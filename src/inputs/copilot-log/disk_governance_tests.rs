//! Synthetic end-to-end output growth and main #517 disk stress contracts.
//! No Agent is launched; the OTLP exporter below is an explicitly local test sink.
use super::*;
use crate::core::{InputManager, LiveInput};
use crate::flushers::{
    BaseFlusher, FlushError, JsonlFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter,
};
use crate::types::{AgentEventName, JsonlFlusherConfig, OtlpTraceFlusherConfig};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Write;
use std::time::Instant;

const BASE: i64 = 1_788_220_800_000;
fn lines(values: &[Value]) -> String {
    values
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
fn conversation(id: &str, shift: i64, payload: usize) -> Value {
    let mut value: Value = serde_json::from_str(
        &include_str!("../../../tests/fixtures/copilot/conversation.json")
            .replace("interaction-a", id),
    )
    .unwrap();
    value["events"][1]["data"]["content"] = json!("x".repeat(payload));
    for event in value["events"].as_array_mut().unwrap() {
        let stamp = chrono::DateTime::parse_from_rfc3339(event["timestamp"].as_str().unwrap())
            .unwrap()
            .timestamp_millis()
            + shift;
        event["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(stamp)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    let trace = hex::encode(Sha256::digest(id.as_bytes()))[..32].to_owned();
    for span in value["spans"].as_array_mut().unwrap() {
        span["traceId"] = json!(trace);
        for key in ["startTime", "endTime"] {
            let a = span[key].as_array().unwrap();
            let nanos = i128::from(a[0].as_i64().unwrap()) * 1_000_000_000
                + i128::from(a[1].as_i64().unwrap())
                + i128::from(shift) * 1_000_000;
            span[key] = json!([
                (nanos / 1_000_000_000) as i64,
                (nanos % 1_000_000_000) as i64
            ]);
        }
    }
    value
}
struct Sources {
    sessions: PathBuf,
    native: PathBuf,
    events: PathBuf,
}
async fn sources(
    root: &Path,
    turns: usize,
    payload: usize,
    shift: i64,
    append: bool,
    first: usize,
) -> Sources {
    let sessions = root.join("sessions");
    let directory = sessions.join("session-test");
    let otel = root.join("otel");
    tokio::fs::create_dir_all(&directory).await.unwrap();
    tokio::fs::create_dir_all(&otel).await.unwrap();
    let events = directory.join("events.jsonl");
    let native = otel.join("native.jsonl");
    let mut event_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&events)
        .unwrap();
    let mut native_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&native)
        .unwrap();
    for n in 0..turns {
        let f = conversation(
            &format!("interaction-{}", first + n),
            shift + n as i64 * 10000,
            payload,
        );
        let events = f["events"].as_array().unwrap();
        event_file
            .write_all(lines(&events[usize::from(n > 0 || append)..]).as_bytes())
            .unwrap();
        native_file
            .write_all(lines(f["spans"].as_array().unwrap()).as_bytes())
            .unwrap();
    }
    Sources {
        sessions,
        native,
        events,
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Disk {
    files: usize,
    bytes: u64,
    max: u64,
}
async fn disk(directory: &Path) -> Disk {
    let mut result = Disk {
        files: 0,
        bytes: 0,
        max: 0,
    };
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return result;
    };
    while let Some(entry) = entries.next_entry().await.unwrap() {
        let metadata = entry.metadata().await.unwrap();
        assert!(metadata.is_file());
        result.files += 1;
        result.bytes += metadata.len();
        result.max = result.max.max(metadata.len());
    }
    result
}
#[derive(Default)]
struct Observed {
    seen: BTreeSet<String>,
    duplicates: usize,
    records: usize,
    requests: usize,
    input_bytes: usize,
    max_record: usize,
}
struct CountingJsonl {
    writer: JsonlFlusher,
    observed: Mutex<Observed>,
}
impl CountingJsonl {
    fn new(output: &Path) -> Self {
        let config: JsonlFlusherConfig = serde_json::from_value(
            json!({"enabled":true,"outputDir":output,"rotateDaily":true,"maxFileSizeMb":1}),
        )
        .unwrap();
        Self {
            writer: JsonlFlusher::new(config),
            observed: Mutex::new(Observed::default()),
        }
    }
}
#[async_trait]
impl BaseFlusher for CountingJsonl {
    fn name(&self) -> &str {
        "copilot-growth-jsonl"
    }
    async fn send(
        &self,
        entry: AgentActivityEntry,
        bytes: Option<f64>,
    ) -> std::result::Result<(), FlushError> {
        {
            let mut observed = self.observed.lock().unwrap();
            if !observed.seen.insert(entry.event_id.clone()) {
                observed.duplicates += 1;
            }
            observed.records += 1;
            observed.max_record = observed
                .max_record
                .max(serde_json::to_vec(&entry).unwrap().len());
            let body = entry
                .input_messages
                .as_ref()
                .or(entry.input_messages_delta.as_ref());
            if let Some(body) = body {
                observed.input_bytes += serde_json::to_vec(body).unwrap().len();
            }
            if entry.event_name == Some(AgentEventName::LlmRequest) {
                assert!(entry.input_messages.is_none());
                assert_eq!(
                    entry
                        .input_messages_delta
                        .as_ref()
                        .unwrap()
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| m["role"].as_str().unwrap())
                        .collect::<Vec<_>>(),
                    vec!["user"]
                );
                observed.requests += 1;
            }
            if entry.event_name == Some(AgentEventName::LlmResponse) {
                assert!(body.is_none());
            }
        }
        self.writer.send(entry, bytes).await
    }
    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _bytes: Option<Vec<f64>>,
    ) -> std::result::Result<(), FlushError> {
        for entry in entries {
            self.send(entry, None).await?;
        }
        Ok(())
    }
    async fn flush(&self) -> std::result::Result<(), FlushError> {
        self.writer.flush().await
    }
    async fn shutdown(&self) -> std::result::Result<(), FlushError> {
        self.writer.shutdown().await
    }
}
struct Collector {
    input: CopilotLogInput,
    manager: InputManager,
    writer: Arc<CountingJsonl>,
}
impl Collector {
    fn new(
        root: &Path,
        sources: &Sources,
        store: Arc<StateStore>,
        floor: Option<u64>,
        writer: Arc<CountingJsonl>,
    ) -> Self {
        let input = CopilotLogInput::new(CopilotLogInputOptions {
            state_store: store.clone(),
            data_dir: root.to_owned(),
            session_dir: Some(sources.sessions.clone()),
            otel_dir: Some(root.join("otel")),
            poll_interval_ms: Some(60000),
            native_grace_ms: Some(30000),
            history_start_time_ms: floor,
        });
        let manager = InputManager::new();
        manager.set_flusher(writer.clone());
        manager.set_state_store(store);
        manager.set_user_id("synthetic-user");
        manager.register_input(LiveInput::new(
            "copilot-log",
            "copilot",
            "session-file-polling",
            || true,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        ));
        Self {
            input,
            manager,
            writer,
        }
    }
    async fn cycle(&self) {
        let entries = self
            .input
            .inner
            .body
            .collect(&self.input.inner.runtime)
            .await
            .unwrap();
        self.manager
            .accept_entries("copilot-log", entries)
            .await
            .unwrap();
        self.input
            .inner
            .body
            .on_entries_queued(&self.input.inner.runtime)
            .await
            .unwrap();
        self.input.inner.runtime.state_store.save().await.unwrap();
    }
    async fn stop(&self) {
        self.input
            .inner
            .body
            .on_stop(&self.input.inner.runtime)
            .await
            .unwrap();
        self.writer.flush().await.unwrap();
    }
}
fn count(root: &Path, sql: &str) -> i64 {
    Connection::open(root.join("state/copilot/source-index.sqlite"))
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn collector_to_jsonl_growth_is_linear_and_stops_after_finite_history_drain() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut previous = 0u64;
        for turns in [10usize, 20, 40] {
            let root = tempfile::tempdir().unwrap();
            let sources = sources(root.path(), turns, 64 * 1024, 0, false, 0).await;
            let output = root.path().join("output");
            let writer = Arc::new(CountingJsonl::new(&output));
            let store = Arc::new(StateStore::new(root.path().join("state.json")));
            store.load().await;
            let collector = Collector::new(
                root.path(),
                &sources,
                store.clone(),
                Some(0),
                writer.clone(),
            );
            collector.cycle().await;
            assert_eq!(count(root.path(), "SELECT count(*) FROM delivered"), 1);
            for _ in 1..turns {
                collector.cycle().await;
            }
            assert_eq!(
                count(root.path(), "SELECT count(*) FROM delivered"),
                turns as i64
            );
            let before = disk(&output).await;
            assert!(before.files > 1);
            assert!(before.max <= 1024 * 1024);
            let transcript = tokio::fs::metadata(&sources.events).await.unwrap().len();
            assert!((before.bytes as f64) < transcript as f64 * 3.2);
            {
                let observed = writer.observed.lock().unwrap();
                assert_eq!(observed.duplicates, 0);
                assert_eq!(observed.requests, turns);
            }
            for _ in 0..5 {
                collector.cycle().await;
            }
            collector.stop().await;
            let restored = Arc::new(StateStore::new(root.path().join("state.json")));
            restored.load().await;
            let restarted = Collector::new(root.path(), &sources, restored, None, writer.clone());
            restarted.cycle().await;
            restarted.stop().await;
            assert_eq!(disk(&output).await, before);
            if previous > 0 {
                assert!((before.bytes as f64) / (previous as f64) < 2.05);
            }
            previous = before.bytes;
            writer.shutdown().await.unwrap();
        }
    })
    .await
    .expect("main's 60-second finite growth budget exceeded");
}

