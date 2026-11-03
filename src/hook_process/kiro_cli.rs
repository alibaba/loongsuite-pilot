//! Kiro CLI hook processor.
//!
//! Port of `assets/hooks/kiro-cli-hook-processor.mjs` and `assets/hooks/kiro-cli/*`.
//! Transcript rows in `conversations_v2.value.history[]` are the STEP/LLM backbone.
//! `postToolUse` only buffers `tool_response`. `stop` enqueues a pending record and
//! returns `{}`; `delayedCollect` reads SQLite (then session JSONL) and writes JSONL.

use super::common::{
    data_dir, env_get, home_dir, iso_now, json_number, load_runtime_config, log_hook_error,
    parse_json_object, random_hex, sanitize_record, sha256_hex, write_empty, write_json,
    write_jsonl_records, Env, HookRequest, Obj,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AGENT_ID: &str = "kiro-cli";
const PROVIDER_NAME: &str = "amazon";
const INITIAL_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb924";
const RUN_GAP_MS: f64 = 30_000.0;
const STALE_SESSION_MS: f64 = 5.0 * 60.0 * 1000.0;
const DB_FILE_NAME: &str = "data.sqlite3";

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let sub = request
        .args
        .first()
        .map(String::as_str)
        .unwrap_or("unknown");
    match sub {
        "postToolUse" => cmd_post_tool_use(request),
        "preToolUse" => cmd_pre_tool_use(request),
        "userPromptSubmit" => {}
        "stop" => cmd_stop(request),
        "delayedCollect" => cmd_delayed_collect(request),
        _ => {}
    }
    write_empty(request.stdout);
    0
}

fn cmd_post_tool_use(request: &HookRequest<'_>) {
    let event = read_event(request.stdin);
    let Some(cwd) = event_cwd(&event) else {
        return;
    };
    let entry = json!({
        "toolName": event_tool_name(&event),
        "toolInput": event_tool_input(&event),
        "toolResponse": event.get("tool_response").cloned().unwrap_or(Value::Null),
        "captureTs": iso_now(),
    });
    append_jsonl(&buffer_file(request.env, "buffers", &cwd), &entry);
}

fn cmd_pre_tool_use(request: &HookRequest<'_>) {
    let event = read_event(request.stdin);
    let Some(cwd) = event_cwd(&event) else {
        return;
    };
    let entry = json!({
        "toolName": event_tool_name(&event),
        "toolInput": event_tool_input(&event),
        "startTs": iso_now(),
    });
    append_jsonl(&buffer_file(request.env, "pre-tool-buffers", &cwd), &entry);
}

fn cmd_stop(request: &HookRequest<'_>) {
    let event = read_event(request.stdin);
    let Some(cwd) = event_cwd(&event) else {
        log_err(
            request.env,
            "cmd_stop",
            "missing_cwd",
            "stop hook stdin lacks cwd; skipping",
        );
        return;
    };
    let user_id = load_runtime_config(request.env).user_id;
    let assistant = match event.get("assistant_response") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    enqueue_pending_stop(
        request.env,
        &PendingStop {
            stop_unix_ms: now_ms(),
            since_ms: load_offset(request.env, &cwd),
            session_since_ms: load_session_offset(request.env, &cwd),
            assistant_response: assistant,
            user_id,
            cwd,
        },
    );
    wake_daemon(request.env);
}

fn cmd_delayed_collect(request: &mut HookRequest<'_>) {
    let pending = request.args.get(1).cloned().unwrap_or_default();
    let allow_fallback = request.args.iter().any(|arg| arg == "--allow-fallback");
    if pending.is_empty() {
        log_err(
            request.env,
            "cmd_delayed_collect",
            "missing_argv",
            "delayedCollect missing pending file argv",
        );
        return;
    }
    let pending_path = PathBuf::from(&pending);
    let record = match fs::read_to_string(&pending_path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => value,
            Err(err) => {
                log_err(
                    request.env,
                    "cmd_delayed_collect",
                    "pending_read_failed",
                    &format!("{pending}: {err}"),
                );
                return;
            }
        },
        Err(err) => {
            log_err(
                request.env,
                "cmd_delayed_collect",
                "pending_read_failed",
                &format!("{pending}: {err}"),
            );
            return;
        }
    };
    let cwd = record
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let Some(cwd) = cwd else {
        log_err(
            request.env,
            "cmd_delayed_collect",
            "missing_cwd",
            &format!("pending record at {pending} lacks cwd"),
        );
        return;
    };
    let since_ms =
        finite_f64(record.get("sinceMs")).unwrap_or_else(|| load_offset(request.env, &cwd));
    let session_since_ms = finite_f64(record.get("sessionSinceMs"))
        .unwrap_or_else(|| load_session_offset(request.env, &cwd));
    let assistant = match record.get("assistantResponse") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    let user_id = match record.get("userId").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => load_runtime_config(request.env).user_id,
    };
    let status = run_collect(
        request.env,
        &CollectCtx {
            cwd,
            since_ms,
            session_since_ms,
            assistant_response: assistant,
            user_id,
            allow_fallback,
        },
    );
    write_json(request.stdout, &json!({ "status": status }));
}

struct CollectCtx {
    cwd: String,
    since_ms: f64,
    session_since_ms: f64,
    assistant_response: Option<String>,
    user_id: String,
    allow_fallback: bool,
}

struct PendingStop {
    cwd: String,
    stop_unix_ms: f64,
    since_ms: f64,
    session_since_ms: f64,
    assistant_response: Option<String>,
    user_id: String,
}

fn run_collect(env: &Env, ctx: &CollectCtx) -> &'static str {
    let since_ms = ctx.since_ms.max(load_offset(env, &ctx.cwd));
    let session_since_ms = ctx.session_since_ms.max(load_session_offset(env, &ctx.cwd));
    let mut tool_events = drain_jsonl(&buffer_file(env, "buffers", &ctx.cwd));
    let mut pre_tool_events = drain_jsonl(&buffer_file(env, "pre-tool-buffers", &ctx.cwd));

    let db_path = resolve_db_path(env);
    let mut transcript = None;
    if db_path.exists() {
        for attempt in 0..5u32 {
            match read_transcript_for_cwd(&db_path, &ctx.cwd, since_ms) {
                Ok(Some(data)) if !data.steps.is_empty() => {
                    transcript = Some(data);
                    break;
                }
                Ok(_) => {}
                Err(err) => {
                    log_err(env, "transcript_read", "read_failed", &err);
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(200 * (1u64 << attempt)));
        }
        let stale_age = transcript.as_ref().and_then(|data| {
            let age_ms = now_ms() - data.updated_ms;
            if since_ms == 0.0
                && !data.steps.is_empty()
                && data.updated_ms > 0.0
                && age_ms > STALE_SESSION_MS
            {
                Some((age_ms / 1000.0).round() as i64)
            } else {
                None
            }
        });
        if let Some(age_s) = stale_age {
            log_err(
                env,
                "transcript_read",
                "cold_start_stale_session_skipped",
                &format!("cold start (sqlite): row updated {age_s}s ago — skipping stale replay"),
            );
            transcript = None;
        }
    }

    let chosen = match transcript {
        Some(data) if !data.steps.is_empty() => data,
        _ => match try_session_jsonl(env, &ctx.cwd, session_since_ms, ctx.allow_fallback) {
            Some(data) if !data.steps.is_empty() => data,
            _ => return "no_data",
        },
    };

    let original_has_final = chosen
        .steps
        .iter()
        .any(|step| step.kind == "NotToolUse" && !step.assistant_text.is_empty());
    let conv_id = session_key(&chosen);
    let seen = load_emitted_steps(env, &ctx.cwd)
        .remove(&conv_id)
        .unwrap_or_default();
    let mut new_steps: Vec<Step> = chosen
        .steps
        .iter()
        .filter(|step| step.step_id.is_empty() || !seen.contains(&step.step_id))
        .cloned()
        .collect();
    if new_steps.is_empty() {
        return "ok";
    }
    let timing_valid = new_steps.iter().all(|step| step.start_time_ms > 0.0);
    if !timing_valid && !ctx.allow_fallback {
        return "timing_pending";
    }

    let assistant = ctx
        .assistant_response
        .as_deref()
        .filter(|text| !text.is_empty());
    let records = build_records(
        RecordContext {
            env,
            cwd: &ctx.cwd,
            user_id: &ctx.user_id,
            assistant_response: assistant,
            original_has_final,
        },
        &chosen,
        &mut new_steps,
        &mut tool_events,
        &mut pre_tool_events,
    );
    if records.is_empty() {
        return "ok";
    }
    if let Err(err) = write_jsonl_records(env, &default_log_dir(env), AGENT_ID, &records) {
        log_err(env, "jsonl_write", "write_failed", &err);
        return "timing_pending";
    }

    save_emitted_steps(
        env,
        &ctx.cwd,
        &conv_id,
        &new_steps
            .iter()
            .map(|step| step.step_id.clone())
            .collect::<Vec<_>>(),
    );
    if chosen.source == "session_jsonl" {
        if js_truthy_f64(chosen.updated_ms) {
            save_session_offset(env, &ctx.cwd, chosen.updated_ms);
        }
    } else if js_truthy_f64(chosen.updated_ms) {
        save_offset(env, &ctx.cwd, chosen.updated_ms);
    }
    "ok"
}

fn try_session_jsonl(
    env: &Env,
    cwd: &str,
    since_ms: f64,
    allow_fallback: bool,
) -> Option<Transcript> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_session = None;
    for attempt in 0..MAX_ATTEMPTS {
        if let Some(mut session) = read_session_jsonl(env, cwd, since_ms) {
            if !session.steps.is_empty() {
                if since_ms == 0.0
                    && session.updated_ms > 0.0
                    && (now_ms() - session.updated_ms) > STALE_SESSION_MS
                {
                    let age_s = ((now_ms() - session.updated_ms) / 1000.0).round() as i64;
                    log_err(
                        env,
                        "session_jsonl_read",
                        "cold_start_stale_session_skipped",
                        &format!(
                            "cold start: session updated {age_s}s ago (>{}s) — skipping stale replay",
                            (STALE_SESSION_MS / 1000.0) as i64
                        ),
                    );
                    return None;
                }
                if since_ms == 0.0 && session.steps.len() > 1 {
                    let last_turn = session
                        .steps
                        .last()
                        .map(|step| step.turn_start_ms)
                        .unwrap_or(0.0);
                    if last_turn > 0.0 {
                        let before = session.steps.len();
                        session.steps.retain(|step| step.turn_start_ms == last_turn);
                        log_err(
                            env,
                            "session_jsonl_read",
                            "cold_start_replay_filtered",
                            &format!(
                                "cold start (sinceMs=0): kept last prompt only ({}/{} steps)",
                                session.steps.len(),
                                before
                            ),
                        );
                    }
                }
                let timing_valid = session.steps.iter().all(|step| step.start_time_ms > 0.0);
                if timing_valid {
                    return Some(session);
                }
                let step_count = session.steps.len();
                last_session = Some(session);
                if attempt + 1 == MAX_ATTEMPTS {
                    if allow_fallback {
                        log_err(
                            env,
                            "session_jsonl_read",
                            "timing_incomplete_fallback",
                            &format!(
                                "sidecar timing incomplete; falling back ({step_count} steps)"
                            ),
                        );
                    } else {
                        log_err(
                            env,
                            "session_jsonl_read",
                            "timing_incomplete_requeue",
                            &format!(
                                "sidecar timing incomplete after {MAX_ATTEMPTS} retries ({step_count} steps with startTimeMs=0) — returning for requeue"
                            ),
                        );
                    }
                    return last_session;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200 * (1u64 << attempt)));
    }
    if allow_fallback {
        last_session
    } else {
        None
    }
}

#[derive(Clone, Debug)]
struct ToolUse {
    id: String,
    name: String,
    args: Value,
}

#[derive(Clone, Debug)]
struct Step {
    step_id: String,
    response_id: String,
    kind: String,
    model_id: String,
    start_time_ms: f64,
    end_time_ms: f64,
    tools: Vec<ToolUse>,
    assistant_text: String,
    user_prompt: String,
    tool_use_results: Vec<String>,
    credit_index: i64,
    turn_start_ms: f64,
    turn_end_ms: f64,
}

struct Transcript {
    conversation_id: String,
    continuation_id: String,
    model_id: String,
    steps: Vec<Step>,
    credits: Vec<f64>,
    updated_ms: f64,
    source: String,
    tool_result_map: HashMap<String, String>,
    #[allow(dead_code)]
    session_id: String,
}

struct ToolMatch {
    tool: ToolUse,
    pre: Option<Value>,
    post: Option<Value>,
}

struct RecordContext<'a> {
    env: &'a Env,
    cwd: &'a str,
    user_id: &'a str,
    assistant_response: Option<&'a str>,
    original_has_final: bool,
}

