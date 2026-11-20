use super::*;
use crate::checkpoints::InputState;

fn settings() -> Delivery {
    Delivery {
        max_events_per_batch: 8,
        max_event_bytes: 1024,
        max_batch_bytes: 4096,
        queue_disk_bytes: 8192,
        queue_memory_bytes: 4096,
        flush_interval_ms: 1,
        retry_initial_ms: 1,
        retry_max_ms: 4,
        retry_alarm_after_ms: 1,
        ..Delivery::default()
    }
}

impl Outbox {
    async fn accept_fixture(
        &self,
        source: &str,
        store: &StateStore,
        rows: &[Vec<u8>],
        cancelled: &AtomicBool,
    ) -> anyhow::Result<()> {
        let entries: Vec<AgentActivityEntry> = rows
            .iter()
            .filter_map(|row| serde_json::from_slice(row).ok())
            .collect();
        self.accept(source, store, rows, &usage_updates(&entries), cancelled)
            .await
    }
}

#[test]
fn checkpoint_save_only_rewrites_when_source_progress_changes() {
    let dir = tempfile::tempdir().unwrap();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let progress = r#"{"qoder-trace":{"lastOffset":97}}"#;
    queue.checkpoint("source", progress).unwrap();
    let changes = queue.db.lock().unwrap().total_changes();

    queue.checkpoint("source", progress).unwrap();
    assert_eq!(queue.db.lock().unwrap().total_changes(), changes);

    let advanced = r#"{"qoder-trace":{"lastOffset":101}}"#;
    queue.checkpoint("source", advanced).unwrap();
    assert_eq!(queue.db.lock().unwrap().total_changes(), changes + 1);
    assert_eq!(
        queue.saved_checkpoints().unwrap(),
        vec![("source".into(), advanced.into())]
    );
}

#[tokio::test]
async fn isolated_source_reuses_committed_progress_and_writes_later_cursor_only_cycles() {
    let dir = tempfile::tempdir().unwrap();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let store = Arc::new(StateStore::new_sdk_source(dir.path().join("state.json")));
    let writes = Arc::new(AtomicU64::new(0));
    let journal = queue.clone();
    let observed_writes = writes.clone();
    store.set_write_hook(move |_, text| {
        let journal = journal.clone();
        let observed_writes = observed_writes.clone();
        async move {
            observed_writes.fetch_add(1, Ordering::Relaxed);
            journal.checkpoint("source", &text)
        }
    });
    let key = "codex-transcript:fixture";
    let hold = store.begin_output_for(key);
    store.set_offset(key, 42.0);
    let payload = br#"{"event.id":"one"}"#.to_vec();
    queue
        .accept_fixture("source", &store, &[payload], &AtomicBool::new(false))
        .await
        .unwrap();
    hold.finish(Ok(()));
    store.save_for(key).await.unwrap();
    assert!(store.is_persisted(key, None));
    assert_eq!(writes.load(Ordering::Relaxed), 0);

    let hold = store.begin_output_for(key);
    store.set_offset(key, 56.0);
    assert!(!store.is_persisted(key, None));
    hold.finish(Ok(()));
    store.save_for(key).await.unwrap();
    assert_eq!(writes.load(Ordering::Relaxed), 1);
    let text = Outbox::read_persisted_checkpoint(dir.path(), "source")
        .unwrap()
        .unwrap();
    let recovered = StateStore::new(dir.path().join("recovered.json"));
    recovered.load_checkpoint_text(&text).unwrap();
    assert_eq!(recovered.get_offset(key), 56.0);
    assert_eq!(queue.read_batch(&settings()).unwrap().0.len(), 1);
}

