//! Exact remaining Copilot input history contracts. All paths/data are synthetic.
use super::*;
use crate::types::AgentEventName;
async fn collect_at(input: &CopilotLogInput, now: i64) -> Vec<AgentActivityEntry> {
    input.inner.body.apply_history_policy().await.unwrap();
    let body = &input.inner.body;
    let mut shared = body.shared.lock().unwrap();
    let (keys, records) = super::super::collect_sources_at(
        shared.index.as_ref().unwrap(),
        &body.session_dir,
        &body.otel_dir,
        &body.wakeup_dir,
        body.native_grace_ms,
        Some(now),
    )
    .unwrap();
    shared.queued = keys;
    records
}
fn ids(rows: &[AgentActivityEntry]) -> Vec<String> {
    rows.iter().map(|r| r.event_id.clone()).collect()
}
fn interaction(rows: &[AgentActivityEntry], id: &str) {
    assert!(!rows.is_empty());
    assert!(rows
        .iter()
        .all(|r| r.get("gen_ai.copilot.interaction.id") == Some(&json!(id))));
}
#[tokio::test]
async fn input_l25_unknown_shell_grace_is_durable_and_reapplies_to_each_interaction() {
    let x = Fixture::new().await;
    let a = conversation("interaction-a", 0);
    tokio::fs::write(&x.events, lines(&a["events"]))
        .await
        .unwrap();
    tokio::fs::write(x.root.path().join("otel-enabled"), "managed")
        .await
        .unwrap();
    let first = x.input(Some(0));
    assert!(collect_at(&first, 100_000).await.is_empty());
    stop(&first).await;
    let next = x.input(None);
    assert!(collect_at(&next, 129_999).await.is_empty());
    let records = collect_at(&next, 130_000).await;
    assert!(response(&records));
    assert!(records
        .iter()
        .all(|r| r.get("gen_ai.copilot.telemetry.source") == Some(&json!("transcript-only"))));
    assert!(records
        .iter()
        .find(|r| r.event_name == Some(AgentEventName::LlmResponse))
        .unwrap()
        .input_tokens
        .is_none());
    queued(&next).await;
    let b = conversation("interaction-b", 10000);
    x.append(&x.events, &b["events"].as_array().unwrap()[1..]);
    assert!(collect_at(&next, 130_000).await.is_empty());
    assert!(!collect_at(&next, 160_000).await.is_empty());
    stop(&next).await;
}
#[tokio::test]
async fn input_l41_delayed_native_arrival_within_grace_uses_exact_per_call_tokens() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    tokio::fs::write(&x.events, lines(&f["events"]))
        .await
        .unwrap();
    let input = x.input(Some(0));
    assert!(collect_at(&input, 100_000).await.is_empty());
    tokio::fs::write(&x.native, lines(&f["spans"]))
        .await
        .unwrap();
    let records = collect_at(&input, 125_000).await;
    assert_eq!(
        records
            .iter()
            .find(|r| r.event_name == Some(AgentEventName::LlmResponse))
            .unwrap()
            .input_tokens,
        Some(100)
    );
    assert_eq!(
        records[0].get("gen_ai.copilot.telemetry.source"),
        Some(&json!("native-otel"))
    );
    stop(&input).await;
}
#[tokio::test]
async fn input_l48_explicit_no_exporter_avoids_grace_while_known_exporter_waits() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    tokio::fs::write(&x.events, lines(&f["events"]))
        .await
        .unwrap();
    x.mark_native().await;
    let input = x.input(Some(0));
    assert!(collect(&input).await.is_empty());
    tokio::fs::write(
        x.root
            .path()
            .join("state/copilot/session-wakeups/session-test.json"),
        json!({"session_id":"session-test"}).to_string(),
    )
    .await
    .unwrap();
    assert!(!collect(&input).await.is_empty());
    stop(&input).await;
}
#[tokio::test]
async fn input_l56_normal_polling_survives_an_asynchronously_terminated_wakeup_listener() {
    let x = Fixture::new().await;
    let input = x.input(Some(0));
    input.inner.runtime.force_poll_interval_ms(10);
    let records = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&records);
    input.on_entries(move |rows| sink.lock().unwrap().extend_from_slice(rows));
    input.start().await.unwrap();
    let watcher = input
        .inner
        .body
        .watcher
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .task
        .abort_handle();
    watcher.abort();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !watcher.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    x.sources(&conversation("interaction-a", 0)).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !records.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    input.stop().await.unwrap();
    assert!(response(&records.lock().unwrap()));
    assert!(input.inner.body.watcher.lock().unwrap().is_none());
}
#[tokio::test]
async fn input_l63_l72_constructor_and_unified_poll_intervals_are_used_by_real_native_inputs() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    unsafe {
        std::env::set_var("LOONGSUITE_PILOT_POLL_INTERVAL_MS", "");
    }
    let x = Fixture::new().await;
    for (configured, expected) in [(None, 10000), (Some(1234), 1234), (Some(0), 10000)] {
        let input = CopilotLogInput::new(CopilotLogInputOptions {
            state_store: Arc::clone(&x.store),
            data_dir: x.root.path().to_owned(),
            session_dir: Some(x.sessions.clone()),
            otel_dir: Some(x.root.path().join("otel")),
            poll_interval_ms: configured,
            native_grace_ms: None,
            history_start_time_ms: Some(0),
        });
        assert_eq!(input.inner.runtime.poll_interval_ms(), expected);
    }
    unsafe {
        std::env::set_var("LOONGSUITE_PILOT_POLL_INTERVAL_MS", "3000");
    }
    for configured in [None, Some(45000)] {
        let input = CopilotLogInput::new(CopilotLogInputOptions {
            state_store: Arc::clone(&x.store),
            data_dir: x.root.path().to_owned(),
            session_dir: Some(x.sessions.clone()),
            otel_dir: Some(x.root.path().join("otel")),
            poll_interval_ms: configured,
            native_grace_ms: None,
            history_start_time_ms: Some(0),
        });
        assert_eq!(input.inner.runtime.poll_interval_ms(), 3000);
    }
}
#[tokio::test]
async fn input_l86_pending_interaction_waits_for_native_root_across_recreated_input() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    tokio::fs::write(&x.events, lines(&f["events"]))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&json!([f["spans"][0].clone()])))
        .await
        .unwrap();
    let first = x.input(Some(0));
    assert!(collect(&first).await.is_empty());
    x.store.save().await.unwrap();
    stop(&first).await;
    let next = x.input(None);
    x.append(&x.native, &f["spans"].as_array().unwrap()[1..]);
    assert!(!collect(&next).await.is_empty());
    stop(&next).await;
}
#[tokio::test]
async fn input_l90_only_appended_interaction_and_separate_summary_are_emitted_once() {
    let x = Fixture::new().await;
    let a = conversation("interaction-a", 0);
    let b = conversation("interaction-b", 10000);
    x.sources(&a).await;
    let input = x.input(Some(0));
    collect(&input).await;
    queued(&input).await;
    x.append(&x.events, &b["events"].as_array().unwrap()[1..]);
    x.append(&x.native, b["spans"].as_array().unwrap());
    interaction(&collect(&input).await, "interaction-b");
    queued(&input).await;
    x.append(&x.events,&[json!({"type":"session.shutdown","id":"s-end","timestamp":"2026-09-01T00:00:30Z","data":{"modelMetrics":{"model":{"usage":{"inputTokens":200}}}}})]);
    let summary = collect(&input).await;
    assert_eq!(summary.len(), 1);
    assert_eq!(
        summary[0].get("gen_ai.copilot.session_summary"),
        Some(&json!(true))
    );
    queued(&input).await;
    assert!(collect(&input).await.is_empty());
    stop(&input).await;
}
#[tokio::test]
async fn input_l95_missing_session_directory_and_partial_line_keep_delivery_state() {
    let x = Fixture::new().await;
    let a = conversation("interaction-a", 0);
    x.sources(&a).await;
    let input = x.input(Some(0));
    collect(&input).await;
    queued(&input).await;
    x.store.save().await.unwrap();
    let away = x.sessions.with_extension("away");
    tokio::fs::rename(&x.sessions, &away).await.unwrap();
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 1);
    tokio::fs::rename(away, &x.sessions).await.unwrap();
    let b = conversation("interaction-b", 10000);
    let text = lines(&json!(&b["events"].as_array().unwrap()[1..]));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&x.events)
        .unwrap()
        .write_all(&text.as_bytes()[..text.len() - 2])
        .unwrap();
    x.append(&x.native, b["spans"].as_array().unwrap());
    assert!(collect(&input).await.is_empty());
    std::fs::OpenOptions::new()
        .append(true)
        .open(&x.events)
        .unwrap()
        .write_all(&text.as_bytes()[text.len() - 2..])
        .unwrap();
    assert!(!collect(&input).await.is_empty());
    stop(&input).await;
}
#[tokio::test]
async fn input_l100_replaced_native_source_does_not_replay_queued_interactions() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    x.sources(&f).await;
    let input = x.input(Some(0));
    collect(&input).await;
    queued(&input).await;
    tokio::fs::rename(&x.native, x.native.with_extension("old"))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&f["spans"]))
        .await
        .unwrap();
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 1);
    stop(&input).await;
}
#[tokio::test]
async fn input_l104_events_above_sixty_four_mib_drain_complete_interaction_before_partial_eof() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    let mut file = std::fs::File::create(&x.events).unwrap();
    file.write_all(lines(&json!([f["events"][0].clone()])).as_bytes())
        .unwrap();
    let padding =
        json!({"type":"hook.end","data":{"padding":"x".repeat(1024*1024)}}).to_string() + "\n";
    for _ in 0..65 {
        file.write_all(padding.as_bytes()).unwrap();
    }
    file.write_all(lines(&json!(&f["events"].as_array().unwrap()[1..])).as_bytes())
        .unwrap();
    file.write_all(b"{\"type\":").unwrap();
    drop(file);
    tokio::fs::write(&x.native, lines(&f["spans"]))
        .await
        .unwrap();
    let input = x.input(Some(0));
    let mut records = vec![];
    for _ in 0..40 {
        records = collect(&input).await;
        if !records.is_empty() {
            break;
        }
    }
    assert_eq!(
        records
            .iter()
            .filter(|r| r.event_name == Some(AgentEventName::LlmResponse))
            .count(),
        1
    );
    queued(&input).await;
    assert!(collect(&input).await.is_empty());
    stop(&input).await;
}
#[tokio::test]
async fn input_l119_native_above_sixty_four_mib_resumes_four_mib_budget_after_restart() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    tokio::fs::write(&x.events, lines(&f["events"]))
        .await
        .unwrap();
    tokio::fs::write(x.root.path().join("otel-enabled"), "managed")
        .await
        .unwrap();
    let mut file = std::fs::File::create(&x.native).unwrap();
    let padding = json!({"type":"log","body":"x".repeat(1024*1024)}).to_string() + "\n";
    for _ in 0..65 {
        file.write_all(padding.as_bytes()).unwrap();
    }
    file.write_all(lines(&f["spans"]).as_bytes()).unwrap();
    file.write_all(b"{\"type\":").unwrap();
    drop(file);
    let first = x.input(Some(0));
    assert!(collect(&first).await.is_empty());
    let offset = x.count("SELECT offset FROM sources WHERE kind='span'");
    assert!(offset > 0 && offset <= 4 * 1024 * 1024);
    assert_eq!(
        x.count("SELECT position FROM partial_sources WHERE path LIKE '%native.jsonl'"),
        4 * 1024 * 1024
    );
    stop(&first).await;
    let next = x.input(None);
    let mut records = vec![];
    for _ in 0..40 {
        records = collect(&next).await;
        if !records.is_empty() {
            break;
        }
    }
    assert_eq!(
        records
            .iter()
            .filter(|r| r.event_name == Some(AgentEventName::LlmResponse))
            .count(),
        1
    );
    queued(&next).await;
    assert_eq!(
        x.count("SELECT offset FROM sources WHERE kind='span'") as u64,
        tokio::fs::metadata(&x.native).await.unwrap().len() - 8
    );
    assert!(collect(&next).await.is_empty());
    stop(&next).await;
}
#[tokio::test]
async fn input_l138_five_mib_complete_json_record_crosses_cycle_budget_without_content_loss() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-a", 0);
    f["events"][1]["data"]["content"] = json!("x".repeat(5 * 1024 * 1024));
    x.sources(&f).await;
    let input = x.input(Some(0));
    assert!(collect(&input).await.is_empty());
    let records = collect(&input).await;
    let prompt = records
        .iter()
        .find(|r| r.event_name == Some(AgentEventName::Other))
        .unwrap();
    assert!(serde_json::to_string(&prompt.input_messages)
        .unwrap()
        .contains(&"x".repeat(1024)));
    stop(&input).await;
}
#[tokio::test]
async fn input_l144_twelve_old_pending_interactions_cannot_starve_later_complete_work() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    let mut events = vec![f["events"][0].clone()];
    events.extend((0..12).map(|i|json!({"type":"user.message","id":format!("pending-{i}"),"timestamp":"2026-08-01T00:00:00Z","data":{"interactionId":format!("pending-{i}"),"content":"pending"}})));
    events.extend(f["events"].as_array().unwrap()[1..].to_vec());
    tokio::fs::write(&x.events, lines(&json!(events)))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&f["spans"]))
        .await
        .unwrap();
    let input = x.input(Some(0));
    let mut records = vec![];
    for _ in 0..4 {
        records = collect(&input).await;
        if !records.is_empty() {
            break;
        }
    }
    assert_eq!(
        records
            .iter()
            .filter(|r| r.event_name == Some(AgentEventName::LlmResponse))
            .count(),
        1
    );
    stop(&input).await;
}
#[tokio::test]
async fn input_l150_v2_delivered_keys_import_without_replay_after_transcript_truncation() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    x.store.set(
        "copilot-log:v2:session-test",
        crate::checkpoints::InputState::new()
            .with_extra(json!({"interactions":["copilot:session-test:interaction-a"]})),
    );
    x.sources(&f).await;
    let input = x.input(Some(0));
    assert!(collect(&input).await.is_empty());
    assert!(!x
        .store
        .keys()
        .contains(&"copilot-log:v2:session-test".to_owned()));
    tokio::fs::write(&x.events, lines(&json!([f["events"][0].clone()])))
        .await
        .unwrap();
    assert!(collect(&input).await.is_empty());
    x.append(&x.events, &f["events"].as_array().unwrap()[1..]);
    assert!(collect(&input).await.is_empty());
    stop(&input).await;
}
#[tokio::test]
async fn input_l184_copy_truncate_regrowth_past_old_offset_delivers_only_new_interaction() {
    let x = Fixture::new().await;
    let a = conversation("interaction-a", 0);
    x.sources(&a).await;
    let input = x.input(Some(0));
    collect(&input).await;
    queued(&input).await;
    let old = tokio::fs::metadata(&x.events).await.unwrap().len();
    let mut b = conversation("interaction-b", 10000);
    b["events"][1]["data"]["content"] = json!("New content ".repeat(200));
    tokio::fs::write(&x.events, lines(&b["events"]))
        .await
        .unwrap();
    assert!(tokio::fs::metadata(&x.events).await.unwrap().len() > old);
    x.append(&x.native, b["spans"].as_array().unwrap());
    let records = collect(&input).await;
    assert_eq!(
        records
            .iter()
            .filter(|r| r.event_name == Some(AgentEventName::LlmResponse))
            .count(),
        1
    );
    interaction(&records, "interaction-b");
    stop(&input).await;
}
#[tokio::test]
async fn input_l191_confirmed_deleted_session_prunes_facts_and_delivery_but_keeps_native_files() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    x.sources(&f).await;
    let input = x.input(Some(0));
    collect(&input).await;
    queued(&input).await;
    tokio::fs::remove_dir_all(x.sessions.join("session-test"))
        .await
        .unwrap();
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT COUNT(*) FROM records"), 0);
    assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 0);
    assert!(tokio::fs::metadata(&x.native).await.unwrap().len() > 0);
    stop(&input).await;
}

