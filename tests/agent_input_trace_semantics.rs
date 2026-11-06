use async_trait::async_trait;
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use loongsuite_pilot::normalization::expand_agent_input_events;
use loongsuite_pilot::types::{AgentActivityEntry, AgentEventName, OtlpTraceFlusherConfig};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

struct CapturingExporter(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait]
impl TraceExporter for CapturingExporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
fn records() -> Vec<AgentActivityEntry> {
    let common = json!({
        "user.id": "user-1", "gen_ai.session.id": "session-1", "gen_ai.turn.id": "turn-1",
        "gen_ai.agent.type": "claude-code", "gen_ai.provider.name": "anthropic"
    });
    [
        json!({
            "time_unix_nano":"1700000000000000000", "event.id":"input-other", "event.name":"other",
            "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"hello"}]}]
        }),
        json!({
            "time_unix_nano":"1700000000100000000", "event.id":"request", "event.name":"llm.request",
            "gen_ai.step.id":"step-1", "gen_ai.response.id":"response-1", "gen_ai.request.model":"claude-test",
            "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"hello"}]}]
        }),
        json!({
            "time_unix_nano":"1700000001000000000", "event.id":"response", "event.name":"llm.response",
            "gen_ai.step.id":"step-1", "gen_ai.response.id":"response-1", "gen_ai.response.model":"claude-test",
            "gen_ai.response.finish_reasons":["stop"],
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"world"}]}]
        })
    ].into_iter().map(|fields| {
        let mut record=common.as_object().unwrap().clone();
        record.extend(fields.as_object().unwrap().clone());
        serde_json::from_value(Value::Object(record)).unwrap()
    }).collect()
}
async fn converted(root: &Path, records: Vec<AgentActivityEntry>) -> Vec<ReadableSpan> {
    let config: OtlpTraceFlusherConfig=serde_json::from_value(json!({
        "enabled":true,"endpoints":[{"name":"primary","endpoint":"http://unused:4318/v1/traces","headers":{}}],
        "protocol":"http/protobuf","serviceName":"agent-input-dual-write-test",
        "debug":false,"turnIdleTimeoutMs":0,"dataDir":root
    })).unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let sink = captured.clone();
    let flusher = OtlpTraceFlusher::with_parts(
        config,
        None,
        Some(Arc::new(move |_| {
            Arc::new(CapturingExporter(sink.clone())) as Arc<dyn TraceExporter>
        })),
        None,
    )
    .unwrap();
    flusher.send_batch(records, None).await.unwrap();
    flusher.shutdown().await.unwrap();
    let spans = captured.lock().unwrap().clone();
    spans
}
fn snapshot(spans: &[ReadableSpan]) -> Vec<Value> {
    let kinds: HashMap<_, _> = spans
        .iter()
        .map(|span| {
            (
                span.span_id.as_str(),
                span.attributes
                    .get("gen_ai.span.kind")
                    .and_then(Value::as_str)
                    .unwrap_or("UNKNOWN"),
            )
        })
        .collect();
    let mut result: Vec<_> = spans
        .iter()
        .map(|span| {
            let attributes: BTreeMap<_, _> = span
                .attributes
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            json!({
                "name":span.name,
                "kind":kinds[span.span_id.as_str()],
                "parentKind":span.parent_span_id.as_deref().and_then(|id|kinds.get(id)),
                "attributes":attributes
            })
        })
        .collect();
    result.sort_by_key(|span| {
        format!(
            "{}:{}",
            span["kind"].as_str().unwrap(),
            span["name"].as_str().unwrap()
        )
    });
    result
}
#[tokio::test]
async fn actual_flusher_and_real_converter_keep_span_semantics_when_agent_input_is_dual_written() {
    let root = tempfile::tempdir().unwrap();
    let legacy = records();
    let expanded = expand_agent_input_events(legacy.clone());
    assert_eq!(
        expanded
            .iter()
            .map(|record| record.event_name)
            .collect::<Vec<_>>(),
        [
            Some(AgentEventName::Other),
            Some(AgentEventName::AgentInput),
            Some(AgentEventName::LlmRequest),
            Some(AgentEventName::LlmResponse)
        ]
    );
    let legacy = converted(root.path(), legacy).await;
    let expanded = converted(root.path(), expanded).await;
    assert!(!legacy.is_empty());
    assert_eq!(expanded.len(), legacy.len());
    assert_eq!(snapshot(&expanded), snapshot(&legacy));
    for kind in ["ENTRY", "AGENT"] {
        assert_eq!(
            expanded
                .iter()
                .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!(kind)))
                .count(),
            1
        );
    }
    assert_eq!(
        expanded
            .iter()
            .map(|span| &span.span_id)
            .collect::<HashSet<_>>()
            .len(),
        expanded.len()
    );
}
