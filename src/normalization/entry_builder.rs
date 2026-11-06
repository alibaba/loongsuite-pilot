use super::normalize_messages::{
    normalize_input_messages, normalize_input_messages_delta, normalize_output_messages,
};
use super::openclaw_session_key::{is_openclaw_session_key, OPENCLAW_SESSION_KEY};
use crate::types::{
    AgentActivityEntry, AgentEventName, CodeGenerationEvent, JsonValue, SerializedLogEntry,
};
use chrono::{DateTime, NaiveDate};
use regex::Regex;
use serde_json::{Map, Number, Value};
use std::sync::LazyLock;
use uuid::Uuid;

#[cfg(test)]
use std::cell::{Cell, RefCell};
#[cfg(test)]
use std::collections::VecDeque;

static DIGITS_16: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{16,}$").expect("nanosecond digit string"));
static AGENT_SCOPED_FIELD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^agent\.[^.]+\..+$").expect("agent scoped field"));

const REDACTED_FIELDS: &[&str] = &[
    "gen_ai.input.messages_delta",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "input.messages_delta",
    "input.messages",
    "output.messages",
    "tool.arguments",
    "tool.result.payload",
    "agent.content",
    "agent.inline_diff_message",
    "filePath",
    "content",
    "inlineDiffMessage",
    "recorduuid",
    "distinctid",
];

const LEGACY_ALIAS_FIELDS: &[&str] = &[
    "session.id",
    "turn.id",
    "step.id",
    "response.id",
    "agent.type",
    "agent.id",
    "agent.name",
    "gen_ai.message.role",
    "gen_ai.tool.call.duration_ms",
    "message.role",
    "client.channel",
    "provider.name",
    "request.id",
    "request.model",
    "response.model",
    "response.finish_reasons",
    "usage.input_tokens",
    "usage.output_tokens",
    "usage.cache_read_tokens",
    "usage.cache_write_tokens",
    "usage.total_tokens",
    "cost.input",
    "cost.output",
    "cost.cache_read",
    "cost.cache_write",
    "cost.total",
    "input.messages_hash",
    "input.messages_delta",
    "input.messages",
    "output.messages",
    "tool.name",
    "tool.exec.id",
    "tool.arguments",
    "tool.result.payload",
    "tool.result.duration",
    "tool.result.duration_ms",
    "skill.name",
    "is_error",
    "attributes",
    "sessionId",
    "timestamp",
    "uuid",
    "userId",
    "identity",
    "agentType",
    "actionType",
    "filePath",
    "content",
    "inlineDiffMessage",
    "extra",
];

#[cfg(test)]
thread_local! {
    static TEST_NOW: Cell<Option<i64>> = const { Cell::new(None) };
    static TEST_UUIDS: RefCell<VecDeque<String>> = const { RefCell::new(VecDeque::new()) };
    static TEST_UUID_FALLBACK: RefCell<Option<String>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Default)]
pub struct SerialiseLogEntryOptions {
    pub drop_agent_scoped_fields: bool,
}

pub fn build_agent_activity_entry(opts: &Value) -> AgentActivityEntry {
    let Some(map) = opts.as_object() else {
        return build_standard(&Map::new());
    };
    if is_legacy_options(map) {
        build_from_legacy(map)
    } else {
        build_standard(map)
    }
}

pub fn build_from_code_generation_event(
    event: &CodeGenerationEvent,
    user_id: &str,
    session_id: &str,
) -> AgentActivityEntry {
    let mut opts = Map::new();
    opts.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    opts.insert("userId".to_string(), Value::String(user_id.to_string()));
    opts.insert(
        "agentType".to_string(),
        Value::String(event.agent_type.as_str().to_string()),
    );
    opts.insert(
        "actionType".to_string(),
        Value::String(event.action_type.as_str().to_string()),
    );
    opts.insert(
        "filePath".to_string(),
        Value::String(event.file_path.clone()),
    );
    if let Some(content) = &event.content {
        opts.insert("content".to_string(), Value::String(content.clone()));
    }
    if let Some(diff) = &event.diff {
        opts.insert("inlineDiffMessage".to_string(), Value::String(diff.clone()));
    }
    opts.insert(
        "timestamp".to_string(),
        Value::Number(Number::from(event.source_timestamp)),
    );
    opts.insert("extra".to_string(), Value::Object(event.raw_data.clone()));
    build_agent_activity_entry(&Value::Object(opts))
}

pub fn project_log_entry(
    entry: &AgentActivityEntry,
    options: &SerialiseLogEntryOptions,
) -> Map<String, JsonValue> {
    let mut out = Map::new();
    for (key, value) in super::entry_to_object(entry) {
        if value.is_null() || is_legacy_alias(&key) {
            continue;
        }
        if key == OPENCLAW_SESSION_KEY {
            if entry.agent_type != "openclaw" || !is_openclaw_session_key(&value) {
                continue;
            }
        } else if options.drop_agent_scoped_fields && AGENT_SCOPED_FIELD_RE.is_match(&key) {
            continue;
        }
        out.insert(key, value);
    }
    out
}

pub fn serialise_log_entry(
    entry: &AgentActivityEntry,
    options: &SerialiseLogEntryOptions,
) -> SerializedLogEntry {
    let mut out = SerializedLogEntry::new();
    for (key, value) in project_log_entry(entry, options) {
        out.insert(key, serialize_value(&value));
    }
    out
}

pub fn redact_code_generation_fields(serialized: &SerializedLogEntry) -> SerializedLogEntry {
    let mut copy = serialized.clone();
    for key in REDACTED_FIELDS {
        copy.shift_remove(*key);
    }
    if let Some(raw) = copy.get("attributes").cloned() {
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(mut attributes)) => {
                attributes.remove("filePath");
                attributes.remove("content");
                attributes.remove("inlineDiffMessage");
                if let Ok(text) = serde_json::to_string(&Value::Object(attributes)) {
                    copy.insert("attributes".to_string(), text);
                }
            }
            Ok(Value::Array(items)) => {
                if let Ok(text) = serde_json::to_string(&Value::Array(items)) {
                    copy.insert("attributes".to_string(), text);
                }
            }
            _ => {
                copy.shift_remove("attributes");
            }
        }
    }
    copy
}

