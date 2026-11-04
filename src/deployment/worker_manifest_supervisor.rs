//! Start and stop workers described by `worker.manifest.json`.

use super::worker_process::{is_alive, NativeProcesses, ProcessIdentity, ProcessOperations};
use crate::utils::{ensure_dir, file_exists};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerManifest {
    pub name: String,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    pub command: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub paths: Option<WorkerPaths>,
    #[serde(default)]
    pub restart_policy: Option<RestartPolicy>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct WorkerPaths {
    #[serde(default)]
    pub pid: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub log: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartPolicy {
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub max_restarts: Option<u32>,
    #[serde(default)]
    pub backoff_seconds: Option<u64>,
}

#[derive(Clone, Default)]
pub struct WorkerManifestOptions {
    pub instance: Option<HashMap<String, String>>,
    pub runtime_options: Option<HashMap<String, Value>>,
}

#[derive(Clone)]
pub struct WorkerManifestSupervisor {
    platform: String,
    node_executable: String,
    processes: Arc<dyn ProcessOperations>,
}

impl WorkerManifestSupervisor {
    pub fn new() -> Self {
        Self {
            platform: if cfg!(windows) {
                "win32".to_string()
            } else {
                std::env::consts::OS.to_string()
            },
            // 该变量只指定外部 Agent 的运行时，不能拿 Pilot 二进制冒充 Node。
            node_executable: std::env::var("PILOT_NODE_BIN").unwrap_or_default(),
            processes: Arc::new(NativeProcesses),
        }
    }

    pub fn with_platform(platform: &str, node_executable: &str) -> Self {
        Self {
            platform: platform.into(),
            node_executable: node_executable.into(),
            processes: Arc::new(NativeProcesses),
        }
    }

    pub async fn has_manifest(&self, install_dir: &str) -> bool {
        self.find_manifest(install_dir).await.is_some()
    }

    pub async fn is_worker_running(
        &self,
        install_dir: &str,
        options: &WorkerManifestOptions,
    ) -> bool {
        let Some((manifest_path, bundle_root)) = self.find_manifest(install_dir).await else {
            return false;
        };
        let Some(manifest) = read_manifest(&manifest_path).await else {
            return false;
        };
        let paths = resolve_paths(&bundle_root, &manifest, options);
        read_pid(&paths.pid).await.is_some_and(is_alive)
    }

    pub async fn start_if_present(
        &self,
        agent_id: &str,
        install_dir: &str,
        env: &HashMap<String, String>,
        options: &WorkerManifestOptions,
    ) -> bool {
        let Some((manifest_path, bundle_root)) = self.find_manifest(install_dir).await else {
            return true;
        };
        let Some(manifest) = read_manifest(&manifest_path).await else {
            return false;
        };
        let paths = resolve_paths(&bundle_root, &manifest, options);
        let Ok(_lock) = WorkerLock::acquire(&paths.pid).await else {
            return false;
        };
        if !self.stop(agent_id, &bundle_root, &manifest, options).await {
            return false;
        }
        self.start(
            agent_id,
            &bundle_root,
            &manifest,
            env,
            options,
            &RunGeneration::default(),
        )
        .await
    }

    pub async fn stop_if_present(
        &self,
        agent_id: &str,
        install_dir: &str,
        options: &WorkerManifestOptions,
    ) -> bool {
        let Some((manifest_path, bundle_root)) = self.find_manifest(install_dir).await else {
            return true;
        };
        let Some(manifest) = read_manifest(&manifest_path).await else {
            return false;
        };
        let paths = resolve_paths(&bundle_root, &manifest, options);
        if [&paths.pid, &paths.status, &identity_path(&paths.pid)]
            .iter()
            .all(|p| {
                std::fs::symlink_metadata(p)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            })
        {
            return true;
        }
        let Ok(_lock) = WorkerLock::acquire(&paths.pid).await else {
            return false;
        };
        self.stop(agent_id, &bundle_root, &manifest, options).await
    }

    async fn find_manifest(&self, install_dir: &str) -> Option<(String, String)> {
        let direct = Path::new(install_dir).join("worker.manifest.json");
        if file_exists(&direct.to_string_lossy()).await {
            return Some((
                direct.to_string_lossy().into_owned(),
                install_dir.to_string(),
            ));
        }
        let mut entries = tokio::fs::read_dir(install_dir).await.ok()?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_type().await.ok()?.is_dir() {
                let bundle = entry.path();
                let manifest = bundle.join("worker.manifest.json");
                if file_exists(&manifest.to_string_lossy()).await {
                    return Some((
                        manifest.to_string_lossy().into_owned(),
                        bundle.to_string_lossy().into_owned(),
                    ));
                }
            }
        }
        None
    }

    async fn start(
        &self,
        agent_id: &str,
        bundle_root: &str,
        manifest: &WorkerManifest,
        env: &HashMap<String, String>,
        options: &WorkerManifestOptions,
        generation: &RunGeneration,
    ) -> bool {
        let run = WorkerRun {
            agent_id: agent_id.into(),
            bundle_root: bundle_root.into(),
            manifest: manifest.clone(),
            env: env.clone(),
            options: options.clone(),
            generation: generation.clone(),
        };
        let paths = resolve_paths(bundle_root, manifest, options);
        ensure_dir(&parent(&paths.pid)).await;
        ensure_dir(&parent(&paths.status)).await;
        ensure_dir(&parent(&paths.log)).await;
        let cwd = resolve_path(
            bundle_root,
            &expand(manifest.cwd.as_deref().unwrap_or("."), bundle_root, options),
        );
        let (executable, args) = match self
            .resolve_command(bundle_root, &cwd, manifest, options)
            .await
        {
            Ok(command) => command,
            Err((reason, message)) => {
                let mut status = json!({
                    "state": "failed", "name": manifest.name, "agentId": agent_id,
                    "reason": reason, "error": message, "updatedAt": iso(),
                });
                if reason == "RuntimeBundlePlatformUnsupported" {
                    status["bundleName"] = json!(manifest.name);
                    status["bundleVersion"] =
                        json!(manifest.version.as_deref().unwrap_or("unknown"));
                    status["platform"] = json!(self.platform);
                    status["entryType"] = json!("unix-shell");
                    status["action"] = json!("请使用适用于 Windows 的 Runtime Bundle 入口");
                }
                write_status(&paths.status, &status).await;
                return false;
            }
        };
        let child_env = resolve_environment(&self.platform, env, manifest, bundle_root, options);
        let mut command = tokio::process::Command::new(&executable);
        command
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .kill_on_drop(false);
        if let Ok(log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&paths.log)
        {
            if let Ok(err_log) = log.try_clone() {
                command
                    .stdout(Stdio::from(log))
                    .stderr(Stdio::from(err_log));
            }
        }
        command.env_clear();
        for (key, value) in &child_env {
            command.env(key, value);
        }
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let mut child = match command.spawn() {
            Ok(child) => PendingWorker(Some(child)),
            Err(err) => {
                write_status(&paths.status, &json!({"state":"failed","name":manifest.name,"agentId":agent_id,"error":err.to_string(),"updatedAt":iso()})).await;
                return false;
            }
        };
        let Some(pid) = child.id() else {
            return false;
        };
        if crate::utils::fs_utils::write_text_file_atomic(
            &paths.pid,
            &format!("{pid}\n"),
            &crate::utils::fs_utils::AtomicTextWriteOptions {
                mode: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return false;
        }
        let identity = match self.processes.identity(pid) {
            Ok(Some(identity)) => identity,
            result => {
                if let Ok(Some(_)) = child.try_wait() {
                    if !write_status(&paths.status, &json!({"state":"running","name":manifest.name,"agentId":agent_id,"pid":pid,"runId":generation.id,"restartCount":generation.restarts})).await { return false; }
                    self.monitor(child.release(), pid, run);
                    return true;
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = tokio::fs::remove_file(&paths.pid).await;
                write_status(&paths.status, &json!({"state":"failed","name":manifest.name,"agentId":agent_id,"reason":"WorkerProcessIdentityUnavailable","error":result.err().map(|error| error.to_string()),"updatedAt":iso()})).await;
                return false;
            }
        };
        // 非托管 Windows worker 保持无 sidecar 合同；身份仍写入其状态文件供后续安全停止。
        let identity_saved = if self.platform != "win32" || options.instance.is_some() {
            write_status(&identity_path(&paths.pid), &json!(identity)).await
        } else {
            true
        };
        if !identity_saved || !write_status(&paths.status, &json!({"state":"running","name":manifest.name,"agentId":agent_id,"pid":pid,"startedAt":iso(),"restartCount":generation.restarts,"processIdentity":identity,"runId":generation.id})).await {
            let _ = stop_process_tree(self.processes.as_ref(), &identity, Duration::from_secs(1)).await;
            let _ = child.kill().await;
            let _ = child.wait().await;
            return false;
        }
        self.monitor(child.release(), pid, run);
        true
    }

    fn monitor(&self, child: tokio::process::Child, pid: u32, run: WorkerRun) {
        tokio::spawn(monitor_exit(self.clone(), child, pid, run));
    }

    async fn stop(
        &self,
        agent_id: &str,
        bundle_root: &str,
        manifest: &WorkerManifest,
        options: &WorkerManifestOptions,
    ) -> bool {
        let paths = resolve_paths(bundle_root, manifest, options);
        let previous = match read_status_checked(&paths.status).await {
            Ok(status) => status,
            Err(_) => return false,
        };
        let recovery = match recovery_identity(previous.as_ref()) {
            Ok(identity) => identity,
            Err(_) => return false,
        };
        let recorded_pid = match read_pid_checked(&paths.pid).await {
            Ok(pid) => pid,
            Err(error) => {
                let mut failed =
                    previous.unwrap_or(json!({"name":manifest.name,"agentId":agent_id}));
                failed["state"] = json!("failed");
                failed["reason"] = json!("WorkerPidInvalid");
                failed["error"] = json!(error.to_string());
                failed["updatedAt"] = json!(iso());
                write_status(&paths.status, &failed).await;
                return false;
            }
        };
        let pid = match recorded_pid.or_else(|| recovery.as_ref().map(|identity| identity.pid)) {
            Some(pid) => pid,
            None => {
                if !std::fs::symlink_metadata(identity_path(&paths.pid))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                {
                    return false;
                }
                if let Some(status) = &previous {
                    if status["state"] == "restarting" {
                        return write_status(&paths.status, &json!({"state":"stopped","name":manifest.name,"agentId":agent_id,"stoppedAt":iso()})).await;
                    }
                    if matches!(status["state"].as_str(), Some("running" | "stopping")) {
                        return false;
                    }
                }
                return true;
            }
        };
        let stored = read_identity(
            &paths,
            pid,
            self.platform == "win32" && options.instance.is_none(),
        )
        .await
        .or_else(|| {
            recovery.clone().filter(|identity| {
                identity.pid == pid
                    && (recorded_pid.is_none()
                        || previous
                            .as_ref()
                            .is_some_and(|status| status.get("trackedProcesses").is_some()))
            })
        });
        if previous
            .as_ref()
            .is_some_and(|status| status.get("trackedProcesses").is_some())
            && !stored
                .as_ref()
                .zip(recovery.as_ref())
                .is_some_and(|(a, b)| a.matches(b))
        {
            return false;
        }
        let actual = match self.processes.identity(pid) {
            Ok(actual) => actual,
            Err(error) => {
                let mut failed = previous
                    .clone()
                    .unwrap_or(json!({"name":manifest.name,"agentId":agent_id,"pid":pid}));
                failed["state"] = json!("failed");
                failed["reason"] = json!("WorkerProcessIdentityCheckFailed");
                failed["error"] = json!(error.to_string());
                failed["updatedAt"] = json!(iso());
                write_status(&paths.status, &failed).await;
                return false;
            }
        };
        let reason = match (stored, actual) {
            (None, None) => Some("WorkerProcessNotFound"),
            (None, Some(actual)) => {
                let mut failed = previous
                    .clone()
                    .unwrap_or(json!({"name":manifest.name,"agentId":agent_id,"pid":pid}));
                failed["state"] = json!("failed");
                failed["reason"] = json!("WorkerProcessIdentityMissing");
                failed["actualIdentity"] = json!(actual);
                failed["updatedAt"] = json!(iso());
                write_status(&paths.status, &failed).await;
                return false;
            }
            (Some(expected), actual) => {
                let reason = match actual {
                    None => Some("WorkerProcessNotFound"),
                    Some(ref actual) if !expected.matches(actual) => {
                        Some("WorkerPidIdentityMismatch")
                    }
                    _ => None,
                };
                let tracked = previous
                    .as_ref()
                    .filter(|s| {
                        serde_json::from_value::<ProcessIdentity>(s["processIdentity"].clone())
                            .is_ok_and(|p| p.matches(&expected))
                    })
                    .and_then(|s| s.get("trackedProcesses"))
                    .cloned()
                    .unwrap_or(json!([]));
                if !write_status(&paths.status, &json!({"state":"stopping","name":manifest.name,"agentId":agent_id,"pid":pid,"processIdentity":expected,"trackedProcesses":tracked,"updatedAt":iso()})).await { return false; }
                let grace = Duration::from_secs(5);
                #[cfg(test)]
                let grace = history_contract_tests::grace_for_history(grace);
                if let Err((remaining, error)) = stop_tree_with_journal(
                    self.processes.as_ref(),
                    &expected,
                    grace,
                    Some(&paths.status),
                )
                .await
                {
                    let mut failed = read_status(&paths.status)
                        .await
                        .unwrap_or(json!({"processIdentity":expected}));
                    failed["state"] = json!("failed");
                    failed["reason"] = json!("WorkerProcessTreeStopFailed");
                    failed["remainingPids"] = json!(remaining);
                    failed["error"] = json!(error);
                    failed["updatedAt"] = json!(iso());
                    write_status(&paths.status, &failed).await;
                    return false;
                }
                reason
            }
        };
        if !matches!(read_pid_checked(&paths.pid).await, Ok(current) if current == recorded_pid) {
            return false;
        }
        for path in [identity_path(&paths.pid), paths.pid.clone()] {
            if let Err(error) = tokio::fs::remove_file(path).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return false;
                }
            }
        }
        let mut status = json!({"state":"stopped","name":manifest.name,"agentId":agent_id,"pid":pid,"stoppedAt":iso()});
        if let Some(reason) = reason {
            status["reason"] = json!(reason);
        }
        write_status(&paths.status, &status).await
    }

    async fn resolve_command(
        &self,
        bundle_root: &str,
        cwd: &str,
        manifest: &WorkerManifest,
        options: &WorkerManifestOptions,
    ) -> Result<(String, Vec<String>), (&'static str, String)> {
        validate_placeholders(manifest)?;
        let command: Vec<String> = manifest
            .command
            .iter()
            .map(|part| expand(part, bundle_root, options))
            .collect();
        let executable = if manifest.command.first().map(String::as_str) == Some("${pilot:node}") {
            if !Path::new(&self.node_executable).is_absolute() {
                return Err((
                    "WorkerManifestPlaceholderInvalid",
                    "外部 Agent 需要显式配置 PILOT_NODE_BIN 绝对路径；Pilot 不提供 Node 运行时"
                        .into(),
                ));
            }
            if !tokio::fs::metadata(&self.node_executable)
                .await
                .ok()
                .is_some_and(|meta| meta.is_file())
            {
                return Err((
                    "WorkerManifestPlaceholderInvalid",
                    "外部 Agent Node 运行时不可用".into(),
                ));
            }
            let node = std::fs::canonicalize(&self.node_executable).ok();
            let pilot = std::env::current_exe()
                .ok()
                .and_then(|path| std::fs::canonicalize(path).ok());
            if node.is_some() && node == pilot {
                return Err((
                    "WorkerManifestPlaceholderInvalid",
                    "不能将 Pilot 二进制用作 Agent Node 运行时".into(),
                ));
            }
            self.node_executable.clone()
        } else if manifest.command.first().map(String::as_str) == Some("${pilot:binary}") {
            std::env::current_exe()
                .map_err(|err| ("WorkerManifestPlaceholderInvalid", err.to_string()))?
                .to_string_lossy()
                .into_owned()
        } else {
            resolve_command_path(
                bundle_root,
                command.first().map(String::as_str).unwrap_or(""),
            )
        };
        let args = command.into_iter().skip(1).collect::<Vec<_>>();
        if self.platform == "win32" {
            let entry = if manifest.command.first().map(String::as_str) == Some("${pilot:node}") {
                args.first().map(String::as_str).unwrap_or("")
            } else {
                executable.as_str()
            };
            if entry.is_empty() {
                return Err((
                    "WorkerManifestPlaceholderInvalid",
                    "Pilot Node manifest command requires an entrypoint argument".into(),
                ));
            }
            if is_unix_shell_entry(entry, cwd).await {
                return Err(("RuntimeBundlePlatformUnsupported", "runtime bundle uses a Unix shell entrypoint that is not supported on native Windows".into()));
            }
        }
        Ok((executable, args))
    }
}

impl Default for WorkerManifestSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

struct PendingWorker(Option<tokio::process::Child>);
impl PendingWorker {
    fn release(mut self) -> tokio::process::Child {
        self.0.take().expect("启动作用域拥有子进程")
    }
}
impl std::ops::Deref for PendingWorker {
    type Target = tokio::process::Child;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("启动作用域拥有子进程")
    }
}
impl std::ops::DerefMut for PendingWorker {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("启动作用域拥有子进程")
    }
}
impl Drop for PendingWorker {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            // 启动尚未提交就取消时回收本次创建的树；正常提交后交给持久化生命周期管理。
            if let Some(pid) = child.id() {
                if let Ok(Some(identity)) = NativeProcesses.identity(pid) {
                    if let Ok(children) = NativeProcesses.descendants(&identity) {
                        for child in children {
                            let _ = NativeProcesses.signal(&child, true);
                        }
                    }
                }
            }
            let _ = child.start_kill();
        }
    }
}

