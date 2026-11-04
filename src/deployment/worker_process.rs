//! worker 的原生进程身份与定向终止；不调用 PATH 中的 kill、ps 或 PowerShell。

use serde::{Deserialize, Serialize};
use std::io;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProcessIdentity {
    pub pid: u32,
    pub creation_time: String,
    pub executable_path: String,
}

impl ProcessIdentity {
    pub fn matches(&self, actual: &Self) -> bool {
        let same_time = self.creation_time == actual.creation_time
            || chrono::DateTime::parse_from_rfc3339(&self.creation_time)
                .ok()
                .zip(chrono::DateTime::parse_from_rfc3339(&actual.creation_time).ok())
                .is_some_and(|(a, b)| a == b);
        self.pid == actual.pid
            && same_time
            && !self.creation_time.is_empty()
            && (self.executable_path.is_empty()
                || if cfg!(windows) {
                    self.executable_path
                        .replace('/', "\\")
                        .eq_ignore_ascii_case(&actual.executable_path.replace('/', "\\"))
                } else {
                    self.executable_path == actual.executable_path
                })
    }
}

pub(super) trait ProcessOperations: Send + Sync {
    fn identity(&self, pid: u32) -> io::Result<Option<ProcessIdentity>>;
    fn descendants(&self, root: &ProcessIdentity) -> io::Result<Vec<ProcessIdentity>>;
    fn signal(&self, expected: &ProcessIdentity, force: bool) -> io::Result<()>;
}

pub(super) struct NativeProcesses;

impl ProcessOperations for NativeProcesses {
    fn identity(&self, pid: u32) -> io::Result<Option<ProcessIdentity>> {
        native_identity(pid)
    }

    fn descendants(&self, root: &ProcessIdentity) -> io::Result<Vec<ProcessIdentity>> {
        if root.pid <= 1 || root.pid == std::process::id() {
            return Err(io::Error::other("拒绝枚举保留 PID 或当前进程的终止目标"));
        }
        let system = sysinfo::System::new_with_specifics(
            sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
        );
        if system
            .process(sysinfo::Pid::from_u32(std::process::id()))
            .is_none()
        {
            return Err(io::Error::other("无法验证进程快照"));
        }
        let mut pending = vec![root.clone()];
        let mut seen = std::collections::HashSet::from([root.pid]);
        let mut result = Vec::new();
        while let Some(parent_identity) = pending.pop() {
            let parent = parent_identity.pid;
            if native_identity(parent)?.is_some_and(|actual| !parent_identity.matches(&actual)) {
                return Err(io::Error::other("父进程身份发生变化"));
            }
            let Some(parent_info) = system.process(sysinfo::Pid::from_u32(parent)) else {
                continue;
            };
            for (pid, process) in system.processes() {
                if process.parent().map(|p| p.as_u32()) != Some(parent)
                    || process.start_time() < parent_info.start_time()
                    || !seen.insert(pid.as_u32())
                {
                    continue;
                }
                if let Some(identity) = lineage_identity(pid.as_u32(), &parent_identity)? {
                    pending.push(identity.clone());
                    result.push(identity);
                }
            }
        }
        // 快照期间根 PID 被复用时，整个结果作废，不能把新进程的后代当作 worker。
        if native_identity(root.pid)?.is_some_and(|actual| !root.matches(&actual)) {
            return Err(io::Error::other("枚举期间 worker 身份发生变化"));
        }
        Ok(result)
    }

    fn signal(&self, expected: &ProcessIdentity, force: bool) -> io::Result<()> {
        if expected.pid <= 1 || expected.pid == std::process::id() {
            return Err(io::Error::other("拒绝终止保留 PID 或当前进程"));
        }
        native_signal(expected, force)
    }
}

