//! Original f84 hybrid fixtures through the real parser and final OTLP converter.
use super::interaction_parser::parse_interactions;
use crate::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct Capture(Mutex<Vec<ReadableSpan>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
fn fixture(name: &str) -> Value {
    serde_json::from_str(match name {
        "tools" => include_str!("../../../tests/fixtures/copilot/tool-conversation.json"),
        "two" => include_str!("../../../tests/fixtures/copilot/main-hybrid-two-conversations.json"),
        _ => include_str!("../../../tests/fixtures/copilot/conversation.json"),
    })
    .unwrap()
}
fn kind(span: &ReadableSpan) -> &str {
    span.attributes
        .get("gen_ai.span.kind")
        .and_then(Value::as_str)
        .unwrap()
}
fn messages(span: &ReadableSpan) -> Value {
    let raw = &span.attributes["gen_ai.input.messages"];
    match raw.as_str() {
        Some(raw) => serde_json::from_str(raw).unwrap(),
        None => raw.clone(),
    }
}
async fn export(
    fixture: &Value,
    source: bool,
) -> (Vec<ReadableSpan>, Vec<crate::types::AgentActivityEntry>) {
    let root = tempfile::tempdir().unwrap();
    let batches = parse_interactions(
        fixture["events"].as_array().unwrap(),
        fixture["spans"].as_array().unwrap(),
        true,
    );
    let mut rows: Vec<_> = batches
        .into_iter()
        .flat_map(|batch| batch.records)
        .collect();
    if source {
        for row in &mut rows {
            let mut fields = crate::normalization::entry_to_object(row);
            fields.insert(
                "gen_ai.copilot.telemetry.source".into(),
                json!("native-otel"),
            );
            *row = crate::normalization::entry_from_map(fields);
        }
    }
    let cfg = serde_json::from_value(
        json!({"enabled":true,"protocol":"http/protobuf","serviceName":"test",
        "dataDir":root.path(),"turnIdleTimeoutMs":0,
        "endpoints":[{"name":"test","endpoint":"http://unused:4318"}]}),
    )
    .unwrap();
    let capture = Arc::new(Capture::default());
    let out = capture.clone();
    let flusher =
        OtlpTraceFlusher::with_parts(cfg, None, Some(Arc::new(move |_| out.clone())), None)
            .unwrap();
    flusher.send_batch(rows.clone(), None).await.unwrap();
    flusher.shutdown().await.unwrap();
    let spans = capture.0.lock().unwrap().clone();
    (spans, rows)
}
#[tokio::test]
async fn main_l8_real_parser_reconstructs_deltas_preserving_roots_tool_results_and_two_call_usage()
{
    let (spans, _) = export(&fixture("tools"), false).await;
    assert_eq!(
        spans
            .iter()
            .map(|span| &span.trace_id)
            .collect::<HashSet<_>>()
            .len(),
        1
    );
    let mut llms: Vec<_> = spans.iter().filter(|span| kind(span) == "LLM").collect();
    llms.sort_by_key(|span| span.start_time);
    assert_eq!(llms.len(), 2);
    for (index, expected) in [vec!["user"], vec!["user", "assistant", "tool"]]
        .iter()
        .enumerate()
    {
        let input = messages(llms[index]);
        assert_eq!(
            input
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            *expected
        );
    }
    for root in spans
        .iter()
        .filter(|s| matches!(kind(s), "ENTRY" | "AGENT"))
    {
        assert_eq!(
            messages(root),
            json!([{"role":"user","parts":[{"type":"text","content":"Read the sample."}]}])
        );
    }
    let agent = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
    assert_eq!(agent.attributes["gen_ai.usage.input_tokens"], 200);
    assert_eq!(spans.iter().filter(|s| kind(s) == "TOOL").count(), 1);
}
#[tokio::test]
async fn main_l24_two_interactions_export_separate_traces_exact_usage_and_no_summary_trace() {
    let (spans, rows) = export(&fixture("two"), true).await;
    assert_eq!(
        spans
            .iter()
            .map(|s| &s.trace_id)
            .collect::<HashSet<_>>()
            .len(),
        2
    );
    let llms: Vec<_> = spans.iter().filter(|s| kind(s) == "LLM").collect();
    assert_eq!(llms.len(), 2);
    for llm in llms {
        assert_eq!(llm.attributes["gen_ai.usage.input_tokens"], 100);
        assert_eq!(llm.attributes["gen_ai.usage.output_tokens"], 10);
        assert!(llm.duration[0] as f64 + llm.duration[1] as f64 / 1e9 > 0.0);
    }
    let second_trace = rows
        .iter()
        .find(|r| r.get("gen_ai.copilot.interaction.id") == Some(&json!("interaction-b")))
        .unwrap()
        .trace_id
        .as_deref()
        .unwrap();
    for root in spans
        .iter()
        .filter(|s| matches!(kind(s), "ENTRY" | "AGENT"))
    {
        assert_eq!(
            root.attributes["gen_ai.copilot.telemetry.source"],
            "native-otel"
        );
        let prompt = if root.trace_id == second_trace {
            "Second prompt."
        } else {
            "Read the sample."
        };
        assert_eq!(
            messages(root),
            json!([{"role":"user","parts":[{"type":"text","content":prompt}]}])
        );
    }
    let agents: Vec<_> = spans.iter().filter(|s| kind(s) == "AGENT").collect();
    assert_eq!(agents.len(), 2);
    for agent in agents {
        assert_eq!(agent.attributes["gen_ai.usage.input_tokens"], 100);
    }
}
#[tokio::test]
async fn main_l40_current_interaction_prompts_keep_original_order_and_one_step() {
    let mut fixture = fixture("single");
    fixture["events"].as_array_mut().unwrap().insert(2,json!({"type":"user.message","id":"follow-up",
        "timestamp":"2026-09-01T00:00:01.500Z","data":{"interactionId":"interaction-a","content":"Also explain it."}}));
    let (spans, _) = export(&fixture, false).await;
    let roots: Vec<_> = spans
        .iter()
        .filter(|s| matches!(kind(s), "ENTRY" | "AGENT"))
        .collect();
    assert_eq!(roots.len(), 2);
    for root in roots {
        let input = messages(root);
        assert_eq!(
            input
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["parts"][0]["content"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["Read the sample.", "Also explain it."]
        );
    }
    assert_eq!(spans.iter().filter(|s| kind(s) == "STEP").count(), 1);
}