struct WorkerLock {
    _file: std::fs::File,
}

impl WorkerLock {
    async fn acquire(pid_path: &str) -> std::io::Result<Self> {
        let path = format!("{pid_path}.lock");
        tokio::fs::create_dir_all(parent(&path)).await?;
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            return Err(std::io::Error::other("worker 锁不是普通文件"));
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&path)?;
        let start = Instant::now();
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(Self { _file: file }),
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        && start.elapsed() < Duration::from_secs(12) =>
                {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }
}

#[derive(Clone)]
struct RunGeneration {
    id: String,
    restarts: u32,
}
impl Default for RunGeneration {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            restarts: 0,
        }
    }
}

struct WorkerRun {
    agent_id: String,
    bundle_root: String,
    manifest: WorkerManifest,
    env: HashMap<String, String>,
    options: WorkerManifestOptions,
    generation: RunGeneration,
}

async fn read_status(path: &str) -> Option<Value> {
    read_status_checked(path).await.ok().flatten()
}

async fn read_status_checked(path: &str) -> std::io::Result<Option<Value>> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > 128 * 1024 {
        return Err(std::io::Error::other("worker 状态文件无效"));
    }
    let value: Value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    if !value.is_object() {
        return Err(std::io::Error::other("worker 状态必须是 JSON object"));
    }
    Ok(Some(value))
}

