//! Rollout JSONL → transcript turns. Port of `codex-transcript-extractor.ts`.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::multimodal::types::{BlobToUriParams, UriResult};
use crate::multimodal::MAX_MULTIMODAL_PARTS;
use crate::types::{multimodal_upload_includes_input, MultimodalUploadMode};

use super::types::{
    CodexExtractedTranscriptTurn, CodexPartialTurnExtraction, CodexTerminalStatus,
    CodexThreadSource, CodexTranscriptMeta, CodexTranscriptSourceRange,
    CodexTranscriptSourceRecord, CodexTranscriptStep, CodexTranscriptTool, CodexTranscriptUsage,
};
use super::utils::{as_record, json_number, number_value, string_value, timestamp_ms};

static SESSION_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([0-9a-f]{8}-[0-9a-f-]{27,})$").expect("session id"));
static DATA_URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^data:([^;]+);base64,(.+)$").expect("data url"));
static IMAGE_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<image\b[^>]*>\s*$").expect("image open"));
static IMAGE_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^</image>\s*$").expect("image close"));

type BlobUriResolver<'a> = dyn Fn(&BlobToUriParams) -> Option<UriResult> + 'a;

#[derive(Default)]
pub struct ExtractOptions<'a> {
    pub require_terminal: bool,
    pub started_at_ms: Option<f64>,
    pub next_step_started_at_ms: Option<f64>,
    pub last_cumulative_token_total: Option<f64>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub developer_instructions: Option<String>,
    pub blob_to_uri: Option<&'a BlobUriResolver<'a>>,
    pub upload_mode: Option<MultimodalUploadMode>,
}

pub fn extract_codex_transcript_meta(record: &Map<String, Value>) -> Option<CodexTranscriptMeta> {
    if record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = record.get("payload").and_then(as_record)?;
    let thread_id = string_value(payload.get("id")).unwrap_or("").to_owned();
    let source = payload.get("source").and_then(as_record);
    let subagent = source
        .and_then(|record| record.get("subagent"))
        .and_then(as_record);
    let thread_spawn = subagent
        .and_then(|record| record.get("thread_spawn"))
        .and_then(as_record);
    let parent_thread_id =
        string_value(thread_spawn.and_then(|record| record.get("parent_thread_id")))
            .map(str::to_owned);
    let forked_from_id = string_value(payload.get("forked_from_id")).map(str::to_owned);
    let agent_path =
        string_value(thread_spawn.and_then(|record| record.get("agent_path"))).map(str::to_owned);
    let agent_nickname = string_value(thread_spawn.and_then(|record| record.get("agent_nickname")))
        .map(str::to_owned);
    let agent_role =
        string_value(thread_spawn.and_then(|record| record.get("agent_role"))).map(str::to_owned);
    let raw_thread_source = string_value(payload.get("thread_source"));
    let thread_source = if raw_thread_source == Some("subagent") || parent_thread_id.is_some() {
        CodexThreadSource::Subagent
    } else if raw_thread_source == Some("user") {
        CodexThreadSource::User
    } else {
        CodexThreadSource::Unknown
    };
    let raw_depth = number_value(thread_spawn.and_then(|record| record.get("depth")));
    let depth = match raw_depth {
        Some(value) if value >= 0.0 => value.trunc() as i64,
        _ if thread_source == CodexThreadSource::Subagent => 1,
        _ => 0,
    };
    let created = timestamp_ms(payload, timestamp_ms(record, f64::NAN));
    let base_instructions = read_instruction_text(payload.get("base_instructions"));
    let tool_definitions = payload
        .get("dynamic_tools")
        .filter(|value| value.is_array())
        .and_then(to_json_value);
    Some(CodexTranscriptMeta {
        thread_id: thread_id.clone(),
        root_session_id: string_value(payload.get("session_id"))
            .unwrap_or(thread_id.as_str())
            .to_owned(),
        thread_source,
        parent_thread_id,
        forked_from_id,
        depth,
        created_at_ms: created.is_finite().then_some(created),
        agent_path,
        agent_nickname,
        agent_role,
        provider: string_value(payload.get("model_provider"))
            .unwrap_or("openai")
            .to_owned(),
        base_instructions,
        tool_definitions,
    })
}

pub fn extract_codex_terminal_turn(
    records: &[Map<String, Value>],
    meta: Option<&CodexTranscriptMeta>,
    fallback_session_id: &str,
    expected_turn_id: &str,
    opts: &ExtractOptions<'_>,
) -> Option<CodexExtractedTranscriptTurn> {
    let mut options = ExtractOptions {
        require_terminal: true,
        blob_to_uri: opts.blob_to_uri,
        upload_mode: opts.upload_mode,
        ..ExtractOptions::default()
    };
    options.blob_to_uri = opts.blob_to_uri;
    options.upload_mode = opts.upload_mode;
    extract_codex_turn(
        &to_source_records(records),
        meta,
        fallback_session_id,
        expected_turn_id,
        &options,
    )
    .map(|extraction| extraction.turn)
}

pub fn extract_codex_partial_turn(
    records: &[Map<String, Value>],
    meta: Option<&CodexTranscriptMeta>,
    fallback_session_id: &str,
    expected_turn_id: &str,
    opts: &ExtractOptions<'_>,
) -> Option<CodexExtractedTranscriptTurn> {
    let options = ExtractOptions {
        require_terminal: false,
        started_at_ms: opts.started_at_ms,
        next_step_started_at_ms: opts.next_step_started_at_ms,
        last_cumulative_token_total: opts.last_cumulative_token_total,
        model: opts.model.clone(),
        cwd: opts.cwd.clone(),
        developer_instructions: opts.developer_instructions.clone(),
        blob_to_uri: opts.blob_to_uri,
        upload_mode: opts.upload_mode,
    };
    let _ = options;
    extract_codex_turn(
        &to_source_records(records),
        meta,
        fallback_session_id,
        expected_turn_id,
        &opts_with_terminal(opts, false),
    )
    .map(|extraction| extraction.turn)
}

