//! Grok Build hook processor.
//!
//! Port of `assets/hooks/grok-build-hook-processor.mjs` and `assets/hooks/grok-build/*`.
//! One turn is fused from `chat_history.jsonl`, `updates.jsonl`, and `unified.jsonl`.
//! Checkpoints, the session lock, prompt-export dedup, and the hash chain follow the script.

use super::common::{
    agent_name_patch, collect_resource_attributes, data_dir, env_get, home_dir, json_number,
    load_runtime_config, log_hook_error, parse_json_object, resolve_path, sanitize_record,
    sha256_hex, write_empty, write_jsonl_records, Env, HookRequest, Obj,
};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const AGENT_ID: &str = "grok-build";
const PROVIDER_NAME: &str = "x_ai";
const FRAMEWORK_NAME: &str = "grok-build";
const AGENT_DESCRIPTION: &str = "Grok Build coding agent";
const DATA_SOURCE_ID: &str = "grok-build";

const STATE_VERSION: i64 = 1;
const MAX_RECENT_PROMPT_IDS: usize = 64;
const STATE_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
const STATE_LOCK_TIMEOUT_MS: u64 = 3_000;
const STATE_LOCK_STALE_MS: u64 = 30_000;
const STATE_LOCK_RETRY_MS: u64 = 25;
const MAX_TRANSCRIPT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_UPDATES_BYTES: u64 = 50 * 1024 * 1024;
const MAX_UNIFIED_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
enum HookFail {
    LockTimeout(String),
    Other(String),
}

impl HookFail {
    fn message(&self) -> &str {
        match self {
            HookFail::LockTimeout(message) | HookFail::Other(message) => message,
        }
    }
}

struct LockOptions {
    timeout_ms: u64,
    stale_ms: u64,
    retry_ms: u64,
}

impl Default for LockOptions {
    fn default() -> Self {
        Self {
            timeout_ms: STATE_LOCK_TIMEOUT_MS,
            stale_ms: STATE_LOCK_STALE_MS,
            retry_ms: STATE_LOCK_RETRY_MS,
        }
    }
}

#[cfg(test)]
impl LockOptions {
    fn from_parts(timeout_ms: u64, stale_ms: u64, retry_ms: u64) -> Self {
        Self {
            timeout_ms,
            stale_ms: stale_ms.max(1),
            retry_ms: retry_ms.max(1),
        }
    }
}

struct LockGuard {
    file: Option<File>,
    path: PathBuf,
    token: String,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        self.file.take();
        remove_lock_if_owned(&self.path, &self.token);
    }
}

#[derive(Clone, Debug, Default)]
struct Checkpoint {
    offset: u64,
    ino: Option<String>,
    size: u64,
}

#[derive(Clone, Debug)]
struct SessionState {
    initialized: bool,
    transcript_path: Option<String>,
    cwd: Option<String>,
    chat_checkpoint: Checkpoint,
    updates_checkpoint: Checkpoint,
    recent_prompt_ids: Vec<String>,
    turn_count: u64,
}

#[derive(Clone, Debug)]
struct ToolDetail {
    result: Option<Value>,
    has_result: bool,
    is_error: bool,
}

#[derive(Clone, Debug)]
struct LlmCall {
    model: String,
    message_id: String,
    input_messages: Vec<Value>,
    input_is_delta: bool,
    output_content: Vec<Value>,
    stop_reason: String,
    input_tokens: Option<f64>,
    output_tokens: Option<f64>,
    cache_read_input_tokens: Option<f64>,
    cache_creation_input_tokens: Option<f64>,
    declared_tool_ids: Vec<String>,
    tool_details: HashMap<String, ToolDetail>,
    prompt_index: Option<String>,
    incomplete: bool,
    timestamp: Option<Value>,
}

#[derive(Clone, Debug)]
struct ChatTurn {
    prompt_index: Option<String>,
    prompt: String,
    prompt_timestamp: Option<Value>,
    llm_calls: Vec<LlmCall>,
}

struct TranscriptParse {
    turns: Vec<ChatTurn>,
    next_offset: u64,
    system_prompt: Option<String>,
}

#[derive(Clone, Debug)]
struct UpdateEvent {
    kind: String,
    prompt_id: Option<String>,
    prompt_index: Option<String>,
    timestamp_ms: Option<f64>,
    turn_start_ms: Option<f64>,
    tool_id: String,
    tool_name: Option<String>,
    tool_status: Option<String>,
    tool_input: Option<Value>,
    tool_output: Option<Value>,
    stop_reason: Option<String>,
    usage: Option<Value>,
    start_offset: u64,
    end_offset: u64,
}

#[derive(Clone, Debug)]
struct UpdateTurn {
    prompt_id: Option<String>,
    prompt_index: Option<String>,
    completed: bool,
    stop_reason: Option<String>,
    usage: Option<Value>,
    start_ms: Option<f64>,
    end_ms: Option<f64>,
    end_offset: u64,
    tool_starts: Vec<UpdateEvent>,
    tool_completions: Vec<UpdateEvent>,
}

struct UpdatesParse {
    turns: Vec<UpdateTurn>,
    checkpoint: Checkpoint,
    last_completed_offset: u64,
    #[cfg(test)]
    parse_errors: u32,
    reset: bool,
}

#[derive(Clone, Debug)]
struct UnifiedTool {
    name: String,
    start_ms: f64,
    end_ms: f64,
    elapsed_ms: f64,
    success: Option<bool>,
}

#[derive(Clone, Debug)]
struct UnifiedGroup {
    loop_index: f64,
    start_ms: Option<f64>,
    end_ms: Option<f64>,
    model_elapsed_ms: Option<f64>,
    prompt_tokens: Option<f64>,
    cached_prompt_tokens: Option<f64>,
    cache_creation_input_tokens: Option<f64>,
    completion_tokens: Option<f64>,
    tools: Vec<UnifiedTool>,
}

struct UnifiedParse {
    groups: Vec<UnifiedGroup>,
    #[cfg(test)]
    parse_errors: u32,
}

#[derive(Clone, Debug)]
struct FusedTool {
    id: String,
    name: String,
    arguments: Value,
    result_present: bool,
    result: Option<Value>,
    status: String,
    start_ms: Option<f64>,
    end_ms: f64,
    duration_ms: Option<f64>,
    match_strategy: String,
    timing_source: String,
}

#[derive(Clone, Debug)]
struct FusedCall {
    model: String,
    message_id: String,
    input_messages: Vec<Value>,
    input_is_delta: bool,
    output_content: Vec<Value>,
    request_start_ms: Option<f64>,
    response_end_ms: f64,
    timing_source: String,
    finish_reason: String,
    tools: Vec<FusedTool>,
    input_tokens: Option<f64>,
    output_tokens: Option<f64>,
    cache_read_input_tokens: Option<f64>,
    cache_creation_input_tokens: Option<f64>,
    incomplete: bool,
}

struct FusedTurn {
    prompt_id: Option<String>,
    prompt: String,
    prompt_timestamp_ms: Option<f64>,
    terminal_timestamp_ms: Option<f64>,
    stop_reason: String,
    llm_calls: Vec<FusedCall>,
}

struct ExportTarget {
    update_index: Option<usize>,
    prompt_id: String,
    stop_reason: String,
    error_type: Option<String>,
}

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let subcommand = request
        .args
        .first()
        .map(String::as_str)
        .unwrap_or("unknown");
    if matches!(
        subcommand,
        "stop" | "stop_failure" | "user_prompt_submit" | "session_end"
    ) {
        if let Err(err) = process_hook(request.env, request.stdin, subcommand) {
            let kind = match &err {
                HookFail::LockTimeout(_) => "state_lock_timeout",
                HookFail::Other(_) => "unhandled",
            };
            log_hook_error(
                request.env,
                AGENT_ID,
                &format!("dispatch_{subcommand}"),
                kind,
                err.message(),
            );
        }
    }
    write_empty(request.stdout);
    0
}

fn process_hook(env: &Env, stdin: &[u8], trigger: &str) -> Result<(), HookFail> {
    let event = read_event(stdin);
    let Some(session_id) = require_session_id(env, &event) else {
        return Ok(());
    };
    if is_session_closing_stop(trigger, &event) {
        return Ok(());
    }
    cleanup_expired_states(env)?;
    match with_session_state_lock(env, &session_id, LockOptions::default(), || {
        process_hook_locked(env, trigger, &event, &session_id)
    }) {
        Ok(result) => result,
        Err(err) => Err(err),
    }
}

fn process_hook_locked(
    env: &Env,
    trigger: &str,
    event: &Obj,
    session_id: &str,
) -> Result<(), HookFail> {
    if is_session_closed(env, session_id)? {
        return Ok(());
    }
    let mut state = load_state(env, session_id)?;
    if let Some(transcript) = event_str(event, "transcript_path") {
        let Some(valid) = validate_updates_path(env, transcript, session_id) else {
            log_hook_error(
                env,
                AGENT_ID,
                trigger,
                "invalid_transcript_path",
                "Grok transcript path is outside the native session directory",
            );
            return Ok(());
        };
        state.transcript_path = Some(valid.to_string_lossy().into_owned());
    }
    if let Some(cwd) = event.get("cwd").and_then(Value::as_str) {
        if !cwd.is_empty() {
            state.cwd = Some(cwd.to_string());
        }
    }
    if state.transcript_path.is_none() {
        state.transcript_path = derive_updates_path(env, state.cwd.as_deref(), session_id)
            .map(|path| path.to_string_lossy().into_owned());
    } else if let Some(stored) = state.transcript_path.clone() {
        state.transcript_path = validate_updates_path(env, &stored, session_id)
            .map(|path| path.to_string_lossy().into_owned());
    }

    let Some(updates_path) = state.transcript_path.clone() else {
        log_hook_error(
            env,
            AGENT_ID,
            trigger,
            "missing_transcript_path",
            "cannot resolve Grok session files",
        );
        return Ok(());
    };
    let updates_path = PathBuf::from(&updates_path);
    let chat_path = updates_path
        .parent()
        .unwrap_or(updates_path.as_path())
        .join("chat_history.jsonl");
    if updates_path.as_os_str().is_empty() {
        log_hook_error(
            env,
            AGENT_ID,
            trigger,
            "missing_transcript_path",
            "cannot resolve Grok session files",
        );
        return Ok(());
    }

    // A first UserPromptSubmit must not consume the prompt Grok already appended.
    // A first SessionEnd has no safe current-turn boundary, so it only tombstones.
    if !state.initialized && (trigger == "user_prompt_submit" || trigger == "session_end") {
        state.initialized = true;
        state.transcript_path = Some(updates_path.to_string_lossy().into_owned());
        if trigger == "session_end" {
            mark_session_closed(env, session_id)?;
            clear_state(env, session_id)?;
        } else {
            save_state(env, session_id, &state)?;
        }
        return Ok(());
    }

    let (chat_offset, chat_reset) = resolve_chat_read_position(&chat_path, &state.chat_checkpoint);
    if trigger == "stop" || trigger == "stop_failure" {
        wait_for_file_stable(&chat_path, chat_offset);
    }
    let mut chat = parse_grok_transcript(&chat_path, chat_offset);
    let updates = parse_grok_updates(
        &updates_path,
        &state.updates_checkpoint,
        event_str(event, "prompt_id"),
        MAX_UPDATES_BYTES,
    )?;
    if chat.turns.is_empty() && chat_offset == 0 && (trigger == "stop" || trigger == "stop_failure")
    {
        let retry = parse_grok_transcript(&chat_path, 0);
        if !retry.turns.is_empty() {
            if let Some(last) = retry.turns.last().cloned() {
                chat.turns = vec![last];
                chat.next_offset = retry.next_offset;
                chat.system_prompt = retry.system_prompt;
            }
        }
    }

    let reset_observed = chat_reset || updates.reset;
    if reset_observed && trigger == "user_prompt_submit" {
        state.initialized = true;
        state.updates_checkpoint = updates.checkpoint;
        save_state(env, session_id, &state)?;
        return Ok(());
    }

    let prompt_id = event_str(event, "prompt_id");
    let has_evidence = prompt_id.is_some() || !chat.turns.is_empty() || !updates.turns.is_empty();
    let mut candidates = if has_evidence {
        terminal_targets(trigger, event, &state, &updates.turns)
    } else {
        Vec::new()
    };
    if trigger == "session_end" && reset_observed && !candidates.is_empty() {
        let exact =
            prompt_id.and_then(|id| candidates.iter().position(|target| target.prompt_id == id));
        let index = exact.unwrap_or(candidates.len() - 1);
        let chosen = candidates.swap_remove(index);
        candidates = vec![chosen];
    }
    let had_candidates = !candidates.is_empty();
    let targets: Vec<ExportTarget> = candidates
        .into_iter()
        .filter(|target| !has_exported_prompt(&state, &target.prompt_id))
        .collect();
    if targets.is_empty() {
        return finish_without_export(
            env,
            session_id,
            trigger,
            &mut state,
            &updates,
            had_candidates,
        );
    }

    let runtime = load_runtime_config(env);
    let resources = collect_resource_attributes(env, AGENT_ID);
    let agent_name = agent_name_patch(&resources);
    let system_prompt = chat
        .system_prompt
        .clone()
        .filter(|text| !text.is_empty())
        .or_else(|| read_system_prompt(&chat_path))
        .filter(|text| !text.is_empty());
    let unified = parse_grok_unified(&unified_log_path(env), session_id, MAX_UNIFIED_BYTES)?;
    let fallback_ms = hook_timestamp_ms(event);
    let mut used_chat = HashSet::new();
    let mut all_records = Vec::new();
    let allow_latest = trigger == "stop" || trigger == "stop_failure";
    for target in &targets {
        let update_turn = target
            .update_index
            .and_then(|index| updates.turns.get(index))
            .cloned();
        let chat_turn = take_matching_chat_turn(
            &chat.turns,
            update_turn.as_ref(),
            &mut used_chat,
            allow_latest,
        );
        let chat_turn = chat_turn.unwrap_or(ChatTurn {
            prompt_index: None,
            prompt: String::new(),
            prompt_timestamp: None,
            llm_calls: Vec::new(),
        });
        let fused = fuse_grok_turn(
            &chat_turn,
            update_turn.as_ref(),
            &unified.groups,
            &target.prompt_id,
            &target.stop_reason,
            Some(fallback_ms),
        );
        all_records.extend(build_turn_records(
            &fused,
            TurnRecordContext {
                session_id,
                user_id: &runtime.user_id,
                cwd: state.cwd.as_deref().filter(|cwd| !cwd.is_empty()),
                agent_name: agent_name.as_deref(),
                resources: &resources,
            },
            system_prompt.as_deref(),
            target.error_type.as_deref(),
            fallback_ms,
        ));
        mark_prompt_exported(&mut state, &target.prompt_id);
        state.turn_count = state.turn_count.saturating_add(1);
    }

    let cleaned: Vec<Obj> = all_records.into_iter().map(sanitize_record).collect();
    write_jsonl_records(env, &default_log_dir(env), AGENT_ID, &cleaned).map_err(HookFail::Other)?;
    state.initialized = true;
    if trigger == "stop" || trigger == "stop_failure" {
        state.chat_checkpoint = checkpoint_for(&chat_path, chat.next_offset);
        state.updates_checkpoint = updates.checkpoint;
    } else {
        state.updates_checkpoint = Checkpoint {
            offset: updates.last_completed_offset,
            ..updates.checkpoint
        };
    }
    if trigger == "session_end" {
        save_state(env, session_id, &state)?;
        mark_session_closed(env, session_id)?;
        clear_state(env, session_id)?;
    } else {
        save_state(env, session_id, &state)?;
    }
    Ok(())
}

fn finish_without_export(
    env: &Env,
    session_id: &str,
    trigger: &str,
    state: &mut SessionState,
    updates: &UpdatesParse,
    had_candidates: bool,
) -> Result<(), HookFail> {
    state.initialized = true;
    if (trigger == "user_prompt_submit" || trigger == "session_end" || had_candidates)
        && updates.last_completed_offset > state.updates_checkpoint.offset
    {
        state.updates_checkpoint = Checkpoint {
            offset: updates.last_completed_offset,
            ..updates.checkpoint.clone()
        };
    }
    if trigger == "session_end" {
        mark_session_closed(env, session_id)?;
        clear_state(env, session_id)?;
    } else {
        save_state(env, session_id, state)?;
    }
    Ok(())
}

fn now_ms_i64() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn now_ms_f64() -> f64 {
    now_ms_i64() as f64
}

fn parse_time_ms(value: &str) -> Option<f64> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|parsed| parsed.timestamp_millis() as f64)
}

fn scale_unix_ms(value: f64) -> f64 {
    if value.abs() < 10_000_000_000.0 {
        value * 1000.0
    } else {
        value
    }
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|number| number.is_finite()),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                trimmed
                    .parse::<f64>()
                    .ok()
                    .filter(|number| number.is_finite())
            }
        }
        _ => None,
    }
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|number| number.is_finite()),
        _ => None,
    }
}

fn js_number_string(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{}", number as i64)
    } else {
        serde_json::Number::from_f64(number)
            .map(|number| number.to_string())
            .unwrap_or_else(|| number.to_string())
    }
}

fn ms_to_unix_nanos(value: Option<f64>, fallback_ms: f64) -> String {
    let ms = match value {
        Some(value) if value.is_finite() => value.trunc().max(0.0),
        _ => fallback_ms.trunc().max(0.0),
    };
    format!("{}000000", ms as i64)
}

fn hook_timestamp_ms(event: &Obj) -> f64 {
    match event.get("timestamp") {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .map(scale_unix_ms)
            .unwrap_or_else(now_ms_f64),
        Some(Value::String(text)) => parse_time_ms(text).unwrap_or_else(now_ms_f64),
        _ => now_ms_f64(),
    }
}

fn event_str<'a>(event: &'a Obj, key: &str) -> Option<&'a str> {
    event
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn read_event(bytes: &[u8]) -> Obj {
    match parse_json_object(bytes) {
        Ok(event) => normalize_envelope(event),
        Err(_) => Obj::new(),
    }
}

fn normalize_envelope(mut event: Obj) -> Obj {
    const ALIASES: &[(&str, &str)] = &[
        ("hookEventName", "hook_event_name"),
        ("sessionId", "session_id"),
        ("transcriptPath", "transcript_path"),
        ("workspaceRoot", "workspace_root"),
        ("promptId", "prompt_id"),
        ("permissionMode", "permission_mode"),
        ("stopReason", "stop_reason"),
        ("errorType", "error_type"),
        ("errorDetails", "error_details"),
        ("lastAssistantMessage", "last_assistant_message"),
    ];
    for (camel, snake) in ALIASES {
        if let Some(value) = event.remove(*camel) {
            event.entry(snake.to_string()).or_insert(value);
        }
    }
    if !event.contains_key("stop_reason") {
        if let Some(reason) = event.get("reason").cloned() {
            event.insert("stop_reason".into(), reason);
        }
    }
    event
}

fn require_session_id(env: &Env, event: &Obj) -> Option<String> {
    if let Some(session_id) = event_str(event, "session_id") {
        return Some(session_id.to_string());
    }
    log_hook_error(
        env,
        AGENT_ID,
        "cmd",
        "missing_session_id",
        "hook stdin lacks session_id; skipping",
    );
    None
}

