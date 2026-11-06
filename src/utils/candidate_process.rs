//! 有界候选命令：子进程组/Job 随调用作用域结束；不用于需要存活的服务启动器。

use std::io;
use std::process::{Command, Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

#[cfg(unix)]
struct Tree {
    group: Option<libc::pid_t>,
}

#[cfg(unix)]
impl Tree {
    fn prepare(command: &mut Command) -> io::Result<Self> {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        Ok(Self { group: None })
    }

    fn attach(&mut self, pid: u32) -> io::Result<()> {
        let group = libc::pid_t::try_from(pid).map_err(io::Error::other)?;
        // 只允许本次新建的进程组；绝不能向调用者所在组发信号。
        if group <= 1 || group == unsafe { libc::getpgrp() } {
            return Err(io::Error::other("候选进程组无效"));
        }
        self.group = Some(group);
        Ok(())
    }

    fn ready_to_reap(&mut self, pid: u32) -> io::Result<bool> {
        if self.group.is_none() {
            return Ok(true);
        }
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // 先观察退出但保留组长 PID，再终止进程组；避免 wait 回收后 PGID 被复用。
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(error);
        }
        if info.si_signo == 0 {
            return Ok(false);
        }
        self.terminate()?;
        Ok(true)
    }

    fn terminate(&mut self) -> io::Result<()> {
        if let Some(group) = self.group.take() {
            // 进程组包含继承 stdout/stderr 的后代；不按进程名扫描或终止其他安装。
            if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
                let error = io::Error::last_os_error();
                self.group = Some(group);
                #[cfg(target_os = "macos")]
                if error.raw_os_error() == Some(libc::EPERM)
                    && group_has_only_exited_members(group)?
                {
                    self.group = None;
                    return Ok(());
                }
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
                self.group = None;
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn group_has_only_exited_members(group: libc::pid_t) -> io::Result<bool> {
    // XNU killpg 跳过僵尸：只有僵尸的组也会返回 EPERM。不能忽略真正的权限失败，
    // 必须在组长 PID 尚未回收时，确认该组不存在活进程；查询失败或容量不足均失败关闭。
    let mut members = [0 as libc::pid_t; 4096];
    let count = unsafe {
        // libproc 将底层错误折叠为 0，必须清理并读取 errno 区分空组与查询失败。
        *libc::__error() = 0;
        libc::proc_listpgrppids(
            group,
            members.as_mut_ptr().cast(),
            std::mem::size_of_val(&members) as i32,
        )
    };
    if count <= 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(0) | Some(libc::ESRCH) if count == 0 => Ok(true),
            _ => Err(error),
        };
    }
    if count as usize >= members.len() {
        return Err(io::Error::other("候选进程组查询不完整"));
    }
    for &pid in &members[..count as usize] {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let read = unsafe {
            *libc::__error() = 0;
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if read != size {
            let error = io::Error::last_os_error();
            if read == 0 && error.raw_os_error() == Some(libc::ESRCH) {
                continue;
            }
            return Err(io::Error::other(format!("候选进程状态查询不完整：{error}")));
        }
        if info.pbi_pgid == group as u32 && info.pbi_status != libc::SZOMB {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(windows)]
use windows_tree::Tree;

#[cfg(windows)]
mod windows_tree {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
    };

    pub(super) struct Tree {
        job: OwnedHandle,
        terminated: bool,
    }

    impl Tree {
        pub(super) fn prepare(command: &mut Command) -> io::Result<Self> {
            // 候选尚未执行任何指令时加入 Job，避免先 spawn 再绑定产生逃逸窗口。
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            // Isolated candidate commands never need a console. Creating one can
            // block PowerShell before its first instruction on unattended hosts.
            command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
            Ok(Self {
                job,
                terminated: false,
            })
        }

        pub(super) fn attach(&mut self, pid: u32, process: RawHandle) -> io::Result<()> {
            if unsafe { AssignProcessToJobObject(self.job.as_raw_handle(), process) } == 0 {
                // Job 嵌套或权限不允许时失败关闭，不降级为不受控子进程。
                return Err(io::Error::last_os_error());
            }
            let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            if raw == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut found = None;
            let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
            while more != 0 {
                if entry.th32OwnerProcessID == pid {
                    if found.replace(entry.th32ThreadID).is_some() {
                        return Err(io::Error::other("候选初始线程不唯一"));
                    }
                }
                entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(error);
            }
            let thread_id = found.ok_or_else(|| io::Error::other("候选初始线程缺失"))?;
            let raw = unsafe {
                OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                    0,
                    thread_id,
                )
            };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
                return Err(io::Error::other("候选线程归属已变化"));
            }
            if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
                return Err(io::Error::other("候选初始线程恢复失败"));
            }
            Ok(())
        }

        pub(super) fn terminate(&mut self) -> io::Result<()> {
            if !self.terminated {
                if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                self.terminated = true;
            }
            Ok(())
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

/// 同步工具的候选进程作用域；正常退出也回收留下的后代。
pub struct CandidateChild {
    child: std::process::Child,
    tree: Tree,
}

impl CandidateChild {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        let tree = Tree::prepare(command)?;
        let child = command.spawn()?;
        let mut scoped = Self { child, tree };
        #[cfg(unix)]
        scoped.tree.attach(scoped.child.id())?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            scoped
                .tree
                .attach(scoped.child.id(), scoped.child.as_raw_handle())?;
        }
        Ok(scoped)
    }

    pub fn take_stdin(&mut self) -> Option<std::process::ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child.stderr.take()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        #[cfg(unix)]
        if !self.tree.ready_to_reap(self.child.id())? {
            return Ok(None);
        }
        let result = self.child.try_wait()?;
        if result.is_some() {
            self.tree.terminate()?;
        }
        Ok(result)
    }
}

