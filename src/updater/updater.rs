//! Port of `src/updater/updater.ts`.
//!
//! Version selection, pointer rollback, collector restart diagnostics, and
//! version GC follow the TypeScript control flow. Native release downloads and
//! service commands use [`UpdaterNet`]; the default uses `reqwest` and the
//! bounded process executor.

use super::activation_transaction::ActivationTransaction;
use super::release_manifest::{LatestManifest, VersionManifest};
use crate::types::{AutoUpdateConfig, CanaryPolicy};
use crate::updater::runtime_state::{
    updater_runtime_path, UpdaterRuntimeState, UpdaterRuntimeStatus,
};
use crate::updater::updater_metrics::{
    UpdaterEventExtra, UpdaterMetrics, EVENT_COLLECTOR_RESTARTED, EVENT_DEPLOYED,
    EVENT_DOWNLOADING, EVENT_DOWNLOAD_VERIFIED, EVENT_NEW_VERSION_AVAILABLE, EVENT_UPDATER_STARTED,
    EVENT_UPDATER_STOPPED, EVENT_UPDATER_STOPPED_MAX_FAILURES, EVENT_UPDATE_FAILURE,
};
use crate::updater::version_utils::{compare_versions, compute_sha256, deterministic_bucket};
use crate::utils::runtime_paths::{build_edition, build_target, resource_file, validate_runtime};
use crate::utils::{
    describe_restart_command_error, is_restart_command_timeout, is_restart_failure_fresh,
    read_json_file, read_restart_failure, resolve_home, summarize_restart_failure, write_json_file,
    write_restart_failure, Platform, RestartCommandError, RestartExitCode, RestartFailureWrite,
    RestartTarget,
};
use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const FETCH_TIMEOUT_MS: u64 = 30_000;
pub const DOWNLOAD_TIMEOUT_MS: u64 = 5 * 60_000;
pub const MAX_BACKOFF_MS: u64 = 6 * 60 * 60_000;
pub const MAX_CONSECUTIVE_FAILURES: u32 = 10;
pub const MAX_VERSION_GC_REMOVALS_PER_CHECK: usize = 1;
pub const COLLECTOR_COMMAND_TIMEOUT_MS: u64 = 90_000;
pub const COLLECTOR_HEALTH_TIMEOUT_MS: u64 = 30_000;
pub const COLLECTOR_HEALTH_POLL_MS: u64 = 500;
const HEARTBEAT_INTERVAL_MS: u64 = 30_000;
const INITIAL_CHECK_DELAY_MS: u64 = 60_000;

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TimerEffect {
    ScheduledCheck,
    Heartbeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Canary,
}

impl UpdateChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Canary => "canary",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalVersion {
    pub version: String,
    pub git_commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdaterPaths {
    pub cache_dir: String,
    pub data_dir: String,
    pub versions_dir: String,
    pub current_file: String,
    pub previous_file: String,
    pub bootstrap_dir: String,
    pub loongsuite_pilot_bin: String,
    pub runtime_file: String,
    pub collector_runtime_file: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTarget {
    pub manifest: VersionManifest,
    pub channel: UpdateChannel,
    pub hotfix_version: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct FetchResponse {
    pub status: u16,
    pub status_text: String,
    pub body: Vec<u8>,
}

impl FetchResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.body).map_err(|err| err.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone)]
pub struct CommandFailure {
    pub message: String,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub code: Option<String>,
    pub killed: Option<bool>,
    pub signal: Option<String>,
}

impl CommandFailure {
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stdout: None,
            stderr: None,
            code: None,
            killed: None,
            signal: None,
        }
    }

    fn as_restart_error(&self) -> RestartCommandError {
        RestartCommandError {
            message: Some(self.message.clone()),
            killed: self.killed,
            signal: self.signal.clone(),
            code: self.code.as_ref().map(|code| {
                if let Ok(number) = code.parse::<i64>() {
                    RestartExitCode::Number(number)
                } else {
                    RestartExitCode::Name(code.clone())
                }
            }),
            stdout: self.stdout.clone(),
            stderr: self.stderr.clone(),
        }
    }
}

impl std::fmt::Display for CommandFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[async_trait]
pub trait UpdaterNet: Send + Sync {
    async fn fetch(&self, url: &str, timeout_ms: u64) -> Result<FetchResponse, String>;
    async fn exec(&self, request: &ExecRequest) -> Result<ExecOutput, CommandFailure>;
    async fn exec_candidate(&self, request: &ExecRequest) -> Result<ExecOutput, CommandFailure> {
        self.exec(request).await
    }
}

pub struct RealUpdaterNet;

#[async_trait]
impl UpdaterNet for RealUpdaterNet {
    async fn fetch(&self, url: &str, timeout_ms: u64) -> Result<FetchResponse, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|err| err.to_string())?;
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("").to_string();
        let limit = if timeout_ms == FETCH_TIMEOUT_MS {
            1024 * 1024
        } else {
            super::package_archive::MAX_DOWNLOAD_BYTES
        };
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err("下载响应大小超限".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
            if chunk.len() > limit.saturating_sub(body.len()) {
                return Err("下载响应大小超限".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(FetchResponse {
            status: status.as_u16(),
            status_text,
            body,
        })
    }

    async fn exec_candidate(&self, request: &ExecRequest) -> Result<ExecOutput, CommandFailure> {
        let mut command = tokio::process::Command::new(&request.program);
        command.args(&request.args).env_clear().envs(&request.env);
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        let output = crate::utils::candidate_process::output(
            &mut command,
            Duration::from_millis(request.timeout_ms),
            1024 * 1024,
        )
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                CommandFailure {
                    message: "候选命令超时".into(),
                    stdout: None,
                    stderr: None,
                    code: Some("ETIMEDOUT".into()),
                    killed: Some(true),
                    signal: None,
                }
            } else {
                CommandFailure::message(error.to_string())
            }
        })?;
        if !output.status.success() {
            // 候选可能输出配置内容；错误只报告退出状态，不传播它的诊断流。
            return Err(CommandFailure {
                message: format!("候选命令执行失败：{}", output.status),
                stdout: None,
                stderr: None,
                code: output.status.code().map(|code| code.to_string()),
                killed: Some(false),
                signal: None,
            });
        }
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    async fn exec(&self, request: &ExecRequest) -> Result<ExecOutput, CommandFailure> {
        let mut command = tokio::process::Command::new(&request.program);
        command
            .args(&request.args)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null());
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        command.env_clear();
        for (key, value) in &request.env {
            command.env(key, value);
        }
        let output =
            tokio::time::timeout(Duration::from_millis(request.timeout_ms), command.output()).await;
        let output = match output {
            Err(_) => {
                return Err(CommandFailure {
                    message: "Command timed out".into(),
                    stdout: None,
                    stderr: None,
                    code: Some("ETIMEDOUT".into()),
                    killed: Some(true),
                    signal: Some("SIGTERM".into()),
                })
            }
            Ok(Err(err)) => return Err(CommandFailure::message(err.to_string())),
            Ok(Ok(output)) => output,
        };
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if output.status.success() {
            return Ok(ExecOutput { stdout, stderr });
        }
        Err(CommandFailure {
            message: format!("Command failed: {}", output.status),
            stdout: Some(stdout),
            stderr: Some(stderr),
            code: output.status.code().map(|code| code.to_string()),
            killed: Some(false),
            signal: None,
        })
    }
}

pub struct Updater {
    config: Mutex<AutoUpdateConfig>,
    paths: UpdaterPaths,
    config_path: String,
    platform: Platform,
    process_env: HashMap<String, String>,
    net: Arc<dyn UpdaterNet>,
    metrics: Mutex<Option<Arc<UpdaterMetrics>>>,
    checking: AtomicBool,
    scheduled: AtomicBool,
    stopping: tokio::sync::watch::Sender<bool>,
    consecutive_failures: Mutex<u32>,
    next_check_at: Mutex<u128>,
    now_ms: Arc<dyn Fn() -> u128 + Send + Sync>,
    pid_alive: Arc<dyn Fn(u32) -> bool + Send + Sync>,
    health_timeout_ms: u64,
    health_poll_ms: u64,
    #[cfg(test)]
    timer_observer: Option<Arc<dyn Fn(TimerEffect) + Send + Sync>>,
}

impl Updater {
    pub fn new(config: AutoUpdateConfig, base_dir: Option<&str>) -> Self {
        Self::with_net(config, base_dir, Arc::new(RealUpdaterNet))
    }

