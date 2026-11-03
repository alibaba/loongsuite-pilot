//! Qoder Work hook transcript processor.
//!
//! Port of `assets/hooks/qoderwork-hook-processor.mjs` for `qoderwork`,
//! `qoder-work`, and `qoder-work-cn`. One [`run`] handles all three; the agent
//! id comes from `--agent-id` and `--log-prefix` defaults to that id.
//!
//! Assistant rows between `tool_result` boundaries are one LLM call. Rows that
//! share a `parentUuid` stay together for that reason. `groupByParentUuid` in
//! the JavaScript file is unused.

use super::common::{
    append_history_rows, data_dir, decode_payload, env_get, filter_workspace_records, home_dir,
    hostname, load_runtime_config, local_date, local_stamp_seconds, now_unix_nanos,
    sanitize_record, sha256_hex, with_file_lock, write_empty, Env, HookRequest, Obj,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let Some((agent_id, log_prefix)) = parse_args(request.args) else {
        eprintln!("hook-processor: --agent-id is required");
        return 1;
    };
    let raw = decode_payload(request.stdin);
    write_empty(request.stdout);
    let Some(payload) = parse_payload(request.env, &agent_id, &raw) else {
        return 0;
    };
    let cwd = payload
        .cwd
        .as_deref()
        .map(|cwd| resolve_qoder_work_project_dir(request.env, cwd, &agent_id));
    let cwd = cwd.as_deref().filter(|cwd| !cwd.is_empty());
    let runtime = load_runtime_config(request.env);
    let snapshot = read_transcript_snapshot(&payload.transcript_path);
    let Some(range) = line_range(
        request.env,
        &agent_id,
        &payload.transcript_path,
        &payload.session_id,
        snapshot.line_count,
    ) else {
        return 0;
    };
    let lines = slice_transcript_lines(&snapshot.lines, range.start, range.end);
    log_debug(
        request.env,
        &agent_id,
        &format!(
            "Read {} lines from {} (range: {}-{})",
            lines.len(),
            payload.transcript_path,
            range.start,
            range.end
        ),
    );
    if lines.is_empty() {
        update_line_record(
            request.env,
            &agent_id,
            &payload.transcript_path,
            &payload.session_id,
            range.end,
        );
        return 0;
    }
    let mut parsed = Vec::new();
    for line in &lines {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            parsed.push(value);
        }
    }
    if parsed.is_empty() {
        update_line_record(
            request.env,
            &agent_id,
            &payload.transcript_path,
            &payload.session_id,
            range.end,
        );
        return 0;
    }
    let records = process_transcript(
        &parsed,
        &payload.session_id,
        &agent_id,
        &runtime.user_id,
        cwd,
        &range.reason,
        request.env,
    );
    log_debug(
        request.env,
        &agent_id,
        &format!("Produced {} events", records.len()),
    );
    if append_produced(request.env, &agent_id, &log_prefix, &records) {
        log_debug(
            request.env,
            &agent_id,
            &format!("Successfully appended {} rows", records.len()),
        );
        update_line_record(
            request.env,
            &agent_id,
            &payload.transcript_path,
            &payload.session_id,
            range.end,
        );
    }
    0
}

struct HookPayload {
    transcript_path: String,
    session_id: String,
    cwd: Option<String>,
}

fn parse_args(args: &[String]) -> Option<(String, String)> {
    let mut agent_id = String::new();
    let mut log_prefix = String::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--agent-id" && index + 1 < args.len() {
            index += 1;
            agent_id.clone_from(&args[index]);
        } else if args[index] == "--log-prefix" && index + 1 < args.len() {
            index += 1;
            log_prefix.clone_from(&args[index]);
        }
        index += 1;
    }
    if agent_id.is_empty() {
        agent_id = hook_agent_token()
            .map(|token| canonical_work_agent(&token))
            .unwrap_or_default();
    }
    if agent_id.is_empty() {
        return None;
    }
    if log_prefix.is_empty() {
        log_prefix.clone_from(&agent_id);
    }
    Some((agent_id, log_prefix))
}

fn hook_agent_token() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == "hook-process")?;
    let agent = args.get(index + 1)?;
    if agent.is_empty() || agent.starts_with('-') {
        None
    } else {
        Some(agent.clone())
    }
}

fn canonical_work_agent(token: &str) -> String {
    match token {
        "qoderwork" | "qoder-work" => "qoder-work".to_string(),
        "qoderworkcn" | "qoder-work-cn" => "qoder-work-cn".to_string(),
        other => other.to_string(),
    }
}

