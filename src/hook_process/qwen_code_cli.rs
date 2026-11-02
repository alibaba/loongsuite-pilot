//! Qwen Code CLI hook process.
//!
//! Port of `assets/hooks/qwen-code-cli-hook-processor.mjs` and
//! `assets/hooks/qwen-code-cli/*.mjs`. `stop` parses the main transcript and
//! writes event records. `subagent-start` / `subagent-stop` only acknowledge;
//! the parent Stop reads child transcript and meta files.
//!
//! C1 one trace id per turn. C2 turn/step ids. C3 one step per LLM call.
//! C4 request and response share `gen_ai.response.id`. C5 one assistant
//! message holds reasoning, text, and tool calls. C6 tool call and result
//! share `gen_ai.tool.call.id`. C7 user input is `event.name=other`.
//! C8 provider comes from the model, then auth type. C10 record timestamps
//! become `time_unix_nano`. C11 request time is the previous record time.

use super::common::{
    agent_name_patch, collect_resource_attributes, data_dir, finite_f64, iso_to_unix_nanos,
    json_number, load_runtime_config, log_hook_error, parse_json_object, parse_span_attributes,
    random_hex, record_upstream_context_once, sanitize_record, sanitize_session_id, sha256_hex,
    write_atomic_json, write_empty, write_jsonl_records, Env, Obj,
};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AGENT_ID: &str = "qwen-code-cli";
const INITIAL_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb924";
const MAX_TRANSCRIPT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_AGENTS: usize = 1000;
const MAX_DEPTH: u32 = 100;
const SUBAGENT_COLLECTION: &str = "agent.qwen-code-cli.subagent.collection";
const FOREGROUND_COLLECTION: &str = "agent.qwen-code-cli.collection";

pub fn run(request: &mut super::common::HookRequest<'_>) -> i32 {
    let subcommand = request.args.first().map(String::as_str).unwrap_or("");
    match subcommand {
        "stop" => cmd_stop(request),
        "subagent-start" | "subagent-stop" => acknowledge(request),
        _ => {}
    }
    write_empty(request.stdout);
    0
}

fn acknowledge(request: &super::common::HookRequest<'_>) {
    // `readStdinJson` swallows parse failures and returns `{}`.
    let _ = read_event(request.stdin);
}

fn cmd_stop(request: &super::common::HookRequest<'_>) {
    let event = read_event(request.stdin);
    let Some(session_id) = require_session(request.env, &event, "stop") else {
        return;
    };
    record_upstream_context_once(request.env, AGENT_ID, &session_id);
    let mut state = load_state(request.env, &session_id);
    bind_invocation_context(request.env, &mut state);
    if blank_field(state.get("transcript_path")) {
        if let Some(path) = event
            .get("transcript_path")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            state.insert("transcript_path".into(), Value::String(path.to_string()));
        }
    }
    if let Some(cwd) = event
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        state.insert("cwd".into(), Value::String(cwd.to_string()));
    }
    state.insert("stop_time".into(), now_seconds());
    if let Err(err) = save_state(request.env, &session_id, &state) {
        log_hook_error(request.env, AGENT_ID, "main", "unhandled", &err);
        return;
    }
    let stop_reason = event
        .get("stop_reason")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("end_turn");
    if let Err(err) = export_session(request.env, &mut state, stop_reason) {
        log_hook_error(request.env, AGENT_ID, "cmd_stop", "export_failed", &err);
        return;
    }
    if let Some(next) = state.remove("_next_transcript_offset") {
        if let Some(offset) = next
            .as_u64()
            .or_else(|| next.as_f64().map(|value| value as u64))
        {
            state.insert("transcript_offset".into(), Value::from(offset));
        }
    }
    state.insert("events".into(), json!([]));
    state.insert("stop_time".into(), Value::Null);
    if let Err(err) = save_state(request.env, &session_id, &state) {
        log_hook_error(request.env, AGENT_ID, "cmd_stop", "export_failed", &err);
    }
}

fn read_event(bytes: &[u8]) -> Obj {
    parse_json_object(bytes).unwrap_or_default()
}

fn require_session(env: &Env, event: &Obj, stage: &str) -> Option<String> {
    match event
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        Some(session_id) => Some(session_id.to_string()),
        None => {
            log_hook_error(
                env,
                AGENT_ID,
                stage,
                "missing_session_id",
                "hook stdin lacks session_id; skipping",
            );
            None
        }
    }
}

fn bind_invocation_context(env: &Env, state: &mut Obj) {
    let resources = collect_resource_attributes(env, AGENT_ID);
    if resources.is_empty() {
        state.remove("resource_attributes");
    } else {
        state.insert("resource_attributes".into(), Value::Object(resources));
    }
    // Invocation identity keys stay off, matching parseSpanAttributesFromEnv's default.
    let spans = parse_span_attributes(env, AGENT_ID, false);
    if spans.is_empty() {
        state.remove("span_attributes");
    } else {
        state.insert("span_attributes".into(), Value::Object(spans));
    }
}

fn fresh_state(session_id: &str) -> Obj {
    let mut state = Obj::new();
    state.insert("session_id".into(), Value::String(session_id.to_string()));
    state.insert("start_time".into(), now_seconds());
    state.insert("cwd".into(), Value::Null);
    state.insert("transcript_path".into(), Value::Null);
    state.insert("transcript_offset".into(), json!(0));
    state.insert("turn_count".into(), json!(0));
    state.insert("events".into(), json!([]));
    state
}

fn now_seconds() -> Value {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    json_number(millis as f64 / 1000.0)
}

fn session_state_path(env: &Env, session_id: &str) -> PathBuf {
    let dir = data_dir(env).join("state").join(AGENT_ID).join("sessions");
    let _ = fs::create_dir_all(&dir);
    dir.join(format!("{}.json", sanitize_session_id(session_id)))
}

fn load_state(env: &Env, session_id: &str) -> Obj {
    let path = session_state_path(env, session_id);
    if let Ok(text) = fs::read_to_string(&path) {
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => return map,
            Ok(_) => eprintln!(
                "[qwen-code-cli-hook] state file for session {session_id} corrupted; starting fresh (state is not an object)"
            ),
            Err(err) => eprintln!(
                "[qwen-code-cli-hook] state file for session {session_id} corrupted; starting fresh ({err})"
            ),
        }
    }
    fresh_state(session_id)
}

fn save_state(env: &Env, session_id: &str, state: &Obj) -> Result<(), String> {
    let path = session_state_path(env, session_id);
    let dir = path.parent().ok_or("state directory missing")?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("state file name")?;
    write_atomic_json(dir, name, &Value::Object(state.clone()))
}

fn export_session(env: &Env, state: &mut Obj, hook_stop_reason: &str) -> Result<(), String> {
    let session_id = state
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let transcript = match state
        .get("transcript_path")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        Some(path) => path.to_string(),
        None => {
            log_hook_error(
                env,
                AGENT_ID,
                "export",
                "missing_transcript_path",
                "no transcript_path in state; cannot export",
            );
            return Ok(());
        }
    };
    let base_offset = number_or_zero(state.get("transcript_offset"));
    let base_count = number_or_zero(state.get("turn_count"));
    let transcript_path = PathBuf::from(&transcript);
    let mut current_size = fs::metadata(&transcript_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if current_size <= base_offset {
        return Ok(());
    }
    wait_for_transcript_stable(&transcript_path, base_offset);
    ensure_complete_tail(&transcript_path)?;

    let mut parsed_ok = None;
    for attempt in 0..5 {
        match parse_qwen_transcript(&transcript_path, base_offset, Some(&session_id)) {
            Ok(parsed) if !parsed.turns.is_empty() => {
                parsed_ok = Some(parsed);
                break;
            }
            Ok(parsed) => parsed_ok = Some(parsed),
            Err(err) => {
                log_hook_error(env, AGENT_ID, "transcript_parse", "parse_failed", &err);
                parsed_ok = None;
                break;
            }
        }
        thread::sleep(Duration::from_millis(200));
        let new_size = fs::metadata(&transcript_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        if new_size == current_size && attempt > 0 {
            break;
        }
        current_size = new_size;
        wait_for_transcript_stable(&transcript_path, base_offset);
    }
    let parsed = match parsed_ok {
        Some(parsed) if !parsed.turns.is_empty() => parsed,
        _ => return Ok(()),
    };

    let runtime = load_runtime_config(env);
    let cwd = state
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let resources = object_field(state, "resource_attributes");
    let spans = object_field(state, "span_attributes");
    let inventory = load_subagent_index(&transcript_path, &session_id);
    let is_first = js_falsy(state.get("turn_count")) && base_offset == 0;
    let indexes: Vec<usize> = if is_first && parsed.turns.len() > 1 {
        vec![parsed.turns.len() - 1]
    } else {
        (0..parsed.turns.len()).collect()
    };

    let mut log_hash = INITIAL_HASH.to_string();
    let mut all_records = Vec::new();
    let parent_options = TurnOptions::parent();
    for (index, turn_index) in indexes.iter().copied().enumerate() {
        let turn = &parsed.turns[turn_index];
        let turn_stop = if index + 1 == indexes.len() {
            hook_stop_reason
        } else {
            "end_turn"
        };
        let context = RecordContext {
            turn_index: base_count + index as u64,
            session_id: &session_id,
            user_id: &runtime.user_id,
            cwd: cwd.as_deref(),
            resources: &resources,
            spans: &spans,
        };
        let built = build_turn_records(turn, &context, &log_hash, turn_stop, &parent_options);
        let mut records = built.records;
        let mut children = collect_subagents(turn, &mut records, &inventory, &context);
        for record in records.iter_mut().chain(children.iter_mut()) {
            record.insert(
                FOREGROUND_COLLECTION.into(),
                Value::String("foreground-v1".into()),
            );
        }
        let seal = seal_record(&records);
        all_records.append(&mut records);
        all_records.append(&mut children);
        if let Some(seal) = seal {
            all_records.push(seal);
        }
        log_hash = built.hash;
        if turn.positional_fallbacks > 0 {
            log_hook_error(
                env,
                AGENT_ID,
                "pair_tool_results",
                "tool_pair_ambiguous",
                &format!(
                    "positional fallback used for {} tool call(s) in turn {} (session={session_id}); functionCall.id missing — pairings may be incorrect if multiple ID-less calls coexist",
                    turn.positional_fallbacks,
                    base_count + index as u64 + 1
                ),
            );
        }
    }
    state.insert(
        "_next_transcript_offset".into(),
        Value::from(parsed.next_offset),
    );
    state.insert(
        "turn_count".into(),
        Value::from(base_count + parsed.turns.len() as u64),
    );
    let cleaned: Vec<Obj> = all_records.into_iter().map(sanitize_record).collect();
    write_jsonl_records(
        env,
        &data_dir(env).join("logs").join(AGENT_ID),
        AGENT_ID,
        &cleaned,
    )
}

struct Turn {
    prompt: String,
    prompt_timestamp: Option<String>,
    git_branch: Option<String>,
    llm_calls: Vec<LlmCall>,
    positional_fallbacks: u32,
}

struct LlmCall {
    assistant_uuid: Option<String>,
    timestamp: Option<String>,
    request_start: Option<String>,
    model: String,
    usage_metadata: Option<Value>,
    assistant_record: Value,
    api_response: Option<ApiResponse>,
    declared_tools: Vec<DeclaredTool>,
    input_delta: Vec<Value>,
}

struct DeclaredTool {
    call_id: Option<String>,
    native_call_id: Option<String>,
    name: String,
    args: Value,
    part_index: usize,
    result: Option<ToolResult>,
    timestamp: Option<String>,
}

struct ToolResult {
    timestamp: Option<String>,
    response: Option<Value>,
    duration_ms: Option<f64>,
    status: String,
    error: Option<Value>,
}

struct ApiResponse {
    event_name: Option<String>,
    response_id: Option<String>,
    status_code: Option<Value>,
    input_tokens: Option<Value>,
    output_tokens: Option<Value>,
    cached_tokens: Option<Value>,
    auth_type: Option<String>,
    error_message: Option<String>,
    error_type: Option<String>,
    #[allow(dead_code)]
    duration_ms: Option<f64>,
}

struct Parsed {
    turns: Vec<Turn>,
    next_offset: u64,
}

struct TurnOptions {
    turn_id: Option<String>,
    trace_id: Option<String>,
    step_prefix: Option<String>,
    fields: Obj,
    subagent: bool,
}

impl TurnOptions {
    fn parent() -> Self {
        Self {
            turn_id: None,
            trace_id: None,
            step_prefix: None,
            fields: Obj::new(),
            subagent: false,
        }
    }
}

struct BuiltTurn {
    records: Vec<Obj>,
    hash: String,
}

struct Inventory {
    index: HashMap<String, Vec<ChildFile>>,
    reason: String,
}

#[derive(Clone)]
struct ChildFile {
    meta: Obj,
    filename: PathBuf,
}

fn blank_field(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.is_empty(),
        Some(Value::Bool(flag)) => !flag,
        Some(Value::Number(number)) => number.as_f64() == Some(0.0),
        Some(_) => false,
    }
}

fn number_or_zero(value: Option<&Value>) -> u64 {
    let Some(Value::Number(number)) = value else {
        return 0;
    };
    if let Some(value) = number.as_u64() {
        return value;
    }
    number
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value as u64)
        .unwrap_or(0)
}

