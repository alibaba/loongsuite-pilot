//! Frozen watchdog failure/stop contracts using isolated real child processes.
//! Only L564 injects a shorter process timeout to stay inside its original 60s
//! cooldown; L536 exercises the actual default command and its full 90s budget.
use super::*;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Harness {
    root: tempfile::TempDir,
    wd: Arc<UpdaterWatchdog>,
    alarms: Arc<AlarmManager>,
}
#[derive(Clone, Copy)]
enum CommandMode {
    Fail,
    Hold,
    Success,
    FreshFlat,
    FreshArray,
    Missing,
}
fn missing() -> ProcessLiveness {
    ProcessLiveness {
        running: false,
        pid: None,
        source: crate::utils::ProcessLivenessSource::None,
        reason: "missing pid file".into(),
        pid_file_state: None,
        pid_file_process_alive: None,
        pid_file_command: None,
        pid_file_command_matched: None,
    }
}
fn breadcrumb(ts: Value, stage: &str, detail: &str, array: bool) -> Value {
    let diag = if array {
        json!([{"Key":"task_state","Value":"Ready"},
               {"Key":"definition_owner","Value":"BUILTIN\\Administrators"}])
    } else {
        json!({"task_state":"Ready","definition_owner":"BUILTIN\\Administrators"})
    };
    json!({"schema":1,"ts":ts,"target":"updater","stage":stage,
           "init_type":"taskscheduler","detail":detail,"diag":diag})
}
fn make_script(root: &Path, mode: CommandMode) -> String {
    std::fs::create_dir_all(root.join("logs")).unwrap();
    let calls = root.join("calls.txt");
    let file = root.join(if cfg!(windows) {
        "failure pilot.ps1"
    } else {
        "failure pilot"
    });
    if matches!(mode, CommandMode::Missing) {
        return file.to_string_lossy().into_owned();
    }
    let template = breadcrumb(
        json!("TIMESTAMP"),
        "register-denied",
        "self-heal failed: Access is denied.",
        matches!(mode, CommandMode::FreshArray),
    )
    .to_string();
    let (prefix, suffix) = template.split_once("\"TIMESTAMP\"").unwrap();
    let failure =
        crate::utils::restart_failure_path(root.to_str().unwrap(), RestartTarget::Updater);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let mut script = format!("#!/bin/sh\n[ \"$#\" -eq 1 ] && [ \"$1\" = restart-updater ] || exit 79\nprintf '%s|%s\\n' \"$1\" \"$$\" >> {}\n", q(&calls.to_string_lossy()));
        if matches!(mode, CommandMode::FreshFlat | CommandMode::FreshArray) {
            script.push_str(&format!(
                "ts=$(date +%s)\nprintf '\\357\\273\\277%s%s%s\\n' {} \"$ts\" {} > {}\n",
                q(prefix),
                q(suffix),
                q(&failure)
            ));
        }
        if matches!(mode, CommandMode::Hold) {
            script.push_str("while :; do sleep 0.1; done\n");
        } else if matches!(mode, CommandMode::Success) {
            script.push_str("exit 0\n");
        } else {
            script.push_str("printf '%s\\n' '[restart-failure] target=updater stage=register-denied'\nprintf '%s\\n' 'Service manager failed to restart updater' >&2\nexit 1\n");
        }
        std::fs::write(&file, script).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(windows)]
    {
        let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let mut script = format!("\u{feff}param([string]$Action)\r\nif ($Action -ne 'restart-updater' -or $args.Count -ne 0) {{ exit 79 }}\r\nAdd-Content -LiteralPath {} -Value \"$Action|$PID\" -Encoding UTF8\r\n", q(&calls.to_string_lossy()));
        if matches!(mode, CommandMode::FreshFlat | CommandMode::FreshArray) {
            script.push_str(&format!("$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()\r\n$body = {} + [string]$now + {}\r\nSet-Content -LiteralPath {} -Value $body -Encoding UTF8\r\n",
                q(prefix), q(suffix), q(&failure)));
        }
        if matches!(mode, CommandMode::Hold) {
            script.push_str("while ($true) { Start-Sleep -Milliseconds 100 }\r\n");
        } else if matches!(mode, CommandMode::Success) {
            script.push_str("exit 0\r\n");
        } else {
            script.push_str("[Console]::Out.WriteLine('[restart-failure] target=updater stage=register-denied')\r\n[Console]::Error.WriteLine('Service manager failed to restart updater')\r\nexit 1\r\n");
        }
        std::fs::write(&file, script).unwrap();
    }
    file.to_string_lossy().into_owned()
}
impl Harness {
    fn new(mode: CommandMode, configure: impl FnOnce(&mut UpdaterWatchdogOptions)) -> Self {
        let root = tempfile::tempdir().unwrap();
        let bin = make_script(root.path(), mode);
        let alarms = Arc::new(AlarmManager::new("127.0.0.1", "fixture", "watchdog-user"));
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
            updater_liveness: Some(Arc::new(|_| Box::pin(async { missing() }))),
            restart_command: None,
            now_ms: None,
        };
        configure(&mut opts);
        Self {
            root,
            wd: Arc::new(UpdaterWatchdog::new(opts)),
            alarms,
        }
    }
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.path().join("calls.txt"))
            .unwrap_or_default()
            .lines()
            .map(|s| s.trim_start_matches('\u{feff}').into())
            .collect()
    }
    async fn child(&self) -> u32 {
        let readiness = if cfg!(windows) { 20 } else { 5 };
        tokio::time::timeout(Duration::from_secs(readiness), async {
            loop {
                if let Some(pid) = self
                    .calls()
                    .first()
                    .and_then(|s| s.rsplit_once('|'))
                    .and_then(|(_, s)| s.parse().ok())
                {
                    return pid;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("isolated real restart child never became ready")
    }
    fn write_breadcrumb(&self, value: Value) {
        let file = crate::utils::restart_failure_path(
            self.root.path().to_str().unwrap(),
            RestartTarget::Updater,
        );
        std::fs::write(file, format!("\u{feff}{value}\n")).unwrap();
    }
    fn failure_message(&self) -> String {
        let alarms = self.alarms.serialize();
        let item = alarms
            .iter()
            .find(|a| {
                a.alarm_type == "UPDATER_FAILURE_ALARM"
                    && a.alarm_message.contains("restart command failed")
            })
            .expect("failure alarm missing");
        assert_eq!(item.input_name.as_deref(), Some("updater"));
        item.alarm_message.clone()
    }
}
fn alive(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    system
        .process(pid)
        .is_some_and(|p| p.status() != sysinfo::ProcessStatus::Zombie)
}
async fn exited(pid: u32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while alive(pid) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cancelled or expired fixture child remained alive");
}
async fn pending_check(h: &Harness) -> tokio::task::JoinHandle<UpdaterWatchdogResult> {
    let wd = h.wd.clone();
    tokio::spawn(async move { wd.run_check().await })
}
#[tokio::test]
async fn failure_l435_real_failed_command_records_updater_alarm() {
    let h = Harness::new(CommandMode::Fail, |_| {});
    let result = h.wd.run_check().await;
    assert_eq!(result.status, UpdaterWatchdogStatus::RestartFailed);
    assert_eq!(result.restarted, Some(false));
    assert_eq!(h.calls().len(), 1);
    assert!(h.failure_message().contains("exit=1"));
}
#[tokio::test]
async fn failure_l457_fresh_bom_flat_and_ps51_array_diagnostics_and_both_streams() {
    for mode in [CommandMode::FreshFlat, CommandMode::FreshArray] {
        let h = Harness::new(mode, |_| {});
        assert_eq!(
            h.wd.run_check().await.status,
            UpdaterWatchdogStatus::RestartFailed
        );
        let message = h.failure_message();
        for part in [
            "stage=register-denied",
            "reason=\"self-heal failed: Access is denied.\"",
            "init_type=taskscheduler",
            "task_state=\"Ready\"",
            "definition_owner=\"BUILTIN\\Administrators\"",
            "exit=1",
            "stdout=\"[restart-failure] target=updater stage=register-denied\"",
            "stderr=\"Service manager failed to restart updater\"",
        ] {
            assert!(message.contains(part), "missing {part}: {message}");
        }
    }
}
#[tokio::test]
async fn failure_l506_stale_prior_attempt_is_not_current_failure_evidence() {
    let h = Harness::new(CommandMode::Missing, |_| {});
    h.write_breadcrumb(breadcrumb(
        json!(now_ms() / 1000 - 600),
        "register-denied",
        "stale evidence from ten minutes ago",
        false,
    ));
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartFailed
    );
    let message = h.failure_message();
    assert!(message.contains("stage=unknown"), "{message}");
    assert!(!message.contains("register-denied"), "{message}");
    assert!(!message.contains("stale evidence"), "{message}");
    assert!(h.calls().is_empty());
}
#[tokio::test]
async fn failure_l536_default_ninety_second_timeout_kills_real_child_and_writes_stage() {
    assert_eq!(COMMAND_TIMEOUT_MS, 90_000);
    let h = Harness::new(CommandMode::Hold, |_| {});
    let started = std::time::Instant::now();
    let check = pending_check(&h).await;
    let pid = h.child().await;
    assert!(alive(pid));
    let result = tokio::time::timeout(Duration::from_secs(110), check)
        .await
        .unwrap()
        .unwrap();
    assert!(
        started.elapsed() >= Duration::from_secs(90),
        "default timeout was shortened"
    );
    assert_eq!(result.status, UpdaterWatchdogStatus::RestartFailed);
    let message = h.failure_message();
    assert!(message.contains("stage=timeout"), "{message}");
    assert!(message.contains("killed=true"), "{message}");
    assert!(message.contains("exit=ETIMEDOUT"), "{message}");
    let breadcrumb = read_restart_failure(h.root.path().to_str().unwrap(), RestartTarget::Updater)
        .await
        .unwrap();
    assert_eq!(breadcrumb.stage, "timeout");
    assert!(is_restart_failure_fresh(&breadcrumb, now_ms() as f64, None));
    assert_eq!(h.calls().len(), 1);
    exited(pid).await;
}
#[tokio::test]
async fn failure_l564_real_timeout_breadcrumb_survives_original_sixty_second_cooldown() {
    // The original source fixes cooldown at 60s. Its fake timeout is immediate.
    // Use a real shorter child timeout solely here, keeping cooldown exactly 60s;
    // L536 separately proves the untouched production default really waits 90s.
    let h = Harness::new(CommandMode::Hold, |opts| {
        opts.restart_cooldown_ms = Some(60_000);
        let bin = opts.loongsuite_pilot_bin.clone().unwrap();
        opts.restart_command = Some(Arc::new(move || {
            let command = restart_process_command(&bin);
            Box::pin(async move {
                let timeout = Duration::from_secs(if cfg!(windows) { 30 } else { 2 });
                run_restart_process(command?, timeout).await
            })
        }));
    });
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartFailed
    );
    let pid = h.child().await;
    exited(pid).await;
    assert!(h.failure_message().contains("stage=timeout"));
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartRateLimited
    );
    let service = h
        .alarms
        .serialize()
        .into_iter()
        .rfind(|a| a.alarm_type == "SERVICE_NOT_RUNNING_ALARM")
        .unwrap();
    assert_eq!(service.input_name.as_deref(), Some("updater"));
    assert!(service
        .alarm_message
        .contains("last_restart_failure: stage=timeout"));
    assert_eq!(h.calls().len(), 1);
}
#[tokio::test]
async fn failure_l589_stop_aborts_real_in_flight_child_without_failure_alarm() {
    let h = Harness::new(CommandMode::Hold, |_| {});
    let check = pending_check(&h).await;
    let pid = h.child().await;
    assert!(alive(pid));
    let before = h.alarms.serialize();
    assert_eq!(
        before
            .iter()
            .filter(|a| a.alarm_type == "SERVICE_NOT_RUNNING_ALARM")
            .count(),
        1
    );
    h.wd.stop();
    let result = tokio::time::timeout(Duration::from_secs(3), check)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status, UpdaterWatchdogStatus::RestartFailed);
    assert_eq!(result.reason.as_deref(), Some("aborted by stop"));
    assert_eq!(result.restarted, Some(false));
    exited(pid).await;
    assert!(h
        .alarms
        .serialize()
        .iter()
        .all(|a| a.alarm_type != "UPDATER_FAILURE_ALARM"));
    assert!(
        read_restart_failure(h.root.path().to_str().unwrap(), RestartTarget::Updater)
            .await
            .is_none()
    );
    assert_eq!(h.calls().len(), 1);
}
#[tokio::test]
async fn failure_l627_stopped_watchdog_never_spawns_restart() {
    let h = Harness::new(CommandMode::Success, |_| {});
    h.wd.stop();
    let result = h.wd.run_check().await;
    assert_eq!(result.status, UpdaterWatchdogStatus::Disabled);
    assert_eq!(result.reason.as_deref(), Some("stopped"));
    assert!(h.calls().is_empty());
    assert!(h.alarms.serialize().is_empty());
}
#[tokio::test]
async fn failure_l641_stop_during_real_health_socket_io_cannot_spawn() {
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = server.local_addr().unwrap();
    let h = Harness::new(CommandMode::Success, |opts| {
        opts.updater_liveness = Some(Arc::new(move |_| {
            Box::pin(async move {
                let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
                stream.write_all(&[1]).await.unwrap();
                let mut release = [0];
                let _ = stream.read_exact(&mut release).await;
                missing()
            })
        }));
    });
    let check = pending_check(&h).await;
    let (mut peer, _) = tokio::time::timeout(Duration::from_secs(5), server.accept())
        .await
        .unwrap()
        .unwrap();
    let mut probe = [0];
    peer.read_exact(&mut probe).await.unwrap();
    assert_eq!(probe, [1]);
    h.wd.stop();
    let _ = peer.write_all(&[1]).await;
    let result = tokio::time::timeout(Duration::from_secs(3), check)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status, UpdaterWatchdogStatus::RestartFailed);
    assert_eq!(result.reason.as_deref(), Some("aborted by stop"));
    assert_eq!(result.restarted, Some(false));
    assert!(h.calls().is_empty());
    assert!(h.alarms.serialize().is_empty());
}
#[tokio::test]
async fn failure_l674_previous_attempt_still_enriches_pre_restart_service_alarm() {
    let h = Harness::new(CommandMode::Success, |_| {});
    h.write_breadcrumb(breadcrumb(
        json!(now_ms() / 1000 - 300),
        "task-missing",
        "scheduled task LoongsuitePilotUpdater does not exist",
        false,
    ));
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartAttempted
    );
    let service = h
        .alarms
        .serialize()
        .into_iter()
        .find(|a| a.alarm_type == "SERVICE_NOT_RUNNING_ALARM")
        .unwrap();
    assert_eq!(service.input_name.as_deref(), Some("updater"));
    assert!(service
        .alarm_message
        .contains("last_restart_failure: stage=task-missing"));
    assert!(service
        .alarm_message
        .contains("reason=\"scheduled task LoongsuitePilotUpdater does not exist\""));
    assert_eq!(h.calls().len(), 1);
}
#[cfg(windows)]
#[test]
fn failure_l700_windows_default_service_script_and_installed_powershell_arguments() {
    let home = crate::utils::resolve_home("~");
    let expected = Path::new(&home).join(".local/bin/loongsuite-pilot-service.ps1");
    let bin = default_pilot_bin();
    assert_eq!(Path::new(&bin), expected.as_path());
    // Inspect the actual native command without launching any installed service.
    let command = restart_process_command(&bin).unwrap();
    let system = std::env::var_os("SystemRoot").unwrap();
    let powershell = Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    assert_eq!(command.as_std().get_program(), powershell.as_os_str());
    let args = command
        .as_std()
        .get_args()
        .map(|s| s.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        args,
        [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &bin,
            "restart-updater"
        ]
    );
}
#[cfg(windows)]
#[tokio::test]
async fn failure_l724_real_powershell_restarts_explicit_script_with_correct_action() {
    let h = Harness::new(CommandMode::Success, |_| {});
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::RestartAttempted
    );
    let calls = h.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].starts_with("restart-updater|"));
}
#[cfg(windows)]
#[tokio::test]
async fn failure_l754_windows_heartbeat_pid_mismatch_does_not_restart() {
    let h = Harness::new(CommandMode::Success, |opts| {
        opts.updater_liveness = Some(Arc::new(|_| {
            Box::pin(async {
                let mut p = missing();
                p.running = true;
                p.pid = Some(12345);
                p.source = crate::utils::ProcessLivenessSource::PidFile;
                p.pid_file_process_alive = Some(true);
                p.pid_file_command_matched = Some(true);
                p
            })
        }));
    });
    std::fs::write(
        h.root.path().join("loongsuite-pilot-updater.pid"),
        "12345\n",
    )
    .unwrap();
    std::fs::write(h.root.path().join("logs/updater-runtime.json"), json!({
        "status":"running","pid":67890,"version":"1.0.2","updatedAt":chrono::Utc::now().to_rfc3339(),
        "consecutiveFailures":0}).to_string()).unwrap();
    assert_eq!(
        h.wd.run_check().await.status,
        UpdaterWatchdogStatus::Healthy
    );
    assert!(h.calls().is_empty());
    assert!(h.alarms.serialize().is_empty());
}