pub fn extract_codex_partial_turn_with_boundaries(
    records: &[CodexTranscriptSourceRecord],
    meta: Option<&CodexTranscriptMeta>,
    fallback_session_id: &str,
    expected_turn_id: &str,
    opts: &ExtractOptions<'_>,
) -> Option<CodexPartialTurnExtraction> {
    extract_codex_turn(records, meta, fallback_session_id, expected_turn_id, opts)
}

fn opts_with_terminal<'a>(
    opts: &'a ExtractOptions<'a>,
    require_terminal: bool,
) -> ExtractOptions<'a> {
    ExtractOptions {
        require_terminal,
        started_at_ms: opts.started_at_ms,
        next_step_started_at_ms: opts.next_step_started_at_ms,
        last_cumulative_token_total: opts.last_cumulative_token_total,
        model: opts.model.clone(),
        cwd: opts.cwd.clone(),
        developer_instructions: opts.developer_instructions.clone(),
        blob_to_uri: opts.blob_to_uri,
        upload_mode: opts.upload_mode,
    }
}

struct StepEnvelope {
    step: CodexTranscriptStep,
    source_range: CodexTranscriptSourceRange,
    llm_closed: bool,
    followed_by_another_wave: bool,
    last_cumulative_token_total: Option<f64>,
    flushed: bool,
}

pub fn session_id_from_transcript_path(file_path: &str) -> String {
    let base = std::path::Path::new(file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file_path);
    let base = base.strip_suffix(".jsonl").unwrap_or(base);
    SESSION_ID_RE
        .captures(base)
        .and_then(|caps| caps.get(1))
        .map(|item| item.as_str().to_owned())
        .unwrap_or_else(|| base.to_owned())
}