fn js_falsy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(flag)) => !flag,
        Some(Value::String(text)) => text.is_empty(),
        Some(Value::Number(number)) => !number.as_f64().is_some_and(|value| value != 0.0),
        Some(_) => false,
    }
}

fn object_field(state: &Obj, key: &str) -> Obj {
    match state.get(key) {
        Some(Value::Object(map)) => map.clone(),
        _ => Obj::new(),
    }
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) | Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|value| value.is_finite() && value != 0.0),
    }
}

fn nonempty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn nonempty_ts(record: &Value) -> Option<String> {
    nonempty_string(record.get("timestamp"))
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        value.chars().take(max).collect()
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn wait_for_transcript_stable(path: &Path, min_size: u64) {
    let mut previous: i64 = -1;
    let mut stable = 0u32;
    for _ in 0..10 {
        let size = match fs::metadata(path) {
            Ok(meta) => meta.len(),
            Err(_) => return,
        };
        if size <= min_size {
            thread::sleep(Duration::from_millis(150));
            continue;
        }
        if size as i64 == previous {
            stable += 1;
            if stable >= 2 {
                return;
            }
        } else {
            stable = 0;
        }
        previous = size as i64;
        thread::sleep(Duration::from_millis(150));
    }
}

fn ensure_complete_tail(path: &Path) -> Result<(), String> {
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    let size = file.metadata().map_err(|err| err.to_string())?.len();
    if size == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|err| err.to_string())?;
    let mut byte = [0u8; 1];
    let read = file.read(&mut byte).map_err(|err| err.to_string())?;
    if read != 1 || byte[0] != b'\n' {
        return Err("incomplete main transcript tail; retaining checkpoint".into());
    }
    Ok(())
}

fn read_at(path: &Path, offset: u64, len: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| err.to_string())?;
    let len = usize::try_from(len).map_err(|_| "transcript read is too large".to_string())?;
    let mut buf = vec![0u8; len];
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(String::from_utf8_lossy(&buf[..filled]).into_owned())
}

fn read_incremental(path: &Path, byte_offset: u64) -> Result<(String, u64), String> {
    let file_size = match fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(_) => return Ok((String::new(), byte_offset)),
    };
    if byte_offset >= file_size {
        return Ok((String::new(), byte_offset));
    }
    let read_len = file_size - byte_offset;
    if read_len > MAX_TRANSCRIPT_BYTES {
        let tail_offset = file_size - MAX_TRANSCRIPT_BYTES;
        let actual_offset = tail_offset.max(byte_offset);
        let mut content = read_at(path, actual_offset, file_size - actual_offset)?;
        if actual_offset > byte_offset {
            if let Some(index) = content.find('\n') {
                content = content[index + 1..].to_string();
            }
        }
        return Ok((content, file_size));
    }
    Ok((read_at(path, byte_offset, read_len)?, file_size))
}

fn stable_serialize(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => {
            if *flag {
                "true".into()
            } else {
                "false".into()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(stable_serialize).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    let rendered = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into());
                    format!("{rendered}:{}", stable_serialize(&map[key]))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

fn hash_step(prev: &str, message: &Value) -> String {
    let serialized = stable_serialize(message);
    let mut bytes = Vec::with_capacity(prev.len() + serialized.len());
    bytes.extend(prev.as_bytes());
    bytes.extend(serialized.as_bytes());
    let digest = sha256_hex(&bytes);
    digest[..32].to_string()
}

fn compute_hash(prev: &str, messages: &[Value]) -> String {
    let mut hash = prev.to_string();
    for message in messages {
        hash = hash_step(&hash, message);
    }
    hash
}

fn scoped_tool_id(agent_id: &str, call_id: &str, run_id: &str) -> String {
    let payload =
        serde_json::to_string(&json!([agent_id, run_id, call_id])).unwrap_or_else(|_| "[]".into());
    let digest = sha256_hex(payload.as_bytes());
    format!("qwen-child:{}", &digest[..32])
}

fn pair_key(parent: Value, tool: Value) -> String {
    serde_json::to_string(&Value::Array(vec![parent, tool])).unwrap_or_default()
}

fn safe_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

struct ProviderPatterns {
    claude: Regex,
    qwen: Regex,
    openai: Regex,
    gemini: Regex,
    deepseek: Regex,
    xai: Regex,
}

fn provider_patterns() -> &'static ProviderPatterns {
    static PATTERNS: OnceLock<ProviderPatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| ProviderPatterns {
        claude: Regex::new(r"claude|anthropic").expect("provider regex"),
        qwen: Regex::new(r"qwen|tongyi").expect("provider regex"),
        openai: Regex::new(r"gpt|openai|codex|^o[1-9]").expect("provider regex"),
        gemini: Regex::new(r"gemini").expect("provider regex"),
        deepseek: Regex::new(r"deepseek").expect("provider regex"),
        xai: Regex::new(r"grok|xai|x_ai").expect("provider regex"),
    })
}

fn infer_provider(model: &str, auth_type: Option<&str>) -> String {
    let model = model.to_lowercase();
    let patterns = provider_patterns();
    if patterns.claude.is_match(&model) {
        return "anthropic".into();
    }
    if patterns.qwen.is_match(&model) {
        return "qwen".into();
    }
    if patterns.openai.is_match(&model) {
        return "openai".into();
    }
    if patterns.gemini.is_match(&model) {
        return "gcp.gemini".into();
    }
    if patterns.deepseek.is_match(&model) {
        return "deepseek".into();
    }
    if patterns.xai.is_match(&model) {
        return "x_ai".into();
    }
    match auth_type.unwrap_or("").to_lowercase().as_str() {
        "openai" => "openai",
        "anthropic" => "anthropic",
        "gemini" => "gcp.gemini",
        "qwen" => "qwen",
        _ => "qwen",
    }
    .into()
}

fn parse_millis(timestamp: &str) -> Option<i64> {
    if timestamp.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn same_file_id(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        before.ino() == after.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (before, after);
        true
    }
}