#[tokio::test]
async fn backlog_of_1024_old_interactions_never_reopens_and_128_new_same_session_turns_are_delivered(
) {
    tokio::time::timeout(Duration::from_secs(180), async {
        let root = tempfile::tempdir().unwrap();
        let source = sources(root.path(), 1024, 64 * 1024, 0, false, 0).await;
        let output = root.path().join("logs/output");
        let writer = Arc::new(CountingJsonl::new(&output));
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        let collector = Collector::new(root.path(), &source, store.clone(), None, writer.clone());
        for _ in 0..40 {
            collector.cycle().await;
        }
        assert_eq!(disk(&output).await.bytes, 0);
        assert!(count(root.path(), "SELECT count(*) FROM records") <= 2);
        collector.stop().await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = tokio::fs::remove_file(
                root.path()
                    .join(format!("state/copilot/source-index.sqlite{suffix}")),
            )
            .await;
        }
        let rebuilt = Collector::new(root.path(), &source, store.clone(), None, writer.clone());
        for _ in 0..40 {
            rebuilt.cycle().await;
        }
        assert_eq!(disk(&output).await.bytes, 0);
        let shift = chrono::Utc::now().timestamp_millis() + 1 - BASE;
        sources(root.path(), 128, 16 * 1024, shift, true, 1024).await;
        for _ in 0..140 {
            rebuilt.cycle().await;
        }
        assert_eq!(count(root.path(), "SELECT count(*) FROM delivered"), 128);
        let after = disk(&output).await;
        assert!(after.bytes > 0);
        assert!(after.max <= 1024 * 1024);
        assert_eq!(writer.observed.lock().unwrap().duplicates, 0);
        rebuilt.stop().await;
        writer.shutdown().await.unwrap();
    })
    .await
    .expect("main's 180-second historical backlog budget exceeded");
}