fn extract_codex_turn(
    records: &[CodexTranscriptSourceRecord],
    meta: Option<&CodexTranscriptMeta>,
    fallback_session_id: &str,
    expected_turn_id: &str,
    opts: &ExtractOptions<'_>,
) -> Option<CodexPartialTurnExtraction> {
    let mut current_turn_id = if opts.require_terminal {
        String::new()
    } else {
        expected_turn_id.to_owned()
    };
    let mut started_at_ms = opts.started_at_ms.unwrap_or(0.0);
    let mut terminal_at_ms = 0.0;
    let mut status: Option<CodexTerminalStatus> = None;
    let mut saw_terminal = false;
    let mut saw_submitted_user_message = false;
    let mut final_text: Option<String> = None;
    let mut model = opts.model.clone().unwrap_or_else(|| "unknown".to_owned());
    let mut cwd = opts.cwd.clone();
    let mut developer_instructions = opts.developer_instructions.clone();
    let blob_to_uri = opts.blob_to_uri;
    let upload_mode = opts.upload_mode.unwrap_or(if blob_to_uri.is_some() {
        MultimodalUploadMode::All
    } else {
        MultimodalUploadMode::None
    });
    let mut prompt: Option<String> = None;
    let mut prompt_parts: Vec<String> = Vec::new();
    let mut input_messages: Vec<Value> = Vec::new();
    let mut envelopes: Vec<StepEnvelope> = Vec::new();
    let mut unmatched: Vec<CodexTranscriptUsage> = Vec::new();
    let mut tool_steps: HashMap<String, usize> = HashMap::new();
    let mut web_search_starts: HashMap<String, f64> = HashMap::new();
    let mut web_search_ends: HashMap<String, f64> = HashMap::new();
    let mut current: Option<usize> = None;
    let mut last_usage: Option<CodexTranscriptUsage> = None;
    let mut last_activity_at_ms = opts.next_step_started_at_ms.unwrap_or(0.0);
    let mut last_cumulative = opts.last_cumulative_token_total;

    let mark_activity = |last_activity_at_ms: &mut f64, timestamp: f64| {
        if timestamp > 0.0 {
            *last_activity_at_ms = timestamp;
        }
    };
    let append_prompt =
        |prompt: &mut Option<String>, prompt_parts: &mut Vec<String>, value: Option<&str>| {
            let Some(value) = value.filter(|text| !text.is_empty()) else {
                return;
            };
            if prompt_parts.iter().any(|part| part == value) {
                return;
            }
            prompt_parts.push(value.to_owned());
            *prompt = Some(prompt_parts.join("\n"));
        };

    for source in records {
        let record = &source.record;
        let Some(payload) = record.get("payload").and_then(as_record) else {
            continue;
        };
        let timestamp = timestamp_ms(record, super::utils::now_ms());
        let record_type = record.get("type").and_then(Value::as_str);

        if record_type == Some("turn_context") {
            let turn_id = string_value(payload.get("turn_id"));
            if turn_id != Some(expected_turn_id) {
                continue;
            }
            current_turn_id = expected_turn_id.to_owned();
            if started_at_ms == 0.0 {
                started_at_ms = timestamp;
            }
            mark_activity(&mut last_activity_at_ms, timestamp);
            if let Some(value) = string_value(payload.get("model")) {
                model = value.to_owned();
            }
            if let Some(value) = string_value(payload.get("cwd")) {
                cwd = Some(value.to_owned());
            }
            if let Some(value) = string_value(payload.get("developer_instructions")) {
                developer_instructions = Some(value.to_owned());
            }
            continue;
        }

        if record_type == Some("event_msg")
            && payload.get("type").and_then(Value::as_str) == Some("task_started")
        {
            if string_value(payload.get("turn_id")) == Some(expected_turn_id) {
                current_turn_id = expected_turn_id.to_owned();
                if started_at_ms == 0.0 {
                    started_at_ms = timestamp;
                }
                mark_activity(&mut last_activity_at_ms, timestamp);
            }
            continue;
        }

        if current_turn_id != expected_turn_id {
            continue;
        }

        if record_type == Some("token_usage_record") {
            let turn_id = string_value(payload.get("turn_id"));
            let response_id = string_value(payload.get("response_id")).map(str::to_owned);
            if turn_id.is_none() || turn_id == Some(expected_turn_id) {
                if let (Some(response_id), Some(index)) = (response_id, current) {
                    if envelopes[index].step.has_response_evidence {
                        envelopes[index].step.response_id = Some(response_id);
                        touch_step(&mut envelopes[index], source);
                    }
                }
            }
            continue;
        }

        if record_type == Some("event_msg") {
            let payload_type = payload.get("type").and_then(Value::as_str);
            if payload_type == Some("user_message") {
                append_prompt(
                    &mut prompt,
                    &mut prompt_parts,
                    string_value(payload.get("message")),
                );
                saw_submitted_user_message = true;
                mark_activity(&mut last_activity_at_ms, timestamp);
                continue;
            }
            if payload_type == Some("agent_message") {
                if current.is_some_and(|index| step_tools_complete(&envelopes[index].step)) {
                    flush_current(&mut envelopes, &mut current, false, last_cumulative);
                }
                if let Some(message) = string_value(payload.get("message")) {
                    let index = begin_step(
                        &mut envelopes,
                        &mut current,
                        if last_activity_at_ms > 0.0 {
                            last_activity_at_ms
                        } else {
                            timestamp
                        },
                        source,
                    );
                    touch_step(&mut envelopes[index], source);
                    let step = &mut envelopes[index].step;
                    step.response_at_ms = timestamp;
                    step.has_response_evidence = true;
                    if step.reasoning.last().map(String::as_str) != Some(message) {
                        step.reasoning.push(message.to_owned());
                    }
                }
                mark_activity(&mut last_activity_at_ms, timestamp);
                continue;
            }
            if payload_type == Some("web_search_start") {
                if let Some(call_id) = string_value(payload.get("call_id")) {
                    web_search_starts.insert(call_id.to_owned(), timestamp);
                }
                if current.is_some_and(|index| step_tools_complete(&envelopes[index].step)) {
                    flush_current(&mut envelopes, &mut current, false, last_cumulative);
                }
                let index = begin_step(
                    &mut envelopes,
                    &mut current,
                    if last_activity_at_ms > 0.0 {
                        last_activity_at_ms
                    } else {
                        timestamp
                    },
                    source,
                );
                touch_step(&mut envelopes[index], source);
                envelopes[index].step.response_at_ms = timestamp;
                envelopes[index].step.has_response_evidence = true;
                mark_activity(&mut last_activity_at_ms, timestamp);
                continue;
            }
            if payload_type == Some("web_search_end") {
                if let Some(call_id) = string_value(payload.get("call_id")) {
                    web_search_ends.insert(call_id.to_owned(), timestamp);
                    if let Some(index) = tool_steps.get(call_id).copied() {
                        if let Some(tool) = envelopes[index]
                            .step
                            .tools
                            .iter_mut()
                            .find(|tool| tool.call_id == call_id)
                        {
                            tool.completed_at_ms = Some(timestamp);
                        }
                        envelopes[index].step.completed_at_ms =
                            envelopes[index].step.completed_at_ms.max(timestamp);
                        touch_step(&mut envelopes[index], source);
                    }
                }
                continue;
            }
            if payload_type == Some("token_count") {
                let Some(usage) = extract_last_token_usage(payload.get("info")) else {
                    continue;
                };
                let cumulative = extract_cumulative_token_total(payload.get("info"));
                let repeated = cumulative.is_some()
                    && last_cumulative.is_some()
                    && cumulative == last_cumulative;
                if current.is_some_and(|index| envelopes[index].step.has_response_evidence) {
                    let index = current.expect("current");
                    if repeated {
                        envelopes[index].step.completed_at_ms =
                            envelopes[index].step.completed_at_ms.max(timestamp);
                        touch_step(&mut envelopes[index], source);
                        last_usage = Some(usage);
                        mark_activity(&mut last_activity_at_ms, timestamp);
                        continue;
                    }
                    envelopes[index].step.token_usage = Some(usage.clone());
                    envelopes[index].step.completed_at_ms =
                        envelopes[index].step.completed_at_ms.max(timestamp);
                    envelopes[index].llm_closed = true;
                    touch_step(&mut envelopes[index], source);
                    last_usage = Some(usage);
                    if let Some(total) = cumulative {
                        last_cumulative = Some(total);
                    }
                    mark_activity(&mut last_activity_at_ms, timestamp);
                    flush_current(&mut envelopes, &mut current, false, last_cumulative);
                } else {
                    if !repeated && !same_usage(last_usage.as_ref(), &usage) {
                        unmatched.push(usage.clone());
                    }
                    last_usage = Some(usage);
                    if let Some(total) = cumulative {
                        last_cumulative = Some(total);
                    }
                    mark_activity(&mut last_activity_at_ms, timestamp);
                }
                continue;
            }
            if payload_type == Some("task_complete")
                && string_value(payload.get("turn_id")) == Some(expected_turn_id)
            {
                status = Some(CodexTerminalStatus::Completed);
                saw_terminal = true;
                terminal_at_ms = timestamp;
                final_text = string_value(payload.get("last_agent_message")).map(str::to_owned);
                break;
            }
            if payload_type == Some("turn_aborted")
                && string_value(payload.get("turn_id")) == Some(expected_turn_id)
            {
                status = Some(CodexTerminalStatus::Interrupted);
                saw_terminal = true;
                terminal_at_ms = timestamp;
                break;
            }
            continue;
        }

        if record_type != Some("response_item") {
            continue;
        }
        let item_type = string_value(payload.get("type"));
        if item_type == Some("agent_message")
            && meta.is_some_and(|meta| meta.thread_source == CodexThreadSource::Subagent)
        {
            let recipient = string_value(payload.get("recipient"));
            let communication = payload
                .get("internal_chat_message_metadata_passthrough")
                .and_then(as_record);
            let message_turn_id =
                string_value(communication.and_then(|record| record.get("turn_id")));
            let agent_path = meta.and_then(|meta| meta.agent_path.as_deref());
            if (agent_path.is_none() || recipient.is_none() || recipient == agent_path)
                && (message_turn_id.is_none() || message_turn_id == Some(expected_turn_id))
            {
                if let Some(message) = transcript_input_message(
                    "user",
                    payload.get("content"),
                    None,
                    timestamp,
                    Some(source.start_offset),
                ) {
                    input_messages.push(message);
                    append_prompt(
                        &mut prompt,
                        &mut prompt_parts,
                        extract_message_text(payload.get("content")).as_deref(),
                    );
                    saw_submitted_user_message = true;
                    mark_activity(&mut last_activity_at_ms, timestamp);
                }
            }
            continue;
        }
        if item_type == Some("message") {
            let role = string_value(payload.get("role"));
            if role == Some("assistant") {
                if current.is_some_and(|index| step_tools_complete(&envelopes[index].step)) {
                    flush_current(&mut envelopes, &mut current, false, last_cumulative);
                }
                let index = begin_step(
                    &mut envelopes,
                    &mut current,
                    if last_activity_at_ms > 0.0 {
                        last_activity_at_ms
                    } else {
                        timestamp
                    },
                    source,
                );
                touch_step(&mut envelopes[index], source);
                let step = &mut envelopes[index].step;
                if step.response_id.is_none() {
                    step.response_id = string_value(payload.get("id")).map(str::to_owned);
                }
                step.response_at_ms = timestamp;
                step.has_response_evidence = true;
                if let Some(message) = extract_message_text(payload.get("content")) {
                    if step.reasoning.last().map(String::as_str) != Some(message.as_str()) {
                        step.reasoning.push(message);
                    }
                }
            } else if let Some(role) = role {
                let image_blob = if multimodal_upload_includes_input(upload_mode) {
                    blob_to_uri
                } else {
                    None
                };
                if let Some(message) = transcript_input_message(
                    role,
                    payload.get("content"),
                    image_blob,
                    timestamp,
                    Some(source.start_offset),
                ) {
                    input_messages.push(message);
                    if role == "user" {
                        append_prompt(
                            &mut prompt,
                            &mut prompt_parts,
                            extract_message_text(payload.get("content")).as_deref(),
                        );
                    }
                }
                mark_activity(&mut last_activity_at_ms, timestamp);
            }
            continue;
        }
        if item_type == Some("reasoning") {
            if current.is_some_and(|index| step_tools_complete(&envelopes[index].step)) {
                flush_current(&mut envelopes, &mut current, false, last_cumulative);
            }
            let index = begin_step(
                &mut envelopes,
                &mut current,
                if last_activity_at_ms > 0.0 {
                    last_activity_at_ms
                } else {
                    timestamp
                },
                source,
            );
            touch_step(&mut envelopes[index], source);
            let step = &mut envelopes[index].step;
            if step.response_id.is_none() {
                step.response_id = string_value(payload.get("id")).map(str::to_owned);
            }
            step.response_at_ms = timestamp;
            step.has_response_evidence = true;
            mark_activity(&mut last_activity_at_ms, timestamp);
            continue;
        }

        if let Some(mut call) = transcript_tool_call(item_type, payload, timestamp) {
            if current.is_some_and(|index| step_tools_complete(&envelopes[index].step)) {
                flush_current(&mut envelopes, &mut current, false, last_cumulative);
            }
            if call.name == "web_search" {
                call.started_at_ms = web_search_starts.get(&call.call_id).copied().unwrap_or(
                    if last_activity_at_ms > 0.0 {
                        last_activity_at_ms
                    } else {
                        timestamp
                    },
                );
                call.completed_at_ms = Some(
                    web_search_ends
                        .get(&call.call_id)
                        .copied()
                        .unwrap_or(timestamp),
                );
            }
            let anchor = if last_activity_at_ms > 0.0 {
                last_activity_at_ms
            } else {
                call.started_at_ms
            };
            let index = begin_step(&mut envelopes, &mut current, anchor, source);
            touch_step(&mut envelopes[index], source);
            let step = &mut envelopes[index].step;
            if step.response_id.is_none() {
                step.response_id = string_value(payload.get("id")).map(str::to_owned);
            }
            if call.name != "web_search" {
                step.response_at_ms = if step.tools.is_empty() {
                    call.started_at_ms
                } else {
                    step.response_at_ms.min(call.started_at_ms)
                };
                step.has_response_evidence = true;
            } else if !step.has_response_evidence {
                step.response_at_ms = call.completed_at_ms.unwrap_or(call.started_at_ms);
                step.has_response_evidence = true;
            }
            let call_id = call.call_id.clone();
            step.tools.push(call);
            tool_steps.insert(call_id, index);
            let completed = envelopes[index]
                .step
                .tools
                .last()
                .and_then(|tool| tool.completed_at_ms);
            mark_activity(&mut last_activity_at_ms, completed.unwrap_or(timestamp));
            continue;
        }

        let image_blob = if multimodal_upload_includes_input(upload_mode) {
            blob_to_uri
        } else {
            None
        };
        let Some(tool_output) = transcript_tool_output(
            item_type,
            payload,
            image_blob,
            timestamp,
            Some(source.start_offset),
        ) else {
            continue;
        };
        let Some(index) = tool_steps.get(&tool_output.call_id).copied() else {
            continue;
        };
        let Some(tool) = envelopes[index]
            .step
            .tools
            .iter_mut()
            .find(|tool| tool.call_id == tool_output.call_id)
        else {
            continue;
        };
        tool.completed_at_ms = Some(timestamp);
        tool.output = tool_output.output;
        envelopes[index].step.completed_at_ms =
            envelopes[index].step.completed_at_ms.max(timestamp);
        touch_step(&mut envelopes[index], source);
        mark_activity(&mut last_activity_at_ms, timestamp);
    }

    if opts.require_terminal && (status.is_none() || terminal_at_ms == 0.0) {
        return None;
    }

    if current.is_some_and(|index| step_tools_complete(&envelopes[index].step)) {
        flush_current(&mut envelopes, &mut current, false, last_cumulative);
    }
    if status.is_none() && !opts.require_terminal {
        let flushed = envelopes.iter().any(|envelope| envelope.flushed);
        if !flushed && prompt.is_none() {
            return None;
        }
        terminal_at_ms = if last_activity_at_ms > 0.0 {
            last_activity_at_ms
        } else if started_at_ms > 0.0 {
            started_at_ms
        } else {
            super::utils::now_ms()
        };
        status = Some(CodexTerminalStatus::Completed);
    } else if status == Some(CodexTerminalStatus::Completed) {
        let mut terminal_index = current.or_else(|| {
            envelopes
                .iter()
                .enumerate()
                .rev()
                .find(|(_, envelope)| envelope.flushed)
                .map(|(index, _)| index)
        });
        if terminal_index.is_none() {
            let terminal_source = records
                .last()
                .cloned()
                .unwrap_or(CodexTranscriptSourceRecord {
                    start_offset: 0,
                    end_offset: 0,
                    record: Map::new(),
                });
            let anchor = if last_activity_at_ms > 0.0 {
                last_activity_at_ms
            } else if started_at_ms > 0.0 {
                started_at_ms
            } else {
                terminal_at_ms
            };
            terminal_index = Some(begin_step(
                &mut envelopes,
                &mut current,
                anchor,
                &terminal_source,
            ));
            if let Some(index) = terminal_index {
                envelopes[index].step.response_at_ms = terminal_at_ms;
            }
        }
        if let Some(index) = terminal_index {
            let step = &mut envelopes[index].step;
            if let Some(text) = final_text.clone() {
                if step.reasoning.last().map(String::as_str) == Some(text.as_str()) {
                    step.reasoning.pop();
                }
                step.final_text = Some(text);
            }
            step.completed_at_ms = terminal_at_ms;
            if current == Some(index) {
                flush_current(&mut envelopes, &mut current, true, last_cumulative);
            }
        }
    } else if let Some(index) = current {
        envelopes[index].step.completed_at_ms = terminal_at_ms;
        flush_current(&mut envelopes, &mut current, false, last_cumulative);
    }

    let resolved_status = status.unwrap_or(CodexTerminalStatus::Completed);
    let steps: Vec<CodexTranscriptStep> = envelopes
        .iter()
        .filter(|envelope| envelope.flushed)
        .map(|envelope| envelope.step.clone())
        .collect();
    let prompt_ready =
        prompt.is_some() && (saw_submitted_user_message || !steps.is_empty() || saw_terminal);
    let turn = CodexExtractedTranscriptTurn {
        session_id: meta
            .map(|meta| meta.thread_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| fallback_session_id.to_owned()),
        transcript_turn_id: expected_turn_id.to_owned(),
        provider: meta
            .map(|meta| meta.provider.clone())
            .unwrap_or_else(|| "openai".to_owned()),
        model,
        status: resolved_status,
        started_at_ms: if started_at_ms > 0.0 {
            started_at_ms
        } else {
            terminal_at_ms
        },
        terminal_at_ms,
        prompt,
        prompt_ready,
        input_messages,
        cwd,
        developer_instructions,
        base_instructions: meta.and_then(|meta| meta.base_instructions.clone()),
        tool_definitions: meta.and_then(|meta| meta.tool_definitions.clone()),
        steps,
        unmatched_token_usages: unmatched,
    };
    let committed: Vec<&StepEnvelope> = if saw_terminal {
        envelopes
            .iter()
            .filter(|envelope| envelope.flushed)
            .collect()
    } else {
        leading_committable(&envelopes)
    };
    let committed_tail = committed.last().copied();
    let next_step_started_at_ms = committed_tail.map(|envelope| envelope.step.completed_at_ms);
    let last_cumulative_token_total =
        committed_tail.and_then(|envelope| envelope.last_cumulative_token_total);
    let committed_step_ranges = committed
        .iter()
        .map(|envelope| envelope.source_range.clone())
        .collect();
    let committed_step_count = committed.len();
    let consumed_end_offset = committed_tail
        .map(|envelope| envelope.source_range.end_offset)
        .unwrap_or_else(|| {
            records
                .first()
                .map(|record| record.start_offset)
                .unwrap_or(0)
        });
    Some(CodexPartialTurnExtraction {
        turn,
        committed_step_count,
        committed_step_ranges,
        consumed_end_offset,
        next_step_started_at_ms,
        last_cumulative_token_total,
    })
}

