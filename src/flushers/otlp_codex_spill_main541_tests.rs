use super::super::CodexTurnJournal;
use super::*;
fn record(id: &str, bytes: usize, terminal: bool, turn: &str) -> AgentActivityEntry {
    let mut row = serde_json::json!({
        "event.name": if terminal {"other"} else {"llm.request"},
        "event.id": id, "user.id":"owner","gen_ai.agent.type":"codex",
        "gen_ai.session.id":"session","gen_ai.turn.id":turn,
        "gen_ai.input.messages":"x".repeat(bytes)
    });
    if terminal {
        row["gen_ai.turn.end"] = Value::Bool(true);
        row["agent.codex.turn_status"] = Value::String("completed".into());
    }
    serde_json::from_value(row).unwrap()
}
fn plain_flusher(root: &std::path::Path, journal: Arc<CodexTurnJournal>) -> OtlpTraceFlusher {
    let cfg = serde_json::from_value(serde_json::json!({
        "enabled":true,"serviceName":"spill-fixture","protocol":"http/protobuf",
        "endpoints":[{"name":"test","endpoint":"http://unused:4318","headers":{}}],
        "dataDir":root,"turnIdleTimeoutMs":0
    }))
    .unwrap();
    OtlpTraceFlusher::new(cfg)
        .unwrap()
        .with_codex_journal(journal, Ok)
}

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[derive(Default)]
struct Capture {
    calls: Mutex<Vec<Vec<String>>>,
    fail: AtomicBool,
    block_first: AtomicBool,
    ready: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl Capture {
    fn ids(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}
fn setup(
    root: &std::path::Path,
    journal: Arc<CodexTurnJournal>,
) -> (Arc<OtlpTraceFlusher>, Arc<Capture>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let prepare_calls = calls.clone();
    let f = plain_flusher(root, journal.clone()).with_codex_journal(journal, move |rows| {
        if !rows.is_empty() {
            prepare_calls.fetch_add(1, Ordering::SeqCst);
        }
        Ok(rows)
    });
    let capture = Arc::new(Capture::default());
    let captured = capture.clone();
    *f.inner.test_codex_export.lock().unwrap() = Some(Arc::new(move |rows| {
        let captured = captured.clone();
        Box::pin(async move {
            captured
                .calls
                .lock()
                .unwrap()
                .push(rows.iter().map(|e| e.event_id.clone()).collect());
            if captured.block_first.swap(false, Ordering::SeqCst) {
                captured.ready.notify_one();
                captured.release.notified().await;
            }
            !captured.fail.load(Ordering::SeqCst)
        })
    }));
    (Arc::new(f), capture, calls)
}
fn journal(root: &std::path::Path) -> Arc<CodexTurnJournal> {
    Arc::new(CodexTurnJournal::new(root.join("journal")))
}
fn ids(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn main_l36_live_long_turn_spills_only_durable_payload_before_terminal() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = journal(root.path());
        let (f, capture, _) = setup(root.path(), journal.clone());
        let prefix = record("prefix", 9 * 1024 * 1024, false, "turn");
        f.send(prefix.clone(), Some(1.0)).await.unwrap();
        f.send(record("tool-result", 0, false, "turn"), None)
            .await
            .unwrap();
        {
            let state = f.inner.state.lock().unwrap();
            assert!(
                state.buffers.values().next().unwrap().records.is_empty(),
                "already durable >8MiB Codex payload must leave the resident buffer"
            );
        }
        let snapshot = &f.trace_runtime_snapshot()[0];
        assert_eq!(snapshot.pending_records, 2);
        assert_eq!(snapshot.pending_unmeasured_records, 0);
        assert_eq!(snapshot.resident_records, Some(0));
        assert_eq!(snapshot.resident_payload_bytes, Some(0));
        assert_eq!(snapshot.spilled_buffers, Some(1));
        assert_eq!(snapshot.spilled_records, Some(2));
        assert_eq!(snapshot.largest_buffer_records, 2);
        f.flush().await.unwrap();
        assert!(capture.ids().is_empty());
        assert!(!journal.is_acknowledged(&prefix).await.unwrap());
        f.send(record("terminal", 0, true, "turn"), None)
            .await
            .unwrap();
        f.flush().await.unwrap();
        assert_eq!(capture.ids(), [ids(&["prefix", "tool-result", "terminal"])]);
        assert!(journal.is_acknowledged(&prefix).await.unwrap());
        let empty = &f.trace_runtime_snapshot()[0];
        assert_eq!(empty.resident_records, Some(0));
        assert_eq!(empty.spilled_records, Some(0));
        f.shutdown().await.unwrap();
    })
    .await
    .expect("original main 15s test budget");
}

#[tokio::test]
async fn main_l55_bounded_restore_measures_payload_and_survives_two_pending_restarts() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let prefix = record("prefix", 3 * 1024 * 1024, false, "turn");
        journal(root.path())
            .append(&[
                prefix.clone(),
                record("second", 3 * 1024 * 1024, false, "turn"),
                record("third", 3 * 1024 * 1024, false, "turn"),
            ])
            .await
            .unwrap();
        for _ in 0..2 {
            let (f, capture, _) = setup(root.path(), journal(root.path()));
            f.start().await.unwrap();
            let row = &f.trace_runtime_snapshot()[0];
            assert_eq!(row.pending_records, 3);
            assert_eq!(row.pending_unmeasured_records, 0);
            assert_eq!(row.resident_records, Some(0));
            assert_eq!(row.spilled_records, Some(3));
            assert!(row.pending_logical_bytes > 9.0 * 1024.0 * 1024.0);
            f.shutdown().await.unwrap();
            assert!(capture.ids().is_empty());
        }
        let durable = journal(root.path());
        let (f, capture, _) = setup(root.path(), durable.clone());
        f.send(record("terminal", 0, true, "turn"), None)
            .await
            .unwrap();
        f.flush().await.unwrap();
        assert_eq!(
            capture.ids(),
            [ids(&["prefix", "second", "third", "terminal"])]
        );
        assert!(durable.is_acknowledged(&prefix).await.unwrap());
        f.shutdown().await.unwrap();
    })
    .await
    .expect("original main 15s test budget");
}

