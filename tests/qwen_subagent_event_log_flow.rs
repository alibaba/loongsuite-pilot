//! Native Hook -> physical event JSONL -> production normalization -> actual
//! JSONL/OTLP flushers. Only the endpoint exporter is a capturing test sink.
use async_trait::async_trait;
use loongsuite_pilot::flushers::{
    BaseFlusher, ExporterOpts, JsonlFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter,
};
use loongsuite_pilot::inputs::base::transform_hook_record;
use loongsuite_pilot::types::{ClientType, JsonlFlusherConfig};
use loongsuite_pilot::utils::candidate_process::CandidateChild;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    project: PathBuf,
    data: PathBuf,
    transcript: PathBuf,
}
impl Fixture {
    fn new(variant: &str) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let project = root.join("project");
        let data = root.join("pilot");
        let transcript = project.join("chats/synthetic-session.jsonl");
        let children = project.join("subagents/synthetic-session");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        fs::create_dir_all(&children).unwrap();
        fs::create_dir_all(&data).unwrap();
        let original: Value = serde_json::from_str(include_str!(
            "fixtures/qwen-subagent-event-log-flow-original.json"
        ))
        .unwrap();
        let source = &original[variant];
        assert_eq!(source["sessionId"], "synthetic-session");
        let jsonl = |rows: &Value| {
            rows.as_array()
                .unwrap()
                .iter()
                .map(|row| row.to_string() + "\n")
                .collect::<String>()
        };
        fs::write(&transcript, jsonl(&source["main"])).unwrap();
        for (name, value) in source["children"].as_object().unwrap() {
            assert!(!name.contains(['/', '\\']));
            fs::write(
                children.join(name),
                if name.ends_with(".jsonl") {
                    jsonl(value)
                } else {
                    value.to_string()
                },
            )
            .unwrap();
        }
        fs::write(data.join("config.json"), source["config"].to_string()).unwrap();
        Self {
            _temporary: temporary,
            root,
            project,
            data,
            transcript,
        }
    }
    fn run_native_hook(&self) -> Vec<Value> {
        let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        command
            .env_clear()
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("PATH", self.root.join("no-runtimes"))
            .args(["hook-process", "qwen-code-cli", "stop"]);
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut stdout = tempfile::tempfile().unwrap();
        let mut stderr = tempfile::tempfile().unwrap();
        command
            .stdin(Stdio::piped())
            .stdout(stdout.try_clone().unwrap())
            .stderr(stderr.try_clone().unwrap());
        let mut child = CandidateChild::spawn(&mut command).unwrap();
        let payload = json!({"session_id":"synthetic-session","transcript_path":self.transcript,"cwd":self.project});
        child
            .take_stdin()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "Native Hook exceeded original15000ms fixture invocation bound"
            );
            std::thread::sleep(Duration::from_millis(2));
        };
        let read = |file: &mut fs::File| {
            file.seek(SeekFrom::Start(0)).unwrap();
            let mut bytes = Vec::new();
            file.take(64 * 1024 + 1).read_to_end(&mut bytes).unwrap();
            bytes
        };
        let stdout = read(&mut stdout);
        let stderr = read(&mut stderr);
        assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
        assert_eq!(stdout, b"{}\n");
        assert!(stderr.is_empty(), "{}", String::from_utf8_lossy(&stderr));
        let logs = self.data.join("logs/qwen-code-cli");
        let mut files = fs::read_dir(logs)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .collect::<Vec<_>>();
        files.sort();
        let records = files
            .iter()
            .flat_map(|path| {
                fs::read_to_string(path)
                    .unwrap()
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect::<Vec<_>>();
        assert!(
            !records.is_empty(),
            "actual Native processor must produce physical JSONL"
        );
        assert_eq!(records.last().unwrap()["gen_ai.turn.end"], true);
        assert_ne!(records.last().unwrap()["gen_ai.agent.scope"], "subagent");
        assert_eq!(
            records
                .iter()
                .filter(
                    |row| row["gen_ai.turn.end"] == true && row["gen_ai.agent.scope"] != "subagent"
                )
                .count(),
            1
        );
        records
    }
}
#[derive(Default)]
struct CapturingExporter {
    spans: Mutex<Vec<ReadableSpan>>,
}
#[async_trait]
impl TraceExporter for CapturingExporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.spans.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
struct Flow {
    traces: OtlpTraceFlusher,
    jsonl: JsonlFlusher,
    exporter: Arc<CapturingExporter>,
    output: PathBuf,
    normalized: usize,
}
impl Flow {
    async fn new(fixture: &Fixture) -> Self {
        let exporter = Arc::new(CapturingExporter::default());
        let sink = Arc::clone(&exporter);
        let factory: Arc<dyn Fn(ExporterOpts) -> Arc<dyn TraceExporter> + Send + Sync> =
            Arc::new(move |_| Arc::clone(&sink) as Arc<dyn TraceExporter>);
        let cfg=serde_json::from_value(json!({
            "enabled":true,"endpoints":[{"name":"test","endpoint":"http://localhost:4318/v1/traces","headers":{}}],
            "protocol":"http/protobuf","serviceName":"qwen-subagent-test","dataDir":fixture.data,
        })).unwrap();
        let traces = OtlpTraceFlusher::with_parts(cfg, None, Some(factory), None).unwrap();
        let output = fixture.root.join("normalized-jsonl");
        let jsonl = JsonlFlusher::new(JsonlFlusherConfig {
            enabled: true,
            output_dir: output.to_string_lossy().into_owned(),
            rotate_daily: false,
            max_file_size_mb: 128.into(),
        });
        jsonl.start().await.unwrap();
        Self {
            traces,
            jsonl,
            exporter,
            output,
            normalized: 0,
        }
    }
    async fn send(&mut self, records: &[Value]) {
        for raw in records {
            let entry = transform_hook_record(
                raw.as_object().unwrap(),
                ClientType::QwenCodeCli,
                "qwen-code-cli",
            )
            .await
            .expect("shipping Hook record must survive the production normalizer");
            self.jsonl.send(entry.clone(), None).await.unwrap();
            self.traces.send(entry, None).await.unwrap();
            self.normalized += 1;
        }
    }
    fn captured(&self) -> Vec<ReadableSpan> {
        self.exporter.spans.lock().unwrap().clone()
    }
    async fn finish(self) -> Vec<ReadableSpan> {
        self.traces.flush().await.unwrap();
        self.jsonl.flush().await.unwrap();
        self.traces.shutdown().await.unwrap();
        self.jsonl.shutdown().await.unwrap();
        let records = fs::read_to_string(self.output.join("qwen-code-cli-all.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records.len(), self.normalized);
        assert!(records
            .iter()
            .all(|row| row["gen_ai.agent.type"] == "qwen-code-cli"));
        assert!(records
            .iter()
            .any(|row| row["gen_ai.agent.scope"] == "subagent"));
        assert!(serde_json::to_string(&records)
            .unwrap()
            .contains("SENSITIVE"));
        self.captured()
    }
}
fn kind<'a>(spans: &'a [ReadableSpan], value: &str) -> Vec<&'a ReadableSpan> {
    spans
        .iter()
        .filter(|span| span.attributes["gen_ai.span.kind"] == value)
        .collect()
}
fn assert_tree(spans: &[ReadableSpan]) {
    let by_id = spans
        .iter()
        .map(|span| (&span.span_id, span))
        .collect::<HashMap<_, _>>();
    assert_eq!(by_id.len(), spans.len(), "span IDs must be globally unique");
    assert_eq!(
        spans
            .iter()
            .map(|span| &span.trace_id)
            .collect::<HashSet<_>>()
            .len(),
        1
    );
    for span in spans {
        if span.attributes["gen_ai.span.kind"] == "ENTRY" {
            continue;
        }
        let parent = by_id
            .get(
                span.parent_span_id
                    .as_ref()
                    .expect("every non-entry span has a parent"),
            )
            .expect("parent must exist in this exported trace");
        assert!(
            span.start_time >= parent.start_time,
            "{} starts before its parent",
            span.name
        );
        assert!(
            span.end_time <= parent.end_time,
            "{} ends after its parent",
            span.name
        );
        if span.attributes.get("gen_ai.agent.scope") == Some(&json!("subagent"))
            && span.attributes["gen_ai.span.kind"] == "AGENT"
        {
            assert_eq!(parent.attributes["gen_ai.span.kind"], "TOOL");
            assert_eq!(
                span.attributes["gen_ai.subagent.parent_tool_call.id"],
                parent.attributes["gen_ai.tool.call.id"]
            );
        }
    }
}
fn assert_counts(spans: &[ReadableSpan], expected: &[(&str, usize)]) {
    for (name, count) in expected {
        assert_eq!(kind(spans, name).len(), *count, "{name}");
    }
    assert_tree(spans);
}
#[tokio::test]
async fn native_qwen_hook_and_normalization_wait_for_seal_before_exporting_recursive_jsonl_and_spans(
) {
    let fixture = Fixture::new("recursive");
    let raw = fixture.run_native_hook();
    let mut flow = Flow::new(&fixture).await;
    flow.send(&raw[..raw.len() - 1]).await;
    tokio::task::yield_now().await;
    assert!(
        flow.captured().is_empty(),
        "no exporter call before the explicit root seal"
    );
    let snapshot = flow.traces.trace_runtime_snapshot();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].pending_buffers, 1);
    assert_eq!(snapshot[0].pending_records as usize, raw.len() - 1);
    assert_eq!(snapshot[0].converter_calls_total, 0);
    flow.send(&raw[raw.len() - 1..]).await;
    let spans = flow.finish().await;
    assert_counts(
        &spans,
        &[
            ("ENTRY", 1),
            ("AGENT", 3),
            ("LLM", 5),
            ("STEP", 5),
            ("TOOL", 2),
        ],
    );
    let usage = kind(&spans, "AGENT")
        .into_iter()
        .map(|span| {
            (
                span.attributes["gen_ai.agent.id"].as_str().unwrap(),
                span.attributes["gen_ai.usage.input_tokens"]
                    .as_i64()
                    .unwrap(),
            )
        })
        .collect::<HashMap<_, _>>();
    assert_eq!(
        usage,
        HashMap::from([("synthetic-session", 50), ("child", 22), ("grandchild", 5)])
    );
    assert_eq!(
        kind(&spans, "LLM")
            .iter()
            .map(|span| span.attributes["gen_ai.usage.input_tokens"]
                .as_i64()
                .unwrap())
            .sum::<i64>(),
        77
    );
}
#[tokio::test]
async fn native_qwen_parallel_children_and_grandchildren_keep_identical_native_tool_ids_separate() {
    let fixture = Fixture::new("parallel");
    let raw = fixture.run_native_hook();
    let mut flow = Flow::new(&fixture).await;
    flow.send(&raw).await;
    let spans = flow.finish().await;
    assert_counts(&spans, &[("ENTRY", 1), ("AGENT", 5), ("LLM", 8)]);
    let tools = kind(&spans, "TOOL");
    assert_eq!(tools.len(), 4);
    assert_eq!(
        tools
            .iter()
            .map(|span| span.attributes["gen_ai.tool.call.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        4
    );
}
#[tokio::test]
async fn native_qwen_failed_child_status_and_collection_diagnostics_reach_final_spans() {
    let fixture = Fixture::new("failed");
    let raw = fixture.run_native_hook();
    let mut flow = Flow::new(&fixture).await;
    flow.send(&raw).await;
    let spans = flow.finish().await;
    assert_counts(
        &spans,
        &[
            ("ENTRY", 1),
            ("AGENT", 3),
            ("LLM", 5),
            ("STEP", 5),
            ("TOOL", 2),
        ],
    );
    let failed = kind(&spans, "AGENT")
        .into_iter()
        .find(|span| span.attributes["gen_ai.agent.id"] == "grandchild")
        .unwrap();
    assert_eq!(
        failed.attributes["agent.qwen-code-cli.subagent.status"],
        "failed"
    );
    assert_eq!(failed.status["code"], 2);
    assert!(kind(&spans, "TOOL")
        .iter()
        .all(|span| span.attributes["agent.qwen-code-cli.subagent.collection"] == "collected"));
}
#[tokio::test]
async fn native_qwen_ignores_the_legacy_content_optout_while_preserving_recursive_topology() {
    let fixture = Fixture::new("legacy-content-optout");
    let raw = fixture.run_native_hook();
    let mut flow = Flow::new(&fixture).await;
    flow.send(&raw).await;
    let spans = flow.finish().await;
    assert_counts(
        &spans,
        &[
            ("ENTRY", 1),
            ("AGENT", 3),
            ("LLM", 5),
            ("STEP", 5),
            ("TOOL", 2),
        ],
    );
    let attributes = spans
        .iter()
        .map(|span| &span.attributes)
        .collect::<Vec<_>>();
    assert!(serde_json::to_string(&attributes)
        .unwrap()
        .contains("SENSITIVE"));
}
