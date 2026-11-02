mod migration_contract_tests {
    use super::*;

    // Each component fixture owns an installation, including its service lock.
    // Updater's production default intentionally shares HOME's installed entry.
    fn scoped_updater(
        config: AutoUpdateConfig,
        base_dir: Option<&str>,
        net: Arc<dyn UpdaterNet>,
    ) -> Updater {
        let root = Path::new(base_dir.expect("fixture installation root"));
        let mut updater = super::Updater::with_net(config, base_dir, net);
        updater.paths.loongsuite_pilot_bin = root
            .join("service-bin")
            .join(if updater.platform == Platform::Win32 {
                "loongsuite-pilot-service.ps1"
            } else {
                "loongsuite-pilot"
            })
            .to_string_lossy()
            .into_owned();
        updater.config_path = root.join("config.json").to_string_lossy().into_owned();
        updater
    }
    fn scoped_real_updater(config: AutoUpdateConfig, base_dir: Option<&str>) -> Updater {
        scoped_updater(config, base_dir, Arc::new(RealUpdaterNet))
    }
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[test]
    fn all_six_historical_stable_version_decisions_are_exact() {
        let root = tempfile::tempdir().unwrap();
        let updater = scoped_real_updater(base_config(), root.path().to_str());
        let remote = super::super::super::release_manifest::fixture("1.0.2", "bbb");
        assert!(updater.needs_update(None, &remote, UpdateChannel::Stable));
        for (local_version, local_commit, remote_version, remote_commit, want) in [
            ("1.0.1", "aaa", "1.0.2", "bbb", true),
            ("1.0.2", "bbb", "1.0.1", "bbb", false),
            ("1.0.2", "aaa", "1.0.2", "bbb", true),
            ("1.0.2", "aaa", "1.0.2", "aaa", false),
            ("1.0.2", "aaa", "1.0.2", "", false),
        ] {
            let manifest =
                super::super::super::release_manifest::fixture(remote_version, remote_commit);
            assert_eq!(
                updater.needs_update(
                    Some(&LocalVersion {
                        version: local_version.into(),
                        git_commit: local_commit.into()
                    }),
                    &manifest,
                    UpdateChannel::Stable
                ),
                want
            );
        }
    }
    #[tokio::test]
    async fn disabled_scheduler_has_no_work_and_repeated_stop_is_safe() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![], vec![]);
        let updater = scoped_updater(
            AutoUpdateConfig {
                enabled: false,
                ..base_config()
            },
            root.path().to_str(),
            net.clone(),
        );
        updater.start();
        assert!(!updater.is_scheduled());
        updater.stop();
        updater.stop();
        assert!(!updater.is_scheduled());
        tokio::time::timeout(
            Duration::from_secs(1),
            updater.run_until(std::future::pending()),
        )
        .await
        .unwrap();
        assert!(!updater.is_scheduled());
        assert!(!updater.is_checking());
        assert!(net.fetch_log.lock().unwrap().is_empty());
        assert!(net.exec_log.lock().unwrap().is_empty());
    }
    #[tokio::test(start_paused = true)]
    async fn stop_during_initial_delay_cancels_all_automatic_work_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![], vec![]);
        let mut updater = scoped_updater(base_config(), root.path().to_str(), net.clone());
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        updater.timer_observer = Some(Arc::new(move |effect| {
            if effect == TimerEffect::ScheduledCheck {
                observed.fetch_add(1, Ordering::SeqCst);
            }
        }));
        let updater = Arc::new(updater);
        let runner = updater.clone();
        let task = tokio::spawn(async move { runner.run_until(std::future::pending()).await });
        tokio::task::yield_now().await;
        assert!(updater.is_scheduled());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        updater.stop();
        updater.stop();
        task.await.unwrap();
        tokio::time::advance(Duration::from_secs(61)).await;
        assert!(!updater.is_scheduled());
        assert!(!updater.is_checking());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(net.fetch_log.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn daemon_dispatches_at_sixty_seconds_with_startup_phased_interval_and_independent_heartbeats(
    ) {
        let root = tempfile::tempdir().unwrap();
        let mut config = base_config();
        config.check_interval_ms = 70_000;
        let mut updater = scoped_updater(
            config,
            root.path().to_str(),
            ScriptedNet::new(vec![], vec![]),
        );
        let origin = tokio::time::Instant::now();
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = events.clone();
        updater.timer_observer = Some(Arc::new(move |effect| {
            observed
                .lock()
                .unwrap()
                .push((effect, origin.elapsed().as_millis()));
        }));
        let updater = Arc::new(updater);
        let runner = updater.clone();
        let task = tokio::spawn(async move { runner.run_until(std::future::pending()).await });
        tokio::task::yield_now().await;
        let checks = || {
            events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|(effect, at)| (*effect == TimerEffect::ScheduledCheck).then_some(*at))
                .collect::<Vec<_>>()
        };
        tokio::time::advance(Duration::from_millis(29_999)).await;
        tokio::task::yield_now().await;
        assert!(checks().is_empty());
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(events
            .lock()
            .unwrap()
            .contains(&(TimerEffect::Heartbeat, 30_000)));
        tokio::time::advance(Duration::from_millis(29_999)).await;
        tokio::task::yield_now().await;
        assert!(checks().is_empty());
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(checks(), vec![60_000]);
        tokio::time::advance(Duration::from_millis(9_999)).await;
        tokio::task::yield_now().await;
        assert_eq!(checks(), vec![60_000]);
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(checks(), vec![60_000, 70_000]);
        tokio::time::advance(Duration::from_millis(69_999)).await;
        tokio::task::yield_now().await;
        assert_eq!(checks(), vec![60_000, 70_000]);
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(checks(), vec![60_000, 70_000, 140_000]);
        updater.stop();
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn configured_periodic_check_can_precede_the_separate_initial_timeout() {
        let root = tempfile::tempdir().unwrap();
        let mut config = base_config();
        config.check_interval_ms = 10_000;
        let mut updater = scoped_updater(
            config,
            root.path().to_str(),
            ScriptedNet::new(vec![], vec![]),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        updater.timer_observer = Some(Arc::new(move |effect| {
            if effect == TimerEffect::ScheduledCheck {
                observed.fetch_add(1, Ordering::SeqCst);
            }
        }));
        let updater = Arc::new(updater);
        let runner = updater.clone();
        let task = tokio::spawn(async move { runner.run_until(std::future::pending()).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(9_999)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        updater.stop();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn manual_check_remains_immediate_while_daemon_waits_for_its_first_scheduled_check() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![Err("explicit manual transport".into())], vec![]);
        let mut updater = scoped_updater(base_config(), root.path().to_str(), net.clone());
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        updater.timer_observer = Some(Arc::new(move |effect| {
            if effect == TimerEffect::ScheduledCheck {
                observed.fetch_add(1, Ordering::SeqCst);
            }
        }));
        let updater = Arc::new(updater);
        let runner = updater.clone();
        let task = tokio::spawn(async move { runner.run_until(std::future::pending()).await });
        tokio::task::yield_now().await;
        assert!(updater.is_scheduled());
        let error = tokio::time::timeout(Duration::from_secs(2), updater.check())
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.contains("explicit manual transport"));
        assert_eq!(net.fetch_log.lock().unwrap().len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        updater.stop();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn missing_manifest_url_does_not_fetch_or_spawn_any_service_command() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![], vec![]);
        let updater = scoped_updater(
            AutoUpdateConfig {
                manifest_url: None,
                ..base_config()
            },
            root.path().to_str(),
            net.clone(),
        );
        updater.check().await.unwrap();
        assert!(net.fetch_log.lock().unwrap().is_empty());
        assert!(net.exec_log.lock().unwrap().is_empty());
        assert!(!updater.is_checking());
        assert_eq!(updater.consecutive_failures(), 0);
    }
    #[tokio::test]
    async fn actual_manifest_http_and_connection_failures_release_guard_and_preserve_install_state()
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(String::from_utf8_lossy(&buffer[..n]).starts_with("GET /latest.json "));
            count.fetch_add(1, Ordering::SeqCst);
            stream.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let updater = scoped_real_updater(
            AutoUpdateConfig {
                manifest_url: Some(format!("http://{address}/latest.json")),
                ..base_config()
            },
            root.path().to_str(),
        );
        let error = tokio::time::timeout(Duration::from_secs(3), updater.check())
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.contains("500"));
        server.await.unwrap();
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(!updater.is_checking());
        assert_eq!(updater.consecutive_failures(), 1);
        assert!(!Path::new(&updater.paths.current_file).exists());
        assert!(!Path::new(&updater.paths.previous_file).exists());
        let root = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let updater = scoped_real_updater(
            AutoUpdateConfig {
                manifest_url: Some(format!("http://{address}/latest.json")),
                ..base_config()
            },
            root.path().to_str(),
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(3), updater.check())
                .await
                .unwrap()
                .is_err()
        );
        assert!(!updater.is_checking());
        assert_eq!(updater.consecutive_failures(), 1);
        assert!(!Path::new(&updater.paths.current_file).exists());
        assert!(!Path::new(&updater.paths.previous_file).exists());
    }
    #[tokio::test]
    async fn an_actual_inflight_check_rejects_reentry_then_stop_releases_its_guard_and_future() {
        let root = tempfile::tempdir().unwrap();
        let net = Arc::new(PendingNet {
            entered: tokio::sync::Notify::new(),
            dropped: AtomicBool::new(false),
        });
        let updater = Arc::new(scoped_updater(
            base_config(),
            root.path().to_str(),
            net.clone(),
        ));
        let active = updater.clone();
        let task = tokio::spawn(async move { active.check().await });
        tokio::time::timeout(Duration::from_secs(2), net.entered.notified())
            .await
            .unwrap();
        assert!(updater.is_checking());
        tokio::time::timeout(Duration::from_millis(100), updater.check())
            .await
            .unwrap()
            .unwrap();
        assert!(updater.is_checking());
        assert!(!net.dropped.load(Ordering::SeqCst));
        updater.stop();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!updater.is_checking());
        assert!(net.dropped.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn exact_exponential_retry_gate_and_six_hour_cap_keep_degraded_daemon_alive() {
        let root = tempfile::tempdir().unwrap();
        let failure = || {
            Ok(FetchResponse {
                status: 500,
                status_text: "Download failed".into(),
                body: vec![],
            })
        };
        let net = ScriptedNet::new(vec![Ok(manifest_body("1.0.2", "bbb")), failure()], vec![]);
        let mut updater = scoped_updater(
            AutoUpdateConfig {
                check_interval_ms: 10_000,
                ..base_config()
            },
            root.path().to_str(),
            net.clone(),
        );
        updater.set_clock(Arc::new(|| 100_000));
        updater.start();
        assert!(updater.check().await.is_err());
        assert_eq!(updater.consecutive_failures(), 1);
        assert_eq!(updater.next_check_at(), 120_000);
        assert_eq!(net.fetch_log.lock().unwrap().len(), 2);
        updater.check().await.unwrap();
        assert_eq!(net.fetch_log.lock().unwrap().len(), 2);
        assert!(updater.is_scheduled());
        updater.stop();
        for prior in [9, 99] {
            let root = tempfile::tempdir().unwrap();
            let net = ScriptedNet::new(vec![Ok(manifest_body("1.0.2", "bbb")), failure()], vec![]);
            let mut updater = scoped_updater(base_config(), root.path().to_str(), net);
            updater.set_clock(Arc::new(|| 100_000));
            updater.set_failure_state_for_test(prior, 0);
            updater.start();
            assert!(updater.check().await.is_err());
            assert!(updater.is_scheduled());
            assert_eq!(updater.consecutive_failures(), prior + 1);
            let heartbeat: Value = read_json_file(&updater.paths.runtime_file).await.unwrap();
            assert_eq!(heartbeat["status"], "degraded");
            assert!(updater.paths.runtime_file.ends_with("updater-runtime.json"));
            assert!(updater.next_check_at() - 100_000 <= 21_600_000);
            if prior == 99 {
                assert_eq!(updater.next_check_at() - 100_000, 21_600_000);
            }
            updater.stop();
        }
        assert_eq!(backoff_ms(60_000, 100), 21_600_000);
    }
    fn set_directory_mtime(path: &Path, seconds: u64) {
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .access_mode(windows_sys::Win32::Storage::FileSystem::FILE_WRITE_ATTRIBUTES)
                .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .unwrap()
        };
        #[cfg(not(windows))]
        let file = std::fs::File::open(path).unwrap();
        file.set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    }
    fn stale_version(updater: &Updater, version: &str, seconds: u64) -> PathBuf {
        let name = format!(
            "{version}_{}_{}",
            "a".repeat(40),
            uuid::Uuid::new_v4().simple()
        );
        let path = Path::new(&updater.paths.versions_dir).join(name);
        // GC verifies ownership/resources and never executes this fixture.
        native_package_version_for_test(
            &path,
            version,
            &"a".repeat(40),
            Some(&crate::utils::native_binary::fixture_binary(build_target())),
        );
        set_directory_mtime(&path, seconds);
        path
    }
    #[tokio::test]
    async fn real_gc_preserves_current_previous_and_removes_exactly_the_oldest_owned_version() {
        let root = tempfile::tempdir().unwrap();
        let updater = scoped_updater(
            base_config(),
            root.path().to_str(),
            ScriptedNet::new(vec![], vec![]),
        );
        let older = stale_version(&updater, "0.9.9", 10);
        let old = stale_version(&updater, "1.0.0", 20);
        updater.gc_old_versions().await;
        assert!(older.exists());
        assert!(old.exists());
        for (file, name) in [
            (&updater.paths.current_file, "1.0.2_current"),
            (&updater.paths.previous_file, "1.0.1_previous"),
        ] {
            std::fs::create_dir_all(Path::new(&updater.paths.versions_dir).join(name)).unwrap();
            write_pointer_file(file, name).await.unwrap();
        }
        let unrelated = Path::new(&updater.paths.versions_dir).join("unknown-user-directory");
        std::fs::create_dir_all(&unrelated).unwrap();
        updater.gc_old_versions().await;
        assert!(!older.exists());
        assert!(old.exists());
        assert!(Path::new(&updater.paths.versions_dir)
            .join("1.0.2_current")
            .exists());
        assert!(Path::new(&updater.paths.versions_dir)
            .join("1.0.1_previous")
            .exists());
        assert!(unrelated.exists());
        updater.gc_old_versions().await;
        assert!(!old.exists());
        assert!(unrelated.exists());
    }
    #[tokio::test]
    async fn already_current_success_fetches_only_manifest_clears_backoff_and_runs_real_gc() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![Ok(manifest_body("1.0.2", "aaa"))], vec![]);
        let mut updater = scoped_updater(base_config(), root.path().to_str(), net.clone());
        let commit = format!("{:0<40}", "aaa");
        native_package_version(
            &Path::new(&updater.paths.versions_dir).join("1.0.2_aaa"),
            "1.0.2",
            &commit,
        );
        write_pointer_file(&updater.paths.current_file, "1.0.2_aaa")
            .await
            .unwrap();
        std::fs::create_dir_all(
            Path::new(&updater.paths.collector_runtime_file)
                .parent()
                .unwrap(),
        )
        .unwrap();
        std::fs::write(&updater.paths.collector_runtime_file,json!({"status":"active","packageVersion":"1.0.2","gitCommit":commit,"pid":std::process::id(),"updatedAt":"2099-01-01T00:00:00Z"}).to_string()).unwrap();
        updater.set_pid_alive(Arc::new(|_| true));
        updater.set_failure_state_for_test(5, 0);
        let stale = stale_version(&updater, "1.0.0", 10);
        updater.check().await.unwrap();
        assert_eq!(net.fetch_log.lock().unwrap().len(), 1);
        assert!(net.exec_log.lock().unwrap().is_empty());
        assert_eq!(updater.consecutive_failures(), 0);
        assert_eq!(updater.next_check_at(), 0);
        assert!(!stale.exists());
        assert_eq!(
            read_pointer_file(&updater.paths.current_file)
                .await
                .as_deref(),
            Some("1.0.2_aaa")
        );
    }
    #[tokio::test]
    async fn current_version_resolution_uses_real_pointer_and_explicitly_refuses_node_legacy_fallback(
    ) {
        let root = tempfile::tempdir().unwrap();
        let updater = scoped_updater(
            base_config(),
            root.path().to_str(),
            ScriptedNet::new(vec![], vec![]),
        );
        assert!(updater.resolve_current_version_dir().await.is_none());
        let legacy = root.path().join("package/dist");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("index.js"), "legacy fixture").unwrap();
        assert!(updater.resolve_current_version_dir().await.is_none());
        let version = Path::new(&updater.paths.versions_dir).join("1.0.2_abc");
        std::fs::create_dir_all(&version).unwrap();
        write_pointer_file(&updater.paths.current_file, "1.0.2_abc")
            .await
            .unwrap();
        assert_eq!(
            updater.resolve_current_version_dir().await.as_deref(),
            version.to_str()
        );
    }
    type ExecObserver = dyn Fn(&ExecRequest) + Send + Sync;
    struct ObservedNet {
        scripted: Arc<ScriptedNet>,
        observe: Box<ExecObserver>,
    }
    #[async_trait]
    impl UpdaterNet for ObservedNet {
        async fn fetch(&self, url: &str, timeout: u64) -> Result<FetchResponse, String> {
            self.scripted.fetch(url, timeout).await
        }
        async fn exec(&self, request: &ExecRequest) -> Result<ExecOutput, CommandFailure> {
            (self.observe)(request);
            self.scripted.exec(request).await
        }
    }
    fn service_commands(net: &ScriptedNet) -> Vec<String> {
        net.exec_log
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, args)| {
                args.iter()
                    .find(|v| {
                        [
                            "restart-collector",
                            "start-collector",
                            "schedule-updater-restart",
                        ]
                        .contains(&v.as_str())
                    })
                    .cloned()
            })
            .collect()
    }
    fn attach_metrics(updater: &Updater, root: &Path) -> Arc<UpdaterMetrics> {
        let metrics = Arc::new(UpdaterMetrics::new(crate::updater::UpdaterMetricsOptions {
            data_dir: root.to_string_lossy().into_owned(),
            version: "1.0.0".into(),
            collector_pid_file: root.join("pid").to_string_lossy().into_owned(),
            user_id: "fixture".into(),
            collector_liveness: None,
            date_string: Some(Arc::new(|| "contract".into())),
            now_ms: Some(Arc::new(system_now_ms)),
            alarm_sender: None,
            ip: Some("127.0.0.1".into()),
        }));
        updater.set_metrics(metrics.clone());
        metrics
    }
    fn records(root: &Path, name: &str) -> Vec<Value> {
        std::fs::read_to_string(
            root.join("logs/metric_alarm")
                .join(format!("{name}-contract.jsonl")),
        )
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
    }
    fn install_current(updater: &Updater) {
        let commit = format!("{:0<40}", "aaa");
        native_package_version(
            &Path::new(&updater.paths.versions_dir).join("1.0.2_aaa"),
            "1.0.2",
            &commit,
        );
        std::fs::write(&updater.paths.current_file, "1.0.2_aaa\n").unwrap();
    }
    fn write_healthy_runtime(paths: &UpdaterPaths) {
        std::fs::create_dir_all(Path::new(&paths.collector_runtime_file).parent().unwrap())
            .unwrap();
        std::fs::write(&paths.collector_runtime_file,json!({"status":"active","packageVersion":"1.0.2","gitCommit":format!("{:0<40}","aaa"),"pid":std::process::id(),"updatedAt":"2099-01-01T00:00:00Z"}).to_string()).unwrap();
    }
    fn command_failure(
        message: &str,
        stdout: &str,
        stderr: Option<&str>,
        killed: bool,
    ) -> CommandFailure {
        CommandFailure {
            message: message.into(),
            stdout: Some(stdout.into()),
            stderr: stderr.map(str::to_owned),
            code: if killed { None } else { Some("1".into()) },
            killed: Some(killed),
            signal: if killed { Some("SIGTERM".into()) } else { None },
        }
    }
    #[tokio::test]
    async fn already_current_recovery_handoff_waits_for_success_bookkeeping_and_is_best_effort() {
        for handoff_fails in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let paths = build_paths(root.path().to_str().unwrap());
            let heartbeat = paths.runtime_file.clone();
            let observed = Arc::new(AtomicBool::new(false));
            let flag = observed.clone();
            let target = paths.clone();
            let scripted = ScriptedNet::new(
                vec![Ok(manifest_body("1.0.2", "aaa"))],
                if handoff_fails {
                    vec![
                        Ok(ExecOutput::default()),
                        Err(CommandFailure::message("handoff scheduling unavailable")),
                    ]
                } else {
                    vec![]
                },
            );
            let net = Arc::new(ObservedNet {
                scripted: scripted.clone(),
                observe: Box::new(move |request| {
                    assert_eq!(request.env["LOONGSUITE_PILOT_DATA_DIR"], target.data_dir);
                    assert_eq!(request.env["LOONGSUITE_PILOT_CACHE_DIR"], target.cache_dir);
                    if request.args.iter().any(|v| v == "start-collector") {
                        write_healthy_runtime(&target);
                    }
                    if request.args.iter().any(|v| v == "schedule-updater-restart") {
                        let state: Value =
                            serde_json::from_slice(&std::fs::read(&heartbeat).unwrap()).unwrap();
                        assert_eq!(state["version"], "1.0.2");
                        assert_eq!(state["consecutiveFailures"], 0);
                        flag.store(true, Ordering::SeqCst);
                    }
                }),
            });
            let mut updater = scoped_updater(base_config(), root.path().to_str(), net);
            install_current(&updater);
            updater.set_pid_alive(Arc::new(|_| true));
            updater.set_failure_state_for_test(5, 0);
            let metrics = attach_metrics(&updater, root.path());
            updater.check().await.unwrap();
            metrics.flush().await;
            assert_eq!(
                service_commands(&scripted),
                ["start-collector", "schedule-updater-restart"]
            );
            assert!(observed.load(Ordering::SeqCst));
            assert_eq!(updater.consecutive_failures(), 0);
            assert_eq!(updater.next_check_at(), 0);
            assert_eq!(scripted.fetch_log.lock().unwrap().len(), 1);
            assert!(records(root.path(), "pilot-updater-events")
                .iter()
                .any(
                    |v| v["event_type"] == "collector_restarted" && v["latest_version"] == "1.0.2"
                ));
            assert!(!records(root.path(), "pilot-updater-events")
                .iter()
                .any(|v| v["event_type"] == "update_failure"));
        }
    }
    #[tokio::test]
    async fn restart_failure_keeps_both_child_diagnostics_when_start_only_also_fails() {
        let root = tempfile::tempdir().unwrap();
        let restart = command_failure("restart timed out", "restart output", None, true);
        let recovery = command_failure(
            "start failed",
            "Unknown command: start-collector",
            Some("permission denied"),
            false,
        );
        let scripted = ScriptedNet::new(vec![], vec![Err(restart), Err(recovery)]);
        let updater = scoped_updater(base_config(), root.path().to_str(), scripted.clone());
        let metrics = attach_metrics(&updater, root.path());
        let error = updater
            .restart_collector("1.0.2", false, "")
            .await
            .unwrap_err();
        metrics.flush().await;
        assert!(error.contains("stdout=\"restart output\""));
        assert!(error.contains("killed=true"));
        assert!(error.contains("signal=SIGTERM"));
        assert!(error.contains("stdout=\"Unknown command: start-collector\""));
        assert!(error.contains("stderr=\"permission denied\""));
        assert!(error.contains("code=1"));
        assert!(error.contains("killed=false"));
        assert_eq!(
            service_commands(&scripted),
            ["restart-collector", "start-collector"]
        );
        let alarms = records(root.path(), "pilot-alarms");
        assert_eq!(alarms.len(), 1);
        assert_eq!(alarms[0]["alarm_type"], "UPDATER_FAILURE_ALARM");
        assert_eq!(alarms[0]["alarm_level"], "2");
        assert!(alarms[0]["alarm_message"]
            .as_str()
            .unwrap()
            .contains("Unknown command: start-collector"));
    }
    #[tokio::test]
    async fn public_start_only_recovery_api_keeps_ordered_structured_diagnostics() {
        let root = tempfile::tempdir().unwrap();
        let restart = command_failure("restart timed out", "restart output", None, true);
        let recovery = command_failure(
            "start failed",
            "start output",
            Some("permission denied"),
            false,
        );
        let scripted = ScriptedNet::new(vec![], vec![Err(recovery)]);
        let updater = scoped_updater(base_config(), root.path().to_str(), scripted);
        let error = updater
            .start_collector_for_recovery(&restart)
            .await
            .unwrap_err();
        let expected = [
            "stdout=\"restart output\"",
            "killed=true",
            "signal=SIGTERM",
            "stdout=\"start output\"",
            "stderr=\"permission denied\"",
            "code=1",
            "killed=false",
        ];
        let positions = expected.map(|part| error.find(part).unwrap());
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    }
    #[tokio::test]
    async fn public_windows_service_commands_preserve_file_argv_and_native_environment() {
        let root = tempfile::tempdir().unwrap();
        let scripted = ScriptedNet::new(vec![], vec![]);
        let expected_root = root.path().to_string_lossy().into_owned();
        let net = Arc::new(ObservedNet {
            scripted: scripted.clone(),
            observe: Box::new(move |request| {
                assert_eq!(request.env["LOONGSUITE_PILOT_DATA_DIR"], expected_root);
                assert_eq!(request.env["LOONGSUITE_PILOT_CACHE_DIR"], expected_root);
                assert_eq!(
                    request.env["AGENT_DATA_COLLECTION_CONFIG"],
                    Path::new(&expected_root)
                        .join("config.json")
                        .to_string_lossy()
                        .into_owned()
                );
                assert!(!request.env.contains_key("LOONGSUITE_PILOT_RESOURCE_ROOT"));
                assert!(!request.env.contains_key("LOONGSUITE_PILOT_INSTALL_INPUT"));
                assert_eq!(request.timeout_ms, 90_000);
            }),
        });
        let mut updater = scoped_updater(base_config(), root.path().to_str(), net);
        updater.platform = Platform::Win32;
        updater.paths.loongsuite_pilot_bin = r"C:\Users\Test User\pilot-service.ps1".into();
        updater.process_env.insert(
            "LOONGSUITE_PILOT_RESOURCE_ROOT".into(),
            "candidate-staging".into(),
        );
        updater.process_env.insert(
            "LOONGSUITE_PILOT_INSTALL_INPUT".into(),
            "candidate-input".into(),
        );
        for command in [
            "restart-collector",
            "start-collector",
            "schedule-updater-restart",
        ] {
            updater.run_collector_command(command).await.unwrap();
        }
        let calls = scripted.exec_log.lock().unwrap();
        assert_eq!(calls.len(), 3);
        for ((program, args), command) in calls.iter().zip([
            "restart-collector",
            "start-collector",
            "schedule-updater-restart",
        ]) {
            assert_eq!(program, "powershell.exe");
            assert_eq!(
                &args[..5],
                [
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    r"C:\Users\Test User\pilot-service.ps1"
                ]
            );
            assert_eq!(args[5], command);
            assert_eq!(
                args.len(),
                if command == "restart-collector" { 7 } else { 6 }
            );
        }
        assert_eq!(calls[0].1[6], "--defer-updater-restart");
    }

    fn archive_candidate(root: &Path, version: &str, commit: &str) -> (Vec<u8>, VersionManifest) {
        use sha2::Digest;
        use std::io::Write;
        let source = root.join("archive-source");
        // Candidate execution is explicitly supplied by UpdaterNet in these
        // archive component tests. Actual native process/caps/pin tests retain
        // their real executable; no execution claim is made for this resource.
        let mut manifest = native_package_version_for_test(
            &source,
            version,
            commit,
            Some(&crate::utils::native_binary::fixture_binary(build_target())),
        );
        let name = format!("loongsuite-pilot-{version}-{}", build_target());
        let format =
            super::super::super::release_manifest::ArchiveFormat::for_target(build_target());
        let body = match format {
            super::super::super::release_manifest::ArchiveFormat::TarGz => {
                let encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                let mut tar = tar::Builder::new(encoder);
                tar.append_dir_all(&name, &source).unwrap();
                tar.into_inner().unwrap().finish().unwrap()
            }
            super::super::super::release_manifest::ArchiveFormat::Zip => {
                let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)
                    .unix_permissions(0o755);
                zip.add_directory(format!("{name}/"), options).unwrap();
                for entry in walkdir::WalkDir::new(&source)
                    .min_depth(1)
                    .sort_by_file_name()
                {
                    let entry = entry.unwrap();
                    let relative = entry
                        .path()
                        .strip_prefix(&source)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    let destination = format!("{name}/{relative}");
                    if entry.file_type().is_dir() {
                        zip.add_directory(format!("{destination}/"), options)
                            .unwrap();
                    } else {
                        zip.start_file(destination, options).unwrap();
                        zip.write_all(&std::fs::read(entry.path()).unwrap())
                            .unwrap();
                    }
                }
                zip.finish().unwrap().into_inner()
            }
        };
        let asset = manifest.assets.get_mut(build_target()).unwrap();
        asset.sha256 = hex::encode(sha2::Sha256::digest(&body));
        asset.format = format;
        (body, manifest)
    }
    fn manifest_response(manifest: &VersionManifest) -> FetchResponse {
        FetchResponse {
            status: 200,
            status_text: "OK".into(),
            body: serde_json::to_vec(&LatestManifest {
                schema: 1,
                runtime: "rust".into(),
                edition: build_edition().into(),
                stable: manifest.clone(),
                canary: None,
            })
            .unwrap(),
        }
    }
    fn healthy_for(paths: &UpdaterPaths, manifest: &VersionManifest, pid: u32) {
        std::fs::create_dir_all(Path::new(&paths.collector_runtime_file).parent().unwrap())
            .unwrap();
        std::fs::write(&paths.collector_runtime_file,json!({"status":"active","packageVersion":manifest.version,"gitCommit":manifest.git_commit,"pid":pid,"updatedAt":"2099-01-01T00:00:00Z"}).to_string()).unwrap();
    }
    fn cached_candidate_archive() -> (Vec<u8>, VersionManifest) {
        static ARCHIVE: std::sync::OnceLock<(Vec<u8>, VersionManifest)> =
            std::sync::OnceLock::new();
        ARCHIVE
            .get_or_init(|| {
                let root = tempfile::tempdir().unwrap();
                archive_candidate(root.path(), "1.0.2", &format!("{:0<40}", "bbb"))
            })
            .clone()
    }
    #[tokio::test]
    async fn downloaded_native_archive_commits_install_and_upgrade_then_hands_off_with_fresh_success_heartbeat(
    ) {
        for upgrade in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let commit = format!("{:0<40}", "bbb");
            let (body, manifest) = cached_candidate_archive();
            let paths = build_paths(root.path().to_str().unwrap());
            let observed = Arc::new(AtomicBool::new(false));
            let handoff = observed.clone();
            let target = paths.clone();
            let package = manifest.clone();
            let scripted = ScriptedNet::new(
                vec![
                    Ok(manifest_response(&manifest)),
                    Ok(FetchResponse {
                        status: 200,
                        status_text: "OK".into(),
                        body,
                    }),
                ],
                preflight_outputs(&manifest),
            );
            let net = Arc::new(ObservedNet {
                scripted: scripted.clone(),
                observe: Box::new(move |request| {
                    assert_eq!(request.env["LOONGSUITE_PILOT_DATA_DIR"], target.data_dir);
                    assert_eq!(request.env["LOONGSUITE_PILOT_CACHE_DIR"], target.cache_dir);
                    assert_eq!(
                        request.env["AGENT_DATA_COLLECTION_CONFIG"],
                        Path::new(&target.data_dir)
                            .join("config.json")
                            .to_string_lossy()
                    );
                    if request.args == ["--version"] || request.args == ["check", "--json"] {
                        let resources = &request.env["LOONGSUITE_PILOT_RESOURCE_ROOT"];
                        assert_eq!(request.cwd.as_deref(), Some(resources.as_str()));
                        assert!(Path::new(resources).join("runtime-manifest.json").is_file());
                    }
                    if request.args.iter().any(|v| v == "restart-collector") {
                        let current = std::fs::read_to_string(&target.current_file).unwrap();
                        assert!(current
                            .trim()
                            .starts_with(&format!("{}_{}_", package.version, package.git_commit)));
                        let service = if request.program == "powershell.exe" {
                            &request.args[4]
                        } else {
                            &request.program
                        };
                        assert!(std::fs::read_to_string(service)
                            .unwrap()
                            .contains("native service"));
                        assert!(!request.env.contains_key("LOONGSUITE_PILOT_RESOURCE_ROOT"));
                        assert!(!request.env.contains_key("LOONGSUITE_PILOT_INSTALL_INPUT"));
                        healthy_for(&target, &package, std::process::id());
                    }
                    if request.args.iter().any(|v| v == "schedule-updater-restart") {
                        let state: Value =
                            serde_json::from_slice(&std::fs::read(&target.runtime_file).unwrap())
                                .unwrap();
                        assert_eq!(state["version"], "1.0.2");
                        assert_eq!(state["consecutiveFailures"], 0);
                        assert!(
                            state.get("nextCheckAt").is_none() || state["nextCheckAt"].is_null()
                        );
                        handoff.store(true, Ordering::SeqCst);
                    }
                }),
            });
            let mut updater = scoped_updater(base_config(), root.path().to_str(), net);
            updater.paths.loongsuite_pilot_bin = root
                .path()
                .join(if cfg!(windows) {
                    "bin/loongsuite-pilot-service.ps1"
                } else {
                    "bin/loongsuite-pilot"
                })
                .to_string_lossy()
                .into_owned();
            updater.set_pid_alive(Arc::new(|_| true));
            if upgrade {
                native_package_version(
                    &Path::new(&updater.paths.versions_dir).join("1.0.1_aaa"),
                    "1.0.1",
                    &format!("{:0<40}", "aaa"),
                );
                write_pointer_file(&updater.paths.current_file, "1.0.1_aaa")
                    .await
                    .unwrap();
            }
            let stale = stale_version(&updater, "0.9.9", 10);
            updater.set_failure_state_for_test(5, 0);
            let metrics = attach_metrics(&updater, root.path());
            updater.check().await.unwrap();
            metrics.flush().await;
            let current = read_pointer_file(&updater.paths.current_file)
                .await
                .unwrap();
            assert!(current.starts_with(&format!("1.0.2_{commit}_")));
            assert!(Path::new(&updater.paths.versions_dir)
                .join(&current)
                .join("runtime-manifest.json")
                .is_file());
            assert_eq!(
                read_pointer_file(&updater.paths.previous_file)
                    .await
                    .as_deref(),
                if upgrade { Some("1.0.1_aaa") } else { None }
            );
            assert!(observed.load(Ordering::SeqCst));
            assert_eq!(
                service_commands(&scripted),
                ["restart-collector", "schedule-updater-restart"]
            );
            assert_eq!(scripted.fetch_log.lock().unwrap().len(), 2);
            assert_eq!(updater.consecutive_failures(), 0);
            assert_eq!(updater.next_check_at(), 0);
            assert!(!stale.exists());
            let events = records(root.path(), "pilot-updater-events");
            assert!(events
                .iter()
                .any(|v| v["event_type"] == "download_verified"));
            assert!(events.iter().any(
                |v| v["event_type"] == "collector_restarted" && v["latest_version"] == "1.0.2"
            ));
            assert!(!events.iter().any(|v| v["event_type"] == "update_failure"));
            let service = std::fs::read_to_string(&updater.paths.loongsuite_pilot_bin).unwrap();
            if cfg!(windows) {
                assert!(service.starts_with('\u{feff}'));
            } else {
                assert!(service.contains(&updater.paths.data_dir));
                assert!(service.contains(&updater.paths.cache_dir));
            }
            assert!(std::fs::read_dir(&updater.paths.versions_dir)
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".unpack-")));
        }
    }

    #[tokio::test]
    async fn download_http_checksum_preflight_and_missing_sha_failures_never_publish_or_leak_temporary_roots(
    ) {
        for mode in ["http", "checksum", "preflight", "missing-sha"] {
            let root = tempfile::tempdir().unwrap();
            let mut manifest =
                super::super::super::release_manifest::fixture("1.0.2", &format!("{:0<40}", "bbb"));
            let (body, execs) = if mode == "preflight" {
                let (body, candidate) = cached_candidate_archive();
                manifest = candidate;
                (
                    body,
                    vec![Err(CommandFailure::message("native preflight rejected"))],
                )
            } else {
                (b"untrusted archive".to_vec(), vec![])
            };
            if mode == "missing-sha" {
                manifest
                    .assets
                    .get_mut(build_target())
                    .unwrap()
                    .sha256
                    .clear();
            }
            let mut responses = vec![Ok(manifest_response(&manifest))];
            if mode != "missing-sha" {
                responses.push(Ok(FetchResponse {
                    status: if mode == "http" { 404 } else { 200 },
                    status_text: "synthetic download".into(),
                    body,
                }));
            }
            let scripted = ScriptedNet::new(responses, execs);
            let updater = scoped_updater(base_config(), root.path().to_str(), scripted.clone());
            let metrics = attach_metrics(&updater, root.path());
            let error = updater.check().await.unwrap_err();
            metrics.flush().await;
            assert!(!error.is_empty());
            if mode == "checksum" {
                assert!(error.contains("SHA-256 mismatch"));
            }
            if mode == "preflight" {
                assert!(error.contains("native preflight rejected"));
            }
            assert!(!Path::new(&updater.paths.current_file).exists());
            assert!(!Path::new(&updater.paths.previous_file).exists());
            assert!(service_commands(&scripted).is_empty());
            assert_eq!(updater.consecutive_failures(), 1);
            assert!(!updater.is_checking());
            let events = records(root.path(), "pilot-updater-events");
            assert!(events.iter().any(|v| v["event_type"] == "update_failure"));
            assert!(!events
                .iter()
                .any(|v| v["event_type"] == "collector_restarted"));
            if let Ok(entries) = std::fs::read_dir(&updater.paths.versions_dir) {
                assert!(entries
                    .map(Result::unwrap)
                    .all(|entry| !entry.file_name().to_string_lossy().starts_with(".unpack-")));
            }
            assert_eq!(
                scripted.fetch_log.lock().unwrap().len(),
                if mode == "missing-sha" { 1 } else { 2 }
            );
        }
    }
    #[tokio::test]
    async fn actual_daemon_check_boundary_handles_http_and_network_result_errors_without_stopping()
    {
        let root = tempfile::tempdir().unwrap();
        let scripted = ScriptedNet::new(
            vec![
                Ok(FetchResponse {
                    status: 500,
                    status_text: "manifest unavailable".into(),
                    body: b"{}".to_vec(),
                }),
                Err("network timeout from synthetic transport".into()),
            ],
            vec![],
        );
        let updater = scoped_updater(base_config(), root.path().to_str(), scripted.clone());
        std::fs::write(&updater.config_path,r#"{"autoUpdate":{"enabled":true,"manifestUrl":"https://example.invalid/latest.json","checkIntervalMs":1000}}"#).unwrap();
        let metrics = attach_metrics(&updater, root.path());
        updater.start();
        updater.scheduled_check().await;
        assert!(updater.is_scheduled());
        assert!(!updater.is_checking());
        assert_eq!(updater.consecutive_failures(), 1);
        updater.set_failure_state_for_test(0, 0);
        updater.scheduled_check().await;
        assert!(updater.is_scheduled());
        assert!(!updater.is_checking());
        assert_eq!(updater.consecutive_failures(), 1);
        metrics.flush().await;
        let alarms = records(root.path(), "pilot-alarms");
        assert!(alarms
            .iter()
            .any(|v| v["alarm_message"].as_str().unwrap().contains("500")));
        assert!(alarms.iter().any(|v| v["alarm_message"]
            .as_str()
            .unwrap()
            .contains("network timeout")));
        assert_eq!(scripted.fetch_log.lock().unwrap().len(), 2);
        updater.stop();
        assert!(!updater.is_scheduled());
    }
    async fn physical_collector_fixture(
        root: &Path,
    ) -> (crate::utils::candidate_process::CandidateChild, u32) {
        use crate::utils::candidate_process::tests::{fixture, ready};
        let directory = root.join("physical-collector");
        std::fs::create_dir_all(&directory).unwrap();
        let mut command = fixture(&directory, "wait");
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let scope = crate::utils::candidate_process::CandidateChild::spawn(&mut command).unwrap();
        let pid = ready(&directory).await;
        (scope, pid)
    }
    fn component_current(updater: &Updater, version: &str, commit: &str, name: &str) {
        native_package_version_for_test(
            &Path::new(&updater.paths.versions_dir).join(name),
            version,
            commit,
            Some(&crate::utils::native_binary::fixture_binary(build_target())),
        );
        std::fs::write(&updater.paths.current_file, format!("{name}\n")).unwrap();
    }
    #[tokio::test]
    async fn current_collector_recovery_handles_missing_wrong_version_wrong_commit_and_failed_health(
    ) {
        for mode in [
            "old-version",
            "old-build",
            "timeout-recovery",
            "no-health",
            "unknown-command",
        ] {
            let root = tempfile::tempdir().unwrap();
            let paths = build_paths(root.path().to_str().unwrap());
            let target = paths.clone();
            let mode_owned = mode.to_owned();
            let (_scope, new_pid) = physical_collector_fixture(root.path()).await;
            let execs = match mode {
                "timeout-recovery" => vec![
                    Err(command_failure(
                        "restart timed out",
                        "restart output",
                        None,
                        true,
                    )),
                    Ok(ExecOutput::default()),
                ],
                "unknown-command" => vec![
                    Err(command_failure(
                        "restart timed out",
                        "restart output",
                        None,
                        true,
                    )),
                    Err(command_failure(
                        "start failed",
                        "Unknown command: start-collector",
                        Some("permission denied"),
                        false,
                    )),
                ],
                _ => vec![],
            };
            let scripted = ScriptedNet::new(vec![Ok(manifest_body("1.0.2", "aaa"))], execs);
            let net = Arc::new(ObservedNet {
                scripted: scripted.clone(),
                observe: Box::new(move |request| {
                    let restart = request.args.iter().any(|v| v == "restart-collector");
                    let start = request.args.iter().any(|v| v == "start-collector");
                    if (restart && ["old-version", "old-build"].contains(&mode_owned.as_str()))
                        || (start && mode_owned == "timeout-recovery")
                    {
                        let record = json!({"status":"active","packageVersion":"1.0.2","gitCommit":format!("{:0<40}","aaa"),"pid":new_pid,"updatedAt":"2099-01-01T00:00:00Z"});
                        std::fs::create_dir_all(
                            Path::new(&target.collector_runtime_file).parent().unwrap(),
                        )
                        .unwrap();
                        std::fs::write(&target.collector_runtime_file, record.to_string()).unwrap();
                    }
                }),
            });
            let mut updater = scoped_updater(base_config(), root.path().to_str(), net);
            component_current(&updater, "1.0.2", &format!("{:0<40}", "aaa"), "1.0.2_aaa");
            updater.set_pid_alive(Arc::new(crate::utils::is_process_alive));
            updater.set_health_timeout_ms(0);
            let metrics = attach_metrics(&updater, root.path());
            let stale = stale_version(&updater, "0.9.9", 10);
            if mode != "no-health" {
                std::fs::create_dir_all(
                    Path::new(&updater.paths.collector_runtime_file)
                        .parent()
                        .unwrap(),
                )
                .unwrap();
                std::fs::write(&updater.paths.collector_runtime_file,json!({"status":"active","packageVersion":if mode=="old-version"{"1.0.1"}else{"1.0.2"},"gitCommit":"old","pid":std::process::id(),"updatedAt":"2099-01-01T00:00:00Z"}).to_string()).unwrap();
            }
            let result = updater.check().await;
            metrics.flush().await;
            let events = records(root.path(), "pilot-updater-events");
            let commands = service_commands(&scripted);
            if ["no-health", "unknown-command"].contains(&mode) {
                assert!(result.is_err());
                assert_eq!(updater.consecutive_failures(), 1);
                assert!(stale.exists());
                assert!(!commands.iter().any(|v| v == "schedule-updater-restart"));
                assert!(!events
                    .iter()
                    .any(|v| v["event_type"] == "collector_restarted"));
                assert!(
                    events
                        .iter()
                        .any(|v| v["event_type"] == "update_failure"
                            && v["consecutive_failures"] == 1)
                );
                if mode == "unknown-command" {
                    assert!(events.iter().any(|v| v["event_type"] == "update_failure"
                        && v["error"]
                            .as_str()
                            .unwrap()
                            .contains("stdout=\"Unknown command: start-collector\"")));
                    assert_eq!(commands, ["restart-collector", "start-collector"]);
                } else {
                    assert_eq!(commands, ["start-collector"]);
                }
            } else {
                result.unwrap();
                assert_eq!(updater.consecutive_failures(), 0);
                assert!(!stale.exists());
                assert!(events
                    .iter()
                    .any(|v| v["event_type"] == "collector_restarted"
                        && v["latest_version"] == "1.0.2"));
                assert_eq!(
                    commands,
                    if mode == "timeout-recovery" {
                        vec![
                            "restart-collector",
                            "start-collector",
                            "schedule-updater-restart",
                        ]
                    } else {
                        vec!["restart-collector", "schedule-updater-restart"]
                    }
                );
                let runtime: Value = read_json_file(&updater.paths.collector_runtime_file)
                    .await
                    .unwrap();
                assert_eq!(runtime["pid"], new_pid);
            }
        }
    }
    #[tokio::test]
    async fn downloaded_candidate_without_health_rolls_back_and_never_reports_restart_or_runs_gc() {
        let root = tempfile::tempdir().unwrap();
        let (body, manifest) = cached_candidate_archive();
        let scripted = ScriptedNet::new(
            vec![
                Ok(manifest_response(&manifest)),
                Ok(FetchResponse {
                    status: 200,
                    status_text: "OK".into(),
                    body,
                }),
            ],
            preflight_outputs(&manifest),
        );
        let mut updater = scoped_updater(base_config(), root.path().to_str(), scripted.clone());
        updater.paths.loongsuite_pilot_bin = root
            .path()
            .join("bin/pilot-service")
            .to_string_lossy()
            .into_owned();
        updater.set_health_timeout_ms(0);
        let stale = stale_version(&updater, "0.9.9", 10);
        let metrics = attach_metrics(&updater, root.path());
        assert!(updater.check().await.is_err());
        metrics.flush().await;
        assert_eq!(
            service_commands(&scripted),
            ["restart-collector", "start-collector"]
        );
        assert!(stale.exists());
        assert!(!Path::new(&updater.paths.current_file).exists());
        assert!(!Path::new(&updater.paths.previous_file).exists());
        assert_eq!(updater.consecutive_failures(), 1);
        let events = records(root.path(), "pilot-updater-events");
        assert!(!events
            .iter()
            .any(|v| v["event_type"] == "collector_restarted"));
        assert!(events
            .iter()
            .any(|v| v["event_type"] == "update_failure" && v["consecutive_failures"] == 1));
        assert!(!Path::new(&updater.paths.loongsuite_pilot_bin).exists());
    }
    #[tokio::test]
    async fn exact_restart_alarm_contracts_preserve_fresh_stage_ignore_stale_and_remain_quiet_on_success(
    ) {
        for mode in ["fresh", "stale", "timeout", "no-health", "success"] {
            let root = tempfile::tempdir().unwrap();
            let failure = if mode == "timeout" {
                command_failure("Command failed", "", None, true)
            } else if mode == "stale" {
                CommandFailure::message("spawn ENOENT")
            } else if mode == "no-health" {
                command_failure(
                    "Command failed",
                    "[restart-failure] target=collector stage=task-missing\n",
                    Some("Service manager failed to restart collector\n"),
                    false,
                )
            } else {
                command_failure(
                    "Command failed",
                    "[restart-failure] target=collector stage=register-denied\n",
                    Some("Service manager failed to restart collector\n"),
                    false,
                )
            };
            let execs = match mode {
                "success" => vec![],
                "no-health" => vec![Err(failure), Ok(ExecOutput::default())],
                _ => vec![Err(failure.clone()), Err(failure)],
            };
            let scripted = ScriptedNet::new(vec![], execs);
            let mut updater = scoped_updater(base_config(), root.path().to_str(), scripted);
            updater.set_pid_alive(Arc::new(|pid| pid == std::process::id()));
            updater.set_health_timeout_ms(0);
            let metrics = attach_metrics(&updater, root.path());
            if mode == "success" {
                write_healthy_runtime(&updater.paths);
            }
            if ["fresh", "stale", "no-health"].contains(&mode) {
                let breadcrumb = Path::new(&updater.paths.data_dir)
                    .join("logs/last-restart-failure-collector.json");
                std::fs::create_dir_all(breadcrumb.parent().unwrap()).unwrap();
                std::fs::write(breadcrumb,json!({"schema":1,"ts":if mode=="stale"{system_now_ms()/1000-900}else{system_now_ms()/1000},"target":"collector","stage":if mode=="no-health"{"task-missing"}else{"register-denied"},"init_type":"taskscheduler","detail":if mode=="stale"{"stale evidence from fifteen minutes ago"}else if mode=="no-health"{"scheduled task is not registered"}else{"self-heal failed: Access is denied."},"diag":{"definition_owner":"BUILTIN\\Administrators"}}).to_string()).unwrap();
            }
            let result = updater.restart_collector("1.0.2", false, "").await;
            metrics.flush().await;
            let alarms = records(root.path(), "pilot-alarms");
            if mode == "success" {
                result.unwrap();
                assert!(alarms.is_empty());
                continue;
            }
            assert!(result.is_err());
            assert_eq!(alarms.len(), 1);
            assert_eq!(alarms[0]["alarm_type"], "UPDATER_FAILURE_ALARM");
            assert_eq!(alarms[0]["alarm_level"], "2");
            let message = alarms[0]["alarm_message"].as_str().unwrap();
            match mode {
                "fresh" => {
                    assert!(message.contains("stage=register-denied"));
                    assert!(message.contains("reason=\"self-heal failed: Access is denied.\""));
                    assert!(message.contains("definition_owner=\"BUILTIN\\Administrators\""));
                    assert!(message.contains(
                        "stdout=\"[restart-failure] target=collector stage=register-denied\""
                    ));
                }
                "stale" => {
                    assert!(message.contains("stage=unknown"));
                    assert!(!message.contains("stale evidence"));
                    assert!(!message.contains("register-denied"));
                }
                "timeout" => {
                    let crumb =
                        read_restart_failure(&updater.paths.data_dir, RestartTarget::Collector)
                            .await
                            .unwrap();
                    assert_eq!(crumb.stage, "timeout");
                    assert_eq!(crumb.target, "collector");
                    assert!(message.contains("stage=timeout"));
                }
                "no-health" => {
                    assert!(message.contains("stage=task-missing"));
                    assert!(message.contains("health check failed after start-collector recovery"));
                    assert!(message.contains("runtime record not found"));
                }
                _ => unreachable!(),
            }
        }
    }
    #[tokio::test]
    async fn start_only_recovery_retains_the_full_default_thirty_second_health_window() {
        let root = tempfile::tempdir().unwrap();
        let began = Arc::new(tokio::sync::Notify::new());
        let notify = began.clone();
        let scripted = ScriptedNet::new(
            vec![],
            vec![
                Err(command_failure("restart timed out", "", None, true)),
                Ok(ExecOutput::default()),
            ],
        );
        let net = Arc::new(ObservedNet {
            scripted,
            observe: Box::new(move |request| {
                if request.args.iter().any(|v| v == "start-collector") {
                    notify.notify_one();
                }
            }),
        });
        let mut updater = scoped_updater(base_config(), root.path().to_str(), net);
        updater.set_pid_alive(Arc::new(|pid| pid == std::process::id()));
        assert_eq!(updater.health_timeout_ms, 30_000);
        let paths = updater.paths.clone();
        let updater = Arc::new(updater);
        let task = updater.clone();
        let pending = tokio::spawn(async move { task.restart_collector("1.0.2", false, "").await });
        tokio::time::timeout(Duration::from_secs(2), began.notified())
            .await
            .unwrap();
        let start = tokio::time::Instant::now();
        tokio::time::sleep(Duration::from_millis(29_500)).await;
        assert!(!pending.is_finished());
        write_healthy_runtime(&paths);
        tokio::time::timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(start.elapsed() >= Duration::from_millis(29_500));
    }
    #[tokio::test]
    async fn real_service_publication_io_failure_preserves_both_pointers_layout_and_owned_entrypoint(
    ) {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("candidate");
        let manifest = native_package_version_for_test(
            &staging,
            "1.0.2",
            &format!("{:0<40}", "bbb"),
            Some(&crate::utils::native_binary::fixture_binary(build_target())),
        );
        let scripted = ScriptedNet::new(vec![], preflight_outputs(&manifest));
        let mut updater = scoped_updater(base_config(), root.path().to_str(), scripted);
        updater.paths.loongsuite_pilot_bin = root
            .path()
            .join("bin/pilot-service")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(
            Path::new(&updater.paths.loongsuite_pilot_bin)
                .parent()
                .unwrap(),
        )
        .unwrap();
        std::fs::write(&updater.paths.loongsuite_pilot_bin, "old owned service").unwrap();
        let layout = Path::new(&updater.paths.loongsuite_pilot_bin)
            .with_file_name("loongsuite-pilot-layout.json");
        let old_layout=json!({"cacheDir":updater.paths.cache_dir,"dataDir":updater.paths.data_dir,"keep":"user-layout-field"}).to_string();
        std::fs::write(&layout, &old_layout).unwrap();
        write_pointer_file(&updater.paths.current_file, "1.0.1_aaa")
            .await
            .unwrap();
        write_pointer_file(&updater.paths.previous_file, "1.0.0_zzz")
            .await
            .unwrap();
        let permissions = std::fs::metadata(&updater.paths.loongsuite_pilot_bin)
            .unwrap()
            .permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&updater.paths.loongsuite_pilot_bin, readonly).unwrap();
        let result = updater.activate_staged(&staging, &manifest).await;
        std::fs::set_permissions(&updater.paths.loongsuite_pilot_bin, permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(
            read_pointer_file(&updater.paths.current_file)
                .await
                .as_deref(),
            Some("1.0.1_aaa")
        );
        assert_eq!(
            read_pointer_file(&updater.paths.previous_file)
                .await
                .as_deref(),
            Some("1.0.0_zzz")
        );
        assert_eq!(
            std::fs::read_to_string(&updater.paths.loongsuite_pilot_bin).unwrap(),
            "old owned service"
        );
        assert_eq!(std::fs::read_to_string(layout).unwrap(), old_layout);
    }
    #[tokio::test]
    async fn windows_service_file_publication_has_bom_cmd_and_preserves_unowned_legacy_script() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("candidate");
        let manifest = native_package_version_for_test(
            &staging,
            "1.0.2",
            &format!("{:0<40}", "bbb"),
            Some(&crate::utils::native_binary::fixture_binary(build_target())),
        );
        let scripted = ScriptedNet::new(vec![], preflight_outputs(&manifest));
        let mut updater = scoped_updater(base_config(), root.path().to_str(), scripted);
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        updater.paths.loongsuite_pilot_bin = bin
            .join("loongsuite-pilot-service.ps1")
            .to_string_lossy()
            .into_owned();
        let legacy = bin.join("loongsuite-pilot.ps1");
        std::fs::write(&legacy, "unowned user legacy script").unwrap();
        let transaction = updater.activate_staged(&staging, &manifest).await.unwrap();
        let service = std::fs::read(&updater.paths.loongsuite_pilot_bin).unwrap();
        assert!(service.starts_with(b"\xef\xbb\xbf"));
        assert!(String::from_utf8_lossy(&service).contains("native service"));
        let launcher = std::fs::read_to_string(bin.join("loongsuite-pilot.cmd")).unwrap();
        assert!(launcher.contains("-File \"%~dp0loongsuite-pilot-service.ps1\" %*"));
        assert_eq!(
            std::fs::read_to_string(&legacy).unwrap(),
            "unowned user legacy script"
        );
        drop(transaction);
        assert!(!Path::new(&updater.paths.loongsuite_pilot_bin).exists());
        assert!(!bin.join("loongsuite-pilot.cmd").exists());
        assert_eq!(
            std::fs::read_to_string(legacy).unwrap(),
            "unowned user legacy script"
        );
    }
    #[tokio::test]
    async fn fixture_installations_do_not_share_the_default_home_service_lock() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let unused = ScriptedNet::new(vec![], vec![]);
        // Constructor-only comparison proves the source of the old alias;
        // neither default HOME path is read, locked, or created.
        let default_one =
            super::Updater::with_net(base_config(), first.path().to_str(), unused.clone());
        let default_two = super::Updater::with_net(base_config(), second.path().to_str(), unused);
        assert_eq!(
            default_one.paths.loongsuite_pilot_bin,
            default_two.paths.loongsuite_pilot_bin
        );
        let foreign_entry = foreign.path().join("bin/pilot-service");
        let acquired = Arc::new(tokio::sync::Notify::new());
        let entered = acquired.clone();
        let release = Arc::new(tokio::sync::Notify::new());
        let release_task = release.clone();
        let locked_path = foreign_entry.clone();
        let owner = tokio::spawn(async move {
            crate::deployment::native_install::with_service_lock(&locked_path, || async {
                entered.notify_one();
                release_task.notified().await;
                Ok(())
            })
            .await
            .unwrap()
        });
        tokio::time::timeout(Duration::from_secs(2), acquired.notified())
            .await
            .unwrap();
        let blocked_net = Arc::new(PendingNet {
            entered: tokio::sync::Notify::new(),
            dropped: AtomicBool::new(false),
        });
        let mut blocked =
            super::Updater::with_net(base_config(), first.path().to_str(), blocked_net.clone());
        blocked.paths.loongsuite_pilot_bin = foreign_entry.to_string_lossy().into_owned();
        blocked.config_path = first
            .path()
            .join("config.json")
            .to_string_lossy()
            .into_owned();
        let blocked = Arc::new(blocked);
        let blocked_check = blocked.clone();
        let blocked_task = tokio::spawn(async move { blocked_check.check().await });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), blocked_net.entered.notified())
                .await
                .is_err()
        );
        assert!(!blocked_task.is_finished());
        assert!(blocked.is_checking());
        blocked.stop();
        tokio::time::timeout(Duration::from_secs(2), blocked_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let isolated_net = Arc::new(PendingNet {
            entered: tokio::sync::Notify::new(),
            dropped: AtomicBool::new(false),
        });
        let isolated = Arc::new(scoped_updater(
            base_config(),
            second.path().to_str(),
            isolated_net.clone(),
        ));
        assert!(Path::new(&isolated.paths.loongsuite_pilot_bin).starts_with(second.path()));
        assert!(Path::new(&isolated.config_path).starts_with(second.path()));
        let running = isolated.clone();
        let own_task = tokio::spawn(async move { running.check().await });
        // Foreign install remains locked throughout; our network boundary must
        // still be reached within the unchanged original two-second budget.
        tokio::time::timeout(Duration::from_secs(2), isolated_net.entered.notified())
            .await
            .unwrap();
        isolated.stop();
        tokio::time::timeout(Duration::from_secs(2), own_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(isolated_net.dropped.load(Ordering::SeqCst));
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), owner)
            .await
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn actual_native_upgrade_cleans_only_owned_windows_shadow_after_commit_and_retries_current_install(
    ) {
        for mode in ["owned", "foreign", "cancel-before-commit", "current-retry"] {
            let root = tempfile::tempdir().unwrap();
            let bin = root.path().join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let service = bin.join("loongsuite-pilot-service.ps1");
            let legacy = bin.join("loongsuite-pilot.ps1");
            let mut official = Vec::new();
            std::io::Read::read_to_end(
                &mut flate2::read::GzDecoder::new(
                    &include_bytes!("../../tests/fixtures/updater/official-v1-windows-cli.ps1.gz")
                        [..],
                ),
                &mut official,
            )
            .unwrap();
            let original = if mode == "foreign" {
                b"user script with same command name\n".to_vec()
            } else {
                official.clone()
            };
            std::fs::write(&legacy, &original).unwrap();
            let (body, manifest) = cached_candidate_archive();
            let scripted = ScriptedNet::new(
                vec![
                    Ok(manifest_response(&manifest)),
                    Ok(FetchResponse {
                        status: 200,
                        status_text: "OK".into(),
                        body,
                    }),
                    Ok(manifest_response(&manifest)),
                ],
                preflight_outputs(&manifest),
            );
            let paths = build_paths(root.path().to_str().unwrap());
            let target = paths.clone();
            let package = manifest.clone();
            let legacy_during_restart = legacy.clone();
            let reached = Arc::new(tokio::sync::Notify::new());
            let signal = reached.clone();
            let cancel = mode == "cancel-before-commit";
            let net = Arc::new(ObservedNet {
                scripted: scripted.clone(),
                observe: Box::new(move |request| {
                    if request
                        .args
                        .iter()
                        .any(|value| value == "restart-collector")
                    {
                        // Still present throughout rollback-capable activation.
                        assert!(legacy_during_restart.is_file());
                        signal.notify_one();
                        if !cancel {
                            healthy_for(&target, &package, std::process::id());
                        }
                    }
                }),
            });
            let mut updater = scoped_updater(base_config(), root.path().to_str(), net);
            updater.platform = Platform::Win32;
            updater.paths.loongsuite_pilot_bin = service.to_string_lossy().into_owned();
            updater.set_pid_alive(Arc::new(|_| true));
            if cancel {
                let updater = Arc::new(updater);
                let runner = updater.clone();
                let task = tokio::spawn(async move { runner.check().await });
                tokio::time::timeout(Duration::from_secs(2), reached.notified())
                    .await
                    .unwrap();
                assert!(updater.is_checking());
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
                assert_eq!(std::fs::read(&legacy).unwrap(), original);
                assert!(!service.exists());
                assert!(!bin.join("loongsuite-pilot.cmd").exists());
                assert!(!Path::new(&paths.current_file).exists());
                assert!(!updater.is_checking());
                continue;
            }
            updater.check().await.unwrap();
            assert!(std::fs::read(&service)
                .unwrap()
                .starts_with(b"\xef\xbb\xbf"));
            assert!(std::fs::read_to_string(bin.join("loongsuite-pilot.cmd"))
                .unwrap()
                .contains("-File \"%~dp0loongsuite-pilot-service.ps1\" %*"));
            if mode == "foreign" {
                assert_eq!(std::fs::read(&legacy).unwrap(), original);
            } else {
                assert!(!legacy.exists());
            }
            let current = std::fs::read(&paths.current_file).unwrap();
            if mode == "current-retry" {
                // Simulate process exit immediately after the native commit
                // but before best-effort cleanup. No next upgrade is required.
                std::fs::write(&legacy, official).unwrap();
                updater.check().await.unwrap();
                assert!(!legacy.exists());
                assert_eq!(std::fs::read(&paths.current_file).unwrap(), current);
                assert_eq!(scripted.fetch_log.lock().unwrap().len(), 3);
            }
        }
    }
}
