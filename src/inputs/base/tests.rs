//! Vitest cases from `tests/unit/inputs/base-*.test.ts`, extensibility, and
//! hook-record-transform, rewritten as Rust tests.

use super::*;
use crate::checkpoints::{InputState, SnapshotStore, StateStore};
use crate::normalization::build_test_entry;
use crate::types::{
    ActionType, AgentActivityEntry, ClientType, CodeGenerationEvent, CollectionMethod,
};
use crate::utils::get_today_date_string;
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn temp_store() -> (tempfile::TempDir, Arc<StateStore>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("input-state.json")));
    (dir, store)
}

struct Script {
    collect_calls: AtomicUsize,
    collect_entered: tokio::sync::Notify,
    start_calls: AtomicUsize,
    stop_calls: AtomicUsize,
    fail_starts: AtomicUsize,
    entries: Mutex<Vec<AgentActivityEntry>>,
    collect_wait: Mutex<Option<tokio::sync::oneshot::Receiver<Vec<AgentActivityEntry>>>>,
    start_wait: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    stop_wait: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    watcher_open: AtomicUsize,
}

impl Script {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            collect_calls: AtomicUsize::new(0),
            collect_entered: tokio::sync::Notify::new(),
            start_calls: AtomicUsize::new(0),
            stop_calls: AtomicUsize::new(0),
            fail_starts: AtomicUsize::new(0),
            entries: Mutex::new(Vec::new()),
            collect_wait: Mutex::new(None),
            start_wait: Mutex::new(None),
            stop_wait: Mutex::new(None),
            watcher_open: AtomicUsize::new(0),
        })
    }
}

struct PlainBody {
    id: &'static str,
    agent: ClientType,
    method: CollectionMethod,
    script: Arc<Script>,
}

#[async_trait]
impl InputBody for PlainBody {
    fn id(&self) -> &str {
        self.id
    }
    fn agent_type(&self) -> ClientType {
        self.agent
    }
    fn collection_method(&self) -> CollectionMethod {
        self.method
    }
    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        self.script.start_calls.fetch_add(1, Ordering::SeqCst);
        let wait = self.script.start_wait.lock().unwrap().take();
        if let Some(wait) = wait {
            let _ = wait.await;
        }
        self.script.watcher_open.store(1, Ordering::SeqCst);
        let left = self.script.fail_starts.load(Ordering::SeqCst);
        if left > 0 {
            self.script.fail_starts.fetch_sub(1, Ordering::SeqCst);
            self.script.watcher_open.store(0, Ordering::SeqCst);
            anyhow::bail!("startup failed");
        }
        Ok(())
    }
    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        let wait = self.script.stop_wait.lock().unwrap().take();
        if let Some(wait) = wait {
            let _ = wait.await;
        }
        self.script.watcher_open.store(0, Ordering::SeqCst);
        self.script.stop_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn collect(&self, _rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        self.script.collect_calls.fetch_add(1, Ordering::SeqCst);
        self.script.collect_entered.notify_one();
        let wait = self.script.collect_wait.lock().unwrap().take();
        if let Some(wait) = wait {
            return match wait.await {
                Ok(entries) => Ok(entries),
                Err(_) => anyhow::bail!("test error"),
            };
        }
        Ok(self.script.entries.lock().unwrap().clone())
    }
}

fn plain(
    script: Arc<Script>,
    store: Arc<StateStore>,
    poll: Option<u64>,
) -> Arc<HostedInput<PlainBody>> {
    let hosted = HostedInput::new(
        PlainBody {
            id: "test-input",
            agent: ClientType::Qoder,
            method: CollectionMethod::HookJsonl,
            script,
        },
        "TestInput",
        store,
        poll,
    );
    hosted.runtime.force_poll_interval_ms(poll.unwrap_or(5_000));
    hosted
}

#[tokio::test]
async fn poll_env_overrides_constructor_value() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let (_dir, store) = temp_store();
    let previous = std::env::var("LOONGSUITE_PILOT_POLL_INTERVAL_MS").ok();
    unsafe { std::env::set_var("LOONGSUITE_PILOT_POLL_INTERVAL_MS", "3000") };
    let hosted = HostedInput::new(
        PlainBody {
            id: "test-input",
            agent: ClientType::Qoder,
            method: CollectionMethod::HookJsonl,
            script: Script::new(),
        },
        "TestInput",
        store,
        Some(5_000),
    );
    assert_eq!(hosted.runtime.poll_interval_ms(), 3_000);
    match previous {
        Some(value) => unsafe { std::env::set_var("LOONGSUITE_PILOT_POLL_INTERVAL_MS", value) },
        None => unsafe { std::env::remove_var("LOONGSUITE_PILOT_POLL_INTERVAL_MS") },
    }
}

#[tokio::test(start_paused = true)]
async fn start_stop_lifecycle_matches_base_input_tests() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let input = plain(Arc::clone(&script), store, Some(5_000));
    assert!(!input.running());
    input.start().await.unwrap();
    assert!(input.running());
    assert_eq!(script.start_calls.load(Ordering::SeqCst), 1);
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 1);
    input.start().await.unwrap();
    assert_eq!(script.start_calls.load(Ordering::SeqCst), 1);
    input.stop().await.unwrap();
    assert!(!input.running());
    assert_eq!(script.stop_calls.load(Ordering::SeqCst), 1);
    input.stop().await.unwrap();
    assert_eq!(script.stop_calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(10_000)).await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 1);
    assert!(!input.runtime.timer_active());
}