fn same_mtime(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    match (before.modified(), after.modified()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn parse_qwen_transcript(
    path: &Path,
    byte_offset: u64,
    session_id: Option<&str>,
) -> Result<Parsed, String> {
    if path.as_os_str().is_empty() || !path.exists() {
        return Ok(Parsed {
            turns: Vec::new(),
            next_offset: byte_offset,
        });
    }
    let (content, next_offset) = read_incremental(path, byte_offset)?;
    if content.is_empty() {
        return Ok(Parsed {
            turns: Vec::new(),
            next_offset,
        });
    }
    let mut records = Vec::new();
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if keep_main_record(&value) {
            records.push(value);
        }
    }
    if records.is_empty() {
        return Ok(Parsed {
            turns: Vec::new(),
            next_offset,
        });
    }
    let raw_turns = split_into_turns(&records);
    if raw_turns.is_empty() {
        return Ok(Parsed {
            turns: Vec::new(),
            next_offset,
        });
    }
    let turns = raw_turns
        .iter()
        .map(|turn| enrich_turn(&turn.user, &turn.records, session_id, false))
        .collect();
    Ok(Parsed { turns, next_offset })
}

fn keep_main_record(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let Some(typ) = obj.get("type").and_then(Value::as_str) else {
        return false;
    };
    if typ.is_empty() {
        return false;
    }
    if obj.get("isSidechain") == Some(&Value::Bool(true)) || js_truthy(obj.get("agentId")) {
        return false;
    }
    true
}

struct RawTurn {
    user: Value,
    records: Vec<Value>,
}

fn split_into_turns(records: &[Value]) -> Vec<RawTurn> {
    let mut turns = Vec::new();
    let mut current: Option<RawTurn> = None;
    for record in records {
        if is_turn_boundary(record) {
            if let Some(existing) = current.take() {
                turns.push(existing);
            }
            current = Some(RawTurn {
                user: record.clone(),
                records: Vec::new(),
            });
        } else if let Some(turn) = current.as_mut() {
            turn.records.push(record.clone());
        }
    }
    if let Some(existing) = current {
        turns.push(existing);
    }
    turns
}

fn is_turn_boundary(record: &Value) -> bool {
    if record.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let subtype = record.get("subtype").and_then(Value::as_str).unwrap_or("");
    !matches!(subtype, "mid_turn_user_message" | "notification" | "cron")
}

fn enrich_turn(user: &Value, records: &[Value], session_id: Option<&str>, subagent: bool) -> Turn {
    let prefix = session_id
        .filter(|value| !value.is_empty())
        .map(|value| format!("{value}########"));
    let api_indexes: Vec<usize> = records
        .iter()
        .enumerate()
        .filter(|(_, record)| is_main_api(record, prefix.as_deref()))
        .map(|(index, _)| index)
        .collect();
    let mut api_cursor = 0usize;
    let mut prev_ts = nonempty_ts(user);
    let mut delta = vec![user.clone()];
    let mut calls = Vec::new();
    for (index, record) in records.iter().enumerate() {
        let typ = record.get("type").and_then(Value::as_str).unwrap_or("");
        if subagent && typ == "user" {
            delta.push(record.clone());
            if let Some(timestamp) = nonempty_ts(record) {
                prev_ts = Some(timestamp);
            }
            continue;
        }
        if typ == "tool_result" {
            delta.push(record.clone());
            if let Some(timestamp) = nonempty_ts(record) {
                prev_ts = Some(timestamp);
            }
            continue;
        }
        if typ != "assistant" {
            continue;
        }
        let mut matched = None;
        while api_cursor < api_indexes.len() {
            let candidate = api_indexes[api_cursor];
            if candidate <= index {
                matched = Some(candidate);
                api_cursor += 1;
            } else {
                break;
            }
        }
        let api = matched.and_then(|index| extract_api(&records[index]));
        let parts = record
            .pointer("/message/parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let timestamp = nonempty_ts(record);
        calls.push(LlmCall {
            assistant_uuid: nonempty_string(record.get("uuid")),
            timestamp: timestamp.clone(),
            request_start: prev_ts.clone().or_else(|| timestamp.clone()),
            model: nonempty_string(record.get("model")).unwrap_or_else(|| "unknown".into()),
            usage_metadata: match record.get("usageMetadata") {
                Some(Value::Object(map)) => Some(Value::Object(map.clone())),
                Some(other) if js_truthy(Some(other)) => Some(other.clone()),
                _ => None,
            },
            assistant_record: record.clone(),
            api_response: api,
            declared_tools: declared_from_parts(&parts),
            input_delta: std::mem::take(&mut delta),
        });
        delta = vec![record.clone()];
        if let Some(timestamp) = timestamp {
            prev_ts = Some(timestamp);
        }
    }
    let positional_fallbacks = pair_tool_calls_with_results(&mut calls, records, subagent);
    Turn {
        prompt: extract_user_prompt(user),
        prompt_timestamp: nonempty_ts(user),
        git_branch: nonempty_string(user.get("gitBranch")),
        llm_calls: calls,
        positional_fallbacks,
    }
}

fn is_main_api(record: &Value, prefix: Option<&str>) -> bool {
    if record.get("type").and_then(Value::as_str) != Some("system")
        || record.get("subtype").and_then(Value::as_str) != Some("ui_telemetry")
    {
        return false;
    }
    let Some(event) = record.pointer("/systemPayload/uiEvent") else {
        return false;
    };
    let name = event.get("event.name").and_then(Value::as_str);
    if name != Some("qwen-code.api_response") && name != Some("qwen-code.api_error") {
        return false;
    }
    match prefix {
        Some(prefix) => event
            .get("prompt_id")
            .and_then(Value::as_str)
            .is_some_and(|prompt_id| prompt_id.starts_with(prefix)),
        None => true,
    }
}

fn number_field(event: &Value, key: &str) -> Option<Value> {
    event.get(key).filter(|value| value.is_number()).cloned()
}

fn extract_api(record: &Value) -> Option<ApiResponse> {
    let event = record.pointer("/systemPayload/uiEvent")?;
    Some(ApiResponse {
        event_name: nonempty_string(event.get("event.name")),
        response_id: nonempty_string(event.get("response_id")),
        status_code: number_field(event, "status_code"),
        input_tokens: number_field(event, "input_token_count"),
        output_tokens: number_field(event, "output_token_count"),
        cached_tokens: number_field(event, "cached_content_token_count"),
        auth_type: nonempty_string(event.get("auth_type")),
        error_message: nonempty_string(event.get("error_message")),
        error_type: nonempty_string(event.get("error_type")),
        duration_ms: finite_f64(event.get("duration_ms")),
    })
}

fn declared_from_parts(parts: &[Value]) -> Vec<DeclaredTool> {
    let mut tools = Vec::new();
    for part in parts {
        let Some(call) = part.get("functionCall").and_then(Value::as_object) else {
            continue;
        };
        let call_id = match call.get("id") {
            Some(Value::String(id)) if !id.is_empty() => Some(id.clone()),
            _ => None,
        };
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = match call.get("args") {
            None | Some(Value::Null) => Value::Null,
            Some(value) => value.clone(),
        };
        tools.push(DeclaredTool {
            call_id,
            native_call_id: None,
            name,
            args,
            part_index: tools.len(),
            result: None,
            timestamp: None,
        });
    }
    tools
}

fn extract_user_prompt(user: &Value) -> String {
    let Some(parts) = user.pointer("/message/parts").and_then(Value::as_array) else {
        return String::new();
    };
    let mut text = String::new();
    for part in parts {
        if let Some(piece) = part.get("text").and_then(Value::as_str) {
            text.push_str(piece);
        }
    }
    text
}

fn uuid_of(record: &Value) -> Option<String> {
    nonempty_string(record.get("uuid"))
}

fn tool_result_call_id(record: &Value) -> Option<&str> {
    record
        .pointer("/toolCallResult/callId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn pair_tool_calls_with_results(calls: &mut [LlmCall], records: &[Value], strict: bool) -> u32 {
    let tool_results: Vec<&Value> = records
        .iter()
        .filter(|record| record.get("type").and_then(Value::as_str) == Some("tool_result"))
        .collect();
    let mut claimed: HashSet<Option<String>> = HashSet::new();
    for call in calls.iter_mut() {
        for tool in &mut call.declared_tools {
            let Some(call_id) = tool.call_id.clone().filter(|id| !id.is_empty()) else {
                continue;
            };
            if let Some(found) = tool_results.iter().copied().find(|result| {
                !claimed.contains(&uuid_of(result))
                    && tool_result_call_id(result) == Some(call_id.as_str())
            }) {
                claimed.insert(uuid_of(found));
                tool.result = Some(extract_tool_result(found));
            }
        }
    }
    if strict {
        return 0;
    }
    let unclaimed: Vec<&Value> = tool_results
        .into_iter()
        .filter(|result| !claimed.contains(&uuid_of(result)))
        .collect();
    let mut cursor = 0usize;
    let mut used = 0u32;
    for call in calls.iter_mut() {
        for tool in &mut call.declared_tools {
            if tool.result.is_some() || cursor >= unclaimed.len() {
                continue;
            }
            let result = unclaimed[cursor];
            cursor += 1;
            used += 1;
            if tool.call_id.as_deref().unwrap_or("").is_empty() {
                if let Some(id) = tool_result_call_id(result) {
                    tool.call_id = Some(id.to_string());
                }
            }
            tool.result = Some(extract_tool_result(result));
        }
    }
    used
}

fn first_truthy(map: Option<&Obj>, key: &str) -> Option<Value> {
    map.and_then(|object| object.get(key))
        .filter(|value| js_truthy(Some(value)))
        .cloned()
}

fn extract_tool_result(record: &Value) -> ToolResult {
    let tcr = record.get("toolCallResult").and_then(Value::as_object);
    let function_response = record
        .pointer("/message/parts")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find(|part| part.get("functionResponse").is_some())
                .and_then(|part| part.get("functionResponse"))
        });
    let response = if let Some(function_response) = function_response {
        match function_response.get("response") {
            Some(Value::Null) | None => None,
            Some(value) => Some(value.clone()),
        }
    } else {
        tcr.and_then(|map| map.get("resultDisplay"))
            .filter(|value| !value.is_null())
            .cloned()
    };
    let status = tcr
        .and_then(|map| map.get("status"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("success")
        .to_string();
    let error = if status == "error" {
        Some(
            first_truthy(tcr, "error")
                .or_else(|| first_truthy(tcr, "resultDisplay"))
                .unwrap_or_else(|| Value::String(String::new())),
        )
    } else {
        None
    };
    ToolResult {
        timestamp: nonempty_ts(record),
        response,
        duration_ms: tcr.and_then(|map| finite_f64(map.get("durationMs"))),
        status,
        error,
    }
}

fn convert_qwen_part(part: &Value, tool_call_id: Option<&str>) -> Option<Value> {
    let obj = part.as_object()?;
    if obj.get("thought") == Some(&Value::Bool(true)) {
        if let Some(text) = obj.get("text").and_then(Value::as_str) {
            return Some(json!({"type": "reasoning", "content": text}));
        }
    }
    if let Some(text) = obj.get("text").and_then(Value::as_str) {
        return Some(json!({"type": "text", "content": text}));
    }
    if let Some(call) = obj.get("functionCall").and_then(Value::as_object) {
        let id = match call.get("id") {
            Some(Value::String(value)) if !value.is_empty() => Value::String(value.clone()),
            Some(other) if js_truthy(Some(other)) => other.clone(),
            _ => Value::Null,
        };
        let name = match call.get("name") {
            Some(Value::String(value)) if !value.is_empty() => Value::String(value.clone()),
            Some(other) if js_truthy(Some(other)) => other.clone(),
            _ => Value::String(String::new()),
        };
        let arguments = match call.get("args") {
            None | Some(Value::Null) => Value::Null,
            Some(value) => value.clone(),
        };
        return Some(json!({
            "type": "tool_call",
            "id": id,
            "name": name,
            "arguments": arguments,
        }));
    }
    if let Some(response) = obj.get("functionResponse").and_then(Value::as_object) {
        let id = match tool_call_id {
            Some(id) if !id.is_empty() => Value::String(id.to_string()),
            _ => Value::Null,
        };
        let body = match response.get("response") {
            None | Some(Value::Null) => Value::Null,
            Some(value) => value.clone(),
        };
        return Some(json!({
            "type": "tool_call_response",
            "id": id,
            "response": body,
        }));
    }
    None
}

fn convert_qwen_parts(parts: Option<&Vec<Value>>, tool_call_id: Option<&str>) -> Vec<Value> {
    let Some(parts) = parts else {
        return Vec::new();
    };
    parts
        .iter()
        .filter_map(|part| convert_qwen_part(part, tool_call_id))
        .collect()
}

fn infer_assistant_finish_reason(assistant: &Value) -> &'static str {
    let Some(parts) = assistant
        .pointer("/message/parts")
        .and_then(Value::as_array)
    else {
        return "stop";
    };
    if parts.is_empty() {
        return "stop";
    }
    if parts.iter().any(|part| {
        part.get("functionCall")
            .and_then(Value::as_object)
            .is_some()
    }) {
        "tool_call"
    } else {
        "stop"
    }
}

fn build_output_messages(assistant: &Value) -> Vec<Value> {
    let parts = convert_qwen_parts(
        assistant
            .pointer("/message/parts")
            .and_then(Value::as_array),
        None,
    );
    vec![json!({
        "role": "assistant",
        "parts": parts,
        "finish_reason": infer_assistant_finish_reason(assistant),
    })]
}

fn build_input_messages_delta(records: &[Value], id_map: &HashMap<String, String>) -> Vec<Value> {
    let mut messages = Vec::new();
    for record in records {
        let Some(obj) = record.as_object() else {
            continue;
        };
        let message = obj.get("message").unwrap_or(&Value::Null);
        let parts = message.get("parts").and_then(Value::as_array);
        let typ = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if typ == "assistant" {
            let converted = convert_qwen_parts(parts, None);
            if !converted.is_empty() {
                messages.push(json!({"role": "assistant", "parts": converted}));
            }
            continue;
        }
        if typ == "tool_result" {
            let mapped = obj
                .get("uuid")
                .and_then(Value::as_str)
                .and_then(|uuid| id_map.get(uuid))
                .map(String::as_str)
                .filter(|value| !value.is_empty());
            let from_result = tool_result_call_id(record);
            let converted = convert_qwen_parts(parts, mapped.or(from_result));
            if !converted.is_empty() {
                messages.push(json!({"role": "tool", "parts": converted}));
            }
            continue;
        }
        let converted = convert_qwen_parts(parts, None);
        if !converted.is_empty() {
            let role = if message.get("role").and_then(Value::as_str) == Some("tool") {
                "tool"
            } else {
                "user"
            };
            messages.push(json!({"role": role, "parts": converted}));
        }
    }
    messages
}

fn parse_subagent_records(source: &[Value], meta: &Obj) -> Result<Turn, String> {
    let agent_id = meta.get("agentId").and_then(Value::as_str).unwrap_or("");
    let parent_session = meta
        .get("parentSessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut records: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    let mut round_index: Option<usize> = None;
    let mut tools_open = false;
    let mut run_id = String::new();
    let mut active_calls: HashMap<String, String> = HashMap::new();
    let mut tool_times: HashMap<String, (Option<String>, String)> = HashMap::new();
    for raw in source {
        if raw.get("agentId").and_then(Value::as_str) != Some(agent_id)
            || raw.get("sessionId").and_then(Value::as_str) != Some(parent_session)
        {
            return Err("identity_mismatch".into());
        }
        let Some(uuid) = raw
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !seen.insert(uuid.to_string()) {
            continue;
        }
        let mut record = raw.clone();
        if let Some(next_run) = record
            .get("agentRunId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            run_id = next_run.to_string();
        }
        let timestamp = nonempty_ts(&record);
        let mut parts = record
            .pointer("/message/parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if parts.iter().any(|part| !part.is_object()) {
            return Err("bad_part".into());
        }
        for part in &mut parts {
            let Some(obj) = part.as_object_mut() else {
                continue;
            };
            let call_id = obj
                .get("functionCall")
                .and_then(|call| call.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if let Some(id) = call_id {
                let scoped = scoped_tool_id(agent_id, &id, &run_id);
                if let Some(call) = obj.get_mut("functionCall").and_then(Value::as_object_mut) {
                    call.insert("id".into(), Value::String(scoped.clone()));
                }
                active_calls.insert(id.clone(), scoped.clone());
                tool_times.insert(scoped, (timestamp.clone(), id));
            }
            let response_id = obj
                .get("functionResponse")
                .and_then(|response| response.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if let Some(id) = response_id {
                let scoped = active_calls
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| scoped_tool_id(agent_id, &id, &run_id));
                if let Some(response) = obj
                    .get_mut("functionResponse")
                    .and_then(Value::as_object_mut)
                {
                    response.insert("id".into(), Value::String(scoped));
                }
            }
        }
        if let Some(message) = record.get_mut("message").and_then(Value::as_object_mut) {
            message.insert("parts".into(), Value::Array(parts.clone()));
        }
        let error_status = parts
            .iter()
            .any(|part| js_truthy(part.pointer("/functionResponse/response/error")));
        if let Some(result) = record
            .get_mut("toolCallResult")
            .and_then(Value::as_object_mut)
        {
            if let Some(call_id) = result
                .get("callId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
            {
                let scoped = active_calls
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| scoped_tool_id(agent_id, &call_id, &run_id));
                result.insert("callId".into(), Value::String(scoped));
            }
            if error_status {
                result.insert("status".into(), Value::String("error".into()));
            }
        }
        let typ = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if typ == "assistant" {
            let tool_only =
                !parts.is_empty() && parts.iter().all(|part| js_truthy(part.get("functionCall")));
            let agent_round_missing = record
                .as_object()
                .map(|obj| !obj.contains_key("agentRound"))
                .unwrap_or(true);
            if let Some(index) =
                round_index.filter(|_| tool_only && tools_open && agent_round_missing)
            {
                if let Some(dest) = records[index]
                    .pointer_mut("/message/parts")
                    .and_then(Value::as_array_mut)
                {
                    dest.extend(parts);
                }
            } else {
                assign_round_model(&mut record, meta);
                records.push(record);
                round_index = Some(records.len() - 1);
            }
            tools_open = true;
        } else {
            let subtype = record
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            records.push(record);
            if typ == "tool_result" || typ == "user" || subtype == "agent_retry" {
                tools_open = false;
            }
        }
    }
    let user_index = records
        .iter()
        .position(|record| record.get("type").and_then(Value::as_str) == Some("user"))
        .ok_or("missing_input")?;
    let user = records[user_index].clone();
    let rest = records[user_index + 1..].to_vec();
    let mut turn = enrich_turn(&user, &rest, None, true);
    if let Some(history) = records.iter().find_map(|record| {
        if record.get("subtype").and_then(Value::as_str) == Some("agent_bootstrap") {
            record
                .pointer("/systemPayload/history")
                .and_then(Value::as_array)
                .cloned()
        } else {
            None
        }
    }) {
        if !turn.llm_calls.is_empty() {
            let mut prefixed = Vec::new();
            for message in history {
                let typ = if message.get("role").and_then(Value::as_str) == Some("model") {
                    "assistant"
                } else {
                    "user"
                };
                prefixed.push(json!({"type": typ, "message": message}));
            }
            prefixed.append(&mut turn.llm_calls[0].input_delta);
            turn.llm_calls[0].input_delta = prefixed;
        }
    }
    for llm in &mut turn.llm_calls {
        let uuid = llm.assistant_uuid.clone().unwrap_or_default();
        llm.assistant_uuid = Some(format!("{agent_id}:{uuid}"));
        for tool in &mut llm.declared_tools {
            if let Some(call_id) = tool.call_id.clone() {
                if let Some((timestamp, native)) = tool_times.get(&call_id) {
                    tool.native_call_id = Some(native.clone());
                    tool.timestamp = timestamp.clone();
                }
            }
        }
    }
    Ok(turn)
}

fn assign_round_model(record: &mut Value, meta: &Obj) {
    if record
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    let model = meta
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            meta.get("persistedCliFlags")
                .and_then(|flags| flags.get("model"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
    if let Some(model) = model {
        if let Some(obj) = record.as_object_mut() {
            obj.insert("model".into(), Value::String(model.to_string()));
        }
    }
}

fn meta_acceptable(meta: &Obj, session_id: &str, name: &str) -> bool {
    if meta.get("parentSessionId").and_then(Value::as_str) != Some(session_id) {
        return false;
    }
    let Some(agent_id) = meta.get("agentId").and_then(Value::as_str) else {
        return false;
    };
    let Some(tool) = meta.get("toolUseId").and_then(Value::as_str) else {
        return false;
    };
    if tool.is_empty() {
        return false;
    }
    match meta.get("parentAgentId") {
        Some(Value::Null) | Some(Value::String(_)) => {}
        _ => return false,
    }
    name == format!("agent-{}.meta.json", safe_name(agent_id))
}

fn load_subagent_index(transcript: &Path, session_id: &str) -> Inventory {
    let mut index = HashMap::new();
    let Some(parent) = transcript.parent() else {
        return Inventory {
            index,
            reason: "metadata_unavailable".into(),
        };
    };
    if parent.file_name().and_then(|name| name.to_str()) != Some("chats") {
        return Inventory {
            index,
            reason: "metadata_unavailable".into(),
        };
    }
    let Some(project) = parent.parent() else {
        return Inventory {
            index,
            reason: "metadata_unavailable".into(),
        };
    };
    let dir = project.join("subagents").join(safe_name(session_id));
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => {
            return Inventory {
                index,
                reason: "metadata_unavailable".into(),
            };
        }
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    if names.len() > MAX_AGENTS * 3 {
        return Inventory {
            index,
            reason: "collection_limit".into(),
        };
    }
    let mut count = 0usize;
    for name in &names {
        if !name.starts_with("agent-") || !name.ends_with(".meta.json") {
            continue;
        }
        count += 1;
        if count > MAX_AGENTS {
            return Inventory {
                index: HashMap::new(),
                reason: "collection_limit".into(),
            };
        }
        let meta_path = dir.join(name);
        let meta_len = fs::metadata(&meta_path)
            .map(|meta| meta.len())
            .unwrap_or(u64::MAX);
        if meta_len > 1024 * 1024 {
            continue;
        }
        let Ok(text) = fs::read_to_string(&meta_path) else {
            continue;
        };
        let Ok(Value::Object(meta)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if !meta_acceptable(&meta, session_id, name) {
            continue;
        }
        let tool = meta
            .get("toolUseId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let parent_id = meta.get("parentAgentId").cloned().unwrap_or(Value::Null);
        let key = pair_key(parent_id, Value::String(tool));
        let stem = name.strip_suffix(".meta.json").unwrap_or(name);
        index.entry(key).or_default().push(ChildFile {
            meta,
            filename: dir.join(format!("{stem}.jsonl")),
        });
    }
    Inventory {
        index,
        reason: "metadata_missing".into(),
    }
}

struct CollectCtx<'a> {
    inventory: &'a Inventory,
    output: Vec<Obj>,
    visited: HashSet<String>,
    bytes: u64,
    trace_id: Option<String>,
    turn_id: Option<String>,
    root_agent_id: String,
    session_id: &'a str,
    user_id: &'a str,
    turn_index: u64,
    cwd: Option<&'a str>,
    resources: &'a Obj,
    spans: &'a Obj,
}

struct RecordContext<'a> {
    turn_index: u64,
    session_id: &'a str,
    user_id: &'a str,
    cwd: Option<&'a str>,
    resources: &'a Obj,
    spans: &'a Obj,
}

fn collect_subagents(
    turn: &Turn,
    records: &mut [Obj],
    inventory: &Inventory,
    context: &RecordContext<'_>,
) -> Vec<Obj> {
    let RecordContext {
        session_id,
        user_id,
        turn_index,
        cwd,
        resources,
        spans,
    } = *context;
    let trace_id = records
        .first()
        .and_then(|record| nonempty_string(record.get("trace_id")));
    let turn_id = records
        .first()
        .and_then(|record| nonempty_string(record.get("gen_ai.turn.id")));
    let root_agent_id = records
        .first()
        .and_then(|record| nonempty_string(record.get("gen_ai.agent.id")))
        .unwrap_or_default();
    let mut ctx = CollectCtx {
        inventory,
        output: Vec::new(),
        visited: HashSet::new(),
        bytes: 0,
        trace_id,
        turn_id,
        root_agent_id,
        session_id,
        user_id,
        turn_index,
        cwd,
        resources,
        spans,
    };
    visit_agents(turn, records, None, 1, &mut ctx);
    ctx.output
}

fn mark_tool(records: &mut [Obj], call_id: Option<&str>, reason: &str) {
    let Some(call_id) = call_id.filter(|value| !value.is_empty()) else {
        return;
    };
    for record in records {
        if record.get("gen_ai.tool.call.id").and_then(Value::as_str) == Some(call_id) {
            record.insert(SUBAGENT_COLLECTION.into(), Value::String(reason.into()));
        }
    }
}

fn tool_lookup_id(tool: &DeclaredTool) -> Value {
    if let Some(native) = tool
        .native_call_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        return Value::String(native.to_string());
    }
    match tool.call_id.as_deref() {
        Some(id) => Value::String(id.to_string()),
        None => Value::Null,
    }
}

fn visit_agents(
    turn: &Turn,
    records: &mut [Obj],
    parent_id: Option<&str>,
    depth: u32,
    ctx: &mut CollectCtx<'_>,
) {
    for llm in &turn.llm_calls {
        for tool in &llm.declared_tools {
            let key = pair_key(
                match parent_id {
                    Some(id) => Value::String(id.to_string()),
                    None => Value::Null,
                },
                tool_lookup_id(tool),
            );
            let found = ctx.inventory.index.get(&key).cloned().unwrap_or_default();
            let default_reason = ctx.inventory.reason.clone();
            if found.is_empty() && tool.name != "agent" {
                continue;
            }
            if found.len() != 1 {
                let reason = if found.is_empty() {
                    default_reason
                } else {
                    "ambiguous_parent".into()
                };
                mark_tool(records, tool.call_id.as_deref(), &reason);
                continue;
            }
            let child = found.into_iter().next().unwrap();
            let agent_id = child
                .meta
                .get("agentId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match child.meta.get("isBackgrounded") {
                Some(Value::Bool(true)) => {
                    mark_tool(records, tool.call_id.as_deref(), "unsupported_background");
                    continue;
                }
                Some(Value::Bool(false)) => {}
                _ => {
                    mark_tool(records, tool.call_id.as_deref(), "unknown_execution_mode");
                    continue;
                }
            }
            let terminal = matches!(
                child.meta.get("status").and_then(Value::as_str),
                Some("completed" | "failed" | "cancelled")
            );
            if tool.result.is_none() || !terminal {
                mark_tool(records, tool.call_id.as_deref(), "incomplete");
                continue;
            }
            if depth > MAX_DEPTH || ctx.visited.contains(&agent_id) {
                mark_tool(records, tool.call_id.as_deref(), "invalid_hierarchy");
                continue;
            }
            let result_ts = tool
                .result
                .as_ref()
                .and_then(|result| result.timestamp.clone());
            match read_child_turn(
                ctx,
                &child.meta,
                &child.filename,
                tool.timestamp.as_deref(),
                llm.timestamp.as_deref(),
                result_ts.as_deref(),
            ) {
                Ok(child_turn) => {
                    ctx.visited.insert(agent_id.clone());
                    let parent_field = match parent_id {
                        Some(id) if !id.is_empty() => id.to_string(),
                        _ => ctx.root_agent_id.clone(),
                    };
                    let mut fields = Obj::new();
                    fields.insert("gen_ai.agent.id".into(), Value::String(agent_id.clone()));
                    let agent_name = child
                        .meta
                        .get("agentType")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .or_else(|| {
                            child
                                .meta
                                .get("subagentName")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                        })
                        .unwrap_or(agent_id.as_str())
                        .to_string();
                    fields.insert("gen_ai.agent.name".into(), Value::String(agent_name));
                    fields.insert("gen_ai.agent.scope".into(), json!("subagent"));
                    fields.insert("gen_ai.agent.depth".into(), Value::from(depth as i64));
                    fields.insert("gen_ai.agent.parent.id".into(), Value::String(parent_field));
                    fields.insert(
                        "gen_ai.subagent.parent_tool_call.id".into(),
                        match &tool.call_id {
                            Some(id) => Value::String(id.clone()),
                            None => Value::Null,
                        },
                    );
                    if let Some(status) = child.meta.get("status").and_then(Value::as_str) {
                        fields.insert(
                            "agent.qwen-code-cli.subagent.status".into(),
                            Value::String(status.to_string()),
                        );
                    }
                    fields.insert(
                        "agent.qwen-code-cli.timing.source".into(),
                        json!("transcript_boundary"),
                    );
                    let step_prefix = format!(
                        "{}:agent:{agent_id}",
                        ctx.turn_id.as_deref().unwrap_or("undefined")
                    );
                    let options = TurnOptions {
                        turn_id: ctx.turn_id.clone(),
                        trace_id: ctx.trace_id.clone(),
                        step_prefix: Some(step_prefix),
                        fields,
                        subagent: true,
                    };
                    let mut child_records = build_turn_records(
                        &child_turn,
                        &RecordContext {
                            turn_index: ctx.turn_index,
                            session_id: ctx.session_id,
                            user_id: ctx.user_id,
                            cwd: ctx.cwd,
                            resources: ctx.resources,
                            spans: ctx.spans,
                        },
                        INITIAL_HASH,
                        "end_turn",
                        &options,
                    )
                    .records;
                    mark_tool(records, tool.call_id.as_deref(), "collected");
                    visit_agents(
                        &child_turn,
                        &mut child_records,
                        Some(agent_id.as_str()),
                        depth + 1,
                        ctx,
                    );
                    ctx.output.extend(child_records);
                }
                Err(reason) => mark_tool(records, tool.call_id.as_deref(), reason),
            }
        }
    }
}

fn read_child_turn(
    ctx: &mut CollectCtx<'_>,
    meta: &Obj,
    filename: &Path,
    tool_ts: Option<&str>,
    llm_ts: Option<&str>,
    result_ts: Option<&str>,
) -> Result<Turn, &'static str> {
    let before = fs::metadata(filename).map_err(|_| "transcript_unavailable")?;
    if ctx.bytes as u128 + before.len() as u128 > MAX_TRANSCRIPT_BYTES as u128 {
        return Err("collection_limit");
    }
    ctx.bytes += before.len();
    let bytes = fs::read(filename).map_err(|_| "transcript_unavailable")?;
    let text = String::from_utf8_lossy(&bytes);
    let after = fs::metadata(filename).map_err(|_| "transcript_unavailable")?;
    if !same_file_id(&before, &after)
        || before.len() != after.len()
        || !same_mtime(&before, &after)
        || (!text.is_empty() && !text.ends_with('\n'))
    {
        return Err("incomplete");
    }
    let mut source = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(line).map_err(|_| "transcript_unavailable")?;
        source.push(value);
    }
    let start = tool_ts.or(llm_ts).and_then(parse_millis);
    let end = result_ts.and_then(parse_millis);
    let (Some(start), Some(end)) = (start, end) else {
        return Err("missing_time_boundary");
    };
    let window: Vec<Value> = source
        .into_iter()
        .filter(|record| {
            record
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_millis)
                .is_some_and(|timestamp| timestamp >= start && timestamp <= end)
        })
        .collect();
    let turn = parse_subagent_records(&window, meta).map_err(|_| "transcript_unavailable")?;
    if turn.llm_calls.is_empty() {
        return Err("no_model_records");
    }
    Ok(turn)
}

fn seal_record(records: &[Obj]) -> Option<Obj> {
    let mut seal = records.first()?.clone();
    let time = records.last()?.get("time_unix_nano")?.clone();
    seal.insert(
        "event.id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    seal.insert("event.name".into(), json!("other"));
    seal.remove("gen_ai.input.messages_delta");
    seal.insert("time_unix_nano".into(), time);
    seal.insert("gen_ai.turn.end".into(), json!(true));
    Some(seal)
}

fn event_time(record: &Obj) -> i128 {
    record
        .get("time_unix_nano")
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn compose(base: &Obj, time: &str, name: &str, extra: Obj) -> Obj {
    let mut out = Obj::new();
    out.insert(
        "time_unix_nano".into(),
        Value::String(iso_to_unix_nanos(time)),
    );
    out.insert(
        "event.id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    out.insert("event.name".into(), Value::String(name.to_string()));
    for (key, value) in base {
        out.entry(key.clone()).or_insert_with(|| value.clone());
    }
    for (key, value) in extra {
        out.insert(key, value);
    }
    out
}

fn coalesce_field(
    primary: Option<&Obj>,
    key: &str,
    secondary: Option<&Value>,
    default: Value,
) -> Value {
    match primary.and_then(|map| map.get(key)) {
        Some(value) if !value.is_null() => value.clone(),
        _ => match secondary {
            Some(value) if !value.is_null() => value.clone(),
            _ => default,
        },
    }
}

fn add_numbers(left: &Value, right: &Value) -> Value {
    match (left.as_f64(), right.as_f64()) {
        (Some(left), Some(right)) if left.is_finite() && right.is_finite() => {
            json_number(left + right)
        }
        _ => json!(0),
    }
}

fn subagent_metric(usage: Option<&Obj>, key: &str) -> Option<Value> {
    let value = usage.and_then(|map| map.get(key))?;
    if value.is_null() {
        return None;
    }
    let number = value.as_f64()?;
    if number.is_finite() && number >= 0.0 {
        Some(value.clone())
    } else {
        None
    }
}

fn subagent_total(usage: Option<&Obj>) -> Option<Value> {
    if let Some(raw) = usage.and_then(|map| map.get("totalTokenCount")) {
        if !raw.is_null() {
            return raw
                .as_f64()
                .filter(|number| number.is_finite() && *number >= 0.0)
                .map(|_| raw.clone());
        }
    }
    let prompt = usage.and_then(|map| finite_f64(map.get("promptTokenCount")));
    let output = usage.and_then(|map| finite_f64(map.get("candidatesTokenCount")));
    match (prompt, output) {
        (Some(prompt), Some(output)) if (prompt + output).is_finite() && prompt + output >= 0.0 => {
            Some(json_number(prompt + output))
        }
        _ => None,
    }
}

fn put_metric(record: &mut Obj, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            record.insert(key.into(), value);
        }
        None => {
            record.remove(key);
        }
    }
}

fn build_turn_records(
    turn: &Turn,
    context: &RecordContext<'_>,
    prev_hash: &str,
    stop_reason: &str,
    options: &TurnOptions,
) -> BuiltTurn {
    let RecordContext {
        turn_index,
        session_id,
        user_id,
        cwd,
        resources,
        spans,
    } = *context;
    let mut base = Obj::new();
    for (key, value) in spans {
        base.insert(key.clone(), value.clone());
    }
    let trace_id = options
        .trace_id
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| random_hex(16));
    let turn_id = options
        .turn_id
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{session_id}:t{}", turn_index + 1));
    base.insert("trace_id".into(), Value::String(trace_id));
    base.insert(
        "gen_ai.session.id".into(),
        Value::String(session_id.to_string()),
    );
    base.insert("gen_ai.turn.id".into(), Value::String(turn_id.clone()));
    base.insert("gen_ai.agent.type".into(), Value::String(AGENT_ID.into()));
    base.insert(
        "gen_ai.agent.id".into(),
        Value::String(session_id.to_string()),
    );
    base.insert("user.id".into(), Value::String(user_id.to_string()));
    if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
        base.insert(
            "agent.qwen-code-cli.cwd".into(),
            Value::String(cwd.to_string()),
        );
    }
    if let Some(branch) = turn.git_branch.as_deref().filter(|value| !value.is_empty()) {
        base.insert("git.branch".into(), Value::String(branch.to_string()));
    }
    if let Some(name) = agent_name_patch(resources) {
        base.insert("gen_ai.agent.name".into(), Value::String(name));
    }
    for (key, value) in &options.fields {
        base.insert(key.clone(), value.clone());
    }
    if !resources.is_empty() {
        base.insert(
            "resourceAttributes".into(),
            Value::Object(resources.clone()),
        );
    }

    let mut records = Vec::new();
    if !turn.prompt.is_empty() {
        let mut extra = Obj::new();
        extra.insert(
            "gen_ai.input.messages_delta".into(),
            json!([{
                "role": "user",
                "parts": [{"type": "text", "content": turn.prompt}],
            }]),
        );
        records.push(compose(
            &base,
            turn.prompt_timestamp.as_deref().unwrap_or(""),
            "other",
            extra,
        ));
    }

    let mut running = prev_hash.to_string();
    for (step_index, llm) in turn.llm_calls.iter().enumerate() {
        let step_root = options
            .step_prefix
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(turn_id.as_str());
        let step_id = format!("{step_root}:s{}", step_index + 1);
        let step_span = random_hex(8);
        let llm_span = random_hex(8);
        let response_id = llm
            .api_response
            .as_ref()
            .and_then(|api| api.response_id.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| llm.assistant_uuid.clone().filter(|value| !value.is_empty()))
            .unwrap_or_else(|| format!("{step_id}:r"));
        let model = if llm.model.is_empty() {
            "unknown"
        } else {
            llm.model.as_str()
        };
        let provider = infer_provider(
            model,
            llm.api_response
                .as_ref()
                .and_then(|api| api.auth_type.as_deref()),
        );
        let delta = build_input_messages_delta(&llm.input_delta, &HashMap::new());
        let input_hash = compute_hash(&running, &delta);
        let mut request_extra = Obj::new();
        request_extra.insert("span_id".into(), Value::String(llm_span.clone()));
        request_extra.insert("parent_span_id".into(), Value::String(step_span.clone()));
        request_extra.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        request_extra.insert(
            "gen_ai.response.id".into(),
            Value::String(response_id.clone()),
        );
        request_extra.insert(
            "gen_ai.provider.name".into(),
            Value::String(provider.clone()),
        );
        request_extra.insert(
            "gen_ai.request.model".into(),
            Value::String(model.to_string()),
        );
        request_extra.insert(
            "gen_ai.input.messages_hash".into(),
            Value::String(input_hash.clone()),
        );
        if !delta.is_empty() {
            request_extra.insert("gen_ai.input.messages_delta".into(), Value::Array(delta));
        }
        let request_time = llm
            .request_start
            .as_deref()
            .filter(|value| !value.is_empty())
            .or(llm.timestamp.as_deref())
            .unwrap_or("");
        records.push(compose(&base, request_time, "llm.request", request_extra));
        running = input_hash;

        let usage = llm.usage_metadata.as_ref().and_then(Value::as_object);
        let api = llm.api_response.as_ref();
        let input = coalesce_field(
            usage,
            "promptTokenCount",
            api.and_then(|item| item.input_tokens.as_ref()),
            json!(0),
        );
        let output = coalesce_field(
            usage,
            "candidatesTokenCount",
            api.and_then(|item| item.output_tokens.as_ref()),
            json!(0),
        );
        let cache = coalesce_field(
            usage,
            "cachedContentTokenCount",
            api.and_then(|item| item.cached_tokens.as_ref()),
            json!(0),
        );
        let total = match usage.and_then(|map| map.get("totalTokenCount")) {
            Some(value) if !value.is_null() => value.clone(),
            _ => add_numbers(&input, &output),
        };
        let mut response_extra = Obj::new();
        response_extra.insert("span_id".into(), Value::String(llm_span));
        response_extra.insert("parent_span_id".into(), Value::String(step_span.clone()));
        response_extra.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        response_extra.insert("gen_ai.response.id".into(), Value::String(response_id));
        response_extra.insert("gen_ai.provider.name".into(), Value::String(provider));
        response_extra.insert(
            "gen_ai.request.model".into(),
            Value::String(model.to_string()),
        );
        response_extra.insert(
            "gen_ai.response.model".into(),
            Value::String(model.to_string()),
        );
        response_extra.insert(
            "gen_ai.response.finish_reasons".into(),
            json!([infer_assistant_finish_reason(&llm.assistant_record)]),
        );
        response_extra.insert("gen_ai.usage.input_tokens".into(), input);
        response_extra.insert("gen_ai.usage.output_tokens".into(), output);
        response_extra.insert("gen_ai.usage.cache_read.input_tokens".into(), cache);
        response_extra.insert("gen_ai.usage.total_tokens".into(), total);
        response_extra.insert(
            "gen_ai.output.messages".into(),
            Value::Array(build_output_messages(&llm.assistant_record)),
        );
        let mut response = compose(
            &base,
            llm.timestamp.as_deref().unwrap_or(""),
            "llm.response",
            response_extra,
        );
        if api.and_then(|item| item.event_name.as_deref()) == Some("qwen-code.api_error") {
            let error_type = api
                .and_then(|item| item.error_type.clone())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "ApiError".into());
            let error_message = truncate_chars(
                api.and_then(|item| item.error_message.as_deref())
                    .unwrap_or(""),
                500,
            );
            response.insert("error.type".into(), Value::String(error_type));
            response.insert("error.message".into(), Value::String(error_message));
            if let Some(code) = api.and_then(|item| item.status_code.clone()) {
                response.insert("http.status_code".into(), code);
            }
            response.insert("gen_ai.response.finish_reasons".into(), json!(["error"]));
        }
        if options.subagent {
            let input_metric = subagent_metric(usage, "promptTokenCount");
            let output_metric = subagent_metric(usage, "candidatesTokenCount");
            let cache_metric = subagent_metric(usage, "cachedContentTokenCount");
            let total_metric = subagent_total(usage);
            put_metric(&mut response, "gen_ai.usage.input_tokens", input_metric);
            put_metric(&mut response, "gen_ai.usage.output_tokens", output_metric);
            put_metric(
                &mut response,
                "gen_ai.usage.cache_read.input_tokens",
                cache_metric,
            );
            put_metric(&mut response, "gen_ai.usage.total_tokens", total_metric);
            response.remove("gen_ai.response.model");
            if model == "unknown" {
                response.remove("gen_ai.request.model");
                if let Some(request) = records.last_mut() {
                    request.remove("gen_ai.request.model");
                }
            }
        }
        records.push(response);

        for tool in &llm.declared_tools {
            let tool_span = random_hex(8);
            let call_for_event = tool
                .call_id
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("{step_id}:t{}", tool.part_index));
            let mut call_extra = Obj::new();
            call_extra.insert("span_id".into(), Value::String(tool_span.clone()));
            call_extra.insert("parent_span_id".into(), Value::String(step_span.clone()));
            call_extra.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
            call_extra.insert("gen_ai.tool.name".into(), Value::String(tool.name.clone()));
            call_extra.insert(
                "gen_ai.tool.call.id".into(),
                Value::String(call_for_event.clone()),
            );
            if !tool.args.is_null() {
                call_extra.insert("gen_ai.tool.call.arguments".into(), tool.args.clone());
            }
            let tool_time = tool
                .timestamp
                .as_deref()
                .filter(|value| !value.is_empty())
                .or(llm.timestamp.as_deref())
                .unwrap_or("");
            records.push(compose(&base, tool_time, "tool.call", call_extra));
            if let Some(result) = &tool.result {
                let mut result_extra = Obj::new();
                result_extra.insert("span_id".into(), Value::String(tool_span));
                result_extra.insert("parent_span_id".into(), Value::String(step_span.clone()));
                result_extra.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
                result_extra.insert("gen_ai.tool.name".into(), Value::String(tool.name.clone()));
                result_extra.insert("gen_ai.tool.call.id".into(), Value::String(call_for_event));
                if let Some(body) = &result.response {
                    result_extra.insert("gen_ai.tool.call.result".into(), body.clone());
                }
                result_extra.insert(
                    "tool.result.status".into(),
                    Value::String(result.status.clone()),
                );
                if options.subagent {
                    if let Some(duration) = result.duration_ms {
                        if duration.is_finite() && duration >= 0.0 {
                            result_extra
                                .insert("gen_ai.tool.call.duration".into(), json_number(duration));
                        }
                    }
                }
                if result.status == "error" {
                    let message = match &result.error {
                        Some(Value::String(text)) => truncate_chars(text, 500),
                        Some(other) => truncate_chars(&js_string(other), 500),
                        None => "tool execution failed".into(),
                    };
                    result_extra.insert("error.type".into(), json!("ToolError"));
                    result_extra.insert("error.message".into(), Value::String(message));
                }
                records.push(compose(
                    &base,
                    result.timestamp.as_deref().unwrap_or(""),
                    "tool.result",
                    result_extra,
                ));
            }
        }
    }

    records.sort_by_key(event_time);
    if !stop_reason.is_empty() && stop_reason != "end_turn" {
        if let Some(record) = records
            .iter_mut()
            .rev()
            .find(|record| record.get("event.name").and_then(Value::as_str) == Some("llm.response"))
        {
            record.insert(
                "gen_ai.response.finish_reasons".into(),
                json!([stop_reason]),
            );
        }
    }
    BuiltTurn {
        records,
        hash: running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    fn hello_message() -> Value {
        json!({"role": "user", "parts": [{"type": "text", "content": "hello"}]})
    }

    #[test]
    fn initial_hash_is_sha256_of_empty_prefix() {
        assert_eq!(INITIAL_HASH, &sha256_hex(b"")[..32]);
        assert_eq!(INITIAL_HASH, "e3b0c44298fc1c149afbf4c8996fb924");
    }

    #[test]
    fn hash_step_is_deterministic_and_order_independent() {
        let left = hash_step(INITIAL_HASH, &hello_message());
        let right = hash_step(INITIAL_HASH, &hello_message());
        assert_eq!(left, right);
        assert_eq!(left, "5c24e8d6e614ea10f1f504b9017596bc");
        assert_ne!(
            left,
            hash_step(
                INITIAL_HASH,
                &json!({"role": "user", "parts": [{"type": "text", "content": "bye"}]})
            )
        );
        let unsorted = json!({"b": 1, "a": {"z": true, "y": null}});
        let sorted = json!({"a": {"y": null, "z": true}, "b": 1});
        assert_eq!(
            hash_step(INITIAL_HASH, &unsorted),
            hash_step(INITIAL_HASH, &sorted)
        );
    }

    #[test]
    fn compute_hash_chains_messages_like_javascript() {
        let second = json!({
            "role": "assistant",
            "parts": [{
                "type": "tool_call",
                "id": null,
                "name": "Bash",
                "arguments": {"cmd": "ls"}
            }]
        });
        let messages = vec![hello_message(), second];
        let stepped = hash_step(&hash_step(INITIAL_HASH, &messages[0]), &messages[1]);
        assert_eq!(compute_hash(INITIAL_HASH, &messages), stepped);
        assert_eq!(stepped, "72e50ec5323de1b5188891ac4ad307c9");
        assert_eq!(compute_hash(INITIAL_HASH, &[]), INITIAL_HASH);
    }

    #[test]
    fn turn_request_hash_chains_across_llm_steps() {
        let user = json!({
            "type": "user",
            "uuid": "u1",
            "timestamp": "2026-06-17T08:00:00.000Z",
            "message": {"role": "user", "parts": [{"text": "hello"}]}
        });
        let assistant = json!({
            "type": "assistant",
            "uuid": "a1",
            "timestamp": "2026-06-17T08:00:10.000Z",
            "message": {"role": "model", "parts": [{"functionCall": {"id": "c1", "name": "Bash", "args": {"cmd": "ls"}}}]}
        });
        let tool = json!({
            "type": "tool_result",
            "uuid": "tr1",
            "timestamp": "2026-06-17T08:00:13.000Z",
            "message": {"parts": [{"functionResponse": {"name": "Bash", "response": "ok"}}]},
            "toolCallResult": {"callId": "c1"}
        });
        let turn = Turn {
            prompt: "hello".into(),
            prompt_timestamp: Some("2026-06-17T08:00:00.000Z".into()),
            git_branch: None,
            positional_fallbacks: 0,
            llm_calls: vec![
                text_call(
                    "a1",
                    "2026-06-17T08:00:00.000Z",
                    "2026-06-17T08:00:10.000Z",
                    vec![user],
                    "qwen3.6-plus",
                ),
                text_call(
                    "a2",
                    "2026-06-17T08:00:13.000Z",
                    "2026-06-17T08:00:15.000Z",
                    vec![assistant, tool],
                    "qwen3.6-plus",
                ),
            ],
        };
        let built = build_turn_records(
            &turn,
            &RecordContext {
                turn_index: 0,
                session_id: "sess-1",
                user_id: "u-1",
                cwd: Some("/work"),
                resources: &Obj::new(),
                spans: &Obj::new(),
            },
            INITIAL_HASH,
            "end_turn",
            &TurnOptions::parent(),
        );
        let requests: Vec<&Obj> = built
            .records
            .iter()
            .filter(|record| {
                record.get("event.name").and_then(Value::as_str) == Some("llm.request")
            })
            .collect();
        assert_eq!(requests.len(), 2);
        let first = requests[0]
            .get("gen_ai.input.messages_hash")
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(first, "5c24e8d6e614ea10f1f504b9017596bc");
        let second_delta = requests[1]
            .get("gen_ai.input.messages_delta")
            .and_then(Value::as_array)
            .unwrap();
        let second = requests[1]
            .get("gen_ai.input.messages_hash")
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(second, compute_hash(first, second_delta));
        assert_eq!(built.hash, second);
        assert_ne!(second, compute_hash(INITIAL_HASH, second_delta));
        let traces: HashSet<&str> = built
            .records
            .iter()
            .filter_map(|record| record.get("trace_id").and_then(Value::as_str))
            .collect();
        assert_eq!(traces.len(), 1);
        assert!(traces.iter().all(|trace| trace.len() == 32));
    }

    #[test]
    fn empty_delta_keeps_previous_hash() {
        let turn = Turn {
            prompt: String::new(),
            prompt_timestamp: None,
            git_branch: None,
            positional_fallbacks: 0,
            llm_calls: vec![text_call(
                "a1",
                "2026-06-17T08:00:00.000Z",
                "2026-06-17T08:00:10.000Z",
                Vec::new(),
                "qwen3.6-plus",
            )],
        };
        let built = build_turn_records(
            &turn,
            &RecordContext {
                turn_index: 2,
                session_id: "sess-1",
                user_id: "u-1",
                cwd: None,
                resources: &Obj::new(),
                spans: &Obj::new(),
            },
            INITIAL_HASH,
            "content_filter",
            &TurnOptions::parent(),
        );
        let request = built
            .records
            .iter()
            .find(|record| record.get("event.name").and_then(Value::as_str) == Some("llm.request"))
            .unwrap();
        assert!(request.get("gen_ai.input.messages_delta").is_none());
        assert_eq!(
            request
                .get("gen_ai.input.messages_hash")
                .and_then(Value::as_str),
            Some(INITIAL_HASH)
        );
        assert_eq!(
            built.records[0]
                .get("gen_ai.turn.id")
                .and_then(Value::as_str),
            Some("sess-1:t3")
        );
        let response = built
            .records
            .iter()
            .find(|record| record.get("event.name").and_then(Value::as_str) == Some("llm.response"))
            .unwrap();
        assert_eq!(
            response.get("gen_ai.response.finish_reasons"),
            Some(&json!(["content_filter"]))
        );
        assert_eq!(
            response.get("gen_ai.provider.name").and_then(Value::as_str),
            Some("qwen")
        );
    }

    #[test]
    fn provider_inference_prefers_model_over_auth() {
        let cases = [
            ("qwen3.6-plus", None, "qwen"),
            ("tongyi-qwen-plus", None, "qwen"),
            ("claude-3-5-sonnet-20241022", None, "anthropic"),
            ("gpt-4o", None, "openai"),
            ("o1-preview", None, "openai"),
            ("o3-mini", None, "openai"),
            ("codex-mini", None, "openai"),
            ("gemini-1.5-pro", None, "gcp.gemini"),
            ("deepseek-r1", None, "deepseek"),
            ("grok-2-latest", None, "x_ai"),
            ("QWEN-MAX", None, "qwen"),
            ("", Some("openai"), "openai"),
            ("", Some("anthropic"), "anthropic"),
            ("", Some("gemini"), "gcp.gemini"),
            ("qwen3.6-plus", Some("openai"), "qwen"),
            ("weird-model-xyz", Some("some-auth"), "qwen"),
            ("", None, "qwen"),
        ];
        for (model, auth, expected) in cases {
            assert_eq!(infer_provider(model, auth), expected, "{model} {auth:?}");
        }
    }

    fn text_call(
        uuid: &str,
        request_start: &str,
        timestamp: &str,
        delta: Vec<Value>,
        model: &str,
    ) -> LlmCall {
        let assistant = json!({
            "type": "assistant",
            "uuid": uuid,
            "timestamp": timestamp,
            "model": model,
            "message": {"role": "model", "parts": [{"text": "done"}]},
            "usageMetadata": {
                "promptTokenCount": 100,
                "candidatesTokenCount": 20,
                "cachedContentTokenCount": 0,
                "totalTokenCount": 120
            }
        });
        LlmCall {
            assistant_uuid: Some(uuid.into()),
            timestamp: Some(timestamp.into()),
            request_start: Some(request_start.into()),
            model: model.into(),
            usage_metadata: assistant.get("usageMetadata").cloned(),
            assistant_record: assistant,
            api_response: None,
            declared_tools: Vec::new(),
            input_delta: delta,
        }
    }

    fn user_rec(uuid: &str, text: &str, timestamp: &str) -> Value {
        json!({
            "uuid": uuid,
            "sessionId": "sess-1",
            "timestamp": timestamp,
            "type": "user",
            "message": {"role": "user", "parts": [{"text": text}]}
        })
    }

    fn assistant_rec(uuid: &str, parts: Value, timestamp: &str) -> Value {
        json!({
            "uuid": uuid,
            "sessionId": "sess-1",
            "timestamp": timestamp,
            "type": "assistant",
            "model": "qwen3.6-plus",
            "message": {"role": "model", "parts": parts},
            "usageMetadata": {
                "promptTokenCount": 100,
                "candidatesTokenCount": 20,
                "totalTokenCount": 120,
                "cachedContentTokenCount": 0
            }
        })
    }

    fn tool_rec(uuid: &str, call_id: &str, response: Value, timestamp: &str) -> Value {
        json!({
            "uuid": uuid,
            "sessionId": "sess-1",
            "timestamp": timestamp,
            "type": "tool_result",
            "message": {"role": "user", "parts": [{"functionResponse": {"name": "Bash", "response": response}}]},
            "toolCallResult": {"callId": call_id, "status": "success"}
        })
    }

    fn write_jsonl(path: &Path, records: &[Value]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut body = String::new();
        for record in records {
            body.push_str(&serde_json::to_string(record).unwrap());
            body.push('\n');
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn split_turns_keeps_mid_turn_user_inside_the_turn() {
        let mid = json!({
            "uuid": "u1b",
            "type": "user",
            "subtype": "mid_turn_user_message",
            "message": {"parts": [{"text": "extra"}]}
        });
        let records = vec![
            user_rec("u1", "q1", "2026-06-17T08:00:00.000Z"),
            mid,
            assistant_rec("a1", json!([{"text": "a1"}]), "2026-06-17T08:00:10.000Z"),
        ];
        let turns = split_into_turns(&records);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].records.len(), 2);
        let dropped = split_into_turns(&[
            assistant_rec("orphan", json!([{"text": "x"}]), "2026-06-17T08:00:00.000Z"),
            user_rec("u1", "q1", "2026-06-17T08:00:01.000Z"),
            assistant_rec("a1", json!([{"text": "a1"}]), "2026-06-17T08:00:02.000Z"),
        ]);
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].records.len(), 1);
        assert_eq!(
            dropped[0].records[0].get("uuid").and_then(Value::as_str),
            Some("a1")
        );
    }

    #[test]
    fn transcript_parser_pairs_tools_offsets_and_api_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t.jsonl");
        write_jsonl(
            &file,
            &[
                user_rec("u1", "do it", "2026-06-17T08:00:00.000Z"),
                assistant_rec(
                    "a1",
                    json!([{"functionCall": {"name": "Bash", "args": {"cmd": "ls"}, "id": "call_1"}}]),
                    "2026-06-17T08:00:10.000Z",
                ),
                tool_rec(
                    "tr1",
                    "call_1",
                    json!({"stdout": "file1"}),
                    "2026-06-17T08:00:12.000Z",
                ),
                assistant_rec("a2", json!([{"text": "done"}]), "2026-06-17T08:00:15.000Z"),
            ],
        );
        let parsed = parse_qwen_transcript(&file, 0, Some("sess-1")).unwrap();
        assert_eq!(parsed.next_offset, fs::metadata(&file).unwrap().len());
        assert_eq!(parsed.turns.len(), 1);
        assert_eq!(parsed.turns[0].prompt, "do it");
        assert_eq!(parsed.turns[0].llm_calls.len(), 2);
        let step = &parsed.turns[0].llm_calls[0];
        assert_eq!(step.declared_tools[0].call_id.as_deref(), Some("call_1"));
        assert_eq!(step.declared_tools[0].name, "Bash");
        assert_eq!(
            step.declared_tools[0].result.as_ref().unwrap().response,
            Some(json!({"stdout": "file1"}))
        );
        assert_eq!(
            step.declared_tools[0].result.as_ref().unwrap().status,
            "success"
        );
        assert!(parsed.turns[0].llm_calls[1].declared_tools.is_empty());
        assert_eq!(
            step.input_delta[0].get("type").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            parsed.turns[0].llm_calls[1]
                .input_delta
                .iter()
                .filter_map(|record| record.get("type").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["assistant", "tool_result"]
        );
        assert_eq!(
            step.request_start.as_deref(),
            Some("2026-06-17T08:00:00.000Z")
        );
        assert_eq!(
            parsed.turns[0].llm_calls[1].request_start.as_deref(),
            Some("2026-06-17T08:00:12.000Z")
        );
        let again = parse_qwen_transcript(&file, parsed.next_offset, Some("sess-1")).unwrap();
        assert!(again.turns.is_empty());
        assert_eq!(again.next_offset, parsed.next_offset);
        let missing =
            parse_qwen_transcript(Path::new("/nonexistent/path.jsonl"), 0, Some("sess-1")).unwrap();
        assert!(missing.turns.is_empty());
        let ahead = parse_qwen_transcript(&file, 99_999, Some("sess-1")).unwrap();
        assert!(ahead.turns.is_empty());
        assert_eq!(ahead.next_offset, 99_999);
    }

    #[test]
    fn transcript_parser_matches_parallel_calls_and_filters_foreign_api() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t.jsonl");
        let mut side = assistant_rec(
            "a-side",
            json!([{"text": "sub"}]),
            "2026-06-17T08:00:09.000Z",
        );
        side["isSidechain"] = json!(true);
        side["agentId"] = json!("sub-1");
        write_jsonl(
            &file,
            &[
                user_rec("u1", "run 3", "2026-06-17T08:00:00.000Z"),
                side,
                json!({
                    "uuid": "api-sub",
                    "type": "system",
                    "subtype": "ui_telemetry",
                    "timestamp": "2026-06-17T08:00:09.000Z",
                    "systemPayload": {"uiEvent": {
                        "event.name": "qwen-code.api_response",
                        "prompt_id": "subagent-xxx#0",
                        "response_id": "foreign",
                        "duration_ms": 1
                    }}
                }),
                json!({
                    "uuid": "api1",
                    "type": "system",
                    "subtype": "ui_telemetry",
                    "timestamp": "2026-06-17T08:00:09.500Z",
                    "systemPayload": {"uiEvent": {
                        "event.name": "qwen-code.api_response",
                        "prompt_id": "sess-1########0",
                        "response_id": "resp_api1",
                        "duration_ms": 9000,
                        "input_token_count": 100,
                        "output_token_count": 10,
                        "auth_type": "openai"
                    }}
                }),
                assistant_rec(
                    "a1",
                    json!([
                        {"functionCall": {"name": "Bash", "args": {"cmd": "ls"}, "id": "c1"}},
                        {"functionCall": {"name": "Bash", "args": {"cmd": "pwd"}, "id": "c2"}},
                        {"functionCall": {"name": "Bash", "args": {"cmd": "date"}, "id": "c3"}}
                    ]),
                    "2026-06-17T08:00:10.000Z",
                ),
                tool_rec("tr2", "c2", json!("pwd-out"), "2026-06-17T08:00:13.000Z"),
                tool_rec("tr1", "c1", json!("ls-out"), "2026-06-17T08:00:14.000Z"),
                tool_rec("tr3", "c3", json!("date-out"), "2026-06-17T08:00:15.000Z"),
            ],
        );
        let parsed = parse_qwen_transcript(&file, 0, Some("sess-1")).unwrap();
        let tools = &parsed.turns[0].llm_calls[0].declared_tools;
        assert_eq!(tools.len(), 3);
        assert_eq!(
            tools[0].result.as_ref().unwrap().response,
            Some(json!("ls-out"))
        );
        assert_eq!(
            tools[1].result.as_ref().unwrap().response,
            Some(json!("pwd-out"))
        );
        assert_eq!(
            tools[2].result.as_ref().unwrap().response,
            Some(json!("date-out"))
        );
        assert_eq!(
            parsed.turns[0].llm_calls[0]
                .api_response
                .as_ref()
                .and_then(|api| api.response_id.as_deref()),
            Some("resp_api1")
        );
        assert_eq!(
            parsed.turns[0].llm_calls[0]
                .api_response
                .as_ref()
                .and_then(|api| api.duration_ms),
            Some(9000.0)
        );
        assert_eq!(
            parsed.turns[0].llm_calls[0].assistant_uuid.as_deref(),
            Some("a1")
        );
    }

    #[test]
    fn positional_fallback_counts_unmatched_tools_and_strict_mode_does_not() {
        let mut calls = vec![LlmCall {
            assistant_uuid: None,
            timestamp: None,
            request_start: None,
            model: "unknown".into(),
            usage_metadata: None,
            assistant_record: json!({}),
            api_response: None,
            declared_tools: vec![
                DeclaredTool {
                    call_id: Some("good".into()),
                    native_call_id: None,
                    name: "A".into(),
                    args: json!({}),
                    part_index: 0,
                    result: None,
                    timestamp: None,
                },
                DeclaredTool {
                    call_id: None,
                    native_call_id: None,
                    name: "B".into(),
                    args: json!({}),
                    part_index: 1,
                    result: None,
                    timestamp: None,
                },
            ],
            input_delta: Vec::new(),
        }];
        let records = vec![
            tool_rec(
                "tr-unmatched",
                "orphan",
                json!("or"),
                "2026-06-17T08:00:11.000Z",
            ),
            tool_rec("tr-good", "good", json!("gr"), "2026-06-17T08:00:12.000Z"),
        ];
        let used = pair_tool_calls_with_results(&mut calls, &records, false);
        assert_eq!(
            calls[0].declared_tools[0].result.as_ref().unwrap().response,
            Some(json!("gr"))
        );
        assert_eq!(
            calls[0].declared_tools[1].result.as_ref().unwrap().response,
            Some(json!("or"))
        );
        assert_eq!(
            calls[0].declared_tools[1].call_id.as_deref(),
            Some("orphan")
        );
        assert_eq!(used, 1);
        let mut strict = calls;
        strict[0].declared_tools[1].result = None;
        strict[0].declared_tools[1].call_id = None;
        assert_eq!(pair_tool_calls_with_results(&mut strict, &records, true), 0);
        assert!(strict[0].declared_tools[1].result.is_none());
    }

    #[test]
    fn real_fixture_parses_one_turn_two_steps_and_three_tools() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/unit/hooks/qwen-code-cli/fixtures/real-multi-step-tool-calls.jsonl");
        let parsed =
            parse_qwen_transcript(&path, 0, Some("3821eeeb-f45b-4a91-b921-6949b9893e88")).unwrap();
        assert_eq!(parsed.turns.len(), 1);
        let turn = &parsed.turns[0];
        assert!(turn.prompt.contains("subagent"));
        assert_eq!(turn.llm_calls.len(), 2);
        let step = &turn.llm_calls[0];
        assert_eq!(step.declared_tools.len(), 3);
        assert!(step.declared_tools.iter().all(|tool| tool.name == "agent"));
        assert!(step
            .declared_tools
            .iter()
            .all(|tool| tool.call_id.is_some()));
        assert!(step.declared_tools.iter().all(|tool| tool
            .result
            .as_ref()
            .is_some_and(|result| result.status == "success")));
        assert_eq!(
            step.usage_metadata
                .as_ref()
                .and_then(|usage| usage.get("promptTokenCount"))
                .and_then(Value::as_i64),
            Some(14484)
        );
        assert_eq!(
            step.usage_metadata
                .as_ref()
                .and_then(|usage| usage.get("candidatesTokenCount"))
                .and_then(Value::as_i64),
            Some(287)
        );
        assert_eq!(
            step.api_response.as_ref().and_then(|api| api.duration_ms),
            Some(6983.0)
        );
        assert!(turn.llm_calls[1].declared_tools.is_empty());
        let parts = step
            .assistant_record
            .pointer("/message/parts")
            .and_then(Value::as_array)
            .unwrap();
        assert!(parts.iter().any(|part| {
            part.get("thought") == Some(&Value::Bool(true))
                && part.get("text").and_then(Value::as_str).is_some()
        }));
        assert!(parts.iter().any(|part| {
            part.get("text").and_then(Value::as_str).is_some()
                && part.get("thought") != Some(&Value::Bool(true))
        }));
    }

    fn ts(seconds: f64) -> String {
        let base = chrono::DateTime::parse_from_rfc3339("2026-09-22T04:00:00.000Z").unwrap();
        let millis = (seconds * 1000.0).round() as i64;
        (base + chrono::Duration::milliseconds(millis))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        data: std::path::PathBuf,
        project: std::path::PathBuf,
        transcript: std::path::PathBuf,
        children: std::path::PathBuf,
        session_id: String,
        seq: i64,
        main: Vec<Value>,
        child: Vec<Value>,
        grandchild: Vec<Value>,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let session_id = "synthetic-session".to_string();
            let project = dir.path().join("project");
            let transcript = project.join("chats").join(format!("{session_id}.jsonl"));
            let children = project.join("subagents").join(&session_id);
            let data = dir.path().join("pilot");
            fs::create_dir_all(transcript.parent().unwrap()).unwrap();
            fs::create_dir_all(&children).unwrap();
            fs::create_dir_all(&data).unwrap();
            let mut fixture = Self {
                _dir: dir,
                data,
                project,
                transcript,
                children,
                session_id,
                seq: 0,
                main: Vec::new(),
                child: Vec::new(),
                grandchild: Vec::new(),
            };
            let user = fixture.user(0.0, "SENSITIVE_MAIN");
            let mut call = fixture.call(1.0, "root-call");
            call["model"] = json!("qwen3-test");
            call["usageMetadata"] = json!({
                "promptTokenCount": 30,
                "candidatesTokenCount": 3,
                "totalTokenCount": 33
            });
            let result = fixture.result(10.0, "root-call");
            let mut round = fixture.round(11.0, "Main finished", 20);
            round["model"] = json!("qwen3-test");
            fixture.main = vec![user, call, result, round];
            fixture.child = vec![
                fixture.user(2.0, "SENSITIVE_CHILD"),
                fixture.round(3.0, "Plan", 10),
                fixture.call(3.1, "nested-call"),
                fixture.result(8.0, "nested-call"),
                fixture.round(9.0, "Child finished", 12),
            ];
            fixture.grandchild = vec![
                fixture.user(4.0, "SENSITIVE_GRANDCHILD"),
                fixture.round(5.0, "Grandchild finished", 5),
            ];
            write_jsonl(&fixture.transcript, &fixture.main);
            fixture.write_child(
                "child",
                None,
                "root-call",
                &fixture.child.clone(),
                json!({}),
            );
            fixture.write_child(
                "grandchild",
                Some("child"),
                "nested-call",
                &fixture.grandchild.clone(),
                json!({}),
            );
            fixture
        }

        fn record(&mut self, typ: &str, time: f64, parts: Value, extra: Value) -> Value {
            self.seq += 1;
            let mut value = json!({
                "type": typ,
                "uuid": format!("record-{}", self.seq),
                "sessionId": self.session_id,
                "timestamp": ts(time),
                "message": {
                    "role": if typ == "assistant" { "model" } else { "user" },
                    "parts": parts,
                }
            });
            if let (Some(obj), Value::Object(extra)) = (value.as_object_mut(), extra) {
                for (key, item) in extra {
                    obj.insert(key, item);
                }
            }
            value
        }

        fn user(&mut self, time: f64, text: &str) -> Value {
            self.record("user", time, json!([{"text": text}]), json!({}))
        }

        fn round(&mut self, time: f64, text: &str, tokens: i64) -> Value {
            self.record(
                "assistant",
                time,
                json!([{"text": text}]),
                json!({
                    "agentRunId": "run-1",
                    "agentRound": time,
                    "usageMetadata": {
                        "promptTokenCount": tokens,
                        "candidatesTokenCount": 2,
                        "totalTokenCount": tokens + 2
                    }
                }),
            )
        }

        fn call(&mut self, time: f64, id: &str) -> Value {
            self.record(
                "assistant",
                time,
                json!([{"functionCall": {"id": id, "name": "agent", "args": {"prompt": "SENSITIVE_TASK"}}}]),
                json!({}),
            )
        }

        fn result(&mut self, time: f64, id: &str) -> Value {
            self.record(
                "tool_result",
                time,
                json!([{"functionResponse": {"id": id, "name": "agent", "response": {"output": "SENSITIVE_RESULT"}}}]),
                json!({"toolCallResult": {"callId": id, "durationMs": 100}}),
            )
        }

        fn write_child(
            &self,
            id: &str,
            parent: Option<&str>,
            tool: &str,
            rows: &[Value],
            overrides: Value,
        ) {
            let mut meta = json!({
                "agentId": id,
                "agentType": id,
                "parentSessionId": self.session_id,
                "parentAgentId": parent,
                "toolUseId": tool,
                "isBackgrounded": false,
                "status": "completed",
                "persistedCliFlags": {"model": "qwen3-test"}
            });
            if let (Some(obj), Value::Object(extra)) = (meta.as_object_mut(), overrides) {
                for (key, value) in extra {
                    obj.insert(key, value);
                }
            }
            fs::write(
                self.children.join(format!("agent-{id}.meta.json")),
                serde_json::to_string(&meta).unwrap(),
            )
            .unwrap();
            let tagged: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let mut copy = row.clone();
                    copy["agentId"] = json!(id);
                    copy["isSidechain"] = json!(true);
                    copy
                })
                .collect();
            write_jsonl(&self.children.join(format!("agent-{id}.jsonl")), &tagged);
        }

        fn run(&self, extra: &[(&str, &str)]) -> Vec<Value> {
            let (code, stdout) = invoke(
                &self.data,
                "stop",
                &json!({
                    "session_id": self.session_id,
                    "transcript_path": self.transcript,
                    "cwd": self.project,
                }),
                extra,
            );
            assert_eq!(code, 0, "{stdout}");
            assert_eq!(stdout.trim(), "{}");
            read_records(&self.data)
        }
    }

    fn invoke(root: &Path, sub: &str, payload: &Value, extra: &[(&str, &str)]) -> (i32, String) {
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        for (key, value) in extra {
            env.insert((*key).to_string(), (*value).to_string());
        }
        let stdin = serde_json::to_vec(payload).unwrap();
        let args = vec![sub.to_string()];
        let mut stdout = Vec::new();
        let mut request = super::super::common::HookRequest {
            args: &args,
            stdin: &stdin,
            env: &env,
            stdout: &mut stdout,
        };
        let code = super::run(&mut request);
        (code, String::from_utf8(stdout).unwrap())
    }

    fn read_records(root: &Path) -> Vec<Value> {
        let dir = root.join("logs").join("qwen-code-cli");
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut paths: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .collect();
        paths.sort();
        let mut records = Vec::new();
        for path in paths {
            for line in fs::read_to_string(path).unwrap_or_default().lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    if !line.trim().is_empty() {
                        records.push(value);
                    }
                }
            }
        }
        records
    }

    fn children(records: &[Value]) -> Vec<&Value> {
        records
            .iter()
            .filter(|record| {
                record.get("gen_ai.agent.scope").and_then(Value::as_str) == Some("subagent")
            })
            .collect()
    }

    fn llms<'a>(records: impl IntoIterator<Item = &'a Value>) -> Vec<&'a Value> {
        records
            .into_iter()
            .filter(|record| {
                record.get("event.name").and_then(Value::as_str) == Some("llm.response")
            })
            .collect()
    }

    fn status(records: &[Value]) -> String {
        records
            .iter()
            .find(|record| {
                record.get("event.name").and_then(Value::as_str) == Some("tool.call")
                    && record.get("gen_ai.tool.call.id").and_then(Value::as_str)
                        == Some("root-call")
            })
            .and_then(|record| {
                record
                    .get("agent.qwen-code-cli.subagent.collection")
                    .and_then(Value::as_str)
            })
            .unwrap_or("")
            .to_string()
    }

    #[test]
    fn subagent_hooks_acknowledge_without_touching_state() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state/qwen-code-cli/sessions");
        fs::create_dir_all(&state_dir).unwrap();
        let state_file = state_dir.join("sess-sa-1.json");
        let existing = r#"{"transcript_offset":12345,"turn_count":2}"#;
        fs::write(&state_file, existing).unwrap();
        for command in ["subagent-start", "subagent-stop"] {
            let (code, stdout) = invoke(
                dir.path(),
                command,
                &json!({"session_id": "sess-sa-1", "agent_id": "child"}),
                &[],
            );
            assert_eq!(code, 0);
            assert_eq!(stdout, "{}\n");
            assert_eq!(fs::read_to_string(&state_file).unwrap(), existing);
        }
        assert!(read_records(dir.path()).is_empty());
    }

    #[test]
    fn foreground_subagents_share_the_root_trace() {
        let fixture = Fixture::new();
        let records = fixture.run(&[]);
        let traces: HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("trace_id").and_then(Value::as_str))
            .collect();
        let turns: HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("gen_ai.turn.id").and_then(Value::as_str))
            .collect();
        assert_eq!(traces.len(), 1);
        assert_eq!(turns.len(), 1);
        let child_llms = llms(children(&records));
        assert_eq!(child_llms.len(), 3);
        let mut tokens: Vec<i64> = child_llms
            .iter()
            .map(|record| record["gen_ai.usage.input_tokens"].as_i64().unwrap())
            .collect();
        tokens.sort();
        assert_eq!(tokens, vec![5, 10, 12]);
        let depths: HashSet<i64> = children(&records)
            .iter()
            .map(|record| record["gen_ai.agent.depth"].as_i64().unwrap())
            .collect();
        assert_eq!(depths, HashSet::from([1, 2]));
        assert_eq!(status(&records), "collected");
        let child_tool = records
            .iter()
            .find(|record| {
                record["gen_ai.agent.id"] == "child" && record["event.name"] == "tool.call"
            })
            .unwrap();
        let grandchild = records
            .iter()
            .find(|record| record["gen_ai.agent.id"] == "grandchild")
            .unwrap();
        assert_eq!(
            grandchild["gen_ai.subagent.parent_tool_call.id"],
            child_tool["gen_ai.tool.call.id"]
        );
        let last = records.last().unwrap();
        assert_eq!(last["gen_ai.turn.end"], true);
        assert!(last.get("gen_ai.agent.scope").is_none());
    }

    #[test]
    fn second_stop_does_not_replay_children() {
        let fixture = Fixture::new();
        let first = fixture.run(&[]);
        assert_eq!(fixture.run(&[]), first);
    }

    #[test]
    fn later_main_turn_does_not_replay_historic_children() {
        let mut fixture = Fixture::new();
        fixture.run(&[]);
        let extra = vec![
            fixture.user(20.0, "New request"),
            fixture.round(21.0, "New answer", 10),
        ];
        let mut body = fs::read_to_string(&fixture.transcript).unwrap();
        for record in extra {
            body.push_str(&serde_json::to_string(&record).unwrap());
            body.push('\n');
        }
        fs::write(&fixture.transcript, body).unwrap();
        let records = fixture.run(&[]);
        assert_eq!(llms(children(&records)).len(), 3);
        let turns: HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("gen_ai.turn.id").and_then(Value::as_str))
            .collect();
        assert_eq!(turns.len(), 2);
    }

    #[test]
    fn background_execution_is_not_collected() {
        let fixture = Fixture::new();
        fixture.write_child(
            "child",
            None,
            "root-call",
            &fixture.child,
            json!({"isBackgrounded": true}),
        );
        let records = fixture.run(&[]);
        assert_eq!(status(&records), "unsupported_background");
        assert!(children(&records).is_empty());
    }

    #[test]
    fn failed_and_cancelled_children_keep_their_status() {
        for lifecycle in ["failed", "cancelled"] {
            let fixture = Fixture::new();
            fixture.write_child(
                "child",
                None,
                "root-call",
                &fixture.child,
                json!({"status": lifecycle}),
            );
            let records = fixture.run(&[]);
            let child = children(&records)
                .into_iter()
                .find(|record| record["gen_ai.agent.id"] == "child")
                .unwrap();
            assert_eq!(
                child["agent.qwen-code-cli.subagent.status"].as_str(),
                Some(lifecycle)
            );
            assert!(records
                .last()
                .unwrap()
                .get("agent.qwen-code-cli.subagent.status")
                .is_none());
        }
    }

    #[test]
    fn running_metadata_is_incomplete() {
        let fixture = Fixture::new();
        fixture.write_child(
            "child",
            None,
            "root-call",
            &fixture.child,
            json!({"status": "running"}),
        );
        let records = fixture.run(&[]);
        assert_eq!(status(&records), "incomplete");
        assert!(children(&records).is_empty());
    }

    #[test]
    fn missing_metadata_is_not_invented() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.children.join("agent-child.meta.json")).unwrap();
        let records = fixture.run(&[]);
        assert_eq!(status(&records), "metadata_missing");
        assert!(children(&records).is_empty());
    }

    #[test]
    fn two_agents_for_one_parent_tool_are_ambiguous() {
        let fixture = Fixture::new();
        fixture.write_child("other", None, "root-call", &fixture.child, json!({}));
        let records = fixture.run(&[]);
        assert_eq!(status(&records), "ambiguous_parent");
        assert!(children(&records).is_empty());
    }

    #[test]
    fn partial_child_file_is_incomplete() {
        let fixture = Fixture::new();
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(fixture.children.join("agent-child.jsonl"))
            .unwrap();
        file.write_all(br#"{"type":"#).unwrap();
        let records = fixture.run(&[]);
        assert_eq!(status(&records), "incomplete");
        assert!(children(&records).is_empty());
    }

    #[test]
    fn missing_child_transcript_keeps_parent_llms() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.children.join("agent-child.jsonl")).unwrap();
        let records = fixture.run(&[]);
        assert_eq!(status(&records), "transcript_unavailable");
        assert_eq!(llms(records.iter()).len(), 2);
    }

    #[test]
    fn unknown_child_usage_is_absent() {
        let fixture = Fixture::new();
        let mut child = fixture.child.clone();
        child[1].as_object_mut().unwrap().remove("usageMetadata");
        fixture.write_child("child", None, "root-call", &child, json!({}));
        let records = fixture.run(&[]);
        let response = llms(records.iter())
            .into_iter()
            .find(|record| record["gen_ai.agent.id"] == "child")
            .unwrap();
        assert!(response.get("gen_ai.usage.input_tokens").is_none());
        assert!(response.get("gen_ai.usage.total_tokens").is_none());
        assert!(response.get("gen_ai.response.model").is_none());
    }

    #[test]
    fn legacy_content_off_config_still_keeps_payloads() {
        let fixture = Fixture::new();
        fs::write(
            fixture.data.join("config.json"),
            r#"{"agents":{"qwen-code-cli":{"captureMessageContent":false}}}"#,
        )
        .unwrap();
        let records = fixture.run(&[]);
        assert!(!children(&records).is_empty());
        assert!(serde_json::to_string(&records)
            .unwrap()
            .contains("SENSITIVE"));
        for record in children(&records) {
            match record.get("event.name").and_then(Value::as_str) {
                Some("llm.request") => assert!(record.get("gen_ai.input.messages_delta").is_some()),
                Some("llm.response") => assert!(record.get("gen_ai.output.messages").is_some()),
                Some("tool.call") => assert!(record.get("gen_ai.tool.call.arguments").is_some()),
                Some("tool.result") => assert!(record.get("gen_ai.tool.call.result").is_some()),
                _ => {}
            }
        }
    }

    #[test]
    fn children_inherit_invocation_attributes_and_keep_identity() {
        let fixture = Fixture::new();
        let records = fixture.run(&[
            ("AGENTTEAMS_WORKER_NAME", "parent-worker"),
            ("AGENTTEAMS_INSTANCE_ID", "test-instance"),
            (
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "multica.issue.id=test-issue",
            ),
        ]);
        for record in children(&records) {
            assert_eq!(
                record["resourceAttributes"]["agentteams.instance.id"],
                "test-instance"
            );
            assert_eq!(record["multica.issue.id"], "test-issue");
            let name = record["gen_ai.agent.name"].as_str().unwrap();
            assert!(name == "child" || name == "grandchild", "{name}");
        }
        assert_eq!(
            records.last().unwrap()["gen_ai.agent.name"],
            "parent-worker"
        );
    }

    #[test]
    fn mismatched_child_identity_is_unavailable() {
        let fixture = Fixture::new();
        let path = fixture.children.join("agent-child.jsonl");
        let text = fs::read_to_string(&path)
            .unwrap()
            .replace("\"agentId\":\"child\"", "\"agentId\":\"wrong\"");
        fs::write(path, text).unwrap();
        let records = fixture.run(&[]);
        assert_eq!(status(&records), "transcript_unavailable");
        assert!(children(&records).is_empty());
    }

    #[test]
    fn resumed_child_run_outside_the_window_is_ignored() {
        let mut fixture = Fixture::new();
        let later_user = fixture.user(50.0, "Later request");
        let later_round = fixture.round(51.0, "Later response", 999);
        let mut rows = fixture.grandchild.clone();
        rows.push(later_user);
        rows.push(later_round);
        fixture.write_child("grandchild", Some("child"), "nested-call", &rows, json!({}));
        let ran = fixture.run(&[]);
        let responses = llms(children(&ran));
        assert_eq!(responses.len(), 3);
        assert!(responses
            .iter()
            .all(|record| record["gen_ai.usage.input_tokens"].as_i64() != Some(999)));
    }

    #[test]
    fn partial_main_tail_keeps_the_checkpoint() {
        let fixture = Fixture::new();
        let original = fs::read(&fixture.transcript).unwrap();
        fs::write(&fixture.transcript, &original[..original.len() - 8]).unwrap();
        assert!(fixture.run(&[]).is_empty());
        let state: Value = serde_json::from_str(
            &fs::read_to_string(
                fixture
                    .data
                    .join("state/qwen-code-cli/sessions")
                    .join(format!("{}.json", fixture.session_id)),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(state["transcript_offset"], 0);
        fs::write(&fixture.transcript, original).unwrap();
        assert_eq!(llms(children(&fixture.run(&[]))).len(), 3);
    }

    #[test]
    fn scoped_tool_ids_do_not_collide_across_runs() {
        assert_eq!(
            scoped_tool_id("child", "nested-call", "run-1"),
            "qwen-child:c4470811b7f02cc085e2272d931fe0d4"
        );
        assert_eq!(
            scoped_tool_id("child", "nested-call", "run-2"),
            "qwen-child:76ee0a4f8c4ebdc9ca634094a00a451d"
        );
        let fixture = Fixture::new();
        let second: Vec<Value> = fixture
            .child
            .iter()
            .enumerate()
            .map(|(index, record)| {
                let mut copy = record.clone();
                copy["uuid"] = json!(format!("second-{index}"));
                copy["agentRunId"] = json!("run-2");
                copy
            })
            .collect();
        let mut source: Vec<Value> = fixture
            .child
            .iter()
            .cloned()
            .chain(second)
            .map(|mut record| {
                record["agentId"] = json!("child");
                record["isSidechain"] = json!(true);
                record
            })
            .collect();
        let turn = parse_subagent_records(
            &source,
            json!({
                "agentId": "child",
                "parentSessionId": "synthetic-session"
            })
            .as_object()
            .unwrap(),
        )
        .unwrap();
        let tools: Vec<&DeclaredTool> = turn
            .llm_calls
            .iter()
            .flat_map(|call| call.declared_tools.iter())
            .collect();
        assert_eq!(tools.len(), 2);
        assert_ne!(tools[0].call_id, tools[1].call_id);
        assert!(tools.iter().all(|tool| tool.result.is_some()));

        source.truncate(5);
        let mut only = source;
        only[3]
            .as_object_mut()
            .unwrap()
            .get_mut("toolCallResult")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("callId".into(), json!("wrong-call"));
        let unmatched = parse_subagent_records(
            &only,
            json!({
                "agentId": "child",
                "parentSessionId": "synthetic-session"
            })
            .as_object()
            .unwrap(),
        )
        .unwrap();
        assert!(unmatched.llm_calls[0].declared_tools[0].result.is_none());
    }
}

#[cfg(test)]
#[path = "qwen_provider_message_contract_tests.rs"]
mod provider_message_contract_tests;

#[cfg(test)]
#[path = "qwen_build_capture_contract_tests.rs"]
mod build_capture_contract_tests;

#[cfg(test)]
#[path = "qwen_parser_processor_contract_tests.rs"]
mod parser_processor_contract_tests;

#[cfg(test)]
#[path = "qwen_self_check_contract_tests.rs"]
mod self_check_contract_tests;
