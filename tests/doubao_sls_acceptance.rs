//! Real Doubao SLS acceptance and cancellation preserve source progress.
//! Synthetic credentials are sent only to loopback receivers.
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{BaseFlusher, SlsFlusher};
use loongsuite_pilot::inputs::base::{HostedInput, InputBody, InputRuntime};
use loongsuite_pilot::types::{AgentActivityEntry, ClientType, CollectionMethod, SlsFlusherConfig};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const INPUT_ID: &str = "doubao-sls-stop";
fn event() -> AgentActivityEntry {
    serde_json::from_value(json!({
        "event.name":"gen_ai.agent.invoke", "event.id":"synthetic-sls-cancel-event",
        "time_unix_nano":"1800000000000000001", "user.id":"synthetic-user",
        "gen_ai.agent.type":"doubao-work", "gen_ai.session.id":"synthetic-parent",
        "gen_ai.agent.invocation.id":"synthetic-invocation", "gen_ai.agent.peer.id":"synthetic-child"
    }))
    .unwrap()
}
struct Source {
    collects: Arc<AtomicUsize>,
}
#[async_trait]
impl InputBody for Source {
    fn id(&self) -> &str {
        INPUT_ID
    }
    fn agent_type(&self) -> ClientType {
        ClientType::DoubaoWork
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }
    async fn collect(&self, runtime: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        self.collects.fetch_add(1, Ordering::SeqCst);
        runtime.set_state_fields(None, Some(1.0), None);
        Ok(vec![event()])
    }
}
struct Receiver {
    url: String,
    received: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<Vec<u8>>>>,
    disconnected: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Receiver {
    async fn new(partial_status: Option<u16>) -> Self {
        Self::response(partial_status, false).await
    }
    async fn full(status: u16) -> Self {
        Self::response(Some(status), true).await
    }
    async fn response(partial_status: Option<u16>, complete: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let received = Arc::new(AtomicUsize::new(0));
        let disconnected = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&bodies);
        let (seen, closed) = (Arc::clone(&received), Arc::clone(&disconnected));
        let task = tokio::spawn(async move {
            let mut sockets = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (mut socket, _) = result.unwrap();
                        let (seen, closed) = (Arc::clone(&seen), Arc::clone(&closed));
                        let captured = Arc::clone(&captured);
                        sockets.spawn(async move {
                            tokio::time::timeout(Duration::from_secs(5), async move {
                                let mut bytes = Vec::new();
                                let mut chunk = [0; 4096];
                                let end = loop {
                                    let n = socket.read(&mut chunk).await.unwrap();
                                    if n == 0 { return; }
                                    bytes.extend_from_slice(&chunk[..n]);
                                    assert!(bytes.len() < 1024 * 1024);
                                    if let Some(i) = bytes.windows(4).position(|part| part == b"\r\n\r\n") { break i + 4; }
                                };
                                let headers = String::from_utf8(bytes[..end].to_vec()).unwrap().to_ascii_lowercase();
                                let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length:"))
                                    .unwrap().trim().parse().unwrap();
                                assert!(length < 1024 * 1024);
                                while bytes.len() < end + length {
                                    let n = socket.read(&mut chunk).await.unwrap();
                                    if n == 0 { return; }
                                    bytes.extend_from_slice(&chunk[..n]);
                                }
                                captured.lock().unwrap().push(bytes[end..end+length].to_vec());
                                if complete {
                                    socket.write_all(format!("HTTP/1.1 {} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",partial_status.unwrap()).as_bytes()).await.unwrap();
                                } else if let Some(status) = partial_status {
                                    let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{{\r\n");
                                    socket.write_all(response.as_bytes()).await.unwrap();
                                    socket.flush().await.unwrap();
                                }
                                seen.fetch_add(1, Ordering::SeqCst);
                                // Keep headers or body pending until the client explicitly
                                // cancels/drops its request. Error/reset also closes it.
                                let _ = socket.read(&mut chunk).await;
                                closed.fetch_add(1, Ordering::SeqCst);
                            }).await.expect("SLS loopback socket was abandoned");
                        });
                    }
                    result = sockets.join_next(), if !sockets.is_empty() => {
                        result.unwrap().expect("SLS loopback receiver failed");
                    }
                }
            }
        });
        Self {
            url,
            received,
            bodies,
            disconnected,
            task,
        }
    }
}
fn config(mode: &str, url: &str) -> SlsFlusherConfig {
    serde_json::from_value(json!({
        "enabled":true, "mode":mode, "accessKeyId":"synthetic-ak",
        "accessKeySecret":"synthetic-sk", "apiKey":"synthetic-api-key", "endpoint":url,
        "endpoints":[{"name":"loopback", "endpoint":url, "project":"", "logstore":"events",
            "mode":mode, "kind":"agentActivity", "accessKeyId":"synthetic-ak",
            "accessKeySecret":"synthetic-sk", "apiKey":"synthetic-api-key"}],
        "batchMaxSize":20, "flushIntervalMs":60000, "serviceNamePrefix":"",
        "timeout":{"timeoutMs":60000},
        "retry":{"retryMaxAttempts":3,"retryBaseDelayMs":1000,"retryJitter":false}
    }))
    .unwrap()
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(1), future)
        .await
        .expect("SLS cancellation did not settle")
}
async fn eventually(mut predicate: impl FnMut() -> bool) {
    bounded(async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}
async fn disk_offset(path: &Path) -> f64 {
    let state: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    state[INPUT_ID]["lastOffset"].as_f64().unwrap()
}
async fn run_cancellation(mode: &str, partial_status: Option<u16>) {
    let root = tempfile::tempdir().unwrap();
    let receiver = Receiver::new(partial_status).await;
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.set_offset(INPUT_ID, 0.0);
    store.save().await.unwrap();
    let collects = Arc::new(AtomicUsize::new(0));
    let input = HostedInput::new(
        Source {
            collects: Arc::clone(&collects),
        },
        "SlsCancelFixture",
        Arc::clone(&store),
        Some(60000),
    );
    let sls = Arc::new(SlsFlusher::new(
        config(mode, &receiver.url),
        root.path().to_str().unwrap(),
    ));
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(Arc::clone(&store));
    manager.set_flusher(sls.clone());
    manager.set_user_id("synthetic-user");
    let (running, start, stop) = (Arc::clone(&input), Arc::clone(&input), Arc::clone(&input));
    manager.register_input(LiveInput::new(
        INPUT_ID,
        "doubao-work",
        "session-file-polling",
        move || running.running(),
        move || {
            let input = Arc::clone(&start);
            Box::pin(async move { input.start().await })
        },
        move || {
            let input = Arc::clone(&stop);
            Box::pin(async move {
                input.stop().await.unwrap();
            })
        },
    ));
    let weak = Arc::downgrade(&manager);
    input.on_entries(move |entries| {
        if let Some(manager) = weak.upgrade() {
            manager.bind_entries(INPUT_ID, entries.to_vec());
        }
    });
    sls.start().await.unwrap();
    // Actual initial collection queues a hung SLS request; startup must return
    // while disk progress waits for acceptance, even with a 60 s HTTP timeout.
    bounded(manager.start_input(INPUT_ID)).await;
    eventually(|| receiver.received.load(Ordering::SeqCst) == 1).await;
    assert_eq!(disk_offset(&path).await, 0.0);
    assert!(store.waiting_for_output());
    bounded(manager.stop_input(INPUT_ID)).await;
    eventually(|| receiver.disconnected.load(Ordering::SeqCst) == 1).await;
    assert!(!input.running());
    assert_eq!(collects.load(Ordering::SeqCst), 1);
    assert_eq!(
        receiver.received.load(Ordering::SeqCst),
        1,
        "cancelled send retried"
    );
    assert!(store.save_failed());
    assert!(store.save().await.is_err());
    assert_eq!(disk_offset(&path).await, 0.0);
    assert_eq!(sls.endpoint_counters()["loopback"].out_entries, 0);
    bounded(sls.shutdown()).await.unwrap();
    bounded(manager.stop_all()).await;
}

#[tokio::test]
async fn native_doubao_stop_cancels_ak_headers_and_preserves_source_checkpoint() {
    run_cancellation("ak", None).await;
}
#[tokio::test]
async fn native_doubao_stop_cancels_api_key_headers_and_preserves_source_checkpoint() {
    run_cancellation("apiKey", None).await;
}
#[tokio::test]
async fn native_doubao_stop_cancels_webtracking_headers_and_preserves_source_checkpoint() {
    run_cancellation("webtracking", None).await;
}
#[tokio::test]
async fn native_doubao_stop_cancels_ak_partial_response_body() {
    run_cancellation("ak", Some(503)).await;
}
#[tokio::test]
async fn native_doubao_stop_cancels_api_key_partial_response_body() {
    run_cancellation("apiKey", Some(503)).await;
}
#[tokio::test]
async fn native_doubao_stop_cancels_webtracking_partial_response_body() {
    run_cancellation("webtracking", Some(503)).await;
}

#[tokio::test]
async fn native_doubao_successful_webtracking_releases_unused_body_without_waiting_for_timeout() {
    let root = tempfile::tempdir().unwrap();
    let receiver = Receiver::new(Some(200)).await;
    let sls = Arc::new(SlsFlusher::new(
        config("webtracking", &receiver.url),
        root.path().to_str().unwrap(),
    ));
    let sending = Arc::clone(&sls);
    let mut task = tokio::spawn(async move { sending.send_batch(vec![event()], None).await });
    eventually(|| receiver.received.load(Ordering::SeqCst) == 1).await;
    let result = tokio::time::timeout(Duration::from_secs(1), &mut task).await;
    let accepted = matches!(&result, Ok(Ok(Ok(()))));
    // Clean up the real outstanding socket even when this regression fails.
    if result.is_err() {
        task.abort();
        let _ = task.await;
    }
    eventually(|| receiver.disconnected.load(Ordering::SeqCst) == 1).await;
    bounded(sls.shutdown()).await.unwrap();
    assert!(accepted, "successful WebTracking must release its unused partial body without the 60 s request timeout");
    assert_eq!(sls.endpoint_counters()["loopback"].out_entries, 1);
    assert_eq!(receiver.received.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_doubao_sls_preserves_agent_service_grouping_in_mixed_batches() {
    let root = tempfile::tempdir().unwrap();
    let receiver = Receiver::full(200).await;
    let mut cfg = config("webtracking", &receiver.url);
    cfg.service_name_prefix = "synthetic-service".into();
    let sls = SlsFlusher::new(cfg, root.path().to_str().unwrap());
    let doubao = event();
    let mut codex = doubao.clone();
    codex.agent_type = "codex".into();
    codex.event_id = "synthetic-codex-event".into();
    bounded(sls.send_batch(vec![doubao, codex], None))
        .await
        .unwrap();
    let bodies = receiver.bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2);
    for (bytes, agent) in bodies.iter().zip(["doubao-work", "codex"]) {
        let body: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(
            body["__tags__"]["__service_name__"],
            format!("synthetic-service-{agent}")
        );
        assert_eq!(body["__logs__"].as_array().unwrap().len(), 1);
        assert_eq!(body["__logs__"][0]["gen_ai.agent.type"], agent);
    }
    assert_eq!(sls.endpoint_counters()["loopback"].out_entries, 2);
    bounded(sls.shutdown()).await.unwrap();
}

#[tokio::test]
async fn native_doubao_sls_requires_every_real_endpoint_and_labels_durability_failure_correctly() {
    let root = tempfile::tempdir().unwrap();
    let good = Receiver::full(200).await;
    let bad = Receiver::full(400).await;
    let mut cfg = config("webtracking", &good.url);
    cfg.retry.as_mut().unwrap().retry_max_attempts = Some(1);
    cfg.endpoints[0].name = "accepted".into();
    let mut reject = cfg.endpoints[0].clone();
    reject.name = "rejected".into();
    reject.endpoint = bad.url.clone();
    cfg.endpoints.push(reject);
    let sls = SlsFlusher::new(cfg, root.path().to_str().unwrap());
    let error = bounded(sls.send_batch(vec![event()], None))
        .await
        .unwrap_err();
    assert!(error.preserves_checkpoint());
    assert!(error.to_string().contains("Doubao Work"));
    assert!(!error.to_string().contains("Codex"));
    assert_eq!(good.received.load(Ordering::SeqCst), 1);
    assert_eq!(bad.received.load(Ordering::SeqCst), 1);
    assert_eq!(sls.endpoint_counters()["accepted"].out_entries, 1);
    assert_eq!(sls.endpoint_counters()["rejected"].out_failed, 1);
    bounded(sls.shutdown()).await.unwrap();
}