#[tokio::test(start_paused = true)]
async fn drains_startup_before_stop_and_does_not_collect() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let (tx, rx) = tokio::sync::oneshot::channel();
    *script.start_wait.lock().unwrap() = Some(rx);
    let input = plain(Arc::clone(&script), store, Some(5_000));
    let starting = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.start().await })
    };
    tokio::task::yield_now().await;
    let stopping = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.stop().await })
    };
    tokio::task::yield_now().await;
    assert!(!input.running());
    let _ = tx.send(());
    starting.await.unwrap().unwrap();
    stopping.await.unwrap().unwrap();
    assert_eq!(script.watcher_open.load(Ordering::SeqCst), 0);
    assert!(!input.runtime.timer_active());
    tokio::time::advance(Duration::from_millis(10_000)).await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn does_not_install_timer_when_stopped_during_first_collection() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let (tx, rx) = tokio::sync::oneshot::channel();
    *script.collect_wait.lock().unwrap() = Some(rx);
    let input = plain(Arc::clone(&script), store, Some(5_000));
    let starting = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.start().await })
    };
    tokio::time::timeout(Duration::from_secs(1), script.collect_entered.notified())
        .await
        .unwrap();
    let stopping = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.stop().await })
    };
    tokio::task::yield_now().await;
    assert!(!input.running());
    assert!(!stopping.is_finished());
    assert_eq!(script.stop_calls.load(Ordering::SeqCst), 0);
    let _ = tx.send(Vec::new());
    starting.await.unwrap().unwrap();
    stopping.await.unwrap().unwrap();
    assert!(!input.running());
    assert!(!input.runtime.timer_active());
    tokio::time::advance(Duration::from_millis(10_000)).await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn shares_pending_startup_and_waits_for_cleanup_before_restart() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    *script.start_wait.lock().unwrap() = Some(start_rx);
    let input = plain(Arc::clone(&script), store, Some(5_000));
    let first = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.start().await })
    };
    let duplicate = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.start().await })
    };
    tokio::task::yield_now().await;
    assert!(!first.is_finished());
    assert!(!duplicate.is_finished());
    assert_eq!(script.start_calls.load(Ordering::SeqCst), 1);
    let _ = start_tx.send(());
    first.await.unwrap().unwrap();
    duplicate.await.unwrap().unwrap();
    assert_eq!(script.start_calls.load(Ordering::SeqCst), 1);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    *script.stop_wait.lock().unwrap() = Some(stop_rx);
    let stopping = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.stop().await })
    };
    let restarting = {
        let input = Arc::clone(&input);
        tokio::spawn(async move { input.start().await })
    };
    tokio::task::yield_now().await;
    assert_eq!(script.start_calls.load(Ordering::SeqCst), 1);
    assert!(!stopping.is_finished());
    assert!(!restarting.is_finished());
    let _ = stop_tx.send(());
    stopping.await.unwrap().unwrap();
    restarting.await.unwrap().unwrap();
    assert_eq!(script.start_calls.load(Ordering::SeqCst), 2);
    assert!(input.running());
    assert!(input.runtime.timer_active());
    input.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn cleans_failed_startup_and_allows_retry() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    script.fail_starts.store(1, Ordering::SeqCst);
    let input = plain(Arc::clone(&script), store, Some(5_000));
    let err = input.start().await.unwrap_err();
    assert!(err.contains("startup failed"));
    assert!(!input.running());
    assert_eq!(script.stop_calls.load(Ordering::SeqCst), 1);
    assert!(!input.runtime.timer_active());
    input.start().await.unwrap();
    assert!(input.running());
    input.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn polls_on_interval_and_serializes_slow_cycles() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let input = plain(Arc::clone(&script), Arc::clone(&store), Some(5_000));
    input.start().await.unwrap();
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 2);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 3);

    let (tx, rx) = tokio::sync::oneshot::channel();
    *script.collect_wait.lock().unwrap() = Some(rx);
    script.collect_calls.store(0, Ordering::SeqCst);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(10_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 1);
    let _ = tx.send(Vec::new());
    tokio::task::yield_now().await;

    input.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn emits_entries_saves_and_keeps_polling_after_errors() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let entry = build_test_entry(&json!({ "filePath": "/tmp/test/file.ts" }));
    *script.entries.lock().unwrap() = vec![entry.clone()];
    let input = plain(Arc::clone(&script), Arc::clone(&store), Some(5_000));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let deltas = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| seen.lock().unwrap().push(entries.to_vec()));
    }
    {
        let deltas = Arc::clone(&deltas);
        input.on_runtime_delta(move |delta| deltas.lock().unwrap().push(delta.clone()));
    }
    input.start().await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(seen.lock().unwrap()[0].len(), 1);
    input.stop().await.unwrap();

    *script.entries.lock().unwrap() = Vec::new();
    let input = plain(Arc::clone(&script), Arc::clone(&store), Some(5_000));
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| seen.lock().unwrap().push(entries.len()));
    }
    input.start().await.unwrap();
    assert!(seen.lock().unwrap().is_empty());
    input.stop().await.unwrap();

    let script = Script::new();
    let input = plain(Arc::clone(&script), store, Some(5_000));
    let seen = Arc::new(Mutex::new(0_usize));
    let deltas = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| {
            if !entries.is_empty() {
                *seen.lock().unwrap() += 1;
            }
        });
    }
    {
        let deltas = Arc::clone(&deltas);
        input.on_runtime_delta(move |delta| deltas.lock().unwrap().push(delta.raw_read_calls));
    }
    script.fail_starts.store(0, Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<AgentActivityEntry>>();
    drop(tx);
    *script.collect_wait.lock().unwrap() = Some(rx);
    input.start().await.unwrap();
    assert_eq!(*seen.lock().unwrap(), 0);
    assert_eq!(deltas.lock().unwrap().len(), 1);
    *script.entries.lock().unwrap() = vec![build_test_entry(&json!({}))];
    tokio::time::advance(Duration::from_millis(5_000)).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    assert!(!deltas.lock().unwrap().is_empty());
    input.stop().await.unwrap();
}

struct OwnedHook {
    paths: HookPaths,
    transform_null: AtomicUsize,
    calls: AtomicUsize,
}

#[async_trait]
impl HookBody for OwnedHook {
    fn id(&self) -> &str {
        "test-hook"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QoderCliHook
    }
    fn paths(&self) -> &HookPaths {
        &self.paths
    }
    async fn transform_record(
        &self,
        _rt: &InputRuntime,
        record: &mut Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.transform_null.load(Ordering::SeqCst) > 0 {
            return Ok(None);
        }
        let file_path = record
            .get("file_path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        Ok(Some(build_test_entry(&json!({
            "filePath": file_path,
            "actionType": ActionType::Edit.as_str(),
        }))))
    }
}

fn hook_input(
    dir: &std::path::Path,
    store: Arc<StateStore>,
    nulls: bool,
) -> Arc<HostedInput<HookAdapter<OwnedHook>>> {
    let hosted = hosted_hook(
        OwnedHook {
            paths: HookPaths {
                log_dir: dir.to_string_lossy().into_owned(),
                log_prefix: "test-hook".into(),
                cold_start_keep_last_turn_only: false,
            },
            transform_null: AtomicUsize::new(if nulls { 1 } else { 0 }),
            calls: AtomicUsize::new(0),
        },
        "TestHookInput",
        store,
        Some(60_000),
    );
    hosted.runtime.force_poll_interval_ms(60_000);
    hosted
}

#[tokio::test]
async fn hook_reads_today_incrementally_and_skips_partial_lines() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let today = get_today_date_string();
    let log_file = dir.path().join(format!("test-hook-{today}.jsonl"));
    std::fs::write(&log_file, format!("{}\n", json!({"file_path": "/a.ts"}))).unwrap();
    let input = hook_input(dir.path(), Arc::clone(&store), false);
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| seen.lock().unwrap().extend(entries.to_vec()));
    }
    input.start().await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    input.stop().await.unwrap();

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&log_file)
        .unwrap();
    writeln!(file, "{}", json!({"file_path": "/second.ts"})).unwrap();
    let input2 = hook_input(dir.path(), Arc::clone(&store), false);
    let more = Arc::new(Mutex::new(Vec::new()));
    {
        let more = Arc::clone(&more);
        input2.on_entries(move |entries| more.lock().unwrap().extend(entries.to_vec()));
    }
    input2.start().await.unwrap();
    input2.stop().await.unwrap();
    assert_eq!(more.lock().unwrap().len(), 1);
    assert_eq!(
        legacy_file_path(&more.lock().unwrap()[0]),
        Some("/second.ts")
    );

    let complete = json!({"file_path": "/written-in-two-parts.ts"}).to_string();
    let split_at = complete.len() / 2;
    let partial = dir.path().join(format!("test-hook-{today}.jsonl"));
    std::fs::write(&partial, &complete[..split_at]).unwrap();
    let fresh = Arc::new(StateStore::new(dir.path().join("state-partial.json")));
    let input = hook_input(dir.path(), Arc::clone(&fresh), false);
    let incomplete_batches = Arc::new(AtomicUsize::new(0));
    let observed = incomplete_batches.clone();
    input.on_entries(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    let incomplete_deltas = Arc::new(Mutex::new(Vec::new()));
    let observed = incomplete_deltas.clone();
    input.on_runtime_delta(move |delta| observed.lock().unwrap().push(delta.clone()));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(incomplete_batches.load(Ordering::SeqCst), 0);
    {
        let deltas = incomplete_deltas.lock().unwrap();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].raw_read_calls, 1);
        assert_eq!(deltas[0].raw_read_bytes, split_at as u64);
        assert_eq!(deltas[0].raw_in_records, 0);
        assert_eq!(deltas[0].raw_in_bytes, 0);
        assert_eq!(deltas[0].raw_in_max_batch_bytes, split_at as u64);
        assert_eq!(fresh.get("test-hook").last_offset().unwrap_or(-1.0), 0.0);
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&partial)
        .unwrap();
    writeln!(file, "{}", &complete[split_at..]).unwrap();
    let next = hook_input(dir.path(), Arc::clone(&fresh), false);
    let got = Arc::new(Mutex::new(Vec::new()));
    {
        let got = Arc::clone(&got);
        next.on_entries(move |entries| got.lock().unwrap().extend(entries.to_vec()));
    }
    next.start().await.unwrap();
    next.stop().await.unwrap();
    assert_eq!(got.lock().unwrap().len(), 1);
    assert_eq!(
        legacy_file_path(&got.lock().unwrap()[0]),
        Some("/written-in-two-parts.ts")
    );
}

