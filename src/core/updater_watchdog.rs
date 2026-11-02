//! Collector-side updater liveness watchdog. Port of `updater-watchdog.ts`.
//!
//! It does not download packages. It observes the updater pid and heartbeat
//! and asks `loongsuite-pilot restart-updater` to recover.

use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::task::JoinHandle;

use crate::metrics::{AlarmContext, AlarmManager};
use crate::updater::{updater_runtime_path, UpdaterRuntimeState};
use crate::utils::{
    check_process_liveness, describe_restart_command_error, is_restart_command_timeout,
    is_restart_failure_fresh, read_json_file, read_restart_failure, sanitize_alarm_text,
    summarize_restart_failure, write_restart_failure, ProcessLiveness, RestartCommandError,
    RestartExitCode, RestartFailureWrite, RestartTarget, UPDATER_PROCESS_PATTERNS,
};

use super::{fields, logger};

const DEFAULT_INTERVAL_MS: u64 = 60_000;
const DEFAULT_STALE_HEARTBEAT_MS: u64 = 3 * 60_000;
const DEFAULT_STARTUP_GRACE_MS: u64 = 3 * 60_000;
const DEFAULT_SLEEP_WAKE_GRACE_MS: u64 = 3 * 60_000;
const DEFAULT_RESTART_COOLDOWN_MS: u64 = 10 * 60_000;
const COMMAND_TIMEOUT_MS: u64 = 90_000;
const RECENT_RESTART_FAILURE_MS: i64 = 30 * 60_000;