#[tokio::test]
async fn partial_batch_waits_until_due_and_handles_clock_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let options = Delivery {
        flush_interval_ms: 60_000,
        ..settings()
    };
    let queue = Outbox::open(dir.path(), options.clone()).unwrap();
    let store = StateStore::new(dir.path().join("state"));
    let row = br#"{"event.id":"one"}"#.to_vec();
    queue
        .accept_fixture(
            "source",
            &store,
            std::slice::from_ref(&row),
            &AtomicBool::new(false),
        )
        .await
        .unwrap();

    let (pending, wait) = queue.delivery_batch(&options).unwrap();
    assert!(pending.is_empty() && !wait.is_zero());

    queue
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE event SET created=?1",
            [chrono::Utc::now().timestamp_millis() + 60_000],
        )
        .unwrap();
    let (ready, wait) = queue.delivery_batch(&options).unwrap();
    assert!(wait.is_zero());
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].1, row);
}

#[tokio::test]
async fn transaction_recovers_original_bytes_and_checkpoint_without_json_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input-state.json");
    let store = StateStore::new(&path);
    store.set("qoder-trace", InputState::new().with_last_offset(97.0));
    let original =
        br#"{"event.id":"original","extension":{"integer":"18446744073709551615"}}"#.to_vec();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    queue
        .accept_fixture(
            "source",
            &store,
            std::slice::from_ref(&original),
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
    assert!(!path.exists());
    let text = Outbox::read_persisted_checkpoint(dir.path(), "source")
        .unwrap()
        .unwrap();
    let committed = StateStore::new(&path);
    committed.load_checkpoint_text(&text).unwrap();
    assert_eq!(committed.get_offset("qoder-trace"), 97.0);
    drop(queue);
    let recovered = Outbox::open(dir.path(), settings()).unwrap();
    recovered.restore("source", &path).unwrap();
    let loaded = StateStore::new(&path);
    loaded.load().await;
    assert_eq!(loaded.get_offset("qoder-trace"), 97.0);
    let (rows, _) = recovered.read_batch(&settings()).unwrap();
    assert_eq!(rows[0].1, original);
    recovered.ack(&rows).unwrap();
    drop(recovered);
    let recovered = Outbox::open(dir.path(), settings()).unwrap();
    std::fs::remove_file(&path).unwrap();
    recovered.restore("source", &path).unwrap();
    let loaded = StateStore::new(&path);
    loaded.load().await;
    assert_eq!(loaded.get_offset("qoder-trace"), 97.0);
    assert_eq!(recovered.pending_bytes().unwrap(), 0);
}