#[tokio::test]
async fn hook_cold_start_skips_previous_day_and_prunes_missing_offsets() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let today = get_today_date_string();
    let previous = add_days(&today, -1);
    let previous_name = format!("test-hook-{previous}.jsonl");
    std::fs::write(
        dir.path().join(&previous_name),
        format!(
            "{}\n{}\n",
            json!({"file_path": "/old-a.ts"}),
            json!({"file_path": "/old-b.ts"})
        ),
    )
    .unwrap();
    let input = hook_input(dir.path(), Arc::clone(&store), false);
    let seen = Arc::new(Mutex::new(0_usize));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| *seen.lock().unwrap() += entries.len());
    }
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(*seen.lock().unwrap(), 0);
    let extra = store.get("test-hook").extra().unwrap();
    let offsets = extra
        .get(OFFSET_MAP_EXTRA_KEY)
        .unwrap()
        .as_object()
        .unwrap();
    assert!(offsets.get(&previous_name).is_some());
    assert_eq!(offsets.len(), 1);
    assert_eq!(
        offsets[&previous_name].as_f64(),
        Some(
            std::fs::metadata(dir.path().join(&previous_name))
                .unwrap()
                .len() as f64
        )
    );
}

fn add_days(today: &str, days: i64) -> String {
    let date = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").unwrap();
    (date + chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string()
}

struct IdeProbe {
    events: Mutex<Vec<CodeGenerationEvent>>,
    fail_path: Mutex<Option<String>>,
    calls: AtomicUsize,
    scan_calls: AtomicUsize,
    since: Mutex<Option<f64>>,
    snapshot: SnapshotStore,
    root: String,
}

#[async_trait]
impl IdeBody for IdeProbe {
    fn id(&self) -> &str {
        "test-ide"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::Qoder
    }
    fn data_root(&self) -> &str {
        &self.root
    }
    fn snapshot_store(&self) -> &SnapshotStore {
        &self.snapshot
    }
    async fn scan_history_entries(
        &self,
        _rt: &InputRuntime,
        since_ts: f64,
    ) -> anyhow::Result<Vec<CodeGenerationEvent>> {
        self.scan_calls.fetch_add(1, Ordering::SeqCst);
        *self.since.lock().unwrap() = Some(since_ts);
        Ok(self.events.lock().unwrap().clone())
    }
    async fn build_entry(
        &self,
        _rt: &InputRuntime,
        event: &CodeGenerationEvent,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_path.lock().unwrap().as_deref() == Some(event.file_path.as_str()) {
            anyhow::bail!("build error");
        }
        if event.file_path == "/skip" {
            return Ok(None);
        }
        Ok(Some(build_test_entry(&json!({
            "filePath": event.file_path,
            "actionType": event.action_type.as_str(),
            "timestamp": event.source_timestamp,
        }))))
    }
}

fn code_event(path: &str, ts: i64) -> CodeGenerationEvent {
    CodeGenerationEvent {
        agent_type: ClientType::Qoder,
        file_path: path.into(),
        action_type: ActionType::Edit,
        content: None,
        diff: None,
        source_timestamp: ts,
        raw_data: Map::new(),
    }
}

#[tokio::test(start_paused = true)]
async fn ide_dedups_snapshot_keys_and_flushes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let snapshot_path = dir.path().join("snapshot.json");
    let body = IdeProbe {
        events: Mutex::new(vec![code_event("/a.ts", 1000)]),
        fail_path: Mutex::new(None),
        calls: AtomicUsize::new(0),
        scan_calls: AtomicUsize::new(0),
        since: Mutex::new(None),
        snapshot: SnapshotStore::new(&snapshot_path),
        root: dir.path().to_string_lossy().into_owned(),
    };
    let input = hosted_ide(body, "TestIdeInput", store, Some(60_000));
    input.runtime.force_poll_interval_ms(60_000);
    assert_eq!(
        input.collection_method(),
        CollectionMethod::IdeSnapshotPolling
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| seen.lock().unwrap().extend(entries.to_vec()));
    }
    input.start().await.unwrap();
    assert_eq!(input.body.inner().scan_calls.load(Ordering::SeqCst), 1);
    assert!(input
        .body
        .inner()
        .since
        .lock()
        .unwrap()
        .is_some_and(f64::is_finite));
    assert_eq!(seen.lock().unwrap().len(), 1);
    input.body.inner().events.lock().unwrap().clear();
    input
        .body
        .inner()
        .events
        .lock()
        .unwrap()
        .push(code_event("/a.ts", 1000));
    tokio::time::advance(Duration::from_millis(60_000)).await;
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert_eq!(input.body.inner().scan_calls.load(Ordering::SeqCst), 2);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(snapshot_path.exists());
    input.stop().await.unwrap();
}

#[tokio::test]
async fn ide_skips_build_errors_and_nulls() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let body = IdeProbe {
        events: Mutex::new(vec![
            code_event("/fail.ts", 1000),
            code_event("/ok.ts", 2000),
        ]),
        fail_path: Mutex::new(Some("/fail.ts".into())),
        calls: AtomicUsize::new(0),
        scan_calls: AtomicUsize::new(0),
        since: Mutex::new(None),
        snapshot: SnapshotStore::new(dir.path().join("snapshot.json")),
        root: dir.path().to_string_lossy().into_owned(),
    };
    let input = hosted_ide(body, "TestIdeInput", store, Some(60_000));
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| seen.lock().unwrap().extend(entries.to_vec()));
    }
    input.start().await.unwrap();
    assert_eq!(input.body.inner().calls.load(Ordering::SeqCst), 2);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(legacy_file_path(&seen.lock().unwrap()[0]), Some("/ok.ts"));
    input.stop().await.unwrap();
}

struct SessionProbe {
    paths: SessionPaths,
    files: Mutex<Vec<String>>,
    calls: AtomicUsize,
}

#[async_trait]
impl SessionBody for SessionProbe {
    fn id(&self) -> &str {
        "test-session"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QoderWork
    }
    fn paths(&self) -> &SessionPaths {
        &self.paths
    }
    async fn discover_session_files(&self, _rt: &InputRuntime) -> anyhow::Result<Vec<String>> {
        Ok(self.files.lock().unwrap().clone())
    }
    async fn process_session_line(
        &self,
        _rt: &InputRuntime,
        record: &Map<String, Value>,
        file_path: &str,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _ = file_path;
        let path = record
            .get("file_path")
            .and_then(Value::as_str)
            .unwrap_or("");
        Ok(Some(build_test_entry(&json!({ "filePath": path }))))
    }
}