fn lineage_identity(pid: u32, parent: &ProcessIdentity) -> io::Result<Option<ProcessIdentity>> {
    let Some(before) = native_identity(pid)? else {
        return Ok(None);
    };
    // A stale PPID can refer to a prior generation of this numeric root PID.
    // The coarse sysinfo start_time filter cannot distinguish an older child
    // within the same second. Native Windows identity retains 100ns time.
    #[cfg(windows)]
    if !windows_child_not_older_than_parent(&before, parent)? {
        return Ok(None);
    }
    let key = sysinfo::Pid::from_u32(pid);
    let mut fresh = sysinfo::System::new();
    fresh.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[key]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    if fresh
        .process(key)
        .and_then(|p| p.parent())
        .map(|p| p.as_u32())
        != Some(parent.pid)
    {
        return Ok(None);
    }
    let Some(after) = native_identity(pid)? else {
        return Ok(None);
    };
    if !before.matches(&after) {
        return Err(io::Error::other("后代查询期间 PID 已复用"));
    }
    Ok(Some(after))
}

#[cfg(any(windows, test))]
fn windows_child_not_older_than_parent(
    child: &ProcessIdentity,
    parent: &ProcessIdentity,
) -> io::Result<bool> {
    let parent_created = chrono::DateTime::parse_from_rfc3339(&parent.creation_time)
        .map_err(|_| io::Error::other("父进程高精度创建时间无效"))?;
    let child_created = chrono::DateTime::parse_from_rfc3339(&child.creation_time)
        .map_err(|_| io::Error::other("子进程高精度创建时间无效"))?;
    Ok(child_created >= parent_created)
}

pub(super) fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // EPERM 是存活而非消失；健康查询不需要读取可执行文件或身份文件。
        if pid > i32::MAX as u32 {
            return false;
        }
        (unsafe { libc::kill(pid as libc::pid_t, 0) == 0 })
            || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        windows::open(pid, false)
            .map(|process| process.is_some())
            .unwrap_or(true)
    }
}

#[cfg(unix)]
fn missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(3)
}

#[cfg(target_os = "linux")]
fn native_identity(pid: u32) -> io::Result<Option<ProcessIdentity>> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Ok(None);
    }
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let end = stat
        .rfind(')')
        .ok_or_else(|| io::Error::other("进程 stat 缺少名称边界"))?;
    let fields: Vec<_> = stat[end + 1..].split_whitespace().collect();
    if matches!(fields.first(), Some(&"Z" | &"X")) {
        return Ok(None);
    }
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let token = crate::utils::pid_utils::linux_proc_start_token(&stat, &boot);
    if token.is_empty() {
        return Err(io::Error::other("进程启动标识缺失"));
    }
    let exe = match std::fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(exe) => exe,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let after = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    if crate::utils::pid_utils::linux_proc_start_token(&after, &boot) != token {
        return Err(io::Error::other("查询期间 PID 身份发生变化"));
    }
    Ok(Some(ProcessIdentity {
        pid,
        creation_time: token,
        executable_path: exe.to_string_lossy().into_owned(),
    }))
}

#[cfg(target_os = "macos")]
fn native_identity(pid: u32) -> io::Result<Option<ProcessIdentity>> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Ok(None);
    }
    fn info(pid: u32) -> io::Result<Option<libc::proc_bsdinfo>> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if read != size {
            let error = io::Error::last_os_error();
            if missing(&error) {
                return Ok(None);
            }
            return Err(io::Error::other(format!("进程身份查询不完整: {error}")));
        }
        if info.pbi_status == libc::SZOMB {
            return Ok(None);
        }
        Ok(Some(info))
    }
    let Some(before) = info(pid)? else {
        return Ok(None);
    };
    let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length =
        unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    if length <= 0 {
        return Err(io::Error::last_os_error());
    }
    let Some(after) = info(pid)? else {
        return Ok(None);
    };
    if (before.pbi_start_tvsec, before.pbi_start_tvusec)
        != (after.pbi_start_tvsec, after.pbi_start_tvusec)
    {
        return Err(io::Error::other("查询期间 PID 身份发生变化"));
    }
    let end = path.iter().position(|b| *b == 0).unwrap_or(length as usize);
    Ok(Some(ProcessIdentity {
        pid,
        creation_time: format!(
            "darwin-native-v1:{}:{}",
            before.pbi_start_tvsec, before.pbi_start_tvusec
        ),
        executable_path: String::from_utf8_lossy(&path[..end]).into_owned(),
    }))
}

