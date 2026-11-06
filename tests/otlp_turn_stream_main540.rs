//! Migrated from main 2caaaf9 tests/unit/flushers/otlp-trace-flusher/turn-streaming.test.ts.
//! Parameterized source cases stay together; native ownership replaces SDK timer assertions.
use async_trait::async_trait;
use loongsuite_pilot::flushers::*;
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
type ExporterFactory = Arc<dyn Fn(ExporterOpts) -> Arc<dyn TraceExporter> + Send + Sync>;
mod types {
    pub use loongsuite_pilot::types::{AgentActivityEntry, AgentEventName};
}
#[path = "../src/flushers/turn_stream.rs"]
mod turn_stream;
use loongsuite_pilot::flushers::GenAiEventLogConverter;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn turn(count: usize, delegated: bool, agent: &str) -> Vec<AgentActivityEntry> {
    let mut records: Vec<AgentActivityEntry> = Vec::new();
    let event = |name: &str, time: usize, fields: Value| {
        let mut value = json!({
            "event.name":name, "event.id":format!("event-{time}"),
            "time_unix_nano":format!("{}000000", 1700000000000u64 + time as u64),
            "trace_id":"1234567890abcdef1234567890abcdef", "gen_ai.turn.id":"long-turn",
            "gen_ai.agent.type":agent, "gen_ai.agent.id":"main", "gen_ai.agent.name":"test-agent",
            "gen_ai.session.id":"session", "user.id":"test-user", "gen_ai.provider.name":"test"
        });
        if delegated {
            value["gen_ai.agent.scope"] = json!("subagent");
            value["parent_span_id"] = json!("1111111111111111");
        }
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    };
    records.push(event("other", 0, json!({"agent.openclaw.hook":"before_agent_run",
        "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"task"}]}]})));
    for i in 0..count {
        let mut request = json!({
            "gen_ai.step.id":format!("step_{i}"),"gen_ai.response.id":format!("response-{i}"),
            "span_id":format!("{:016x}",i+1),"gen_ai.request.model":"test-model","gen_ai.react.round":i,
            "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":format!("delta-{i}")}]}]
        });
        if i == 0 || i == 20 {
            request["gen_ai.input.messages"] =
                json!([{"role":"user","parts":[{"type":"text","content":format!("anchor-{i}")}]}]);
        }
        if i + 1 == count {
            request["test.late"] = json!("available-at-conversion");
        }
        if i == 10 {
            request["gen_ai.system_instructions"] =
                json!([{"type":"text","content":"late-system"}]);
            request["gen_ai.tool.definitions"] =
                json!([{"type":"function","name":"read","description":"read data"}]);
        }
        records.push(event("llm.request", i * 100 + 1, request));
        records.push(event("llm.response", i*100+2, json!({
            "gen_ai.step.id":format!("step_{i}"),"gen_ai.response.id":format!("response-{i}"),
            "span_id":format!("{:016x}",i+1),"gen_ai.response.model":"test-model",
            "gen_ai.response.finish_reasons":["tool_calls"], "gen_ai.react.round":i,
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":format!("output-{i}")}]}],
            "gen_ai.usage.input_tokens":100+i,"gen_ai.usage.output_tokens":10+i,
            "gen_ai.usage.total_tokens":110+2*i,"gen_ai.usage.reasoning_tokens":i,
            "gen_ai.usage.cache_read.input_tokens":1,"gen_ai.usage.cache_creation.input_tokens":2
        })));
        records.push(event("tool.call", i*100+3, json!({
            "gen_ai.step.id":format!("step_{i}"),"gen_ai.tool.call.id":format!("tool-{i}"),
            "span_id":format!("{:016x}",i+10000),"gen_ai.tool.name":"read",
            "gen_ai.tool.call.arguments":{"path":format!("file-{i}")},"gen_ai.skill.name":"reader"
        })));
        let mut result = json!({
            "gen_ai.step.id":format!("step_{i}"),"gen_ai.tool.call.id":format!("tool-{i}"),
            "span_id":format!("{:016x}",i+10000),"gen_ai.tool.name":"read",
            "gen_ai.tool.call.result":{"text":format!("result-{i}")},
            "tool.result.status":if i == 5 { "failure" } else { "success" }
        });
        if i == 5 {
            result["error.type"] = json!("TestToolFailure");
        }
        records.push(event("tool.result", i * 100 + 4, result));
    }
    let mut late = records.remove(4);
    late.extra
        .insert("test.precedence".into(), json!("late-tool-result"));
    records[4]
        .extra
        .insert("test.precedence".into(), json!("earlier-source-record"));
    records.push(late);
    records.push(event(
        "other",
        count * 100 + 5,
        json!({"agent.openclaw.hook":"llm_output","gen_ai.turn.end":true}),
    ));
    records
}

