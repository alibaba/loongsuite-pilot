//! Exact main Codex recovery contracts through the real hosted collect/save,
//! manager, HTTP timer and JSONL fanout. Only the source and loopback are synthetic.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{BaseFlusher, HttpFlusher, JsonlFlusher, MultiFlusher};
use loongsuite_pilot::inputs::base::{HostedInput, InputBody, InputRuntime};
use loongsuite_pilot::types::{AgentActivityEntry, ClientType, CollectionMethod};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ID: &str = "codex-http-recovery";
fn entry(id: &str) -> AgentActivityEntry {
    serde_json::from_value(json!({"event.name":"gen_ai.agent.invoke","event.id":id,
        "time_unix_nano":"1800000000000000000","user.id":"synthetic",
        "gen_ai.agent.type":"codex","gen_ai.session.id":"recovery-parent",
        "gen_ai.agent.invocation.id":format!("invocation-{id}"),"gen_ai.agent.peer.id":"recovery-child",
        "gen_ai.agent.peer.name":"Newton",
        "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"recover this task"}]}]})).unwrap()
}
struct Recovery {
    pending: Mutex<Vec<AgentActivityEntry>>,
}
#[async_trait]
impl InputBody for Recovery {
    fn id(&self) -> &str {
        ID
    }
    fn agent_type(&self) -> ClientType {
        ClientType::CodexCliHook
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }
    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let entries = std::mem::take(&mut *self.pending.lock().unwrap());
        if !entries.is_empty() {
            let next = rt.state().last_offset().unwrap_or(0.0) + entries.len() as f64;
            rt.set_state_fields(None, Some(next), None);
        }
        Ok(entries)
    }
}
struct Other;
#[async_trait]
impl InputBody for Other {
    fn id(&self) -> &str {
        "other-input"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::Qoder
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }
    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        rt.set_state_fields(None, Some(1.0), None);
        Ok(vec![])
    }
}
fn register<T: InputBody + 'static>(
    manager: &Arc<InputManager>,
    input: &Arc<HostedInput<T>>,
    id: &'static str,
    agent: &str,
) {
    let (running, start, stop) = (Arc::clone(input), Arc::clone(input), Arc::clone(input));
    manager.register_input(LiveInput::new(
        id,
        agent,
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
    let weak = Arc::downgrade(manager);
    input.on_entries(move |entries| {
        if let Some(manager) = weak.upgrade() {
            manager.bind_entries(id, entries.to_vec());
        }
    });
}
async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(1), future)
        .await
        .expect("original1000ms shutdown/readiness deadline")
}
async fn eventually(mut ready: impl FnMut() -> bool) {
    within(async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await;
}
struct Receiver {
    url: String,
    status: Arc<AtomicU16>,
    attempts: Arc<Mutex<Vec<Value>>>,
    accepted: Arc<Mutex<Vec<Value>>>,
    closed: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Receiver {
    async fn new(status: u16) -> Self {
        Self::listen(
            tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(),
            status,
        )
        .await
    }
    async fn listen(listener: tokio::net::TcpListener, status: u16) -> Self {
        let url = format!("http://{}/events", listener.local_addr().unwrap());
        let status = Arc::new(AtomicU16::new(status));
        let attempts = Arc::new(Mutex::new(vec![]));
        let accepted = Arc::new(Mutex::new(vec![]));
        let closed = Arc::new(AtomicUsize::new(0));
        let (s, a, ok, c) = (
            status.clone(),
            attempts.clone(),
            accepted.clone(),
            closed.clone(),
        );
        let task = tokio::spawn(async move {
            let mut sockets = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result=listener.accept()=>{
                        let(mut socket,_)=result.unwrap();
                        let(s,a,ok,c)=(s.clone(),a.clone(),ok.clone(),c.clone());
                        sockets.spawn(async move {
                            let mut bytes=Vec::new();let mut part=[0;4096];
                            let header=loop{
                                let n=socket.read(&mut part).await.unwrap();if n==0{return;}
                                bytes.extend_from_slice(&part[..n]);assert!(bytes.len()<1024*1024);
                                if let Some(i)=bytes.windows(4).position(|p|p==b"\r\n\r\n"){break i+4;}
                            };
                            let headers=String::from_utf8_lossy(&bytes[..header]).to_ascii_lowercase();
                            let length:usize=headers.lines().find_map(|line|line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                            while bytes.len()<header+length {
                                let n=socket.read(&mut part).await.unwrap();if n==0{return;}bytes.extend_from_slice(&part[..n]);
                            }
                            let body:Value=serde_json::from_slice(&bytes[header..header+length]).unwrap();
                            let records=body["entries"].clone();a.lock().unwrap().push(records.clone());
                            let status=s.load(Ordering::SeqCst);
                            if status==0 {
                                let _=socket.read(&mut part).await;
                                c.fetch_add(1,Ordering::SeqCst);
                            }else{
                                if status==200 {ok.lock().unwrap().push(records);}
                                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").as_bytes()).await.unwrap();
                            }
                        });
                    },
                    result=sockets.join_next(),if !sockets.is_empty()=>{result.unwrap().expect("owned loopback receiver failed");}
                }
            }
        });
        Self {
            url,
            status,
            attempts,
            accepted,
            closed,
            task,
        }
    }
    fn requests(&self) -> usize {
        self.attempts.lock().unwrap().len()
    }
}
struct Flow {
    _root: tempfile::TempDir,
    path: PathBuf,
    output: PathBuf,
    input: Arc<HostedInput<Recovery>>,
    manager: Arc<InputManager>,
    store: Arc<StateStore>,
    http: Arc<HttpFlusher>,
    flusher: Arc<MultiFlusher>,
}
impl Flow {
    async fn new(url: &str, timeout: u64) -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.json");
        let output = root.path().join("output");
        let store = Arc::new(StateStore::new(&path));
        store.set_offset(ID, 0.0);
        store.save().await.unwrap();
        let input = HostedInput::new(
            Recovery {
                pending: Mutex::new(vec![]),
            },
            "RecoveryFixture",
            store.clone(),
            Some(60000),
        );
        let http = Arc::new(HttpFlusher::new(
            serde_json::from_value(json!({"enabled":true,"url":url,
            "batchMaxSize":100,"flushIntervalMs":25,"requestTimeoutMs":timeout}))
            .unwrap(),
        ));
        let jsonl = Arc::new(JsonlFlusher::new(
            serde_json::from_value(json!({"enabled":true,
            "outputDir":output,"rotateDaily":false,"maxFileSizeMb":100}))
            .unwrap(),
        ));
        http.start().await.unwrap();
        jsonl.start().await.unwrap();
        let flusher = Arc::new(MultiFlusher::new(vec![http.clone(), jsonl]));
        let manager = Arc::new(InputManager::new());
        manager.set_state_store(store.clone());
        manager.set_flusher(flusher.clone());
        register(&manager, &input, ID, "codex");
        Self {
            _root: root,
            path,
            output,
            input,
            manager,
            store,
            http,
            flusher,
        }
    }
    fn enqueue(&self, id: &str) {
        self.input.body.pending.lock().unwrap().push(entry(id));
    }
    async fn checkpoint(&self, id: &str) -> f64 {
        let data: Value =
            serde_json::from_slice(&tokio::fs::read(&self.path).await.unwrap()).unwrap();
        data[id]["lastOffset"].as_f64().unwrap()
    }
    async fn events(&self) -> Vec<Value> {
        tokio::fs::read_to_string(self.output.join("codex-all.jsonl"))
            .await
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    async fn recovery_save(&self) {
        tokio::time::timeout(Duration::from_secs(3), self.store.save())
            .await
            .expect("original3000ms recovery deadline")
            .unwrap();
    }
    async fn close(&self) {
        self.manager.cancel_pending_outputs();
        within(self.manager.stop_all()).await;
        within(self.flusher.shutdown()).await.unwrap();
    }
}
#[tokio::test]
async fn main_http_503_timer_retries_stable_identity_and_commits_only_after_acknowledgement() {
    let server = Receiver::new(503).await;
    let flow = Flow::new(&server.url, 100).await;
    flow.enqueue("event-recovery");
    within(flow.manager.start_input(ID)).await;
    eventually(|| server.requests() >= 2).await;
    assert_eq!(flow.checkpoint(ID).await, 0.0);
    assert_eq!(
        flow.events()
            .await
            .iter()
            .map(|row| row["event.id"].clone())
            .collect::<Vec<_>>(),
        [json!("event-recovery")]
    );
    server.status.store(200, Ordering::SeqCst);
    flow.recovery_save().await;
    assert_eq!(flow.checkpoint(ID).await, 1.0);
    assert_eq!(server.accepted.lock().unwrap().len(), 1);
    let attempts = server.attempts.lock().unwrap().clone();
    assert!(attempts.iter().all(|entries| entries == &attempts[0]));
    let accepted = server.accepted.lock().unwrap().clone();
    assert_eq!(accepted[0][0]["event.id"], "event-recovery");
    assert_eq!(
        accepted[0][0]["gen_ai.agent.invocation.id"],
        "invocation-event-recovery"
    );
    assert_eq!(accepted[0][0]["gen_ai.agent.peer.name"], "Newton");
    flow.http.flush().await.unwrap();
    assert_eq!(server.accepted.lock().unwrap().len(), 1);
    assert_eq!(flow.events().await.len(), 1);
    flow.close().await;
}
#[tokio::test]
async fn main_http_real_connection_refusal_recovers_without_freezing_shared_checkpoint() {
    let reserved = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = reserved.local_addr().unwrap();
    drop(reserved);
    let flow = Flow::new(&format!("http://{address}/events"), 100).await;
    flow.enqueue("event-offline");
    within(flow.manager.start_input(ID)).await;
    within(async {
        while !Path::new(&flow.output.join("codex-all.jsonl")).exists() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await;
    flow.http.flush().await.unwrap();
    assert_eq!(flow.checkpoint(ID).await, 0.0);
    assert!(!flow.store.save_failed());
    let server = Receiver::listen(tokio::net::TcpListener::bind(address).await.unwrap(), 200).await;
    flow.recovery_save().await;
    assert_eq!(flow.checkpoint(ID).await, 1.0);
    let accepted = server.accepted.lock().unwrap().clone();
    assert_eq!(
        accepted
            .into_iter()
            .flat_map(|v| v.as_array().unwrap().clone())
            .map(|row| row["event.id"].clone())
            .collect::<Vec<_>>(),
        [json!("event-offline")]
    );
    assert_eq!(flow.events().await.len(), 1);
    flow.close().await;
}
async fn stop_hung(stop_all: bool) {
    let server = Receiver::new(0).await;
    let flow = Flow::new(&server.url, 60000).await;
    let event = if stop_all {
        "event-stopAll"
    } else {
        "event-stopInput"
    };
    flow.enqueue(event);
    within(flow.manager.start_input(ID)).await;
    eventually(|| server.requests() == 1).await;
    assert_eq!(flow.checkpoint(ID).await, 0.0);
    if stop_all {
        within(flow.manager.stop_all()).await;
    } else {
        within(flow.manager.stop_input(ID)).await;
    }
    eventually(|| server.closed.load(Ordering::SeqCst) == 1).await;
    assert!(!flow.input.running());
    assert_eq!(flow.checkpoint(ID).await, 0.0);
    flow.http.flush().await.unwrap();
    assert_eq!(server.requests(), 1);
    flow.close().await;
}
#[tokio::test]
async fn main_http_stop_input_cancels_the_real_hung_socket_without_advancing_source() {
    stop_hung(false).await;
}
#[tokio::test]
async fn main_http_stop_all_cancels_the_real_hung_socket_without_advancing_source() {
    stop_hung(true).await;
}
#[tokio::test]
async fn main_http_other_input_stop_releases_only_its_wait_and_leaves_codex_recovery_owned() {
    let server = Receiver::new(503).await;
    let flow = Flow::new(&server.url, 100).await;
    let other = HostedInput::new(
        Other,
        "OtherRecoveryFixture",
        flow.store.clone(),
        Some(60000),
    );
    register(&flow.manager, &other, "other-input", "qoder");
    flow.store.set_offset("other-input", 0.0);
    flow.store.save().await.unwrap();
    flow.enqueue("event-shared-checkpoint");
    within(flow.manager.start_input(ID)).await;
    eventually(|| server.requests() > 0).await;
    within(flow.manager.start_input("other-input")).await;
    assert_eq!(flow.store.get_offset("other-input"), 1.0);
    assert_eq!(flow.checkpoint(ID).await, 0.0);
    assert_eq!(flow.checkpoint("other-input").await, 0.0);
    within(flow.manager.stop_input("other-input")).await;
    assert!(!other.running());
    assert!(flow.input.running());
    assert_eq!(flow.checkpoint(ID).await, 0.0);
    assert_eq!(flow.checkpoint("other-input").await, 0.0);
    assert_eq!(
        server.closed.load(Ordering::SeqCst),
        0,
        "other stop cannot cancel the Codex recovery"
    );
    server.status.store(200, Ordering::SeqCst);
    flow.recovery_save().await;
    assert_eq!(flow.checkpoint(ID).await, 1.0);
    assert_eq!(flow.checkpoint("other-input").await, 1.0);
    flow.close().await;
}
#[tokio::test]
async fn main_http_successful_stop_restart_renews_cancellation_for_both_new_batches() {
    let server = Receiver::new(200).await;
    let flow = Flow::new(&server.url, 100).await;
    flow.enqueue("event-first-start");
    within(flow.manager.start_input(ID)).await;
    within(flow.store.save()).await.unwrap();
    within(flow.manager.stop_input(ID)).await;
    flow.enqueue("event-second-start");
    within(flow.manager.start_input(ID)).await;
    within(flow.store.save()).await.unwrap();
    assert_eq!(flow.checkpoint(ID).await, 2.0);
    let accepted = server.accepted.lock().unwrap().clone();
    let ids = accepted
        .into_iter()
        .flat_map(|v| v.as_array().unwrap().clone())
        .map(|row| row["event.id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [json!("event-first-start"), json!("event-second-start")]
    );
    assert_eq!(
        flow.events()
            .await
            .iter()
            .map(|row| row["event.id"].clone())
            .collect::<Vec<_>>(),
        ids
    );
    flow.close().await;
}