    pub fn with_net(
        config: AutoUpdateConfig,
        base_dir: Option<&str>,
        net: Arc<dyn UpdaterNet>,
    ) -> Self {
        let platform = Platform::current();
        let paths = match base_dir {
            Some(base) => build_paths_for(base, platform, &home_dir()),
            None => default_paths(platform, &home_dir()),
        };
        let config_path = std::env::var("AGENT_DATA_COLLECTION_CONFIG")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| resolve_home(value.trim()))
            .unwrap_or_else(|| {
                if let Some(base) = base_dir {
                    Path::new(base)
                        .join("config.json")
                        .to_string_lossy()
                        .into_owned()
                } else {
                    crate::utils::config_json_path()
                }
            });
        let health_cache = PathBuf::from(&paths.cache_dir);
        let health_data = PathBuf::from(&paths.data_dir);
        Self {
            config: Mutex::new(config),
            paths,
            config_path,
            platform,
            process_env: std::env::vars().collect(),
            net,
            metrics: Mutex::new(None),
            checking: AtomicBool::new(false),
            scheduled: AtomicBool::new(false),
            stopping: tokio::sync::watch::channel(false).0,
            consecutive_failures: Mutex::new(0),
            next_check_at: Mutex::new(0),
            now_ms: Arc::new(system_now_ms),
            pid_alive: Arc::new(move |pid| {
                crate::utils::installed_process::is_current_installed_process(
                    pid,
                    "collector",
                    &health_cache,
                    &health_data,
                )
            }),
            health_timeout_ms: COLLECTOR_HEALTH_TIMEOUT_MS,
            health_poll_ms: COLLECTOR_HEALTH_POLL_MS,
            #[cfg(test)]
            timer_observer: None,
        }
    }

    pub fn paths(&self) -> &UpdaterPaths {
        &self.paths
    }

    pub fn set_metrics(&self, metrics: Arc<UpdaterMetrics>) {
        *self.metrics.lock().unwrap_or_else(|err| err.into_inner()) = Some(metrics);
    }

    pub fn is_scheduled(&self) -> bool {
        self.scheduled.load(Ordering::SeqCst)
    }

    pub fn consecutive_failures(&self) -> u32 {
        *self
            .consecutive_failures
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    pub fn set_clock(&mut self, now_ms: Arc<dyn Fn() -> u128 + Send + Sync>) {
        self.now_ms = now_ms;
    }

    pub fn set_health_timeout_ms(&mut self, timeout_ms: u64) {
        self.health_timeout_ms = timeout_ms;
    }

    pub fn set_pid_alive(&mut self, pid_alive: Arc<dyn Fn(u32) -> bool + Send + Sync>) {
        self.pid_alive = pid_alive;
    }

    pub fn set_checking_for_test(&self, checking: bool) {
        self.checking.store(checking, Ordering::SeqCst);
    }

    pub fn is_checking(&self) -> bool {
        self.checking.load(Ordering::SeqCst)
    }

    pub fn set_failure_state_for_test(&self, failures: u32, next_check_at: u128) {
        *self
            .consecutive_failures
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = failures;
        *self
            .next_check_at
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = next_check_at;
    }

    pub fn next_check_at(&self) -> u128 {
        *self
            .next_check_at
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    pub fn start(&self) {
        if !self
            .config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .enabled
        {
            return;
        }
        self.stopping.send_replace(false);
        self.scheduled.store(true, Ordering::SeqCst);
        self.emit(EVENT_UPDATER_STARTED, UpdaterEventExtra::default());
    }

    pub fn stop(&self) {
        self.stopping.send_replace(true);
        self.scheduled.store(false, Ordering::SeqCst);
        self.emit(EVENT_UPDATER_STOPPED, UpdaterEventExtra::default());
    }

    /// 常驻调度；检查失败只触发退避，不让 daemon 退出。
    pub async fn run_until(&self, shutdown: impl std::future::Future<Output = ()>) {
        struct StopOnDrop<'a>(&'a Updater);
        impl Drop for StopOnDrop<'_> {
            fn drop(&mut self) {
                self.0.stop();
            }
        }
        self.start();
        let _guard = StopOnDrop(self);
        let mut stopping = self.stopping.subscribe();
        tokio::pin!(shutdown);
        let maintenance = self.maintain();
        tokio::pin!(maintenance);
        let origin = tokio::time::Instant::now();
        let mut initial_pending = true;
        let mut interval = self
            .config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .check_interval_ms
            .max(1000);
        let mut next_periodic_ms = u128::from(interval);
        while self.is_scheduled() && !*stopping.borrow() {
            let next_ms = if initial_pending {
                next_periodic_ms.min(u128::from(INITIAL_CHECK_DELAY_MS))
            } else {
                next_periodic_ms
            };
            let deadline =
                origin + Duration::from_millis(u64::try_from(next_ms).unwrap_or(u64::MAX));
            tokio::select! {
                biased;
                _ = &mut shutdown => break,
                _ = stopping.changed() => break,
                _ = &mut maintenance => break,
                _ = tokio::time::sleep_until(deadline) => {}
            }
            tokio::select! {
                biased;
                _ = &mut shutdown => break,
                _ = stopping.changed() => break,
                _ = &mut maintenance => break,
                _ = self.scheduled_check() => {}
            }
            let elapsed_ms = origin.elapsed().as_millis();
            if elapsed_ms >= u128::from(INITIAL_CHECK_DELAY_MS) {
                initial_pending = false;
            }
            let configured_interval = self
                .config
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .check_interval_ms
                .max(1000);
            if configured_interval != interval {
                interval = configured_interval;
                next_periodic_ms = elapsed_ms.saturating_add(u128::from(interval));
            } else if elapsed_ms >= next_periodic_ms {
                // Missed checks are skipped, preserving the startup phase. Do not
                // queue concurrent checks behind a slow download/restart.
                let period = u128::from(interval);
                next_periodic_ms = elapsed_ms / period * period + period;
            }
        }
    }

    #[cfg(test)]
    fn timer_effect_for_test(&self, effect: TimerEffect) -> bool {
        if let Some(observer) = &self.timer_observer {
            observer(effect);
            true
        } else {
            false
        }
    }

    async fn scheduled_check(&self) {
        #[cfg(test)]
        if self.timer_effect_for_test(TimerEffect::ScheduledCheck) {
            return;
        }
        let result = async {
            let file = read_config_for_update(&self.config_path).await?;
            let config = super::build_auto_update_config_with(Some(&file), self.platform, |key| {
                self.process_env.get(key).cloned()
            });
            let enabled = config.enabled;
            *self.config.lock().unwrap_or_else(|err| err.into_inner()) = config;
            if !enabled {
                self.stop();
                return Ok(());
            }
            self.check().await
        }
        .await;
        if let Err(err) = result {
            self.alarm(
                "UPDATER_FAILURE_ALARM",
                "2",
                &format!("更新检查失败：{err}"),
            );
        }
    }

    async fn maintain(&self) {
        use super::updater_metrics::{COLLECTOR_HEALTH_INTERVAL_MS, FLUSH_INTERVAL_MS};
        self.maintain_with_intervals(
            HEARTBEAT_INTERVAL_MS,
            FLUSH_INTERVAL_MS,
            COLLECTOR_HEALTH_INTERVAL_MS,
        )
        .await;
    }

    async fn maintain_with_intervals(&self, heartbeat_ms: u64, flush_ms: u64, health_ms: u64) {
        let timer = |ms| {
            let mut timer = tokio::time::interval(Duration::from_millis(ms));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            timer
        };
        let mut heartbeat = timer(heartbeat_ms);
        let mut flush = timer(flush_ms);
        let mut health = timer(health_ms);
        loop {
            let metrics = self
                .metrics
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone();
            tokio::select! {
                _ = heartbeat.tick() => {
                    #[cfg(test)]
                    if self.timer_effect_for_test(TimerEffect::Heartbeat) { continue; }
                    if let Err(err) = self.write_heartbeat().await {
                        self.alarm("UPDATER_FAILURE_ALARM", "2", &format!("更新心跳写入失败：{err}"));
                    }
                }
                _ = flush.tick() => { if let Some(metrics) = metrics { metrics.flush().await; } }
                _ = health.tick() => { if let Some(metrics) = metrics { metrics.check_collector_health(); } }
            }
        }
    }

    pub fn needs_update(
        &self,
        local: Option<&LocalVersion>,
        manifest: &VersionManifest,
        channel: UpdateChannel,
    ) -> bool {
        let Some(local) = local else {
            return true;
        };
        let cmp = compare_versions(&manifest.version, &local.version);
        if cmp > 0 {
            return true;
        }
        if cmp < 0 {
            return false;
        }
        if channel == UpdateChannel::Canary {
            let remote = manifest.hotfix_version.unwrap_or(0);
            let local_hotfix = self
                .config
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .canary_hotfix_version
                .unwrap_or(0);
            if remote > local_hotfix {
                return true;
            }
        }
        if !manifest.git_commit.is_empty() && local.git_commit != manifest.git_commit {
            return true;
        }
        false
    }

    pub fn resolve_target_version(&self, latest: &LatestManifest) -> ResolvedTarget {
        let stable = latest.stable.clone();
        let Some(canary) = latest.canary.as_ref() else {
            return ResolvedTarget {
                manifest: stable,
                channel: UpdateChannel::Stable,
                hotfix_version: None,
            };
        };
        if canary.rollout_percentage.is_none() {
            return ResolvedTarget {
                manifest: stable,
                channel: UpdateChannel::Stable,
                hotfix_version: None,
            };
        }
        let config = self
            .config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        if config.canary_policy == Some(CanaryPolicy::Off) {
            return ResolvedTarget {
                manifest: stable,
                channel: UpdateChannel::Stable,
                hotfix_version: None,
            };
        }
        if config.canary_policy == Some(CanaryPolicy::Latest) {
            return ResolvedTarget {
                manifest: canary.clone(),
                channel: UpdateChannel::Canary,
                hotfix_version: canary.hotfix_version,
            };
        }
        let Some(install_id) = config.install_id.as_deref() else {
            return ResolvedTarget {
                manifest: stable,
                channel: UpdateChannel::Stable,
                hotfix_version: None,
            };
        };
        let bucket = deterministic_bucket(install_id, &canary.version);
        let rollout = canary.rollout_percentage.unwrap_or(0.0);
        if (bucket as f64) < rollout {
            ResolvedTarget {
                manifest: canary.clone(),
                channel: UpdateChannel::Canary,
                hotfix_version: canary.hotfix_version,
            }
        } else {
            ResolvedTarget {
                manifest: stable,
                channel: UpdateChannel::Stable,
                hotfix_version: None,
            }
        }
    }

    pub async fn ensure_install_id(&self) -> Result<(), String> {
        crate::deployment::installer_helper::with_config_lock(
            Path::new(&self.config_path),
            || async { self.ensure_install_id_locked() },
        )
        .await
        .map_err(|err| format!("{err:#}"))
    }

    fn ensure_install_id_locked(&self) -> anyhow::Result<()> {
        let file = crate::deployment::installer_helper::update_config_locked(
            Path::new(&self.config_path),
            |old| {
                let mut file = old.clone();
                if file
                    .get("installId")
                    .and_then(Value::as_str)
                    .is_none_or(|id| id.is_empty())
                {
                    file["installId"] = json!(uuid::Uuid::new_v4().to_string());
                }
                Ok(file)
            },
        )?;
        self.config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .install_id = file["installId"].as_str().map(str::to_owned);
        Ok(())
    }

    pub async fn persist_canary_state(&self, hotfix_version: u64) -> Result<(), String> {
        crate::deployment::installer_helper::with_config_lock(
            Path::new(&self.config_path),
            || async { self.persist_canary_state_locked(hotfix_version) },
        )
        .await
        .map_err(|err| format!("{err:#}"))
    }

    fn persist_canary_state_locked(&self, hotfix_version: u64) -> anyhow::Result<()> {
        crate::deployment::installer_helper::update_config_locked(
            Path::new(&self.config_path),
            |old| Self::config_with_canary_state(old, hotfix_version),
        )?;
        self.config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .canary_hotfix_version = Some(hotfix_version);
        Ok(())
    }

    fn config_with_canary_state(old: &Value, hotfix_version: u64) -> anyhow::Result<Value> {
        let mut file = old.clone();
        let mut existing = file.get("canary").cloned().unwrap_or_else(|| json!({}));
        anyhow::ensure!(
            existing.is_object(),
            "canary 配置不是 JSON object，拒绝覆盖"
        );
        existing["hotfix_version"] = json!(hotfix_version);
        file["canary"] = existing;
        Ok(file)
    }

    fn stage_canary_state_locked(
        &self,
        activation: &mut ActivationTransaction,
        hotfix_version: u64,
    ) -> anyhow::Result<()> {
        let path = Path::new(&self.config_path);
        let (original, old) = crate::deployment::installer_helper::read_config(path)?;
        let next = Self::config_with_canary_state(&old, hotfix_version)?;
        let bytes =
            crate::deployment::installer_helper::encode_config(original.as_deref(), &old, &next)?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            if original.is_some() {
                crate::utils::runtime_paths::runtime_metadata(path)?
                    .permissions()
                    .mode()
                    & 0o777
            } else {
                0o600
            }
        };
        #[cfg(not(unix))]
        let mode = 0o600;
        activation.write("config", &bytes, mode)
    }

    /// 调用方保持配置锁；健康确认之后，将灰度状态与版本入口一同提交。
    fn commit_activation(
        &self,
        activation: &mut ActivationTransaction,
        hotfix_version: Option<u64>,
    ) -> anyhow::Result<()> {
        if let Some(hotfix) = hotfix_version {
            self.stage_canary_state_locked(activation, hotfix)?;
        }
        activation.commit()?;
        if let Some(hotfix) = hotfix_version {
            self.config
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .canary_hotfix_version = Some(hotfix);
        }
        Ok(())
    }

    pub async fn check(&self) -> Result<(), String> {
        if self.checking.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        struct CheckingGuard<'a>(&'a AtomicBool);
        impl Drop for CheckingGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = CheckingGuard(&self.checking);
        let mut stopping = self.stopping.subscribe();
        if *stopping.borrow() {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = stopping.changed() => Ok(()),
            result = self.check_inner() => result,
        }
    }

    async fn check_inner(&self) -> Result<(), String> {
        let now = (self.now_ms)();
        if now
            < *self
                .next_check_at
                .lock()
                .unwrap_or_else(|err| err.into_inner())
        {
            return Ok(());
        }
        match self.check_once().await {
            Ok(true) => {
                *self
                    .consecutive_failures
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) = 0;
                *self
                    .next_check_at
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) = 0;
                Ok(())
            }
            Ok(false) => Ok(()),
            Err(err) => {
                let count = {
                    let mut failures = self
                        .consecutive_failures
                        .lock()
                        .unwrap_or_else(|err| err.into_inner());
                    *failures += 1;
                    *failures
                };
                let interval = self
                    .config
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .check_interval_ms;
                let backoff = backoff_ms(interval, count);
                *self
                    .next_check_at
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) =
                    (self.now_ms)().saturating_add(backoff as u128);
                self.emit(
                    EVENT_UPDATE_FAILURE,
                    UpdaterEventExtra {
                        error: Some(err.clone()),
                        consecutive_failures: Some(count),
                        ..UpdaterEventExtra::default()
                    },
                );
                self.alarm(
                    "UPDATER_FAILURE_ALARM",
                    "2",
                    &format!("update check failed (attempt {count}): {err}"),
                );
                if count >= MAX_CONSECUTIVE_FAILURES {
                    self.emit(
                        EVENT_UPDATER_STOPPED_MAX_FAILURES,
                        UpdaterEventExtra {
                            error: Some(format!("{MAX_CONSECUTIVE_FAILURES} consecutive failures; degraded retry continues")),
                            consecutive_failures: Some(count),
                            ..UpdaterEventExtra::default()
                        },
                    );
                }
                let _ = self.write_heartbeat().await;
                Err(err)
            }
        }
    }

    async fn check_once(&self) -> Result<bool, String> {
        std::fs::create_dir_all(&self.paths.cache_dir).map_err(|err| err.to_string())?;
        let lock = Path::new(&self.paths.cache_dir).join("update.lock");
        crate::deployment::with_deployed_state_lock(
            &lock.to_string_lossy(),
            || async {
                crate::deployment::native_install::with_service_lock(
                    Path::new(&self.paths.loongsuite_pilot_bin),
                    || async {
                        crate::deployment::installer_helper::with_config_lock(
                            Path::new(&self.config_path),
                            || async {
                                crate::deployment::native_install::recover_runtime_files(
                                    Path::new(&self.paths.cache_dir),
                                    self.activation_targets(),
                                )?;
                                self.check_locked().await.map_err(anyhow::Error::msg)
                            },
                        )
                        .await
                    },
                )
                .await
            },
            5000,
        )
        .await
        .map_err(|err| format!("{err:#}"))
    }

    async fn check_locked(&self) -> Result<bool, String> {
        let local = self.read_local_version_checked().await?;
        let Some(latest) = self.fetch_manifest().await? else {
            return Ok(false);
        };
        self.ensure_install_id_locked()
            .map_err(|err| format!("{err:#}"))?;
        let resolved = self.resolve_target_version(&latest);
        if !self.needs_update(local.as_ref(), &resolved.manifest, resolved.channel) {
            let active = local.clone().unwrap_or(LocalVersion {
                version: resolved.manifest.version.clone(),
                git_commit: resolved.manifest.git_commit.clone(),
            });
            let recovered = self.recover_current_collector_if_needed(&active).await?;
            if recovered {
                self.emit(
                    EVENT_COLLECTOR_RESTARTED,
                    UpdaterEventExtra {
                        latest_version: Some(active.version.clone()),
                        ..UpdaterEventExtra::default()
                    },
                );
            }
            *self
                .consecutive_failures
                .lock()
                .unwrap_or_else(|err| err.into_inner()) = 0;
            *self
                .next_check_at
                .lock()
                .unwrap_or_else(|err| err.into_inner()) = 0;
            self.cleanup_legacy_cli();
            self.gc_old_versions().await;
            self.write_heartbeat().await?;
            if recovered {
                self.schedule_updater_restart().await;
            }
            return Ok(true);
        }
        self.emit(
            EVENT_NEW_VERSION_AVAILABLE,
            UpdaterEventExtra {
                current_version: Some(
                    local
                        .as_ref()
                        .map(|item| item.version.clone())
                        .unwrap_or_else(|| "unknown".into()),
                ),
                latest_version: Some(resolved.manifest.version.clone()),
                ..UpdaterEventExtra::default()
            },
        );
        self.emit(
            EVENT_DOWNLOADING,
            UpdaterEventExtra {
                latest_version: Some(resolved.manifest.version.clone()),
                ..UpdaterEventExtra::default()
            },
        );
        let mut activation = self.download_and_deploy(&resolved.manifest).await?;
        self.emit(
            EVENT_DEPLOYED,
            UpdaterEventExtra {
                latest_version: Some(resolved.manifest.version.clone()),
                ..UpdaterEventExtra::default()
            },
        );
        let same_version = local
            .as_ref()
            .is_some_and(|item| item.version == resolved.manifest.version);
        if let Err(err) = self
            .restart_collector(
                &resolved.manifest.version,
                same_version,
                &resolved.manifest.git_commit,
            )
            .await
        {
            activation
                .rollback()
                .map_err(|rollback| format!("{err}; 回滚失败：{rollback:#}"))?;
            if let Some(local) = local.as_ref() {
                self.restart_collector(&local.version, false, &local.git_commit)
                    .await
                    .map_err(|recovery| format!("{err}; 旧版本恢复失败：{recovery}"))?;
            }
            return Err(err);
        }
        let hotfix = (resolved.channel == UpdateChannel::Canary)
            .then_some(resolved.hotfix_version.unwrap_or(0));
        if let Err(err) = self.commit_activation(&mut activation, hotfix) {
            activation
                .rollback()
                .map_err(|rollback| format!("更新提交失败：{err:#}; 回滚失败：{rollback:#}"))?;
            if let Some(local) = local.as_ref() {
                self.restart_collector(&local.version, false, &local.git_commit)
                    .await
                    .map_err(|recovery| {
                        format!("更新提交失败：{err:#}; 旧版本恢复失败：{recovery}")
                    })?;
            }
            return Err(format!("更新提交失败：{err:#}"));
        }
        self.cleanup_legacy_cli();
        self.emit(
            EVENT_COLLECTOR_RESTARTED,
            UpdaterEventExtra {
                latest_version: Some(resolved.manifest.version.clone()),
                ..UpdaterEventExtra::default()
            },
        );
        self.gc_old_versions().await;
        *self
            .consecutive_failures
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = 0;
        *self
            .next_check_at
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = 0;
        self.write_heartbeat().await?;
        self.schedule_updater_restart().await;
        Ok(true)
    }

    fn cleanup_legacy_cli(&self) {
        if let Err(error) = crate::deployment::native_install::cleanup_legacy_windows_cli(
            Path::new(&self.paths.loongsuite_pilot_bin),
            Path::new(&self.paths.cache_dir),
            Path::new(&self.paths.data_dir),
        ) {
            crate::utils::create_logger("Updater").warn(
                "legacy CLI cleanup failed; native publication remains committed",
                json!({"error":format!("{error:#}")}).as_object(),
            );
        }
    }

    async fn fetch_manifest(&self) -> Result<Option<LatestManifest>, String> {
        let url = self
            .config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .manifest_url
            .clone();
        let Some(url) = url.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let response = self.net.fetch(&url, FETCH_TIMEOUT_MS).await?;
        if !response.ok() {
            return Err(format!(
                "更新清单下载失败：{} {}",
                response.status, response.status_text
            ));
        }
        if response.body.len() > 1024 * 1024 {
            return Err("更新清单大小超限".into());
        }
        let latest: LatestManifest = serde_json::from_slice(&response.body)
            .map_err(|err| format!("Rust 更新清单无效：{err}"))?;
        latest
            .validate(build_edition())
            .map_err(|err| err.to_string())?;
        Ok(Some(latest))
    }

    async fn download_and_deploy(
        &self,
        manifest: &VersionManifest,
    ) -> Result<ActivationTransaction, String> {
        use sha2::{Digest, Sha256};
        let asset = manifest
            .asset(build_target())
            .map_err(|err| err.to_string())?;
        let response = self.net.fetch(&asset.url, DOWNLOAD_TIMEOUT_MS).await?;
        if !response.ok() {
            return Err(format!(
                "download failed: {} {}",
                response.status, response.status_text
            ));
        }
        if response.body.is_empty()
            || response.body.len() > super::package_archive::MAX_DOWNLOAD_BYTES
        {
            return Err("download body size is invalid".into());
        }
        let actual = hex::encode(Sha256::digest(&response.body));
        if !actual.eq_ignore_ascii_case(&asset.sha256) {
            return Err(format!(
                "SHA-256 mismatch: expected {}, got {actual}",
                asset.sha256
            ));
        }
        self.emit(
            EVENT_DOWNLOAD_VERIFIED,
            UpdaterEventExtra {
                latest_version: Some(manifest.version.clone()),
                ..UpdaterEventExtra::default()
            },
        );
        let package_name = format!("loongsuite-pilot-{}-{}", manifest.version, build_target());
        let parent = PathBuf::from(&self.paths.versions_dir);
        let format = asset.format;
        // 解包是纯文件操作；任务被取消后临时目录由返回值/闭包拥有者回收。
        let unpacked = tokio::task::spawn_blocking(move || {
            super::package_archive::unpack(&response.body, format, &parent, &package_name)
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| format!("安全解包失败：{err:#}"))?;
        self.activate_staged(&unpacked.root, manifest).await
    }

    async fn activate_staged(
        &self,
        staging: &Path,
        manifest: &VersionManifest,
    ) -> Result<ActivationTransaction, String> {
        manifest.validate().map_err(|err| err.to_string())?;
        let runtime = validate_runtime(staging, &manifest.version, build_target(), build_edition())
            .map_err(|err| format!("候选包校验失败：{err:#}"))?;
        if runtime.git_commit != manifest.git_commit {
            return Err("候选包提交与更新清单不一致".into());
        }
        let binary = resource_file(staging, &runtime.binary).map_err(|err| err.to_string())?;
        let mut env = self.process_env.clone();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            self.paths.data_dir.clone(),
        );
        env.insert(
            "LOONGSUITE_PILOT_CACHE_DIR".into(),
            self.paths.cache_dir.clone(),
        );
        env.insert(
            "LOONGSUITE_PILOT_RESOURCE_ROOT".into(),
            staging.to_string_lossy().into_owned(),
        );
        env.insert(
            "AGENT_DATA_COLLECTION_CONFIG".into(),
            self.config_path.clone(),
        );
        let request = |args| ExecRequest {
            program: binary.to_string_lossy().into_owned(),
            args,
            cwd: Some(staging.to_string_lossy().into_owned()),
            env: env.clone(),
            timeout_ms: 30_000,
        };
        let version = self
            .net
            .exec_candidate(&request(vec!["--version".into()]))
            .await
            .map_err(|err| err.to_string())?;
        if version.stdout.trim() != format!("loongsuite-pilot {}", manifest.version) {
            return Err("候选二进制版本不匹配".into());
        }
        let check = self
            .net
            .exec_candidate(&request(vec!["check".into(), "--json".into()]))
            .await
            .map_err(|err| err.to_string())?;
        let check: Value = serde_json::from_str(&check.stdout)
            .map_err(|err| format!("候选预检报告无效：{err}"))?;
        if check["schema"] != 1
            || check["ok"] != true
            || check["runtime"] != "rust"
            || check["version"] != manifest.version
            || check["target"] != build_target()
            || check["edition"] != build_edition()
            || check["check"]["details"]["gitCommit"] != manifest.git_commit
        {
            return Err("候选包版本、配置或资源预检失败".into());
        }
        crate::deployment::native_install::check_container_candidate(
            Path::new(&self.paths.cache_dir),
            Path::new(&self.paths.data_dir),
            &check,
        )
        .map_err(|err| err.to_string())?;
        crate::deployment::native_install::check_service_owner(
            Path::new(&self.paths.loongsuite_pilot_bin),
            Path::new(&self.paths.cache_dir),
            Path::new(&self.paths.data_dir),
        )
        .map_err(|err| format!("服务入口归属校验失败：{err:#}"))?;
        let mut transaction = ActivationTransaction::begin(
            Path::new(&self.paths.cache_dir),
            self.activation_targets(),
        )
        .map_err(|err| format!("无法保存更新恢复材料：{err:#}"))?;
        let old_current = read_pointer_checked(&self.paths.current_file).await?;
        // 不覆盖任何现有版本目录，Windows 正在执行的 updater 也无需被替换。
        let dir_name = format!(
            "{}_{}_{}",
            manifest.version,
            manifest.git_commit,
            uuid::Uuid::new_v4().simple()
        );
        let target = Path::new(&self.paths.versions_dir).join(&dir_name);
        std::fs::create_dir_all(&self.paths.versions_dir).map_err(|err| err.to_string())?;
        std::fs::rename(staging, &target).map_err(|err| err.to_string())?;
        let switch = (|| -> anyhow::Result<()> {
            // Pin the installed final target, never the temporary unpacked path.
            let service_files = crate::deployment::native_install::service_files(
                &target,
                Path::new(&self.paths.loongsuite_pilot_bin),
                Path::new(&self.paths.cache_dir),
                Path::new(&self.paths.data_dir),
                Path::new(&self.config_path),
                true,
            )?;
            if let Some(previous) = old_current {
                transaction.write("previous", format!("{previous}\n").as_bytes(), 0o600)?;
            }
            transaction.write("current", format!("{dir_name}\n").as_bytes(), 0o600)?;
            for (key, (bytes, mode)) in &service_files {
                transaction.write(key, bytes, *mode)?;
            }
            Ok(())
        })();
        if let Err(err) = switch {
            transaction
                .rollback()
                .map_err(|rollback| format!("{err:#}; 回滚失败：{rollback:#}"))?;
            return Err(err.to_string());
        }
        Ok(transaction)
    }

    fn activation_targets(&self) -> std::collections::BTreeMap<String, PathBuf> {
        let mut targets = crate::deployment::native_install::service_targets(Path::new(
            &self.paths.loongsuite_pilot_bin,
        ));
        targets.insert("current".into(), PathBuf::from(&self.paths.current_file));
        targets.insert("previous".into(), PathBuf::from(&self.paths.previous_file));
        targets.insert("config".into(), PathBuf::from(&self.config_path));
        targets
    }

    pub async fn gc_old_versions(&self) {
        let Ok(executable) = std::env::current_exe() else {
            return;
        };
        self.gc_old_versions_for(&executable).await;
    }

    async fn gc_old_versions_for(&self, executable: &Path) {
        let Ok(executable) = std::fs::canonicalize(executable) else {
            return;
        };
        if std::fs::symlink_metadata(Path::new(&self.paths.cache_dir).join("update-recovery.json"))
            .is_ok()
        {
            return;
        }
        let current = match read_pointer_file(&self.paths.current_file).await {
            Some(name) => name,
            None => return,
        };
        let previous = match read_pointer_checked(&self.paths.previous_file).await {
            Ok(value) => value,
            Err(_) => return,
        };
        if !crate::utils::runtime_paths::runtime_metadata(Path::new(&self.paths.versions_dir))
            .is_ok_and(|meta| meta.is_dir())
        {
            return;
        }
        let mut entries = match tokio::fs::read_dir(&self.paths.versions_dir).await {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut stale = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == current || previous.as_deref() == Some(name.as_str()) {
                continue;
            }
            let parts: Vec<_> = name.split('_').collect();
            if parts.len() != 3 || parts[2].len() != 32 || uuid::Uuid::parse_str(parts[2]).is_err()
            {
                continue;
            }
            let path = entry.path();
            let meta = match crate::utils::runtime_paths::runtime_metadata(&path) {
                Ok(meta) if meta.is_dir() => meta,
                _ => continue,
            };
            let Ok(canonical) = std::fs::canonicalize(&path) else {
                continue;
            };
            if executable.starts_with(&canonical) {
                continue;
            }
            let Ok(manifest) = validate_runtime(&path, parts[0], build_target(), build_edition())
            else {
                continue;
            };
            if manifest.git_commit != parts[1] {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_millis())
                .unwrap_or(u128::MAX);
            stale.push((mtime, name, entry.path()));
        }
        stale.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        for (_, _, path) in stale.into_iter().take(MAX_VERSION_GC_REMOVALS_PER_CHECK) {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
    }

    pub async fn resolve_current_version_dir(&self) -> Option<String> {
        self.current_version_dir_checked().await.ok().flatten()
    }

    async fn current_version_dir_checked(&self) -> Result<Option<String>, String> {
        let Some(name) = read_pointer_checked(&self.paths.current_file).await? else {
            return Ok(None);
        };
        let versions = Path::new(&self.paths.versions_dir);
        let dir = versions.join(name);
        for path in [versions, dir.as_path()] {
            let meta = crate::utils::runtime_paths::runtime_metadata(path)
                .map_err(|err| err.to_string())?;
            if !meta.is_dir() {
                return Err("版本指针目标不是普通目录".into());
            }
        }
        Ok(Some(dir.to_string_lossy().into_owned()))
    }

    async fn read_local_version_checked(&self) -> Result<Option<LocalVersion>, String> {
        read_pointer_checked(&self.paths.previous_file).await?;
        let Some(dir) = self.current_version_dir_checked().await? else {
            return Ok(None);
        };
        let version = read_version_file(&Path::new(&dir).join("VERSION"))
            .await
            .ok_or("当前版本缺少有效 VERSION，拒绝自动接管")?;
        let manifest = validate_runtime(
            Path::new(&dir),
            &version.version,
            build_target(),
            build_edition(),
        )
        .map_err(|err| format!("当前安装不是完整原生包，拒绝自动接管：{err:#}"))?;
        if manifest.git_commit != version.git_commit {
            return Err("当前 VERSION 与运行清单提交不一致".into());
        }
        Ok(Some(version))
    }

    pub fn collector_health_failure(
        &self,
        runtime: Option<&Value>,
        target_version: &str,
        not_before_ms: u128,
        previous_pid: Option<u32>,
        target_git_commit: &str,
    ) -> String {
        let Some(runtime) = runtime else {
            return "runtime record not found".into();
        };
        if runtime.get("status").and_then(Value::as_str) != Some("active") {
            return format!("runtime status is {}", json_display(runtime.get("status")));
        }
        if runtime.get("packageVersion").and_then(Value::as_str) != Some(target_version) {
            return format!(
                "runtime version is {}, expected {target_version}",
                json_display(runtime.get("packageVersion"))
            );
        }
        if !target_git_commit.is_empty()
            && runtime.get("gitCommit").and_then(Value::as_str) != Some(target_git_commit)
        {
            return format!(
                "runtime git commit is {}, expected {target_git_commit}",
                json_display(runtime.get("gitCommit"))
            );
        }
        let updated = runtime
            .get("updatedAt")
            .and_then(Value::as_str)
            .and_then(parse_time_ms);
        if updated.is_none() || updated.unwrap_or(0) < not_before_ms {
            return "runtime record predates restart".into();
        }
        let pid = json_u32(runtime.get("pid"));
        let Some(pid) = pid else {
            return "runtime PID is invalid".into();
        };
        if previous_pid == Some(pid) {
            return "collector PID did not change".into();
        }
        if !(self.pid_alive)(pid) {
            return format!(
                "collector PID {pid} is not alive or does not match the current installation"
            );
        }
        String::new()
    }

    pub fn collector_command_invocation(&self, command: &str) -> (String, Vec<String>) {
        collector_command_invocation(self.platform, &self.paths.loongsuite_pilot_bin, command)
    }

    pub async fn run_collector_command(
        &self,
        command: &str,
    ) -> Result<ExecOutput, Box<CommandFailure>> {
        let (program, args) = self.collector_command_invocation(command);
        let mut env = self.process_env.clone();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            self.paths.data_dir.clone(),
        );
        env.insert(
            "LOONGSUITE_PILOT_CACHE_DIR".into(),
            self.paths.cache_dir.clone(),
        );
        env.insert(
            "AGENT_DATA_COLLECTION_CONFIG".into(),
            self.config_path.clone(),
        );
        // 不把下载候选的资源根或安装输入泄漏给已安装的服务。
        env.remove("LOONGSUITE_PILOT_RESOURCE_ROOT");
        env.remove("LOONGSUITE_PILOT_INSTALL_INPUT");
        self.net
            .exec(&ExecRequest {
                program,
                args,
                cwd: None,
                env,
                timeout_ms: COLLECTOR_COMMAND_TIMEOUT_MS,
            })
            .await
            .map_err(Box::new)
    }

    pub async fn restart_collector(
        &self,
        target_version: &str,
        require_new_pid: bool,
        target_git_commit: &str,
    ) -> Result<(), String> {
        let previous_runtime = if require_new_pid {
            self.read_collector_runtime().await
        } else {
            None
        };
        let previous_pid = previous_runtime
            .as_ref()
            .and_then(|runtime| json_u32(runtime.get("pid")));
        let started = (self.now_ms)();
        let mut diagnosed = None;
        let mut recovery_attempted = false;
        if let Err(err) = self.run_collector_command("restart-collector").await {
            let info = self.diagnose_collector_restart_failure(started, &err).await;
            if let Err(recovery) = self.start_collector_for_recovery(&err).await {
                self.alarm(
                    "UPDATER_FAILURE_ALARM",
                    "2",
                    &format!(
                        "collector restart command failed: {} | {}; {recovery}",
                        info.detail, info.diagnosis
                    ),
                );
                return Err(recovery);
            }
            diagnosed = Some(info);
            recovery_attempted = true;
        }
        if let Err(health_err) = self
            .wait_for_collector_health(target_version, started, previous_pid, target_git_commit)
            .await
        {
            if recovery_attempted {
                let first = diagnosed
                    .map(|info| format!("{} | {}", info.detail, info.diagnosis))
                    .unwrap_or_else(|| "restart-collector failed".into());
                self.alarm(
                    "UPDATER_FAILURE_ALARM",
                    "2",
                    &format!("collector restart command failed: {first}; health check failed after start-collector recovery: {health_err}"),
                );
                return Err(health_err);
            }
            self.run_collector_command("start-collector")
                .await
                .map_err(|err| err.to_string())?;
            self.wait_for_collector_health(
                target_version,
                started,
                previous_pid,
                target_git_commit,
            )
            .await?;
        }
        Ok(())
    }

    /// Handoff follows health confirmation and durable success bookkeeping.
    /// Scheduling failure is best effort: the activated collector remains healthy.
    async fn schedule_updater_restart(&self) {
        if let Err(error) = self.run_collector_command("schedule-updater-restart").await {
            let meta = json!({"error": format_command_failure(&error)});
            crate::utils::create_logger("Updater")
                .warn("failed to schedule updater restart", meta.as_object());
        }
    }

    pub async fn start_collector_for_recovery(&self, cause: &CommandFailure) -> Result<(), String> {
        match self.run_collector_command("start-collector").await {
            Ok(_) => Ok(()),
            Err(recovery) => Err(format!(
                "collector restart failed ({}); start-only recovery also failed ({})",
                format_command_failure(cause),
                format_command_failure(&recovery)
            )),
        }
    }

    async fn diagnose_collector_restart_failure(
        &self,
        attempt_started_at: u128,
        err: &CommandFailure,
    ) -> RestartDiagnosis {
        let detail = describe_restart_command_error(Some(&err.as_restart_error()));
        if is_restart_command_timeout(Some(&err.as_restart_error())) {
            write_restart_failure(
                &self.paths.data_dir,
                RestartTarget::Collector,
                &RestartFailureWrite {
                    stage: "timeout".into(),
                    init_type: None,
                    detail: Some(
                        "restart command killed by timeout before it reported a stage".into(),
                    ),
                    diag: None,
                },
            );
        }
        let mut breadcrumb =
            read_restart_failure(&self.paths.data_dir, RestartTarget::Collector).await;
        if let Some(found) = breadcrumb.as_ref() {
            if !is_restart_failure_fresh(found, attempt_started_at as f64, None) {
                breadcrumb = None;
            }
        }
        let diagnosis = if let Some(found) = breadcrumb.as_ref() {
            summarize_restart_failure(found)
        } else if is_restart_command_timeout(Some(&err.as_restart_error())) {
            "stage=timeout reason=\"restart command killed by timeout before it reported a stage\""
                .into()
        } else {
            "stage=unknown reason=\"restart command left no diagnostics\"".into()
        };
        RestartDiagnosis { detail, diagnosis }
    }

    async fn wait_for_collector_health(
        &self,
        target_version: &str,
        not_before_ms: u128,
        previous_pid: Option<u32>,
        target_git_commit: &str,
    ) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(self.health_timeout_ms);
        let last_failure = loop {
            let runtime = self.read_collector_runtime().await;
            let failure = self.collector_health_failure(
                runtime.as_ref(),
                target_version,
                not_before_ms,
                previous_pid,
                target_git_commit,
            );
            if failure.is_empty() {
                return Ok(());
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break failure;
            }
            tokio::time::sleep(Duration::from_millis(self.health_poll_ms).min(deadline - now))
                .await;
        };
        Err(format!(
            "collector did not become healthy within {}ms: {last_failure}",
            self.health_timeout_ms
        ))
    }

    async fn recover_current_collector_if_needed(
        &self,
        target: &LocalVersion,
    ) -> Result<bool, String> {
        let runtime = self.read_collector_runtime().await;
        let failure = self.collector_health_failure(
            runtime.as_ref(),
            &target.version,
            0,
            None,
            &target.git_commit,
        );
        if failure.is_empty() {
            return Ok(false);
        }
        let live = runtime
            .as_ref()
            .and_then(|value| json_u32(value.get("pid")))
            .filter(|pid| (self.pid_alive)(*pid));
        if live.is_some() {
            self.restart_collector(&target.version, true, &target.git_commit)
                .await?;
            return Ok(true);
        }
        let started = (self.now_ms)();
        self.run_collector_command("start-collector")
            .await
            .map_err(|err| err.to_string())?;
        self.wait_for_collector_health(&target.version, started, None, &target.git_commit)
            .await?;
        Ok(true)
    }

    async fn read_collector_runtime(&self) -> Option<Value> {
        read_json_file(&self.paths.collector_runtime_file).await
    }

    async fn write_heartbeat(&self) -> Result<(), String> {
        if !self
            .config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .enabled
        {
            return Ok(());
        }
        let current_name = read_pointer_file(&self.paths.current_file).await;
        let local = match current_name.as_deref() {
            Some(name) => {
                read_version_file(
                    &Path::new(&self.paths.versions_dir)
                        .join(name)
                        .join("VERSION"),
                )
                .await
            }
            None => None,
        };
        let failures = *self
            .consecutive_failures
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let next = *self
            .next_check_at
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let state = UpdaterRuntimeState {
            status: if failures >= MAX_CONSECUTIVE_FAILURES {
                UpdaterRuntimeStatus::Degraded
            } else {
                UpdaterRuntimeStatus::Running
            },
            pid: std::process::id(),
            version: local
                .as_ref()
                .map(|item| item.version.clone())
                .unwrap_or_else(|| "unknown".into()),
            version_dir: current_name,
            git_commit: local.as_ref().and_then(|item| {
                if item.git_commit.is_empty() {
                    None
                } else {
                    Some(item.git_commit.clone())
                }
            }),
            updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            consecutive_failures: failures,
            next_check_at: if next > 0 {
                Some(ms_to_iso(next))
            } else {
                None
            },
        };
        write_json_file(&self.paths.runtime_file, &state)
            .await
            .map_err(|err| err.to_string())
    }

    fn emit(&self, event_type: &str, extra: UpdaterEventExtra) {
        if let Some(metrics) = self
            .metrics
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
        {
            metrics.write_event(event_type, extra);
        }
    }

    fn alarm(&self, alarm_type: &str, level: &str, message: &str) {
        if let Some(metrics) = self
            .metrics
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
        {
            metrics.write_alarm(alarm_type, level, message);
        }
    }
}

