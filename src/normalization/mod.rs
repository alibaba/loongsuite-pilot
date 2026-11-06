//! Normalization of agent activity into the canonical [`AgentActivityEntry`] record.
//!
//! Dotted on-the-wire names (`event.id`, `gen_ai.session.id`, …) are the serde
//! names of [`crate::types::AgentActivityEntry`]. Keys that are not fields of
//! that struct live in [`AgentActivityEntry::extra`].
//!
//! Helpers that need git or the filesystem are duplicated in this module. They
//! do not call `crate::utils`.

mod agent_config;
mod agent_input_dual_write;
mod agent_system_map;
mod enrich_git_context;
mod entry_builder;
mod finish_reason;
mod global_attributes;
mod invocation_identity;
mod normalize_messages;
mod openclaw_session_key;
mod source_context;
mod turn_boundary_processor;

pub use agent_config::{is_multimodal_supported_agent, resolve_agent_config, ResolvedAgentConfig};
pub use agent_input_dual_write::{
    derive_agent_input_event_id, expand_agent_input_events, is_input_other_event,
    AGENT_INPUT_EVENT_NAMESPACE,
};
pub use agent_system_map::{resolve_agent_system, AGENT_SYSTEM_MAP};
pub use enrich_git_context::{
    enrich_canonical_entries_with_git, enrich_canonical_entry_with_git, infer_git_context,
    GitContextResult,
};
pub use entry_builder::{
    build_agent_activity_entry, build_from_code_generation_event, infer_provider_name,
    normalize_event_name, normalize_finish_reasons, project_log_entry,
    redact_code_generation_fields, serialise_log_entry, timestamp_to_unix_nanos, to_json_value,
    unix_nanos_to_millis, SerialiseLogEntryOptions,
};
pub use finish_reason::{normalize_finish_reason, VALID_FINISH_REASONS};
pub use global_attributes::{
    is_reserved_key, parse_key_value_attributes, sanitize_attributes, AttrMap,
    GlobalAttributesProvider, DEFAULT_GIT_PASSTHROUGH_KEYS,
};
pub use invocation_identity::{
    apply_invocation_identity, INVOCATION_SESSION_ID_FIELD, INVOCATION_USER_ID_FIELD,
};
pub use normalize_messages::{
    normalize_input_messages, normalize_input_messages_delta, normalize_output_messages,
};
pub use openclaw_session_key::{
    is_openclaw_session_key, OPENCLAW_SESSION_KEY, OPENCLAW_SESSION_KEY_AMBIGUOUS,
};
pub use source_context::{
    collect_absolute_path_values, normalize_domain, normalize_source_context, pick_first_value,
    read_record_path, source_fields_from_context, NormalizedSourceContext, SourceContextInput,
};
pub use turn_boundary_processor::{is_terminal_turn_entry, TurnBoundaryProcessor};

use crate::types::AgentActivityEntry;
use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// Serialize an entry to its on-the-wire object.
///
/// Empty `String` fields that serde skips (`user.id`, `event.id`, …) are absent
/// here. JavaScript keeps an explicit empty string. Optional `None` matches a
/// missing JavaScript property.
pub(crate) fn entry_to_object(entry: &AgentActivityEntry) -> Map<String, Value> {
    match serde_json::to_value(entry) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub(crate) fn entry_from_map(map: Map<String, Value>) -> AgentActivityEntry {
    match serde_json::from_value(Value::Object(map)) {
        Ok(entry) => entry,
        Err(err) => {
            tracing::warn!(error = %err, "activity entry JSON did not match AgentActivityEntry");
            AgentActivityEntry::default()
        }
    }
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Fixture helper shared by ported vitest cases. Field defaults follow
/// `tests/helpers/fixture-builder.ts` `buildTestEntry`.
#[cfg(test)]
pub(crate) fn build_test_entry(overrides: &Value) -> AgentActivityEntry {
    use uuid::Uuid;

    let obj = overrides.as_object();
    let timestamp = obj
        .and_then(|map| map.get("timestamp"))
        .and_then(value_as_i64)
        .unwrap_or_else(now_millis);
    let nanos = format!("{timestamp}000000");
    let mut map = Map::new();
    map.insert("time_unix_nano".to_string(), Value::String(nanos.clone()));
    map.insert("observed_time_unix_nano".to_string(), Value::String(nanos));
    map.insert(
        "event.id".to_string(),
        Value::String(Uuid::new_v4().to_string()),
    );
    map.insert("event.name".to_string(), Value::String("other".to_string()));
    map.insert(
        "user.id".to_string(),
        Value::String("test-user".to_string()),
    );
    map.insert(
        "gen_ai.session.id".to_string(),
        Value::String("test-session-1".to_string()),
    );
    map.insert(
        "gen_ai.agent.type".to_string(),
        Value::String("qoder".to_string()),
    );
    map.insert(
        "gen_ai.provider.name".to_string(),
        Value::String("unknown".to_string()),
    );
    map.insert(
        "agent.file_path".to_string(),
        Value::String("/tmp/test/file.ts".to_string()),
    );
    map.insert(
        "agent.action_type".to_string(),
        Value::String("edit".to_string()),
    );

    let Some(overrides) = obj else {
        return entry_from_map(map);
    };

    if let Some(value) = overrides.get("userId") {
        map.insert("user.id".to_string(), value.clone());
    }
    if let Some(value) = overrides.get("sessionId") {
        map.insert("gen_ai.session.id".to_string(), value.clone());
    }
    if let Some(value) = overrides.get("uuid") {
        map.insert("event.id".to_string(), value.clone());
    }
    if let Some(value) = overrides.get("agentType") {
        map.insert("gen_ai.agent.type".to_string(), value.clone());
    }
    if let Some(value) = overrides.get("filePath") {
        map.insert("agent.file_path".to_string(), value.clone());
    }
    if let Some(value) = overrides.get("actionType") {
        map.insert("agent.action_type".to_string(), value.clone());
    }
    if let Some(value) = overrides.get("content") {
        map.insert("content".to_string(), value.clone());
    }
    if let Some(value) = overrides.get("inlineDiffMessage") {
        map.insert("inlineDiffMessage".to_string(), value.clone());
    }
    if let Some(Value::Object(extra)) = overrides.get("extra") {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
    if let Some(Value::Object(attributes)) = overrides.get("attributes") {
        for (key, value) in attributes {
            map.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in overrides {
        map.insert(key.clone(), value.clone());
    }
    entry_from_map(map)
}

#[cfg(test)]
fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
        .or_else(|| {
            value.as_f64().and_then(|n| {
                if n.is_finite() && n.fract() == 0.0 {
                    Some(n as i64)
                } else {
                    None
                }
            })
        })
}
