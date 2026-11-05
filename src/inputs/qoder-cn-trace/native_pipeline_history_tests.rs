//! Exact main qoder/qoder-cn × IDE/CLI queued-turn Native transcript matrices.
//! Token readers are controlled exactly as upstream; notice, transcript, hosted
//! lifecycle, disk checkpoint, Native masking and span conversion are real.
use crate::{
    checkpoints::StateStore,
    core::{InputManager, LiveInput},
    flushers::{
        BaseFlusher, ConvertOptions, EventLogConverter, FlushError, GenAiEventLogConverter,
    },
    inputs::{
        qoder_cn_trace::{QoderCnTraceInput, QoderCnTraceOptions, QoderCnTraceReaders},
        qoder_trace::{
            InterceptData, InterceptTokenData, QoderTraceInput, QoderTraceOptions,
            QoderTraceReaders, SegmentTokenData, SqliteTokenData, SqliteTokenResult,
        },
    },
    types::{AgentActivityEntry, MaskConfig, MaskMode, MaskReplacementMode},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
struct Readers {
    epoch: i64,
    cli: bool,
    turns: AtomicUsize,
}
impl Readers {
    fn tokens(&self) -> SqliteTokenResult {
        SqliteTokenResult {
            matched_db_path: None,
            rows: (0..self.turns.load(Ordering::SeqCst))
                .flat_map(|turn| {
                    (0..2).map(move |step| SqliteTokenData {
                        session_id: "synthetic-session".into(),
                        request_id: if self.cli {
                            format!("req-{turn}-{step}")
                        } else {
                            format!("req-{turn}")
                        },
                        message_id: format!("response-{turn}-{step}"),
                        gmt_create: self.epoch
                            + turn as i64 * 10000
                            + if step == 0 { 100 } else { 300 },
                        input_tokens: 100 + turn as i64 * 20 + step as i64 * 10,
                        output_tokens: 10 + turn as i64 * 2 + step as i64,
                        cache_read_tokens: 50,
                        model: Some("synthetic-model".into()),
                    })
                })
                .collect(),
        }
    }
    fn intercept(&self) -> InterceptData {
        InterceptData {
            system_prompt: None,
            tokens: (0..3)
                .flat_map(|turn| {
                    (0..2).map(move |step| InterceptTokenData {
                        id: format!("response-{turn}-{step}"),
                        ts: self.epoch + turn * 10000 + if step == 0 { 100 } else { 300 },
                        prompt_tokens: 100 + turn * 20 + step * 10,
                        completion_tokens: 10 + turn * 2 + step,
                        cached_tokens: 50,
                        reasoning_tokens: 0,
                        total_tokens: 110 + turn * 22 + step * 11,
                    })
                })
                .collect(),
        }
    }
}
macro_rules! reader {
    ($trait:ident) => {
        #[async_trait]
        impl $trait for Readers {
            async fn read_cli_intercept(&self) -> InterceptData {
                self.intercept()
            }
            async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
                vec![]
            }
            async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
                self.tokens()
            }
        }
    };
}
reader!(QoderTraceReaders);
reader!(QoderCnTraceReaders);
#[derive(Default)]
struct Sink(Mutex<Vec<Vec<AgentActivityEntry>>>);
#[async_trait]
impl BaseFlusher for Sink {
    fn name(&self) -> &str {
        "native-capture"
    }
    async fn send(&self, e: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.send_batch(vec![e], None).await
    }
    async fn send_batch(
        &self,
        e: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        self.0.lock().unwrap().push(e);
        Ok(())
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}
impl Sink {
    fn all(&self) -> Vec<AgentActivityEntry> {
        self.0.lock().unwrap().iter().flatten().cloned().collect()
    }
    fn values(&self) -> Vec<Value> {
        self.all()
            .iter()
            .map(|e| serde_json::to_value(e).unwrap())
            .collect()
    }
}
enum Input {
    Global(QoderTraceInput),
    Cn(QoderCnTraceInput),
}
impl Input {
    async fn start(&self) -> Result<(), String> {
        match self {
            Self::Global(i) => i.start().await,
            Self::Cn(i) => i.start().await,
        }
    }
    async fn stop(&self) -> Result<(), String> {
        match self {
            Self::Global(i) => i.stop().await,
            Self::Cn(i) => i.stop().await,
        }
    }
    async fn cycle(&self) {
        match self {
            Self::Global(i) => i.inner.run_cycle().await,
            Self::Cn(i) => i.inner.run_cycle().await,
        }
    }
    fn running(&self) -> bool {
        match self {
            Self::Global(i) => i.collector_running(),
            Self::Cn(i) => i.collector_running(),
        }
    }
    fn bind(&self, manager: &Arc<InputManager>, id: &'static str) {
        let weak = Arc::downgrade(manager);
        let callback = move |rows: &[AgentActivityEntry]| {
            if let Some(m) = weak.upgrade() {
                m.bind_entries(id, rows.to_vec());
            }
        };
        match self {
            Self::Global(i) => i.bind_collector(callback, |_| {}),
            Self::Cn(i) => i.bind_collector(callback, |_| {}),
        }
    }
}
struct Pipeline {
    input: Arc<Input>,
    manager: Arc<InputManager>,
}
impl Pipeline {
    async fn new(root: &Path, agent: &str, readers: Arc<Readers>, sink: Arc<Sink>) -> Self {
        let store = Arc::new(StateStore::new(root.join("input-state.json")));
        store.load().await;
        let log = Some(root.join("custom-history").to_string_lossy().into_owned());
        let input = Arc::new(if agent == "qoder" {
            Input::Global(QoderTraceInput::with_readers(
                QoderTraceOptions {
                    state_store: store.clone(),
                    log_dir: log,
                    poll_interval_ms: Some(60000),
                    multimodal_enabled: false,
                    upload_mode: None,
                    allowed_root_paths: vec![],
                },
                readers,
            ))
        } else {
            Input::Cn(QoderCnTraceInput::new_with_sources(QoderCnTraceOptions{
   state_store:store.clone(),log_dir:log,poll_interval_ms:Some(60000),
  },root.into(),readers,Arc::new(crate::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver::default())))
        });
        let id = if agent == "qoder" {
            "qoder-trace"
        } else {
            "qoder-cn-trace"
        };
        let manager = Arc::new(InputManager::new());
        manager.set_state_store(store);
        manager.set_flusher(sink);
        manager.set_mask_config(MaskConfig {
            mode: MaskMode::All,
            types: vec![],
            replacement_mode: Some(MaskReplacementMode::Placeholder),
        });
        let (running, start, stop) = (input.clone(), input.clone(), input.clone());
        manager.register_input(LiveInput::new(
            id,
            agent,
            "session-file-polling",
            move || running.running(),
            move || {
                let input = start.clone();
                Box::pin(async move { input.start().await })
            },
            move || {
                let input = stop.clone();
                Box::pin(async move { input.stop().await.unwrap() })
            },
        ));
        input.bind(&manager, id);
        manager.start_input(id).await;
        input.cycle().await;
        Self { input, manager }
    }
    async fn close(&self) {
        self.manager.stop_all().await;
    }
}
fn rows(epoch: i64, turn: usize, cli: bool, secret: &str) -> Vec<Value> {
    let at = |ms| {
        chrono::DateTime::from_timestamp_millis(epoch + turn as i64 * 10000 + ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let progress =
        |event, ms| json!({"type":"progress","timestamp":at(ms),"data":{"hookEvent":event}});
    let mut user = json!({"type":"user","uuid":format!("user-{turn}"),"timestamp":at(10),"message":{"role":"user","content":format!("prompt {turn} {secret}")}});
    if cli {
        user["entrypoint"] = "cli".into();
    }
    let mut rows = vec![
        progress("UserPromptSubmit", 0),
        user,
        progress("UserPromptSubmit", 20),
        json!({"type":"assistant","timestamp":at(100),"message":{"id":format!("response-{turn}-0"),"model":"synthetic-model","role":"assistant","usage":{"request_id":format!("req-{turn}-0")},"content":[{"type":"tool_use","id":format!("tool-{turn}"),"name":"Read","input":{"path":secret}}],"stop_reason":"tool_use"}}),
        progress("PreToolUse", 120),
        json!({"type":"user","timestamp":at(200),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("tool-{turn}"),"content":format!("result {secret}")}]}}),
        progress("PostToolUse", 220),
        json!({"type":"assistant","timestamp":at(300),"message":{"id":format!("response-{turn}-1"),"model":"synthetic-model","role":"assistant","usage":{"request_id":format!("req-{turn}-1")},"content":[{"type":"text","text":format!("answer {turn} {secret}")}],"stop_reason":"end_turn"}}),
        progress("Stop", 400),
        json!({"type":"last-prompt"}),
    ];
    if cli {
        rows.push(json!({"type":"user","entrypoint":"cli","timestamp":at(500),"message":{"role":"user","content":"<command-message>exit</command-message>\n<command-name>/exit</command-name>"}}));
    }
    rows
}
fn append(path: &Path, rows: &[Value]) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for row in rows {
        writeln!(file, "{row}").unwrap();
    }
}
fn wake(root: &Path, agent: &str, transcript: &Path) {
    assert!(crate::hook_process::publish_qoder_wakeup(
        &json!({"session_id":"synthetic-session","transcript_path":transcript,"hook_event_name":"Stop","cwd":root}),
        root,
        agent,
        None,
        &serde_json::Map::new(),
        &serde_json::Map::new(),
    ));
}