fn leading_committable(envelopes: &[StepEnvelope]) -> Vec<&StepEnvelope> {
    let mut committed = Vec::new();
    for envelope in envelopes.iter().filter(|envelope| envelope.flushed) {
        if !envelope.llm_closed {
            break;
        }
        let tools_complete = !envelope.step.tools.is_empty()
            && envelope
                .step
                .tools
                .iter()
                .all(|tool| tool.completed_at_ms.is_some());
        if !tools_complete && !envelope.followed_by_another_wave {
            break;
        }
        committed.push(envelope);
    }
    committed
}

fn begin_step(
    envelopes: &mut Vec<StepEnvelope>,
    current: &mut Option<usize>,
    timestamp: f64,
    source: &CodexTranscriptSourceRecord,
) -> usize {
    if let Some(index) = *current {
        return index;
    }
    if let Some(previous) = envelopes.iter_mut().rev().find(|envelope| envelope.flushed) {
        if previous.llm_closed {
            previous.followed_by_another_wave = true;
        }
    }
    envelopes.push(StepEnvelope {
        step: CodexTranscriptStep {
            started_at_ms: timestamp,
            response_at_ms: timestamp,
            has_response_evidence: false,
            completed_at_ms: timestamp,
            response_id: None,
            input_messages: None,
            reasoning: Vec::new(),
            tools: Vec::new(),
            token_usage: None,
            final_text: None,
        },
        source_range: CodexTranscriptSourceRange {
            start_offset: source.start_offset,
            end_offset: source.end_offset,
        },
        llm_closed: false,
        followed_by_another_wave: false,
        last_cumulative_token_total: None,
        flushed: false,
    });
    let index = envelopes.len() - 1;
    *current = Some(index);
    index
}