fn parse_payload(env: &Env, agent_id: &str, raw: &str) -> Option<HookPayload> {
    if raw.trim().is_empty() {
        return None;
    }
    log_debug(
        env,
        agent_id,
        &format!("stdin payload: {} bytes", raw.chars().count()),
    );
    let value: Value = match serde_json::from_str(raw.trim()) {
        Ok(value) => value,
        Err(err) => {
            log_debug(env, agent_id, &format!("Failed to parse stdin JSON: {err}"));
            return None;
        }
    };
    let payload = value.as_object()?;
    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let session_log = payload
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    log_debug(
        env,
        agent_id,
        &format!("event: {event}, session: {session_log}"),
    );
    let keys = payload.keys().cloned().collect::<Vec<_>>().join(", ");
    log_debug(env, agent_id, &format!("payload keys: {keys}"));
    if payload.get("stop_hooks_active").is_some_and(js_truthy) {
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
    let session_id = non_empty_string(payload.get("session_id"))
        .or_else(|| non_empty_string(payload.get("conversation_id")))
        .unwrap_or_default();
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
    Some(HookPayload {
        transcript_path: transcript_path.to_string(),
        session_id,
        cwd: non_empty_string(payload.get("cwd")),
    })
}

fn process_transcript(
    parsed: &[Value],
    session_id: &str,
    agent_id: &str,
    configured_user_id: &str,
    cwd: Option<&str>,
    range_reason: &str,
    env: &Env,
) -> Vec<Obj> {
    let observed = now_unix_nanos();
    if is_review_copy(parsed) {
        log_debug(
            env,
            agent_id,
            &format!("Skipping review-copy session {session_id}"),
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
    let all_turns = split_into_turns(&content);
    let bootstrap = range_reason != "incremental";
    let selected: Vec<&[usize]> = if bootstrap {
        all_turns.last().map(Vec::as_slice).into_iter().collect()
    } else {
        all_turns.iter().map(Vec::as_slice).collect()
    };
    if bootstrap && all_turns.len() > selected.len() {
        log_debug(
            env,
            agent_id,
            &format!(
                "Cursor recovery ({range_reason}): skipped {} historical turn(s), kept latest turn",
                all_turns.len() - selected.len()
            ),
        );
    }
    let first = selected
        .first()
        .and_then(|turn| turn.first())
        .map(|index| &content[*index])
        .unwrap_or(&content[0]);
    let user_id = resolve_user_id(first, configured_user_id);
    let provider = infer_provider_name(None, "", agent_id);
    let mut records = Vec::new();
    for turn in selected {
        let turn_rows: Vec<&Value> = turn.iter().map(|index| &content[*index]).collect();
        let turn_id = get_turn_id(&turn_rows);
        records.extend(build_turn_events(
            &turn_rows,
            &TurnCtx {
                turn_id: &turn_id,
                session_id,
                user_id: &user_id,
                provider: &provider,
                observed: &observed,
                cwd,
                agent_id,
            },
        ));
    }
    let mode = if bootstrap {
        "bootstrap"
    } else {
        "incremental"
    };
    let batch = uuid::Uuid::new_v4().to_string();
    for record in &mut records {
        record.insert(
            "agent.transcript.cursor_mode".into(),
            Value::String(mode.into()),
        );
        record.insert(
            "agent.transcript.cursor_reason".into(),
            Value::String(range_reason.into()),
        );
        record.insert(
            "agent.transcript.cursor_batch_id".into(),
            Value::String(batch.clone()),
        );
    }
    records
}

struct TurnCtx<'a> {
    turn_id: &'a str,
    session_id: &'a str,
    user_id: &'a str,
    provider: &'a str,
    observed: &'a str,
    cwd: Option<&'a str>,
    agent_id: &'a str,
}

fn build_turn_events(turn_rows: &[&Value], ctx: &TurnCtx<'_>) -> Vec<Obj> {
    let mut records = Vec::new();
    let user_row = turn_rows.iter().copied().find(|row| is_prompt_row(row));
    let prompt_id = user_row
        .and_then(|row| non_empty_string(row.get("promptId")))
        .unwrap_or_else(|| ctx.turn_id.to_string());
    let user_text = user_row.map(extract_text).unwrap_or_default();
    let user_ts = user_row.map(|row| timestamp_to_unix_nanos(row.get("timestamp")));
    if let Some(user_row) = user_row {
        if !user_text.is_empty() {
            let mut fields = turn_fields(&prompt_id);
            insert_str(&mut fields, "event.name", "other");
            insert_str(&mut fields, "gen_ai.turn.id", ctx.turn_id);
            insert_str(&mut fields, "gen_ai.session.id", ctx.session_id);
            insert_str(&mut fields, "gen_ai.agent.type", ctx.agent_id);
            insert_str(&mut fields, "gen_ai.provider.name", ctx.provider);
            insert_str(&mut fields, "user.id", ctx.user_id);
            fields.insert(
                "gen_ai.input.messages_delta".into(),
                user_text_delta(&user_text),
            );
            insert_str(
                &mut fields,
                "time_unix_nano",
                &timestamp_to_unix_nanos(user_row.get("timestamp")),
            );
            insert_str(&mut fields, "observed_time_unix_nano", ctx.observed);
            records.push(build_record(fields, turn_rows[0], ctx.cwd));
        }
    }

    let tool_results = index_tool_results(turn_rows);
    let groups = group_assistant_rows_by_tool_results(turn_rows);
    let mut prev_calls: Vec<ToolCall> = Vec::new();
    let mut prev_parts: Vec<Value> = Vec::new();
    let mut prev_tool_result_ts: Option<String> = None;
    for (offset, group) in groups.iter().enumerate() {
        let step_counter = offset + 1;
        let step_id = format!("{}:s{step_counter}", ctx.turn_id);
        let output = extract_assistant_output(group);
        let input_delta = step_input_delta(
            step_counter,
            &user_text,
            &prev_calls,
            &prev_parts,
            &tool_results,
        );
        let request_ts = if step_counter == 1 {
            user_ts.clone()
        } else {
            prev_tool_result_ts.clone()
        };
        let request_ts = request_ts
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| timestamp_to_unix_nanos(group[0].get("timestamp")));
        records.extend(build_step_events(
            group,
            &output,
            &tool_results,
            turn_rows,
            ctx,
            StepRequest {
                step_id: &step_id,
                prompt_id: &prompt_id,
                input_delta,
                request_ts: &request_ts,
            },
        ));
        if let Some(ts) = last_tool_result_ts(&output.tool_calls, &tool_results, turn_rows) {
            prev_tool_result_ts = Some(ts);
        }
        prev_calls = output.tool_calls;
        prev_parts = output.parts;
    }
    records
}

fn step_input_delta(
    step_counter: usize,
    user_text: &str,
    prev_calls: &[ToolCall],
    prev_parts: &[Value],
    tool_results: &HashMap<String, ToolResultHit>,
) -> Option<Value> {
    if step_counter == 1 && !user_text.is_empty() {
        return Some(user_text_delta(user_text));
    }
    if prev_calls.is_empty() {
        return None;
    }
    let completed: Vec<&ToolCall> = prev_calls
        .iter()
        .filter(|call| {
            call.id
                .as_deref()
                .is_some_and(|id| !id.is_empty() && tool_results.contains_key(id))
        })
        .collect();
    if completed.is_empty() {
        return None;
    }
    let completed_ids: HashSet<&str> = completed
        .iter()
        .filter_map(|call| call.id.as_deref())
        .collect();
    let parts: Vec<Value> = prev_parts
        .iter()
        .filter(|part| match part.get("type").and_then(Value::as_str) {
            Some("tool_call") => part
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| completed_ids.contains(id)),
            _ => true,
        })
        .cloned()
        .collect();
    let mut messages = vec![json!({ "role": "assistant", "parts": parts })];
    for call in completed {
        let Some(id) = call.id.as_deref() else {
            continue;
        };
        let Some(hit) = tool_results.get(id) else {
            continue;
        };
        let mut response = Obj::new();
        response.insert("type".into(), Value::String("tool_call_response".into()));
        response.insert("id".into(), Value::String(id.to_string()));
        if let Some(text) = stringify_jsonish(hit.block.get("content")) {
            response.insert("response".into(), Value::String(text));
        }
        let mut message = Obj::new();
        message.insert("role".into(), Value::String("tool".into()));
        message.insert("parts".into(), Value::Array(vec![Value::Object(response)]));
        messages.push(Value::Object(message));
    }
    Some(Value::Array(messages))
}

struct StepRequest<'a> {
    step_id: &'a str,
    prompt_id: &'a str,
    input_delta: Option<Value>,
    request_ts: &'a str,
}