fn normalize_token(value: &str) -> String {
    let mut out = String::new();
    let lower = value.trim().to_lowercase();
    let mut chars = lower.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() || ch == '-' {
            if !out.is_empty() && !out.ends_with('_') {
                out.push('_');
            }
            while chars
                .peek()
                .is_some_and(|next| next.is_whitespace() || *next == '-')
            {
                chars.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn normalize_terminal_reason(value: Option<&str>, fallback: &str) -> String {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return fallback.to_string();
    };
    let mut reason = String::new();
    let lower = value.to_lowercase();
    let mut chars = lower.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() || ch == '-' {
            reason.push('_');
            while chars
                .peek()
                .is_some_and(|next| next.is_whitespace() || *next == '-')
            {
                chars.next();
            }
        } else {
            reason.push(ch);
        }
    }
    if reason == "canceled" {
        "cancelled".into()
    } else if reason == "max_output_tokens" {
        "max_tokens".into()
    } else {
        reason
    }
}

fn is_session_closing_stop(trigger: &str, event: &Obj) -> bool {
    if trigger != "stop" {
        return false;
    }
    let reason = normalize_terminal_reason(event_str(event, "stop_reason"), "");
    reason == "shutdown" || reason == "channel_closed"
}

fn error_patterns() -> &'static RegexSet {
    static PATTERNS: OnceLock<RegexSet> = OnceLock::new();
    PATTERNS.get_or_init(|| RegexSet {
        rate: Regex::new(r"(?i)(rate.?limit|too many requests|\b429\b)").expect("rate"),
        auth: Regex::new(
            r"(?i)(unauthori[sz]ed|forbidden|authentication|credential|api.?key|\b40[13]\b)",
        )
        .expect("auth"),
        timeout: Regex::new(r"(?i)(timeout|timed out|deadline)").expect("timeout"),
        context: Regex::new(r"(?i)(context.?length|token.?limit|max.?tokens)").expect("context"),
        safety: Regex::new(r"(?i)(content.?filter|safety)").expect("safety"),
        network: Regex::new(r"(?i)(network|connection|dns|socket)").expect("network"),
        server: Regex::new(r"(?i)(server|internal|service unavailable|gateway|\b5\d\d\b)")
            .expect("server"),
    })
}

struct RegexSet {
    rate: Regex,
    auth: Regex,
    timeout: Regex,
    context: Regex,
    safety: Regex,
    network: Regex,
    server: Regex,
}

fn classify_model_error(event: &Obj) -> String {
    let source = event
        .get("error")
        .and_then(Value::as_str)
        .map(normalize_token)
        .unwrap_or_default();
    match source.as_str() {
        "rate_limit" => return "rate_limit".into(),
        "authentication_failed" => return "authentication_error".into(),
        "invalid_request" => return "invalid_request".into(),
        "server_error" => return "server_error".into(),
        "max_output_tokens" => return "context_length_error".into(),
        _ => {}
    }
    let mut parts = Vec::new();
    for key in ["error_type", "error", "error_details", "stop_reason"] {
        if let Some(text) = event.get(key).and_then(Value::as_str) {
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    let raw = parts.join(" ").to_lowercase();
    let patterns = error_patterns();
    if patterns.rate.is_match(&raw) {
        "rate_limit".into()
    } else if patterns.auth.is_match(&raw) {
        "authentication_error".into()
    } else if patterns.timeout.is_match(&raw) {
        "timeout".into()
    } else if patterns.context.is_match(&raw) {
        "context_length_error".into()
    } else if patterns.safety.is_match(&raw) {
        "content_filter".into()
    } else if patterns.network.is_match(&raw) {
        "network_error".into()
    } else if patterns.server.is_match(&raw) {
        "server_error".into()
    } else {
        "model_error".into()
    }
}

fn initial_hash() -> String {
    sha256_hex(b"")[..32].to_string()
}

fn stable_serialize(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) | Value::Number(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".into())
        }
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "null".into()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(stable_serialize).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|key| {
                    let rendered = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into());
                    format!("{rendered}:{}", stable_serialize(&map[*key]))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

fn hash_step(prev: &str, message: &Value) -> String {
    let mut bytes = Vec::with_capacity(prev.len() + 64);
    bytes.extend_from_slice(prev.as_bytes());
    bytes.extend_from_slice(stable_serialize(message).as_bytes());
    sha256_hex(&bytes)[..32].to_string()
}

fn compute_hash(prev: &str, messages: &[Value]) -> String {
    let mut hash = prev.to_string();
    for message in messages {
        hash = hash_step(&hash, message);
    }
    hash
}

fn should_log_full_messages(previous: &str, delta: &[Value], current: &str) -> bool {
    compute_hash(previous, delta) != current
}

fn deterministic_hex(value: &str, length: usize) -> String {
    let hex = sha256_hex(value.as_bytes());
    let mut sliced: String = hex.chars().take(length).collect();
    if sliced.chars().all(|ch| ch == '0') {
        sliced = format!("{}1", "0".repeat(length.saturating_sub(1)));
    }
    sliced
}

fn deterministic_event_id(value: &str) -> String {
    let hex = deterministic_hex(value, 32);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn js_index(number: f64) -> String {
    js_number_string(number)
}

fn grok_sanitize_session_id(session_id: &str) -> String {
    let base = Path::new(session_id)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(session_id);
    let cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let base = if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned.chars().take(80).collect()
    };
    let digest: String = sha256_hex(session_id.as_bytes()).chars().take(12).collect();
    format!("{base}-{digest}")
}

fn is_safe_session_segment(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id != "."
        && session_id != ".."
        && !session_id.contains('\0')
        && !session_id.contains('/')
        && !session_id.contains('\\')
        && !Path::new(session_id).is_absolute()
}

fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_path_inside(root: &Path, candidate: &Path) -> bool {
    let root = lexical_normalize(root);
    let candidate = lexical_normalize(candidate);
    if candidate == root {
        return true;
    }
    candidate.strip_prefix(&root).is_ok()
}

fn grok_home(env: &Env) -> PathBuf {
    if let Some(home) = env_get(env, "GROK_HOME") {
        resolve_path(env, home)
    } else {
        home_dir(env).join(".grok")
    }
}

fn resolve_through_existing_ancestor(env: &Env, candidate: &Path) -> Result<PathBuf, ()> {
    let mut current = resolve_path(env, &candidate.to_string_lossy());
    let mut suffix = Vec::new();
    while !current.exists() {
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            return Ok(resolve_path(env, &candidate.to_string_lossy()));
        };
        if parent == current {
            return Ok(resolve_path(env, &candidate.to_string_lossy()));
        }
        if let Some(name) = current.file_name() {
            suffix.push(name.to_os_string());
        }
        current = parent;
    }
    let mut real = fs::canonicalize(&current).map_err(|_| ())?;
    for name in suffix.iter().rev() {
        real.push(name);
    }
    Ok(real)
}

fn validate_updates_path(env: &Env, candidate: &str, session_id: &str) -> Option<PathBuf> {
    if candidate.is_empty() || !is_safe_session_segment(session_id) {
        return None;
    }
    let resolved = resolve_path(env, candidate);
    let sessions_root = resolve_path(env, &grok_home(env).join("sessions").to_string_lossy());
    if resolved.file_name().and_then(|name| name.to_str()) != Some("updates.jsonl") {
        return None;
    }
    let parent_name = resolved
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str());
    if parent_name != Some(session_id) || !is_path_inside(&sessions_root, &resolved) {
        return None;
    }
    let real_root = resolve_through_existing_ancestor(env, &sessions_root).ok()?;
    let real_file = resolve_through_existing_ancestor(env, &resolved).ok()?;
    if !is_path_inside(&real_root, &real_file) {
        return None;
    }
    Some(resolved)
}

fn derive_updates_path(env: &Env, cwd: Option<&str>, session_id: &str) -> Option<PathBuf> {
    let cwd = cwd.filter(|cwd| !cwd.is_empty())?;
    if !is_safe_session_segment(session_id) {
        return None;
    }
    let candidate = grok_home(env)
        .join("sessions")
        .join(encode_uri_component(cwd))
        .join(session_id)
        .join("updates.jsonl");
    validate_updates_path(env, &candidate.to_string_lossy(), session_id)
}

fn unified_log_path(env: &Env) -> PathBuf {
    if let Some(path) = env_get(env, "GROK_UNIFIED_LOG_PATH") {
        resolve_path(env, path)
    } else {
        grok_home(env).join("logs").join("unified.jsonl")
    }
}

fn default_log_dir(env: &Env) -> PathBuf {
    data_dir(env).join("logs").join(AGENT_ID)
}

fn file_ino(meta: &fs::Metadata) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(meta.ino().to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

fn open_private(path: &Path, create_new: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn ensure_state_dir(env: &Env) -> Result<PathBuf, HookFail> {
    let dir = data_dir(env)
        .join("state")
        .join("grok-build")
        .join("sessions");
    fs::create_dir_all(&dir).map_err(|err| HookFail::Other(err.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn state_file_path(env: &Env, session_id: &str) -> Result<PathBuf, HookFail> {
    Ok(ensure_state_dir(env)?.join(format!("{}.json", grok_sanitize_session_id(session_id))))
}

fn session_lock_path(env: &Env, session_id: &str) -> Result<PathBuf, HookFail> {
    Ok(ensure_state_dir(env)?.join(format!("{}.lock", grok_sanitize_session_id(session_id))))
}

fn closed_marker_path(env: &Env, session_id: &str) -> Result<PathBuf, HookFail> {
    Ok(ensure_state_dir(env)?.join(format!("{}.closed", grok_sanitize_session_id(session_id))))
}

fn file_mtime_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn is_transient_rename(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(1) | Some(13) | Some(16))
}

fn rename_retrying(mut op: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    const DELAYS_MS: [u64; 2] = [50, 100];
    let mut attempt = 0usize;
    loop {
        match op() {
            Ok(()) => return Ok(()),
            Err(err) if is_transient_rename(&err) && attempt < DELAYS_MS.len() => {
                thread::sleep(Duration::from_millis(DELAYS_MS[attempt]));
                attempt += 1;
            }
            Err(err) => return Err(err),
        }
    }
}

fn rename_sync_with_retry(source: &Path, destination: &Path) -> io::Result<()> {
    rename_retrying(|| fs::rename(source, destination))
}

fn remove_lock_if_owned(path: &Path, token: &str) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if value.get("token").and_then(Value::as_str) == Some(token) {
        let _ = fs::remove_file(path);
    }
}

fn with_session_state_lock<T>(
    env: &Env,
    session_id: &str,
    options: LockOptions,
    callback: impl FnOnce() -> T,
) -> Result<T, HookFail> {
    let path = session_lock_path(env, session_id)?;
    let token = format!("{}:{}", std::process::id(), uuid::Uuid::new_v4());
    let started = Instant::now();
    let timeout = Duration::from_millis(options.timeout_ms);
    let guard = loop {
        match open_private(&path, true) {
            Ok(mut file) => {
                let body = json!({
                    "token": token,
                    "pid": std::process::id(),
                    "acquired_at_ms": now_ms_i64(),
                });
                let text = serde_json::to_string(&body).unwrap_or_default();
                if let Err(err) = file.write_all(text.as_bytes()) {
                    return Err(HookFail::Other(err.to_string()));
                }
                break LockGuard {
                    file: Some(file),
                    path,
                    token,
                };
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                if let (Some(mtime),) = (file_mtime_ms(&path),) {
                    if now_ms_i64() - mtime > options.stale_ms as i64 {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                }
                if started.elapsed() >= timeout {
                    return Err(HookFail::LockTimeout(format!(
                        "timed out acquiring Grok session state lock for {}",
                        grok_sanitize_session_id(session_id)
                    )));
                }
                thread::sleep(Duration::from_millis(options.retry_ms));
            }
            Err(err) => return Err(HookFail::Other(err.to_string())),
        }
    };
    let value = callback();
    drop(guard);
    Ok(value)
}

fn fresh_state() -> SessionState {
    SessionState {
        initialized: false,
        transcript_path: None,
        cwd: None,
        chat_checkpoint: Checkpoint::default(),
        updates_checkpoint: Checkpoint::default(),
        recent_prompt_ids: Vec::new(),
        turn_count: 0,
    }
}

fn normalize_checkpoint(value: Option<&Value>) -> Checkpoint {
    let Some(obj) = value.and_then(Value::as_object) else {
        return Checkpoint::default();
    };
    let offset = json_f64(obj.get("offset"))
        .filter(|number| number.is_finite())
        .map(|number| number.max(0.0) as u64)
        .unwrap_or(0);
    let size = json_f64(obj.get("size"))
        .filter(|number| number.is_finite())
        .map(|number| number.max(0.0) as u64)
        .unwrap_or(0);
    let ino = match obj.get("ino") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(number)) => number.as_f64().map(js_number_string),
        Some(Value::Bool(flag)) => Some(flag.to_string()),
        Some(_) => None,
    };
    Checkpoint { offset, ino, size }
}

fn tail_ids(ids: Vec<String>) -> Vec<String> {
    let mut ids: Vec<String> = ids.into_iter().filter(|id| !id.is_empty()).collect();
    if ids.len() > MAX_RECENT_PROMPT_IDS {
        let extra = ids.len() - MAX_RECENT_PROMPT_IDS;
        ids.drain(0..extra);
    }
    ids
}

fn normalize_state(raw: &Value) -> SessionState {
    let Some(obj) = raw.as_object() else {
        return fresh_state();
    };
    if json_f64(obj.get("version")).is_none_or(|version| version != STATE_VERSION as f64) {
        return fresh_state();
    }
    let ids = obj
        .get("recent_prompt_ids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    SessionState {
        initialized: obj.get("initialized").and_then(Value::as_bool) == Some(true),
        transcript_path: obj
            .get("transcript_path")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd: obj.get("cwd").and_then(Value::as_str).map(str::to_string),
        chat_checkpoint: normalize_checkpoint(obj.get("chat_checkpoint")),
        updates_checkpoint: normalize_checkpoint(obj.get("updates_checkpoint")),
        recent_prompt_ids: tail_ids(ids),
        turn_count: json_f64(obj.get("turn_count"))
            .filter(|number| number.is_finite())
            .map(|number| number.max(0.0) as u64)
            .unwrap_or(0),
    }
}

fn load_state(env: &Env, session_id: &str) -> Result<SessionState, HookFail> {
    let path = state_file_path(env, session_id)?;
    if !path.exists() {
        return Ok(fresh_state());
    }
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) => {
            eprintln!(
                "[grok-build-hook] state file for session {session_id} corrupted; starting fresh ({err})"
            );
            return Ok(fresh_state());
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => Ok(normalize_state(&value)),
        Err(err) => {
            eprintln!(
                "[grok-build-hook] state file for session {session_id} corrupted; starting fresh ({err})"
            );
            Ok(fresh_state())
        }
    }
}

fn checkpoint_value(checkpoint: &Checkpoint) -> Value {
    json!({
        "offset": checkpoint.offset,
        "ino": checkpoint.ino,
        "size": checkpoint.size,
    })
}

fn save_state(env: &Env, session_id: &str, state: &SessionState) -> Result<(), HookFail> {
    let dest = state_file_path(env, session_id)?;
    let tmp = dest.with_file_name(format!(
        "{}.{}.tmp",
        grok_sanitize_session_id(session_id),
        std::process::id()
    ));
    let clean = json!({
        "version": STATE_VERSION,
        "session_id": session_id,
        "initialized": state.initialized,
        "transcript_path": state.transcript_path,
        "cwd": state.cwd,
        "chat_checkpoint": checkpoint_value(&state.chat_checkpoint),
        "updates_checkpoint": checkpoint_value(&state.updates_checkpoint),
        "recent_prompt_ids": tail_ids(state.recent_prompt_ids.clone()),
        "turn_count": state.turn_count,
    });
    let bytes = serde_json::to_vec(&clean).map_err(|err| HookFail::Other(err.to_string()))?;
    open_private(&tmp, false)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(|err| HookFail::Other(err.to_string()))?;
    if let Err(err) = rename_sync_with_retry(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(HookFail::Other(err.to_string()));
    }
    Ok(())
}

fn has_exported_prompt(state: &SessionState, prompt_id: &str) -> bool {
    !prompt_id.is_empty() && state.recent_prompt_ids.iter().any(|id| id == prompt_id)
}

fn mark_prompt_exported(state: &mut SessionState, prompt_id: &str) {
    if prompt_id.is_empty() {
        return;
    }
    state.recent_prompt_ids.retain(|id| id != prompt_id);
    state.recent_prompt_ids.push(prompt_id.to_string());
    state.recent_prompt_ids = tail_ids(std::mem::take(&mut state.recent_prompt_ids));
}

fn clear_state(env: &Env, session_id: &str) -> Result<(), HookFail> {
    let path = state_file_path(env, session_id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Ok(()),
    }
}

fn is_session_closed(env: &Env, session_id: &str) -> Result<bool, HookFail> {
    let path = closed_marker_path(env, session_id)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Ok(false),
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Ok(false);
    };
    let closed_at = finite_number(value.get("closed_at_ms"));
    if let Some(closed_at) = closed_at {
        if now_ms_i64() - closed_at as i64 <= STATE_RETENTION_MS {
            return Ok(true);
        }
    }
    let _ = fs::remove_file(path);
    Ok(false)
}

fn mark_session_closed(env: &Env, session_id: &str) -> Result<(), HookFail> {
    let dest = closed_marker_path(env, session_id)?;
    let tmp = PathBuf::from(format!("{}.{}.tmp", dest.display(), std::process::id()));
    let bytes = serde_json::to_vec(&json!({ "closed_at_ms": now_ms_i64() }))
        .map_err(|err| HookFail::Other(err.to_string()))?;
    if let Err(err) = open_private(&tmp, false).and_then(|mut file| file.write_all(&bytes)) {
        let _ = fs::remove_file(&tmp);
        return Err(HookFail::Other(err.to_string()));
    }
    if let Err(err) = rename_sync_with_retry(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(HookFail::Other(err.to_string()));
    }
    Ok(())
}

fn write_cleanup_marker(marker: &Path, now: i64) {
    let tmp = PathBuf::from(format!("{}.{}.tmp", marker.display(), std::process::id()));
    let Ok(bytes) = serde_json::to_vec(&json!({ "last_run_ms": now })) else {
        return;
    };
    if open_private(&tmp, false)
        .and_then(|mut file| file.write_all(&bytes))
        .is_err()
    {
        let _ = fs::remove_file(&tmp);
        return;
    }
    if rename_sync_with_retry(&tmp, marker).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

fn cleanup_expired_states(env: &Env) -> Result<(), HookFail> {
    let dir = ensure_state_dir(env)?;
    let marker = dir.join(".cleanup.json");
    let now = now_ms_i64();
    if let Ok(text) = fs::read_to_string(&marker) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(last) = json_f64(value.get("last_run_ms")) {
                if (now - last as i64) < CLEANUP_INTERVAL_MS {
                    return Ok(());
                }
            }
        }
    }
    let mut read_error = None;
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if (!name.ends_with(".json") && !name.ends_with(".closed"))
                    || name == ".cleanup.json"
                {
                    continue;
                }
                let path = entry.path();
                if let Some(mtime) = file_mtime_ms(&path) {
                    if now - mtime > STATE_RETENTION_MS {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }
        Err(err) => read_error = Some(err.to_string()),
    }
    write_cleanup_marker(&marker, now);
    match read_error {
        Some(err) => Err(HookFail::Other(err)),
        None => Ok(()),
    }
}

fn read_from(path: &Path, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    if len == 0 {
        return Ok(Vec::new());
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    let mut filled = 0usize;
    while filled < len {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

fn wait_for_file_stable(path: &Path, min_size: u64) {
    let mut previous: Option<u64> = None;
    let mut stable = 0u32;
    for _ in 0..6 {
        let Ok(meta) = fs::metadata(path) else {
            return;
        };
        let size = meta.len();
        if size > min_size && previous == Some(size) {
            stable += 1;
            if stable >= 2 {
                return;
            }
        } else {
            stable = 0;
        }
        previous = Some(size);
        thread::sleep(Duration::from_millis(100));
    }
}

fn checkpoint_for(path: &Path, offset: u64) -> Checkpoint {
    match fs::metadata(path) {
        Ok(meta) => Checkpoint {
            offset: offset.min(meta.len()),
            ino: file_ino(&meta),
            size: meta.len(),
        },
        Err(_) => Checkpoint {
            offset,
            ino: None,
            size: 0,
        },
    }
}

fn resolve_chat_read_position(path: &Path, checkpoint: &Checkpoint) -> (u64, bool) {
    let Ok(meta) = fs::metadata(path) else {
        return (0, false);
    };
    let size = meta.len();
    let current_ino = file_ino(&meta);
    let identity_changed = match (&checkpoint.ino, &current_ino) {
        (Some(saved), Some(current)) => saved != current,
        _ => false,
    };
    let reset = identity_changed || checkpoint.offset > size || checkpoint.size > size;
    (if reset { 0 } else { checkpoint.offset }, reset)
}

fn extract_text_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let mut out = String::new();
            for part in parts {
                if let Some(text) = part.as_str() {
                    out.push_str(text);
                } else if let Some(text) = part.get("text").and_then(Value::as_str) {
                    out.push_str(text);
                }
            }
            out
        }
        _ => String::new(),
    }
}

