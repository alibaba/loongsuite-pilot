// Exact missing assertions from updater-metrics18; isolate sender recording.
fn default_history_metrics(harness: &Harness, user_id: &str) -> UpdaterMetrics {
    let now = harness.now.clone();
    UpdaterMetrics::new(UpdaterMetricsOptions {
        data_dir: harness.dir.path().to_string_lossy().into_owned(),
        version: "1.0.0".into(),
        collector_pid_file: harness.dir.path().join("collector.pid").to_string_lossy().into_owned(),
        user_id: user_id.into(),
        collector_liveness: Some(Arc::new(|_| down("pid file is missing"))),
        date_string: Some(Arc::new(|| "2026-09-02".into())),
        now_ms: Some(Arc::new(move || *now.lock().unwrap())),
        alarm_sender: None,
        ip: Some("127.0.0.1".into()),
    })
}

#[tokio::test]
async fn history_events_preserve_started_version_ip_time_user_and_both_extra_versions() {
    crate::internal::sender::clear_sends();
    let h = Harness::new();
    let metrics = default_history_metrics(&h, "user-123");
    metrics.start().await;
    metrics.write_event(EVENT_UPDATER_STARTED, UpdaterEventExtra::default());
    metrics.write_event(EVENT_NEW_VERSION_AVAILABLE, UpdaterEventExtra {
        current_version: Some("1.0.0".into()),
        latest_version: Some("1.0.1".into()),
        ..UpdaterEventExtra::default()
    });
    metrics.stop().await;
    let events = read_lines(h.dir.path(), "pilot-updater-events");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["event_type"], "updater_started");
    assert_eq!(events[0]["version"], "1.0.0");
    assert_eq!(events[0]["ip"], "127.0.0.1");
    assert!(events[0]["__time__"].is_number());
    assert_eq!(events[0]["user_id"], "user-123");
    assert_eq!(events[1]["current_version"], "1.0.0");
    assert_eq!(events[1]["latest_version"], "1.0.1");
    // Production default path: events are local rows, never status sends.
    assert!(crate::internal::sender::recorded_sends().is_empty());
}

#[tokio::test]
async fn history_default_alarm_sender_receives_the_exact_queued_alarm_on_flush() {
    crate::internal::sender::clear_sends();
    let h = Harness::new();
    let metrics = default_history_metrics(&h, "test-user");
    metrics.start().await;
    metrics.write_alarm("UPDATER_FAILURE_ALARM", "2", "update failed");
    assert!(crate::internal::sender::recorded_sends().is_empty());
    metrics.stop().await;
    let local = read_lines(h.dir.path(), "pilot-alarms");
    assert_eq!(local.len(), 1);
    assert_eq!(local[0]["alarm_type"], "UPDATER_FAILURE_ALARM");
    assert_eq!(local[0]["alarm_level"], "2");
    assert_eq!(local[0]["alarm_message"], "update failed");
    assert_eq!(local[0]["alarm_count"], "1");
    assert_eq!(local[0]["user_id"], "test-user");
    assert_eq!(local[0]["ver"], "1.0.0");
    let sends = crate::internal::sender::recorded_sends();
    assert_eq!(sends.len(), 1, "the real default must call internal sender, not only injected callbacks");
    assert_eq!(sends[0].kind, "alarm");
    assert_eq!(sends[0].topic, "pilot_alarm");
    assert_eq!(sends[0].fields["alarm_message"], "update failed");
    assert!(!sends[0].fields.contains_key("__topic__"));
}

#[tokio::test]
async fn history_stale_pid_file_with_live_command_identity_never_alarms() {
    let h = Harness::new();
    let metrics = h.metrics("test-user", Some(Arc::new(|_| ProcessLiveness {
        running: true,
        pid: Some(456),
        source: ProcessLivenessSource::ProcessScan,
        reason: "matching process command found; pid file points to stale or mismatched pid 123".into(),
        pid_file_state: Some(PidFileState::Stale),
        pid_file_process_alive: Some(false),
        pid_file_command: None,
        pid_file_command_matched: Some(false),
    })));
    metrics.start().await;
    *h.now.lock().unwrap() += 4 * 60_000;
    metrics.check_collector_health();
    *h.now.lock().unwrap() += 60_000;
    metrics.check_collector_health();
    metrics.stop().await;
    assert!(read_lines(h.dir.path(), "pilot-alarms").is_empty());
    assert!(h.alarms.lock().unwrap().is_empty());
}
