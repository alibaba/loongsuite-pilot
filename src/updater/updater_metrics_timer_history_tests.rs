mod metrics_timer_history_tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn original_metrics_flush_contract_uses_the_actual_thirty_second_ticker() {
        let root = tempfile::tempdir().unwrap();
        let alarms = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sent = alarms.clone();
        let metrics = Arc::new(UpdaterMetrics::new(crate::updater::UpdaterMetricsOptions {
            data_dir: root.path().to_string_lossy().into_owned(),
            version: "1.0.0".into(),
            collector_pid_file: root.path().join("pid").to_string_lossy().into_owned(),
            user_id: "{source-test}".into(),
            collector_liveness: Some(Arc::new(|_| crate::utils::ProcessLiveness {
                running: true, pid: Some(456), source: crate::utils::ProcessLivenessSource::ProcessScan,
                reason: "matching process command found".into(), pid_file_state: None,
                pid_file_process_alive: None, pid_file_command: None, pid_file_command_matched: None,
            })),
            date_string: Some(Arc::new(|| "2026-09-02".into())),
            now_ms: Some(Arc::new(||1_700_000_000_000)),
            alarm_sender: Some(Arc::new(move |_,_| {sent.fetch_add(1,Ordering::SeqCst);})),
            ip: Some("127.0.0.1".into()),
        }));
        let updater = Arc::new(Updater::with_net(base_config(),root.path().to_str(),ScriptedNet::new(vec![],vec![])));
        updater.set_metrics(metrics.clone());
        metrics.start().await;
        let keep_clock_fixed=tokio::spawn(async {loop {tokio::task::yield_now().await;}});
        let runner=updater.clone();
        let maintenance=tokio::spawn(async move {runner.maintain().await;});
        let wait_for = async {
            let deadline=std::time::Instant::now()+Duration::from_secs(10);
            while alarms.load(Ordering::SeqCst)==0 {
                assert!(std::time::Instant::now()<deadline);
                tokio::task::yield_now().await;
            }
        };
        wait_for.await;
        let events=root.path().join("logs/metric_alarm/pilot-updater-events-2026-09-02.jsonl");
        metrics.write_event(EVENT_UPDATER_STARTED,UpdaterEventExtra::default());
        assert!(!events.exists());
        tokio::time::advance(Duration::from_millis(29_999)).await;
        for _ in 0..20 {tokio::task::yield_now().await;}
        assert!(!events.exists());
        tokio::time::advance(Duration::from_millis(1)).await;
        let deadline=std::time::Instant::now()+Duration::from_secs(10);
        while !std::fs::metadata(&events).is_ok_and(|meta|meta.len()>0) {
            assert!(std::time::Instant::now()<deadline);
            tokio::task::yield_now().await;
        }
        let rows:Vec<Value>=std::fs::read_to_string(events).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows.len(),1);assert_eq!(rows[0]["event_type"],"updater_started");
        maintenance.abort();maintenance.await.unwrap_err();
        metrics.stop().await;
        assert_eq!(alarms.load(Ordering::SeqCst),1,"braced user ID alarms only once per lifetime");
        keep_clock_fixed.abort();
    }
}
