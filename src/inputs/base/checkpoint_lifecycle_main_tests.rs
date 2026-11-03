//! New main contracts through actual HostedInput + StateStore. The only
//! injected IO is a deterministic barrier around the real checkpoint write.
use super::*;
use crate::checkpoints::InputState;
use std::sync::atomic::AtomicUsize;
use std::sync::Weak;
use tokio::sync::oneshot;
struct Probe {
    collects: AtomicUsize,
    stops: AtomicUsize,
    early_watcher: bool,
    source: std::path::PathBuf,
    seen: Mutex<Vec<String>>,
    input: Mutex<Option<Weak<HostedInput<Body>>>>,
}
struct Body(Arc<Probe>);
#[async_trait]
impl InputBody for Body {
    fn id(&self) -> &str {
        "base-main-checkpoint"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::Qoder
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().into()])
    }
    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let count = self.0.collects.fetch_add(1, Ordering::SeqCst) + 1;
        self.0
            .seen
            .lock()
            .unwrap()
            .push(std::fs::read_to_string(&self.0.source).unwrap());
        rt.state_store
            .set(self.id(), InputState::new().with_last_offset(count as f64));
        Ok(vec![])
    }
    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        if self.0.early_watcher {
            let input = self
                .0
                .input
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .upgrade()
                .unwrap();
            input.request_collection();
            loop {
                let ready = rt.checkpoint_ready.notified();
                if rt.checkpoint_waiting.load(Ordering::SeqCst) {
                    break;
                }
                ready.await;
            }
        }
        Ok(())
    }
    async fn on_stop(&self, _: &InputRuntime) -> anyhow::Result<()> {
        self.0.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
fn fixture(
    early: bool,
) -> (
    tempfile::TempDir,
    Arc<StateStore>,
    Arc<HostedInput<Body>>,
    Arc<Probe>,
) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    let probe = Arc::new(Probe {
        collects: AtomicUsize::new(0),
        stops: AtomicUsize::new(0),
        early_watcher: early,
        source: root.path().join("synthetic-source"),
        seen: Mutex::new(Vec::new()),
        input: Mutex::new(None),
    });
    std::fs::write(&probe.source, "0").unwrap();
    let input = HostedInput::new(
        Body(Arc::clone(&probe)),
        "BaseMainCheckpoint",
        Arc::clone(&store),
        Some(1000),
    );
    *probe.input.lock().unwrap() = Some(Arc::downgrade(&input));
    (root, store, input, probe)
}
async fn settle() {
    for _ in 0..12 {
        tokio::task::yield_now().await;
    }
}
fn block_write(store: &StateStore) -> (Arc<Notify>, oneshot::Sender<()>) {
    let entered = Arc::new(Notify::new());
    let notify = Arc::clone(&entered);
    let (tx, rx) = oneshot::channel::<()>();
    let waiting = Arc::new(Mutex::new(Some(rx)));
    store.set_write_hook(move |path, text| {
        let rx = waiting.lock().unwrap().take();
        let notify = Arc::clone(&notify);
        async move {
            if let Some(rx) = rx {
                notify.notify_one();
                rx.await.map_err(|e| anyhow::anyhow!(e))?;
            }
            tokio::fs::write(path, text).await?;
            Ok(())
        }
    });
    (entered, tx)
}
#[tokio::test(start_paused = true)]
async fn base_main_l98_stop_releases_output_wait_without_abandoning_shared_save_or_cleanup() {
    let (root, store, input, probe) = fixture(false);
    let hold = store.begin_output();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&errors);
    input.on_collect_error(move |error| observed.lock().unwrap().push(error.to_owned()));
    input.start().await.unwrap();
    let observer = Arc::clone(&store);
    let shared = tokio::spawn(async move { observer.save().await.map_err(|e| e.to_string()) });
    settle().await;
    tokio::time::timeout(Duration::from_millis(100), input.stop())
        .await
        .unwrap()
        .unwrap();
    settle().await;
    assert_eq!(probe.stops.load(Ordering::SeqCst), 1);
    assert!(!input.running());
    assert!(!input.runtime.timer_active());
    assert!(
        !shared.is_finished(),
        "stopping one input cancelled a StateStore-owned shared save"
    );
    assert!(!root.path().join("state.json").exists());
    hold.finish(Err("another output was cancelled".into()));
    assert!(shared
        .await
        .unwrap()
        .unwrap_err()
        .contains("another output was cancelled"));
    assert!(store.save_failed());
    settle().await;
    assert_eq!(*errors.lock().unwrap(), ["another output was cancelled"]);
}
#[tokio::test(start_paused = true)]
async fn base_main_l121_stop_drains_active_write_when_no_output_hold_is_pending() {
    let (_root, store, input, probe) = fixture(false);
    let (entered, finish) = block_write(&store);
    let start = Arc::clone(&input);
    let starting = tokio::spawn(async move { start.start().await });
    entered.notified().await;
    let stop = Arc::clone(&input);
    let stopping = tokio::spawn(async move { stop.stop().await });
    settle().await;
    assert!(!stopping.is_finished());
    assert_eq!(probe.stops.load(Ordering::SeqCst), 0);
    finish.send(()).unwrap();
    starting.await.unwrap().unwrap();
    stopping.await.unwrap().unwrap();
    assert_eq!(probe.stops.load(Ordering::SeqCst), 1);
    assert!(store.is_persisted(input.id(), None));
}
#[tokio::test(start_paused = true)]
async fn base_main_l141_start_is_ready_at_held_checkpoint_without_overlapping_early_watcher_cycle()
{
    for early in [false, true] {
        let (_root, store, input, probe) = fixture(early);
        let hold = store.begin_output();
        tokio::time::timeout(Duration::from_millis(100), input.start())
            .await
            .unwrap()
            .unwrap();
        tokio::time::advance(Duration::from_secs(60)).await;
        settle().await;
        assert_eq!(
            probe.collects.load(Ordering::SeqCst),
            1,
            "early watcher={early}"
        );
        assert!(input.runtime.timer_active());
        hold.finish(Ok(()));
        input.stop().await.unwrap();
    }
}
#[tokio::test(start_paused = true)]
async fn base_main_l178_startup_is_not_coupled_to_a_checkpoint_that_acquires_a_later_hold() {
    let (_root, store, input, probe) = fixture(false);
    let (entered, finish) = block_write(&store);
    let start = Arc::clone(&input);
    let mut starting = tokio::spawn(async move { start.start().await });
    entered.notified().await;
    tokio::time::timeout(Duration::from_millis(100), &mut starting)
        .await
        .expect("startup waited for checkpoint IO")
        .unwrap()
        .unwrap();
    let hold = store.begin_output();
    tokio::time::timeout(Duration::from_millis(100), input.stop())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(probe.stops.load(Ordering::SeqCst), 1);
    finish.send(()).unwrap();
    hold.finish(Ok(()));
    store.save().await.unwrap();
    assert!(store.is_persisted(input.id(), None));
}