fn touch_step(envelope: &mut StepEnvelope, source: &CodexTranscriptSourceRecord) {
    envelope.source_range.start_offset =
        envelope.source_range.start_offset.min(source.start_offset);
    envelope.source_range.end_offset = envelope.source_range.end_offset.max(source.end_offset);
}

fn step_tools_complete(step: &CodexTranscriptStep) -> bool {
    !step.tools.is_empty() && step.tools.iter().all(|tool| tool.completed_at_ms.is_some())
}

fn flush_current(
    envelopes: &mut [StepEnvelope],
    current: &mut Option<usize>,
    force: bool,
    last_cumulative: Option<f64>,
) {
    let Some(index) = current.take() else {
        return;
    };
    let envelope = &mut envelopes[index];
    let keep = force
        || !envelope.step.reasoning.is_empty()
        || !envelope.step.tools.is_empty()
        || envelope.step.final_text.is_some();
    if keep {
        envelope.last_cumulative_token_total = last_cumulative;
        envelope.flushed = true;
    }
}

fn to_source_records(records: &[Map<String, Value>]) -> Vec<CodexTranscriptSourceRecord> {
    records
        .iter()
        .enumerate()
        .map(|(index, record)| CodexTranscriptSourceRecord {
            start_offset: index as i64,
            end_offset: index as i64 + 1,
            record: record.clone(),
        })
        .collect()
}