pub fn timestamp_to_unix_nanos(ts: Option<&Value>) -> String {
    match ts {
        None | Some(Value::Null) => timestamp_from_i64(current_time_millis()),
        Some(Value::String(text)) => timestamp_from_string(text),
        Some(Value::Number(number)) => timestamp_from_number(number),
        Some(_) => timestamp_from_i64(current_time_millis()),
    }
}

pub fn unix_nanos_to_millis(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => {
            let Some(float) = number.as_f64() else {
                return current_time_millis();
            };
            if !float.is_finite() {
                return current_time_millis();
            }
            if float >= 1e16 {
                (float / 1_000_000.0).floor() as i64
            } else {
                normalize_timestamp_to_millis(float)
            }
        }
        Some(Value::String(text)) => {
            if let Ok(float) = text.trim().parse::<f64>() {
                if float.is_finite() {
                    return if float >= 1e16 {
                        (float / 1_000_000.0).floor() as i64
                    } else {
                        normalize_timestamp_to_millis(float)
                    };
                }
            }
            date_parse(text).unwrap_or_else(current_time_millis)
        }
        _ => current_time_millis(),
    }
}

pub fn normalize_event_name(value: Option<&Value>) -> AgentEventName {
    match value.and_then(Value::as_str) {
        Some("gen_ai.model.request") => AgentEventName::ModelRequest,
        Some("gen_ai.model.response") => AgentEventName::ModelResponse,
        Some("gen_ai.tool.call") => AgentEventName::GenAiToolCall,
        Some("gen_ai.tool.result") => AgentEventName::GenAiToolResult,
        Some("gen_ai.agent.invoke") => AgentEventName::AgentInvoke,
        Some("gen_ai.agent.result") => AgentEventName::AgentResult,
        Some("llm.request" | "llm_call_input") => AgentEventName::LlmRequest,
        Some("llm.response" | "llm_call_output" | "llm_call_thinking") => {
            AgentEventName::LlmResponse
        }
        Some("tool.call" | "tool_call_input") => AgentEventName::ToolCall,
        Some("tool.result" | "tool_call_output") => AgentEventName::ToolResult,
        Some("skill.use" | "skill_use") => AgentEventName::SkillUse,
        Some("tool.approve") => AgentEventName::ToolApprove,
        Some("agent.input") => AgentEventName::AgentInput,
        Some("react.step") => AgentEventName::ReactStep,
        _ => AgentEventName::Other,
    }
}

pub fn normalize_finish_reasons(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        Some(Value::Array(items)) => {
            let values = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) if !text.is_empty() => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if values.is_empty() {
                None
            } else {
                Some(values)
            }
        }
        Some(Value::String(text)) if !text.is_empty() => Some(vec![text.clone()]),
        _ => None,
    }
}

pub fn infer_provider_name(input: &Map<String, Value>) -> String {
    if let Some(explicit) = string_alias(input, "gen_ai.provider.name", "provider.name") {
        return explicit;
    }
    let model = string_alias(input, "gen_ai.request.model", "request.model")
        .or_else(|| string_alias(input, "gen_ai.response.model", "response.model"))
        .unwrap_or_default()
        .to_lowercase();
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
    let agent_type = string_alias(input, "gen_ai.agent.type", "agent.type")
        .unwrap_or_default()
        .to_lowercase();
    if agent_type.contains("codex") {
        return "openai".to_string();
    }
    if agent_type.contains("claude") {
        return "anthropic".to_string();
    }
    if agent_type.contains("qoder") || agent_type.contains("qwen") {
        return "qwen".to_string();
    }
    if agent_type.contains("gemini") {
        return "gcp.gemini".to_string();
    }
    "unknown".to_string()
}

pub fn to_json_value(value: Option<&Value>) -> Option<JsonValue> {
    value.cloned()
}

fn build_from_legacy(opts: &Map<String, Value>) -> AgentActivityEntry {
    let mut agent_fields = Map::new();
    if let Some(value) = opts.get("filePath") {
        agent_fields.insert("agent.file_path".to_string(), value.clone());
    }
    if let Some(value) = opts.get("actionType") {
        agent_fields.insert("agent.action_type".to_string(), value.clone());
    }
    if let Some(value) = opts.get("inlineDiffMessage") {
        agent_fields.insert("agent.inline_diff_message".to_string(), value.clone());
    }
    if let Some(Value::Object(extra)) = opts.get("extra") {
        for (key, raw) in extra {
            let agent_key = if key.starts_with("agent.") {
                key.clone()
            } else {
                format!("agent.{key}")
            };
            if !agent_fields.contains_key(&agent_key) {
                agent_fields.insert(agent_key, raw.clone());
            }
        }
    }
    if let Some(content) = opts.get("content") {
        agent_fields.insert("agent.content".to_string(), content.clone());
    }

    let mut next = agent_fields;
    if let Some(timestamp) = opts.get("timestamp") {
        if !timestamp.is_null() {
            next.insert("timestamp".to_string(), timestamp.clone());
        }
    }
    match opts.get("sessionId") {
        Some(value) if !value.is_null() => {
            next.insert("session.id".to_string(), value.clone());
        }
        _ => {
            next.remove("session.id");
        }
    }
    match opts.get("userId") {
        Some(value) if !value.is_null() => {
            next.insert("user.id".to_string(), value.clone());
        }
        _ => {
            next.remove("user.id");
        }
    }
    match opts.get("agentType") {
        Some(value) if !value.is_null() => {
            next.insert("agent.type".to_string(), value.clone());
        }
        _ => {
            next.remove("agent.type");
        }
    }
    next.insert("event.name".to_string(), Value::String("other".to_string()));
    build_standard(&next)
}