fn recovery_identity(status: Option<&Value>) -> std::io::Result<Option<ProcessIdentity>> {
    let Some(status) = status else {
        return Ok(None);
    };
    let valid = |identity: &ProcessIdentity| {
        identity.pid > 1
            && identity.pid <= i32::MAX as u32
            && identity.pid != std::process::id()
            && !identity.creation_time.is_empty()
    };
    let root = status
        .get("processIdentity")
        .map(|value| {
            serde_json::from_value::<ProcessIdentity>(value.clone()).map_err(std::io::Error::other)
        })
        .transpose()?;
    if root.as_ref().is_some_and(|identity| !valid(identity)) {
        return Err(std::io::Error::other("worker 恢复身份无效"));
    }
    if let Some(tracked) = status.get("trackedProcesses") {
        let identities: Vec<ProcessIdentity> = serde_json::from_value(tracked.clone())?;
        if root.is_none() || identities.iter().any(|identity| !valid(identity)) {
            return Err(std::io::Error::other("worker 停止恢复记录无效"));
        }
    }
    Ok(root)
}

fn monitor_exit(
    supervisor: WorkerManifestSupervisor,
    mut child: tokio::process::Child,
    pid: u32,
    mut run: WorkerRun,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let result = child.wait().await;
        let paths = resolve_paths(&run.bundle_root, &run.manifest, &run.options);
        let restart;
        {
            let Ok(_lock) = WorkerLock::acquire(&paths.pid).await else {
                return;
            };
            let Some(status) = read_status(&paths.status).await else {
                return;
            };
            // 旧进程的迟到退出回调不能清除新一代 PID，也不能覆盖 stop 留下的诊断。
            if status["runId"] != run.generation.id
                || status["state"] != "running"
                || read_pid(&paths.pid).await != Some(pid)
            {
                return;
            }
            for path in [identity_path(&paths.pid), paths.pid.clone()] {
                if let Err(error) = tokio::fs::remove_file(path).await {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        return;
                    }
                }
            }
            let failed = result.as_ref().is_ok_and(|exit| !exit.success()) || result.is_err();
            restart = failed
                && run.manifest.restart_policy.as_ref().is_some_and(|policy| {
                    policy.r#type.as_deref() == Some("on-failure")
                        && run.generation.restarts < policy.max_restarts.unwrap_or(0)
                });
            let code = result.as_ref().ok().and_then(|exit| exit.code());
            #[cfg(windows)]
            let signal: Option<String> = None;
            #[cfg(unix)]
            let signal = result.as_ref().ok().and_then(|exit| {
                use std::os::unix::process::ExitStatusExt;
                exit.signal().map(|value| match value {
                    libc::SIGTERM => "SIGTERM".into(),
                    libc::SIGKILL => "SIGKILL".into(),
                    libc::SIGINT => "SIGINT".into(),
                    libc::SIGABRT => "SIGABRT".into(),
                    libc::SIGSEGV => "SIGSEGV".into(),
                    libc::SIGPIPE => "SIGPIPE".into(),
                    libc::SIGHUP => "SIGHUP".into(),
                    other => format!("signal:{other}"),
                })
            });
            let status = json!({"state":if restart {"restarting"} else {"exited"}, "name":run.manifest.name,"agentId":run.agent_id,"exitCode":code,"signal":signal,"error":result.err().map(|e| e.to_string()),"restartCount":run.generation.restarts,"runId":run.generation.id,"exitedAt":iso()});
            if !write_status(&paths.status, &status).await {
                return;
            }
        }
        if !restart {
            return;
        }
        let backoff = run
            .manifest
            .restart_policy
            .as_ref()
            .and_then(|p| p.backoff_seconds)
            .unwrap_or(0);
        // 分段等待，允许磁盘上的 stop 状态及时取消超长 backoff，不保留无效定时任务。
        let start = Instant::now();
        while start.elapsed().as_secs() < backoff {
            tokio::time::sleep(
                Duration::from_secs(1)
                    .min(Duration::from_secs(backoff).saturating_sub(start.elapsed())),
            )
            .await;
            if !read_status(&paths.status)
                .await
                .is_some_and(|s| s["runId"] == run.generation.id && s["state"] == "restarting")
            {
                return;
            }
        }
        let Ok(_lock) = WorkerLock::acquire(&paths.pid).await else {
            return;
        };
        if !read_status(&paths.status)
            .await
            .is_some_and(|s| s["runId"] == run.generation.id && s["state"] == "restarting")
        {
            return;
        }
        if !matches!(read_pid_checked(&paths.pid).await, Ok(None)) {
            return;
        }
        run.generation.restarts += 1;
        supervisor
            .start(
                &run.agent_id,
                &run.bundle_root,
                &run.manifest,
                &run.env,
                &run.options,
                &run.generation,
            )
            .await;
    })
}

fn validate_placeholders(manifest: &WorkerManifest) -> Result<(), (&'static str, String)> {
    let mut fields = Vec::new();
    for (index, value) in manifest.command.iter().enumerate() {
        fields.push((format!("command[{index}]"), value.clone()));
    }
    if let Some(cwd) = &manifest.cwd {
        fields.push(("cwd".into(), cwd.clone()));
    }
    if let Some(env) = &manifest.env {
        for (name, value) in env {
            fields.push((format!("env.{name}"), value.clone()));
        }
    }
    for (location, value) in fields {
        if value.contains("${pilot:")
            && !(location == "command[0]"
                && matches!(value.as_str(), "${pilot:node}" | "${pilot:binary}"))
        {
            return Err((
                "WorkerManifestPlaceholderInvalid",
                format!("unsupported Pilot placeholder in {location}"),
            ));
        }
    }
    Ok(())
}