fn build_step_events(
    group: &[&Value],
    output: &AssistantOutput,
    tool_results: &HashMap<String, ToolResultHit>,
    turn_rows: &[&Value],
    ctx: &TurnCtx<'_>,
    request: StepRequest<'_>,
) -> Vec<Obj> {
    let StepRequest {
        step_id,
        prompt_id,
        input_delta,
        request_ts,
    } = request;
    let mut records = Vec::new();
    let first = group[0];
    let last = group[group.len() - 1];
    let response_ts = timestamp_to_unix_nanos(
        group
            .iter()
            .copied()
            .find(|row| is_thinking_row(row))
            .unwrap_or(last)
            .get("timestamp"),
    );
    let response_id = response_id(first);
    let finish_reason = if output.tool_calls.is_empty() {
        "stop"
    } else {
        "tool_calls"
    };

    let mut request = turn_fields(prompt_id);
    insert_str(&mut request, "event.name", "llm.request");
    insert_str(&mut request, "gen_ai.step.id", step_id);
    insert_str(&mut request, "gen_ai.turn.id", ctx.turn_id);
    insert_str(&mut request, "gen_ai.session.id", ctx.session_id);
    insert_str(&mut request, "gen_ai.agent.type", ctx.agent_id);
    insert_str(&mut request, "gen_ai.provider.name", ctx.provider);
    insert_str(&mut request, "gen_ai.request.model", "auto");
    insert_str(&mut request, "user.id", ctx.user_id);
    insert_str(&mut request, "time_unix_nano", request_ts);
    insert_str(&mut request, "observed_time_unix_nano", ctx.observed);
    if let Some(delta) = input_delta {
        request.insert("gen_ai.input.messages_delta".into(), delta);
    }
    records.push(build_record(request, first, ctx.cwd));

    if !output.parts.is_empty() {
        let mut response = turn_fields(prompt_id);
        insert_str(&mut response, "event.name", "llm.response");
        insert_str(&mut response, "gen_ai.step.id", step_id);
        insert_str(&mut response, "gen_ai.turn.id", ctx.turn_id);
        insert_str(&mut response, "gen_ai.session.id", ctx.session_id);
        insert_str(&mut response, "gen_ai.agent.type", ctx.agent_id);
        insert_str(&mut response, "gen_ai.provider.name", ctx.provider);
        insert_str(&mut response, "gen_ai.request.model", "auto");
        insert_str(&mut response, "gen_ai.response.model", "auto");
        if let Some(id) = &response_id {
            insert_str(&mut response, "gen_ai.response.id", id);
        }
        response.insert(
            "gen_ai.response.finish_reasons".into(),
            json!([finish_reason]),
        );
        insert_str(&mut response, "user.id", ctx.user_id);
        response.insert(
            "gen_ai.output.messages".into(),
            json!([{
                "role": "assistant",
                "parts": output.parts,
                "finish_reason": finish_reason,
            }]),
        );
        insert_str(&mut response, "time_unix_nano", &response_ts);
        insert_str(&mut response, "observed_time_unix_nano", ctx.observed);
        records.push(build_record(response, first, ctx.cwd));
    }

    for call in &output.tool_calls {
        let mut tool_call = turn_fields(prompt_id);
        insert_str(&mut tool_call, "event.name", "tool.call");
        insert_str(&mut tool_call, "gen_ai.step.id", step_id);
        insert_str(&mut tool_call, "gen_ai.turn.id", ctx.turn_id);
        insert_str(&mut tool_call, "gen_ai.session.id", ctx.session_id);
        insert_str(&mut tool_call, "gen_ai.agent.type", ctx.agent_id);
        if let Some(name) = &call.name {
            tool_call.insert("gen_ai.tool.name".into(), name.clone());
        }
        if let Some(id) = &call.id {
            insert_str(&mut tool_call, "gen_ai.tool.call.id", id);
            insert_str(&mut tool_call, "gen_ai.tool.call.exec.id", id);
        }
        if let Some(input) = &call.input {
            insert_str(
                &mut tool_call,
                "gen_ai.tool.call.arguments",
                &json_string_or_raw(input),
            );
        }
        insert_str(&mut tool_call, "user.id", ctx.user_id);
        insert_str(
            &mut tool_call,
            "time_unix_nano",
            &timestamp_to_unix_nanos(last.get("timestamp")),
        );
        insert_str(&mut tool_call, "observed_time_unix_nano", ctx.observed);
        records.push(build_record(tool_call, first, ctx.cwd));

        let Some(id) = call.id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(hit) = tool_results.get(id) else {
            continue;
        };
        let result_row = turn_rows[hit.row_index];
        let mut tool_result = turn_fields(prompt_id);
        insert_str(&mut tool_result, "event.name", "tool.result");
        insert_str(&mut tool_result, "gen_ai.step.id", step_id);
        insert_str(&mut tool_result, "gen_ai.turn.id", ctx.turn_id);
        insert_str(&mut tool_result, "gen_ai.session.id", ctx.session_id);
        insert_str(&mut tool_result, "gen_ai.agent.type", ctx.agent_id);
        if let Some(name) = &call.name {
            tool_result.insert("gen_ai.tool.name".into(), name.clone());
        }
        insert_str(&mut tool_result, "gen_ai.tool.call.id", id);
        insert_str(&mut tool_result, "gen_ai.tool.call.exec.id", id);
        if let Some(text) = stringify_jsonish(hit.block.get("content")) {
            insert_str(&mut tool_result, "gen_ai.tool.call.result", &text);
        }
        let status = if hit.block.get("is_error").is_some_and(js_truthy) {
            "failure"
        } else {
            "success"
        };
        insert_str(&mut tool_result, "tool.result.status", status);
        insert_str(&mut tool_result, "user.id", ctx.user_id);
        insert_str(
            &mut tool_result,
            "time_unix_nano",
            &timestamp_to_unix_nanos(result_row.get("timestamp")),
        );
        insert_str(&mut tool_result, "observed_time_unix_nano", ctx.observed);
        records.push(build_record(tool_result, result_row, ctx.cwd));
    }
    records
}

fn turn_fields(prompt_id: &str) -> Obj {
    let mut fields = Obj::new();
    if !prompt_id.is_empty() {
        insert_str(&mut fields, "agent.qoderwork.promptId", prompt_id);
    }
    fields
}

fn user_text_delta(text: &str) -> Value {
    json!([{
        "role": "user",
        "parts": [{ "type": "text", "content": text }],
    }])
}

fn last_tool_result_ts(
    calls: &[ToolCall],
    tool_results: &HashMap<String, ToolResultHit>,
    turn_rows: &[&Value],
) -> Option<String> {
    let mut last = None;
    for call in calls {
        let Some(id) = call.id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(hit) = tool_results.get(id) else {
            continue;
        };
        let row = turn_rows[hit.row_index];
        if row.get("timestamp").is_some_and(js_truthy) {
            let nano = timestamp_to_unix_nanos(row.get("timestamp"));
            if !nano.is_empty() {
                last = Some(nano);
            }
        }
    }
    last
}

struct ToolCall {
    id: Option<String>,
    name: Option<Value>,
    input: Option<Value>,
}

struct AssistantOutput {
    parts: Vec<Value>,
    tool_calls: Vec<ToolCall>,
}

struct ToolResultHit {
    row_index: usize,
    block: Value,
}

/// One LLM response is the assistant rows between tool-result boundaries.
///
/// Qoder Work sometimes emits one model response as several assistant rows
/// with different `parentUuid` values. Splitting on `parentUuid` would turn
/// the later half into its own step and assign the tool's runtime to that
/// step's request time. A tool result is the boundary, because that is when
/// the model sees tool output and starts the next response.
fn group_assistant_rows_by_tool_results<'a>(turn_rows: &[&'a Value]) -> Vec<Vec<&'a Value>> {
    let mut groups = Vec::new();
    let mut current = Vec::new();
    for row in turn_rows {
        if row.get("type").and_then(Value::as_str) == Some("assistant") {
            current.push(*row);
        } else if row.get("type").and_then(Value::as_str) == Some("user")
            && is_tool_result(row)
            && !current.is_empty()
        {
            groups.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

fn extract_assistant_output(group: &[&Value]) -> AssistantOutput {
    let mut parts = Vec::new();
    let mut tool_calls = Vec::new();
    for row in group {
        let blocks = content_blocks(row);
        let content_type = content_type_of(row, blocks);
        if content_type == "thinking" {
            if let Some(thinking) = thinking_text(row, blocks) {
                parts.push(json!({ "type": "reasoning", "content": thinking }));
            }
        } else if content_type == "text" {
            if let Some(text) = visible_text(row, blocks) {
                parts.push(json!({ "type": "text", "content": text }));
            }
        } else if content_type == "tool_use" {
            let block = blocks
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"));
            let id = block.and_then(|block| present_string(block.get("id")));
            let name = block.and_then(|block| block.get("name").cloned());
            let input = block.and_then(|block| block.get("input").cloned());
            let mut part = Obj::new();
            part.insert("type".into(), Value::String("tool_call".into()));
            if let Some(id) = &id {
                part.insert("id".into(), Value::String(id.clone()));
            }
            if let Some(name) = &name {
                part.insert("name".into(), name.clone());
            }
            if let Some(input) = &input {
                part.insert("arguments".into(), input.clone());
            }
            parts.push(Value::Object(part));
            tool_calls.push(ToolCall { id, name, input });
        }
    }
    AssistantOutput { parts, tool_calls }
}

fn index_tool_results(turn_rows: &[&Value]) -> HashMap<String, ToolResultHit> {
    let mut indexed = HashMap::new();
    for (row_index, row) in turn_rows.iter().enumerate() {
        if row.get("type").and_then(Value::as_str) != Some("user") || !is_tool_result(row) {
            continue;
        }
        let blocks = match row
            .get("message")
            .and_then(|message| message.get("content"))
        {
            Some(Value::Array(blocks)) => blocks,
            _ => continue,
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = non_empty_string(block.get("tool_use_id")) else {
                continue;
            };
            indexed.entry(id).or_insert_with(|| ToolResultHit {
                row_index,
                block: block.clone(),
            });
        }
    }
    indexed
}

fn split_into_turns(rows: &[Value]) -> Vec<Vec<usize>> {
    let mut turns = Vec::new();
    let mut current = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if is_prompt_row(row) {
            if !current.is_empty() {
                turns.push(std::mem::take(&mut current));
            }
            current.push(index);
        } else {
            current.push(index);
        }
    }
    if !current.is_empty() {
        turns.push(current);
    }
    turns
}

fn get_turn_id(turn_rows: &[&Value]) -> String {
    if let Some(row) = turn_rows.iter().copied().find(|row| is_prompt_row(row)) {
        if let Some(id) = non_empty_string(row.get("promptId")) {
            return id;
        }
        if let Some(id) = non_empty_string(row.get("uuid")) {
            return id;
        }
    }
    uuid::Uuid::new_v4().to_string()
}

fn is_prompt_row(row: &Value) -> bool {
    row.get("type").and_then(Value::as_str) == Some("user")
        && !is_tool_result(row)
        && !is_system_injection(row)
}

fn is_system_injection(row: &Value) -> bool {
    let text = extract_text(row);
    let text = text.trim_start();
    text.starts_with("<command-message>")
        || text.starts_with("<command-name>")
        || text.starts_with("[Request interrupted")
        || text.starts_with("[SYSTEM: This is an automated background review task")
        || is_pure_system_reminder(text)
}

fn is_pure_system_reminder(text: &str) -> bool {
    text.starts_with("<system-reminder>")
        && system_reminder_pattern()
            .replace_all(text, "")
            .trim()
            .is_empty()
}

fn system_reminder_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?s)<system-reminder>.*?</system-reminder>")
            .expect("system reminder pattern")
    })
}