fn transcript_tool_call(
    item_type: Option<&str>,
    payload: &Map<String, Value>,
    timestamp: f64,
) -> Option<CodexTranscriptTool> {
    if item_type == Some("web_search_call") {
        let call_id = string_value(payload.get("call_id"))
            .or_else(|| string_value(payload.get("id")))
            .map(str::to_owned)
            .unwrap_or_else(|| format!("web_search:{timestamp}"));
        return Some(CodexTranscriptTool {
            call_id,
            name: "web_search".to_owned(),
            input: to_json_value(&parse_maybe_json(payload.get("action"))),
            started_at_ms: timestamp,
            output: to_json_value(&web_search_output(payload)),
            completed_at_ms: Some(timestamp),
        });
    }
    if item_type != Some("function_call")
        && item_type != Some("custom_tool_call")
        && item_type != Some("tool_search_call")
    {
        return None;
    }
    let call_id = string_value(payload.get("call_id"))
        .or_else(|| string_value(payload.get("id")))?
        .to_owned();
    let name = string_value(payload.get("name"))
        .unwrap_or(if item_type == Some("tool_search_call") {
            "tool_search"
        } else {
            "unknown"
        })
        .to_owned();
    let raw_input = if item_type == Some("custom_tool_call") {
        payload.get("input")
    } else {
        payload.get("arguments")
    };
    Some(CodexTranscriptTool {
        call_id,
        name: name.clone(),
        input: normalize_tool_input(&name, &parse_maybe_json(raw_input)),
        started_at_ms: timestamp,
        output: None,
        completed_at_ms: None,
    })
}

struct ToolOutput {
    call_id: String,
    output: Option<Value>,
}