pub type BoxFut<T> = Pin<Box<dyn std::future::Future<Output = T> + Send>>;
pub type UpdaterLivenessProbe = Arc<dyn Fn(&str) -> BoxFut<ProcessLiveness> + Send + Sync>;
pub type UpdaterRestartCommand =
    Arc<dyn Fn() -> BoxFut<Result<(String, String), Box<RestartCommandError>>> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterWatchdogStatus {
    Disabled,
    Healthy,
    MissingProcess,
    CommandMismatch,
    MissingHeartbeat,
    StaleHeartbeat,
    PidMismatch,
    Grace,
    RestartRateLimited,
    RestartAttempted,
    RestartFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdaterWatchdogResult {
    pub status: UpdaterWatchdogStatus,
    pub reason: Option<String>,
    pub restarted: Option<bool>,
}

pub struct UpdaterWatchdogOptions {
    pub enabled: bool,
    pub data_dir: String,
    pub loongsuite_pilot_bin: Option<String>,
    pub interval_ms: Option<u64>,
    pub stale_heartbeat_ms: Option<u64>,
    pub startup_grace_ms: Option<u64>,
    pub sleep_wake_grace_ms: Option<u64>,
    pub restart_cooldown_ms: Option<u64>,
    pub alarm_manager: Option<Arc<AlarmManager>>,
    pub updater_liveness: Option<UpdaterLivenessProbe>,
    pub restart_command: Option<UpdaterRestartCommand>,
    pub now_ms: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
}

pub struct UpdaterWatchdog {
    enabled: bool,
    data_dir: String,
    interval_ms: u64,
    stale_heartbeat_ms: u64,
    startup_grace_ms: u64,
    sleep_wake_grace_ms: u64,
    restart_cooldown_ms: u64,
    alarm_manager: Option<Arc<AlarmManager>>,
    liveness: UpdaterLivenessProbe,
    restart_command: UpdaterRestartCommand,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    started_at: Mutex<i64>,
    last_tick_at: Mutex<i64>,
    sleep_wake_grace_until: Mutex<i64>,
    last_restart_at: Mutex<i64>,
    checking: AtomicBool,
    stopping: AtomicBool,
    stop_generation: tokio::sync::watch::Sender<u64>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

impl UpdaterWatchdog {
    pub fn new(opts: UpdaterWatchdogOptions) -> Self {
        let bin = opts.loongsuite_pilot_bin.unwrap_or_else(default_pilot_bin);
        let liveness = opts.updater_liveness.unwrap_or_else(|| {
            Arc::new(|pid_file: &str| {
                let pid_file = pid_file.to_string();
                Box::pin(async move { check_process_liveness(&pid_file, UPDATER_PROCESS_PATTERNS) })
                    as BoxFut<_>
            })
        });
        let restart_bin = bin.clone();
        let restart_command = opts.restart_command.unwrap_or_else(|| {
            Arc::new(move || {
                let bin = restart_bin.clone();
                Box::pin(async move { run_restart_command(&bin).await }) as BoxFut<_>
            })
        });
        let now_ms = opts.now_ms.unwrap_or_else(|| Arc::new(now_ms));
        let started_at = now_ms();
        Self {
            enabled: opts.enabled,
            data_dir: opts.data_dir,
            interval_ms: opts.interval_ms.unwrap_or(DEFAULT_INTERVAL_MS),
            stale_heartbeat_ms: opts
                .stale_heartbeat_ms
                .unwrap_or(DEFAULT_STALE_HEARTBEAT_MS),
            startup_grace_ms: opts.startup_grace_ms.unwrap_or(DEFAULT_STARTUP_GRACE_MS),
            sleep_wake_grace_ms: opts
                .sleep_wake_grace_ms
                .unwrap_or(DEFAULT_SLEEP_WAKE_GRACE_MS),
            restart_cooldown_ms: opts
                .restart_cooldown_ms
                .unwrap_or(DEFAULT_RESTART_COOLDOWN_MS),
            alarm_manager: opts.alarm_manager,
            liveness,
            restart_command,
            now_ms,
            started_at: Mutex::new(started_at),
            last_tick_at: Mutex::new(0),
            sleep_wake_grace_until: Mutex::new(0),
            last_restart_at: Mutex::new(0),
            checking: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stop_generation: tokio::sync::watch::channel(0).0,
            timer: Mutex::new(None),
        }
    }

    pub fn start(self: &Arc<Self>) {
        if !self.enabled {
            logger("UpdaterWatchdog").info("updater-watchdog disabled", None);
            return;
        }
        if is_agentshell(&self.data_dir) {
            logger("UpdaterWatchdog")
                .info("updater-watchdog disabled for agentshell version", None);
            return;
        }
        *self.started_at.lock().expect("start") = (self.now_ms)();
        *self.last_tick_at.lock().expect("tick") = 0;
        self.stopping.store(false, Ordering::SeqCst);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let _ = this.run_check().await;
        });
        let this = Arc::clone(self);
        *self.timer.lock().expect("timer") = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(this.interval_ms.max(1)));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if this.stopping.load(Ordering::SeqCst) {
                    break;
                }
                let _ = this.run_check().await;
            }
        }));
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_generation
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        if let Some(task) = self.timer.lock().expect("timer").take() {
            task.abort();
        }
    }

    pub async fn run_check(&self) -> UpdaterWatchdogResult {
        let stop = self.stop_generation.subscribe();
        let generation = *stop.borrow();
        if !self.enabled || is_agentshell(&self.data_dir) {
            return result(UpdaterWatchdogStatus::Disabled, None, None);
        }
        if self.stopping.load(Ordering::SeqCst) {
            return result(
                UpdaterWatchdogStatus::Disabled,
                Some("stopped".into()),
                None,
            );
        }
        if self.checking.swap(true, Ordering::SeqCst) {
            return result(
                UpdaterWatchdogStatus::RestartRateLimited,
                Some("check already in flight".into()),
                Some(false),
            );
        }
        // Cancellation drops the command future (and its kill_on_drop child),
        // including the untracked first check started by start().
        let _checking = CheckingGuard(&self.checking);
        tokio::select! {
            biased;
            _ = wait_for_stop_generation(stop, generation) => result(
                UpdaterWatchdogStatus::RestartFailed,
                Some("aborted by stop".into()),
                Some(false),
            ),
            outcome = self.run_check_locked() => outcome,
        }
    }

    async fn run_check_locked(&self) -> UpdaterWatchdogResult {
        let now = (self.now_ms)();
        let last_tick = *self.last_tick_at.lock().expect("tick");
        if last_tick > 0
            && now - last_tick > self.interval_ms as i64 + self.sleep_wake_grace_ms as i64
        {
            *self.sleep_wake_grace_until.lock().expect("grace") =
                now + self.sleep_wake_grace_ms as i64;
        }
        *self.last_tick_at.lock().expect("tick") = now;
        if self.stopping.load(Ordering::SeqCst) {
            return result(
                UpdaterWatchdogStatus::RestartFailed,
                Some("aborted by stop".into()),
                Some(false),
            );
        }
        let process = self.read_process().await;
        if !process.running {
            if self.in_grace(now) {
                return result(UpdaterWatchdogStatus::Grace, Some(process.reason), None);
            }
            self.record_service(&self.with_last_failure(&process.reason).await);
            return self
                .restart(UpdaterWatchdogStatus::MissingProcess, &process.reason)
                .await;
        }
        if !process.command_ok {
            let reason = format!("updater pid {} command mismatch", process.pid.unwrap_or(0));
            if self.in_grace(now) {
                return result(UpdaterWatchdogStatus::Grace, Some(reason), None);
            }
            self.record_failure(&self.with_last_failure(&reason).await);
            return self
                .restart(UpdaterWatchdogStatus::CommandMismatch, &reason)
                .await;
        }
        let heartbeat: Option<UpdaterRuntimeState> =
            read_json_file(&updater_runtime_path(&self.data_dir)).await;
        if self.stopping.load(Ordering::SeqCst) {
            return result(
                UpdaterWatchdogStatus::RestartFailed,
                Some("aborted by stop".into()),
                Some(false),
            );
        }
        let Some(heartbeat) = heartbeat else {
            let reason = "updater heartbeat is missing";
            if self.in_grace(now) {
                return result(UpdaterWatchdogStatus::Grace, Some(reason.into()), None);
            }
            self.record_failure(&self.with_last_failure(reason).await);
            return self
                .restart(UpdaterWatchdogStatus::MissingHeartbeat, reason)
                .await;
        };
        if !cfg!(windows) {
            if let Some(pid) = process.pid {
                if heartbeat.pid != pid {
                    let reason = format!(
                        "updater heartbeat pid {} does not match running pid {pid}",
                        heartbeat.pid
                    );
                    if self.in_grace(now) {
                        return result(UpdaterWatchdogStatus::Grace, Some(reason), None);
                    }
                    self.record_failure(&self.with_last_failure(&reason).await);
                    return self
                        .restart(UpdaterWatchdogStatus::PidMismatch, &reason)
                        .await;
                }
            }
        }
        let heartbeat_at = chrono::DateTime::parse_from_rfc3339(&heartbeat.updated_at)
            .map(|time| time.timestamp_millis())
            .unwrap_or(i64::MIN);
        if heartbeat_at == i64::MIN || now - heartbeat_at > self.stale_heartbeat_ms as i64 {
            let reason = "updater heartbeat is stale";
            if self.in_grace(now) {
                return result(UpdaterWatchdogStatus::Grace, Some(reason.into()), None);
            }
            self.record_failure(&self.with_last_failure(reason).await);
            return self
                .restart(UpdaterWatchdogStatus::StaleHeartbeat, reason)
                .await;
        }
        result(UpdaterWatchdogStatus::Healthy, None, None)
    }

    async fn read_process(&self) -> ProcessView {
        let pid_file = Path::new(&self.data_dir).join("loongsuite-pilot-updater.pid");
        let liveness = (self.liveness)(&pid_file.to_string_lossy()).await;
        if !liveness.running {
            if liveness.pid.is_some()
                && liveness.pid_file_process_alive == Some(true)
                && liveness.pid_file_command_matched == Some(false)
            {
                return ProcessView {
                    running: true,
                    pid: liveness.pid,
                    command_ok: false,
                    reason: format!(
                        "unexpected updater command: {}",
                        liveness
                            .pid_file_command
                            .unwrap_or_else(|| "unknown".into())
                    ),
                };
            }
            return ProcessView {
                running: false,
                pid: liveness.pid,
                command_ok: false,
                reason: liveness.reason,
            };
        }
        ProcessView {
            running: true,
            pid: liveness.pid,
            command_ok: true,
            reason: liveness.reason,
        }
    }

    fn in_grace(&self, now: i64) -> bool {
        now - *self.started_at.lock().expect("start") < self.startup_grace_ms as i64
            || now < *self.sleep_wake_grace_until.lock().expect("grace")
    }

    async fn restart(&self, status: UpdaterWatchdogStatus, reason: &str) -> UpdaterWatchdogResult {
        if self.stopping.load(Ordering::SeqCst) {
            return result(
                UpdaterWatchdogStatus::RestartFailed,
                Some("aborted by stop".into()),
                Some(false),
            );
        }
        let now = (self.now_ms)();
        let last = *self.last_restart_at.lock().expect("restart");
        if last > 0 && now - last < self.restart_cooldown_ms as i64 {
            return result(
                UpdaterWatchdogStatus::RestartRateLimited,
                Some(reason.into()),
                Some(false),
            );
        }
        *self.last_restart_at.lock().expect("restart") = now;
        match (self.restart_command)().await {
            Ok((stdout, stderr)) => {
                logger("UpdaterWatchdog").warn(
                    "updater-watchdog requested updater restart",
                    Some(&fields(serde_json::json!({
                        "status": format!("{status:?}"),
                        "reason": reason,
                        "stdout": sanitize_alarm_text(&stdout, 1_000),
                        "stderr": sanitize_alarm_text(&stderr, 1_000),
                    }))),
                );
                result(
                    UpdaterWatchdogStatus::RestartAttempted,
                    Some(reason.into()),
                    Some(true),
                )
            }
            Err(err) => {
                if self.stopping.load(Ordering::SeqCst) {
                    return result(
                        UpdaterWatchdogStatus::RestartFailed,
                        Some("aborted by stop".into()),
                        Some(false),
                    );
                }
                if is_restart_command_timeout(Some(&err)) {
                    write_restart_failure(
                        &self.data_dir,
                        RestartTarget::Updater,
                        &RestartFailureWrite {
                            stage: "timeout".into(),
                            init_type: None,
                            detail: Some(
                                "restart command killed by timeout before it reported a stage"
                                    .into(),
                            ),
                            diag: None,
                        },
                    );
                }
                let breadcrumb = read_restart_failure(&self.data_dir, RestartTarget::Updater)
                    .await
                    .filter(|item| is_restart_failure_fresh(item, now as f64, None));
                let diagnosis = breadcrumb.as_ref().map(summarize_restart_failure).unwrap_or_else(|| {
                    if is_restart_command_timeout(Some(&err)) {
                        "stage=timeout reason=\"restart command killed by timeout before it reported a stage\"".into()
                    } else {
                        "stage=unknown reason=\"restart command left no diagnostics\"".into()
                    }
                });
                let message = format!(
                    "updater restart command failed: {} | {diagnosis}",
                    describe_restart_command_error(Some(&err))
                );
                self.record_failure(&message);
                result(
                    UpdaterWatchdogStatus::RestartFailed,
                    Some(message),
                    Some(false),
                )
            }
        }
    }

    async fn with_last_failure(&self, message: &str) -> String {
        let not_before = (self.now_ms)() - RECENT_RESTART_FAILURE_MS;
        let breadcrumb = read_restart_failure(&self.data_dir, RestartTarget::Updater)
            .await
            .filter(|item| is_restart_failure_fresh(item, not_before as f64, None));
        match breadcrumb {
            Some(breadcrumb) => format!(
                "{message} | last_restart_failure: {}",
                summarize_restart_failure(&breadcrumb)
            ),
            None => message.to_string(),
        }
    }

    fn record_service(&self, message: &str) {
        if let Some(alarm) = &self.alarm_manager {
            alarm.record(
                "SERVICE_NOT_RUNNING_ALARM",
                "3",
                message,
                Some(AlarmContext {
                    input_name: Some("updater".into()),
                    endpoint_name: None,
                }),
            );
        }
    }

    fn record_failure(&self, message: &str) {
        if let Some(alarm) = &self.alarm_manager {
            alarm.record(
                "UPDATER_FAILURE_ALARM",
                "2",
                message,
                Some(AlarmContext {
                    input_name: Some("updater".into()),
                    endpoint_name: None,
                }),
            );
        }
    }
}