fn user_query_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?s)<user_query>\s*(.*?)\s*</user_query>").expect("user_query")
    })
}

fn extract_user_prompt_text(content: &Value) -> String {
    let text = extract_text_content(content);
    if let Some(captures) = user_query_pattern().captures(&text) {
        captures
            .get(1)
            .map(|item| item.as_str().trim().to_string())
            .unwrap_or(text)
    } else {
        text
    }
}

fn is_synthetic_user(record: &Obj) -> bool {
    match record.get("synthetic_reason") {
        None | Some(Value::Null) => false,
        Some(_) => true,
    }
}

fn should_skip_user(record: &Obj) -> bool {
    if is_synthetic_user(record) {
        return true;
    }
    if let Some(parts) = record.get("content").and_then(Value::as_array) {
        if parts
            .iter()
            .any(|part| part.get("type").and_then(Value::as_str) == Some("tool_result"))
        {
            return false;
        }
    }
    let text = record
        .get("content")
        .map(extract_text_content)
        .unwrap_or_default();
    text.is_empty() || text.starts_with("<user_info>") || text.starts_with("<system-reminder>")
}

fn is_tool_result_content(content: &Value) -> bool {
    content.as_array().is_some_and(|parts| {
        parts
            .iter()
            .all(|part| part.get("type").and_then(Value::as_str) == Some("tool_result"))
    })
}

fn js_stringish(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => number.as_f64().map(js_number_string),
        Value::String(text) => Some(text.clone()),
        Value::Array(_) | Value::Object(_) => Some("[object Object]".into()),
    }
}

fn first_present(values: &[Option<&Value>]) -> Option<Value> {
    values.iter().find_map(|value| {
        value.and_then(|value| {
            if value.is_null() {
                None
            } else {
                Some(value.clone())
            }
        })
    })
}

fn parse_tool_call_arguments(raw: Option<&Value>) -> Value {
    match raw {
        None | Some(Value::Null) => json!({}),
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::Array(items)) => Value::Array(items.clone()),
        Some(Value::String(text)) if text.is_empty() => json!({}),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => Value::Object(map),
            Ok(Value::Array(items)) => Value::Array(items),
            Ok(Value::Null) | Err(_) => json!({ "_raw": text }),
            Ok(_) => json!({ "_raw": text }),
        },
        Some(_) => json!({}),
    }
}

fn build_assistant_blocks(record: &Obj, assistant_seq: u32) -> Vec<Value> {
    if let Some(content) = record.get("content").and_then(Value::as_array) {
        if !content.is_empty() {
            return content
                .iter()
                .map(|block| {
                    let Some(obj) = block.as_object() else {
                        return block.clone();
                    };
                    if obj.get("type").and_then(Value::as_str) != Some("tool_use") {
                        return block.clone();
                    }
                    let mut cloned = obj.clone();
                    let source = obj
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(|id| Value::String(id.to_string()))
                        .unwrap_or(Value::Null);
                    cloned.insert("source_id".into(), source);
                    Value::Object(cloned)
                })
                .collect();
        }
    }
    let mut blocks = Vec::new();
    if let Some(text) = record.get("content").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
    }
    if let Some(calls) = record.get("tool_calls").and_then(Value::as_array) {
        for (index, call) in calls.iter().enumerate() {
            let Some(call) = call.as_object() else {
                continue;
            };
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or("tool");
            let provided = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty());
            let tool_id = provided
                .map(str::to_string)
                .unwrap_or_else(|| format!("{name}_{assistant_seq}_{}", index + 1));
            let source_id = provided
                .map(|id| Value::String(id.to_string()))
                .unwrap_or(Value::Null);
            let input =
                parse_tool_call_arguments(call.get("arguments").or_else(|| call.get("input")));
            blocks.push(json!({
                "type": "tool_use",
                "id": tool_id,
                "source_id": source_id,
                "name": name,
                "input": input,
            }));
        }
    }
    blocks
}

fn usage_number_of(usage: &Value, keys: &[&str]) -> Option<f64> {
    let obj = usage.as_object()?;
    keys.iter().find_map(|key| json_f64(obj.get(*key)))
}

enum ConvRecord {
    User {
        content: Value,
        prompt_index: Option<String>,
        skip: bool,
        timestamp: Option<Value>,
    },
    Assistant {
        msg_id: String,
        content: Vec<Value>,
        timestamp: Option<Value>,
        model: String,
        stop_reason: String,
        prompt_index: Option<String>,
        input_tokens: Option<f64>,
        output_tokens: Option<f64>,
        cache_read_input_tokens: Option<f64>,
        cache_creation_input_tokens: Option<f64>,
    },
}

fn parse_grok_transcript(path: &Path, byte_offset: u64) -> TranscriptParse {
    let empty = TranscriptParse {
        turns: Vec::new(),
        next_offset: byte_offset,
        system_prompt: None,
    };
    let Ok(meta) = fs::metadata(path) else {
        return empty;
    };
    let file_size = meta.len();
    if byte_offset >= file_size {
        return empty;
    }
    let read_len = file_size - byte_offset;
    let (content_start, bytes) = if read_len > MAX_TRANSCRIPT_BYTES {
        let tail_offset = file_size - MAX_TRANSCRIPT_BYTES;
        let actual = tail_offset.max(byte_offset);
        let Ok(mut buf) = read_from(path, actual, (file_size - actual) as usize) else {
            return empty;
        };
        let mut start = actual;
        if actual > byte_offset {
            if let Some(newline) = buf.iter().position(|byte| *byte == b'\n') {
                start += newline as u64 + 1;
                buf = buf[newline + 1..].to_vec();
            }
        }
        (start, buf)
    } else {
        match read_from(path, byte_offset, read_len as usize) {
            Ok(buf) => (byte_offset, buf),
            Err(_) => return empty,
        }
    };
    let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return empty;
    };
    let complete = &bytes[..=last_newline];
    let next_offset = content_start + complete.len() as u64;
    let text = String::from_utf8_lossy(complete);
    let _ = content_start;
    let (turns, system_prompt) = turns_from_transcript_text(&text);
    TranscriptParse {
        turns,
        next_offset,
        system_prompt,
    }
}

fn turns_from_transcript_text(text: &str) -> (Vec<ChatTurn>, Option<String>) {
    let mut records = Vec::new();
    let mut tool_results: HashMap<String, Value> = HashMap::new();
    let mut tool_errors: HashMap<String, bool> = HashMap::new();
    let mut current_prompt: Option<String> = None;
    let mut assistant_seq = 0u32;
    let mut system_prompt = None;
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        let Some(record_type) = record.get("type").and_then(Value::as_str) else {
            continue;
        };
        if record_type == "system" {
            let content = match record.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => extract_text_content(other),
                None => String::new(),
            };
            if system_prompt.is_none() && !content.is_empty() {
                system_prompt = Some(content);
            }
            continue;
        }
        if record_type == "user" {
            let prompt_index = record
                .get("prompt_index")
                .and_then(js_stringish)
                .filter(|value| !value.is_empty());
            if let Some(prompt_index) = prompt_index {
                current_prompt = Some(prompt_index);
            }
            if let Some(parts) = record.get("content").and_then(Value::as_array) {
                for part in parts {
                    if part.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let Some(tool_id) = part
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                    else {
                        continue;
                    };
                    let result = first_present(&[
                        part.get("content"),
                        part.get("output"),
                        part.get("result"),
                    ])
                    .unwrap_or_else(|| Value::String(String::new()));
                    tool_results.insert(tool_id.to_string(), result);
                    if js_truthy(part.get("is_error")) {
                        tool_errors.insert(tool_id.to_string(), true);
                    }
                }
            }
            records.push(ConvRecord::User {
                content: record.get("content").cloned().unwrap_or(Value::Null),
                prompt_index: current_prompt.clone(),
                skip: should_skip_user(record),
                timestamp: record
                    .get("timestamp")
                    .filter(|value| !value.is_null())
                    .cloned(),
            });
            continue;
        }
        if record_type == "assistant" {
            assistant_seq += 1;
            let msg_id = record
                .get("message_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .or_else(|| {
                    record
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                })
                .map(str::to_string)
                .unwrap_or_else(|| format!("_syn_assistant_{assistant_seq}"));
            let usage = record.get("usage").cloned().unwrap_or(Value::Null);
            let model = record
                .get("model_id")
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
                .or_else(|| {
                    record
                        .get("model")
                        .and_then(Value::as_str)
                        .filter(|model| !model.is_empty())
                })
                .unwrap_or("grok")
                .to_string();
            records.push(ConvRecord::Assistant {
                msg_id,
                content: build_assistant_blocks(record, assistant_seq),
                timestamp: record
                    .get("timestamp")
                    .filter(|value| !value.is_null())
                    .cloned(),
                model,
                stop_reason: record
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or("end_turn")
                    .to_string(),
                prompt_index: current_prompt.clone(),
                input_tokens: usage_number_of(&usage, &["input_tokens", "prompt_tokens"]),
                output_tokens: usage_number_of(&usage, &["output_tokens", "completion_tokens"]),
                cache_read_input_tokens: usage_number_of(&usage, &["cache_read_input_tokens"]),
                cache_creation_input_tokens: usage_number_of(
                    &usage,
                    &["cache_creation_input_tokens"],
                ),
            });
            continue;
        }
        if record_type == "tool_result" {
            let mut tool_id = record
                .get("tool_call_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .or_else(|| {
                    record
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                })
                .unwrap_or("")
                .to_string();
            if tool_id.is_empty() {
                tool_id = format!("_orphan_result_{}", records.len() + 1);
            }
            let result = first_present(&[
                record.get("content"),
                record.get("output"),
                record.get("result"),
            ])
            .unwrap_or_else(|| Value::String(String::new()));
            let is_error = js_truthy(record.get("is_error"));
            tool_results.insert(tool_id.clone(), result.clone());
            if is_error {
                tool_errors.insert(tool_id.clone(), true);
            }
            records.push(ConvRecord::User {
                content: json!([{
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result,
                    "is_error": is_error,
                }]),
                prompt_index: current_prompt.clone(),
                skip: false,
                timestamp: record
                    .get("timestamp")
                    .filter(|value| !value.is_null())
                    .cloned(),
            });
        }
    }
    let llm_calls = build_llm_calls(&records, &tool_results, &tool_errors);
    (split_into_turns(&records, llm_calls), system_prompt)
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn build_llm_calls(
    records: &[ConvRecord],
    tool_results: &HashMap<String, Value>,
    tool_errors: &HashMap<String, bool>,
) -> Vec<LlmCall> {
    let mut calls = Vec::new();
    let mut history = Vec::new();
    let mut prev_count = 0usize;
    for record in records {
        match record {
            ConvRecord::User { content, skip, .. } => {
                if !skip {
                    history.push(json!({ "role": "user", "content": content }));
                }
            }
            ConvRecord::Assistant {
                msg_id,
                content,
                timestamp,
                model,
                stop_reason,
                prompt_index,
                input_tokens,
                output_tokens,
                cache_read_input_tokens,
                cache_creation_input_tokens,
            } => {
                let delta = history[prev_count..].to_vec();
                let declared = content
                    .iter()
                    .filter_map(|block| {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            block
                                .get("id")
                                .and_then(Value::as_str)
                                .filter(|id| !id.is_empty())
                                .map(str::to_string)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>();
                let mut details = HashMap::new();
                for tool_id in &declared {
                    if let Some(result) = tool_results.get(tool_id) {
                        details.insert(
                            tool_id.clone(),
                            ToolDetail {
                                result: Some(result.clone()),
                                has_result: true,
                                is_error: tool_errors.get(tool_id).copied().unwrap_or(false),
                            },
                        );
                    }
                }
                calls.push(LlmCall {
                    model: model.clone(),
                    message_id: msg_id.clone(),
                    input_messages: delta,
                    input_is_delta: true,
                    output_content: content.clone(),
                    stop_reason: stop_reason.clone(),
                    input_tokens: *input_tokens,
                    output_tokens: *output_tokens,
                    cache_read_input_tokens: *cache_read_input_tokens,
                    cache_creation_input_tokens: *cache_creation_input_tokens,
                    declared_tool_ids: declared,
                    tool_details: details,
                    prompt_index: prompt_index.clone(),
                    incomplete: false,
                    timestamp: timestamp.clone(),
                });
                history.push(json!({ "role": "assistant", "content": content }));
                prev_count = history.len();
            }
        }
    }
    calls
}

fn value_time_ms(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        Some(Value::String(text)) => parse_time_ms(text),
        _ => None,
    }
}

fn split_into_turns(records: &[ConvRecord], llm_calls: Vec<LlmCall>) -> Vec<ChatTurn> {
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    let mut info: HashMap<String, (String, Option<Value>)> = HashMap::new();
    let mut boundary: HashMap<String, Value> = HashMap::new();
    for record in records {
        let ConvRecord::User {
            content,
            prompt_index,
            skip,
            timestamp,
        } = record
        else {
            continue;
        };
        let Some(prompt_index) = prompt_index.clone() else {
            continue;
        };
        if seen.insert(prompt_index.clone()) {
            order.push(prompt_index.clone());
        }
        if let Some(timestamp) = timestamp.clone() {
            boundary.entry(prompt_index.clone()).or_insert(timestamp);
        }
        if info.contains_key(&prompt_index) || *skip || is_tool_result_content(content) {
            continue;
        }
        info.insert(
            prompt_index,
            (extract_user_prompt_text(content), timestamp.clone()),
        );
    }
    if order.is_empty() {
        if llm_calls.is_empty() {
            return Vec::new();
        }
        return vec![ChatTurn {
            prompt_index: None,
            prompt: String::new(),
            prompt_timestamp: llm_calls.first().and_then(|call| call.timestamp.clone()),
            llm_calls,
        }];
    }
    let mut turns = Vec::new();
    let mut claimed = HashSet::new();
    for prompt_index in &order {
        let mut turn_calls = Vec::new();
        for (index, call) in llm_calls.iter().enumerate() {
            if call.prompt_index.as_deref() == Some(prompt_index.as_str()) {
                turn_calls.push(call.clone());
                claimed.insert(index);
            }
        }
        let (prompt, prompt_timestamp) = info.get(prompt_index).cloned().unwrap_or_default();
        let prompt_timestamp = prompt_timestamp
            .or_else(|| boundary.get(prompt_index).cloned())
            .or_else(|| turn_calls.first().and_then(|call| call.timestamp.clone()));
        turns.push(ChatTurn {
            prompt_index: Some(prompt_index.clone()),
            prompt,
            prompt_timestamp,
            llm_calls: turn_calls,
        });
    }
    let orphans: Vec<LlmCall> = llm_calls
        .into_iter()
        .enumerate()
        .filter(|(index, call)| !claimed.contains(index) && call.prompt_index.is_none())
        .map(|(_, call)| call)
        .collect();
    if !orphans.is_empty() {
        if let Some(last) = turns.last_mut() {
            last.llm_calls.extend(orphans);
        } else {
            turns.push(ChatTurn {
                prompt_index: None,
                prompt: String::new(),
                prompt_timestamp: None,
                llm_calls: orphans,
            });
        }
    }
    turns
}

struct RawLine {
    text: String,
    start_offset: u64,
    end_offset: u64,
}

struct LineRead {
    lines: Vec<RawLine>,
    checkpoint: Checkpoint,
    reset: bool,
}

fn read_complete_lines(
    path: &Path,
    checkpoint: &Checkpoint,
    max_bytes: u64,
) -> Result<LineRead, String> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => {
            return Ok(LineRead {
                lines: Vec::new(),
                checkpoint: Checkpoint {
                    offset: checkpoint.offset,
                    ino: checkpoint.ino.clone().filter(|ino| !ino.is_empty()),
                    size: 0,
                },
                reset: false,
            });
        }
    };
    let file_size = meta.len();
    let current_ino = file_ino(&meta);
    let identity_changed = match (&checkpoint.ino, &current_ino) {
        (Some(saved), Some(current)) => saved != current,
        _ => false,
    };
    let reset = identity_changed || checkpoint.offset > file_size || checkpoint.size > file_size;
    let mut start = if reset { 0 } else { checkpoint.offset };
    if file_size.saturating_sub(start) > max_bytes {
        start = file_size.saturating_sub(max_bytes);
    }
    if start >= file_size {
        return Ok(LineRead {
            lines: Vec::new(),
            checkpoint: Checkpoint {
                offset: start,
                ino: current_ino,
                size: file_size,
            },
            reset,
        });
    }
    let mut buffer =
        read_from(path, start, (file_size - start) as usize).map_err(|err| err.to_string())?;
    let saved_floor = if reset { 0 } else { checkpoint.offset };
    if start > saved_floor {
        if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            start += newline as u64 + 1;
            buffer = buffer[newline + 1..].to_vec();
        } else {
            return Ok(LineRead {
                lines: Vec::new(),
                checkpoint: Checkpoint {
                    offset: checkpoint.offset,
                    ino: current_ino,
                    size: file_size,
                },
                reset,
            });
        }
    }
    let Some(last_newline) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return Ok(LineRead {
            lines: Vec::new(),
            checkpoint: Checkpoint {
                offset: start,
                ino: current_ino,
                size: file_size,
            },
            reset,
        });
    };
    let complete = &buffer[..=last_newline];
    let mut lines = Vec::new();
    let mut relative = 0usize;
    while relative < complete.len() {
        let newline = complete[relative..]
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap_or(complete.len() - relative);
        let line = &complete[relative..relative + newline];
        let start_offset = start + relative as u64;
        let end_offset = start_offset + newline as u64 + 1;
        let text = String::from_utf8_lossy(line);
        if !text.trim().is_empty() {
            lines.push(RawLine {
                text: text.into_owned(),
                start_offset,
                end_offset,
            });
        }
        relative += newline + 1;
    }
    Ok(LineRead {
        lines,
        checkpoint: Checkpoint {
            offset: start + complete.len() as u64,
            ino: current_ino,
            size: file_size,
        },
        reset,
    })
}

fn event_type_name(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::new();
    for (index, ch) in chars.iter().enumerate() {
        if index > 0
            && ch.is_ascii_uppercase()
            && (chars[index - 1].is_ascii_lowercase() || chars[index - 1].is_ascii_digit())
        {
            out.push('_');
        }
        if *ch == '-' {
            out.push('_');
        } else {
            out.extend(ch.to_lowercase());
        }
    }
    out
}

fn normalize_grok_tool_status(raw: Option<&Value>) -> Option<String> {
    let text = raw?.as_str()?;
    let status = text.trim().to_lowercase();
    if status.is_empty() {
        return None;
    }
    Some(
        match status.as_str() {
            "completed" | "complete" | "success" | "succeeded" => "success",
            "failed" | "failure" | "error" => "failure",
            "cancelled" | "canceled" => "cancelled",
            _ => "unknown",
        }
        .to_string(),
    )
}

fn is_progress_status(raw: Option<&Value>) -> bool {
    let Some(text) = raw.and_then(Value::as_str) else {
        return false;
    };
    matches!(
        text.trim().to_lowercase().as_str(),
        "in_progress" | "in-progress" | "pending" | "running" | "started"
    )
}