fn build_standard(opts: &Map<String, Value>) -> AgentActivityEntry {
    let mut entry = opts.clone();
    let now_value = match opts.get("timestamp") {
        None | Some(Value::Null) => Value::Number(Number::from(current_time_millis())),
        Some(value) => value.clone(),
    };
    let time_unix_nano = assigned_string(
        opts,
        "time_unix_nano",
        timestamp_to_unix_nanos(Some(&now_value)),
    );
    let observed = assigned_string(
        opts,
        "observed_time_unix_nano",
        timestamp_to_unix_nanos(Some(&Value::Number(Number::from(current_time_millis())))),
    );
    set_string(&mut entry, "time_unix_nano", Some(time_unix_nano));
    set_string(&mut entry, "observed_time_unix_nano", Some(observed));
    set_string(
        &mut entry,
        "event.id",
        Some(match opts.get("event.id") {
            None | Some(Value::Null) => new_event_id(),
            Some(Value::String(text)) => text.clone(),
            Some(other) => serialize_value(other),
        }),
    );
    entry.insert(
        "event.name".to_string(),
        Value::String(
            normalize_event_name(opts.get("event.name"))
                .as_str()
                .to_string(),
        ),
    );
    set_string(
        &mut entry,
        "user.id",
        Some(match opts.get("user.id") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(text)) => text.clone(),
            Some(other) => serialize_value(other),
        }),
    );
    set_string(
        &mut entry,
        "gen_ai.session.id",
        Some(string_alias(opts, "gen_ai.session.id", "session.id").unwrap_or_default()),
    );
    set_alias_string(&mut entry, opts, "gen_ai.turn.id", "turn.id");
    set_alias_string(&mut entry, opts, "gen_ai.step.id", "step.id");
    set_alias_string(&mut entry, opts, "gen_ai.response.id", "response.id");
    set_string(
        &mut entry,
        "gen_ai.agent.type",
        Some(
            string_alias(opts, "gen_ai.agent.type", "agent.type")
                .unwrap_or_else(|| "unknown".to_string()),
        ),
    );
    set_alias_string(&mut entry, opts, "gen_ai.agent.id", "agent.id");
    set_alias_string(&mut entry, opts, "gen_ai.agent.name", "agent.name");
    set_string(
        &mut entry,
        "gen_ai.provider.name",
        Some(infer_provider_name(opts)),
    );
    set_alias_string(&mut entry, opts, "gen_ai.request.id", "request.id");
    set_alias_string(&mut entry, opts, "gen_ai.request.model", "request.model");
    set_alias_string(&mut entry, opts, "gen_ai.response.model", "response.model");
    match normalize_finish_reasons(first_present(
        opts,
        &["gen_ai.response.finish_reasons", "response.finish_reasons"],
    )) {
        Some(reasons) => {
            entry.insert(
                "gen_ai.response.finish_reasons".to_string(),
                Value::Array(reasons.into_iter().map(Value::String).collect()),
            );
        }
        None => {
            entry.remove("gen_ai.response.finish_reasons");
        }
    }
    set_alias_i64(
        &mut entry,
        opts,
        "gen_ai.usage.input_tokens",
        "usage.input_tokens",
    );
    set_alias_i64(
        &mut entry,
        opts,
        "gen_ai.usage.output_tokens",
        "usage.output_tokens",
    );
    set_alias_i64(
        &mut entry,
        opts,
        "gen_ai.usage.cache_read.input_tokens",
        "usage.cache_read_tokens",
    );
    set_alias_i64(
        &mut entry,
        opts,
        "gen_ai.usage.cache_creation.input_tokens",
        "usage.cache_write_tokens",
    );
    set_alias_i64(
        &mut entry,
        opts,
        "gen_ai.usage.total_tokens",
        "usage.total_tokens",
    );
    set_alias_f64(&mut entry, opts, "gen_ai.usage.input_cost", "cost.input");
    set_alias_f64(&mut entry, opts, "gen_ai.usage.output_cost", "cost.output");
    set_alias_f64(
        &mut entry,
        opts,
        "gen_ai.usage.cache_read.input_cost",
        "cost.cache_read",
    );
    set_alias_f64(
        &mut entry,
        opts,
        "gen_ai.usage.cache_creation.input_cost",
        "cost.cache_write",
    );
    set_alias_f64(&mut entry, opts, "gen_ai.usage.total_cost", "cost.total");
    set_alias_string(
        &mut entry,
        opts,
        "gen_ai.input.messages_hash",
        "input.messages_hash",
    );
    set_alias_json(
        &mut entry,
        opts,
        "gen_ai.input.messages_delta",
        "input.messages_delta",
    );
    set_alias_json(&mut entry, opts, "gen_ai.input.messages", "input.messages");
    set_alias_json(
        &mut entry,
        opts,
        "gen_ai.output.messages",
        "output.messages",
    );
    set_alias_string(&mut entry, opts, "gen_ai.tool.name", "tool.name");
    set_alias_string(&mut entry, opts, "gen_ai.tool.call.id", "tool.call.id");
    set_alias_string(&mut entry, opts, "gen_ai.tool.call.exec.id", "tool.exec.id");
    set_alias_json(
        &mut entry,
        opts,
        "gen_ai.tool.call.arguments",
        "tool.arguments",
    );
    set_alias_json(
        &mut entry,
        opts,
        "gen_ai.tool.call.result",
        "tool.result.payload",
    );
    match tool_duration(opts) {
        Some(duration) => {
            if let Some(number) = Number::from_f64(duration) {
                entry.insert(
                    "gen_ai.tool.call.duration".to_string(),
                    Value::Number(number),
                );
            } else {
                entry.remove("gen_ai.tool.call.duration");
            }
        }
        None => {
            entry.remove("gen_ai.tool.call.duration");
        }
    }
    set_alias_string(&mut entry, opts, "gen_ai.skill.name", "skill.name");
    set_alias_string(&mut entry, opts, "gen_ai.skill.id", "skill.id");
    set_alias_string(
        &mut entry,
        opts,
        "gen_ai.skill.description",
        "skill.description",
    );
    set_alias_string(&mut entry, opts, "gen_ai.skill.version", "skill.version");
    set_alias_json(
        &mut entry,
        opts,
        "gen_ai.system_instructions",
        "system_instructions",
    );
    set_alias_json(
        &mut entry,
        opts,
        "gen_ai.tool.definitions",
        "tool.definitions",
    );
    apply_legacy_tool_status(&mut entry, opts);
    flatten_attributes(&mut entry, opts);
    normalize_message_fields(&mut entry);
    remove_legacy_aliases(&mut entry);
    super::entry_from_map(entry)
}

