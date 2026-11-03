//! QwenWorkCN transcript hook. Port of `assets/hooks/qwen-work-cn-hook-processor.mjs`.
//!
//! Stop hooks read one transcript slice, split user turns, and split each turn
//! into LLM steps at tool-result boundaries. Assistant fragments inside a step
//! stay one request/response pair. History JSONL is the only stdout-visible
//! side effect besides the fail-open `{}`.

use super::common::{
    data_dir, decode_payload, env_get, filter_workspace_records, hostname, load_runtime_config,
    local_date, local_stamp_seconds, now_unix_nanos, sanitize_value, sha256_hex, with_file_lock,
    write_empty, Env, HookRequest, Obj,
};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const REVIEW_COPY_PREFIX: &str = "[SYSTEM: This is an automated background review task";
const PRIVACY_ERROR: &str = "Workspace privacy configuration could not be loaded; collection will retry without advancing its cursor";

struct Payload {
    transcript_path: String,
    session_id: String,
    cwd: String,
}

struct Snapshot {
    line_count: usize,
    lines: Vec<String>,
}

struct LineRange {
    start: usize,
    end: usize,
    reason: String,
}

struct ContentBlock {
    kind: String,
    text: Option<String>,
    thinking: Option<String>,
    id: Option<Value>,
    name: Option<Value>,
    input: Option<Value>,
    tool_use_id: Option<Value>,
    content: Option<Value>,
    is_error: bool,
}

struct ToolHit {
    row: Value,
    is_error: bool,
    content: Option<Value>,
}

struct OwnedCall {
    id: String,
    name: String,
    input: Option<Value>,
    row: Value,
}

struct StepOut {
    records: Vec<Obj>,
    calls: Vec<OwnedCall>,
    last_result_ts: Option<String>,
}

struct StepArgs<'a> {
    group: &'a [Value],
    tool_results: &'a HashMap<String, ToolHit>,
    step_id: String,
    turn_id: &'a str,
    session_id: &'a str,
    user_id: &'a str,
    observed_ts: &'a str,
    cwd: &'a str,
    input_delta: Option<Value>,
    request_ts: String,
    is_last_step: bool,
}

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let Some((agent_id, log_prefix)) = parse_args(request.args) else {
        let _ = writeln!(io::stderr(), "hook-processor: --agent-id is required");
        return 1;
    };
    write_empty(request.stdout);
    if let Some(payload) = read_payload(request.env, &agent_id, request.stdin) {
        consume_transcript(request.env, &agent_id, &log_prefix, &payload);
    }
    0
}

fn parse_args(args: &[String]) -> Option<(String, String)> {
    let mut agent_id = String::new();
    let mut log_prefix = String::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--agent-id" && index + 1 < args.len() {
            index += 1;
            agent_id = args[index].clone();
        } else if args[index] == "--log-prefix" && index + 1 < args.len() {
            index += 1;
            log_prefix = args[index].clone();
        }
        index += 1;
    }
    if agent_id.is_empty() {
        return None;
    }
    if log_prefix.is_empty() {
        log_prefix = agent_id.clone();
    }
    Some((agent_id, log_prefix))
}

fn read_payload(env: &Env, agent_id: &str, stdin: &[u8]) -> Option<Payload> {
    let raw = decode_payload(stdin);
    if js_trim(&raw).is_empty() {
        return None;
    }
    log_debug(
        env,
        agent_id,
        &format!("stdin payload: {} bytes", utf16_len(&raw)),
    );
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(err) => {
            log_debug(env, agent_id, &format!("Failed to parse stdin JSON: {err}"));
            return None;
        }
    };
    let payload = value.as_object()?;
    let event_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("unknown");
    let logged_session = payload
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    log_debug(
        env,
        agent_id,
        &format!("event: {event_name}, session: {logged_session}"),
    );
    let keys = payload.keys().cloned().collect::<Vec<_>>().join(", ");
    log_debug(env, agent_id, &format!("payload keys: {keys}"));
    if js_truthy(payload.get("stop_hooks_active")) {
        log_debug(
            env,
            agent_id,
            "stop_hooks_active=true, exiting to avoid recursion",
        );
        return None;
    }
    let transcript_path = payload
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    let session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            payload
                .get("conversation_id")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        })
        .unwrap_or("");
    if transcript_path.is_empty() || session_id.is_empty() {
        log_debug(env, agent_id, "No transcript_path or session_id in payload");
        return None;
    }
    if !Path::new(transcript_path).exists() {
        log_debug(
            env,
            agent_id,
            &format!("Transcript file not found: {transcript_path}"),
        );
        return None;
    }
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("")
        .to_string();
    Some(Payload {
        transcript_path: transcript_path.to_string(),
        session_id: session_id.to_string(),
        cwd,
    })
}

fn consume_transcript(env: &Env, agent_id: &str, log_prefix: &str, payload: &Payload) {
    let snapshot = read_snapshot(Path::new(&payload.transcript_path));
    let Some(range) = line_range(
        env,
        agent_id,
        &payload.transcript_path,
        &payload.session_id,
        snapshot.line_count,
    ) else {
        return;
    };
    let lines = slice_lines(&snapshot.lines, range.start, range.end);
    if lines.is_empty() {
        update_line_record(
            env,
            agent_id,
            &payload.transcript_path,
            &payload.session_id,
            range.end,
        );
        return;
    }
    let mut parsed = Vec::new();
    for line in lines {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            parsed.push(value);
        }
    }
    let runtime = load_runtime_config(env);
    let records = process_transcript(
        env,
        &parsed,
        &payload.session_id,
        &runtime.user_id,
        &payload.cwd,
        &range.reason,
    );
    let count = records.len();
    if append_rows(env, agent_id, log_prefix, &records) {
        update_line_record(
            env,
            agent_id,
            &payload.transcript_path,
            &payload.session_id,
            range.end,
        );
        log_debug(
            env,
            agent_id,
            &format!("Mapped {count} QwenWorkCN event(s)"),
        );
    }
}

fn read_snapshot(path: &Path) -> Snapshot {
    let Ok(bytes) = fs::read(path) else {
        return Snapshot {
            line_count: 0,
            lines: Vec::new(),
        };
    };
    if bytes.is_empty() {
        return Snapshot {
            line_count: 0,
            lines: Vec::new(),
        };
    }
    let content = String::from_utf8_lossy(&bytes);
    let trailing_newline = content.ends_with('\n');
    let lines: Vec<String> = content.split('\n').map(str::to_string).collect();
    let line_count = if trailing_newline {
        lines.len().saturating_sub(1)
    } else {
        lines.len()
    };
    Snapshot { line_count, lines }
}

fn slice_lines(lines: &[String], start: usize, end: usize) -> Vec<String> {
    lines
        .iter()
        .enumerate()
        .filter(|(index, _)| *index >= start && *index < end)
        .filter_map(|(_, line)| {
            let trimmed = js_trim(line);
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect()
}

fn line_range(
    env: &Env,
    agent_id: &str,
    transcript_path: &str,
    session_id: &str,
    current_count: usize,
) -> Option<LineRange> {
    let record = load_line_record(env, agent_id, session_id);
    let recorded_offset = record.get("last_line_count").and_then(finite_nonneg);
    let mut last = recorded_offset.unwrap_or(0.0);
    let mut reason = if recorded_offset.is_some() {
        "incremental"
    } else {
        "missing-cursor"
    }
    .to_string();
    let recorded_session = record
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let recorded_transcript = record
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !recorded_session.is_empty() && recorded_session != session_id {
        log_debug(
            env,
            agent_id,
            &format!("Session changed: {recorded_session} -> {session_id}, reset to 0"),
        );
        last = 0.0;
        reason = "session-changed".to_string();
    }
    if !recorded_transcript.is_empty() && recorded_transcript != transcript_path {
        log_debug(
            env,
            agent_id,
            &format!("Transcript changed for session {session_id}, reset to 0"),
        );
        last = 0.0;
        reason = "transcript-changed".to_string();
    }
    if current_count == 0 {
        log_debug(env, agent_id, "Transcript is empty");
        return None;
    }
    if (current_count as f64) == last {
        log_debug(
            env,
            agent_id,
            &format!("No new lines (count: {current_count})"),
        );
        return None;
    }
    if (current_count as f64) < last {
        log_debug(
            env,
            agent_id,
            &format!(
                "File truncated ({} -> {current_count}), sending all",
                format_count(last)
            ),
        );
        last = 0.0;
        reason = "truncated".to_string();
    }
    log_debug(
        env,
        agent_id,
        &format!(
            "Range: {} -> {current_count} ({reason})",
            format_count(last)
        ),
    );
    let start = float_index(last)?;
    Some(LineRange {
        start,
        end: current_count,
        reason,
    })
}

fn load_line_record(env: &Env, agent_id: &str, session_id: &str) -> Obj {
    if session_id.is_empty() {
        return Obj::new();
    }
    let data = data_dir(env);
    reconcile_line_records(&data, agent_id, session_id);
    read_json_object(&session_record_path(&data, agent_id, session_id)).unwrap_or_default()
}

fn reconcile_line_records(data: &Path, agent_id: &str, session_id: &str) {
    let target = session_record_path(data, agent_id, session_id);
    for source in shadow_paths(data, agent_id) {
        let Some(records) = read_json_object(&source) else {
            continue;
        };
        for (transcript_path, value) in records {
            let Some(value) = value.as_object() else {
                continue;
            };
            let Some(found) = value.get("session_id").and_then(Value::as_str) else {
                continue;
            };
            if found.is_empty() || found != session_id {
                continue;
            }
            let mut candidate = value.clone();
            candidate.insert(
                "session_id".to_string(),
                Value::String(session_id.to_string()),
            );
            candidate.insert(
                "transcript_path".to_string(),
                Value::String(transcript_path),
            );
            let existing = read_json_object(&target);
            let newer = match &existing {
                None => true,
                Some(existing) => is_line_record_newer(&candidate, existing),
            };
            if newer {
                let _ = save_json_object(&target, &Value::Object(candidate));
            }
        }
    }
}

fn is_line_record_newer(candidate: &Obj, existing: &Obj) -> bool {
    let candidate_path = candidate
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    let existing_path = existing
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    if candidate_path == existing_path {
        return number_gt(
            candidate.get("last_line_count"),
            existing.get("last_line_count"),
        );
    }
    let candidate_updated = candidate
        .get("updated_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    let existing_updated = existing
        .get("updated_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    !candidate_updated.is_empty()
        && (existing_updated.is_empty() || candidate_updated > existing_updated)
}

fn update_line_record(
    env: &Env,
    agent_id: &str,
    transcript_path: &str,
    session_id: &str,
    end_line: usize,
) -> bool {
    let updated_at = local_stamp_seconds();
    let mut record = Obj::new();
    record.insert(
        "session_id".to_string(),
        Value::String(session_id.to_string()),
    );
    record.insert(
        "transcript_path".to_string(),
        Value::String(transcript_path.to_string()),
    );
    record.insert(
        "last_line_count".to_string(),
        Value::from(i64::try_from(end_line).unwrap_or(i64::MAX)),
    );
    record.insert("updated_at".to_string(), Value::String(updated_at.clone()));
    let data = data_dir(env);
    let ok = save_json_object(
        &session_record_path(&data, agent_id, session_id),
        &Value::Object(record),
    );
    if ok {
        log_debug(
            env,
            agent_id,
            &format!("Updated record: {transcript_path} -> {end_line} lines"),
        );
        for shadow in shadow_paths(&data, agent_id) {
            if !update_aggregate_shadow(&shadow, transcript_path, session_id, end_line, &updated_at)
            {
                log_debug(
                    env,
                    agent_id,
                    &format!(
                        "Warning: Failed to update rollback cursor shadow {}",
                        shadow.display()
                    ),
                );
            }
        }
    } else {
        log_debug(env, agent_id, "Warning: Failed to save line records");
    }
    ok
}

fn update_aggregate_shadow(
    file: &Path,
    transcript_path: &str,
    session_id: &str,
    end_line: usize,
    updated_at: &str,
) -> bool {
    let lock = suffix_path(file, ".lock");
    let saved = with_file_lock(&lock, 1_000, 30_000, || {
        let mut records = read_json_object(file).unwrap_or_default();
        let incoming = Value::from(i64::try_from(end_line).unwrap_or(i64::MAX));
        if let Some(existing) = records.get(transcript_path).and_then(Value::as_object) {
            if existing.get("session_id").and_then(Value::as_str) == Some(session_id)
                && number_gt(existing.get("last_line_count"), Some(&incoming))
            {
                return true;
            }
        }
        let mut shadow = Obj::new();
        shadow.insert(
            "session_id".to_string(),
            Value::String(session_id.to_string()),
        );
        shadow.insert("last_line_count".to_string(), incoming);
        shadow.insert(
            "updated_at".to_string(),
            Value::String(updated_at.to_string()),
        );
        records.insert(transcript_path.to_string(), Value::Object(shadow));
        save_json_object(file, &Value::Object(records))
    });
    saved.unwrap_or(false)
}

fn session_record_path(data: &Path, agent_id: &str, session_id: &str) -> PathBuf {
    data.join("state")
        .join("hooks")
        .join(format!("{agent_id}-line-records"))
        .join(format!("{}.json", sha256_hex(session_id.as_bytes())))
}

fn shadow_paths(data: &Path, agent_id: &str) -> Vec<PathBuf> {
    // JS compares the processor file's hooks directory with `{dataDir}/hooks`.
    // The Rust binary has no script path, so the deployed hooks directory is used.
    vec![
        data.join("state")
            .join("hooks")
            .join(format!("{agent_id}-line-records.json")),
        data.join("hooks")
            .join(format!(".line_records.{agent_id}.json")),
    ]
}

fn read_json_object(path: &Path) -> Option<Obj> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn save_json_object(path: &Path, value: &Value) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        millis
    ));
    let Ok(body) = serde_json::to_string_pretty(value) else {
        return false;
    };
    if fs::write(&temporary, body).is_err() {
        let _ = fs::remove_file(&temporary);
        return false;
    }
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return false;
    }
    true
}