use crate::core::{InputManager, LiveInput};
use crate::flushers::{BaseFlusher, FlushError};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct CaptureFlusher(Mutex<Vec<AgentActivityEntry>>);
#[async_trait]
impl BaseFlusher for CaptureFlusher {
    fn name(&self) -> &str {
        "copilot-history-capture"
    }
    async fn send(
        &self,
        row: AgentActivityEntry,
        _: Option<f64>,
    ) -> std::result::Result<(), FlushError> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
    async fn send_batch(
        &self,
        rows: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> std::result::Result<(), FlushError> {
        self.0.lock().unwrap().extend(rows);
        Ok(())
    }
    async fn flush(&self) -> std::result::Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> std::result::Result<(), FlushError> {
        Ok(())
    }
}
struct FreezeAfterNativeCollect {
    native: Arc<HostedInput<CopilotLogBody>>,
    expected: Arc<Mutex<Vec<String>>>,
    staged_progress: Option<f64>,
    freeze_output: bool,
}
#[async_trait]
impl InputBody for FreezeAfterNativeCollect {
    fn id(&self) -> &str {
        "copilot-log"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::CopilotCli
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().into()])
    }
    async fn collect(&self, rt: &InputRuntime) -> Result<Vec<AgentActivityEntry>> {
        let rows = self.native.body.collect(&self.native.runtime).await?;
        *self.expected.lock().unwrap() = ids(&rows);
        if let Some(offset) = self.staged_progress {
            rt.state_store.set_offset(self.id(), offset);
        }
        if self.freeze_output {
            rt.state_store
                .begin_output()
                .finish(Err("another input output failed".into()));
        }
        Ok(rows)
    }
    async fn on_entries_queued(&self, _: &InputRuntime) -> Result<()> {
        self.native
            .body
            .on_entries_queued(&self.native.runtime)
            .await
    }
    async fn on_stop(&self, _: &InputRuntime) -> Result<()> {
        self.native.body.on_stop(&self.native.runtime).await
    }
}
#[tokio::test]
async fn input_l158_real_shared_lifecycle_replays_a_batch_frozen_during_native_collection() {
    let x = Fixture::new().await;
    x.sources(&conversation("interaction-a", 0)).await;
    let native = x.input(Some(0));
    let expected = Arc::new(Mutex::new(Vec::new()));
    let input = HostedInput::new(
        FreezeAfterNativeCollect {
            native: Arc::clone(&native.inner),
            expected: Arc::clone(&expected),
            staged_progress: None,
            freeze_output: true,
        },
        "FrozenCopilotHistory",
        Arc::clone(&x.store),
        Some(60000),
    );
    let manager = Arc::new(InputManager::new());
    let flusher = Arc::new(CaptureFlusher(Mutex::new(Vec::new())));
    manager.set_flusher(flusher.clone());
    manager.set_state_store(Arc::clone(&x.store));
    manager.register_input(LiveInput::new(
        "copilot-log",
        "copilot",
        "session-file-polling",
        || true,
        || Box::pin(async { Ok(()) }),
        || Box::pin(async {}),
    ));
    let queue = Arc::clone(&manager);
    input.on_entries(move |rows| queue.bind_entries("copilot-log", rows.to_vec()));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    manager.stop_all().await;
    assert!(x.store.save_failed());
    assert!(
        flusher.0.lock().unwrap().is_empty(),
        "frozen collection leaked entries to the flusher"
    );
    let restored = Arc::new(StateStore::new(x.root.path().join("state.json")));
    restored.load().await;
    let replay = CopilotLogInput::new(CopilotLogInputOptions {
        state_store: restored,
        session_dir: Some(x.sessions.clone()),
        data_dir: x.root.path().to_owned(),
        otel_dir: Some(x.root.path().join("otel")),
        poll_interval_ms: Some(60000),
        native_grace_ms: Some(30000),
        history_start_time_ms: None,
    });
    let rows = collect(&replay).await;
    assert!(!expected.lock().unwrap().is_empty());
    assert_eq!(ids(&rows), *expected.lock().unwrap());
    assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 0);
    queued(&replay).await;
    assert!(collect(&replay).await.is_empty());
    stop(&replay).await;
}
#[tokio::test]
async fn input_l175_real_shared_lifecycle_commits_only_after_synchronous_queue_acceptance() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let x = Fixture::new().await;
        x.sources(&conversation("interaction-a", 0)).await;
        let input = x.input(Some(0));
        let failures = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::clone(&failures);
        input.inner.on_collect_error(move |_| {
            failure_count.fetch_add(1, Ordering::SeqCst);
        });
        let reject = Arc::new(AtomicBool::new(true));
        let accepted = Arc::new(AtomicUsize::new(0));
        let flag = Arc::clone(&reject);
        let count = Arc::clone(&accepted);
        input.on_entries(move |_| {
            assert!(!flag.load(Ordering::SeqCst), "queue rejected");
            count.fetch_add(1, Ordering::SeqCst);
        });
        let first = input.start().await;
        assert!(
            first.is_ok(),
            "shared lifecycle failed to contain queue rejection"
        );
        input.stop().await.unwrap();
        assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 0);
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        reject.store(false, Ordering::SeqCst);
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    })
    .await
    .expect("original five-second queue lifecycle budget");
}