struct RestartDiagnosis {
    detail: String,
    diagnosis: String,
}

pub fn build_paths(base_dir: &str) -> UpdaterPaths {
    build_paths_for(base_dir, Platform::current(), &home_dir())
}

pub fn build_paths_for(base_dir: &str, platform: Platform, home: &str) -> UpdaterPaths {
    UpdaterPaths {
        cache_dir: base_dir.to_string(),
        data_dir: base_dir.to_string(),
        versions_dir: Path::new(base_dir)
            .join("versions")
            .to_string_lossy()
            .into_owned(),
        current_file: Path::new(base_dir)
            .join("current")
            .to_string_lossy()
            .into_owned(),
        previous_file: Path::new(base_dir)
            .join("previous")
            .to_string_lossy()
            .into_owned(),
        bootstrap_dir: Path::new(base_dir)
            .join("bin")
            .to_string_lossy()
            .into_owned(),
        loongsuite_pilot_bin: pilot_bin_path(platform, home),
        runtime_file: updater_runtime_path(base_dir),
        collector_runtime_file: Path::new(base_dir)
            .join("logs")
            .join("runtime.json")
            .to_string_lossy()
            .into_owned(),
    }
}

pub fn pilot_bin_path(platform: Platform, home: &str) -> String {
    if platform == Platform::Win32 {
        Path::new(home)
            .join(".local")
            .join("bin")
            .join("loongsuite-pilot-service.ps1")
            .to_string_lossy()
            .into_owned()
    } else {
        Path::new(home)
            .join(".local")
            .join("bin")
            .join("loongsuite-pilot")
            .to_string_lossy()
            .into_owned()
    }
}