#[tokio::test]
async fn replay_at_128_256_512_turns_is_segmented_duplicate_free_and_linear() {
    tokio::time::timeout(Duration::from_secs(180), async {
        let mut previous = 0;
        for turns in [128usize, 256, 512] {
            let root = tempfile::tempdir().unwrap();
            let source = sources(root.path(), turns, 16 * 1024, 0, false, 0).await;
            assert!(tokio::fs::metadata(&source.native).await.unwrap().len() > 0);
            let output = root.path().join("logs/output");
            let writer = Arc::new(CountingJsonl::new(&output));
            let store = Arc::new(StateStore::new(root.path().join("state.json")));
            let collector =
                Collector::new(root.path(), &source, store.clone(), Some(0), writer.clone());
            let started = Instant::now();
            for _ in 0..turns + 8 {
                collector.cycle().await;
            }
            assert_eq!(
                count(root.path(), "SELECT count(*) FROM delivered"),
                turns as i64
            );
            {
                let observed = writer.observed.lock().unwrap();
                assert_eq!(observed.duplicates, 0);
                assert_eq!(observed.seen.len(), turns * 5);
            }
            let before = disk(&output).await;
            assert!(before.max <= 1024 * 1024);
            collector.stop().await;
            let restored = Collector::new(root.path(), &source, store, None, writer.clone());
            for _ in 0..5 {
                restored.cycle().await;
            }
            assert_eq!(disk(&output).await, before);
            restored.stop().await;
            if previous > 0 {
                assert!((before.bytes as f64) / (previous as f64) < 2.05);
            }
            previous = before.bytes;
            eprintln!(
                "synthetic Copilot disk replay: turns={turns} bytes={} files={} elapsed_ms={}",
                before.bytes,
                before.files,
                started.elapsed().as_millis()
            );
            writer.shutdown().await.unwrap();
        }
    })
    .await
    .expect("main's 180-second scaled replay budget exceeded");
}