fn transcript_tool_output(
    item_type: Option<&str>,
    payload: &Map<String, Value>,
    blob_to_uri: Option<&BlobUriResolver<'_>>,
    timestamp_ms: f64,
    record_offset: Option<i64>,
) -> Option<ToolOutput> {
    if item_type != Some("function_call_output")
        && item_type != Some("custom_tool_call_output")
        && item_type != Some("tool_search_output")
    {
        return None;
    }
    let call_id = string_value(payload.get("call_id"))
        .or_else(|| string_value(payload.get("id")))?
        .to_owned();
    if item_type == Some("tool_search_output") {
        let mut output = Map::new();
        if let Some(status) = payload.get("status") {
            if let Some(json) = to_json_value(status) {
                output.insert("status".into(), json);
            }
        }
        if let Some(execution) = payload.get("execution") {
            if let Some(json) = to_json_value(execution) {
                output.insert("execution".into(), json);
            }
        }
        if payload.get("tools").is_some() {
            if let Some(json) = to_json_value(&parse_maybe_json(payload.get("tools"))) {
                output.insert("tools".into(), json);
            }
        }
        return Some(ToolOutput {
            call_id,
            output: Some(Value::Object(output)),
        });
    }
    if payload.get("output").is_some_and(Value::is_array) {
        let parts = extract_message_parts(
            payload.get("output"),
            blob_to_uri,
            timestamp_ms,
            record_offset,
        );
        return Some(ToolOutput {
            call_id,
            output: Some(Value::Array(
                parts.into_iter().filter_map(part_to_json).collect(),
            )),
        });
    }
    Some(ToolOutput {
        call_id,
        output: to_json_value(&parse_maybe_json(payload.get("output"))),
    })
}

fn web_search_output(payload: &Map<String, Value>) -> Value {
    let mut output = Map::new();
    if let Some(status) = payload.get("status") {
        output.insert("status".into(), status.clone());
    }
    if payload.contains_key("action") {
        output.insert("action".into(), parse_maybe_json(payload.get("action")));
    }
    Value::Object(output)
}

fn normalize_tool_input(name: &str, value: &Value) -> Option<Value> {
    let input = to_json_value(value);
    let record = as_record(value);
    if name == "Bash" || name == "exec_command" {
        let command = string_value(record.and_then(|item| item.get("command")))
            .or_else(|| string_value(record.and_then(|item| item.get("cmd"))));
        let Some(command) = command else {
            return input;
        };
        let mut normalized = Map::new();
        normalized.insert("command".into(), Value::String(command.to_owned()));
        if let Some(workdir) = string_value(record.and_then(|item| item.get("workdir"))) {
            normalized.insert("workdir".into(), Value::String(workdir.to_owned()));
        }
        return Some(Value::Object(normalized));
    }
    if name == "apply_patch" {
        if let Some(text) = value.as_str() {
            return Some(serde_json::json!({ "command": text }));
        }
    }
    input
}

enum MessagePart {
    Text(String),
    Uri { mime_type: String, uri: String },
}

fn part_to_json(part: MessagePart) -> Option<Value> {
    match part {
        MessagePart::Text(content) => {
            Some(serde_json::json!({ "type": "text", "content": content }))
        }
        MessagePart::Uri { mime_type, uri } => Some(serde_json::json!({
            "type": "uri",
            "mime_type": mime_type,
            "modality": "image",
            "uri": uri,
        })),
    }
}

fn transcript_input_message(
    role: &str,
    content: Option<&Value>,
    blob_to_uri: Option<&BlobUriResolver<'_>>,
    timestamp_ms: f64,
    record_offset: Option<i64>,
) -> Option<Value> {
    let parts = extract_message_parts(content, blob_to_uri, timestamp_ms, record_offset);
    if parts.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "role": role,
        "parts": parts.into_iter().filter_map(part_to_json).collect::<Vec<_>>(),
    }))
}

fn extract_message_parts(
    content: Option<&Value>,
    blob_to_uri: Option<&BlobUriResolver<'_>>,
    timestamp_ms: f64,
    record_offset: Option<i64>,
) -> Vec<MessagePart> {
    let Some(content) = content else {
        return Vec::new();
    };
    if let Some(text) = content.as_str() {
        if text.is_empty() {
            return Vec::new();
        }
        return vec![MessagePart::Text(text.to_owned())];
    }
    let Some(items) = content.as_array() else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    let mut multimodal_count = 0usize;
    let mut has_uri = false;
    for (part_index, item) in items.iter().enumerate() {
        if let Some(text) = item.as_str() {
            if !text.is_empty() {
                parts.push(MessagePart::Text(text.to_owned()));
            }
            continue;
        }
        let Some(record) = as_record(item) else {
            continue;
        };
        let kind = string_value(record.get("type"));
        if matches!(kind, Some("input_text" | "text" | "output_text")) {
            if let Some(text) = string_value(record.get("text")) {
                parts.push(MessagePart::Text(text.to_owned()));
            }
            continue;
        }
        if kind == Some("input_image") {
            let Some(blob_to_uri) = blob_to_uri else {
                continue;
            };
            if multimodal_count >= MAX_MULTIMODAL_PARTS {
                continue;
            }
            let url = string_value(record.get("image_url"))
                .or_else(|| string_value(record.get("url")))
                .unwrap_or("");
            let Some(caps) = DATA_URL_RE.captures(url) else {
                continue;
            };
            let payload = caps.get(2).map(|item| item.as_str()).unwrap_or("");
            if payload.is_empty() {
                continue;
            }
            let mime = caps
                .get(1)
                .map(|item| item.as_str())
                .filter(|text| !text.is_empty())
                .unwrap_or("image/unknown");
            let result = blob_to_uri(&BlobToUriParams {
                content: payload.to_owned(),
                mime_type: Some(mime.to_owned()),
                modality: Some("image".to_owned()),
                time_unix_ms: Some(timestamp_ms.max(0.0)),
                reuse_key: record_offset.map(|offset| format!("{offset}:{part_index}")),
            });
            let Some(result) = result else {
                continue;
            };
            multimodal_count += 1;
            has_uri = true;
            parts.push(MessagePart::Uri {
                mime_type: result.mime_type,
                uri: result.uri,
            });
        }
    }
    if has_uri {
        collapse_codex_image_wrappers(parts)
    } else {
        parts
    }
}