#[tokio::test]
async fn session_offsets_inode_and_malformed_lines() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let file = dir.path().join("rotated.jsonl");
    std::fs::write(&file, format!("{}\n", json!({"file_path": "/original.ts"}))).unwrap();
    let input = hosted_session(
        SessionProbe {
            paths: SessionPaths {
                session_dir: dir.path().to_string_lossy().into_owned(),
                file_pattern: "*.jsonl".into(),
            },
            files: Mutex::new(vec![file.to_string_lossy().into_owned()]),
            calls: AtomicUsize::new(0),
        },
        "TestSessionInput",
        Arc::clone(&store),
        Some(60_000),
    );
    assert_eq!(
        input.collection_method(),
        CollectionMethod::SessionFilePolling
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| seen.lock().unwrap().extend(entries.to_vec()));
    }
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);

    let old = dir.path().join("rotated.jsonl.old");
    std::fs::rename(&file, &old).unwrap();
    std::fs::write(&file, format!("{}\n", json!({"file_path": "/rotated.ts"}))).unwrap();
    std::fs::remove_file(&old).unwrap();
    let input2 = hosted_session(
        SessionProbe {
            paths: SessionPaths {
                session_dir: dir.path().to_string_lossy().into_owned(),
                file_pattern: "*.jsonl".into(),
            },
            files: Mutex::new(vec![file.to_string_lossy().into_owned()]),
            calls: AtomicUsize::new(0),
        },
        "TestSessionInput",
        Arc::clone(&store),
        Some(60_000),
    );
    let more = Arc::new(Mutex::new(Vec::new()));
    {
        let more = Arc::clone(&more);
        input2.on_entries(move |entries| more.lock().unwrap().extend(entries.to_vec()));
    }
    input2.start().await.unwrap();
    input2.stop().await.unwrap();
    assert_eq!(more.lock().unwrap().len(), 1);
    assert_eq!(
        legacy_file_path(&more.lock().unwrap()[0]),
        Some("/rotated.ts")
    );

    let bad = dir.path().join("bad.jsonl");
    std::fs::write(
        &bad,
        format!("not-json\n{}\n", json!({"file_path": "/ok.ts"})),
    )
    .unwrap();
    let input3 = hosted_session(
        SessionProbe {
            paths: SessionPaths {
                session_dir: dir.path().to_string_lossy().into_owned(),
                file_pattern: "*.jsonl".into(),
            },
            files: Mutex::new(vec![
                bad.to_string_lossy().into_owned(),
                dir.path()
                    .join("missing.jsonl")
                    .to_string_lossy()
                    .into_owned(),
            ]),
            calls: AtomicUsize::new(0),
        },
        "TestSessionInput",
        store,
        Some(60_000),
    );
    let got = Arc::new(Mutex::new(Vec::new()));
    {
        let got = Arc::clone(&got);
        input3.on_entries(move |entries| got.lock().unwrap().extend(entries.to_vec()));
    }
    input3.start().await.unwrap();
    input3.stop().await.unwrap();
    assert_eq!(got.lock().unwrap().len(), 1);
    assert_eq!(legacy_file_path(&got.lock().unwrap()[0]), Some("/ok.ts"));
}

struct ExtSession {
    paths: SessionPaths,
    dir: String,
}

#[async_trait]
impl SessionBody for ExtSession {
    fn id(&self) -> &str {
        "mock-session-agent"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::Qoder
    }
    fn paths(&self) -> &SessionPaths {
        &self.paths
    }
    async fn discover_session_files(&self, _rt: &InputRuntime) -> anyhow::Result<Vec<String>> {
        let mut files = Vec::new();
        let mut dir = match tokio::fs::read_dir(&self.dir).await {
            Ok(dir) => dir,
            Err(_) => return Ok(files),
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".jsonl") {
                files.push(entry.path().to_string_lossy().into_owned());
            }
        }
        Ok(files)
    }
    async fn process_session_line(
        &self,
        _rt: &InputRuntime,
        record: &Map<String, Value>,
        _file_path: &str,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        if record.get("type").and_then(Value::as_str) != Some("action") {
            return Ok(None);
        }
        Ok(Some(build_test_entry(&json!({
            "sessionId": record.get("session_id").and_then(Value::as_str).unwrap_or(""),
            "agentType": ClientType::Qoder.as_str(),
            "actionType": ActionType::Edit.as_str(),
            "filePath": record.get("file_path").and_then(Value::as_str).unwrap_or(""),
            "timestamp": record.get("timestamp").cloned().unwrap_or(Value::from(0)),
        }))))
    }
}

#[tokio::test]
async fn extensibility_session_collects_action_lines_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let file = dir.path().join("mixed.jsonl");
    let lines = [
        json!({"type": "meta", "session_id": "s1"}).to_string(),
        json!({"type": "action", "session_id": "s1", "file_path": "/ok.ts", "timestamp": 1})
            .to_string(),
        json!({"type": "status", "progress": 50}).to_string(),
    ];
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
    let input = hosted_session(
        ExtSession {
            paths: SessionPaths {
                session_dir: dir.path().to_string_lossy().into_owned(),
                file_pattern: "*.jsonl".into(),
            },
            dir: dir.path().to_string_lossy().into_owned(),
        },
        "MockSessionInput",
        store,
        Some(60_000),
    );
    assert_eq!(
        input.collection_method(),
        CollectionMethod::SessionFilePolling
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        input.on_entries(move |entries| seen.lock().unwrap().extend(entries.to_vec()));
    }
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(seen.lock().unwrap()[0].agent_type, "qoder");
    assert_eq!(legacy_file_path(&seen.lock().unwrap()[0]), Some("/ok.ts"));
    assert!(!seen.lock().unwrap()[0].time_unix_nano.is_empty());
    assert!(!seen.lock().unwrap()[0].event_id.is_empty());
}

#[tokio::test]
async fn canonical_and_hook_transform_preserve_safe_fields() {
    let mut record = Map::new();
    record.insert("event.id".into(), json!("event-custom-1"));
    record.insert("event.name".into(), json!("llm.response"));
    record.insert("gen_ai.session.id".into(), json!("session-custom-1"));
    record.insert("gen_ai.agent.type".into(), json!("qoder-cli"));
    record.insert("multica.issue.id".into(), json!("AGE-992"));
    let strict = build_canonical_hook_entry(
        &record,
        ClientType::QoderCli.as_str(),
        None,
        CanonicalHookRecordOptions::default(),
    )
    .unwrap();
    assert!(strict.extra.get("multica.issue.id").is_none());

    record.insert("multica.user.id".into(), json!(" staff-1 "));
    record.insert("user.name".into(), json!("qoder-user"));
    record.insert("user.email".into(), json!("qoder-user@example.com"));
    let kept = build_canonical_hook_entry(
        &record,
        ClientType::QoderCli.as_str(),
        None,
        CanonicalHookRecordOptions {
            preserve_safe_custom_top_level_fields: true,
        },
    )
    .unwrap();
    assert_eq!(
        kept.extra.get("multica.issue.id").and_then(Value::as_str),
        Some("AGE-992")
    );
    assert_eq!(
        kept.extra.get("multica.user.id").and_then(Value::as_str),
        Some("staff-1")
    );
    assert_eq!(
        serde_json::to_value(&kept).unwrap()["event.name"],
        "llm.response"
    );
    assert_eq!(kept.user_name.as_deref(), Some("qoder-user"));
    assert_eq!(kept.user_email.as_deref(), Some("qoder-user@example.com"));

    let mut unsafe_record = record.clone();
    unsafe_record.insert("multica.api_token".into(), json!("secret"));
    unsafe_record.insert("multica.count".into(), json!(42));
    unsafe_record.insert("multica.empty".into(), json!(" "));
    unsafe_record.insert("multica.comma".into(), json!("one,two"));
    unsafe_record.insert("multica.too_long".into(), json!("x".repeat(513)));
    unsafe_record.insert("cost_custom".into(), json!("reserved"));
    unsafe_record.insert("event.custom".into(), json!("reserved"));
    let dropped = build_canonical_hook_entry(
        &unsafe_record,
        ClientType::QoderCli.as_str(),
        None,
        CanonicalHookRecordOptions {
            preserve_safe_custom_top_level_fields: true,
        },
    )
    .unwrap();
    for key in [
        "multica.api_token",
        "multica.count",
        "multica.empty",
        "multica.comma",
        "multica.too_long",
        "cost_custom",
        "event.custom",
    ] {
        assert!(dropped.extra.get(key).is_none(), "{key}");
        assert!(dropped.get(key).is_none(), "{key}");
    }

    let mut generic = Map::new();
    generic.insert("event.id".into(), json!("event-1"));
    generic.insert("event.name".into(), json!("llm.response"));
    generic.insert("gen_ai.session.id".into(), json!("session-1"));
    generic.insert("gen_ai.agent.type".into(), json!("claude-code"));
    generic.insert("gen_ai.response.finish_reasons".into(), json!(["stop"]));
    generic.insert(
        "resourceAttributes".into(),
        json!({
            "agentteams.worker.name": "local-worker",
            "agentteams.instance.id": "example-instance",
        }),
    );
    let entry = transform_hook_record(&generic, ClientType::ClaudeCliHook, "claude-code")
        .await
        .unwrap();
    let attrs = entry.resource_attributes.unwrap();
    assert_eq!(
        attrs.get("agentteams.worker.name").and_then(Value::as_str),
        Some("local-worker")
    );
}