fn append_rows(env: &Env, agent_id: &str, log_prefix: &str, records: &[Obj]) -> bool {
    let filtered = match filter_rows(env, records, agent_id) {
        Ok(filtered) => filtered,
        Err(err) => {
            log_debug(
                env,
                agent_id,
                &format!("ERROR appending rows to history: {err}"),
            );
            return false;
        }
    };
    if filtered.is_empty() {
        return true;
    }
    let mut rows = Vec::with_capacity(filtered.len());
    for record in filtered {
        match serde_json::to_string(&Value::Object(record)) {
            Ok(line) => rows.push(line),
            Err(err) => {
                log_debug(
                    env,
                    agent_id,
                    &format!("ERROR appending rows to history: {err}"),
                );
                return false;
            }
        }
    }
    let path = history_path(env, agent_id, log_prefix);
    let lock = suffix_path(&path, ".lock");
    match with_file_lock(&lock, 15_000, 10_000, || {
        super::common::append_history_rows(env, agent_id, log_prefix, &rows)
    }) {
        Some(true) => {
            log_debug(
                env,
                agent_id,
                &format!("Appended {} rows to {}", rows.len(), path.display()),
            );
            true
        }
        Some(false) => {
            log_debug(
                env,
                agent_id,
                &format!(
                    "ERROR appending rows to history: failed to append {}",
                    path.display()
                ),
            );
            false
        }
        None => {
            log_debug(
                env,
                agent_id,
                &format!(
                    "ERROR appending rows to history: timed out waiting for {}",
                    lock.display()
                ),
            );
            false
        }
    }
}

fn filter_rows(env: &Env, records: &[Obj], agent_id: &str) -> Result<Vec<Obj>, String> {
    let root = data_dir(env);
    let config_path = env_get(env, "AGENT_DATA_COLLECTION_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config.json"));
    match fs::read_to_string(&config_path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(PRIVACY_ERROR.to_string()),
        Ok(text) => {
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text).trim();
            if text.is_empty() {
                return Err(PRIVACY_ERROR.to_string());
            }
        }
    }
    filter_workspace_records(env, records, agent_id)
}

fn history_path(env: &Env, agent_id: &str, log_prefix: &str) -> PathBuf {
    data_dir(env)
        .join("logs")
        .join(agent_id)
        .join("history")
        .join(format!("{log_prefix}-{}.jsonl", local_date()))
}

fn process_transcript(
    env: &Env,
    parsed: &[Value],
    fallback_session: &str,
    configured_user: &str,
    fallback_cwd: &str,
    reason: &str,
) -> Vec<Obj> {
    if is_review_copy(parsed) {
        log_debug(
            env,
            "qwen-work-cn",
            &format!("Skipping review-copy session {fallback_session}"),
        );
        return Vec::new();
    }
    let content: Vec<Value> = parsed
        .iter()
        .filter(|row| is_content_row(row))
        .cloned()
        .collect();
    if content.is_empty() {
        return Vec::new();
    }
    let mut turns = split_turns(&content);
    if reason != "incremental" {
        let last = turns.pop();
        turns.clear();
        if let Some(last) = last {
            turns.push(last);
        }
    }
    let observed = now_unix_nanos();
    let mut records = Vec::new();
    for turn in &turns {
        records.extend(build_turn_events(
            turn,
            fallback_session,
            configured_user,
            fallback_cwd,
            &observed,
        ));
    }
    let mode = if reason == "incremental" {
        "incremental"
    } else {
        "bootstrap"
    };
    let batch = uuid::Uuid::new_v4().to_string();
    for record in &mut records {
        record.insert(
            "agent.transcript.cursor_mode".to_string(),
            Value::String(mode.to_string()),
        );
        record.insert(
            "agent.transcript.cursor_reason".to_string(),
            Value::String(reason.to_string()),
        );
        record.insert(
            "agent.transcript.cursor_batch_id".to_string(),
            Value::String(batch.clone()),
        );
    }
    records
}

fn is_review_copy(rows: &[Value]) -> bool {
    rows.iter().any(|row| {
        row_type(row) == "user"
            && blocks_of(row).iter().any(|block| {
                block.kind == "text"
                    && block
                        .text
                        .as_deref()
                        .is_some_and(|text| js_trim_start(text).starts_with(REVIEW_COPY_PREFIX))
            })
    })
}

fn is_content_row(row: &Value) -> bool {
    let kind = row_type(row);
    if kind != "user" && kind != "assistant" {
        return false;
    }
    !flag_is_true(row, "isSidechain") && !flag_is_true(row, "isMeta")
}

fn flag_is_true(row: &Value, key: &str) -> bool {
    match row.get(key) {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) if text == "true" => true,
        _ => false,
    }
}

fn split_turns(rows: &[Value]) -> Vec<Vec<Value>> {
    let mut turns = Vec::new();
    let mut current = Vec::new();
    for row in rows {
        if is_prompt_row(row) {
            if !current.is_empty() {
                turns.push(std::mem::take(&mut current));
            }
            current.push(row.clone());
        } else {
            current.push(row.clone());
        }
    }
    if !current.is_empty() {
        turns.push(current);
    }
    turns
}

fn is_prompt_row(row: &Value) -> bool {
    row_type(row) == "user" && !is_tool_result(row) && !is_system_injection(row)
}

fn is_tool_result(row: &Value) -> bool {
    row_type(row) == "user"
        && blocks_of(row)
            .iter()
            .any(|block| block.kind == "tool_result")
}

fn is_system_injection(row: &Value) -> bool {
    let extracted = extract_text(row);
    let text = js_trim_start(&extracted);
    if text.starts_with("<command-message>")
        || text.starts_with("<command-name>")
        || text.starts_with("[Request interrupted")
        || text.starts_with(REVIEW_COPY_PREFIX)
    {
        return true;
    }
    if !text.starts_with("<system-reminder>") {
        return false;
    }
    let stripped = reminder_pattern().replace_all(text, "");
    js_trim(&stripped).is_empty()
}

