//! Real native transcript → manager → loopback HTTP acceptance and restart.
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{BaseFlusher, HttpFlusher};
use loongsuite_pilot::inputs::codex_transcript::{
    CodexTranscriptInput, CodexTranscriptInputOptions,
};
use loongsuite_pilot::types::HttpFlusherConfig;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Receiver {
    url: String,
    healthy: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    disconnected: Arc<AtomicUsize>,
    accepted: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Receiver {
    async fn new(hang: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let healthy = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let disconnected = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(Mutex::new(Vec::new()));
        let (health, count, closed, received) = (
            healthy.clone(),
            requests.clone(),
            disconnected.clone(),
            accepted.clone(),
        );
        let task = tokio::spawn(async move {
            let mut sockets = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (mut socket, _) = result.unwrap();
                        let (health, count, closed, received) = (health.clone(), count.clone(), closed.clone(), received.clone());
                        sockets.spawn(async move {
                            tokio::time::timeout(Duration::from_secs(10), async move {
                                let mut bytes = Vec::new();
                                let mut chunk = [0u8; 4096];
                                let end = loop {
                                    let size = socket.read(&mut chunk).await.unwrap();
                                    if size == 0 { return; }
                                    bytes.extend_from_slice(&chunk[..size]);
                                    assert!(bytes.len() < 1024 * 1024);
                                    if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") { break i + 4; }
                                };
                                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                                let length: usize = headers.lines().find_map(|s| s.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                                while bytes.len() < end + length {
                                    let size = socket.read(&mut chunk).await.unwrap();
                                    if size == 0 { return; }
                                    bytes.extend_from_slice(&chunk[..size]);
                                    assert!(bytes.len() < 1024 * 1024);
                                }
                                count.fetch_add(1, Ordering::SeqCst);
                                if hang {
                                    if socket.read(&mut chunk).await.unwrap_or(0) == 0 { closed.fetch_add(1, Ordering::SeqCst); }
                                    return;
                                }
                                let status = if health.load(Ordering::SeqCst) {
                                    received.lock().unwrap().push(serde_json::from_slice(&bytes[end..end+length]).unwrap());
                                    "200 OK"
                                } else { "503 Unavailable" };
                                let response = format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
                                let _ = socket.write_all(response.as_bytes()).await;
                            }).await.expect("loopback HTTP socket did not settle");
                        });
                    }
                    result = sockets.join_next(), if !sockets.is_empty() => {
                        result.unwrap().expect("loopback HTTP task failed");
                    }
                }
            }
        });
        Self {
            url,
            healthy,
            requests,
            disconnected,
            accepted,
            task,
        }
    }
}
async fn eventually(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("native pipeline condition did not settle");
}
fn config(url: &str) -> HttpFlusherConfig {
    serde_json::from_value(json!({"enabled":true, "url":url,
        "batchMaxSize":100, "flushIntervalMs":10, "requestTimeoutMs":60000}))
    .unwrap()
}
fn pipeline(
    root: &Path,
    store: Arc<StateStore>,
    url: &str,
) -> (
    Arc<CodexTranscriptInput>,
    Arc<InputManager>,
    Arc<HttpFlusher>,
) {
    let input = Arc::new(CodexTranscriptInput::new(CodexTranscriptInputOptions {
        state_store: store.clone(),
        session_dir: Some(root.join("sessions").to_string_lossy().into_owned()),
        wakeup_dir: Some(root.join("wakeups").to_string_lossy().into_owned()),
        span_context_dir: Some(root.join("spans").to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
        multimodal: None,
    }));
    let http = Arc::new(HttpFlusher::new(config(url)));
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(store);
    manager.set_flusher(http.clone());
    manager.set_user_id("synthetic-user");
    let (running, start, stop) = (input.clone(), input.clone(), input.clone());
    manager.register_input(LiveInput::new(
        "codex-transcript",
        "codex",
        "session-file-polling",
        move || running.collector_running(),
        move || {
            let input = start.clone();
            Box::pin(async move { input.start().await })
        },
        move || {
            let input = stop.clone();
            Box::pin(async move {
                input.stop().await.unwrap();
            })
        },
    ));
    let weak = Arc::downgrade(&manager);
    input.on_entries(move |entries| {
        if let Some(manager) = weak.upgrade() {
            manager.bind_entries("codex-transcript", entries.to_vec());
        }
    });
    (input, manager, http)
}
async fn disk_offset(path: &Path, key: &str) -> f64 {
    let state: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    state[key]["lastOffset"].as_f64().unwrap()
}

#[tokio::test]
async fn native_codex_http_acceptance_blocks_disk_progress_and_restart_does_not_duplicate_facts() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let receiver = Receiver::new(false).await;
    let path = root.path().join("state.json");
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    store.set_offset(&key, 0.0);
    store.save().await.unwrap();
    let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
    http.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), input.start())
        .await
        .unwrap()
        .unwrap();
    tokio::fs::write(&rollout, completed_turn()).await.unwrap();
    input.request_collection();
    eventually(|| receiver.requests.load(Ordering::SeqCst) >= 3).await;
    assert_eq!(disk_offset(&path, &key).await, 0.0);
    assert!(store.waiting_for_output());
    for _ in 0..100 {
        input.request_collection();
    }
    receiver.healthy.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(3), store.save())
        .await
        .unwrap()
        .unwrap();
    assert!(disk_offset(&path, &key).await > 0.0);
    let accepted: Vec<_> = receiver
        .accepted
        .lock()
        .unwrap()
        .iter()
        .flat_map(|v| v["entries"].as_array().unwrap().clone())
        .collect();
    let mut facts = BTreeSet::new();
    for entry in accepted.iter().filter(|e| {
        matches!(
            e["event.name"].as_str(),
            Some("llm.request" | "llm.response" | "tool.call" | "tool.result")
        )
    }) {
        let fact = (
            entry["event.name"].to_string(),
            entry["gen_ai.step.id"].to_string(),
            entry["gen_ai.tool.call.id"].to_string(),
        );
        assert!(facts.insert(fact), "native operation was copied");
    }
    assert!(!facts.is_empty());
    assert!(!accepted.iter().any(|e| matches!(
        e["event.name"].as_str(),
        Some(
            "gen_ai.model.request"
                | "gen_ai.model.response"
                | "gen_ai.tool.call"
                | "gen_ai.tool.result"
        )
    )));
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
    let before = receiver.requests.load(Ordering::SeqCst);
    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    let (input, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    input.run_cycle().await;
    restored.save().await.unwrap();
    assert_eq!(receiver.requests.load(Ordering::SeqCst), before);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_codex_hung_http_is_cancelled_and_failed_checkpoint_replays_after_restart() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let hanging = Receiver::new(true).await;
    let path = root.path().join("state.json");
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    store.set_offset(&key, 0.0);
    store.save().await.unwrap();
    let (input, manager, http) = pipeline(root.path(), store.clone(), &hanging.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    tokio::fs::write(&rollout, completed_turn()).await.unwrap();
    input.request_collection();
    eventually(|| hanging.requests.load(Ordering::SeqCst) > 0).await;
    manager.cancel_pending_outputs();
    tokio::time::timeout(Duration::from_secs(1), manager.stop_all())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), http.shutdown())
        .await
        .unwrap()
        .unwrap();
    eventually(|| hanging.disconnected.load(Ordering::SeqCst) > 0).await;
    assert!(store.save_failed());
    assert!(store.save().await.is_err());
    assert_eq!(disk_offset(&path, &key).await, 0.0);
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    let (input, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), input.start())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), restored.save())
        .await
        .unwrap()
        .unwrap();
    assert!(disk_offset(&path, &key).await > 0.0);
    assert!(!receiver.accepted.lock().unwrap().is_empty());
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