struct CheckingGuard<'a>(&'a AtomicBool);

impl Drop for CheckingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn wait_for_stop_generation(mut stop: tokio::sync::watch::Receiver<u64>, generation: u64) {
    loop {
        if *stop.borrow_and_update() != generation {
            return;
        }
        if stop.changed().await.is_err() {
            return;
        }
    }
}

struct ProcessView {
    running: bool,
    pid: Option<u32>,
    command_ok: bool,
    reason: String,
}

fn result(
    status: UpdaterWatchdogStatus,
    reason: Option<String>,
    restarted: Option<bool>,
) -> UpdaterWatchdogResult {
    UpdaterWatchdogResult {
        status,
        reason,
        restarted,
    }
}

fn default_pilot_bin() -> String {
    let home = crate::utils::resolve_home("~");
    if cfg!(windows) {
        Path::new(&home)
            .join(".local")
            .join("bin")
            .join("loongsuite-pilot-service.ps1")
            .to_string_lossy()
            .into_owned()
    } else {
        Path::new(&home)
            .join(".local")
            .join("bin")
            .join("loongsuite-pilot")
            .to_string_lossy()
            .into_owned()
    }
}

fn is_agentshell(data_dir: &str) -> bool {
    std::fs::read_to_string(Path::new(data_dir).join("current"))
        .map(|text| text.to_ascii_lowercase().contains("-agentshell"))
        .unwrap_or(false)
}