fn resolve_environment(
    platform: &str,
    env: &HashMap<String, String>,
    manifest: &WorkerManifest,
    bundle_root: &str,
    options: &WorkerManifestOptions,
) -> HashMap<String, String> {
    let mut child = env.clone();
    if let Some(extra) = &manifest.env {
        for (key, value) in extra {
            child.insert(key.clone(), expand(value, bundle_root, options));
        }
    }
    if platform == "win32"
        && options.instance.is_some()
        && child.get("HOME").is_none_or(String::is_empty)
    {
        if let Some(home) = child
            .get("USERPROFILE")
            .filter(|home| !home.is_empty())
            .cloned()
        {
            child.insert("HOME".into(), home);
        }
    }
    child
}

async fn is_unix_shell_entry(entry: &str, cwd: &str) -> bool {
    use tokio::io::AsyncReadExt;
    if is_unix_shell(entry) {
        return true;
    }
    let path = Path::new(cwd).join(entry);
    if !tokio::fs::metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_file())
    {
        return false;
    }
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return false;
    };
    let mut header = [0_u8; 256];
    let Ok(size) = file.read(&mut header).await else {
        return false;
    };
    let text = String::from_utf8_lossy(&header[..size]);
    let first = text.lines().next().unwrap_or("");
    let Some(shebang) = first.strip_prefix("#!") else {
        return false;
    };
    shebang
        .split(|ch: char| ch == '/' || ch.is_whitespace())
        .any(|part| {
            matches!(
                part.to_ascii_lowercase().as_str(),
                "sh" | "bash" | "zsh" | "dash" | "ksh"
            )
        })
}

fn is_unix_shell(entry: &str) -> bool {
    let base = Path::new(entry)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    base.ends_with(".sh")
        || matches!(
            base.as_str(),
            "bash"
                | "bash.exe"
                | "sh"
                | "sh.exe"
                | "zsh"
                | "zsh.exe"
                | "dash"
                | "dash.exe"
                | "ksh"
                | "ksh.exe"
        )
}

async fn read_manifest(path: &str) -> Option<WorkerManifest> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let manifest: WorkerManifest = serde_json::from_str(&raw).ok()?;
    if manifest.name.is_empty() || manifest.command.is_empty() {
        return None;
    }
    Some(manifest)
}

struct ResolvedPaths {
    pid: String,
    status: String,
    log: String,
}

fn resolve_paths(
    bundle_root: &str,
    manifest: &WorkerManifest,
    options: &WorkerManifestOptions,
) -> ResolvedPaths {
    let paths = manifest.paths.as_ref();
    ResolvedPaths {
        pid: resolve_path(
            bundle_root,
            &expand(
                paths
                    .and_then(|paths| paths.pid.as_deref())
                    .unwrap_or(".agent-worker/worker.pid"),
                bundle_root,
                options,
            ),
        ),
        status: resolve_path(
            bundle_root,
            &expand(
                paths
                    .and_then(|paths| paths.status.as_deref())
                    .unwrap_or(".agent-worker/status.json"),
                bundle_root,
                options,
            ),
        ),
        log: resolve_path(
            bundle_root,
            &expand(
                paths
                    .and_then(|paths| paths.log.as_deref())
                    .unwrap_or(".agent-worker/worker.log"),
                bundle_root,
                options,
            ),
        ),
    }
}

fn expand(value: &str, bundle_root: &str, options: &WorkerManifestOptions) -> String {
    let with_dest = value.replace("${destDir}", bundle_root);
    let mut out = String::new();
    let chars: Vec<char> = with_dest.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i..].starts_with(&['$', '{', 'i', 'n', 's', 't', 'a', 'n', 'c', 'e', ':']) {
            if let Some(end) = chars[i..].iter().position(|ch| *ch == '}') {
                let name: String = chars[i + 11..i + end].iter().collect();
                out.push_str(&instance_value(&name, options));
                i += end + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn instance_value(name: &str, options: &WorkerManifestOptions) -> String {
    if let Some(value) = options.instance.as_ref().and_then(|map| map.get(name)) {
        return value.clone();
    }
    if let Some(value) = options
        .runtime_options
        .as_ref()
        .and_then(|map| map.get(name))
    {
        return runtime_option_value(value);
    }
    let kebab = camel_to_kebab(name);
    options
        .runtime_options
        .as_ref()
        .and_then(|map| map.get(&kebab))
        .map(runtime_option_value)
        .unwrap_or_default()
}

fn runtime_option_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    runtime_option_value(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        other => other.to_string(),
    }
}

fn camel_to_kebab(value: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = value.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 && ch.is_ascii_uppercase() && chars[index - 1].is_ascii_alphanumeric() {
            out.push('-');
        }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

fn resolve_command_path(bundle_root: &str, command: &str) -> String {
    if Path::new(command).is_absolute()
        || command.contains('/')
        || command.contains('\\')
        || command.starts_with('.')
    {
        return if Path::new(command).is_absolute() {
            command.to_string()
        } else {
            Path::new(bundle_root)
                .join(command)
                .to_string_lossy()
                .into_owned()
        };
    }
    command.to_string()
}

fn resolve_path(bundle_root: &str, value: &str) -> String {
    if Path::new(value).is_absolute() {
        value.to_string()
    } else {
        Path::new(bundle_root)
            .join(value)
            .to_string_lossy()
            .into_owned()
    }
}

async fn read_pid(path: &str) -> Option<u32> {
    read_pid_checked(path).await.ok().flatten()
}

async fn read_pid_checked(path: &str) -> std::io::Result<Option<u32>> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > 32 {
        return Err(std::io::Error::other("worker PID 文件无效"));
    }
    let raw = tokio::fs::read_to_string(path).await?;
    let raw = raw.trim();
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(std::io::Error::other("worker PID 不是正整数"));
    }
    raw.parse::<u32>()
        .ok()
        .filter(|pid| *pid > 1 && *pid <= i32::MAX as u32)
        .map(Some)
        .ok_or_else(|| std::io::Error::other("worker PID 超出允许范围"))
}

async fn write_status(path: &str, payload: &Value) -> bool {
    let Ok(text) = serde_json::to_string_pretty(payload) else {
        return false;
    };
    crate::utils::fs_utils::write_text_file_atomic(
        path,
        &format!("{text}\n"),
        &crate::utils::fs_utils::AtomicTextWriteOptions {
            mode: Some(0o600),
            ..Default::default()
        },
    )
    .await
    .is_ok()
}

fn identity_path(pid: &str) -> String {
    format!("{pid}.identity.json")
}

async fn read_identity(
    paths: &ResolvedPaths,
    pid: u32,
    allow_status: bool,
) -> Option<ProcessIdentity> {
    let stored = read_status(&identity_path(&paths.pid))
        .await
        .and_then(|value| serde_json::from_value::<ProcessIdentity>(value).ok());
    let stored = if stored.is_none() && allow_status {
        read_status(&paths.status).await.and_then(|status| {
            serde_json::from_value::<ProcessIdentity>(status["processIdentity"].clone()).ok()
        })
    } else {
        stored
    };
    stored.filter(|identity| identity.pid == pid && !identity.creation_time.is_empty())
}

async fn stop_process_tree(
    ops: &dyn ProcessOperations,
    root: &ProcessIdentity,
    grace: Duration,
) -> Result<(), (Vec<u32>, String)> {
    stop_tree_with_journal(ops, root, grace, None).await
}