fn object_field<'a>(value: &'a Obj, key: &str) -> Option<&'a Obj> {
    value.get(key).and_then(Value::as_object)
}

fn prompt_id_of(params: &Obj, update: &Obj) -> Option<String> {
    let meta = object_field(params, "_meta");
    for value in [
        meta.and_then(|meta| meta.get("promptId")),
        meta.and_then(|meta| meta.get("prompt_id")),
        update.get("promptId"),
        update.get("prompt_id"),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            return Some(text.to_string());
        }
    }
    None
}

fn prompt_index_value(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .map(js_number_string),
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn prompt_index_of(params: &Obj, update: &Obj) -> Option<String> {
    let update_meta = object_field(update, "_meta");
    let params_meta = object_field(params, "_meta");
    for value in [
        update_meta.and_then(|meta| meta.get("promptIndex")),
        update_meta.and_then(|meta| meta.get("prompt_index")),
        params_meta.and_then(|meta| meta.get("promptIndex")),
        params_meta.and_then(|meta| meta.get("prompt_index")),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(text) = prompt_index_value(value) {
            return Some(text);
        }
    }
    None
}

fn tool_name_of(update: &Obj) -> Option<String> {
    let meta = object_field(update, "_meta");
    let named = meta
        .and_then(|meta| meta.get("x.ai/tool"))
        .and_then(Value::as_object)
        .and_then(|tool| tool.get("name"))
        .or_else(|| {
            meta.and_then(|meta| meta.get("x_ai_tool"))
                .and_then(Value::as_object)
                .and_then(|tool| tool.get("name"))
        })
        .or_else(|| update.get("toolName"))
        .or_else(|| update.get("tool_name"));
    named
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn tool_id_of(update: &Obj) -> String {
    update
        .get("toolCallId")
        .or_else(|| update.get("tool_call_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn event_timestamp_ms(record: &Obj, params: &Obj) -> Option<f64> {
    if let Some(agent) =
        object_field(params, "_meta").and_then(|meta| finite_number(meta.get("agentTimestampMs")))
    {
        return Some(agent);
    }
    match record.get("timestamp") {
        Some(Value::String(text)) => parse_time_ms(text),
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .map(scale_unix_ms),
        _ => None,
    }
}

fn parse_grok_updates(
    path: &Path,
    checkpoint: &Checkpoint,
    fallback_prompt_id: Option<&str>,
    max_bytes: u64,
) -> Result<UpdatesParse, HookFail> {
    let read = read_complete_lines(path, checkpoint, max_bytes).map_err(HookFail::Other)?;
    let mut events = Vec::new();
    #[cfg(test)]
    let mut parse_errors = 0u32;
    for line in read.lines {
        let Ok(raw) = serde_json::from_str::<Value>(&line.text) else {
            #[cfg(test)]
            {
                parse_errors += 1;
            }
            continue;
        };
        let record = raw.as_object();
        let params = record
            .and_then(|record| record.get("params"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let update = params
            .get("update")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let kind_type = event_type_name(
            update
                .get("sessionUpdate")
                .or_else(|| update.get("session_update"))
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        let raw_status = update.get("status");
        let tool_status = normalize_grok_tool_status(raw_status);
        let is_tool = kind_type == "tool_call_update";
        let has_start = is_tool
            && (update.get("rawInput").is_some_and(|value| !value.is_null())
                || update
                    .get("raw_input")
                    .is_some_and(|value| !value.is_null())
                || update.get("title").is_some_and(|value| !value.is_null())
                || tool_name_of(&update).is_some());
        let terminal_status = matches!(
            tool_status.as_deref(),
            Some("success") | Some("failure") | Some("cancelled")
        );
        let has_output = ["rawOutput", "raw_output", "content"]
            .iter()
            .any(|key| update.get(*key).is_some_and(|value| !value.is_null()));
        let has_completion = is_tool
            && (terminal_status || (!has_start && !is_progress_status(raw_status) && has_output));
        let kind = if kind_type == "turn_completed" {
            "turn_completed"
        } else if has_completion {
            "tool_completion"
        } else if has_start {
            "tool_start"
        } else if kind_type.is_empty() {
            "unknown"
        } else {
            ""
        };
        let kind = if kind.is_empty() {
            kind_type.clone()
        } else {
            kind.to_string()
        };
        events.push(UpdateEvent {
            kind,
            prompt_id: prompt_id_of(&params, &update),
            prompt_index: prompt_index_of(&params, &update),
            timestamp_ms: record.and_then(|record| event_timestamp_ms(record, &params)),
            turn_start_ms: object_field(&params, "_meta").and_then(|meta| {
                finite_number(meta.get("turnStartMs"))
                    .or_else(|| finite_number(meta.get("turn_start_ms")))
            }),
            tool_id: tool_id_of(&update),
            tool_name: tool_name_of(&update),
            tool_status,
            tool_input: first_present(&[update.get("rawInput"), update.get("raw_input")]),
            tool_output: first_present(&[
                update.get("rawOutput"),
                update.get("raw_output"),
                update.get("content"),
            ]),
            stop_reason: update
                .get("stopReason")
                .or_else(|| update.get("stop_reason"))
                .and_then(Value::as_str)
                .filter(|reason| !reason.is_empty())
                .map(str::to_string),
            usage: update
                .get("usage")
                .filter(|value| !value.is_null())
                .cloned(),
            start_offset: line.start_offset,
            end_offset: line.end_offset,
        });
    }
    let turns = build_update_turns(events, fallback_prompt_id.map(str::to_string));
    let last_completed_offset = turns
        .iter()
        .rev()
        .find(|turn| turn.completed)
        .map(|turn| turn.end_offset)
        .unwrap_or(checkpoint.offset);
    Ok(UpdatesParse {
        turns,
        checkpoint: read.checkpoint,
        last_completed_offset,
        #[cfg(test)]
        parse_errors,
        reset: read.reset,
    })
}

fn build_update_turns(
    events: Vec<UpdateEvent>,
    fallback_prompt_id: Option<String>,
) -> Vec<UpdateTurn> {
    let mut turns = Vec::new();
    let mut segment = Vec::new();
    for event in events {
        let completed = event.kind == "turn_completed";
        segment.push(event);
        if completed {
            push_update_turn(&mut turns, &mut segment, true, &fallback_prompt_id);
        }
    }
    if !segment.is_empty() {
        push_update_turn(&mut turns, &mut segment, false, &fallback_prompt_id);
    }
    turns
}

fn push_update_turn(
    turns: &mut Vec<UpdateTurn>,
    segment: &mut Vec<UpdateEvent>,
    completed: bool,
    fallback_prompt_id: &Option<String>,
) {
    if segment.is_empty() {
        return;
    }
    let all = std::mem::take(segment);
    let terminal = if completed { all.last() } else { None };
    let prompt_id = terminal
        .and_then(|event| event.prompt_id.clone())
        .or_else(|| all.iter().find_map(|event| event.prompt_id.clone()))
        .or_else(|| fallback_prompt_id.clone());
    let prompt_index = all.iter().find_map(|event| event.prompt_index.clone());
    let timestamps: Vec<f64> = all.iter().filter_map(|event| event.timestamp_ms).collect();
    let turn_starts: Vec<f64> = all.iter().filter_map(|event| event.turn_start_ms).collect();
    let start_ms = if !turn_starts.is_empty() {
        turn_starts.into_iter().reduce(f64::min)
    } else {
        timestamps.iter().copied().reduce(f64::min)
    };
    let end_ms = terminal
        .and_then(|event| event.timestamp_ms)
        .or_else(|| timestamps.into_iter().reduce(f64::max));
    let start_offset = all.first().map(|event| event.start_offset).unwrap_or(0);
    let end_offset = all.last().map(|event| event.end_offset).unwrap_or(0);
    turns.push(UpdateTurn {
        prompt_id,
        prompt_index,
        completed,
        stop_reason: terminal.and_then(|event| event.stop_reason.clone()),
        usage: terminal.and_then(|event| event.usage.clone()),
        start_ms,
        end_ms,
        end_offset,
        tool_starts: all
            .iter()
            .filter(|event| event.kind == "tool_start")
            .cloned()
            .collect(),
        tool_completions: all
            .iter()
            .filter(|event| event.kind == "tool_completion")
            .cloned()
            .collect(),
    });
    let _ = start_offset;
}

fn read_system_prompt(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len().min(2 * 1024 * 1024) as usize;
    let mut buf = vec![0u8; len];
    let mut filled = 0usize;
    while filled < len {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    let text = String::from_utf8_lossy(&buf);
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("system") {
            continue;
        }
        return match value.get("content") {
            Some(Value::String(text)) => Some(text.clone()),
            Some(Value::Array(_)) => Some(extract_text_content(
                value.get("content").unwrap_or(&Value::Null),
            )),
            _ => None,
        };
    }
    None
}

fn blank_group(loop_index: f64, start_ms: Option<f64>) -> UnifiedGroup {
    UnifiedGroup {
        loop_index,
        start_ms,
        end_ms: None,
        model_elapsed_ms: None,
        prompt_tokens: None,
        cached_prompt_tokens: None,
        cache_creation_input_tokens: None,
        completion_tokens: None,
        tools: Vec::new(),
    }
}

fn parse_grok_unified(
    path: &Path,
    session_id: &str,
    max_bytes: u64,
) -> Result<UnifiedParse, HookFail> {
    if session_id.is_empty() {
        return Ok(UnifiedParse {
            groups: Vec::new(),
            #[cfg(test)]
            parse_errors: 0,
        });
    }
    let lines = read_unified_lines(path, max_bytes)?;
    let mut records = Vec::new();
    #[cfg(test)]
    let mut parse_errors = 0u32;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<Value>(&line) else {
            #[cfg(test)]
            {
                parse_errors += 1;
            }
            continue;
        };
        if raw.get("sid").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        let Some(timestamp_ms) = (match raw.get("ts") {
            Some(Value::Number(number)) => {
                number.as_f64().filter(|n| n.is_finite()).map(scale_unix_ms)
            }
            Some(Value::String(text)) if !text.is_empty() => parse_time_ms(text),
            _ => None,
        }) else {
            continue;
        };
        let Some(msg) = raw.get("msg").and_then(Value::as_str) else {
            continue;
        };
        if msg != "shell.turn.inference_start"
            && msg != "shell.turn.inference_done"
            && msg != "shell.tool.exec_done"
        {
            continue;
        }
        let ctx = raw
            .get("ctx")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        records.push((timestamp_ms, msg.to_string(), ctx));
    }
    records.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut groups = Vec::new();
    let mut current: Option<usize> = None;
    for (timestamp_ms, msg, ctx) in records {
        if msg == "shell.turn.inference_start" {
            let loop_index = json_f64(ctx.get("loop_index")).unwrap_or((groups.len() + 1) as f64);
            groups.push(blank_group(loop_index, Some(timestamp_ms)));
            current = Some(groups.len() - 1);
            continue;
        }
        if msg == "shell.turn.inference_done" {
            let loop_index = json_f64(ctx.get("loop_index"));
            let mut target = current.filter(|index| groups[*index].end_ms.is_none());
            if target.is_none()
                || loop_index.is_some_and(|index| {
                    target.is_some_and(|target| groups[target].loop_index != index)
                })
            {
                target = groups
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, group)| {
                        group.end_ms.is_none()
                            && loop_index
                                .map(|index| group.loop_index == index)
                                .unwrap_or(true)
                    })
                    .map(|(index, _)| index);
            }
            if target.is_none() {
                let elapsed = json_f64(ctx.get("model_elapsed_ms"));
                let start = elapsed
                    .map(|elapsed| timestamp_ms - elapsed)
                    .unwrap_or(timestamp_ms);
                let loop_index = loop_index.unwrap_or((groups.len() + 1) as f64);
                groups.push(blank_group(loop_index, Some(start)));
                target = Some(groups.len() - 1);
            }
            let target = target.unwrap_or(0);
            groups[target].end_ms = Some(timestamp_ms);
            groups[target].model_elapsed_ms = json_f64(ctx.get("model_elapsed_ms"));
            if groups[target].model_elapsed_ms.is_some()
                && groups[target].start_ms == groups[target].end_ms
            {
                let elapsed = groups[target].model_elapsed_ms.unwrap_or(0.0);
                groups[target].start_ms = Some(timestamp_ms - elapsed);
            }
            groups[target].prompt_tokens = json_f64(ctx.get("prompt_tokens"));
            groups[target].cached_prompt_tokens = json_f64(ctx.get("cached_prompt_tokens"));
            groups[target].cache_creation_input_tokens =
                json_f64(ctx.get("cache_creation_input_tokens"));
            groups[target].completion_tokens = json_f64(ctx.get("completion_tokens"));
            current = Some(target);
            continue;
        }
        let target = current
            .filter(|index| groups[*index].end_ms.is_some())
            .or_else(|| {
                groups
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, group)| group.end_ms.is_some())
                    .map(|(index, _)| index)
            });
        let Some(target) = target else {
            continue;
        };
        let elapsed = json_f64(ctx.get("elapsed_ms")).unwrap_or(0.0).max(0.0);
        let name = ctx
            .get("tool_name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or("unknown");
        let success = match ctx.get("success") {
            Some(Value::Bool(flag)) => Some(*flag),
            _ => None,
        };
        groups[target].tools.push(UnifiedTool {
            name: name.to_string(),
            start_ms: timestamp_ms - elapsed,
            end_ms: timestamp_ms,
            elapsed_ms: elapsed,
            success,
        });
    }
    Ok(UnifiedParse {
        groups,
        #[cfg(test)]
        parse_errors,
    })
}

fn read_unified_lines(path: &Path, max_bytes: u64) -> Result<Vec<String>, HookFail> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return Ok(Vec::new()),
    };
    if meta.len() == 0 {
        return Ok(Vec::new());
    }
    let start = meta.len().saturating_sub(max_bytes);
    let mut buffer = read_from(path, start, (meta.len() - start) as usize)
        .map_err(|err| HookFail::Other(err.to_string()))?;
    if start > 0 {
        let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };
        buffer = buffer[newline + 1..].to_vec();
    }
    let Some(last) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return Ok(Vec::new());
    };
    let text = String::from_utf8_lossy(&buffer[..=last]);
    Ok(text.split('\n').map(str::to_string).collect())
}

fn select_indices(
    groups: &[UnifiedGroup],
    start_ms: Option<f64>,
    end_ms: Option<f64>,
    expected_count: usize,
) -> Vec<usize> {
    let mut selected: Vec<usize> = (0..groups.len()).collect();
    if start_ms.is_some_and(|value| value.is_finite())
        || end_ms.is_some_and(|value| value.is_finite())
    {
        let lower = start_ms
            .filter(|value| value.is_finite())
            .map(|value| value - 2000.0)
            .unwrap_or(f64::NEG_INFINITY);
        let upper = end_ms
            .filter(|value| value.is_finite())
            .map(|value| value + 2000.0)
            .unwrap_or(f64::INFINITY);
        selected.retain(|index| {
            let observed = groups[*index].start_ms.or(groups[*index].end_ms);
            observed.is_some_and(|value| value >= lower && value <= upper)
        });
    }
    if expected_count > 0 && selected.len() > expected_count {
        let completed: Vec<usize> = selected
            .iter()
            .copied()
            .filter(|index| groups[*index].end_ms.is_some_and(|value| value.is_finite()))
            .collect();
        if completed.len() >= expected_count {
            selected = completed[completed.len() - expected_count..].to_vec();
        } else {
            selected = selected[selected.len() - expected_count..].to_vec();
        }
    }
    selected
}

#[cfg(test)]
fn select_unified_groups(
    groups: &[UnifiedGroup],
    start_ms: Option<f64>,
    end_ms: Option<f64>,
    expected_count: usize,
) -> Vec<UnifiedGroup> {
    select_indices(groups, start_ms, end_ms, expected_count)
        .into_iter()
        .map(|index| groups[index].clone())
        .collect()
}

fn current_update_index(turns: &[UpdateTurn], prompt_id: Option<&str>) -> Option<usize> {
    if let Some(prompt_id) = prompt_id {
        if let Some(index) = turns
            .iter()
            .enumerate()
            .rev()
            .find(|(_, turn)| turn.prompt_id.as_deref() == Some(prompt_id))
            .map(|(index, _)| index)
        {
            return Some(index);
        }
    }
    if turns.is_empty() {
        None
    } else {
        Some(turns.len() - 1)
    }
}

fn terminal_targets(
    trigger: &str,
    event: &Obj,
    state: &SessionState,
    turns: &[UpdateTurn],
) -> Vec<ExportTarget> {
    if trigger == "stop" || trigger == "stop_failure" {
        let prompt = event_str(event, "prompt_id");
        let index = current_update_index(turns, prompt);
        let update = index.and_then(|index| turns.get(index));
        let Some(prompt_id) = prompt
            .map(str::to_string)
            .or_else(|| update.and_then(|turn| turn.prompt_id.clone()))
            .filter(|id| !id.is_empty())
        else {
            return Vec::new();
        };
        let stop_reason = if trigger == "stop_failure" {
            "error".into()
        } else {
            normalize_terminal_reason(
                event_str(event, "stop_reason")
                    .or(update.and_then(|turn| turn.stop_reason.as_deref())),
                "end_turn",
            )
        };
        return vec![ExportTarget {
            update_index: index,
            prompt_id,
            stop_reason,
            error_type: if trigger == "stop_failure" {
                Some(classify_model_error(event))
            } else {
                None
            },
        }];
    }
    let mut eligible: Vec<usize> = turns
        .iter()
        .enumerate()
        .filter(|(_, turn)| {
            turn.completed
                && turn
                    .prompt_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty() && !has_exported_prompt(state, id))
        })
        .map(|(index, _)| index)
        .collect();
    if trigger == "user_prompt_submit" {
        if let Some(prompt_id) = event_str(event, "prompt_id") {
            eligible.retain(|index| turns[*index].prompt_id.as_deref() != Some(prompt_id));
        }
    }
    let cold = state.turn_count == 0
        && state.chat_checkpoint.offset == 0
        && state.updates_checkpoint.offset == 0
        && state.recent_prompt_ids.is_empty();
    if cold && eligible.len() > 1 {
        if let Some(last) = eligible.last().copied() {
            eligible = vec![last];
        }
    }
    eligible
        .into_iter()
        .map(|index| {
            let turn = &turns[index];
            let normalized = normalize_terminal_reason(turn.stop_reason.as_deref(), "end_turn");
            ExportTarget {
                update_index: Some(index),
                prompt_id: turn.prompt_id.clone().unwrap_or_default(),
                error_type: if normalized == "error" {
                    Some("model_error".into())
                } else {
                    None
                },
                stop_reason: normalized,
            }
        })
        .collect()
}