struct BatchConverter;
impl EventLogConverter for BatchConverter {
    fn convert(
        &self,
        records: &[AgentActivityEntry],
        options: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        GenAiEventLogConverter.convert(records, options)
    }
}

#[derive(Default)]
struct Capture {
    batches: Mutex<Vec<Vec<ReadableSpan>>>,
    active: AtomicUsize,
    peak: AtomicUsize,
    attempts: AtomicUsize,
    fail_at: usize,
    delay: bool,
}
struct CapturingExporter(Arc<Capture>);
#[async_trait]
impl TraceExporter for CapturingExporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        let active = self.0.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.peak.fetch_max(active, Ordering::SeqCst);
        if self.0.delay {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        self.0.batches.lock().unwrap().push(spans);
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        let attempt = self.0.attempts.fetch_add(1, Ordering::SeqCst) + 1;
        if self.0.fail_at != 0 && attempt == self.0.fail_at {
            Err("synthetic rejection".into())
        } else {
            Ok(())
        }
    }
    async fn shutdown(&self) {}
}
fn setup(batch: bool, limit: u64, capture: Arc<Capture>) -> OtlpTraceFlusher {
    let factory: ExporterFactory =
        Arc::new(move |_| Arc::new(CapturingExporter(Arc::clone(&capture))));
    let cfg: OtlpTraceFlusherConfig = serde_json::from_value(json!({
        "enabled":true,"protocol":"http/protobuf","serviceName":"stream-test",
        "maxExportBatchBytes":limit,"spanAttributePassthroughPrefixes":["test."],
        "endpoints":[{"name":"test","endpoint":"http://127.0.0.1:4318"}]
    }))
    .unwrap();
    let converter = batch.then(|| Arc::new(BatchConverter) as Arc<dyn EventLogConverter>);
    OtlpTraceFlusher::with_parts(cfg, None, Some(factory), converter).unwrap()
}
async fn collect(
    records: Vec<AgentActivityEntry>,
    batch: bool,
    limit: u64,
) -> Vec<Vec<ReadableSpan>> {
    let capture = Arc::new(Capture::default());
    let f = setup(batch, limit, Arc::clone(&capture));
    f.send_batch(records, None).await.unwrap();
    f.shutdown().await.unwrap();
    let result = capture.batches.lock().unwrap().clone();
    result
}
fn snapshot(spans: &[ReadableSpan]) -> Value {
    let mut spans = spans.to_vec();
    for span in &mut spans {
        if let Some(resource) = &mut span.resource_attributes {
            resource.remove("service.instance.id");
        }
    }
    spans.sort_by(|a, b| (&a.trace_id, &a.span_id).cmp(&(&b.trace_id, &b.span_id)));
    json!(create_readable_span_to_otlp_span_json_array(&spans)
        .iter()
        .map(|encoded| serde_json::from_str::<Value>(encoded).unwrap())
        .collect::<Vec<_>>())
}
fn flatten(batches: &[Vec<ReadableSpan>]) -> Vec<ReadableSpan> {
    batches.iter().flatten().cloned().collect()
}

#[tokio::test]
async fn main540_l94_preserves_batch_spans_inputs_token_aggregates_and_delegation() {
    for delegated in [false, true] {
        let records = turn(40, delegated, "openclaw");
        let before = serde_json::to_value(&records).unwrap();
        let expected = flatten(&collect(records.clone(), true, 5000).await);
        let batches = collect(records.clone(), false, 5000).await;
        let actual = flatten(&batches);
        assert_snapshot(&actual, &expected);
        assert_eq!(serde_json::to_value(records).unwrap(), before);
        assert_eq!(actual.len(), if delegated { 121 } else { 122 });
        assert!(batches.len() > 1);
        let agent = actual
            .iter()
            .find(|s| s.attributes["gen_ai.span.kind"] == "AGENT")
            .unwrap();
        for (key, expected) in [
            ("input_tokens", 4780),
            ("output_tokens", 1180),
            ("reasoning_tokens", 780),
            ("cache_read.input_tokens", 40),
            ("cache_creation.input_tokens", 80),
        ] {
            assert_eq!(
                agent.attributes[&format!("gen_ai.usage.{key}")],
                json!(expected)
            );
        }
    }
}

