//! Main runtime contracts; controlled preparation matches original private spies.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Notify, Semaphore};

#[derive(Default)]
struct Capture(Mutex<Vec<Vec<AgentActivityEntry>>>);
impl Capture {
    fn calls(&self) -> Vec<Vec<AgentActivityEntry>> {
        self.0.lock().unwrap().clone()
    }
}
impl EventLogConverter for Capture {
    fn convert(
        &self,
        rows: &[AgentActivityEntry],
        _: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        self.0.lock().unwrap().push(rows.to_vec());
        Ok(ConvertResult::default())
    }
}
struct Gate {
    entered: Semaphore,
    released: AtomicBool,
    notify: Notify,
}
impl Gate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: Semaphore::new(0),
            released: AtomicBool::new(false),
            notify: Notify::new(),
        })
    }
    async fn hold(&self) {
        let waiting = self.notify.notified();
        tokio::pin!(waiting);
        waiting.as_mut().enable();
        self.entered.add_permits(1);
        if !self.released.load(Ordering::SeqCst) {
            waiting.await;
        }
    }
    async fn entered(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(5), self.entered.acquire())
            .await
            .is_ok_and(|permit| {
                permit.unwrap().forget();
                true
            })
    }
    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
}
fn row(turn: &str, terminal: bool) -> AgentActivityEntry {
    entry_from_map(serde_json::json!({
        "event.name":"llm.response","gen_ai.agent.type":"codex","gen_ai.turn.id":turn,
        "gen_ai.session.id":turn,"gen_ai.output.messages":"private body",
        "gen_ai.turn.end":terminal,"agent.codex.turn_status":if terminal {"completed"} else {"in_progress"}
    }).as_object().unwrap().clone())
}
fn setup() -> (tempfile::TempDir, Arc<OtlpTraceFlusher>, Arc<Capture>) {
    setup_with(None, 0)
}
fn setup_with(
    journal: Option<Arc<super::super::CodexTurnJournal>>,
    idle_ms: u64,
) -> (tempfile::TempDir, Arc<OtlpTraceFlusher>, Arc<Capture>) {
    let root = tempfile::tempdir().unwrap();
    let cfg = serde_json::from_value(serde_json::json!({
        "enabled":true,"serviceName":"test","protocol":"http/protobuf","dataDir":root.path(),
        "turnIdleTimeoutMs":idle_ms,"endpoints":[{"name":"primary","endpoint":"http://unused:4318"}]
    }))
    .unwrap();
    let capture = Arc::new(Capture::default());
    let mut f = OtlpTraceFlusher::with_parts(cfg, None, None, Some(capture.clone())).unwrap();
    if let Some(journal) = journal {
        f = f.with_codex_journal(journal, Ok);
    }
    (root, Arc::new(f), capture)
}
#[tokio::test]
async fn main_l180_two_preparations_overlap_and_terminal_conversion_waits_for_both() {
    let (_root, f, capture) = setup();
    let first = Gate::new();
    let second = Gate::new();
    let a = first.clone();
    let b = second.clone();
    *f.inner.test_codex_preparation.lock().unwrap() = Some(Arc::new(move |rows| {
        let gate = if rows[0].turn_id.as_deref() == Some("first") {
            a.clone()
        } else {
            b.clone()
        };
        Box::pin(async move {
            gate.hold().await;
            Ok(())
        })
    }));
    let out = f.clone();
    let first_send =
        tokio::spawn(async move { out.send_batch(vec![row("first", true)], None).await });
    assert!(first.entered().await);
    let out = f.clone();
    let second_send =
        tokio::spawn(async move { out.send_batch(vec![row("second", true)], None).await });
    let overlapped = second.entered().await;
    first.release();
    first_send.await.unwrap().unwrap();
    let deferred = capture.calls().is_empty();
    second.release();
    second_send.await.unwrap().unwrap();
    assert!(
        overlapped,
        "second private preparation must enter before first is released"
    );
    assert!(deferred);
    assert_eq!(capture.calls().len(), 2);
    f.send(row("next", true), None).await.unwrap();
    assert_eq!(capture.calls().len(), 3);
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l315_terminal_single_is_accepted_while_earlier_preparation_is_pending() {
    let (_root, f, capture) = setup();
    let first = Gate::new();
    let held = first.clone();
    *f.inner.test_codex_preparation.lock().unwrap() = Some(Arc::new(move |rows| {
        let held = held.clone();
        Box::pin(async move {
            if rows[0].turn_id.as_deref() == Some("pending") {
                held.hold().await;
            }
            Ok(())
        })
    }));
    let out = f.clone();
    let pending = tokio::spawn(async move { out.send(row("pending", false), None).await });
    assert!(first.entered().await);
    let out = f.clone();
    let mut terminal = tokio::spawn(async move { out.send(row("terminal", true), None).await });
    let independent = tokio::time::timeout(Duration::from_secs(5), &mut terminal).await;
    let accepted = independent.is_ok();
    if let Ok(result) = independent {
        result.unwrap().unwrap();
    }
    let deferred = capture.calls().is_empty();
    first.release();
    pending.await.unwrap().unwrap();
    if !accepted {
        terminal.await.unwrap().unwrap();
    }
    assert!(
        accepted,
        "terminal single must finish preparation before prior send is released"
    );
    assert!(deferred);
    assert_eq!(capture.calls().len(), 1);
    assert_eq!(capture.calls()[0][0].turn_id.as_deref(), Some("terminal"));
    f.shutdown().await.unwrap();
}

fn durable(turn: &str, id: &str, terminal: bool) -> AgentActivityEntry {
    let mut object = entry_to_object(&row(turn, terminal));
    object.insert("user.id".into(), Value::String("owner".into()));
    object.insert("event.id".into(), Value::String(id.into()));
    entry_from_map(object)
}
async fn journal_ids(journal: &Arc<super::super::CodexTurnJournal>) -> Vec<String> {
    let mut replay = journal.load(None).await.unwrap();
    let mut ids = Vec::new();
    while let Some(group) = replay.next_group().await.unwrap() {
        ids.extend(group.into_iter().map(|row| row.event_id));
    }
    ids
}
#[tokio::test]
async fn main_l108_concurrent_codex_turns_keep_bytes_until_their_own_terminal() {
    let (_root, f, _) = setup();
    f.send(row("first", false), Some(12.0)).await.unwrap();
    f.send(row("next", false), Some(34.0)).await.unwrap();
    let snapshot = f.trace_runtime_snapshot();
    assert_eq!(snapshot[0].pending_buffers, 2);
    assert_eq!(snapshot[0].pending_logical_bytes, 46.0);
    assert_eq!(snapshot[0].removed_buffers_total, 0);
    f.send(row("first", true), Some(0.0)).await.unwrap();
    let snapshot = f.trace_runtime_snapshot();
    assert_eq!(snapshot[0].pending_buffers, 1);
    assert_eq!(snapshot[0].pending_logical_bytes, 34.0);
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l215_real_preparation_io_error_releases_batch_depth_for_next_terminal() {
    let root = tempfile::tempdir().unwrap();
    let journal_path = root.path().join("pending");
    let journal = Arc::new(super::super::CodexTurnJournal::new(&journal_path));
    let (_root, f, capture) = setup_with(Some(journal), 0);
    f.start().await.unwrap();
    std::fs::create_dir_all(&journal_path).unwrap();
    std::fs::remove_dir(&journal_path).unwrap();
    std::fs::write(&journal_path, b"not a directory").unwrap();
    let error = f
        .send_batch(vec![durable("failed", "failed", false)], None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("journal"), "{error}");
    assert_eq!(f.inner.state.lock().unwrap().batch_depth, 0);
    std::fs::remove_file(&journal_path).unwrap();
    f.send(durable("next", "next", true), None).await.unwrap();
    assert_eq!(capture.calls().len(), 1);
    assert_eq!(capture.calls()[0][0].turn_id.as_deref(), Some("next"));
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l224_startup_replay_finishes_before_live_batch_is_durably_accepted() {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(super::super::CodexTurnJournal::new(root.path()));
    journal
        .append(&[durable("restored", "restored-prefix", false)])
        .await
        .unwrap();
    let (_root, f, _) = setup_with(Some(journal.clone()), 0);
    let first = Gate::new();
    let held = first.clone();
    *f.inner.test_codex_startup_replay.lock().unwrap() = Some(Arc::new(move |_| {
        let held = held.clone();
        Box::pin(async move {
            held.hold().await;
            Ok(())
        })
    }));
    let out = f.clone();
    let restoring = tokio::spawn(async move { out.start().await });
    assert!(first.entered().await);
    let accepted = Arc::new(AtomicBool::new(false));
    let flag = accepted.clone();
    let out = f.clone();
    let sending = tokio::spawn(async move {
        out.send_batch(vec![durable("live", "live-prefix", false)], None)
            .await
            .unwrap();
        flag.store(true, Ordering::SeqCst);
    });
    tokio::task::yield_now().await;
    let premature = accepted.load(Ordering::SeqCst);
    let before = journal_ids(&journal).await;
    first.release();
    restoring.await.unwrap().unwrap();
    sending.await.unwrap();
    assert!(!premature);
    assert!(!before.contains(&"live-prefix".into()));
    assert!(journal_ids(&journal).await.contains(&"live-prefix".into()));
    assert_eq!(f.trace_runtime_snapshot()[0].pending_records, 2);
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l256_external_single_is_persisted_while_another_batch_preparation_is_held() {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(super::super::CodexTurnJournal::new(root.path()));
    let (_root, f, _) = setup_with(Some(journal.clone()), 0);
    let first = Gate::new();
    let held = first.clone();
    *f.inner.test_codex_preparation.lock().unwrap() = Some(Arc::new(move |rows| {
        let held = held.clone();
        Box::pin(async move {
            if rows.iter().any(|row| row.event_id == "batch-prefix") {
                held.hold().await;
            }
            Ok(())
        })
    }));
    let out = f.clone();
    let batch = tokio::spawn(async move {
        out.send_batch(vec![durable("batch", "batch-prefix", false)], None)
            .await
    });
    assert!(first.entered().await);
    let out = f.clone();
    let mut single = tokio::spawn(async move {
        out.send(durable("single", "single-prefix", false), None)
            .await
    });
    let outcome = tokio::time::timeout(Duration::from_secs(5), &mut single).await;
    let independent = outcome.is_ok();
    if let Ok(result) = outcome {
        result.unwrap().unwrap();
    }
    let ids = journal_ids(&journal).await;
    first.release();
    batch.await.unwrap().unwrap();
    if !independent {
        single.await.unwrap().unwrap();
    }
    assert!(independent);
    assert!(ids.contains(&"single-prefix".into()));
    assert!(!ids.contains(&"batch-prefix".into()));
    assert_eq!(f.trace_runtime_snapshot()[0].pending_records, 2);
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l281_original_one_second_idle_tick_keeps_prefix_during_real_append_preparation() {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(super::super::CodexTurnJournal::new(root.path()));
    let (_root, f, capture) = setup_with(Some(journal.clone()), 1000);
    let mut prefix = entry_to_object(&durable("turn", "prefix", false));
    prefix.insert(
        "gen_ai.step.id".into(),
        Value::String("original-step".into()),
    );
    prefix.insert("gen_ai.usage.input_tokens".into(), Value::from(11));
    let prefix = entry_from_map(prefix);
    f.send(prefix.clone(), None).await.unwrap();
    let first = Gate::new();
    let held = first.clone();
    *f.inner.test_codex_preparation.lock().unwrap() = Some(Arc::new(move |_| {
        let held = held.clone();
        Box::pin(async move {
            held.hold().await;
            Ok(())
        })
    }));
    let out = f.clone();
    let terminal = durable("turn", "terminal", true);
    let sent = terminal.clone();
    let sending = tokio::spawn(async move { out.send(sent, None).await });
    assert!(first.entered().await);
    tokio::time::sleep(Duration::from_secs(2)).await;
    f.tick_idle().await;
    let pending = f.trace_runtime_snapshot()[0].pending_records;
    first.release();
    sending.await.unwrap().unwrap();
    f.flush().await.unwrap();
    assert_eq!(pending, 1);
    let calls = capture.calls();
    assert_eq!(calls.len(), 1);
    let objects: Vec<_> = calls[0].iter().map(entry_to_object).collect();
    assert_eq!(
        objects,
        vec![entry_to_object(&prefix), entry_to_object(&terminal)]
    );
    assert!(journal.is_acknowledged(&prefix).await.unwrap());
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l142_all_three_capacity_modes_recover_exact_prefix_tokens_and_ack_with_original_soft65(
) {
    for mode in ["single", "batch", "batch-restored"] {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(super::super::CodexTurnJournal::new(root.path()));
        let (_root, f, capture) = setup_with(Some(journal.clone()), 0);
        let mut prefix = entry_to_object(&durable("turn-0", "prefix", false));
        prefix.extend(
            serde_json::json!({"gen_ai.step.id":"step-1","gen_ai.response.id":"response-1",
            "gen_ai.usage.input_tokens":11,"gen_ai.usage.output_tokens":7})
            .as_object()
            .unwrap()
            .clone(),
        );
        let prefix = entry_from_map(prefix);
        f.send(prefix.clone(), None).await.unwrap();
        for i in 1..65 {
            f.send(
                durable(&format!("turn-{i}"), &format!("prefix-{i}"), false),
                None,
            )
            .await
            .unwrap();
        }
        assert_eq!(f.trace_runtime_snapshot()[0].pending_buffers, 65);
        assert!(capture.calls().is_empty());
        assert!(!journal.is_acknowledged(&prefix).await.unwrap());
        if mode == "batch-restored" {
            f.send(durable("turn-65", "prefix-65", false), None)
                .await
                .unwrap();
        }
        let terminal = durable("turn-0", "terminal", true);
        if mode == "single" {
            f.send(terminal.clone(), None).await.unwrap();
        } else {
            let count = if mode == "batch-restored" { 65 } else { 1 };
            let mut rows: Vec<_> = (0..count)
                .map(|i| durable(&format!("new-turn-{i}"), &format!("new-prefix-{i}"), false))
                .collect();
            rows.push(terminal.clone());
            f.send_batch(rows, None).await.unwrap();
        }
        f.flush().await.unwrap();
        let calls = capture.calls();
        assert_eq!(calls.len(), 1, "{mode}");
        let objects: Vec<_> = calls[0].iter().map(entry_to_object).collect();
        assert_eq!(
            objects,
            vec![entry_to_object(&prefix), entry_to_object(&terminal)],
            "{mode}"
        );
        let tokens: u64 = objects
            .iter()
            .map(|row| {
                row.get("gen_ai.usage.input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    + row
                        .get("gen_ai.usage.output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
            })
            .sum();
        assert_eq!(tokens, 18);
        assert!(f.trace_runtime_snapshot()[0].pending_buffers <= 64);
        assert!(journal.is_acknowledged(&prefix).await.unwrap());
        f.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn soft65_resident_prefix_survives_real_append_io_failure_and_fresh_restart_before_terminal()
{
    for restart in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pending");
        let backup = root.path().join("held-pending");
        let journal = Arc::new(super::super::CodexTurnJournal::new(&path));
        let (_root, f, capture) = setup_with(Some(journal.clone()), 0);
        let mut prefix = entry_to_object(&durable("turn-0", "prefix", false));
        prefix.extend(
            serde_json::json!({"gen_ai.step.id":"step-1","gen_ai.response.id":"response-1",
            "gen_ai.usage.input_tokens":11,"gen_ai.usage.output_tokens":7})
            .as_object()
            .unwrap()
            .clone(),
        );
        let prefix = entry_from_map(prefix);
        f.send(prefix.clone(), None).await.unwrap();
        for i in 1..65 {
            f.send(
                durable(&format!("turn-{i}"), &format!("prefix-{i}"), false),
                None,
            )
            .await
            .unwrap();
        }
        let resident_before = f
            .inner
            .state
            .lock()
            .unwrap()
            .buffers
            .contains_key(&resolve_group_key(&prefix).2);
        // Real journal parent I/O failure after65 successful durable admissions.
        std::fs::rename(&path, &backup).unwrap();
        std::fs::write(&path, b"not a directory").unwrap();
        let failed = f
            .send(durable("turn-0", "failed-continuation", false), None)
            .await;
        let resident_after = f
            .inner
            .state
            .lock()
            .unwrap()
            .buffers
            .contains_key(&resolve_group_key(&prefix).2);
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        assert!(failed.is_err());
        assert!(
            resident_before,
            "65th single must leave oldest incoming prefix resident"
        );
        assert!(
            resident_after,
            "failed durable append must not evict its resident prefix"
        );
        assert_eq!(f.trace_runtime_snapshot()[0].pending_buffers, 65);
        assert!(capture.calls().is_empty());
        assert!(!journal.is_acknowledged(&prefix).await.unwrap());
        let (f, capture, journal, _fresh_root) = if restart {
            f.shutdown().await.unwrap();
            drop(f);
            let fresh = Arc::new(super::super::CodexTurnJournal::new(&path));
            let (fresh_root, f, capture) = setup_with(Some(fresh.clone()), 0);
            (f, capture, fresh, Some(fresh_root))
        } else {
            (f, capture, journal, None)
        };
        let terminal = durable("turn-0", "terminal", true);
        f.send(terminal.clone(), None).await.unwrap();
        f.flush().await.unwrap();
        let calls = capture.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].iter().map(entry_to_object).collect::<Vec<_>>(),
            vec![entry_to_object(&prefix), entry_to_object(&terminal)]
        );
        assert!(journal.is_acknowledged(&prefix).await.unwrap());
        f.shutdown().await.unwrap();
    }
}

struct WireConverter;
impl EventLogConverter for WireConverter {
    fn convert(
        &self,
        rows: &[AgentActivityEntry],
        _: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        let span = ReadableSpan::minimal(
            rows[0].turn_id.as_deref().unwrap(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbb",
        );
        Ok(ConvertResult {
            spans: vec![span],
            span_count: 1,
            ..ConvertResult::default()
        })
    }
}
struct GatedExporter {
    gate: Arc<Gate>,
}
#[async_trait]
impl TraceExporter for GatedExporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        if spans[0].name == "first" {
            self.gate.hold().await;
        }
        Ok(())
    }
    async fn shutdown(&self) {}
}
fn collector_fixture(
    journal: Option<Arc<super::super::CodexTurnJournal>>,
) -> (
    tempfile::TempDir,
    Arc<OtlpTraceFlusher>,
    Arc<crate::core::InputManager>,
    Arc<Gate>,
) {
    let root = tempfile::tempdir().unwrap();
    let cfg = serde_json::from_value(serde_json::json!({"enabled":true,"serviceName":"test",
        "protocol":"http/protobuf","dataDir":root.path(),"turnIdleTimeoutMs":0,
        "endpoints":[{"name":"primary","endpoint":"http://unused:4318"}]}))
    .unwrap();
    let gate = Gate::new();
    let exporter = Arc::new(GatedExporter { gate: gate.clone() });
    let mut f = OtlpTraceFlusher::with_parts(
        cfg,
        None,
        Some(Arc::new(move |_| exporter.clone())),
        Some(Arc::new(WireConverter)),
    )
    .unwrap();
    if let Some(journal) = journal {
        f = f.with_codex_journal(journal, Ok);
    }
    let f = Arc::new(f);
    let manager = Arc::new(crate::core::InputManager::new());
    manager.set_flusher(Arc::new(super::super::MultiFlusher::new(vec![f.clone()])));
    (root, f, manager, gate)
}
#[tokio::test]
async fn collector_preemption_returns_with_owned_export_and_shutdown_joins_through_real_manager_and_multi(
) {
    let (_root, f, manager, gate) = collector_fixture(None);
    let ordinary = |turn| {
        let mut object = entry_to_object(&row(turn, false));
        object.insert("gen_ai.agent.type".into(), Value::from("claude-code"));
        object.insert("gen_ai.session.id".into(), Value::from("session"));
        entry_from_map(object)
    };
    manager
        .flush_prepared_entries(vec![ordinary("first")])
        .await
        .unwrap();
    let out = manager.clone();
    let next = ordinary("next");
    let mut pending = tokio::spawn(async move { out.flush_prepared_entries(vec![next]).await });
    assert!(gate.entered().await);
    let result = tokio::time::timeout(Duration::from_secs(5), &mut pending).await;
    let returned = result.is_ok();
    if let Ok(result) = result {
        result.unwrap().unwrap();
    }
    let blocked = f.trace_runtime_snapshot();
    let closing = f.clone();
    let shutdown = tokio::spawn(async move { closing.shutdown().await });
    tokio::task::yield_now().await;
    let joined_too_early = shutdown.is_finished();
    gate.release();
    if !returned {
        pending.await.unwrap().unwrap();
    }
    shutdown.await.unwrap().unwrap();
    assert!(
        returned,
        "actual collector must return while its ordinary predecessor export is held"
    );
    assert!(
        !joined_too_early,
        "shutdown must still join accepted owned exports"
    );
    assert_eq!(blocked[0].pending_buffers, 1);
    assert_eq!(blocked[0].removed_buffers_total, 1);
    assert_eq!(f.trace_runtime_snapshot()[0].pending_buffers, 0);
}
#[tokio::test]
async fn collector_terminal_batch_waits_for_real_export_and_keeps_unacknowledged_journal_on_cancel()
{
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("pending");
    let journal = Arc::new(super::super::CodexTurnJournal::new(&path));
    let (_root, f, manager, gate) = collector_fixture(Some(journal.clone()));
    let terminal = durable("first", "first", true);
    let out = manager.clone();
    let sent = terminal.clone();
    let pending = tokio::spawn(async move { out.flush_prepared_entries(vec![sent]).await });
    assert!(gate.entered().await);
    assert!(!pending.is_finished());
    assert!(!journal.is_acknowledged(&terminal).await.unwrap());
    assert!(journal_ids(&journal).await.contains(&"first".into()));
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert!(!journal.is_acknowledged(&terminal).await.unwrap());
    drop(manager);
    drop(f);
    // Fresh flusher+fresh journal actually replay the canceled terminal.
    let fresh = Arc::new(super::super::CodexTurnJournal::new(&path));
    let (_root, replay, manager, release) = collector_fixture(Some(fresh.clone()));
    release.release();
    replay.start().await.unwrap();
    assert!(fresh.is_acknowledged(&terminal).await.unwrap());
    assert!(journal_ids(&fresh).await.is_empty());
    drop(manager);
    replay.shutdown().await.unwrap();
}
#[tokio::test]
async fn ordinary_owned_export_last_flusher_drop_closes_real_loopback_request_with_idle_enabled() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut block = [0_u8; 1024];
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            let size = socket.read(&mut block).await.unwrap();
            assert_ne!(size, 0);
            bytes.extend_from_slice(&block[..size]);
        }
        entered.send(()).unwrap();
        loop {
            if socket.read(&mut block).await.unwrap() == 0 {
                break;
            }
        }
    });
    let root = tempfile::tempdir().unwrap();
    let cfg = serde_json::from_value(serde_json::json!({"enabled":true,"serviceName":"test",
        "protocol":"http/protobuf","dataDir":root.path(),"turnIdleTimeoutMs":1000,
        "endpoints":[{"name":"loopback","endpoint":format!("http://{address}")}]}))
    .unwrap();
    let f = Arc::new(
        OtlpTraceFlusher::with_parts(cfg, None, None, Some(Arc::new(WireConverter))).unwrap(),
    );
    let ordinary = |turn| {
        let mut fields = entry_to_object(&row(turn, false));
        fields.insert("gen_ai.agent.type".into(), Value::from("claude-code"));
        fields.insert("gen_ai.session.id".into(), Value::from("session"));
        entry_from_map(fields)
    };
    f.send(ordinary("first"), None).await.unwrap();
    let out = f.clone();
    let next = ordinary("next");
    let mut sending = tokio::spawn(async move { out.send(next, None).await });
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut sending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(f.trace_runtime_snapshot()[0].pending_buffers, 1);
    assert!(!peer.is_finished());
    let inner = Arc::downgrade(&f.inner);
    drop(f);
    tokio::time::timeout(Duration::from_secs(5),peer).await
        .expect("last owner Drop must abort the real HTTP request, not retain Inner through its worker/idle handles").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while inner.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
struct FailedExporter;
#[async_trait]
impl TraceExporter for FailedExporter {
    async fn export(&self, _: Vec<ReadableSpan>) -> Result<(), String> {
        Err("synthetic ordinary endpoint failure".into())
    }
    async fn shutdown(&self) {}
}
#[tokio::test]
async fn ordinary_owned_export_failure_keeps_original_failed_log_and_endpoint_counters_visible() {
    let root = tempfile::tempdir().unwrap();
    let cfg = serde_json::from_value(serde_json::json!({"enabled":true,"serviceName":"test",
        "protocol":"http/protobuf","dataDir":root.path(),"turnIdleTimeoutMs":0,
        "endpoints":[{"name":"primary","endpoint":"http://unused:4318"}]}))
    .unwrap();
    let f = OtlpTraceFlusher::with_parts(
        cfg,
        None,
        Some(Arc::new(|_| Arc::new(FailedExporter))),
        Some(Arc::new(WireConverter)),
    )
    .unwrap();
    for turn in ["first", "next"] {
        let mut fields = entry_to_object(&row(turn, false));
        fields.insert("gen_ai.agent.type".into(), Value::from("claude-code"));
        fields.insert("gen_ai.session.id".into(), Value::from("session"));
        f.send(entry_from_map(fields), None).await.unwrap();
    }
    f.flush().await.unwrap();
    let files: Vec<_> = std::fs::read_dir(root.path().join("logs/otlp-failed"))
        .unwrap()
        .map(|item| item.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    let lines = std::fs::read_to_string(&files[0]).unwrap();
    let rows: Vec<Value> = lines
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    let names: std::collections::HashSet<_> = rows
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, std::collections::HashSet::from(["first", "next"]));
    for row in rows {
        assert_eq!(
            row["_error"]["message"],
            "synthetic ordinary endpoint failure"
        );
    }
    assert_eq!(f.endpoint_counters()["primary"].out_failed, 2);
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancelling_shutdown_wait_keeps_previously_accepted_ordinary_worker_owned_until_retry() {
    let (_root, f, manager, gate) = collector_fixture(None);
    let ordinary = |turn| {
        let mut fields = entry_to_object(&row(turn, false));
        fields.insert("gen_ai.agent.type".into(), Value::from("claude-code"));
        fields.insert("gen_ai.session.id".into(), Value::from("session"));
        entry_from_map(fields)
    };
    manager
        .flush_prepared_entries(vec![ordinary("first")])
        .await
        .unwrap();
    manager
        .flush_prepared_entries(vec![ordinary("next")])
        .await
        .unwrap();
    assert!(gate.entered().await);
    let out = f.clone();
    let closing = tokio::spawn(async move { out.shutdown().await });
    tokio::task::yield_now().await;
    assert!(!closing.is_finished());
    closing.abort();
    assert!(closing.await.unwrap_err().is_cancelled());
    assert_eq!(f.ordinary_flushes.tasks.lock().unwrap().len(), 2);
    gate.release();
    f.shutdown().await.unwrap();
    assert!(f.ordinary_flushes.tasks.lock().unwrap().is_empty());
    assert_eq!(f.endpoint_counters()["primary"].out_spans, 2);
}

#[tokio::test]
async fn ordinary_owned_export_supports_concurrent_flush_and_shutdown_waiters() {
    let (_root, f, _manager, gate) = collector_fixture(None);
    let mut fields = entry_to_object(&row("first", true));
    fields.insert("gen_ai.agent.type".into(), Value::from("claude-code"));
    f.send(entry_from_map(fields), None).await.unwrap();
    assert!(gate.entered().await);
    let out = f.clone();
    let (started, wait) = tokio::sync::oneshot::channel();
    let mut flushing = tokio::spawn(async move {
        let _ = started.send(());
        out.flush().await
    });
    wait.await.unwrap();
    tokio::task::yield_now().await;
    let out = f.clone();
    let (started, wait) = tokio::sync::oneshot::channel();
    let mut stopping = tokio::spawn(async move {
        let _ = started.send(());
        out.shutdown().await
    });
    wait.await.unwrap();
    tokio::task::yield_now().await;
    assert!(!flushing.is_finished());
    assert!(!stopping.is_finished());
    gate.release();
    let flushed = tokio::time::timeout(Duration::from_secs(5), &mut flushing).await;
    let stopped = tokio::time::timeout(Duration::from_secs(5), &mut stopping).await;
    if flushed.is_err() {
        flushing.abort();
    }
    if stopped.is_err() {
        stopping.abort();
    }
    flushed
        .expect("flush join waiter must not be overwritten")
        .unwrap()
        .unwrap();
    stopped
        .expect("shutdown join waiter must not be overwritten")
        .unwrap()
        .unwrap();
}