fn default_paths(platform: Platform, home: &str) -> UpdaterPaths {
    let default = Path::new(home)
        .join(".loongsuite-pilot")
        .to_string_lossy()
        .into_owned();
    let cache = std::env::var("LOONGSUITE_PILOT_CACHE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_home(&value))
        .unwrap_or(default);
    let data = crate::utils::resolve_data_dir(None);
    let mut paths = build_paths_for(&cache, platform, home);
    paths.data_dir = data.clone();
    paths.runtime_file = updater_runtime_path(&data);
    paths.collector_runtime_file = Path::new(&data)
        .join("logs")
        .join("runtime.json")
        .to_string_lossy()
        .into_owned();
    paths
}

fn home_dir() -> String {
    if let Some(home) = std::env::var("HOME").ok().filter(|value| !value.is_empty()) {
        return home;
    }
    std::env::var("USERPROFILE").unwrap_or_default()
}

pub fn backoff_ms(interval_ms: u64, consecutive_failures: u32) -> u64 {
    if consecutive_failures >= 40 {
        return MAX_BACKOFF_MS;
    }
    let factor = 1_u64.checked_shl(consecutive_failures).unwrap_or(u64::MAX);
    interval_ms.saturating_mul(factor).min(MAX_BACKOFF_MS)
}

pub fn collector_command_invocation(
    platform: Platform,
    bin: &str,
    command: &str,
) -> (String, Vec<String>) {
    let mut command_args = vec![command.to_string()];
    if command == "restart-collector" {
        command_args.push("--defer-updater-restart".into());
    }
    if platform == Platform::Win32 {
        let mut args = vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            bin.to_string(),
        ];
        args.extend(command_args);
        ("powershell.exe".into(), args)
    } else {
        (bin.to_string(), command_args)
    }
}

pub fn format_command_failure(error: &CommandFailure) -> String {
    let mut fields = vec![format!("error={}", error.message)];
    if let Some(stdout) = error
        .stdout
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        fields.push(format!(
            "stdout={}",
            serde_json::to_string(stdout).unwrap_or_else(|_| "\"\"".into())
        ));
    }
    if let Some(stderr) = error
        .stderr
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        fields.push(format!(
            "stderr={}",
            serde_json::to_string(stderr).unwrap_or_else(|_| "\"\"".into())
        ));
    }
    if let Some(code) = &error.code {
        fields.push(format!("code={code}"));
    }
    if let Some(killed) = error.killed {
        fields.push(format!("killed={killed}"));
    }
    if let Some(signal) = &error.signal {
        fields.push(format!("signal={signal}"));
    }
    fields.join(", ")
}

pub async fn verify_checksum(archive: &Path, shasums_file: &Path, name: &str) -> bool {
    let Ok(content) = tokio::fs::read_to_string(shasums_file).await else {
        return false;
    };
    let mut expected = None;
    for raw in content.split(['\n', '\r']) {
        let line = raw.trim();
        let Some(sep) = line.find(char::is_whitespace) else {
            continue;
        };
        let mut file = line[sep..].trim();
        if let Some(stripped) = file.strip_prefix('*') {
            file = stripped;
        }
        if file == name {
            expected = Some(line[..sep].to_string());
            break;
        }
    }
    let Some(expected) = expected else {
        return false;
    };
    compute_sha256(&archive.to_string_lossy()).ok().as_deref() == Some(expected.as_str())
}

#[cfg(test)]
async fn write_pointer_file(path: &str, value: &str) -> Result<(), String> {
    if !safe_pointer(value) {
        return Err("无效版本指针".into());
    }
    crate::utils::write_text_file_atomic(path, &format!("{value}\n"), &Default::default())
        .await
        .map_err(|err| err.to_string())
}

pub async fn read_pointer_file(path: &str) -> Option<String> {
    let content = tokio::fs::read_to_string(path).await.ok()?;
    let trimmed = content.trim();
    if safe_pointer(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

async fn read_pointer_checked(path: &str) -> Result<Option<String>, String> {
    match tokio::fs::symlink_metadata(path).await {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
        Ok(_) => {}
    }
    let meta = crate::utils::runtime_paths::runtime_metadata(Path::new(path))
        .map_err(|err| err.to_string())?;
    if !meta.is_file() || meta.len() > 1024 {
        return Err("版本指针不是受支持的普通文件".into());
    }
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|err| err.to_string())?;
    let value = content.trim();
    if !safe_pointer(value) {
        return Err("版本指针损坏，保留现有安装".into());
    }
    Ok(Some(value.into()))
}

async fn read_version_file(path: &Path) -> Option<LocalVersion> {
    let content = tokio::fs::read_to_string(path).await.ok()?;
    let version = capture(&content, r"(?m)^version=(.+)$")?;
    let git_commit = capture(&content, r"(?m)^git_commit=(.+)$").unwrap_or_default();
    Some(LocalVersion {
        version,
        git_commit,
    })
}

fn capture(text: &str, pattern: &str) -> Option<String> {
    regex::Regex::new(pattern)
        .ok()?
        .captures(text)?
        .get(1)
        .map(|item| item.as_str().trim().to_string())
}

fn safe_pointer(value: &str) -> bool {
    crate::utils::runtime_paths::safe_component(value)
}

pub(super) async fn read_config_for_update(path: &str) -> Result<Value, String> {
    crate::deployment::installer_helper::read_config(Path::new(path))
        .map(|(_, value)| value)
        .map_err(|err| format!("{err:#}"))
}

fn json_display(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "undefined".into(),
    }
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    let number = value?.as_u64().or_else(|| {
        value?
            .as_i64()
            .and_then(|item| u32::try_from(item).ok().map(u64::from))
    })?;
    if number == 0 || number > u32::MAX as u64 {
        None
    } else {
        Some(number as u32)
    }
}