#[tokio::test]
async fn main540_l114_preserves_all_eleven_adapters_under_bounded_export() {
    for agent in [
        "claude-code",
        "opencode",
        "hermes",
        "codex",
        "qoder",
        "qoder-cn",
        "qwen-code-cli",
        "grok-build",
        "copilot",
        "dsh",
        "cursor",
    ] {
        let records = turn(40, false, agent);
        assert!(turn_stream::can_stream(&records), "{agent}");
        let before = serde_json::to_value(&records).unwrap();
        let expected = flatten(&collect(records.clone(), true, 5000).await);
        let actual = flatten(&collect(records.clone(), false, 5000).await);
        assert_snapshot(&actual, &expected);
        assert_eq!(serde_json::to_value(records).unwrap(), before);
        assert_eq!(
            actual
                .iter()
                .filter(|s| s.attributes["gen_ai.span.kind"] == "LLM")
                .count(),
            40
        );
    }
}
#[tokio::test]
async fn main540_l129_preserves_native_codex_ids_and_delegation_on_replay() {
    for delegated in [false, true] {
        let mut records = turn(40, delegated, "codex");
        for record in &mut records {
            record.extra.insert(
                "agent.codex.transcript_turn_id".into(),
                json!("native-turn"),
            );
            if delegated {
                record
                    .extra
                    .insert("agent.codex.delegated".into(), json!(true));
                record.extra.insert(
                    "agent.codex.parent_span_id".into(),
                    json!("1111111111111111"),
                );
            }
        }
        let expected = flatten(&collect(records.clone(), true, 5000).await);
        let actual = flatten(&collect(records, false, 5000).await);
        assert_snapshot(&actual, &expected);
    }
}
#[tokio::test]
async fn main540_l143_short_compatible_turn_exports_once() {
    let batches = collect(turn(2, false, "claude-code"), false, 1024 * 1024).await;
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].len(), 8);
}
#[tokio::test]
async fn main540_l149_awaits_each_export_without_unbounded_completed_sdk_queue() {
    let capture = Arc::new(Capture {
        delay: true,
        ..Capture::default()
    });
    let f = setup(false, 5000, Arc::clone(&capture));
    f.send_batch(turn(80, false, "openclaw"), None)
        .await
        .unwrap();
    f.shutdown().await.unwrap();
    assert_eq!(capture.peak.load(Ordering::SeqCst), 1);
    assert_eq!(capture.active.load(Ordering::SeqCst), 0);
    assert_eq!(flatten(&capture.batches.lock().unwrap()).len(), 242);
}
#[test]
fn main540_l177_keeps_batch_for_inline_children_and_response_source_order() {
    let mut records = turn(40, false, "openclaw");
    let response = records.remove(2);
    let index = records.len() - 1;
    records.insert(index, response);
    assert!(!turn_stream::can_stream(&records));
    let mut inline = turn(40, false, "openclaw");
    inline[2]
        .extra
        .insert("gen_ai.agent.scope".into(), json!("subagent"));
    inline[2].extra.insert(
        "gen_ai.subagent.parent_tool_call.id".into(),
        json!("tool-0"),
    );
    assert!(!turn_stream::can_stream(&inline));
}
#[tokio::test]
async fn main540_l241_preflights_missing_merged_steps_and_late_parent_metadata() {
    let mut missing = turn(40, false, "openclaw");
    missing[1].step_id = None;
    let mut merged = turn(40, false, "openclaw");
    for r in &mut merged {
        if r.step_id.as_deref() == Some("step_1") {
            r.step_id = Some("step_0".into());
        }
    }
    let mut late = turn(40, false, "openclaw");
    for r in &mut late {
        if r.step_id.as_deref() == Some("step_0")
            || r.event_name == Some(loongsuite_pilot::types::AgentEventName::Other)
        {
            r.user_id.clear();
        }
    }
    for records in [missing, merged, late] {
        assert!(!turn_stream::can_stream(&records));
        assert_eq!(
            snapshot(&flatten(&collect(records.clone(), true, 5000).await)),
            snapshot(&flatten(&collect(records, false, 5000).await))
        );
    }
}
#[tokio::test]
async fn main540_l255_failed_batch_does_not_contaminate_the_following_turn() {
    for agent in ["openclaw", "qoder"] {
        let capture = Arc::new(Capture {
            fail_at: 4,
            ..Capture::default()
        });
        let f = setup(false, 5000, Arc::clone(&capture));
        f.send_batch(turn(40, false, agent), None).await.unwrap();
        let mut next = turn(2, false, agent);
        for r in &mut next {
            r.trace_id = Some("abcdef1234567890abcdef1234567890".into());
            r.turn_id = Some("next-turn".into());
        }
        f.send_batch(next, None).await.unwrap();
        f.shutdown().await.unwrap();
        let spans = flatten(&capture.batches.lock().unwrap());
        assert_eq!(spans.len(), 130);
        assert_eq!(
            spans
                .iter()
                .map(|s| (&s.trace_id, &s.span_id))
                .collect::<HashSet<_>>()
                .len(),
            130
        );
        assert!(f.endpoint_counters()["test"].out_failed > 0);
    }
}