fn is_review_copy(rows: &[Value]) -> bool {
    rows.iter().any(|row| {
        row.get("type").and_then(Value::as_str) == Some("user")
            && row
                .pointer("/message/content/0/text")
                .and_then(Value::as_str)
                .is_some_and(|text| {
                    text.starts_with("[SYSTEM: This is an automated background review task")
                })
    })
}

fn is_content_row(row: &Value) -> bool {
    let Some(kind) = row.get("type").and_then(Value::as_str) else {
        return false;
    };
    if kind.is_empty()
        || matches!(
            kind,
            "ai-title" | "last-prompt" | "session_meta" | "progress"
        )
    {
        return false;
    }
    if is_flag_true(row.get("isSidechain")) || is_flag_true(row.get("isMeta")) {
        return false;
    }
    kind == "user" || kind == "assistant"
}

fn is_flag_true(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) if text == "true" => true,
        _ => false,
    }
}

fn is_tool_result(row: &Value) -> bool {
    match row
        .get("message")
        .and_then(|message| message.get("content"))
    {
        Some(Value::Array(blocks)) if !blocks.is_empty() => {
            blocks[0].get("type").and_then(Value::as_str) == Some("tool_result")
        }
        _ => false,
    }
}

fn extract_text(row: &Value) -> String {
    match row
        .get("message")
        .and_then(|message| message.get("content"))
    {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                if let Value::String(text) = block {
                    parts.push(text.clone());
                } else if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            parts.push(text.to_string());
                        }
                    }
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

fn content_blocks(row: &Value) -> &[Value] {
    match row
        .get("message")
        .and_then(|message| message.get("content"))
    {
        Some(Value::Array(blocks)) => blocks,
        _ => &[],
    }
}

fn content_type_of(row: &Value, blocks: &[Value]) -> String {
    if let Some(kind) = non_empty_string(row.get("content_type")) {
        return kind;
    }
    blocks
        .first()
        .and_then(|block| block.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn is_thinking_row(row: &Value) -> bool {
    let first = content_blocks(row)
        .first()
        .and_then(|block| block.get("type"))
        .and_then(Value::as_str);
    first == Some("thinking") || row.get("content_type").and_then(Value::as_str) == Some("thinking")
}

fn thinking_text(row: &Value, blocks: &[Value]) -> Option<String> {
    block_text(blocks, "thinking", "thinking")
        .or_else(|| block_text(blocks, "text", "text"))
        .or_else(|| message_string(row))
}

fn visible_text(row: &Value, blocks: &[Value]) -> Option<String> {
    block_text(blocks, "text", "text").or_else(|| message_string(row))
}

fn block_text(blocks: &[Value], kind: &str, field: &str) -> Option<String> {
    blocks
        .iter()
        .find(|block| block.get("type").and_then(Value::as_str) == Some(kind))
        .and_then(|block| non_empty_string(block.get(field)))
}

fn message_string(row: &Value) -> Option<String> {
    match row
        .get("message")
        .and_then(|message| message.get("content"))
    {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn response_id(row: &Value) -> Option<String> {
    non_empty_string(row.get("message").and_then(|message| message.get("id")))
        .or_else(|| non_empty_string(row.get("parentUuid")))
        .or_else(|| non_empty_string(row.get("uuid")))
}

fn build_record(fields: Obj, source: &Value, cwd: Option<&str>) -> Obj {
    let mut record = Obj::new();
    record.insert(
        "event.id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    record.insert(
        "agent.source".into(),
        Value::String("qoder-transcript-hook".into()),
    );
    let variant =
        non_empty_string(fields.get("gen_ai.agent.type")).unwrap_or_else(|| "qoder-work".into());
    record.insert("agent.qoderwork.variant".into(), Value::String(variant));
    for (key, value) in fields {
        record.insert(key, value);
    }
    if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
        record.insert("agent.qoderwork.cwd".into(), Value::String(cwd.to_string()));
    }
    if let Some(side) = source.get("isSidechain") {
        record.insert(
            "agent.qoderwork.isSidechain".into(),
            Value::String(js_string(side)),
        );
    }
    copy_truthy(source, &mut record, "userType", "agent.qoderwork.userType");
    copy_truthy(source, &mut record, "version", "agent.qoderwork.version");
    copy_truthy(source, &mut record, "agentId", "agent.qoderwork.agentId");
    sanitize_record(record)
}

fn copy_truthy(source: &Value, record: &mut Obj, from: &str, to: &str) {
    if let Some(value) = source.get(from) {
        if js_truthy(value) {
            record.insert(to.to_string(), value.clone());
        }
    }
}

fn append_produced(env: &Env, agent_id: &str, log_prefix: &str, records: &[Obj]) -> bool {
    let filtered = match filter_workspace_records(env, records, agent_id) {
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
    if !append_history_rows(env, agent_id, log_prefix, &rows) {
        log_debug(
            env,
            agent_id,
            "ERROR appending rows to history: append failed",
        );
        return false;
    }
    if !rows.is_empty() {
        let path = history_file(env, agent_id, log_prefix);
        log_debug(
            env,
            agent_id,
            &format!("Appended {} rows to {}", rows.len(), path.display()),
        );
    }
    true
}

fn history_file(env: &Env, agent_id: &str, log_prefix: &str) -> PathBuf {
    data_dir(env)
        .join("logs")
        .join(agent_id)
        .join("history")
        .join(format!("{log_prefix}-{}.jsonl", local_date()))
}

fn infer_provider_name(explicit: Option<&str>, model: &str, agent_type: &str) -> String {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return explicit.to_string();
    }
    let model = model.to_lowercase();
    if model.contains("claude") || model.contains("anthropic") {
        return "anthropic".into();
    }
    if model.contains("gpt") || model.contains("openai") || model.contains("codex") {
        return "openai".into();
    }
    if model.contains("qwen") || model.contains("tongyi") {
        return "qwen".into();
    }
    if model.contains("deepseek") {
        return "deepseek".into();
    }
    if model.contains("gemini") {
        return "gcp.gemini".into();
    }
    if model.contains("grok") || model.contains("xai") || model.contains("x_ai") {
        return "x_ai".into();
    }
    let agent_type = agent_type.to_lowercase();
    if agent_type.contains("codex") {
        return "openai".into();
    }
    if agent_type.contains("claude") {
        return "anthropic".into();
    }
    if agent_type.contains("qoder") || agent_type.contains("qwen") {
        return "qwen".into();
    }
    if agent_type.contains("gemini") {
        return "gcp.gemini".into();
    }
    "unknown".into()
}

fn resolve_user_id(row: &Value, configured: &str) -> String {
    for key in ["user.id", "user_id", "userId", "identity"] {
        if let Some(value) = non_empty_string(row.get(key)) {
            return value;
        }
    }
    if !configured.is_empty() {
        return configured.to_string();
    }
    hostname()
}

fn timestamp_to_unix_nanos(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => now_unix_nanos(),
        Some(Value::String(text)) => timestamp_from_text(text),
        Some(Value::Number(number)) => {
            if let Some(integer) = number.as_i64() {
                timestamp_from_i64(integer)
            } else if let Some(float) = number.as_f64() {
                timestamp_from_f64(float)
            } else {
                now_unix_nanos()
            }
        }
        Some(_) => now_unix_nanos(),
    }
}

fn timestamp_from_text(text: &str) -> String {
    let trimmed = text.trim();
    if is_wide_digits(trimmed) {
        return trimmed.to_string();
    }
    // Number("") is 0, and an empty timestamp is that value rather than "now".
    if trimmed.is_empty() {
        return timestamp_from_f64(0.0);
    }
    if let Ok(number) = trimmed.parse::<f64>() {
        if number.is_finite() {
            return timestamp_from_f64(number);
        }
    }
    parse_date_millis(trimmed)
        .map(nanos_from_millis)
        .unwrap_or_else(now_unix_nanos)
}

fn timestamp_from_i64(value: i64) -> String {
    if value >= 10_000_000_000_000_000 {
        value.to_string()
    } else if value >= 1_000_000_000_000 {
        format!("{value}000000")
    } else {
        match value.checked_mul(1000) {
            Some(millis) => format!("{millis}000000"),
            None => timestamp_from_f64(value as f64),
        }
    }
}

fn timestamp_from_f64(value: f64) -> String {
    if !value.is_finite() {
        return now_unix_nanos();
    }
    if value >= 1e16 {
        return trunc_digits(value);
    }
    if value >= 1e12 {
        return format!("{}000000", trunc_digits(value));
    }
    format!("{}000000", trunc_digits(value * 1000.0))
}

fn trunc_digits(value: f64) -> String {
    let truncated = value.trunc();
    if truncated.abs() < 1e15 {
        format!("{}", truncated as i64)
    } else {
        format!("{truncated:.0}")
    }
}

fn nanos_from_millis(millis: i64) -> String {
    format!("{millis}000000")
}

fn parse_date_millis(text: &str) -> Option<i64> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|naive| naive.and_utc().timestamp_millis());
    }
    None
}