fn completed_turn() -> String {
    fn record(timestamp: &str, kind: &str, payload: serde_json::Value) -> String {
        serde_json::json!({ "timestamp": timestamp, "type": kind, "payload": payload }).to_string()
    }
    [
        record(
            "2026-06-24T06:00:00.000Z",
            "session_meta",
            serde_json::json!({
                "id": "session-1",
                "model_provider": "openai",
                "dynamic_tools": [{ "name": "exec_command", "description": "Run a command" }],
            }),
        ),
        record(
            "2026-06-24T06:00:01.000Z",
            "turn_context",
            serde_json::json!({
                "turn_id": "turn-1",
                "model": "gpt-5.5",
                "cwd": "/tmp/project",
                "developer_instructions": "Follow the project conventions.",
            }),
        ),
        record(
            "2026-06-24T06:00:02.000Z",
            "event_msg",
            serde_json::json!({ "type": "task_started", "turn_id": "turn-1" }),
        ),
        record(
            "2026-06-24T06:00:03.000Z",
            "response_item",
            serde_json::json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "fix it" }],
            }),
        ),
        record(
            "2026-06-24T06:00:04.000Z",
            "event_msg",
            serde_json::json!({
                "type": "agent_message",
                "message": "inspect the script first",
                "phase": "commentary",
            }),
        ),
        record(
            "2026-06-24T06:00:05.000Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "id": "fc-1",
                "call_id": "call-1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}",
            }),
        ),
        record(
            "2026-06-24T06:00:06.000Z",
            "response_item",
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "\"/tmp/project\"",
            }),
        ),
        record(
            "2026-06-24T06:00:06.000Z",
            "event_msg",
            serde_json::json!({
                "type": "token_count",
                "info": {
                    "total_token_usage": { "total_tokens": 110 },
                    "last_token_usage": {
                        "input_tokens": 100,
                        "output_tokens": 10,
                        "cached_input_tokens": 0,
                        "reasoning_output_tokens": 9,
                        "total_tokens": 110,
                    },
                },
            }),
        ),
        record(
            "2026-06-24T06:00:10.000Z",
            "event_msg",
            serde_json::json!({ "type": "agent_message", "message": "fixed", "phase": "final" }),
        ),
        record(
            "2026-06-24T06:00:10.000Z",
            "event_msg",
            serde_json::json!({
                "type": "token_count",
                "info": {
                    "total_token_usage": { "total_tokens": 143 },
                    "last_token_usage": {
                        "input_tokens": 130,
                        "output_tokens": 13,
                        "cached_input_tokens": 0,
                        "reasoning_output_tokens": 12,
                        "total_tokens": 143,
                    },
                },
            }),
        ),
        record(
            "2026-06-24T06:00:11.000Z",
            "event_msg",
            serde_json::json!({
                "type": "task_complete",
                "turn_id": "turn-1",
                "last_agent_message": "fixed",
            }),
        ),
    ]
    .join("\n")
        + "\n"
}