impl Drop for CandidateChild {
    fn drop(&mut self) {
        let _ = self.tree.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct AsyncCandidate {
    child: tokio::process::Child,
    tree: Tree,
}

impl Drop for AsyncCandidate {
    fn drop(&mut self) {
        // Future 被取消时不能 await；先终止后代，再由 Tokio 回收直属子进程。
        let _ = self.tree.terminate();
        let _ = self.child.start_kill();
    }
}

async fn limited(stream: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(io::Error::other("候选命令输出超限"));
    }
    Ok(bytes)
}

/// stdout/stderr 分别限流；超时、错误、取消及主进程退出都结束候选作用域。
pub async fn output(
    command: &mut tokio::process::Command,
    timeout: Duration,
    limit: usize,
) -> io::Result<Output> {
    if timeout.is_zero() || limit == 0 || limit == usize::MAX {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "候选执行边界无效",
        ));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let tree = Tree::prepare(command.as_std_mut())?;
    let child = command.spawn()?;
    let mut scoped = AsyncCandidate { child, tree };
    let pid = scoped
        .child
        .id()
        .ok_or_else(|| io::Error::other("候选进程缺少 PID"))?;
    #[cfg(unix)]
    scoped.tree.attach(pid)?;
    #[cfg(windows)]
    scoped.tree.attach(
        pid,
        scoped
            .child
            .raw_handle()
            .ok_or_else(|| io::Error::other("候选句柄缺失"))?,
    )?;
    let stdout = scoped
        .child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("候选缺少 stdout"))?;
    let stderr = scoped
        .child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("候选缺少 stderr"))?;
    let run = async {
        let wait = async {
            #[cfg(unix)]
            while !scoped.tree.ready_to_reap(pid)? {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let status = scoped.child.wait().await?;
            scoped.tree.terminate()?;
            Ok::<_, io::Error>(status)
        };
        let (status, stdout, stderr) =
            tokio::try_join!(wait, limited(stdout, limit), limited(stderr, limit))?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    };
    let result = tokio::time::timeout(timeout, run)
        .await
        .unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "候选命令超时")));
    scoped.tree.terminate()?;
    let _ = scoped.child.kill().await;
    let _ = scoped.child.wait().await;
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Instant;

    const FIXTURE: &str = "utils::candidate_process::tests::candidate_tree_fixture";

    pub(crate) fn fixture(root: &Path, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", FIXTURE, "--nocapture"])
            .env_clear()
            .env("PILOT_CANDIDATE_FIXTURE", root)
            .env("PILOT_CANDIDATE_MODE", mode)
            .env("HOME", root)
            .env("USERPROFILE", root)
            .current_dir(root)
            .stdin(Stdio::null());
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
    }

    #[test]
    fn candidate_tree_fixture() {
        let Some(root) = std::env::var_os("PILOT_CANDIDATE_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let mode = std::env::var("PILOT_CANDIDATE_MODE").unwrap();
        if mode == "leaf" {
            std::fs::write(root.join("leaf.pid"), std::process::id().to_string()).unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        // 只创建隔离测试二进制的后代；它故意继承管道，验证父进程先退出的情况。
        let mut leaf = fixture(root, "leaf").spawn().unwrap();
        let start = Instant::now();
        while !root.join("leaf.pid").is_file() {
            if start.elapsed() > Duration::from_secs(10) {
                let _ = leaf.kill();
                let _ = leaf.wait();
                panic!("测试后代未启动");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        match mode.as_str() {
            "success" => {
                println!("候选完成 🚀");
                std::process::exit(0);
            }
            "failure" => {
                eprintln!("候选失败");
                std::process::exit(23);
            }
            "stdout" | "stderr" => {
                use std::io::Write;
                let block = [b'x'; 8192];
                loop {
                    if mode == "stdout" {
                        std::io::stdout().write_all(&block).unwrap();
                    } else {
                        std::io::stderr().write_all(&block).unwrap();
                    }
                }
            }
            "wait" => {
                let _ = leaf.wait();
            }
            _ => panic!("未知测试模式"),
        }
    }

    pub(crate) async fn ready(root: &Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(root.join("leaf.pid")) {
                    if let Ok(pid) = text.parse::<u32>() {
                        return pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("测试后代未就绪")
    }

    pub(crate) async fn stopped(pid: u32) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let system = sysinfo::System::new_with_specifics(
                    sysinfo::RefreshKind::nothing()
                        .with_processes(sysinfo::ProcessRefreshKind::nothing()),
                );
                let running = system
                    .process(sysinfo::Pid::from_u32(pid))
                    .is_some_and(|process| {
                        !matches!(
                            process.status(),
                            sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
                        )
                    });
                if !running {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("候选后代仍在运行");
    }

    #[tokio::test]
    async fn success_and_failure_close_inherited_pipes_and_descendants() {
        for mode in ["success", "failure"] {
            let root = tempfile::tempdir().unwrap();
            let mut command = tokio::process::Command::from(fixture(root.path(), mode));
            let result = output(&mut command, Duration::from_secs(10), 64 * 1024)
                .await
                .unwrap();
            assert_eq!(
                result.status.code(),
                Some(if mode == "success" { 0 } else { 23 })
            );
            if mode == "success" {
                assert!(String::from_utf8_lossy(&result.stdout).contains("候选完成 🚀"));
            }
            stopped(ready(root.path()).await).await;
        }
    }

    #[tokio::test]
    async fn stream_limits_and_timeout_terminate_descendants() {
        for mode in ["stdout", "stderr", "wait"] {
            let root = tempfile::tempdir().unwrap();
            let mut command = tokio::process::Command::from(fixture(root.path(), mode));
            let task = tokio::spawn(async move {
                output(&mut command, Duration::from_secs(2), 64 * 1024).await
            });
            let pid = ready(root.path()).await;
            let error = task.await.unwrap().unwrap_err();
            if mode == "wait" {
                assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            } else {
                assert!(error.to_string().contains("输出超限"));
            }
            stopped(pid).await;
        }
    }

    #[tokio::test]
    async fn cancellation_terminates_only_the_owned_tree() {
        let unrelated = tempfile::tempdir().unwrap();
        let mut sentinel = CandidateChild::spawn(&mut fixture(unrelated.path(), "wait")).unwrap();
        let sentinel_pid = ready(unrelated.path()).await;
        #[cfg(target_os = "macos")]
        assert!(!group_has_only_exited_members(sentinel.child.id() as libc::pid_t).unwrap());
        let root = tempfile::tempdir().unwrap();
        let mut command = tokio::process::Command::from(fixture(root.path(), "wait"));
        let task =
            tokio::spawn(
                async move { output(&mut command, Duration::from_secs(30), 64 * 1024).await },
            );
        let pid = ready(root.path()).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        stopped(pid).await;
        assert!(sentinel.try_wait().unwrap().is_none());
        drop(sentinel);
        stopped(sentinel_pid).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_candidate_does_not_execute_before_job_assignment() {
        use std::os::windows::io::AsRawHandle;
        let root = tempfile::tempdir().unwrap();
        let mut command = fixture(root.path(), "success");
        let tree = Tree::prepare(&mut command).unwrap();
        let child = command.spawn().unwrap();
        let mut scope = CandidateChild { child, tree };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!root.path().join("leaf.pid").exists());
        scope
            .tree
            .attach(scope.child.id(), scope.child.as_raw_handle())
            .unwrap();
        let pid = ready(root.path()).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(status) = scope.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stopped(pid).await;
    }

    #[tokio::test]
    async fn synchronous_scope_reaps_descendants_after_parent_exit() {
        let root = tempfile::tempdir().unwrap();
        let mut child = CandidateChild::spawn(&mut fixture(root.path(), "success")).unwrap();
        let pid = ready(root.path()).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stopped(pid).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_powershell_candidate_reaches_its_first_instruction_without_a_console() {
        use std::os::windows::process::CommandExt;
        let shell = which::which("powershell.exe").expect("Windows PowerShell 5.1");
        let root = tempfile::tempdir().unwrap();
        let command = |label: &str| {
            let mut command = Command::new(&shell);
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "[IO.File]::WriteAllText($env:PILOT_STARTUP_DIAG,'entered;'); Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop; Write-Output 'PILOT_SHELL_STARTED'; [IO.File]::AppendAllText($env:PILOT_STARTUP_DIAG,'script-complete')",
                ])
                .env_clear()
                .env("PILOT_STARTUP_DIAG", root.path().join(format!("{label}.marker")))
                .env("HOME", root.path())
                .env("USERPROFILE", root.path())
                .env("APPDATA", root.path().join("appdata"))
                .env("LOCALAPPDATA", root.path().join("localappdata"))
                .env("PATH", root.path().join("no-runtimes"))
                // Provide the selected Shell's built-in modules explicitly.
                .env("PSModulePath",shell.parent().unwrap().join("Modules"))
                .current_dir(root.path())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
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
        };
        // Control: the same literal script, environment and no-console flag,
        // without suspension or a candidate Job. This script spawns no children.
        let mut baseline = tokio::process::Command::from(command("direct"));
        baseline.kill_on_drop(true);
        let mut baseline_child = baseline.spawn().unwrap();
        let stdout = baseline_child.stdout.take().unwrap();
        let stderr = baseline_child.stderr.take().unwrap();
        let control = tokio::time::timeout(Duration::from_secs(20), async {
            let (status, stdout, stderr) = tokio::try_join!(
                baseline_child.wait(),
                limited(stdout, 64 * 1024),
                limited(stderr, 64 * 1024)
            )?;
            Ok::<_, io::Error>(Output {
                status,
                stdout,
                stderr,
            })
        })
        .await
        .unwrap_or_else(|_| {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "direct PowerShell startup timed out",
            ))
        });
        let _ = baseline_child.kill().await;
        let _ = baseline_child.wait().await;
        // Always run both paths, so a failing control cannot hide the comparison.
        let mut scoped = tokio::process::Command::from(command("candidate"));
        let managed = output(&mut scoped, Duration::from_secs(20), 64 * 1024).await;
        let describe = |result: &io::Result<Output>| match result {
            Ok(output) => format!(
                "exit={:?} stdout={:?} stderr={:?}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
            Err(error) => format!("error={:?}: {error}", error.kind()),
        };
        eprintln!(
            "Windows startup control: {}; candidate: {}",
            describe(&control),
            describe(&managed)
        );
        for label in ["direct", "candidate"] {
            let marker = std::fs::read_to_string(root.path().join(format!("{label}.marker")))
                .unwrap_or_else(|_| "absent".into());
            eprintln!("Windows startup {label} stage: {marker}");
        }
        for (label, result) in [("direct", control), ("candidate", managed)] {
            let result = result.unwrap_or_else(|error| panic!("{label}: {error}"));
            assert!(
                result.status.success(),
                "{label}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert_eq!(
                String::from_utf8(result.stdout).unwrap().trim(),
                "PILOT_SHELL_STARTED",
                "{label}"
            );
            assert!(
                result.stderr.is_empty(),
                "{label}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}