fn is_wide_digits(text: &str) -> bool {
    text.len() >= 16 && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn resolve_qoder_work_project_dir(env: &Env, sandbox_cwd: &str, agent_id: &str) -> String {
    if sandbox_cwd.is_empty() {
        return String::new();
    }
    let home_name = if agent_id == "qoder-work-cn" {
        ".qoderworkcn"
    } else {
        ".qoderwork"
    };
    let app_name = if agent_id == "qoder-work-cn" {
        "QoderWork CN"
    } else {
        "QoderWork"
    };
    let mut prefix = home_dir(env)
        .join(home_name)
        .join("workspace")
        .to_string_lossy()
        .into_owned();
    let separator = std::path::MAIN_SEPARATOR;
    if !prefix.ends_with(separator) {
        prefix.push(separator);
    }
    if !sandbox_cwd.starts_with(&prefix) {
        return sandbox_cwd.to_string();
    }
    let relative = &sandbox_cwd[prefix.len()..];
    let chat_id = relative.split(separator).next().unwrap_or("");
    if chat_id.is_empty() || !chat_id_pattern().is_match(chat_id) {
        return sandbox_cwd.to_string();
    }
    let db = agents_db(env, app_name);
    let sql = format!(
        "SELECT additional_directories FROM chats WHERE id = '{}'",
        chat_id.replace('\'', "''")
    );
    match sqlite3_text(&db, &sql) {
        Ok(result) => {
            let trimmed = result.trim();
            if trimmed.is_empty() {
                return sandbox_cwd.to_string();
            }
            if let Ok(Value::Array(dirs)) = serde_json::from_str::<Value>(trimmed) {
                if let Some(Value::String(first)) = dirs.first() {
                    log_debug(
                        env,
                        agent_id,
                        &format!("Resolved project dir: {sandbox_cwd} -> {first}"),
                    );
                    return first.clone();
                }
            }
            sandbox_cwd.to_string()
        }
        Err(err) => {
            log_debug(
                env,
                agent_id,
                &format!("Failed to resolve project dir from sqlite: {err}"),
            );
            sandbox_cwd.to_string()
        }
    }
}

fn agents_db(env: &Env, app_name: &str) -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir(env)
            .join("Library")
            .join("Application Support")
            .join(app_name)
            .join("data")
            .join("agents.db")
    } else {
        let base = env_get(env, "XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir(env).join(".config"));
        base.join(app_name).join("data").join("agents.db")
    }
}

fn chat_id_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"(?i)^[a-z0-9-]{1,64}$").expect("qoderwork chat id"))
}

fn sqlite3_text(db: &Path, sql: &str) -> Result<String, String> {
    let mut child = Command::new("sqlite3")
        .arg(db)
        .arg(sql)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let mut err = String::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_string(&mut out);
        }
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_string(&mut err);
        }
        (out, err)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= Duration::from_millis(5000) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("sqlite3 timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(err.to_string());
            }
        }
    };
    let (out, err) = reader.join().unwrap_or_default();
    if status.success() {
        Ok(out)
    } else {
        let detail = err.trim();
        if detail.is_empty() {
            Err(format!("sqlite3 exited {status}"))
        } else {
            Err(detail.to_string())
        }
    }
}

struct Snapshot {
    line_count: usize,
    lines: Vec<String>,
}

fn read_transcript_snapshot(path: &str) -> Snapshot {
    let bytes = match fs::read(path) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => {
            return Snapshot {
                line_count: 0,
                lines: Vec::new(),
            };
        }
    };
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let lines: Vec<String> = content.split('\n').map(str::to_owned).collect();
    let line_count = if content.ends_with('\n') {
        lines.len().saturating_sub(1)
    } else {
        lines.len()
    };
    Snapshot { line_count, lines }
}

fn slice_transcript_lines(lines: &[String], start: usize, end: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut index = start;
    while index < end && index < lines.len() {
        let trimmed = lines[index].trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
        index += 1;
    }
    out
}

struct LineRange {
    start: usize,
    end: usize,
    reason: String,
}