struct StartupBody(Arc<AtomicUsize>);
#[async_trait::async_trait]
impl loongsuite_pilot::inputs::base::InputBody for StartupBody {
    fn id(&self) -> &str {
        "codex-startup"
    }
    fn agent_type(&self) -> loongsuite_pilot::types::ClientType {
        loongsuite_pilot::types::ClientType::CodexCliHook
    }
    fn collection_method(&self) -> loongsuite_pilot::types::CollectionMethod {
        loongsuite_pilot::types::CollectionMethod::SessionFilePolling
    }
    async fn collect(
        &self,
        runtime: &loongsuite_pilot::inputs::base::InputRuntime,
    ) -> anyhow::Result<Vec<loongsuite_pilot::types::AgentActivityEntry>> {
        if self.0.fetch_add(1, Ordering::SeqCst) > 0 {
            return Ok(vec![]);
        }
        runtime.set_state_fields(None, Some(1.0), None);
        Ok(vec![serde_json::from_value(json!({
            "event.id":"startup-audit", "event.name":"gen_ai.agent.invoke",
            "time_unix_nano":"1800000000000000000", "gen_ai.agent.type":"codex",
            "gen_ai.session.id":"startup-session", "gen_ai.turn.id":"startup-turn",
            "gen_ai.agent.invocation.id":"startup-invocation"
        }))
        .unwrap()])
    }
}
type DetectionAction = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send>>
        + Send
        + Sync,
>;
struct Detection {
    id: &'static str,
    start: DetectionAction,
    stop: DetectionAction,
}

