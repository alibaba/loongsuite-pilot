//! Main Codex fatal output backpressure through the actual HostedInput lifecycle.
//! The source and deliberately rejecting destination are controlled, as in the
//! original; collection, manager queue, checkpoint failure, and restart are real.
use async_trait::async_trait;
use loongsuite_pilot::{
    checkpoints::StateStore,
    core::{InputManager, LiveInput},
    flushers::{BaseFlusher, FlushError},
    inputs::base::{HostedInput, InputBody, InputRuntime},
    types::{AgentActivityEntry, ClientType, CollectionMethod},
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
const ID: &str = "codex-checkpoint-backpressure";
struct Replay(Arc<AtomicUsize>);
#[async_trait]
impl InputBody for Replay {
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
        self.0.fetch_add(1, Ordering::SeqCst);
        let offset = rt.state().last_offset().unwrap_or(0.0) + 1.0;
        rt.set_state_fields(None, Some(offset), None);
        Ok(vec![serde_json::from_value(json!({
            "event.name":"gen_ai.agent.invoke","event.id":format!("event-{}",offset as u64),
            "gen_ai.agent.type":"codex","gen_ai.session.id":"backpressure-parent",
            "gen_ai.agent.invocation.id":format!("invocation-{}",offset as u64),
            "time_unix_nano":"1800000000000000000"
        }))
        .unwrap()])
    }
}
struct Controlled {
    fail: bool,
    received: Mutex<Vec<Vec<AgentActivityEntry>>>,
}
#[async_trait]
impl BaseFlusher for Controlled {
    fn name(&self) -> &str {
        "controlled"
    }
    async fn send(&self, e: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.send_batch(vec![e], None).await
    }
    async fn send_batch(
        &self,
        es: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        let first = {
            let mut batches = self.received.lock().unwrap();
            batches.push(es);
            batches.len() == 1
        };
        if self.fail && first {
            Err(FlushError::codex_output("SLS"))
        } else {
            Ok(())
        }
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}
fn pipeline(
    store: Arc<StateStore>,
    fail: bool,
    poll: u64,
) -> (
    Arc<HostedInput<Replay>>,
    Arc<InputManager>,
    Arc<Controlled>,
    Arc<AtomicUsize>,
) {
    let count = Arc::new(AtomicUsize::new(0));
    let input = HostedInput::new(Replay(count.clone()), "Replay", store.clone(), Some(poll));
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(store);
    let output = Arc::new(Controlled {
        fail,
        received: Mutex::new(Vec::new()),
    });
    manager.set_flusher(output.clone());
    let (running, start, stop) = (input.clone(), input.clone(), input.clone());
    manager.register_input(LiveInput::new(
        ID,
        "codex",
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
    let weak = Arc::downgrade(&manager);
    input.on_entries(move |rows| {
        if let Some(manager) = weak.upgrade() {
            manager.bind_entries(ID, rows.to_vec());
        }
    });
    (input, manager, output, count)
}
async fn within<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(1), f)
        .await
        .expect("original one-second readiness/stop bound")
}
async fn eventually(mut f: impl FnMut() -> bool) {
    within(async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
}
fn disk(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
#[tokio::test]
async fn main_checkpoint_failure_pauses_real_poll_and_100_wakeups_until_a_new_store_replays_the_persisted_cursor(
) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.set_offset(ID, 0.0);
    store.save().await.unwrap();
    let (input, manager, output, count) = pipeline(store.clone(), true, 5);
    within(manager.start_input(ID)).await;
    eventually(|| store.save_failed()).await;
    assert!(store.save().await.unwrap_err().to_string().contains("SLS"));
    for _ in 0..100 {
        input.request_collection();
    }
    // Original fake 1000ms is observed against the real 5ms poll worker.
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(output.received.lock().unwrap().len(), 1);
    assert!(!store.waiting_for_output());
    assert_eq!(disk(&path)[ID]["lastOffset"], 0.0);
    within(manager.stop_input(ID)).await;
    within(manager.start_input(ID)).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    within(manager.stop_all()).await;
    let recovered = Arc::new(StateStore::new(&path));
    recovered.load().await;
    let (_replay, restarted, healthy, _count) = pipeline(recovered.clone(), false, 60000);
    within(restarted.start_input(ID)).await;
    eventually(|| !healthy.received.lock().unwrap().is_empty()).await;
    within(recovered.save()).await.unwrap();
    let rows = healthy.received.lock().unwrap().clone();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].len(), 1);
    assert_eq!(rows[0][0].event_id, "event-1");
    assert_eq!(
        serde_json::to_value(&rows[0][0]).unwrap()["gen_ai.agent.invocation.id"],
        "invocation-1"
    );
    assert_eq!(disk(&path)[ID]["lastOffset"], 1.0);
    within(restarted.stop_all()).await;
}
#[tokio::test]
async fn main_checkpoint_failure_refuses_100_later_streaming_batches_from_the_same_collect_queue() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    let (_input, manager, output, _count) = pipeline(store.clone(), true, 60000);
    within(manager.start_input(ID)).await;
    eventually(|| store.save_failed()).await;
    assert!(store.save().await.is_err());
    let first = output.received.lock().unwrap()[0].clone();
    for _ in 0..100 {
        manager.bind_entries(ID, first.clone());
    }
    tokio::task::yield_now().await;
    assert_eq!(output.received.lock().unwrap().len(), 1);
    assert!(!store.waiting_for_output());
    within(manager.stop_all()).await;
}