#[tokio::test]
async fn main540_l188_preserves_source_request_order_in_all_five_permutations() {
    for (tied, anchored, ordered) in [
        (false, false, false),
        (true, false, false),
        (true, true, false),
        (false, false, true),
        (true, false, true),
    ] {
        let event = |name: &str, time: u64, step: Option<&str>, fields: Value| {
            let mut v = json!({"event.name":name,"event.id":format!("{name}-{time}-{}",step.unwrap_or("control")),
                "time_unix_nano":format!("{}000000",1700000000000u64+time),
                "trace_id":"1234567890abcdef1234567890abcdef","gen_ai.agent.type":"qoder",
                "gen_ai.agent.name":"test-agent","gen_ai.session.id":"session","gen_ai.turn.id":"request-order",
                "user.id":"test-user","gen_ai.provider.name":"test"});
            if let Some(step) = step {
                v["gen_ai.step.id"] = json!(step);
            }
            v.as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            serde_json::from_value(v).unwrap()
        };
        let message =
            |content: &str| json!([{"role":"user","parts":[{"type":"text","content":content}]}]);
        let mut records: Vec<AgentActivityEntry> = Vec::new();
        if anchored {
            records.push(event(
                "other",
                0,
                None,
                json!({"gen_ai.input.messages_delta":message("task")}),
            ));
        }
        records.push(event(
            "tool.call",
            21,
            Some("A"),
            json!({"gen_ai.tool.call.id":"tool-A",
            "gen_ai.tool.name":"read","gen_ai.tool.call.arguments":{"path":"test.txt"}}),
        ));
        let a = event(
            "llm.request",
            5,
            Some("A"),
            json!({"gen_ai.response.id":"response-A",
            "gen_ai.request.model":"test-model","gen_ai.input.messages_delta":message("A")}),
        );
        let b = event(
            "llm.request",
            if tied { 5 } else { 10 },
            Some("B"),
            json!({"gen_ai.response.id":"response-B",
            "gen_ai.request.model":"test-model","gen_ai.input.messages_delta":message("B")}),
        );
        if ordered {
            records.extend([a, b]);
        } else {
            records.extend([b, a]);
        }
        records.push(event("llm.response",20,Some("A"),json!({"gen_ai.response.id":"response-A",
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"tool_call","id":"tool-A","name":"read","arguments":{"path":"test.txt"}}]}],
            "gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":10})));
        records.push(event(
            "tool.result",
            22,
            Some("A"),
            json!({"gen_ai.tool.call.id":"tool-A",
            "gen_ai.tool.name":"read","gen_ai.tool.call.result":{"text":"result"}}),
        ));
        records.push(event("llm.response",30,Some("B"),json!({"gen_ai.response.id":"response-B",
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"done"}]}],
            "gen_ai.usage.input_tokens":200,"gen_ai.usage.output_tokens":20})));
        records.push(event("other", 40, None, json!({"gen_ai.turn.end":true})));
        assert_eq!(turn_stream::can_stream(&records), ordered);
        let expected = flatten(&collect(records.clone(), true, 5000).await);
        let actual = flatten(&collect(records, false, 5000).await);
        assert_snapshot(&actual, &expected);
        for span in actual.iter().filter(|s| {
            matches!(
                s.attributes["gen_ai.span.kind"].as_str(),
                Some("ENTRY" | "AGENT")
            )
        }) {
            let input: Value =
                serde_json::from_str(span.attributes["gen_ai.input.messages"].as_str().unwrap())
                    .unwrap();
            assert_eq!(
                input,
                message(if anchored {
                    "task"
                } else if ordered {
                    "A"
                } else {
                    "B"
                })
            );
        }
        for span in actual
            .iter()
            .filter(|s| s.attributes["gen_ai.span.kind"] == "LLM")
        {
            let a = span.attributes["gen_ai.response.id"] == "response-A";
            let content = if a {
                if tied && !ordered {
                    json!([message("B")[0], message("A")[0]])
                } else {
                    message("A")
                }
            } else if tied && !ordered {
                message("B")
            } else {
                json!([message("A")[0], message("B")[0]])
            };
            assert_eq!(
                serde_json::from_str::<Value>(
                    span.attributes["gen_ai.input.messages"].as_str().unwrap()
                )
                .unwrap(),
                content
            );
        }
    }
}

