//! Merge deployed-agent records without dropping another process's ids.

use crate::types::{DeployedAgentRecord, DeployedAgentsState};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use super::paths::node_resolve;

const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(25);

// 保留锁文件本身，避免删除后其他进程锁住不同 inode；句柄关闭即释放系统锁。
pub(crate) fn open_state_lock(path: &Path) -> anyhow::Result<Option<std::fs::File>> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            let metadata = crate::utils::runtime_paths::runtime_metadata(path)?;
            if metadata.is_dir() {
                // 旧版目录锁没有可验证的持有者，不能仅凭 mtime 认定其已失效。
                return Ok(None);
            }
            anyhow::ensure!(metadata.is_file(), "部署状态锁不是普通文件");
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // 打开 reparse point 本身供后续校验，持锁期间禁止删除或替换路径。
        options.custom_flags(0x0020_0000).share_mode(0x1 | 0x2);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "部署状态锁不是普通文件");
    anyhow::ensure!(metadata.len() == 0, "部署状态锁内容异常，保留原文件");
    let current = crate::utils::runtime_paths::runtime_metadata(path)?;
    anyhow::ensure!(current.is_file(), "部署状态锁路径已变化");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(metadata.nlink() == 1, "部署状态锁不能为硬链接");
        anyhow::ensure!(
            metadata.dev() == current.dev() && metadata.ino() == current.ino(),
            "部署状态锁路径已变化"
        );
    }
    Ok(Some(file))
}

pub fn merge_hook_settings_paths(
    record: Option<&DeployedAgentRecord>,
    extra: Option<&str>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut add = |value: Option<&str>| {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        let resolved = node_resolve(value);
        if seen.insert(resolved.clone()) {
            out.push(resolved);
        }
    };
    if let Some(record) = record {
        if let Some(paths) = &record.hook_settings_paths {
            for item in paths {
                add(Some(item));
            }
        }
        add(record.hook_settings_path.as_deref());
    }
    add(extra);
    out
}

/// Overlay only the ids this process changed. Disk records written by another
/// process stay in place.
pub fn merge_deployed_agents_state(
    disk: &DeployedAgentsState,
    memory: &DeployedAgentsState,
    touched_ids: &HashSet<String>,
) -> DeployedAgentsState {
    let mut merged = disk.clone();
    for id in touched_ids {
        let Some(next) = memory.get(id) else {
            merged.remove(id);
            continue;
        };
        let previous = disk.get(id);
        let mut path_inputs = Vec::new();
        if let Some(previous) = previous {
            if let Some(paths) = &previous.hook_settings_paths {
                path_inputs.extend(paths.clone());
            }
            if let Some(path) = &previous.hook_settings_path {
                path_inputs.push(path.clone());
            }
        }
        if let Some(paths) = &next.hook_settings_paths {
            path_inputs.extend(paths.clone());
        }
        let synthetic = DeployedAgentRecord {
            hook_settings_paths: Some(path_inputs),
            hook_settings_path: next
                .hook_settings_path
                .clone()
                .or_else(|| previous.and_then(|record| record.hook_settings_path.clone())),
            ..next.clone()
        };
        let paths = merge_hook_settings_paths(Some(&synthetic), None);
        let mut record = previous.cloned().unwrap_or_else(|| next.clone());
        record.deploy_mode = next.deploy_mode;
        record.deployed_at = next.deployed_at.clone();
        record.source_hash = next.source_hash.clone().or(record.source_hash);
        // Overlay next over previous, matching `{ ...previous, ...next }`.
        record = overlay_record(previous, next);
        if !paths.is_empty() {
            record.hook_settings_paths = Some(paths);
        }
        record.hook_settings_path = next
            .hook_settings_path
            .clone()
            .or_else(|| previous.and_then(|item| item.hook_settings_path.clone()));
        merged.insert(id.clone(), record);
    }
    merged
}

