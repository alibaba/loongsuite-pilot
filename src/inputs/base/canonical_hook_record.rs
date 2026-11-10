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

#[cfg(test)]
std::thread_local! {
    static SAFE_CUSTOM_ENTRY_MAP_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn attach_safe_custom_top_level_fields(
    entry: &mut AgentActivityEntry,
    record: &Map<String, Value>,
) {
    use super::entry_map::{entry_from, entry_map};
    let mut map = None;
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
        let map = map.get_or_insert_with(|| {
            #[cfg(test)]
            SAFE_CUSTOM_ENTRY_MAP_CALLS.with(|calls| calls.set(calls.get() + 1));
            entry_map(entry)
        });
        if !map.contains_key(key) {
            map.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    if let Some(map) = map {
        *entry = entry_from(map);
    }
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

#[cfg(test)]
mod lazy_custom_field_tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> AgentActivityEntry {
        build_agent_activity_entry(&json!({
            "event.id":"fixed", "event.name":"llm.response", "user.id":"fixture",
            "time_unix_nano":"1794270000000000000",
            "observed_time_unix_nano":"1794270000001000000",
            "gen_ai.agent.type":"qoder-cli", "gen_ai.session.id":"session",
            "gen_ai.provider.name":"qwen", "gen_ai.response.model":"qwen-coder",
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"x".repeat(8192)}]}],
            "agent.opaque":{"z":false,"a":[18446744073709551615u64,null]}
        }))
    }
    fn attach(entry: &mut AgentActivityEntry, record: Value) -> usize {
        SAFE_CUSTOM_ENTRY_MAP_CALLS.with(|calls| calls.set(0));
        attach_safe_custom_top_level_fields(entry, record.as_object().unwrap());
        SAFE_CUSTOM_ENTRY_MAP_CALLS.with(std::cell::Cell::get)
    }

    #[test]
    fn no_custom_fields_do_not_materialize_entry_map() {
        let mut entry = fixture();
        let before = serde_json::to_vec(&entry).unwrap();
        let record = serde_json::to_value(&entry).unwrap();
        assert_eq!(attach(&mut entry, record), 0);
        assert_eq!(serde_json::to_vec(&entry).unwrap(), before);
    }

    #[test]
    fn rejected_custom_fields_do_not_materialize_entry_map() {
        let mut entry = fixture();
        let before = serde_json::to_vec(&entry).unwrap();
        assert_eq!(
            attach(
                &mut entry,
                json!({
                    "":"empty key", " ":"blank key", "bad,key":"x", "bad=key":"x",
                    " API_KEY ":"sensitive", "access_token":"sensitive", "password":"sensitive",
                    "vendor.empty":"", "vendor.blank":"  ", "vendor.comma":"x,y",
                    "vendor.too_long":"中".repeat(513), "vendor.object":{"unknown":true},
                    "vendor.array":[1], "vendor.null":null, "vendor.bool":false,
                    "vendor.number":0, " gen_ai.request.model ":"cannot override"
                })
            ),
            0
        );
        assert_eq!(serde_json::to_vec(&entry).unwrap(), before);
    }

    #[test]
    fn legal_custom_fields_materialize_once_and_preserve_order_and_payload() {
        let mut entry = fixture();
        let before = serde_json::to_value(&entry).unwrap();
        let old_keys = entry.extra.keys().cloned().collect::<Vec<_>>();
        let max = "中".repeat(512);
        assert_eq!(
            attach(
                &mut entry,
                json!({
                    " vendor.z ":" first ", "vendor.a":"second", "vendor.max":max,
                    "vendor.array":["reject"], "TOKEN":"reject"
                })
            ),
            1
        );
        assert_eq!(entry.extra["vendor.z"], "first");
        assert_eq!(entry.extra["vendor.a"], "second");
        assert_eq!(entry.extra["vendor.max"], max);
        let mut expected_keys = old_keys;
        expected_keys.extend(["vendor.z".into(), "vendor.a".into(), "vendor.max".into()]);
        assert_eq!(
            entry.extra.keys().cloned().collect::<Vec<_>>(),
            expected_keys
        );
        let mut after = serde_json::to_value(&entry).unwrap();
        for key in ["vendor.z", "vendor.a", "vendor.max"] {
            after.as_object_mut().unwrap().shift_remove(key);
        }
        assert_eq!(
            serde_json::to_vec(&after).unwrap(),
            serde_json::to_vec(&before).unwrap()
        );
    }

    #[test]
    fn trimmed_collisions_keep_existing_value_and_original_order() {
        let mut entry = fixture();
        entry
            .extra
            .insert("vendor.existing".into(), json!({"z":2,"a":1}));
        let before = serde_json::to_vec(&entry).unwrap();
        assert_eq!(
            attach(&mut entry, json!({" vendor.existing ":"must not replace"})),
            1
        );
        assert_eq!(serde_json::to_vec(&entry).unwrap(), before);
    }
}