fn build_turn_events(
    turn_rows: &[Value],
    fallback_session: &str,
    configured_user: &str,
    fallback_cwd: &str,
    observed_ts: &str,
) -> Vec<Obj> {
    let Some(prompt) = turn_rows.iter().find(|row| is_prompt_row(row)) else {
        return Vec::new();
    };
    let session_id = non_empty_string(prompt, "sessionId")
        .or_else(|| non_empty_string(prompt, "session_id"))
        .unwrap_or_else(|| fallback_session.to_string());
    let stamp = id_component(prompt.get("timestamp"));
    let turn_id = non_empty_string(prompt, "promptId")
        .or_else(|| non_empty_string(prompt, "uuid"))
        .unwrap_or_else(|| stable_id(&[&session_id, &stamp, "turn"]));
    let user_id = resolve_user_id(prompt, configured_user);
    let cwd = non_empty_string(prompt, "cwd").unwrap_or_else(|| fallback_cwd.to_string());
    let prompt_text = extract_text(prompt);
    let prompt_ts = timestamp_to_unix_nanos(prompt.get("timestamp"));
    let mut records = Vec::new();
    if !prompt_text.is_empty() {
        let mut fields = Obj::new();
        insert_str(&mut fields, "agent.qwenworkcn.promptId", &turn_id);
        insert_str(&mut fields, "event.name", "other");
        insert_str(&mut fields, "gen_ai.turn.id", &turn_id);
        insert_str(&mut fields, "gen_ai.session.id", &session_id);
        insert_str(&mut fields, "gen_ai.agent.type", "qwen-work-cn");
        insert_str(
            &mut fields,
            "gen_ai.provider.name",
            &infer_provider("", "qwen-work-cn"),
        );
        insert_str(&mut fields, "user.id", &user_id);
        fields.insert(
            "gen_ai.input.messages_delta".to_string(),
            user_text_delta(&prompt_text),
        );
        insert_str(&mut fields, "time_unix_nano", &prompt_ts);
        insert_str(&mut fields, "observed_time_unix_nano", observed_ts);
        if let Some(record) = build_record(
            fields,
            prompt,
            &cwd,
            &session_id,
            &format!("{turn_id}:other"),
        ) {
            records.push(record);
        }
    }

    let tool_results = index_tool_results(turn_rows);
    let groups = group_assistants(turn_rows);
    let mut previous_calls = Vec::new();
    let mut previous_result_ts = None;
    for (index, group) in groups.iter().enumerate() {
        let input_delta = input_delta_for(index, &prompt_text, &previous_calls, &tool_results);
        let request_ts = if index == 0 {
            prompt_ts.clone()
        } else {
            previous_result_ts
                .clone()
                .unwrap_or_else(|| timestamp_to_unix_nanos(group[0].get("timestamp")))
        };
        let step = build_step(StepArgs {
            group,
            tool_results: &tool_results,
            step_id: format!("{turn_id}:s{}", index + 1),
            turn_id: &turn_id,
            session_id: &session_id,
            user_id: &user_id,
            observed_ts,
            cwd: &cwd,
            input_delta,
            request_ts,
            is_last_step: index + 1 == groups.len(),
        });
        records.extend(step.records);
        previous_calls = step.calls;
        if step.last_result_ts.is_some() {
            previous_result_ts = step.last_result_ts;
        }
    }
    records
}

fn input_delta_for(
    index: usize,
    prompt_text: &str,
    previous_calls: &[OwnedCall],
    tool_results: &HashMap<String, ToolHit>,
) -> Option<Value> {
    if index == 0 {
        if prompt_text.is_empty() {
            return None;
        }
        return Some(user_text_delta(prompt_text));
    }
    if previous_calls.is_empty() {
        return None;
    }
    let mut responses = Vec::new();
    for call in previous_calls {
        if let Some(hit) = tool_results.get(&call.id) {
            responses.push(tool_response_part(&call.id, hit_result(hit)));
        }
    }
    if responses.is_empty() {
        return None;
    }
    let mut assistant_parts = Vec::new();
    for call in previous_calls {
        let mut part = Obj::new();
        insert_str(&mut part, "type", "tool_call");
        insert_str(&mut part, "id", &call.id);
        insert_str(&mut part, "name", &call.name);
        if let Some(input) = &call.input {
            part.insert("arguments".to_string(), input.clone());
        }
        assistant_parts.push(Value::Object(part));
    }
    Some(json!([
        {"role": "assistant", "parts": assistant_parts},
        {"role": "tool", "parts": responses}
    ]))
}

fn user_text_delta(text: &str) -> Value {
    json!([{
        "role": "user",
        "parts": [{"type": "text", "content": text}]
    }])
}

fn tool_response_part(id: &str, response: Option<Value>) -> Value {
    let mut part = Obj::new();
    insert_str(&mut part, "type", "tool_call_response");
    insert_str(&mut part, "id", id);
    if let Some(response) = response {
        part.insert("response".to_string(), response);
    }
    Value::Object(part)
}

fn hit_result(hit: &ToolHit) -> Option<Value> {
    if let Some(value) = hit.row.get("toolUseResult") {
        if !value.is_null() {
            return Some(value.clone());
        }
    }
    hit.content.clone().filter(|value| !value.is_null())
}

