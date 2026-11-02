//! Claude Code hook process. Port of the v2 dispatcher in
//! `assets/hooks/claude-code-hook-processor.mjs`.
//!
//! Stop / StopFailure export a transcript into daily JSONL. PreToolUse can
//! reserve a Bash traceparent. Direct subagent transcripts, intercept and
//! attempt files, and synthetic skill loads are merged into that export.
//! Input-message hashes chain across steps. An empty parse retries five times.
//! Transcript reads larger than 50MB keep only the tail.

use super::common::{
    agent_name_patch, collect_resource_attributes, data_dir, iso_now, iso_to_unix_nanos,
    json_number, load_runtime_config, log_hook_error, parse_json_object, parse_span_attributes,
    parse_traceparent, random_hex, record_upstream_context_once, safe_path_part, sanitize_record,
    sanitize_session_id, sha256_hex, shell_single_quote, write_empty, write_json,
    write_jsonl_records, Env, HookRequest, Obj,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[path = "claude_skill.rs"]
mod claude_skill;

const FINALIZED_SUBAGENT_LIMIT: usize = 128;
pub(super) const INTERCEPT_STALE_MS: u128 = 60 * 60 * 1000;
pub(super) const MAX_ATTEMPT_FILES: usize = 500;
pub(super) const MAX_ATTEMPT_BYTES: u64 = 16 * 1024 * 1024;

const AGENT_ID: &str = "claude-code";
const INITIAL_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb924";
const MAX_TRANSCRIPT_BYTES: u64 = 50 * 1024 * 1024;

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let subcommand = request
        .args
        .first()
        .map(String::as_str)
        .unwrap_or("unknown");
    let emitted = match subcommand {
        "pre-tool-use" => cmd_pre_tool(request),
        "stop" => {
            cmd_terminal(request, false);
            false
        }
        "stop-failure" => {
            cmd_terminal(request, true);
            false
        }
        "subagent-start" => {
            cmd_subagent_start(request);
            false
        }
        "subagent-stop" => {
            cmd_subagent_stop(request);
            false
        }
        _ => false,
    };
    if !emitted {
        write_empty(request.stdout);
    }
    0
}

fn read_event(bytes: &[u8]) -> Obj {
    parse_json_object(bytes).unwrap_or_default()
}

fn cursor_caller(event: &Obj) -> bool {
    event
        .get("cursor_version")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn require_session(env: &Env, event: &Obj, stage: &str) -> Option<String> {
    match event
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        Some(session) => Some(session.to_string()),
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

fn cmd_pre_tool(request: &mut HookRequest<'_>) -> bool {
    let event = read_event(request.stdin);
    if cursor_caller(&event) {
        return false;
    }
    let Some(session_id) = require_session(request.env, &event, "pre_tool_use") else {
        return false;
    };
    if non_empty(&event, "agent_id") || non_empty(&event, "agent_type") {
        return false;
    }
    if event.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return false;
    }
    let Some(tool_use_id) = event
        .get("tool_use_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let runtime = load_runtime_config(request.env);
    if !runtime.upstream_enabled || !runtime.propagate_to_tools {
        return false;
    }
    let prompt_id = event.get("prompt_id").and_then(Value::as_str).unwrap_or("");
    let context = reserve_tool_context(
        request.env,
        &session_id,
        prompt_id,
        tool_use_id,
        runtime.generate_trace_when_missing,
    );
    let updated = build_bash_updated_input(
        event.get("tool_input"),
        context.as_ref().map(|item| item.traceparent.as_str()),
        context.as_ref().and_then(|item| item.tracestate.as_deref()),
        request
            .env
            .get("LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES")
            .map(String::as_str),
    );
    let Some(updated) = updated else { return false };
    write_json(
        request.stdout,
        &json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": updated,
            }
        }),
    );
    true
}

fn cmd_terminal(request: &HookRequest<'_>, failure: bool) {
    let event = read_event(request.stdin);
    if cursor_caller(&event) {
        return;
    }
    let Some(session_id) = require_session(request.env, &event, "cmd") else {
        return;
    };
    record_upstream_context_once(request.env, AGENT_ID, &session_id);
    let runtime = load_runtime_config(request.env);
    if runtime.upstream_enabled && runtime.propagate_to_tools {
        mark_tool_propagation_consumed(request.env, &session_id);
    }
    let export_result = with_state_lock(request.env, &session_id, || {
        let mut state = load_state(request.env, &session_id);
        if state
            .get("transcript_path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
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
        let now_sec = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64())
            .unwrap_or(0.0);
        state.insert("stop_time".into(), json!(now_sec));
        let _ = save_state(request.env, &session_id, &state);
        let prompt_id = event.get("prompt_id").and_then(Value::as_str).unwrap_or("");
        let stop_reason = if failure {
            "error"
        } else {
            event
                .get("stop_reason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn")
        };
        if let Err(err) = export_session(request.env, &mut state, stop_reason, prompt_id) {
            log_hook_error(
                request.env,
                AGENT_ID,
                if failure {
                    "cmd_stop_failure"
                } else {
                    "cmd_stop"
                },
                "export_failed",
                &err,
            );
            return;
        }
        state.insert("events".into(), Value::Array(Vec::new()));
        state.remove("stop_time");
        let _ = save_state(request.env, &session_id, &state);
    });
    if let Err(err) = export_result {
        log_hook_error(request.env, AGENT_ID, "cmd", "state_lock", &err);
    }
}

fn cmd_subagent_start(request: &HookRequest<'_>) {
    let event = read_event(request.stdin);
    if cursor_caller(&event) {
        return;
    }
    let Some(session_id) = require_session(request.env, &event, "cmd") else {
        return;
    };
    let _ = with_state_lock(request.env, &session_id, || {
        let mut state = load_state(request.env, &session_id);
        remember_paths(&mut state, &event, true);
        let mut events = state
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        events.push(json!({
            "type": "subagent_start",
            "timestamp": now_sec(),
            "subagent_session_id": event.get("subagent_session_id").and_then(Value::as_str).unwrap_or(""),
            "agent_id": event.get("agent_id").and_then(Value::as_str).unwrap_or(""),
            "agent_type": event.get("agent_type").and_then(Value::as_str).unwrap_or(""),
        }));
        state.insert("events".into(), Value::Array(events));
        let _ = save_state(request.env, &session_id, &state);
    });
}