fn is_legacy_options(opts: &Map<String, Value>) -> bool {
    opts.contains_key("sessionId")
        || opts.contains_key("agentType")
        || opts.contains_key("actionType")
}

fn is_legacy_alias(key: &str) -> bool {
    LEGACY_ALIAS_FIELDS.contains(&key)
}

fn apply_legacy_tool_status(entry: &mut Map<String, Value>, opts: &Map<String, Value>) {
    let Some(Value::String(status)) = opts.get("tool.result.status") else {
        return;
    };
    let normalized = normalize_tool_result_status(&status.to_lowercase());
    entry.insert(
        "tool.result.status".to_string(),
        Value::String(normalized.to_string()),
    );
    if normalized == "failure" {
        let missing = matches!(entry.get("error.type"), None | Some(Value::Null));
        if missing {
            entry.insert(
                "error.type".to_string(),
                Value::String("_OTHER".to_string()),
            );
        }
    }
}

fn normalize_tool_result_status(status: &str) -> &'static str {
    match status {
        "success" | "completed" => "success",
        "failure" | "failed" | "error" => "failure",
        "cancelled" | "canceled" => "cancelled",
        _ => "unknown",
    }
}

fn flatten_attributes(entry: &mut Map<String, Value>, opts: &Map<String, Value>) {
    let Some(Value::Object(attributes)) = opts.get("attributes") else {
        return;
    };
    for (key, value) in attributes {
        let target = if key.starts_with("agent.") {
            key.clone()
        } else {
            format!("agent.{key}")
        };
        if !entry.contains_key(&target) {
            entry.insert(target, value.clone());
        }
    }
}

fn normalize_message_fields(entry: &mut Map<String, Value>) {
    let output = normalize_output_messages(entry.get("gen_ai.output.messages").cloned());
    let delta = normalize_input_messages_delta(entry.get("gen_ai.input.messages_delta").cloned());
    let input = normalize_input_messages(entry.get("gen_ai.input.messages").cloned());
    set_json_key(entry, "gen_ai.output.messages", output);
    set_json_key(entry, "gen_ai.input.messages_delta", delta);
    set_json_key(entry, "gen_ai.input.messages", input);
}

fn remove_legacy_aliases(entry: &mut Map<String, Value>) {
    let keys = entry
        .keys()
        .filter(|key| is_legacy_alias(key))
        .cloned()
        .collect::<Vec<_>>();
    for key in keys {
        entry.remove(&key);
    }
}

fn set_string(entry: &mut Map<String, Value>, key: &str, value: Option<String>) {
    match value {
        Some(text) => {
            entry.insert(key.to_string(), Value::String(text));
        }
        None => {
            entry.remove(key);
        }
    }
}

fn set_json_key(entry: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            entry.insert(key.to_string(), value);
        }
        None => {
            entry.remove(key);
        }
    }
}

fn set_alias_string(
    entry: &mut Map<String, Value>,
    opts: &Map<String, Value>,
    canonical: &str,
    legacy: &str,
) {
    set_string(entry, canonical, string_alias(opts, canonical, legacy));
}

fn set_alias_i64(
    entry: &mut Map<String, Value>,
    opts: &Map<String, Value>,
    canonical: &str,
    legacy: &str,
) {
    match aliased_number(opts, canonical, legacy).and_then(json_i64) {
        Some(value) => {
            entry.insert(canonical.to_string(), Value::Number(Number::from(value)));
        }
        None => {
            entry.remove(canonical);
        }
    }
}

fn set_alias_f64(
    entry: &mut Map<String, Value>,
    opts: &Map<String, Value>,
    canonical: &str,
    legacy: &str,
) {
    match aliased_number(opts, canonical, legacy).and_then(json_finite) {
        Some(value) => match Number::from_f64(value) {
            Some(number) => {
                entry.insert(canonical.to_string(), Value::Number(number));
            }
            None => {
                entry.remove(canonical);
            }
        },
        None => {
            entry.remove(canonical);
        }
    }
}

fn set_alias_json(
    entry: &mut Map<String, Value>,
    opts: &Map<String, Value>,
    canonical: &str,
    legacy: &str,
) {
    set_json_key(entry, canonical, json_alias(opts, canonical, legacy));
}

fn string_alias(input: &Map<String, Value>, canonical: &str, legacy: &str) -> Option<String> {
    match first_present(input, &[canonical, legacy])? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn json_alias(input: &Map<String, Value>, canonical: &str, legacy: &str) -> Option<Value> {
    first_present(input, &[canonical, legacy]).cloned()
}

fn aliased_number<'a>(
    input: &'a Map<String, Value>,
    canonical: &str,
    legacy: &str,
) -> Option<&'a Value> {
    let value = first_present(input, &[canonical, legacy])?;
    json_finite(value).is_some().then_some(value)
}

fn tool_duration(input: &Map<String, Value>) -> Option<f64> {
    let value = first_present(
        input,
        &[
            "gen_ai.tool.call.duration",
            "gen_ai.tool.call.duration_ms",
            "tool.result.duration",
            "tool.result.duration_ms",
        ],
    )?;
    json_finite(value)
}

fn first_present<'a>(input: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        match input.get(*key) {
            None | Some(Value::Null) => continue,
            Some(value) => return Some(value),
        }
    }
    None
}

fn json_finite(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    number.is_finite().then_some(number)
}

fn json_i64(value: &Value) -> Option<i64> {
    let Value::Number(number) = value else {
        return None;
    };
    if let Some(integer) = number.as_i64() {
        return Some(integer);
    }
    let float = number.as_f64()?;
    if float.is_finite()
        && float.fract() == 0.0
        && float >= i64::MIN as f64
        && float <= i64::MAX as f64
    {
        Some(float as i64)
    } else {
        None
    }
}