#[tokio::test]
async fn main540_l285_flush_waits_for_a_completed_turn_already_exporting() {
    struct BarrierExport {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        received: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl TraceExporter for BarrierExport {
        async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
            self.entered.notify_one();
            self.release.notified().await;
            self.received.fetch_add(spans.len(), Ordering::SeqCst);
            Ok(())
        }
        async fn shutdown(&self) {}
    }
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let received = Arc::new(AtomicUsize::new(0));
    let exporter = Arc::new(BarrierExport {
        entered: entered.clone(),
        release: release.clone(),
        received: received.clone(),
    });
    let factory: ExporterFactory = Arc::new(move |_| exporter.clone());
    let config = serde_json::from_value(
        json!({"enabled":true,"protocol":"http/protobuf","serviceName":"flush-stream",
        "endpoints":[{"name":"test","endpoint":"http://127.0.0.1:4318"}]}),
    )
    .unwrap();
    let f = Arc::new(OtlpTraceFlusher::with_parts(config, None, Some(factory), None).unwrap());
    let sending = {
        let f = f.clone();
        tokio::spawn(async move { f.send_batch(turn(2, false, "openclaw"), None).await })
    };
    entered.notified().await;
    let flushed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flushing = {
        let f = f.clone();
        let flushed = flushed.clone();
        tokio::spawn(async move {
            f.flush().await.unwrap();
            flushed.store(true, Ordering::SeqCst);
        })
    };
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(!flushed.load(Ordering::SeqCst));
    release.notify_one();
    sending.await.unwrap().unwrap();
    flushing.await.unwrap();
    assert_eq!(received.load(Ordering::SeqCst), 8);
    f.shutdown().await.unwrap();
}

fn assert_snapshot(actual: &[ReadableSpan], expected: &[ReadableSpan]) {
    let a = snapshot(actual);
    let b = snapshot(expected);
    let aa = a.as_array().unwrap();
    let bb = b.as_array().unwrap();
    assert_eq!(aa.len(), bb.len());
    for (a, b) in aa.iter().zip(bb) {
        if a != b {
            fn diff(a: &Value, b: &Value, path: &str, out: &mut Vec<String>) {
                if a == b {
                    return;
                }
                if let (Some(a), Some(b)) = (a.as_object(), b.as_object()) {
                    let keys: std::collections::BTreeSet<_> = a.keys().chain(b.keys()).collect();
                    for key in keys {
                        diff(
                            a.get(key).unwrap_or(&Value::Null),
                            b.get(key).unwrap_or(&Value::Null),
                            &format!("{path}.{key}"),
                            out,
                        );
                    }
                } else {
                    out.push(format!("{path}: actual={a} expected={b}"));
                }
            }
            let mut differences = Vec::new();
            diff(a, b, "span", &mut differences);
            panic!("{}: {}", a["spanId"], differences.join("\n"));
        }
    }
}