fn collapse_codex_image_wrappers(parts: Vec<MessagePart>) -> Vec<MessagePart> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let open_text = match &parts[index] {
            MessagePart::Text(text) => Some(text.as_str()),
            MessagePart::Uri { .. } => None,
        };
        let mid_uri = parts.get(index + 1).and_then(|part| match part {
            MessagePart::Uri { mime_type, uri } => Some((mime_type.clone(), uri.clone())),
            MessagePart::Text(_) => None,
        });
        let close_text = parts.get(index + 2).and_then(|part| match part {
            MessagePart::Text(text) => Some(text.as_str()),
            MessagePart::Uri { .. } => None,
        });
        if let (Some(open), Some((mime_type, uri)), Some(close)) = (open_text, mid_uri, close_text)
        {
            if IMAGE_OPEN_RE.is_match(open.trim()) && IMAGE_CLOSE_RE.is_match(close.trim()) {
                out.push(MessagePart::Uri { mime_type, uri });
                index += 3;
                continue;
            }
        }
        out.push(match &parts[index] {
            MessagePart::Text(text) => MessagePart::Text(text.clone()),
            MessagePart::Uri { mime_type, uri } => MessagePart::Uri {
                mime_type: mime_type.clone(),
                uri: uri.clone(),
            },
        });
        index += 1;
    }
    out
}

fn read_instruction_text(value: Option<&Value>) -> Option<String> {
    let record = value.and_then(as_record);
    string_value(record.and_then(|record| record.get("text")))
        .or_else(|| string_value(value))
        .map(str::to_owned)
}

fn extract_message_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(text) = content.as_str() {
        return (!text.is_empty()).then(|| text.to_owned());
    }
    let items = content.as_array()?;
    let mut parts = Vec::new();
    for item in items {
        if let Some(text) = item.as_str() {
            parts.push(text.to_owned());
            continue;
        }
        let Some(record) = as_record(item) else {
            continue;
        };
        let kind = string_value(record.get("type"));
        if matches!(kind, Some("input_image" | "image_url")) {
            continue;
        }
        if let Some(text) = string_value(record.get("text")) {
            parts.push(text.to_owned());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn parse_maybe_json(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let Some(text) = value.as_str() else {
        return value.clone();
    };
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned()))
}

fn to_json_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::String(_) | Value::Bool(_) => Some(value.clone()),
        Value::Number(number) => number
            .as_f64()
            .filter(|item| item.is_finite())
            .map(|_| value.clone()),
        Value::Array(items) => Some(Value::Array(
            items.iter().filter_map(to_json_value).collect(),
        )),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if let Some(json) = to_json_value(item) {
                    out.insert(key.clone(), json);
                }
            }
            Some(Value::Object(out))
        }
    }
}

fn extract_last_token_usage(value: Option<&Value>) -> Option<CodexTranscriptUsage> {
    let info = value.and_then(as_record)?;
    let raw = info.get("last_token_usage").and_then(as_record)?;
    let input_tokens = number_value(raw.get("input_tokens"))?;
    let output_tokens = number_value(raw.get("output_tokens"))?;
    let cached = number_value(raw.get("cached_input_tokens")).unwrap_or(0.0);
    let cache_creation = number_value(raw.get("cache_creation_input_tokens")).unwrap_or(0.0);
    let total = number_value(raw.get("total_tokens"));
    let reasoning = number_value(raw.get("reasoning_output_tokens"));
    Some(CodexTranscriptUsage {
        input_tokens,
        output_tokens,
        cached_input_tokens: cached,
        cache_creation_tokens: cache_creation,
        reasoning_output_tokens: reasoning,
        total_tokens: total
            .filter(|value| *value > 0.0)
            .unwrap_or(input_tokens + output_tokens),
    })
}

fn extract_cumulative_token_total(value: Option<&Value>) -> Option<f64> {
    let info = value.and_then(as_record)?;
    let total = info.get("total_token_usage").and_then(as_record)?;
    number_value(total.get("total_tokens"))
}

fn same_usage(left: Option<&CodexTranscriptUsage>, right: &CodexTranscriptUsage) -> bool {
    let Some(left) = left else {
        return false;
    };
    left.input_tokens == right.input_tokens
        && left.output_tokens == right.output_tokens
        && left.cached_input_tokens == right.cached_input_tokens
        && left.cache_creation_tokens == right.cache_creation_tokens
        && left.reasoning_output_tokens == right.reasoning_output_tokens
        && left.total_tokens == right.total_tokens
}

#[allow(dead_code)]
fn _json_number_used(value: f64) -> Value {
    json_number(value)
}

#[cfg(test)]
#[path = "hook_parser_history.rs"]
mod hook_parser_history;