#[async_trait::async_trait]
impl loongsuite_pilot::types::AgentDetection for Detection {
    fn id(&self) -> &str {
        self.id
    }
    fn type_name(&self) -> &str {
        "session-file-polling"
    }
    async fn is_available(&self) -> bool {
        true
    }
    fn watch_paths(&self) -> &[String] {
        &[]
    }
    fn enabled(&self) -> bool {
        true
    }
    async fn start(&self) -> anyhow::Result<()> {
        (self.start)().await
    }
    async fn stop(&self) -> anyhow::Result<()> {
        (self.stop)().await
    }
    fn poll_interval_ms(&self) -> u64 {
        60000
    }
}

#[tokio::test]
async fn discovery_startup_outage_keeps_later_agents_running_and_one_inflight_cycle() {
    use loongsuite_pilot::core::AgentDiscoveryService;
    use loongsuite_pilot::inputs::base::HostedInput;
    for hang in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let receiver = Receiver::new(hang).await;
        let path = root.path().join("state.json");
        let store = Arc::new(StateStore::new(&path));
        store.set_offset("codex-startup", 0.0);
        store.save().await.unwrap();
        let collections = Arc::new(AtomicUsize::new(0));
        let input = HostedInput::new(
            StartupBody(collections.clone()),
            "StartupBody",
            store.clone(),
            Some(60000),
        );
        let http = Arc::new(HttpFlusher::new(config(&receiver.url)));
        let manager = Arc::new(InputManager::new());
        manager.set_state_store(store.clone());
        manager.set_flusher(http.clone());
        let (running, start, stop) = (input.clone(), input.clone(), input.clone());
        manager.register_input(LiveInput::new(
            "codex-startup",
            "codex",
            "session-file-polling",
            move || running.running(),
            move || {
                let input = start.clone();
                Box::pin(async move { input.start().await })
            },
            move || {
                let input = stop.clone();
                Box::pin(async move {
                    input.stop().await.unwrap();
                })
            },
        ));
        let weak = Arc::downgrade(&manager);
        input.on_entries(move |entries| {
            if let Some(manager) = weak.upgrade() {
                manager.bind_entries("codex-startup", entries.to_vec());
            }
        });
        let later = Arc::new(AtomicUsize::new(0));
        let later_counter = later.clone();
        let (start_input, stop_input) = (input.clone(), input.clone());
        let discovery = Arc::new(AgentDiscoveryService::new(vec![
            Arc::new(Detection {
                id: "codex-startup",
                start: Arc::new(move || {
                    let input = start_input.clone();
                    Box::pin(async move { input.start().await.map_err(anyhow::Error::msg) })
                }),
                stop: Arc::new(move || {
                    let input = stop_input.clone();
                    Box::pin(async move { input.stop().await.map_err(anyhow::Error::msg) })
                }),
            }),
            Arc::new(Detection {
                id: "later-agent",
                start: Arc::new(move || {
                    later_counter.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { Ok(()) })
                }),
                stop: Arc::new(|| Box::pin(async { Ok(()) })),
            }),
        ]));
        http.start().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), discovery.start())
            .await
            .unwrap();
        eventually(|| receiver.requests.load(Ordering::SeqCst) >= if hang { 1 } else { 3 }).await;
        assert_eq!(later.load(Ordering::SeqCst), 1);
        for _ in 0..100 {
            input.request_collection();
        }
        assert_eq!(collections.load(Ordering::SeqCst), 1);
        assert_eq!(disk_offset(&path, "codex-startup").await, 0.0);
        if !hang {
            receiver.healthy.store(true, Ordering::SeqCst);
            tokio::time::timeout(Duration::from_secs(3), store.save())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(disk_offset(&path, "codex-startup").await, 1.0);
        }
        manager.cancel_pending_outputs();
        tokio::time::timeout(Duration::from_secs(1), discovery.stop())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), manager.stop_all())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), http.shutdown())
            .await
            .unwrap()
            .unwrap();
        if hang {
            eventually(|| receiver.disconnected.load(Ordering::SeqCst) > 0).await;
            assert!(store.save_failed());
            assert_eq!(disk_offset(&path, "codex-startup").await, 0.0);
        }
    }
}
async fn disk_has_source_key(path: &Path, key: &str) -> bool {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .unwrap()
            .get(key)
            .is_some(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => panic!("failed reading synthetic checkpoint: {error}"),
    }
}

