//! Exact new main533 Qoder final-output contracts plus its documented grouping edges.
use super::super::event_log_converter::GenAiEventLogConverter;
use super::*;
use crate::normalization::entry_from_map;

const TRACE: &str = "1234567890abcdef1234567890abcdef";
const UPSTREAM: &str = "abcdef1234567890";
const TYPES: [&str; 4] = ["qoder", "qoder-cli", "qoder-cn", "qoder-idea"];
fn records(agent: &str, parent: Option<&str>) -> Vec<AgentActivityEntry> {
    let mut rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/main533/qoder-turn-records.json"
    ))
    .unwrap();
    for row in &mut rows {
        row["gen_ai.agent.type"] = Value::String(agent.into());
    }
    if let Some(parent) = parent {
        rows[0]["parent_span_id"] = Value::String(parent.into());
    }
    rows.into_iter()
        .map(|v| entry_from_map(v.as_object().unwrap().clone()))
        .collect()
}
struct Capture(Mutex<Vec<ReadableSpan>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
async fn flush(rows: Vec<AgentActivityEntry>) -> Vec<ReadableSpan> {
    let root = tempfile::tempdir().unwrap();
    let config:OtlpTraceFlusherConfig=serde_json::from_value(serde_json::json!({
        "enabled":true,"serviceName":"qoder-root-test","dataDir":root.path(),"protocol":"http/protobuf",
        "endpoints":[{"name":"test","endpoint":"http://localhost:4318/v1/traces","headers":{}}]
    })).unwrap();
    let capture = Arc::new(Capture(Mutex::new(Vec::new())));
    let output = capture.clone();
    let factory: ExporterFactory = Arc::new(move |_| output.clone());
    let flusher = OtlpTraceFlusher::with_parts(config, None, Some(factory), None).unwrap();
    flusher.send_batch(rows, None).await.unwrap();
    flusher.flush().await.unwrap();
    flusher.shutdown().await.unwrap();
    let spans = capture.0.lock().unwrap().clone();
    spans
}
fn kind<'a>(spans: &'a [ReadableSpan], value: &str) -> Vec<&'a ReadableSpan> {
    spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind").and_then(Value::as_str) == Some(value))
        .collect()
}
fn numbers(spans: &[&ReadableSpan], name: &str) -> Vec<f64> {
    let mut values: Vec<_> = spans
        .iter()
        .map(|s| s.attributes[name].as_f64().unwrap())
        .collect();
    values.sort_by(f64::total_cmp);
    values
}
#[tokio::test]
async fn main533_l55_all_four_qoder_types_export_real_roots_exact_messages_tools_and_per_llm_usage()
{
    for agent in TYPES {
        let rows = records(agent, None);
        let before = serde_json::to_value(&rows).unwrap();
        let spans = flush(rows.clone()).await;
        let entry = kind(&spans, "ENTRY");
        assert_eq!(entry.len(), 1, "{agent}");
        assert!(entry[0].parent_span_id.is_none(), "{agent}");
        assert!(spans.iter().all(|s| s.trace_id == TRACE), "{agent}");
        let ids: HashSet<_> = spans.iter().map(|s| s.span_id.as_str()).collect();
        assert_eq!(ids.len(), spans.len());
        for span in spans.iter().filter(|s| s.span_id != entry[0].span_id) {
            assert!(
                ids.contains(span.parent_span_id.as_deref().unwrap()),
                "{agent} {span:?}"
            );
        }
        let agents = kind(&spans, "AGENT");
        assert_eq!(agents.len(), 1);
        let llms = kind(&spans, "LLM");
        assert_eq!(llms.len(), 2);
        assert_eq!(numbers(&llms, "gen_ai.usage.input_tokens"), [10.0, 20.0]);
        assert_eq!(numbers(&llms, "gen_ai.usage.output_tokens"), [2.0, 3.0]);
        assert_eq!(
            numbers(&llms, "gen_ai.usage.cache_read.input_tokens"),
            [4.0, 5.0]
        );
        assert_eq!(
            agents[0].attributes["gen_ai.usage.input_tokens"].as_f64(),
            Some(30.0)
        );
        assert_eq!(
            agents[0].attributes["gen_ai.usage.output_tokens"].as_f64(),
            Some(5.0)
        );
        let tools = kind(&spans, "TOOL");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].span_id, "aaaaaaaaaaaaaaaa");
        assert_eq!(
            tools[0].attributes["gen_ai.tool.call.result"],
            "demo content"
        );
        assert!(entry[0].attributes["gen_ai.input.messages"]
            .as_str()
            .unwrap()
            .contains("Read the demo"));
        assert!(entry[0].attributes["gen_ai.output.messages"]
            .as_str()
            .unwrap()
            .contains("demo read"));
        assert_eq!(serde_json::to_value(rows).unwrap(), before);
    }
}
#[tokio::test]
async fn main533_l84_all_four_types_keep_real_upstream_including_the_synthetic_looking_id() {
    for agent in TYPES {
        for parent in [UPSTREAM, "0000000000000001"] {
            let spans = flush(records(agent, Some(parent))).await;
            let entry = kind(&spans, "ENTRY")[0];
            assert_eq!(entry.parent_span_id.as_deref(), Some(parent), "{agent}");
            assert_eq!(entry.trace_id, TRACE);
        }
    }
}
#[tokio::test]
async fn main533_l91_incomplete_marker_reaches_entry_without_changing_tools_or_tokens() {
    for agent in TYPES {
        let mut rows = records(agent, None);
        for row in &mut rows {
            row.extra
                .insert("agent.transcript_incomplete".into(), Value::Bool(true));
        }
        let spans = flush(rows).await;
        assert_eq!(
            kind(&spans, "ENTRY")[0]
                .attributes
                .get("agent.transcript_incomplete"),
            Some(&Value::Bool(true)),
            "{agent}"
        );
        assert_eq!(
            numbers(&kind(&spans, "LLM"), "gen_ai.usage.input_tokens"),
            [10.0, 20.0]
        );
        assert_eq!(
            kind(&spans, "TOOL")[0].attributes["gen_ai.tool.call.result"],
            "demo content"
        );
    }
}
#[tokio::test]
async fn main533_l100_late_trace_preserves_upstream_and_the_one_original_trace_root() {
    for agent in TYPES {
        let mut rows = records(agent, Some(UPSTREAM));
        rows[0].trace_id = None;
        let spans = flush(rows).await;
        let roots = kind(&spans, "ENTRY");
        assert_eq!(
            roots[0].parent_span_id.as_deref(),
            Some(UPSTREAM),
            "{agent}"
        );
        // Confirmed against exact new TS wrapper + SDK beta13 oracle. Its
        // groupByTurn uses the first valid trace anywhere, not a second trace.
        assert_eq!(roots.len(), 1, "{agent}");
        assert!(spans.iter().all(|s| s.trace_id == TRACE), "{agent}");
    }
}
#[test]
fn main533_l114_qoder_routing_does_not_change_another_native_agent_converter() {
    let rows = records("claude-code", None);
    let options = ConvertOptions {
        strict: false,
        passthrough_keys: Vec::new(),
    };
    let direct = GenAiEventLogConverter.convert(&rows, &options).unwrap();
    let routed = route_convert("claude-code", &rows, &[], &GenAiEventLogConverter).unwrap();
    let wire = |spans: &[ReadableSpan]| {
        create_readable_span_to_otlp_span_json_array(spans)
            .iter()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(wire(&direct.spans), wire(&routed.spans));
}
#[test]
fn main533_l119_native_error_propagation_keeps_input_unchanged_and_no_shared_trace_override_can_leak(
) {
    struct Failure;
    impl EventLogConverter for Failure {
        fn convert(
            &self,
            _: &[AgentActivityEntry],
            _: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            Err("test startEntry failure".into())
        }
    }
    let rows = records("qoder", None);
    let before = serde_json::to_value(&rows).unwrap();
    assert_eq!(
        route_convert("qoder", &rows, &[], &Failure).unwrap_err(),
        "test startEntry failure"
    );
    assert_eq!(serde_json::to_value(&rows).unwrap(), before);
    let mut next = rows;
    for row in &mut next {
        row.trace_id = Some("fedcba9876543210fedcba9876543210".into());
    }
    let next = route_convert("qoder", &next, &[], &GenAiEventLogConverter).unwrap();
    assert!(next
        .spans
        .iter()
        .all(|s| s.trace_id == "fedcba9876543210fedcba9876543210"));
}
#[tokio::test]
async fn main533_documented_partial_internal_llm_parent_is_not_an_entry_upstream_edge() {
    for agent in TYPES {
        let rows = records(agent, None)[5..].to_vec();
        let spans = flush(rows).await;
        let root = kind(&spans, "ENTRY");
        assert_eq!(root.len(), 1);
        assert!(root[0].parent_span_id.is_none(), "{agent}");
        assert_eq!(root[0].trace_id, TRACE);
        let ids: HashSet<_> = spans.iter().map(|s| s.span_id.as_str()).collect();
        for span in spans.iter().filter(|s| s.span_id != root[0].span_id) {
            assert!(ids.contains(span.parent_span_id.as_deref().unwrap()));
        }
    }
}