#[test]
fn bootstrap_filter_keeps_latest_turn_per_batch() {
    let mut older = build_test_entry(&json!({ "gen_ai.turn.id": "t1" }));
    older
        .extra
        .insert("agent.transcript.cursor_mode".into(), json!("bootstrap"));
    older
        .extra
        .insert("agent.transcript.cursor_batch_id".into(), json!("b1"));
    older.turn_id = Some("t1".into());
    let mut newer = build_test_entry(&json!({ "gen_ai.turn.id": "t2" }));
    newer
        .extra
        .insert("agent.transcript.cursor_mode".into(), json!("bootstrap"));
    newer
        .extra
        .insert("agent.transcript.cursor_batch_id".into(), json!("b1"));
    newer.turn_id = Some("t2".into());
    let mut live = build_test_entry(&json!({ "gen_ai.turn.id": "live" }));
    live.turn_id = Some("live".into());
    let kept = filter_bootstrap_history_turns(vec![older, newer.clone(), live]);
    assert_eq!(kept.len(), 2);
    assert_eq!(kept[0].turn_id.as_deref(), Some("t2"));
    assert_eq!(kept[1].turn_id.as_deref(), Some("live"));
}

#[tokio::test]
async fn hook_history_checkpoint_baselines_existing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir
        .path()
        .join(format!("qoder-{}.jsonl", get_today_date_string()));
    std::fs::write(&file, "abc\n").unwrap();
    let checkpoint = create_hook_history_startup_checkpoint(
        &InputState::new(),
        dir.path().to_str().unwrap(),
        "qoder",
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(checkpoint.skipped_existing_bytes, 4);
    assert!(checkpoint.last_file.starts_with("qoder-"));
    let again = create_hook_history_startup_checkpoint(
        &InputState::new()
            .with_last_file(checkpoint.last_file.clone())
            .with_last_offset(4.0),
        dir.path().to_str().unwrap(),
        "qoder",
    )
    .await
    .unwrap();
    assert!(again.is_none());
}