fn take_matching_chat_turn(
    turns: &[ChatTurn],
    update: Option<&UpdateTurn>,
    used: &mut HashSet<usize>,
    allow_latest: bool,
) -> Option<ChatTurn> {
    let mut index = None;
    if let Some(prompt_index) = update.and_then(|turn| turn.prompt_index.as_deref()) {
        index = turns.iter().enumerate().find_map(|(idx, turn)| {
            if !used.contains(&idx) && turn.prompt_index.as_deref() == Some(prompt_index) {
                Some(idx)
            } else {
                None
            }
        });
    }
    if index.is_none() {
        if let Some(start) = update
            .and_then(|turn| turn.start_ms)
            .filter(|value| value.is_finite())
        {
            let mut candidates: Vec<(usize, f64)> = turns
                .iter()
                .enumerate()
                .filter_map(|(idx, turn)| {
                    if used.contains(&idx) {
                        return None;
                    }
                    value_time_ms(turn.prompt_timestamp.as_ref()).map(|timestamp| (idx, timestamp))
                })
                .collect();
            let end = update
                .and_then(|turn| turn.end_ms)
                .filter(|value| value.is_finite());
            if end.is_some_and(|end| end == start) {
                let end = end.unwrap_or(start);
                candidates.retain(|(_, timestamp)| *timestamp <= end);
                candidates.sort_by(|left, right| {
                    right
                        .1
                        .partial_cmp(&left.1)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                index = candidates.first().map(|(idx, _)| *idx);
            } else if !candidates.is_empty() {
                candidates.sort_by(|left, right| {
                    (left.1 - start)
                        .abs()
                        .partial_cmp(&(right.1 - start).abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                index = candidates.first().map(|(idx, _)| *idx);
            }
        }
    }
    if index.is_none() && allow_latest {
        index = (0..turns.len()).rev().find(|idx| !used.contains(idx));
    }
    let index = index?;
    used.insert(index);
    Some(turns[index].clone())
}

fn normalize_tool_name(value: Option<&str>) -> String {
    match value {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => "unknown".into(),
    }
}

fn is_within(value: Option<f64>, start: Option<f64>, end: Option<f64>) -> bool {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return false;
    };
    if let Some(start) = start.filter(|value| value.is_finite()) {
        if value < start - 2000.0 {
            return false;
        }
    }
    if let Some(end) = end.filter(|value| value.is_finite()) {
        if value > end + 2000.0 {
            return false;
        }
    }
    true
}

fn events_for_group(
    events: &[UpdateEvent],
    used: &HashSet<usize>,
    group: Option<&UnifiedGroup>,
    next_group: Option<&UnifiedGroup>,
) -> Vec<(usize, UpdateEvent)> {
    events
        .iter()
        .enumerate()
        .filter(|(index, event)| {
            if used.contains(index) {
                return false;
            }
            match group {
                None => true,
                Some(group) => is_within(
                    event.timestamp_ms,
                    group.end_ms.or(group.start_ms),
                    next_group.and_then(|group| group.start_ms),
                ),
            }
        })
        .map(|(index, event)| (index, event.clone()))
        .collect()
}

fn take_name(names: &[Option<String>], used: &mut HashSet<usize>, name: &str) -> Option<usize> {
    let want = normalize_tool_name(Some(name));
    let index = names.iter().enumerate().find_map(|(index, item)| {
        if !used.contains(&index) && normalize_tool_name(item.as_deref()) == want {
            Some(index)
        } else {
            None
        }
    })?;
    used.insert(index);
    Some(index)
}

fn find_id(ids: &[String], used: &HashSet<usize>, id: &str) -> Option<usize> {
    if id.is_empty() {
        return None;
    }
    ids.iter()
        .enumerate()
        .find(|(index, item)| !used.contains(index) && item.as_str() == id)
        .map(|(index, _)| index)
}

fn usage_number(usage: Option<&Value>, keys: &[&str]) -> Option<f64> {
    let obj = usage?.as_object()?;
    keys.iter().find_map(|key| json_f64(obj.get(*key)))
}

fn resolve_status(
    unified_success: Option<bool>,
    saw_unified: bool,
    update_status: Option<&str>,
    chat_error: bool,
    stop_reason: &str,
    has_result: bool,
) -> String {
    if saw_unified {
        if let Some(success) = unified_success {
            return if success { "success" } else { "failure" }.into();
        }
    }
    if let Some(status) = update_status {
        if !status.is_empty() && status != "unknown" {
            return status.to_string();
        }
    }
    if chat_error {
        return "failure".into();
    }
    if update_status == Some("unknown") {
        return "unknown".into();
    }
    if has_result {
        return "success".into();
    }
    if stop_reason == "cancelled" || stop_reason == "canceled" {
        return "cancelled".into();
    }
    "unknown".into()
}

fn fuse_grok_turn(
    chat_turn: &ChatTurn,
    update_turn: Option<&UpdateTurn>,
    unified_groups: &[UnifiedGroup],
    prompt_id: &str,
    stop_reason: &str,
    hook_timestamp_ms: Option<f64>,
) -> FusedTurn {
    let start_ms = update_turn.and_then(|turn| turn.start_ms);
    let completed_end = update_turn
        .filter(|turn| turn.completed)
        .and_then(|turn| turn.end_ms);
    let end_ms = completed_end
        .or(hook_timestamp_ms)
        .or(update_turn.and_then(|turn| turn.end_ms));
    let windowed_idx = select_indices(unified_groups, start_ms, end_ms, 0);
    let windowed: Vec<UnifiedGroup> = windowed_idx
        .iter()
        .map(|index| unified_groups[*index].clone())
        .collect();
    let selected_idx = if chat_turn.llm_calls.is_empty() {
        Vec::new()
    } else {
        select_indices(&windowed, None, None, chat_turn.llm_calls.len())
    };
    let mut call_groups: Vec<(LlmCall, Option<UnifiedGroup>)> = chat_turn
        .llm_calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            (
                call.clone(),
                selected_idx
                    .get(index)
                    .map(|group_index| windowed[*group_index].clone()),
            )
        })
        .collect();
    if stop_reason == "error" {
        let paired: HashSet<usize> = selected_idx.iter().copied().collect();
        for (index, group) in windowed.iter().enumerate() {
            if paired.contains(&index) {
                continue;
            }
            if !group.start_ms.is_some_and(|value| value.is_finite())
                || group.end_ms.is_some_and(|value| value.is_finite())
            {
                continue;
            }
            let loop_label = if group.loop_index.is_finite() {
                js_index(group.loop_index)
            } else {
                (index + 1).to_string()
            };
            call_groups.push((
                LlmCall {
                    model: "grok".into(),
                    message_id: format!("{prompt_id}:incomplete:{loop_label}"),
                    input_messages: Vec::new(),
                    input_is_delta: true,
                    output_content: Vec::new(),
                    stop_reason: "error".into(),
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_input_tokens: None,
                    cache_creation_input_tokens: None,
                    declared_tool_ids: Vec::new(),
                    tool_details: HashMap::new(),
                    prompt_index: update_turn
                        .and_then(|turn| turn.prompt_index.clone())
                        .or_else(|| chat_turn.prompt_index.clone()),
                    incomplete: true,
                    timestamp: None,
                },
                Some(group.clone()),
            ));
        }
    }
    let update_starts = update_turn
        .map(|turn| turn.tool_starts.as_slice())
        .unwrap_or(&[]);
    let update_completions = update_turn
        .map(|turn| turn.tool_completions.as_slice())
        .unwrap_or(&[]);
    let mut used_starts = HashSet::new();
    let mut used_completions = HashSet::new();
    let mut previous_step_end = start_ms.or(hook_timestamp_ms).or(end_ms);
    let mut fused_calls = Vec::new();
    for call_index in 0..call_groups.len() {
        let call = call_groups[call_index].0.clone();
        let group = call_groups[call_index].1.clone();
        let next_group = call_groups
            .get(call_index + 1)
            .and_then(|item| item.1.clone());
        let group_starts = events_for_group(
            update_starts,
            &used_starts,
            group.as_ref(),
            next_group.as_ref(),
        );
        let group_completions = events_for_group(
            update_completions,
            &used_completions,
            group.as_ref(),
            next_group.as_ref(),
        );
        let start_names: Vec<Option<String>> = group_starts
            .iter()
            .map(|(_, event)| event.tool_name.clone())
            .collect();
        let start_ids: Vec<String> = group_starts
            .iter()
            .map(|(_, event)| event.tool_id.clone())
            .collect();
        let completion_names: Vec<Option<String>> = group_completions
            .iter()
            .map(|(_, event)| event.tool_name.clone())
            .collect();
        let completion_ids: Vec<String> = group_completions
            .iter()
            .map(|(_, event)| event.tool_id.clone())
            .collect();
        let unified_names: Vec<Option<String>> = group
            .as_ref()
            .map(|group| {
                group
                    .tools
                    .iter()
                    .map(|tool| Some(tool.name.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut local_starts = HashSet::new();
        let mut local_completions = HashSet::new();
        let mut unified_used = HashSet::new();
        let mut tools = Vec::new();
        for (tool_index, declared_id) in call.declared_tool_ids.iter().enumerate() {
            let block = call.output_content.iter().find(|block| {
                block.get("type").and_then(Value::as_str) == Some("tool_use")
                    && block.get("id").and_then(Value::as_str) == Some(declared_id.as_str())
            });
            let name = normalize_tool_name(
                block
                    .and_then(|block| block.get("name"))
                    .and_then(Value::as_str),
            );
            let source_id = block
                .and_then(|block| block.get("source_id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .unwrap_or("")
                .to_string();
            let chat_details = call.tool_details.get(declared_id);
            let unified_index = take_name(&unified_names, &mut unified_used, &name);
            let unified_tool = unified_index
                .and_then(|index| group.as_ref().and_then(|group| group.tools.get(index)));
            let mut start_matched_by_id = false;
            let mut start_index = if !source_id.is_empty() {
                find_id(&start_ids, &local_starts, &source_id)
            } else {
                None
            };
            if let Some(index) = start_index {
                local_starts.insert(index);
                start_matched_by_id = true;
            } else {
                start_index = take_name(&start_names, &mut local_starts, &name);
            }
            let start_event = start_index.map(|index| &group_starts[index].1);
            let completion_id = if !source_id.is_empty() {
                source_id.clone()
            } else {
                start_event
                    .map(|event| event.tool_id.clone())
                    .unwrap_or_default()
            };
            let mut completion_index = find_id(&completion_ids, &local_completions, &completion_id);
            let completion_matched_by_id = completion_index.is_some()
                && !source_id.is_empty()
                && completion_index
                    .and_then(|index| group_completions.get(index))
                    .is_some_and(|(_, event)| event.tool_id == source_id);
            if completion_index.is_none() {
                completion_index = take_name(&completion_names, &mut local_completions, &name);
            }
            if let Some(index) = completion_index {
                local_completions.insert(index);
            }
            let completion_event = completion_index.map(|index| &group_completions[index].1);
            if let Some(index) = start_index {
                used_starts.insert(group_starts[index].0);
            }
            if let Some(index) = completion_index {
                used_completions.insert(group_completions[index].0);
            }
            let update_id = start_event
                .map(|event| event.tool_id.clone())
                .filter(|id| !id.is_empty())
                .or_else(|| {
                    completion_event
                        .map(|event| event.tool_id.clone())
                        .filter(|id| !id.is_empty())
                })
                .unwrap_or_default();
            let loop_label = group
                .as_ref()
                .map(|group| js_index(group.loop_index))
                .unwrap_or_else(|| (call_index + 1).to_string());
            let prompt_label = if prompt_id.is_empty() {
                "unknown"
            } else {
                prompt_id
            };
            let deterministic_id = format!("{prompt_label}:l{loop_label}:t{}", tool_index + 1);
            let tool_id = if !source_id.is_empty() {
                source_id.clone()
            } else if !update_id.is_empty() {
                update_id
            } else {
                deterministic_id
            };
            let chat_matched_by_id = !source_id.is_empty()
                && chat_details.is_some_and(|detail| detail.has_result || detail.is_error);
            let matched_by_id =
                start_matched_by_id || completion_matched_by_id || chat_matched_by_id;
            let has_evidence = unified_tool.is_some()
                || start_event.is_some()
                || completion_event.is_some()
                || chat_details.is_some_and(|detail| detail.has_result);
            let match_strategy = if matched_by_id {
                "id"
            } else if has_evidence {
                "name_order"
            } else {
                "unmatched"
            };
            let (result_present, result) = if let Some(output) =
                completion_event.and_then(|event| event.tool_output.clone())
            {
                (true, Some(output))
            } else if chat_details.is_some_and(|detail| detail.has_result) {
                (true, chat_details.and_then(|detail| detail.result.clone()))
            } else {
                (false, None)
            };
            let status = resolve_status(
                unified_tool.and_then(|tool| tool.success),
                unified_tool.is_some(),
                completion_event.and_then(|event| event.tool_status.as_deref()),
                chat_details.is_some_and(|detail| detail.is_error),
                stop_reason,
                result_present,
            );
            let update_start_ms = start_event.and_then(|event| event.timestamp_ms);
            let update_end_ms = completion_event.and_then(|event| event.timestamp_ms);
            let fallback_ms = hook_timestamp_ms.or(previous_step_end).or(end_ms);
            let tool_start = unified_tool
                .map(|tool| tool.start_ms)
                .or(update_start_ms)
                .or(fallback_ms);
            let tool_end_raw = unified_tool
                .map(|tool| tool.end_ms)
                .or(update_end_ms)
                .or(tool_start);
            let stored_end = tool_start
                .unwrap_or(0.0)
                .max(tool_end_raw.or(tool_start).unwrap_or(0.0));
            let duration_ms = if let Some(tool) = unified_tool {
                Some(tool.elapsed_ms)
            } else if let (Some(start), Some(end)) = (tool_start, tool_end_raw) {
                if start.is_finite() && end.is_finite() {
                    Some((end - start).max(0.0))
                } else {
                    None
                }
            } else {
                None
            };
            let timing_source = if unified_tool.is_some() {
                "unified"
            } else if start_event.is_some() || completion_event.is_some() {
                "updates"
            } else {
                "hook"
            };
            let arguments = block
                .and_then(|block| block.get("input"))
                .filter(|value| !value.is_null())
                .cloned()
                .or_else(|| start_event.and_then(|event| event.tool_input.clone()))
                .unwrap_or_else(|| json!({}));
            tools.push(FusedTool {
                id: tool_id,
                name,
                arguments,
                result_present,
                result,
                status,
                start_ms: tool_start,
                end_ms: stored_end,
                duration_ms,
                match_strategy: match_strategy.into(),
                timing_source: timing_source.into(),
            });
        }
        let mut output_tool_index = 0usize;
        let output_content = call
            .output_content
            .iter()
            .map(|block| {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    return block.clone();
                }
                let Some(tool) = tools.get(output_tool_index) else {
                    output_tool_index += 1;
                    return block.clone();
                };
                output_tool_index += 1;
                let mut cloned = block.as_object().cloned().unwrap_or_default();
                cloned.insert("id".into(), Value::String(tool.id.clone()));
                Value::Object(cloned)
            })
            .collect::<Vec<_>>();
        let fallback_start = previous_step_end.or(start_ms).or(hook_timestamp_ms);
        let request_start = group
            .as_ref()
            .and_then(|group| group.start_ms)
            .or(fallback_start);
        let first_tool_start = tools
            .iter()
            .filter_map(|tool| tool.start_ms)
            .filter(|value| value.is_finite())
            .reduce(f64::min);
        let is_last = call_index + 1 == call_groups.len();
        let fallback_end = if first_tool_start.is_some() {
            first_tool_start
        } else if is_last {
            end_ms
        } else {
            request_start
        };
        let response_end = request_start.unwrap_or(0.0).max(
            group
                .as_ref()
                .and_then(|group| group.end_ms)
                .or(fallback_end)
                .or(request_start)
                .unwrap_or(0.0),
        );
        let step_end = tools
            .iter()
            .fold(response_end, |max, tool| max.max(tool.end_ms));
        previous_step_end = Some(step_end);
        let finish_reason = if !tools.is_empty() {
            "tool_use".into()
        } else if is_last {
            stop_reason.to_string()
        } else if !call.stop_reason.is_empty() {
            call.stop_reason.clone()
        } else {
            "end_turn".into()
        };
        let single_usage = if call_groups.len() == 1 {
            update_turn.and_then(|turn| turn.usage.as_ref())
        } else {
            None
        };
        let input_tokens = group
            .as_ref()
            .and_then(|group| group.prompt_tokens)
            .or(call.input_tokens)
            .or_else(|| usage_number(single_usage, &["inputTokens", "input_tokens"]));
        let output_tokens = group
            .as_ref()
            .and_then(|group| group.completion_tokens)
            .or(call.output_tokens)
            .or_else(|| usage_number(single_usage, &["outputTokens", "output_tokens"]));
        let cache_read = group
            .as_ref()
            .and_then(|group| group.cached_prompt_tokens)
            .or(call.cache_read_input_tokens)
            .or_else(|| usage_number(single_usage, &["cachedReadTokens", "cached_read_tokens"]));
        let cache_creation = group
            .as_ref()
            .and_then(|group| group.cache_creation_input_tokens)
            .or(call.cache_creation_input_tokens);
        fused_calls.push(FusedCall {
            model: call.model,
            message_id: call.message_id,
            input_messages: call.input_messages,
            input_is_delta: call.input_is_delta,
            output_content,
            request_start_ms: request_start,
            response_end_ms: response_end,
            timing_source: if group.is_some() {
                "unified".into()
            } else if update_turn.is_some() {
                "updates".into()
            } else {
                "hook".into()
            },
            finish_reason,
            tools,
            input_tokens,
            output_tokens,
            cache_read_input_tokens: cache_read,
            cache_creation_input_tokens: cache_creation,
            incomplete: call.incomplete,
        });
    }
    FusedTurn {
        prompt_id: Some(prompt_id.to_string()),
        prompt: chat_turn.prompt.clone(),
        prompt_timestamp_ms: start_ms.or(hook_timestamp_ms),
        terminal_timestamp_ms: end_ms.or(hook_timestamp_ms),
        stop_reason: stop_reason.to_string(),
        llm_calls: fused_calls,
    }
}

fn map_stop_reason(raw: &str) -> String {
    match raw {
        "" | "end_turn" | "stop" | "completed" => "stop".into(),
        "tool_use" | "tool_calls" => "tool_call".into(),
        "max_tokens" | "length" => "length".into(),
        "content_filter" => "content_filter".into(),
        "error" => "error".into(),
        other => other.to_string(),
    }
}

fn falsy_or_null(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Value::String(text.clone()),
        Some(Value::Number(number))
            if number.as_f64().is_some_and(|n| n != 0.0 && n.is_finite()) =>
        {
            Value::Number(number.clone())
        }
        Some(Value::Bool(true)) => Value::Bool(true),
        _ => Value::Null,
    }
}

fn convert_block(block: &Value) -> Option<Value> {
    let block = block.as_object()?;
    match block.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" => Some(json!({
            "type": "text",
            "content": block.get("text").and_then(Value::as_str).unwrap_or(""),
        })),
        "tool_use" => Some(json!({
            "type": "tool_call",
            "id": falsy_or_null(block.get("id")),
            "name": block.get("name").and_then(Value::as_str).unwrap_or(""),
            "arguments": block.get("input").cloned().unwrap_or(Value::Null),
        })),
        "tool_result" => Some(json!({
            "type": "tool_call_response",
            "id": falsy_or_null(block.get("tool_use_id")),
            "response": block.get("content").cloned().unwrap_or(Value::Null),
        })),
        "image" => {
            let source = block.get("source").and_then(Value::as_object);
            Some(json!({
                "type": "blob",
                "mime_type": source.and_then(|s| s.get("media_type")).and_then(Value::as_str).unwrap_or("image/unknown"),
                "modality": "image",
                "content": source.and_then(|s| s.get("data")).and_then(Value::as_str).unwrap_or(""),
            }))
        }
        "thinking" => Some(json!({
            "type": "reasoning",
            "content": block.get("thinking").and_then(Value::as_str).unwrap_or(""),
        })),
        kind => {
            if block.get("text").is_some_and(|text| !text.is_null()) {
                Some(
                    json!({ "type": "text", "content": block.get("text").cloned().unwrap_or(Value::Null) }),
                )
            } else if kind.is_empty() {
                Some(json!({ "type": "unknown" }))
            } else {
                Some(json!({ "type": kind }))
            }
        }
    }
}

fn convert_anthropic_message(message: &Obj) -> Value {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user");
    match message.get("content") {
        Some(Value::String(text)) => json!({
            "role": role,
            "parts": [{ "type": "text", "content": text }],
        }),
        Some(Value::Array(blocks)) => {
            let parts: Vec<Value> = blocks.iter().filter_map(convert_block).collect();
            let role = if parts
                .iter()
                .any(|part| part.get("type").and_then(Value::as_str) == Some("tool_call_response"))
            {
                "tool"
            } else {
                role
            };
            json!({ "role": role, "parts": parts })
        }
        Some(other) => json!({
            "role": role,
            "parts": [{ "type": "text", "content": other.to_string() }],
        }),
        None => json!({ "role": role, "parts": [] }),
    }
}

fn convert_input_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| message.as_object().map(convert_anthropic_message))
        .filter(|message| message.get("role").and_then(Value::as_str) != Some("system"))
        .collect()
}