fn cmd_subagent_stop(request: &HookRequest<'_>) {
    let event = read_event(request.stdin);
    if cursor_caller(&event) {
        return;
    }
    let Some(session_id) = require_session(request.env, &event, "cmd") else {
        return;
    };
    let _ = with_state_lock(request.env, &session_id, || {
        let mut state = load_state(request.env, &session_id);
        remember_paths(&mut state, &event, true);
        let agent_id = event
            .get("agent_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                event
                    .get("subagent_session_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("")
            .to_string();
        let child_sid = event
            .get("subagent_session_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string();
        let child_state =
            if !child_sid.is_empty() && child_sid != "unknown" && child_sid != session_id {
                read_and_delete_child_state(request.env, &child_sid)
            } else {
                None
            };
        let finalized = string_list(state.get("finalized_subagent_ids"));
        if !agent_id.is_empty() && !finalized.iter().any(|id| id == &agent_id) {
            let completed = state
                .entry("completed_subagents")
                .or_insert_with(|| Value::Object(Obj::new()));
            if let Some(completed) = completed.as_object_mut() {
                completed.insert(agent_id.clone(), Value::Bool(true));
            }
        }
        let mut ev = json!({
            "type": "subagent_stop",
            "timestamp": now_sec(),
            "subagent_session_id": child_sid,
            "agent_id": agent_id,
            "agent_type": event.get("agent_type").and_then(Value::as_str).unwrap_or(""),
            "agent_transcript_path": event.get("agent_transcript_path").and_then(Value::as_str).unwrap_or(""),
            "stop_reason": event.get("stop_reason").and_then(Value::as_str).unwrap_or("end_turn"),
            "input_tokens": event_token(&event, "input_tokens"),
            "output_tokens": event_token(&event, "output_tokens"),
            "cache_read_input_tokens": event_token(&event, "cache_read_input_tokens"),
            "cache_creation_input_tokens": event_token(&event, "cache_creation_input_tokens"),
        });
        if let Some(child_state) = child_state {
            if child_state
                .get("events")
                .and_then(Value::as_array)
                .is_some_and(|events| !events.is_empty())
            {
                ev.as_object_mut()
                    .expect("event object")
                    .insert("_child_state".into(), Value::Object(child_state));
            }
        }
        let mut events = state
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        events.push(ev);
        state.insert("events".into(), Value::Array(events));
        claude_skill::finalize_pending_subagent_turns(request.env, &mut state);
        let _ = save_state(request.env, &session_id, &state);
    });
}

fn export_session(
    env: &Env,
    state: &mut Obj,
    _stop_reason: &str,
    stop_prompt_id: &str,
) -> Result<(), String> {
    let session_id = state
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let transcript_path = state
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if transcript_path.is_empty() {
        log_hook_error(
            env,
            AGENT_ID,
            "export",
            "missing_transcript_path",
            "no transcript_path in state; cannot export",
        );
        return Ok(());
    }
    let base_offset = number_u64(state.get("transcript_offset"));
    wait_for_transcript_stable(Path::new(&transcript_path), base_offset);
    if let Ok(meta) = fs::metadata(&transcript_path) {
        if meta.len() <= base_offset {
            state.insert("transcript_offset".into(), Value::from(base_offset));
            claude_skill::reap_stale_intercept(env, &session_id);
            return Ok(());
        }
    }
    let parsed = match parse_with_empty_retry(env, Path::new(&transcript_path), base_offset) {
        Some(parsed) => parsed,
        None => {
            claude_skill::reap_stale_intercept(env, &session_id);
            return Ok(());
        }
    };
    state.insert("transcript_offset".into(), Value::from(parsed.next_offset));
    if parsed.turns.is_empty() {
        claude_skill::reap_stale_intercept(env, &session_id);
        return Ok(());
    }
    let runtime = load_runtime_config(env);
    let resources = collect_resource_attributes(env, AGENT_ID);
    let span_attributes = parse_span_attributes(env, AGENT_ID, true);
    let base_count = number_u64(state.get("turn_count"));
    let is_first = base_count == 0 && base_offset == 0;
    let start = if is_first && parsed.turns.len() > 1 {
        parsed.turns.len() - 1
    } else {
        0
    };
    let prompt_fallback = if parsed.turns.len() == 1
        && parsed.turns.len() - start == 1
        && parsed.turns[start]
            .prompt_id
            .as_deref()
            .unwrap_or("")
            .is_empty()
    {
        stop_prompt_id
    } else {
        ""
    };
    let cwd = state
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let intercept = claude_skill::load_intercept_for_session(env, &session_id);
    let mut attempts = AttemptContext {
        records: claude_skill::load_attempt_records(env, &session_id),
        consumed: HashSet::new(),
    };
    let mut merged_response_ids = HashSet::new();
    let mut consumed_attempt_files = HashSet::new();
    let mut records = Vec::new();
    let mut pending = state
        .get("pending_subagent_turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut pending_touched = false;
    let mut completed = state
        .get("completed_subagents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut log_hash = INITIAL_HASH.to_string();
    for (offset, turn) in parsed.turns.iter().skip(start).enumerate() {
        let built = build_turn_records(
            RecordBuildContext {
                env,
                user_id: &runtime.user_id,
                cwd: cwd.as_deref(),
                resources: &resources,
                span_attributes: &span_attributes,
                intercept: &intercept,
                attempts: &mut attempts,
            },
            turn,
            base_count + offset as u64,
            &session_id,
            &log_hash,
            prompt_fallback,
        );
        log_hash = built.hash;
        merged_response_ids.extend(built.merged_response_ids);
        consumed_attempt_files.extend(built.consumed_attempt_files);
        let mut turn_records = built.records;
        let parent_trace = turn_records
            .first()
            .and_then(|record| record.get("trace_id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let parent_turn = turn_records
            .first()
            .and_then(|record| record.get("gen_ai.turn.id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut background = Vec::new();
        if !turn_records.is_empty() {
            for link in collect_subagent_links(turn) {
                let completion = js_object_truthy(&completed, &link.agent_id);
                if link.is_background && !completion {
                    background.push(link_value(&link, false));
                    continue;
                }
                let child = build_subagent_records(
                    RecordBuildContext {
                        env,
                        user_id: &runtime.user_id,
                        cwd: cwd.as_deref(),
                        resources: &resources,
                        span_attributes: &span_attributes,
                        intercept: &intercept,
                        attempts: &mut attempts,
                    },
                    &transcript_path,
                    &session_id,
                    &parent_trace,
                    &parent_turn,
                    &link,
                );
                if link.is_background {
                    extend_background_agent_result(
                        &mut turn_records,
                        &link.parent_tool_call_id,
                        &child.records,
                    );
                }
                turn_records.extend(child.records);
                merged_response_ids.extend(child.merged_response_ids);
                consumed_attempt_files.extend(child.consumed_attempt_files);
                if completion {
                    completed.remove(&link.agent_id);
                }
            }
        }
        sort_records(&mut turn_records);
        if !background.is_empty() && !parent_trace.is_empty() {
            pending.push(json!({
                "created_at": json_number(now_sec()),
                "trace_id": parent_trace,
                "turn_id": parent_turn,
                "records": turn_records.into_iter().map(|record| Value::Object(sanitize_record(record))).collect::<Vec<_>>(),
                "background_links": background,
            }));
            pending_touched = true;
        } else {
            records.extend(turn_records);
        }
    }
    state.insert(
        "turn_count".into(),
        Value::from(base_count + parsed.turns.len() as u64),
    );
    if pending_touched {
        state.insert("pending_subagent_turns".into(), Value::Array(pending));
    }
    if state.contains_key("completed_subagents") || !completed.is_empty() {
        state.insert("completed_subagents".into(), Value::Object(completed));
    }
    let cleaned: Vec<Obj> = records.into_iter().map(sanitize_record).collect();
    write_jsonl_records(
        env,
        &data_dir(env).join("logs").join(AGENT_ID),
        AGENT_ID,
        &cleaned,
    )?;
    claude_skill::reap_intercept_files(&intercept, &merged_response_ids);
    claude_skill::reap_attempt_files(&consumed_attempt_files);
    claude_skill::reap_stale_intercept(env, &session_id);
    Ok(())
}

fn wait_for_transcript_stable(path: &Path, min_size: u64) {
    let mut previous: i64 = -1;
    let mut stable = 0;
    for _ in 0..10 {
        let size = match fs::metadata(path) {
            Ok(meta) => meta.len(),
            Err(_) => return,
        };
        if size <= min_size {
            std::thread::sleep(Duration::from_millis(150));
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
        std::thread::sleep(Duration::from_millis(150));
    }
}

struct ParsedTranscript {
    turns: Vec<Turn>,
    next_offset: u64,
}

struct Turn {
    prompt_id: Option<String>,
    prompt: String,
    prompt_timestamp: Option<String>,
    llm_calls: Vec<LlmCall>,
    skill_loads: Vec<claude_skill::SkillLoad>,
}

struct LlmCall {
    timestamp: Option<String>,
    request_start: Option<String>,
    model: String,
    message_id: String,
    input_messages: Vec<Value>,
    output_content: Vec<Value>,
    stop_reason: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_create: i64,
    declared: Vec<String>,
    tools: HashMap<String, ToolDetail>,
    prompt_id: Option<String>,
    api_error: Option<ApiError>,
}

struct ToolDetail {
    call: Option<String>,
    result: Option<String>,
    result_content: Value,
    is_error: bool,
    agent_id: Option<String>,
    agent_type: String,
    status: String,
    is_async: bool,
}

struct ApiError {
    kind: String,
    status: Option<i64>,
    request_id: Option<String>,
}

enum Conv {
    User {
        content: Value,
        timestamp: Option<String>,
        prompt_id: Option<String>,
        is_meta: bool,
        skill_context: bool,
    },
    Assistant {
        msg_id: String,
    },
}

struct SubagentMeta {
    agent_id: String,
    agent_type: String,
    status: String,
    is_async: bool,
}

struct AssistantGroup {
    chunks: Vec<Value>,
    usage: Option<Value>,
    model: Option<String>,
    stop_reason: Option<String>,
    first_timestamp: Option<String>,
    tool_use_timestamps: HashMap<String, String>,
    prompt_id: Option<String>,
    api_error: Option<ApiError>,
}

fn parse_with_empty_retry(env: &Env, path: &Path, byte_offset: u64) -> Option<ParsedTranscript> {
    let mut parsed = None;
    for attempt in 0..5 {
        match parse_claude_transcript(path, byte_offset) {
            Ok(result) => {
                let done = !result.turns.is_empty();
                parsed = Some(result);
                if done {
                    break;
                }
            }
            Err(err) => {
                log_hook_error(env, AGENT_ID, "transcript_parse", "parse_failed", &err);
                break;
            }
        }
        if attempt + 1 < 5 {
            thread::sleep(Duration::from_millis(200));
            wait_for_transcript_stable(path, byte_offset);
        }
    }
    parsed
}

fn parse_claude_transcript(path: &Path, byte_offset: u64) -> Result<ParsedTranscript, String> {
    let file_size = match fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(_) => {
            return Ok(ParsedTranscript {
                turns: Vec::new(),
                next_offset: byte_offset,
            })
        }
    };
    if byte_offset >= file_size {
        return Ok(ParsedTranscript {
            turns: Vec::new(),
            next_offset: byte_offset,
        });
    }
    let mut actual_offset = byte_offset;
    if file_size - byte_offset > MAX_TRANSCRIPT_BYTES {
        actual_offset = file_size - MAX_TRANSCRIPT_BYTES;
    }
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(actual_offset))
        .map_err(|err| err.to_string())?;
    let mut buffer = vec![0u8; (file_size - actual_offset) as usize];
    file.read_exact(&mut buffer)
        .map_err(|err| err.to_string())?;
    // A producer can be between writes, including in the middle of UTF-8.
    // Do not ACK an incomplete final JSON value: the next stop must resume at
    // the untouched byte prefix. Complete malformed lines remain skippable.
    let complete_bytes = if buffer.last() != Some(&b'\n') {
        let tail = buffer
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |at| at + 1);
        if serde_json::from_slice::<Value>(&buffer[tail..]).is_err() {
            tail
        } else {
            buffer.len()
        }
    } else {
        buffer.len()
    };
    let file_size_for_offset = actual_offset + complete_bytes as u64;
    let mut owned = String::from_utf8_lossy(&buffer[..complete_bytes]).into_owned();
    if actual_offset > byte_offset {
        if let Some(index) = owned.find('\n') {
            owned = owned[index + 1..].to_string();
        } else {
            owned.clear();
        }
    }
    let content = owned;
    let mut groups: HashMap<String, AssistantGroup> = HashMap::new();
    let mut conversation = Vec::new();
    let mut tool_result_ts: HashMap<String, String> = HashMap::new();
    let mut tool_result_content: HashMap<String, Value> = HashMap::new();
    let mut tool_result_error: HashSet<String> = HashSet::new();
    let mut subagent_by_tool: HashMap<String, SubagentMeta> = HashMap::new();
    let mut skill_tools: HashMap<String, Option<String>> = HashMap::new();
    let mut slash_commands: HashMap<String, Option<String>> = HashMap::new();
    let mut skill_loads: Vec<claude_skill::SkillLoad> = Vec::new();
    let mut current_prompt: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(record_type) = record.get("type").and_then(Value::as_str) else {
            continue;
        };
        if record_type == "assistant" {
            let api_error = extract_api_error(&record);
            let message = record.get("message").and_then(Value::as_object);
            let Some(message) = message else { continue };
            if message.get("model").and_then(Value::as_str) == Some("<synthetic>")
                && api_error.is_none()
            {
                continue;
            }
            let msg_id = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("_syn_{}", uuid::Uuid::new_v4()));
            let record_ts = record
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let group = groups.entry(msg_id.clone()).or_insert_with(|| {
                conversation.push(Conv::Assistant {
                    msg_id: msg_id.clone(),
                });
                AssistantGroup {
                    chunks: Vec::new(),
                    usage: None,
                    model: None,
                    stop_reason: None,
                    first_timestamp: record_ts.clone(),
                    tool_use_timestamps: HashMap::new(),
                    prompt_id: current_prompt.clone(),
                    api_error: api_error.clone(),
                }
            });
            if group.first_timestamp.is_none() {
                group.first_timestamp = record_ts.clone();
            }
            if let Some(Value::Array(blocks)) = message.get("content") {
                for block in blocks {
                    if block.is_null() {
                        return Err("Cannot read properties of null (reading 'type')".into());
                    }
                    group.chunks.push(block.clone());
                    if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                        if let Some(id) = block
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                        {
                            if let Some(ts) = record_ts.as_deref() {
                                group
                                    .tool_use_timestamps
                                    .insert(id.to_string(), ts.to_string());
                            }
                            if block.get("name").and_then(Value::as_str) == Some("Skill") {
                                let name = block.get("input").and_then(|input| {
                                    input
                                        .get("skill")
                                        .and_then(Value::as_str)
                                        .or_else(|| input.get("name").and_then(Value::as_str))
                                });
                                skill_tools.insert(
                                    id.to_string(),
                                    name.and_then(claude_skill::normalize_skill_name),
                                );
                            }
                        }
                    }
                }
            }
            if message.get("usage").is_some() {
                group.usage = message.get("usage").cloned();
            }
            if let Some(model) = message.get("model").and_then(Value::as_str) {
                group.model = Some(model.to_string());
            }
            if let Some(reason) = message.get("stop_reason").and_then(Value::as_str) {
                group.stop_reason = Some(reason.to_string());
            }
            if api_error.is_some() {
                group.api_error = api_error;
            }
        } else if record_type == "user" {
            let Some(message) = record.get("message").and_then(Value::as_object) else {
                continue;
            };
            let record_ts = record
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if let Some(prompt_id) = record
                .get("promptId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                current_prompt = Some(prompt_id.to_string());
            }
            let is_meta = record.get("isMeta").and_then(Value::as_bool) == Some(true)
                || record.get("isMeta").and_then(Value::as_str) == Some("true");
            let content = message.get("content").cloned().unwrap_or(Value::Null);
            if let Value::Array(parts) = &content {
                for part in parts {
                    let Some(part) = part.as_object() else {
                        continue;
                    };
                    if part.get("type").and_then(Value::as_str) == Some("tool_result") {
                        if let Some(id) = part
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                        {
                            if let Some(ts) = &record_ts {
                                tool_result_ts.insert(id.to_string(), ts.clone());
                            }
                            tool_result_content.insert(id.to_string(), result_content(part));
                            if part.get("is_error").and_then(Value::as_bool) == Some(true) {
                                tool_result_error.insert(id.to_string());
                            }
                            if let Some(meta) = subagent_meta(&record, id) {
                                subagent_by_tool.insert(id.to_string(), meta);
                            }
                        }
                    }
                }
            }
            let user_text = extract_text(&content);
            let mut skill_context = false;
            if !is_meta {
                if let Some(name) = claude_skill::extract_slash_command_name(&user_text) {
                    slash_commands.insert(prompt_key(&current_prompt), Some(name));
                }
            } else {
                let root = claude_skill::extract_skill_root_path(&user_text);
                let source = record
                    .get("sourceToolUseID")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                let source_known = source
                    .as_ref()
                    .is_some_and(|id| skill_tools.contains_key(id));
                if root.is_some() || source_known {
                    let source_name = source
                        .as_ref()
                        .and_then(|id| skill_tools.get(id))
                        .and_then(|name| name.clone());
                    let slash_name = slash_commands
                        .get(&prompt_key(&current_prompt))
                        .and_then(|name| name.clone());
                    let name = source_name.or(slash_name).or_else(|| {
                        root.as_deref()
                            .and_then(claude_skill::extract_skill_name_from_root_path)
                    });
                    skill_loads.push(claude_skill::SkillLoad {
                        prompt_id: current_prompt.clone(),
                        source_tool_use_id: source,
                        name: name.clone(),
                        id: name,
                        root_path: root,
                        meta_uuid: record
                            .get("uuid")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned),
                        meta_timestamp: record_ts.clone(),
                    });
                    skill_context = true;
                }
            }
            conversation.push(Conv::User {
                content,
                timestamp: record_ts,
                prompt_id: current_prompt.clone(),
                is_meta,
                skill_context,
            });
        }
    }

    if groups.is_empty() {
        return Ok(ParsedTranscript {
            turns: Vec::new(),
            next_offset: file_size_for_offset,
        });
    }
    let merged: HashMap<String, Vec<Value>> = groups
        .iter()
        .map(|(id, group)| (id.clone(), dedup_blocks(&group.chunks)))
        .collect();
    let mut histories: HashMap<String, History> = HashMap::new();
    let mut last_tool_ts: HashMap<String, String> = HashMap::new();
    let mut llm_calls = Vec::new();
    for rec in &conversation {
        match rec {
            Conv::User {
                content,
                timestamp: _,
                prompt_id,
                is_meta,
                skill_context,
            } => {
                if !*is_meta || *skill_context {
                    histories
                        .entry(prompt_key(prompt_id))
                        .or_default()
                        .messages
                        .push(json!({"role": "user", "content": content}));
                }
                if !*is_meta {
                    if let Value::Array(parts) = content {
                        for part in parts {
                            if part.get("type").and_then(Value::as_str) == Some("tool_result") {
                                if let Some(id) = part.get("tool_use_id").and_then(Value::as_str) {
                                    if let Some(ts) = tool_result_ts.get(id) {
                                        let slot =
                                            last_tool_ts.entry(prompt_key(prompt_id)).or_default();
                                        if slot.is_empty() || ts > slot {
                                            *slot = ts.clone();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Conv::Assistant { msg_id } => {
                let Some(group) = groups.get(msg_id) else {
                    continue;
                };
                let usage = group.usage.as_ref().and_then(Value::as_object);
                let history = histories.entry(prompt_key(&group.prompt_id)).or_default();
                let delta = history.messages[history.emitted..].to_vec();
                let output = merged.get(msg_id).cloned().unwrap_or_default();
                let declared: Vec<String> = output
                    .iter()
                    .filter_map(|block| {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            block
                                .get("id")
                                .and_then(Value::as_str)
                                .filter(|id| !id.is_empty())
                                .map(str::to_owned)
                        } else {
                            None
                        }
                    })
                    .collect();
                let mut tools = HashMap::new();
                for tool_id in &declared {
                    tools.insert(
                        tool_id.clone(),
                        ToolDetail {
                            call: group
                                .tool_use_timestamps
                                .get(tool_id)
                                .cloned()
                                .or_else(|| group.first_timestamp.clone()),
                            result: tool_result_ts.get(tool_id).cloned(),
                            result_content: tool_result_content
                                .get(tool_id)
                                .cloned()
                                .unwrap_or_else(|| Value::String(String::new())),
                            is_error: tool_result_error.contains(tool_id),
                            agent_id: subagent_by_tool
                                .get(tool_id)
                                .map(|meta| meta.agent_id.clone()),
                            agent_type: subagent_by_tool
                                .get(tool_id)
                                .map(|meta| meta.agent_type.clone())
                                .unwrap_or_default(),
                            status: subagent_by_tool
                                .get(tool_id)
                                .map(|meta| meta.status.clone())
                                .unwrap_or_default(),
                            is_async: subagent_by_tool
                                .get(tool_id)
                                .map(|meta| meta.is_async)
                                .unwrap_or(false),
                        },
                    );
                }
                let request_start = last_tool_ts.get(&prompt_key(&group.prompt_id)).cloned();
                history.emitted = history.messages.len();
                if group.api_error.is_none() {
                    history
                        .messages
                        .push(json!({"role": "assistant", "content": output.clone()}));
                }
                for tool_id in &declared {
                    if let Some(ts) = tool_result_ts.get(tool_id) {
                        let slot = last_tool_ts
                            .entry(prompt_key(&group.prompt_id))
                            .or_default();
                        if slot.is_empty() || ts > slot {
                            *slot = ts.clone();
                        }
                    }
                }
                llm_calls.push(LlmCall {
                    timestamp: group.first_timestamp.clone(),
                    request_start,
                    model: if group.api_error.is_some() {
                        "unknown".into()
                    } else {
                        group.model.clone().unwrap_or_else(|| "unknown".into())
                    },
                    message_id: msg_id.clone(),
                    input_messages: delta,
                    output_content: if group.api_error.is_some() {
                        Vec::new()
                    } else {
                        output
                    },
                    stop_reason: if group.api_error.is_some() {
                        "error".into()
                    } else {
                        group
                            .stop_reason
                            .clone()
                            .unwrap_or_else(|| "end_turn".into())
                    },
                    input_tokens: usage
                        .and_then(|map| map.get("input_tokens"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    output_tokens: usage
                        .and_then(|map| map.get("output_tokens"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    cache_read: usage
                        .and_then(|map| map.get("cache_read_input_tokens"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    cache_create: usage
                        .and_then(|map| map.get("cache_creation_input_tokens"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    declared,
                    tools,
                    prompt_id: group.prompt_id.clone(),
                    api_error: group.api_error.clone(),
                });
            }
        }
    }
    Ok(ParsedTranscript {
        turns: split_turns(&conversation, llm_calls, skill_loads),
        next_offset: file_size_for_offset,
    })
}

#[derive(Default)]
struct History {
    messages: Vec<Value>,
    emitted: usize,
}

fn prompt_key(prompt_id: &Option<String>) -> String {
    prompt_id
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "__missing_prompt_id__".into())
}

fn split_turns(
    conversation: &[Conv],
    mut llm_calls: Vec<LlmCall>,
    skill_loads: Vec<claude_skill::SkillLoad>,
) -> Vec<Turn> {
    if llm_calls.is_empty() {
        return Vec::new();
    }
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    let mut info: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut boundary: HashMap<String, String> = HashMap::new();
    for rec in conversation {
        let Conv::User {
            content,
            timestamp,
            prompt_id,
            is_meta,
            skill_context: _,
        } = rec
        else {
            continue;
        };
        let Some(prompt_id) = prompt_id.clone().filter(|value| !value.is_empty()) else {
            continue;
        };
        if seen.insert(prompt_id.clone()) {
            order.push(prompt_id.clone());
        }
        if let Some(ts) = timestamp {
            boundary
                .entry(prompt_id.clone())
                .or_insert_with(|| ts.clone());
        }
        if info.contains_key(&prompt_id) || *is_meta || is_tool_result_content(content) {
            continue;
        }
        info.insert(prompt_id, (extract_text(content), timestamp.clone()));
    }
    if order.is_empty() {
        let first = llm_calls.first().and_then(|call| call.timestamp.clone());
        fill_request_starts(&mut llm_calls, first.clone());
        return vec![Turn {
            prompt_id: None,
            prompt: String::new(),
            prompt_timestamp: first,
            llm_calls,
            skill_loads,
        }];
    }
    let mut turns = Vec::new();
    for prompt_id in &order {
        let mut calls: Vec<LlmCall> = llm_calls
            .iter()
            .filter(|call| call.prompt_id.as_deref() == Some(prompt_id.as_str()))
            .cloned()
            .collect();
        if calls.is_empty() {
            continue;
        }
        let (prompt, prompt_ts) = info.get(prompt_id).cloned().unwrap_or_default();
        let prompt_timestamp = prompt_ts
            .or_else(|| boundary.get(prompt_id).cloned())
            .or_else(|| calls.first().and_then(|call| call.timestamp.clone()));
        fill_request_starts(&mut calls, prompt_timestamp.clone());
        turns.push(Turn {
            prompt_id: Some(prompt_id.clone()),
            prompt,
            prompt_timestamp,
            llm_calls: calls,
            skill_loads: skill_loads
                .iter()
                .filter(|load| load.prompt_id.as_deref() == Some(prompt_id.as_str()))
                .cloned()
                .collect(),
        });
    }
    let mut orphans: Vec<LlmCall> = llm_calls
        .into_iter()
        .filter(|call| call.prompt_id.as_deref().unwrap_or("").is_empty())
        .collect();
    if !orphans.is_empty() {
        let first = orphans.first().and_then(|call| call.timestamp.clone());
        fill_request_starts(&mut orphans, first.clone());
        turns.push(Turn {
            prompt_id: None,
            prompt: String::new(),
            prompt_timestamp: first,
            llm_calls: orphans,
            skill_loads: skill_loads
                .into_iter()
                .filter(|load| load.prompt_id.as_deref().unwrap_or("").is_empty())
                .collect(),
        });
    }
    turns
}

fn fill_request_starts(calls: &mut [LlmCall], prompt_timestamp: Option<String>) {
    let mut fallback =
        prompt_timestamp.or_else(|| calls.first().and_then(|call| call.timestamp.clone()));
    for call in calls.iter_mut() {
        let candidate = call
            .request_start
            .clone()
            .or_else(|| fallback.clone())
            .or_else(|| call.timestamp.clone());
        call.request_start = normalize_request_start(candidate, call.timestamp.clone());
        fallback = later_timestamp(fallback, call.timestamp.clone());
    }
}

fn normalize_request_start(candidate: Option<String>, response: Option<String>) -> Option<String> {
    let Some(candidate) = candidate else {
        return response;
    };
    let (Some(candidate_ms), Some(response_ms)) = (
        parse_ms(Some(candidate.as_str())),
        parse_ms(response.as_deref()),
    ) else {
        return Some(candidate);
    };
    if candidate_ms > response_ms {
        response
    } else {
        Some(candidate)
    }
}

fn later_timestamp(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (None, right) => right,
        (left, None) => left,
        (Some(left), Some(right)) => match (parse_ms(Some(&left)), parse_ms(Some(&right))) {
            (Some(left_ms), Some(right_ms)) if right_ms > left_ms => Some(right),
            _ => Some(left),
        },
    }
}

fn parse_ms(value: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

struct TurnBuild {
    records: Vec<Obj>,
    hash: String,
    merged_response_ids: HashSet<String>,
    consumed_attempt_files: HashSet<PathBuf>,
}

#[derive(Clone)]
struct InterceptRecord {
    file: PathBuf,
    ttft_ns: Option<f64>,
    system_instructions: Option<Vec<Value>>,
    llm_span_id: Option<String>,
}

#[derive(Clone)]
struct AttemptRecord {
    file: PathBuf,
    attempt_id: String,
    request_id: Option<String>,
    client_request_id: Option<String>,
    response_id: Option<String>,
    request_hash: Option<String>,
    model: Option<String>,
    start_ns: u128,
    end_ns: u128,
    outcome: String,
    status_code: Option<i64>,
    error_type: Option<String>,
    llm_span_id: Option<String>,
}

struct AttemptContext {
    records: Vec<AttemptRecord>,
    consumed: HashSet<usize>,
}

struct SubagentLink {
    agent_id: String,
    agent_name: String,
    parent_tool_call_id: String,
    is_background: bool,
}

struct PendingLink {
    agent_id: String,
    agent_name: String,
    parent_tool_call_id: String,
    completed: bool,
}

struct RecordBuildContext<'a> {
    env: &'a Env,
    user_id: &'a str,
    cwd: Option<&'a str>,
    resources: &'a Obj,
    span_attributes: &'a Obj,
    intercept: &'a HashMap<String, InterceptRecord>,
    attempts: &'a mut AttemptContext,
}

fn build_turn_records(
    context: RecordBuildContext<'_>,
    turn: &Turn,
    turn_index: u64,
    session_id: &str,
    prev_hash: &str,
    prompt_fallback: &str,
) -> TurnBuild {
    let RecordBuildContext {
        env,
        user_id,
        cwd,
        resources,
        span_attributes,
        intercept,
        attempts,
    } = context;
    let turn_id = format!("{session_id}:t{}", turn_index + 1);
    let prompt_for_trace = turn
        .prompt_id
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if prompt_fallback.is_empty() {
                None
            } else {
                Some(prompt_fallback.to_string())
            }
        });
    let turn_context = prompt_for_trace
        .as_deref()
        .and_then(|prompt_id| read_turn_context(env, session_id, prompt_id));
    let trace_id = turn_context
        .map(|context| context.trace_id)
        .unwrap_or_else(|| random_hex(16));
    let mut base = Obj::new();
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
    if let Some(name) = agent_name_patch(resources) {
        base.insert("gen_ai.agent.name".into(), Value::String(name));
    }
    base.insert("user.id".into(), Value::String(user_id.to_string()));
    if let Some(cwd) = cwd {
        base.insert(
            "agent.claude-code.cwd".into(),
            Value::String(cwd.to_string()),
        );
    }
    for (key, value) in span_attributes {
        base.insert(key.clone(), value.clone());
    }
    if !resources.is_empty() {
        base.insert(
            "resourceAttributes".into(),
            Value::Object(resources.clone()),
        );
    }
    let mut real_skill_tools = HashSet::new();
    for call in &turn.llm_calls {
        for block in &call.output_content {
            if block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("name").and_then(Value::as_str) == Some("Skill")
            {
                if let Some(id) = block
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    if call.tools.contains_key(id) {
                        real_skill_tools.insert(id.to_string());
                    }
                }
            }
        }
    }
    let synthetic = claude_skill::synthetic_skills(
        session_id,
        turn.prompt_id.as_deref(),
        &turn.skill_loads,
        &real_skill_tools,
    );
    let first_output = turn
        .llm_calls
        .first()
        .map(|call| convert_output_messages(&call.output_content, &call.stop_reason))
        .unwrap_or_default();
    let skill_by_tool = claude_skill::skill_index_by_tool(&turn.skill_loads);
    let mut consumed_skills = HashSet::new();
    let mut running_hash = prev_hash.to_string();
    let turn_start_ns = if turn
        .prompt_id
        .as_ref()
        .is_some_and(|prompt| !prompt.is_empty())
    {
        turn.prompt_timestamp
            .as_deref()
            .map(|timestamp| iso_to_unix_nanos(timestamp).parse::<u128>().unwrap_or(0))
            .unwrap_or(0)
    } else {
        0
    };
    let mut records = Vec::new();
    let mut merged_response_ids = HashSet::new();
    let mut consumed_attempt_files = HashSet::new();
    if !turn.prompt.is_empty() {
        let mut record = base.clone();
        record.insert(
            "time_unix_nano".into(),
            Value::String(iso_to_unix_nanos(
                turn.prompt_timestamp.as_deref().unwrap_or(""),
            )),
        );
        record.insert(
            "event.id".into(),
            Value::String(uuid::Uuid::new_v4().to_string()),
        );
        record.insert("event.name".into(), Value::String("other".into()));
        record.insert(
            "gen_ai.input.messages_delta".into(),
            json!([{ "role": "user", "parts": [{ "type": "text", "content": turn.prompt }] }]),
        );
        records.push(record);
    }
    let mut owners: HashMap<String, (String, String)> = HashMap::new();
    let mut first_step: Option<(String, String)> = None;
    for (index, call) in turn.llm_calls.iter().enumerate() {
        let step_id = format!("{turn_id}:s{}", index + 1);
        let step_span = random_hex(8);
        if first_step.is_none() {
            first_step = Some((step_id.clone(), step_span.clone()));
        }
        let response_id = if call.message_id.is_empty() {
            format!("{step_id}:r")
        } else {
            call.message_id.clone()
        };
        for tool_id in &call.declared {
            owners.insert(tool_id.clone(), (step_id.clone(), step_span.clone()));
        }
        let chosen = claude_skill::consume_attempts_for_call(attempts, call, turn_start_ns);
        for attempt in &chosen {
            consumed_attempt_files.insert(attempt.file.clone());
        }
        let final_attempt = chosen.last();
        let retry_end = chosen.len().saturating_sub(1);
        records.extend(claude_skill::build_retry_attempt_records(
            &chosen[..retry_end],
            &base,
            &step_id,
            &step_span,
            &call.model,
        ));
        let intercept_data = if call.message_id.is_empty() {
            None
        } else {
            intercept.get(&call.message_id)
        };
        if intercept_data.is_some() {
            merged_response_ids.insert(call.message_id.clone());
        }
        let llm_span = intercept_data
            .and_then(|data| data.llm_span_id.as_deref())
            .filter(|span| claude_skill::is_span_id(span))
            .or_else(|| {
                final_attempt
                    .and_then(|attempt| attempt.llm_span_id.as_deref())
                    .filter(|span| claude_skill::is_span_id(span))
            })
            .map(str::to_owned)
            .unwrap_or_else(|| random_hex(8));
        let mut input_messages = convert_input_messages(&call.input_messages);
        if index > 0 {
            claude_skill::inject_synthetic_skill_history(
                &mut input_messages,
                &first_output,
                &synthetic,
            );
        }
        let mut request = base.clone();
        request.insert(
            "time_unix_nano".into(),
            Value::String(
                final_attempt
                    .map(|attempt| attempt.start_ns.to_string())
                    .unwrap_or_else(|| {
                        iso_to_unix_nanos(call.request_start.as_deref().unwrap_or(""))
                    }),
            ),
        );
        request.insert(
            "event.id".into(),
            Value::String(uuid::Uuid::new_v4().to_string()),
        );
        request.insert("event.name".into(), Value::String("llm.request".into()));
        request.insert("span_id".into(), Value::String(llm_span.clone()));
        request.insert("parent_span_id".into(), Value::String(step_span.clone()));
        request.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        request.insert(
            "gen_ai.response.id".into(),
            Value::String(response_id.clone()),
        );
        request.insert(
            "gen_ai.provider.name".into(),
            Value::String("anthropic".into()),
        );
        request.insert(
            "gen_ai.request.model".into(),
            Value::String(call.model.clone()),
        );
        let message_hash = compute_hash(&running_hash, &input_messages);
        running_hash = message_hash.clone();
        request.insert(
            "gen_ai.input.messages_hash".into(),
            Value::String(message_hash),
        );
        request.insert(
            "gen_ai.input.messages_delta".into(),
            Value::Array(input_messages),
        );
        if let Some(attempt) = final_attempt {
            claude_skill::apply_attempt_attributes(&mut request, attempt);
        }
        if let Some(request_id) = call
            .api_error
            .as_ref()
            .and_then(|error| error.request_id.clone())
        {
            request.insert("gen_ai.request.id".into(), Value::String(request_id));
        }
        if let Some(instructions) = intercept_data.and_then(|data| data.system_instructions.clone())
        {
            if !instructions.is_empty() {
                request.insert(
                    "gen_ai.system_instructions".into(),
                    Value::Array(instructions),
                );
            }
        }
        records.push(request);

        let input_tokens = call.input_tokens + call.cache_read + call.cache_create;
        let output_tokens = call.output_tokens;
        let attempt_failed = final_attempt.is_some_and(|attempt| attempt.outcome != "success");
        let mut response = base.clone();
        let response_time = if attempt_failed {
            final_attempt
                .map(|attempt| attempt.end_ns.to_string())
                .unwrap_or_else(|| iso_to_unix_nanos(call.timestamp.as_deref().unwrap_or("")))
        } else {
            iso_to_unix_nanos(call.timestamp.as_deref().unwrap_or(""))
        };
        response.insert("time_unix_nano".into(), Value::String(response_time));
        response.insert(
            "event.id".into(),
            Value::String(uuid::Uuid::new_v4().to_string()),
        );
        response.insert("event.name".into(), Value::String("llm.response".into()));
        response.insert("span_id".into(), Value::String(llm_span));
        response.insert("parent_span_id".into(), Value::String(step_span.clone()));
        response.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        response.insert("gen_ai.response.id".into(), Value::String(response_id));
        response.insert(
            "gen_ai.provider.name".into(),
            Value::String("anthropic".into()),
        );
        response.insert(
            "gen_ai.request.model".into(),
            Value::String(call.model.clone()),
        );
        response.insert(
            "gen_ai.response.model".into(),
            Value::String(call.model.clone()),
        );
        response.insert(
            "gen_ai.response.finish_reasons".into(),
            json!([map_stop_reason(&call.stop_reason)]),
        );
        response.insert(
            "gen_ai.usage.input_tokens".into(),
            Value::from(input_tokens),
        );
        response.insert(
            "gen_ai.usage.output_tokens".into(),
            Value::from(output_tokens),
        );
        response.insert(
            "gen_ai.usage.cache_read.input_tokens".into(),
            Value::from(call.cache_read),
        );
        response.insert(
            "gen_ai.usage.cache_creation.input_tokens".into(),
            Value::from(call.cache_create),
        );
        response.insert(
            "gen_ai.usage.total_tokens".into(),
            Value::from(input_tokens + output_tokens),
        );
        if call.api_error.is_none() {
            let mut output = convert_output_messages(&call.output_content, &call.stop_reason);
            if index == 0 {
                claude_skill::append_synthetic_skill_calls(&mut output, &synthetic);
            }
            response.insert("gen_ai.output.messages".into(), Value::Array(output));
        }
        if let Some(attempt) = final_attempt {
            claude_skill::apply_attempt_attributes(&mut response, attempt);
        }
        if let Some(ttft) = intercept_data.and_then(|data| data.ttft_ns) {
            if ttft.is_finite() && ttft >= 0.0 {
                response.insert(
                    "gen_ai.response.time_to_first_token".into(),
                    json_number(ttft),
                );
            }
        }
        if call.api_error.is_some() || attempt_failed {
            let transcript_type = call.api_error.as_ref().map(|error| error.kind.as_str());
            let error_type = if transcript_type
                .is_some_and(|kind| !kind.is_empty() && kind != "unknown" && kind != "model_error")
            {
                transcript_type.unwrap_or("model_error").to_string()
            } else {
                final_attempt
                    .and_then(|attempt| attempt.error_type.clone())
                    .filter(|value| !value.is_empty())
                    .or_else(|| transcript_type.map(str::to_owned))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "model_error".into())
            };
            response.insert("error.type".into(), Value::String(error_type));
            response.insert("gen_ai.response.finish_reasons".into(), json!(["error"]));
            if index + 1 == turn.llm_calls.len() {
                response.insert("gen_ai.turn.end".into(), Value::Bool(true));
            }
            if call.api_error.is_some() {
                response.remove("gen_ai.output.messages");
            }
            if let Some(request_id) = call
                .api_error
                .as_ref()
                .and_then(|error| error.request_id.clone())
            {
                response.insert("gen_ai.request.id".into(), Value::String(request_id));
            }
            let status = call
                .api_error
                .as_ref()
                .and_then(|error| error.status)
                .or_else(|| final_attempt.and_then(|attempt| attempt.status_code));
            if let Some(status) = status {
                response.insert("http.response.status_code".into(), Value::from(status));
            }
        }
        records.push(response);
    }
    for call in &turn.llm_calls {
        for tool_id in &call.declared {
            let Some((step_id, step_span)) = owners.get(tool_id) else {
                continue;
            };
            let Some(detail) = call.tools.get(tool_id) else {
                continue;
            };
            let Some(block) = call.output_content.iter().find(|block| {
                block.get("type").and_then(Value::as_str) == Some("tool_use")
                    && block.get("id").and_then(Value::as_str) == Some(tool_id.as_str())
            }) else {
                continue;
            };
            let tool_name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let reserved = consume_tool_context(env, session_id, tool_id);
            let tool_span = reserved
                .map(|item| item.span_id)
                .unwrap_or_else(|| random_hex(8));
            let arguments = match block.get("input") {
                None | Some(Value::Null) => Value::Object(Obj::new()),
                Some(input) => input.clone(),
            };
            let skill_fields = if tool_name == "Skill" {
                let fallback = block.get("input").and_then(|input| {
                    input
                        .get("skill")
                        .and_then(Value::as_str)
                        .or_else(|| input.get("name").and_then(Value::as_str))
                });
                let load = skill_by_tool
                    .get(tool_id)
                    .map(|index| &turn.skill_loads[*index]);
                if let Some(index) = skill_by_tool.get(tool_id) {
                    consumed_skills.insert(*index);
                }
                claude_skill::skill_fields(load, fallback)
            } else {
                Vec::new()
            };
            let mut call_record = base.clone();
            call_record.insert(
                "time_unix_nano".into(),
                Value::String(iso_to_unix_nanos(detail.call.as_deref().unwrap_or(""))),
            );
            call_record.insert(
                "event.id".into(),
                Value::String(uuid::Uuid::new_v4().to_string()),
            );
            call_record.insert("event.name".into(), Value::String("tool.call".into()));
            call_record.insert("span_id".into(), Value::String(tool_span.clone()));
            call_record.insert("parent_span_id".into(), Value::String(step_span.clone()));
            call_record.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
            call_record.insert(
                "gen_ai.tool.name".into(),
                Value::String(tool_name.to_string()),
            );
            call_record.insert("gen_ai.tool.call.id".into(), Value::String(tool_id.clone()));
            call_record.insert("gen_ai.tool.call.arguments".into(), arguments);
            insert_string_pairs(&mut call_record, &skill_fields);
            records.push(call_record);
            if detail.result.is_some() {
                let mut result_record = base.clone();
                result_record.insert(
                    "time_unix_nano".into(),
                    Value::String(iso_to_unix_nanos(detail.result.as_deref().unwrap_or(""))),
                );
                result_record.insert(
                    "event.id".into(),
                    Value::String(uuid::Uuid::new_v4().to_string()),
                );
                result_record.insert("event.name".into(), Value::String("tool.result".into()));
                result_record.insert("span_id".into(), Value::String(tool_span));
                result_record.insert("parent_span_id".into(), Value::String(step_span.clone()));
                result_record.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
                result_record.insert(
                    "gen_ai.tool.name".into(),
                    Value::String(tool_name.to_string()),
                );
                result_record.insert("gen_ai.tool.call.id".into(), Value::String(tool_id.clone()));
                result_record.insert(
                    "gen_ai.tool.call.result".into(),
                    detail.result_content.clone(),
                );
                result_record.insert(
                    "tool.result.status".into(),
                    Value::String(if detail.is_error { "error" } else { "success" }.into()),
                );
                if detail.is_error {
                    result_record.insert("error.type".into(), Value::String("ToolError".into()));
                    let message = match &detail.result_content {
                        Value::String(text) => text.chars().take(500).collect::<String>(),
                        _ => "tool execution failed".into(),
                    };
                    result_record.insert("error.message".into(), Value::String(message));
                }
                insert_string_pairs(&mut result_record, &skill_fields);
                records.push(result_record);
            }
        }
    }
    if let Some((step_id, step_span)) = &first_step {
        claude_skill::append_synthetic_skill_spans(
            &mut records,
            &base,
            &claude_skill::SkillStep {
                id: step_id,
                span_id: step_span,
            },
            &turn.skill_loads,
            &synthetic,
            &consumed_skills,
            turn.llm_calls
                .first()
                .and_then(|call| call.timestamp.as_deref()),
        );
    }
    sort_records(&mut records);
    TurnBuild {
        records,
        hash: running_hash,
        merged_response_ids,
        consumed_attempt_files,
    }
}

fn insert_string_pairs(record: &mut Obj, fields: &[(String, String)]) {
    for (key, value) in fields {
        record.insert(key.clone(), Value::String(value.clone()));
    }
}

fn sort_records(records: &mut [Obj]) {
    records.sort_by_key(nano_key);
}

fn empty_turn() -> TurnBuild {
    TurnBuild {
        records: Vec::new(),
        hash: INITIAL_HASH.to_string(),
        merged_response_ids: HashSet::new(),
        consumed_attempt_files: HashSet::new(),
    }
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

fn now_sec() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64 / 1000.0)
        .unwrap_or(0.0)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn remember_paths(state: &mut Obj, event: &Obj, only_missing_cwd: bool) {
    if state
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
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
        let missing = state
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty();
        if !only_missing_cwd || missing {
            state.insert("cwd".into(), Value::String(cwd.to_string()));
        }
    }
}

fn js_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    let number = value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))?;
    if number == 0 {
        None
    } else {
        Some(number)
    }
}

fn event_token(event: &Obj, key: &str) -> i64 {
    js_i64(event.get("usage").and_then(|usage| usage.get(key)))
        .or_else(|| js_i64(event.get(key)))
        .unwrap_or(0)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn js_object_truthy(map: &Obj, key: &str) -> bool {
    match map.get(key) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(value)) if value.is_empty() => false,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => false,
        Some(_) => true,
    }
}

fn read_and_delete_child_state(env: &Env, session_id: &str) -> Option<Obj> {
    let path = state_path(env, session_id);
    let text = fs::read_to_string(&path).ok()?;
    let Value::Object(map) = serde_json::from_str(&text).ok()? else {
        return None;
    };
    let _ = fs::remove_file(path);
    Some(map)
}

fn subagent_meta(record: &Obj, _tool_id: &str) -> Option<SubagentMeta> {
    let result = record.get("toolUseResult")?.as_object()?;
    let agent_id = result
        .get("agentId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            result
                .get("agent_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })?;
    Some(SubagentMeta {
        agent_id: agent_id.to_string(),
        agent_type: result
            .get("agentType")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                result
                    .get("agent_type")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("")
            .to_string(),
        status: result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        is_async: result.get("isAsync").and_then(Value::as_bool) == Some(true)
            || result.get("is_async").and_then(Value::as_bool) == Some(true),
    })
}

fn is_agent_tool(name: &str) -> bool {
    name == "Agent" || name == "agent"
}

fn collect_subagent_links(turn: &Turn) -> Vec<SubagentLink> {
    let mut links = Vec::new();
    for call in &turn.llm_calls {
        for block in &call.output_content {
            let Some(id) = block
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
            if !is_agent_tool(name) {
                continue;
            }
            let Some(detail) = call.tools.get(id) else {
                continue;
            };
            let Some(agent_id) = detail.agent_id.clone().filter(|id| !id.is_empty()) else {
                continue;
            };
            let fallback = block
                .get("input")
                .and_then(|input| input.get("subagent_type"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("Subagent");
            let agent_name = if detail.agent_type.is_empty() {
                fallback.to_string()
            } else {
                detail.agent_type.clone()
            };
            let run_in_background = block
                .get("input")
                .and_then(|input| input.get("run_in_background"))
                .and_then(Value::as_bool)
                == Some(true);
            links.push(SubagentLink {
                agent_id,
                agent_name,
                parent_tool_call_id: id.to_string(),
                is_background: run_in_background
                    || detail.status == "async_launched"
                    || detail.is_async,
            });
        }
    }
    links
}

fn link_value(link: &SubagentLink, completed: bool) -> Value {
    json!({
        "agentId": link.agent_id,
        "agentName": link.agent_name,
        "parentToolCallId": link.parent_tool_call_id,
        "isBackground": link.is_background,
        "completed": completed,
    })
}

fn resolve_subagent_transcript_path(
    parent_transcript_path: &str,
    agent_id: &str,
) -> Option<PathBuf> {
    let raw = agent_id.trim();
    if raw.is_empty() || raw.contains('/') || raw.contains('\\') || raw.contains('\0') {
        return None;
    }
    let base = Path::new(raw).file_name()?.to_str()?;
    let safe = base.strip_suffix(".jsonl").unwrap_or(base);
    if safe.is_empty() || safe == "." || safe == ".." {
        return None;
    }
    let filename = if safe.starts_with("agent-") {
        format!("{safe}.jsonl")
    } else {
        format!("agent-{safe}.jsonl")
    };
    let parent = Path::new(parent_transcript_path);
    let parent_session = parent.file_stem()?.to_str()?;
    let parent_dir = parent.parent().unwrap_or_else(|| Path::new("."));
    let subagent_dir = parent_dir.join(parent_session).join("subagents");
    let transcript = subagent_dir.join(filename);
    let relative = transcript.strip_prefix(&subagent_dir).ok()?;
    let relative_text = relative.to_str()?;
    if relative_text.is_empty()
        || relative_text == ".."
        || relative_text.starts_with("../")
        || relative_text.starts_with("..\\")
        || Path::new(relative_text).is_absolute()
    {
        return None;
    }
    Some(transcript)
}

fn build_subagent_records(
    context: RecordBuildContext<'_>,
    parent_transcript: &str,
    parent_session: &str,
    parent_trace: &str,
    parent_turn: &str,
    link: &SubagentLink,
) -> TurnBuild {
    let RecordBuildContext {
        env,
        user_id,
        cwd,
        resources,
        span_attributes,
        intercept,
        attempts,
    } = context;
    let Some(path) = resolve_subagent_transcript_path(parent_transcript, &link.agent_id) else {
        return empty_turn();
    };
    if !path.exists() {
        return empty_turn();
    }
    let parsed = match parse_claude_transcript(&path, 0) {
        Ok(parsed) => parsed,
        Err(err) => {
            log_hook_error(
                env,
                AGENT_ID,
                "subagent_transcript_parse",
                "parse_failed",
                &err,
            );
            return empty_turn();
        }
    };
    let mut records = Vec::new();
    let mut merged_response_ids = HashSet::new();
    let mut consumed_attempt_files = HashSet::new();
    let mut child_hash = INITIAL_HASH.to_string();
    for (index, turn) in parsed.turns.iter().enumerate() {
        let built = build_turn_records(
            RecordBuildContext {
                env,
                user_id,
                cwd,
                resources,
                span_attributes,
                intercept,
                attempts: &mut *attempts,
            },
            turn,
            index as u64,
            &link.agent_id,
            &child_hash,
            "",
        );
        child_hash = built.hash;
        merged_response_ids.extend(built.merged_response_ids);
        consumed_attempt_files.extend(built.consumed_attempt_files);
        for mut record in built.records {
            if record.get("event.name").and_then(Value::as_str) == Some("other") {
                continue;
            }
            record.insert("trace_id".into(), Value::String(parent_trace.to_string()));
            record.insert(
                "gen_ai.session.id".into(),
                Value::String(parent_session.to_string()),
            );
            record.insert(
                "gen_ai.turn.id".into(),
                Value::String(parent_turn.to_string()),
            );
            record.insert(
                "gen_ai.agent.scope".into(),
                Value::String("subagent".into()),
            );
            record.insert("gen_ai.agent.depth".into(), Value::from(1));
            record.insert(
                "gen_ai.agent.id".into(),
                Value::String(link.agent_id.clone()),
            );
            record.insert(
                "gen_ai.agent.name".into(),
                Value::String(link.agent_name.clone()),
            );
            record.insert(
                "gen_ai.agent.parent.id".into(),
                Value::String(parent_session.to_string()),
            );
            record.insert(
                "gen_ai.subagent.parent_tool_call.id".into(),
                Value::String(link.parent_tool_call_id.clone()),
            );
            records.push(record);
        }
    }
    TurnBuild {
        records,
        hash: child_hash,
        merged_response_ids,
        consumed_attempt_files,
    }
}

fn extend_background_agent_result(
    records: &mut [Obj],
    parent_tool_call_id: &str,
    child_records: &[Obj],
) {
    let mut child_end = 0u128;
    for record in child_records {
        child_end = child_end.max(nano_key(record));
    }
    if child_end == 0 {
        return;
    }
    let Some(parent) = records.iter_mut().find(|record| {
        record.get("event.name").and_then(Value::as_str) == Some("tool.result")
            && record.get("gen_ai.tool.call.id").and_then(Value::as_str)
                == Some(parent_tool_call_id)
    }) else {
        return;
    };
    if nano_key(parent) < child_end {
        parent.insert(
            "time_unix_nano".into(),
            Value::String(child_end.to_string()),
        );
    }
}

fn record_list(value: Option<&Value>) -> Vec<Obj> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn pending_link_from_value(value: &Value) -> Option<PendingLink> {
    let map = value.as_object()?;
    Some(PendingLink {
        agent_id: map
            .get("agentId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        agent_name: map
            .get("agentName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        parent_tool_call_id: map
            .get("parentToolCallId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        completed: map
            .get("completed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn pending_link_value(link: &PendingLink) -> Value {
    json!({
        "agentId": link.agent_id,
        "agentName": link.agent_name,
        "parentToolCallId": link.parent_tool_call_id,
        "isBackground": true,
        "completed": link.completed,
    })
}

fn push_finalized_ids(state: &mut Obj, agent_ids: &[String]) {
    let mut ids = state
        .get("finalized_subagent_ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for id in agent_ids {
        ids.push(Value::String(id.clone()));
    }
    if ids.len() > FINALIZED_SUBAGENT_LIMIT {
        ids = ids.split_off(ids.len() - FINALIZED_SUBAGENT_LIMIT);
    }
    state.insert("finalized_subagent_ids".into(), Value::Array(ids));
}

fn nano_key(record: &Obj) -> u128 {
    record
        .get("time_unix_nano")
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
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

fn convert_input_messages(messages: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        let Some(message) = message.as_object() else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        match message.get("content") {
            Some(Value::String(text)) => {
                out.push(json!({"role": role, "parts": [{"type": "text", "content": text}]}))
            }
            Some(Value::Array(blocks)) => {
                let parts: Vec<Value> = blocks.iter().filter_map(convert_block).collect();
                let role = if parts.iter().any(|part| {
                    part.get("type").and_then(Value::as_str) == Some("tool_call_response")
                }) {
                    "tool"
                } else {
                    role
                };
                out.push(json!({"role": role, "parts": parts}));
            }
            Some(other) => out.push(
                json!({"role": role, "parts": [{"type": "text", "content": other.to_string()}]}),
            ),
            None => out.push(json!({"role": role, "parts": []})),
        }
    }
    out
}

fn convert_output_messages(blocks: &[Value], stop_reason: &str) -> Vec<Value> {
    if blocks.is_empty() {
        return vec![
            json!({"role": "assistant", "parts": [], "finish_reason": map_stop_reason(stop_reason)}),
        ];
    }
    let parts: Vec<Value> = blocks.iter().filter_map(|block| match block.get("type").and_then(Value::as_str) {
        Some("text") => Some(json!({"type": "text", "content": block.get("text").and_then(Value::as_str).unwrap_or("")})),
        Some("tool_use") => Some(json!({
            "type": "tool_call",
            "id": block.get("id").cloned().unwrap_or(Value::Null),
            "name": block.get("name").and_then(Value::as_str).unwrap_or(""),
            "arguments": block.get("input").cloned().unwrap_or(Value::Null),
        })),
        Some("thinking") => Some(json!({"type": "reasoning", "content": block.get("thinking").and_then(Value::as_str).unwrap_or("")})),
        Some(_) if block.get("text").is_some() => Some(json!({"type": "text", "content": block.get("text").and_then(Value::as_str).unwrap_or("")})),
        _ => None,
    }).collect();
    vec![
        json!({"role": "assistant", "parts": parts, "finish_reason": map_stop_reason(stop_reason)}),
    ]
}

fn convert_block(block: &Value) -> Option<Value> {
    let block = block.as_object()?;
    match block.get("type").and_then(Value::as_str)? {
        "text" => Some(
            json!({"type": "text", "content": block.get("text").and_then(Value::as_str).unwrap_or("")}),
        ),
        "tool_use" => Some(json!({
            "type": "tool_call",
            "id": block.get("id").cloned().unwrap_or(Value::Null),
            "name": block.get("name").and_then(Value::as_str).unwrap_or(""),
            "arguments": block.get("input").cloned().unwrap_or(Value::Null),
        })),
        "tool_result" => Some(json!({
            "type": "tool_call_response",
            "id": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
            "response": block.get("content").cloned().unwrap_or(Value::Null),
        })),
        "thinking" => Some(
            json!({"type": "reasoning", "content": block.get("thinking").and_then(Value::as_str).unwrap_or("")}),
        ),
        other => block
            .get("text")
            .map(|text| json!({"type": "text", "content": text}))
            .or_else(|| Some(json!({"type": other}))),
    }
}

fn dedup_blocks(blocks: &[Value]) -> Vec<Value> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut best_text: Option<Value> = None;
    let mut best_thinking: Option<Value> = None;
    for block in blocks {
        let Some(kind) = block.get("type").and_then(Value::as_str) else {
            continue;
        };
        match kind {
            "text" => {
                let len = block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .len();
                let best = best_text
                    .as_ref()
                    .and_then(|value| value.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .len();
                if best_text.is_none() || len > best {
                    best_text = Some(block.clone());
                }
            }
            "thinking" => {
                let len = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .len();
                let best = best_thinking
                    .as_ref()
                    .and_then(|value| value.get("thinking"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .len();
                if best_thinking.is_none() || len > best {
                    best_thinking = Some(block.clone());
                }
            }
            "tool_use" => {
                if let Some(id) = block
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    if seen.insert(id.to_string()) {
                        result.push(block.clone());
                    }
                } else {
                    result.push(block.clone());
                }
            }
            _ => result.push(block.clone()),
        }
    }
    if let Some(text) = best_text {
        result.insert(0, text);
    }
    if let Some(thinking) = best_thinking {
        result.insert(0, thinking);
    }
    result
}

fn extract_api_error(record: &Obj) -> Option<ApiError> {
    if record.get("isApiErrorMessage").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let status = record
        .get("apiErrorStatus")
        .and_then(Value::as_i64)
        .filter(|status| (100..=599).contains(status));
    let request_id = record
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(256).collect());
    Some(ApiError {
        kind: normalize_error_type(record.get("error").and_then(Value::as_str).unwrap_or("")),
        status,
        request_id,
    })
}

fn normalize_error_type(value: &str) -> String {
    let normalized: String = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let trimmed = normalized.trim_matches('_');
    if trimmed.is_empty() {
        "model_error".into()
    } else {
        trimmed.to_string()
    }
}

fn extract_text(content: &Value) -> String {
    match content {
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| part.get("content").and_then(Value::as_str))
                        .unwrap_or("")
                } else {
                    ""
                }
            })
            .collect(),
        Value::String(text) => text.clone(),
        _ => String::new(),
    }
}

fn is_tool_result_content(content: &Value) -> bool {
    match content {
        Value::Array(parts) if !parts.is_empty() => parts
            .iter()
            .all(|part| part.get("type").and_then(Value::as_str) == Some("tool_result")),
        _ => false,
    }
}

fn result_content(part: &Obj) -> Value {
    part.get("content")
        .cloned()
        .or_else(|| part.get("output").cloned())
        .or_else(|| part.get("result").cloned())
        .unwrap_or_else(|| Value::String(String::new()))
}

fn non_empty(map: &Obj, key: &str) -> bool {
    map.get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn number_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .or_else(|| {
            value
                .and_then(Value::as_i64)
                .filter(|number| *number >= 0)
                .map(|number| number as u64)
        })
        .unwrap_or(0)
}

fn state_path(env: &Env, session_id: &str) -> PathBuf {
    data_dir(env)
        .join("state")
        .join(AGENT_ID)
        .join("sessions")
        .join(format!("{}.json", sanitize_session_id(session_id)))
}

fn load_state(env: &Env, session_id: &str) -> Obj {
    if let Ok(text) = fs::read_to_string(state_path(env, session_id)) {
        if let Ok(Value::Object(map)) = serde_json::from_str(&text) {
            return map;
        }
    }
    let mut state = Obj::new();
    state.insert("session_id".into(), Value::String(session_id.to_string()));
    state.insert("transcript_offset".into(), Value::from(0));
    state.insert("turn_count".into(), Value::from(0));
    state.insert("events".into(), Value::Array(Vec::new()));
    state
}

fn save_state(env: &Env, session_id: &str, state: &Obj) -> Result<(), String> {
    let dest = state_path(env, session_id);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = dest.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(
        &tmp,
        serde_json::to_vec(&Value::Object(state.clone())).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::rename(&tmp, dest).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        err.to_string()
    })
}

fn with_state_lock<T>(
    env: &Env,
    session_id: &str,
    action: impl FnOnce() -> T,
) -> Result<T, String> {
    let dir = data_dir(env).join("state").join(AGENT_ID).join("sessions");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let lock = dir.join(format!("{}.lock", sanitize_session_id(session_id)));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match fs::create_dir(&lock) {
            Ok(()) => break,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                if let Ok(meta) = fs::metadata(&lock) {
                    if meta
                        .modified()
                        .ok()
                        .and_then(|time| time.elapsed().ok())
                        .is_some_and(|age| age > Duration::from_secs(30))
                    {
                        let _ = fs::remove_dir(&lock);
                        continue;
                    }
                }
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "timed out waiting for session state lock: {}",
                        sanitize_session_id(session_id)
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => return Err(err.to_string()),
        }
    }
    let result = action();
    let _ = fs::remove_dir(&lock);
    Ok(result)
}

struct ToolContext {
    traceparent: String,
    tracestate: Option<String>,
    span_id: String,
    trace_id: String,
}

fn correlate_dir(env: &Env) -> PathBuf {
    data_dir(env).join("acp-correlate")
}

fn turn_context_path(env: &Env, session_id: &str, prompt_id: &str) -> PathBuf {
    correlate_dir(env).join(format!(
        "{}.{}.turn-context.json",
        safe_path_part(session_id),
        safe_path_part(prompt_id)
    ))
}

fn tool_context_path(env: &Env, session_id: &str, tool_use_id: &str) -> PathBuf {
    correlate_dir(env).join(format!(
        "{}.{}.tool-context.json",
        safe_path_part(session_id),
        safe_path_part(tool_use_id)
    ))
}

fn consumed_path(env: &Env, session_id: &str) -> PathBuf {
    correlate_dir(env).join(format!(
        "{}.tool-propagation.done",
        safe_path_part(session_id)
    ))
}

fn propagation_consumed(env: &Env, session_id: &str) -> bool {
    fs::metadata(consumed_path(env, session_id))
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

fn mark_tool_propagation_consumed(env: &Env, session_id: &str) {
    let path = consumed_path(env, session_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            let _ = writeln!(
                file,
                "{}",
                json!({"sessionId": session_id, "ts": iso_now()})
            );
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            if let Ok(bytes) = fs::read(&path) {
                let _ = fs::write(&path, bytes);
            }
        }
        Err(_) => {}
    }
}

fn read_turn_context(env: &Env, session_id: &str, prompt_id: &str) -> Option<ToolContext> {
    let value: Value = serde_json::from_str(
        &fs::read_to_string(turn_context_path(env, session_id, prompt_id)).ok()?,
    )
    .ok()?;
    let trace_id = value
        .get("traceId")
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    let flags = value
        .get("flags")
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    let source = value.get("source").and_then(Value::as_str)?;
    if trace_id.len() != 32
        || trace_id.chars().all(|ch| ch == '0')
        || flags.len() != 2
        || (source != "upstream-env" && source != "local")
    {
        return None;
    }
    let span_id = value
        .get("parentSpanId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    Some(ToolContext {
        traceparent: format!("00-{trace_id}-{span_id}-{flags}"),
        tracestate: value
            .get("tracestate")
            .and_then(Value::as_str)
            .map(str::to_owned),
        span_id,
        trace_id,
    })
}

fn reserve_tool_context(
    env: &Env,
    session_id: &str,
    prompt_id: &str,
    tool_use_id: &str,
    generate_when_missing: bool,
) -> Option<ToolContext> {
    if session_id.is_empty() || tool_use_id.is_empty() || has_acp_turn_record(env, session_id) {
        return None;
    }
    let turn = if !prompt_id.is_empty() {
        reserve_turn_context(env, session_id, prompt_id, generate_when_missing)?
    } else if propagation_consumed(env, session_id) {
        return None;
    } else {
        let parsed = parse_traceparent(env.get("TRACEPARENT").map(String::as_str).unwrap_or(""))?;
        TurnSeed {
            trace_id: parsed.trace_id,
            flags: parsed.flags,
            source: "upstream-env".into(),
            tracestate: sanitize_tracestate(env.get("TRACESTATE").map(String::as_str)),
        }
    };
    let path = tool_context_path(env, session_id, tool_use_id);
    if let Some(existing) = read_tool_record(&path) {
        return Some(existing);
    }
    let span_id = random_hex(8);
    let traceparent = format!("00-{}-{span_id}-{}", turn.trace_id, turn.flags);
    let record = json!({
        "type": "tool",
        "source": turn.source,
        "sessionId": session_id,
        "promptId": if prompt_id.is_empty() { Value::Null } else { Value::String(prompt_id.to_string()) },
        "toolUseId": tool_use_id,
        "traceId": turn.trace_id,
        "spanId": span_id,
        "traceparent": traceparent,
        "tracestate": turn.tracestate,
        "ts": iso_now(),
    });
    publish_record(&path, &record, |value| {
        tool_context_from_value(value).is_some()
    })
    .and_then(|value| tool_context_from_value(&value))
}

struct TurnSeed {
    trace_id: String,
    flags: String,
    source: String,
    tracestate: Option<String>,
}

fn reserve_turn_context(
    env: &Env,
    session_id: &str,
    prompt_id: &str,
    generate_when_missing: bool,
) -> Option<TurnSeed> {
    let path = turn_context_path(env, session_id, prompt_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Some(existing) = read_turn_seed(&path) {
        if existing.source == "upstream-env" && propagation_consumed(env, session_id) {
            return None;
        }
        return Some(existing);
    }
    let upstream = if propagation_consumed(env, session_id) {
        None
    } else {
        parse_traceparent(env.get("TRACEPARENT").map(String::as_str).unwrap_or(""))
    };
    if upstream.is_none() && !generate_when_missing {
        return None;
    }
    let record = if let Some(upstream) = upstream {
        json!({
            "type": "turn",
            "source": "upstream-env",
            "sessionId": session_id,
            "promptId": prompt_id,
            "traceId": upstream.trace_id,
            "parentSpanId": upstream.parent_span_id,
            "flags": upstream.flags,
            "tracestate": sanitize_tracestate(env.get("TRACESTATE").map(String::as_str)),
            "ts": iso_now(),
        })
    } else {
        json!({
            "type": "turn",
            "source": "local",
            "sessionId": session_id,
            "promptId": prompt_id,
            "traceId": random_hex(16),
            "flags": "01",
            "ts": iso_now(),
        })
    };
    let published = publish_record(&path, &record, |value| {
        read_turn_seed_value(value).is_some()
    })?;
    read_turn_seed_value(&published)
}

fn read_turn_seed(path: &Path) -> Option<TurnSeed> {
    read_turn_seed_value(&serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?)
}

fn read_turn_seed_value(value: &Value) -> Option<TurnSeed> {
    let trace_id = value
        .get("traceId")
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    let flags = value
        .get("flags")
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    let source = value.get("source").and_then(Value::as_str)?.to_string();
    if trace_id.len() != 32
        || trace_id.chars().all(|ch| ch == '0')
        || flags.len() != 2
        || (source != "upstream-env" && source != "local")
    {
        return None;
    }
    Some(TurnSeed {
        trace_id,
        flags,
        source,
        tracestate: sanitize_tracestate(value.get("tracestate").and_then(Value::as_str)),
    })
}

fn read_tool_record(path: &Path) -> Option<ToolContext> {
    tool_context_from_value(&serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?)
}

fn tool_context_from_value(value: &Value) -> Option<ToolContext> {
    let span_id = value
        .get("spanId")
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    let traceparent = value
        .get("traceparent")
        .and_then(Value::as_str)?
        .to_string();
    let parsed = parse_traceparent(&traceparent)?;
    if span_id.len() != 16 || span_id.chars().all(|ch| ch == '0') {
        return None;
    }
    Some(ToolContext {
        traceparent,
        tracestate: sanitize_tracestate(value.get("tracestate").and_then(Value::as_str)),
        span_id,
        trace_id: parsed.trace_id,
    })
}

fn consume_tool_context(env: &Env, session_id: &str, tool_use_id: &str) -> Option<ToolContext> {
    let path = tool_context_path(env, session_id, tool_use_id);
    let record = read_tool_record(&path)?;
    let _ = fs::remove_file(path);
    Some(record)
}

// Match the Agent-hosted publisher: complete same-directory temp, immutable
// create-if-absent link, and losers read the validated winner. A rename would
// replace another process's seed on Unix and split parallel hooks into traces.
fn publish_record(path: &Path, record: &Value, valid: fn(&Value) -> bool) -> Option<Value> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    let tmp = path.with_extension(format!("tmp.{}.{}", std::process::id(), random_hex(4)));
    let result = (|| -> Option<Value> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).ok()?;
        file.write_all(&serde_json::to_vec(record).ok()?).ok()?;
        drop(file);
        match fs::hard_link(&tmp, path) {
            Ok(()) => Some(record.clone()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                read_published_record(path, valid)
            }
            Err(_) => None,
        }
    })();
    let _ = fs::remove_file(&tmp);
    result
}

fn read_published_record(path: &Path, valid: fn(&Value) -> bool) -> Option<Value> {
    // A pre-upgrade writer may create the target before filling it. Retain the
    // original 20 x 5ms bounded retry and never invent a competing local seed.
    for attempt in 0..=20 {
        if let Some(value) = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(valid)
        {
            return Some(value);
        }
        if attempt < 20 {
            thread::sleep(Duration::from_millis(5));
        }
    }
    None
}

fn sanitize_tracestate(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(|ch| ch.is_control()) {
        None
    } else {
        Some(value.to_string())
    }
}

fn has_acp_turn_record(env: &Env, session_id: &str) -> bool {
    let path = correlate_dir(env).join(format!("{}.jsonl", safe_path_part(session_id)));
    let Ok(meta) = fs::metadata(&path) else {
        return false;
    };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    if meta.len() > 64 * 1024 {
        return true;
    }
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if value.get("type").and_then(Value::as_str) == Some("turn")
                && value
                    .get("traceparent")
                    .and_then(Value::as_str)
                    .is_some_and(|trace| parse_traceparent(trace).is_some())
            {
                return true;
            }
        } else if line.contains("\"type\":\"turn\"") || line.contains("\"type\": \"turn\"") {
            return true;
        }
    }
    false
}

fn build_bash_updated_input(
    tool_input: Option<&Value>,
    traceparent: Option<&str>,
    tracestate: Option<&str>,
    resource_attributes: Option<&str>,
) -> Option<Value> {
    let input = tool_input?.as_object()?;
    let command = input.get("command")?.as_str()?;
    if command.is_empty() {
        return None;
    }
    let resource_attributes = sanitize_resource_attributes(resource_attributes);
    if traceparent.is_none() && resource_attributes.is_none() {
        return None;
    }
    let mut exports = Vec::new();
    if let Some(traceparent) = traceparent {
        exports.push(format!(
            "export TRACEPARENT={}",
            shell_single_quote(traceparent)
        ));
        if let Some(tracestate) = tracestate {
            exports.push(format!(
                "export TRACESTATE={}",
                shell_single_quote(tracestate)
            ));
        }
    }
    if let Some(resource_attributes) = resource_attributes {
        exports.push(format!(
            "export OTEL_RESOURCE_ATTRIBUTES={}",
            shell_single_quote(&resource_attributes)
        ));
    }
    let mut updated = input.clone();
    updated.insert(
        "command".into(),
        Value::String(format!("{};\n{command}", exports.join("; "))),
    );
    Some(Value::Object(updated))
}

fn sanitize_resource_attributes(value: Option<&str>) -> Option<String> {
    let value = value?.trim_end_matches(['\r', '\n']);
    if value.trim().is_empty() || value.len() > 8 * 1024 || value.chars().any(|ch| ch.is_control())
    {
        None
    } else {
        Some(value.to_string())
    }
}

impl Clone for ApiError {
    fn clone(&self) -> Self {
        Self {
            kind: self.kind.clone(),
            status: self.status,
            request_id: self.request_id.clone(),
        }
    }
}

impl Clone for LlmCall {
    fn clone(&self) -> Self {
        Self {
            timestamp: self.timestamp.clone(),
            request_start: self.request_start.clone(),
            model: self.model.clone(),
            message_id: self.message_id.clone(),
            input_messages: self.input_messages.clone(),
            output_content: self.output_content.clone(),
            stop_reason: self.stop_reason.clone(),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read: self.cache_read,
            cache_create: self.cache_create,
            declared: self.declared.clone(),
            tools: self.tools.clone(),
            prompt_id: self.prompt_id.clone(),
            api_error: self.api_error.clone(),
        }
    }
}

impl Clone for ToolDetail {
    fn clone(&self) -> Self {
        Self {
            call: self.call.clone(),
            result: self.result.clone(),
            result_content: self.result_content.clone(),
            is_error: self.is_error,
            agent_id: self.agent_id.clone(),
            agent_type: self.agent_type.clone(),
            status: self.status.clone(),
            is_async: self.is_async,
        }
    }
}

#[cfg(test)]
mod transcript_history_contracts {
    use super::*;
    fn fixture(write_line: u32) -> (tempfile::TempDir, PathBuf) {
        // AST-extracted literal-only synthetic fixtures from immutable ef8953.
        // No JS test, source module, real HOME, or runtime config is executed.
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/claude-parser-history.json"
        ))
        .unwrap();
        let rows = fixtures[format!("write-L{write_line}")].as_array().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("native transcript 中文.jsonl");
        write_rows(&file, rows);
        (dir, file)
    }
    fn write_rows(path: &Path, rows: &[Value]) {
        let mut text = rows
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        text.push('\n');
        fs::write(path, text).unwrap();
    }
    fn parse(write_line: u32) -> ParsedTranscript {
        let (_dir, file) = fixture(write_line);
        parse_claude_transcript(&file, 0).unwrap()
    }
    fn at(second: &str) -> String {
        format!("2026-06-04T02:57:{second}Z")
    }

    #[test]
    fn parses_turn_usage_and_real_next_byte_offset() {
        let (_dir, file) = fixture(27);
        let parsed = parse_claude_transcript(&file, 0).unwrap();
        assert_eq!(parsed.next_offset, fs::metadata(file).unwrap().len());
        assert_eq!(parsed.turns.len(), 1);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls.len(), 1);
        assert_eq!((calls[0].input_tokens, calls[0].output_tokens), (10, 5));
        assert_eq!(calls[0].stop_reason, "end_turn");
    }
    #[test]
    fn complete_checkpoint_resumes_at_eof_without_replaying_turns() {
        let (_dir, file) = fixture(52);
        let first = parse_claude_transcript(&file, 0).unwrap();
        assert_eq!(first.turns.len(), 1);
        let next = parse_claude_transcript(&file, first.next_offset).unwrap();
        assert!(next.turns.is_empty());
        assert_eq!(next.next_offset, first.next_offset);
    }
    #[test]
    fn chunks_of_same_message_merge_and_longest_text_survives() {
        let parsed = parse(65);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls.len(), 1);
        let text = calls[0]
            .output_content
            .iter()
            .find(|b| b["type"] == "text")
            .unwrap();
        assert_eq!(text["text"], "hello world");
    }
    #[test]
    fn prompt_ids_split_turns_and_preserve_distinct_prompt_timestamps() {
        let parsed = parse(78);
        assert_eq!(parsed.turns.len(), 2);
        for (i, (prompt, ts)) in [
            ("q1", "2026-06-04T02:57:32.000Z"),
            ("q2", "2026-06-04T02:58:00.000Z"),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(parsed.turns[i].prompt, prompt);
            assert_eq!(parsed.turns[i].prompt_timestamp.as_deref(), Some(ts));
            assert_eq!(parsed.turns[i].llm_calls.len(), 1);
        }
    }
    #[test]
    fn resume_meta_does_not_replace_real_prompt_or_enter_llm_input() {
        let parsed = parse(96);
        let turn = &parsed.turns[0];
        assert_eq!(turn.prompt, "real user prompt");
        assert!(!serde_json::to_string(&turn.llm_calls[0].input_messages)
            .unwrap()
            .contains("Continue from where you left off."));
    }
    #[test]
    fn meta_only_uses_boundary_time_without_exposing_meta_text() {
        let parsed = parse(109);
        let turn = &parsed.turns[0];
        assert_eq!(turn.prompt, "");
        assert_eq!(
            turn.prompt_timestamp.as_deref(),
            Some(at("30.000").as_str())
        );
        assert_eq!(
            turn.llm_calls[0].request_start.as_deref(),
            Some(at("30.000").as_str())
        );
        assert!(!serde_json::to_string(&turn.llm_calls[0].input_messages)
            .unwrap()
            .contains("Continue from where you left off."));
    }
    #[test]
    fn resume_synthetic_placeholder_does_not_create_call_or_move_real_start() {
        let parsed = parse(122);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].model, "qwen3.7-max");
        assert_eq!(
            calls[0].request_start.as_deref(),
            Some(at("32.000").as_str())
        );
    }
    #[test]
    fn synthetic_api_error_is_structured_failure_and_discards_private_error_body() {
        let parsed = parse(138);
        assert_eq!(parsed.turns.len(), 1);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(call.model, "unknown");
        assert_eq!(call.message_id, "synthetic-error-message");
        assert!(call.output_content.is_empty());
        assert_eq!(call.stop_reason, "error");
        let error = call.api_error.as_ref().unwrap();
        assert_eq!(error.kind, "server_error");
        assert_eq!(error.status, Some(529));
        assert_eq!(error.request_id.as_deref(), Some("req-error-11"));
        assert!(!serde_json::to_string(&call.input_messages)
            .unwrap()
            .contains("private upstream detail"));
    }
    #[test]
    fn tool_result_stays_in_same_turn_and_next_input_is_exact_delta() {
        let parsed = parse(177);
        assert_eq!(parsed.turns.len(), 1);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].input_messages,
            json!([{"role":"user","content":[{"type":"text","text":"do it"}]}])
                .as_array()
                .unwrap()
                .clone()
        );
        assert_eq!(calls[1].input_messages,json!([{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]).as_array().unwrap().clone());
    }
    #[test]
    fn tool_result_request_start_does_not_cross_prompt_id_boundary() {
        let parsed = parse(204);
        assert_eq!(parsed.turns.len(), 2);
        assert_eq!(
            parsed.turns[1].llm_calls[0].request_start.as_deref(),
            Some("2026-06-04T03:12:32.000Z")
        );
    }
    #[test]
    fn streaming_first_response_timestamp_and_tool_result_request_boundary_are_exact() {
        let parsed = parse(219);
        assert_eq!(parsed.turns.len(), 1);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls[0].timestamp.as_deref(), Some(at("49.546").as_str()));
        assert_eq!(
            calls[1].request_start.as_deref(),
            Some(at("51.879").as_str())
        );
        assert_eq!(calls[1].timestamp.as_deref(), Some(at("56.868").as_str()));
    }
    #[test]
    fn declared_tool_ids_accumulate_across_streaming_message_chunks() {
        let parsed = parse(238);
        assert_eq!(parsed.turns[0].llm_calls[0].declared, ["tool_A", "tool_B"]);
    }
    #[test]
    fn tool_detail_preserves_actual_call_result_time_content_and_success() {
        let parsed = parse(253);
        let detail = &parsed.turns[0].llm_calls[0].tools["tool_X"];
        assert_eq!(detail.call.as_deref(), Some(at("49.000").as_str()));
        assert_eq!(detail.result.as_deref(), Some(at("49.200").as_str()));
        assert_eq!(detail.result_content, "data");
        assert!(!detail.is_error);
    }
    #[test]
    fn parallel_streamed_tools_all_belong_to_declaring_call_and_exact_next_input() {
        let parsed = parse(271);
        assert_eq!(parsed.turns.len(), 1);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].declared, ["read_1", "read_2", "read_3"]);
        assert_eq!(calls[0].tools.len(), 3);
        assert!(calls[1].declared.is_empty());
        assert_eq!(
            calls[1].request_start.as_deref(),
            Some(at("53.000").as_str())
        );
        let expected = json!([{"role":"assistant","content":[{"type":"thinking","thinking":"reading..."},{"type":"tool_use","id":"read_1","name":"Read","input":{"file_path":"/a.txt"}},{"type":"tool_use","id":"read_2","name":"Read","input":{"file_path":"/b.txt"}},{"type":"tool_use","id":"read_3","name":"Read","input":{"file_path":"/c.txt"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"read_1","content":"aaa"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"read_2","content":"bbb"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"read_3","content":"ccc"}]}]);
        assert_eq!(
            calls[1].input_messages,
            expected.as_array().unwrap().clone()
        );
    }
    #[test]
    fn missing_message_id_still_exports_final_call_with_local_identity() {
        let parsed = parse(320);
        assert_eq!(parsed.turns.len(), 1);
        let calls = &parsed.turns[0].llm_calls;
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].stop_reason, "end_turn");
        assert_eq!(calls[1].model, "claude-opus-4-6");
        assert_eq!(calls[1].output_tokens, 30);
        assert!(calls[1].message_id.starts_with("_syn_"));
    }
    #[test]
    fn missing_prompt_id_sequence_fills_starts_and_keeps_tool_boundary_with_or_without_ids() {
        for missing_id in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("no-prompt.jsonl");
            let assistant = |id: &str, ts: &str, content: Value| {
                let mut row =
                    json!({"type":"assistant","timestamp":at(ts),"message":{"content":content}});
                if !missing_id {
                    row["message"]["id"] = id.into();
                }
                row
            };
            let rows = vec![
                json!({"type":"user","timestamp":at("32.000"),"message":{"content":"hello"}}),
                assistant("m1", "40.000", json!([{"type":"text","text":"first"}])),
                assistant("m2", "41.000", json!([{"type":"text","text":"second"}])),
                assistant(
                    "m3",
                    "42.000",
                    json!([{"type":"tool_use","id":"t1","name":"Bash","input":{}}]),
                ),
                json!({"type":"user","timestamp":at("43.000"),"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}),
                assistant("m4", "44.000", json!([{"type":"text","text":"done"}])),
            ];
            write_rows(&file, &rows);
            let parsed = parse_claude_transcript(&file, 0).unwrap();
            assert_eq!(parsed.turns.len(), 1);
            let turn = &parsed.turns[0];
            assert!(turn.prompt_id.is_none());
            assert_eq!(
                turn.llm_calls
                    .iter()
                    .map(|c| c.request_start.clone().unwrap())
                    .collect::<Vec<_>>(),
                [at("40.000"), at("40.000"), at("41.000"), at("43.000")]
            );
        }
    }
    #[test]
    fn orphan_call_uses_own_time_without_leaking_other_turn_boundary() {
        let parsed = parse(368);
        assert_eq!(parsed.turns.len(), 2);
        let prompt = parsed
            .turns
            .iter()
            .find(|t| t.prompt_id.as_deref() == Some("p1"))
            .unwrap();
        assert_eq!(
            prompt.llm_calls[0].request_start.as_deref(),
            Some(at("32.000").as_str())
        );
        let orphan = parsed.turns.iter().find(|t| t.prompt_id.is_none()).unwrap();
        assert_eq!(
            orphan.llm_calls[0].request_start.as_deref(),
            Some(at("30.000").as_str())
        );
    }
    #[test]
    fn assistant_only_appended_fragment_starts_from_fragment_time() {
        let (_dir, file) = fixture(383);
        let first = parse_claude_transcript(&file, 0).unwrap();
        let row =
            json!({"type":"assistant","timestamp":at("45.000"),"message":{"id":"m2","content":[]}});
        let mut writer = OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(writer, "{row}").unwrap();
        drop(writer);
        let next = parse_claude_transcript(&file, first.next_offset).unwrap();
        assert_eq!(next.next_offset, fs::metadata(&file).unwrap().len());
        assert_eq!(next.turns.len(), 1);
        assert_eq!(next.turns[0].llm_calls.len(), 1);
        assert_eq!(
            next.turns[0].llm_calls[0].request_start.as_deref(),
            Some(at("45.000").as_str())
        );
    }
    #[test]
    fn missing_prompt_id_never_places_request_start_after_response() {
        let parsed = parse(401);
        assert_eq!(
            parsed.turns[0].llm_calls[0].request_start.as_deref(),
            Some(at("40.000").as_str())
        );
    }
    #[test]
    fn first_call_request_start_uses_real_prompt_timestamp() {
        let parsed = parse(411);
        let turn = &parsed.turns[0];
        assert_eq!(
            turn.llm_calls[0].request_start.as_deref(),
            Some(at("32.000").as_str())
        );
        assert_eq!(
            turn.prompt_timestamp.as_deref(),
            Some(at("32.000").as_str())
        );
    }
    #[test]
    fn content_text_dedup_keeps_longest_observed_version() {
        let blocks = json!([{"type":"text","text":"a"},{"type":"text","text":"abc"},{"type":"text","text":"ab"}]);
        let blocks = dedup_blocks(blocks.as_array().unwrap());
        assert_eq!(
            blocks.iter().find(|b| b["type"] == "text").unwrap()["text"],
            "abc"
        );
    }
    #[test]
    fn content_tool_dedup_uses_real_tool_id() {
        let blocks = json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"x":1}},{"type":"tool_use","id":"t1","name":"Bash","input":{"x":1}},{"type":"tool_use","id":"t2","name":"Read","input":{}}]);
        let blocks = dedup_blocks(blocks.as_array().unwrap());
        assert_eq!(blocks.iter().filter(|b| b["type"] == "tool_use").count(), 2);
    }
    #[test]
    fn content_blocks_keep_thinking_then_text_then_tool_natural_order() {
        let blocks = json!([{"type":"tool_use","id":"t1","name":"X"},{"type":"text","text":"reasoning result"},{"type":"thinking","thinking":"hmm"}]);
        let blocks = dedup_blocks(blocks.as_array().unwrap());
        assert_eq!(
            blocks
                .iter()
                .map(|b| b["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["thinking", "text", "tool_use"]
        );
    }
}

#[cfg(test)]
mod partial_transcript_recovery_contracts {
    use super::*;
    #[test]
    fn incomplete_multibyte_tail_keeps_checkpoint_before_tail_then_recovers_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("partial transcript.jsonl");
        let first = json!({"type":"assistant","timestamp":"2026-06-04T02:57:40.000Z","message":{"id":"first","content":[{"type":"text","text":"first answer"}]}});
        let next = json!({"type":"assistant","timestamp":"2026-06-04T02:57:45.000Z","message":{"id":"next","content":[{"type":"text","text":"你好 recovered"}],"usage":{"input_tokens":3,"output_tokens":2},"stop_reason":"end_turn"}});
        let mut prefix = serde_json::to_vec(&first).unwrap();
        prefix.push(b'\n');
        let bytes = serde_json::to_vec(&next).unwrap();
        let split = bytes
            .windows("你".len())
            .position(|w| w == "你".as_bytes())
            .unwrap()
            + 1;
        let mut pending = prefix.clone();
        pending.extend_from_slice(&bytes[..split]);
        fs::write(&file, pending).unwrap();
        let observed = parse_claude_transcript(&file, 0).unwrap();
        assert_eq!(observed.next_offset, prefix.len() as u64);
        assert_eq!(observed.turns.len(), 1);
        assert_eq!(observed.turns[0].llm_calls[0].message_id, "first");
        let waiting = parse_claude_transcript(&file, observed.next_offset).unwrap();
        assert_eq!(waiting.next_offset, observed.next_offset);
        assert!(waiting.turns.is_empty());
        let mut writer = OpenOptions::new().append(true).open(&file).unwrap();
        writer.write_all(&bytes[split..]).unwrap();
        writer.write_all(b"\n").unwrap();
        drop(writer);
        let recovered = parse_claude_transcript(&file, observed.next_offset).unwrap();
        assert_eq!(recovered.next_offset, fs::metadata(&file).unwrap().len());
        assert_eq!(recovered.turns.len(), 1);
        assert_eq!(recovered.turns[0].llm_calls.len(), 1);
        let call = &recovered.turns[0].llm_calls[0];
        assert_eq!(call.message_id, "next");
        assert_eq!(
            call.output_content,
            json!([{"type":"text","text":"你好 recovered"}])
                .as_array()
                .unwrap()
                .clone()
        );
        assert_eq!((call.input_tokens, call.output_tokens), (3, 2));
        assert!(parse_claude_transcript(&file, recovered.next_offset)
            .unwrap()
            .turns
            .is_empty());
    }
    #[test]
    fn malformed_complete_line_does_not_block_next_valid_record_and_complete_tail_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("malformed.jsonl");
        let row = json!({"type":"assistant","timestamp":"2026-06-04T02:57:40.000Z","message":{"id":"valid","content":[{"type":"text","text":"valid answer"}]}});
        fs::write(&file, format!("{{broken JSON}}\n{row}")).unwrap();
        let parsed = parse_claude_transcript(&file, 0).unwrap();
        assert_eq!(parsed.next_offset, fs::metadata(&file).unwrap().len());
        assert_eq!(parsed.turns.len(), 1);
        assert_eq!(parsed.turns[0].llm_calls[0].message_id, "valid");
        assert_eq!(
            parsed.turns[0].llm_calls[0].output_content,
            json!([{"type":"text","text":"valid answer"}])
                .as_array()
                .unwrap()
                .clone()
        );
    }
}

#[cfg(test)]
#[path = "claude_tool_context_history.rs"]
mod tool_context_history;