fn group_assistants(rows: &[Value]) -> Vec<Vec<Value>> {
    let mut groups = Vec::new();
    let mut current = Vec::new();
    for row in rows {
        if row_type(row) == "assistant" {
            current.push(row.clone());
        } else if is_tool_result(row) && !current.is_empty() {
            groups.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

fn index_tool_results(rows: &[Value]) -> HashMap<String, ToolHit> {
    let mut results = HashMap::new();
    for row in rows {
        if !is_tool_result(row) {
            continue;
        }
        for block in blocks_of(row) {
            if block.kind != "tool_result" {
                continue;
            }
            let Some(id) = block.tool_use_id.as_ref().and_then(Value::as_str) else {
                continue;
            };
            if id.is_empty() || results.contains_key(id) {
                continue;
            }
            results.insert(
                id.to_string(),
                ToolHit {
                    row: row.clone(),
                    is_error: block.is_error,
                    content: block.content.clone(),
                },
            );
        }
    }
    results
}

fn build_step(args: StepArgs<'_>) -> StepOut {
    let StepArgs {
        group,
        tool_results,
        step_id,
        turn_id,
        session_id,
        user_id,
        observed_ts,
        cwd,
        input_delta,
        request_ts,
        is_last_step,
    } = args;
    let first_row = &group[0];
    let response_index = group
        .iter()
        .position(|row| blocks_of(row).iter().any(|block| block.kind == "thinking"))
        .unwrap_or(group.len() - 1);
    let response_row = &group[response_index];
    let model = group
        .iter()
        .find_map(|row| {
            row.get("message")
                .and_then(|message| message.get("model"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string());
    let provider = infer_provider(&model, "qwen-work-cn");
    let mut output_parts = Vec::new();
    let mut calls = Vec::new();
    for row in group {
        for block in blocks_of(row) {
            if block.kind == "thinking" {
                let content = block
                    .thinking
                    .clone()
                    .filter(|text| !text.is_empty())
                    .or_else(|| block.text.clone().filter(|text| !text.is_empty()));
                if let Some(content) = content {
                    output_parts.push(json!({"type": "reasoning", "content": content}));
                }
            } else if block.kind == "text" {
                if let Some(content) = block.text.clone().filter(|text| !text.is_empty()) {
                    output_parts.push(json!({"type": "text", "content": content}));
                }
            } else if block.kind == "tool_use" {
                let mut part = Obj::new();
                insert_str(&mut part, "type", "tool_call");
                if let Some(id) = &block.id {
                    part.insert("id".to_string(), id.clone());
                }
                if let Some(name) = &block.name {
                    part.insert("name".to_string(), name.clone());
                }
                if let Some(input) = &block.input {
                    part.insert("arguments".to_string(), input.clone());
                }
                output_parts.push(Value::Object(part));
                calls.push(OwnedCall {
                    id: json_string(block.id.as_ref()),
                    name: json_string(block.name.as_ref()),
                    input: block.input.clone(),
                    row: row.clone(),
                });
            }
        }
    }
    let finish = if !calls.is_empty() {
        "tool_calls"
    } else if is_last_step {
        "end_turn"
    } else {
        "stop"
    };
    let response_id = group
        .iter()
        .find_map(|row| {
            row.get("message")
                .and_then(|message| message.get("id"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .filter(|text| !text.is_empty())
        .or_else(|| {
            let parent = json_string(first_row.get("parentUuid"));
            if parent.is_empty() {
                None
            } else {
                Some(parent)
            }
        })
        .or_else(|| {
            let uuid = json_string(first_row.get("uuid"));
            if uuid.is_empty() {
                None
            } else {
                Some(uuid)
            }
        })
        .unwrap_or_default();
    let request_id = if response_id.is_empty() {
        format!("{step_id}:request")
    } else {
        format!("{response_id}:request")
    };
    let mut records = Vec::new();
    let mut request_fields = step_fields(turn_id, &step_id, session_id, user_id, &provider);
    insert_str(&mut request_fields, "event.name", "llm.request");
    insert_str(&mut request_fields, "gen_ai.request.id", &request_id);
    insert_str(&mut request_fields, "gen_ai.request.model", &model);
    if let Some(input_delta) = input_delta {
        request_fields.insert("gen_ai.input.messages_delta".to_string(), input_delta);
    }
    insert_str(&mut request_fields, "time_unix_nano", &request_ts);
    insert_str(&mut request_fields, "observed_time_unix_nano", observed_ts);
    if let Some(record) = build_record(
        request_fields,
        first_row,
        cwd,
        session_id,
        &format!("{step_id}:request"),
    ) {
        records.push(record);
    }
    if !output_parts.is_empty() {
        let mut response_fields = step_fields(turn_id, &step_id, session_id, user_id, &provider);
        insert_str(&mut response_fields, "event.name", "llm.response");
        insert_str(&mut response_fields, "gen_ai.request.id", &request_id);
        insert_str(&mut response_fields, "gen_ai.request.model", &model);
        insert_str(&mut response_fields, "gen_ai.response.model", &model);
        if !response_id.is_empty() {
            insert_str(&mut response_fields, "gen_ai.response.id", &response_id);
        }
        response_fields.insert(
            "gen_ai.response.finish_reasons".to_string(),
            json!([finish]),
        );
        response_fields.insert(
            "gen_ai.output.messages".to_string(),
            json!([{
                "role": "assistant",
                "parts": output_parts,
                "finish_reason": finish
            }]),
        );
        insert_str(
            &mut response_fields,
            "time_unix_nano",
            &timestamp_to_unix_nanos(response_row.get("timestamp")),
        );
        insert_str(&mut response_fields, "observed_time_unix_nano", observed_ts);
        if let Some(record) = build_record(
            response_fields,
            first_row,
            cwd,
            session_id,
            &format!("{step_id}:response"),
        ) {
            records.push(record);
        }
    }
    let mut last_result_ts = None;
    for call in &calls {
        let mut call_fields = step_fields(turn_id, &step_id, session_id, user_id, &provider);
        insert_str(&mut call_fields, "event.name", "tool.call");
        insert_str(&mut call_fields, "gen_ai.tool.name", &call.name);
        insert_str(&mut call_fields, "gen_ai.tool.call.id", &call.id);
        insert_str(&mut call_fields, "gen_ai.tool.call.exec.id", &call.id);
        if let Some(input) = &call.input {
            call_fields.insert("gen_ai.tool.call.arguments".to_string(), input.clone());
        }
        insert_str(
            &mut call_fields,
            "time_unix_nano",
            &timestamp_to_unix_nanos(call.row.get("timestamp")),
        );
        insert_str(&mut call_fields, "observed_time_unix_nano", observed_ts);
        if let Some(record) = build_record(
            call_fields,
            &call.row,
            cwd,
            session_id,
            &format!("{step_id}:tool.call:{}", call.id),
        ) {
            records.push(record);
        }
        let Some(hit) = tool_results.get(&call.id) else {
            continue;
        };
        let result_ts = timestamp_to_unix_nanos(hit.row.get("timestamp"));
        last_result_ts = Some(result_ts.clone());
        let mut result_fields = step_fields(turn_id, &step_id, session_id, user_id, &provider);
        insert_str(&mut result_fields, "event.name", "tool.result");
        insert_str(&mut result_fields, "gen_ai.tool.name", &call.name);
        insert_str(&mut result_fields, "gen_ai.tool.call.id", &call.id);
        insert_str(&mut result_fields, "gen_ai.tool.call.exec.id", &call.id);
        if let Some(result) = hit_result(hit) {
            result_fields.insert("gen_ai.tool.call.result".to_string(), result);
        }
        insert_str(
            &mut result_fields,
            "tool.result.status",
            if hit.is_error { "failure" } else { "success" },
        );
        insert_str(&mut result_fields, "time_unix_nano", &result_ts);
        insert_str(&mut result_fields, "observed_time_unix_nano", observed_ts);
        if let Some(record) = build_record(
            result_fields,
            &hit.row,
            cwd,
            session_id,
            &format!("{step_id}:tool.result:{}", call.id),
        ) {
            records.push(record);
        }
    }
    StepOut {
        records,
        calls,
        last_result_ts,
    }
}

fn step_fields(
    turn_id: &str,
    step_id: &str,
    session_id: &str,
    user_id: &str,
    provider: &str,
) -> Obj {
    let mut fields = Obj::new();
    insert_str(&mut fields, "agent.qwenworkcn.promptId", turn_id);
    insert_str(&mut fields, "gen_ai.step.id", step_id);
    insert_str(&mut fields, "gen_ai.turn.id", turn_id);
    insert_str(&mut fields, "gen_ai.session.id", session_id);
    insert_str(&mut fields, "gen_ai.agent.type", "qwen-work-cn");
    insert_str(&mut fields, "gen_ai.provider.name", provider);
    insert_str(&mut fields, "user.id", user_id);
    fields
}

fn build_record(
    fields: Obj,
    source: &Value,
    cwd: &str,
    session_id: &str,
    event_key: &str,
) -> Option<Obj> {
    let mut record = Obj::new();
    record.insert(
        "event.id".to_string(),
        Value::String(stable_id(&[session_id, event_key])),
    );
    record.insert(
        "agent.source".to_string(),
        Value::String("qwen-work-cn-transcript-hook".to_string()),
    );
    for (key, value) in fields {
        record.insert(key, value);
    }
    if !cwd.is_empty() {
        record.insert(
            "agent.qwenworkcn.cwd".to_string(),
            Value::String(cwd.to_string()),
        );
    }
    if let Some(kind) = truthy_field(source, "type") {
        record.insert("agent.qwenworkcn.raw_type".to_string(), kind);
    }
    if let Some(version) = truthy_field(source, "version") {
        record.insert("agent.qwenworkcn.version".to_string(), version);
    }
    match sanitize_value(&Value::Object(record)) {
        Some(Value::Object(cleaned)) => Some(cleaned),
        _ => None,
    }
}

fn truthy_field(source: &Value, key: &str) -> Option<Value> {
    let value = source.get(key)?;
    js_truthy(Some(value)).then(|| value.clone())
}

fn blocks_of(row: &Value) -> Vec<ContentBlock> {
    let Some(content) = row
        .get("message")
        .and_then(|message| message.get("content"))
    else {
        return Vec::new();
    };
    if let Some(text) = content.as_str() {
        return vec![ContentBlock {
            kind: "text".to_string(),
            text: Some(text.to_string()),
            thinking: None,
            id: None,
            name: None,
            input: None,
            tool_use_id: None,
            content: None,
            is_error: false,
        }];
    }
    let Some(items) = content.as_array() else {
        return Vec::new();
    };
    items.iter().filter_map(block_from_value).collect()
}

fn block_from_value(value: &Value) -> Option<ContentBlock> {
    let object = value.as_object()?;
    let kind = object.get("type").and_then(Value::as_str)?.to_string();
    Some(ContentBlock {
        kind,
        text: object
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string),
        thinking: object
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_string),
        id: object.get("id").cloned(),
        name: object.get("name").cloned(),
        input: object.get("input").cloned(),
        tool_use_id: object.get("tool_use_id").cloned(),
        content: object.get("content").cloned(),
        is_error: js_truthy(object.get("is_error")),
    })
}

fn extract_text(row: &Value) -> String {
    blocks_of(row)
        .into_iter()
        .filter_map(|block| {
            if block.kind == "text" {
                block.text.filter(|text| !text.is_empty())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_user_id(row: &Value, configured: &str) -> String {
    for key in ["user.id", "user_id", "userId", "identity"] {
        if let Some(value) = non_empty_string(row, key) {
            return value;
        }
    }
    if !configured.is_empty() {
        return configured.to_string();
    }
    hostname()
}

fn infer_provider(model: &str, agent_type: &str) -> String {
    let model = model.to_lowercase();
    if !model.is_empty() {
        if model.contains("claude") || model.contains("anthropic") {
            return "anthropic".to_string();
        }
        if model.contains("gpt") || model.contains("openai") || model.contains("codex") {
            return "openai".to_string();
        }
        if model.contains("qwen") || model.contains("tongyi") {
            return "qwen".to_string();
        }
        if model.contains("deepseek") {
            return "deepseek".to_string();
        }
        if model.contains("gemini") {
            return "gcp.gemini".to_string();
        }
        if model.contains("grok") || model.contains("xai") || model.contains("x_ai") {
            return "x_ai".to_string();
        }
    }
    let agent = agent_type.to_lowercase();
    if agent.contains("codex") {
        return "openai".to_string();
    }
    if agent.contains("claude") {
        return "anthropic".to_string();
    }
    if agent.contains("qoder") || agent.contains("qwen") {
        return "qwen".to_string();
    }
    if agent.contains("gemini") {
        return "gcp.gemini".to_string();
    }
    "unknown".to_string()
}

fn timestamp_to_unix_nanos(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => now_unix_nanos(),
        Some(Value::String(text)) => timestamp_from_string(text),
        Some(Value::Number(number)) => number
            .as_f64()
            .map(nanos_from_f64)
            .unwrap_or_else(now_unix_nanos),
        Some(_) => now_unix_nanos(),
    }
}

fn timestamp_from_string(text: &str) -> String {
    let trimmed = js_trim(text);
    if trimmed.len() >= 16 && trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return trimmed.to_string();
    }
    if let Some(number) = js_number_literal(trimmed) {
        return nanos_from_f64(number);
    }
    if let Some(millis) = parse_js_date_millis(trimmed) {
        return nanos_from_f64(millis as f64);
    }
    now_unix_nanos()
}

fn js_number_literal(text: &str) -> Option<f64> {
    if text.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        if !hex.is_empty() && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return u64::from_str_radix(hex, 16)
                .ok()
                .map(|number| number as f64);
        }
    }
    if let Some(binary) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        if !binary.is_empty() && binary.chars().all(|ch| ch == '0' || ch == '1') {
            return u64::from_str_radix(binary, 2)
                .ok()
                .map(|number| number as f64);
        }
    }
    if let Some(octal) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        if !octal.is_empty() && octal.chars().all(|ch| ('0'..='7').contains(&ch)) {
            return u64::from_str_radix(octal, 8)
                .ok()
                .map(|number| number as f64);
        }
    }
    let number: f64 = text.parse().ok()?;
    number.is_finite().then_some(number)
}

fn nanos_from_f64(value: f64) -> String {
    if !value.is_finite() {
        return now_unix_nanos();
    }
    if value >= 1e16 {
        let trunc = value.trunc();
        if trunc >= i64::MIN as f64 && trunc <= i64::MAX as f64 {
            return format!("{}", trunc as i64);
        }
        return format!("{trunc:.0}");
    }
    if value >= 1e12 {
        return format!("{}000000", value.trunc() as i64);
    }
    format!("{}000000", (value * 1000.0).trunc() as i64)
}

fn parse_js_date_millis(text: &str) -> Option<i64> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    let naive = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S"))
        .ok()?;
    naive
        .and_local_timezone(chrono::Local)
        .single()
        .map(|parsed| parsed.timestamp_millis())
}

fn stable_id(parts: &[&str]) -> String {
    sha256_hex(parts.join("\0").as_bytes())
}

fn id_component(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Bool(false)) => "false".to_string(),
        Some(Value::Number(number)) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(integer) = number.as_u64() {
                integer.to_string()
            } else if let Some(float) = number.as_f64() {
                format_js_number(float)
            } else {
                String::new()
            }
        }
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| id_component(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

fn format_js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity".to_string()
        } else {
            "Infinity".to_string()
        };
    }
    if value.fract() == 0.0 && value.abs() <= i64::MAX as f64 {
        return format!("{}", value as i64);
    }
    value.to_string()
}

fn non_empty_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn json_string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_string()
}

fn row_type(row: &Value) -> &str {
    row.get("type").and_then(Value::as_str).unwrap_or("")
}

fn insert_str(map: &mut Obj, key: &str, value: &str) {
    map.insert(key.to_string(), Value::String(value.to_string()));
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => match number.as_f64() {
            Some(number) => number != 0.0 && !number.is_nan(),
            None => true,
        },
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn finite_nonneg(value: &Value) -> Option<f64> {
    let Value::Number(number) = value else {
        return None;
    };
    let number = number.as_f64()?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn number_gt(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (js_number(left), js_number(right)) {
        (Some(left), Some(right)) => left > right,
        _ => false,
    }
}

fn js_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        Some(Value::String(text)) => {
            let text = js_trim(text);
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse::<f64>().ok().filter(|number| number.is_finite())
            }
        }
        Some(Value::Bool(true)) => Some(1.0),
        Some(Value::Bool(false) | Value::Null) => Some(0.0),
        _ => None,
    }
}

fn float_index(value: f64) -> Option<usize> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= usize::MAX as f64 {
        Some(value as usize)
    } else {
        None
    }
}

fn format_count(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

fn reminder_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?s)<system-reminder>.*?</system-reminder>").expect("system reminder pattern")
    })
}

