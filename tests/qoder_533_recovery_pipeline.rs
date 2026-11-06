//! #533 actual Source -> native StateStore -> fresh Source recovery contracts.
use loongsuite_pilot::checkpoints::{InputStatePatch, StateStore};
use loongsuite_pilot::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver;
use loongsuite_pilot::inputs::qoder_trace::transcript_scanner;
use loongsuite_pilot::inputs::qoder_trace::transcript_source::QoderTranscriptSource;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    key: String,
    agent: String,
    paths: Vec<String>,
}
impl Fixture {
    fn seed(agent: &str, damaged: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let file = root.join("native.jsonl");
        let epoch = chrono::Utc::now().timestamp_millis() - 60_000;
        let paths = (0..5)
            .map(|i| {
                root.join(format!("cache-{i}.db"))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        for (index, path) in paths.iter().enumerate() {
            let db = rusqlite::Connection::open(path).unwrap();
            db.execute_batch("CREATE TABLE chat_message(session_id TEXT,request_id TEXT,role TEXT,gmt_create INTEGER)").unwrap();
            db.execute(
                "INSERT INTO chat_message VALUES (?1,'owned-0','user',?2)",
                rusqlite::params![
                    if index == 4 {
                        "synthetic-session"
                    } else {
                        "other-session"
                    },
                    epoch + 10
                ],
            )
            .unwrap();
        }
        let stamp = |delta| {
            chrono::DateTime::from_timestamp_millis(epoch + delta)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let secret = format!("sk-{}", "synthetic".repeat(4));
        let rows = [
            json!({"type":"user","timestamp":stamp(10),"message":{"role":"user","content":format!("read the fixture {secret}")}}),
            json!({"type":"assistant","timestamp":stamp(100),"message":{"id":"response-0","model":"synthetic-model","role":"assistant","content":[{"type":"tool_use","id":"tool-0","name":"Read","input":{"path":secret,"options":{"enabled":true,"counts":[2,3]}}}],"stop_reason":"tool_use"}}),
            json!({"type":"user","timestamp":stamp(200),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-0","content":format!("fixture result {secret}")}]}}),
            json!({"type":"assistant","timestamp":stamp(300),"message":{"id":"response-1","model":"synthetic-model","role":"assistant","content":[{"type":"text","text":format!("fixture read {secret}")}],"stop_reason":"end_turn"}}),
        ];
        let mut bytes = Vec::new();
        for row in rows {
            serde_json::to_writer(&mut bytes, &row).unwrap();
            bytes.push(b'\n');
        }
        if damaged {
            bytes.extend_from_slice(b"{broken}\n");
        }
        for row in [
            json!({"type":"progress","timestamp":stamp(400),"data":{"hookEvent":"Stop"}}),
            json!({"type":"last-prompt"}),
        ] {
            serde_json::to_writer(&mut bytes, &row).unwrap();
            bytes.push(b'\n');
        }
        std::fs::write(&file, bytes).unwrap();
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!(["synthetic-session", file])).unwrap(),
        ));
        let fixture = Self {
            _temp: dir,
            root,
            file,
            key,
            agent: agent.into(),
            paths,
        };
        fixture.wake();
        fixture
    }
    fn wake(&self) {
        let source = self
            .root
            .join("state/qoder-transcripts")
            .join(&self.agent)
            .join("sources")
            .join(&self.key);
        let events = source.join("events");
        std::fs::create_dir_all(&events).unwrap();
        let stat =
            transcript_scanner::version(&transcript_scanner::open_regular(&self.file).unwrap())
                .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let value = json!({"schema":1,"key":self.key,"agentId":self.agent,"sessionId":"synthetic-session","transcriptPath":self.file,
            "observedSize":stat.size,"observedAt":now,"event":"UserPromptSubmit","inode":stat.ino,"cwd":self.root,
            "observationId":"owned-native-fixture","requestSetId":"owned-0","parentBusinessInfo":{"product":"app"}});
        loongsuite_pilot::hook_process::with_qoder_wakeup_lock(&source, 25, || {
            std::fs::write(source.join("source.json"), serde_json::to_vec(&value)?)?;
            std::fs::write(
                events.join(format!("{now}-UserPromptSubmit-{:024x}.json", 1)),
                serde_json::to_vec(&value)?,
            )?;
            Ok(())
        })
        .unwrap()
        .unwrap();
    }
    fn source(&self, reverse: bool) -> QoderTranscriptSource {
        let mut paths = self.paths.clone();
        if reverse {
            paths.reverse();
        }
        QoderTranscriptSource::new(
            self.root.clone(),
            self.agent.clone(),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(paths)),
        )
    }
}
#[tokio::test]
async fn source_l75_real_sqlite_search_rotation_survives_disk_and_source_restart_for_both_agents() {
    for agent in ["qoder", "qoder-cn"] {
        let fixture = Fixture::seed(agent, false);
        let id = format!("{agent}-trace");
        let path = fixture.root.join("input-state.json");
        let store = StateStore::new(&path);
        store.load().await;
        let source = fixture.source(false);
        let first = source.read(None, true).await.unwrap();
        assert!(first.records.is_empty());
        let next = first
            .state
            .as_object()
            .unwrap()
            .values()
            .map(|s| s["initialOwnership"]["dbSearch"]["nextIndex"].clone())
            .collect::<Vec<_>>();
        assert_eq!(next, vec![json!(4)]);
        store.update(
            &id,
            InputStatePatch {
                extra: Some(json!({"qoderTranscripts":first.state})),
                ..Default::default()
            },
        );
        store.save().await.unwrap();
        source.stop();
        let loaded = StateStore::new(&path);
        loaded.load().await;
        let source = fixture.source(true);
        let extra = loaded.get(&id).extra().unwrap();
        let second = source
            .read(
                extra.get("qoderTranscripts"),
                loaded.is_persisted(&id, Some("qoderTranscripts")),
            )
            .await
            .unwrap();
        assert_eq!(
            second
                .records
                .iter()
                .filter(|row| row["event.name"] == "llm.response")
                .count(),
            2
        );
        store.update(
            &id,
            InputStatePatch {
                extra: Some(json!({"qoderTranscripts":second.state})),
                ..Default::default()
            },
        );
        store.save().await.unwrap();
        let extra = store.get(&id).extra().unwrap();
        assert!(source
            .read(
                extra.get("qoderTranscripts"),
                store.is_persisted(&id, Some("qoderTranscripts"))
            )
            .await
            .unwrap()
            .records
            .is_empty());
        source.stop();
    }
}

// The second original integration assertion crosses both actual input classes,
// manager masking, a real local JSONL child and the native genai exporter.
use async_trait::async_trait;
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{
    BaseFlusher, FlushError, JsonlFlusher, MultiFlusher, OtlpTraceFlusher, ReadableSpan,
    TraceExporter,
};
use loongsuite_pilot::inputs::qoder_cn_trace::{
    QoderCnTraceInput, QoderCnTraceOptions, QoderCnTraceReaders,
};
use loongsuite_pilot::inputs::qoder_trace::prompt_ownership::{
    QoderOwnershipCursor, QoderOwnershipSearch, QoderPromptOwnership, QoderPromptOwnershipResolver,
};
use loongsuite_pilot::inputs::qoder_trace::{
    read_sqlite_tokens, AttachedImageLookup, InterceptData, QoderTraceInput, QoderTraceOptions,
    QoderTraceReaders, SegmentTokenData, SqliteTokenResult,
};
use loongsuite_pilot::types::{AgentActivityEntry, MaskConfig, MaskMode};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use std::time::Duration;

struct TokenReaders(Vec<String>);
#[async_trait]
impl QoderTraceReaders for TokenReaders {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        vec![]
    }
    async fn read_ide_tokens(&self, session: &str) -> SqliteTokenResult {
        read_sqlite_tokens(session, &self.0).await
    }
    async fn read_ide_images(
        &self,
        _: &[String],
    ) -> Result<HashMap<String, AttachedImageLookup>, String> {
        Ok(HashMap::new())
    }
}
#[async_trait]
impl QoderCnTraceReaders for TokenReaders {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        vec![]
    }
    async fn read_ide_tokens(&self, session: &str) -> SqliteTokenResult {
        read_sqlite_tokens(session, &self.0).await
    }
}
struct OwnershipGate {
    native: NativeQoderPromptOwnershipResolver,
    calls: AtomicUsize,
    allow_second: tokio::sync::Semaphore,
}
#[async_trait]
impl QoderPromptOwnershipResolver for OwnershipGate {
    async fn resolve(
        &self,
        agent: &str,
        session: &str,
        request: &str,
        cursor: Option<&QoderOwnershipCursor>,
        search: &mut QoderOwnershipSearch,
    ) -> Option<QoderPromptOwnership> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call > 0 {
            let permit = self.allow_second.acquire().await.ok()?;
            drop(permit);
        }
        self.native
            .resolve(agent, session, request, cursor, search)
            .await
    }
}
struct CaptureSpans(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait]
impl TraceExporter for CaptureSpans {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
struct CaptureEvents(Arc<Mutex<Vec<Value>>>);
#[async_trait]
impl BaseFlusher for CaptureEvents {
    fn name(&self) -> &str {
        "typed-fixture-capture"
    }
    async fn send(&self, entry: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.0
            .lock()
            .unwrap()
            .push(serde_json::to_value(entry).unwrap());
        Ok(())
    }
    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        self.0.lock().unwrap().extend(
            entries
                .into_iter()
                .map(|entry| serde_json::to_value(entry).unwrap()),
        );
        Ok(())
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}
#[derive(Clone)]
enum ActualInput {
    Qoder(Arc<QoderTraceInput>),
    Cn(Arc<QoderCnTraceInput>),
}
impl ActualInput {
    fn new(
        f: &Fixture,
        store: Arc<StateStore>,
        resolver: Arc<dyn QoderPromptOwnershipResolver>,
    ) -> Self {
        let readers = Arc::new(TokenReaders(f.paths.clone()));
        let log_dir = Some(
            f.root
                .join("logs")
                .join(&f.agent)
                .join("history")
                .to_string_lossy()
                .into_owned(),
        );
        if f.agent == "qoder" {
            Self::Qoder(Arc::new(QoderTraceInput::new_with_sources(
                QoderTraceOptions {
                    state_store: store,
                    log_dir,
                    poll_interval_ms: Some(10),
                    multimodal_enabled: false,
                    upload_mode: None,
                    allowed_root_paths: vec![],
                },
                f.root.clone(),
                readers,
                resolver,
            )))
        } else {
            Self::Cn(Arc::new(QoderCnTraceInput::new_with_sources(
                QoderCnTraceOptions {
                    state_store: store,
                    log_dir,
                    poll_interval_ms: Some(10),
                },
                f.root.clone(),
                readers,
                resolver,
            )))
        }
    }
    fn running(&self) -> bool {
        match self {
            Self::Qoder(i) => i.collector_running(),
            Self::Cn(i) => i.collector_running(),
        }
    }
    async fn start(&self) -> Result<(), String> {
        match self {
            Self::Qoder(i) => i.start().await,
            Self::Cn(i) => i.start().await,
        }
    }
    async fn stop(&self) {
        match self {
            Self::Qoder(i) => i.stop().await.unwrap(),
            Self::Cn(i) => i.stop().await.unwrap(),
        }
    }
    fn bind(&self, manager: &Arc<InputManager>, id: String) {
        let weak = Arc::downgrade(manager);
        let on_entries = move |entries: &[AgentActivityEntry]| {
            if let Some(manager) = weak.upgrade() {
                manager.bind_entries(&id, entries.to_vec());
            }
        };
        match self {
            Self::Qoder(i) => i.bind_collector(on_entries, |_| {}),
            Self::Cn(i) => i.bind_collector(on_entries, |_| {}),
        }
    }
}
fn add_real_tokens(f: &Fixture) {
    for path in &f.paths {
        let db = rusqlite::Connection::open(path).unwrap();
        db.execute_batch("ALTER TABLE chat_message ADD COLUMN id TEXT;ALTER TABLE chat_message ADD COLUMN token_info TEXT;ALTER TABLE chat_message ADD COLUMN model_info TEXT;CREATE TABLE chat_record(request_id TEXT,extra TEXT)").unwrap();
    }
    let db = rusqlite::Connection::open(f.paths.last().unwrap()).unwrap();
    let epoch=db.query_row("SELECT gmt_create FROM chat_message WHERE session_id='synthetic-session' AND role='user' LIMIT 1",[],|row|row.get::<_,i64>(0)).unwrap()-10;
    for step in 0..2i64 {
        db.execute("INSERT INTO chat_message(session_id,request_id,role,gmt_create,id,token_info,model_info) VALUES ('synthetic-session','owned-0','assistant',?1,?2,?3,?4)",
            rusqlite::params![epoch+if step==0{100}else{300},format!("response-{step}"),
                json!({"prompt_tokens":100+step*10,"completion_tokens":10+step,"cached_tokens":50}).to_string(),
                json!({"model_key":"synthetic-model"}).to_string()]).unwrap();
    }
}
fn make_manager(
    f: &Fixture,
    store: Arc<StateStore>,
    output: Arc<MultiFlusher>,
    resolver: Arc<dyn QoderPromptOwnershipResolver>,
) -> (Arc<InputManager>, ActualInput) {
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(store.clone());
    manager.set_configured_user_id("synthetic-user");
    manager.set_mask_config(MaskConfig {
        mode: MaskMode::All,
        types: vec![],
        replacement_mode: None,
    });
    manager.set_flusher(output);
    let input = ActualInput::new(f, store, resolver);
    let (running, start, stop) = (input.clone(), input.clone(), input.clone());
    let id = format!("{}-trace", f.agent);
    manager.register_input(LiveInput::new(
        &id,
        &f.agent,
        "hook-jsonl",
        move || running.running(),
        move || {
            let input = start.clone();
            Box::pin(async move { input.start().await })
        },
        move || {
            let input = stop.clone();
            Box::pin(async move { input.stop().await })
        },
    ));
    input.bind(&manager, id);
    (manager, input)
}
async fn output_rows(root: &std::path::Path) -> Vec<Value> {
    let mut rows = Vec::new();
    if let Ok(mut files) = tokio::fs::read_dir(root.join("output")).await {
        while let Some(file) = files.next_entry().await.unwrap() {
            if file.path().extension().is_some_and(|s| s == "jsonl") {
                rows.extend(
                    tokio::fs::read_to_string(file.path())
                        .await
                        .unwrap()
                        .lines()
                        .filter(|s| !s.is_empty())
                        .map(|s| serde_json::from_str::<Value>(s).unwrap()),
                );
            }
        }
    }
    rows
}
fn kind(span: &ReadableSpan) -> &str {
    span.attributes
        .get("gen_ai.span.kind")
        .and_then(Value::as_str)
        .unwrap_or("")
}
#[tokio::test]
async fn source_l93_both_actual_inputs_manager_masking_and_real_genai_preserve_recovered_semantics()
{
    for agent in ["qoder", "qoder-cn"] {
        let fixture = Fixture::seed(agent, true);
        add_real_tokens(&fixture);
        let store = Arc::new(StateStore::new(fixture.root.join("input-state.json")));
        store.load().await;
        let gate = Arc::new(OwnershipGate {
            native: NativeQoderPromptOwnershipResolver::with_paths(fixture.paths.clone()),
            calls: AtomicUsize::new(0),
            allow_second: tokio::sync::Semaphore::new(0),
        });
        let spans = Arc::new(Mutex::new(Vec::<ReadableSpan>::new()));
        let sink = spans.clone();
        let trace=Arc::new(OtlpTraceFlusher::with_parts(serde_json::from_value(json!({
            "enabled":true,"serviceName":"synthetic-qoder-recovery","protocol":"http/protobuf","dataDir":fixture.root,
            "turnIdleTimeoutMs":0,"endpoints":[{"name":"capture","endpoint":"http://127.0.0.1:1"}]
        })).unwrap(),None,Some(Arc::new(move |_|Arc::new(CaptureSpans(sink.clone())))),None).unwrap());
        let jsonl=Arc::new(JsonlFlusher::new(serde_json::from_value(json!({
            "enabled":true,"outputDir":fixture.root.join("output"),"rotateDaily":false,"maxFileSizeMb":100
        })).unwrap()));
        let typed = Arc::new(Mutex::new(Vec::<Value>::new()));
        let output = Arc::new(MultiFlusher::new(vec![
            Arc::new(CaptureEvents(typed.clone())),
            jsonl,
            trace,
        ]));
        output.start().await.unwrap();
        let (manager, input) = make_manager(&fixture, store.clone(), output.clone(), gate.clone());
        let id = format!("{agent}-trace");
        manager.start_input(&id).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let ready = store
                    .get(&id)
                    .extra()
                    .and_then(|v| v.get("qoderTranscripts").cloned())
                    .and_then(|v| v.as_object().cloned())
                    .is_some_and(|states| {
                        states.values().any(|s| {
                            s.pointer("/initialOwnership/dbSearch/nextIndex") == Some(&json!(4))
                        })
                    });
                if ready && store.is_persisted(&id, Some("qoderTranscripts")) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("first four metadata-only databases must commit search position");
        assert!(output_rows(&fixture.root).await.is_empty());
        assert!(spans.lock().unwrap().is_empty());
        gate.allow_second.add_permits(1);
        tokio::time::timeout(Duration::from_secs(10), async {
            while output_rows(&fixture.root).await.len() < 7 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("actual native recovery must reach manager and local output");
        // bind_entries is asynchronous in native embedding. Public stop drains
        // the actual manager queue before inspecting the complete fanout.
        manager.stop_all().await;
        tokio::time::timeout(Duration::from_secs(5), store.save())
            .await
            .unwrap()
            .unwrap();
        output.flush().await.unwrap();
        let jsonl_events = output_rows(&fixture.root).await;
        let events = typed.lock().unwrap().clone();
        assert_eq!(jsonl_events.len(), events.len());
        for row in jsonl_events
            .iter()
            .filter(|v| v["event.name"] == "tool.call")
        {
            let decoded = row["gen_ai.tool.call.arguments"].clone();
            assert_eq!(
                decoded,
                json!({"path":"[APIKEY_MASKED]","options":{"enabled":true,"counts":[2,3]}})
            );
        }

        assert_eq!(
            events
                .iter()
                .map(|r| r["gen_ai.turn.id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert_eq!(
            events
                .iter()
                .map(|r| r["event.id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            events.len()
        );
        assert_eq!(
            events
                .iter()
                .filter(|r| r["event.name"] == "llm.request")
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|r| r["event.name"] == "llm.response")
                .map(|r| r["gen_ai.usage.input_tokens"].clone())
                .collect::<Vec<_>>(),
            [json!(100), json!(110)]
        );
        assert_eq!(
            events
                .iter()
                .filter(|r| r["event.name"] == "tool.call")
                .map(|r| r["gen_ai.tool.call.arguments"].clone())
                .collect::<Vec<_>>(),
            [json!({"path":"[APIKEY_MASKED]","options":{"enabled":true,"counts":[2,3]}})]
        );
        assert_eq!(
            events
                .iter()
                .filter(|r| r["event.name"] == "tool.result")
                .count(),
            1
        );
        assert!(events
            .iter()
            .filter(|r| r["event.name"] == "llm.response")
            .all(|r| r["agent.transcript_incomplete"] == true));
        let secret = format!("sk-{}", "synthetic".repeat(4));
        assert!(!serde_json::to_string(&events).unwrap().contains(&secret));
        assert!(std::fs::read_to_string(&fixture.file)
            .unwrap()
            .contains("{broken}"));
        let captured = spans.lock().unwrap().clone();
        let llms = captured
            .iter()
            .filter(|s| kind(s) == "LLM")
            .collect::<Vec<_>>();
        assert_eq!(llms.len(), 2);
        let mut input_tokens = llms
            .iter()
            .map(|s| s.attributes["gen_ai.usage.input_tokens"].as_f64().unwrap())
            .collect::<Vec<_>>();
        input_tokens.sort_by(f64::total_cmp);
        assert_eq!(input_tokens, [100.0, 110.0]);
        let mut output_tokens = llms
            .iter()
            .map(|s| s.attributes["gen_ai.usage.output_tokens"].as_f64().unwrap())
            .collect::<Vec<_>>();
        output_tokens.sort_by(f64::total_cmp);
        assert_eq!(output_tokens, [10.0, 11.0]);
        assert_eq!(captured.iter().filter(|s| kind(s) == "TOOL").count(), 1);
        let entries = captured
            .iter()
            .filter(|s| kind(s) == "ENTRY")
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].parent_span_id.is_none());
        assert_eq!(entries[0].attributes["agent.transcript_incomplete"], true);
        let aggregate = captured.iter().find(|s| kind(s) == "AGENT").unwrap();
        assert_eq!(
            aggregate.attributes["gen_ai.usage.input_tokens"].as_f64(),
            Some(210.0)
        );
        assert_eq!(
            aggregate.attributes["gen_ai.usage.output_tokens"].as_f64(),
            Some(21.0)
        );
        let ids = captured
            .iter()
            .map(|s| s.span_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), captured.len());
        assert!(captured
            .iter()
            .filter(|s| s.span_id != entries[0].span_id)
            .all(|s| s.parent_span_id.as_deref().is_some_and(|p| ids.contains(p))));
        assert!(!serde_json::to_string(
            &captured.iter().map(|s| &s.attributes).collect::<Vec<_>>()
        )
        .unwrap()
        .contains(&secret));
        manager.stop_all().await;
        drop(input);
        let fresh = Arc::new(StateStore::new(fixture.root.join("input-state.json")));
        fresh.load().await;
        let (next, _) = make_manager(
            &fixture,
            fresh,
            output.clone(),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(
                fixture.paths.clone(),
            )),
        );
        next.start_input(&id).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        next.stop_all().await;
        output.flush().await.unwrap();
        assert_eq!(output_rows(&fixture.root).await.len(), events.len());
        assert_eq!(spans.lock().unwrap().len(), 7);
        output.shutdown().await.unwrap();
    }
}