#[tokio::test]
async fn each_successful_empty_cycle_persists_the_actual_dirty_checkpoint() {
    let (dir, store) = temp_store();
    let script = Script::new();
    let input = plain(script.clone(), store.clone(), Some(60_000));
    store.set_offset("first-cycle", 41.0);
    input.start().await.unwrap();
    let path = dir.path().join("input-state.json");
    let first: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(first["first-cycle"]["lastOffset"], 41.0);
    store.set_offset("second-cycle", 42.0);
    input.run_cycle().await;
    let second: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(second["first-cycle"]["lastOffset"], 41.0);
    assert_eq!(second["second-cycle"]["lastOffset"], 42.0);
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 2);
    input.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn collect_error_reports_zero_raw_delta_then_next_scheduled_tick_recovers() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    drop(sender);
    *script.collect_wait.lock().unwrap() = Some(receiver);
    let input = plain(script.clone(), store, Some(5_000));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let failures = Arc::new(Mutex::new(Vec::new()));
    let delivered = Arc::new(tokio::sync::Notify::new());
    let observed = seen.clone();
    let ready = delivered.clone();
    input.on_entries(move |entries| {
        observed.lock().unwrap().push(entries.to_vec());
        ready.notify_one();
    });
    let completed = Arc::new(tokio::sync::Notify::new());
    let ready = completed.clone();
    let observed = deltas.clone();
    input.on_runtime_delta(move |delta| {
        let mut rows = observed.lock().unwrap();
        rows.push(delta.clone());
        if rows.len() == 2 {
            ready.notify_one();
        }
    });
    let observed = failures.clone();
    input.on_collect_error(move |error| observed.lock().unwrap().push(error.to_owned()));
    input.start().await.unwrap();
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(failures.lock().unwrap().as_slice(), ["test error"]);
    assert_eq!(deltas.lock().unwrap().len(), 1);
    {
        let rows = deltas.lock().unwrap();
        let first = &rows[0];
        assert_eq!(first.source_kind, PRIMARY_INPUT_SOURCE_KIND);
        assert_eq!(first.raw_read_calls, 0);
        assert_eq!(first.raw_read_bytes, 0);
        assert_eq!(first.raw_in_records, 0);
        assert_eq!(first.raw_in_bytes, 0);
    }
    let entry = build_test_entry(&json!({"filePath":"/after-error.ts"}));
    *script.entries.lock().unwrap() = vec![entry.clone()];
    tokio::time::advance(Duration::from_millis(5_000)).await;
    tokio::time::timeout(Duration::from_secs(1), delivered.notified())
        .await
        .expect("the next scheduled polling cycle must survive the earlier Err");
    tokio::time::timeout(Duration::from_secs(1), completed.notified())
        .await
        .expect("recovery cycle must complete and report its runtime delta");
    assert_eq!(
        serde_json::to_value(&*seen.lock().unwrap()).unwrap(),
        json!([[entry]])
    );
    assert_eq!(deltas.lock().unwrap().len(), 2);
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 2);
    input.stop().await.unwrap();
    tokio::time::advance(Duration::from_millis(10_000)).await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn stop_drains_the_actual_active_cycle_before_body_cleanup() {
    let (_dir, store) = temp_store();
    let script = Script::new();
    let input = plain(script.clone(), store, Some(5_000));
    input.start().await.unwrap();
    script.collect_entered.notified().await;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    *script.collect_wait.lock().unwrap() = Some(receiver);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    tokio::time::timeout(Duration::from_secs(1), script.collect_entered.notified())
        .await
        .unwrap();
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 2);
    let stopping = {
        let input = input.clone();
        tokio::spawn(async move { input.stop().await })
    };
    tokio::task::yield_now().await;
    assert!(!stopping.is_finished());
    assert_eq!(script.stop_calls.load(Ordering::SeqCst), 0);
    sender.send(Vec::new()).unwrap();
    stopping.await.unwrap().unwrap();
    assert_eq!(script.stop_calls.load(Ordering::SeqCst), 1);
    assert!(!input.running());
    assert!(!input.runtime.timer_active());
    tokio::time::advance(Duration::from_millis(10_000)).await;
    assert_eq!(script.collect_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn ide_different_keys_emit_two_entries_and_null_builds_emit_no_batch() {
    for (events, expected_paths) in [
        (
            vec![code_event("/a.ts", 1_000), code_event("/b.ts", 2_000)],
            vec!["/a.ts", "/b.ts"],
        ),
        (vec![code_event("/skip", 1_000)], vec![]),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(StateStore::new(dir.path().join("state.json")));
        let input = hosted_ide(
            IdeProbe {
                events: Mutex::new(events),
                fail_path: Mutex::new(None),
                calls: AtomicUsize::new(0),
                scan_calls: AtomicUsize::new(0),
                since: Mutex::new(None),
                snapshot: SnapshotStore::new(dir.path().join("snapshot.json")),
                root: dir.path().to_string_lossy().into_owned(),
            },
            "TestIdeContract",
            store,
            Some(60_000),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observed = seen.clone();
        input.on_entries(move |entries| observed.lock().unwrap().push(entries.to_vec()));
        input.start().await.unwrap();
        assert_eq!(input.body.inner().scan_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            input.body.inner().calls.load(Ordering::SeqCst),
            if expected_paths.is_empty() { 1 } else { 2 }
        );
        let batches = seen.lock().unwrap().clone();
        if expected_paths.is_empty() {
            assert!(batches.is_empty());
        } else {
            assert_eq!(batches.len(), 1);
            assert_eq!(
                batches[0]
                    .iter()
                    .filter_map(legacy_file_path)
                    .collect::<Vec<_>>(),
                expected_paths
            );
        }
        input.stop().await.unwrap();
    }
}

#[tokio::test]
async fn hook_resource_attributes_survive_both_real_transform_paths() {
    let attributes = json!({
        "agentteams.worker.name":"local-worker",
        "agentteams.instance.id":"example-instance"
    });
    let record = json!({
        "event.id":"event-1","event.name":"llm.response",
        "gen_ai.session.id":"session-1","gen_ai.agent.type":"claude-code",
        "gen_ai.response.finish_reasons":["stop"],"resourceAttributes":attributes
    })
    .as_object()
    .unwrap()
    .clone();
    let generic = transform_hook_record(&record, ClientType::ClaudeCliHook, "claude-code")
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(generic.resource_attributes.unwrap()).unwrap(),
        attributes
    );
    let mut canonical_record = record;
    canonical_record.insert("event.id".into(), json!("event-2"));
    canonical_record.insert("gen_ai.session.id".into(), json!("session-2"));
    let canonical = build_canonical_hook_entry(
        &canonical_record,
        ClientType::ClaudeCliHook.as_str(),
        None,
        CanonicalHookRecordOptions::default(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(canonical.resource_attributes.unwrap()).unwrap(),
        attributes
    );
}

struct ContractSession {
    paths: SessionPaths,
    files: Vec<String>,
    discoveries: AtomicUsize,
    records: Mutex<Vec<(String, Value)>>,
    filter_all: bool,
}

#[async_trait]
impl SessionBody for ContractSession {
    fn id(&self) -> &str {
        "contract-session"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QoderWork
    }
    fn paths(&self) -> &SessionPaths {
        &self.paths
    }
    async fn discover_session_files(&self, _: &InputRuntime) -> anyhow::Result<Vec<String>> {
        self.discoveries.fetch_add(1, Ordering::SeqCst);
        Ok(self.files.clone())
    }
    async fn process_session_line(
        &self,
        _: &InputRuntime,
        record: &Map<String, Value>,
        path: &str,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        self.records
            .lock()
            .unwrap()
            .push((path.into(), Value::Object(record.clone())));
        if self.filter_all {
            return Ok(None);
        }
        Ok(Some(build_test_entry(
            &json!({"filePath":record.get("file_path").and_then(Value::as_str).unwrap_or("")}),
        )))
    }
}

fn contract_session(
    dir: &std::path::Path,
    store: Arc<StateStore>,
    files: Vec<String>,
    filter_all: bool,
) -> Arc<HostedInput<SessionAdapter<ContractSession>>> {
    let input = hosted_session(
        ContractSession {
            paths: SessionPaths {
                session_dir: dir.to_string_lossy().into_owned(),
                file_pattern: "*.jsonl".into(),
            },
            files,
            discoveries: AtomicUsize::new(0),
            records: Mutex::new(Vec::new()),
            filter_all,
        },
        "SessionContract",
        store,
        Some(60_000),
    );
    input.runtime.force_poll_interval_ms(60_000);
    input
}

fn entry_paths(entries: &[AgentActivityEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| legacy_file_path(entry).unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn session_delegates_each_record_and_filepath_then_resumes_only_new_bytes_from_disk() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("session.jsonl");
    let path = file.to_string_lossy().into_owned();
    let state = dir.path().join("state.json");
    std::fs::write(
        &file,
        "{\"file_path\":\"/a.ts\"}\n{\"file_path\":\"/b.ts\"}\n",
    )
    .unwrap();
    let store = Arc::new(StateStore::new(&state));
    let input = contract_session(dir.path(), store, vec![path.clone()], false);
    assert_eq!(
        input.collection_method(),
        CollectionMethod::SessionFilePolling
    );
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
    input.start().await.unwrap();
    assert_eq!(input.body.inner().discoveries.load(Ordering::SeqCst), 1);
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/a.ts", "/b.ts"]);
    let records = input.body.inner().records.lock().unwrap().clone();
    assert_eq!(
        records,
        vec![
            (path.clone(), json!({"file_path":"/a.ts"})),
            (path.clone(), json!({"file_path":"/b.ts"})),
        ]
    );
    input.stop().await.unwrap();
    use std::io::Write;
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap(),
        "{}",
        json!({"file_path":"/second.ts"})
    )
    .unwrap();
    let restored = Arc::new(StateStore::new(&state));
    restored.load().await;
    let next = contract_session(dir.path(), restored, vec![path], false);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    next.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
    next.start().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/second.ts"]);
    next.run_cycle().await;
    assert_eq!(next.body.inner().discoveries.load(Ordering::SeqCst), 2);
    assert_eq!(next.body.inner().records.lock().unwrap().len(), 1);
    assert_eq!(rows.lock().unwrap().len(), 1);
    next.stop().await.unwrap();
}

#[tokio::test]
async fn session_counts_malformed_and_filtered_records_before_normalization() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("raw-stats.jsonl");
    let payload = "not-json\n{\"file_path\":\"/filtered.ts\"}\n";
    std::fs::write(&file, payload).unwrap();
    let input = contract_session(
        dir.path(),
        Arc::new(StateStore::new(dir.path().join("state.json"))),
        vec![file.to_string_lossy().into_owned()],
        true,
    );
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let observed = deltas.clone();
    input.on_runtime_delta(move |delta| observed.lock().unwrap().push(delta.clone()));
    let emitted = Arc::new(AtomicUsize::new(0));
    let observed = emitted.clone();
    input.on_entries(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(emitted.load(Ordering::SeqCst), 0);
    assert_eq!(input.body.inner().records.lock().unwrap().len(), 1);
    let rows = deltas.lock().unwrap();
    assert_eq!(rows.len(), 1);
    let stats = &rows[0];
    assert_eq!(stats.raw_read_calls, 1);
    assert_eq!(stats.raw_read_bytes, payload.len() as u64);
    assert_eq!(stats.raw_in_records, 2);
    assert_eq!(stats.raw_in_bytes, payload.len() as u64);
    assert_eq!(stats.raw_in_max_batch_bytes, payload.len() as u64);
    assert_eq!(stats.parse_success_records, 1);
    assert_eq!(stats.parse_failed_records, 1);
}

#[tokio::test]
async fn session_missing_files_emit_nothing_and_never_invoke_the_record_processor() {
    let dir = tempfile::tempdir().unwrap();
    let input = contract_session(
        dir.path(),
        Arc::new(StateStore::new(dir.path().join("state.json"))),
        vec![dir
            .path()
            .join("nonexistent.jsonl")
            .to_string_lossy()
            .into_owned()],
        false,
    );
    let emitted = Arc::new(AtomicUsize::new(0));
    let observed = emitted.clone();
    input.on_entries(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    input.start().await.unwrap();
    assert_eq!(input.body.inner().discoveries.load(Ordering::SeqCst), 1);
    assert!(input.body.inner().records.lock().unwrap().is_empty());
    assert_eq!(emitted.load(Ordering::SeqCst), 0);
    input.stop().await.unwrap();
}

#[tokio::test]
async fn session_same_length_replacement_is_not_mistaken_for_an_already_consumed_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("rotated.jsonl");
    let old = dir.path().join("rotated.jsonl.old");
    let path = file.to_string_lossy().into_owned();
    let key = format!("contract-session:{path}");
    let checkpoint = dir.path().join("state.json");
    let first = "{\"file_path\":\"/a.ts\"}\n";
    let replacement = "{\"file_path\":\"/b.ts\"}\n";
    assert_eq!(first.len(), replacement.len());
    std::fs::write(&file, first).unwrap();
    let store = Arc::new(StateStore::new(&checkpoint));
    let input = contract_session(dir.path(), store.clone(), vec![path.clone()], false);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/a.ts"]);
    let previous_identity = store.get(&key).extra().unwrap()["inode"].clone();
    std::fs::rename(&file, &old).unwrap();
    std::fs::write(&file, replacement).unwrap();
    let restored = Arc::new(StateStore::new(&checkpoint));
    restored.load().await;
    let next = contract_session(dir.path(), restored.clone(), vec![path], false);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    next.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
    next.start().await.unwrap();
    next.stop().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/b.ts"]);
    assert_ne!(
        restored.get(&key).extra().unwrap()["inode"],
        previous_identity
    );
    assert_eq!(restored.get_offset(&key), replacement.len() as f64);
    std::fs::remove_file(old).unwrap();
}

#[tokio::test]
async fn session_adopts_legacy_unknown_identity_without_replaying_the_saved_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("legacy-zero-inode.jsonl");
    let path = file.to_string_lossy().into_owned();
    let key = format!("contract-session:{path}");
    let first = "{\"file_path\":\"/already-consumed.ts\"}\n";
    std::fs::write(&file, first).unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    store.set(
        &key,
        InputState::new()
            .with_last_offset(first.len() as f64)
            .with_extra(json!({"inode":0,"preserved":"yes"})),
    );
    let input = contract_session(dir.path(), store.clone(), vec![path], false);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
    input.start().await.unwrap();
    assert!(rows.lock().unwrap().is_empty());
    assert_eq!(store.get_offset(&key), first.len() as f64);
    assert_eq!(store.get(&key).extra().unwrap()["preserved"], "yes");
    assert!(store.get(&key).extra().unwrap().get("device").is_some());
    use std::io::Write;
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap(),
        "{}",
        json!({"file_path":"/new-tail.ts"})
    )
    .unwrap();
    input.run_cycle().await;
    input.stop().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/new-tail.ts"]);
}