#[tokio::test]
async fn main_l75_terminal_in_middle_batch_cannot_truncate_later_records() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = journal(root.path());
        journal
            .append(&[
                record("prefix", 9 * 1024 * 1024, false, "turn"),
                record("terminal", 0, true, "turn"),
                record("late-tool", 2 * 1024 * 1024, false, "turn"),
            ])
            .await
            .unwrap();
        let (f, capture, _) = setup(root.path(), journal);
        f.start().await.unwrap();
        assert_eq!(capture.ids(), [ids(&["prefix", "terminal", "late-tool"])]);
        f.shutdown().await.unwrap();
    })
    .await
    .expect("original main 15s test budget");
}

#[tokio::test]
async fn main_l85_total_resident_budget_and_failed_export_remain_replayable() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = journal(root.path());
        let (f, capture, _) = setup(root.path(), journal.clone());
        capture.fail.store(true, Ordering::SeqCst);
        for i in 0..10 {
            f.send(
                record(
                    &format!("prefix-{i}"),
                    4 * 1024 * 1024,
                    false,
                    &format!("turn-{i}"),
                ),
                None,
            )
            .await
            .unwrap();
        }
        let row = &f.trace_runtime_snapshot()[0];
        assert!(row.resident_payload_bytes.unwrap() <= 32 * 1024 * 1024);
        assert_eq!(row.pending_records, 10);
        assert!(capture.ids().is_empty());
        f.send(record("terminal", 0, true, "turn-0"), None)
            .await
            .unwrap();
        f.flush().await.unwrap();
        assert!(!journal
            .is_acknowledged(&record("prefix-0", 0, false, "turn-0"))
            .await
            .unwrap());
        let (retry, retried, _) = setup(root.path(), journal.clone());
        retry.start().await.unwrap();
        assert_eq!(retried.ids(), [ids(&["prefix-0", "terminal"])]);
        assert!(journal
            .is_acknowledged(&record("prefix-0", 0, false, "turn-0"))
            .await
            .unwrap());
        f.shutdown().await.unwrap();
        retry.shutdown().await.unwrap();
    })
    .await
    .expect("original main 15s test budget");
}

#[tokio::test]
async fn main_l101_rehydrates_only_one_large_turn_through_a_blocked_export() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = journal(root.path());
        let (f, capture, prepare) = setup(root.path(), journal);
        f.send(record("a", 9 * 1024 * 1024, false, "a"), None)
            .await
            .unwrap();
        f.send(record("b", 9 * 1024 * 1024, false, "b"), None)
            .await
            .unwrap();
        let before = prepare.load(Ordering::SeqCst);
        capture.block_first.store(true, Ordering::SeqCst);
        let ending = f.clone();
        let task = tokio::spawn(async move {
            ending
                .send_batch(
                    vec![record("end-a", 0, true, "a"), record("end-b", 0, true, "b")],
                    None,
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(10), capture.ready.notified())
            .await
            .unwrap();
        let first = prepare.load(Ordering::SeqCst) - before;
        assert_eq!(
            first, 4,
            "one turn: two raw batches in each of two policy passes"
        );
        assert_eq!(capture.ids().len(), 1);
        capture.release.notify_one();
        tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(prepare.load(Ordering::SeqCst) - before, 8);
        assert_eq!(capture.ids(), [ids(&["a", "end-a"]), ids(&["b", "end-b"])]);
        f.shutdown().await.unwrap();
    })
    .await
    .expect("original main 15s test budget");
}

#[tokio::test]
async fn main_l125_unpersistable_continuation_precedes_persisted_future_terminal() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let (f, capture, _) = setup(root.path(), journal(root.path()));
        f.send(record("prefix", 9 * 1024 * 1024, false, "turn"), None)
            .await
            .unwrap();
        let mut invalid = record("temporary", 0, false, "turn");
        invalid.event_id.clear();
        f.send_batch(vec![invalid, record("terminal", 0, true, "turn")], None)
            .await
            .unwrap();
        assert_eq!(capture.ids(), [ids(&["prefix", "", "terminal"])]);
        f.shutdown().await.unwrap();
    })
    .await
    .expect("original main 15s test budget");
}

#[tokio::test]
async fn spill_gauges_are_omitted_without_codex_journal_and_for_other_agents() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let f = plain_flusher(root.path(), journal(root.path()));
        let mut claude = record("claude", 0, false, "claude");
        claude.agent_type = "claude-code".into();
        f.send(claude, None).await.unwrap();
        assert_eq!(f.trace_runtime_snapshot()[0].resident_records, None);
        let plain = OtlpTraceFlusher::new(f.inner.cfg.clone()).unwrap();
        plain
            .send(record("codex", 0, false, "plain"), None)
            .await
            .unwrap();
        let row = &plain.trace_runtime_snapshot()[0];
        assert_eq!(row.resident_records, None);
        assert_eq!(row.resident_payload_bytes, None);
        assert_eq!(row.spilled_buffers, None);
        assert_eq!(row.spilled_records, None);
    })
    .await
    .expect("original main 15s test budget");
}