fn parse_time_ms(value: &str) -> Option<u128> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis().max(0) as u128)
}

fn ms_to_iso(ms: u128) -> String {
    chrono::DateTime::<Utc>::from_timestamp_millis(ms as i64)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn system_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    #[tokio::test]
    async fn real_candidate_exec_bounds_output_and_reaps_its_tree() {
        use crate::utils::candidate_process::tests::{fixture, ready, stopped};
        for mode in ["success", "failure", "stdout", "stderr", "wait", "cancel"] {
            let root = tempfile::tempdir().unwrap();
            let command = fixture(root.path(), if mode == "cancel" { "wait" } else { mode });
            let request = ExecRequest {
                program: command.get_program().to_string_lossy().into_owned(),
                args: command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect(),
                cwd: Some(root.path().to_string_lossy().into_owned()),
                env: command
                    .get_envs()
                    .filter_map(|(key, value)| {
                        value.map(|value| {
                            (
                                key.to_string_lossy().into_owned(),
                                value.to_string_lossy().into_owned(),
                            )
                        })
                    })
                    .collect(),
                timeout_ms: if mode == "wait" { 2000 } else { 30_000 },
            };
            let task = tokio::spawn(async move { RealUpdaterNet.exec_candidate(&request).await });
            let pid = ready(root.path()).await;
            if mode == "cancel" {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                let result = task.await.unwrap();
                if mode == "success" {
                    assert!(result.unwrap().stdout.contains("候选完成 🚀"));
                } else {
                    let error = result.unwrap_err();
                    assert!(error.stdout.is_none() && error.stderr.is_none());
                    match mode {
                        "failure" => assert_eq!(error.code.as_deref(), Some("23")),
                        "wait" => {
                            assert_eq!(error.code.as_deref(), Some("ETIMEDOUT"));
                            assert_eq!(error.killed, Some(true));
                        }
                        _ => assert!(error.message.contains("输出超限")),
                    }
                }
            }
            stopped(pid).await;
        }
    }

    fn base_config() -> AutoUpdateConfig {
        AutoUpdateConfig {
            enabled: true,
            check_interval_ms: 60_000,
            manifest_url: Some("https://example.com/latest.json".into()),
            package_url: Some("https://example.com/pkg.tar.gz".into()),
            install_id: None,
            canary_policy: None,
            canary_hotfix_version: Some(0),
        }
    }

    fn latest(canary: Option<VersionManifest>) -> LatestManifest {
        LatestManifest {
            schema: 1,
            runtime: "rust".into(),
            edition: build_edition().into(),
            stable: super::super::release_manifest::fixture("1.0.35", "abc123"),
            canary,
        }
    }

    fn canary(rollout: f64, hotfix: Option<u64>) -> VersionManifest {
        VersionManifest {
            rollout_percentage: Some(rollout),
            hotfix_version: hotfix,
            ..super::super::release_manifest::fixture("1.0.36", "def456")
        }
    }

    struct ScriptedNet {
        fetches: StdMutex<Vec<Result<FetchResponse, String>>>,
        execs: StdMutex<Vec<Result<ExecOutput, CommandFailure>>>,
        fetch_log: StdMutex<Vec<String>>,
        exec_log: StdMutex<Vec<(String, Vec<String>)>>,
    }

    impl ScriptedNet {
        fn new(
            fetches: Vec<Result<FetchResponse, String>>,
            execs: Vec<Result<ExecOutput, CommandFailure>>,
        ) -> Arc<Self> {
            Arc::new(Self {
                fetches: StdMutex::new(fetches),
                execs: StdMutex::new(execs),
                fetch_log: StdMutex::new(Vec::new()),
                exec_log: StdMutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl UpdaterNet for ScriptedNet {
        async fn fetch(&self, url: &str, _timeout_ms: u64) -> Result<FetchResponse, String> {
            self.fetch_log.lock().unwrap().push(url.to_string());
            self.fetches.lock().unwrap().remove(0)
        }

        async fn exec(&self, request: &ExecRequest) -> Result<ExecOutput, CommandFailure> {
            self.exec_log
                .lock()
                .unwrap()
                .push((request.program.clone(), request.args.clone()));
            if self.execs.lock().unwrap().is_empty() {
                return Ok(ExecOutput::default());
            }
            self.execs.lock().unwrap().remove(0)
        }
    }

    fn manifest_body(version: &str, commit: &str) -> FetchResponse {
        let manifest = LatestManifest {
            stable: super::super::release_manifest::fixture(version, &format!("{commit:0<40}")),
            ..latest(None)
        };
        let body = serde_json::to_vec(&manifest).unwrap();
        FetchResponse {
            status: 200,
            status_text: "OK".into(),
            body,
        }
    }

    #[test]
    fn resolves_canary_policy_and_bucket() {
        let dir = "/tmp/test-canary";
        let stable = Updater::new(base_config(), Some(dir));
        assert_eq!(
            stable.resolve_target_version(&latest(None)).channel,
            UpdateChannel::Stable
        );

        let mut off = base_config();
        off.canary_policy = Some(crate::types::CanaryPolicy::Off);
        assert_eq!(
            Updater::new(off, Some(dir))
                .resolve_target_version(&latest(Some(canary(10.0, None))))
                .channel,
            UpdateChannel::Stable
        );

        let mut latest_policy = base_config();
        latest_policy.canary_policy = Some(crate::types::CanaryPolicy::Latest);
        let resolved = Updater::new(latest_policy, Some(dir))
            .resolve_target_version(&latest(Some(canary(10.0, Some(3)))));
        assert_eq!(resolved.channel, UpdateChannel::Canary);
        assert_eq!(resolved.manifest.version, "1.0.36");
        assert_eq!(resolved.hotfix_version, Some(3));

        let mut inside = None;
        let mut outside = None;
        for index in 0..1000 {
            let id = format!("test-{index}");
            if deterministic_bucket(&id, "1.0.36") < 10 && inside.is_none() {
                inside = Some(id);
            } else if deterministic_bucket(&format!("test-{index}"), "1.0.36") >= 10
                && outside.is_none()
            {
                outside = Some(format!("test-{index}"));
            }
        }
        let mut in_config = base_config();
        in_config.install_id = inside;
        assert_eq!(
            Updater::new(in_config, Some(dir))
                .resolve_target_version(&latest(Some(canary(10.0, None))))
                .channel,
            UpdateChannel::Canary
        );
        let mut out_config = base_config();
        out_config.install_id = outside;
        assert_eq!(
            Updater::new(out_config, Some(dir))
                .resolve_target_version(&latest(Some(canary(10.0, None))))
                .channel,
            UpdateChannel::Stable
        );

        let mut any = base_config();
        any.install_id = Some("any-id".into());
        assert_eq!(
            Updater::new(any.clone(), Some(dir))
                .resolve_target_version(&latest(Some(canary(0.0, None))))
                .channel,
            UpdateChannel::Stable
        );
        assert_eq!(
            Updater::new(any, Some(dir))
                .resolve_target_version(&latest(Some(canary(100.0, None))))
                .channel,
            UpdateChannel::Canary
        );

        let malformed = LatestManifest {
            canary: Some(VersionManifest {
                rollout_percentage: None,
                hotfix_version: None,
                ..super::super::release_manifest::fixture("1.0.36", "def")
            }),
            ..latest(None)
        };
        assert_eq!(
            Updater::new(base_config(), Some(dir))
                .resolve_target_version(&malformed)
                .channel,
            UpdateChannel::Stable
        );
    }

    #[test]
    fn needs_update_honors_hotfix_only_on_canary() {
        let mut config = base_config();
        config.canary_hotfix_version = Some(1);
        let updater = Updater::new(config, Some("/tmp/test-canary"));
        let local = LocalVersion {
            version: "1.0.36".into(),
            git_commit: "def456".into(),
        };
        let mut manifest = canary(10.0, Some(2));
        assert!(updater.needs_update(Some(&local), &manifest, UpdateChannel::Canary));
        manifest.hotfix_version = Some(1);
        assert!(!updater.needs_update(Some(&local), &manifest, UpdateChannel::Canary));
        let stable_local = LocalVersion {
            version: "1.0.35".into(),
            git_commit: "abc123".into(),
        };
        let stable = super::super::release_manifest::fixture("1.0.35", "abc123");
        assert!(!updater.needs_update(Some(&stable_local), &stable, UpdateChannel::Stable));
        assert!(updater.needs_update(None, &stable, UpdateChannel::Stable));
        let newer = VersionManifest {
            version: "1.0.2".into(),
            git_commit: "bbb".into(),
            ..stable.clone()
        };
        let older_local = LocalVersion {
            version: "1.0.1".into(),
            git_commit: "aaa".into(),
        };
        assert!(updater.needs_update(Some(&older_local), &newer, UpdateChannel::Stable));
        assert!(!updater.needs_update(
            Some(&LocalVersion {
                version: "1.0.3".into(),
                git_commit: "ccc".into()
            }),
            &newer,
            UpdateChannel::Stable
        ));
        assert!(updater.needs_update(
            Some(&LocalVersion {
                version: "1.0.2".into(),
                git_commit: "aaa".into()
            }),
            &newer,
            UpdateChannel::Stable
        ));
        let empty_commit = VersionManifest {
            git_commit: String::new(),
            ..newer
        };
        assert!(!updater.needs_update(
            Some(&LocalVersion {
                version: "1.0.2".into(),
                git_commit: "aaa".into()
            }),
            &empty_commit,
            UpdateChannel::Stable
        ));
    }

    #[tokio::test]
    async fn persists_install_id_and_canary_hotfix() {
        let dir = tempfile::tempdir().unwrap();
        let updater = Updater::new(base_config(), Some(dir.path().to_str().unwrap()));
        updater.ensure_install_id().await.unwrap();
        let file: Value = read_json_file(&updater.config_path).await.unwrap();
        assert!(file["installId"].as_str().unwrap().len() > 8);
        updater.ensure_install_id().await.unwrap();
        let again: Value = read_json_file(&updater.config_path).await.unwrap();
        assert_eq!(file["installId"], again["installId"]);
        updater.persist_canary_state(2).await.unwrap();
        let canary_file: Value = read_json_file(&updater.config_path).await.unwrap();
        assert_eq!(canary_file["canary"]["hotfix_version"], 2);
    }

    #[tokio::test]
    async fn updater_config_writes_wait_for_installer_and_preserve_latest_bytes() {
        let root = tempfile::tempdir().unwrap();
        let updater = Updater::new(base_config(), root.path().to_str());
        let path = Path::new(&updater.config_path);
        std::fs::write(path, "{}").unwrap();
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.with_extension("json.lock"))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        let writes = async {
            tokio::try_join!(updater.ensure_install_id(), updater.persist_canary_state(7))
        };
        tokio::pin!(writes);
        assert!(tokio::time::timeout(Duration::from_millis(75), &mut writes)
            .await
            .is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"{}");
        let original = b"\xef\xbb\xbf{\"installId\":\"existing-id\",\"userId\":\"installer-user\",\"canary\":{\"enabled\":true}}\r\n";
        std::fs::write(path, original).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        fs2::FileExt::unlock(&lock).unwrap();
        writes.await.unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.starts_with(b"\xef\xbb\xbf"));
        let value = read_config_for_update(&updater.config_path).await.unwrap();
        assert_eq!(value["userId"], "installer-user");
        assert_eq!(value["installId"], "existing-id");
        assert_eq!(value["canary"], json!({"enabled":true,"hotfix_version":7}));
        updater.ensure_install_id().await.unwrap();
        updater.persist_canary_state(7).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
    }

    #[tokio::test]
    async fn updater_recovery_waits_for_config_lock_before_touching_journal_targets() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![], vec![]);
        let mut settings = base_config();
        settings.manifest_url = None;
        let updater = Updater::with_net(settings, root.path().to_str(), net.clone());
        let config = Path::new(&updater.config_path);
        std::fs::write(config, "{}").unwrap();
        let mut transaction =
            ActivationTransaction::begin(root.path(), updater.activation_targets()).unwrap();
        transaction
            .write("config", b"{\"pending\":true}", 0o600)
            .unwrap();
        std::mem::forget(transaction);
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(config.with_extension("json.lock"))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        let check = updater.check_once();
        tokio::pin!(check);
        assert!(tokio::time::timeout(Duration::from_millis(75), &mut check)
            .await
            .is_err());
        assert_eq!(std::fs::read(config).unwrap(), b"{\"pending\":true}");
        assert!(root.path().join("update-recovery.json").is_file());
        assert!(net.fetch_log.lock().unwrap().is_empty());
        fs2::FileExt::unlock(&lock).unwrap();
        assert!(!check.await.unwrap());
        assert!(net.fetch_log.lock().unwrap().is_empty());
        assert_eq!(std::fs::read(config).unwrap(), b"{}");
        assert!(!root.path().join("update-recovery.json").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn updater_config_rejects_symlinks_readonly_files_and_secret_echoes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let updater = Updater::new(base_config(), root.path().to_str());
        let path = Path::new(&updater.config_path);
        let target = root.path().join("untouched.json");
        std::fs::write(&target, "{}").unwrap();
        symlink(&target, path).unwrap();
        assert!(updater.ensure_install_id().await.is_err());
        assert!(updater.persist_canary_state(1).await.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");
        std::fs::remove_file(path).unwrap();
        std::fs::write(path, "{}").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o400)).unwrap();
        assert!(updater.ensure_install_id().await.is_err());
        assert!(updater.persist_canary_state(1).await.is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"{}");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(path, "{\"secret\":never-print}").unwrap();
        let error = updater.persist_canary_state(1).await.unwrap_err();
        assert!(!error.contains("never-print"));
        assert_eq!(std::fs::read(path).unwrap(), b"{\"secret\":never-print}");
    }

    #[test]
    fn windows_collector_argv_defers_updater_handoff() {
        let bin = r"C:\Users\pilot\.local\bin\loongsuite-pilot-service.ps1";
        let (program, args) =
            collector_command_invocation(Platform::Win32, bin, "restart-collector");
        assert_eq!(program, "powershell.exe");
        assert_eq!(
            args,
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                bin.to_string(),
                "restart-collector".into(),
                "--defer-updater-restart".into(),
            ]
        );
        let (_, start) = collector_command_invocation(Platform::Win32, bin, "start-collector");
        assert_eq!(start.last().map(String::as_str), Some("start-collector"));
        let (unix, unix_args) = collector_command_invocation(
            Platform::Posix,
            "/home/pilot/.local/bin/loongsuite-pilot",
            "schedule-updater-restart",
        );
        assert_eq!(unix, "/home/pilot/.local/bin/loongsuite-pilot");
        assert_eq!(unix_args, vec!["schedule-updater-restart".to_string()]);
        assert!(pilot_bin_path(Platform::Win32, r"C:\Users\pilot")
            .ends_with("loongsuite-pilot-service.ps1"));
    }

    #[test]
    fn formats_child_process_diagnostics() {
        let restart = CommandFailure {
            message: "restart timed out".into(),
            stdout: Some("restart output".into()),
            stderr: None,
            code: None,
            killed: Some(true),
            signal: Some("SIGTERM".into()),
        };
        let recovery = CommandFailure {
            message: "start failed".into(),
            stdout: Some("start output".into()),
            stderr: Some("permission denied".into()),
            code: Some("1".into()),
            killed: Some(false),
            signal: None,
        };
        let rendered = format!(
            "collector restart failed ({}); start-only recovery also failed ({})",
            format_command_failure(&restart),
            format_command_failure(&recovery)
        );
        assert!(rendered.contains("stdout=\"restart output\""));
        assert!(rendered.contains("killed=true"));
        assert!(rendered.contains("signal=SIGTERM"));
        assert!(rendered.contains("stdout=\"start output\""));
        assert!(rendered.contains("stderr=\"permission denied\""));
        assert!(rendered.contains("code=1"));
        assert!(rendered.contains("killed=false"));
    }

    #[test]
    fn health_requires_version_freshness_and_a_new_pid() {
        let updater = Updater::new(base_config(), Some("/tmp/test-updater"));
        let updated = "2023-11-14T22:13:20.000Z";
        let runtime = json!({"status": "active", "packageVersion": "1.0.2", "gitCommit": "bbb", "pid": std::process::id(), "updatedAt": updated});
        let parsed = parse_time_ms(updated).unwrap();
        let mut wrong_version = runtime.clone();
        wrong_version["packageVersion"] = json!("1.0.1");
        assert!(updater
            .collector_health_failure(Some(&wrong_version), "1.0.2", parsed, None, "")
            .contains("expected 1.0.2"));
        let mut wrong_commit = runtime.clone();
        wrong_commit["gitCommit"] = json!("aaa");
        assert!(updater
            .collector_health_failure(Some(&wrong_commit), "1.0.2", parsed, None, "bbb")
            .contains("expected bbb"));
        let mut stale = runtime.clone();
        stale["updatedAt"] = json!("2023-11-14T22:13:19.000Z");
        assert_eq!(
            updater.collector_health_failure(Some(&stale), "1.0.2", parsed, None, ""),
            "runtime record predates restart"
        );
        assert_eq!(
            updater.collector_health_failure(
                Some(&runtime),
                "1.0.2",
                parsed,
                Some(std::process::id()),
                ""
            ),
            "collector PID did not change"
        );
        assert!(updater
            .collector_health_failure(Some(&runtime), "1.0.2", parsed, None, "")
            .contains("does not match the current installation"));
        let mut updater = updater;
        updater.set_pid_alive(Arc::new(|_| true));
        assert_eq!(
            updater.collector_health_failure(Some(&runtime), "1.0.2", parsed, None, ""),
            ""
        );
    }

    #[tokio::test(start_paused = true)]
    async fn health_timeout_is_bounded_even_when_wall_clock_stops() {
        let root = tempfile::tempdir().unwrap();
        let mut updater = Updater::new(base_config(), root.path().to_str());
        updater.set_clock(Arc::new(|| 1));
        updater.set_health_timeout_ms(75);
        let result = tokio::time::timeout(
            Duration::from_millis(200),
            updater.wait_for_collector_health("1.2.0", 1, None, ""),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().contains("within 75ms"));
    }

    #[test]
    fn canary_config_and_version_share_commit_cancel_and_crash_recovery() {
        for outcome in ["commit", "cancel", "crash"] {
            let root = tempfile::tempdir().unwrap();
            let mut updater = Updater::new(base_config(), root.path().to_str());
            updater.paths.loongsuite_pilot_bin =
                root.path().join("service").to_string_lossy().into_owned();
            let initial_hotfix = updater.config.lock().unwrap().canary_hotfix_version;
            let original = "\u{feff}{\"userId\":\"keep\",\"canary\":{\"enabled\":true,\"hotfix_version\":2}}\r\n";
            std::fs::write(&updater.config_path, original).unwrap();
            std::fs::write(&updater.paths.current_file, "old\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    &updater.config_path,
                    std::fs::Permissions::from_mode(0o640),
                )
                .unwrap();
            }
            let mut tx =
                ActivationTransaction::begin(root.path(), updater.activation_targets()).unwrap();
            tx.write("current", b"candidate\n", 0o600).unwrap();
            if outcome == "commit" {
                updater.commit_activation(&mut tx, Some(7)).unwrap();
                let bytes = std::fs::read(&updater.config_path).unwrap();
                assert!(bytes.starts_with(b"\xef\xbb\xbf"));
                let config: Value = serde_json::from_slice(&bytes[3..]).unwrap();
                assert_eq!(config["userId"], "keep");
                assert_eq!(config["canary"]["enabled"], true);
                assert_eq!(config["canary"]["hotfix_version"], 7);
                assert_eq!(
                    updater.config.lock().unwrap().canary_hotfix_version,
                    Some(7)
                );
                drop(tx);
                assert_eq!(
                    std::fs::read(&updater.paths.current_file).unwrap(),
                    b"candidate\n"
                );
            } else {
                updater.stage_canary_state_locked(&mut tx, 7).unwrap();
                assert_eq!(
                    updater.config.lock().unwrap().canary_hotfix_version,
                    initial_hotfix
                );
                if outcome == "crash" {
                    std::mem::forget(tx);
                    ActivationTransaction::recover(root.path(), updater.activation_targets())
                        .unwrap();
                } else {
                    drop(tx);
                }
                assert_eq!(
                    std::fs::read(&updater.config_path).unwrap(),
                    original.as_bytes()
                );
                assert_eq!(
                    std::fs::read(&updater.paths.current_file).unwrap(),
                    b"old\n"
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(&updater.config_path)
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o640
                );
            }
            assert!(!root.path().join("update-recovery.json").exists());
        }
    }

    #[test]
    fn invalid_canary_config_prevents_activation_commit_and_allows_rollback() {
        let root = tempfile::tempdir().unwrap();
        let mut updater = Updater::new(base_config(), root.path().to_str());
        updater.paths.loongsuite_pilot_bin =
            root.path().join("service").to_string_lossy().into_owned();
        let initial_hotfix = updater.config.lock().unwrap().canary_hotfix_version;
        let original = b"{\"canary\":false}";
        std::fs::write(&updater.config_path, original).unwrap();
        std::fs::write(&updater.paths.current_file, "old\n").unwrap();
        let mut tx =
            ActivationTransaction::begin(root.path(), updater.activation_targets()).unwrap();
        tx.write("current", b"candidate\n", 0o600).unwrap();
        assert!(updater.commit_activation(&mut tx, Some(7)).is_err());
        assert_eq!(
            updater.config.lock().unwrap().canary_hotfix_version,
            initial_hotfix
        );
        tx.rollback().unwrap();
        assert_eq!(std::fs::read(&updater.config_path).unwrap(), original);
        assert_eq!(
            std::fs::read(&updater.paths.current_file).unwrap(),
            b"old\n"
        );
        assert!(!root.path().join("update-recovery.json").exists());
    }

    #[tokio::test]
    async fn native_activation_rollback_restores_pointers_and_service_and_gc_keeps_current() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap();
        let paths = build_paths(base);
        tokio::fs::create_dir_all(&paths.versions_dir)
            .await
            .unwrap();
        write_pointer_file(&paths.current_file, "1.0.1_aaa")
            .await
            .unwrap();
        write_pointer_file(&paths.previous_file, "1.0.0_zzz")
            .await
            .unwrap();
        let stale_name = |version| {
            format!(
                "{version}_{}_{}",
                "a".repeat(40),
                uuid::Uuid::new_v4().simple()
            )
        };
        let older_name = stale_name("0.9.9");
        let old_name = stale_name("1.0.0");
        for name in [
            "1.0.0_zzz",
            "1.0.1_aaa",
            older_name.as_str(),
            old_name.as_str(),
        ] {
            native_package_version(
                &Path::new(&paths.versions_dir).join(name),
                name.split('_').next().unwrap(),
                &"a".repeat(40),
            );
        }
        let older = Path::new(&paths.versions_dir).join(&older_name);
        let old = Path::new(&paths.versions_dir).join(&old_name);
        let _ = filetime_set(&older, 10);
        let _ = filetime_set(&old, 20);

        let staging = Path::new(&paths.versions_dir).join("candidate");
        let manifest = native_package(&staging);
        let net = ScriptedNet::new(vec![], preflight_outputs(&manifest));
        let mut updater = Updater::with_net(base_config(), Some(base), net.clone());
        updater.paths.loongsuite_pilot_bin =
            dir.path().join("service").to_string_lossy().into_owned();
        std::fs::write(&updater.paths.loongsuite_pilot_bin, b"old service").unwrap();
        let expected_service = crate::deployment::native_install::service_files(
            &staging,
            Path::new(&updater.paths.loongsuite_pilot_bin),
            Path::new(base),
            Path::new(base),
            Path::new(&updater.config_path),
            false,
        )
        .unwrap();
        let layout = dir.path().join("loongsuite-pilot-layout.json");
        let old_layout =
            serde_json::to_vec(&json!({"cacheDir":base,"dataDir":base,"legacyField":"keep"}))
                .unwrap();
        std::fs::write(&layout, &old_layout).unwrap();
        let transaction = updater.activate_staged(&staging, &manifest).await.unwrap();
        assert_eq!(
            std::fs::read(&layout).unwrap(),
            expected_service["layout"].0
        );
        assert_ne!(
            read_pointer_file(&paths.current_file).await.as_deref(),
            Some("1.0.1_aaa")
        );
        assert_eq!(
            std::fs::read(&updater.paths.loongsuite_pilot_bin).unwrap(),
            expected_service["service"].0
        );
        drop(transaction);
        assert_eq!(std::fs::read(layout).unwrap(), old_layout);
        assert_eq!(
            std::fs::read(&updater.paths.loongsuite_pilot_bin).unwrap(),
            b"old service"
        );
        assert!(net
            .exec_log
            .lock()
            .unwrap()
            .iter()
            .all(|(_, args)| args == &["--version"] || args == &["check", "--json"]));
        assert_eq!(
            read_pointer_file(&paths.current_file).await.as_deref(),
            Some("1.0.1_aaa")
        );
        assert_eq!(
            read_pointer_file(&paths.previous_file).await.as_deref(),
            Some("1.0.0_zzz")
        );

        updater.gc_old_versions().await;
        assert!(Path::new(&paths.versions_dir).join("1.0.1_aaa").exists());
        assert!(Path::new(&paths.versions_dir).join("1.0.0_zzz").exists());
        assert!(!older.exists() ^ !old.exists());
    }

    #[tokio::test]
    async fn same_version_activation_preserves_live_tree_and_retries_failed_preflight() {
        use crate::utils::runtime_paths::sha256_file;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("张三 安装 🚀");
        std::fs::create_dir(&root).unwrap();
        let base = root.to_str().unwrap();
        let paths = build_paths(base);
        let old_name = format!("1.2.0_{}_{}", "a".repeat(40), uuid::Uuid::new_v4().simple());
        let old_root = Path::new(&paths.versions_dir).join(&old_name);
        native_package(&old_root);
        let old_manifest = std::fs::read(old_root.join("runtime-manifest.json")).unwrap();
        let binary = if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        };
        let old_digest = sha256_file(&old_root.join(binary)).unwrap();
        std::fs::write(old_root.join("live-only.txt"), b"keep live tree").unwrap();
        write_pointer_file(&paths.current_file, &old_name)
            .await
            .unwrap();
        write_pointer_file(&paths.previous_file, "1.1.0_previous")
            .await
            .unwrap();

        let staging = Path::new(&paths.versions_dir).join("candidate");
        let manifest = native_package(&staging);
        let mut outcomes = vec![Err(CommandFailure::message("candidate access denied"))];
        outcomes.extend(preflight_outputs(&manifest));
        outcomes[2] = Ok(ExecOutput {
            stdout: "{\"schema\":1,\"ok\":false}".into(),
            ..ExecOutput::default()
        });
        outcomes.extend(preflight_outputs(&manifest));
        outcomes.extend(preflight_outputs(&manifest));
        let net = ScriptedNet::new(vec![], outcomes);
        let mut updater = Updater::with_net(base_config(), Some(base), net.clone());
        updater.paths.loongsuite_pilot_bin = root.join("service").to_string_lossy().into_owned();
        std::fs::write(&updater.paths.loongsuite_pilot_bin, b"old service").unwrap();
        std::fs::write(&updater.config_path, b"{\"user\":\"keep\"}\n").unwrap();
        let original: Vec<_> = updater
            .activation_targets()
            .into_values()
            .map(|path| {
                let bytes = std::fs::read(&path).ok();
                (path, bytes)
            })
            .collect();
        let assert_original = || {
            for (path, bytes) in &original {
                assert_eq!(&std::fs::read(path).ok(), bytes, "{}", path.display());
            }
            assert!(!root.join("update-recovery.json").exists());
        };
        for expected in ["candidate access denied", "预检失败"] {
            let err = match updater.activate_staged(&staging, &manifest).await {
                Ok(_) => panic!("预检失败时不应激活候选包"),
                Err(err) => err,
            };
            assert!(err.contains(expected), "{err}");
            assert_original();
            assert!(staging.join(binary).is_file());
            assert_eq!(std::fs::read_dir(&paths.versions_dir).unwrap().count(), 2);
        }

        let mut first = updater.activate_staged(&staging, &manifest).await.unwrap();
        let first_name = read_pointer_file(&paths.current_file).await.unwrap();
        assert_ne!(first_name, old_name);
        assert!(first_name.starts_with(&format!("1.2.0_{}_", manifest.git_commit)));
        assert_eq!(
            read_pointer_file(&paths.previous_file).await.as_deref(),
            Some(old_name.as_str())
        );
        assert!(!staging.exists());
        let first_root = Path::new(&paths.versions_dir).join(&first_name);
        assert!(first_root.join(binary).is_file());
        assert!(!first_root.join("live-only.txt").exists());
        first.rollback().unwrap();
        assert_original();

        native_package(&staging);
        let mut second = updater.activate_staged(&staging, &manifest).await.unwrap();
        let second_name = read_pointer_file(&paths.current_file).await.unwrap();
        assert_ne!(second_name, old_name);
        assert_ne!(second_name, first_name);
        second.commit().unwrap();
        assert_eq!(
            read_pointer_file(&paths.current_file).await.as_deref(),
            Some(second_name.as_str())
        );
        assert_eq!(
            read_pointer_file(&paths.previous_file).await.as_deref(),
            Some(old_name.as_str())
        );
        assert_eq!(
            std::fs::read(old_root.join("live-only.txt")).unwrap(),
            b"keep live tree"
        );
        assert_eq!(
            std::fs::read(old_root.join("runtime-manifest.json")).unwrap(),
            old_manifest
        );
        assert_eq!(sha256_file(&old_root.join(binary)).unwrap(), old_digest);
        assert!(first_root.join(binary).is_file());
        assert!(!root.join("update-recovery.json").exists());
        assert!(net.fetch_log.lock().unwrap().is_empty());
        let log = net.exec_log.lock().unwrap();
        assert_eq!(log.len(), 7);
        assert!(log
            .iter()
            .all(|(program, args)| Path::new(program) == staging.join(binary)
                && (args == &["--version"] || args == &["check", "--json"])));
    }

    fn native_package(root: &Path) -> VersionManifest {
        native_package_version(root, "1.2.0", &"a".repeat(40))
    }

    fn native_package_version(root: &Path, version: &str, commit: &str) -> VersionManifest {
        native_package_version_for_test(root, version, commit, None)
    }

    // Small resource bytes are only for component fixtures with scripted execution.
    // Native subprocess/capability tests retain the real test executable via None.
    fn native_package_version_for_test(
        root: &Path,
        version: &str,
        commit: &str,
        fixture_binary: Option<&[u8]>,
    ) -> VersionManifest {
        use crate::utils::runtime_paths::{sha256_file, RuntimeManifest, RuntimeResource};
        let manifest = super::super::release_manifest::fixture(version, commit);
        let binary = if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        };
        for directory in ["bin", "agents.d", "assets", "scripts"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        if let Some(bytes) = fixture_binary {
            std::fs::write(root.join(binary), bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(root.join(binary), std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
        } else {
            std::fs::copy(std::env::current_exe().unwrap(), root.join(binary)).unwrap();
        }
        let version = format!(
            "version={}\ngit_commit={}\n",
            manifest.version, manifest.git_commit
        );
        for (path, body) in [
            ("VERSION", version.as_str()),
            ("LICENSE", "license"),
            ("agents.d/test.json", "{}"),
            ("assets/test", "asset"),
            (
                "scripts/loongsuite-pilot.sh",
                "#!/bin/bash\n# native service\n",
            ),
            ("scripts/loongsuite-pilot.ps1", "native service"),
        ] {
            std::fs::write(root.join(path), body).unwrap();
        }
        let resources = walkdir::WalkDir::new(root)
            .into_iter()
            .map(Result::unwrap)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| RuntimeResource {
                path: entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/"),
                sha256: sha256_file(entry.path()).unwrap(),
            })
            .collect();
        let runtime = RuntimeManifest {
            schema: 1,
            runtime: "rust".into(),
            version: manifest.version.clone(),
            git_commit: manifest.git_commit.clone(),
            target: build_target().into(),
            edition: build_edition().into(),
            binary: binary.into(),
            resources,
        };
        std::fs::write(
            root.join("runtime-manifest.json"),
            serde_json::to_vec(&runtime).unwrap(),
        )
        .unwrap();
        manifest
    }

    #[cfg(target_os = "linux")]
    fn container_activation_fixture(root: &Path) -> Updater {
        use std::os::unix::fs::PermissionsExt;
        let mut updater = Updater::new(base_config(), root.to_str());
        updater.paths.loongsuite_pilot_bin = root
            .join("bin/loongsuite-pilot")
            .to_string_lossy()
            .into_owned();
        updater.config_path = root.join("config.json").to_string_lossy().into_owned();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("versions")).unwrap();
        std::fs::write(&updater.paths.loongsuite_pilot_bin, b"previous service").unwrap();
        std::fs::write(
            &updater.config_path,
            b"\xef\xbb\xbf{\"autoUpdate\":false}\n",
        )
        .unwrap();
        std::fs::set_permissions(&updater.config_path, std::fs::Permissions::from_mode(0o640))
            .unwrap();
        std::fs::write(&updater.paths.current_file, b"original\n").unwrap();
        std::fs::write(&updater.paths.previous_file, b"older\n").unwrap();
        let descriptor = json!({"schema":1,"containerId":"a".repeat(64),"image":format!("sha256:{}","b".repeat(64)),
            "dockerBinary":"/usr/bin/docker","launcherPath":updater.paths.loongsuite_pilot_bin,
            "cacheDir":root,"dataDir":root,"configPath":updater.config_path,
            "uid":unsafe{libc::geteuid()},"gid":unsafe{libc::getegid()},"startUpdater":false});
        std::fs::write(
            root.join("container-runtime.json"),
            serde_json::to_vec(&descriptor).unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(
            root.join("container-runtime.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        updater
    }

    #[cfg(target_os = "linux")]
    fn container_candidate(root: &Path) -> VersionManifest {
        use crate::utils::runtime_paths::{sha256_file, RuntimeManifest};
        let manifest = native_package(root);
        let script = root.join("scripts/loongsuite-pilot.sh");
        std::fs::write(&script, include_str!("../../scripts/loongsuite-pilot.sh")).unwrap();
        let path = root.join("runtime-manifest.json");
        let mut runtime: RuntimeManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        runtime
            .resources
            .iter_mut()
            .find(|r| r.path == "scripts/loongsuite-pilot.sh")
            .unwrap()
            .sha256 = sha256_file(&script).unwrap();
        std::fs::write(path, serde_json::to_vec(&runtime).unwrap()).unwrap();
        manifest
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn container_updater_rejects_missing_actual_caps_before_rename_or_state_writes() {
        let root = tempfile::tempdir().unwrap();
        let mut updater = container_activation_fixture(root.path());
        let staging = root.path().join("versions/unpacked");
        let manifest = container_candidate(&staging);
        let net = ScriptedNet::new(vec![], preflight_outputs(&manifest));
        updater.net = net.clone();
        let old_config = std::fs::read(&updater.config_path).unwrap();
        let old_mtime = std::fs::metadata(&updater.config_path)
            .unwrap()
            .modified()
            .unwrap();
        let error = updater
            .activate_staged(&staging, &manifest)
            .await
            .err()
            .expect("missing capabilities must reject");
        assert!(error.contains("候选运行时不支持本安装的容器服务入口与 Hook pin"));
        assert!(staging.is_dir());
        assert_eq!(
            std::fs::read(&updater.paths.current_file).unwrap(),
            b"original\n"
        );
        assert_eq!(
            std::fs::read(&updater.paths.previous_file).unwrap(),
            b"older\n"
        );
        assert_eq!(
            std::fs::read(&updater.paths.loongsuite_pilot_bin).unwrap(),
            b"previous service"
        );
        assert_eq!(std::fs::read(&updater.config_path).unwrap(), old_config);
        assert_eq!(
            std::fs::metadata(&updater.config_path)
                .unwrap()
                .modified()
                .unwrap(),
            old_mtime
        );
        assert!(!root.path().join("update-recovery.json").exists());
        assert_eq!(net.exec_log.lock().unwrap().len(), 2);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn container_updater_pins_final_package_after_rename_and_rolls_state_back() {
        let root = tempfile::tempdir().unwrap();
        let mut updater = container_activation_fixture(root.path());
        let staging = root.path().join("versions/unpacked");
        let manifest = container_candidate(&staging);
        let mut outputs = preflight_outputs(&manifest);
        outputs[1] = Ok(ExecOutput {
            stdout: json!({"schema":1,"runtime":"rust","ok":true,
            "version":manifest.version,"target":build_target(),"edition":build_edition(),
            "check":{"details":{"gitCommit":manifest.git_commit,
                "runtimeCapabilities":{"containerServiceHelper":1,"containerHookPin":1}}}})
            .to_string(),
            ..ExecOutput::default()
        });
        let net = ScriptedNet::new(vec![], outputs);
        updater.net = net.clone();
        let tx = updater.activate_staged(&staging, &manifest).await.unwrap();
        let current = read_pointer_file(&updater.paths.current_file)
            .await
            .unwrap();
        let installed = root.path().join("versions").join(&current);
        let helper = std::fs::canonicalize(installed.join("bin/loongsuite-pilot")).unwrap();
        let script = std::fs::read_to_string(&updater.paths.loongsuite_pilot_bin).unwrap();
        let quoted = format!("'{}'", helper.to_string_lossy().replace('\'', "'\"'\"'"));
        assert!(script.contains(&format!("LP_RUNTIME_HELPER={quoted}\n")));
        assert!(!script.contains(&format!("LP_RUNTIME_HELPER='{}", staging.display())));
        assert!(!staging.exists());
        assert!(helper.is_file());
        assert_eq!(net.exec_log.lock().unwrap().len(), 2);
        drop(tx);
        assert_eq!(
            std::fs::read(&updater.paths.current_file).unwrap(),
            b"original\n"
        );
        assert_eq!(
            std::fs::read(&updater.paths.previous_file).unwrap(),
            b"older\n"
        );
        assert_eq!(
            std::fs::read(&updater.paths.loongsuite_pilot_bin).unwrap(),
            b"previous service"
        );
        assert!(!root.path().join("update-recovery.json").exists());
    }

    fn preflight_outputs(manifest: &VersionManifest) -> Vec<Result<ExecOutput, CommandFailure>> {
        vec![
            Ok(ExecOutput {
                stdout: format!("loongsuite-pilot {}\n", manifest.version),
                ..ExecOutput::default()
            }),
            Ok(ExecOutput {
                stdout: json!({ "schema":1, "runtime":"rust", "ok":true,
                "version":manifest.version, "target":build_target(), "edition":build_edition(),
                "check":{"details":{"gitCommit":manifest.git_commit}} })
                .to_string(),
                ..ExecOutput::default()
            }),
        ]
    }

    fn filetime_set(path: &Path, secs: u64) -> std::io::Result<()> {
        let time = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
        let file = std::fs::File::open(path)?;
        file.set_modified(time)
    }

    #[tokio::test]
    async fn skips_gc_without_current_and_refuses_legacy_package() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap();
        let updater = Updater::new(base_config(), Some(base));
        tokio::fs::create_dir_all(Path::new(base).join("versions").join("1.0.0_old"))
            .await
            .unwrap();
        updater.gc_old_versions().await;
        assert!(Path::new(base).join("versions").join("1.0.0_old").exists());
        assert!(updater.resolve_current_version_dir().await.is_none());
        let legacy = Path::new(base).join("package").join("dist");
        tokio::fs::create_dir_all(&legacy).await.unwrap();
        tokio::fs::write(legacy.join("index.js"), "js")
            .await
            .unwrap();
        assert!(updater.resolve_current_version_dir().await.is_none());
    }

    #[tokio::test]
    async fn backs_off_after_download_failure_and_marks_degraded_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap();
        let net = ScriptedNet::new(
            vec![
                Ok(manifest_body("1.0.2", "bbb")),
                Ok(FetchResponse {
                    status: 500,
                    status_text: "Error".into(),
                    body: b"no".to_vec(),
                }),
                Ok(manifest_body("1.0.2", "bbb")),
            ],
            vec![],
        );
        let net_log = net.clone();
        let mut config = base_config();
        config.check_interval_ms = 10_000;
        let updater = Updater::with_net(config, Some(base), net);
        updater.check().await.unwrap_err();
        assert_eq!(updater.consecutive_failures(), 1);
        updater.check().await.unwrap();
        assert_eq!(net_log.fetch_log.lock().unwrap().len(), 2);

        updater.set_failure_state_for_test(9, 0);
        let net = ScriptedNet::new(
            vec![
                Ok(manifest_body("1.0.2", "bbb")),
                Ok(FetchResponse {
                    status: 500,
                    status_text: "Error".into(),
                    body: b"no".to_vec(),
                }),
            ],
            vec![],
        );
        let mut config = base_config();
        config.check_interval_ms = 60_000;
        let updater = Updater::with_net(config, Some(base), net);
        updater.start();
        updater.set_failure_state_for_test(9, 0);
        updater.check().await.unwrap_err();
        assert!(updater.is_scheduled());
        let runtime: Value = read_json_file(&updater.paths().runtime_file).await.unwrap();
        assert_eq!(runtime["status"], "degraded");
        assert!(
            updater.next_check_at().saturating_sub(system_now_ms())
                <= MAX_BACKOFF_MS as u128 + 1000
        );
        assert_eq!(backoff_ms(60_000, 100), MAX_BACKOFF_MS);
    }

    #[tokio::test]
    async fn resets_backoff_when_the_collector_is_already_current() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap();
        let paths = build_paths(base);
        native_package_version(
            &Path::new(&paths.versions_dir).join("1.0.2_aaa"),
            "1.0.2",
            &format!("{:0<40}", "aaa"),
        );
        write_pointer_file(&paths.current_file, "1.0.2_aaa")
            .await
            .unwrap();
        let runtime = json!({
            "status": "active",
            "packageVersion": "1.0.2",
            "gitCommit": format!("{:0<40}", "aaa"),
            "pid": std::process::id(),
            "updatedAt": "2099-01-01T00:00:00.000Z"
        });
        tokio::fs::create_dir_all(Path::new(&paths.collector_runtime_file).parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &paths.collector_runtime_file,
            serde_json::to_string(&runtime).unwrap(),
        )
        .await
        .unwrap();
        let net = ScriptedNet::new(vec![Ok(manifest_body("1.0.2", "aaa"))], vec![]);
        let mut updater = Updater::with_net(base_config(), Some(base), net);
        updater.set_failure_state_for_test(5, 0);
        updater.set_pid_alive(Arc::new(|_| true));
        updater.check().await.unwrap();
        assert_eq!(updater.consecutive_failures(), 0);
    }

    #[tokio::test]
    async fn alarms_with_recorded_restart_stage_and_ignores_stale_breadcrumbs() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap();
        let failure = CommandFailure {
            message: "Command failed".into(),
            stdout: Some("[restart-failure] target=collector stage=register-denied\n".into()),
            stderr: Some("Service manager failed to restart collector\n".into()),
            code: Some("1".into()),
            killed: Some(false),
            signal: None,
        };
        let net = ScriptedNet::new(vec![], vec![Err(failure.clone()), Err(failure)]);
        let mut updater = Updater::with_net(base_config(), Some(base), net);
        updater.set_health_timeout_ms(0);
        let metrics = Arc::new(UpdaterMetrics::new(
            crate::updater::updater_metrics::UpdaterMetricsOptions {
                data_dir: base.into(),
                version: "1.0.0".into(),
                collector_pid_file: format!("{base}/loongsuite-pilot.pid"),
                user_id: "user".into(),
                collector_liveness: None,
                date_string: Some(Arc::new(|| "2026-09-02".into())),
                now_ms: Some(Arc::new(system_now_ms)),
                alarm_sender: None,
                ip: Some("127.0.0.1".into()),
            },
        ));
        updater.set_metrics(metrics.clone());
        let fresh = json!({
            "schema": 1,
            "ts": system_now_ms() / 1000,
            "target": "collector",
            "stage": "register-denied",
            "init_type": "taskscheduler",
            "detail": "self-heal failed: Access is denied.",
            "diag": {"definition_owner": "BUILTIN\\Administrators"}
        });
        let breadcrumb = Path::new(base)
            .join("logs")
            .join("last-restart-failure-collector.json");
        tokio::fs::create_dir_all(breadcrumb.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&breadcrumb, serde_json::to_string_pretty(&fresh).unwrap())
            .await
            .unwrap();
        let err = updater
            .restart_collector("1.0.2", false, "")
            .await
            .unwrap_err();
        assert!(!err.is_empty());
        metrics.flush().await;
        let alarms = std::fs::read_to_string(
            Path::new(base)
                .join("logs")
                .join("metric_alarm")
                .join("pilot-alarms-2026-09-02.jsonl"),
        )
        .unwrap();
        assert!(alarms.contains("UPDATER_FAILURE_ALARM"));
        assert!(alarms.contains("stage=register-denied"));
        assert!(alarms.contains("definition_owner"));
        assert!(alarms.contains("register-denied"));

        let stale = json!({"schema": 1, "ts": 1, "target": "collector", "stage": "register-denied", "detail": "stale evidence from fifteen minutes ago"});
        tokio::fs::write(&breadcrumb, serde_json::to_string(&stale).unwrap())
            .await
            .unwrap();
        let net = ScriptedNet::new(
            vec![],
            vec![
                Err(CommandFailure::message("spawn ENOENT")),
                Err(CommandFailure::message("spawn ENOENT")),
            ],
        );
        let updater = Updater::with_net(base_config(), Some(base), net);
        updater.set_metrics(metrics.clone());
        updater
            .restart_collector("1.0.2", false, "")
            .await
            .unwrap_err();
        metrics.flush().await;
        let alarms = std::fs::read_to_string(
            Path::new(base)
                .join("logs")
                .join("metric_alarm")
                .join("pilot-alarms-2026-09-02.jsonl"),
        )
        .unwrap();
        let last = alarms.lines().last().unwrap();
        assert!(last.contains("stage=unknown"));
        assert!(!last.contains("stale evidence"));
    }

    #[tokio::test]
    async fn writes_timeout_breadcrumb_and_health_failure_after_start_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_str().unwrap();
        let timeout = CommandFailure {
            message: "Command failed".into(),
            stdout: None,
            stderr: None,
            code: None,
            killed: Some(true),
            signal: Some("SIGTERM".into()),
        };
        let net = ScriptedNet::new(vec![], vec![Err(timeout.clone()), Err(timeout)]);
        let updater = Updater::with_net(base_config(), Some(base), net);
        let metrics = Arc::new(UpdaterMetrics::new(
            crate::updater::updater_metrics::UpdaterMetricsOptions {
                data_dir: base.into(),
                version: "1.0.0".into(),
                collector_pid_file: format!("{base}/pid"),
                user_id: "user".into(),
                collector_liveness: None,
                date_string: Some(Arc::new(|| "2026-09-02".into())),
                now_ms: Some(Arc::new(system_now_ms)),
                alarm_sender: None,
                ip: Some("127.0.0.1".into()),
            },
        ));
        updater.set_metrics(metrics.clone());
        updater
            .restart_collector("1.0.2", false, "")
            .await
            .unwrap_err();
        let breadcrumb = read_restart_failure(base, RestartTarget::Collector)
            .await
            .unwrap();
        assert_eq!(breadcrumb.stage, "timeout");
        assert_eq!(breadcrumb.target, "collector");

        let restart_fail = CommandFailure {
            message: "Command failed".into(),
            stdout: Some("[restart-failure] target=collector stage=task-missing\n".into()),
            stderr: Some("Service manager failed to restart collector\n".into()),
            code: Some("1".into()),
            killed: Some(false),
            signal: None,
        };
        let net = ScriptedNet::new(vec![], vec![Err(restart_fail), Ok(ExecOutput::default())]);
        let mut updater = Updater::with_net(base_config(), Some(base), net);
        updater.set_health_timeout_ms(0);
        updater.set_metrics(metrics.clone());
        let fresh = json!({
            "schema": 1,
            "ts": system_now_ms() / 1000,
            "target": "collector",
            "stage": "task-missing",
            "detail": "scheduled task is not registered"
        });
        let path = Path::new(base)
            .join("logs")
            .join("last-restart-failure-collector.json");
        tokio::fs::write(&path, serde_json::to_string(&fresh).unwrap())
            .await
            .unwrap();
        let err = updater
            .restart_collector("1.0.2", false, "")
            .await
            .unwrap_err();
        assert!(err.contains("did not become healthy") || err.contains("runtime record not found"));
        metrics.flush().await;
        let alarms = std::fs::read_to_string(
            Path::new(base)
                .join("logs")
                .join("metric_alarm")
                .join("pilot-alarms-2026-09-02.jsonl"),
        )
        .unwrap();
        let last = alarms.lines().last().unwrap();
        assert!(last.contains("stage=task-missing"));
        assert!(last.contains("health check failed after start-collector recovery"));
        assert!(last.contains("runtime record not found"));
    }

    #[tokio::test]
    async fn checksum_accepts_binary_mode_lines() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("node.tar.gz");
        std::fs::write(&archive, b"payload").unwrap();
        let actual = compute_sha256(archive.to_str().unwrap()).unwrap();
        let sums = dir.path().join("SHASUMS256.txt");
        std::fs::write(&sums, format!("{actual} *node.tar.gz\n")).unwrap();
        assert!(verify_checksum(&archive, &sums, "node.tar.gz").await);
        std::fs::write(&sums, format!("{}  other\n", "ab")).unwrap();
        assert!(!verify_checksum(&archive, &sums, "node.tar.gz").await);
    }

    #[tokio::test]
    async fn rejects_damaged_pointers_and_legacy_current_without_fetching() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![], vec![]);
        let updater = Updater::with_net(base_config(), root.path().to_str(), net.clone());
        for content in ["../escape", "", "1.2.3.", "missing"] {
            std::fs::write(&updater.paths.current_file, content).unwrap();
            assert!(updater.check_once().await.is_err(), "{content}");
            assert_eq!(
                std::fs::read_to_string(&updater.paths.current_file).unwrap(),
                content
            );
        }
        let legacy = root.path().join("versions/legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("VERSION"), "version=1.0.0\ngit_commit=old\n").unwrap();
        std::fs::write(&updater.paths.current_file, "legacy").unwrap();
        assert!(updater.check_once().await.unwrap_err().contains("原生包"));
        assert!(net.fetch_log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn gc_preserves_running_updater_unknown_and_staging_directories() {
        let root = tempfile::tempdir().unwrap();
        let updater = Updater::with_net(
            base_config(),
            root.path().to_str(),
            ScriptedNet::new(vec![], vec![]),
        );
        write_pointer_file(&updater.paths.current_file, "current")
            .await
            .unwrap();
        let versions = Path::new(&updater.paths.versions_dir);
        let running_name = format!("1.2.0_{}_{}", "a".repeat(40), uuid::Uuid::new_v4().simple());
        let running = versions.join(&running_name);
        native_package(&running);
        for name in ["current", ".unpack-temp", "candidate", "legacy", "unknown"] {
            std::fs::create_dir_all(versions.join(name)).unwrap();
        }
        let executable = running.join(if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        });
        updater.gc_old_versions_for(&executable).await;
        for name in [
            "current",
            ".unpack-temp",
            "candidate",
            "legacy",
            "unknown",
            &running_name,
        ] {
            assert!(versions.join(name).is_dir(), "{name}");
        }
    }

    struct PendingNet {
        entered: tokio::sync::Notify,
        dropped: AtomicBool,
    }
    #[async_trait]
    impl UpdaterNet for PendingNet {
        async fn fetch(&self, _: &str, _: u64) -> Result<FetchResponse, String> {
            struct Guard<'a>(&'a AtomicBool);
            impl Drop for Guard<'_> {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::SeqCst);
                }
            }
            let _guard = Guard(&self.dropped);
            self.entered.notify_one();
            std::future::pending().await
        }
        async fn exec(&self, _: &ExecRequest) -> Result<ExecOutput, CommandFailure> {
            panic!("不得调用服务命令");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_cancels_pending_checks_and_releases_reentry_guard_and_lock() {
        let root = tempfile::tempdir().unwrap();
        let net = Arc::new(PendingNet {
            entered: tokio::sync::Notify::new(),
            dropped: AtomicBool::new(false),
        });
        let mut updater = Updater::with_net(base_config(), root.path().to_str(), net.clone());
        updater.paths.loongsuite_pilot_bin = root
            .path()
            .join("service-bin/loongsuite-pilot")
            .to_string_lossy()
            .into_owned();
        updater.config_path = root
            .path()
            .join("config.json")
            .to_string_lossy()
            .into_owned();
        std::fs::write(
            &updater.config_path,
            r#"{"autoUpdate":{"manifestUrl":"https://example.invalid/latest-rust.json"}}"#,
        )
        .unwrap();
        let updater = Arc::new(updater);
        let (send, receive) = tokio::sync::oneshot::channel();
        let runner = updater.clone();
        let task = tokio::spawn(async move {
            runner
                .run_until(async {
                    let _ = receive.await;
                })
                .await
        });
        tokio::task::yield_now().await;
        assert!(!updater.is_checking());
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::time::resume();
        tokio::time::timeout(Duration::from_secs(2), net.entered.notified())
            .await
            .unwrap();
        assert!(updater.is_checking());
        send.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(net.dropped.load(Ordering::SeqCst));
        assert!(!updater.is_checking());
        assert!(!updater.is_scheduled());
        let lock = root.path().join("update.lock");
        crate::deployment::with_deployed_state_lock(
            &lock.to_string_lossy(),
            || async { Ok(()) },
            100,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reload_respects_disabled_and_preserves_damaged_config() {
        let root = tempfile::tempdir().unwrap();
        let net = ScriptedNet::new(vec![], vec![]);
        let updater = Updater::with_net(base_config(), root.path().to_str(), net.clone());
        updater.start();
        std::fs::write(&updater.config_path, r#"{"autoUpdate":{"enabled":false}}"#).unwrap();
        updater.scheduled_check().await;
        assert!(!updater.is_scheduled());
        std::fs::write(&updater.config_path, "{broken").unwrap();
        assert!(updater.ensure_install_id().await.is_err());
        assert!(updater.persist_canary_state(1).await.is_err());
        updater.scheduled_check().await;
        assert_eq!(
            std::fs::read_to_string(&updater.config_path).unwrap(),
            "{broken"
        );
        assert!(net.fetch_log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn maintenance_repeats_heartbeats_flush_and_health_without_waiting_for_download() {
        let root = tempfile::tempdir().unwrap();
        let updater = Updater::with_net(
            base_config(),
            root.path().to_str(),
            ScriptedNet::new(vec![], vec![]),
        );
        let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = checks.clone();
        let metrics = Arc::new(UpdaterMetrics::new(crate::updater::UpdaterMetricsOptions {
            data_dir: root.path().to_string_lossy().into_owned(),
            version: "1.2.0".into(),
            collector_pid_file: root.path().join("pid").to_string_lossy().into_owned(),
            user_id: "fixture".into(),
            collector_liveness: Some(Arc::new(move |_| {
                count.fetch_add(1, Ordering::SeqCst);
                crate::utils::ProcessLiveness {
                    running: true,
                    reason: String::new(),
                    pid: None,
                    source: crate::utils::ProcessLivenessSource::None,
                    pid_file_state: None,
                    pid_file_process_alive: None,
                    pid_file_command: None,
                    pid_file_command_matched: None,
                }
            })),
            date_string: Some(Arc::new(|| "test".into())),
            now_ms: None,
            alarm_sender: None,
            ip: Some("127.0.0.1".into()),
        }));
        updater.set_metrics(metrics.clone());
        updater.start();
        let observe = async {
            loop {
                if checks.load(Ordering::SeqCst) >= 2
                    && Path::new(&updater.paths.runtime_file).is_file()
                    && root
                        .path()
                        .join("logs/metric_alarm/pilot-updater-events-test.jsonl")
                        .is_file()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::select! { _ = observe => {}, _ = updater.maintain_with_intervals(10, 10, 10) => panic!("周期任务提前退出") }
        }).await.unwrap();
        let events = std::fs::read_to_string(
            root.path()
                .join("logs/metric_alarm/pilot-updater-events-test.jsonl"),
        )
        .unwrap();
        assert!(events.contains("updater_started"));
        updater.stop();
    }

    #[test]
    fn reentry_flag_skips_a_second_check() {
        let updater = Updater::new(base_config(), Some("/tmp/test-updater"));
        updater.set_checking_for_test(true);
        assert!(updater.is_checking());
        updater.start();
        updater.stop();
        assert!(!updater.is_scheduled());
        let disabled = AutoUpdateConfig {
            enabled: false,
            ..base_config()
        };
        let quiet = Updater::new(disabled, Some("/tmp/test-updater"));
        quiet.start();
        assert!(!quiet.is_scheduled());
    }
    include!("updater_contract_tests.rs");
}
