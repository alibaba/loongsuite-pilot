//! Frozen baseline contracts through the production native converter.
use loongsuite_pilot::flushers::{
    ConvertOptions, EventLogConverter, GenAiEventLogConverter, ReadableSpan,
};
use loongsuite_pilot::types::{AgentActivityEntry, AgentEventName};
use serde_json::{json, Value};
use std::collections::HashSet;

const RESERVED: &str = "d0d0d0d0d0d0d0d0";
fn turn(response: Option<&str>, span: &str, step: &str) -> Vec<AgentActivityEntry> {
    let mut rows = vec![
        json!({
            "event.id":"e-other","event.name":"other",
            "time_unix_nano":"1700000000000000000",
            "span_id":"a1a1a1a1a1a1a1a1",
            "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"hi"}]}]
        }),
        json!({
            "event.id":"e-request","event.name":"llm.request",
            "time_unix_nano":"1700000000001000000",
            "gen_ai.step.id":step,"span_id":span,
            "parent_span_id":"c3c3c3c3c3c3c3c3","gen_ai.request.model":"claude"
        }),
        json!({
            "event.id":"e-response","event.name":"llm.response",
            "time_unix_nano":"1700000000002000000",
            "gen_ai.step.id":step,"span_id":span,
            "parent_span_id":"c3c3c3c3c3c3c3c3",
            "gen_ai.request.model":"claude","gen_ai.response.model":"claude",
            "gen_ai.response.finish_reasons":["stop"],
            "gen_ai.usage.input_tokens":10,"gen_ai.usage.output_tokens":20
        }),
    ];
    for row in &mut rows {
        let map = row.as_object_mut().unwrap();
        for (key, value) in [
            ("trace_id", "4bf92f3577b34da6a3ce929d0e0e4736"),
            ("gen_ai.session.id", "ses_llm_reservation"),
            ("gen_ai.turn.id", "ses_llm_reservation:t1"),
            ("gen_ai.agent.type", "claude-code"),
            ("gen_ai.provider.name", "anthropic"),
        ] {
            map.insert(key.into(), json!(value));
        }
        if map["event.name"] != "other" {
            if let Some(id) = response {
                map.insert("gen_ai.response.id".into(), json!(id));
            }
        }
    }
    rows.into_iter()
        .map(|row| serde_json::from_value(row).unwrap())
        .collect()
}
fn convert(rows: &[AgentActivityEntry]) -> Vec<ReadableSpan> {
    GenAiEventLogConverter
        .convert(
            rows,
            &ConvertOptions {
                strict: false,
                passthrough_keys: Vec::new(),
            },
        )
        .unwrap()
        .spans
}
fn llm(spans: &[ReadableSpan]) -> Vec<&ReadableSpan> {
    spans
        .iter()
        .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
        .collect()
}
#[test]
fn real_converter_exports_the_llm_under_the_reserved_gateway_parent_id() {
    let spans = convert(&turn(Some("msg_reserved"), RESERVED, "step:1"));
    let model = llm(&spans);
    assert_eq!(model.len(), 1);
    assert_eq!(model[0].span_id, RESERVED);
}
#[test]
fn every_non_llm_span_has_its_own_unreserved_id() {
    let spans = convert(&turn(Some("msg_reserved"), RESERVED, "step:1"));
    let others: Vec<_> = spans
        .iter()
        .filter(|span| span.attributes.get("gen_ai.span.kind") != Some(&json!("LLM")))
        .collect();
    assert!(!others.is_empty());
    let ids: HashSet<_> = others.iter().map(|span| span.span_id.as_str()).collect();
    assert_eq!(ids.len(), others.len());
    assert!(!ids.contains(RESERVED));
}
#[test]
fn no_response_identity_cannot_reserve_a_gateway_parent_id() {
    let spans = convert(&turn(None, RESERVED, "step:1"));
    let model = llm(&spans);
    assert_eq!(model.len(), 1);
    assert_ne!(model[0].span_id, RESERVED);
}
#[test]
fn invalid_zero_reservation_is_replaced_by_a_valid_native_id() {
    let spans = convert(&turn(Some("msg_reserved"), "0000000000000000", "step:1"));
    let model = llm(&spans);
    assert_eq!(model.len(), 1);
    let id = &model[0].span_id;
    assert_ne!(id, "0000000000000000");
    assert_eq!(id.len(), 16);
    assert!(id
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
}
#[test]
fn reservation_does_not_leak_to_the_next_unrelated_llm() {
    let mut rows = turn(Some("msg_a"), RESERVED, "step:1");
    let second = turn(Some("msg_b"), "not-a-span-id", "step:2");
    rows.extend(
        second
            .into_iter()
            .filter(|row| row.event_name != Some(AgentEventName::Other))
            .enumerate()
            .map(|(index, mut row)| {
                row.event_id = format!("e-second-{index}");
                row
            }),
    );
    let spans = convert(&rows);
    let model = llm(&spans);
    assert_eq!(model.len(), 2);
    let id = |response: &str| {
        model
            .iter()
            .find(|span| {
                span.attributes.get("gen_ai.response.id") == Some(&Value::String(response.into()))
            })
            .unwrap()
            .span_id
            .as_str()
    };
    assert_eq!(id("msg_a"), RESERVED);
    assert_ne!(id("msg_b"), RESERVED);
}