fn log_debug(env: &Env, agent_id: &str, message: &str) {
    let path = data_dir(env)
        .join("logs")
        .join(agent_id)
        .join("debug")
        .join(format!("{agent_id}-debug-{}.log", local_date()));
    let line = format!("[{}] {message}\n", local_stamp_seconds());
    let _ = append_text(&path, &line);
}

fn append_text(path: &Path, text: &str) -> bool {
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .is_ok()
}

fn suffix_path(path: &Path, suffix: &str) -> PathBuf {
    let mut owned = path.as_os_str().to_owned();
    owned.push(suffix);
    PathBuf::from(owned)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

fn js_trim(text: &str) -> &str {
    js_trim_start(text).trim_end_matches(is_js_whitespace)
}

#[cfg(test)]
fn run_in(root: &Path, args: &[&str], stdin: &str, extra: &[(&str, &str)]) -> (i32, String) {
    let mut env = Env::new();
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".to_string(),
        root.to_string_lossy().into_owned(),
    );
    for (key, value) in extra {
        env.insert((*key).to_string(), (*value).to_string());
    }
    let owned_args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let mut stdout = Vec::new();
    let code = {
        let mut request = HookRequest {
            args: &owned_args,
            stdin: stdin.as_bytes(),
            env: &env,
            stdout: &mut stdout,
        };
        run(&mut request)
    };
    (code, String::from_utf8(stdout).expect("utf8 stdout"))
}

#[cfg(test)]
mod tests {
    use super::{
        infer_provider, run_in, session_record_path, stable_id, timestamp_to_unix_nanos,
        PRIVACY_ERROR,
    };
    use serde_json::{json, Map, Value};
    use std::fs;
    use std::path::Path;

    const ARGS: &[&str] = &["--agent-id", "qwen-work-cn", "--log-prefix", "qwen-work-cn"];
    const USER: &[(&str, &str)] = &[("LOONGSUITE_PILOT_USER_ID", "user-1")];

    fn write_rows(path: &Path, rows: &[Value]) {
        let mut body = String::new();
        for row in rows {
            body.push_str(&serde_json::to_string(row).unwrap());
            body.push('\n');
        }
        fs::write(path, body).unwrap();
    }

    fn shadow_json(transcript: &str, lines: i64, updated: &str) -> String {
        let mut map = Map::new();
        map.insert(
            transcript.to_string(),
            json!({
                "session_id": "sess",
                "last_line_count": lines,
                "updated_at": updated,
            }),
        );
        serde_json::to_string_pretty(&Value::Object(map)).unwrap()
    }

    fn payload(transcript: &str, session: &str, cwd: &str) -> String {
        json!({
            "hook_event_name": "Stop",
            "transcript_path": transcript,
            "session_id": session,
            "cwd": cwd,
        })
        .to_string()
    }