fn overlay_record(
    previous: Option<&DeployedAgentRecord>,
    next: &DeployedAgentRecord,
) -> DeployedAgentRecord {
    let mut record = previous.cloned().unwrap_or_else(|| next.clone());
    record.deploy_mode = next.deploy_mode;
    record.deployed_at = next.deployed_at.clone();
    if next.source_hash.is_some() {
        record.source_hash = next.source_hash.clone();
    }
    if next.last_remote_checked_at.is_some() {
        record.last_remote_checked_at = next.last_remote_checked_at.clone();
    }
    if next.target_dir.is_some() {
        record.target_dir = next.target_dir.clone();
    }
    if next.dsh_patch_path.is_some() {
        record.dsh_patch_path = next.dsh_patch_path.clone();
    }
    if next.hook_settings_path.is_some() {
        record.hook_settings_path = next.hook_settings_path.clone();
    }
    if next.hook_settings_paths.is_some() {
        record.hook_settings_paths = next.hook_settings_paths.clone();
    }
    if next.installed_by.is_some() {
        record.installed_by = next.installed_by;
    }
    if next.plugin_inject_config_path.is_some() {
        record.plugin_inject_config_path = next.plugin_inject_config_path.clone();
    }
    record
}

/// 在资源事务的原始状态快照上规划单个 Hook 目标，保留其他 Agent 和尚未清理的路径。
pub(super) fn plan_hook_state(
    raw: Option<&str>,
    def: &crate::types::AgentDefinition,
    installed_by: Option<crate::types::InstalledBy>,
    uninstall: bool,
    configuration_changed: bool,
) -> anyhow::Result<Option<String>> {
    use crate::types::DeployMode;
    let mut state: DeployedAgentsState = match raw {
        Some(raw) => {
            let value = crate::utils::parse_json_document(raw, crate::utils::JsonSyntax::Json)
                .map_err(|_| anyhow::anyhow!("部署状态 JSON 无效，原文件保留"))?;
            anyhow::ensure!(value.is_object(), "部署状态根节点必须为对象");
            serde_json::from_value(value)
                .map_err(|_| anyhow::anyhow!("部署状态 schema 无效，原文件保留"))?
        }
        None => DeployedAgentsState::new(),
    };
    anyhow::ensure!(
        def.deploy_mode == DeployMode::Hook,
        "状态事务只接受 Hook 定义"
    );
    let hook = def
        .hook
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Hook 配置缺失"))?;
    let target = node_resolve(&crate::utils::resolve_home(&hook.settings_path));
    let before = serde_json::to_value(&state)?;
    if uninstall {
        if let Some(record) = state.get_mut(&def.id) {
            let remaining: Vec<_> = merge_hook_settings_paths(Some(record), None)
                .into_iter()
                .filter(|path| path != &target)
                .collect();
            if remaining.is_empty() {
                state.remove(&def.id);
            } else {
                record.hook_settings_path = remaining.last().cloned();
                record.hook_settings_paths = Some(remaining);
            }
        }
    } else {
        let previous = state.get(&def.id).cloned();
        let mut record = previous.clone().unwrap_or(DeployedAgentRecord {
            deploy_mode: DeployMode::Hook,
            deployed_at: super::paths::iso_now(),
            source_hash: None,
            last_remote_checked_at: None,
            target_dir: None,
            dsh_patch_path: None,
            hook_settings_path: None,
            hook_settings_paths: None,
            installed_by: None,
            plugin_inject_config_path: None,
        });
        record.deploy_mode = DeployMode::Hook;
        if let Some(installed_by) = installed_by {
            record.installed_by = Some(installed_by);
        }
        record.hook_settings_paths =
            Some(merge_hook_settings_paths(previous.as_ref(), Some(&target)));
        record.hook_settings_path = Some(target);
        if configuration_changed
            || previous.as_ref().is_none_or(|old| {
                serde_json::to_value(old).ok() != serde_json::to_value(&record).ok()
            })
        {
            record.deployed_at = super::paths::iso_now();
        }
        state.insert(def.id.clone(), record);
    }
    if serde_json::to_value(&state)? == before {
        return Ok(None);
    }
    Ok(Some(crate::utils::fs_utils::to_pretty_json(&state)?))
}

#[derive(Debug)]
pub struct LockTimeout;

impl std::fmt::Display for LockTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("lock-timeout")
    }
}