#[tokio::test(start_paused = true)]
async fn repeated_stop_and_restart_share_one_pending_save_and_preserve_latest_revision() {
    let (root, store, input, probe) = fixture(false);
    let hold = store.begin_output();
    let mut first: Option<Arc<Gate>> = None;
    for round in 1..=4 {
        tokio::time::timeout(Duration::from_millis(100), input.start())
            .await
            .unwrap()
            .unwrap();
        let current = input
            .checkpoint_save
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        if let Some(first) = &first {
            assert!(
                Arc::ptr_eq(first, &current),
                "restart created another pending save task"
            );
        } else {
            first = Some(current);
        }
        tokio::time::timeout(Duration::from_millis(100), input.stop())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(probe.collects.load(Ordering::SeqCst), round);
        assert_eq!(probe.stops.load(Ordering::SeqCst), round);
    }
    hold.finish(Ok(()));
    store.save().await.unwrap();
    settle().await;
    assert!(input.checkpoint_save.lock().unwrap().is_none());
    let saved: Value =
        serde_json::from_slice(&std::fs::read(root.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(saved[input.id()]["lastOffset"], 4);
    assert!(store.is_persisted(input.id(), None));
}

#[tokio::test(start_paused = true)]
async fn pending_checkpoint_explicit_cycle_reads_actual_new_source_after_the_old_save() {
    let (_root, store, input, probe) = fixture(false);
    input.runtime.force_poll_interval_ms(60_000);
    let (entered, finish) = block_write(&store);
    input.start().await.unwrap();
    entered.notified().await;
    std::fs::write(&probe.source, "1").unwrap();
    let next = Arc::clone(&input);
    let requested = tokio::spawn(async move { next.run_cycle().await });
    settle().await;
    assert_eq!(probe.collects.load(Ordering::SeqCst), 1);
    assert!(!requested.is_finished());
    finish.send(()).unwrap();
    requested.await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(*probe.seen.lock().unwrap(), ["0", "1"]);
}
#[tokio::test(start_paused = true)]
async fn pending_checkpoint_one_hundred_wakeups_coalesce_once_and_stop_discards_pending_rescan() {
    for stopping in [false, true] {
        let (_root, store, input, probe) = fixture(false);
        input.runtime.force_poll_interval_ms(60_000);
        let (entered, finish) = block_write(&store);
        input.start().await.unwrap();
        entered.notified().await;
        std::fs::write(&probe.source, "1").unwrap();
        for _ in 0..100 {
            input.request_collection();
        }
        settle().await;
        assert_eq!(probe.collects.load(Ordering::SeqCst), 1);
        if stopping {
            let held = store.begin_output();
            tokio::time::timeout(Duration::from_millis(100), input.stop())
                .await
                .unwrap()
                .unwrap();
            finish.send(()).unwrap();
            held.finish(Ok(()));
            store.save().await.unwrap();
            settle().await;
            assert_eq!(*probe.seen.lock().unwrap(), ["0"]);
        } else {
            finish.send(()).unwrap();
            tokio::time::timeout(Duration::from_millis(100), async {
                loop {
                    if probe.collects.load(Ordering::SeqCst) >= 2 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .expect("native wakeup after collection was lost while checkpoint saved");
            input.stop().await.unwrap();
            assert_eq!(*probe.seen.lock().unwrap(), ["0", "1"]);
        }
    }
}