fn line_range(
    env: &Env,
    agent_id: &str,
    transcript_path: &str,
    session_id: &str,
    current: usize,
) -> Option<LineRange> {
    let record = load_line_record(env, agent_id, session_id);
    let recorded = finite_line_count(record.get("last_line_count"));
    let mut last_count = recorded.unwrap_or(0);
    let mut reason = if recorded.is_some() {
        "incremental"
    } else {
        "missing-cursor"
    }
    .to_string();
    if recorded_string_differs(record.get("session_id"), session_id) {
        log_debug(
            env,
            agent_id,
            &format!(
                "Session changed: {} -> {session_id}, reset to 0",
                js_template(record.get("session_id"))
            ),
        );
        last_count = 0;
        reason = "session-changed".into();
    }
    if recorded_string_differs(record.get("transcript_path"), transcript_path) {
        log_debug(
            env,
            agent_id,
            &format!("Transcript changed for session {session_id}, reset to 0"),
        );
        last_count = 0;
        reason = "transcript-changed".into();
    }
    if current == 0 {
        log_debug(env, agent_id, "Transcript is empty");
        return None;
    }
    if current == last_count {
        log_debug(env, agent_id, &format!("No new lines (count: {current})"));
        return None;
    }
    if current < last_count {
        log_debug(
            env,
            agent_id,
            &format!("File truncated ({last_count} -> {current}), sending all"),
        );
        last_count = 0;
        reason = "truncated".into();
    }
    log_debug(
        env,
        agent_id,
        &format!("Range: {last_count} -> {current} ({reason})"),
    );
    Some(LineRange {
        start: last_count,
        end: current,
        reason,
    })
}

fn recorded_string_differs(value: Option<&Value>, expected: &str) -> bool {
    match value {
        Some(Value::String(text)) => !text.is_empty() && text != expected,
        Some(other) if js_truthy(other) => true,
        _ => false,
    }
}

fn finite_line_count(value: Option<&Value>) -> Option<usize> {
    let Value::Number(number) = value? else {
        return None;
    };
    let number = number.as_f64().filter(|number| number.is_finite())?;
    if number < 0.0 || number > usize::MAX as f64 {
        return None;
    }
    Some(number as usize)
}

fn load_line_record(env: &Env, agent_id: &str, session_id: &str) -> Obj {
    if session_id.is_empty() {
        return Obj::new();
    }
    reconcile_aggregate_line_record(env, agent_id, session_id);
    read_json_object(&session_line_record_file(env, agent_id, session_id)).unwrap_or_default()
}