#[tokio::test]
async fn sixty_four_jsonl_producers_preserve_8192_utf8_records_through_repeated_rotation() {
    tokio::time::timeout(Duration::from_secs(180),async {
        let root=tempfile::tempdir().unwrap();let output=root.path().join("output");
        let config:JsonlFlusherConfig=serde_json::from_value(json!({"enabled":true,"outputDir":output,"rotateDaily":true,"maxFileSizeMb":1})).unwrap();
        let writer=Arc::new(JsonlFlusher::new(config));
        for base in (0..8192usize).step_by(64) {
            let mut tasks=tokio::task::JoinSet::new();
            for n in base..base+64 {
                let writer=writer.clone();
                tasks.spawn(async move {
                    let entry=serde_json::from_value(json!({"event.id":n.to_string(),"event.name":"other","user.id":"synthetic",
                        "time_unix_nano":"1788220800000000000","gen_ai.agent.type":"copilot","gen_ai.session.id":"session",
                        "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"界".repeat(2048)}]}]})).unwrap();
                    writer.send(entry,None).await.unwrap();
                });
            }
            while let Some(task)=tasks.join_next().await {task.unwrap();}
        }
        writer.shutdown().await.unwrap();let mut entries=tokio::fs::read_dir(&output).await.unwrap();let mut ids=BTreeSet::new();let mut records=0;
        while let Some(file)=entries.next_entry().await.unwrap() {
            for line in tokio::fs::read_to_string(file.path()).await.unwrap().lines() {
                let entry:Value=serde_json::from_str(line).unwrap();assert!(ids.insert(entry["event.id"].as_str().unwrap().to_owned()));records+=1;
            }
        }
        assert_eq!(records,8192);assert_eq!(ids.len(),8192);assert!(disk(&output).await.max<=1024*1024);
    }).await.expect("main's 180-second concurrent rotation budget exceeded");
}

struct MemoryExporter(Mutex<Vec<ReadableSpan>>);
#[async_trait]
impl TraceExporter for MemoryExporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> std::result::Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
#[tokio::test]
async fn sixty_four_tool_steps_export_native_tokens_once_and_bound_debug_files() {
    tokio::time::timeout(Duration::from_secs(180),async {
        let root=tempfile::tempdir().unwrap();let f=conversation("interaction-long",0,16);let mut events=f["events"].as_array().unwrap()[..2].to_vec();let mut spans=Vec::new();
        let stamp=|second:i64|chrono::DateTime::from_timestamp_millis(BASE+second*1000).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
        for n in 0..64i64 {
            let second=2+n*4;let turn=n.to_string();let call=format!("api-{n}");
            events.push(json!({"type":"assistant.turn_start","id":format!("start-{n}"),"timestamp":stamp(second),"data":{"interactionId":"interaction-long","turnId":turn}}));
            events.push(json!({"type":"assistant.message","id":format!("message-{n}"),"timestamp":stamp(second+1),"data":{
                "interactionId":"interaction-long","turnId":turn,"apiCallId":call,"model":"qwen-test","content":"Continue.",
                "toolRequests":if n<63 {json!([{"toolCallId":format!("tool-{n}"),"name":"read","arguments":{"path":"sample"}}])}else{json!([])}}}));
            if n<63 {
                events.push(json!({"type":"tool.execution_start","id":format!("tool-start-{n}"),"timestamp":stamp(second+2),
                    "data":{"interactionId":"interaction-long","turnId":turn,"toolCallId":format!("tool-{n}"),"toolName":"read","arguments":{"path":"sample"}}}));
                events.push(json!({"type":"tool.execution_complete","id":format!("tool-end-{n}"),"timestamp":stamp(second+3),
                    "data":{"interactionId":"interaction-long","turnId":turn,"toolCallId":format!("tool-{n}"),"success":true,"result":{"content":"界".repeat(2048)}}}));
            }
            events.push(json!({"type":"assistant.turn_end","id":format!("end-{n}"),"timestamp":stamp(second+4),"data":{"turnId":turn}}));
            let mut span=f["spans"][0].clone();span["spanId"]=json!(format!("chat-{n}"));span["startTime"]=json!([BASE/1000+second,0]);span["endTime"]=json!([BASE/1000+second+1,0]);
            span["attributes"]["github.copilot.turn_id"]=json!(turn);span["attributes"]["gen_ai.response.id"]=json!(call);spans.push(span);
        }
        let mut agent=f["spans"][1].clone();agent["endTime"]=json!([BASE/1000+258,0]);spans.push(agent);
        let records:Vec<_>=interaction_parser::parse_interactions(&events,&spans,true).into_iter().flat_map(|batch|batch.records).collect();
        assert!(records.len()>64*3);
        let sink=Arc::new(MemoryExporter(Mutex::new(Vec::new())));let exporter=sink.clone();
        let config:OtlpTraceFlusherConfig=serde_json::from_value(json!({"enabled":true,"protocol":"http/protobuf","serviceName":"stress",
            "debug":true,"dataDir":root.path(),"endpoints":[{"name":"memory","endpoint":"http://127.0.0.1:1"}]})).unwrap();
        let writer=OtlpTraceFlusher::with_parts(config,None,Some(Arc::new(move |_|exporter.clone())),None).unwrap();
        writer.send_batch(records,None).await.unwrap();writer.shutdown().await.unwrap();
        {
        let exported=sink.0.lock().unwrap();let llms:Vec<_>=exported.iter().filter(|span|span.attributes.get("gen_ai.span.kind")==Some(&json!("LLM"))).collect();
        assert_eq!(llms.len(),64);assert_eq!(llms.iter().map(|span|span.attributes["gen_ai.usage.input_tokens"].as_i64().unwrap()).sum::<i64>(),6400);
        }
        let debug=disk(&root.path().join("logs/otlp-debug")).await;assert!(debug.bytes>0);assert!(debug.max<=100*1024*1024);
    }).await.expect("main's 180-second 64-step native usage budget exceeded");
}