    fn history(root: &Path) -> Vec<Value> {
        let dir = root.join("logs/qwen-work-cn/history");
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
            let text = fs::read_to_string(path).unwrap_or_default();
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                records.push(serde_json::from_str(line).expect("history json"));
            }
        }
        records
    }

    fn debug_text(root: &Path, agent: &str) -> String {
        let dir = root.join("logs").join(agent).join("debug");
        let Ok(entries) = fs::read_dir(dir) else {
            return String::new();
        };
        entries
            .flatten()
            .map(|entry| fs::read_to_string(entry.path()).unwrap_or_default())
            .collect()
    }

    fn names(events: &[Value]) -> Vec<&str> {
        events
            .iter()
            .map(|event| event["event.name"].as_str().unwrap())
            .collect()
    }

    fn real_shape() -> Vec<Value> {
        let common = json!({
            "sessionId": "sess-qwen-1",
            "cwd": "/workspace",
            "version": "0.1.5",
            "isSidechain": false,
        });
        let row = |extra: Value| {
            let mut merged = common.as_object().unwrap().clone();
            for (key, value) in extra.as_object().unwrap() {
                merged.insert(key.clone(), value.clone());
            }
            Value::Object(merged)
        };
        vec![
            row(json!({
                "type": "user",
                "uuid": "user-1",
                "promptId": "prompt-turn-1",
                "timestamp": "2026-08-06T03:44:58.934Z",
                "message": {"role": "user", "content": [
                    {"type": "text", "text": "<system-reminder>workspace context</system-reminder>"},
                    {"type": "text", "text": "inspect package.json"}
                ]}
            })),
            row(json!({
                "type": "assistant",
                "uuid": "thinking-1",
                "parentUuid": "user-1",
                "timestamp": "2026-08-06T03:45:03.994Z",
                "message": {"role": "assistant", "id": "response-1", "model": "qwork-advanced", "content": [
                    {"type": "thinking", "thinking": "reason 1"}
                ]}
            })),
            row(json!({
                "type": "assistant",
                "uuid": "tool-call-row-1",
                "parentUuid": "thinking-1",
                "timestamp": "2026-08-06T03:45:03.994Z",
                "message": {"role": "assistant", "id": "response-1", "model": "qwork-advanced", "stop_reason": "tool_use", "content": [
                    {"type": "tool_use", "id": "call-1", "name": "Glob", "input": {"pattern": "package.json"}}
                ]}
            })),
            row(json!({
                "type": "user",
                "uuid": "tool-result-row-1",
                "parentUuid": "tool-call-row-1",
                "promptId": "prompt-turn-1",
                "timestamp": "2026-08-06T03:45:04.099Z",
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-1", "content": ["package.json"]}
                ]}
            })),
            row(json!({
                "type": "assistant",
                "uuid": "thinking-2",
                "parentUuid": "tool-result-row-1",
                "timestamp": "2026-08-06T03:45:08.673Z",
                "message": {"role": "assistant", "id": "response-2", "model": "qwork-advanced", "content": [
                    {"type": "thinking", "thinking": "reason 2"}
                ]}
            })),
            row(json!({
                "type": "assistant",
                "uuid": "tool-call-row-2",
                "parentUuid": "thinking-2",
                "timestamp": "2026-08-06T03:45:08.673Z",
                "message": {"role": "assistant", "id": "response-2", "model": "qwork-advanced", "stop_reason": "tool_use", "content": [
                    {"type": "tool_use", "id": "call-2", "name": "Read", "input": {"file_path": "package.json"}}
                ]}
            })),
            row(json!({
                "type": "user",
                "uuid": "tool-result-row-2",
                "parentUuid": "tool-call-row-2",
                "promptId": "prompt-turn-1",
                "timestamp": "2026-08-06T03:45:08.776Z",
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-2", "content": "{\"name\":\"pilot\"}"}
                ]}
            })),
            row(json!({
                "type": "assistant",
                "uuid": "thinking-3",
                "parentUuid": "tool-result-row-2",
                "timestamp": "2026-08-06T03:45:14.512Z",
                "message": {"role": "assistant", "id": "response-3", "model": "qwork-advanced", "content": [
                    {"type": "thinking", "thinking": "reason 3"}
                ]}
            })),
            row(json!({
                "type": "assistant",
                "uuid": "text-3",
                "parentUuid": "thinking-3",
                "timestamp": "2026-08-06T03:45:14.512Z",
                "message": {"role": "assistant", "id": "response-3", "model": "qwork-advanced", "stop_reason": "end_turn", "content": [
                    {"type": "text", "text": "done"}
                ]}
            })),
        ]
    }

    fn two_turns() -> Vec<Value> {
        vec![
            json!({
                "type": "user",
                "isSidechain": "true",
                "promptId": "side",
                "sessionId": "sess",
                "timestamp": "2026-08-06T03:59:00.000Z",
                "cwd": "/workspace",
                "message": {"content": "hidden sidechain"}
            }),
            json!({
                "type": "user",
                "isMeta": true,
                "promptId": "meta",
                "sessionId": "sess",
                "timestamp": "2026-08-06T03:59:01.000Z",
                "cwd": "/workspace",
                "message": {"content": "hidden meta"}
            }),
            json!({
                "type": "user",
                "promptId": "sys",
                "sessionId": "sess",
                "timestamp": "2026-08-06T03:59:02.000Z",
                "cwd": "/workspace",
                "message": {"content": "<system-reminder>only</system-reminder>"}
            }),
            json!({
                "type": "user",
                "promptId": "t1",
                "sessionId": "sess",
                "timestamp": "2026-08-06T04:00:00.000Z",
                "cwd": "/workspace",
                "version": "1",
                "message": {"content": "one"}
            }),
            json!({
                "type": "assistant",
                "timestamp": "2026-08-06T04:00:01.000Z",
                "version": "1",
                "message": {"id": "r1", "model": "claude-3", "content": "r1"}
            }),
            json!({
                "type": "user",
                "promptId": "t2",
                "sessionId": "sess",
                "timestamp": "2026-08-06T04:00:02.000Z",
                "cwd": "/workspace",
                "version": "1",
                "message": {"content": "two"}
            }),
            json!({
                "type": "assistant",
                "timestamp": "2026-08-06T04:00:03.000Z",
                "version": "1",
                "message": {"id": "r2", "model": "qwen-x", "content": [{"type": "text", "text": "ok2"}]}
            }),
        ]
    }

    #[test]
    fn timestamps_and_event_ids_match_javascript() {
        assert_eq!(
            timestamp_to_unix_nanos(Some(&json!("2026-08-06T03:44:58.934Z"))),
            "1785987898934000000"
        );
        assert_eq!(
            timestamp_to_unix_nanos(Some(&json!("2026-08-06T03:44:58.934+00:00"))),
            "1785987898934000000"
        );
        assert_eq!(timestamp_to_unix_nanos(Some(&json!(""))), "0000000");
        assert_eq!(timestamp_to_unix_nanos(Some(&json!("123"))), "123000000000");
        assert_eq!(
            timestamp_to_unix_nanos(Some(&json!(1_700_000_000_000_u64))),
            "1700000000000000000"
        );
        assert_eq!(
            timestamp_to_unix_nanos(Some(&json!("17000000000000000"))),
            "17000000000000000"
        );
        let missing = timestamp_to_unix_nanos(None);
        assert!(missing.ends_with("000000"));
        assert_ne!(missing, "0000000");
        assert_eq!(
            stable_id(&["sess-qwen-1", "prompt-turn-1:other"]),
            "af200e19f36b88eac2efc28d50ddeea6e1ffe5fd63fb291d1125ab0c247543c6"
        );
        assert_eq!(infer_provider("qwork-advanced", "qwen-work-cn"), "qwen");
        assert_eq!(infer_provider("gpt-4o", "qwen-work-cn"), "openai");
        assert_eq!(infer_provider("claude-3", "qwen-work-cn"), "anthropic");
        assert_eq!(infer_provider("deepseek-r1", "qwen-work-cn"), "deepseek");
        assert_eq!(infer_provider("gemini-2", "qwen-work-cn"), "gcp.gemini");
        assert_eq!(infer_provider("grok-2", "qwen-work-cn"), "x_ai");
        assert_eq!(infer_provider("", "qwen-work-cn"), "qwen");
    }

    #[test]
    fn missing_agent_id_exits_before_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let (code, stdout) = run_in(dir.path(), &["--log-prefix", "qwen-work-cn"], "{}", &[]);
        assert_eq!(code, 1);
        assert_eq!(stdout, "");
        assert!(!dir.path().join("logs").exists());
    }

    #[test]
    fn bad_stdin_stop_hook_and_missing_file_print_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (code, stdout) = run_in(root, ARGS, "not-json", USER);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(debug_text(root, "qwen-work-cn").contains("Failed to parse stdin JSON"));

        let transcript = root.join("session.jsonl");
        write_rows(&transcript, &real_shape());
        let path = transcript.to_string_lossy().into_owned();
        let stop = json!({
            "hook_event_name": "Stop",
            "transcript_path": path,
            "session_id": "sess-qwen-1",
            "stop_hooks_active": true,
        })
        .to_string();
        let (code, stdout) = run_in(root, ARGS, &stop, USER);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(history(root).is_empty());
        assert!(debug_text(root, "qwen-work-cn").contains("stop_hooks_active=true"));
        assert!(!root.join("state/hooks/qwen-work-cn-line-records").exists());

        let missing = json!({
            "hook_event_name": "Stop",
            "transcript_path": root.join("missing.jsonl").to_string_lossy(),
            "session_id": "sess-qwen-1",
        })
        .to_string();
        let (code, stdout) = run_in(root, ARGS, &missing, USER);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(debug_text(root, "qwen-work-cn").contains("Transcript file not found"));
    }

    #[test]
    fn cold_start_groups_tool_steps_and_second_run_is_idle() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("session.jsonl");
        write_rows(&transcript, &real_shape());
        let path = transcript.to_string_lossy().into_owned();
        let stdin = payload(&path, "sess-qwen-1", "/fallback");
        let (code, stdout) = run_in(root, ARGS, &stdin, USER);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let events = history(root);
        assert_eq!(
            names(&events),
            vec![
                "other",
                "llm.request",
                "llm.response",
                "tool.call",
                "tool.result",
                "llm.request",
                "llm.response",
                "tool.call",
                "tool.result",
                "llm.request",
                "llm.response",
            ]
        );
        assert!(events.iter().all(|event| {
            event["gen_ai.agent.type"] == "qwen-work-cn"
                && event["gen_ai.provider.name"] == "qwen"
                && event["gen_ai.turn.id"] == "prompt-turn-1"
                && event["agent.qwenworkcn.version"] == "0.1.5"
                && event["agent.qwenworkcn.cwd"] == "/workspace"
                && event["user.id"] == "user-1"
                && event["agent.source"] == "qwen-work-cn-transcript-hook"
                && event.get("version").is_none()
                && event["agent.transcript.cursor_mode"] == "bootstrap"
                && event["agent.transcript.cursor_reason"] == "missing-cursor"
        }));
        let keys: Vec<_> = events[0].as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            vec![
                "event.id",
                "agent.source",
                "agent.qwenworkcn.promptId",
                "event.name",
                "gen_ai.turn.id",
                "gen_ai.session.id",
                "gen_ai.agent.type",
                "gen_ai.provider.name",
                "user.id",
                "gen_ai.input.messages_delta",
                "time_unix_nano",
                "observed_time_unix_nano",
                "agent.qwenworkcn.cwd",
                "agent.qwenworkcn.raw_type",
                "agent.qwenworkcn.version",
                "agent.transcript.cursor_mode",
                "agent.transcript.cursor_reason",
                "agent.transcript.cursor_batch_id",
            ]
        );
        assert_eq!(
            events[0]["event.id"],
            "af200e19f36b88eac2efc28d50ddeea6e1ffe5fd63fb291d1125ab0c247543c6"
        );
        assert_eq!(
            events[0]["gen_ai.input.messages_delta"][0]["parts"][0]["content"],
            "<system-reminder>workspace context</system-reminder>\ninspect package.json"
        );
        assert_eq!(events[0]["time_unix_nano"], "1785987898934000000");
        assert_eq!(events[1]["time_unix_nano"], "1785987898934000000");
        assert_eq!(events[1]["gen_ai.request.id"], "response-1:request");
        assert_eq!(events[1]["gen_ai.request.model"], "qwork-advanced");
        assert_eq!(events[2]["time_unix_nano"], "1785987903994000000");
        assert_eq!(
            events[2]["gen_ai.output.messages"][0]["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["reasoning", "tool_call"]
        );
        assert_eq!(
            events[2]["gen_ai.response.finish_reasons"],
            json!(["tool_calls"])
        );
        assert_eq!(
            events[4]["gen_ai.tool.call.result"],
            json!(["package.json"])
        );
        assert_eq!(events[4]["tool.result.status"], "success");
        assert_eq!(events[4]["agent.qwenworkcn.raw_type"], "user");
        assert_eq!(events[4]["time_unix_nano"], "1785987904099000000");
        assert_eq!(
            events[4]["event.id"],
            "8f4558b5309d0a9317b854811cfa86917b9f1623bffe7473eca0d3c5bc640695"
        );
        let request_roles = |event: &Value| {
            event["gen_ai.input.messages_delta"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["role"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(request_roles(&events[1]), vec!["user"]);
        assert_eq!(request_roles(&events[5]), vec!["assistant", "tool"]);
        assert_eq!(request_roles(&events[9]), vec!["assistant", "tool"]);
        assert_eq!(events[5]["time_unix_nano"], "1785987904099000000");
        assert_eq!(
            events[5]["gen_ai.input.messages_delta"][0]["parts"][0]["id"],
            "call-1"
        );
        assert_eq!(
            events[5]["gen_ai.input.messages_delta"][1]["parts"][0]["response"],
            json!(["package.json"])
        );
        assert_eq!(events[8]["gen_ai.tool.call.result"], "{\"name\":\"pilot\"}");
        assert_eq!(events[9]["time_unix_nano"], "1785987908776000000");
        assert_eq!(
            events[10]["gen_ai.output.messages"][0]["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["reasoning", "text"]
        );
        assert_eq!(
            events[10]["gen_ai.response.finish_reasons"],
            json!(["end_turn"])
        );
        assert_eq!(events[10]["time_unix_nano"], "1785987914512000000");
        let steps: Vec<_> = events
            .iter()
            .filter(|event| event["event.name"] != "other")
            .map(|event| event["gen_ai.step.id"].as_str().unwrap())
            .collect();
        assert_eq!(
            steps,
            vec![
                "prompt-turn-1:s1",
                "prompt-turn-1:s1",
                "prompt-turn-1:s1",
                "prompt-turn-1:s1",
                "prompt-turn-1:s2",
                "prompt-turn-1:s2",
                "prompt-turn-1:s2",
                "prompt-turn-1:s2",
                "prompt-turn-1:s3",
                "prompt-turn-1:s3",
            ]
        );
        let batch = events[0]["agent.transcript.cursor_batch_id"]
            .as_str()
            .unwrap();
        assert_eq!(batch.len(), 36);
        assert!(events
            .iter()
            .all(|event| event["agent.transcript.cursor_batch_id"] == batch));
        let observed = events[0]["observed_time_unix_nano"].as_str().unwrap();
        assert!(observed.ends_with("000000"));
        assert!(events
            .iter()
            .all(|event| event["observed_time_unix_nano"] == observed));
        let cursor_path = session_record_path(root, "qwen-work-cn", "sess-qwen-1");
        let cursor: Value =
            serde_json::from_str(&fs::read_to_string(&cursor_path).unwrap()).unwrap();
        assert_eq!(cursor["last_line_count"], 9);
        assert_eq!(cursor["transcript_path"], path);
        let aggregate: Value = serde_json::from_str(
            &fs::read_to_string(root.join("state/hooks/qwen-work-cn-line-records.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(aggregate[&path]["last_line_count"], 9);
        assert!(aggregate[&path].get("transcript_path").is_none());
        let legacy: Value = serde_json::from_str(
            &fs::read_to_string(root.join("hooks/.line_records.qwen-work-cn.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(legacy[&path]["session_id"], "sess-qwen-1");
        assert!(!root
            .join("state/hooks/qwen-work-cn-line-records.json.lock")
            .exists());
        let debug = debug_text(root, "qwen-work-cn");
        assert!(debug.contains("Range: 0 -> 9 (missing-cursor)"));
        assert!(debug.contains("Mapped 11 QwenWorkCN event(s)"));
        assert!(debug.contains("Appended 11 rows"));

        let (code, stdout) = run_in(root, ARGS, &stdin, USER);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert_eq!(history(root).len(), 11);
        assert!(debug_text(root, "qwen-work-cn").contains("No new lines (count: 9)"));
    }

    #[test]
    fn missing_cursor_keeps_only_the_last_turn() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("turns.jsonl");
        write_rows(&transcript, &two_turns());
        let stdin = payload(&transcript.to_string_lossy(), "sess", "/fallback");
        let (code, stdout) = run_in(root, ARGS, &stdin, USER);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let events = history(root);
        assert!(events.iter().all(|event| event["gen_ai.turn.id"] == "t2"));
        assert!(events
            .iter()
            .all(|event| event["agent.transcript.cursor_mode"] == "bootstrap"
                && event["agent.transcript.cursor_reason"] == "missing-cursor"));
        assert!(events
            .iter()
            .all(|event| event["gen_ai.provider.name"] == "qwen"));
        assert_eq!(events.len(), 3);
        assert!(!events
            .iter()
            .any(|event| event.to_string().contains("hidden sidechain")
                || event.to_string().contains("\"one\"")));
    }

    #[test]
    fn zero_cursor_is_incremental_and_keeps_every_turn() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("turns.jsonl");
        write_rows(&transcript, &two_turns());
        let path = transcript.to_string_lossy().into_owned();
        let cursor = session_record_path(root, "qwen-work-cn", "sess");
        fs::create_dir_all(cursor.parent().unwrap()).unwrap();
        fs::write(
            &cursor,
            serde_json::to_string_pretty(&json!({
                "session_id": "sess",
                "transcript_path": path,
                "last_line_count": 0,
                "updated_at": "2026-01-01 00:00:00",
            }))
            .unwrap(),
        )
        .unwrap();
        let (code, _) = run_in(root, ARGS, &payload(&path, "sess", "/fallback"), USER);
        assert_eq!(code, 0);
        let events = history(root);
        let turns: Vec<_> = events
            .iter()
            .map(|event| event["gen_ai.turn.id"].as_str().unwrap())
            .collect();
        assert!(turns.contains(&"t1"));
        assert!(turns.contains(&"t2"));
        assert!(!turns.contains(&"side"));
        assert!(!turns.contains(&"sys"));
        assert!(events.iter().all(|event| {
            event["agent.transcript.cursor_mode"] == "incremental"
                && event["agent.transcript.cursor_reason"] == "incremental"
        }));
        assert_eq!(
            events
                .iter()
                .find(
                    |event| event["gen_ai.turn.id"] == "t1" && event["event.name"] == "llm.request"
                )
                .unwrap()["gen_ai.provider.name"],
            "anthropic"
        );
    }

    #[test]
    fn aggregate_and_legacy_shadows_restore_incremental_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("turns.jsonl");
        write_rows(&transcript, &two_turns());
        let path = transcript.to_string_lossy().into_owned();
        fs::create_dir_all(root.join("state/hooks")).unwrap();
        fs::write(
            root.join("state/hooks/qwen-work-cn-line-records.json"),
            shadow_json(&path, 0, "2026-07-22 10:00:00"),
        )
        .unwrap();
        let _ = run_in(root, ARGS, &payload(&path, "sess", "/workspace"), USER);
        let events = history(root);
        assert!(events.iter().any(|event| event["gen_ai.turn.id"] == "t1"));
        assert!(events
            .iter()
            .all(|event| event["agent.transcript.cursor_reason"] == "incremental"));

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("turns.jsonl");
        write_rows(&transcript, &two_turns());
        let path = transcript.to_string_lossy().into_owned();
        fs::create_dir_all(root.join("hooks")).unwrap();
        fs::write(
            root.join("hooks/.line_records.qwen-work-cn.json"),
            shadow_json(&path, 0, "2026-07-22 10:00:00"),
        )
        .unwrap();
        let _ = run_in(root, ARGS, &payload(&path, "sess", "/workspace"), USER);
        let events = history(root);
        assert!(events.iter().any(|event| event["gen_ai.turn.id"] == "t1"));
        assert!(events
            .iter()
            .all(|event| event["agent.transcript.cursor_reason"] == "incremental"));
    }

    #[test]
    fn same_transcript_shadow_does_not_rewind_line_count() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("turns.jsonl");
        write_rows(&transcript, &two_turns());
        let path = transcript.to_string_lossy().into_owned();
        let cursor = session_record_path(root, "qwen-work-cn", "sess");
        fs::create_dir_all(cursor.parent().unwrap()).unwrap();
        fs::write(
            &cursor,
            serde_json::to_string_pretty(&json!({
                "session_id": "sess",
                "transcript_path": path,
                "last_line_count": 5,
                "updated_at": "2026-07-22 10:00:00",
            }))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(root.join("state/hooks")).unwrap();
        fs::write(
            root.join("state/hooks/qwen-work-cn-line-records.json"),
            shadow_json(&path, 0, "2026-07-22 12:00:00"),
        )
        .unwrap();
        let _ = run_in(root, ARGS, &payload(&path, "sess", "/workspace"), USER);
        let events = history(root);
        assert!(events.iter().all(|event| event["gen_ai.turn.id"] == "t2"));
        assert!(events
            .iter()
            .all(|event| event["agent.transcript.cursor_reason"] == "incremental"));
    }

    #[test]
    fn transcript_change_bootstraps_from_the_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("turns.jsonl");
        write_rows(&transcript, &two_turns());
        let path = transcript.to_string_lossy().into_owned();
        let cursor = session_record_path(root, "qwen-work-cn", "sess");
        fs::create_dir_all(cursor.parent().unwrap()).unwrap();
        fs::write(
            &cursor,
            serde_json::to_string_pretty(&json!({
                "session_id": "sess",
                "transcript_path": "/other/old.jsonl",
                "last_line_count": 5,
                "updated_at": "2026-07-22 10:00:00",
            }))
            .unwrap(),
        )
        .unwrap();
        let _ = run_in(root, ARGS, &payload(&path, "sess", "/workspace"), USER);
        let events = history(root);
        assert!(events.iter().all(|event| {
            event["gen_ai.turn.id"] == "t2"
                && event["agent.transcript.cursor_mode"] == "bootstrap"
                && event["agent.transcript.cursor_reason"] == "transcript-changed"
        }));
        assert!(debug_text(root, "qwen-work-cn").contains("Transcript changed for session sess"));
    }

    #[test]
    fn review_copy_advances_cursor_without_history_rows() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut rows = real_shape();
        rows.push(json!({
            "type": "user",
            "sessionId": "sess-qwen-1",
            "uuid": "review-task",
            "timestamp": "2026-08-06T03:45:15.000Z",
            "message": {"content": [{
                "type": "text",
                "text": "[SYSTEM: This is an automated background review task. Review the preceding conversation.]"
            }]}
        }));
        let transcript = root.join("review.jsonl");
        write_rows(&transcript, &rows);
        let path = transcript.to_string_lossy().into_owned();
        let (code, stdout) = run_in(
            root,
            ARGS,
            &payload(&path, "sess-qwen-1", "/workspace"),
            USER,
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(history(root).is_empty());
        let cursor: Value = serde_json::from_str(
            &fs::read_to_string(session_record_path(root, "qwen-work-cn", "sess-qwen-1")).unwrap(),
        )
        .unwrap();
        assert_eq!(cursor["last_line_count"], 10);
        let debug = debug_text(root, "qwen-work-cn");
        assert!(debug.contains("Skipping review-copy session sess-qwen-1"));
        assert!(debug.contains("Mapped 0 QwenWorkCN event(s)"));
    }

    #[test]
    fn blank_lines_advance_cursor_without_mapped_log() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("blank.jsonl");
        fs::write(&transcript, "\n\n").unwrap();
        let path = transcript.to_string_lossy().into_owned();
        let (code, stdout) = run_in(
            root,
            ARGS,
            &payload(&path, "blank-sess", "/workspace"),
            USER,
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(history(root).is_empty());
        let cursor: Value = serde_json::from_str(
            &fs::read_to_string(session_record_path(root, "qwen-work-cn", "blank-sess")).unwrap(),
        )
        .unwrap();
        assert_eq!(cursor["last_line_count"], 2);
        let debug = debug_text(root, "qwen-work-cn");
        assert!(debug.contains("Updated record"));
        assert!(!debug.contains("Mapped "));
    }

    #[test]
    fn unmatched_tool_result_splits_steps_without_carrying_input() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("split.jsonl");
        write_rows(
            &transcript,
            &[
                json!({
                    "type": "user",
                    "promptId": "p",
                    "sessionId": "s",
                    "timestamp": "2026-08-06T03:44:58.000Z",
                    "cwd": "/workspace",
                    "message": {"content": "q"}
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-08-06T03:44:59.000Z",
                    "message": {"id": "m1", "model": "unknown-model", "content": [{"type": "text", "text": "partial"}]}
                }),
                json!({
                    "type": "user",
                    "timestamp": "2026-08-06T03:45:00.000Z",
                    "message": {"content": [{"type": "tool_result", "tool_use_id": "missing", "content": "x"}]}
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-08-06T03:45:01.000Z",
                    "message": {"id": "m2", "content": [{"type": "text", "text": "end"}]}
                }),
            ],
        );
        let _ = run_in(
            root,
            ARGS,
            &payload(&transcript.to_string_lossy(), "s", "/workspace"),
            USER,
        );
        let events = history(root);
        assert_eq!(
            names(&events),
            vec![
                "other",
                "llm.request",
                "llm.response",
                "llm.request",
                "llm.response"
            ]
        );
        assert_eq!(events[2]["gen_ai.response.finish_reasons"], json!(["stop"]));
        assert!(events[3].get("gen_ai.input.messages_delta").is_none());
        assert_eq!(events[3]["gen_ai.request.model"], "unknown");
        assert_eq!(
            events[4]["gen_ai.response.finish_reasons"],
            json!(["end_turn"])
        );
        assert_eq!(events[1]["gen_ai.step.id"], "p:s1");
        assert_eq!(events[3]["gen_ai.step.id"], "p:s2");
    }

    #[test]
    fn tool_use_result_null_arguments_and_provider_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("tools.jsonl");
        write_rows(
            &transcript,
            &[
                json!({
                    "type": "user",
                    "promptId": "p",
                    "sessionId": "s",
                    "userId": "row-user",
                    "timestamp": "2026-08-06T03:44:58.934Z",
                    "cwd": "/workspace",
                    "message": {"content": "run"}
                }),
                json!({
                    "type": "user",
                    "timestamp": "2026-08-06T03:44:59.000Z",
                    "message": {"content": "[Request interrupted by user]"}
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-08-06T03:45:00.000Z",
                    "message": {"id": "mid", "model": "deepseek-r1", "content": [
                        {"type": "tool_use", "id": "a", "name": "Bash", "input": {"cmd": 1, "drop": null, "keep": false}},
                        {"type": "tool_use", "id": "b", "name": "Bash", "input": {}}
                    ]}
                }),
                json!({
                    "type": "user",
                    "timestamp": "2026-08-06T03:45:01.000Z",
                    "toolUseResult": {"stdout": "out"},
                    "message": {"content": [
                        {"type": "tool_result", "tool_use_id": "a", "content": "ignored", "is_error": true},
                        {"type": "tool_result", "tool_use_id": "a", "content": "second"},
                        {"type": "tool_result", "tool_use_id": "b", "content": "ok", "is_error": false}
                    ]}
                }),
                json!({
                    "type": "assistant",
                    "timestamp": "2026-08-06T03:45:02.000Z",
                    "message": {"model": "gemini-2", "content": "done"}
                }),
            ],
        );
        let _ = run_in(
            root,
            ARGS,
            &payload(&transcript.to_string_lossy(), "s", "/fallback"),
            USER,
        );
        let events = history(root);
        assert_eq!(events[0]["user.id"], "row-user");
        assert_eq!(events[1]["gen_ai.provider.name"], "deepseek");
        assert_eq!(
            events
                .iter()
                .find(|event| event["event.name"] == "tool.call"
                    && event["gen_ai.tool.call.id"] == "a")
                .unwrap()["gen_ai.tool.call.arguments"],
            json!({"cmd": 1, "keep": false})
        );
        let empty_call = events
            .iter()
            .find(|event| event["event.name"] == "tool.call" && event["gen_ai.tool.call.id"] == "b")
            .unwrap();
        assert!(empty_call.get("gen_ai.tool.call.arguments").is_none());
        let results: Vec<_> = events
            .iter()
            .filter(|event| event["event.name"] == "tool.result")
            .collect();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["tool.result.status"], "failure");
        assert_eq!(results[1]["tool.result.status"], "success");
        assert_eq!(
            results[0]["gen_ai.tool.call.result"],
            json!({"stdout": "out"})
        );
        assert_eq!(
            results[1]["gen_ai.tool.call.result"],
            json!({"stdout": "out"})
        );
        let last_request = events
            .iter()
            .rfind(|event| event["event.name"] == "llm.request")
            .unwrap();
        assert_eq!(last_request["gen_ai.provider.name"], "gcp.gemini");
        assert_eq!(last_request["gen_ai.request.model"], "gemini-2");
        assert_eq!(
            last_request["gen_ai.input.messages_delta"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["assistant", "tool"]
        );
    }

    #[test]
    fn conversation_id_payload_cwd_and_log_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("conv.jsonl");
        write_rows(
            &transcript,
            &[
                json!({
                    "type": "user",
                    "promptId": "p",
                    "timestamp": "2026-08-07T08:00:00.000Z",
                    "message": {"content": "hello"}
                }),
                json!({
                    "type": "assistant",
                    "parentUuid": "",
                    "uuid": "only-uuid",
                    "timestamp": "2026-08-07T08:00:01.000Z",
                    "message": {"content": "answer"}
                }),
            ],
        );
        let stdin = json!({
            "hook_event_name": "Stop",
            "transcript_path": transcript.to_string_lossy(),
            "conversation_id": "conv-1",
            "cwd": "/from-hook",
        })
        .to_string();
        let (code, stdout) = run_in(
            root,
            &[
                "--agent-id",
                "qwen-work-cn",
                "--log-prefix",
                "custom-prefix",
            ],
            &stdin,
            USER,
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let events = history(root);
        assert_eq!(events[0]["gen_ai.session.id"], "conv-1");
        assert_eq!(events[0]["agent.qwenworkcn.cwd"], "/from-hook");
        assert_eq!(
            events
                .iter()
                .find(|event| event["event.name"] == "llm.request")
                .unwrap()["gen_ai.request.id"],
            "only-uuid:request"
        );
        assert_eq!(
            events
                .iter()
                .find(|event| event["event.name"] == "llm.response")
                .unwrap()["gen_ai.output.messages"][0]["parts"][0]["content"],
            "answer"
        );
        let names: Vec<_> = fs::read_dir(root.join("logs/qwen-work-cn/history"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names
            .iter()
            .any(|name| name.starts_with("custom-prefix-") && name.ends_with(".jsonl")));
        assert!(debug_text(root, "qwen-work-cn").contains("event: Stop, session: "));
    }

    #[test]
    fn excluded_workspace_advances_cursor_without_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("config.json"),
            r#"{"privacy":{"excludeWorkspaces":["/workspace"]}}"#,
        )
        .unwrap();
        let transcript = root.join("session.jsonl");
        write_rows(&transcript, &real_shape());
        let path = transcript.to_string_lossy().into_owned();
        let (code, stdout) = run_in(
            root,
            ARGS,
            &payload(&path, "sess-qwen-1", "/workspace"),
            USER,
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(history(root).is_empty());
        let cursor: Value = serde_json::from_str(
            &fs::read_to_string(session_record_path(root, "qwen-work-cn", "sess-qwen-1")).unwrap(),
        )
        .unwrap();
        assert_eq!(cursor["last_line_count"], 9);
        let debug = debug_text(root, "qwen-work-cn");
        assert!(debug.contains("Mapped 11 QwenWorkCN event(s)"));
        assert!(!debug.contains("Appended "));
    }

    #[test]
    fn invalid_privacy_config_does_not_advance_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("config.json"), "{").unwrap();
        let transcript = root.join("session.jsonl");
        write_rows(&transcript, &real_shape());
        let path = transcript.to_string_lossy().into_owned();
        let (code, stdout) = run_in(
            root,
            ARGS,
            &payload(&path, "sess-qwen-1", "/workspace"),
            USER,
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(history(root).is_empty());
        assert!(!session_record_path(root, "qwen-work-cn", "sess-qwen-1").exists());
        assert!(debug_text(root, "qwen-work-cn").contains(PRIVACY_ERROR));
    }
    #[test]
    fn history_qwen_three_native_run_and_real_converter_keep_all_original_step_and_input_assertions(
    ) {
        use crate::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
        use crate::types::AgentActivityEntry;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("session.jsonl");
        write_rows(&transcript, &real_shape());
        let path = transcript.to_string_lossy().into_owned();
        let (code, stdout) = run_in(
            root,
            ARGS,
            &payload(&path, "sess-qwen-1", "/fallback"),
            USER,
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let events = history(root);
        assert_eq!(
            names(&events),
            [
                "other",
                "llm.request",
                "llm.response",
                "tool.call",
                "tool.result",
                "llm.request",
                "llm.response",
                "tool.call",
                "tool.result",
                "llm.request",
                "llm.response"
            ]
        );
        assert!(events
            .iter()
            .all(|event| event["gen_ai.agent.type"] == "qwen-work-cn"
                && event.get("version").is_none()
                && event["agent.qwenworkcn.version"] == "0.1.5"
                && event["gen_ai.turn.id"] == "prompt-turn-1"));
        assert_eq!(
            events[0]["gen_ai.input.messages_delta"][0]["parts"][0]["content"],
            "<system-reminder>workspace context</system-reminder>\ninspect package.json"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["event.name"] != "other")
                .map(|event| event["gen_ai.step.id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "prompt-turn-1:s1",
                "prompt-turn-1:s1",
                "prompt-turn-1:s1",
                "prompt-turn-1:s1",
                "prompt-turn-1:s2",
                "prompt-turn-1:s2",
                "prompt-turn-1:s2",
                "prompt-turn-1:s2",
                "prompt-turn-1:s3",
                "prompt-turn-1:s3"
            ]
        );
        let requests = events
            .iter()
            .filter(|event| event["event.name"] == "llm.request")
            .collect::<Vec<_>>();
        let responses = events
            .iter()
            .filter(|event| event["event.name"] == "llm.response")
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 3);
        assert_eq!(responses.len(), 3);
        assert_eq!(
            requests
                .iter()
                .map(|event| event["gen_ai.input.messages_delta"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|message| message["role"].as_str().unwrap())
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            [
                vec!["user"],
                vec!["assistant", "tool"],
                vec!["assistant", "tool"]
            ]
        );
        assert_eq!(
            responses
                .iter()
                .map(|event| event["gen_ai.output.messages"][0]["parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|part| part["type"].as_str().unwrap())
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            [
                vec!["reasoning", "tool_call"],
                vec!["reasoning", "tool_call"],
                vec!["reasoning", "text"]
            ]
        );
        let records = events
            .into_iter()
            .map(|event| serde_json::from_value::<AgentActivityEntry>(event).unwrap())
            .collect::<Vec<_>>();
        let conversion = GenAiEventLogConverter
            .convert(&records, &ConvertOptions::default())
            .unwrap();
        assert_eq!(conversion.warnings, Vec::<String>::new());
        for (kind, count) in [("STEP", 3), ("LLM", 3), ("TOOL", 2)] {
            assert_eq!(
                conversion
                    .spans
                    .iter()
                    .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!(kind)))
                    .count(),
                count
            );
        }
        let mut llms = conversion
            .spans
            .iter()
            .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
            .collect::<Vec<_>>();
        llms.sort_by_key(|span| span.start_time);
        assert!(llms
            .iter()
            .all(|span| span.duration[0] > 0 || span.duration[1] > 0));
        let inputs = llms
            .iter()
            .map(|span| match &span.attributes["gen_ai.input.messages"] {
                Value::String(text) => serde_json::from_str::<Value>(text).unwrap(),
                value => value.clone(),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            inputs
                .iter()
                .map(|messages| messages
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|message| message["role"].as_str().unwrap())
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            [
                vec!["user"],
                vec!["user", "assistant", "tool"],
                vec!["user", "assistant", "tool", "assistant", "tool"]
            ]
        );
        assert_eq!(inputs[1][1]["parts"][0]["type"], "tool_call");
        assert_eq!(inputs[1][1]["parts"][0]["id"], "call-1");
        assert_eq!(inputs[1][1]["parts"][0]["name"], "Glob");
        assert_eq!(inputs[1][2]["parts"][0]["type"], "tool_call_response");
        assert_eq!(inputs[1][2]["parts"][0]["id"], "call-1");
    }

    #[test]
    fn history_qwen_review_copy_suppresses_both_incremental_and_missing_cursor_real_runs() {
        for incremental in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let transcript = root.join("review-copy.jsonl");
            let mut rows = real_shape();
            rows.extend([
                json!({"type":"user","uuid":"review-task","parentUuid":"text-3","timestamp":"2026-08-06T03:45:15.000Z","message":{"role":"user","content":[{"type":"text","text":"[SYSTEM: This is an automated background review task. Review the preceding conversation.]"}]}}),
                json!({"type":"assistant","uuid":"review-response","parentUuid":"review-task","timestamp":"2026-08-06T03:45:16.000Z","message":{"role":"assistant","id":"review-response","model":"qwork-advanced","content":[{"type":"text","text":"The review is complete."}]}}),
            ]);
            write_rows(&transcript, &rows);
            let path = transcript.to_string_lossy().into_owned();
            if incremental {
                let cursor = session_record_path(root, "qwen-work-cn", "sess-qwen-1");
                fs::create_dir_all(cursor.parent().unwrap()).unwrap();
                fs::write(cursor,json!({"session_id":"sess-qwen-1","transcript_path":path,"last_line_count":0,"updated_at":"2026-07-22 10:00:00"}).to_string()).unwrap();
            }
            let (code, stdout) = run_in(
                root,
                ARGS,
                &payload(&path, "sess-qwen-1", "/fallback"),
                USER,
            );
            assert_eq!(code, 0);
            assert_eq!(stdout, "{}\n");
            assert!(history(root).is_empty());
            let cursor: Value = serde_json::from_str(
                &fs::read_to_string(session_record_path(root, "qwen-work-cn", "sess-qwen-1"))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(cursor["last_line_count"], 11);
            let debug = debug_text(root, "qwen-work-cn");
            assert!(debug.contains(if incremental {
                "(incremental)"
            } else {
                "(missing-cursor)"
            }));
        }
    }
}