async fn stop_tree_with_journal(
    ops: &dyn ProcessOperations,
    root: &ProcessIdentity,
    grace: Duration,
    journal: Option<&str>,
) -> Result<(), (Vec<u32>, String)> {
    let mut tracked = vec![root.clone()];
    if let Some(path) = journal {
        let status = read_status(path)
            .await
            .ok_or_else(|| (vec![root.pid], "停止恢复记录不可读".into()))?;
        let previous: Vec<ProcessIdentity> =
            serde_json::from_value(status["trackedProcesses"].clone())
                .map_err(|e| (vec![root.pid], e.to_string()))?;
        for identity in previous {
            if !tracked.iter().any(|p| p.matches(&identity)) {
                tracked.push(identity);
            }
        }
    }
    let mut last_error = String::new();
    for force in [false, true] {
        // Publishing "stopping" may let the worker exit while Windows is
        // querying its identity. Retry only denied reads, sharing this phase's
        // existing grace period. Signals still require a fresh exact identity.
        let phase_started = Instant::now();
        let children = loop {
            let snapshot = match ops.identity(root.pid) {
                Ok(Some(actual)) if root.matches(&actual) => ops.descendants(root),
                Ok(_) => Ok(Vec::new()),
                Err(error) => Err(error),
            };
            match snapshot {
                Ok(children) => break Some(children),
                Err(error) => {
                    last_error = error.to_string();
                    if error.kind() != std::io::ErrorKind::PermissionDenied {
                        return Err((tracked.iter().map(|p| p.pid).collect(), last_error));
                    }
                    let remaining = grace.saturating_sub(phase_started.elapsed());
                    if remaining.is_zero() {
                        if force {
                            return Err((tracked.iter().map(|p| p.pid).collect(), last_error));
                        }
                        break None;
                    }
                    tokio::time::sleep(Duration::from_millis(50).min(remaining)).await;
                }
            }
        };
        let Some(children) = children else {
            continue;
        };
        for identity in children {
            if !tracked.iter().any(|known| known.matches(&identity)) {
                tracked.push(identity);
            }
        }
        if let Some(path) = journal {
            let mut status = read_status(path)
                .await
                .ok_or_else(|| (vec![root.pid], "停止恢复记录不可读".into()))?;
            status["trackedProcesses"] = json!(tracked);
            if !write_status(path, &status).await {
                return Err((
                    tracked.iter().map(|p| p.pid).collect(),
                    "无法持久化停止恢复记录".into(),
                ));
            }
        }
        // 先对子进程定向发信号；每次发送均重新验证身份，不会广播到调用者进程组。
        for identity in tracked.iter().rev() {
            match ops.identity(identity.pid) {
                Ok(Some(actual)) if identity.matches(&actual) => {
                    if let Err(error) = ops.signal(identity, force) {
                        last_error = error.to_string();
                    }
                }
                Ok(_) => {}
                Err(error) => last_error = error.to_string(),
            }
        }
        loop {
            let mut remaining = Vec::new();
            for identity in &tracked {
                match ops.identity(identity.pid) {
                    Ok(Some(actual)) if identity.matches(&actual) => remaining.push(identity.pid),
                    Ok(_) => {}
                    Err(error) => {
                        remaining.push(identity.pid);
                        last_error = error.to_string();
                    }
                }
            }
            if remaining.is_empty() {
                return Ok(());
            }
            if phase_started.elapsed() >= grace {
                if force {
                    return Err((remaining, last_error));
                }
                break;
            }
            let remaining_grace = grace.saturating_sub(phase_started.elapsed());
            tokio::time::sleep(Duration::from_millis(50).min(remaining_grace)).await;
        }
        // The next phase takes another identity-checked snapshot before
        // signalling, including descendants created during graceful shutdown.
    }
    unreachable!()
}

