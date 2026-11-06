//! Port of `codex-aborted-turn-extractor.ts`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::types::{
    AssistantMessage, CodexExtractedAbortedTurn, CodexTokenUsage, CodexTokenUsageSample,
    CodexTranscriptMeta, TimelineEvent, ToolCall, ToolResult,
};
use super::utils::{as_record, number_value, string_value, timestamp_ms};

static SESSION_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([0-9a-f]{8}-[0-9a-f-]{27,})$").expect("session id"));

pub fn extract_codex_transcript_meta(record: &Map<String, Value>) -> Option<CodexTranscriptMeta> {
    if record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = record.get("payload").and_then(as_record)?;
    let base_instructions = read_instruction_text(payload.get("base_instructions"));
    let tool_definitions = payload
        .get("dynamic_tools")
        .filter(|value| value.is_array())
        .and_then(to_json_value);
    Some(CodexTranscriptMeta {
        session_id: string_value(payload.get("id")).unwrap_or("").to_owned(),
        provider: string_value(payload.get("model_provider"))
            .unwrap_or("openai")
            .to_owned(),
        base_instructions,
        tool_definitions,
    })
}

pub fn extract_aborted_turn(
    records: &[Map<String, Value>],
    meta: Option<&CodexTranscriptMeta>,
    fallback_session_id: &str,
    expected_turn_id: &str,
) -> Option<CodexExtractedAbortedTurn> {
    let mut current_turn_id = String::new();
    let mut started_at_ms: Option<f64> = None;
    let mut aborted_at_ms: Option<f64> = None;
    let mut abort_reason = "interrupted".to_owned();
    let mut model = "unknown".to_owned();
    let mut cwd = None;
    let mut developer_instructions = None;
    let mut prompt_parts = Vec::new();
    let mut timeline = Vec::new();
    let mut tool_call_ids = HashSet::new();
    let mut usage_samples = Vec::new();
    let mut last_usage = None;
    let mut sequence = 0u64;

    for record in records {
        let Some(payload) = record.get("payload").and_then(as_record) else {
            continue;
        };
        let parsed_timestamp = timestamp_ms(record);
        let timestamp = parsed_timestamp
            .or(started_at_ms)
            .unwrap_or_else(super::utils::now_ms);
        let record_type = record.get("type").and_then(Value::as_str);

        if record_type == Some("event_msg")
            && payload.get("type").and_then(Value::as_str) == Some("task_started")
        {
            if string_value(payload.get("turn_id")) == Some(expected_turn_id) {
                current_turn_id = expected_turn_id.to_owned();
                started_at_ms.get_or_insert(timestamp);
            }
            continue;
        }
        if record_type == Some("turn_context") {
            if string_value(payload.get("turn_id")) != Some(expected_turn_id) {
                continue;
            }
            current_turn_id = expected_turn_id.to_owned();
            started_at_ms.get_or_insert(timestamp);
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
        if current_turn_id != expected_turn_id {
            continue;
        }
        if record_type == Some("event_msg") {
            let kind = payload.get("type").and_then(Value::as_str);
            if kind == Some("agent_message") {
                if let Some(message) = string_value(payload.get("message")) {
                    timeline.push(TimelineEvent::Assistant(AssistantMessage {
                        timestamp_ms: timestamp,
                        sequence,
                        content: message.to_owned(),
                    }));
                    sequence += 1;
                }
            } else if kind == Some("token_count") {
                if let Some(usage) = extract_last_token_usage(payload.get("info")) {
                    if !same_usage(last_usage.as_ref(), &usage) {
                        last_usage = Some(usage.clone());
                        usage_samples.push(CodexTokenUsageSample {
                            timestamp_ms: timestamp,
                            sequence,
                            usage,
                        });
                        sequence += 1;
                    }
                }
            } else if kind == Some("turn_aborted")
                && string_value(payload.get("turn_id")) == Some(expected_turn_id)
            {
                aborted_at_ms = parsed_timestamp;
                if let Some(reason) = string_value(payload.get("reason")) {
                    abort_reason = reason.to_owned();
                }
            }
            continue;
        }
        if record_type != Some("response_item") {
            continue;
        }
        let item_type = string_value(payload.get("type"));
        if item_type == Some("message") {
            if string_value(payload.get("role")) == Some("user") {
                if let Some(text) = extract_message_text(payload.get("content")) {
                    if !is_turn_aborted_injection(&text) {
                        prompt_parts.push(text);
                    }
                }
            }
            continue;
        }
        if matches!(
            item_type,
            Some("function_call" | "custom_tool_call" | "tool_search_call")
        ) {
            let Some(call_id) =
                string_value(payload.get("call_id")).or_else(|| string_value(payload.get("id")))
            else {
                continue;
            };
            let input_field = if item_type == Some("custom_tool_call") {
                payload.get("input")
            } else {
                payload.get("arguments")
            };
            let name = string_value(payload.get("name"))
                .unwrap_or(if item_type == Some("tool_search_call") {
                    "tool_search"
                } else {
                    "unknown"
                })
                .to_owned();
            timeline.push(TimelineEvent::ToolCall(ToolCall {
                timestamp_ms: timestamp,
                sequence,
                call_id: call_id.to_owned(),
                name,
                input: to_json_value(&parse_maybe_json(input_field)),
            }));
            sequence += 1;
            tool_call_ids.insert(call_id.to_owned());
            continue;
        }
        if item_type == Some("web_search_call") {
            let call_id = string_value(payload.get("call_id"))
                .or_else(|| string_value(payload.get("id")))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("web_search:{timestamp}"));
            timeline.push(TimelineEvent::ToolCall(ToolCall {
                timestamp_ms: timestamp,
                sequence,
                call_id: call_id.clone(),
                name: "web_search".to_owned(),
                input: to_json_value(&parse_maybe_json(payload.get("action"))),
            }));
            sequence += 1;
            tool_call_ids.insert(call_id.clone());
            timeline.push(TimelineEvent::ToolResult(ToolResult {
                timestamp_ms: timestamp,
                sequence,
                call_id,
                output: Some(web_search_output(payload)),
            }));
            sequence += 1;
            continue;
        }
        if item_type != Some("function_call_output")
            && item_type != Some("custom_tool_call_output")
            && item_type != Some("tool_search_output")
        {
            continue;
        }
        let Some(call_id) =
            string_value(payload.get("call_id")).or_else(|| string_value(payload.get("id")))
        else {
            continue;
        };
        if !tool_call_ids.contains(call_id) {
            continue;
        }
        let output = if item_type == Some("tool_search_output") {
            Some(tool_search_output(payload))
        } else {
            to_json_value(&parse_maybe_json(payload.get("output")))
        };
        timeline.push(TimelineEvent::ToolResult(ToolResult {
            timestamp_ms: timestamp,
            sequence,
            call_id: call_id.to_owned(),
            output,
        }));
        sequence += 1;
    }

    let aborted_at_ms = aborted_at_ms?;
    Some(CodexExtractedAbortedTurn {
        session_id: meta
            .map(|meta| meta.session_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| fallback_session_id.to_owned()),
        transcript_turn_id: expected_turn_id.to_owned(),
        provider: meta
            .map(|meta| meta.provider.clone())
            .unwrap_or_else(|| "openai".to_owned()),
        model,
        cwd,
        prompt: if prompt_parts.is_empty() {
            None
        } else {
            Some(prompt_parts.join("\n\n"))
        },
        developer_instructions,
        base_instructions: meta.and_then(|meta| meta.base_instructions.clone()),
        tool_definitions: meta.and_then(|meta| meta.tool_definitions.clone()),
        started_at_ms: started_at_ms.unwrap_or(aborted_at_ms),
        aborted_at_ms,
        reason: abort_reason,
        timeline,
        usage_samples,
    })
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

fn read_instruction_text(value: Option<&Value>) -> Option<String> {
    if let Some(record) = value.and_then(as_record) {
        if let Some(text) = string_value(record.get("text")) {
            return Some(text.to_owned());
        }
    }
    string_value(value).map(str::to_owned)
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
        if let Some(text) = item
            .as_object()
            .and_then(|record| string_value(record.get("text")))
        {
            parts.push(text.to_owned());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn is_turn_aborted_injection(text: &str) -> bool {
    text.trim_start().starts_with("<turn_aborted>")
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

fn web_search_output(payload: &Map<String, Value>) -> Value {
    let mut output = Map::new();
    if let Some(status) = payload.get("status").and_then(to_json_value) {
        output.insert("status".into(), status);
    }
    if payload.contains_key("action") {
        if let Some(action) = to_json_value(&parse_maybe_json(payload.get("action"))) {
            output.insert("action".into(), action);
        }
    }
    Value::Object(output)
}

fn tool_search_output(payload: &Map<String, Value>) -> Value {
    let mut output = Map::new();
    if let Some(status) = payload.get("status").and_then(to_json_value) {
        output.insert("status".into(), status);
    }
    if let Some(execution) = payload.get("execution").and_then(to_json_value) {
        output.insert("execution".into(), execution);
    }
    if payload.contains_key("tools") {
        if let Some(tools) = to_json_value(&parse_maybe_json(payload.get("tools"))) {
            output.insert("tools".into(), tools);
        }
    }
    Value::Object(output)
}

fn extract_last_token_usage(value: Option<&Value>) -> Option<CodexTokenUsage> {
    let info = value.and_then(as_record)?;
    let raw = info.get("last_token_usage").and_then(as_record)?;
    let input_tokens = number_value(raw.get("input_tokens"))?;
    let output_tokens = number_value(raw.get("output_tokens"))?;
    let total = number_value(raw.get("total_tokens"));
    Some(CodexTokenUsage {
        input_tokens,
        output_tokens,
        cached_input_tokens: number_value(raw.get("cached_input_tokens")).unwrap_or(0.0),
        cache_creation_tokens: number_value(raw.get("cache_creation_input_tokens")).unwrap_or(0.0),
        reasoning_output_tokens: number_value(raw.get("reasoning_output_tokens")),
        total_tokens: total
            .filter(|value| *value > 0.0)
            .unwrap_or(input_tokens + output_tokens),
    })
}

fn same_usage(left: Option<&CodexTokenUsage>, right: &CodexTokenUsage) -> bool {
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