#[cfg(unix)]
#[tokio::test]
async fn session_permission_failures_warn_once_and_keep_collecting_readable_siblings() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    const CHILD: &str = "PILOT_BASE_SESSION_PERMISSION_CHILD";
    if let Some(mode) = std::env::var_os(CHILD) {
        let root = std::path::PathBuf::from(std::env::var_os("PILOT_PERMISSION_FIXTURE").unwrap());
        let blocked = root.join("blocked.jsonl");
        let readable = root.join("readable.jsonl");
        let owner = std::fs::metadata(&blocked).unwrap().uid();
        let daemon = if mode == "mismatch" {
            owner.wrapping_add(1)
        } else {
            owner
        };
        let input = contract_session(
            &root,
            Arc::new(StateStore::new(root.join("checkpoint/state.json"))),
            vec![
                blocked.to_string_lossy().into_owned(),
                readable.to_string_lossy().into_owned(),
            ],
            false,
        );
        input.runtime.set_daemon_uid_override(Some(daemon));
        let rows = Arc::new(Mutex::new(Vec::new()));
        let observed = rows.clone();
        input.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
        input.start().await.unwrap();
        assert_eq!(entry_paths(&rows.lock().unwrap()), ["/ok.ts"]);
        let warnings = input.runtime.test_warns();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("ownership-mismatch"));
        if mode == "mismatch" {
            assert!(warnings[0].contains(&format!("owned by uid {owner}")));
            assert!(warnings[0].contains(&format!("daemon runs as uid {daemon}")));
        } else {
            assert!(warnings[0].contains(&format!("despite matching uid {daemon}")));
            assert!(warnings[0].contains("SELinux/AppArmor/ACLs"));
        }
        input.stop().await.unwrap();
        input.start().await.unwrap();
        assert_eq!(input.runtime.test_warns(), warnings);
        assert_eq!(entry_paths(&rows.lock().unwrap()), ["/ok.ts"]);
        input.stop().await.unwrap();
        return;
    }
    let uid = unsafe { libc::getuid() };
    for mode in ["mismatch", "matching"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let blocked = root.join("blocked.jsonl");
        std::fs::write(&blocked, "{\"file_path\":\"/blocked.ts\"}\n").unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::write(root.join("readable.jsonl"), "{\"file_path\":\"/ok.ts\"}\n").unwrap();
        std::fs::set_permissions(
            root.join("readable.jsonl"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let checkpoint = root.join("checkpoint");
        std::fs::create_dir(&checkpoint).unwrap();
        std::fs::set_permissions(&checkpoint, std::fs::Permissions::from_mode(0o700)).unwrap();
        let child_uid = if uid == 0 { 65_534 } else { uid };
        if uid == 0 {
            std::os::unix::fs::chown(&blocked, Some(child_uid), Some(child_uid)).unwrap();
            std::os::unix::fs::chown(&checkpoint, Some(child_uid), Some(child_uid)).unwrap();
        }
        let executable = root.join("isolated-session-permission-tests");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = std::process::Command::new(executable);
        command.env_clear()
            .args(["--exact","inputs::base::tests::session_permission_failures_warn_once_and_keep_collecting_readable_siblings","--nocapture"])
            .env(CHILD,mode).env("PILOT_PERMISSION_FIXTURE",root)
            .env("HOME",&checkpoint).env("USERPROFILE",&checkpoint)
            .env("TMPDIR",&checkpoint).env("TMP",&checkpoint).env("TEMP",&checkpoint)
            .env("PATH",root.join("no-runtimes"))
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        if uid == 0 {
            use std::os::unix::process::CommandExt;
            command.uid(child_uid).gid(child_uid);
        }
        let mut child = command.spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!("permission fixture timed out: {output:?}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{mode} permission fixture failed: {output:?}"
        );
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[tokio::test]
async fn hook_missing_and_empty_logs_emit_no_batches_or_transform_calls() {
    for empty in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        if empty {
            std::fs::write(
                dir.path()
                    .join(format!("test-hook-{}.jsonl", get_today_date_string())),
                "",
            )
            .unwrap();
        }
        let input = hook_input(
            dir.path(),
            Arc::new(StateStore::new(dir.path().join("state.json"))),
            false,
        );
        assert_eq!(input.collection_method(), CollectionMethod::HookJsonl);
        let emitted = Arc::new(AtomicUsize::new(0));
        let observed = emitted.clone();
        input.on_entries(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert_eq!(emitted.load(Ordering::SeqCst), 0);
        assert_eq!(input.body.inner().calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn hook_raw_metrics_include_malformed_and_filtered_utf8_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let valid = "{\"file_path\":\"/已过滤.ts\"}\n";
    let payload = format!("not-json\n{valid}");
    std::fs::write(
        dir.path()
            .join(format!("test-hook-{}.jsonl", get_today_date_string())),
        &payload,
    )
    .unwrap();
    let input = hook_input(
        dir.path(),
        Arc::new(StateStore::new(dir.path().join("state.json"))),
        true,
    );
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let observed = deltas.clone();
    input.on_runtime_delta(move |stats| observed.lock().unwrap().push(stats.clone()));
    let emitted = Arc::new(AtomicUsize::new(0));
    let observed = emitted.clone();
    input.on_entries(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(emitted.load(Ordering::SeqCst), 0);
    assert_eq!(input.body.inner().calls.load(Ordering::SeqCst), 1);
    let rows = deltas.lock().unwrap();
    assert_eq!(rows.len(), 1);
    let stats = &rows[0];
    assert_eq!(stats.raw_read_calls, 1);
    assert_eq!(stats.raw_read_bytes, payload.len() as u64);
    assert_eq!(stats.raw_in_records, 2);
    assert_eq!(stats.raw_in_bytes, payload.len() as u64);
    assert_eq!(stats.raw_in_max_batch_bytes, payload.len() as u64);
    assert_eq!(stats.raw_in_max_record_bytes, valid.len() as u64);
    assert_eq!(stats.parse_success_records, 1);
    assert_eq!(stats.parse_failed_records, 1);
}

#[tokio::test]
async fn hook_transforms_each_new_line_once_and_skips_bad_json_without_aborting_valid_siblings() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir
        .path()
        .join(format!("test-hook-{}.jsonl", get_today_date_string()));
    std::fs::write(
        &file,
        "not-json\n{\"file_path\":\"/a.ts\"}\n{\"file_path\":\"/b.ts\"}\n",
    )
    .unwrap();
    let input = hook_input(
        dir.path(),
        Arc::new(StateStore::new(dir.path().join("state.json"))),
        false,
    );
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
    input.start().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/a.ts", "/b.ts"]);
    assert_eq!(input.body.inner().calls.load(Ordering::SeqCst), 2);
    input.run_cycle().await;
    assert_eq!(input.body.inner().calls.load(Ordering::SeqCst), 2);
    assert_eq!(rows.lock().unwrap().len(), 2);
    use std::io::Write;
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap(),
        "{}",
        json!({"file_path":"/c.ts"})
    )
    .unwrap();
    input.run_cycle().await;
    input.stop().await.unwrap();
    assert_eq!(
        entry_paths(&rows.lock().unwrap()),
        ["/a.ts", "/b.ts", "/c.ts"]
    );
    assert_eq!(input.body.inner().calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn hook_stale_truncated_offset_resets_then_persists_the_short_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir
        .path()
        .join(format!("test-hook-{}.jsonl", get_today_date_string()));
    let checkpoint = dir.path().join("state.json");
    std::fs::write(
        &file,
        "{\"file_path\":\"/first-entry-with-long-path.ts\"}\n",
    )
    .unwrap();
    let store = Arc::new(StateStore::new(&checkpoint));
    let input = hook_input(dir.path(), store, false);
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let short = "{\"file_path\":\"/short.ts\"}\n";
    std::fs::write(&file, short).unwrap();
    let restored = Arc::new(StateStore::new(&checkpoint));
    restored.load().await;
    assert!(restored.get_offset("test-hook") > short.len() as f64);
    let next = hook_input(dir.path(), restored.clone(), false);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    next.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
    next.start().await.unwrap();
    next.stop().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/short.ts"]);
    assert_eq!(restored.get_offset("test-hook"), short.len() as f64);
}

#[tokio::test]
async fn hook_drains_previous_day_in_order_and_keeps_lagged_sources_after_today() {
    for lagged in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let today = get_today_date_string();
        let previous = add_days(&today, -1);
        let old_name = format!("test-hook-{previous}.jsonl");
        let current_name = format!("test-hook-{today}.jsonl");
        let old_consumed = "{\"file_path\":\"/already-read.ts\"}\n";
        let old_payload = format!("{old_consumed}{{\"file_path\":\"/late-previous.ts\"}}\n");
        let current_payload = if lagged {
            "{\"file_path\":\"/today-consumed.ts\"}\n"
        } else {
            "{\"file_path\":\"/today.ts\"}\n"
        };
        std::fs::write(dir.path().join(&old_name), &old_payload).unwrap();
        std::fs::write(dir.path().join(&current_name), current_payload).unwrap();
        let store = Arc::new(StateStore::new(dir.path().join("state.json")));
        let state = if lagged {
            InputState::new().with_last_file(&current_name).with_last_offset(current_payload.len() as f64)
                .with_extra(json!({(OFFSET_MAP_EXTRA_KEY):{(old_name.clone()):old_consumed.len(),(current_name.clone()):current_payload.len()}}))
        } else {
            InputState::new()
                .with_last_file(&old_name)
                .with_last_offset(old_consumed.len() as f64)
        };
        store.set("test-hook", state);
        let input = hook_input(dir.path(), store.clone(), false);
        let rows = Arc::new(Mutex::new(Vec::new()));
        let observed = rows.clone();
        input.on_entries(move |batch| observed.lock().unwrap().extend(batch.to_vec()));
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert_eq!(
            entry_paths(&rows.lock().unwrap()),
            if lagged {
                vec!["/late-previous.ts"]
            } else {
                vec!["/late-previous.ts", "/today.ts"]
            }
        );
        let final_state = store.get("test-hook");
        assert_eq!(final_state.last_file(), Some(current_name.as_str()));
        assert_eq!(
            final_state.extra().unwrap()[OFFSET_MAP_EXTRA_KEY],
            json!({
                (old_name):old_payload.len() as f64,(current_name):current_payload.len() as f64
            })
        );
    }
}

#[tokio::test]
async fn hook_prunes_only_missing_daily_offsets_and_keeps_live_and_unrelated_state() {
    let dir = tempfile::tempdir().unwrap();
    let today = get_today_date_string();
    let current_name = format!("test-hook-{today}.jsonl");
    let old_name = format!("test-hook-{}.jsonl", add_days(&today, -30));
    let payload = "{\"file_path\":\"/today.ts\"}\n";
    std::fs::write(dir.path().join(&current_name), payload).unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    store.set("test-hook",InputState::new().with_last_file(&current_name).with_last_offset(0.0)
        .with_extra(json!({(OFFSET_MAP_EXTRA_KEY):{(old_name.clone()):999,(current_name.clone()):0},"unrelated":"keep"})));
    let input = hook_input(dir.path(), store.clone(), false);
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let extra = store.get("test-hook").extra().unwrap();
    assert_eq!(
        extra[OFFSET_MAP_EXTRA_KEY],
        json!({(current_name):payload.len() as f64})
    );
    assert!(extra[OFFSET_MAP_EXTRA_KEY].get(&old_name).is_none());
    assert_eq!(extra["unrelated"], "keep");
}

mod shared_history_contracts {
    include!("shared_history_contracts.rs");
}
