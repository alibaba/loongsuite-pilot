//! Adapt copies at the legacy trace converter boundary. Raw audit output keeps
//! its original event names and operation parents.
use crate::normalization::entry_to_object;
use crate::types::{AgentActivityEntry, AgentEventName};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(super) fn is_agent_audit_event(entry: &AgentActivityEntry) -> bool {
    matches!(
        entry.event_name,
        Some(AgentEventName::AgentInvoke | AgentEventName::AgentResult)
    )
}

fn legacy_name(name: Option<AgentEventName>) -> Option<AgentEventName> {
    name.map(|name| match name {
        AgentEventName::ModelRequest => AgentEventName::LlmRequest,
        AgentEventName::ModelResponse => AgentEventName::LlmResponse,
        AgentEventName::GenAiToolCall => AgentEventName::ToolCall,
        AgentEventName::GenAiToolResult => AgentEventName::ToolResult,
        other => other,
    })
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<_, _> = map
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        other => other,
    }
}

pub(super) fn prepare_trace_events(records: &[AgentActivityEntry]) -> Vec<AgentActivityEntry> {
    let names: HashSet<_> = records
        .iter()
        .filter_map(|record| record.event_name)
        .collect();
    let alias_pairs: HashSet<_> = [
        (AgentEventName::ModelRequest, AgentEventName::LlmRequest),
        (AgentEventName::ModelResponse, AgentEventName::LlmResponse),
        (AgentEventName::GenAiToolCall, AgentEventName::ToolCall),
        (AgentEventName::GenAiToolResult, AgentEventName::ToolResult),
    ]
    .into_iter()
    .filter(|(long, short)| names.contains(long) && names.contains(short))
    .map(|(_, short)| short)
    .collect();
    let mut ids = HashSet::new();
    let mut aliases = HashMap::new();
    let mut prepared = Vec::new();
    for record in records {
        if is_agent_audit_event(record) || record.event_name == Some(AgentEventName::AgentInput) {
            continue;
        }
        if !record.event_id.is_empty() && !ids.insert(record.event_id.as_str()) {
            continue;
        }
        let mut normalized = record.clone();
        normalized.event_name = legacy_name(record.event_name);
        if normalized
            .event_name
            .is_some_and(|name| alias_pairs.contains(&name))
        {
            let mut semantic = entry_to_object(&normalized);
            semantic.remove("event.id");
            semantic.remove("observed_time_unix_nano");
            let fingerprint = canonical(Value::Object(semantic)).to_string();
            if aliases
                .get(&fingerprint)
                .is_some_and(|prior| *prior != record.event_name)
            {
                continue;
            }
            aliases.insert(fingerprint, record.event_name);
        }
        prepared.push(normalized);
    }
    prepared
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
    use crate::normalization::build_agent_activity_entry;
    use serde_json::json;

    fn entry(id: &str, name: &str) -> AgentActivityEntry {
        build_agent_activity_entry(&json!({
            "event.id":id,"event.name":name,"time_unix_nano":"1000000","user.id":"fixture-user",
            "gen_ai.agent.type":"cursor","gen_ai.session.id":"fixture-session","gen_ai.turn.id":"fixture-turn",
            "gen_ai.response.id":"fixture-response","gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"你好🚀"}]}],
            "gen_ai.agent.parent.id":"upstream","gen_ai.agent.peer.id":"peer",
            "gen_ai.agent.invocation.id":"outgoing","gen_ai.agent.parent.invocation.id":"incoming"
        }))
    }

    #[test]
    fn standard_names_and_both_invocation_directions_roundtrip_without_legacy_rewriting() {
        for name in [
            "gen_ai.model.request",
            "gen_ai.model.response",
            "gen_ai.tool.call",
            "gen_ai.tool.result",
            "gen_ai.agent.invoke",
            "gen_ai.agent.result",
        ] {
            let raw = entry("standard", name);
            assert_eq!(raw.event_name.unwrap().as_str(), name);
            let encoded = serde_json::to_value(&raw).unwrap();
            for (field, value) in [
                ("gen_ai.agent.parent.id", "upstream"),
                ("gen_ai.agent.peer.id", "peer"),
                ("gen_ai.agent.invocation.id", "outgoing"),
                ("gen_ai.agent.parent.invocation.id", "incoming"),
            ] {
                assert_eq!(encoded[field], value);
            }
            let decoded: AgentActivityEntry = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, raw);
        }
    }

    #[test]
    fn compatibility_copies_normalize_four_aliases_and_omit_audit_and_input_rows() {
        let rows: Vec<_> = [
            "gen_ai.model.request",
            "gen_ai.model.response",
            "gen_ai.tool.call",
            "gen_ai.tool.result",
            "gen_ai.agent.invoke",
            "gen_ai.agent.result",
            "agent.input",
        ]
        .into_iter()
        .enumerate()
        .map(|(i, name)| entry(&format!("id-{i}"), name))
        .collect();
        let before = rows.clone();
        let prepared = prepare_trace_events(&rows);
        assert_eq!(
            prepared
                .iter()
                .map(|row| row.event_name.unwrap().as_str())
                .collect::<Vec<_>>(),
            ["llm.request", "llm.response", "tool.call", "tool.result"]
        );
        assert_eq!(rows, before);
        assert_eq!(
            prepared[0].get("gen_ai.agent.parent.invocation.id"),
            Some(&json!("incoming"))
        );
    }

    #[test]
    fn aliases_deduplicate_semantic_copies_but_preserve_real_stream_fragments() {
        let mut long = entry("long", "gen_ai.model.response");
        long.extra
            .insert("custom.nested".into(), json!({"a":1,"z":{"c":3,"b":2}}));
        let mut short = long.clone();
        short.event_id = "short".into();
        short.event_name = Some(AgentEventName::LlmResponse);
        short.observed_time_unix_nano = Some("2000000".into());
        short
            .extra
            .insert("custom.nested".into(), json!({"z":{"b":2,"c":3},"a":1}));
        let mut fragment = long.clone();
        fragment.event_id = "fragment".into();
        fragment.output_messages =
            Some(json!([{"role":"assistant","parts":[{"type":"text","content":"new content"}]}]));
        let prepared = prepare_trace_events(&[long.clone(), short.clone(), fragment.clone()]);
        assert_eq!(prepared.len(), 2);
        assert_eq!(prepared[0].event_id, "long");
        assert_eq!(prepared[1].event_id, "fragment");
        assert_eq!(prepare_trace_events(&[short, long, fragment]).len(), 2);
    }

    #[test]
    fn same_name_stream_records_are_kept_and_identical_event_ids_are_authoritative() {
        let first = entry("first", "gen_ai.model.response");
        let mut second = first.clone();
        second.event_id = "second".into();
        assert_eq!(
            prepare_trace_events(&[first.clone(), second.clone()]).len(),
            2
        );
        second.event_id = first.event_id.clone();
        second.output_messages = Some(json!([{"role":"assistant","parts":[]}]));
        assert_eq!(prepare_trace_events(&[first, second]).len(), 1);
    }

    #[test]
    fn adapted_standard_model_pair_reaches_real_native_span_conversion() {
        let request = entry("request", "gen_ai.model.request");
        let mut response = entry("response", "gen_ai.model.response");
        response.time_unix_nano = "2000000".into();
        response.input_tokens = Some(100);
        response.output_tokens = Some(20);
        response.finish_reasons = Some(vec!["stop".into()]);
        let records = prepare_trace_events(&[request, response]);
        let converted = GenAiEventLogConverter
            .convert(&records, &ConvertOptions::default())
            .unwrap();
        let llm = converted
            .spans
            .iter()
            .find(|span| span.attributes["gen_ai.span.kind"] == "LLM")
            .unwrap();
        assert_eq!(llm.attributes["gen_ai.usage.input_tokens"], 100);
        assert_eq!(llm.attributes["gen_ai.usage.output_tokens"], 20);
        assert_eq!(
            converted
                .spans
                .iter()
                .filter(|span| span.attributes["gen_ai.span.kind"] == "LLM")
                .count(),
            1
        );
    }
}