fn parent(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_running_from_a_live_pid_file() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = json!({
            "name": "worker",
            "command": ["sleep", "30"],
            "paths": { "pid": "worker.pid", "status": "status.json", "log": "worker.log" }
        });
        std::fs::write(
            dir.path().join("worker.manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        let supervisor = WorkerManifestSupervisor::new();
        assert!(supervisor.has_manifest(&dir.path().to_string_lossy()).await);
        assert!(
            !supervisor
                .is_worker_running(
                    &dir.path().to_string_lossy(),
                    &WorkerManifestOptions::default()
                )
                .await
        );
        std::fs::write(
            dir.path().join("worker.pid"),
            format!("{}\n", std::process::id()),
        )
        .unwrap();
        assert!(
            supervisor
                .is_worker_running(
                    &dir.path().to_string_lossy(),
                    &WorkerManifestOptions::default()
                )
                .await
        );
        assert!(!dir.path().join("worker.pid.identity.json").exists());
    }

    #[derive(Default)]
    struct FakeProcesses {
        alive: std::sync::Mutex<HashMap<u32, ProcessIdentity>>,
        signals: std::sync::Mutex<Vec<(u32, bool)>>,
        deny_query: bool,
        deny_signal: bool,
        deny_tree: bool,
    }

    fn fake_identity(pid: u32) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            creation_time: "2026-07-30T00:00:00.0000000Z".into(),
            executable_path: "fixture".into(),
        }
    }

    impl ProcessOperations for FakeProcesses {
        fn identity(&self, pid: u32) -> std::io::Result<Option<ProcessIdentity>> {
            if self.deny_query {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            Ok(self.alive.lock().unwrap().get(&pid).cloned())
        }
        fn descendants(&self, root: &ProcessIdentity) -> std::io::Result<Vec<ProcessIdentity>> {
            if self.deny_tree {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            Ok(self
                .alive
                .lock()
                .unwrap()
                .values()
                .filter(|p| p.pid != root.pid)
                .cloned()
                .collect())
        }
        fn signal(&self, expected: &ProcessIdentity, force: bool) -> std::io::Result<()> {
            self.signals.lock().unwrap().push((expected.pid, force));
            if self.deny_signal {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            let mut alive = self.alive.lock().unwrap();
            if force
                && alive
                    .get(&expected.pid)
                    .is_some_and(|actual| expected.matches(actual))
            {
                alive.remove(&expected.pid);
            }
            Ok(())
        }
    }

    async fn tracked_fixture(
        dir: &Path,
        identity: Option<&ProcessIdentity>,
    ) -> (WorkerManifest, ResolvedPaths) {
        let manifest: WorkerManifest =
            serde_json::from_value(json!({"name":"fixture", "command":["must-not-start"]}))
                .unwrap();
        let paths = resolve_paths(
            dir.to_str().unwrap(),
            &manifest,
            &WorkerManifestOptions::default(),
        );
        std::fs::create_dir_all(parent(&paths.pid)).unwrap();
        std::fs::write(&paths.pid, "40001\n").unwrap();
        std::fs::write(
            dir.join("worker.manifest.json"),
            r#"{"name":"fixture","command":["must-not-start"]}"#,
        )
        .unwrap();
        if let Some(identity) = identity {
            assert!(write_status(&identity_path(&paths.pid), &json!(identity)).await);
        }
        (manifest, paths)
    }

    #[tokio::test]
    async fn missing_live_identity_and_query_failure_preserve_pid_and_block_all_restarts() {
        for deny_query in [false, true] {
            for managed in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let (_, paths) = tracked_fixture(dir.path(), None).await;
                let ops = Arc::new(FakeProcesses {
                    deny_query,
                    ..Default::default()
                });
                ops.alive
                    .lock()
                    .unwrap()
                    .insert(40001, fake_identity(40001));
                let mut supervisor = WorkerManifestSupervisor::with_platform("win32", "");
                supervisor.processes = ops.clone();
                let options = WorkerManifestOptions {
                    instance: managed.then(HashMap::new),
                    ..Default::default()
                };
                assert!(
                    !supervisor
                        .start_if_present(
                            "fixture",
                            dir.path().to_str().unwrap(),
                            &HashMap::new(),
                            &options
                        )
                        .await
                );
                let status: Value =
                    serde_json::from_slice(&std::fs::read(&paths.status).unwrap()).unwrap();
                assert_eq!(
                    status["reason"],
                    if deny_query {
                        "WorkerProcessIdentityCheckFailed"
                    } else {
                        "WorkerProcessIdentityMissing"
                    }
                );
                assert_eq!(std::fs::read_to_string(&paths.pid).unwrap(), "40001\n");
                assert!(ops.signals.lock().unwrap().is_empty());
                assert!(!Path::new(&paths.log).exists());
            }
        }
    }

    #[tokio::test]
    async fn stale_and_reused_pids_are_cleaned_without_sending_signals() {
        for reused in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let expected = fake_identity(40001);
            let (manifest, paths) = tracked_fixture(dir.path(), reused.then_some(&expected)).await;
            let ops = Arc::new(FakeProcesses::default());
            if reused {
                let mut actual = expected.clone();
                actual.creation_time = "later".into();
                ops.alive.lock().unwrap().insert(40001, actual);
            }
            let mut supervisor = WorkerManifestSupervisor::with_platform("win32", "");
            supervisor.processes = ops.clone();
            assert!(
                supervisor
                    .stop(
                        "fixture",
                        dir.path().to_str().unwrap(),
                        &manifest,
                        &WorkerManifestOptions::default()
                    )
                    .await
            );
            assert!(!Path::new(&paths.pid).exists());
            assert!(!Path::new(&identity_path(&paths.pid)).exists());
            assert!(ops.signals.lock().unwrap().is_empty());
            let status: Value =
                serde_json::from_slice(&std::fs::read(&paths.status).unwrap()).unwrap();
            assert_eq!(
                status["reason"],
                if reused {
                    "WorkerPidIdentityMismatch"
                } else {
                    "WorkerProcessNotFound"
                }
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stop_retry_keeps_recorded_descendants_after_root_exits() {
        let dir = tempfile::tempdir().unwrap();
        let expected = fake_identity(40001);
        let (manifest, paths) = tracked_fixture(dir.path(), Some(&expected)).await;
        let denied = Arc::new(FakeProcesses {
            deny_signal: true,
            ..Default::default()
        });
        for pid in [40001, 40002] {
            denied.alive.lock().unwrap().insert(pid, fake_identity(pid));
        }
        let mut supervisor = WorkerManifestSupervisor::with_platform("win32", "");
        supervisor.processes = denied;
        let options = WorkerManifestOptions {
            instance: Some(HashMap::new()),
            ..Default::default()
        };
        assert!(
            !supervisor
                .stop("fixture", dir.path().to_str().unwrap(), &manifest, &options)
                .await
        );
        let status = read_status(&paths.status).await.unwrap();
        assert_eq!(status["reason"], "WorkerProcessTreeStopFailed");
        assert_eq!(status["trackedProcesses"].as_array().unwrap().len(), 2);
        assert_eq!(status["remainingPids"].as_array().unwrap().len(), 2);
        let recovered = Arc::new(FakeProcesses::default());
        recovered
            .alive
            .lock()
            .unwrap()
            .insert(40002, fake_identity(40002));
        supervisor.processes = recovered.clone();
        assert!(
            supervisor
                .stop("fixture", dir.path().to_str().unwrap(), &manifest, &options)
                .await
        );
        assert!(recovered.alive.lock().unwrap().is_empty());
        assert_eq!(
            *recovered.signals.lock().unwrap(),
            [(40002, false), (40002, true)]
        );
        assert!(!Path::new(&paths.pid).exists());
    }

    #[tokio::test(start_paused = true)]
    async fn stop_recovers_journal_without_pid_or_sidecar_and_preserves_corruption() {
        for missing_pid in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = fake_identity(40001);
            let (_, paths) = tracked_fixture(dir.path(), None).await;
            if missing_pid {
                std::fs::remove_file(&paths.pid).unwrap();
            }
            assert!(
                write_status(
                    &paths.status,
                    &json!({
                        "state":"failed", "processIdentity":root,
                        "trackedProcesses":[root, fake_identity(40002)]
                    })
                )
                .await
            );
            let ops = Arc::new(FakeProcesses::default());
            ops.alive
                .lock()
                .unwrap()
                .insert(40002, fake_identity(40002));
            let mut supervisor = WorkerManifestSupervisor::new();
            supervisor.processes = ops.clone();
            assert!(
                supervisor
                    .stop_if_present(
                        "fixture",
                        dir.path().to_str().unwrap(),
                        &WorkerManifestOptions::default()
                    )
                    .await
            );
            assert!(ops.alive.lock().unwrap().is_empty());
            assert!(!Path::new(&paths.pid).exists());
            assert_eq!(
                read_status(&paths.status).await.unwrap()["state"],
                "stopped"
            );
        }
        for raw in [
            "{",
            "[]",
            r#"{"state":"running"}"#,
            r#"{"state":"failed","trackedProcesses":[]}"#,
            r#"{"state":"failed","processIdentity":{"pid":1,"creationTime":"x","executablePath":"x"}}"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (_, paths) = tracked_fixture(dir.path(), None).await;
            std::fs::remove_file(&paths.pid).unwrap();
            std::fs::write(&paths.status, raw).unwrap();
            assert!(
                !WorkerManifestSupervisor::new()
                    .start_if_present(
                        "fixture",
                        dir.path().to_str().unwrap(),
                        &HashMap::new(),
                        &WorkerManifestOptions::default()
                    )
                    .await
            );
            assert_eq!(std::fs::read_to_string(&paths.status).unwrap(), raw);
            assert!(!Path::new(&paths.log).exists());
        }
    }

    #[tokio::test]
    async fn orphan_identity_without_pid_or_status_blocks_start() {
        let dir = tempfile::tempdir().unwrap();
        let (_, paths) = tracked_fixture(dir.path(), Some(&fake_identity(40001))).await;
        std::fs::remove_file(&paths.pid).unwrap();
        let before = std::fs::read(identity_path(&paths.pid)).unwrap();
        let supervisor = WorkerManifestSupervisor::new();
        let options = WorkerManifestOptions::default();
        assert!(
            !supervisor
                .stop_if_present("fixture", dir.path().to_str().unwrap(), &options)
                .await
        );
        assert!(
            !supervisor
                .start_if_present(
                    "fixture",
                    dir.path().to_str().unwrap(),
                    &HashMap::new(),
                    &options
                )
                .await
        );
        assert_eq!(std::fs::read(identity_path(&paths.pid)).unwrap(), before);
        assert!(!Path::new(&paths.log).exists());
    }

    #[tokio::test(start_paused = true)]
    async fn malformed_pid_preserves_stop_journal_for_repaired_retry() {
        let dir = tempfile::tempdir().unwrap();
        let root = fake_identity(40001);
        let (_, paths) = tracked_fixture(dir.path(), Some(&root)).await;
        let journal = json!([root, fake_identity(40002)]);
        assert!(
            write_status(
                &paths.status,
                &json!({"state":"failed","processIdentity":root,"trackedProcesses":journal})
            )
            .await
        );
        std::fs::write(&paths.pid, "broken").unwrap();
        let ops = Arc::new(FakeProcesses::default());
        ops.alive
            .lock()
            .unwrap()
            .insert(40002, fake_identity(40002));
        let mut supervisor = WorkerManifestSupervisor::new();
        supervisor.processes = ops.clone();
        let options = WorkerManifestOptions::default();
        assert!(
            !supervisor
                .stop_if_present("fixture", dir.path().to_str().unwrap(), &options)
                .await
        );
        assert_eq!(
            read_status(&paths.status).await.unwrap()["trackedProcesses"],
            journal
        );
        assert!(ops.signals.lock().unwrap().is_empty());
        std::fs::write(&paths.pid, "40001\n").unwrap();
        assert!(
            supervisor
                .stop_if_present("fixture", dir.path().to_str().unwrap(), &options)
                .await
        );
        assert!(ops.alive.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bounded_tree_stop_tracks_descendants_and_reports_query_or_signal_failures() {
        for (deny_tree, deny_signal) in [(false, false), (true, false), (false, true)] {
            let ops = FakeProcesses {
                deny_tree,
                deny_signal,
                ..Default::default()
            };
            for pid in [40001, 40002] {
                ops.alive.lock().unwrap().insert(pid, fake_identity(pid));
            }
            let result = stop_process_tree(&ops, &fake_identity(40001), Duration::ZERO).await;
            if deny_tree || deny_signal {
                let (remaining, _) = result.unwrap_err();
                assert!(remaining.contains(&40001));
                if deny_tree {
                    assert!(ops.signals.lock().unwrap().is_empty());
                } else {
                    assert!(remaining.contains(&40002));
                }
            } else {
                result.unwrap();
                assert!(ops.alive.lock().unwrap().is_empty());
                assert_eq!(
                    *ops.signals.lock().unwrap(),
                    [(40002, false), (40001, false), (40002, true), (40001, true)]
                );
            }
        }
    }

    struct WorkerCleanup(ProcessIdentity);
    impl Drop for WorkerCleanup {
        fn drop(&mut self) {
            if let Ok(children) = NativeProcesses.descendants(&self.0) {
                for child in children {
                    let _ = NativeProcesses.signal(&child, true);
                }
            }
            let _ = NativeProcesses.signal(&self.0, true);
        }
    }

    #[tokio::test]
    async fn cancelling_uncommitted_start_reaps_its_owned_process_tree() {
        use crate::utils::candidate_process::tests::{fixture, ready, stopped};
        let dir = tempfile::tempdir().unwrap();
        let command = fixture(dir.path(), "wait");
        let child = tokio::process::Command::from(command).spawn().unwrap();
        let pid = child.id().unwrap();
        let pending = PendingWorker(Some(child));
        let task = tokio::spawn(async move {
            let _pending = pending;
            std::future::pending::<()>().await;
        });
        let descendant = ready(dir.path()).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        stopped(pid).await;
        stopped(descendant).await;
    }

    #[tokio::test]
    async fn native_worker_tree_stop_preserves_unrelated_process_and_needs_no_path_runtime() {
        use crate::utils::candidate_process::{
            tests::{fixture, ready, stopped},
            CandidateChild,
        };
        let sentinel_dir = tempfile::tempdir().unwrap();
        let mut sentinel =
            CandidateChild::spawn(&mut fixture(sentinel_dir.path(), "wait")).unwrap();
        let sentinel_pid = ready(sentinel_dir.path()).await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let command = fixture(dir.path(), "wait");
        let args: Vec<_> = std::iter::once("${pilot:binary}".to_string())
            .chain(command.get_args().map(|s| s.to_string_lossy().into_owned()))
            .collect();
        std::fs::write(
            dir.path().join("worker.manifest.json"),
            json!({"name":"fixture", "command":args}).to_string(),
        )
        .unwrap();
        let mut env: HashMap<String, String> = command
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|v| {
                    (
                        key.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        env.insert(
            "PATH".into(),
            dir.path()
                .join("no-runtimes")
                .to_string_lossy()
                .into_owned(),
        );
        let options = WorkerManifestOptions {
            instance: Some(HashMap::new()),
            ..Default::default()
        };
        let supervisor = WorkerManifestSupervisor::new();
        assert!(
            supervisor
                .start_if_present("fixture", root, &env, &options)
                .await
        );
        let pid_path = dir.path().join(".agent-worker/worker.pid");
        let pid = read_pid(pid_path.to_str().unwrap()).await.unwrap();
        let identity = NativeProcesses.identity(pid).unwrap().unwrap();
        let _cleanup = WorkerCleanup(identity.clone());
        let child = ready(dir.path()).await;
        assert!(is_alive(pid));
        assert!(is_alive(child));
        let mut wrong = identity.clone();
        wrong.creation_time = "wrong".into();
        NativeProcesses.signal(&wrong, true).unwrap();
        assert!(is_alive(pid));
        // 新实例从落盘身份恢复，不依赖原 supervisor 的内存状态。
        assert!(
            WorkerManifestSupervisor::new()
                .stop_if_present("fixture", root, &options)
                .await
        );
        stopped(child).await;
        stopped(pid).await;
        assert!(!pid_path.exists());
        assert!(!Path::new(&identity_path(pid_path.to_str().unwrap())).exists());
        assert!(sentinel.try_wait().unwrap().is_none());
        assert!(is_alive(sentinel_pid));
        drop(sentinel);
        stopped(sentinel_pid).await;
    }

    #[test]
    fn worker_lifecycle_fixture() {
        let Ok(root) = std::env::var("PILOT_WORKER_LIFECYCLE_FIXTURE") else {
            return;
        };
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(Path::new(&root).join("starts.txt"))
            .unwrap();
        writeln!(file, "{}", std::process::id()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        std::process::exit(
            std::env::var("PILOT_WORKER_EXIT_CODE")
                .unwrap()
                .parse()
                .unwrap(),
        );
    }

    fn lifecycle_setup(
        root: &Path,
        code: i32,
        restarts: u32,
        backoff: u64,
    ) -> HashMap<String, String> {
        std::fs::write(root.join("worker.manifest.json"), json!({
            "name":"lifecycle", "command":["${pilot:binary}","--exact","deployment::worker_manifest_supervisor::tests::worker_lifecycle_fixture","--nocapture"],
            "restartPolicy":{"type":"on-failure","maxRestarts":restarts,"backoffSeconds":backoff}
        }).to_string()).unwrap();
        let mut env = HashMap::from([
            (
                "PILOT_WORKER_LIFECYCLE_FIXTURE".into(),
                root.to_string_lossy().into_owned(),
            ),
            ("PILOT_WORKER_EXIT_CODE".into(), code.to_string()),
            ("HOME".into(), root.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), root.to_string_lossy().into_owned()),
            (
                "PATH".into(),
                root.join("no-runtimes").to_string_lossy().into_owned(),
            ),
        ]);
        for key in ["SystemRoot", "WINDIR"] {
            if let Ok(value) = std::env::var(key) {
                env.insert(key.into(), value);
            }
        }
        env
    }

    async fn await_state(root: &Path, expected: &str) -> Value {
        let status = root.join(".agent-worker/status.json");
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(value) = read_status(status.to_str().unwrap()).await {
                    if value["state"] == expected {
                        return value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "未得到 {expected} 状态: {:?}",
                std::fs::read_to_string(status)
            )
        })
    }

    #[tokio::test]
    async fn natural_exit_records_status_and_on_failure_restarts_are_bounded() {
        for (code, max, starts) in [(0, 2, 1), (23, 0, 1), (23, 2, 3)] {
            let dir = tempfile::tempdir().unwrap();
            let env = lifecycle_setup(dir.path(), code, max, 0);
            assert!(
                WorkerManifestSupervisor::new()
                    .start_if_present(
                        "fixture",
                        dir.path().to_str().unwrap(),
                        &env,
                        &WorkerManifestOptions::default()
                    )
                    .await
            );
            let status = await_state(dir.path(), "exited").await;
            assert_eq!(status["exitCode"], code);
            assert_eq!(status["restartCount"], starts - 1);
            assert_eq!(
                std::fs::read_to_string(dir.path().join("starts.txt"))
                    .unwrap()
                    .lines()
                    .count(),
                starts
            );
            assert!(!dir.path().join(".agent-worker/worker.pid").exists());
            assert!(!dir
                .path()
                .join(".agent-worker/worker.pid.identity.json")
                .exists());
        }
    }

    #[tokio::test]
    async fn stop_during_backoff_cancels_restart_even_from_another_supervisor() {
        let dir = tempfile::tempdir().unwrap();
        let env = lifecycle_setup(dir.path(), 23, 3, 2);
        let options = WorkerManifestOptions::default();
        assert!(
            WorkerManifestSupervisor::new()
                .start_if_present("fixture", dir.path().to_str().unwrap(), &env, &options)
                .await
        );
        await_state(dir.path(), "restarting").await;
        assert!(
            WorkerManifestSupervisor::new()
                .stop_if_present("fixture", dir.path().to_str().unwrap(), &options)
                .await
        );
        tokio::time::sleep(Duration::from_millis(2300)).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("starts.txt"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(await_state(dir.path(), "stopped").await["state"], "stopped");
    }

    #[tokio::test]
    async fn late_exit_cannot_remove_replacement_pid_or_status_under_worker_lock() {
        let dir = tempfile::tempdir().unwrap();
        let env = lifecycle_setup(dir.path(), 0, 0, 0);
        assert!(
            WorkerManifestSupervisor::new()
                .start_if_present(
                    "fixture",
                    dir.path().to_str().unwrap(),
                    &env,
                    &WorkerManifestOptions::default()
                )
                .await
        );
        let pid_path = dir.path().join(".agent-worker/worker.pid");
        let status_path = dir.path().join(".agent-worker/status.json");
        let lock = WorkerLock::acquire(pid_path.to_str().unwrap())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        std::fs::write(&pid_path, "40002\n").unwrap();
        assert!(
            write_status(
                status_path.to_str().unwrap(),
                &json!({"state":"running","runId":"new-generation","pid":40002})
            )
            .await
        );
        let before = std::fs::read(&status_path).unwrap();
        drop(lock);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(std::fs::read(&status_path).unwrap(), before);
        assert_eq!(std::fs::read_to_string(pid_path).unwrap(), "40002\n");
    }

    #[tokio::test]
    async fn malformed_pid_never_becomes_permission_to_spawn_another_worker() {
        for raw in ["", "0", "1", "-7", "+40001", "4294967295", "not-a-pid"] {
            let dir = tempfile::tempdir().unwrap();
            let (_, paths) = tracked_fixture(dir.path(), None).await;
            std::fs::write(&paths.pid, raw).unwrap();
            assert!(
                !WorkerManifestSupervisor::new()
                    .start_if_present(
                        "fixture",
                        dir.path().to_str().unwrap(),
                        &HashMap::new(),
                        &WorkerManifestOptions::default()
                    )
                    .await
            );
            assert_eq!(std::fs::read_to_string(&paths.pid).unwrap(), raw);
            assert_eq!(
                read_status(&paths.status).await.unwrap()["reason"],
                "WorkerPidInvalid"
            );
            assert!(!Path::new(&paths.log).exists());
        }
    }

    #[test]
    fn runtime_values_preserve_native_arguments_instead_of_json_escapes() {
        for value in ["C:\\Users\\用户", "带\"引号\"和\n换行", "🚀 "] {
            assert_eq!(runtime_option_value(&json!(value)), value);
            let options = WorkerManifestOptions {
                runtime_options: Some(HashMap::from([("model-name".into(), json!(value))])),
                ..Default::default()
            };
            assert_eq!(expand("${instance:modelName}", "unused", &options), value);
        }
        assert_eq!(
            runtime_option_value(&json!([1, null, true, ["a", "b"]])),
            "1,,true,a,b"
        );
        assert_eq!(runtime_option_value(&json!({"x":1})), "[object Object]");
    }

    #[test]
    fn native_identity_rejects_self_signals_and_preserves_timestamp_precision() {
        let identity = NativeProcesses
            .identity(std::process::id())
            .unwrap()
            .unwrap();
        assert!(!identity.executable_path.is_empty());
        assert!(identity.matches(
            &NativeProcesses
                .identity(std::process::id())
                .unwrap()
                .unwrap()
        ));
        assert!(NativeProcesses.signal(&identity, true).is_err());
        assert!(NativeProcesses.descendants(&identity).is_err());
        let a = fake_identity(40001);
        let mut b = a.clone();
        b.creation_time = "2026-07-30T00:00:00.000000000Z".into();
        assert!(a.matches(&b));
        b.creation_time = "2026-07-30T00:00:00.000000100Z".into();
        assert!(!a.matches(&b));
    }

    #[tokio::test]
    async fn windows_bundle_shell_preflight_preserves_failure_metadata_without_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let supervisor = WorkerManifestSupervisor::with_platform("win32", "");
        for (name, header) in [
            ("bundle.sh", "exit 0"),
            ("entry", "#!/usr/bin/env bash\r\nexit 0"),
            ("upper", "#!/BIN/SH\n"),
            ("z", "#!/bin/zsh -e\n"),
        ] {
            let entry = dir.path().join(name);
            std::fs::write(&entry, header).unwrap();
            std::fs::write(
                dir.path().join("worker.manifest.json"),
                json!({
                    "name":"fixture", "version":"1.2.3", "command":[entry]
                })
                .to_string(),
            )
            .unwrap();
            assert!(
                !supervisor
                    .start_if_present(
                        "fixture",
                        root,
                        &HashMap::new(),
                        &WorkerManifestOptions::default()
                    )
                    .await
            );
            let status: Value = serde_json::from_slice(
                &std::fs::read(dir.path().join(".agent-worker/status.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(status["reason"], "RuntimeBundlePlatformUnsupported");
            assert_eq!(status["platform"], "win32");
            assert_eq!(status["bundleVersion"], "1.2.3");
            assert_eq!(status["entryType"], "unix-shell");
            assert!(!dir.path().join(".agent-worker/worker.pid").exists());
        }
        for (name, header) in [
            ("native", "MZfixture"),
            ("node", "#!/usr/bin/env node\n"),
            ("not-header", "text\n#!/bin/sh"),
            ("bashful", "#!/bin/bashful\n"),
        ] {
            std::fs::write(dir.path().join(name), header).unwrap();
            assert!(!is_unix_shell_entry(name, root).await, "{name}");
        }
        assert!(!is_unix_shell_entry("missing", root).await);
    }

    #[test]
    fn windows_managed_home_is_child_only_and_respects_explicit_overrides() {
        let manifest: WorkerManifest = serde_json::from_value(json!({
            "name":"fixture", "command":["unused"], "env":{
                "DATA":"${instance:stateDir}", "MODEL":"${instance:modelName}", "BUNDLE":"${destDir}"
            }
        })).unwrap();
        let options = WorkerManifestOptions {
            instance: Some(HashMap::from([("stateDir".into(), "状态 空格🚀".into())])),
            runtime_options: Some(HashMap::from([("model-name".into(), json!("模型"))])),
        };
        let env = HashMap::from([("USERPROFILE".into(), "C:\\Users\\测试 用户".into())]);
        let before = env.clone();
        let child = resolve_environment("win32", &env, &manifest, "bundle", &options);
        assert_eq!(child["HOME"], env["USERPROFILE"]);
        assert_eq!(child["DATA"], "状态 空格🚀");
        assert_eq!(child["MODEL"], "模型");
        assert_eq!(child["BUNDLE"], "bundle");
        assert_eq!(env, before);
        assert!(
            !resolve_environment("linux", &env, &manifest, "bundle", &options).contains_key("HOME")
        );
        assert!(!resolve_environment(
            "win32",
            &env,
            &manifest,
            "bundle",
            &WorkerManifestOptions::default()
        )
        .contains_key("HOME"));
        let mut explicit = manifest.clone();
        explicit
            .env
            .as_mut()
            .unwrap()
            .insert("HOME".into(), "显式目录".into());
        assert_eq!(
            resolve_environment("win32", &env, &explicit, "bundle", &options)["HOME"],
            "显式目录"
        );
    }

    #[tokio::test]
    async fn command_resolution_keeps_unicode_arguments_and_rejects_interpolated_placeholders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let supervisor = WorkerManifestSupervisor::with_platform("linux", "");
        let mut manifest: WorkerManifest = serde_json::from_value(json!({
            "name":"fixture", "command":["${pilot:binary}", "参数 空格🚀", "${destDir}", "${instance:modelName}"]
        })).unwrap();
        let options = WorkerManifestOptions {
            instance: None,
            runtime_options: Some(HashMap::from([("model-name".into(), json!("保留值"))])),
        };
        let (binary, args) = supervisor
            .resolve_command(root, root, &manifest, &options)
            .await
            .unwrap();
        assert_eq!(Path::new(&binary), std::env::current_exe().unwrap());
        assert_eq!(args, ["参数 空格🚀", root, "保留值"]);
        for command in [
            "${pilot:other}",
            "prefix-${pilot:binary}",
            "prefix-${pilot:node}",
        ] {
            manifest.command = vec![command.into()];
            assert!(supervisor
                .resolve_command(root, root, &manifest, &options)
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn pilot_binary_and_external_node_are_distinct_runtimes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let pilot = std::env::current_exe().unwrap();
        let options = WorkerManifestOptions::default();
        let mut manifest: WorkerManifest = serde_json::from_value(json!({
            "name":"fixture", "command":["${pilot:node}", "agent.js"]
        }))
        .unwrap();
        let missing = WorkerManifestSupervisor::with_platform("linux", "");
        assert!(missing
            .resolve_command(root, root, &manifest, &options)
            .await
            .is_err());
        let incorrect = WorkerManifestSupervisor::with_platform("linux", pilot.to_str().unwrap());
        assert!(incorrect
            .resolve_command(root, root, &manifest, &options)
            .await
            .is_err());
        let external = dir.path().join("agent-node");
        std::fs::write(&external, "外部运行时占位，测试不执行").unwrap();
        let configured =
            WorkerManifestSupervisor::with_platform("linux", external.to_str().unwrap());
        assert_eq!(
            configured
                .resolve_command(root, root, &manifest, &options)
                .await
                .unwrap()
                .0,
            external.to_str().unwrap()
        );
        manifest.command = vec!["${pilot:binary}".into(), "--version".into()];
        let (binary, args) = missing
            .resolve_command(root, root, &manifest, &options)
            .await
            .unwrap();
        assert_eq!(Path::new(&binary), pilot);
        assert_eq!(args, ["--version"]);
        manifest.env = Some(HashMap::from([("UNSAFE".into(), "${pilot:binary}".into())]));
        assert!(validate_placeholders(&manifest).is_err());
    }

    #[test]
    fn rejects_placeholders_other_than_pilot_node() {
        let manifest = WorkerManifest {
            name: "worker".into(),
            runtime: None,
            version: None,
            command: vec!["${pilot:node}".into(), "${pilot:secret}".into()],
            cwd: None,
            env: None,
            paths: None,
            restart_policy: None,
        };
        assert!(validate_placeholders(&manifest).is_err());
    }
}

#[cfg(test)]
#[path = "worker_manifest_history_contract_tests.rs"]
mod history_contract_tests;

#[cfg(test)]
#[path = "worker_manifest_snapshot_retry_tests.rs"]
mod snapshot_retry_contract_tests;