/// Fault injection: normal startup/collect has saved this source checkpoint.
/// Remove just its synthetic disk key, retaining all other source values and
/// the independent body-free ownership/floor sidecar byte-for-byte.
async fn lose_synthetic_source_checkpoint(root: &Path, path: &Path, key: &str) {
    // start() now signals collection readiness before checkpoint IO finishes.
    // Establish the actual durable baseline before deleting only this key.
    tokio::time::timeout(Duration::from_secs(1), async {
        while !disk_has_source_key(path, key).await {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("synthetic baseline checkpoint did not commit within one second");
    assert!(
        disk_has_source_key(path, key).await,
        "normal baseline/park checkpoint must be saved before fault injection"
    );
    let owners = root.join("wakeups/source-owners");
    let snapshot_owners = || -> std::collections::BTreeMap<_, _> {
        std::fs::read_dir(&owners)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                let bytes = std::fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect()
    };
    let before_owners = snapshot_owners();
    assert!(!before_owners.is_empty());
    let mut expected: Value =
        serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    assert!(expected.as_object_mut().unwrap().remove(key).is_some());
    assert!(
        expected.get("unrelated-source").is_some(),
        "keep an unrelated checkpoint as a loss-isolation control"
    );
    tokio::fs::write(path, serde_json::to_vec(&expected).unwrap())
        .await
        .unwrap();
    assert!(!disk_has_source_key(path, key).await);
    let after: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    assert_eq!(
        after, expected,
        "fault injection changed another canonical state value"
    );
    assert_eq!(
        snapshot_owners(),
        before_owners,
        "fault injection changed independent source ownership/floor metadata"
    );
}

fn assert_replayed_native_facts(receiver: &Receiver) {
    let bodies = receiver.accepted.lock().unwrap();
    let entries: Vec<_> = bodies
        .iter()
        .flat_map(|body| body["entries"].as_array().unwrap().iter())
        .collect();
    let names: BTreeSet<_> = entries
        .iter()
        .filter_map(|entry| entry["event.name"].as_str())
        .collect();
    for name in ["llm.request", "llm.response", "tool.call", "tool.result"] {
        assert!(names.contains(name), "missing native replay fact {name}");
    }
    assert!(entries
        .iter()
        .any(|entry| entry["event.name"] == "llm.request"
            && entry["gen_ai.input.messages"]
                .to_string()
                .contains("fix it")));
    assert!(entries
        .iter()
        .any(|entry| entry["event.name"] == "llm.response"
            && entry["gen_ai.output.messages"]
                .to_string()
                .contains("fixed")));

    let tool_call = entries
        .iter()
        .find(|entry| entry["event.name"] == "tool.call")
        .expect("missing tool.call");
    let arguments = tool_call["gen_ai.tool.call.arguments"]
        .as_str()
        .expect("HTTP log fields preserve the string serialization contract");
    // The native fixture supplied this exact JSON text. HTTP log serialization
    // retains its bytes here and the parsed object must retain the same command.
    assert_eq!(arguments.as_bytes(), br#"{"command":"pwd"}"#);
    assert_eq!(
        serde_json::from_str::<Value>(arguments).unwrap(),
        json!({"command":"pwd"})
    );

    assert!(entries
        .iter()
        .any(|entry| entry["event.name"] == "tool.result"
            && entry["gen_ai.tool.call.result"]
                .to_string()
                .contains("/tmp/project")));
}

#[tokio::test]
async fn native_codex_fresh_source_without_any_disk_key_replays_after_http_cancellation() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let hanging = Receiver::new(true).await;
    let path = root.path().join("state.json");
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    // Persist only an unrelated source. The rollout has never had a durable key,
    // including an explicit zero offset, before or after its first failed output.
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    assert!(!disk_has_source_key(&path, &key).await);
    let (input, manager, http) = pipeline(root.path(), store.clone(), &hanging.url);
    http.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), input.start())
        .await
        .unwrap()
        .unwrap();
    assert!(!rollout.exists());
    tokio::fs::write(&rollout, completed_turn()).await.unwrap();
    input.request_collection();
    eventually(|| hanging.requests.load(Ordering::SeqCst) > 0).await;
    assert!(store.waiting_for_output());
    assert!(!disk_has_source_key(&path, &key).await);

    // The ownership sidecar is metadata only and must exist before the request
    // can be observed; it cannot contain transcript bodies or acknowledged offset.
    let owners: Vec<_> = std::fs::read_dir(root.path().join("wakeups/source-owners"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(owners.len(), 1);
    let metadata = std::fs::read_to_string(&owners[0]).unwrap();
    for raw in [
        "fix it",
        "Follow the project conventions.",
        "/tmp/project",
        "exec_command",
    ] {
        assert!(
            !metadata.contains(raw),
            "source ownership retained business text"
        );
    }
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata.as_object().unwrap().len(), 6);
    assert!(metadata.get("scanOffset").is_none());
    assert!(metadata.get("lastOffset").is_none());

    manager.cancel_pending_outputs();
    tokio::time::timeout(Duration::from_secs(1), manager.stop_all())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), http.shutdown())
        .await
        .unwrap()
        .unwrap();
    eventually(|| hanging.disconnected.load(Ordering::SeqCst) > 0).await;
    assert!(store.save_failed());
    assert!(store.save().await.is_err());
    assert!(!disk_has_source_key(&path, &key).await);

    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    // A fresh StateStore is essential: neither the input's checkpoint nor its
    // firstOwned ID is inherited from the cancelled process's memory.
    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    assert!(restored.get(&key).last_offset().is_none());
    let (input, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), input.start())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), restored.save())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        disk_offset(&path, &key).await,
        completed_turn().len() as f64
    );
    assert_eq!(disk_offset(&path, "unrelated-source").await, 7.0);
    assert_replayed_native_facts(&receiver);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_codex_first_install_keeps_existing_history_baselined() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    tokio::fs::write(&rollout, completed_turn()).await.unwrap();
    let path = root.path().join("state.json");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    input.run_cycle().await;
    store.save().await.unwrap();
    assert_eq!(
        disk_offset(&path, &key).await,
        completed_turn().len() as f64
    );
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    let metadata = only_source_metadata(root.path());
    assert_eq!(
        metadata["baseline_floor"],
        json!({"offset": completed_turn().len(), "copied": false})
    );
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_codex_source_ownership_recovers_checkpoint_loss_without_promoting_copied_history() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let path = root.path().join("state.json");
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let store = Arc::new(StateStore::new(&path));
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    let mut records: Vec<Value> = completed_turn()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    records[0]["payload"]["forked_from_id"] = json!("copied-parent-session");
    let copied = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    tokio::fs::write(&rollout, copied).await.unwrap();
    input.run_cycle().await;
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    assert!(root.path().join("wakeups/source-owners").exists());
    lose_synthetic_source_checkpoint(root.path(), &path, &key).await;
    // Simulate loss of the normally persisted parked checkpoint, not an ACK or save cancellation.
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();

    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    let (input, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    input.run_cycle().await;
    restored.save().await.unwrap();
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    // There is no Hook first-owned ID or valid UUIDv7 provenance. Merely seeing
    // a copied source live must not convert its inherited turn into own work.
    assert_eq!(disk_offset(&path, &key).await, 0.0);
    assert_eq!(disk_offset(&path, "unrelated-source").await, 7.0);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_codex_cannot_emit_when_durable_source_ownership_cannot_be_written() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    tokio::fs::create_dir(root.path().join("wakeups"))
        .await
        .unwrap();
    tokio::fs::write(root.path().join("wakeups/source-owners"), b"blocked")
        .await
        .unwrap();
    let path = root.path().join("state.json");
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    tokio::fs::write(&rollout, completed_turn()).await.unwrap();
    input.run_cycle().await;
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    assert!(store.get(&key).last_offset().is_none());
    assert!(!disk_has_source_key(&path, &key).await);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

fn synthetic_history() -> String {
    completed_turn()
        .replace("fix it", "old installed private question")
        .replace("fixed", "old installed private answer")
        .replace("pwd", "old_installed_command")
        .replace("/tmp/project", "/old/installed/history")
}
fn fresh_tail() -> String {
    let completed = completed_turn()
        .replace("turn-1", "turn-2")
        .replace("call-1", "call-2")
        .replace("fc-1", "fc-2");
    completed.lines().skip(1).collect::<Vec<_>>().join("\n") + "\n"
}
fn only_source_metadata(root: &Path) -> Value {
    let paths: Vec<_> = std::fs::read_dir(root.join("wakeups/source-owners"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(paths.len(), 1);
    serde_json::from_slice(&std::fs::read(&paths[0]).unwrap()).unwrap()
}

#[tokio::test]
async fn native_codex_historical_floor_recovers_checkpoint_loss_and_replays_only_unaccepted_tail() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let history = synthetic_history();
    tokio::fs::write(&rollout, &history).await.unwrap();
    let path = root.path().join("state.json");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    assert!(!disk_has_source_key(&path, &key).await);
    let hanging = Receiver::new(true).await;
    let (input, manager, http) = pipeline(root.path(), store.clone(), &hanging.url);
    http.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), input.start())
        .await
        .unwrap()
        .unwrap();
    // Normal startup saved the no-replay baseline. Explicitly lose only this
    // synthetic canonical checkpoint to test independent-floor crash recovery.
    assert_eq!(store.get(&key).last_offset(), Some(history.len() as f64));
    lose_synthetic_source_checkpoint(root.path(), &path, &key).await;
    let metadata = only_source_metadata(root.path());
    assert_eq!(
        metadata["baseline_floor"],
        json!({"offset": history.len(), "copied": false})
    );
    for key in ["scanOffset", "lastOffset", "firstOwnedTurnId", "activeTurn"] {
        assert!(metadata.get(key).is_none());
    }
    assert!(!metadata
        .to_string()
        .contains("old installed private question"));
    assert_eq!(hanging.requests.load(Ordering::SeqCst), 0);

    tokio::fs::OpenOptions::new()
        .append(true)
        .open(&rollout)
        .await
        .unwrap()
        .write_all(fresh_tail().as_bytes())
        .await
        .unwrap();
    input.request_collection();
    eventually(|| hanging.requests.load(Ordering::SeqCst) > 0).await;
    assert!(store.waiting_for_output());
    assert!(!disk_has_source_key(&path, &key).await);
    assert_eq!(
        only_source_metadata(root.path())["baseline_floor"],
        metadata["baseline_floor"]
    );
    manager.cancel_pending_outputs();
    tokio::time::timeout(Duration::from_secs(1), manager.stop_all())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), http.shutdown())
        .await
        .unwrap()
        .unwrap();
    eventually(|| hanging.disconnected.load(Ordering::SeqCst) > 0).await;
    assert!(store.save_failed());
    assert!(store.save().await.is_err());
    assert!(!disk_has_source_key(&path, &key).await);

    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    assert!(restored.get(&key).last_offset().is_none());
    let (input, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), input.start())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), restored.save())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        disk_offset(&path, &key).await,
        (history.len() + fresh_tail().len()) as f64
    );
    assert_eq!(disk_offset(&path, "unrelated-source").await, 7.0);
    assert_replayed_native_facts(&receiver);
    let accepted = receiver.accepted.lock().unwrap().clone();
    let serialized = serde_json::to_string(&accepted).unwrap();
    for old in [
        "old installed private question",
        "old installed private answer",
        "old_installed_command",
        "/old/installed/history",
    ] {
        assert!(
            !serialized.contains(old),
            "initial historical data was replayed"
        );
    }
    let entries: Vec<_> = accepted
        .iter()
        .flat_map(|body| body["entries"].as_array().unwrap())
        .collect();
    let mut ids = BTreeSet::new();
    for entry in entries.iter().filter(|entry| {
        matches!(
            entry["event.name"].as_str(),
            Some("llm.request" | "llm.response" | "tool.call" | "tool.result")
        )
    }) {
        assert!(
            ids.insert(entry["event.id"].as_str().unwrap()),
            "native tail fact duplicated"
        );
    }
    assert_eq!(
        only_source_metadata(root.path())["baseline_floor"],
        metadata["baseline_floor"]
    );
    assert_eq!(disk_offset(&path, "unrelated-source").await, 7.0);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_codex_initial_history_cannot_start_without_durable_exclusion_floor() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    tokio::fs::create_dir(root.path().join("wakeups"))
        .await
        .unwrap();
    tokio::fs::write(root.path().join("wakeups/source-owners"), b"blocked")
        .await
        .unwrap();
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    tokio::fs::write(&rollout, synthetic_history())
        .await
        .unwrap();
    let path = root.path().join("state.json");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let (input, manager, http) = pipeline(root.path(), store.clone(), &receiver.url);
    http.start().await.unwrap();
    assert!(input.start().await.is_err());
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    assert!(store.get(&key).last_offset().is_none());
    assert!(!disk_has_source_key(&path, &key).await);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_codex_checkpoint_loss_floor_does_not_follow_a_replaced_source_identity() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let history = synthetic_history();
    tokio::fs::write(&rollout, &history).await.unwrap();
    let path = root.path().join("state.json");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let (input, manager, http) = pipeline(root.path(), store, &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    let original = only_source_metadata(root.path());
    lose_synthetic_source_checkpoint(root.path(), &path, &key).await;
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();

    // Preserve the original inode under a second path, forcing a different
    // identity at the monitored path even on filesystems that recycle inodes.
    tokio::fs::rename(&rollout, root.path().join("original-held.jsonl"))
        .await
        .unwrap();
    let replacement = history.clone() + &fresh_tail();
    tokio::fs::write(&rollout, &replacement).await.unwrap();
    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    let (input, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    input.run_cycle().await;
    restored.save().await.unwrap();
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    assert_eq!(disk_offset(&path, &key).await, replacement.len() as f64);
    let replaced = only_source_metadata(root.path());
    assert_ne!(
        (original["device"].clone(), original["inode"].clone()),
        (replaced["device"].clone(), replaced["inode"].clone())
    );
    assert_eq!(
        replaced["baseline_floor"]["offset"],
        json!(replacement.len())
    );
    assert_eq!(disk_offset(&path, "unrelated-source").await, 7.0);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_codex_copied_checkpoint_loss_rebuild_keeps_initial_floor_and_unowned_tail_parked() {
    let root = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(root.path().join("sessions"))
        .await
        .unwrap();
    let rollout = root.path().join("sessions/rollout-session-1.jsonl");
    let mut records: Vec<Value> = synthetic_history()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    records[0]["payload"]["forked_from_id"] = json!("copied-parent-session");
    let history = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    tokio::fs::write(&rollout, &history).await.unwrap();
    let path = root.path().join("state.json");
    let key = format!("codex-transcript:{}", rollout.to_string_lossy());
    let store = Arc::new(StateStore::new(&path));
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    let receiver = Receiver::new(false).await;
    receiver.healthy.store(true, Ordering::SeqCst);
    let (input, manager, http) = pipeline(root.path(), store, &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    assert_eq!(
        only_source_metadata(root.path())["baseline_floor"],
        json!({"offset": history.len(), "copied": true})
    );
    lose_synthetic_source_checkpoint(root.path(), &path, &key).await;
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
    tokio::fs::OpenOptions::new()
        .append(true)
        .open(&rollout)
        .await
        .unwrap()
        .write_all(fresh_tail().as_bytes())
        .await
        .unwrap();

    let restored = Arc::new(StateStore::new(&path));
    restored.load().await;
    let (input, manager, http) = pipeline(root.path(), restored.clone(), &receiver.url);
    http.start().await.unwrap();
    input.start().await.unwrap();
    input.run_cycle().await;
    restored.save().await.unwrap();
    assert_eq!(receiver.requests.load(Ordering::SeqCst), 0);
    assert_eq!(disk_offset(&path, &key).await, history.len() as f64);
    let extra = restored.get(&key).extra().unwrap();
    assert!(extra["codexTranscript"]["firstOwnedTurnId"].is_null());
    assert_eq!(
        extra["codexTranscript"]["forkBootstrap"]["state"],
        json!("baseline-search")
    );
    assert_eq!(disk_offset(&path, "unrelated-source").await, 7.0);
    manager.cancel_pending_outputs();
    manager.stop_all().await;
    http.shutdown().await.unwrap();
}
