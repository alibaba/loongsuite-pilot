//! Native Codex turn conversion: work identity belongs to the operation that
//! proved it, while delegated turns attach through a unanimous external context.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::event_log_converter::valid_id;
use super::{ConvertOptions, ConvertResult, EventLogConverter};
use crate::types::{AgentActivityEntry, AgentEventName};

const WORK_KEYS: &[&str] = &[
    "gen_ai.agent.id",
    "gen_ai.agent.scope",
    "gen_ai.agent.depth",
    "gen_ai.agent.parent.id",
    "gen_ai.agent.parent.invocation.id",
    "gen_ai.subagent.parent_tool_call.id",
];
const OUTGOING_KEYS: &[&str] = &["gen_ai.agent.invocation.id", "gen_ai.agent.peer.id"];

fn stable_id(parts: &[&str]) -> String {
    hex::encode(Sha256::digest(parts.join("\0").as_bytes()))[..16].to_owned()
}

fn context_value<'a>(record: &'a AgentActivityEntry, key: &str) -> Option<Cow<'a, Value>> {
    // Flattened extra fields follow typed fields in the serialized entry, so
    // preserve their precedence while projecting only the requested metadata.
    if let Some(value) = record.extra.get(key) {
        return Some(Cow::Borrowed(value));
    }
    match key {
        "gen_ai.agent.id" => record.agent_id.as_ref(),
        "gen_ai.step.id" => record.step_id.as_ref(),
        _ => None,
    }
    .map(|value| Cow::Owned(Value::String(value.clone())))
}

fn consensus(records: &[&AgentActivityEntry], keys: &[&str]) -> Map<String, Value> {
    let mut fields = Map::new();
    if let Some(first) = records.first() {
        for &key in keys {
            if let Some(value) = context_value(first, key) {
                if records
                    .iter()
                    .all(|record| context_value(record, key).as_deref() == Some(value.as_ref()))
                {
                    fields.insert(key.to_owned(), value.into_owned());
                }
            }
        }
    }
    fields
}

fn native_step(record: &AgentActivityEntry) -> &str {
    record
        .step_id
        .as_deref()
        .filter(|step| !step.is_empty())
        .unwrap_or("step:1")
}

pub fn convert_codex_turn(
    records: &[AgentActivityEntry],
    options: &ConvertOptions,
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    if records.is_empty() {
        return Ok(ConvertResult::default());
    }
    let has_delegated_work = records
        .iter()
        .any(|record| record.get("agent.codex.delegated") == Some(&Value::Bool(true)));
    let local: Vec<_> = records
        .iter()
        .map(|record| {
            let mut copy = record.clone();
            copy.extra.remove("gen_ai.agent.scope");
            if has_delegated_work && copy.event_name == Some(AgentEventName::Other) {
                copy.parent_span_id = None;
            }
            copy
        })
        .collect();
    let result = converter.convert(&local, options)?;
    map_codex_spans(records, result)
}

