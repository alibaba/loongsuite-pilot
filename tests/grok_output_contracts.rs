use async_trait::async_trait;
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

type Captured = Arc<Mutex<Vec<ReadableSpan>>>;
struct Exporter(Captured);
#[async_trait]
impl TraceExporter for Exporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/grok-output-frozen-fixtures.json")).unwrap()
}
fn records(name: &str) -> Vec<AgentActivityEntry> {
    serde_json::from_value(fixture()[name].clone()).unwrap()
}
fn flusher(root: &Path, captured: Captured) -> OtlpTraceFlusher {
    let config: OtlpTraceFlusherConfig = serde_json::from_value(json!({
        "enabled":true,"protocol":"http/protobuf","serviceName":"grok-unit",
        "dataDir":root,"turnIdleTimeoutMs":0,
        "endpoints":[{"name":"test","endpoint":"http://unused:4318"}]
    }))
    .unwrap();
    OtlpTraceFlusher::with_parts(
        config,
        None,
        Some(Arc::new(move |_| {
            Arc::new(Exporter(captured.clone())) as Arc<dyn TraceExporter>
        })),
        None,
    )
    .unwrap()
}
async fn exported(records: Vec<AgentActivityEntry>) -> Vec<ReadableSpan> {
    let root = tempfile::tempdir().unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let flusher = flusher(root.path(), captured.clone());
    flusher.send_batch(records, None).await.unwrap();
    flusher.shutdown().await.unwrap();
    let spans = captured.lock().unwrap().clone();
    spans
}
fn of_kind<'a>(spans: &'a [ReadableSpan], kind: &str) -> Vec<&'a ReadableSpan> {
    spans
        .iter()
        .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!(kind)))
        .collect()
}
#[tokio::test]
async fn grok_reconstruction_scopes_original_attributes_duration_and_system_content_to_the_right_spans(
) {
    let spans = exported(records("full")).await;
    for (kind, count) in [
        ("ENTRY", 1),
        ("AGENT", 1),
        ("STEP", 2),
        ("LLM", 2),
        ("TOOL", 1),
    ] {
        assert_eq!(of_kind(&spans, kind).len(), count, "{kind}");
    }
    let agent = of_kind(&spans, "AGENT")[0];
    assert_eq!(
        agent.attributes["gen_ai.agent.description"],
        "Grok Build coding agent"
    );
    assert_eq!(agent.attributes["gen_ai.data_source.id"], "grok-build");
    assert_eq!(
        agent.resource_attributes.as_ref().unwrap()["gen_ai.agent.system"],
        "grok"
    );
    let mut llms = of_kind(&spans, "LLM");
    llms.sort_by_key(|span| span.start_time);
    assert_eq!(
        llms.iter()
            .filter(|span| span.attributes.contains_key("gen_ai.system_instructions"))
            .count(),
        1
    );
    assert!(llms[0].attributes["gen_ai.system_instructions"]
        .as_str()
        .unwrap()
        .contains("SYSTEM-CONTENT"));
    for span in &spans {
        if span.attributes["gen_ai.span.kind"] != "LLM" {
            assert!(!span.attributes.contains_key("gen_ai.system_instructions"));
        }
        assert!(!span
            .attributes
            .get("gen_ai.input.messages")
            .map(Value::to_string)
            .unwrap_or_default()
            .contains("SYSTEM-CONTENT"));
    }
    let tool = of_kind(&spans, "TOOL")[0];
    assert_eq!(
        tool.attributes["gen_ai.tool.call.duration"].as_i64(),
        Some(125)
    );
    assert_eq!(tool.attributes["loongsuite.grok.match.strategy"], "id");
    assert_eq!(tool.attributes["loongsuite.grok.timing.source"], "unified");
    assert_eq!(tool.status["code"], 2);
    assert_eq!(tool.attributes["error.type"], "ToolError");
    assert_eq!(tool.attributes["error.message"], "tool execution failed");
    for span in spans
        .iter()
        .filter(|span| span.attributes["gen_ai.span.kind"] != "TOOL")
    {
        assert!(!span.attributes.contains_key("gen_ai.tool.call.duration"));
    }
    let entry = of_kind(&spans, "ENTRY")[0];
    let millis = entry.duration[0] as f64 * 1000.0 + entry.duration[1] as f64 / 1_000_000.0;
    assert!((millis - 7000.0).abs() < 0.001, "actual duration {millis}");
    let zero = exported(records("zero")).await;
    let tool = of_kind(&zero, "TOOL")[0];
    assert!(!tool.attributes.contains_key("gen_ai.tool.call.duration"));
    assert_ne!(tool.status["code"], 2);
}
#[tokio::test]
async fn grok_cancellation_classified_llm_error_and_prompt_only_failure_preserve_the_original_status_scope(
) {
    let cancelled = exported(records("cancelled")).await;
    assert_ne!(of_kind(&cancelled, "LLM")[0].status["code"], 2);
    for kind in ["TOOL", "AGENT", "ENTRY"] {
        assert_eq!(of_kind(&cancelled, kind)[0].status["code"], 2, "{kind}");
    }
    assert_eq!(
        of_kind(&cancelled, "AGENT")[0].attributes["error.type"],
        "cancelled"
    );
    assert_eq!(
        of_kind(&cancelled, "TOOL")[0].attributes["error.type"],
        "ToolCancelled"
    );
    let failed = exported(records("failed")).await;
    for kind in ["LLM", "AGENT", "ENTRY"] {
        let span = of_kind(&failed, kind)[0];
        assert_eq!(span.status["code"], 2, "{kind}");
        assert_eq!(span.attributes["error.type"], "rate_limit");
        assert_eq!(span.attributes["error.message"], "model request failed");
    }
    let prompt = exported(records("promptOnly")).await;
    assert!(of_kind(&prompt, "LLM").is_empty());
    for kind in ["AGENT", "ENTRY"] {
        let span = of_kind(&prompt, kind)[0];
        assert_eq!(span.status["code"], 2, "{kind}");
        assert_eq!(span.attributes["error.type"], "network_error");
    }
}
#[tokio::test]
async fn grok_incremental_records_wait_for_the_explicit_other_terminal_before_export() {
    let root = tempfile::tempdir().unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let flusher = flusher(root.path(), captured.clone());
    let mut records = records("sequential");
    let terminal = records.pop().unwrap();
    for record in records {
        flusher.send(record, None).await.unwrap();
    }
    assert!(captured.lock().unwrap().is_empty());
    flusher.send(terminal, None).await.unwrap();
    flusher.flush().await.unwrap();
    {
        let spans = captured.lock().unwrap();
        assert_eq!(of_kind(&spans, "ENTRY").len(), 1);
        assert_eq!(of_kind(&spans, "TOOL").len(), 1);
    }
    flusher.shutdown().await.unwrap();
}
