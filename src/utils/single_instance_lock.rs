//! Port of `src/utils/single-instance-lock.ts`.

use super::pid_utils::{
    is_command_match, is_process_alive, read_process_command, read_process_start_token,
    ProcessCommandPattern,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleLockReason {
    MalformedLock,
    DeadHolder,
    PidReused,
    SamePidOwnerMismatch,
}

impl StaleLockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MalformedLock => "malformed-lock",
            Self::DeadHolder => "dead-holder",
            Self::PidReused => "pid-reused",
            Self::SamePidOwnerMismatch => "same-pid-owner-mismatch",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HolderProcessStartState {
    SameProcessOwner,
    Matched,
    LockTokenMissing,
    CurrentTokenUnreadable,
}

impl HolderProcessStartState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SameProcessOwner => "same-process-owner",
            Self::Matched => "matched",
            Self::LockTokenMissing => "lock-token-missing",
            Self::CurrentTokenUnreadable => "current-token-unreadable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HolderCommandState {
    Matched,
    Mismatched,
    Unreadable,
    NotChecked,
}

impl HolderCommandState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Matched => "matched",
            Self::Mismatched => "mismatched",
            Self::Unreadable => "unreadable",
            Self::NotChecked => "not-checked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleLockRecovery {
    pub previous_pid: Option<i64>,
    pub reason: StaleLockReason,
}

pub struct SingleInstanceLock {
    pub path: String,
    owner_id: String,
    released: AtomicBool,
}

impl std::fmt::Debug for SingleInstanceLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SingleInstanceLock")
            .field("path", &self.path)
            .field("owner_id", &self.owner_id)
            .field("released", &self.released.load(Ordering::SeqCst))
            .finish()
    }
}

impl SingleInstanceLock {
    pub fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        {
            let mut owners = owners();
            if owners.get(&self.path) == Some(&self.owner_id) {
                owners.remove(&self.path);
            }
        }
        if let Some(existing) = read_lock(&self.path) {
            if existing.pid == std::process::id() as i64
                && existing.owner_id.as_deref() == Some(self.owner_id.as_str())
            {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

#[derive(Debug)]
pub struct LockAcquireResult {
    pub lock: Option<SingleInstanceLock>,
    pub holder_pid: Option<i64>,
    pub error: Option<io::Error>,
    pub holder_process_start_state: Option<HolderProcessStartState>,
    pub holder_command_state: Option<HolderCommandState>,
    pub recovered_stale_lock: Option<StaleLockRecovery>,
}

impl LockAcquireResult {
    fn denied() -> Self {
        Self {
            lock: None,
            holder_pid: None,
            error: None,
            holder_process_start_state: None,
            holder_command_state: None,
            recovered_stale_lock: None,
        }
    }
}

#[derive(Debug, Clone)]
struct LockPayload {
    pid: i64,
    owner_id: Option<String>,
    process_start_token: Option<String>,
}

#[derive(Serialize)]
struct LockFile<'a> {
    pid: u32,
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "ownerId")]
    owner_id: &'a str,
    #[serde(rename = "processStartToken", skip_serializing_if = "Option::is_none")]
    process_start_token: Option<&'a str>,
}

struct Inspection {
    stale: bool,
    stale_reason: Option<StaleLockReason>,
    holder_process_start_state: Option<HolderProcessStartState>,
    holder_command_state: Option<HolderCommandState>,
}

enum Attempt {
    Done(LockAcquireResult),
    Retry(StaleLockRecovery),
}