/// Apply native Codex ownership to spans already produced by a converter.
/// Streaming leaves reuse this mapping without cloning their entire turn again.
pub(super) fn map_codex_spans(
    records: &[AgentActivityEntry],
    mut result: ConvertResult,
) -> Result<ConvertResult, String> {
    let Some(first) = records.first() else {
        return Ok(ConvertResult::default());
    };
    let trace = first.trace_id.as_deref().unwrap_or_default();
    let attachment = first
        .get("agent.codex.parent_span_id")
        .and_then(Value::as_str);
    let delegated = valid_id(trace, 32)
        && attachment.is_some_and(|id| valid_id(id, 16))
        && records.iter().all(|record| {
            record.trace_id.as_deref() == Some(trace)
                && record
                    .get("agent.codex.parent_span_id")
                    .and_then(Value::as_str)
                    == attachment
                && record.get("agent.codex.delegated") == Some(&Value::Bool(true))
        });
    let all: Vec<_> = records.iter().collect();
    let work = consensus(&all, WORK_KEYS);
    let raw_turn = first
        .get("agent.codex.transcript_turn_id")
        .and_then(Value::as_str)
        .unwrap_or(first.turn_id.as_deref().unwrap_or("undefined"));
    let entry_id = stable_id(&[&first.session_id, raw_turn, "entry"]);
    let agent_id = stable_id(&[&first.session_id, raw_turn, "agent"]);
    let mut remapped = HashMap::new();
    let mut entries = HashSet::new();
    for span in &mut result.spans {
        let kind = span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let own: Vec<_> = match kind.as_str() {
            "STEP" => {
                let step = span
                    .attributes
                    .get("gen_ai.step.id")
                    .and_then(Value::as_str);
                records
                    .iter()
                    .filter(|record| {
                        record.event_name != Some(AgentEventName::Other)
                            && Some(native_step(record)) == step
                    })
                    .collect()
            }
            "LLM" => {
                let response = span
                    .attributes
                    .get("gen_ai.response.id")
                    .and_then(Value::as_str);
                records
                    .iter()
                    .filter(|record| {
                        matches!(
                            record.event_name,
                            Some(AgentEventName::LlmRequest | AgentEventName::LlmResponse)
                        ) && record.response_id.as_deref() == response
                    })
                    .collect()
            }
            "TOOL" => {
                let call = span
                    .attributes
                    .get("gen_ai.tool.call.id")
                    .and_then(Value::as_str);
                records
                    .iter()
                    .filter(|record| {
                        matches!(
                            record.event_name,
                            Some(AgentEventName::ToolCall | AgentEventName::ToolResult)
                        ) && record.tool_call_id.as_deref() == call
                    })
                    .collect()
            }
            _ => all.clone(),
        };
        let mut attrs = if matches!(kind.as_str(), "ENTRY" | "AGENT") {
            work.clone()
        } else {
            consensus(&own, WORK_KEYS)
        };
        if kind == "TOOL" {
            attrs.extend(consensus(&own, OUTGOING_KEYS));
        }
        if !matches!(kind.as_str(), "ENTRY" | "AGENT") {
            attrs.extend(consensus(&own, &["gen_ai.step.id"]));
        }
        for &key in WORK_KEYS
            .iter()
            .chain(OUTGOING_KEYS)
            .chain(std::iter::once(&"gen_ai.step.id"))
        {
            span.attributes.remove(key);
        }
        span.attributes.extend(attrs);
        let replacement = match kind.as_str() {
            "ENTRY" => Some(entry_id.clone()),
            "AGENT" => Some(agent_id.clone()),
            "STEP" => Some(
                own.iter()
                    .find_map(|record| record.parent_span_id.clone())
                    .unwrap_or_else(|| {
                        stable_id(&[
                            &first.session_id,
                            raw_turn,
                            "step",
                            own.first()
                                .and_then(|record| record.step_id.as_deref())
                                .unwrap_or("undefined"),
                        ])
                    }),
            ),
            _ => None,
        };
        if let Some(id) = replacement {
            remapped.insert(span.span_id.clone(), id.clone());
            if kind == "ENTRY" {
                entries.insert(id.clone());
            }
            span.span_id = id;
        }
    }
    for span in &mut result.spans {
        if let Some(parent) = span.parent_span_id.as_ref().and_then(|id| remapped.get(id)) {
            span.parent_span_id = Some(parent.clone());
        }
        if delegated
            && span
                .parent_span_id
                .as_ref()
                .is_some_and(|id| entries.contains(id))
        {
            span.parent_span_id = attachment.map(str::to_owned);
        }
    }
    if delegated {
        result.spans.retain(|span| !entries.contains(&span.span_id));
    }
    result.span_count = result.spans.len();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flushers::GenAiEventLogConverter;
    use serde_json::json;

    fn event(name: &str, step: &str, time: &str) -> AgentActivityEntry {
        serde_json::from_value(json!({
            "event.name": name, "event.id": format!("{name}:{step}"),
            "time_unix_nano": time, "gen_ai.agent.type": "codex",
            "gen_ai.session.id": "child", "gen_ai.turn.id": "turn",
            "agent.codex.transcript_turn_id": "native-turn",
            "gen_ai.step.id": step, "gen_ai.response.id": step,
            "trace_id": "0123456789abcdef0123456789abcdef",
            "gen_ai.agent.scope": "subagent", "gen_ai.agent.id": "child",
            "gen_ai.agent.parent.invocation.id": "incoming",
            "agent.codex.delegated": true,
            "agent.codex.parent_span_id": "fedcba9876543210"
        }))
        .unwrap()
    }

    #[test]
    fn delegated_turn_has_transparent_entry_and_stable_agent_without_mutating_audit() {
        let mut start = event("llm.request", "s1", "1700000000000000001");
        start.parent_span_id = Some("1111111111111111".into());
        let mut end = event("llm.response", "s1", "1700000000000000002");
        end.parent_span_id = start.parent_span_id.clone();
        let records = vec![start, end];
        let before = serde_json::to_value(&records).unwrap();
        let result = convert_codex_turn(
            &records,
            &ConvertOptions::default(),
            &GenAiEventLogConverter,
        )
        .unwrap();
        assert_eq!(result.span_count, 3);
        let agent = result
            .spans
            .iter()
            .find(|span| span.attributes["gen_ai.span.kind"] == "AGENT")
            .unwrap();
        assert_eq!(agent.span_id, stable_id(&["child", "native-turn", "agent"]));
        assert_eq!(agent.parent_span_id.as_deref(), Some("fedcba9876543210"));
        assert!(result
            .spans
            .iter()
            .any(|span| span.span_id == "1111111111111111"));
        assert_eq!(serde_json::to_value(&records).unwrap(), before);
        assert!(result
            .spans
            .iter()
            .all(|span| span.attributes["gen_ai.agent.scope"] == "subagent"));
    }

    #[test]
    fn conflicting_context_keeps_entry_and_operation_identity_does_not_leak_upward() {
        let mut start = event("tool.call", "s1", "1700000000000000001");
        start.tool_call_id = Some("call".into());
        start
            .extra
            .insert("gen_ai.agent.invocation.id".into(), json!("outgoing"));
        start
            .extra
            .insert("gen_ai.agent.peer.id".into(), json!("other-child"));
        let mut end = start.clone();
        end.event_name = Some(AgentEventName::ToolResult);
        end.time_unix_nano = "1700000000000000002".into();
        end.extra.insert(
            "agent.codex.parent_span_id".into(),
            json!("2222222222222222"),
        );
        let result = convert_codex_turn(
            &[start, end],
            &ConvertOptions::default(),
            &GenAiEventLogConverter,
        )
        .unwrap();
        assert_eq!(result.span_count, 4);
        for span in &result.spans {
            if span.attributes["gen_ai.span.kind"] == "TOOL" {
                assert_eq!(span.attributes["gen_ai.agent.invocation.id"], "outgoing");
            } else {
                assert!(!span.attributes.contains_key("gen_ai.agent.invocation.id"));
                assert!(!span.attributes.contains_key("gen_ai.agent.peer.id"));
            }
        }
    }

    #[test]
    fn mixed_work_metadata_is_consensual_per_step_and_missing_values_do_not_inherit() {
        let mut records = vec![
            event("llm.request", "s1", "1700000000000000001"),
            event("llm.response", "s1", "1700000000000000002"),
            event("llm.request", "s2", "1700000000000000003"),
            event("llm.response", "s2", "1700000000000000004"),
        ];
        records[2].extra.remove("gen_ai.agent.parent.invocation.id");
        records[3].extra.remove("gen_ai.agent.parent.invocation.id");
        let result = convert_codex_turn(
            &records,
            &ConvertOptions::default(),
            &GenAiEventLogConverter,
        )
        .unwrap();
        for span in &result.spans {
            if span
                .attributes
                .get("gen_ai.step.id")
                .and_then(Value::as_str)
                == Some("s1")
            {
                assert_eq!(
                    span.attributes["gen_ai.agent.parent.invocation.id"],
                    "incoming"
                );
            } else {
                assert!(!span
                    .attributes
                    .contains_key("gen_ai.agent.parent.invocation.id"));
            }
        }
    }
}