fn reconcile_aggregate_line_record(env: &Env, agent_id: &str, session_id: &str) {
    let sources = [
        aggregate_line_record_file(env, agent_id),
        legacy_line_record_file(env, agent_id),
    ];
    for source in sources {
        let Some(records) = read_json_object(&source) else {
            continue;
        };
        for (transcript_path, value) in records {
            let Value::Object(mut value) = value else {
                continue;
            };
            let Some(stored_session) = value.get("session_id").and_then(Value::as_str) else {
                continue;
            };
            if stored_session.is_empty() || stored_session != session_id {
                continue;
            }
            let candidate_count = js_number(value.get("last_line_count"));
            let candidate_updated = value
                .get("updated_at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let target = session_line_record_file(env, agent_id, session_id);
            let existing = read_json_object(&target);
            let save = match &existing {
                None => true,
                Some(existing) => is_line_record_newer(
                    &transcript_path,
                    candidate_count,
                    &candidate_updated,
                    existing,
                ),
            };
            if !save {
                continue;
            }
            value.insert("session_id".into(), Value::String(session_id.to_string()));
            value.insert("transcript_path".into(), Value::String(transcript_path));
            let _ = save_json_object(&target, &Value::Object(value));
        }
    }
}

fn is_line_record_newer(
    candidate_path: &str,
    candidate_count: f64,
    candidate_updated: &str,
    existing: &Obj,
) -> bool {
    let existing_path = existing
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    if candidate_path == existing_path {
        return candidate_count > js_number(existing.get("last_line_count"));
    }
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
    let record = json!({
        "session_id": session_id,
        "transcript_path": transcript_path,
        "last_line_count": end_line,
        "updated_at": local_stamp_seconds(),
    });
    let ok = save_json_object(
        &session_line_record_file(env, agent_id, session_id),
        &record,
    );
    if ok {
        log_debug(
            env,
            agent_id,
            &format!("Updated record: {transcript_path} -> {end_line} lines"),
        );
        let Value::Object(stored) = record else {
            return ok;
        };
        for shadow in rollback_shadow_files(env, agent_id) {
            if !update_aggregate_shadow(&shadow, transcript_path, &stored) {
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

/// The installed JavaScript processor writes the legacy shadow only when the
/// script directory is `data_dir/hooks`. This binary has no script directory,
/// so it always maintains that deployed shadow alongside the aggregate file.
fn rollback_shadow_files(env: &Env, agent_id: &str) -> Vec<PathBuf> {
    vec![
        aggregate_line_record_file(env, agent_id),
        legacy_line_record_file(env, agent_id),
    ]
}

fn update_aggregate_shadow(file: &Path, transcript_path: &str, record: &Obj) -> bool {
    let lock = PathBuf::from(format!("{}.lock", file.display()));
    let session_id = record
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let updated_at = record
        .get("updated_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    let last_line_count = record
        .get("last_line_count")
        .cloned()
        .unwrap_or(Value::from(0));
    let outcome = with_file_lock(&lock, 1_000, 30_000, || {
        let mut records = read_json_object(file).unwrap_or_default();
        if let Some(existing) = records.get(transcript_path).and_then(Value::as_object) {
            let same_session =
                existing.get("session_id").and_then(Value::as_str) == Some(session_id);
            if same_session
                && js_number(existing.get("last_line_count")) > js_number(Some(&last_line_count))
            {
                return true;
            }
        }
        records.insert(
            transcript_path.to_string(),
            json!({
                "session_id": session_id,
                "last_line_count": last_line_count,
                "updated_at": updated_at,
            }),
        );
        save_json_object(file, &Value::Object(records))
    });
    outcome.unwrap_or(false)
}

fn aggregate_line_record_file(env: &Env, agent_id: &str) -> PathBuf {
    data_dir(env)
        .join("state")
        .join("hooks")
        .join(format!("{agent_id}-line-records.json"))
}

fn legacy_line_record_file(env: &Env, agent_id: &str) -> PathBuf {
    data_dir(env)
        .join("hooks")
        .join(format!(".line_records.{agent_id}.json"))
}

fn session_line_record_file(env: &Env, agent_id: &str, session_id: &str) -> PathBuf {
    data_dir(env)
        .join("state")
        .join("hooks")
        .join(format!("{agent_id}-line-records"))
        .join(format!("{}.json", sha256_hex(session_id.as_bytes())))
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
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        unix_millis()
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

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn log_debug(env: &Env, agent_id: &str, message: &str) {
    let path = data_dir(env)
        .join("logs")
        .join(agent_id)
        .join("debug")
        .join(format!("{agent_id}-debug-{}.log", local_date()));
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let line = format!("[{}] {message}\n", local_stamp_seconds());
    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

fn insert_str(map: &mut Obj, key: &str, value: &str) {
    map.insert(key.to_string(), Value::String(value.to_string()));
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn present_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn js_template(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => js_string(other),
        None => String::new(),
    }
}

fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(f64::NAN),
        Some(Value::Array(items)) if items.is_empty() => 0.0,
        Some(_) => f64::NAN,
    }
}

fn stringify_jsonish(value: Option<&Value>) -> Option<String> {
    match value {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => serde_json::to_string(other).ok(),
    }
}

fn json_string_or_raw(value: &Value) -> String {
    if let Value::String(text) = value {
        text.clone()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "null".into())
    }
}

#[cfg(test)]
mod tests {
    use super::super::common::{Env, HookRequest};
    use super::*;
    use serde_json::json;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    fn invoke(root: &Path, args: &[&str], stdin: &str) -> (i32, String) {
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        env.insert(
            "HOME".into(),
            root.join("home").to_string_lossy().into_owned(),
        );
        env.insert("LOONGSUITE_PILOT_USER_ID".into(), "user-1".into());
        let args: Vec<String> = args.iter().copied().map(str::to_owned).collect();
        let mut stdout = Vec::new();
        let code = run(&mut HookRequest {
            args: &args,
            stdin: stdin.as_bytes(),
            env: &env,
            stdout: &mut stdout,
        });
        (code, String::from_utf8(stdout).expect("utf8 stdout"))
    }

    fn write_jsonl(path: &Path, rows: &[Value]) {
        let mut body = String::new();
        for row in rows {
            body.push_str(&serde_json::to_string(row).expect("row"));
            body.push('\n');
        }
        fs::write(path, body).expect("write transcript");
    }

    fn append_jsonl(path: &Path, rows: &[Value]) {
        let mut body = String::new();
        for row in rows {
            body.push_str(&serde_json::to_string(row).expect("row"));
            body.push('\n');
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(path)
            .expect("append transcript");
        file.write_all(body.as_bytes()).expect("append bytes");
    }

    fn payload(session_id: &str, transcript: &Path) -> String {
        json!({
            "hook_event_name": "Stop",
            "session_id": session_id,
            "transcript_path": transcript.to_string_lossy(),
            "cwd": "/tmp/qoderwork-test",
        })
        .to_string()
    }

    fn history(root: &Path, agent_id: &str) -> Vec<Value> {
        let dir = root.join("logs").join(agent_id).join("history");
        let Ok(entries) = fs::read_dir(dir) else {
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
            let content = fs::read_to_string(path).unwrap_or_default();
            for line in content.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    records.push(value);
                }
            }
        }
        records
    }

    fn cursor_file(root: &Path, agent_id: &str) -> Value {
        let dir = root
            .join("state")
            .join("hooks")
            .join(format!("{agent_id}-line-records"));
        let mut files: Vec<_> = fs::read_dir(&dir)
            .expect("cursor dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect();
        assert_eq!(files.len(), 1, "one session cursor file");
        files.sort();
        serde_json::from_str(&fs::read_to_string(&files[0]).expect("cursor")).expect("cursor json")
    }

    fn nanos(iso: &str) -> String {
        let parsed = chrono::DateTime::parse_from_rfc3339(iso).expect("rfc3339");
        format!("{}000000", parsed.timestamp_millis())
    }

    fn names(records: &[Value]) -> Vec<&str> {
        records
            .iter()
            .map(|record| record["event.name"].as_str().expect("event.name"))
            .collect()
    }

    #[test]
    fn parent_uuid_assistant_blocks_form_one_llm_call() {
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("transcript.jsonl");
        let rows = vec![
            json!({
                "type": "ai-title",
                "message": { "content": [{ "type": "text", "text": "title should be skipped" }] }
            }),
            json!({
                "type": "user",
                "uuid": "user-1",
                "promptId": "turn-1",
                "timestamp": "2026-08-25T01:00:00.000Z",
                "version": "1.1.26",
                "userType": "external",
                "isSidechain": false,
                "agentId": "worker-1",
                "message": { "role": "user", "content": [{ "type": "text", "text": "inspect a file" }] }
            }),
            json!({
                "type": "assistant",
                "uuid": "a-think",
                "parentUuid": "parent-a",
                "timestamp": "2026-08-25T01:00:01.000Z",
                "version": "1.1.26",
                "isSidechain": false,
                "message": {
                    "role": "assistant",
                    "id": "response-1",
                    "content": [{ "type": "thinking", "thinking": "I need both results." }]
                }
            }),
            json!({
                "type": "assistant",
                "uuid": "side-1",
                "parentUuid": "parent-a",
                "isSidechain": true,
                "timestamp": "2026-08-25T01:00:01.020Z",
                "message": { "content": [{ "type": "text", "text": "hidden sidechain" }] }
            }),
            json!({
                "type": "assistant",
                "uuid": "a-text",
                "parentUuid": "parent-b",
                "timestamp": "2026-08-25T01:00:01.050Z",
                "version": "1.1.26",
                "isSidechain": false,
                "message": { "content": [{ "type": "text", "text": "Reading both files." }] }
            }),
            json!({
                "type": "assistant",
                "uuid": "a-tool-1",
                "parentUuid": "parent-a",
                "timestamp": "2026-08-25T01:00:01.100Z",
                "version": "1.1.26",
                "isSidechain": false,
                "message": {
                    "content": [{ "type": "tool_use", "id": "call-1", "name": "Read", "input": { "file_path": "a.txt" } }]
                }
            }),
            json!({
                "type": "assistant",
                "uuid": "a-tool-2",
                "parentUuid": "parent-b",
                "timestamp": "2026-08-25T01:00:01.200Z",
                "version": "1.1.26",
                "isSidechain": false,
                "message": {
                    "content": [{ "type": "tool_use", "id": "call-2", "name": "Read", "input": { "file_path": "b.txt" } }]
                }
            }),
            json!({
                "type": "user",
                "uuid": "result-1",
                "timestamp": "2026-08-25T01:00:02.000Z",
                "version": "1.1.26",
                "isSidechain": false,
                "message": {
                    "content": [{ "type": "tool_result", "tool_use_id": "call-1", "content": "a contents" }]
                }
            }),
            json!({
                "type": "assistant",
                "uuid": "a-final",
                "parentUuid": "parent-c",
                "timestamp": "2026-08-25T01:00:03.000Z",
                "version": "1.1.26",
                "isSidechain": false,
                "message": {
                    "id": "response-2",
                    "content": [{ "type": "text", "text": "done" }]
                }
            }),
        ];
        write_jsonl(&transcript, &rows);
        let (code, stdout) = invoke(
            dir.path(),
            &["--agent-id", "qoder-work"],
            &payload("sess-group", &transcript),
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");

        let records = history(dir.path(), "qoder-work");
        let flat = serde_json::to_string(&records).expect("records");
        assert!(!flat.contains("hidden sidechain"));
        assert!(!flat.contains("title should be skipped"));
        assert_eq!(
            names(&records),
            vec![
                "other",
                "llm.request",
                "llm.response",
                "tool.call",
                "tool.result",
                "tool.call",
                "llm.request",
                "llm.response",
            ]
        );
        for record in &records {
            assert_eq!(record["agent.qoderwork.variant"], "qoder-work");
            assert_eq!(record["agent.source"], "qoder-transcript-hook");
            assert_eq!(record["agent.qoderwork.version"], "1.1.26");
            assert_eq!(record["agent.qoderwork.isSidechain"], "false");
            assert_eq!(record["agent.qoderwork.cwd"], "/tmp/qoderwork-test");
            assert_eq!(record["agent.qoderwork.promptId"], "turn-1");
            assert_eq!(record["gen_ai.turn.id"], "turn-1");
            if matches!(
                record["event.name"].as_str(),
                Some("other" | "llm.request" | "llm.response")
            ) {
                assert_eq!(record["gen_ai.provider.name"], "qwen");
            }
            assert_eq!(record["user.id"], "user-1");
            assert_eq!(record["agent.transcript.cursor_mode"], "bootstrap");
            assert_eq!(record["agent.transcript.cursor_reason"], "missing-cursor");
        }
        let batch = records[0]["agent.transcript.cursor_batch_id"]
            .as_str()
            .expect("batch");
        assert_eq!(batch.len(), 36);
        assert!(records
            .iter()
            .all(|record| record["agent.transcript.cursor_batch_id"] == batch));
        assert_eq!(records[0]["agent.qoderwork.userType"], "external");
        assert_eq!(records[0]["agent.qoderwork.agentId"], "worker-1");
        assert!(records[0].get("gen_ai.step.id").is_none());

        let first_response = records
            .iter()
            .find(|record| {
                record["event.name"] == "llm.response" && record["gen_ai.step.id"] == "turn-1:s1"
            })
            .expect("s1 response");
        assert_eq!(first_response["gen_ai.response.id"], "response-1");
        assert_eq!(
            first_response["gen_ai.response.finish_reasons"],
            json!(["tool_calls"])
        );
        assert_eq!(
            first_response["time_unix_nano"],
            json!(nanos("2026-08-25T01:00:01.000Z"))
        );
        assert_eq!(
            first_response["gen_ai.output.messages"],
            json!([{
                "role": "assistant",
                "parts": [
                    { "type": "reasoning", "content": "I need both results." },
                    { "type": "text", "content": "Reading both files." },
                    { "type": "tool_call", "id": "call-1", "name": "Read", "arguments": { "file_path": "a.txt" } },
                    { "type": "tool_call", "id": "call-2", "name": "Read", "arguments": { "file_path": "b.txt" } }
                ],
                "finish_reason": "tool_calls"
            }])
        );

        let second_request = records
            .iter()
            .find(|record| {
                record["event.name"] == "llm.request" && record["gen_ai.step.id"] == "turn-1:s2"
            })
            .expect("s2 request");
        assert!(second_request.get("gen_ai.input.messages").is_none());
        assert_eq!(
            second_request["time_unix_nano"],
            json!(nanos("2026-08-25T01:00:02.000Z"))
        );
        assert_eq!(
            second_request["gen_ai.input.messages_delta"],
            json!([
                {
                    "role": "assistant",
                    "parts": [
                        { "type": "reasoning", "content": "I need both results." },
                        { "type": "text", "content": "Reading both files." },
                        { "type": "tool_call", "id": "call-1", "name": "Read", "arguments": { "file_path": "a.txt" } }
                    ]
                },
                {
                    "role": "tool",
                    "parts": [{ "type": "tool_call_response", "id": "call-1", "response": "a contents" }]
                }
            ])
        );
        let final_response = records
            .iter()
            .find(|record| {
                record["event.name"] == "llm.response" && record["gen_ai.step.id"] == "turn-1:s2"
            })
            .expect("s2 response");
        assert_eq!(final_response["gen_ai.response.id"], "response-2");
        assert_eq!(
            final_response["gen_ai.response.finish_reasons"],
            json!(["stop"])
        );
        let tool_results: Vec<_> = records
            .iter()
            .filter(|record| record["event.name"] == "tool.result")
            .collect();
        assert_eq!(tool_results.len(), 1);
        assert_eq!(tool_results[0]["gen_ai.tool.call.id"], "call-1");
        assert_eq!(tool_results[0]["tool.result.status"], "success");
        assert!(tool_results[0].get("gen_ai.tool.call.arguments").is_none());
        let call_args = records
            .iter()
            .find(|record| {
                record["event.name"] == "tool.call" && record["gen_ai.tool.call.id"] == "call-1"
            })
            .expect("call-1");
        assert_eq!(
            call_args["gen_ai.tool.call.arguments"],
            json!("{\"file_path\":\"a.txt\"}")
        );
        assert_eq!(
            call_args["time_unix_nano"],
            json!(nanos("2026-08-25T01:00:01.200Z"))
        );

        let cursor = cursor_file(dir.path(), "qoder-work");
        assert_eq!(cursor["session_id"], "sess-group");
        assert_eq!(
            cursor["transcript_path"],
            json!(transcript.to_string_lossy().into_owned())
        );
        assert_eq!(cursor["last_line_count"], json!(rows.len()));
        let history_names: Vec<_> = fs::read_dir(dir.path().join("logs/qoder-work/history"))
            .expect("history")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(history_names
            .iter()
            .any(|name| name.starts_with("qoder-work-") && name.ends_with(".jsonl")));
    }

    #[test]
    fn cursor_advances_from_bootstrap_to_incremental() {
        let dir = tempfile::tempdir().expect("tempdir");
        let transcript = dir.path().join("transcript.jsonl");
        let historical = [
            turn_rows(1, "historical prompt 1"),
            turn_rows(2, "historical prompt 2"),
        ]
        .concat();
        write_jsonl(&transcript, &historical);
        let (code, stdout) = invoke(
            dir.path(),
            &[
                "--agent-id",
                "qoder-work-test",
                "--log-prefix",
                "qoder-work",
            ],
            &payload("sess-recovery", &transcript),
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let bootstrap = history(dir.path(), "qoder-work-test");
        assert_eq!(input_contents(&bootstrap), vec!["historical prompt 2"]);
        assert!(bootstrap.iter().all(|record| {
            record["agent.transcript.cursor_mode"] == "bootstrap"
                && record["agent.transcript.cursor_reason"] == "missing-cursor"
        }));
        assert_eq!(
            bootstrap
                .iter()
                .map(|e| e["agent.transcript.cursor_batch_id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert_eq!(
            fs::read_dir(dir.path().join("state/hooks/qoder-work-test-line-records"))
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "json"))
                .count(),
            1
        );
        let cursor = cursor_file(dir.path(), "qoder-work-test");
        assert_eq!(cursor["session_id"], "sess-recovery");
        assert_eq!(
            cursor["transcript_path"],
            json!(transcript.to_string_lossy().into_owned())
        );
        assert_eq!(cursor["last_line_count"], json!(historical.len()));

        let added = turn_rows(3, "new prompt 3");
        append_jsonl(&transcript, &added);
        let (code, stdout) = invoke(
            dir.path(),
            &[
                "--agent-id",
                "qoder-work-test",
                "--log-prefix",
                "qoder-work",
            ],
            &payload("sess-recovery", &transcript),
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let all = history(dir.path(), "qoder-work-test");
        let incremental = &all[bootstrap.len()..];
        assert_eq!(input_contents(incremental), vec!["new prompt 3"]);
        assert!(incremental.iter().all(|record| {
            record["agent.transcript.cursor_mode"] == "incremental"
                && record["agent.transcript.cursor_reason"] == "incremental"
        }));
        let cursor = cursor_file(dir.path(), "qoder-work-test");
        assert_eq!(
            cursor["last_line_count"],
            json!(historical.len() + added.len())
        );
        let history_names: Vec<_> = fs::read_dir(dir.path().join("logs/qoder-work-test/history"))
            .expect("history")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(history_names
            .iter()
            .any(|name| name.starts_with("qoder-work-") && name.ends_with(".jsonl")));
    }

    fn turn_rows(index: usize, text: &str) -> Vec<Value> {
        let second = format!("{:02}", 50 + index * 2);
        vec![
            json!({
                "type": "user",
                "uuid": format!("user-{index}"),
                "promptId": format!("prompt-{index}"),
                "timestamp": format!("2026-06-18T01:35:{second}.477Z"),
                "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
                "userType": "external",
                "isSidechain": false,
            }),
            json!({
                "type": "assistant",
                "uuid": format!("assistant-{index}"),
                "parentUuid": format!("user-{index}"),
                "timestamp": format!("2026-06-18T01:35:{second}.977Z"),
                "message": {
                    "role": "assistant",
                    "id": format!("msg-{index}"),
                    "content": [{ "type": "text", "text": format!("answer {index}") }],
                    "stop_reason": "end_turn"
                },
                "isSidechain": false,
            }),
        ]
    }

    fn input_contents(records: &[Value]) -> Vec<String> {
        records
            .iter()
            .filter(|record| record["event.name"] == "llm.request")
            .flat_map(|record| {
                record["gen_ai.input.messages_delta"]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .flat_map(|message| message["parts"].as_array().into_iter().flatten())
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["content"].as_str().map(str::to_owned))
            .collect()
    }

    #[test]
    fn missing_agent_id_exits_without_stdout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (code, stdout) = invoke(dir.path(), &[], "{}");
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
    }
}

#[cfg(test)]
#[path = "qoder_work_pure_history_contract_tests.rs"]
mod pure_history_contracts;