struct Receiver {
    calls: AtomicU64,
    reply: i32,
    seen: Mutex<Vec<Vec<Vec<u8>>>>,
}
unsafe extern "C" fn receive(
    context: *mut std::ffi::c_void,
    views: *const PilotJsonView,
    count: usize,
) -> i32 {
    // SAFETY: test owns receiver until delivery thread joins; views are borrowed.
    let receiver = unsafe { &*(context as *const Receiver) };
    let rows = unsafe { std::slice::from_raw_parts(views, count) }
        .iter()
        .map(|view| unsafe { std::slice::from_raw_parts(view.data, view.len) }.to_vec())
        .collect();
    receiver.seen.lock().unwrap().push(rows);
    let call = receiver.calls.fetch_add(1, Ordering::SeqCst);
    if call == 0 {
        super::super::abi::RETRY
    } else {
        receiver.reply
    }
}
fn deliver_for(queue: Arc<Outbox>, receiver: &Receiver) {
    let context = receiver as *const _ as usize;
    let worker = queue.clone();
    let thread = std::thread::spawn(move || worker.deliver(receive, context));
    let until = Instant::now() + Duration::from_secs(2);
    while receiver.calls.load(Ordering::SeqCst) < 2 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
    queue.stopping.store(true, Ordering::SeqCst);
    queue.wake();
    thread.join().unwrap();
}
#[tokio::test]
async fn retry_and_ack_loss_keep_original_bytes_and_event_ids() {
    let dir = tempfile::tempdir().unwrap();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let store = StateStore::new(dir.path().join("state"));
    let original = vec![
        br#"{"event.id":"one"}"#.to_vec(),
        br#"{"event.id":"two","unknown":[1,false,null]}"#.to_vec(),
    ];
    queue
        .accept_fixture("source", &store, &original, &AtomicBool::new(false))
        .await
        .unwrap();
    // A real SQLite write failure models ACK received before its durable removal.
    queue
        .db
        .lock()
        .unwrap()
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    let receiver = Receiver {
        calls: AtomicU64::new(0),
        reply: ACK,
        seen: Mutex::new(Vec::new()),
    };
    deliver_for(queue.clone(), &receiver);
    assert!(receiver.calls.load(Ordering::SeqCst) >= 2);
    assert!(receiver
        .seen
        .lock()
        .unwrap()
        .iter()
        .all(|batch| batch == &original));
    assert!(queue.pending_bytes().unwrap() > 0);
    drop(queue);
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let receiver = Receiver {
        calls: AtomicU64::new(0),
        reply: ACK,
        seen: Mutex::new(Vec::new()),
    };
    deliver_for(queue.clone(), &receiver);
    assert_eq!(queue.pending_bytes().unwrap(), 0);
    assert!(receiver
        .seen
        .lock()
        .unwrap()
        .iter()
        .all(|batch| batch == &original));
}
#[tokio::test]
async fn capacity_update_unblocks_acceptance_without_advancing_old_durable_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let mut options = settings();
    options.queue_disk_bytes = 64;
    options.max_event_bytes = 64;
    options.max_batch_bytes = 64;
    let queue = Outbox::open(dir.path(), options.clone()).unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state")));
    store.set("input", InputState::new().with_last_offset(1.0));
    queue
        .accept_fixture("source", &store, &[vec![b'x'; 48]], &AtomicBool::new(false))
        .await
        .unwrap();
    store.set("input", InputState::new().with_last_offset(2.0));
    let q = queue.clone();
    let s = store.clone();
    let task = tokio::spawn(async move {
        q.accept_fixture("source", &s, &[vec![b'y'; 48]], &AtomicBool::new(false))
            .await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!task.is_finished());
    let text: String = queue
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT json FROM checkpoint WHERE source='source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["input"]["lastOffset"],
        1.0
    );
    options.queue_disk_bytes = 128;
    queue.update(options);
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text: String = queue
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT json FROM checkpoint WHERE source='source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["input"]["lastOffset"],
        2.0
    );
}
#[tokio::test]
async fn invalid_ack_is_retry_and_corrupt_outbox_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let store = StateStore::new(dir.path().join("state"));
    queue
        .accept_fixture(
            "source",
            &store,
            &[br#"{"event.id":"stable"}"#.to_vec()],
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
    let receiver = Receiver {
        calls: AtomicU64::new(0),
        reply: 77,
        seen: Mutex::new(Vec::new()),
    };
    deliver_for(queue.clone(), &receiver);
    assert!(queue.pending_bytes().unwrap() > 0);
    assert!(!queue.alarm_batch().is_empty());
    drop(queue);
    let corrupt = tempfile::tempdir().unwrap();
    let bytes = b"a corrupt queue must be reported";
    std::fs::write(corrupt.path().join("delivery.sqlite"), bytes).unwrap();
    assert!(Outbox::open(corrupt.path(), settings()).is_err());
    assert_eq!(
        std::fs::read(corrupt.path().join("delivery.sqlite")).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn token_totals_commit_with_progress_survive_ack_and_restart_without_counting_retry() {
    let root = tempfile::tempdir().unwrap();
    let state = StateStore::new(root.path().join("state.json"));
    let queue = Outbox::open(&root.path().join("outbox"), Delivery::default()).unwrap();
    let flusher = CallbackOutboxFlusher {
        queue: queue.clone(),
        source: "source".into(),
        store: Arc::new(state),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    flusher
        .store
        .set("qoder-trace", InputState::new().with_last_offset(97.0));
    let entry: AgentActivityEntry = serde_json::from_value(json!({
        "event.name": "llm.response",
        "event.id": "usage-original",
        "gen_ai.agent.type": "qoder",
        "time_unix_nano": "1794066484438000000",
        "gen_ai.usage.input_tokens": 64,
        "gen_ai.usage.output_tokens": 32,
        "gen_ai.usage.cache_read.input_tokens": 8,
        "extension": {"integer": "18446744073709551615"}
    }))
    .unwrap();
    let expected = serde_json::to_vec(&entry).unwrap();

    let (delivered_bytes, result) = flusher
        .deliver_owned_batch(vec![entry], Arc::new(|_, _| {}))
        .await
        .unwrap();
    result.unwrap();
    assert_eq!(delivered_bytes, expected.len() as u64);
    drop(flusher);
    assert_eq!(queue.token_rows()[0]["input_tokens_total"], 64);
    let first = queue.read_batch(&Delivery::default()).unwrap().0;
    assert_eq!(first[0].1, expected);
    let retry = queue.read_batch(&Delivery::default()).unwrap().0;
    assert_eq!(first, retry);
    assert_eq!(queue.token_rows()[0]["llm_responses_total"], 1);
    queue.ack(&first).unwrap();
    assert_eq!(queue.token_rows()[0]["output_tokens_total"], 32);
    assert!(queue.last_ack_ms.load(Ordering::SeqCst) > 0);
    drop(queue);
    let resumed = Outbox::open(&root.path().join("outbox"), Delivery::default()).unwrap();
    assert_eq!(resumed.token_rows()[0]["llm_responses_total"], 1);
    assert_eq!(resumed.token_rows()[0]["cache_read_tokens_total"], 8);
    let progress = resumed.saved_checkpoints().unwrap();
    assert_eq!(progress[0].0, "source");
    let checkpoint: serde_json::Value = serde_json::from_str(&progress[0].1).unwrap();
    assert_eq!(checkpoint["qoder-trace"]["lastOffset"], 97.0);
    assert_eq!(resumed.snapshot()["pending_events"], 0);
}

#[tokio::test]
async fn token_counter_saturates_without_rolling_back_collection_progress() {
    let root = tempfile::tempdir().unwrap();
    let state = StateStore::new(root.path().join("state.json"));
    let q = Outbox::open(&root.path().join("outbox"), Delivery::default()).unwrap();
    let row=serde_json::to_vec(&json!({"event.name":"llm.response","gen_ai.agent.type":"codex","time_unix_nano":"1794066484438000000","gen_ai.usage.input_tokens":i64::MAX})).unwrap();
    for _ in 0..2 {
        q.accept_fixture(
            "source",
            &state,
            std::slice::from_ref(&row),
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
    }
    assert_eq!(
        q.token_rows()[0]["input_tokens_total"].as_i64(),
        Some(i64::MAX)
    );
    assert_eq!(q.token_rows()[0]["llm_responses_total"], 2);
    assert_eq!(q.snapshot()["pending_events"], 2);
}

#[tokio::test]
async fn trace_gauges_use_durable_queue_counters_and_do_not_fabricate_failed_reads() {
    let root = tempfile::tempdir().unwrap();
    let store = StateStore::new(root.path().join("state.json"));
    let q = Outbox::open(&root.path().join("outbox"), Delivery::default()).unwrap();
    let bytes = b"{\"event.name\":\"other\"}".to_vec();
    q.accept_fixture(
        "source",
        &store,
        std::slice::from_ref(&bytes),
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    let row = &q.trace_rows()[0];
    assert_eq!(row["pending_records"], 1);
    assert_eq!(row["pending_logical_bytes"], bytes.len());
    assert_eq!(row["buffer_scope"], "sdk_delivery_outbox");
    assert_eq!(row["converter_available"], false);
    q.db.lock()
        .unwrap()
        .execute("DROP TABLE queue_size", [])
        .unwrap();
    let row = &q.trace_rows()[0];
    assert_eq!(row["collection_status"], "unavailable");
    assert!(row.get("pending_records").is_none());
}

#[test]
fn codex_checkpoint_rebinds_old_sdk_pending_bytes_then_admits_a_legacy_handoff() {
    let root = tempfile::tempdir().unwrap();
    let queue = Outbox::open(root.path(), settings()).unwrap();
    let old = r#"{"codex-transcript:rollout":{"lastOffset":22,"future":true}}"#;
    let pending = br#"{"event.id":"historical-codex","event.name":"llm.request"}"#;
    queue.checkpoint("previous-sdk-source", old).unwrap();
    queue.enqueue_hook(pending).unwrap();

    assert_eq!(
        queue
            .prepare_shell_checkpoint("new-source", LegacyCheckpointHandoff::Codex, || Ok(None))
            .unwrap()
            .as_deref(),
        Some(old)
    );
    let rows = queue.read_batch(&settings()).unwrap().0;
    assert_eq!(rows[0].1, pending);
    assert!(
        Outbox::mark_shell_checkpoint_exported(root.path(), LegacyCheckpointHandoff::Codex)
            .is_err()
    );
    queue.ack(&rows).unwrap();

    Outbox::mark_shell_checkpoint_exported(root.path(), LegacyCheckpointHandoff::Codex).unwrap();
    assert!(queue
        .prepare_shell_checkpoint(
            "new-source",
            LegacyCheckpointHandoff::Codex,
            || anyhow::bail!("corrupt legacy state")
        )
        .is_err());
    let newer = r#"{"codex-transcript:rollout":{"lastOffset":27,"future":true}}"#;
    assert_eq!(
        queue
            .prepare_shell_checkpoint("new-source", LegacyCheckpointHandoff::Codex, || Ok(Some(
                newer.to_owned()
            )))
            .unwrap()
            .as_deref(),
        Some(newer)
    );
    assert_eq!(
        queue.saved_checkpoints().unwrap(),
        vec![("new-source".to_owned(), newer.to_owned())]
    );
}

#[test]
fn checkpoint_imports_legacy_progress_only_after_acknowledged_export() {
    for input in [
        "qoder-trace",
        "openclaw-plugin-log",
        "opencode-log",
        "cursor-hook",
        "qwen-work-cn-trace",
        "qwen-work-cn-collaboration",
    ] {
        assert_acknowledged_checkpoint_handoff(input);
    }
}

#[test]
fn legacy_hook_reader_recovers_an_unexported_drained_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let queue = Outbox::open(&root, settings()).unwrap();
    let handoff = LegacyCheckpointHandoff::HookHistory("opencode");
    let source = "opencode-source";
    let checkpoint = r#"{"opencode-log:fixture":{"lastOffset":97}}"#;
    queue.checkpoint(source, checkpoint).unwrap();
    queue
        .enqueue_hook(br#"{"event.id":"still-queued"}"#)
        .unwrap();
    assert!(matches!(
        Outbox::checkpoint_for_shell(&root, source, handoff).unwrap(),
        ShellCheckpoint::Pending
    ));
    queue
        .ack(&queue.read_batch(&settings()).unwrap().0)
        .unwrap();
    assert!(matches!(
        Outbox::checkpoint_for_shell(&root, source, handoff).unwrap(),
        ShellCheckpoint::Ready(Some(text)) if text == checkpoint
    ));
    assert!(Outbox::checkpoint_for_shell(&root, "different-source", handoff).is_err());
    Outbox::mark_shell_checkpoint_exported(&root, handoff).unwrap();
    assert!(matches!(
        Outbox::checkpoint_for_shell(&root, source, handoff).unwrap(),
        ShellCheckpoint::Exported { has_progress: true }
    ));
}

fn assert_acknowledged_checkpoint_handoff(input: &str) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let queue = Outbox::open(&root, settings()).unwrap();
    let handoff = LegacyCheckpointHandoff::for_input(input).unwrap();
    let source = "fixture-source";
    let original = r#"{"qoder-trace:fixture":{"lastOffset":12}}"#;
    let advanced = r#"{"qoder-trace:fixture":{"lastOffset":36}}"#;
    let pending = br#"{"event.id":"pending-qoder","event.name":"llm.request"}"#;
    queue.checkpoint(source, original).unwrap();
    queue.enqueue_hook(pending).unwrap();
    assert_eq!(
        queue
            .prepare_shell_checkpoint(source, handoff, || panic!("SDK still owns the cursor"))
            .unwrap()
            .as_deref(),
        Some(original)
    );
    assert!(Outbox::mark_shell_checkpoint_exported(&root, handoff).is_err());
    let rows = queue.read_batch(&settings()).unwrap().0;
    assert_eq!(rows[0].1, pending);
    queue.ack(&rows).unwrap();
    Outbox::mark_shell_checkpoint_exported(&root, handoff).unwrap();
    assert!(queue
        .prepare_shell_checkpoint(source, handoff, || anyhow::bail!("bad state"))
        .is_err());
    assert_eq!(
        queue
            .prepare_shell_checkpoint(source, handoff, || Ok(Some(advanced.to_owned())))
            .unwrap()
            .as_deref(),
        Some(advanced)
    );
    assert_eq!(
        queue.saved_checkpoints().unwrap(),
        vec![(source.to_owned(), advanced.to_owned())]
    );

    Outbox::mark_shell_checkpoint_exported(&root, handoff).unwrap();
    assert_eq!(
        queue
            .prepare_shell_checkpoint(source, handoff, || Ok(None))
            .unwrap()
            .as_deref(),
        Some(advanced)
    );
}

#[tokio::test]
async fn legacy_queue_totals_stay_exact_after_batch_updates_and_failed_ack() {
    let dir = tempfile::tempdir().unwrap();
    let previous = Outbox::open(dir.path(), settings()).unwrap();
    let old_payload = br#"{"event.id":"legacy"}"#;
    {
        let db = previous.db.lock().unwrap();
        db.execute_batch(
            "CREATE TRIGGER event_accepted AFTER INSERT ON event BEGIN
                UPDATE queue_size SET bytes=bytes+length(NEW.payload),events=events+1 WHERE singleton=1; END;
             CREATE TRIGGER event_acked AFTER DELETE ON event BEGIN
                UPDATE queue_size SET bytes=bytes-length(OLD.payload),events=events-1 WHERE singleton=1; END;",
        )
        .unwrap();
        db.execute(
            "INSERT INTO event(source,batch,payload,created) VALUES('source','old',?1,1)",
            [old_payload.as_slice()],
        )
        .unwrap();
    }
    drop(previous);

    let queue = Outbox::open(dir.path(), settings()).unwrap();
    let store = StateStore::new(dir.path().join("state.json"));
    store.set_offset("source", 42.0);
    let newer = [
        br#"{"event.id":"one"}"#.to_vec(),
        br#"{"event.id":"two"}"#.to_vec(),
    ];
    queue
        .accept_fixture("source", &store, &newer, &AtomicBool::new(false))
        .await
        .unwrap();
    let expected = old_payload.len() + newer.iter().map(Vec::len).sum::<usize>();
    let before = queue.snapshot();
    assert_eq!(before["pending_events"], 3);
    assert_eq!(before["pending_bytes"], expected);
    assert_eq!(
        queue.saved_checkpoints().unwrap()[0].1,
        store.snapshot_with_revision().1
    );

    let (rows, _) = queue.read_batch(&settings()).unwrap();
    assert_eq!(rows[0].1, old_payload);
    assert_eq!(rows[1].1, newer[0]);
    assert_eq!(rows[2].1, newer[1]);
    let mut incomplete = rows.clone();
    incomplete.push((i64::MAX, Vec::new()));
    assert!(queue.ack(&incomplete).is_err());
    assert_eq!(queue.read_batch(&settings()).unwrap().0, rows);
    assert_eq!(queue.snapshot()["pending_bytes"], expected);

    queue.ack(&rows).unwrap();
    assert_eq!(queue.snapshot()["pending_events"], 0);
    assert_eq!(queue.snapshot()["pending_bytes"], 0);
    assert_eq!(
        queue.saved_checkpoints().unwrap()[0].1,
        store.snapshot_with_revision().1
    );
}