fn assigned_string(opts: &Map<String, Value>, key: &str, fallback: String) -> String {
    match opts.get(key) {
        None | Some(Value::Null) => fallback,
        Some(Value::String(text)) => text.clone(),
        Some(other) => serialize_value(other),
    }
}

fn serialize_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(unsigned) = number.as_u64() {
                unsigned.to_string()
            } else if let Some(float) = number.as_f64() {
                format_js_number(float)
            } else {
                number.to_string()
            }
        }
        Value::Null => "null".to_string(),
        Value::Array(_) | Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
    }
}

fn format_js_number(float: f64) -> String {
    if float.is_nan() {
        return "NaN".to_string();
    }
    if float.is_infinite() {
        return if float.is_sign_positive() {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if float.fract() == 0.0 && float.abs() < 1e21 {
        format!("{}", float as i64)
    } else {
        Number::from_f64(float)
            .map(|number| number.to_string())
            .unwrap_or_else(|| float.to_string())
    }
}

fn timestamp_from_number(number: &Number) -> String {
    if let Some(integer) = number.as_i64() {
        timestamp_from_i64(integer)
    } else if let Some(float) = number.as_f64() {
        timestamp_from_f64(float)
    } else {
        timestamp_from_i64(current_time_millis())
    }
}

fn timestamp_from_string(text: &str) -> String {
    let trimmed = text.trim();
    if DIGITS_16.is_match(trimmed) {
        return trimmed.to_string();
    }
    if let Ok(integer) = trimmed.parse::<i64>() {
        return timestamp_from_i64(integer);
    }
    if let Ok(float) = trimmed.parse::<f64>() {
        if float.is_finite() {
            return timestamp_from_f64(float);
        }
    }
    timestamp_from_i64(date_parse(trimmed).unwrap_or_else(current_time_millis))
}

fn timestamp_from_i64(value: i64) -> String {
    if value >= 10_000_000_000_000_000 {
        return value.to_string();
    }
    if value >= 1_000_000_000_000 {
        return format!("{value}000000");
    }
    match value.checked_mul(1000) {
        Some(millis) => format!("{millis}000000"),
        None => timestamp_from_f64(value as f64),
    }
}

fn timestamp_from_f64(value: f64) -> String {
    let value = if value.is_finite() {
        value
    } else {
        current_time_millis() as f64
    };
    if value >= 1e16 {
        format_trunc(value)
    } else if value >= 1e12 {
        format!("{}000000", format_trunc(value))
    } else {
        format!("{}000000", format_trunc(value * 1000.0))
    }
}

fn format_trunc(value: f64) -> String {
    let truncated = value.trunc();
    if truncated.abs() < 1e21 {
        format!("{truncated:.0}")
    } else {
        truncated.to_string()
    }
}

fn normalize_timestamp_to_millis(ts: f64) -> i64 {
    if ts < 1e12 {
        (ts * 1000.0) as i64
    } else {
        ts as i64
    }
}

fn date_parse(text: &str) -> Option<i64> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = DateTime::parse_from_rfc2822(text) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|naive| naive.and_utc().timestamp_millis());
    }
    None
}

fn current_time_millis() -> i64 {
    #[cfg(test)]
    {
        if let Some(millis) = TEST_NOW.with(|cell| cell.get()) {
            return millis;
        }
    }
    super::now_millis()
}