#[cfg(windows)]
fn native_identity(pid: u32) -> io::Result<Option<ProcessIdentity>> {
    windows::open(pid, false)?
        .map(|process| windows::identity(pid, &process))
        .transpose()
}

#[cfg(unix)]
fn native_signal(expected: &ProcessIdentity, force: bool) -> io::Result<()> {
    if expected.pid > i32::MAX as u32 {
        return Err(io::Error::other("PID 超出平台范围"));
    }
    #[cfg(target_os = "linux")]
    let descriptor = {
        use std::os::fd::{FromRawFd, OwnedFd};
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, expected.pid, 0) };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if missing(&error) {
                return Ok(());
            }
            if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
                return Err(error);
            }
            None
        } else {
            Some(unsafe { OwnedFd::from_raw_fd(fd as i32) })
        }
    };
    let Some(actual) = native_identity(expected.pid)? else {
        return Ok(());
    };
    if !expected.matches(&actual) {
        return Ok(());
    }
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    #[cfg(target_os = "linux")]
    if let Some(fd) = descriptor {
        use std::os::fd::AsRawFd;
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        } == 0
        {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        return if missing(&error) { Ok(()) } else { Err(error) };
    }
    // 无 pidfd 的内核和 macOS 在信号前重新核对高精度启动标识，绝不按负 PID 广播。
    if unsafe { libc::kill(expected.pid as libc::pid_t, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if missing(&error) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(windows)]
fn native_signal(expected: &ProcessIdentity, force: bool) -> io::Result<()> {
    // 通用控制台 worker 没有可靠的优雅退出 API；只在有界等待后的强制阶段终止。
    if !force {
        return Ok(());
    }
    let Some(process) = windows::open(expected.pid, true)? else {
        return Ok(());
    };
    let actual = windows::identity(expected.pid, &process)?;
    if !expected.matches(&actual) {
        return Ok(());
    }
    use std::os::windows::io::AsRawHandle;
    if unsafe {
        windows_sys::Win32::System::Threading::TerminateProcess(process.as_raw_handle(), 1)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    pub(super) fn open(pid: u32, terminate: bool) -> io::Result<Option<OwnedHandle>> {
        if pid == 0 {
            return Ok(None);
        }
        let access = PROCESS_QUERY_LIMITED_INFORMATION
            | PROCESS_SYNCHRONIZE
            | if terminate { PROCESS_TERMINATE } else { 0 };
        let raw = unsafe { OpenProcess(access, 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Ok(None),
            WAIT_TIMEOUT => Ok(Some(handle)),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(super) fn identity(pid: u32, process: &OwnedHandle) -> io::Result<ProcessIdentity> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe {
            GetProcessTimes(
                process.as_raw_handle(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        let seconds = i64::try_from(ticks / 10_000_000).map_err(io::Error::other)? - 11_644_473_600;
        let date = chrono::DateTime::from_timestamp(seconds, ((ticks % 10_000_000) * 100) as u32)
            .ok_or_else(|| io::Error::other("进程创建时间无效"))?;
        let mut path = vec![0_u16; 32768];
        let mut length = path.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(process.as_raw_handle(), 0, path.as_mut_ptr(), &mut length)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(ProcessIdentity {
            pid,
            creation_time: date.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
            executable_path: String::from_utf16_lossy(&path[..length as usize]),
        })
    }
}

#[cfg(test)]
#[path = "worker_process_birth_order_tests.rs"]
mod birth_order_tests;