fn build_records(
    context: RecordContext<'_>,
    transcript: &Transcript,
    steps: &mut [Step],
    tool_events: &mut Vec<Value>,
    pre_tool_events: &mut Vec<Value>,
) -> Vec<Obj> {
    let RecordContext {
        env,
        cwd,
        user_id,
        assistant_response,
        original_has_final,
    } = context;
    let session_id = session_key(transcript);
    let turn_number = load_turn_count(env, cwd) + 1;
    save_turn_count(env, cwd, turn_number);
    let turn_base = format!("{session_id}:t{turn_number}");
    let is_session = transcript.source == "session_jsonl";

    let mut base = Obj::new();
    base.insert(
        "gen_ai.session.id".into(),
        Value::String(session_id.clone()),
    );
    base.insert("gen_ai.agent.type".into(), Value::String(AGENT_ID.into()));
    base.insert("gen_ai.agent.id".into(), Value::String(session_id.clone()));
    base.insert(
        "gen_ai.conversation.id".into(),
        Value::String(if transcript.conversation_id.is_empty() {
            session_id.clone()
        } else {
            transcript.conversation_id.clone()
        }),
    );
    base.insert("user.id".into(), Value::String(user_id.to_string()));
    if !cwd.is_empty() {
        base.insert("agent.kiro-cli.cwd".into(), Value::String(cwd.to_string()));
    }
    if is_session {
        base.insert(
            "kiro.id_source".into(),
            Value::String("session_jsonl".into()),
        );
        base.insert(
            "kiro.time_precision".into(),
            Value::String("turn_estimate".into()),
        );
    }

    let mut records = Vec::new();
    let mut current_trace = random_hex(16);
    let mut run_index = 0i64;
    let mut current_turn = format!("{turn_base}:r0");
    let mut prev_end = 0.0;
    let mut run_step_round = 0i64;
    let mut running_hash = INITIAL_HASH.to_string();
    let mut step_round = 0i64;
    let mut current_turn_start: Option<f64> = None;
    let mut last_tool_end = 0.0;

    for step in steps.iter_mut() {
        step_round += 1;
        let mut tool_matches = Vec::new();
        for tool in &step.tools {
            tool_matches.push(ToolMatch {
                tool: tool.clone(),
                pre: match_tool_event(pre_tool_events, &tool.name),
                post: match_tool_event(tool_events, &tool.name),
            });
        }

        let mut new_prompt_boundary = false;
        if is_session && step.turn_start_ms > 0.0 && current_turn_start != Some(step.turn_start_ms)
        {
            current_turn_start = Some(step.turn_start_ms);
            last_tool_end = 0.0;
            new_prompt_boundary = true;
        }
        if is_session && step.turn_start_ms > 0.0 {
            let turn_end = js_or(step.turn_end_ms, step.end_time_ms);
            if let Some(pre) = tool_matches.iter().find_map(|item| item.pre.as_ref()) {
                step.end_time_ms =
                    iso_to_ms(pre.get("startTs").and_then(Value::as_str).unwrap_or(""));
                if last_tool_end > 0.0 {
                    step.start_time_ms = last_tool_end;
                }
            } else if step.kind == "NotToolUse" && last_tool_end > 0.0 {
                step.start_time_ms = last_tool_end;
                step.end_time_ms = turn_end;
            }
            if let Some(post) = tool_matches
                .iter()
                .rev()
                .find_map(|item| item.post.as_ref())
            {
                last_tool_end =
                    iso_to_ms(post.get("captureTs").and_then(Value::as_str).unwrap_or(""));
            }
        }

        let mut split_run = false;
        if is_session {
            if new_prompt_boundary && step_round > 1 {
                split_run = true;
            }
        } else if prev_end > 0.0
            && step.start_time_ms > 0.0
            && (step.start_time_ms - prev_end) > RUN_GAP_MS
        {
            split_run = true;
        }
        if split_run {
            current_trace = random_hex(16);
            run_index += 1;
            current_turn = format!("{turn_base}:r{run_index}");
            run_step_round = 0;
        }
        if step.end_time_ms > 0.0 || step.start_time_ms > 0.0 {
            prev_end = js_or(step.end_time_ms, step.start_time_ms);
        }
        run_step_round += 1;

        let finish = if step.kind == "NotToolUse" {
            "stop"
        } else {
            "tool_call"
        };
        let mut step_fields = base.clone();
        step_fields.insert("trace_id".into(), Value::String(current_trace.clone()));
        step_fields.insert("gen_ai.turn.id".into(), Value::String(current_turn.clone()));
        step_fields.insert(
            "gen_ai.react.round".into(),
            json_number(run_step_round as f64),
        );
        step_fields.insert(
            "gen_ai.react.finish_reason".into(),
            Value::String(finish.into()),
        );

        let current_step_id = if step.step_id.is_empty() {
            format!("{current_turn}:s{step_round}")
        } else {
            step.step_id.clone()
        };
        let step_span = random_hex(8);
        let llm_span = random_hex(8);
        let response_id = if step.response_id.is_empty() {
            format!("{current_step_id}:r")
        } else {
            step.response_id.clone()
        };
        let model = first_non_empty(&step.model_id, &transcript.model_id, "auto");

        let input_msgs = input_messages(step);
        let current_hash = compute_hash(&running_hash, &input_msgs);
        let log_full = step_round == 1 || !input_msgs.is_empty();

        let mut request = event_shell(
            &step_fields,
            "llm.request",
            &ms_to_unix_nanos(step.start_time_ms),
            &llm_span,
            &step_span,
            &current_step_id,
        );
        request.insert(
            "gen_ai.response.id".into(),
            Value::String(response_id.clone()),
        );
        request.insert(
            "gen_ai.provider.name".into(),
            Value::String(PROVIDER_NAME.into()),
        );
        request.insert("gen_ai.request.model".into(), Value::String(model.clone()));
        request.insert(
            "gen_ai.input.messages_hash".into(),
            Value::String(current_hash.clone()),
        );
        request.insert(
            "gen_ai.input.messages_delta".into(),
            Value::Array(input_msgs.clone()),
        );
        if log_full {
            request.insert(
                "gen_ai.input.messages".into(),
                Value::Array(input_msgs.clone()),
            );
        }
        records.push(request);

        let credit = if step.credit_index >= 0 {
            transcript.credits.get(step.credit_index as usize).copied()
        } else {
            None
        };
        let mut response = event_shell(
            &step_fields,
            "llm.response",
            &ms_to_unix_nanos(js_or(step.end_time_ms, step.start_time_ms)),
            &llm_span,
            &step_span,
            &current_step_id,
        );
        response.insert("gen_ai.response.id".into(), Value::String(response_id));
        response.insert(
            "gen_ai.provider.name".into(),
            Value::String(PROVIDER_NAME.into()),
        );
        response.insert("gen_ai.request.model".into(), Value::String(model.clone()));
        response.insert("gen_ai.response.model".into(), Value::String(model));
        response.insert("gen_ai.response.finish_reasons".into(), json!([finish]));
        response.insert(
            "gen_ai.output.messages".into(),
            Value::Array(vec![output_message(step)]),
        );
        response.insert(
            "kiro.token_source".into(),
            Value::String("unavailable".into()),
        );
        if let Some(credit) = credit {
            response.insert("kiro.credit_cost".into(), json_number(credit));
        }
        records.push(response);
        running_hash = current_hash;

        for item in &tool_matches {
            let tool_span = random_hex(8);
            let call_time = if let Some(pre) = &item.pre {
                iso_to_unix_nanos(pre.get("startTs").and_then(Value::as_str).unwrap_or(""))
            } else {
                ms_to_unix_nanos(js_or(step.end_time_ms, step.start_time_ms))
            };
            let mut call = event_shell(
                &step_fields,
                "tool.call",
                &call_time,
                &tool_span,
                &step_span,
                &current_step_id,
            );
            call.insert(
                "gen_ai.tool.name".into(),
                Value::String(item.tool.name.clone()),
            );
            call.insert(
                "gen_ai.tool.call.id".into(),
                Value::String(item.tool.id.clone()),
            );
            call.insert(
                "gen_ai.tool.call.arguments".into(),
                to_json_value(&strip_meta_keys(&item.tool.args)).unwrap_or(Value::Null),
            );
            call.insert(
                "kiro.time_source".into(),
                Value::String(if item.pre.is_some() {
                    "processor_receive".into()
                } else {
                    "transcript_estimate".into()
                }),
            );
            call.insert(
                "kiro.time_precision".into(),
                Value::String(tool_precision(item.pre.is_some(), is_session)),
            );
            records.push(call);

            let hooked = item
                .post
                .as_ref()
                .and_then(|event| event.get("toolResponse"));
            if hooked.is_some_and(|value| !value.is_null()) {
                let tool_response = hooked.unwrap();
                let result_time = iso_to_unix_nanos(
                    item.post
                        .as_ref()
                        .and_then(|event| event.get("captureTs"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                );
                let mut result = event_shell(
                    &step_fields,
                    "tool.result",
                    &result_time,
                    &tool_span,
                    &step_span,
                    &current_step_id,
                );
                result.insert(
                    "gen_ai.tool.name".into(),
                    Value::String(item.tool.name.clone()),
                );
                result.insert(
                    "gen_ai.tool.call.id".into(),
                    Value::String(item.tool.id.clone()),
                );
                result.insert(
                    "gen_ai.tool.call.result".into(),
                    to_json_value(&extract_tool_result_text(tool_response)).unwrap_or(Value::Null),
                );
                let tool_err = detect_tool_error(tool_response);
                result.insert(
                    "tool.result.status".into(),
                    Value::String(
                        if tool_err.is_some() {
                            "error"
                        } else {
                            "success"
                        }
                        .into(),
                    ),
                );
                result.insert(
                    "kiro.time_source".into(),
                    Value::String("processor_receive".into()),
                );
                result.insert(
                    "kiro.time_precision".into(),
                    Value::String(tool_precision(true, is_session)),
                );
                if let Some(message) = tool_err {
                    result.insert("error.type".into(), Value::String("ToolError".into()));
                    result.insert("error.message".into(), Value::String(message));
                }
                records.push(result);
            } else {
                let derived = derive_tool_result_text(transcript, &item.tool);
                let mut result = event_shell(
                    &step_fields,
                    "tool.result",
                    &ms_to_unix_nanos(js_or(step.end_time_ms, step.start_time_ms) + 1.0),
                    &tool_span,
                    &step_span,
                    &current_step_id,
                );
                result.insert(
                    "gen_ai.tool.name".into(),
                    Value::String(item.tool.name.clone()),
                );
                result.insert(
                    "gen_ai.tool.call.id".into(),
                    Value::String(item.tool.id.clone()),
                );
                result.insert("gen_ai.tool.call.result".into(), Value::String(derived));
                result.insert("tool.result.status".into(), Value::String("success".into()));
                result.insert(
                    "kiro.time_source".into(),
                    Value::String("transcript_derived".into()),
                );
                records.push(result);
            }
        }
    }

    if !original_has_final {
        if let Some(text) = assistant_response {
            step_round += 1;
            run_step_round += 1;
            let synth_step_id = format!("{current_turn}:s{step_round}");
            let synth_step_span = random_hex(8);
            let synth_llm_span = random_hex(8);
            let synth_response_id = uuid::Uuid::new_v4().to_string();
            let synth_ms = now_ms();
            let model = first_non_empty(&transcript.model_id, "auto", "auto");
            let hash = compute_hash(&running_hash, &[]);
            let mut synth_fields = base.clone();
            synth_fields.insert("trace_id".into(), Value::String(current_trace));
            synth_fields.insert("gen_ai.turn.id".into(), Value::String(current_turn));
            synth_fields.insert(
                "gen_ai.react.round".into(),
                json_number(run_step_round as f64),
            );
            synth_fields.insert(
                "gen_ai.react.finish_reason".into(),
                Value::String("stop".into()),
            );
            let mut request = event_shell(
                &synth_fields,
                "llm.request",
                &ms_to_unix_nanos(synth_ms),
                &synth_llm_span,
                &synth_step_span,
                &synth_step_id,
            );
            request.insert(
                "gen_ai.response.id".into(),
                Value::String(synth_response_id.clone()),
            );
            request.insert(
                "gen_ai.provider.name".into(),
                Value::String(PROVIDER_NAME.into()),
            );
            request.insert("gen_ai.request.model".into(), Value::String(model.clone()));
            request.insert("gen_ai.input.messages_hash".into(), Value::String(hash));
            request.insert("gen_ai.input.messages_delta".into(), json!([]));
            records.push(request);

            let mut response = event_shell(
                &synth_fields,
                "llm.response",
                &ms_to_unix_nanos(synth_ms + 1.0),
                &synth_llm_span,
                &synth_step_span,
                &synth_step_id,
            );
            response.insert(
                "gen_ai.response.id".into(),
                Value::String(synth_response_id),
            );
            response.insert(
                "gen_ai.provider.name".into(),
                Value::String(PROVIDER_NAME.into()),
            );
            response.insert("gen_ai.request.model".into(), Value::String(model.clone()));
            response.insert("gen_ai.response.model".into(), Value::String(model));
            response.insert("gen_ai.response.finish_reasons".into(), json!(["stop"]));
            response.insert(
                "gen_ai.output.messages".into(),
                json!([{
                    "role": "assistant",
                    "parts": [{ "type": "text", "content": text }],
                    "finish_reason": "stop",
                    "derived": true
                }]),
            );
            response.insert(
                "kiro.token_source".into(),
                Value::String("unavailable".into()),
            );
            response.insert("kiro.synthesized".into(), Value::Bool(true));
            response.insert("kiro.id_source".into(), Value::String("synthesized".into()));
            response.insert(
                "kiro.time_source".into(),
                Value::String("processor_receive".into()),
            );
            response.insert("kiro.time_precision".into(), Value::String("1s".into()));
            records.push(response);
        }
    }

    records.sort_by_key(nano_key);
    records.into_iter().map(sanitize_record).collect()
}

fn event_shell(
    step_fields: &Obj,
    name: &str,
    time: &str,
    span_id: &str,
    parent: &str,
    step_id: &str,
) -> Obj {
    let mut record = Obj::new();
    record.insert("time_unix_nano".into(), Value::String(time.to_string()));
    record.insert(
        "event.id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    record.insert("event.name".into(), Value::String(name.to_string()));
    for (key, value) in step_fields {
        record.insert(key.clone(), value.clone());
    }
    record.insert("span_id".into(), Value::String(span_id.to_string()));
    record.insert("parent_span_id".into(), Value::String(parent.to_string()));
    record.insert("gen_ai.step.id".into(), Value::String(step_id.to_string()));
    record
}

fn input_messages(step: &Step) -> Vec<Value> {
    if !step.user_prompt.is_empty() {
        vec![text_message("user", &step.user_prompt)]
    } else {
        step.tool_use_results
            .iter()
            .map(|text| text_message("tool", text))
            .collect()
    }
}

fn text_message(role: &str, content: &str) -> Value {
    json!({
        "role": role,
        "parts": [{ "type": "text", "content": content }]
    })
}

fn output_message(step: &Step) -> Value {
    if step.kind == "NotToolUse" && !step.assistant_text.is_empty() {
        json!({
            "role": "assistant",
            "parts": [{ "type": "text", "content": step.assistant_text }],
            "finish_reason": "stop"
        })
    } else {
        let parts: Vec<Value> = step
            .tools
            .iter()
            .map(|tool| {
                let id = if tool.id.is_empty() {
                    Value::Null
                } else {
                    Value::String(tool.id.clone())
                };
                json!({
                    "type": "tool_call",
                    "id": id,
                    "name": tool.name,
                    "arguments": tool.args,
                })
            })
            .collect();
        json!({
            "role": "assistant",
            "parts": parts,
            "finish_reason": "tool_call",
            "derived": true
        })
    }
}

fn tool_precision(matched: bool, is_session: bool) -> String {
    if matched {
        "ms".into()
    } else if is_session {
        "turn_estimate".into()
    } else {
        "ms".into()
    }
}

fn session_key(transcript: &Transcript) -> String {
    if !transcript.conversation_id.is_empty() {
        transcript.conversation_id.clone()
    } else if !transcript.continuation_id.is_empty() {
        transcript.continuation_id.clone()
    } else {
        "unknown".into()
    }
}

fn first_non_empty(primary: &str, secondary: &str, fallback: &str) -> String {
    if !primary.is_empty() {
        primary.to_string()
    } else if !secondary.is_empty() {
        secondary.to_string()
    } else {
        fallback.to_string()
    }
}

fn normalize_tool_name(name: &str) -> String {
    if name.is_empty() {
        return "unknown".into();
    }
    if let Some(rest) = name.strip_prefix('@') {
        if let Some((_, after)) = rest.split_once('/') {
            return after.to_string();
        }
        return name.to_string();
    }
    name.to_string()
}

fn match_tool_event(events: &mut Vec<Value>, tool_name: &str) -> Option<Value> {
    let target = normalize_tool_name(tool_name);
    let index = events.iter().position(|event| {
        let name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
        normalize_tool_name(name) == target
    })?;
    Some(events.remove(index))
}

fn strip_meta_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(strip_meta_keys).collect()),
        Value::Object(map) => {
            let mut clean = Obj::new();
            for (key, item) in map {
                if key.starts_with("__") {
                    continue;
                }
                clean.insert(key.clone(), strip_meta_keys(item));
            }
            Value::Object(clean)
        }
        other => other.clone(),
    }
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

fn extract_tool_result_text(tool_response: &Value) -> Value {
    let Some(object) = tool_response.as_object() else {
        return tool_response.clone();
    };
    if let Some(Value::Array(items)) = object.get("result") {
        let text = items
            .iter()
            .map(|item| match item.as_str() {
                Some(text) => text.to_string(),
                None => serde_json::to_string(item).unwrap_or_else(|_| "null".into()),
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Value::String(text);
    }
    if let Some(Value::String(text)) = object.get("result") {
        return Value::String(text.clone());
    }
    Value::String(serde_json::to_string(tool_response).unwrap_or_else(|_| "{}".into()))
}

fn detect_tool_error(tool_response: &Value) -> Option<String> {
    let object = tool_response.as_object()?;
    if object.get("success") == Some(&Value::Bool(false)) {
        return Some(extract_tool_error_message(tool_response));
    }
    let items = object.get("result").and_then(Value::as_array)?;
    for item in items {
        let Some(map) = item.as_object() else {
            continue;
        };
        let Some(status) = map.get("exit_status") else {
            continue;
        };
        if status.is_null() {
            continue;
        }
        let rendered = js_coerce_string(status);
        if rendered == "0" {
            continue;
        }
        let detail = ["stderr", "error", "output", "stdout"]
            .iter()
            .find_map(|key| {
                map.get(*key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
            });
        return Some(match detail {
            Some(detail) => format!("exit_status {rendered}: {detail}"),
            None => format!("exit_status {rendered}"),
        });
    }
    None
}

fn extract_tool_error_message(tool_response: &Value) -> String {
    if let Some(object) = tool_response.as_object() {
        for key in ["error", "message"] {
            if let Some(text) = object.get(key).and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    serde_json::to_string(tool_response)
        .map(|text| text.chars().take(200).collect())
        .unwrap_or_else(|_| "tool execution reported failure".into())
}

fn derive_tool_result_text(transcript: &Transcript, tool: &ToolUse) -> String {
    if tool.id.is_empty() {
        return String::new();
    }
    transcript
        .tool_result_map
        .get(&tool.id)
        .cloned()
        .unwrap_or_default()
}

fn js_coerce_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".into(),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(integer) = number.as_u64() {
                integer.to_string()
            } else if let Some(float) = number.as_f64() {
                if float.is_finite() && float.fract() == 0.0 && float.abs() < 1e15 {
                    format!("{}", float as i64)
                } else {
                    number.to_string()
                }
            } else {
                number.to_string()
            }
        }
        Value::Array(items) => items
            .iter()
            .map(js_coerce_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn parse_conversation_value(value: &Value) -> Transcript {
    let conversation_id = js_str(value.get("conversation_id"), "");
    let utm = value
        .get("user_turn_metadata")
        .cloned()
        .unwrap_or(Value::Null);
    let continuation_id = js_str(utm.get("continuation_id"), "");
    let model_id = js_str(
        value
            .get("model_info")
            .and_then(|info| info.get("model_id")),
        &js_str(
            value
                .get("model_info")
                .and_then(|info| info.get("model_name")),
            "auto",
        ),
    );
    let credits: Vec<f64> = utm
        .get("usage_info")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(usage_number).collect())
        .unwrap_or_default();
    let history = value
        .get("history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut steps = Vec::new();
    for (index, entry) in history.iter().enumerate() {
        if !entry.is_object() {
            continue;
        }
        let assistant = entry.get("assistant").cloned().unwrap_or(Value::Null);
        let metadata = entry
            .get("request_metadata")
            .cloned()
            .unwrap_or(Value::Null);
        let is_tool = assistant.get("ToolUse").is_some_and(js_truthy);
        let is_response = assistant.get("Response").is_some_and(js_truthy);
        if !is_tool && !is_response {
            continue;
        }
        let chat_type = js_str(
            metadata.get("chat_conversation_type"),
            if is_tool { "ToolUse" } else { "NotToolUse" },
        );
        let kind = if chat_type == "NotToolUse" || (!is_tool && is_response) {
            "NotToolUse"
        } else {
            "ToolUse"
        };
        steps.push(Step {
            step_id: js_str(metadata.get("request_id"), ""),
            response_id: js_str(metadata.get("message_id"), ""),
            kind: kind.into(),
            model_id: js_str(metadata.get("model_id"), &model_id),
            start_time_ms: js_num(metadata.get("request_start_timestamp_ms"), 0.0),
            end_time_ms: js_num(metadata.get("stream_end_timestamp_ms"), 0.0),
            tools: if is_tool {
                extract_tool_uses(assistant.get("ToolUse").unwrap_or(&Value::Null))
            } else {
                Vec::new()
            },
            assistant_text: if is_tool {
                String::new()
            } else {
                extract_assistant_text(&assistant)
            },
            user_prompt: extract_user_prompt(entry),
            tool_use_results: extract_tool_use_results(entry),
            credit_index: if index < credits.len() {
                index as i64
            } else {
                -1
            },
            turn_start_ms: 0.0,
            turn_end_ms: 0.0,
        });
    }
    steps.sort_by(|left, right| left.start_time_ms.total_cmp(&right.start_time_ms));
    Transcript {
        conversation_id,
        continuation_id,
        model_id,
        steps,
        credits,
        updated_ms: 0.0,
        source: String::new(),
        tool_result_map: HashMap::new(),
        session_id: String::new(),
    }
}

fn read_transcript_for_cwd(
    db_path: &Path,
    cwd: &str,
    since_ms: f64,
) -> Result<Option<Transcript>, String> {
    if cwd.is_empty() {
        return Ok(None);
    }
    let fail = |err: &str| {
        format!(
            "[kiro-cli-transcript] failed to query db {}: {err}",
            db_path.display()
        )
    };
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| fail(&err.to_string()))?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|err| fail(&err.to_string()))?;
    let since = since_i64(since_ms);
    let mut stmt = conn
        .prepare(
            "SELECT conversation_id, value, updated_at
               FROM conversations_v2
              WHERE key = ?1
                AND (?2 = 0 OR updated_at > ?2)
              ORDER BY updated_at DESC
              LIMIT 1",
        )
        .map_err(|err| fail(&err.to_string()))?;
    let mut rows = stmt
        .query(params![cwd, since])
        .map_err(|err| fail(&err.to_string()))?;
    let (value_text, updated_ms) = {
        let Some(row) = rows.next().map_err(|err| fail(&err.to_string()))? else {
            return Ok(None);
        };
        let value_text = match row.get_ref(1).map_err(|err| fail(&err.to_string()))? {
            ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
                String::from_utf8_lossy(bytes).into_owned()
            }
            _ => return Ok(None),
        };
        let updated_ms = match row.get_ref(2).map_err(|err| fail(&err.to_string()))? {
            ValueRef::Integer(value) => value as f64,
            ValueRef::Real(value) => value,
            _ => 0.0,
        };
        (value_text, updated_ms)
    };
    let Ok(value) = serde_json::from_str::<Value>(&value_text) else {
        return Ok(None);
    };
    let mut parsed = parse_conversation_value(&value);
    if parsed.steps.is_empty() {
        return Ok(None);
    }
    parsed.updated_ms = updated_ms;
    Ok(Some(parsed))
}

fn extract_tool_uses(assistant_tool: &Value) -> Vec<ToolUse> {
    let Some(object) = assistant_tool.as_object() else {
        return Vec::new();
    };
    let Some(list) = object.get("tool_uses").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|tool| {
            let object = tool.as_object()?;
            let id = object.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return None;
            }
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or("unknown");
            Some(ToolUse {
                id: id.to_string(),
                name: name.to_string(),
                args: nullish(object.get("orig_args")).unwrap_or_else(|| {
                    nullish(object.get("args")).unwrap_or_else(|| Value::Object(Obj::new()))
                }),
            })
        })
        .collect()
}