fn new_event_id() -> String {
    #[cfg(test)]
    {
        if let Some(id) = TEST_UUIDS.with(|queue| queue.borrow_mut().pop_front()) {
            return id;
        }
        if let Some(id) = TEST_UUID_FALLBACK.with(|cell| cell.borrow().clone()) {
            return id;
        }
    }
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ActionType, AgentEventName, ClientType, CodeGenerationEvent};

    struct EnvGuard;

    impl EnvGuard {
        fn now(millis: i64) -> Self {
            TEST_NOW.with(|cell| cell.set(Some(millis)));
            Self
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            TEST_NOW.with(|cell| cell.set(None));
            TEST_UUIDS.with(|queue| queue.borrow_mut().clear());
            TEST_UUID_FALLBACK.with(|cell| *cell.borrow_mut() = None);
        }
    }

    fn push_uuids(ids: &[&str]) {
        TEST_UUIDS.with(|queue| {
            let mut queue = queue.borrow_mut();
            queue.clear();
            queue.extend(ids.iter().map(|id| (*id).to_string()));
        });
    }

    fn set_uuid_fallback(id: &str) {
        TEST_UUID_FALLBACK.with(|cell| *cell.borrow_mut() = Some(id.to_string()));
    }

    fn legacy(extra: Value) -> Value {
        let mut base = serde_json::json!({
            "sessionId": "s1",
            "userId": "u1",
            "agentType": ClientType::Qoder.as_str(),
            "actionType": ActionType::Edit.as_str(),
            "filePath": "/a.ts"
        });
        if let (Some(base_map), Some(extra_map)) = (base.as_object_mut(), extra.as_object()) {
            for (key, value) in extra_map {
                base_map.insert(key.clone(), value.clone());
            }
        }
        base
    }

    fn make_entry(overrides: Value) -> AgentActivityEntry {
        let mut base = serde_json::json!({
            "time_unix_nano": "1700000000000000000",
            "event.id": "test-uuid",
            "event.name": "other",
            "user.id": "user-1",
            "gen_ai.session.id": "sess-1",
            "gen_ai.agent.type": ClientType::Qoder.as_str(),
            "gen_ai.provider.name": "qwen",
            "agent.file_path": "/src/app.ts"
        });
        if let (Some(base_map), Some(extra_map)) = (base.as_object_mut(), overrides.as_object()) {
            for (key, value) in extra_map {
                base_map.insert(key.clone(), value.clone());
            }
        }
        super::super::entry_from_map(base.as_object().cloned().unwrap_or_default())
    }

    #[test]
    fn generates_unique_uuids_per_call() {
        let _guard = EnvGuard::now(1_700_000_000_000);
        push_uuids(&["uuid-aaa", "uuid-bbb"]);
        let a = build_agent_activity_entry(&legacy(serde_json::json!({})));
        let b = build_agent_activity_entry(&legacy(serde_json::json!({ "filePath": "/b.ts" })));
        assert_eq!(a.event_id, "uuid-aaa");
        assert_eq!(b.event_id, "uuid-bbb");
        assert_ne!(a.event_id, b.event_id);
    }

    #[test]
    fn auto_fills_timestamp_with_now_when_not_provided() {
        let _guard = EnvGuard::now(1_700_000_000_000);
        let entry = build_agent_activity_entry(&legacy(serde_json::json!({})));
        assert_eq!(entry.time_unix_nano, "1700000000000000000");
    }

    #[test]
    fn uses_explicit_timestamp_when_provided() {
        let _guard = EnvGuard::now(1_700_000_000_000);
        let entry = build_agent_activity_entry(&legacy(serde_json::json!({ "timestamp": 9999 })));
        assert_eq!(entry.time_unix_nano, "9999000000000");
    }

    #[test]
    fn includes_all_required_fields() {
        let _guard = EnvGuard::now(1_700_000_000_000);
        set_uuid_fallback("mock-uuid");
        let entry = build_agent_activity_entry(&serde_json::json!({
            "sessionId": "sess-abc",
            "userId": "user-42",
            "agentType": ClientType::Cursor.as_str(),
            "actionType": ActionType::Create.as_str(),
            "filePath": "/src/main.ts"
        }));
        assert_eq!(entry.session_id, "sess-abc");
        assert_eq!(entry.user_id, "user-42");
        assert_eq!(entry.agent_type, ClientType::Cursor.as_str());
        assert_eq!(entry.provider_name, "unknown");
        assert_eq!(entry.event_id, "mock-uuid");
        assert_eq!(
            entry.extra.get("agent.action_type").and_then(Value::as_str),
            Some(ActionType::Create.as_str())
        );
        assert_eq!(
            entry.extra.get("agent.file_path").and_then(Value::as_str),
            Some("/src/main.ts")
        );
    }

    #[test]
    fn carries_optional_content_field() {
        let entry =
            build_agent_activity_entry(&legacy(serde_json::json!({ "content": "hello world" })));
        assert_eq!(
            entry.extra.get("agent.content").and_then(Value::as_str),
            Some("hello world")
        );
    }

    #[test]
    fn carries_optional_extra_record() {
        let entry = build_agent_activity_entry(&legacy(serde_json::json!({
            "extra": { "foo": "bar", "num": 42 }
        })));
        assert_eq!(
            entry.extra.get("agent.foo").and_then(Value::as_str),
            Some("bar")
        );
        assert_eq!(
            entry.extra.get("agent.num").and_then(Value::as_i64),
            Some(42)
        );
    }

    #[test]
    fn does_not_let_extra_agent_fields_override_legacy_option_fields() {
        let entry = build_agent_activity_entry(&serde_json::json!({
            "sessionId": "s",
            "userId": "u",
            "agentType": ClientType::QoderWork.as_str(),
            "actionType": ActionType::Edit.as_str(),
            "filePath": "/source.ts",
            "content": "from option",
            "extra": {
                "type": "user",
                "agent.type": "user",
                "file_path": "/extra.ts",
                "action_type": ActionType::Other.as_str(),
                "content": "from extra"
            }
        }));
        assert_eq!(entry.agent_type, ClientType::QoderWork.as_str());
        assert_eq!(
            entry.extra.get("agent.file_path").and_then(Value::as_str),
            Some("/source.ts")
        );
        assert_eq!(
            entry.extra.get("agent.action_type").and_then(Value::as_str),
            Some(ActionType::Edit.as_str())
        );
        assert_eq!(
            entry.extra.get("agent.content").and_then(Value::as_str),
            Some("from option")
        );
    }

    #[test]
    fn leaves_optional_fields_absent_when_not_provided() {
        let entry = build_agent_activity_entry(&legacy(serde_json::json!({})));
        assert!(entry.extra.get("agent.content").is_none());
        assert!(entry.extra.get("agent.inline_diff_message").is_none());
    }

    #[test]
    fn normalizes_a_hook_tool_error_to_failure_and_marks_the_event() {
        let entry = build_agent_activity_entry(&serde_json::json!({
            "event.name": "tool.result",
            "gen_ai.agent.type": ClientType::Qoder.as_str(),
            "tool.result.status": "error"
        }));
        assert_eq!(entry.tool_result_status.as_deref(), Some("failure"));
        assert_eq!(entry.error_type.as_deref(), Some("_OTHER"));
        assert_eq!(entry.event_name, Some(AgentEventName::ToolResult));
    }

    fn event(agent: ClientType, action: ActionType, file: &str) -> CodeGenerationEvent {
        CodeGenerationEvent {
            agent_type: agent,
            file_path: file.to_string(),
            action_type: action,
            content: None,
            diff: None,
            source_timestamp: 1_700_000_000_000,
            raw_data: Map::new(),
        }
    }

    #[test]
    fn maps_agent_type_from_event() {
        let entry = build_from_code_generation_event(
            &event(ClientType::Cursor, ActionType::Create, "/a.ts"),
            "u1",
            "s1",
        );
        assert_eq!(entry.agent_type, ClientType::Cursor.as_str());
    }

    #[test]
    fn maps_action_type_from_event() {
        let entry = build_from_code_generation_event(
            &event(ClientType::Qoder, ActionType::Delete, "/a.ts"),
            "u1",
            "s1",
        );
        assert_eq!(
            entry.extra.get("agent.action_type").and_then(Value::as_str),
            Some(ActionType::Delete.as_str())
        );
    }

    #[test]
    fn maps_file_path_from_event() {
        let entry = build_from_code_generation_event(
            &event(ClientType::Qoder, ActionType::Edit, "/src/foo.ts"),
            "u1",
            "s1",
        );
        assert_eq!(
            entry.extra.get("agent.file_path").and_then(Value::as_str),
            Some("/src/foo.ts")
        );
    }

    #[test]
    fn maps_content_from_event() {
        let mut source = event(ClientType::Qoder, ActionType::Edit, "/a.ts");
        source.content = Some("the content".to_string());
        let entry = build_from_code_generation_event(&source, "u1", "s1");
        assert_eq!(
            entry.extra.get("agent.content").and_then(Value::as_str),
            Some("the content")
        );
    }

    #[test]
    fn maps_diff_to_inline_diff_message() {
        let mut source = event(ClientType::Qoder, ActionType::Edit, "/a.ts");
        source.diff = Some("--- a\n+++ b".to_string());
        let entry = build_from_code_generation_event(&source, "u1", "s1");
        assert_eq!(
            entry
                .extra
                .get("agent.inline_diff_message")
                .and_then(Value::as_str),
            Some("--- a\n+++ b")
        );
    }

    #[test]
    fn maps_raw_data_to_extra() {
        let mut source = event(ClientType::Qoder, ActionType::Edit, "/a.ts");
        source
            .raw_data
            .insert("key1".to_string(), serde_json::json!("val1"));
        source
            .raw_data
            .insert("key2".to_string(), serde_json::json!(123));
        let entry = build_from_code_generation_event(&source, "u1", "s1");
        assert_eq!(
            entry.extra.get("agent.key1").and_then(Value::as_str),
            Some("val1")
        );
        assert_eq!(
            entry.extra.get("agent.key2").and_then(Value::as_i64),
            Some(123)
        );
    }

    #[test]
    fn uses_source_timestamp_as_entry_timestamp() {
        let mut source = event(ClientType::Qoder, ActionType::Edit, "/a.ts");
        source.source_timestamp = 1_234_567_890;
        let entry = build_from_code_generation_event(&source, "u1", "s1");
        assert_eq!(entry.time_unix_nano, "1234567890000000000");
    }

    #[test]
    fn sets_user_id_and_session_id_from_arguments() {
        let entry = build_from_code_generation_event(
            &event(ClientType::Qoder, ActionType::Edit, "/a.ts"),
            "user-X",
            "session-Y",
        );
        assert_eq!(entry.user_id, "user-X");
        assert_eq!(entry.session_id, "session-Y");
    }

    #[test]
    fn serializes_basic_fields() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({})),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("gen_ai.session.id").map(String::as_str),
            Some("sess-1")
        );
        assert_eq!(out.get("event.id").map(String::as_str), Some("test-uuid"));
        assert_eq!(out.get("user.id").map(String::as_str), Some("user-1"));
        assert_eq!(
            out.get("gen_ai.agent.type").map(String::as_str),
            Some("qoder")
        );
        assert_eq!(out.get("event.name").map(String::as_str), Some("other"));
    }

    #[test]
    fn serializes_standard_extra_fields() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({ "agent.custom_key": "customVal" })),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("agent.custom_key").map(String::as_str),
            Some("customVal")
        );
    }

    #[test]
    fn drops_agent_scoped_extension_fields_when_requested() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({
                "agent.qoder.cwd": "/workspace/project",
                "agent.cursor.hook_event_name": "preToolUse",
                "agent.qoderwork.promptId": "prompt-1",
                "agent.custom_key": "customVal"
            })),
            &SerialiseLogEntryOptions {
                drop_agent_scoped_fields: true,
            },
        );
        assert!(!out.contains_key("agent.qoder.cwd"));
        assert!(!out.contains_key("agent.cursor.hook_event_name"));
        assert!(!out.contains_key("agent.qoderwork.promptId"));
        assert_eq!(
            out.get("agent.custom_key").map(String::as_str),
            Some("customVal")
        );
        assert_eq!(
            out.get("agent.file_path").map(String::as_str),
            Some("/src/app.ts")
        );
        assert_eq!(
            out.get("gen_ai.agent.type").map(String::as_str),
            Some("qoder")
        );
    }

    #[test]
    fn converts_scalar_values_to_strings() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({ "gen_ai.usage.input_tokens": 42 })),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("gen_ai.usage.input_tokens").map(String::as_str),
            Some("42")
        );
    }

    #[test]
    fn json_stringifies_object_values() {
        let nested = serde_json::json!({ "a": 1 });
        let expected = serde_json::to_string(&nested).unwrap();
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({ "gen_ai.tool.call.arguments": { "a": 1 } })),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("gen_ai.tool.call.arguments").map(String::as_str),
            Some(expected.as_str())
        );
    }

    #[test]
    fn keeps_content_fields_before_endpoint_redaction() {
        let nested = serde_json::json!({ "output": "visible" });
        let expected = serde_json::to_string(&nested).unwrap();
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({ "gen_ai.tool.call.result": { "output": "visible" } })),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("gen_ai.tool.call.result").map(String::as_str),
            Some(expected.as_str())
        );
    }

    #[test]
    fn keeps_tool_result_status_as_a_serialized_field() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({ "tool.result.status": "cancelled" })),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("tool.result.status").map(String::as_str),
            Some("cancelled")
        );
    }

    #[test]
    fn normalizes_completed_tool_results_before_serializing_status() {
        let mut opts = serde_json::json!({
            "time_unix_nano": "1700000000000000000",
            "event.id": "test-uuid",
            "event.name": "tool.result",
            "user.id": "user-1",
            "gen_ai.session.id": "sess-1",
            "gen_ai.agent.type": "qoder",
            "gen_ai.provider.name": "qwen",
            "agent.file_path": "/src/app.ts",
            "tool.result.status": "completed"
        });
        let _ = &mut opts;
        let entry = build_agent_activity_entry(&opts);
        assert_eq!(
            serialise_log_entry(&entry, &SerialiseLogEntryOptions::default())
                .get("tool.result.status")
                .map(String::as_str),
            Some("success")
        );
    }

    #[test]
    fn skips_null_and_undefined_values() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({ "tool.arguments": null })),
            &SerialiseLogEntryOptions::default(),
        );
        assert!(!out.contains_key("provider.name"));
        assert!(!out.contains_key("tool.arguments"));
    }

    #[test]
    fn serializes_nanosecond_timestamp_as_is() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({ "time_unix_nano": "1700000000000000000" })),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("time_unix_nano").map(String::as_str),
            Some("1700000000000000000")
        );
    }

    #[test]
    fn includes_input_messages_when_present() {
        let value = serde_json::json!([{ "role": "user", "content": "hi" }]);
        let expected = serde_json::to_string(&value).unwrap();
        let out = serialise_log_entry(
            &make_entry(
                serde_json::json!({ "gen_ai.input.messages_delta": [{ "role": "user", "content": "hi" }] }),
            ),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("gen_ai.input.messages_delta").map(String::as_str),
            Some(expected.as_str())
        );
    }

    #[test]
    fn includes_output_messages_when_present() {
        let value = serde_json::json!([{ "type": "text", "content": "ok" }]);
        let expected = serde_json::to_string(&value).unwrap();
        let out = serialise_log_entry(
            &make_entry(
                serde_json::json!({ "gen_ai.output.messages": [{ "type": "text", "content": "ok" }] }),
            ),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("gen_ai.output.messages").map(String::as_str),
            Some(expected.as_str())
        );
    }

    #[test]
    fn serializes_canonical_source_contract_fields() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({
                "git.repo": "sls/loongsuite-pilot",
                "git.branch": "feature/source-contract",
                "workspace.current_root": "/Users/yutao/workspace/sls/loongsuite-pilot"
            })),
            &SerialiseLogEntryOptions::default(),
        );
        assert_eq!(
            out.get("git.repo").map(String::as_str),
            Some("sls/loongsuite-pilot")
        );
        assert_eq!(
            out.get("git.branch").map(String::as_str),
            Some("feature/source-contract")
        );
        assert_eq!(
            out.get("workspace.current_root").map(String::as_str),
            Some("/Users/yutao/workspace/sls/loongsuite-pilot")
        );
    }

    #[test]
    fn omits_optional_message_fields_when_absent() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({})),
            &SerialiseLogEntryOptions::default(),
        );
        assert!(!out.contains_key("gen_ai.input.messages_delta"));
        assert!(!out.contains_key("gen_ai.output.messages"));
    }

    #[test]
    fn omits_legacy_aliases_from_new_output() {
        let out = serialise_log_entry(
            &make_entry(serde_json::json!({
                "session.id": "legacy-session",
                "agent.type": "cursor",
                "usage.input_tokens": 42,
                "tool.arguments": { "legacy": true },
                "gen_ai.message.role": "user",
                "is_error": true,
                "attributes": { "legacy": true }
            })),
            &SerialiseLogEntryOptions::default(),
        );
        assert!(!out.contains_key("session.id"));
        assert!(!out.contains_key("agent.type"));
        assert!(!out.contains_key("usage.input_tokens"));
        assert!(!out.contains_key("tool.arguments"));
        assert!(!out.contains_key("gen_ai.message.role"));
        assert!(!out.contains_key("is_error"));
        assert!(!out.contains_key("attributes"));
    }

    #[test]
    fn removes_file_path_content_and_inline_diff() {
        let mut input = SerializedLogEntry::new();
        input.insert("sessionId".to_string(), "s1".to_string());
        input.insert("uuid".to_string(), "u1".to_string());
        input.insert("filePath".to_string(), "/src/app.ts".to_string());
        input.insert("content".to_string(), "secret code".to_string());
        input.insert("inlineDiffMessage".to_string(), "diff here".to_string());
        input.insert("agentType".to_string(), "qoder".to_string());
        let out = redact_code_generation_fields(&input);
        assert!(!out.contains_key("filePath"));
        assert!(!out.contains_key("content"));
        assert!(!out.contains_key("inlineDiffMessage"));
        assert_eq!(out.get("sessionId").map(String::as_str), Some("s1"));
        assert_eq!(out.get("uuid").map(String::as_str), Some("u1"));
        assert_eq!(out.get("agentType").map(String::as_str), Some("qoder"));
    }

    #[test]
    fn returns_a_new_object_without_mutating_the_original() {
        let mut input = SerializedLogEntry::new();
        input.insert("filePath".to_string(), "/a.ts".to_string());
        input.insert("content".to_string(), "code".to_string());
        input.insert("inlineDiffMessage".to_string(), "diff".to_string());
        input.insert("sessionId".to_string(), "s".to_string());
        let out = redact_code_generation_fields(&input);
        assert_eq!(input.get("filePath").map(String::as_str), Some("/a.ts"));
        assert_eq!(input.get("content").map(String::as_str), Some("code"));
        assert_eq!(
            input.get("inlineDiffMessage").map(String::as_str),
            Some("diff")
        );
        assert!(!out.contains_key("filePath"));
        assert!(!std::ptr::eq(&input, &out));
    }

    #[test]
    fn does_not_alter_output_when_fields_are_already_missing() {
        let mut input = SerializedLogEntry::new();
        input.insert("sessionId".to_string(), "s1".to_string());
        input.insert("uuid".to_string(), "u1".to_string());
        input.insert("agentType".to_string(), "qoder".to_string());
        let mut out = redact_code_generation_fields(&input);
        assert_eq!(out, input);
        out.insert("sessionId".into(), "changed".into());
        assert_eq!(input.get("sessionId").map(String::as_str), Some("s1"));
    }

    #[test]
    fn preserves_all_non_redacted_fields() {
        let mut input = SerializedLogEntry::new();
        for (key, value) in [
            ("sessionId", "s"),
            ("uuid", "u"),
            ("userId", "uid"),
            ("agentType", "qoder"),
            ("actionType", "edit"),
            ("repoId", "repo"),
            ("branchName", "main"),
            ("commitHash", "abc"),
            ("customField", "keep-me"),
            ("filePath", "/remove"),
            ("content", "remove"),
            ("inlineDiffMessage", "remove"),
        ] {
            input.insert(key.to_string(), value.to_string());
        }
        let out = redact_code_generation_fields(&input);
        assert_eq!(out.get("sessionId").map(String::as_str), Some("s"));
        assert_eq!(out.get("uuid").map(String::as_str), Some("u"));
        assert_eq!(out.get("userId").map(String::as_str), Some("uid"));
        assert_eq!(out.get("repoId").map(String::as_str), Some("repo"));
        assert_eq!(out.get("customField").map(String::as_str), Some("keep-me"));
    }
}
