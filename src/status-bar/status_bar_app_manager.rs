//! Port of `src/status-bar/status-bar-app-manager.ts`.
//!
//! Process spawn and `ps`/`pgrep` are injected so the lifecycle, runtime record,
//! and executable search can be tested without a macOS menu bar binary.

use crate::utils::{
    acquire_single_instance_lock, ensure_dir, read_json_file, resolve_home, write_json_file,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const BINARY_NAME: &str = "LoongSuitePilotMenuBarApp";
pub const STOP_TIMEOUT_MS: u64 = 3000;
pub const FORCE_STOP_TIMEOUT_MS: u64 = 1500;
pub const STOP_LOCK_WAIT_MS: u64 = 5000;
pub const LOCK_RETRY_INTERVAL_MS: u64 = 100;
pub const DEFAULT_XCODE_DEVELOPER_DIR: &str = "/Applications/Xcode.app/Contents/Developer";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusBarAppRuntime {
    pub executable_path: String,
    pub package_version: String,
    pub pid: Option<u32>,
    pub executable_fingerprint: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusBarAppStartResult {
    pub status: &'static str,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusBarAppStopResult {
    pub status: &'static str,
    pub pids: Vec<u32>,
}

pub type ProcessSignaler = Arc<dyn Fn(u32, &str) + Send + Sync>;
pub type AppSpawner = Arc<dyn Fn(&str, &str) -> Result<u32, String> + Send + Sync>;

#[derive(Clone)]
pub struct ProcessOps {
    pub read_command: Arc<dyn Fn(u32) -> Option<String> + Send + Sync>,
    pub find_pids: Arc<dyn Fn() -> Vec<u32> + Send + Sync>,
    pub signal: ProcessSignaler,
    pub alive: Arc<dyn Fn(u32) -> bool + Send + Sync>,
    pub spawn: AppSpawner,
    pub platform_darwin: bool,
    pub arch_x64: bool,
}

impl ProcessOps {
    /// 原生进程操作；不调用 Node、Shell 或用户 PATH 中的进程查询工具。
    pub fn native(data_dir: &str) -> Self {
        let data_dir = data_dir.to_owned();
        Self {
            read_command: Arc::new(native_executable),
            find_pids: Arc::new(|| {
                let system = native_processes(None);
                system
                    .processes()
                    .iter()
                    .filter_map(|(pid, process)| {
                        (process.exe().and_then(Path::file_name)
                            == Some(std::ffi::OsStr::new(BINARY_NAME)))
                        .then_some(pid.as_u32())
                    })
                    .collect()
            }),
            signal: Arc::new(|pid, signal| {
                let system = native_processes(Some(pid));
                if let Some(process) = system.process(sysinfo::Pid::from_u32(pid)) {
                    let signal = match signal {
                        "SIGTERM" => sysinfo::Signal::Term,
                        "SIGKILL" => sysinfo::Signal::Kill,
                        _ => return,
                    };
                    let _ = process.kill_with(signal);
                }
            }),
            alive: Arc::new(|pid| native_executable(pid).is_some()),
            spawn: Arc::new(move |executable, log| {
                let log = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log)
                    .map_err(|err| err.to_string())?;
                let stderr = log.try_clone().map_err(|err| err.to_string())?;
                let mut command = std::process::Command::new(executable);
                command
                    .env("LOONGSUITE_PILOT_DATA_DIR", &data_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(log)
                    .stderr(stderr);
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    command.process_group(0);
                }
                let mut child = command.spawn().map_err(|err| err.to_string())?;
                let pid = child.id();
                // 子进程独立于 collector 的等待循环；回收退出状态，避免僵尸进程。
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                Ok(pid)
            }),
            platform_darwin: cfg!(target_os = "macos"),
            arch_x64: cfg!(target_arch = "x86_64"),
        }
    }

    #[cfg(test)]
    pub fn inert(darwin: bool) -> Self {
        Self {
            read_command: Arc::new(|_| None),
            find_pids: Arc::new(Vec::new),
            signal: Arc::new(|_, _| {}),
            alive: Arc::new(|_| false),
            spawn: Arc::new(|_, _| Err("spawn not configured".into())),
            platform_darwin: darwin,
            arch_x64: cfg!(target_arch = "x86_64"),
        }
    }
}

fn native_processes(pid: Option<u32>) -> sysinfo::System {
    let mut system = sysinfo::System::new();
    let pids = pid.map(|pid| [sysinfo::Pid::from_u32(pid)]);
    let selected = pids
        .as_ref()
        .map_or(sysinfo::ProcessesToUpdate::All, |pids| {
            sysinfo::ProcessesToUpdate::Some(pids)
        });
    system.refresh_processes_specifics(
        selected,
        true,
        sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    system
}

fn native_executable(pid: u32) -> Option<String> {
    let system = native_processes(Some(pid));
    let process = system.process(sysinfo::Pid::from_u32(pid))?;
    if matches!(
        process.status(),
        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
    ) {
        return None;
    }
    process
        .exe()
        .map(|path| path.to_string_lossy().into_owned())
}

struct ControlLock(crate::utils::SingleInstanceLock);

impl Drop for ControlLock {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub struct StatusBarAppManager {
    data_dir: String,
    cache_dir: String,
    package_version: String,
    ops: ProcessOps,
    source_roots: Vec<String>,
}

impl StatusBarAppManager {
    pub fn new(
        data_dir: impl Into<String>,
        package_version: impl Into<String>,
        ops: ProcessOps,
    ) -> Self {
        let data_dir = data_dir.into();
        let cache_dir = std::env::var("LOONGSUITE_PILOT_CACHE_DIR")
            .ok()
            .filter(|value| !value.is_empty())
            .map(|value| resolve_home(&value))
            .unwrap_or_else(|| data_dir.clone());
        Self {
            data_dir,
            cache_dir,
            package_version: package_version.into(),
            ops,
            source_roots: Vec::new(),
        }
    }

    pub fn set_cache_dir(&mut self, cache_dir: impl Into<String>) {
        self.cache_dir = cache_dir.into();
    }

    pub fn with_source_roots(mut self, roots: Vec<String>) -> Self {
        self.source_roots = roots;
        self
    }

    pub fn runtime_record_path(&self) -> String {
        Path::new(&self.data_dir)
            .join("logs")
            .join("status-bar-app-runtime.json")
            .to_string_lossy()
            .into_owned()
    }

    pub fn lock_path(&self) -> String {
        Path::new(&self.data_dir)
            .join("status-bar-app-start.lock")
            .to_string_lossy()
            .into_owned()
    }

    pub async fn sync_desired_state(&self, enabled: bool) -> Result<(), String> {
        if !self.ops.platform_darwin {
            return Ok(());
        }
        if enabled {
            self.start().await.map(|_| ())
        } else {
            self.stop("config-disabled").await.map(|_| ())
        }
    }

    pub async fn start(&self) -> Result<Option<StatusBarAppStartResult>, String> {
        if !self.ops.platform_darwin {
            return Ok(None);
        }
        let executable = self.prepare_executable().await;
        self.with_lock(0, || self.ensure_started(executable.clone()))
            .await
    }

    pub async fn stop(&self, reason: &str) -> Result<StatusBarAppStopResult, String> {
        if !self.ops.platform_darwin {
            return Ok(StatusBarAppStopResult {
                status: "already-stopped",
                pids: Vec::new(),
            });
        }
        let reason = reason.to_string();
        self.with_lock(STOP_LOCK_WAIT_MS, || self.stop_processes(&reason))
            .await
    }

    async fn with_lock<T, F, Fut>(&self, wait_ms: u64, action: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
        let lock = loop {
            let acquired = acquire_single_instance_lock(&self.lock_path(), None);
            let holder = acquired.holder_pid;
            if let Some(lock) = acquired.lock {
                break lock;
            }
            if std::time::Instant::now() >= deadline {
                let holder = holder
                    .map(|pid| format!(" (holder PID {pid})"))
                    .unwrap_or_default();
                return Err(format!("Cannot acquire menu bar control lock{holder}; another start or stop may be in progress. Retry shortly."));
            }
            tokio::time::sleep(std::time::Duration::from_millis(LOCK_RETRY_INTERVAL_MS)).await;
        };
        // future 被取消时也释放生命周期锁，避免同进程内永远无法重试。
        let _guard = ControlLock(lock);
        action().await
    }

    async fn prepare_executable(&self) -> Option<String> {
        if let Some(path) = self.resolve_executable() {
            return Some(path);
        }
        if let Some(runtime) = self.read_runtime().await {
            if runtime.package_version == self.package_version {
                if let Some(pid) = runtime.pid {
                    if self.is_process_running(pid, &runtime.executable_path).await {
                        return None;
                    }
                }
            }
        }
        // 安装包必须携带 UI 二进制，缺失时不可假造路径或要求用户安装 Swift。
        None
    }

    async fn stop_processes(&self, _reason: &str) -> Result<StatusBarAppStopResult, String> {
        let runtime = self.read_runtime().await;
        let mut stopped = Vec::new();
        let executables = self.resolve_managed_executable_paths(
            runtime.as_ref().map(|item| item.executable_path.as_str()),
        );
        let mut candidates = (self.ops.find_pids)();
        if let Some(pid) = runtime.as_ref().and_then(|item| item.pid) {
            if !candidates.contains(&pid) {
                candidates.push(pid);
            }
        }
        for pid in candidates {
            for executable in &executables {
                if self.is_process_running(pid, executable).await {
                    (self.ops.signal)(pid, "SIGTERM");
                    stopped.push((pid, executable.clone()));
                    break;
                }
            }
        }
        for (pid, executable) in &stopped {
            if !self.wait_for_exit(*pid, executable, STOP_TIMEOUT_MS).await {
                // 优雅退出期间 PID 可能被复用，升级信号前必须重新验证身份。
                if !self.is_process_running(*pid, executable).await {
                    continue;
                }
                (self.ops.signal)(*pid, "SIGKILL");
                if !self
                    .wait_for_exit(*pid, executable, FORCE_STOP_TIMEOUT_MS)
                    .await
                {
                    return Err(format!("Menu bar app did not stop (PID {pid}); keeping its runtime record for retry."));
                }
            }
        }
        self.remove_runtime().await;
        Ok(StatusBarAppStopResult {
            status: if stopped.is_empty() {
                "already-stopped"
            } else {
                "stopped"
            },
            pids: stopped.into_iter().map(|(pid, _)| pid).collect(),
        })
    }

    async fn ensure_started(
        &self,
        prepared: Option<String>,
    ) -> Result<Option<StatusBarAppStartResult>, String> {
        let runtime = self.read_runtime().await;
        let executable = prepared.or_else(|| self.resolve_executable());
        if let Some(runtime) = runtime.as_ref() {
            if let Some(pid) = runtime.pid {
                if self.is_process_running(pid, &runtime.executable_path).await {
                    if runtime.package_version == self.package_version
                        && executable
                            .as_deref()
                            .map(|path| path == runtime.executable_path)
                            .unwrap_or(true)
                    {
                        return Ok(Some(StatusBarAppStartResult {
                            status: "already-running",
                            pid,
                        }));
                    }
                    if executable.is_none() {
                        return Ok(None);
                    }
                    self.stop_processes("version-upgrade").await?;
                }
            }
        }
        let Some(executable_path) = executable else {
            return Ok(None);
        };
        let managed = self.resolve_managed_executable_paths(
            runtime.as_ref().map(|item| item.executable_path.as_str()),
        );
        let mut managed_processes = Vec::new();
        let mut unmanaged = Vec::new();
        for pid in (self.ops.find_pids)() {
            let mut matched = None;
            for candidate in &managed {
                if self.is_process_running(pid, candidate).await {
                    matched = Some(candidate.clone());
                    break;
                }
            }
            if let Some(path) = matched {
                managed_processes.push((pid, path));
            } else if (self.ops.read_command)(pid).is_some() {
                unmanaged.push(pid);
            }
        }
        if managed_processes.len() == 1 && managed_processes[0].1 == executable_path {
            let pid = managed_processes[0].0;
            self.record_process(&executable_path, pid).await?;
            return Ok(Some(StatusBarAppStartResult {
                status: "already-running",
                pid,
            }));
        }
        if !unmanaged.is_empty() {
            let list = unmanaged
                .iter()
                .map(|pid| pid.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!("Found same-named menu bar process outside this Pilot installation (PID {list}); refusing to start a duplicate."));
        }
        if !managed_processes.is_empty() {
            self.stop_processes("replace-old-or-duplicate").await?;
        }
        self.spawn_process(&executable_path).await
    }

    async fn spawn_process(
        &self,
        executable_path: &str,
    ) -> Result<Option<StatusBarAppStartResult>, String> {
        let log_path = self.prepare_log_path().await;
        let pid = (self.ops.spawn)(executable_path, &log_path)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            if self.is_process_running(pid, executable_path).await {
                break;
            }
            if !(self.ops.alive)(pid) || std::time::Instant::now() >= deadline {
                return Ok(None);
            }
        }
        self.record_process(executable_path, pid).await?;
        Ok(Some(StatusBarAppStartResult {
            status: "started",
            pid,
        }))
    }

    async fn record_process(&self, executable_path: &str, pid: u32) -> Result<(), String> {
        self.write_runtime(&StatusBarAppRuntime {
            executable_path: executable_path.to_string(),
            package_version: self.package_version.clone(),
            pid: Some(pid),
            executable_fingerprint: fingerprint(executable_path).await,
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })
        .await
    }

    pub fn resolve_executable(&self) -> Option<String> {
        self.resolve_executable_candidates(false)
            .into_iter()
            .find(|candidate| Path::new(candidate).is_file())
    }

    pub fn resolve_managed_executable_paths(&self, recorded: Option<&str>) -> Vec<String> {
        let current = self.resolve_executable();
        let mut paths = Vec::new();
        if let Some(recorded) = recorded {
            paths.push(recorded.to_string());
        }
        if let Some(current) = current {
            paths.push(current);
        }
        paths.extend(self.resolve_executable_candidates(true));
        unique_paths(paths)
    }

    pub fn resolve_executable_candidates(&self, historical: bool) -> Vec<String> {
        let current_arch = if self.ops.arch_x64 {
            "darwin-x64"
        } else {
            "darwin-arm64"
        };
        let bundles: &[&str] = if historical {
            &["darwin-universal", "darwin-arm64", "darwin-x64"]
        } else {
            &["darwin-universal", current_arch]
        };
        let mut candidates = Vec::new();
        for source in self.resolve_source_dirs(historical) {
            for bundle in bundles {
                candidates.push(
                    Path::new(&source)
                        .join("bin")
                        .join(bundle)
                        .join(BINARY_NAME)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        candidates.push(
            Path::new(&self.data_dir)
                .join("apps")
                .join("macos-status-bar")
                .join("build")
                .join(BINARY_NAME)
                .to_string_lossy()
                .into_owned(),
        );
        unique_paths(candidates)
    }

    pub fn swiftc_args(
        sdk: &str,
        out_path: &str,
        arch_x64: bool,
        sources: &[String],
    ) -> Vec<String> {
        let target = if arch_x64 {
            "x86_64-apple-macosx13.0"
        } else {
            "arm64-apple-macosx13.0"
        };
        let mut args = vec![
            "-O".into(),
            "-target".into(),
            target.into(),
            "-sdk".into(),
            sdk.into(),
            "-o".into(),
            out_path.into(),
            "-framework".into(),
            "AppKit".into(),
            "-framework".into(),
            "SwiftUI".into(),
            "-framework".into(),
            "Charts".into(),
            "-framework".into(),
            "Combine".into(),
        ];
        args.extend(sources.iter().cloned());
        args
    }

    fn resolve_source_dirs(&self, historical: bool) -> Vec<String> {
        let mut candidates: Vec<String> = self
            .source_roots
            .iter()
            .map(|root| {
                Path::new(root)
                    .join("app")
                    .join("macos-status-bar")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        if let Ok(current) = std::fs::read_to_string(Path::new(&self.cache_dir).join("current")) {
            let current = current.trim();
            if !current.is_empty()
                && current != "."
                && current != ".."
                && current
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            {
                candidates.push(
                    Path::new(&self.cache_dir)
                        .join("versions")
                        .join(current)
                        .join("app")
                        .join("macos-status-bar")
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        candidates.push(
            Path::new(&self.cache_dir)
                .join("package")
                .join("app")
                .join("macos-status-bar")
                .to_string_lossy()
                .into_owned(),
        );
        if historical {
            if let Ok(entries) = std::fs::read_dir(Path::new(&self.cache_dir).join("versions")) {
                for entry in entries.flatten() {
                    if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                        candidates.push(
                            entry
                                .path()
                                .join("app")
                                .join("macos-status-bar")
                                .to_string_lossy()
                                .into_owned(),
                        );
                    }
                }
            }
        }
        unique_paths(candidates)
            .into_iter()
            .filter(|candidate| Path::new(candidate).join("bin").is_dir())
            .collect()
    }

    async fn is_process_running(&self, pid: u32, executable_path: &str) -> bool {
        // 原生适配返回 executable 而非命令行，带空格的另一个路径不能当作参数。
        (self.ops.read_command)(pid).as_deref() == Some(executable_path)
    }

    async fn wait_for_exit(&self, pid: u32, executable: &str, timeout_ms: u64) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            if !(self.ops.alive)(pid) || !self.is_process_running(pid, executable).await {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    async fn prepare_log_path(&self) -> String {
        let log_dir = Path::new(&self.data_dir)
            .join("logs")
            .join("app-status-bar");
        ensure_dir(&log_dir.to_string_lossy()).await;
        let today = chrono::Local::now().format("%Y-%m-%d");
        log_dir
            .join(format!("status-bar-app-{today}.log"))
            .to_string_lossy()
            .into_owned()
    }

    async fn read_runtime(&self) -> Option<StatusBarAppRuntime> {
        read_json_file(&self.runtime_record_path()).await
    }

    async fn write_runtime(&self, record: &StatusBarAppRuntime) -> Result<(), String> {
        if let Some(parent) = Path::new(&self.runtime_record_path()).parent() {
            ensure_dir(&parent.to_string_lossy()).await;
        }
        write_json_file(&self.runtime_record_path(), record)
            .await
            .map_err(|err| err.to_string())
    }

    async fn remove_runtime(&self) {
        let _ = tokio::fs::remove_file(self.runtime_record_path()).await;
    }
}

pub fn command_matches_executable(command: Option<&str>, executable_path: &str) -> bool {
    let Some(command) = command.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    command == executable_path || command.starts_with(&format!("{executable_path} "))
}

pub fn unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for path in paths {
        let normalized = normalize_path(&path);
        if !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

fn normalize_path(path: &str) -> String {
    let absolute = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut parts = Vec::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

async fn fingerprint(path: &str) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Some(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn ops_with(commands: Vec<(u32, String)>, alive: Vec<u32>) -> ProcessOps {
        let commands = Arc::new(Mutex::new(commands));
        let alive_pids = Arc::new(Mutex::new(alive));
        let signals = Arc::new(Mutex::new(Vec::<(u32, String)>::new()));
        let signal_log = signals.clone();
        let command_map = commands.clone();
        let alive_map = alive_pids.clone();
        let alive_lookup = alive_map.clone();
        ProcessOps {
            read_command: Arc::new(move |pid| {
                command_map
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(id, _)| *id == pid)
                    .map(|(_, command)| command.clone())
            }),
            find_pids: Arc::new(move || alive_map.lock().unwrap().clone()),
            signal: Arc::new(move |pid, signal| {
                signal_log.lock().unwrap().push((pid, signal.to_string()));
                if signal == "SIGTERM" || signal == "SIGKILL" {
                    alive_pids.lock().unwrap().retain(|id| *id != pid);
                    commands.lock().unwrap().retain(|(id, _)| *id != pid);
                }
            }),
            alive: Arc::new(move |pid| alive_lookup.lock().unwrap().contains(&pid)),
            spawn: Arc::new(|_, _| Ok(4242)),
            platform_darwin: true,
            arch_x64: true,
        }
    }

    #[tokio::test]
    async fn skips_non_darwin_and_removes_the_runtime_record_on_stop() {
        let dir = tempfile::tempdir().unwrap();
        let manager = StatusBarAppManager::new(
            dir.path().to_str().unwrap(),
            "1.0.0",
            ProcessOps::inert(false),
        );
        assert!(manager.start().await.unwrap().is_none());
        assert_eq!(
            manager.stop("config-disabled").await.unwrap().status,
            "already-stopped"
        );

        let bin = dir.path().join("LoongSuitePilotMenuBarApp");
        std::fs::write(&bin, b"binary").unwrap();
        let ops = ops_with(vec![(7, bin.to_string_lossy().into_owned())], vec![7]);
        let manager = StatusBarAppManager::new(dir.path().to_str().unwrap(), "1.0.0", ops);
        let record = StatusBarAppRuntime {
            executable_path: bin.to_string_lossy().into_owned(),
            package_version: "1.0.0".into(),
            pid: Some(7),
            executable_fingerprint: None,
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        };
        manager.write_runtime(&record).await.unwrap();
        let stopped = manager.stop("cli-request").await.unwrap();
        assert_eq!(stopped.status, "stopped");
        assert_eq!(stopped.pids, vec![7]);
        assert!(!Path::new(&manager.runtime_record_path()).exists());
    }

    #[tokio::test]
    async fn adopts_a_matching_process_and_refuses_an_outside_installation() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir
            .path()
            .join("apps")
            .join("macos-status-bar")
            .join("build");
        std::fs::create_dir_all(&app).unwrap();
        let bin = app.join(BINARY_NAME);
        std::fs::write(&bin, b"app").unwrap();
        let path = bin.to_string_lossy().into_owned();
        let ops = ops_with(vec![(9, path.clone())], vec![9]);
        let manager = StatusBarAppManager::new(dir.path().to_str().unwrap(), "1.2.0", ops);
        let started = manager.start().await.unwrap().unwrap();
        assert_eq!(started.status, "already-running");
        assert_eq!(started.pid, 9);
        let runtime: StatusBarAppRuntime = read_json_file(&manager.runtime_record_path())
            .await
            .unwrap();
        assert_eq!(runtime.executable_path, path);
        assert_eq!(runtime.package_version, "1.2.0");
        assert!(runtime.executable_fingerprint.unwrap().len() == 64);

        let outside = ops_with(
            vec![(11, "/other/LoongSuitePilotMenuBarApp".into())],
            vec![11],
        );
        let manager = StatusBarAppManager::new(dir.path().to_str().unwrap(), "1.2.0", outside);
        let err = manager.start().await.unwrap_err();
        assert!(err.contains("outside this Pilot installation"));
        assert!(err.contains("11"));
    }

    #[test]
    fn command_match_and_swiftc_args() {
        for (command, executable, expected) in [
            (
                "/managed/LoongSuitePilotMenuBarApp",
                "/managed/LoongSuitePilotMenuBarApp",
                true,
            ),
            (
                "/managed/LoongSuitePilotMenuBarApp --flag",
                "/managed/LoongSuitePilotMenuBarApp",
                true,
            ),
            (
                "LoongSuitePilotMenuBarApp",
                "/managed/LoongSuitePilotMenuBarApp",
                false,
            ),
            (
                "/old/LoongSuitePilotMenuBarApp",
                "/managed/LoongSuitePilotMenuBarApp",
                false,
            ),
            (
                "/old/LoongSuitePilotMenuBarApp",
                "/old/LoongSuitePilotMenuBarApp",
                true,
            ),
        ] {
            assert_eq!(
                command_matches_executable(Some(command), executable),
                expected
            );
        }
        assert!(!command_matches_executable(
            None,
            "/managed/LoongSuitePilotMenuBarApp"
        ));
        let args = StatusBarAppManager::swiftc_args("/sdk", "/out", false, &["A.swift".into()]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-target", "arm64-apple-macosx13.0"]));
        assert!(args.iter().any(|arg| arg == "AppKit"));
        assert_eq!(args.last().map(String::as_str), Some("A.swift"));
    }

    #[test]
    fn native_adapter_reads_actual_executable_without_shell() {
        let ops = ProcessOps::native("/unused-test-data");
        let actual = (ops.read_command)(std::process::id()).unwrap();
        assert_eq!(
            std::fs::canonicalize(actual).unwrap(),
            std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap()
        );
        assert!((ops.alive)(std::process::id()));
        assert!(!(ops.alive)(u32::MAX));
        assert_eq!(ops.platform_darwin, cfg!(target_os = "macos"));
    }

    #[tokio::test]
    async fn pid_reused_after_term_is_never_force_killed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(BINARY_NAME).to_string_lossy().into_owned();
        let current = Arc::new(Mutex::new(path.clone()));
        let read = current.clone();
        let signals = Arc::new(Mutex::new(Vec::new()));
        let sent = signals.clone();
        let mut ops = ProcessOps::inert(true);
        ops.read_command = Arc::new(move |_| Some(read.lock().unwrap().clone()));
        ops.find_pids = Arc::new(|| vec![42]);
        ops.alive = Arc::new(|_| true);
        ops.signal = Arc::new(move |_, signal| {
            sent.lock().unwrap().push(signal.to_owned());
            *current.lock().unwrap() = "/different/process".into();
        });
        let manager = StatusBarAppManager::new(dir.path().to_str().unwrap(), "1", ops);
        manager.record_process(&path, 42).await.unwrap();
        assert_eq!(manager.stop("test").await.unwrap().pids, [42]);
        assert_eq!(*signals.lock().unwrap(), ["SIGTERM"]);
        assert!(!Path::new(&manager.runtime_record_path()).exists());
    }

    #[tokio::test]
    async fn starts_restarts_and_upgrades_using_one_owned_process() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("候选包 🚀");
        let bin = root
            .join("app/macos-status-bar/bin/darwin-x64")
            .join(BINARY_NAME);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "fixture").unwrap();
        let commands = Arc::new(Mutex::new(Vec::<(u32, String)>::new()));
        let next_pid = Arc::new(AtomicU32::new(100));
        let mut ops = ProcessOps::inert(true);
        ops.arch_x64 = true;
        let map = commands.clone();
        ops.read_command = Arc::new(move |pid| {
            map.lock()
                .unwrap()
                .iter()
                .find(|(id, _)| *id == pid)
                .map(|(_, exe)| exe.clone())
        });
        let map = commands.clone();
        ops.alive = Arc::new(move |pid| map.lock().unwrap().iter().any(|(id, _)| *id == pid));
        let map = commands.clone();
        ops.find_pids = Arc::new(move || map.lock().unwrap().iter().map(|(id, _)| *id).collect());
        let map = commands.clone();
        ops.signal = Arc::new(move |pid, _| map.lock().unwrap().retain(|(id, _)| *id != pid));
        let map = commands.clone();
        let sequence = next_pid.clone();
        ops.spawn = Arc::new(move |exe, _| {
            let pid = sequence.fetch_add(1, Ordering::SeqCst);
            map.lock().unwrap().push((pid, exe.to_owned()));
            Ok(pid)
        });
        let manager = StatusBarAppManager::new(dir.path().to_str().unwrap(), "1", ops.clone())
            .with_source_roots(vec![root.to_string_lossy().into_owned()]);
        assert_eq!(manager.start().await.unwrap().unwrap().pid, 100);
        assert_eq!(
            manager.start().await.unwrap().unwrap().status,
            "already-running"
        );
        assert_eq!(next_pid.load(Ordering::SeqCst), 101);
        commands.lock().unwrap().clear();
        assert_eq!(manager.start().await.unwrap().unwrap().pid, 101);
        let upgraded = StatusBarAppManager::new(dir.path().to_str().unwrap(), "2", ops)
            .with_source_roots(vec![root.to_string_lossy().into_owned()]);
        assert_eq!(upgraded.start().await.unwrap().unwrap().pid, 102);
        assert_eq!(commands.lock().unwrap().len(), 1);
        assert_eq!(upgraded.stop("test").await.unwrap().pids, [102]);
        assert_eq!(
            upgraded.stop("test").await.unwrap().status,
            "already-stopped"
        );
    }

    #[tokio::test]
    async fn missing_packaged_ui_never_creates_a_build_directory() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir
            .path()
            .join("app/macos-status-bar/Sources/LoongSuitePilotMenuBarApp");
        std::fs::create_dir_all(source).unwrap();
        let manager =
            StatusBarAppManager::new(dir.path().to_str().unwrap(), "1", ProcessOps::inert(true))
                .with_source_roots(vec![dir.path().to_string_lossy().into_owned()]);
        assert!(manager.start().await.unwrap().is_none());
        assert!(!dir.path().join("apps").exists());
        assert!(!Path::new(&manager.runtime_record_path()).exists());
    }

    fn packaged_manager(dir: &Path, ops: ProcessOps) -> StatusBarAppManager {
        let binary = dir
            .join("app/macos-status-bar/bin/darwin-universal")
            .join(BINARY_NAME);
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(binary, "fixture").unwrap();
        StatusBarAppManager::new(dir.to_string_lossy(), "1", ops)
            .with_source_roots(vec![dir.to_string_lossy().into_owned()])
    }

    #[tokio::test]
    async fn launch_errors_and_immediate_exit_never_write_success_or_leave_lock() {
        let dir = tempfile::tempdir().unwrap();
        let manager = packaged_manager(dir.path(), ProcessOps::inert(true));
        assert!(manager
            .start()
            .await
            .unwrap_err()
            .contains("spawn not configured"));
        assert!(!Path::new(&manager.runtime_record_path()).exists());
        assert!(!Path::new(&manager.lock_path()).exists());
        let mut ops = ProcessOps::inert(true);
        ops.spawn = Arc::new(|_, _| Ok(42));
        let manager = packaged_manager(dir.path(), ops);
        assert!(manager.start().await.unwrap().is_none());
        assert!(!Path::new(&manager.runtime_record_path()).exists());
        assert!(!Path::new(&manager.lock_path()).exists());
    }

    #[tokio::test]
    async fn cancelled_operation_releases_shared_control_lock() {
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(packaged_manager(dir.path(), ProcessOps::inert(true)));
        let worker = manager.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            worker
                .with_lock(0, || async {
                    sender.send(()).unwrap();
                    std::future::pending::<Result<(), String>>().await
                })
                .await
        });
        receiver.await.unwrap();
        assert!(manager.start().await.unwrap_err().contains("control lock"));
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!Path::new(&manager.lock_path()).exists());
        assert_eq!(
            manager.stop("test").await.unwrap().status,
            "already-stopped"
        );
    }

    #[tokio::test]
    async fn stop_waits_for_launch_lock_and_disabled_state_removes_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(packaged_manager(dir.path(), ProcessOps::inert(true)));
        manager.record_process("/missing/app", 42).await.unwrap();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let worker = manager.clone();
        let first = tokio::spawn(async move {
            worker
                .with_lock(0, || async {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    Ok(())
                })
                .await
        });
        ready.await.unwrap();
        let other = manager.clone();
        let stop = tokio::spawn(async move { other.sync_desired_state(false).await });
        tokio::task::yield_now().await;
        assert!(!stop.is_finished());
        release.send(()).unwrap();
        first.await.unwrap().unwrap();
        stop.await.unwrap().unwrap();
        assert!(!Path::new(&manager.runtime_record_path()).exists());
        assert!(!Path::new(&manager.lock_path()).exists());
    }

    #[tokio::test]
    async fn stopping_preserves_other_installations_and_replaces_old_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir
            .path()
            .join("cache")
            .join("versions")
            .join("old")
            .join("app")
            .join("macos-status-bar")
            .join("bin")
            .join("darwin-arm64")
            .join(BINARY_NAME);
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, "old").unwrap();
        let ops = ops_with(
            vec![
                (42, old.to_string_lossy().into_owned()),
                (43, "/other/LoongSuitePilotMenuBarApp".into()),
            ],
            vec![42, 43],
        );
        let mut manager = packaged_manager(dir.path(), ops.clone());
        manager.set_cache_dir(dir.path().join("cache").to_string_lossy());
        assert_eq!(manager.stop("test").await.unwrap().pids, [42]);
        assert!((ops.alive)(43));
        assert!(!(ops.alive)(42));
        let mut isolated = packaged_manager(
            dir.path(),
            ops_with(vec![(44, old.to_string_lossy().into_owned())], vec![44]),
        );
        isolated.set_cache_dir(dir.path().join("cache").to_string_lossy());
        // 没有成功启动的新进程仍须先停旧孤儿，不能留下两个版本。
        assert!(isolated.start().await.unwrap().is_none());
        assert!(!(isolated.ops.alive)(44));
    }

    #[tokio::test]
    async fn exact_executable_identity_rejects_space_suffixes_and_reused_pid() {
        let dir = tempfile::tempdir().unwrap();
        let manager = packaged_manager(dir.path(), ProcessOps::inert(true));
        let executable = manager.resolve_executable().unwrap();
        let ops = ops_with(vec![(42, format!("{executable} copy"))], vec![42]);
        let manager = packaged_manager(dir.path(), ops.clone());
        manager.record_process(&executable, 42).await.unwrap();
        assert_eq!(
            manager.stop("test").await.unwrap().status,
            "already-stopped"
        );
        assert!((ops.alive)(42));
        assert!(manager
            .start()
            .await
            .unwrap_err()
            .contains("outside this Pilot installation"));
    }

    #[tokio::test]
    async fn force_stop_escalates_and_failed_stop_retains_record() {
        for reject_kill in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let executable = dir
                .path()
                .join("owned")
                .join("app")
                .to_string_lossy()
                .into_owned();
            let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let mut ops = ProcessOps::inert(true);
            let state = running.clone();
            let read_executable = executable.clone();
            ops.read_command = Arc::new(move |_| {
                state
                    .load(std::sync::atomic::Ordering::SeqCst)
                    .then(|| read_executable.clone())
            });
            let state = running.clone();
            ops.alive = Arc::new(move |_| state.load(std::sync::atomic::Ordering::SeqCst));
            let signals = Arc::new(Mutex::new(Vec::new()));
            let sent = signals.clone();
            ops.signal = Arc::new(move |_, signal| {
                sent.lock().unwrap().push(signal.to_owned());
                if signal == "SIGKILL" && !reject_kill {
                    running.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            });
            let manager = packaged_manager(dir.path(), ops);
            manager.record_process(&executable, 42).await.unwrap();
            let result = manager.stop("test").await;
            assert_eq!(result.is_err(), reject_kill);
            if reject_kill {
                assert!(result.unwrap_err().contains("did not stop"));
                assert_eq!(manager.read_runtime().await.unwrap().pid, Some(42));
            }
            assert_eq!(*signals.lock().unwrap(), ["SIGTERM", "SIGKILL"]);
            assert_eq!(
                Path::new(&manager.runtime_record_path()).exists(),
                reject_kill
            );
            assert!(!Path::new(&manager.lock_path()).exists());
        }
    }

    #[test]
    fn resolves_installed_binaries_from_a_separate_cache_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let ops = ProcessOps::inert(true);
        let bundle = if ops.arch_x64 {
            "darwin-x64"
        } else {
            "darwin-arm64"
        };
        let version = cache
            .join("versions")
            .join("1.2.3_abc")
            .join("app")
            .join("macos-status-bar");
        std::fs::create_dir_all(version.join("bin").join(bundle)).unwrap();
        std::fs::write(version.join("Package.swift"), "").unwrap();
        std::fs::write(version.join("bin").join(bundle).join(BINARY_NAME), b"bin").unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("current"), "1.2.3_abc\n").unwrap();
        let mut manager =
            StatusBarAppManager::new(dir.path().join("data").to_str().unwrap(), "1.2.3", ops);
        manager.set_cache_dir(cache.to_str().unwrap());
        let resolved = manager.resolve_executable().unwrap();
        assert!(resolved.contains(bundle));
        assert_eq!(
            Path::new(&resolved),
            version.join("bin").join(bundle).join(BINARY_NAME)
        );
        assert!(resolved.contains(BINARY_NAME));
    }
}

#[cfg(all(test, unix))]
#[path = "status_bar_native_process_contract_tests.rs"]
mod native_process_contract_tests;
