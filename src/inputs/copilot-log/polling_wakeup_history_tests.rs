//! Actual fallback watcher -> real HostedInput -> native Copilot queue/SQLite.
//! All fixtures are private; no direct request_collection or fabricated entries.
use super::*;

async fn replace_with_polling(input: &CopilotLogInput) -> Arc<AtomicUsize> {
    let old = input.inner.body.watcher.lock().unwrap().take().unwrap();
    old.stop().await;
    let passes = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&passes);
    let watcher = super::super::super::spawn_copilot_polling_wakeup_watcher(
        &input.inner.body.wakeup_dir,
        Arc::downgrade(&input.inner),
        move || {
            observed.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await;
    *input.inner.body.watcher.lock().unwrap() = Some(watcher);
    passes
}
async fn after_two_real_polls(passes: &AtomicUsize, input: &CopilotLogInput) {
    while passes.load(Ordering::SeqCst) < 2 {
        tokio::task::yield_now().await;
    }
    input.inner.await_current_cycle_for_test().await;
}
async fn after_acceptance(count: &AtomicUsize, target: usize, input: &CopilotLogInput) {
    while count.load(Ordering::SeqCst) < target {
        tokio::task::yield_now().await;
    }
    input.inner.await_current_cycle_for_test().await;
}

#[tokio::test]
async fn polling_wakeup_existing_directory_is_quiet_and_real_markers_retry_once_after_restart() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let x = Fixture::new().await;
        x.sources(&conversation("interaction-a", 0)).await;
        let input = x.input(Some(0));
        let failures = Arc::new(AtomicUsize::new(0));
        let errors = Arc::clone(&failures);
        input.inner.on_collect_error(move |_| {
            errors.fetch_add(1, Ordering::SeqCst);
        });
        let cycles = Arc::new(AtomicUsize::new(0));
        let finished = Arc::clone(&cycles);
        input.inner.on_runtime_delta(move |_| {
            finished.fetch_add(1, Ordering::SeqCst);
        });
        let reject = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&reject);
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&accepted);
        let batches = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&batches);
        input.on_entries(move |rows| {
            assert!(!flag.load(Ordering::SeqCst), "queue rejected");
            captured.lock().unwrap().push(rows.to_vec());
            count.fetch_add(1, Ordering::SeqCst);
        });
        input.start().await.unwrap();
        let passes = replace_with_polling(&input).await;
        let initial_cycles = cycles.load(Ordering::SeqCst);
        after_two_real_polls(&passes, &input).await;
        assert_eq!(
            failures.load(Ordering::SeqCst),
            1,
            "initial directory generation is not a filesystem change"
        );
        assert_eq!(
            cycles.load(Ordering::SeqCst),
            initial_cycles,
            "initial fallback polling requested a false rescan"
        );
        assert_eq!(
            x.count("SELECT COUNT(*) FROM delivered"),
            0,
            "rejection must not acknowledge native records"
        );

        reject.store(false, Ordering::SeqCst);
        tokio::fs::write(
            input.inner.body.wakeup_dir.join("retry.json"),
            r#"{"session_id":"session-test"}"#,
        )
        .await
        .unwrap();
        after_acceptance(&accepted, 1, &input).await;
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        assert!(x.count("SELECT COUNT(*) FROM delivered") > 0);
        interaction(&batches.lock().unwrap()[0], "interaction-a");
        input.stop().await.unwrap();

        input.start().await.unwrap();
        let passes = replace_with_polling(&input).await;
        let restarted_cycles = cycles.load(Ordering::SeqCst);
        after_two_real_polls(&passes, &input).await;
        assert_eq!(
            cycles.load(Ordering::SeqCst),
            restarted_cycles,
            "restart must snapshot the existing marker generation"
        );
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            1,
            "restart replayed acknowledged records"
        );
        let next = conversation("interaction-b", 10000);
        x.append(&x.events, &next["events"].as_array().unwrap()[1..]);
        x.append(&x.native, next["spans"].as_array().unwrap());
        tokio::fs::write(
            input.inner.body.wakeup_dir.join("next.json"),
            r#"{"session_id":"session-test"}"#,
        )
        .await
        .unwrap();
        after_acceptance(&accepted, 2, &input).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
        interaction(&batches.lock().unwrap()[1], "interaction-b");
        input.stop().await.unwrap();
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            2,
            "acknowledged batches must remain exactly once after another restart"
        );
    })
    .await
    .expect("existing Native five-second queue lifecycle budget");
}