fn extract_assistant_text(assistant: &Value) -> String {
    let Some(response) = assistant.get("Response") else {
        return String::new();
    };
    if let Some(text) = response.as_str() {
        return text.to_string();
    }
    response
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn extract_user_prompt(entry: &Value) -> String {
    let Some(content) = entry.get("user").and_then(|user| user.get("content")) else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(object) = content.as_object() else {
        return String::new();
    };
    for (key, node) in object {
        if !key.eq_ignore_ascii_case("prompt") {
            continue;
        }
        if let Some(text) = node.as_str() {
            return text.to_string();
        }
        if let Some(inner) = node.as_object() {
            for (inner_key, inner_value) in inner {
                if inner_key.eq_ignore_ascii_case("prompt") {
                    if let Some(text) = inner_value.as_str() {
                        return text.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

fn extract_tool_use_results(entry: &Value) -> Vec<String> {
    let Some(content) = entry
        .get("user")
        .and_then(|user| user.get("content"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let node = content
        .get("ToolUseResults")
        .filter(|value| js_truthy(value))
        .or_else(|| {
            content
                .get("CancelledToolUses")
                .filter(|value| js_truthy(value))
        });
    let Some(results) = node
        .and_then(Value::as_object)
        .and_then(|object| object.get("tool_use_results"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for result in results {
        let Some(parts) = result.get("content").and_then(Value::as_array) else {
            continue;
        };
        let texts: Vec<String> = parts
            .iter()
            .map(extract_tool_result_content_text)
            .filter(|text| !text.is_empty())
            .collect();
        if !texts.is_empty() {
            out.push(texts.join("\n"));
        }
    }
    out
}

fn extract_tool_result_content_text(item: &Value) -> String {
    let Some(object) = item.as_object() else {
        return String::new();
    };
    if let Some(text) = object.get("Text").and_then(Value::as_str) {
        return text.to_string();
    }
    let Some(json) = object.get("Json") else {
        return String::new();
    };
    if !js_truthy(json) {
        return String::new();
    }
    extract_mcp_json_text(json)
}

fn extract_mcp_json_text(data: &Value) -> String {
    if let Some(text) = data.as_str() {
        return text.to_string();
    }
    if let Some(object) = data.as_object() {
        if let Some(content) = object.get("content").and_then(Value::as_array) {
            let texts: Vec<&str> = content
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect();
            if !texts.is_empty() {
                return texts.join("\n");
            }
        }
        if let Some(text) = object
            .get("structuredContent")
            .and_then(|value| value.get("content"))
            .and_then(Value::as_str)
        {
            return text.to_string();
        }
    }
    serde_json::to_string(data).unwrap_or_default()
}

fn usage_number(value: &Value) -> f64 {
    match value {
        Value::Number(_) => js_num(Some(value), 0.0),
        Value::Object(map) => js_num(map.get("value"), 0.0),
        _ => 0.0,
    }
}

fn parse_session_lines(lines: &[Value], sidecar: &Value) -> Transcript {
    let session_id = js_str(sidecar.get("session_id"), "");
    let model_state = sidecar
        .pointer("/session_state/rts_model_state")
        .cloned()
        .unwrap_or(Value::Null);
    let conversation_id = js_str(model_state.get("conversation_id"), &session_id);
    let model_id = js_str(model_state.pointer("/model_info/model_id"), "auto");
    let turn_metadatas = sidecar
        .pointer("/session_state/conversation_metadata/user_turn_metadatas")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut credits = Vec::new();
    let mut turn_durations = Vec::new();
    let mut turn_ends = Vec::new();
    for metadata in &turn_metadatas {
        if let Some(usage) = metadata.get("metering_usage").and_then(Value::as_array) {
            for item in usage {
                let unit = item.get("unit").and_then(Value::as_str).unwrap_or("");
                let plural = item.get("unitPlural").and_then(Value::as_str).unwrap_or("");
                if unit == "credit" || plural == "credits" {
                    credits.push(js_num(item.get("value"), 0.0));
                }
            }
        }
        let duration = metadata.get("turn_duration");
        let secs = js_num(duration.and_then(|value| value.get("secs")), 0.0);
        let nanos = js_num(duration.and_then(|value| value.get("nanos")), 0.0);
        turn_durations.push(secs * 1000.0 + nanos / 1e6);
        let end = metadata
            .get("end_timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_ms)
            .unwrap_or(0) as f64;
        turn_ends.push(end);
    }

    let mut steps = Vec::new();
    let mut current_prompt = String::new();
    let mut current_turn_index = -1i64;
    let mut assistant_index = 0usize;
    let mut tool_result_map = HashMap::new();
    let mut pending: Vec<usize> = Vec::new();
    let mut pending_index = -1i64;

    for line in lines {
        if !line.is_object() {
            continue;
        }
        let kind = line.get("kind").and_then(Value::as_str).unwrap_or("");
        let data = line.get("data").cloned().unwrap_or(Value::Null);
        if kind == "Prompt" {
            flush_turn(
                &mut pending,
                &mut pending_index,
                &mut steps,
                &turn_ends,
                &turn_durations,
            );
            current_turn_index += 1;
            pending_index = current_turn_index;
            if let Some(content) = data.get("content").and_then(Value::as_array) {
                for part in content {
                    if part.get("kind").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = part.get("data").and_then(Value::as_str) {
                            current_prompt = text.to_string();
                        }
                    }
                }
            }
            continue;
        }
        if kind == "AssistantMessage" {
            let message_id = js_str(data.get("message_id"), "");
            let mut tool_uses = Vec::new();
            let mut text_content = String::new();
            if let Some(content) = data.get("content").and_then(Value::as_array) {
                for part in content {
                    let part_kind = part.get("kind").and_then(Value::as_str).unwrap_or("");
                    if part_kind == "toolUse" {
                        if let Some(tool_data) = part.get("data") {
                            tool_uses.push(ToolUse {
                                id: js_str(tool_data.get("toolUseId"), ""),
                                name: map_tool_name(&js_str(tool_data.get("name"), "")),
                                args: nullish(tool_data.get("input"))
                                    .unwrap_or_else(|| Value::Object(Obj::new())),
                            });
                        }
                    } else if part_kind == "text" {
                        if let Some(text) = part.get("data").and_then(Value::as_str) {
                            text_content.push_str(text);
                        }
                    }
                }
            }
            let is_tool = !tool_uses.is_empty();
            let step = Step {
                step_id: message_id.clone(),
                response_id: message_id,
                kind: if is_tool { "ToolUse" } else { "NotToolUse" }.into(),
                model_id: model_id.clone(),
                start_time_ms: 0.0,
                end_time_ms: 0.0,
                tools: if is_tool {
                    tool_uses
                        .into_iter()
                        .filter(|tool| !tool.id.is_empty())
                        .collect()
                } else {
                    Vec::new()
                },
                assistant_text: if is_tool { String::new() } else { text_content },
                user_prompt: current_prompt.clone(),
                tool_use_results: Vec::new(),
                credit_index: if assistant_index < credits.len() {
                    assistant_index as i64
                } else {
                    -1
                },
                turn_start_ms: 0.0,
                turn_end_ms: 0.0,
            };
            pending.push(steps.len());
            steps.push(step);
            current_prompt.clear();
            assistant_index += 1;
            continue;
        }
        if kind == "ToolResults" {
            for (id, text) in extract_session_tool_results(line) {
                tool_result_map.insert(id, text);
            }
        }
    }
    flush_turn(
        &mut pending,
        &mut pending_index,
        &mut steps,
        &turn_ends,
        &turn_durations,
    );
    for index in 1..steps.len() {
        let previous = steps[index - 1].tools.clone();
        if previous.is_empty() {
            continue;
        }
        let mut results = Vec::new();
        for tool in previous {
            if tool.id.is_empty() {
                continue;
            }
            if let Some(text) = tool_result_map.get(&tool.id) {
                results.push(text.clone());
            }
        }
        steps[index].tool_use_results = results;
    }
    Transcript {
        conversation_id: conversation_id.clone(),
        continuation_id: conversation_id,
        model_id,
        steps,
        credits,
        updated_ms: 0.0,
        source: String::new(),
        tool_result_map,
        session_id,
    }
}

fn flush_turn(
    pending: &mut Vec<usize>,
    pending_index: &mut i64,
    steps: &mut [Step],
    turn_ends: &[f64],
    turn_durations: &[f64],
) {
    if pending.is_empty() {
        return;
    }
    let index = *pending_index;
    if index < 0 || index as usize >= turn_ends.len() {
        pending.clear();
        *pending_index = -1;
        return;
    }
    let index = index as usize;
    let duration = turn_durations.get(index).copied().unwrap_or(0.0);
    let end = turn_ends[index];
    if end > 0.0 && duration > 0.0 {
        let base = end - duration;
        let slice = duration / pending.len() as f64;
        for (offset, step_index) in pending.iter().enumerate() {
            let step = &mut steps[*step_index];
            step.start_time_ms = base + offset as f64 * slice;
            step.end_time_ms = step.start_time_ms + slice;
            step.turn_start_ms = base;
            step.turn_end_ms = end;
        }
    }
    pending.clear();
    *pending_index = -1;
}

fn extract_session_tool_results(line: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(content) = line
        .get("data")
        .and_then(|data| data.get("content"))
        .and_then(Value::as_array)
    else {
        return out;
    };
    for entry in content {
        if entry.get("kind").and_then(Value::as_str) != Some("toolResult") {
            continue;
        }
        let Some(data) = entry.get("data") else {
            continue;
        };
        let Some(id) = data
            .get("toolUseId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let mut texts = Vec::new();
        if let Some(inner) = data.get("content").and_then(Value::as_array) {
            for part in inner {
                match part.get("kind").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = part.get("data").and_then(Value::as_str) {
                            texts.push(text.to_string());
                        }
                    }
                    Some("json") => {
                        if let Some(payload) = part.get("data") {
                            texts.push(extract_mcp_json_text(payload));
                        }
                    }
                    _ => {}
                }
            }
        }
        out.push((id.to_string(), texts.join("\n")));
    }
    out
}

fn map_tool_name(name: &str) -> String {
    match name {
        "" => "unknown".into(),
        "read" => "fs_read".into(),
        "write" => "fs_write".into(),
        "shell" | "execute_bash" => "execute_bash".into(),
        "fs_read" => "fs_read".into(),
        "fs_write" => "fs_write".into(),
        other => other.to_string(),
    }
}

fn read_session_jsonl(env: &Env, cwd: &str, _since_ms: f64) -> Option<Transcript> {
    if cwd.is_empty() {
        return None;
    }
    let session_dir = home_dir(env).join(".kiro").join("sessions").join("cli");
    if !session_dir.exists() {
        return None;
    }
    let entries = fs::read_dir(&session_dir).ok()?;
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.ends_with(".history") {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(sidecar) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if sidecar.get("cwd").and_then(Value::as_str) != Some(cwd) {
            continue;
        }
        let Some(session_id) = sidecar
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(|id| id.to_owned())
        else {
            continue;
        };
        let updated = sidecar
            .get("updated_at")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .and_then(parse_iso_ms)
            .unwrap_or(0) as f64;
        candidates.push((updated, session_id, sidecar));
    }
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(|left, right| right.0.total_cmp(&left.0));
    let (updated_ms, session_id, sidecar) = candidates.remove(0);
    let jsonl_path = session_dir.join(format!("{session_id}.jsonl"));
    if !jsonl_path.exists() {
        return None;
    }
    let Ok(raw) = fs::read_to_string(&jsonl_path) else {
        return None;
    };
    let mut lines = Vec::new();
    for line in raw.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            lines.push(value);
        }
    }
    if lines.is_empty() {
        return None;
    }
    let mut parsed = parse_session_lines(&lines, &sidecar);
    if parsed.steps.is_empty() {
        return None;
    }
    parsed.updated_ms = updated_ms;
    parsed.source = "session_jsonl".into();
    parsed.session_id = session_id;
    Some(parsed)
}

fn resolve_db_path(env: &Env) -> PathBuf {
    resolve_db_path_on(env, host_platform())
}

fn resolve_db_path_on(env: &Env, platform: &str) -> PathBuf {
    if let Some(path) = env_get(env, "KIRO_CLI_DB") {
        return expand_home(env, path);
    }
    if let Some(dir) = env_get(env, "KIRO_CLI_DATA_DIR") {
        return expand_home(env, dir).join(DB_FILE_NAME);
    }
    default_data_dir(env, platform).join(DB_FILE_NAME)
}

fn default_data_dir(env: &Env, platform: &str) -> PathBuf {
    if platform == "darwin" {
        return home_dir(env)
            .join("Library")
            .join("Application Support")
            .join("kiro-cli");
    }
    if platform == "win32" {
        if let Some(appdata) = env_get(env, "APPDATA") {
            return PathBuf::from(appdata).join("kiro-cli");
        }
        return home_dir(env)
            .join("AppData")
            .join("Roaming")
            .join("kiro-cli");
    }
    if let Some(xdg) = env_get(env, "XDG_DATA_HOME") {
        return expand_home(env, xdg).join("kiro-cli");
    }
    home_dir(env).join(".local").join("share").join("kiro-cli")
}

fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

fn expand_home(env: &Env, path: &str) -> PathBuf {
    if path == "~" {
        return home_dir(env);
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home_dir(env).join(rest);
    }
    PathBuf::from(path)
}

fn state_dir(env: &Env, name: &str) -> PathBuf {
    let dir = data_dir(env).join("state").join(AGENT_ID).join(name);
    let _ = fs::create_dir_all(&dir);
    dir
}

fn safe_key(cwd: &str) -> String {
    URL_SAFE_NO_PAD.encode(cwd.as_bytes())
}

fn buffer_file(env: &Env, kind: &str, cwd: &str) -> PathBuf {
    state_dir(env, kind).join(format!("{}.jsonl", safe_key(cwd)))
}

fn keyed_json(env: &Env, kind: &str, cwd: &str) -> PathBuf {
    state_dir(env, kind).join(format!("{}.json", safe_key(cwd)))
}

fn append_jsonl(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(line) = serde_json::to_string(value) else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn drain_jsonl(path: &Path) -> Vec<Value> {
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let _ = fs::create_dir_all(dir);
    let mut out = recover_stale_drains(dir, path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("buffer");
    let tmp = dir.join(format!("{file_name}.drain.{}", std::process::id()));
    if fs::rename(path, &tmp).is_err() {
        return out;
    }
    let raw = match fs::read_to_string(&tmp) {
        Ok(text) => text,
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            return out;
        }
    };
    let _ = fs::remove_file(&tmp);
    out.extend(parse_jsonl(&raw));
    out
}

fn recover_stale_drains(dir: &Path, base: &Path) -> Vec<Value> {
    let Some(base_name) = base.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let prefix = format!("{base_name}.drain.");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(entry.path()) {
            out.extend(parse_jsonl(&raw));
        }
        let _ = fs::remove_file(entry.path());
    }
    out
}

fn parse_jsonl(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in raw.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            out.push(value);
        }
    }
    out
}

fn load_number_file(path: &Path, field: &str) -> f64 {
    let Ok(text) = fs::read_to_string(path) else {
        return 0.0;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| finite_f64(value.get(field)))
        .unwrap_or(0.0)
}

fn load_offset(env: &Env, cwd: &str) -> f64 {
    load_number_file(&keyed_json(env, "offsets", cwd), "updatedMs")
}

fn load_session_offset(env: &Env, cwd: &str) -> f64 {
    load_number_file(&keyed_json(env, "session-offsets", cwd), "updatedMs")
}

fn save_offset(env: &Env, cwd: &str, updated_ms: f64) {
    save_number_file(
        &keyed_json(env, "offsets", cwd),
        "updatedMs",
        updated_ms,
        cwd,
    );
}

fn save_session_offset(env: &Env, cwd: &str, updated_ms: f64) {
    save_number_file(
        &keyed_json(env, "session-offsets", cwd),
        "updatedMs",
        updated_ms,
        cwd,
    );
}

fn save_number_file(path: &Path, field: &str, number: f64, cwd: &str) {
    let mut payload = Obj::new();
    payload.insert(field.to_string(), json_number(number));
    atomic_state_write(path, cwd, &Value::Object(payload));
}

fn load_turn_count(env: &Env, cwd: &str) -> i64 {
    let value = load_number_file(&keyed_json(env, "turn-counts", cwd), "count");
    if value.is_finite() {
        value as i64
    } else {
        0
    }
}

fn save_turn_count(env: &Env, cwd: &str, count: i64) {
    let path = keyed_json(env, "turn-counts", cwd);
    atomic_state_write(path.as_path(), cwd, &json!({ "count": count }));
}

fn load_emitted_steps(env: &Env, cwd: &str) -> HashMap<String, HashSet<String>> {
    let path = keyed_json(env, "emitted-steps", cwd);
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&text) else {
        return HashMap::new();
    };
    if let Some(Value::Object(conversations)) = data.get("conversations") {
        let mut map = HashMap::new();
        for (conv_id, ids) in conversations {
            let set = ids
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            map.insert(conv_id.clone(), set);
        }
        return map;
    }
    if let (Some(conv_id), Some(ids)) = (
        data.get("conversationId").and_then(Value::as_str),
        data.get("stepIds").and_then(Value::as_array),
    ) {
        let set = ids
            .iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect();
        let mut map = HashMap::new();
        map.insert(conv_id.to_string(), set);
        return map;
    }
    HashMap::new()
}

fn save_emitted_steps(env: &Env, cwd: &str, conversation_id: &str, new_ids: &[String]) {
    let path = keyed_json(env, "emitted-steps", cwd);
    let mut existing = load_emitted_steps(env, cwd);
    let current = existing.entry(conversation_id.to_string()).or_default();
    for id in new_ids {
        if !id.is_empty() {
            current.insert(id.clone());
        }
    }
    let mut conversations = Obj::new();
    for (conv_id, ids) in &existing {
        let values = ids.iter().cloned().map(Value::String).collect();
        conversations.insert(conv_id.clone(), Value::Array(values));
    }
    atomic_state_write(&path, cwd, &json!({ "conversations": conversations }));
}

fn atomic_state_write(path: &Path, cwd: &str, payload: &Value) {
    let Some(dir) = path.parent() else {
        return;
    };
    let _ = fs::create_dir_all(dir);
    let bytes = match serde_json::to_vec(payload) {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    let tmp = dir.join(format!("{}.{}.tmp", safe_key(cwd), std::process::id()));
    if fs::write(&tmp, &bytes).is_ok() && fs::rename(&tmp, path).is_ok() {
        return;
    }
    let _ = fs::remove_file(&tmp);
    let _ = fs::write(path, bytes);
}

fn enqueue_pending_stop(env: &Env, record: &PendingStop) {
    let ready = state_dir(env, "pending-stops/ready");
    let _ = fs::create_dir_all(state_dir(env, "pending-stops/inflight"));
    let enqueue_ms = now_ms();
    let name = format!(
        "{:013}-{}-{}.json",
        enqueue_ms as u64,
        std::process::id(),
        next_enqueue_id()
    );
    let mut payload = Obj::new();
    payload.insert("schemaVersion".into(), json!(1));
    payload.insert("enqueueMs".into(), json_number(enqueue_ms));
    payload.insert("cwd".into(), Value::String(record.cwd.clone()));
    payload.insert("stopUnixMs".into(), json_number(record.stop_unix_ms));
    payload.insert("sinceMs".into(), json_number(record.since_ms));
    payload.insert(
        "sessionSinceMs".into(),
        json_number(record.session_since_ms),
    );
    payload.insert(
        "assistantResponse".into(),
        match &record.assistant_response {
            Some(text) => Value::String(text.clone()),
            None => Value::Null,
        },
    );
    payload.insert("userId".into(), Value::String(record.user_id.clone()));
    atomic_state_write(&ready.join(&name), &record.cwd, &Value::Object(payload));
}

fn next_enqueue_id() -> u32 {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    (COUNTER.fetch_add(1, Ordering::Relaxed) + 1) & 0xffff
}

fn wake_daemon(env: &Env) {
    let Ok(text) = fs::read_to_string(data_dir(env).join("loongsuite-pilot.pid")) else {
        return;
    };
    let Ok(pid) = text.trim().parse::<i32>() else {
        return;
    };
    if pid <= 0 {
        return;
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-USR1", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn default_log_dir(env: &Env) -> PathBuf {
    data_dir(env).join("logs").join(AGENT_ID)
}

fn read_event(stdin: &[u8]) -> Obj {
    parse_json_object(stdin).unwrap_or_default()
}

fn event_cwd(event: &Obj) -> Option<String> {
    event
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_owned)
}

fn event_tool_name(event: &Obj) -> String {
    event
        .get("tool_name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn event_tool_input(event: &Obj) -> Value {
    match event.get("tool_input") {
        Some(value) if !value.is_null() => value.clone(),
        _ => Value::Object(Obj::new()),
    }
}

fn log_err(env: &Env, stage: &str, error_type: &str, message: &str) {
    log_hook_error(env, AGENT_ID, stage, error_type, message);
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

fn finite_f64(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn js_num(value: Option<&Value>, fallback: f64) -> f64 {
    finite_f64(value).unwrap_or(fallback)
}

fn js_str(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number
            .as_f64()
            .map(|number| number != 0.0 && number.is_finite())
            .unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_truthy_f64(value: f64) -> bool {
    value != 0.0 && value.is_finite()
}

fn js_or(primary: f64, fallback: f64) -> f64 {
    if primary == 0.0 || !primary.is_finite() {
        fallback
    } else {
        primary
    }
}

fn nullish(value: Option<&Value>) -> Option<Value> {
    value.filter(|item| !item.is_null()).cloned()
}

fn since_i64(since: f64) -> i64 {
    if !since.is_finite() {
        return 0;
    }
    if since >= i64::MAX as f64 {
        return i64::MAX;
    }
    if since <= i64::MIN as f64 {
        return i64::MIN;
    }
    since as i64
}

fn ms_to_unix_nanos(ms: f64) -> String {
    if ms == 0.0 || !ms.is_finite() {
        return "0".into();
    }
    let floored = ms.floor();
    if floored < i64::MIN as f64 || floored > i64::MAX as f64 {
        return "0".into();
    }
    format!("{}000000", floored as i64)
}

fn iso_to_ms(iso: &str) -> f64 {
    if iso.is_empty() {
        return 0.0;
    }
    parse_iso_ms(iso).unwrap_or(0) as f64
}

fn iso_to_unix_nanos(iso: &str) -> String {
    if iso.is_empty() {
        return "0".into();
    }
    match parse_iso_ms(iso) {
        Some(ms) => format!("{ms}000000"),
        None => "0".into(),
    }
}

fn parse_iso_ms(iso: &str) -> Option<i64> {
    let iso = iso.trim();
    if iso.is_empty() {
        return None;
    }
    if let Some(ms) = rfc3339_millis(iso) {
        return Some(ms);
    }
    let truncated = truncate_fraction(iso);
    if truncated != iso {
        return rfc3339_millis(&truncated);
    }
    None
}

fn rfc3339_millis(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn truncate_fraction(iso: &str) -> String {
    let Some(dot) = iso.find('.') else {
        return iso.to_string();
    };
    let tail = &iso[dot + 1..];
    let tz_at = tail.find(['Z', '+', '-']).unwrap_or(tail.len());
    let digits = &tail[..tz_at];
    let tz = &tail[tz_at..];
    let keep = digits.len().min(3);
    format!("{}.{}{tz}", &iso[..dot], &digits[..keep])
}

fn compute_hash(prev: &str, messages: &[Value]) -> String {
    let mut hash = prev.to_string();
    for message in messages {
        hash = hash_step(&hash, message);
    }
    hash
}

fn hash_step(prev: &str, message: &Value) -> String {
    let serialized = stable_serialize(message);
    let mut bytes = Vec::with_capacity(prev.len() + serialized.len());
    bytes.extend_from_slice(prev.as_bytes());
    bytes.extend_from_slice(serialized.as_bytes());
    sha256_hex(&bytes).chars().take(32).collect()
}

fn stable_serialize(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
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
                    let encoded = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into());
                    format!("{encoded}:{}", stable_serialize(&map[key]))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

fn nano_key(record: &Obj) -> u128 {
    record
        .get("time_unix_nano")
        .and_then(Value::as_str)
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;
    use std::fs;

    const CWD: &str = "/tmp/kiro_probe/work_r3";
    const CONV_ID: &str = "f66fecc5-d8bb-4b26-ba93-c0575bf0fb4a";
    const SESSION_CWD: &str = "/tmp/kiro_session_probe";
    const MCP_CWD: &str = "/tmp/kiro_mcp_probe";
    const TWO_PROMPT_CWD: &str = "/tmp/kiro_2prompt_probe";
    const CONV_RAW: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/round3_conv_raw.json");
    const HOOK_EVENTS: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/round3_hook_events.jsonl");
    const BASH_FAILED: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/posttool_bash_failed.json");
    const SESSION_JSONL: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/session_interactive.jsonl");
    const SESSION_SIDECAR: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/session_sidecar.json");
    const MCP_JSONL: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/session_mcp_interactive.jsonl");
    const MCP_SIDECAR: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/session_mcp_sidecar.json");
    const TWO_JSONL: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/session_2prompt_interactive.jsonl");
    const TWO_SIDECAR: &str =
        include_str!("../../tests/unit/hooks/kiro-cli/fixtures/session_2prompt_sidecar.json");

    struct Harness {
        _dir: tempfile::TempDir,
        root: PathBuf,
        home: PathBuf,
        db: PathBuf,
    }

    impl Harness {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().to_path_buf();
            let home = root.join("home");
            fs::create_dir_all(&home).unwrap();
            let db = root.join("data.sqlite3");
            Self {
                _dir: dir,
                root,
                home,
                db,
            }
        }

        fn with_round3(self) -> Self {
            insert_conversation(&self.db, CWD, CONV_ID, &conv_fixture(), now_ms() as i64);
            self
        }
    }

    fn conv_fixture() -> Value {
        serde_json::from_str(CONV_RAW).unwrap()
    }

    fn insert_conversation(path: &Path, cwd: &str, conv_id: &str, value: &Value, updated_ms: i64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations_v2 (
                key TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (key, conversation_id)
            )",
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![cwd, conv_id, serde_json::to_string(value).unwrap(), updated_ms - 10_000, updated_ms],
        )
        .unwrap();
    }

    fn run_at(harness: &Harness, args: &[&str], stdin: &Value) -> (i32, String) {
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            harness.root.to_string_lossy().into_owned(),
        );
        env.insert("HOME".into(), harness.home.to_string_lossy().into_owned());
        env.insert(
            "KIRO_CLI_DB".into(),
            harness.db.to_string_lossy().into_owned(),
        );
        let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        let bytes = serde_json::to_vec(stdin).unwrap();
        let mut stdout = Vec::new();
        let code = {
            let mut request = HookRequest {
                args: &owned,
                stdin: &bytes,
                env: &env,
                stdout: &mut stdout,
            };
            run(&mut request)
        };
        (code, String::from_utf8(stdout).unwrap())
    }

    fn latest_pending(root: &Path, cwd: &str) -> Option<PathBuf> {
        let dir = root.join("state/kiro-cli/pending-stops/ready");
        let mut best: Option<(f64, PathBuf)> = None;
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.ends_with(".tmp") {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("cwd").and_then(Value::as_str) != Some(cwd) {
                continue;
            }
            let enqueue = value
                .get("enqueueMs")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if best.as_ref().map(|(ms, _)| enqueue >= *ms).unwrap_or(true) {
                best = Some((enqueue, entry.path()));
            }
        }
        best.map(|(_, path)| path)
    }

    fn stop_and_collect(harness: &Harness, payload: &Value) -> (i32, String) {
        let (code, stdout) = run_at(harness, &["stop"], payload);
        assert_eq!(code, 0, "native stop must remain fail-open");
        let Some(cwd) = payload
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
        else {
            return (code, stdout);
        };
        let Some(pending) = latest_pending(&harness.root, cwd) else {
            return (code, stdout);
        };
        let pending = pending.to_string_lossy().into_owned();
        let result = run_at(harness, &["delayedCollect", &pending], &json!({}));
        assert_eq!(
            result.0, 0,
            "native delayed collection must exit successfully"
        );
        result
    }

    fn read_records(root: &Path) -> Vec<Value> {
        let dir = root.join("logs/kiro-cli");
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .collect();
        paths.sort();
        let mut records = Vec::new();
        for path in paths {
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    records.push(value);
                }
            }
        }
        records
    }

    fn buffer_fixture(harness: &Harness, event_name: &str) {
        for line in HOOK_EVENTS.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(payload) = value.get("_hook_payload") else {
                continue;
            };
            if payload.get("hook_event_name").and_then(Value::as_str) == Some(event_name) {
                let sub = if event_name == "preToolUse" {
                    "preToolUse"
                } else {
                    "postToolUse"
                };
                let _ = run_at(harness, &[sub], payload);
            }
        }
    }

    fn named<'a>(records: &'a [Value], name: &str) -> Vec<&'a Value> {
        records
            .iter()
            .filter(|record| record.get("event.name").and_then(Value::as_str) == Some(name))
            .collect()
    }

    fn install_session(home: &Path, sidecar_raw: &str, jsonl: &str, updated_at: &str) {
        let dir = home.join(".kiro/sessions/cli");
        fs::create_dir_all(&dir).unwrap();
        let mut sidecar: Value = serde_json::from_str(sidecar_raw).unwrap();
        sidecar["updated_at"] = Value::String(updated_at.to_string());
        let sid = sidecar["session_id"].as_str().unwrap().to_string();
        fs::write(
            dir.join(format!("{sid}.json")),
            serde_json::to_string(&sidecar).unwrap(),
        )
        .unwrap();
        fs::write(dir.join(format!("{sid}.jsonl")), jsonl).unwrap();
    }

    fn iso_now_utc() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn missing_cwd_is_fail_open() {
        let harness = Harness::new();
        let (code, stdout) = stop_and_collect(&harness, &json!({ "hook_event_name": "stop" }));
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(read_records(&harness.root).is_empty());
    }

    #[test]
    fn unknown_subcommand_prints_empty_object() {
        let harness = Harness::new();
        let (code, stdout) = run_at(&harness, &["bogus"], &json!({}));
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
    }

    #[test]
    fn user_prompt_submit_is_noop() {
        let harness = Harness::new();
        let (code, stdout) = run_at(
            &harness,
            &["userPromptSubmit"],
            &json!({ "cwd": CWD, "prompt": "hello" }),
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(read_records(&harness.root).is_empty());
    }

    #[test]
    fn sqlite_history_emits_three_steps_and_two_tools() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "postToolUse");
        let (code, stdout) = stop_and_collect(
            &harness,
            &json!({
                "hook_event_name": "stop",
                "cwd": CWD,
                "assistant_response": "**sample.txt** contains: `hello kiro round3`"
            }),
        );
        assert_eq!(code, 0);
        assert!(stdout.contains("\"status\":\"ok\""), "{stdout}");
        let records = read_records(&harness.root);
        assert_eq!(named(&records, "llm.response").len(), 3);
        let calls = named(&records, "tool.call");
        let results = named(&records, "tool.result");
        assert_eq!(calls.len(), 2);
        assert_eq!(results.len(), 2);
        let mut names: Vec<&str> = calls
            .iter()
            .filter_map(|record| record.get("gen_ai.tool.name").and_then(Value::as_str))
            .collect();
        names.sort();
        assert_eq!(names, vec!["fs_read", "fs_write"]);
        let traces: HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("trace_id").and_then(Value::as_str))
            .collect();
        assert_eq!(traces.len(), 1);
        for record in &records {
            assert_eq!(record["gen_ai.agent.type"], "kiro-cli");
            assert_eq!(record["gen_ai.conversation.id"], CONV_ID);
            assert_eq!(record["agent.kiro-cli.cwd"], CWD);
        }
        assert!(records.iter().all(|record| {
            record.get("gen_ai.usage.input_tokens").is_none()
                && record.get("gen_ai.usage.output_tokens").is_none()
        }));
    }

    #[test]
    fn post_tool_use_supplements_tool_response_only() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let fs_read = records.iter().find(|record| {
            record["event.name"] == "tool.result" && record["gen_ai.tool.name"] == "fs_read"
        });
        let fs_read = fs_read.expect("fs_read result");
        assert_eq!(fs_read["gen_ai.tool.call.result"], "hello kiro round3");
        assert_eq!(
            fs_read["gen_ai.tool.call.id"],
            "tooluse_9ZXIR6XBjCnWiGGEZrHWGQ"
        );
        assert_eq!(fs_read["kiro.time_source"], "processor_receive");
        assert_eq!(fs_read["kiro.time_precision"], "ms");
        let responses = named(&records, "llm.response");
        assert!(responses.iter().all(|record| {
            record["kiro.token_source"] == "unavailable" && record["kiro.credit_cost"].is_number()
        }));
        for record in &records {
            let step_id = record.get("gen_ai.step.id").and_then(Value::as_str);
            let response_id = record.get("gen_ai.response.id").and_then(Value::as_str);
            if let (Some(step_id), Some(response_id)) = (step_id, response_id) {
                assert_ne!(step_id, response_id);
            }
        }
        let final_response = responses.last().unwrap();
        assert_eq!(
            final_response["gen_ai.step.id"],
            "153ca0d0-eedd-4573-ad43-e4b16d742d51"
        );
        assert_eq!(
            final_response["gen_ai.response.id"],
            "5ca50dc2-6cbb-40f1-b934-52e803af2111"
        );
    }

    #[test]
    fn tool_steps_emit_derived_tool_call_parts_and_user_prompt() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let tool_responses: Vec<_> = named(&records, "llm.response")
            .into_iter()
            .filter(|record| {
                record["gen_ai.response.finish_reasons"]
                    .as_array()
                    .is_some_and(|reasons| reasons.iter().any(|reason| reason == "tool_call"))
            })
            .collect();
        assert_eq!(tool_responses.len(), 2);
        for record in tool_responses {
            let message = &record["gen_ai.output.messages"][0];
            assert_eq!(message["derived"], true);
            assert_eq!(message["finish_reason"], "tool_call");
            let parts = message["parts"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|part| part["type"] == "tool_call")
                .count();
            assert!(parts > 0);
            let first = message["parts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|part| part["type"] == "tool_call")
                .unwrap();
            assert!(first["name"].is_string());
        }
        let mut requests = named(&records, "llm.request");
        requests.sort_by_key(|record| nano_key_value(record));
        let delta = requests[0]["gen_ai.input.messages_delta"]
            .as_array()
            .unwrap();
        assert!(!delta.is_empty());
        assert_eq!(delta[0]["parts"][0]["type"], "text");
        let content = delta[0]["parts"][0]["content"].as_str().unwrap();
        assert!(content.contains("sample.txt"));
        for request in requests.iter().skip(1) {
            if let Some(messages) = request
                .get("gen_ai.input.messages_delta")
                .and_then(Value::as_array)
            {
                if !messages.is_empty() {
                    assert!(messages.iter().all(|message| message["role"] == "tool"));
                }
            }
        }
    }

    fn nano_key_value(record: &Value) -> u128 {
        record["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap_or(0)
    }

    #[test]
    fn offset_and_step_dedup_suppress_repeat_stops() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "postToolUse");
        let payload =
            json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" });
        let _ = stop_and_collect(&harness, &payload);
        let first = read_records(&harness.root).len();
        assert!(first > 0);
        let offset = fs::read_to_string(
            harness
                .root
                .join("state/kiro-cli/offsets")
                .join(format!("{}.json", safe_key(CWD))),
        )
        .unwrap();
        let offset: Value = serde_json::from_str(&offset).unwrap();
        let since = offset["updatedMs"].as_f64().unwrap();
        assert!(since > 0.0);
        assert!(read_transcript_for_cwd(&harness.db, CWD, since)
            .unwrap()
            .is_none());

        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(&harness, &payload);
        assert_eq!(read_records(&harness.root).len(), first);

        let conn = Connection::open(&harness.db).unwrap();
        conn.execute(
            "UPDATE conversations_v2 SET updated_at = updated_at + 10000 WHERE key = ?1",
            params![CWD],
        )
        .unwrap();
        drop(conn);
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(&harness, &payload);
        let records = read_records(&harness.root);
        assert_eq!(records.len(), first);
        let traces: HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("trace_id").and_then(Value::as_str))
            .collect();
        assert_eq!(traces.len(), 1);
    }

    #[test]
    fn new_conversation_id_emits_again() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" }),
        );
        let first = read_records(&harness.root).len();
        assert!(first > 0);
        let mut conv = conv_fixture();
        let new_id = format!("new-conv-{}", now_ms() as i64);
        conv["conversation_id"] = Value::String(new_id.clone());
        for entry in conv["history"].as_array_mut().unwrap() {
            if let Some(metadata) = entry.get_mut("request_metadata") {
                if let Some(id) = metadata.get("request_id").and_then(Value::as_str) {
                    metadata["request_id"] = Value::String(format!("new-{id}"));
                }
                if let Some(id) = metadata.get("message_id").and_then(Value::as_str) {
                    metadata["message_id"] = Value::String(format!("new-{id}"));
                }
            }
        }
        insert_conversation(&harness.db, CWD, &new_id, &conv, now_ms() as i64 + 50_000);
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" }),
        );
        assert!(read_records(&harness.root).len() > first);
    }

    #[test]
    fn pre_tool_use_sets_processor_receive_and_consume_on_match() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "preToolUse");
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let calls = named(&records, "tool.call");
        assert_eq!(calls.len(), 2);
        for call in &calls {
            assert_eq!(call["kiro.time_source"], "processor_receive");
            assert_eq!(call["kiro.time_precision"], "ms");
            let step_id = call["gen_ai.step.id"].as_str().unwrap();
            let request = records.iter().find(|record| {
                record["event.name"] == "llm.request" && record["gen_ai.step.id"] == step_id
            });
            let response = records.iter().find(|record| {
                record["event.name"] == "llm.response" && record["gen_ai.step.id"] == step_id
            });
            assert_ne!(call["time_unix_nano"], request.unwrap()["time_unix_nano"]);
            assert!(nano_key_value(call) >= nano_key_value(response.unwrap()));
        }
    }

    #[test]
    fn missing_pre_tool_use_estimates_from_transcript() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let calls = named(&records, "tool.call");
        assert_eq!(calls.len(), 2);
        for call in calls {
            assert_eq!(call["kiro.time_source"], "transcript_estimate");
            assert_eq!(call["kiro.time_precision"], "ms");
        }
    }

    #[test]
    fn duplicate_pre_tool_events_do_not_cross_wire() {
        let harness = Harness::new().with_round3();
        let pre = json!({
            "hook_event_name": "preToolUse",
            "cwd": CWD,
            "tool_name": "fs_read",
            "tool_input": { "operations": [{ "mode": "Line", "path": "/tmp/kiro_probe/work_r3/sample.txt" }] }
        });
        let _ = run_at(&harness, &["preToolUse"], &pre);
        let _ = run_at(&harness, &["preToolUse"], &pre);
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let calls: Vec<_> = named(&records, "tool.call")
            .into_iter()
            .filter(|record| record["gen_ai.tool.name"] == "fs_read")
            .collect();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["kiro.time_source"], "processor_receive");
    }

    #[test]
    fn turn_ids_increment_across_stops() {
        let harness = Harness::new().with_round3();
        buffer_fixture(&harness, "postToolUse");
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "round3 done" }),
        );
        let records = read_records(&harness.root);
        let turns: HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("gen_ai.turn.id").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        assert_eq!(turns.len(), 1);
        let turn1 = format!("{CONV_ID}:t1:r0");
        assert!(turns.contains(turn1.as_str()));

        let mut conv = conv_fixture();
        let last = conv["history"].as_array().unwrap().last().unwrap().clone();
        let mut appended = last;
        appended["user"] =
            json!({ "content": { "Prompt": { "prompt": "second turn user input" } } });
        appended["assistant"] = json!({ "Response": { "content": "second turn final answer" } });
        let mut metadata = appended["request_metadata"].clone();
        metadata["request_id"] = json!("turn2-req-00000000-0000-0000-0000-000000000001");
        metadata["message_id"] = json!("turn2-msg-00000000-0000-0000-0000-000000000001");
        metadata["request_start_timestamp_ms"] = json!(1781686310000i64);
        metadata["stream_end_timestamp_ms"] = json!(1781686312000i64);
        metadata["chat_conversation_type"] = json!("NotToolUse");
        metadata["tool_use_ids_and_names"] = json!([]);
        appended["request_metadata"] = metadata;
        conv["history"].as_array_mut().unwrap().push(appended);
        insert_conversation(&harness.db, CWD, CONV_ID, &conv, now_ms() as i64 + 60_000);
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": CWD, "assistant_response": "second turn done" }),
        );
        let second: Vec<_> = read_records(&harness.root)
            .into_iter()
            .filter(|record| record["gen_ai.turn.id"] != turn1)
            .collect();
        assert!(!second.is_empty());
        assert!(second
            .iter()
            .all(|record| record["gen_ai.turn.id"] == format!("{CONV_ID}:t2:r0")));
    }

    #[test]
    fn session_jsonl_fallback_builds_records() {
        let harness = Harness::new();
        install_session(
            &harness.home,
            SESSION_SIDECAR,
            SESSION_JSONL,
            &iso_now_utc(),
        );
        let (code, stdout) = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": SESSION_CWD, "assistant_response": "done" }),
        );
        assert_eq!(code, 0);
        assert!(stdout.contains("\"status\":\"ok\""), "{stdout}");
        let records = read_records(&harness.root);
        assert_eq!(named(&records, "llm.request").len(), 2);
        assert_eq!(named(&records, "llm.response").len(), 2);
        assert_eq!(named(&records, "tool.call").len(), 2);
        assert_eq!(named(&records, "tool.result").len(), 2);
        assert!(records.iter().all(|record| {
            record["kiro.id_source"] == "session_jsonl"
                && record["kiro.time_precision"] == "turn_estimate"
                && record["gen_ai.conversation.id"] == "838a0f1b-1cfd-4421-972a-8807a1b20eb5"
        }));
        let mut names: Vec<&str> = named(&records, "tool.call")
            .into_iter()
            .filter_map(|record| record.get("gen_ai.tool.name").and_then(Value::as_str))
            .collect();
        names.sort();
        assert_eq!(names, vec!["execute_bash", "fs_read"]);
        let call = named(&records, "tool.call")
            .into_iter()
            .find(|record| record["gen_ai.tool.name"] == "fs_read")
            .unwrap();
        let arguments = serde_json::to_string(&call["gen_ai.tool.call.arguments"]).unwrap();
        assert!(!arguments.contains("__tool_use_purpose"));
        let mut responses = named(&records, "llm.response");
        responses.sort_by_key(|record| nano_key_value(record));
        let text = responses.last().unwrap()["gen_ai.output.messages"][0]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|part| part["type"] == "text")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(text.contains("k57j05345.sqa.eu95"));
        assert!(responses.last().unwrap()["gen_ai.response.finish_reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "stop"));
        let mut requests = named(&records, "llm.request");
        requests.sort_by_key(|record| nano_key_value(record));
        assert_eq!(
            requests[0]["gen_ai.input.messages_delta"][0]["role"],
            "user"
        );
        let second_delta = requests[1]["gen_ai.input.messages_delta"]
            .as_array()
            .unwrap();
        assert!(!second_delta.is_empty());
        assert!(second_delta.iter().all(|message| message["role"] == "tool"));
        let derived = named(&records, "tool.result")
            .into_iter()
            .filter(|result| result["kiro.time_source"] == "transcript_derived")
            .collect::<Vec<_>>();
        assert!(!derived.is_empty());
        for result in derived {
            let call = records.iter().find(|record| {
                record["event.name"] == "tool.call"
                    && record["gen_ai.tool.call.id"] == result["gen_ai.tool.call.id"]
                    && record["gen_ai.step.id"] == result["gen_ai.step.id"]
            });
            assert!(nano_key_value(result) > nano_key_value(call.unwrap()));
        }
    }

    #[test]
    fn session_hook_tool_response_and_dedup() {
        let harness = Harness::new();
        install_session(
            &harness.home,
            SESSION_SIDECAR,
            SESSION_JSONL,
            &iso_now_utc(),
        );
        let _ = run_at(
            &harness,
            &["postToolUse"],
            &json!({
                "hook_event_name": "postToolUse",
                "cwd": SESSION_CWD,
                "tool_name": "fs_read",
                "tool_input": { "operations": [{ "mode": "Line", "path": "/etc/hostname" }] },
                "tool_response": { "success": true, "result": ["k57j05345.sqa.eu95"] }
            }),
        );
        let payload =
            json!({ "hook_event_name": "stop", "cwd": SESSION_CWD, "assistant_response": "done" });
        let _ = stop_and_collect(&harness, &payload);
        let records = read_records(&harness.root);
        let fs_read = records.iter().find(|record| {
            record["event.name"] == "tool.result" && record["gen_ai.tool.name"] == "fs_read"
        });
        assert_eq!(
            fs_read.unwrap()["gen_ai.tool.call.result"],
            "k57j05345.sqa.eu95"
        );
        assert_eq!(fs_read.unwrap()["kiro.time_source"], "processor_receive");
        let first = records.len();
        let _ = stop_and_collect(&harness, &payload);
        assert_eq!(read_records(&harness.root).len(), first);
    }

    #[test]
    fn session_cwd_mismatch_writes_nothing() {
        let harness = Harness::new();
        install_session(
            &harness.home,
            SESSION_SIDECAR,
            SESSION_JSONL,
            &iso_now_utc(),
        );
        let (code, stdout) = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": "/some/other/dir", "assistant_response": "done" }),
        );
        assert_eq!(code, 0);
        assert!(stdout.contains("\"status\":\"no_data\""), "{stdout}");
        assert!(read_records(&harness.root).is_empty());
    }

    #[test]
    fn bash_exit_status_marks_tool_error_and_stringifies_objects() {
        let harness = Harness::new();
        install_session(
            &harness.home,
            SESSION_SIDECAR,
            SESSION_JSONL,
            &iso_now_utc(),
        );
        let failed: Value = serde_json::from_str(BASH_FAILED).unwrap();
        let _ = run_at(
            &harness,
            &["postToolUse"],
            &json!({
                "hook_event_name": "postToolUse",
                "cwd": SESSION_CWD,
                "tool_name": "execute_bash",
                "tool_input": { "command": "which bash" },
                "tool_response": failed["tool_response"]
            }),
        );
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": SESSION_CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let bash = records.iter().find(|record| {
            record["event.name"] == "tool.result" && record["gen_ai.tool.name"] == "execute_bash"
        });
        let bash = bash.unwrap();
        assert_eq!(bash["tool.result.status"], "error");
        assert_eq!(bash["error.type"], "ToolError");
        let message = bash["error.message"].as_str().unwrap();
        assert!(message.contains("exit_status 1"));
        assert!(message.contains("No such file or directory"));
        assert_ne!(message, "tool execution reported failure");

        let harness = Harness::new();
        install_session(
            &harness.home,
            SESSION_SIDECAR,
            SESSION_JSONL,
            &iso_now_utc(),
        );
        let _ = run_at(
            &harness,
            &["postToolUse"],
            &json!({
                "hook_event_name": "postToolUse",
                "cwd": SESSION_CWD,
                "tool_name": "execute_bash",
                "tool_input": { "command": "which bash" },
                "tool_response": {
                    "success": true,
                    "result": [{ "exit_status": "0", "stdout": "/usr/bin/bash\n", "stderr": "" }]
                }
            }),
        );
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": SESSION_CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let bash = records
            .iter()
            .find(|record| {
                record["event.name"] == "tool.result"
                    && record["gen_ai.tool.name"] == "execute_bash"
            })
            .unwrap();
        assert_eq!(bash["tool.result.status"], "success");
        assert!(bash.get("error.type").is_none());
        assert!(bash.get("error.message").is_none());
        let rendered = bash["gen_ai.tool.call.result"].as_str().unwrap();
        assert_ne!(rendered, "[object Object]");
        assert!(rendered.contains("exit_status"));
        assert!(rendered.contains("/usr/bin/bash"));
    }

    #[test]
    fn mcp_tool_match_recomputes_llm_times() {
        let harness = Harness::new();
        install_session(&harness.home, MCP_SIDECAR, MCP_JSONL, &iso_now_utc());
        let pre_dir = harness.root.join("state/kiro-cli/pre-tool-buffers");
        let post_dir = harness.root.join("state/kiro-cli/buffers");
        fs::create_dir_all(&pre_dir).unwrap();
        fs::create_dir_all(&post_dir).unwrap();
        let key = safe_key(MCP_CWD);
        let tool_input = json!({ "path": "/tmp/kiro_mcp_probe/out.txt", "content": "hello world" });
        fs::write(
            pre_dir.join(format!("{key}.jsonl")),
            format!(
                "{}\n",
                serde_json::to_string(&json!({
                    "toolName": "@filesystem/write_file",
                    "toolInput": tool_input,
                    "startTs": "2026-07-07T09:49:45.000Z"
                }))
                .unwrap()
            ),
        )
        .unwrap();
        fs::write(
            post_dir.join(format!("{key}.jsonl")),
            format!(
                "{}\n",
                serde_json::to_string(&json!({
                    "toolName": "@filesystem/write_file",
                    "toolInput": tool_input,
                    "toolResponse": {
                        "success": true,
                        "result": [{ "content": [{ "type": "text", "text": "Successfully wrote to /tmp/kiro_mcp_probe/out.txt" }] }]
                    },
                    "captureTs": "2026-07-07T09:49:48.000Z"
                }))
                .unwrap()
            ),
        )
        .unwrap();
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": MCP_CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let call = named(&records, "tool.call")[0];
        let result = named(&records, "tool.result")[0];
        assert_eq!(call["gen_ai.tool.name"], "write_file");
        assert_eq!(call["kiro.time_source"], "processor_receive");
        assert_eq!(result["kiro.time_source"], "processor_receive");
        let nano = |iso: &str| format!("{}000000", parse_iso_ms(iso).unwrap());
        assert_eq!(call["time_unix_nano"], nano("2026-07-07T09:49:45.000Z"));
        assert_eq!(result["time_unix_nano"], nano("2026-07-07T09:49:48.000Z"));
        let find = |name: &str, prefix: &str| {
            records.iter().find(|record| {
                record["event.name"] == name
                    && record["gen_ai.step.id"]
                        .as_str()
                        .is_some_and(|id| id.starts_with(prefix))
            })
        };
        assert_eq!(
            find("llm.request", "bbbbbbbb").unwrap()["time_unix_nano"],
            nano("2026-07-07T09:49:30.000Z")
        );
        assert_eq!(
            find("llm.response", "bbbbbbbb").unwrap()["time_unix_nano"],
            nano("2026-07-07T09:49:45.000Z")
        );
        assert_eq!(
            find("llm.request", "dddddddd").unwrap()["time_unix_nano"],
            nano("2026-07-07T09:49:48.000Z")
        );
        assert_eq!(
            find("llm.response", "dddddddd").unwrap()["time_unix_nano"],
            nano("2026-07-07T09:50:00.000Z")
        );
        let duration = |prefix: &str| {
            nano_key_value(find("llm.response", prefix).unwrap())
                - nano_key_value(find("llm.request", prefix).unwrap())
        };
        assert_eq!(duration("bbbbbbbb"), 15_000 * 1_000_000);
        assert_eq!(duration("dddddddd"), 12_000 * 1_000_000);
    }

    #[test]
    fn session_without_pre_tool_keeps_distinct_request_times() {
        let harness = Harness::new();
        install_session(&harness.home, MCP_SIDECAR, MCP_JSONL, &iso_now_utc());
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": MCP_CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        let requests = named(&records, "llm.request");
        assert!(requests.len() >= 2);
        let times: HashSet<_> = requests
            .iter()
            .map(|record| record["time_unix_nano"].as_str().unwrap())
            .collect();
        assert_eq!(times.len(), requests.len());
        for call in named(&records, "tool.call") {
            assert_eq!(call["kiro.time_source"], "transcript_estimate");
        }
    }

    #[test]
    fn cold_start_keeps_only_the_last_prompt_and_skips_stale_sessions() {
        let harness = Harness::new();
        install_session(&harness.home, TWO_SIDECAR, TWO_JSONL, &iso_now_utc());
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": TWO_PROMPT_CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        assert!(records.iter().all(|record| {
            record
                .get("gen_ai.step.id")
                .and_then(Value::as_str)
                .is_none_or(|id| !id.starts_with("a1"))
        }));
        assert!(records.iter().any(|record| {
            record
                .get("gen_ai.step.id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("a2"))
        }));

        let stale = Harness::new();
        let old = chrono::Utc::now() - chrono::Duration::minutes(10);
        install_session(
            &stale.home,
            TWO_SIDECAR,
            TWO_JSONL,
            &old.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
        let (_, stdout) = stop_and_collect(
            &stale,
            &json!({ "hook_event_name": "stop", "cwd": TWO_PROMPT_CWD, "assistant_response": "done" }),
        );
        assert!(stdout.contains("\"status\":\"no_data\""), "{stdout}");
        assert!(read_records(&stale.root).is_empty());
    }

    #[test]
    fn multiple_prompts_split_runs_when_session_offset_exists() {
        let harness = Harness::new();
        install_session(&harness.home, TWO_SIDECAR, TWO_JSONL, &iso_now_utc());
        let dir = harness.root.join("state/kiro-cli/session-offsets");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{}.json", safe_key(TWO_PROMPT_CWD))),
            r#"{"updatedMs":1}"#,
        )
        .unwrap();
        let _ = stop_and_collect(
            &harness,
            &json!({ "hook_event_name": "stop", "cwd": TWO_PROMPT_CWD, "assistant_response": "done" }),
        );
        let records = read_records(&harness.root);
        assert!(records.iter().any(|record| record["gen_ai.step.id"]
            .as_str()
            .is_some_and(|id| id.starts_with("a1"))));
        assert!(records.iter().any(|record| record["gen_ai.step.id"]
            .as_str()
            .is_some_and(|id| id.starts_with("a2"))));
        let turns: HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("gen_ai.turn.id").and_then(Value::as_str))
            .collect();
        assert!(turns.len() >= 2);
    }

    #[test]
    fn parse_round3_conversation_and_sqlite_cursor() {
        let parsed = parse_conversation_value(&conv_fixture());
        assert_eq!(parsed.conversation_id, CONV_ID);
        assert_eq!(
            parsed.continuation_id,
            "c9eb7963-b0ab-4561-b75b-8f30ffbe8ff4"
        );
        assert_eq!(parsed.model_id, "auto");
        assert_eq!(parsed.steps.len(), 3);
        assert_eq!(parsed.credits.len(), 3);
        for step in &parsed.steps {
            assert!(!step.step_id.is_empty());
            assert!(!step.response_id.is_empty());
        }
        for entry in conv_fixture()["history"].as_array().unwrap() {
            for field in ["total_tokens", "output_tokens", "uncached_input_tokens"] {
                assert_eq!(entry["request_metadata"].get(field), Some(&Value::Null));
            }
        }
        assert_eq!(
            parsed
                .steps
                .iter()
                .map(|step| step.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["ToolUse", "ToolUse", "NotToolUse"]
        );
        assert!(parsed
            .steps
            .iter()
            .all(|step| step.step_id != step.response_id));
        assert_eq!(
            parsed.steps[2].step_id,
            "153ca0d0-eedd-4573-ad43-e4b16d742d51"
        );
        assert_eq!(
            parsed.steps[2].response_id,
            "5ca50dc2-6cbb-40f1-b934-52e803af2111"
        );
        assert!(parsed.steps[0].end_time_ms < parsed.steps[1].start_time_ms);
        assert!(parsed.steps[1].end_time_ms < parsed.steps[2].start_time_ms);
        assert_eq!(parsed.steps[0].tools[0].name, "fs_read");
        assert_eq!(
            parsed.steps[0].tools[0].id,
            "tooluse_9ZXIR6XBjCnWiGGEZrHWGQ"
        );
        assert_eq!(parsed.steps[1].tools[0].name, "fs_write");
        assert_eq!(
            parsed.steps[1].tools[0].id,
            "tooluse_MigrAULbTpGOiFQo4BFZ3d"
        );
        assert!(parsed.steps[2].tools.is_empty());
        assert!(parsed.steps[2].assistant_text.contains("hello kiro round3"));
        assert!(parsed.steps[2].assistant_text.contains("round3-finished"));
        assert!(parsed.steps[0].user_prompt.contains("sample.txt"));
        assert!(parsed.steps[1].user_prompt.is_empty());
        assert!(parsed.steps[2].user_prompt.is_empty());
        assert!(parsed.credits.iter().all(|credit| *credit > 0.0));

        let mut lower = conv_fixture();
        lower["history"][0]["user"]["content"] =
            json!({ "prompt": { "prompt": "小写键兜底文本" } });
        assert_eq!(
            parse_conversation_value(&lower).steps[0].user_prompt,
            "小写键兜底文本"
        );
        lower["history"][0]["user"]["content"] = json!("纯字符串 prompt");
        assert_eq!(
            parse_conversation_value(&lower).steps[0].user_prompt,
            "纯字符串 prompt"
        );

        lower["history"][0].as_object_mut().unwrap().remove("user");
        assert!(parse_conversation_value(&lower).steps[0]
            .user_prompt
            .is_empty());

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("data.sqlite3");
        let updated = now_ms() as i64;
        insert_conversation(&db, CWD, CONV_ID, &conv_fixture(), updated);
        let hit = read_transcript_for_cwd(&db, CWD, 0.0).unwrap().unwrap();
        assert_eq!(hit.conversation_id, CONV_ID);
        assert_eq!(hit.steps.len(), 3);
        assert!(hit.updated_ms > 0.0);
        assert_eq!(hit.updated_ms as i64, updated);
        assert!(read_transcript_for_cwd(&db, "/no/such/cwd", 0.0)
            .unwrap()
            .is_none());
        assert!(read_transcript_for_cwd(&db, "", 0.0).unwrap().is_none());
        assert!(read_transcript_for_cwd(&db, CWD, hit.updated_ms)
            .unwrap()
            .is_none());
    }

    #[test]
    fn tool_result_text_json_and_cancelled_uses_are_kept() {
        let text = json!({
            "conversation_id": "c-text",
            "history": [
                { "user": { "content": { "Prompt": { "prompt": "p" } } },
                  "assistant": { "ToolUse": { "tool_uses": [{ "id": "t0", "name": "read", "args": {} }] } },
                  "request_metadata": { "request_id": "r0", "message_id": "m0", "request_start_timestamp_ms": 1, "stream_end_timestamp_ms": 2 } },
                { "user": { "content": { "ToolUseResults": { "tool_use_results": [{ "tool_use_id": "t0", "content": [{ "Text": "hello text result" }] }] } } },
                  "assistant": { "Response": { "content": "done" } },
                  "request_metadata": { "request_id": "r1", "message_id": "m1", "request_start_timestamp_ms": 3, "stream_end_timestamp_ms": 4 } }
            ]
        });
        assert_eq!(
            parse_conversation_value(&text).steps[1].tool_use_results,
            vec!["hello text result".to_string()]
        );
        let json_case = json!({
            "conversation_id": "c-json",
            "history": [
                { "user": { "content": { "Prompt": { "prompt": "p" } } },
                  "assistant": { "ToolUse": { "tool_uses": [{ "id": "t0", "name": "list_directory", "args": {} }] } },
                  "request_metadata": { "request_id": "r0", "message_id": "m0", "request_start_timestamp_ms": 1, "stream_end_timestamp_ms": 2 } },
                { "user": { "content": { "ToolUseResults": { "tool_use_results": [{ "content": [{ "Json": { "content": [{ "type": "text", "text": "Allowed directories:\n/Users/yunshen/Documents" }], "structuredContent": { "content": "Allowed directories" } } }] }] } } },
                  "assistant": { "Response": { "content": "done" } },
                  "request_metadata": { "request_id": "r1", "message_id": "m1", "request_start_timestamp_ms": 3, "stream_end_timestamp_ms": 4 } }
            ]
        });
        assert_eq!(
            parse_conversation_value(&json_case).steps[1].tool_use_results,
            vec!["Allowed directories:\n/Users/yunshen/Documents".to_string()]
        );
        let cancelled = json!({
            "conversation_id": "c-cancel",
            "history": [
                { "user": { "content": { "Prompt": { "prompt": "p" } } },
                  "assistant": { "ToolUse": { "tool_uses": [{ "id": "t0", "name": "shell", "args": {} }] } },
                  "request_metadata": { "request_id": "r0", "message_id": "m0", "request_start_timestamp_ms": 1, "stream_end_timestamp_ms": 2 } },
                { "user": { "content": { "CancelledToolUses": { "tool_use_results": [{ "content": [{ "Text": "Tool use was cancelled by the user" }] }] } } },
                  "assistant": { "Response": { "content": "ok" } },
                  "request_metadata": { "request_id": "r1", "message_id": "m1", "request_start_timestamp_ms": 3, "stream_end_timestamp_ms": 4 } }
            ]
        });
        assert_eq!(
            parse_conversation_value(&cancelled).steps[1].tool_use_results,
            vec!["Tool use was cancelled by the user".to_string()]
        );
    }

    #[test]
    fn parse_session_lines_maps_tools_timing_and_results() {
        let sidecar: Value = serde_json::from_str(SESSION_SIDECAR).unwrap();
        let lines = SESSION_JSONL
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
            .collect::<Vec<_>>();
        let parsed = parse_session_lines(&lines, &sidecar);
        assert_eq!(parsed.steps.len(), 2);
        assert_eq!(parsed.steps[0].kind, "ToolUse");
        assert_eq!(parsed.steps[1].kind, "NotToolUse");
        assert_eq!(
            parsed.conversation_id,
            "838a0f1b-1cfd-4421-972a-8807a1b20eb5"
        );
        assert_eq!(parsed.model_id, "auto");
        assert_eq!(parsed.steps[0].tools.len(), 2);
        assert_eq!(parsed.steps[0].tools[0].name, "fs_read");
        assert_eq!(
            parsed.steps[0].tools[0].id,
            "tooluse_qGfoBnoJaaIOUSzVkyVTwf"
        );
        assert_eq!(parsed.steps[0].tools[1].name, "execute_bash");
        assert_eq!(
            parsed.steps[0].tools[1].id,
            "tooluse_NzHEPwReSjpoFDaMHj7hPW"
        );
        assert!(parsed.steps[1].assistant_text.contains("/usr/bin/bash"));
        assert!(parsed.steps[1]
            .assistant_text
            .contains("k57j05345.sqa.eu95"));
        assert!(parsed.steps[0].user_prompt.contains("hostname"));
        assert!(parsed.steps[1].user_prompt.is_empty());
        assert_eq!(parsed.steps[1].tool_use_results.len(), 2);
        assert!(parsed.steps[1].tool_use_results[0].contains("k57j05345.sqa.eu95"));
        assert!(parsed.steps[1].tool_use_results[1].contains("/usr/bin/bash"));
        assert!(parsed.steps[0].tool_use_results.is_empty());
        assert!(parsed.steps[0].start_time_ms > 0.0);
        assert!(parsed.steps[0].start_time_ms < parsed.steps[0].end_time_ms);
        assert!(parsed.steps[1].start_time_ms >= parsed.steps[0].end_time_ms);
        assert!(parsed.steps[1].end_time_ms > parsed.steps[1].start_time_ms);
        assert_eq!(parsed.credits.len(), 2);
        assert!((parsed.credits[0] - 0.0426).abs() < 1e-3);
        assert!((parsed.credits[1] - 0.0223).abs() < 1e-3);
        assert_eq!(
            parsed.steps[0].step_id,
            "2b7e8bd9-3f63-4f6d-891c-44e5e3d42123"
        );
        assert_eq!(
            parsed.steps[1].step_id,
            "cdd9d82f-d112-4a28-b92a-58abc327b282"
        );
        assert_eq!(
            parsed.steps[0].tools[0].args["operations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(parse_session_lines(&[], &sidecar).steps.is_empty());
        let no_sidecar = parse_session_lines(&lines, &json!({}));
        assert_eq!(no_sidecar.steps.len(), 2);
        assert_eq!(no_sidecar.conversation_id, "");
        assert_eq!(no_sidecar.model_id, "auto");
        let prompts: Vec<Value> = lines
            .iter()
            .filter(|line| line["kind"] == "Prompt")
            .cloned()
            .collect();
        assert!(parse_session_lines(&prompts, &sidecar).steps.is_empty());
    }

    #[test]
    fn read_session_ignores_since_and_misses() {
        let harness = Harness::new();
        install_session(
            &harness.home,
            SESSION_SIDECAR,
            SESSION_JSONL,
            SESSION_SIDECAR_UPDATED,
        );
        let mut env = Env::new();
        env.insert("HOME".into(), harness.home.to_string_lossy().into_owned());
        let updated = parse_iso_ms("2026-06-22T11:15:53.386817252Z").unwrap() as f64;
        let hit = read_session_jsonl(&env, SESSION_CWD, 0.0).unwrap();
        for since in [0.0, updated, updated + 1.0] {
            let again = read_session_jsonl(&env, SESSION_CWD, since).unwrap();
            assert_eq!(again.steps.len(), 2);
            assert_eq!(again.session_id, hit.session_id);
        }
        assert_eq!(hit.steps.len(), 2);
        assert_eq!(hit.source, "session_jsonl");
        assert_eq!(hit.session_id, "838a0f1b-1cfd-4421-972a-8807a1b20eb5");
        assert!(read_session_jsonl(&env, "/some/other/dir", 0.0).is_none());
        assert!(read_session_jsonl(&env, "", 0.0).is_none());
        let missing = Harness::new();
        let mut missing_env = Env::new();
        missing_env.insert("HOME".into(), missing.home.to_string_lossy().into_owned());
        assert!(read_session_jsonl(&missing_env, SESSION_CWD, 0.0).is_none());
        fs::remove_file(
            harness
                .home
                .join(".kiro/sessions/cli/838a0f1b-1cfd-4421-972a-8807a1b20eb5.jsonl"),
        )
        .unwrap();
        assert!(read_session_jsonl(&env, SESSION_CWD, 0.0).is_none());
    }

    const SESSION_SIDECAR_UPDATED: &str = "2026-06-22T11:15:53.386817252Z";

    #[test]
    fn db_path_priority_follows_env_and_platform() {
        let mut env = Env::new();
        env.insert("HOME".into(), "/home/tester".into());
        env.insert("KIRO_CLI_DB".into(), "/custom/path/kiro.db".into());
        env.insert("KIRO_CLI_DATA_DIR".into(), "/loses".into());
        assert_eq!(
            resolve_db_path_on(&env, "linux"),
            PathBuf::from("/custom/path/kiro.db")
        );
        env.remove("KIRO_CLI_DB");
        env.insert("KIRO_CLI_DATA_DIR".into(), "/data/here".into());
        let data_path = resolve_db_path_on(&env, "linux");
        assert_eq!(data_path, PathBuf::from("/data/here/data.sqlite3"));
        assert_eq!(data_path.parent(), Some(Path::new("/data/here")));
        env.remove("KIRO_CLI_DATA_DIR");
        assert_eq!(
            resolve_db_path_on(&env, "linux"),
            PathBuf::from("/home/tester/.local/share/kiro-cli/data.sqlite3")
        );
        env.insert("XDG_DATA_HOME".into(), "/xdg/data".into());
        assert_eq!(
            resolve_db_path_on(&env, "linux"),
            PathBuf::from("/xdg/data/kiro-cli/data.sqlite3")
        );
        env.remove("XDG_DATA_HOME");
        assert_eq!(
            resolve_db_path_on(&env, "darwin"),
            PathBuf::from("/home/tester/Library/Application Support/kiro-cli/data.sqlite3")
        );
        env.insert("APPDATA".into(), "C:/Users/me/AppData/Roaming".into());
        assert_eq!(
            resolve_db_path_on(&env, "win32"),
            PathBuf::from("C:/Users/me/AppData/Roaming/kiro-cli/data.sqlite3")
        );
        env.insert("KIRO_CLI_DB".into(), "~/kiro.db".into());
        assert_eq!(
            resolve_db_path_on(&env, "linux"),
            PathBuf::from("/home/tester/kiro.db")
        );
        assert_eq!(
            safe_key("/tmp/kiro_probe/work_r3"),
            "L3RtcC9raXJvX3Byb2JlL3dvcmtfcjM"
        );
    }

    #[test]
    fn hash_chain_matches_javascript_stable_serialize() {
        assert!(sha256_hex(b"").starts_with(INITIAL_HASH));
        let message = json!({
            "role": "user",
            "parts": [{ "type": "text", "content": "sample.txt" }]
        });
        assert_eq!(
            stable_serialize(&message),
            r#"{"parts":[{"content":"sample.txt","type":"text"}],"role":"user"}"#
        );
        assert_eq!(
            hash_step(INITIAL_HASH, &message),
            "c1e946529e047e65c9f96fc0e06ec18b"
        );
        assert_eq!(
            parse_iso_ms("2026-06-22T11:15:53.386817252Z"),
            Some(1_782_126_953_386)
        );
        assert_eq!(normalize_tool_name("@filesystem/write_file"), "write_file");
        assert_eq!(normalize_tool_name("@foo"), "@foo");
        assert_eq!(normalize_tool_name(""), "unknown");
    }

    #[test]
    fn delayed_collect_without_argv_stays_empty() {
        let harness = Harness::new();
        let (code, stdout) = run_at(&harness, &["delayedCollect"], &json!({}));
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(!stdout.contains("timing_pending"));
    }
    #[test]
    fn session_json_mcp_result_is_clean_text_in_the_following_step() {
        let mut sidecar: Value = serde_json::from_str(SESSION_SIDECAR).unwrap();
        let mut lines = parse_jsonl(SESSION_JSONL);
        lines.extend([
            json!({"kind":"Prompt","data":{"message_id":"p-json","content":[{"kind":"text","data":"list dir"}],"meta":{"timestamp":1782126960}}}),
            json!({"kind":"AssistantMessage","data":{"message_id":"am-json","content":[{"kind":"toolUse","data":{"toolUseId":"tu-json","name":"list_directory","input":{"path":"/tmp"}}}]}}),
            json!({"kind":"ToolResults","data":{"message_id":"tr-json","content":[{"kind":"toolResult","data":{"toolUseId":"tu-json","content":[{"kind":"json","data":{"content":[{"type":"text","text":"Allowed directories:\n/Users/tmp"}],"structuredContent":{"content":"Allowed directories"}}}],"status":"success"}}]}}),
            json!({"kind":"AssistantMessage","data":{"message_id":"am-json2","content":[{"kind":"text","data":"done"}]}}),
        ]);
        sidecar["session_state"]["conversation_metadata"]["user_turn_metadatas"]
            .as_array_mut().unwrap().push(json!({
                "loop_id":{"agent_id":{"name":"kiro_default"},"rand":3},
                "result":{"Ok":{"id":"am-json2","role":"assistant","content":[{"kind":"text","data":"done"}]}},
                "message_ids":["p-json","am-json","tr-json","am-json2"],
                "total_request_count":1,"turn_duration":{"secs":5,"nanos":0},
                "end_timestamp":"2026-06-22T11:16:00.000000Z",
                "metering_usage":[{"value":0.01,"unit":"credit","unitPlural":"credits"}],
                "user_prompt_length":8
            }));
        let parsed = parse_session_lines(&lines, &sidecar);
        let step = parsed
            .steps
            .iter()
            .find(|s| s.tool_use_results.iter().any(|s| s.contains("Allowed")))
            .expect("MCP result must reach the following native step");
        assert!(step.tool_use_results[0].contains("Allowed directories:\n/Users/tmp"));
        assert!(!step.tool_use_results[0].contains("\"content\""));
    }
}