async fn run_restart_command(bin: &str) -> Result<(String, String), Box<RestartCommandError>> {
    run_restart_process(
        restart_process_command(bin)?,
        Duration::from_millis(COMMAND_TIMEOUT_MS),
    )
    .await
}

fn restart_process_command(bin: &str) -> Result<tokio::process::Command, Box<RestartCommandError>> {
    let mut command = if cfg!(windows) {
        let system = std::env::var_os("SystemRoot").ok_or_else(|| {
            Box::new(RestartCommandError {
                message: Some(
                    "Windows SystemRoot is missing; cannot locate the installed PowerShell host"
                        .into(),
                ),
                ..Default::default()
            })
        })?;
        let mut command = tokio::process::Command::new(
            Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            bin,
            "restart-updater",
        ]);
        command
    } else {
        let mut command = tokio::process::Command::new(bin);
        command.arg("restart-updater");
        command
    };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, equivalent to windowsHide.
    command.kill_on_drop(true);
    Ok(command)
}

async fn run_restart_process(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Result<(String, String), Box<RestartCommandError>> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = command.output();
    match tokio::time::timeout(timeout, child).await {
        Ok(Ok(output)) if output.status.success() => Ok((
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )),
        Ok(Ok(output)) => Err(Box::new(RestartCommandError {
            code: output
                .status
                .code()
                .map(|code| RestartExitCode::Number(code as i64)),
            stdout: Some(String::from_utf8_lossy(&output.stdout).into_owned()),
            stderr: Some(String::from_utf8_lossy(&output.stderr).into_owned()),
            ..RestartCommandError::default()
        })),
        Ok(Err(err)) => Err(Box::new(RestartCommandError {
            message: Some(err.to_string()),
            ..RestartCommandError::default()
        })),
        Err(_) => Err(Box::new(RestartCommandError {
            killed: Some(true),
            code: Some(RestartExitCode::Name("ETIMEDOUT".into())),
            ..RestartCommandError::default()
        })),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alive(pid: u32) -> ProcessLiveness {
        ProcessLiveness {
            running: true,
            pid: Some(pid),
            source: crate::utils::ProcessLivenessSource::PidFile,
            reason: "ok".into(),
            pid_file_state: None,
            pid_file_process_alive: Some(true),
            pid_file_command: Some("loongsuite-pilot-updater".into()),
            pid_file_command_matched: Some(true),
        }
    }

    fn missing() -> ProcessLiveness {
        ProcessLiveness {
            running: false,
            pid: None,
            source: crate::utils::ProcessLivenessSource::None,
            reason: "missing".into(),
            pid_file_state: None,
            pid_file_process_alive: None,
            pid_file_command: None,
            pid_file_command_matched: None,
        }
    }

    fn watchdog(dir: &std::path::Path, liveness: ProcessLiveness, grace: u64) -> UpdaterWatchdog {
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(10_000));
        let now = Arc::clone(&clock);
        UpdaterWatchdog::new(UpdaterWatchdogOptions {
            enabled: true,
            data_dir: dir.to_string_lossy().into_owned(),
            loongsuite_pilot_bin: Some("pilot".into()),
            interval_ms: Some(60_000),
            stale_heartbeat_ms: Some(1_000),
            startup_grace_ms: Some(grace),
            sleep_wake_grace_ms: Some(0),
            restart_cooldown_ms: Some(50_000),
            alarm_manager: None,
            updater_liveness: Some(Arc::new(move |_| {
                let snapshot = ProcessLiveness {
                    running: liveness.running,
                    pid: liveness.pid,
                    source: liveness.source,
                    reason: liveness.reason.clone(),
                    pid_file_state: liveness.pid_file_state,
                    pid_file_process_alive: liveness.pid_file_process_alive,
                    pid_file_command: liveness.pid_file_command.clone(),
                    pid_file_command_matched: liveness.pid_file_command_matched,
                };
                Box::pin(async move { snapshot })
            })),
            restart_command: Some(Arc::new(|| {
                Box::pin(async { Ok(("ok".into(), String::new())) })
            })),
            now_ms: Some(Arc::new(move || {
                now.load(std::sync::atomic::Ordering::SeqCst)
            })),
        })
    }

    #[tokio::test]
    async fn healthy_when_heartbeat_matches_the_pid() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("logs")).unwrap();
        let updated = chrono::Utc::now().to_rfc3339();
        std::fs::write(dir.path().join("logs").join("updater-runtime.json"), serde_json::json!({
            "status": "running", "pid": 42, "version": "1.2.0", "updatedAt": updated, "consecutiveFailures": 0
        }).to_string()).unwrap();
        let watchdog = watchdog(dir.path(), alive(42), 0);
        *watchdog.started_at.lock().unwrap() = 0;
        let outcome = watchdog.run_check().await;
        assert_eq!(outcome.status, UpdaterWatchdogStatus::Healthy);
    }

    #[tokio::test]
    async fn startup_grace_skips_a_missing_updater() {
        let dir = tempfile::tempdir().unwrap();
        let watchdog = watchdog(dir.path(), missing(), 60_000);
        *watchdog.started_at.lock().unwrap() = 10_000;
        let outcome = watchdog.run_check().await;
        assert_eq!(outcome.status, UpdaterWatchdogStatus::Grace);
    }

    #[tokio::test]
    async fn agentshell_current_disables_the_watchdog() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("current"), "1.0.0-agentshell").unwrap();
        let watchdog = watchdog(dir.path(), missing(), 0);
        let outcome = watchdog.run_check().await;
        assert_eq!(outcome.status, UpdaterWatchdogStatus::Disabled);
    }

    fn fixture_command(root: &Path, mode: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "core::updater_watchdog::tests::restart_process_fixture",
                "--nocapture",
            ])
            .env_clear()
            .env("PILOT_UPDATER_RESTART_FIXTURE", root)
            .env("PILOT_UPDATER_RESTART_MODE", mode)
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("PATH", root)
            .current_dir(root);
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "ComSpec",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("TMPDIR", root)
            .env("TMP", root)
            .env("TEMP", root);
        command
    }

    #[test]
    fn restart_process_fixture() {
        let Some(root) = std::env::var_os("PILOT_UPDATER_RESTART_FIXTURE") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let mode = std::env::var("PILOT_UPDATER_RESTART_MODE").unwrap();
        std::fs::write(
            root.join("child-started.json"),
            serde_json::json!({
                "pid":std::process::id(),"mode":mode
            })
            .to_string(),
        )
        .unwrap();
        if mode == "windows-home" {
            assert_eq!(
                default_pilot_bin(),
                root.join(".local")
                    .join("bin")
                    .join("loongsuite-pilot-service.ps1")
                    .to_string_lossy()
                    .into_owned()
            );
            return;
        }
        if mode == "fresh-breadcrumb" || mode == "stale-breadcrumb" {
            let seconds = now_ms() / 1000 - if mode == "stale-breadcrumb" { 600 } else { 0 };
            let payload = serde_json::json!({
                "schema":1,"ts":seconds,"target":"updater","stage":"register-denied",
                "init_type":"taskscheduler","detail":"self-heal failed: Access is denied.",
                "diag":[{"Key":"task_state","Value":"Ready"},
                    {"Key":"definition_owner","Value":"BUILTIN\\Administrators"}]
            });
            let file =
                crate::utils::restart_failure_path(root.to_str().unwrap(), RestartTarget::Updater);
            std::fs::create_dir_all(Path::new(&file).parent().unwrap()).unwrap();
            std::fs::write(file, format!("\u{feff}{}\n", payload)).unwrap();
        }
        if mode == "hold" {
            loop {
                std::thread::park();
            }
        }
        println!("synthetic child stdout: task diagnostic");
        eprintln!("synthetic child stderr: denied");
        std::process::exit(27);
    }

    async fn child_pid(root: &Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(bytes) = std::fs::read(root.join("child-started.json")) {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if let Some(pid) = value["pid"].as_u64() {
                            return pid as u32;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("isolated restart child did not start")
    }

    fn own_fixture_alive(pid: u32) -> bool {
        let pid = sysinfo::Pid::from_u32(pid);
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        system
            .process(pid)
            .is_some_and(|process| process.status() != sysinfo::ProcessStatus::Zombie)
    }

    async fn assert_fixture_exited(pid: u32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while own_fixture_alive(pid) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("cancelled/expired restart child remained alive");
    }

    #[tokio::test]
    async fn stop_cancels_real_first_check_child_and_does_not_report_restart_failure() {
        let root = tempfile::tempdir().unwrap();
        let alarm = Arc::new(AlarmManager::new("127.0.0.1", "fixture", "fixture-user"));
        let mut watchdog = watchdog(root.path(), missing(), 0);
        watchdog.alarm_manager = Some(alarm.clone());
        let directory = root.path().to_path_buf();
        watchdog.restart_command = Arc::new(move || {
            let command = fixture_command(&directory, "hold");
            Box::pin(run_restart_process(
                command,
                Duration::from_millis(COMMAND_TIMEOUT_MS),
            ))
        });
        let watchdog = Arc::new(watchdog);
        watchdog.start();
        let pid = child_pid(root.path()).await;
        assert!(own_fixture_alive(pid));
        assert_eq!(
            alarm
                .serialize()
                .iter()
                .filter(|a| a.alarm_type == "SERVICE_NOT_RUNNING_ALARM")
                .count(),
            1
        );
        watchdog.stop();
        assert_fixture_exited(pid).await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while watchdog.checking.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            alarm.serialize().is_empty(),
            "explicit stop must not create a false restart-failure alarm"
        );
        assert!(
            read_restart_failure(root.path().to_str().unwrap(), RestartTarget::Updater)
                .await
                .is_none()
        );
        assert_eq!(
            watchdog.run_check().await.status,
            UpdaterWatchdogStatus::Disabled
        );
    }

    #[tokio::test]
    async fn stop_during_real_health_probe_cancels_before_any_restart_or_alarm() {
        let root = tempfile::tempdir().unwrap();
        let mut watchdog = watchdog(root.path(), missing(), 0);
        let entered = Arc::new(tokio::sync::Notify::new());
        let observed = entered.clone();
        watchdog.liveness = Arc::new(move |_| {
            let entered = observed.clone();
            Box::pin(async move {
                entered.notify_one();
                std::future::pending::<ProcessLiveness>().await
            })
        });
        let commands = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let called = commands.clone();
        watchdog.restart_command = Arc::new(move || {
            called.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok((String::new(), String::new())) })
        });
        let alarm = Arc::new(AlarmManager::new("127.0.0.1", "fixture", "fixture-user"));
        watchdog.alarm_manager = Some(alarm.clone());
        let watchdog = Arc::new(watchdog);
        let checking = watchdog.clone();
        let pending = tokio::spawn(async move { checking.run_check().await });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        watchdog.stop();
        let result = tokio::time::timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status, UpdaterWatchdogStatus::RestartFailed);
        assert_eq!(result.reason.as_deref(), Some("aborted by stop"));
        assert_eq!(result.restarted, Some(false));
        assert_eq!(commands.load(Ordering::SeqCst), 0);
        assert!(alarm.serialize().is_empty());
    }

    #[tokio::test]
    async fn dropping_a_check_future_releases_in_flight_guard_for_the_next_check() {
        let root = tempfile::tempdir().unwrap();
        let mut watchdog = watchdog(root.path(), missing(), 0);
        let entered = Arc::new(tokio::sync::Notify::new());
        let observed = entered.clone();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls = reads.clone();
        watchdog.liveness = Arc::new(move |_| {
            let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            let entered = observed.clone();
            Box::pin(async move {
                if first {
                    entered.notify_one();
                    std::future::pending::<()>().await;
                }
                missing()
            })
        });
        let watchdog = Arc::new(watchdog);
        let owner = watchdog.clone();
        let pending = tokio::spawn(async move { owner.run_check().await });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        assert_eq!(
            watchdog.run_check().await.status,
            UpdaterWatchdogStatus::RestartAttempted
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn actual_restart_process_captures_both_streams_and_timeout_reaps_child() {
        assert_eq!(COMMAND_TIMEOUT_MS, 90_000);
        let failure_root = tempfile::tempdir().unwrap();
        let error = run_restart_process(
            fixture_command(failure_root.path(), "fail"),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, Some(RestartExitCode::Number(27)));
        assert!(error
            .stdout
            .as_deref()
            .unwrap()
            .contains("synthetic child stdout"));
        assert!(error
            .stderr
            .as_deref()
            .unwrap()
            .contains("synthetic child stderr"));
        let root = tempfile::tempdir().unwrap();
        let command = fixture_command(root.path(), "hold");
        let running = tokio::spawn(run_restart_process(command, Duration::from_secs(2)));
        let pid = child_pid(root.path()).await;
        let error = running.await.unwrap().unwrap_err();
        assert!(is_restart_command_timeout(Some(&error)));
        assert_eq!(error.code, Some(RestartExitCode::Name("ETIMEDOUT".into())));
        assert_fixture_exited(pid).await;
    }

    #[cfg(windows)]
    #[test]
    fn windows_restart_argv_preserves_script_path_as_one_argument() {
        let bin = r"C:\isolated fixture\bin\loongsuite-pilot-service.ps1";
        let command = restart_process_command(bin).unwrap();
        let host = Path::new(&std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        assert_eq!(command.as_std().get_program(), host.as_os_str());
        assert_eq!(
            command
                .as_std()
                .get_args()
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                bin,
                "restart-updater"
            ]
        );
        assert!(default_pilot_bin().ends_with(r".local\bin\loongsuite-pilot-service.ps1"));
    }

    type ObservedWatchdog = (
        UpdaterWatchdog,
        Arc<AlarmManager>,
        Arc<std::sync::atomic::AtomicI64>,
        Arc<std::sync::atomic::AtomicUsize>,
    );

    fn observed_watchdog(root: &Path, process: ProcessLiveness) -> ObservedWatchdog {
        let mut watchdog = watchdog(root, process, 0);
        let alarm = Arc::new(AlarmManager::new("127.0.0.1", "fixture", "fixture-user"));
        watchdog.alarm_manager = Some(alarm.clone());
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(now_ms()));
        let observed = clock.clone();
        watchdog.now_ms = Arc::new(move || observed.load(Ordering::SeqCst));
        let commands = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = commands.clone();
        watchdog.restart_command = Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(("synthetic restart accepted".into(), String::new())) })
        });
        (watchdog, alarm, clock, commands)
    }

    fn mismatched_process() -> ProcessLiveness {
        let mut process = missing();
        process.pid = Some(42);
        process.pid_file_process_alive = Some(true);
        process.pid_file_command_matched = Some(false);
        process.pid_file_command = Some("synthetic-other-process".into());
        process
    }

    fn heartbeat(root: &Path, pid: u32, millis: i64) {
        std::fs::create_dir_all(root.join("logs")).unwrap();
        let updated = chrono::DateTime::from_timestamp_millis(millis)
            .unwrap()
            .to_rfc3339();
        std::fs::write(
            root.join("logs/updater-runtime.json"),
            serde_json::json!({
                "status":"running","pid":pid,"version":"fixture",
                "updatedAt":updated,"consecutiveFailures":0
            })
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn actual_heartbeat_files_classify_health_and_raise_only_the_expected_alarm() {
        for mode in [
            "healthy",
            "recovered-pid",
            "missing",
            "mismatch",
            "missing-heartbeat",
            "stale",
            "invalid-date",
            "pid-mismatch",
        ] {
            let root = tempfile::tempdir().unwrap();
            let process = match mode {
                "missing" => missing(),
                "mismatch" => mismatched_process(),
                "recovered-pid" => {
                    let mut process = alive(456);
                    process.source = crate::utils::ProcessLivenessSource::ProcessScan;
                    process.reason = "matching process scan supersedes stale pid fixture".into();
                    process
                }
                _ => alive(42),
            };
            let (watchdog, alarm, clock, commands) = observed_watchdog(root.path(), process);
            let now = clock.load(Ordering::SeqCst);
            if mode != "missing-heartbeat" {
                heartbeat(
                    root.path(),
                    match mode {
                        "recovered-pid" => 456,
                        "pid-mismatch" => 999,
                        _ => 42,
                    },
                    now - if mode == "stale" { 10_000 } else { 0 },
                );
            }
            if mode == "invalid-date" {
                std::fs::write(root.path().join("logs/updater-runtime.json"),
                    r#"{"status":"running","pid":42,"version":"fixture","updatedAt":"not-a-date","consecutiveFailures":0}"#).unwrap();
            }
            let healthy = matches!(mode, "healthy" | "recovered-pid")
                || (mode == "pid-mismatch" && cfg!(windows));
            let result = watchdog.run_check().await;
            assert_eq!(
                result.status,
                if healthy {
                    UpdaterWatchdogStatus::Healthy
                } else {
                    UpdaterWatchdogStatus::RestartAttempted
                },
                "{mode}"
            );
            assert_eq!(
                commands.load(Ordering::SeqCst),
                usize::from(!healthy),
                "{mode}"
            );
            let alarms = alarm.serialize();
            if healthy {
                assert!(alarms.is_empty(), "{mode}");
            } else {
                assert_eq!(alarms.len(), 1, "{mode}");
                assert_eq!(
                    alarms[0].alarm_type,
                    if mode == "missing" {
                        "SERVICE_NOT_RUNNING_ALARM"
                    } else {
                        "UPDATER_FAILURE_ALARM"
                    }
                );
                assert_eq!(alarms[0].input_name.as_deref(), Some("updater"));
                assert_eq!(
                    alarms[0].alarm_level,
                    if mode == "missing" { "3" } else { "2" }
                );
                if mode == "mismatch" {
                    assert!(alarms[0].alarm_message.contains("command mismatch"));
                }
                if mode == "stale" || mode == "invalid-date" {
                    assert!(alarms[0].alarm_message.contains("heartbeat is stale"));
                }
            }
        }
    }

    #[tokio::test]
    async fn startup_and_sleep_wake_grace_cover_missing_mismatched_and_stale_inputs() {
        for mode in ["missing", "mismatch", "stale"] {
            let root = tempfile::tempdir().unwrap();
            let process = match mode {
                "missing" => missing(),
                "mismatch" => mismatched_process(),
                _ => alive(42),
            };
            let (mut watchdog, alarm, clock, commands) = observed_watchdog(root.path(), process);
            let now = clock.load(Ordering::SeqCst);
            heartbeat(root.path(), 42, now - 10_000);
            watchdog.startup_grace_ms = 60_000;
            *watchdog.started_at.lock().unwrap() = now;
            assert_eq!(
                watchdog.run_check().await.status,
                UpdaterWatchdogStatus::Grace,
                "{mode}"
            );
            assert_eq!(commands.load(Ordering::SeqCst), 0);
            assert!(alarm.serialize().is_empty());
        }
        for mode in ["missing", "stale"] {
            let root = tempfile::tempdir().unwrap();
            let (mut watchdog, alarm, clock, commands) = observed_watchdog(root.path(), alive(42));
            let now = clock.load(Ordering::SeqCst);
            heartbeat(root.path(), 42, now);
            watchdog.sleep_wake_grace_ms = 3_000;
            assert_eq!(
                watchdog.run_check().await.status,
                UpdaterWatchdogStatus::Healthy
            );
            if mode == "missing" {
                watchdog.liveness = Arc::new(|_| Box::pin(async { missing() }));
            }
            clock.store(now + 65_000, Ordering::SeqCst);
            assert_eq!(
                watchdog.run_check().await.status,
                UpdaterWatchdogStatus::Grace,
                "{mode}"
            );
            assert!(alarm.serialize().is_empty());
            assert_eq!(commands.load(Ordering::SeqCst), 0);
            clock.store(now + 68_001, Ordering::SeqCst);
            assert_eq!(
                watchdog.run_check().await.status,
                UpdaterWatchdogStatus::RestartAttempted,
                "{mode}"
            );
            assert_eq!(commands.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn overlapping_tick_and_cooldown_do_not_duplicate_the_restart_command() {
        let root = tempfile::tempdir().unwrap();
        let (mut watchdog, alarm, _, _) = observed_watchdog(root.path(), missing());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (started, gate, count) = (entered.clone(), release.clone(), calls.clone());
        watchdog.restart_command = Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            let (started, gate) = (started.clone(), gate.clone());
            Box::pin(async move {
                started.notify_one();
                gate.acquire().await.unwrap().forget();
                Ok((String::new(), String::new()))
            })
        });
        let watchdog = Arc::new(watchdog);
        let owner = watchdog.clone();
        let first = tokio::spawn(async move { owner.run_check().await });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        assert_eq!(alarm.serialize().len(), 1);
        let overlapping = watchdog.run_check().await;
        assert_eq!(
            overlapping.status,
            UpdaterWatchdogStatus::RestartRateLimited
        );
        assert_eq!(
            overlapping.reason.as_deref(),
            Some("check already in flight")
        );
        assert!(alarm.serialize().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        release.add_permits(1);
        assert_eq!(
            first.await.unwrap().status,
            UpdaterWatchdogStatus::RestartAttempted
        );
        assert_eq!(
            watchdog.run_check().await.status,
            UpdaterWatchdogStatus::RestartRateLimited
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn actual_child_bom_breadcrumb_and_both_streams_enrich_restart_failure() {
        for mode in ["fresh-breadcrumb", "stale-breadcrumb"] {
            let root = tempfile::tempdir().unwrap();
            let (mut watchdog, alarm, _, _) = observed_watchdog(root.path(), missing());
            let directory = root.path().to_path_buf();
            watchdog.restart_command = Arc::new(move || {
                Box::pin(run_restart_process(
                    fixture_command(&directory, mode),
                    Duration::from_secs(5),
                ))
            });
            let result = watchdog.run_check().await;
            assert_eq!(result.status, UpdaterWatchdogStatus::RestartFailed);
            let alarms = alarm.serialize();
            let failed = alarms
                .iter()
                .find(|a| a.alarm_type == "UPDATER_FAILURE_ALARM")
                .unwrap();
            assert_eq!(failed.input_name.as_deref(), Some("updater"));
            assert!(failed.alarm_message.contains("exit=27"));
            assert!(failed.alarm_message.contains("synthetic child stdout"));
            assert!(failed.alarm_message.contains("synthetic child stderr"));
            if mode == "fresh-breadcrumb" {
                assert!(failed.alarm_message.contains("stage=register-denied"));
                assert!(failed
                    .alarm_message
                    .contains("reason=\"self-heal failed: Access is denied.\""));
                assert!(failed.alarm_message.contains("init_type=taskscheduler"));
                assert!(failed
                    .alarm_message
                    .contains("definition_owner=\"BUILTIN\\Administrators\""));
                assert!(failed.alarm_message.contains("task_state=\"Ready\""));
                let bytes = std::fs::read(crate::utils::restart_failure_path(
                    root.path().to_str().unwrap(),
                    RestartTarget::Updater,
                ))
                .unwrap();
                assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]));
            } else {
                assert!(failed.alarm_message.contains("stage=unknown"));
                assert!(!failed.alarm_message.contains("register-denied"));
                assert!(!failed.alarm_message.contains("Access is denied"));
            }
        }
    }

    #[tokio::test]
    async fn actual_timeout_persists_stage_and_enriches_next_cooldown_service_alarm() {
        let root = tempfile::tempdir().unwrap();
        let (mut watchdog, alarm, _, _) = observed_watchdog(root.path(), missing());
        let directory = root.path().to_path_buf();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        watchdog.restart_command = Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(run_restart_process(
                fixture_command(&directory, "hold"),
                Duration::from_secs(2),
            ))
        });
        assert_eq!(
            watchdog.run_check().await.status,
            UpdaterWatchdogStatus::RestartFailed
        );
        let pid = child_pid(root.path()).await;
        assert_fixture_exited(pid).await;
        let breadcrumb =
            read_restart_failure(root.path().to_str().unwrap(), RestartTarget::Updater)
                .await
                .unwrap();
        assert_eq!(breadcrumb.stage, "timeout");
        assert_eq!(breadcrumb.target, "updater");
        let alarms = alarm.serialize();
        let failure = alarms
            .iter()
            .find(|a| a.alarm_type == "UPDATER_FAILURE_ALARM")
            .unwrap();
        assert!(failure.alarm_message.contains("stage=timeout"));
        assert!(failure.alarm_message.contains("killed=true"));
        assert_eq!(
            watchdog.run_check().await.status,
            UpdaterWatchdogStatus::RestartRateLimited
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let alarms = alarm.serialize();
        let service = alarms
            .iter()
            .find(|a| a.alarm_type == "SERVICE_NOT_RUNNING_ALARM")
            .unwrap();
        assert!(service
            .alarm_message
            .contains("last_restart_failure: stage=timeout"));
    }

    #[tokio::test]
    async fn prior_failure_is_attached_before_restart_and_disabled_modes_never_probe() {
        let root = tempfile::tempdir().unwrap();
        write_restart_failure(
            root.path().to_str().unwrap(),
            RestartTarget::Updater,
            &RestartFailureWrite {
                stage: "selfheal-register-failed".into(),
                init_type: Some("taskscheduler".into()),
                detail: Some("synthetic previous access refusal".into()),
                diag: None,
            },
        );
        let (watchdog, alarm, _, commands) = observed_watchdog(root.path(), missing());
        assert_eq!(
            watchdog.run_check().await.status,
            UpdaterWatchdogStatus::RestartAttempted
        );
        assert_eq!(commands.load(Ordering::SeqCst), 1);
        let alarms = alarm.serialize();
        assert!(alarms[0]
            .alarm_message
            .contains("last_restart_failure: stage=selfheal-register-failed"));
        assert!(alarms[0]
            .alarm_message
            .contains("synthetic previous access refusal"));
        for agentshell in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (mut watchdog, alarm, _, commands) = observed_watchdog(root.path(), missing());
            watchdog.enabled = agentshell;
            if agentshell {
                std::fs::write(root.path().join("current"), "2.0.0-agentshell").unwrap();
            }
            watchdog.liveness =
                Arc::new(|_| panic!("disabled watchdog must not probe process state"));
            assert_eq!(
                watchdog.run_check().await.status,
                UpdaterWatchdogStatus::Disabled
            );
            assert_eq!(commands.load(Ordering::SeqCst), 0);
            assert!(alarm.serialize().is_empty());
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn actual_windows_powershell_forwards_restart_argv_and_uses_profile_home() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("isolated service fixture.ps1");
        let body = r#"
param([string]$Action)
if ($Action -ne 'restart-updater') { exit 41 }
[System.IO.File]::WriteAllText(($env:PILOT_UPDATER_RESTART_FIXTURE + '\powershell-action.txt'), $Action)
exit 0
"#;
        std::fs::write(&script, format!("\u{feff}{body}")).unwrap();
        let mut command = restart_process_command(script.to_str().unwrap()).unwrap();
        command
            .env_clear()
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .env("PATH", root.path())
            .env("PILOT_UPDATER_RESTART_FIXTURE", root.path())
            .current_dir(root.path());
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "ComSpec",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("TMP", root.path())
            .env("TEMP", root.path())
            .env("TMPDIR", root.path());
        run_restart_process(command, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("powershell-action.txt")).unwrap(),
            "restart-updater"
        );
        let mut probe = fixture_command(root.path(), "windows-home");
        probe.env("HOME", root.path().join("decoy-home"));
        run_restart_process(probe, Duration::from_secs(5))
            .await
            .unwrap();
    }
}

#[cfg(test)]
#[path = "updater_watchdog_history_health_tests.rs"]
mod history_health_tests;

#[cfg(test)]
#[path = "updater_watchdog_history_failure_tests.rs"]
mod history_failure_tests;