fn owners() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    static OWNERS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let map = OWNERS.get_or_init(|| Mutex::new(HashMap::new()));
    match map.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub fn acquire_single_instance_lock(
    lock_path: &str,
    patterns: Option<&[ProcessCommandPattern<'_>]>,
) -> LockAcquireResult {
    let lock_path = resolve_path(lock_path);
    if let Some(parent) = Path::new(&lock_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut pending = None;
    match attempt(&lock_path, patterns, pending.as_ref()) {
        Attempt::Done(result) => result,
        Attempt::Retry(recovery) => {
            pending = Some(recovery);
            match attempt(&lock_path, patterns, pending.as_ref()) {
                Attempt::Done(result) => result,
                Attempt::Retry(_) => LockAcquireResult::denied(),
            }
        }
    }
}

fn attempt(
    lock_path: &str,
    patterns: Option<&[ProcessCommandPattern<'_>]>,
    pending: Option<&StaleLockRecovery>,
) -> Attempt {
    let owner_id = Uuid::new_v4().to_string();
    match write_own_lock(lock_path, &owner_id) {
        Ok(()) => {
            let lock = make_handle(lock_path, owner_id);
            Attempt::Done(LockAcquireResult {
                lock: Some(lock),
                holder_pid: None,
                error: None,
                holder_process_start_state: None,
                holder_command_state: None,
                recovered_stale_lock: pending.cloned(),
            })
        }
        Err(err) if is_eexist(&err) => {
            let existing = read_lock(lock_path);
            let inspection = inspect_lock(lock_path, existing.as_ref(), patterns);
            if inspection.stale {
                let recovery = StaleLockRecovery {
                    previous_pid: existing.as_ref().map(|lock| lock.pid),
                    reason: inspection
                        .stale_reason
                        .unwrap_or(StaleLockReason::MalformedLock),
                };
                match std::fs::remove_file(lock_path) {
                    Ok(()) => Attempt::Retry(recovery),
                    Err(err) if is_enoent(&err) => Attempt::Retry(recovery),
                    Err(err) => Attempt::Done(LockAcquireResult {
                        lock: None,
                        holder_pid: None,
                        error: Some(err),
                        holder_process_start_state: None,
                        holder_command_state: None,
                        recovered_stale_lock: None,
                    }),
                }
            } else {
                Attempt::Done(LockAcquireResult {
                    lock: None,
                    holder_pid: existing.as_ref().map(|lock| lock.pid),
                    error: None,
                    holder_process_start_state: inspection.holder_process_start_state,
                    holder_command_state: inspection.holder_command_state,
                    recovered_stale_lock: None,
                })
            }
        }
        Err(err) => Attempt::Done(LockAcquireResult {
            lock: None,
            holder_pid: None,
            error: Some(err),
            holder_process_start_state: None,
            holder_command_state: None,
            recovered_stale_lock: None,
        }),
    }
}

fn inspect_lock(
    lock_path: &str,
    lock: Option<&LockPayload>,
    patterns: Option<&[ProcessCommandPattern<'_>]>,
) -> Inspection {
    let Some(lock) = lock else {
        return Inspection {
            stale: true,
            stale_reason: Some(StaleLockReason::MalformedLock),
            holder_process_start_state: None,
            holder_command_state: None,
        };
    };
    if lock.pid == std::process::id() as i64 {
        let owned = lock
            .owner_id
            .as_ref()
            .is_some_and(|owner| owners().get(lock_path) == Some(owner));
        return if owned {
            Inspection {
                stale: false,
                stale_reason: None,
                holder_process_start_state: Some(HolderProcessStartState::SameProcessOwner),
                holder_command_state: Some(command_state(lock.pid, patterns)),
            }
        } else {
            Inspection {
                stale: true,
                stale_reason: Some(StaleLockReason::SamePidOwnerMismatch),
                holder_process_start_state: None,
                holder_command_state: None,
            }
        };
    }
    if !alive_pid(lock.pid) {
        return Inspection {
            stale: true,
            stale_reason: Some(StaleLockReason::DeadHolder),
            holder_process_start_state: None,
            holder_command_state: None,
        };
    }
    let current = if lock.pid > 0 && lock.pid <= u32::MAX as i64 {
        read_process_start_token(lock.pid as u32)
    } else {
        String::new()
    };
    // CIM and FILETIME have different timestamp precision. A format change is
    // not evidence of PID reuse: keep a live legacy holder until it exits.
    let current = if lock
        .process_start_token
        .as_deref()
        .is_some_and(|stored| windows_start_token_format_changed(stored, &current))
    {
        String::new()
    } else {
        current
    };
    if lock
        .process_start_token
        .as_ref()
        .is_some_and(|token| !token.is_empty())
        && !current.is_empty()
        && lock.process_start_token.as_deref() != Some(current.as_str())
    {
        return Inspection {
            stale: true,
            stale_reason: Some(StaleLockReason::PidReused),
            holder_process_start_state: None,
            holder_command_state: None,
        };
    }
    let state = if lock
        .process_start_token
        .as_ref()
        .map(|token| token.is_empty())
        .unwrap_or(true)
    {
        HolderProcessStartState::LockTokenMissing
    } else if !current.is_empty() {
        HolderProcessStartState::Matched
    } else {
        HolderProcessStartState::CurrentTokenUnreadable
    };
    Inspection {
        stale: false,
        stale_reason: None,
        holder_process_start_state: Some(state),
        holder_command_state: Some(command_state(lock.pid, patterns)),
    }
}

fn windows_start_token_format_changed(stored: &str, current: &str) -> bool {
    (stored.starts_with("win32-cim-v1:") && current.starts_with("win32-filetime-v1:"))
        || (stored.starts_with("win32-filetime-v1:") && current.starts_with("win32-cim-v1:"))
}

fn command_state(pid: i64, patterns: Option<&[ProcessCommandPattern<'_>]>) -> HolderCommandState {
    let Some(patterns) = patterns.filter(|patterns| !patterns.is_empty()) else {
        return HolderCommandState::NotChecked;
    };
    if pid <= 0 || pid > u32::MAX as i64 {
        return HolderCommandState::Unreadable;
    }
    let command = read_process_command(pid as u32);
    if command.is_empty() {
        HolderCommandState::Unreadable
    } else if is_command_match(&command, patterns) {
        HolderCommandState::Matched
    } else {
        HolderCommandState::Mismatched
    }
}

fn alive_pid(pid: i64) -> bool {
    if pid <= 0 || pid > u32::MAX as i64 {
        return false;
    }
    is_process_alive(pid as u32)
}

fn write_own_lock(lock_path: &str, owner_id: &str) -> io::Result<()> {
    #[cfg(all(test, unix))]
    if let Some(error) = history_test_hooks::write_error(lock_path) {
        return Err(error);
    }
    let started_at = now_ms();
    let token = read_process_start_token(std::process::id());
    let file = LockFile {
        pid: std::process::id(),
        started_at,
        owner_id,
        process_start_token: if token.is_empty() {
            None
        } else {
            Some(token.as_str())
        },
    };
    let payload = serde_json::to_string(&file)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    let tmp = format!("{lock_path}.{}.tmp", std::process::id());
    std::fs::write(&tmp, &payload)?;
    let linked = std::fs::hard_link(&tmp, lock_path);
    let outcome = match linked {
        Ok(()) => Ok(()),
        Err(err) if is_eexist(&err) => Err(err),
        Err(_) => {
            let mut handle = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(lock_path)?;
            let wrote = handle.write_all(payload.as_bytes());
            drop(handle);
            wrote
        }
    };
    let _ = std::fs::remove_file(&tmp);
    outcome
}

fn make_handle(lock_path: &str, owner_id: String) -> SingleInstanceLock {
    owners().insert(lock_path.to_string(), owner_id.clone());
    SingleInstanceLock {
        path: lock_path.to_string(),
        owner_id,
        released: AtomicBool::new(false),
    }
}

fn read_lock(path: &str) -> Option<LockPayload> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let object = value.as_object()?;
    let pid = object.get("pid")?.as_i64()?;
    Some(LockPayload {
        pid,
        owner_id: object
            .get("ownerId")
            .and_then(Value::as_str)
            .map(str::to_string),
        process_start_token: object
            .get("processStartToken")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn resolve_path(path: &str) -> String {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_eexist(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::AlreadyExists || err.raw_os_error() == Some(17)
}

fn is_enoent(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::NotFound || err.raw_os_error() == Some(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    struct KillOnDrop {
        child: Child,
        _root: tempfile::TempDir,
    }

    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn external_holder_fixture() {
        let Some(ready) = std::env::var_os("PILOT_LOCK_FIXTURE_READY") else {
            return;
        };
        std::fs::write(ready, std::process::id().to_string()).unwrap();
        // 仅父测试显式启动的隔离子进程进入此分支，父进程通过 RAII 回收。
        std::thread::sleep(Duration::from_secs(120));
    }

    fn spawn_sleeper() -> KillOnDrop {
        let root = tempfile::tempdir().unwrap();
        let ready = root.path().join("ready.pid");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "utils::single_instance_lock::tests::external_holder_fixture",
            ])
            .env("PILOT_LOCK_FIXTURE_READY", &ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .expect("启动原生锁持有者 fixture");
        let mut guard = KillOnDrop { child, _root: root };
        let start = Instant::now();
        loop {
            assert!(
                guard.child.try_wait().unwrap().is_none(),
                "锁持有者提前退出"
            );
            if let Ok(text) = std::fs::read_to_string(&ready) {
                if text.parse::<u32>().ok() == Some(guard.child.id()) {
                    return guard;
                }
            }
            assert!(start.elapsed() < Duration::from_secs(10), "锁持有者未就绪");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn acquires_when_no_lock_exists() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("nested").join("collector.lock");
        let path = lock_path.to_str().unwrap();
        let result = acquire_single_instance_lock(path, None);
        let handle = result.lock.as_ref().unwrap();
        assert!(result.holder_pid.is_none());
        assert!(Path::new(&handle.path).exists());
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&handle.path).unwrap()).unwrap();
        assert_eq!(payload["pid"], std::process::id());
        assert!(payload["startedAt"].is_number());
        assert!(payload["ownerId"].is_string());
        assert!(payload["processStartToken"].is_string());
        handle.release();
    }

    #[test]
    fn refuses_a_second_acquisition_while_a_live_holder_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let path = path.to_str().unwrap();
        let first = acquire_single_instance_lock(path, None);
        assert!(first.lock.is_some());
        let second = acquire_single_instance_lock(path, None);
        assert!(second.lock.is_none());
        assert_eq!(second.holder_pid, Some(std::process::id() as i64));
        first.lock.unwrap().release();
    }

    #[test]
    fn takes_over_a_stale_lock_left_by_a_dead_process() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut holder = spawn_sleeper();
        let dead_pid = holder.child.id();
        holder.child.kill().unwrap();
        holder.child.wait().unwrap();
        assert!(!is_process_alive(dead_pid));
        std::fs::write(&path, format!(r#"{{"pid":{dead_pid},"startedAt":1}}"#)).unwrap();
        let result = acquire_single_instance_lock(path.to_str().unwrap(), None);
        let handle = result.lock.as_ref().unwrap();
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&handle.path).unwrap()).unwrap();
        assert_eq!(payload["pid"], std::process::id());
        handle.release();
    }

    #[test]
    fn treats_a_malformed_lockfile_as_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json").unwrap();
        let result = acquire_single_instance_lock(path.to_str().unwrap(), None);
        let handle = result.lock.as_ref().unwrap();
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&handle.path).unwrap()).unwrap();
        assert_eq!(payload["pid"], std::process::id());
        handle.release();
    }

    #[test]
    fn release_removes_the_lockfile_only_when_we_still_own_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let result = acquire_single_instance_lock(path.to_str().unwrap(), None);
        let handle = result.lock.unwrap();
        let peer_pid = std::process::id() + 1;
        std::fs::write(
            &handle.path,
            format!(r#"{{"pid":{peer_pid},"startedAt":1,"ownerId":"peer-owner"}}"#),
        )
        .unwrap();
        handle.release();
        assert!(Path::new(&handle.path).exists());
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&handle.path).unwrap()).unwrap();
        assert_eq!(payload["pid"], peer_pid);
    }

    #[test]
    fn keeps_a_legacy_lock_when_its_external_pid_is_alive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let sleeper = spawn_sleeper();
        let pid = sleeper.child.id();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(r#"{{"pid":{pid},"startedAt":{}}}"#, now_ms()),
        )
        .unwrap();
        let patterns = [ProcessCommandPattern::Contains(
            "collector-daemon-never-matches-node-child",
        )];
        let result = acquire_single_instance_lock(path.to_str().unwrap(), Some(&patterns));
        assert!(result.lock.is_none());
        assert_eq!(result.holder_pid, Some(pid as i64));
        assert_eq!(
            result.holder_process_start_state,
            Some(HolderProcessStartState::LockTokenMissing)
        );
        assert_eq!(
            result.holder_command_state,
            Some(HolderCommandState::Mismatched)
        );
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(payload["pid"], pid);
        drop(sleeper);
    }

    #[test]
    fn refuses_a_live_external_holder_when_its_start_token_matches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let sleeper = spawn_sleeper();
        let pid = sleeper.child.id();
        let token = read_process_start_token(pid);
        assert!(!token.is_empty());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = serde_json::json!({
            "pid": pid,
            "startedAt": now_ms(),
            "ownerId": "external-holder",
            "processStartToken": token,
        });
        std::fs::write(&path, serde_json::to_string(&body).unwrap()).unwrap();
        let patterns = [ProcessCommandPattern::Contains(
            "collector-daemon-never-matches-node-child",
        )];
        let result = acquire_single_instance_lock(path.to_str().unwrap(), Some(&patterns));
        assert!(result.lock.is_none());
        assert_eq!(result.holder_pid, Some(pid as i64));
        assert_eq!(
            result.holder_process_start_state,
            Some(HolderProcessStartState::Matched)
        );
        assert_eq!(
            result.holder_command_state,
            Some(HolderCommandState::Mismatched)
        );
    }

    #[test]
    fn a_windows_identity_format_upgrade_is_not_proof_of_pid_reuse() {
        let old = "win32-cim-v1:2026-10-28T09:00:00.1234560Z";
        let new = "win32-filetime-v1:134377380001234567";
        assert!(windows_start_token_format_changed(old, new));
        assert!(windows_start_token_format_changed(new, old));
        assert!(!windows_start_token_format_changed(
            new,
            "win32-filetime-v1:42"
        ));
        assert!(!windows_start_token_format_changed(old, old));
        assert!(!windows_start_token_format_changed(old, ""));
    }

    #[cfg(windows)]
    #[test]
    fn keeps_a_live_legacy_cim_holder_after_native_identity_upgrade() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("collector.lock");
        let holder = spawn_sleeper();
        let payload = serde_json::json!({
            "pid": holder.child.id(),
            "ownerId": "legacy-owner",
            "processStartToken": "win32-cim-v1:2026-10-28T09:00:00.1234560Z"
        })
        .to_string();
        std::fs::write(&path, &payload).unwrap();
        let result = acquire_single_instance_lock(path.to_str().unwrap(), None);
        assert!(result.lock.is_none());
        assert_eq!(
            result.holder_process_start_state,
            Some(HolderProcessStartState::CurrentTokenUnreadable)
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), payload);
    }

    #[test]
    fn takes_over_only_when_the_start_token_proves_pid_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let sleeper = spawn_sleeper();
        let pid = sleeper.child.id();
        let token = read_process_start_token(pid);
        assert!(!token.is_empty());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = serde_json::json!({
            "pid": pid,
            "startedAt": now_ms().saturating_sub(60_000),
            "ownerId": "crashed-holder",
            "processStartToken": format!("{token}:previous-lifetime"),
        });
        std::fs::write(&path, serde_json::to_string(&body).unwrap()).unwrap();
        let patterns = [ProcessCommandPattern::Contains(
            "collector-daemon-never-matches-node-child",
        )];
        let result = acquire_single_instance_lock(path.to_str().unwrap(), Some(&patterns));
        let handle = result.lock.as_ref().unwrap();
        assert_eq!(
            result.recovered_stale_lock,
            Some(StaleLockRecovery {
                previous_pid: Some(pid as i64),
                reason: StaleLockReason::PidReused
            })
        );
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&handle.path).unwrap()).unwrap();
        assert_eq!(payload["pid"], std::process::id());
        handle.release();
    }

    #[test]
    fn takes_over_a_stale_lock_from_an_older_instance_that_reused_our_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = serde_json::json!({
            "pid": std::process::id(),
            "startedAt": now_ms(),
            "ownerId": "older-process-instance",
        });
        std::fs::write(&path, serde_json::to_string(&body).unwrap()).unwrap();
        let self_cmd = read_process_command(std::process::id());
        let patterns = [ProcessCommandPattern::Contains(&self_cmd)];
        let result = acquire_single_instance_lock(path.to_str().unwrap(), Some(&patterns));
        let handle = result.lock.as_ref().unwrap();
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&handle.path).unwrap()).unwrap();
        assert_ne!(payload["ownerId"], "older-process-instance");
        handle.release();
    }

    #[test]
    fn with_patterns_still_refuses_when_the_live_pid_runs_a_matching_command() {
        let self_cmd = read_process_command(std::process::id());
        assert!(
            !self_cmd.is_empty(),
            "正向命令匹配回归必须读取到当前进程命令"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let patterns = [ProcessCommandPattern::Contains(self_cmd.as_str())];
        let first = acquire_single_instance_lock(path.to_str().unwrap(), Some(&patterns));
        assert!(first.lock.is_some());
        let second = acquire_single_instance_lock(path.to_str().unwrap(), Some(&patterns));
        assert!(second.lock.is_none());
        assert_eq!(second.holder_pid, Some(std::process::id() as i64));
        assert_eq!(
            second.holder_process_start_state,
            Some(HolderProcessStartState::SameProcessOwner)
        );
        assert_eq!(
            second.holder_command_state,
            Some(HolderCommandState::Matched)
        );
        first.lock.unwrap().release();
    }

    #[test]
    fn release_does_not_delete_a_successor_lock_owned_by_the_same_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let first = acquire_single_instance_lock(path.to_str().unwrap(), None);
        let handle = first.lock.unwrap();
        let successor = serde_json::json!({
            "pid": std::process::id(),
            "startedAt": now_ms(),
            "ownerId": "successor-owner",
        });
        std::fs::write(&handle.path, serde_json::to_string(&successor).unwrap()).unwrap();
        handle.release();
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&handle.path).unwrap()).unwrap();
        assert_eq!(payload, successor);
    }

    #[test]
    fn release_is_idempotent_and_deletes_our_own_lockfile() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("collector.lock");
        let result = acquire_single_instance_lock(path.to_str().unwrap(), None);
        let handle = result.lock.unwrap();
        let owned = handle.path.clone();
        handle.release();
        assert!(!Path::new(&owned).exists());
        handle.release();
    }
}

#[cfg(all(test, unix))]
#[path = "single_instance_lock_history_test_hooks.rs"]
pub(crate) mod history_test_hooks;