impl std::error::Error for LockTimeout {}

pub async fn with_deployed_state_lock<T, Fut>(
    lock_path: &str,
    body: impl FnOnce() -> Fut,
    timeout_ms: u64,
) -> Result<T, anyhow::Error>
where
    Fut: std::future::Future<Output = Result<T, anyhow::Error>>,
{
    let started = tokio::time::Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let path = Path::new(lock_path);
    loop {
        if let Some(file) = open_state_lock(path)? {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => {
                    // 包括错误、panic、取消和进程退出，均由文件句柄释放锁。
                    let result = body().await;
                    drop(file);
                    return result;
                }
                Err(err) if err.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {}
                Err(err) => return Err(err.into()),
            }
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(LockTimeout.into());
        }
        tokio::time::sleep(LOCK_RETRY_INTERVAL.min(timeout - elapsed)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DeployMode, InstalledBy};
    use std::time::SystemTime;

    fn record(path: &str) -> DeployedAgentRecord {
        DeployedAgentRecord {
            deploy_mode: DeployMode::Hook,
            deployed_at: "2026-01-01T00:00:00.000Z".into(),
            source_hash: None,
            last_remote_checked_at: None,
            target_dir: None,
            dsh_patch_path: None,
            hook_settings_path: Some(path.into()),
            hook_settings_paths: None,
            installed_by: Some(InstalledBy::Daemon),
            plugin_inject_config_path: None,
        }
    }

    #[test]
    fn merges_hook_paths_without_duplicates() {
        let mut disk_record = record("/tmp/a.json");
        disk_record.hook_settings_paths = Some(vec!["/tmp/a.json".into(), "/tmp/b.json".into()]);
        let paths = merge_hook_settings_paths(Some(&disk_record), Some("/tmp/c.json"));
        assert_eq!(paths.len(), 3);
        assert!(paths.iter().any(|path| path.ends_with("c.json")));
    }

    #[test]
    fn overlay_keeps_untouched_disk_records_and_unions_paths() {
        let mut disk = DeployedAgentsState::new();
        disk.insert("other".into(), record("/tmp/other.json"));
        let mut previous = record("/tmp/old.json");
        previous.hook_settings_paths = Some(vec!["/tmp/old.json".into()]);
        disk.insert("grok-build".into(), previous);
        let mut memory = DeployedAgentsState::new();
        memory.insert("grok-build".into(), record("/tmp/new.json"));
        let mut touched = HashSet::new();
        touched.insert("grok-build".into());
        let merged = merge_deployed_agents_state(&disk, &memory, &touched);
        assert!(merged.contains_key("other"));
        let grok = merged.get("grok-build").unwrap();
        let paths = grok.hook_settings_paths.clone().unwrap_or_default();
        assert!(paths.iter().any(|path| path.ends_with("old.json")));
        assert!(paths.iter().any(|path| path.ends_with("new.json")));
        assert!(grok
            .hook_settings_path
            .as_deref()
            .unwrap()
            .ends_with("new.json"));
    }

    #[tokio::test]
    async fn lock_serializes_writers_and_keeps_the_same_lock_file() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("状态 空格🚀.lock");
        let active = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..12 {
            let path = path.clone();
            let active = active.clone();
            let completed = completed.clone();
            tasks.push(tokio::spawn(async move {
                with_deployed_state_lock(
                    path.to_str().unwrap(),
                    || async {
                        assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                        tokio::task::yield_now().await;
                        assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
                        completed.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    2_000,
                )
                .await
                .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(completed.load(Ordering::SeqCst), 12);
        assert_eq!(std::fs::read(&path).unwrap(), b"");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn active_lock_is_not_evicted_by_age_and_cancellation_releases_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.lock");
        let held_path = path.clone();
        let (entered, wait) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            with_deployed_state_lock(
                held_path.to_str().unwrap(),
                || async {
                    let file = std::fs::OpenOptions::new().write(true).open(&held_path)?;
                    file.set_times(
                        std::fs::FileTimes::new()
                            .set_modified(SystemTime::now() - Duration::from_secs(120)),
                    )?;
                    entered.send(()).unwrap();
                    std::future::pending::<anyhow::Result<()>>().await
                },
                500,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), wait)
            .await
            .unwrap()
            .unwrap();
        let err = with_deployed_state_lock(
            path.to_str().unwrap(),
            || async { Err::<(), _>(anyhow::anyhow!("不能进入已被占用的临界区")) },
            40,
        )
        .await
        .unwrap_err();
        assert!(err.downcast_ref::<LockTimeout>().is_some());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            with_deployed_state_lock(path.to_str().unwrap(), || async { Ok(7) }, 500)
                .await
                .unwrap(),
            7
        );
    }

    #[tokio::test]
    async fn lock_releases_on_body_error_and_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.lock");
        let err = with_deployed_state_lock(
            path.to_str().unwrap(),
            || async { Err::<(), _>(anyhow::anyhow!("写入失败")) },
            100,
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "写入失败");
        let held_path = path.clone();
        let task = tokio::spawn(async move {
            with_deployed_state_lock::<(), _>(
                held_path.to_str().unwrap(),
                || async {
                    panic!("模拟临界区 panic");
                },
                100,
            )
            .await
        });
        assert!(task.await.unwrap_err().is_panic());
        assert!(
            with_deployed_state_lock(path.to_str().unwrap(), || async { Ok(()) }, 100)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn lock_rejects_unexpected_files_without_changing_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.lock");
        std::fs::write(&path, "用户内容").unwrap();
        assert!(
            with_deployed_state_lock(path.to_str().unwrap(), || async { Ok(()) }, 0)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "用户内容");
        assert!(with_deployed_state_lock(
            dir.path().join("missing/state.lock").to_str().unwrap(),
            || async { Ok(()) },
            0
        )
        .await
        .is_err());
        assert!(!dir.path().join("missing").exists());
        #[cfg(unix)]
        {
            let link = dir.path().join("link.lock");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(
                with_deployed_state_lock(link.to_str().unwrap(), || async { Ok(()) }, 0)
                    .await
                    .is_err()
            );
            let empty = dir.path().join("empty");
            std::fs::write(&empty, "").unwrap();
            let hard = dir.path().join("hard.lock");
            std::fs::hard_link(&empty, &hard).unwrap();
            assert!(
                with_deployed_state_lock(hard.to_str().unwrap(), || async { Ok(()) }, 0)
                    .await
                    .is_err()
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "用户内容");
        }
    }

    #[tokio::test]
    async fn state_lock_subprocess_helper() {
        let Some(path) = std::env::var_os("PILOT_STATE_LOCK_TEST_PATH") else {
            return;
        };
        let path = std::path::PathBuf::from(path);
        with_deployed_state_lock(
            path.to_str().unwrap(),
            || async {
                std::fs::write(path.with_extension("ready"), "ready")?;
                std::future::pending::<anyhow::Result<()>>().await
            },
            2_000,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn process_exit_releases_lock_without_stale_age_delay() {
        use std::process::{Child, Command, Stdio};
        struct Reap(Child);
        impl Drop for Reap {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.lock");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "deployment::deployed_state_merge::tests::state_lock_subprocess_helper",
            ])
            .env_clear()
            .env("PILOT_STATE_LOCK_TEST_PATH", &path)
            .env("HOME", dir.path())
            .env("USERPROFILE", dir.path())
            .current_dir(dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = Reap(command.spawn().unwrap());
        tokio::time::timeout(Duration::from_secs(5), async {
            while !path.with_extension("ready").is_file() {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "锁测试子进程提前退出"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let err = with_deployed_state_lock(path.to_str().unwrap(), || async { Ok(()) }, 40)
            .await
            .unwrap_err();
        assert!(err.downcast_ref::<LockTimeout>().is_some());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        with_deployed_state_lock(path.to_str().unwrap(), || async { Ok(()) }, 500)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn lock_times_out_with_lock_timeout_text() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("state.lock");
        std::fs::create_dir(&lock).unwrap();
        let err = with_deployed_state_lock(lock.to_str().unwrap(), || async { Ok(1) }, 40)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("lock-timeout"));
    }
}