fn count(rows: &[Value], name: &str) -> usize {
    rows.iter().filter(|r| r["event.name"] == name).count()
}
async fn scenario(agent: &str, cli: bool) {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let transcript = root.join("native.jsonl");
    let epoch = chrono::Utc::now().timestamp_millis() - 60000;
    let secret = "sk-".to_owned() + &"synthetic".repeat(4);
    let first = rows(epoch, 0, cli, &secret);
    append(&transcript, &first[..2]);
    wake(&root, agent, &transcript);
    append(&transcript, &first[2..]);
    append(&transcript, &rows(epoch, 1, cli, &secret));
    wake(&root, agent, &transcript);
    let readers = Arc::new(Readers {
        epoch,
        cli,
        turns: AtomicUsize::new(2),
    });
    let sink = Arc::new(Sink::default());
    let initial = Pipeline::new(&root, agent, readers.clone(), sink.clone()).await;
    assert_eq!(count(&sink.values(), "llm.response"), 4);
    wake(&root, agent, &transcript);
    let before = sink.0.lock().unwrap().len();
    initial.input.cycle().await;
    assert_eq!(sink.0.lock().unwrap().len(), before);
    initial.close().await;
    let first = sink.values();
    for event in ["other", "llm.request"] {
        let user_texts = first
            .iter()
            .filter(|row| row["event.name"] == event)
            .flat_map(|row| {
                row["gen_ai.input.messages_delta"]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .filter(|message| message["role"] == "user")
            .flat_map(|message| message["parts"].as_array().into_iter().flatten())
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["content"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            user_texts,
            ["prompt 0 [APIKEY_MASKED]", "prompt 1 [APIKEY_MASKED]"]
        );
    }
    assert_eq!(
        first
            .iter()
            .map(|r| r["gen_ai.turn.id"].as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        2
    );
    assert_eq!(count(&first, "tool.call"), 2);
    assert_eq!(count(&first, "tool.result"), 2);
    append(&transcript, &rows(epoch, 2, cli, &secret));
    wake(&root, agent, &transcript);
    readers.turns.store(3, Ordering::SeqCst);
    let restarted = Pipeline::new(&root, agent, readers, sink.clone()).await;
    restarted.close().await;
    let entries = sink.values();
    assert_eq!(count(&entries, "llm.response"), 6);
    assert_eq!(count(&entries, "llm.request"), 6);
    assert_eq!(count(&entries, "tool.call"), 3);
    assert_eq!(count(&entries, "tool.result"), 3);
    let ids: std::collections::BTreeSet<_> = entries
        .iter()
        .map(|r| r["event.id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids.len(), entries.len());
    assert_eq!(
        entries
            .iter()
            .map(|r| r["trace_id"].as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
    let response: Vec<_> = entries
        .iter()
        .filter(|r| r["event.name"] == "llm.response")
        .collect();
    assert_eq!(
        response
            .iter()
            .map(|r| r["gen_ai.usage.input_tokens"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![100, 110, 120, 130, 140, 150]
    );
    assert_eq!(
        response
            .iter()
            .map(|r| r["gen_ai.usage.output_tokens"].as_i64().unwrap())
            .sum::<i64>(),
        75
    );
    let encoded = serde_json::to_string(&entries).unwrap();
    assert!(!encoded.contains(&secret));
    assert!(encoded.contains("[APIKEY_MASKED]"));
    assert!(entries
        .iter()
        .filter(|r| r["event.name"] == "tool.call")
        .all(|r| r["gen_ai.tool.call.arguments"] == json!({"path":"[APIKEY_MASKED]"})));
    let entries: Vec<_> = sink
        .all()
        .into_iter()
        .filter(|e| e.event_name.map(|n| n.as_str()) != Some("agent.input"))
        .collect();
    let converted = GenAiEventLogConverter
        .convert(
            &entries,
            &ConvertOptions {
                strict: false,
                passthrough_keys: vec![],
            },
        )
        .unwrap();
    let llms: Vec<_> = converted
        .spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.operation.name") == Some(&json!("chat")))
        .collect();
    assert_eq!(llms.len(), 6);
    assert_eq!(
        converted
            .spans
            .iter()
            .filter(|s| s.attributes.get("gen_ai.operation.name") == Some(&json!("execute_tool")))
            .count(),
        3
    );
    assert_eq!(
        llms.iter()
            .map(|s| s.attributes["gen_ai.usage.input_tokens"].as_i64().unwrap())
            .sum::<i64>(),
        750
    );
    assert_eq!(
        llms.iter()
            .map(|s| s.attributes["gen_ai.usage.output_tokens"].as_i64().unwrap())
            .sum::<i64>(),
        75
    );
    assert_eq!(
        converted
            .spans
            .iter()
            .map(|s| &s.trace_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
}
#[tokio::test]
async fn main_qoder_and_cn_ide_and_cli_native_queue_duplicate_restart_mask_and_tokens_match_all_four_original_matrices(
) {
    for agent in ["qoder", "qoder-cn"] {
        for cli in [false, true] {
            tokio::time::timeout(Duration::from_secs(15), scenario(agent, cli))
                .await
                .expect("original project15s per expanded Native pipeline case");
        }
    }
}
