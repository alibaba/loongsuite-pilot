//! Port of `src/inputs/base/canonical-hook-record.ts`.

use crate::normalization::{build_agent_activity_entry, is_reserved_key};
use crate::types::AgentActivityEntry;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

const MAX_CUSTOM_FIELD_VALUE_LENGTH: usize = 512;

static SENSITIVE_FIELD_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$",
    )
    .expect("sensitive field name")
});

const CANONICAL_PREFIXES: &[&str] = &[
    "agent.",
    "error.",
    "gen_ai.",
    "git.",
    "host.",
    "service.",
    "workspace.",
];

const CANONICAL_KEYS: &[&str] = &[
    "event.id",
    "event.name",
    "observed_time_unix_nano",
    "parent_span_id",
    "span_id",
    "time_unix_nano",
    "resourceAttributes",
    "tool.result.status",
    "trace_id",
    "user.id",
    "user.name",
    "user.email",
];

#[derive(Debug, Clone, Copy, Default)]
pub struct CanonicalHookRecordOptions {
    pub preserve_safe_custom_top_level_fields: bool,
}

pub fn build_canonical_hook_entry(
    record: &Map<String, Value>,
    fallback_agent_type: &str,
    attributes: Option<&Map<String, Value>>,
    options: CanonicalHookRecordOptions,
) -> Option<AgentActivityEntry> {
    if !is_canonical_hook_record(record) {
        return None;
    }
    let mut opts = Map::new();
    for (key, raw) in record {
        if !is_canonical_key(key) {
            continue;
        }
        if let Some(value) = to_json_value(raw) {
            opts.insert(key.clone(), value);
        }
    }
    opts.insert(
        "gen_ai.agent.type".to_string(),
        Value::String(
            string_value(record, "gen_ai.agent.type")
                .unwrap_or_else(|| fallback_agent_type.to_owned()),
        ),
    );
    if opts.get("gen_ai.request.model").is_none() {
        opts.insert(
            "gen_ai.request.model".to_string(),
            Value::String("unknown".into()),
        );
    }
    if opts.get("gen_ai.response.model").is_none() {
        let request = opts
            .get("gen_ai.request.model")
            .cloned()
            .unwrap_or_else(|| Value::String("unknown".into()));
        opts.insert("gen_ai.response.model".to_string(), request);
    }
    let mut attributes_obj = Map::new();
    if let Some(attributes) = attributes {
        for (key, raw) in attributes {
            if let Some(value) = to_json_value(raw) {
                attributes_obj.insert(key.clone(), value);
            }
        }
    }
    opts.insert("attributes".to_string(), Value::Object(attributes_obj));
    let mut entry = build_agent_activity_entry(&Value::Object(opts));
    if options.preserve_safe_custom_top_level_fields {
        attach_safe_custom_top_level_fields(&mut entry, record);
    }
    Some(entry)
}

fn attach_safe_custom_top_level_fields(
    entry: &mut AgentActivityEntry,
    record: &Map<String, Value>,
) {
    use super::entry_map::{entry_from, entry_map};
    let mut map = entry_map(entry);
    for (raw_key, raw_value) in record {
        if is_canonical_key(raw_key) {
            continue;
        }
        let key = raw_key.trim();
        if key.is_empty() || key.contains(',') || key.contains('=') || is_reserved_key(key) {
            continue;
        }
        if SENSITIVE_FIELD_NAME_RE.is_match(key) {
            continue;
        }
        let Value::String(raw_text) = raw_value else {
            continue;
        };
        let value = raw_text.trim();
        if value.is_empty()
            || value.chars().count() > MAX_CUSTOM_FIELD_VALUE_LENGTH
            || value.contains(',')
        {
            continue;
        }
        if !map.contains_key(key) {
            map.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    *entry = entry_from(map);
}

fn is_canonical_hook_record(record: &Map<String, Value>) -> bool {
    record.get("event.name").and_then(Value::as_str).is_some()
        && record
            .get("gen_ai.agent.type")
            .and_then(Value::as_str)
            .is_some()
}

fn is_canonical_key(key: &str) -> bool {
    CANONICAL_KEYS.contains(&key)
        || CANONICAL_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

fn string_value(data: &Map<String, Value>, key: &str) -> Option<String> {
    match data.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

fn to_json_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_) => Some(value.clone()),
        Value::Array(items) => Some(Value::Array(
            items.iter().filter_map(to_json_value).collect(),
        )),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, raw) in map {
                if let Some(json) = to_json_value(raw) {
                    out.insert(key.clone(), json);
                }
            }
            Some(Value::Object(out))
        }
    }
}