fn convert_output_messages(blocks: &[Value], stop_reason: &str) -> Vec<Value> {
    let finish = map_stop_reason(stop_reason);
    if blocks.is_empty() {
        return vec![json!({ "role": "assistant", "parts": [], "finish_reason": finish })];
    }
    let mut parts = Vec::new();
    for block in blocks {
        let Some(obj) = block.as_object() else {
            continue;
        };
        match obj.get("type").and_then(Value::as_str) {
            Some("text") => parts.push(json!({
                "type": "text",
                "content": obj.get("text").and_then(Value::as_str).unwrap_or(""),
            })),
            Some("tool_use") => parts.push(json!({
                "type": "tool_call",
                "id": falsy_or_null(obj.get("id")),
                "name": obj.get("name").and_then(Value::as_str).unwrap_or(""),
                "arguments": obj.get("input").cloned().unwrap_or(Value::Null),
            })),
            Some("thinking") => parts.push(json!({
                "type": "reasoning",
                "content": obj.get("thinking").and_then(Value::as_str).unwrap_or(""),
            })),
            Some(_) if obj.get("text").is_some() => parts.push(json!({
                "type": "text",
                "content": obj.get("text").cloned().unwrap_or(Value::Null),
            })),
            _ => {}
        }
    }
    vec![json!({ "role": "assistant", "parts": parts, "finish_reason": finish })]
}

fn to_json_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Some(value.clone()),
        Value::Array(items) => {
            let list: Vec<Value> = items.iter().filter_map(to_json_value).collect();
            if list.is_empty() {
                None
            } else {
                Some(Value::Array(list))
            }
        }
        Value::Object(map) => {
            let mut out = Obj::new();
            for (key, item) in map {
                if let Some(json) = to_json_value(item) {
                    out.insert(key.clone(), json);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(Value::Object(out))
            }
        }
    }
}

fn base_fields(
    trace_id: &str,
    session_id: &str,
    turn_id: &str,
    user_id: &str,
    cwd: Option<&str>,
    agent_name: Option<&str>,
    resources: &Obj,
) -> Obj {
    let mut fields = Obj::new();
    fields.insert("trace_id".into(), Value::String(trace_id.into()));
    fields.insert("gen_ai.session.id".into(), Value::String(session_id.into()));
    fields.insert("gen_ai.turn.id".into(), Value::String(turn_id.into()));
    fields.insert("gen_ai.agent.type".into(), Value::String(AGENT_ID.into()));
    fields.insert("gen_ai.agent.id".into(), Value::String(session_id.into()));
    fields.insert(
        "gen_ai.framework".into(),
        Value::String(FRAMEWORK_NAME.into()),
    );
    if let Some(agent_name) = agent_name {
        fields.insert("gen_ai.agent.name".into(), Value::String(agent_name.into()));
    }
    fields.insert("user.id".into(), Value::String(user_id.into()));
    if let Some(cwd) = cwd {
        fields.insert("agent.grok-build.cwd".into(), Value::String(cwd.into()));
    }
    if !resources.is_empty() {
        fields.insert(
            "resourceAttributes".into(),
            Value::Object(resources.clone()),
        );
    }
    fields
}

fn start_record(time: String, event_id: String, name: &str, base: &Obj) -> Obj {
    let mut record = Obj::new();
    record.insert("time_unix_nano".into(), Value::String(time));
    record.insert("event.id".into(), Value::String(event_id));
    record.insert("event.name".into(), Value::String(name.into()));
    for (key, value) in base {
        record.insert(key.clone(), value.clone());
    }
    record
}

fn insert_number(record: &mut Obj, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        record.insert(key.into(), json_number(value));
    }
}

struct TurnRecordContext<'a> {
    session_id: &'a str,
    user_id: &'a str,
    cwd: Option<&'a str>,
    agent_name: Option<&'a str>,
    resources: &'a Obj,
}

