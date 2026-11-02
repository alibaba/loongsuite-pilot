//! Fixed ef8953 contracts with real clocks, heartbeat files and restart subprocesses.
use super::*;
use std::sync::atomic::AtomicUsize;
#[derive(Clone, Copy)]
enum Probe {
    Alive(u32),
    Missing,
    Mismatch,
    Recovered(u32),
}
fn process(probe: Probe) -> ProcessLiveness {
    let mut p = ProcessLiveness {
        running: false,
        pid: None,
        source: crate::utils::ProcessLivenessSource::None,
        reason: "pid file is missing; no matching process found".into(),
        pid_file_state: None,
        pid_file_process_alive: None,
        pid_file_command: None,
        pid_file_command_matched: None,
    };
    match probe {
        Probe::Alive(pid) | Probe::Recovered(pid) => {
            p.running = true;
            p.pid = Some(pid);
            p.pid_file_process_alive = Some(true);
            p.pid_file_command_matched = Some(true);
            p.reason = "matching updater process".into();
            p.source = if matches!(probe, Probe::Recovered(_)) {
                crate::utils::ProcessLivenessSource::ProcessScan
            } else {
                crate::utils::ProcessLivenessSource::PidFile
            };
        }
        Probe::Missing => {}
        Probe::Mismatch => {
            p.pid = Some(12345);
            p.pid_file_process_alive = Some(true);
            p.pid_file_command_matched = Some(false);
            p.pid_file_command = Some("synthetic unrelated command".into());
        }
    }
    p
}
struct Harness {
    root: tempfile::TempDir,
    wd: Arc<UpdaterWatchdog>,
    alarms: Arc<AlarmManager>,
    probe: Arc<Mutex<Probe>>,
    probes: Arc<AtomicUsize>,
}
fn fixture(root: &Path, hold: bool) -> String {
    let invocation = root.join("invocations.log");
    let release = root.join("release");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"));
        let file = root.join("fixture pilot");
        let wait = if hold {
            format!("while [ ! -e {} ]; do sleep 0.01; done\n", quote(&release))
        } else {
            String::new()
        };
        fs_write(&file,&format!("#!/bin/sh\n[ \"$1\" = restart-updater ] || exit 79\nprintf '%s|%s\\n' \"$1\" \"$$\" >> {}\n{}exit 0\n",quote(&invocation),wait));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        file.to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
        let file = root.join("fixture pilot.ps1");
        let wait = if hold {
            format!(
                "while (-not (Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 10 }}\r\n",
                quote(&release)
            )
        } else {
            String::new()
        };
        fs_write(&file,&format!("\u{feff}param([string]$Action)\r\nif ($Action -ne 'restart-updater') {{ exit 79 }}\r\nAdd-Content -LiteralPath {} -Value \"$Action|$PID\" -Encoding UTF8\r\n{}exit 0\r\n",quote(&invocation),wait));
        file.to_string_lossy().into_owned()
    }
}
fn fs_write(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
}
impl Harness {
    fn new(probe: Probe, hold: bool, configure: impl FnOnce(&mut UpdaterWatchdogOptions)) -> Self {
        let root = tempfile::tempdir().unwrap();
        let bin = fixture(root.path(), hold);
        let alarms = Arc::new(AlarmManager::new("127.0.0.1", "fixture", "test-user"));
        let probe = Arc::new(Mutex::new(probe));
        let observed = probe.clone();
        let probes = Arc::new(AtomicUsize::new(0));
        let counter = probes.clone();
        let mut opts = UpdaterWatchdogOptions {
            enabled: true,
            data_dir: root.path().to_string_lossy().into_owned(),
            loongsuite_pilot_bin: Some(bin),
            interval_ms: None,
            stale_heartbeat_ms: None,
            startup_grace_ms: Some(0),
            sleep_wake_grace_ms: None,
            restart_cooldown_ms: None,
            alarm_manager: Some(alarms.clone()),
            updater_liveness: Some(Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                let p = *observed.lock().unwrap();
                Box::pin(async move { process(p) })
            })),
            restart_command: None,
            now_ms: None,
        };
        configure(&mut opts);
        Self {
            root,
            wd: Arc::new(UpdaterWatchdog::new(opts)),
            alarms,
            probe,
            probes,
        }
    }
    fn heartbeat(&self, pid: u32, age_ms: i64) {
        std::fs::create_dir_all(self.root.path().join("logs")).unwrap();
        fs_write(
            &self.root.path().join("logs/updater-runtime.json"),
            &serde_json::json!({
   "status":"running","pid":pid,"version":"1.0.2","versionDir":"1.0.2_bbb","gitCommit":"bbb",
   "updatedAt":chrono::DateTime::from_timestamp_millis(now_ms()-age_ms).unwrap().to_rfc3339(),
   "consecutiveFailures":0})
            .to_string(),
        );
        fs_write(
            &self.root.path().join("loongsuite-pilot-updater.pid"),
            "12345\n",
        );
    }
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.path().join("invocations.log"))
            .unwrap_or_default()
            .lines()
            .map(|v| v.trim_start_matches('\u{feff}').to_owned())
            .collect()
    }
    fn no_restart_or_alarm(&self) {
        assert!(self.calls().is_empty());
        assert!(self.alarms.serialize().is_empty());
    }
    async fn wait_for_child(&self, first: &tokio::task::JoinHandle<UpdaterWatchdogResult>) {
        // PS5.1 cold startup on Windows ARM may exceed five seconds.
        // This is fixture readiness; the production command still has 90 seconds.
        let readiness = if cfg!(windows) { 20 } else { 5 };
        tokio::time::timeout(Duration::from_secs(readiness), async {
            while self.calls().is_empty() {
                assert!(
                    !first.is_finished(),
                    "restart ended before its fixture invocation marker: {}",
                    serde_json::to_string(&self.alarms.serialize()).unwrap()
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("isolated restart command did not start");
    }
}
fn alarm_type(alarms: &[crate::metrics::AlarmEntry], kind: &str) {
    assert_eq!(alarms[0].alarm_type, kind);
    assert_eq!(alarms[0].input_name.as_deref(), Some("updater"));
}
#[tokio::test]
async fn health_l125_matching_process_and_heartbeat() {
    let h = Harness::new(Probe::Alive(12345), false, |_| {});
    h.heartbeat(12345, 0);
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::Healthy
    );
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l145_missing_process_restarts_and_service_alarm() {
    let h = Harness::new(Probe::Missing, false, |_| {});
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartAttempted
    );
    assert_eq!(h.calls().len(), 1);
    assert!(h.calls()[0].starts_with("restart-updater|"));
    alarm_type(&h.alarms.serialize(), "SERVICE_NOT_RUNNING_ALARM");
}
#[tokio::test]
async fn health_l165_overlapping_check_does_not_alarm_or_spawn() {
    assert_eq!(COMMAND_TIMEOUT_MS, 90000);
    let h = Harness::new(Probe::Missing, true, |_| {});
    let wd = h.wd.clone();
    let first = tokio::spawn(async move { wd.run_check().await });
    h.wait_for_child(&first).await;
    assert_eq!(
        h.alarms
            .serialize()
            .iter()
            .filter(|a| a.alarm_type == "SERVICE_NOT_RUNNING_ALARM")
            .count(),
        1
    );
    assert_eq!(
        h.wd.run_check().await,
        UpdaterWatchdogResult {
            status: UpdaterWatchdogStatus::RestartRateLimited,
            reason: Some("check already in flight".into()),
            restarted: Some(false)
        }
    );
    assert!(h.alarms.serialize().is_empty());
    assert_eq!(h.calls().len(), 1);
    fs_write(&h.root.path().join("release"), "release");
    assert_eq!(
        first.await.unwrap().status,
        UpdaterWatchdogStatus::RestartAttempted
    );
}
#[tokio::test]
async fn health_l206_constructor_startup_grace_missing() {
    let h = Harness::new(Probe::Missing, false, |o| o.startup_grace_ms = Some(60000));
    assert_eq!(h.wd.run_check().await.status, UpdaterWatchdogStatus::Grace);
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l228_constructor_startup_grace_mismatch() {
    let h = Harness::new(Probe::Mismatch, false, |o| o.startup_grace_ms = Some(60000));
    h.heartbeat(12345, 0);
    assert_eq!(h.wd.run_check().await.status, UpdaterWatchdogStatus::Grace);
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l258_real_sleep_wake_grace_missing_process() {
    let h = Harness::new(Probe::Alive(12345), false, |o| {
        o.interval_ms = Some(1000);
        o.sleep_wake_grace_ms = Some(5000);
    });
    h.heartbeat(12345, 0);
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::Healthy
    );
    tokio::time::sleep(Duration::from_secs(7)).await;
    *h.probe.lock().unwrap() = Probe::Missing;
    assert_eq!(h.wd.run_check().await.status, UpdaterWatchdogStatus::Grace);
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l298_recovered_process_pid_matches_heartbeat() {
    let h = Harness::new(Probe::Recovered(456), false, |_| {});
    h.heartbeat(456, 0);
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::Healthy
    );
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l323_unrelated_command_restarts_with_failure_alarm() {
    let h = Harness::new(Probe::Mismatch, false, |_| {});
    h.heartbeat(12345, 0);
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartAttempted
    );
    assert_eq!(h.calls().len(), 1);
    alarm_type(&h.alarms.serialize(), "UPDATER_FAILURE_ALARM");
}
#[tokio::test]
async fn health_l354_stale_heartbeat_outside_grace() {
    let h = Harness::new(Probe::Alive(12345), false, |o| {
        o.stale_heartbeat_ms = Some(1000)
    });
    h.heartbeat(12345, 10000);
    let r = h.wd.run_check().await;
    assert_eq!(r.status, UpdaterWatchdogStatus::RestartAttempted);
    assert!(r.reason.unwrap().contains("stale"));
    alarm_type(&h.alarms.serialize(), "UPDATER_FAILURE_ALARM");
}
#[tokio::test]
async fn health_l378_constructor_startup_grace_stale_heartbeat() {
    let h = Harness::new(Probe::Alive(12345), false, |o| {
        o.stale_heartbeat_ms = Some(1000);
        o.startup_grace_ms = Some(60000);
    });
    h.heartbeat(12345, 10000);
    assert_eq!(h.wd.run_check().await.status, UpdaterWatchdogStatus::Grace);
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l395_real_sleep_wake_grace_stale_heartbeat() {
    let h = Harness::new(Probe::Alive(12345), false, |o| {
        o.interval_ms = Some(1000);
        o.stale_heartbeat_ms = Some(1000);
        o.sleep_wake_grace_ms = Some(5000);
    });
    h.heartbeat(12345, 0);
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::Healthy
    );
    tokio::time::sleep(Duration::from_secs(7)).await;
    assert_eq!(h.wd.run_check().await.status, UpdaterWatchdogStatus::Grace);
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l420_repeated_restarts_rate_limited() {
    let h = Harness::new(Probe::Missing, false, |o| {
        o.restart_cooldown_ms = Some(60000)
    });
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartAttempted
    );
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartRateLimited
    );
    assert_eq!(h.calls().len(), 1);
}
#[tokio::test]
async fn health_l776_disabled_checks_nothing() {
    let h = Harness::new(Probe::Missing, false, |o| o.enabled = false);
    assert_eq!(
        h.wd.run_check().await,
        UpdaterWatchdogResult {
            status: UpdaterWatchdogStatus::Disabled,
            reason: None,
            restarted: None
        }
    );
    assert_eq!(h.probes.load(Ordering::SeqCst), 0);
    h.no_restart_or_alarm();
}
#[tokio::test]
async fn health_l787_agentshell_checks_nothing() {
    let h = Harness::new(Probe::Missing, false, |_| {});
    fs_write(
        &h.root.path().join("current"),
        "1.1.20-agentshell_abcdef0\n",
    );
    assert_eq!(
        h.wd.run_check().await,
        UpdaterWatchdogResult {
            status: UpdaterWatchdogStatus::Disabled,
            reason: None,
            restarted: None
        }
    );
    assert_eq!(h.probes.load(Ordering::SeqCst), 0);
    h.no_restart_or_alarm();
}