#[tokio::test]
async fn main551_failure_persistence_backpressures_every_next_export_batch() {
    fn persisted(path: &std::path::Path) -> usize {
        std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
            .sum()
    }
    struct Failing {
        path: std::path::PathBuf,
        previous: AtomicUsize,
    }
    #[async_trait]
    impl TraceExporter for Failing {
        async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
            assert_eq!(
                persisted(&self.path),
                self.previous.load(Ordering::SeqCst),
                "next batch started before failed persistence finished"
            );
            self.previous.fetch_add(spans.len(), Ordering::SeqCst);
            Err("synthetic unavailable".into())
        }
        async fn shutdown(&self) {}
    }
    let root = tempfile::tempdir().unwrap();
    let exporter = Arc::new(Failing {
        path: root.path().join("logs/otlp-failed"),
        previous: AtomicUsize::new(0),
    });
    let expected = exporter.clone();
    let factory: ExporterFactory = Arc::new(move |_| exporter.clone());
    let config = serde_json::from_value(json!({"enabled":true,"protocol":"http/protobuf",
        "serviceName":"failed-stream","dataDir":root.path(),"maxExportBatchBytes":5000,
        "endpoints":[{"name":"failed","endpoint":"http://127.0.0.1:4318"}]}))
    .unwrap();
    let f = OtlpTraceFlusher::with_parts(config, None, Some(factory), None).unwrap();
    f.send_batch(turn(40, false, "claude-code"), None)
        .await
        .unwrap();
    f.shutdown().await.unwrap();
    assert_eq!(expected.previous.load(Ordering::SeqCst), 122);
    assert_eq!(persisted(&expected.path), 122);
}
struct TimedStreamConverter {
    fail: bool,
}
impl EventLogConverter for TimedStreamConverter {
    fn supports_streaming(&self) -> bool {
        true
    }
    fn convert(
        &self,
        _: &[AgentActivityEntry],
        _: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        panic!("streamed conversion must not start batch conversion");
    }
    fn convert_stream(
        &self,
        records: &[AgentActivityEntry],
        options: &ConvertOptions,
        emit: &mut dyn FnMut(Vec<ReadableSpan>, bool) -> Result<(), String>,
    ) -> Result<(), String> {
        std::thread::sleep(Duration::from_millis(10));
        if self.fail {
            return Err("original converter failure fixture".into());
        }
        GenAiEventLogConverter.convert_stream(records, options, emit)?;
        std::thread::sleep(Duration::from_millis(10));
        Ok(())
    }
}
async fn stream_runtime_case(fail: bool) {
    struct SlowExport(Arc<AtomicUsize>);
    #[async_trait]
    impl TraceExporter for SlowExport {
        async fn export(&self, _: Vec<ReadableSpan>) -> Result<(), String> {
            tokio::time::sleep(Duration::from_millis(500)).await;
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn shutdown(&self) {}
    }
    let exports = Arc::new(AtomicUsize::new(0));
    let count = exports.clone();
    let factory: ExporterFactory = Arc::new(move |_| Arc::new(SlowExport(count.clone())));
    let cfg=serde_json::from_value(json!({"enabled":true,"protocol":"http/protobuf",
        "serviceName":"stream-runtime","endpoints":[{"name":"test","endpoint":"http://127.0.0.1:4318"}]})).unwrap();
    let f = OtlpTraceFlusher::with_parts(
        cfg,
        None,
        Some(factory),
        Some(Arc::new(TimedStreamConverter { fail })),
    )
    .unwrap();
    let mut records: Vec<_> = turn(2, false, "opencode")
        .into_iter()
        .filter(|record| {
            record.step_id.as_deref() == Some("step_0")
                && matches!(
                    record.event_name,
                    Some(
                        loongsuite_pilot::types::AgentEventName::LlmRequest
                            | loongsuite_pilot::types::AgentEventName::LlmResponse
                    )
                )
        })
        .collect();
    records[1].finish_reasons = Some(vec!["stop".into()]);
    f.send_batch(records, Some(vec![100.0, 200.0]))
        .await
        .unwrap();
    let row = &f.trace_runtime_snapshot()[0];
    assert_eq!(row.converter_calls_total, 1);
    assert_eq!(row.converter_failed_total, u64::from(fail));
    assert!(row.converter_duration_ms_total >= if fail { 10.0 } else { 20.0 });
    assert!(
        row.converter_duration_ms_total < 400.0,
        "backend waiting counted as converter time"
    );
    assert_eq!(exports.load(Ordering::SeqCst), usize::from(!fail));
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main551_runtime_counts_stream_once_and_excludes_export_waits() {
    stream_runtime_case(false).await;
}
#[tokio::test]
async fn main551_runtime_counts_stream_failure_without_starting_batch() {
    stream_runtime_case(true).await;
}