fn build_turn_records(
    fused: &FusedTurn,
    context: TurnRecordContext<'_>,
    system_prompt: Option<&str>,
    error_type: Option<&str>,
    fallback_ms: f64,
) -> Vec<Obj> {
    let TurnRecordContext {
        session_id,
        user_id,
        cwd,
        agent_name,
        resources,
    } = context;
    let turn_id = fused
        .prompt_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("{session_id}:turn"));
    let trace_id = deterministic_hex(&format!("grok-build:{session_id}:{turn_id}:trace"), 32);
    let base = base_fields(
        &trace_id, session_id, &turn_id, user_id, cwd, agent_name, resources,
    );
    let mut records = Vec::new();
    let mut sequence = 0usize;
    let mut running_hash = initial_hash();
    let mut previous_len = 0usize;
    let mut prompt = start_record(
        ms_to_unix_nanos(fused.prompt_timestamp_ms, fallback_ms),
        deterministic_event_id(&format!("{session_id}:{turn_id}:prompt")),
        "other",
        &base,
    );
    prompt.insert(
        "gen_ai.agent.description".into(),
        Value::String(AGENT_DESCRIPTION.into()),
    );
    prompt.insert(
        "gen_ai.data_source.id".into(),
        Value::String(DATA_SOURCE_ID.into()),
    );
    if !fused.prompt.is_empty() {
        prompt.insert(
            "gen_ai.input.messages_delta".into(),
            json!([{ "role": "user", "parts": [{ "type": "text", "content": fused.prompt }] }]),
        );
    }
    records.push((sequence, prompt));
    sequence += 1;
    for (call_index, call) in fused.llm_calls.iter().enumerate() {
        let step_id = format!("{turn_id}:s{}", call_index + 1);
        let step_span = deterministic_hex(
            &format!("{session_id}:{turn_id}:step:{}", call_index + 1),
            16,
        );
        let llm_span = deterministic_hex(
            &format!("{session_id}:{turn_id}:llm:{}", call_index + 1),
            16,
        );
        let response_id = if call.message_id.is_empty() {
            format!("{step_id}:response")
        } else {
            call.message_id.clone()
        };
        let input_messages = convert_input_messages(&call.input_messages);
        let (input_hash, delta, log_full) = if call.input_is_delta {
            let hash = compute_hash(&running_hash, &input_messages);
            (hash, input_messages.clone(), false)
        } else {
            let hash = compute_hash(&initial_hash(), &input_messages);
            let delta = input_messages
                .iter()
                .skip(previous_len)
                .cloned()
                .collect::<Vec<_>>();
            let log_full = should_log_full_messages(&running_hash, &delta, &hash);
            (hash, delta, log_full)
        };
        let mut request = start_record(
            ms_to_unix_nanos(call.request_start_ms, fallback_ms),
            deterministic_event_id(&format!(
                "{session_id}:{turn_id}:llm:{}:request",
                call_index + 1
            )),
            "llm.request",
            &base,
        );
        request.insert("span_id".into(), Value::String(llm_span.clone()));
        request.insert("parent_span_id".into(), Value::String(step_span.clone()));
        request.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        request.insert(
            "gen_ai.response.id".into(),
            Value::String(response_id.clone()),
        );
        request.insert(
            "gen_ai.provider.name".into(),
            Value::String(PROVIDER_NAME.into()),
        );
        request.insert(
            "gen_ai.request.model".into(),
            Value::String(if call.model.is_empty() {
                "grok".into()
            } else {
                call.model.clone()
            }),
        );
        request.insert(
            "gen_ai.input.messages_hash".into(),
            Value::String(input_hash.clone()),
        );
        request.insert("gen_ai.input.messages_delta".into(), Value::Array(delta));
        request.insert(
            "loongsuite.grok.timing.source".into(),
            Value::String(call.timing_source.clone()),
        );
        if log_full {
            request.insert(
                "gen_ai.input.messages".into(),
                Value::Array(input_messages.clone()),
            );
        }
        if call_index == 0 {
            if let Some(system_prompt) = system_prompt.filter(|text| !text.is_empty()) {
                request.insert(
                    "gen_ai.system_instructions".into(),
                    json!([{ "type": "text", "content": system_prompt }]),
                );
            }
        }
        records.push((sequence, request));
        sequence += 1;
        let finish = map_stop_reason(&call.finish_reason);
        let model = if call.model.is_empty() {
            "grok".into()
        } else {
            call.model.clone()
        };
        let mut response = start_record(
            ms_to_unix_nanos(Some(call.response_end_ms), fallback_ms),
            deterministic_event_id(&format!(
                "{session_id}:{turn_id}:llm:{}:response",
                call_index + 1
            )),
            "llm.response",
            &base,
        );
        response.insert("span_id".into(), Value::String(llm_span));
        response.insert("parent_span_id".into(), Value::String(step_span.clone()));
        response.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        response.insert("gen_ai.response.id".into(), Value::String(response_id));
        response.insert(
            "gen_ai.provider.name".into(),
            Value::String(PROVIDER_NAME.into()),
        );
        response.insert("gen_ai.request.model".into(), Value::String(model.clone()));
        response.insert("gen_ai.response.model".into(), Value::String(model));
        response.insert("gen_ai.response.finish_reasons".into(), json!([finish]));
        response.insert(
            "gen_ai.output.finish_reason".into(),
            Value::String(finish.clone()),
        );
        response.insert(
            "gen_ai.react.finish_reason".into(),
            Value::String(finish.clone()),
        );
        response.insert(
            "loongsuite.grok.timing.source".into(),
            Value::String(call.timing_source.clone()),
        );
        if !call.incomplete {
            insert_number(
                &mut response,
                "gen_ai.usage.input_tokens",
                call.input_tokens,
            );
            insert_number(
                &mut response,
                "gen_ai.usage.output_tokens",
                call.output_tokens,
            );
            insert_number(
                &mut response,
                "gen_ai.usage.cache_read.input_tokens",
                call.cache_read_input_tokens,
            );
            insert_number(
                &mut response,
                "gen_ai.usage.cache_creation.input_tokens",
                call.cache_creation_input_tokens,
            );
            if let (Some(input), Some(output)) = (call.input_tokens, call.output_tokens) {
                insert_number(
                    &mut response,
                    "gen_ai.usage.total_tokens",
                    Some(input + output),
                );
            }
            response.insert(
                "gen_ai.output.messages".into(),
                Value::Array(convert_output_messages(
                    &call.output_content,
                    &call.finish_reason,
                )),
            );
        }
        if error_type.is_some() && finish == "error" {
            response.insert(
                "error.type".into(),
                Value::String(error_type.unwrap_or("").into()),
            );
            response.insert(
                "error.message".into(),
                Value::String("model request failed".into()),
            );
        }
        records.push((sequence, response));
        sequence += 1;
        running_hash = input_hash;
        previous_len = if call.input_is_delta {
            0
        } else {
            input_messages.len()
        };
        for (tool_index, tool) in call.tools.iter().enumerate() {
            let identity = format!("{}:{}:{}", call_index + 1, tool.id, tool_index + 1);
            let tool_span =
                deterministic_hex(&format!("{session_id}:{turn_id}:tool:{identity}"), 16);
            let mut common = base.clone();
            common.insert("span_id".into(), Value::String(tool_span.clone()));
            common.insert("parent_span_id".into(), Value::String(step_span.clone()));
            common.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
            common.insert("gen_ai.tool.name".into(), Value::String(tool.name.clone()));
            common.insert("gen_ai.tool.call.id".into(), Value::String(tool.id.clone()));
            common.insert(
                "loongsuite.grok.match.strategy".into(),
                Value::String(tool.match_strategy.clone()),
            );
            common.insert(
                "loongsuite.grok.timing.source".into(),
                Value::String(tool.timing_source.clone()),
            );
            let mut call_record = start_record(
                ms_to_unix_nanos(tool.start_ms, call.response_end_ms),
                deterministic_event_id(&format!("{session_id}:{turn_id}:tool:{identity}:call")),
                "tool.call",
                &common,
            );
            let arguments = to_json_value(&tool.arguments).unwrap_or_else(|| json!({}));
            call_record.insert("gen_ai.tool.call.arguments".into(), arguments);
            records.push((sequence, call_record));
            sequence += 1;
            let mut result_record = start_record(
                ms_to_unix_nanos(Some(tool.end_ms), tool.start_ms.unwrap_or(fallback_ms)),
                deterministic_event_id(&format!("{session_id}:{turn_id}:tool:{identity}:result")),
                "tool.result",
                &common,
            );
            result_record.insert(
                "tool.result.status".into(),
                Value::String(tool.status.clone()),
            );
            if tool
                .duration_ms
                .is_some_and(|duration| duration.is_finite() && duration > 0.0)
            {
                insert_number(
                    &mut result_record,
                    "gen_ai.tool.call.duration",
                    tool.duration_ms,
                );
            }
            if tool.result_present {
                let structured = json!([{
                    "role": "tool",
                    "parts": [{
                        "type": "tool_call_response",
                        "id": tool.id,
                        "name": tool.name,
                        "response": tool.result.clone().unwrap_or(Value::Null),
                    }],
                }]);
                let result = to_json_value(&structured).unwrap_or(structured);
                result_record.insert("gen_ai.tool.call.result".into(), result);
            }
            if tool.status == "failure" {
                result_record.insert("error.type".into(), Value::String("ToolError".into()));
                result_record.insert(
                    "error.message".into(),
                    Value::String("tool execution failed".into()),
                );
            }
            records.push((sequence, result_record));
            sequence += 1;
        }
    }
    let terminal_finish = map_stop_reason(&fused.stop_reason);
    let mut latest_nanos = 0u128;
    let mut latest_text = "0".to_string();
    for (_, record) in &records {
        if let Some(text) = record.get("time_unix_nano").and_then(Value::as_str) {
            let parsed = text.parse::<u128>().unwrap_or(0);
            if parsed > latest_nanos {
                latest_nanos = parsed;
                latest_text = text.to_string();
            }
        }
    }
    let observed_text = ms_to_unix_nanos(fused.terminal_timestamp_ms, fallback_ms);
    let observed = observed_text.parse::<u128>().unwrap_or(0);
    let terminal_time = if observed > latest_nanos {
        observed_text
    } else {
        latest_text
    };
    let mut terminal = start_record(
        terminal_time,
        deterministic_event_id(&format!("{session_id}:{turn_id}:terminal")),
        "other",
        &base,
    );
    terminal.insert(
        "gen_ai.response.finish_reasons".into(),
        json!([terminal_finish]),
    );
    terminal.insert(
        "gen_ai.output.finish_reason".into(),
        Value::String(terminal_finish),
    );
    if let Some(error_type) = error_type {
        terminal.insert("error.type".into(), Value::String(error_type.into()));
        terminal.insert(
            "error.message".into(),
            Value::String("model request failed".into()),
        );
    }
    records.push((sequence, terminal));
    records.sort_by(|left, right| {
        let left_time = left
            .1
            .get("time_unix_nano")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u128>().ok())
            .unwrap_or(0);
        let right_time = right
            .1
            .get("time_unix_nano")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u128>().ok())
            .unwrap_or(0);
        left_time.cmp(&right_time).then(left.0.cmp(&right.0))
    });
    records.into_iter().map(|(_, record)| record).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/unit/hooks/grok-build/fixtures")
            .join(name)
    }

    fn data_env(dir: &Path) -> Env {
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            dir.to_string_lossy().into_owned(),
        );
        env
    }

    fn write_lines(path: &Path, rows: &[Value]) {
        let mut body = String::new();
        for row in rows {
            body.push_str(&serde_json::to_string(row).unwrap());
            body.push('\n');
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    fn llm_call(message_id: &str, blocks: Vec<Value>, ids: &[&str]) -> LlmCall {
        LlmCall {
            model: "grok".into(),
            message_id: message_id.into(),
            input_messages: Vec::new(),
            input_is_delta: true,
            output_content: blocks,
            stop_reason: "end_turn".into(),
            input_tokens: None,
            output_tokens: None,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
            declared_tool_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            tool_details: HashMap::new(),
            prompt_index: None,
            incomplete: false,
            timestamp: None,
        }
    }

    fn tool_block(id: &str, name: &str, input: Value) -> Value {
        json!({
            "type": "tool_use",
            "id": id,
            "source_id": Value::Null,
            "name": name,
            "input": input,
        })
    }

    fn plain_turn(start: f64, end: f64) -> UpdateTurn {
        UpdateTurn {
            prompt_id: None,
            prompt_index: None,
            completed: true,
            stop_reason: Some("end_turn".into()),
            usage: None,
            start_ms: Some(start),
            end_ms: Some(end),
            end_offset: 0,
            tool_starts: Vec::new(),
            tool_completions: Vec::new(),
        }
    }

    fn chat_with(prompt: &str, calls: Vec<LlmCall>) -> ChatTurn {
        ChatTurn {
            prompt_index: None,
            prompt: prompt.into(),
            prompt_timestamp: None,
            llm_calls: calls,
        }
    }

    struct World {
        _root: tempfile::TempDir,
        root: PathBuf,
        data: PathBuf,
        grok: PathBuf,
        unified: PathBuf,
        chat: PathBuf,
        updates: PathBuf,
        session_id: String,
    }

    impl World {
        fn new(session: &str) -> Self {
            let root_dir = tempfile::tempdir().expect("tempdir");
            let root = root_dir.path().to_path_buf();
            let data = root.join("pilot data");
            let grok = root.join("grok-home");
            let unified = root.join("unified.jsonl");
            fs::create_dir_all(&data).unwrap();
            fs::copy(fixture("unified.redacted-real.jsonl"), &unified).unwrap();
            let mut world = Self {
                _root: root_dir,
                root,
                data,
                grok,
                unified,
                chat: PathBuf::new(),
                updates: PathBuf::new(),
                session_id: String::new(),
            };
            world.use_session(session, true);
            world
        }

        fn use_session(&mut self, session: &str, copy: bool) {
            self.session_id = session.to_string();
            let dir = self
                .grok
                .join("sessions")
                .join(encode_uri_component("/workspace"))
                .join(session);
            fs::create_dir_all(&dir).unwrap();
            self.chat = dir.join("chat_history.jsonl");
            self.updates = dir.join("updates.jsonl");
            if copy {
                fs::copy(fixture("chat_history.redacted-real.jsonl"), &self.chat).unwrap();
                fs::copy(fixture("updates.redacted-real.jsonl"), &self.updates).unwrap();
            }
        }

        fn env(&self) -> Env {
            let mut env = Env::new();
            env.insert("HOME".into(), self.root.to_string_lossy().into_owned());
            env.insert("GROK_HOME".into(), self.grok.to_string_lossy().into_owned());
            env.insert(
                "LOONGSUITE_PILOT_DATA_DIR".into(),
                self.data.to_string_lossy().into_owned(),
            );
            env.insert(
                "GROK_UNIFIED_LOG_PATH".into(),
                self.unified.to_string_lossy().into_owned(),
            );
            env
        }

        fn run(&self, subcommand: &str, payload: &Value) -> (i32, String) {
            run_env(&self.env(), subcommand, payload)
        }

        fn records(&self) -> Vec<Value> {
            read_jsonl_dir(&self.data.join("logs").join("grok-build"))
        }
    }

    fn run_env(env: &Env, subcommand: &str, payload: &Value) -> (i32, String) {
        let args = vec![subcommand.to_string()];
        let stdin = serde_json::to_vec(payload).unwrap();
        let mut stdout = Vec::new();
        let mut request = HookRequest {
            args: &args,
            stdin: &stdin,
            env,
            stdout: &mut stdout,
        };
        let code = run(&mut request);
        (code, String::from_utf8(stdout).unwrap())
    }

    fn read_jsonl_dir(dir: &Path) -> Vec<Value> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .collect();
        files.sort();
        let mut records = Vec::new();
        for path in files {
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    records.push(value);
                }
            }
        }
        records
    }

    fn event_names(records: &[Value]) -> Vec<&str> {
        records
            .iter()
            .filter_map(|record| record.get("event.name").and_then(Value::as_str))
            .collect()
    }

    fn turn_set(records: &[Value]) -> HashSet<&str> {
        records
            .iter()
            .filter_map(|record| record.get("gen_ai.turn.id").and_then(Value::as_str))
            .collect()
    }

    fn base_payload(world: &World) -> Value {
        json!({
            "session_id": world.session_id,
            "prompt_id": "prompt-redacted",
            "transcript_path": world.updates.to_string_lossy(),
            "cwd": "/workspace",
            "timestamp": "2026-07-29T03:48:59.000Z",
        })
    }

    #[test]
    fn state_lock_serializes_and_removes_the_owned_lock() {
        let dir = tempfile::tempdir().unwrap();
        let env = data_env(dir.path());
        let order = Mutex::new(Vec::new());
        thread::scope(|scope| {
            let first = scope.spawn(|| {
                with_session_state_lock(&env, "same-session", LockOptions::default(), || {
                    order.lock().unwrap().push("first-start");
                    thread::sleep(Duration::from_millis(60));
                    order.lock().unwrap().push("first-end");
                })
                .unwrap();
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            while !order.lock().unwrap().contains(&"first-start") {
                assert!(Instant::now() < deadline, "first lock did not start");
                thread::sleep(Duration::from_millis(5));
            }
            let second = scope.spawn(|| {
                with_session_state_lock(&env, "same-session", LockOptions::default(), || {
                    order.lock().unwrap().push("second-start");
                    order.lock().unwrap().push("second-end");
                })
                .unwrap();
            });
            first.join().unwrap();
            second.join().unwrap();
        });
        assert_eq!(
            order.lock().unwrap().as_slice(),
            ["first-start", "first-end", "second-start", "second-end"]
        );
        let lock = dir
            .path()
            .join("state/grok-build/sessions")
            .join(format!("{}.lock", grok_sanitize_session_id("same-session")));
        assert!(!lock.exists());
    }

    #[test]
    fn state_lock_recovers_stale_locks_and_hashes_session_names() {
        assert_ne!(
            grok_sanitize_session_id("../same"),
            grok_sanitize_session_id("same")
        );
        let dir = tempfile::tempdir().unwrap();
        let env = data_env(dir.path());
        let lock = dir.path().join("state/grok-build/sessions").join(format!(
            "{}.lock",
            grok_sanitize_session_id("stale-session")
        ));
        fs::create_dir_all(lock.parent().unwrap()).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&lock)
            .unwrap();
        file.write_all(br#"{"token":"stale"}"#).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        drop(file);
        with_session_state_lock(
            &env,
            "stale-session",
            LockOptions::from_parts(3_000, 1_000, 25),
            || assert!(lock.exists()),
        )
        .unwrap();
        assert!(!lock.exists());
    }

    #[test]
    fn state_lock_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let env = data_env(dir.path());
        let started = Mutex::new(false);
        let result = thread::scope(|scope| {
            let holder = scope.spawn(|| {
                with_session_state_lock(&env, "timeout-session", LockOptions::default(), || {
                    *started.lock().unwrap() = true;
                    thread::sleep(Duration::from_millis(150));
                })
                .unwrap();
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            while !*started.lock().unwrap() {
                assert!(Instant::now() < deadline, "holder did not acquire");
                thread::sleep(Duration::from_millis(5));
            }
            let result = with_session_state_lock(
                &env,
                "timeout-session",
                LockOptions::from_parts(50, 30_000, 5),
                || (),
            );
            holder.join().unwrap();
            result
        });
        assert!(matches!(result, Err(HookFail::LockTimeout(_))));
    }

    #[test]
    fn rename_retries_transient_errors() {
        let mut calls = 0;
        let result = rename_retrying(|| {
            calls += 1;
            if calls == 1 {
                Err(io::Error::from_raw_os_error(1))
            } else {
                Ok(())
            }
        });
        assert!(result.is_ok());
        assert_eq!(calls, 2);
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.tmp");
        let destination = dir.path().join("destination.json");
        fs::write(&source, "state").unwrap();
        rename_sync_with_retry(&source, &destination).unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "state");
    }

    #[test]
    fn unified_scan_stays_near_native_rotation_size() {
        assert_eq!(MAX_UNIFIED_BYTES, 8 * 1024 * 1024);
    }

    #[test]
    fn parses_redacted_rails_and_keeps_torn_jsonl() {
        let chat = parse_grok_transcript(&fixture("chat_history.redacted-real.jsonl"), 0);
        assert!(chat.system_prompt.unwrap().contains("Grok Build"));
        assert_eq!(chat.turns.len(), 1);
        assert_eq!(chat.turns[0].prompt, "Read two files.");
        assert_eq!(chat.turns[0].llm_calls[0].declared_tool_ids.len(), 2);

        let dir = tempfile::tempdir().unwrap();
        let copied = dir.path().join("updates.jsonl");
        let complete = fs::read(fixture("updates.redacted-real.jsonl")).unwrap();
        let mut torn = complete.clone();
        torn.extend_from_slice(br#"{"params":"#);
        fs::write(&copied, torn).unwrap();
        let parsed =
            parse_grok_updates(&copied, &Checkpoint::default(), None, MAX_UPDATES_BYTES).unwrap();
        assert_eq!(parsed.parse_errors, 0);
        assert_eq!(parsed.turns.len(), 1);
        assert_eq!(
            parsed.turns[0].prompt_id.as_deref(),
            Some("prompt-redacted")
        );
        assert!(parsed.turns[0].completed);
        assert_eq!(parsed.turns[0].stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(parsed.checkpoint.offset, complete.len() as u64);
        let statuses: Vec<_> = parsed.turns[0]
            .tool_completions
            .iter()
            .map(|event| event.tool_status.clone())
            .collect();
        assert_eq!(
            statuses,
            vec![Some("failure".to_string()), Some("success".to_string())]
        );

        let unified = parse_grok_unified(
            &fixture("unified.redacted-real.jsonl"),
            "session-redacted",
            MAX_UNIFIED_BYTES,
        )
        .unwrap();
        assert_eq!(unified.parse_errors, 0);
        assert_eq!(unified.groups.len(), 1);
        let group = &unified.groups[0];
        assert_eq!(group.loop_index, 1.0);
        assert_eq!(group.model_elapsed_ms, Some(5206.0));
        assert_eq!(group.prompt_tokens, Some(10244.0));
        assert_eq!(group.cached_prompt_tokens, Some(8448.0));
        assert_eq!(group.completion_tokens, Some(237.0));
        assert_eq!(
            group
                .tools
                .iter()
                .map(|tool| tool.elapsed_ms)
                .collect::<Vec<_>>(),
            vec![125.0, 0.0]
        );
    }

    #[test]
    fn fuses_parallel_same_name_tools_from_the_fixture() {
        let chat = parse_grok_transcript(&fixture("chat_history.redacted-real.jsonl"), 0);
        let updates = parse_grok_updates(
            &fixture("updates.redacted-real.jsonl"),
            &Checkpoint::default(),
            None,
            MAX_UPDATES_BYTES,
        )
        .unwrap();
        let unified = parse_grok_unified(
            &fixture("unified.redacted-real.jsonl"),
            "session-redacted",
            MAX_UNIFIED_BYTES,
        )
        .unwrap();
        let fused = fuse_grok_turn(
            &chat.turns[0],
            Some(&updates.turns[0]),
            &unified.groups,
            "prompt-redacted",
            "end_turn",
            Some(1_785_296_939_000.0),
        );
        assert_eq!(fused.llm_calls.len(), 1);
        let llm = &fused.llm_calls[0];
        assert_eq!(llm.request_start_ms.unwrap() as i64, 1_785_296_932_621);
        assert_eq!(llm.response_end_ms as i64, 1_785_296_937_827);
        assert_eq!(llm.input_tokens, Some(10244.0));
        assert_eq!(llm.output_tokens, Some(237.0));
        assert_eq!(llm.finish_reason, "tool_use");
        assert_eq!(llm.timing_source, "unified");
        assert_eq!(llm.tools.len(), 2);
        assert_eq!(llm.tools[0].id, "tool-a");
        assert_eq!(llm.tools[0].status, "failure");
        assert_eq!(llm.tools[0].duration_ms, Some(125.0));
        assert_eq!(llm.tools[0].match_strategy, "name_order");
        assert_eq!(llm.tools[0].timing_source, "unified");
        assert!(llm.tools[0].result_present);
        assert_eq!(llm.tools[1].id, "tool-b");
        assert_eq!(llm.tools[1].status, "success");
        assert_eq!(llm.tools[1].duration_ms, Some(0.0));
        assert_eq!(llm.tools[1].match_strategy, "name_order");
        assert!(llm.tools[1].result_present);
        let ids: Vec<_> = llm
            .output_content
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
            .map(|block| block.get("id").and_then(Value::as_str).unwrap_or(""))
            .collect();
        assert_eq!(ids, ["tool-a", "tool-b"]);
    }

    #[test]
    fn keeps_completed_inference_when_cancellation_leaves_a_trailing_start() {
        let groups = vec![
            UnifiedGroup {
                loop_index: 1.0,
                start_ms: Some(1000.0),
                end_ms: Some(1500.0),
                model_elapsed_ms: None,
                prompt_tokens: None,
                cached_prompt_tokens: None,
                cache_creation_input_tokens: None,
                completion_tokens: None,
                tools: Vec::new(),
            },
            UnifiedGroup {
                loop_index: 2.0,
                start_ms: Some(1500.0),
                end_ms: None,
                model_elapsed_ms: None,
                prompt_tokens: None,
                cached_prompt_tokens: None,
                cache_creation_input_tokens: None,
                completion_tokens: None,
                tools: Vec::new(),
            },
        ];
        let selected = select_unified_groups(&groups, Some(900.0), Some(2000.0), 1);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].loop_index, 1.0);
        assert_eq!(selected[0].end_ms, Some(1500.0));
    }

    #[test]
    fn leaves_a_differently_named_tool_unmatched() {
        let chat = chat_with(
            "run a command",
            vec![llm_call(
                "response-1",
                vec![tool_block("shell_1_1", "shell", json!({"command": "pwd"}))],
                &["shell_1_1"],
            )],
        );
        let update = plain_turn(1000.0, 3000.0);
        let groups = vec![UnifiedGroup {
            loop_index: 1.0,
            start_ms: Some(1100.0),
            end_ms: Some(1500.0),
            model_elapsed_ms: None,
            prompt_tokens: None,
            cached_prompt_tokens: None,
            cache_creation_input_tokens: None,
            completion_tokens: None,
            tools: vec![UnifiedTool {
                name: "read_file".into(),
                start_ms: 1600.0,
                end_ms: 1700.0,
                elapsed_ms: 100.0,
                success: Some(true),
            }],
        }];
        let fused = fuse_grok_turn(
            &chat,
            Some(&update),
            &groups,
            "prompt-mismatch",
            "end_turn",
            Some(3000.0),
        );
        let tool = &fused.llm_calls[0].tools[0];
        assert_eq!(tool.id, "prompt-mismatch:l1:t1");
        assert_eq!(tool.status, "unknown");
        assert_eq!(tool.match_strategy, "unmatched");
        assert_eq!(tool.timing_source, "hook");
        assert!(!tool.result_present);
        assert_eq!(tool.duration_ms, Some(0.0));
        assert_eq!(
            fused.llm_calls[0].output_content[0]
                .get("id")
                .and_then(Value::as_str),
            Some("prompt-mismatch:l1:t1")
        );
    }

    #[test]
    fn does_not_attach_an_unidentified_update_completion_by_array_index() {
        let chat = chat_with(
            "run a command",
            vec![llm_call(
                "response-1",
                vec![tool_block("shell_1_1", "shell", json!({"command": "pwd"}))],
                &["shell_1_1"],
            )],
        );
        let mut update = plain_turn(1000.0, 3000.0);
        update.tool_completions.push(UpdateEvent {
            kind: "tool_completion".into(),
            prompt_id: None,
            prompt_index: None,
            timestamp_ms: Some(1900.0),
            turn_start_ms: None,
            tool_id: String::new(),
            tool_name: None,
            tool_status: Some("failure".into()),
            tool_input: None,
            tool_output: Some(Value::String("result from a different tool".into())),
            stop_reason: None,
            usage: None,
            start_offset: 0,
            end_offset: 0,
        });
        let groups = vec![UnifiedGroup {
            loop_index: 1.0,
            start_ms: Some(1100.0),
            end_ms: Some(1500.0),
            model_elapsed_ms: None,
            prompt_tokens: None,
            cached_prompt_tokens: None,
            cache_creation_input_tokens: None,
            completion_tokens: None,
            tools: vec![UnifiedTool {
                name: "shell".into(),
                start_ms: 1600.0,
                end_ms: 1700.0,
                elapsed_ms: 100.0,
                success: Some(true),
            }],
        }];
        let fused = fuse_grok_turn(
            &chat,
            Some(&update),
            &groups,
            "prompt-no-cross-index",
            "end_turn",
            Some(3000.0),
        );
        let tool = &fused.llm_calls[0].tools[0];
        assert_eq!(tool.status, "success");
        assert!(!tool.result_present);
        assert!(tool.result.is_none());
        assert_eq!(tool.match_strategy, "name_order");
        assert_eq!(tool.timing_source, "unified");
    }

    #[test]
    fn reads_prompt_index_from_params_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("updates.jsonl");
        write_lines(
            &file,
            &[json!({
                "timestamp": 1785296939u64,
                "params": {
                    "_meta": {
                        "promptId": "prompt-params-meta",
                        "promptIndex": 7,
                        "agentTimestampMs": 1785296939000u64
                    },
                    "update": { "sessionUpdate": "turn_completed", "stopReason": "end_turn" }
                }
            })],
        );
        let parsed =
            parse_grok_updates(&file, &Checkpoint::default(), None, MAX_UPDATES_BYTES).unwrap();
        assert_eq!(
            parsed.turns[0].prompt_id.as_deref(),
            Some("prompt-params-meta")
        );
        assert_eq!(parsed.turns[0].prompt_index.as_deref(), Some("7"));
        assert!(parsed.turns[0].completed);
    }

    #[test]
    fn keeps_inference_timing_when_usage_is_null() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("unified.jsonl");
        write_lines(
            &file,
            &[
                json!({"ts":"2026-07-29T03:48:52.000Z","sid":"no-usage","msg":"shell.turn.inference_start","ctx":{"loop_index":1}}),
                json!({"ts":"2026-07-29T03:48:53.000Z","sid":"no-usage","msg":"shell.turn.inference_done","ctx":{"loop_index":1,"model_elapsed_ms":1000,"prompt_tokens":null,"completion_tokens":null}}),
            ],
        );
        let group = &parse_grok_unified(&file, "no-usage", MAX_UNIFIED_BYTES)
            .unwrap()
            .groups[0];
        assert_eq!(
            group.end_ms.unwrap() as i64 - group.start_ms.unwrap() as i64,
            1000
        );
        assert!(group.prompt_tokens.is_none());
        assert!(group.completion_tokens.is_none());
    }

    #[test]
    fn creates_incomplete_failure_only_with_inference_start() {
        let with_attempt = fuse_grok_turn(
            &chat_with("hello", Vec::new()),
            Some(&UpdateTurn {
                prompt_index: Some("0".into()),
                completed: false,
                end_ms: None,
                ..plain_turn(1000.0, 1000.0)
            }),
            &[UnifiedGroup {
                loop_index: 1.0,
                start_ms: Some(1100.0),
                end_ms: None,
                model_elapsed_ms: None,
                prompt_tokens: None,
                cached_prompt_tokens: None,
                cache_creation_input_tokens: None,
                completion_tokens: None,
                tools: Vec::new(),
            }],
            "prompt-failure",
            "error",
            Some(1200.0),
        );
        assert_eq!(with_attempt.llm_calls.len(), 1);
        assert!(with_attempt.llm_calls[0].incomplete);
        assert_eq!(with_attempt.llm_calls[0].finish_reason, "error");

        let without = fuse_grok_turn(
            &chat_with("hello", Vec::new()),
            Some(&UpdateTurn {
                prompt_index: Some("0".into()),
                completed: false,
                end_ms: None,
                ..plain_turn(1000.0, 1000.0)
            }),
            &[],
            "prompt-failure",
            "error",
            Some(1200.0),
        );
        assert!(without.llm_calls.is_empty());
    }

    #[test]
    fn binds_synthetic_failure_to_the_incomplete_group() {
        let fused = fuse_grok_turn(
            &chat_with("hello", Vec::new()),
            Some(&UpdateTurn {
                prompt_index: Some("8".into()),
                completed: false,
                end_ms: None,
                ..plain_turn(1000.0, 1000.0)
            }),
            &[
                UnifiedGroup {
                    loop_index: 7.0,
                    start_ms: Some(1100.0),
                    end_ms: Some(1200.0),
                    model_elapsed_ms: None,
                    prompt_tokens: Some(111.0),
                    cached_prompt_tokens: None,
                    cache_creation_input_tokens: None,
                    completion_tokens: Some(22.0),
                    tools: Vec::new(),
                },
                UnifiedGroup {
                    loop_index: 8.0,
                    start_ms: Some(1300.0),
                    end_ms: None,
                    model_elapsed_ms: None,
                    prompt_tokens: None,
                    cached_prompt_tokens: None,
                    cache_creation_input_tokens: None,
                    completion_tokens: None,
                    tools: Vec::new(),
                },
            ],
            "prompt-failure",
            "error",
            Some(1400.0),
        );
        assert_eq!(fused.llm_calls.len(), 1);
        assert!(fused.llm_calls[0].incomplete);
        assert_eq!(fused.llm_calls[0].request_start_ms, Some(1300.0));
        assert_eq!(fused.llm_calls[0].response_end_ms, 1400.0);
        assert_eq!(fused.llm_calls[0].finish_reason, "error");
        assert!(fused.llm_calls[0].input_tokens.is_none());
        assert!(fused.llm_calls[0].output_tokens.is_none());
    }

    #[test]
    fn keeps_completed_chat_response_and_adds_trailing_failure() {
        let chat = chat_with(
            "hello",
            vec![LlmCall {
                output_content: vec![json!({"type":"text","text":"partial response"})],
                declared_tool_ids: Vec::new(),
                ..llm_call("completed-response", Vec::new(), &[])
            }],
        );
        let fused = fuse_grok_turn(
            &chat,
            Some(&UpdateTurn {
                prompt_index: Some("8".into()),
                completed: false,
                end_ms: None,
                ..plain_turn(1000.0, 1000.0)
            }),
            &[
                UnifiedGroup {
                    loop_index: 7.0,
                    start_ms: Some(1100.0),
                    end_ms: Some(1200.0),
                    model_elapsed_ms: None,
                    prompt_tokens: Some(111.0),
                    cached_prompt_tokens: None,
                    cache_creation_input_tokens: None,
                    completion_tokens: Some(22.0),
                    tools: Vec::new(),
                },
                UnifiedGroup {
                    loop_index: 8.0,
                    start_ms: Some(1300.0),
                    end_ms: None,
                    model_elapsed_ms: None,
                    prompt_tokens: None,
                    cached_prompt_tokens: None,
                    cache_creation_input_tokens: None,
                    completion_tokens: None,
                    tools: Vec::new(),
                },
            ],
            "prompt-failure",
            "error",
            Some(1400.0),
        );
        assert_eq!(fused.llm_calls.len(), 2);
        assert_eq!(fused.llm_calls[0].message_id, "completed-response");
        assert_eq!(fused.llm_calls[0].request_start_ms, Some(1100.0));
        assert_eq!(fused.llm_calls[0].response_end_ms, 1200.0);
        assert_eq!(fused.llm_calls[0].input_tokens, Some(111.0));
        assert_eq!(fused.llm_calls[0].output_tokens, Some(22.0));
        assert!(fused.llm_calls[1].incomplete);
        assert_eq!(fused.llm_calls[1].request_start_ms, Some(1300.0));
        assert_eq!(fused.llm_calls[1].response_end_ms, 1400.0);
        assert_eq!(fused.llm_calls[1].finish_reason, "error");
    }

    #[test]
    fn accepts_camel_case_hook_envelope() {
        let world = World::new("session-redacted");
        let payload = json!({
            "hookEventName": "stop",
            "sessionId": "session-redacted",
            "promptId": "prompt-redacted",
            "transcriptPath": world.updates.to_string_lossy(),
            "workspaceRoot": "/workspace",
            "cwd": "/workspace",
            "timestamp": "2026-07-29T03:48:59.000Z",
            "reason": "end_turn",
            "lastAssistantMessage": "fixture assistant output",
        });
        let (code, _) = world.run("stop", &payload);
        assert_eq!(code, 0);
        let emitted = world.records();
        assert_eq!(emitted.len(), 8);
        assert_eq!(turn_set(&emitted), HashSet::from(["prompt-redacted"]));
    }

    #[test]
    fn exports_one_turn_across_prompt_stop_and_session_end() {
        let world = World::new("session-redacted");
        let mut payload = base_payload(&world);
        assert_eq!(world.run("user_prompt_submit", &payload).0, 0);
        assert!(world.records().is_empty());
        payload["stop_reason"] = json!("end_turn");
        let (code, stdout) = world.run("stop", &payload);
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "{}");
        let first = world.records();
        assert_eq!(
            event_names(&first),
            [
                "other",
                "llm.request",
                "llm.response",
                "tool.call",
                "tool.result",
                "tool.call",
                "tool.result",
                "other",
            ]
        );
        let traces: HashSet<_> = first
            .iter()
            .filter_map(|record| record.get("trace_id").and_then(Value::as_str))
            .collect();
        assert_eq!(traces.len(), 1);
        let ids: HashSet<_> = first
            .iter()
            .filter_map(|record| record.get("event.id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids.len(), first.len());
        assert_eq!(
            first
                .iter()
                .filter(|record| record.get("gen_ai.system_instructions").is_some())
                .count(),
            1
        );
        let tool_a = first.iter().find(|record| {
            record.get("gen_ai.tool.call.id").and_then(Value::as_str) == Some("tool-a")
                && record.get("event.name").and_then(Value::as_str) == Some("tool.result")
        });
        let tool_a = tool_a.unwrap();
        assert_eq!(
            tool_a.get("tool.result.status").and_then(Value::as_str),
            Some("failure")
        );
        assert_eq!(
            tool_a
                .get("gen_ai.tool.call.duration")
                .and_then(Value::as_i64),
            Some(125)
        );
        assert_eq!(
            tool_a.get("error.type").and_then(Value::as_str),
            Some("ToolError")
        );
        let tool_b = first
            .iter()
            .find(|record| {
                record.get("gen_ai.tool.call.id").and_then(Value::as_str) == Some("tool-b")
                    && record.get("event.name").and_then(Value::as_str) == Some("tool.result")
            })
            .unwrap();
        assert!(tool_b.get("gen_ai.tool.call.duration").is_none());
        assert_eq!(world.run("stop", &payload).0, 0);
        assert_eq!(world.run("session_end", &payload).0, 0);
        payload["stop_reason"] = json!("shutdown");
        assert_eq!(world.run("stop", &payload).0, 0);
        assert_eq!(world.records(), first);
        assert!(world.data.join("state/grok-build/sessions").is_dir());
    }

    #[test]
    fn session_end_exports_after_shutdown_stop() {
        let world = World::new("session-redacted");
        let chat = fs::read(&world.chat).unwrap();
        let updates = fs::read(&world.updates).unwrap();
        fs::write(&world.chat, "").unwrap();
        fs::write(&world.updates, "").unwrap();
        let payload = base_payload(&world);
        assert_eq!(world.run("user_prompt_submit", &payload).0, 0);
        fs::write(&world.chat, chat).unwrap();
        fs::write(&world.updates, updates).unwrap();
        let mut shutdown = payload.clone();
        shutdown["stop_reason"] = json!("shutdown");
        assert_eq!(world.run("stop", &shutdown).0, 0);
        assert!(world.records().is_empty());
        assert_eq!(world.run("session_end", &payload).0, 0);
        let emitted = world.records();
        assert!(!emitted.is_empty());
        assert_eq!(turn_set(&emitted), HashSet::from(["prompt-redacted"]));
        let mut again = payload.clone();
        again["stop_reason"] = json!("end_turn");
        assert_eq!(world.run("stop", &again).0, 0);
        assert_eq!(world.records(), emitted);
    }

    #[test]
    fn session_end_recovers_only_the_rewritten_current_turn() {
        let world = World::new("session-redacted");
        let mut payload = base_payload(&world);
        assert_eq!(world.run("user_prompt_submit", &payload).0, 0);
        payload["stop_reason"] = json!("end_turn");
        assert_eq!(world.run("stop", &payload).0, 0);
        let before = world.records();
        assert_eq!(turn_set(&before), HashSet::from(["prompt-redacted"]));
        let rewritten_chat = [
            json!({"type":"system","content":"rewritten system prompt"}),
            json!({"type":"user","prompt_index":7,"content":"<user_query>do not replay</user_query>","timestamp":"2026-07-29T03:49:01.000Z"}),
            json!({"type":"assistant","content":"historical response","model_id":"grok","timestamp":"2026-07-29T03:49:01.100Z"}),
            json!({"type":"user","prompt_index":8,"content":"<user_query>recover this turn</user_query>","timestamp":"2026-07-29T03:49:02.000Z"}),
            json!({"type":"assistant","content":"recovered response","model_id":"grok","timestamp":"2026-07-29T03:49:02.100Z"}),
        ];
        let rewritten_updates = [
            json!({"timestamp":1785296941u64,"params":{"_meta":{"promptId":"prompt-rewritten-history","agentTimestampMs":1785296941100u64},"update":{"sessionUpdate":"turn_completed","stopReason":"end_turn","_meta":{"promptIndex":7}}}}),
            json!({"timestamp":1785296942u64,"params":{"_meta":{"promptId":"prompt-rewritten-current","agentTimestampMs":1785296942100u64},"update":{"sessionUpdate":"turn_completed","stopReason":"end_turn","_meta":{"promptIndex":8}}}}),
        ];
        let chat_tmp = world.chat.with_extension("replacement");
        let updates_tmp = world.updates.with_extension("replacement");
        write_lines(&chat_tmp, &rewritten_chat);
        fs::rename(&chat_tmp, &world.chat).unwrap();
        write_lines(&updates_tmp, &rewritten_updates);
        fs::rename(&updates_tmp, &world.updates).unwrap();
        fs::write(&world.unified, "").unwrap();
        let mut current = payload.clone();
        current["prompt_id"] = json!("prompt-rewritten-current");
        current["timestamp"] = json!("2026-07-29T03:49:03.000Z");
        current["stop_reason"] = json!("shutdown");
        assert_eq!(world.run("stop", &current).0, 0);
        assert_eq!(world.records(), before);
        current.as_object_mut().unwrap().remove("stop_reason");
        assert_eq!(world.run("session_end", &current).0, 0);
        let after = world.records();
        assert_eq!(
            turn_set(&after),
            HashSet::from(["prompt-redacted", "prompt-rewritten-current"])
        );
        let recovered: Vec<_> = after
            .iter()
            .filter(|record| {
                record.get("gen_ai.turn.id").and_then(Value::as_str)
                    == Some("prompt-rewritten-current")
            })
            .collect();
        assert!(!recovered.is_empty());
        let text = serde_json::to_string(&after).unwrap();
        assert!(text.contains("recover this turn"));
        assert!(!text.contains("do not replay"));
        current["stop_reason"] = json!("end_turn");
        assert_eq!(world.run("stop", &current).0, 0);
        assert_eq!(world.records(), after);
    }

    #[test]
    fn rejects_transcript_paths_outside_the_native_session_directory() {
        let world = World::new("session-redacted");
        let outside = world.root.join("outside-session");
        fs::create_dir_all(&outside).unwrap();
        let outside_updates = outside.join("updates.jsonl");
        fs::copy(fixture("updates.redacted-real.jsonl"), &outside_updates).unwrap();
        fs::copy(
            fixture("chat_history.redacted-real.jsonl"),
            outside.join("chat_history.jsonl"),
        )
        .unwrap();
        let mut payload = base_payload(&world);
        payload["transcript_path"] = json!(outside_updates.to_string_lossy());
        payload["stop_reason"] = json!("end_turn");
        assert_eq!(world.run("stop", &payload).0, 0);
        assert!(world.records().is_empty());
        let state_dir = world.data.join("state/grok-build/sessions");
        let mut persisted = String::new();
        if let Ok(entries) = fs::read_dir(state_dir) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|ext| ext.to_str()) == Some("json") {
                    persisted.push_str(&fs::read_to_string(entry.path()).unwrap_or_default());
                }
            }
        }
        assert!(!persisted.contains(&outside_updates.to_string_lossy().to_string()));
    }

    #[test]
    fn classifies_stop_failure_only_with_a_real_inference_start() {
        let mut world = World::new("session-failure");
        write_lines(
            &world.chat,
            &[
                json!({"type":"system","content":"system"}),
                json!({"type":"user","prompt_index":0,"content":"<user_query>fail</user_query>","timestamp":"2026-07-29T03:48:52.600Z"}),
            ],
        );
        write_lines(
            &world.updates,
            &[json!({
                "timestamp": 1785296932u64,
                "params": {
                    "_meta": {"promptId":"prompt-failure","agentTimestampMs":1785296932600u64,"turnStartMs":1785296932600u64},
                    "update": {"sessionUpdate":"user_message_chunk","_meta":{"promptIndex":0}}
                }
            })],
        );
        write_lines(
            &world.unified,
            &[
                json!({"ts":"2026-07-29T03:48:52.700Z","sid":"session-failure","msg":"shell.turn.inference_start","ctx":{"loop_index":1}}),
            ],
        );
        let (code, _) = world.run(
            "stop_failure",
            &json!({
                "session_id": "session-failure",
                "prompt_id": "prompt-failure",
                "transcript_path": world.updates.to_string_lossy(),
                "error": "HTTP 429 contained private upstream detail",
                "timestamp": "2026-07-29T03:48:53.000Z",
            }),
        );
        assert_eq!(code, 0);
        let emitted = world.records();
        assert_eq!(
            emitted
                .iter()
                .filter(|record| record.get("event.name").and_then(Value::as_str)
                    == Some("llm.request"))
                .count(),
            1
        );
        let response = emitted
            .iter()
            .find(|record| record.get("event.name").and_then(Value::as_str) == Some("llm.response"))
            .unwrap();
        assert_eq!(
            response.get("gen_ai.response.finish_reasons"),
            Some(&json!(["error"]))
        );
        assert_eq!(
            response.get("error.type").and_then(Value::as_str),
            Some("rate_limit")
        );
        assert_eq!(
            response.get("error.message").and_then(Value::as_str),
            Some("model request failed")
        );
        assert!(!serde_json::to_string(&emitted)
            .unwrap()
            .contains("private upstream detail"));

        world.data = world.root.join("pilot-no-attempt");
        fs::create_dir_all(&world.data).unwrap();
        world.use_session("session-no-attempt", false);
        write_lines(
            &world.chat,
            &[
                json!({"type":"system","content":"system"}),
                json!({"type":"user","prompt_index":0,"content":"<user_query>fail</user_query>","timestamp":"2026-07-29T03:48:52.600Z"}),
            ],
        );
        write_lines(
            &world.updates,
            &[json!({
                "timestamp": 1785296932u64,
                "params": {
                    "_meta": {"promptId":"prompt-failure","agentTimestampMs":1785296932600u64,"turnStartMs":1785296932600u64},
                    "update": {"sessionUpdate":"user_message_chunk","_meta":{"promptIndex":0}}
                }
            })],
        );
        fs::write(&world.unified, "").unwrap();
        assert_eq!(
            world
                .run(
                    "stop_failure",
                    &json!({
                        "session_id": "session-no-attempt",
                        "prompt_id": "prompt-failure",
                        "transcript_path": world.updates.to_string_lossy(),
                        "error_type": "network",
                        "timestamp": "2026-07-29T03:48:53.000Z",
                    }),
                )
                .0,
            0
        );
        let emitted = world.records();
        assert_eq!(
            emitted
                .iter()
                .filter(|record| record
                    .get("event.name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("llm."))
                .count(),
            0
        );
        assert_eq!(
            emitted
                .iter()
                .filter(|record| record.get("event.name").and_then(Value::as_str) == Some("other"))
                .count(),
            2
        );
    }

    #[test]
    fn capture_message_content_false_is_ignored() {
        let world = World::new("session-redacted");
        fs::write(
            world.data.join("config.json"),
            r#"{"agents":{"grok-build":{"captureMessageContent":false}}}"#,
        )
        .unwrap();
        let mut payload = base_payload(&world);
        payload["stop_reason"] = json!("end_turn");
        assert_eq!(world.run("stop", &payload).0, 0);
        let emitted = world.records();
        for key in [
            "gen_ai.input.messages_delta",
            "gen_ai.output.messages",
            "gen_ai.system_instructions",
            "gen_ai.tool.call.arguments",
            "gen_ai.tool.call.result",
        ] {
            assert!(
                emitted.iter().any(|record| record.get(key).is_some()),
                "{key}"
            );
        }
        let text = serde_json::to_string(&emitted).unwrap();
        assert!(text.contains("Read two files"));
        assert!(text.contains("license text"));
    }

    #[test]
    fn user_prompt_submit_does_not_borrow_unrelated_history() {
        let mut world = World::new("session-no-chat-correlation");
        world.use_session("session-no-chat-correlation", false);
        fs::write(&world.chat, "").unwrap();
        fs::write(&world.updates, "").unwrap();
        fs::write(&world.unified, "").unwrap();
        let payload = json!({
            "session_id": "session-no-chat-correlation",
            "prompt_id": "prompt-current",
            "transcript_path": world.updates.to_string_lossy(),
            "cwd": "/workspace",
            "timestamp": "2026-07-29T03:49:00.000Z",
        });
        assert_eq!(world.run("user_prompt_submit", &payload).0, 0);
        write_lines(
            &world.chat,
            &[
                json!({"type":"user","prompt_index":0,"content":"<user_query>historical secret</user_query>"}),
                json!({"type":"assistant","content":"historical answer","model_id":"grok"}),
                json!({"type":"user","prompt_index":1,"content":"<user_query>cancelled target</user_query>"}),
                json!({"type":"assistant","content":"target partial","model_id":"grok"}),
            ],
        );
        write_lines(
            &world.updates,
            &[json!({
                "timestamp": 1785296940u64,
                "params": {
                    "_meta": {"agentTimestampMs": 1785296940000u64},
                    "update": {"sessionUpdate":"turn_completed","promptId":"prompt-cancelled","stopReason":"cancelled"}
                }
            })],
        );
        assert_eq!(world.run("user_prompt_submit", &payload).0, 0);
        let emitted = world.records();
        assert_eq!(turn_set(&emitted), HashSet::from(["prompt-cancelled"]));
        assert_eq!(
            emitted
                .iter()
                .filter(|record| record
                    .get("event.name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("llm."))
                .count(),
            0
        );
        let text = serde_json::to_string(&emitted).unwrap();
        assert!(!text.contains("historical secret"));
        assert!(!text.contains("historical answer"));
    }

    #[test]
    fn delays_cancelled_export_and_dedups_concurrent_terminal_hooks() {
        let mut world = World::new("session-delayed-cancel");
        world.use_session("session-delayed-cancel", false);
        fs::write(&world.chat, "").unwrap();
        fs::write(&world.updates, "").unwrap();
        let first = json!({
            "session_id": "session-delayed-cancel",
            "prompt_id": "prompt-1",
            "transcript_path": world.updates.to_string_lossy(),
            "timestamp": "2026-07-29T03:48:52.600Z",
        });
        assert_eq!(world.run("user_prompt_submit", &first).0, 0);
        write_lines(
            &world.chat,
            &[
                json!({"type":"user","prompt_index":0,"content":"<user_query>cancel me</user_query>","timestamp":"2026-07-29T03:48:52.600Z"}),
                json!({"type":"assistant","content":"partial","model_id":"grok","timestamp":"2026-07-29T03:48:53.000Z"}),
                json!({"type":"user","prompt_index":1,"content":"<user_query>next</user_query>","timestamp":"2026-07-29T03:48:54.100Z"}),
            ],
        );
        write_lines(
            &world.updates,
            &[json!({
                "timestamp": 1785296934u64,
                "params": {
                    "_meta": {"agentTimestampMs": 1785296934000u64},
                    "update": {"sessionUpdate":"turn_completed","prompt_id":"prompt-1","stop_reason":"cancelled"}
                }
            })],
        );
        let mut second_prompt = first.clone();
        second_prompt["prompt_id"] = json!("prompt-2");
        second_prompt["timestamp"] = json!("2026-07-29T03:48:54.100Z");
        assert_eq!(world.run("user_prompt_submit", &second_prompt).0, 0);
        let cancelled = world.records();
        assert_eq!(turn_set(&cancelled), HashSet::from(["prompt-1"]));
        assert_eq!(
            cancelled
                .last()
                .unwrap()
                .get("gen_ai.response.finish_reasons"),
            Some(&json!(["cancelled"]))
        );
        let mut chat = fs::read_to_string(&world.chat).unwrap();
        chat.push_str(&serde_json::to_string(&json!({"type":"assistant","content":"second turn answer","model_id":"grok","timestamp":"2026-07-29T03:48:54.200Z"})).unwrap());
        chat.push('\n');
        fs::write(&world.chat, chat).unwrap();
        let mut updates = fs::read_to_string(&world.updates).unwrap();
        updates.push_str(
            &serde_json::to_string(&json!({
                "timestamp": 1785296935u64,
                "params": {
                    "_meta": {"agentTimestampMs": 1785296935000u64},
                    "update": {"sessionUpdate":"turn_completed","prompt_id":"prompt-2","stop_reason":"end_turn"}
                }
            }))
            .unwrap(),
        );
        updates.push('\n');
        fs::write(&world.updates, updates).unwrap();
        let mut stop = first.clone();
        stop["prompt_id"] = json!("prompt-2");
        stop["stop_reason"] = json!("end_turn");
        stop["timestamp"] = json!("2026-07-29T03:48:55.000Z");
        assert_eq!(world.run("stop", &stop).0, 0);
        let after = world.records();
        let second: Vec<_> = after
            .iter()
            .filter(|record| {
                record.get("gen_ai.turn.id").and_then(Value::as_str) == Some("prompt-2")
            })
            .collect();
        assert!(!second.is_empty());
        assert!(serde_json::to_string(&second).unwrap().contains("next"));
        let terminal = json!({
            "session_id": "session-delayed-cancel",
            "prompt_id": "prompt-1",
            "transcript_path": world.updates.to_string_lossy(),
            "stop_reason": "end_turn",
            "timestamp": "2026-07-29T03:48:55.000Z",
        });
        let env = world.env();
        thread::scope(|scope| {
            let left_env = env.clone();
            let right_env = env.clone();
            let left_payload = terminal.clone();
            let right_payload = terminal.clone();
            let left = scope.spawn(move || run_env(&left_env, "stop", &left_payload));
            let right = scope.spawn(move || run_env(&right_env, "session_end", &right_payload));
            assert_eq!(left.join().unwrap().0, 0);
            assert_eq!(right.join().unwrap().0, 0);
        });
        assert_eq!(world.records(), after);
    }
}

#[cfg(test)]
#[path = "grok_emitter_history_tests.rs"]
mod grok_emitter_history_tests;