#[tokio::test]
async fn rejected_progress_cannot_leak_through_an_older_save_when_another_global_hold_accepts() {
    for freeze_output in [true, false] {
        let x = Fixture::new().await;
        x.sources(&conversation("interaction-a", 0)).await;
        x.store.set_offset("copilot-log", 0.0);
        x.store.save().await.unwrap();
        let other = x.store.begin_output();
        let saving = Arc::clone(&x.store);
        let older_save = tokio::spawn(async move { saving.save().await });
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(!older_save.is_finished());
        let native = x.input(Some(0));
        let expected = Arc::new(Mutex::new(Vec::new()));
        let input = HostedInput::new(
            FreezeAfterNativeCollect {
                native: Arc::clone(&native.inner),
                expected: Arc::clone(&expected),
                staged_progress: Some(99.0),
                freeze_output,
            },
            "UnacceptedCopilotCursor",
            Arc::clone(&x.store),
            Some(60_000),
        );
        let sink = Arc::new(CaptureFlusher(Mutex::new(Vec::new())));
        let manager = Arc::new(InputManager::new());
        manager.set_state_store(Arc::clone(&x.store));
        manager.set_flusher(sink.clone());
        manager.register_input(LiveInput::new(
            "copilot-log",
            "copilot",
            "session-file-polling",
            || true,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        ));
        let queue = Arc::clone(&manager);
        input.on_entries(move |rows| {
            assert!(freeze_output, "synthetic queue rejection");
            queue.bind_entries("copilot-log", rows.to_vec());
        });
        input.start().await.unwrap();
        input.stop().await.unwrap();
        manager.stop_all().await;
        assert!(x.store.save_failed());
        assert!(sink.0.lock().unwrap().is_empty());
        assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 0);
        // The unrelated output succeeds later. Its pending shared save must
        // still reject our unaccepted revision rather than flush cursor=99.
        other.finish(Ok(()));
        assert!(older_save.await.unwrap().is_err());
        let disk: Value =
            serde_json::from_slice(&std::fs::read(x.root.path().join("state.json")).unwrap())
                .unwrap();
        assert_eq!(disk["copilot-log"]["lastOffset"], 0);
        let restored = Arc::new(StateStore::new(x.root.path().join("state.json")));
        restored.load().await;
        assert_eq!(restored.get_offset("copilot-log"), 0.0);
        let replay = CopilotLogInput::new(CopilotLogInputOptions {
            state_store: Arc::clone(&restored),
            data_dir: x.root.path().to_owned(),
            session_dir: Some(x.sessions.clone()),
            otel_dir: Some(x.root.path().join("otel")),
            poll_interval_ms: Some(60000),
            native_grace_ms: Some(30000),
            history_start_time_ms: None,
        });
        let records = collect(&replay).await;
        assert!(!expected.lock().unwrap().is_empty());
        assert_eq!(ids(&records), *expected.lock().unwrap());
        // Read locators are intentionally durable before output; delivery
        // remains unacknowledged and reproduces the complete identical batch.
        assert_eq!(
            x.count("SELECT offset FROM sources WHERE kind='event'") as u64,
            std::fs::metadata(&x.events).unwrap().len()
        );
        assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 0);
        let accepted = InputManager::new();
        accepted.set_state_store(restored);
        accepted.set_flusher(sink.clone());
        accepted.register_input(LiveInput::new(
            "copilot-log",
            "copilot",
            "session-file-polling",
            || true,
            || Box::pin(async { Ok(()) }),
            || Box::pin(async {}),
        ));
        accepted
            .accept_entries("copilot-log", records)
            .await
            .unwrap();
        queued(&replay).await;
        assert!(!sink.0.lock().unwrap().is_empty());
        assert_eq!(x.count("SELECT COUNT(*) FROM delivered"), 1);
        assert!(collect(&replay).await.is_empty());
        stop(&replay).await;
        accepted.stop_all().await;
    }
}

#[path = "polling_wakeup_history_tests.rs"]
mod polling_wakeup_history_tests;
