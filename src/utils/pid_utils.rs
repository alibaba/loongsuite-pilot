//! Port of `src/utils/pid-utils.ts`.

use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessLivenessSource {
    PidFile,
    ProcessScan,
    None,
}

impl ProcessLivenessSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PidFile => "pid-file",
            Self::ProcessScan => "process-scan",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PidFileState {
    Missing,
    Invalid,
    Stale,
    Matched,
}

impl PidFileState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Invalid => "invalid",
            Self::Stale => "stale",
            Self::Matched => "matched",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ProcessCommandPattern<'a> {
    Contains(&'a str),
    Regex(&'a str),
}

pub const COLLECTOR_PROCESS_PATTERNS: &[ProcessCommandPattern<'static>] = &[
    ProcessCommandPattern::Contains("collector-daemon.js"),
    ProcessCommandPattern::Contains("/bin/collector-daemon"),
    ProcessCommandPattern::Contains("\\bin\\collector-daemon"),
    ProcessCommandPattern::Regex(
        r#"(?:^|[\s/\\])loongsuite-pilot(?:\.(?:ps1|exe))?["']?\s+(?:run|run-service)(?:\s|$)"#,
    ),
    ProcessCommandPattern::Regex(r#"(?:^|[\s/\\])loongsuite-pilot(?:\.exe)?["']?\s*$"#),
];

pub const UPDATER_PROCESS_PATTERNS: &[ProcessCommandPattern<'static>] = &[
    ProcessCommandPattern::Contains("updater-daemon.js"),
    ProcessCommandPattern::Contains("/bin/updater-daemon"),
    ProcessCommandPattern::Contains("\\bin\\updater-daemon"),
    ProcessCommandPattern::Regex(
        r#"(?:^|[\s/\\])loongsuite-pilot(?:\.(?:ps1|exe))?["']?\s+run-updater(?:\s|$)"#,
    ),
    ProcessCommandPattern::Contains("dist/updater/index.js"),
];

pub const INTERCEPTOR_PROCESS_PATTERNS: &[ProcessCommandPattern<'static>] = &[
    ProcessCommandPattern::Contains("interceptor-daemon.js"),
    ProcessCommandPattern::Contains("/bin/interceptor-daemon"),
    ProcessCommandPattern::Contains("\\bin\\interceptor-daemon"),
    ProcessCommandPattern::Regex(
        r#"(?:^|[\s/\\])loongsuite-pilot(?:\.(?:ps1|exe))?["']?\s+run-interceptor(?:\s|$)"#,
    ),
    ProcessCommandPattern::Contains("dist/interceptor/daemon"),
];

pub const WINDOWS_PROCESS_SCAN_PROGRAM: &str = "powershell.exe";
pub const WINDOWS_PROCESS_SCAN_TIMEOUT_MS: u64 = 8_000;
pub const WINDOWS_PROCESS_SCAN_ENCODING: &str = "utf-8";
pub const WINDOWS_PROCESS_SCAN_WINDOWS_HIDE: bool = true;
pub const WINDOWS_PROCESS_SCAN_COMMAND: &str =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
pub const WINDOWS_PROCESS_SCAN_ARGS: &[&str] = &[
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-Command",
    WINDOWS_PROCESS_SCAN_COMMAND,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessLiveness {
    pub running: bool,
    pub pid: Option<u32>,
    pub source: ProcessLivenessSource,
    pub reason: String,
    pub pid_file_state: Option<PidFileState>,
    pub pid_file_process_alive: Option<bool>,
    pub pid_file_command: Option<String>,
    pub pid_file_command_matched: Option<bool>,
}

impl ProcessLiveness {
    fn scan_hit(pid: u32) -> Self {
        Self {
            running: true,
            pid: Some(pid),
            source: ProcessLivenessSource::ProcessScan,
            reason: "matching process command found".to_string(),
            pid_file_state: None,
            pid_file_process_alive: None,
            pid_file_command: None,
            pid_file_command_matched: None,
        }
    }

    fn scan_miss() -> Self {
        Self {
            running: false,
            pid: None,
            source: ProcessLivenessSource::None,
            reason: "no matching process found".to_string(),
            pid_file_state: None,
            pid_file_process_alive: None,
            pid_file_command: None,
            pid_file_command_matched: None,
        }
    }
}

pub fn is_pid_file_running(pid_file: &str) -> bool {
    match read_pid_file(pid_file) {
        Some(pid) => is_process_alive(pid),
        None => false,
    }
}

pub fn read_pid_file(pid_file: &str) -> Option<u32> {
    let raw = std::fs::read_to_string(pid_file).ok()?;
    parse_pid_text(&raw)
}

pub fn write_pid_file_sync(pid_file: &str) {
    if let Some(parent) = Path::new(pid_file).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(pid_file, format!("{}\n", std::process::id()));
}

pub fn remove_own_pid_file_sync(pid_file: &str) {
    if read_pid_file(pid_file) == Some(std::process::id()) {
        let _ = std::fs::remove_file(pid_file);
    }
}

pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(any(unix, windows))]
    {
        process_alive_from_kill(process_zero_probe(pid))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let key = sysinfo::Pid::from_u32(pid);
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[key]),
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        system.process(key).is_some()
    }
}

#[cfg(unix)]
fn process_zero_probe(pid: u32) -> Result<(), i32> {
    // Never cast an oversized PID into a negative process-group selector.
    let pid = libc::pid_t::try_from(pid).map_err(|_| libc::ESRCH)?;
    if unsafe { libc::kill(pid, 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::ESRCH))
    }
}

#[cfg(windows)]
fn process_zero_probe(pid: u32) -> Result<(), i32> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    // Normalize Windows access refusal to the same EPERM contract as kill(0).
    // Waiting on the process handle distinguishes termination even while a
    // parent still owns a handle to the exited process (or it exits with 259).
    let refused = || {
        if io::Error::last_os_error().kind() == io::ErrorKind::PermissionDenied {
            1
        } else {
            3
        }
    };
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if raw.is_null() {
        return Err(refused());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
        WAIT_TIMEOUT => Ok(()),
        WAIT_FAILED => Err(refused()),
        _ => Err(3),
    }
}

/// Zero-signal probe result (normalized on Windows). `Ok` means alive; `Err(1)` is EPERM
/// and still means the process is alive. Any other errno means it is not.
pub fn process_alive_from_kill(result: Result<(), i32>) -> bool {
    match result {
        Ok(()) => true,
        Err(1) => true,
        Err(_) => false,
    }
}

pub fn is_command_match(command: &str, patterns: &[ProcessCommandPattern<'_>]) -> bool {
    // The same installed binary also hosts extension workers. Plugin paths
    // may contain legacy daemon names, which must never establish service identity.
    static EXTENSION_WORKER: OnceLock<regex::Regex> = OnceLock::new();
    let worker = EXTENSION_WORKER.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)(?:^|[\s/\\'"])loongsuite-pilot(?:\.exe)?["']?\s+internal-span-enricher(?:\s|$)"#,
        ).expect("fixed native worker command pattern")
    });
    if worker.is_match(command) {
        return false;
    }
    patterns.iter().any(|pattern| match pattern {
        ProcessCommandPattern::Contains(needle) => command.contains(needle),
        ProcessCommandPattern::Regex(source) => regex::Regex::new(source)
            .map(|re| re.is_match(command))
            .unwrap_or(false),
    })
}

pub fn find_process_by_command(patterns: &[ProcessCommandPattern<'_>]) -> ProcessLiveness {
    let output = if cfg!(windows) {
        run_command(
            WINDOWS_PROCESS_SCAN_PROGRAM,
            WINDOWS_PROCESS_SCAN_ARGS,
            Duration::from_millis(WINDOWS_PROCESS_SCAN_TIMEOUT_MS),
        )
    } else {
        run_command(
            "ps",
            &["-axo", "pid=,command="],
            Duration::from_millis(5_000),
        )
    };
    match output {
        Ok(text) if cfg!(windows) => {
            match_windows_process_scan(&text, patterns, std::process::id())
        }
        Ok(text) => match_unix_process_scan(&text, patterns, std::process::id()),
        Err(_) => ProcessLiveness::scan_miss(),
    }
}

pub fn match_unix_process_scan(
    output: &str,
    patterns: &[ProcessCommandPattern<'_>],
    self_pid: u32,
) -> ProcessLiveness {
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some((pid, command)) = parse_unix_ps_line(line) else {
            continue;
        };
        if pid == self_pid || pid == 0 {
            continue;
        }
        if is_command_match(&command, patterns) {
            return ProcessLiveness::scan_hit(pid);
        }
    }
    ProcessLiveness::scan_miss()
}

pub fn match_windows_process_scan(
    output: &str,
    patterns: &[ProcessCommandPattern<'_>],
    self_pid: u32,
) -> ProcessLiveness {
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some((pid, command)) = parse_windows_scan_line(line) else {
            continue;
        };
        if pid == self_pid || pid == 0 {
            continue;
        }
        if is_command_match(&command, patterns) {
            return ProcessLiveness::scan_hit(pid);
        }
    }
    ProcessLiveness::scan_miss()
}

pub fn check_process_liveness(
    pid_file: &str,
    patterns: &[ProcessCommandPattern<'_>],
) -> ProcessLiveness {
    check_process_liveness_with(pid_file, patterns, &RealIo)
}

fn check_process_liveness_with(
    pid_file: &str,
    patterns: &[ProcessCommandPattern<'_>],
    io: &dyn LivenessIo,
) -> ProcessLiveness {
    let pid = match io.read_to_string(pid_file) {
        Ok(raw) => parse_pid_text(&raw),
        Err(_) => None,
    };
    let pid_file_state_when_missing = if io.exists(pid_file) {
        PidFileState::Invalid
    } else {
        PidFileState::Missing
    };
    let mut pid_file_process_alive = false;
    let mut pid_file_command = String::new();
    let mut pid_file_command_matched = None;

    if let Some(pid) = pid {
        pid_file_process_alive = io.alive(pid);
        if pid_file_process_alive {
            pid_file_command = io.command(pid);
            pid_file_command_matched = if pid_file_command.is_empty() {
                None
            } else {
                Some(is_command_match(&pid_file_command, patterns))
            };
            if pid_file_command_matched == Some(true) {
                return ProcessLiveness {
                    running: true,
                    pid: Some(pid),
                    source: ProcessLivenessSource::PidFile,
                    reason: "process is running with matching command".to_string(),
                    pid_file_state: Some(PidFileState::Matched),
                    pid_file_process_alive: Some(pid_file_process_alive),
                    pid_file_command: Some(pid_file_command),
                    pid_file_command_matched,
                };
            }
        }
    }

    let discovered = match io.scan() {
        Ok(text) if io.windows() => match_windows_process_scan(&text, patterns, io.self_pid()),
        Ok(text) => match_unix_process_scan(&text, patterns, io.self_pid()),
        Err(_) => ProcessLiveness::scan_miss(),
    };
    if discovered.running {
        let reason = if pid.is_none() {
            format!(
                "{}; pid file is {}",
                discovered.reason,
                pid_file_state_when_missing.as_str()
            )
        } else {
            format!(
                "{}; pid file points to stale or mismatched pid {}",
                discovered.reason,
                pid.unwrap_or(0)
            )
        };
        return ProcessLiveness {
            reason,
            pid_file_state: Some(if pid.is_none() {
                pid_file_state_when_missing
            } else {
                PidFileState::Stale
            }),
            pid_file_process_alive: Some(pid_file_process_alive),
            pid_file_command: Some(pid_file_command),
            pid_file_command_matched,
            ..discovered
        };
    }

    ProcessLiveness {
        running: false,
        pid,
        source: ProcessLivenessSource::None,
        reason: if pid.is_none() {
            format!(
                "pid file is {}; no matching process found",
                pid_file_state_when_missing.as_str()
            )
        } else {
            format!(
                "pid file points to stale or mismatched pid {}; no matching process found",
                pid.unwrap_or(0)
            )
        },
        pid_file_state: Some(if pid.is_none() {
            pid_file_state_when_missing
        } else {
            PidFileState::Stale
        }),
        pid_file_process_alive: Some(pid_file_process_alive),
        pid_file_command: Some(pid_file_command),
        pid_file_command_matched,
    }
}

pub fn read_process_command(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    if cfg!(windows) {
        let pid = sysinfo::Pid::from_u32(pid);
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            true,
            sysinfo::ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
        );
        return system
            .process(pid)
            .map(|process| {
                process
                    .cmd()
                    .iter()
                    .map(|arg| arg.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
    }
    let pid = pid.to_string();
    run_command(
        "ps",
        &["-p", &pid, "-o", "command="],
        Duration::from_millis(5_000),
    )
    .map(|text| text.trim().to_string())
    .unwrap_or_default()
}

pub fn read_process_start_token(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap_or_default();
        linux_proc_start_token(&stat, &boot)
    }
    #[cfg(windows)]
    {
        windows_process_start_token(pid).unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let pid_text = pid.to_string();
        match run_command(
            "ps",
            &["-p", &pid_text, "-o", "lstart="],
            Duration::from_millis(5_000),
        ) {
            Ok(text) => ps_lstart_token(node_platform(), &text),
            Err(_) => String::new(),
        }
    }
}

#[cfg(windows)]
fn windows_process_start_token(pid: u32) -> io::Result<String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // No PowerShell/WMI startup: creation FILETIME identifies the process even
    // when the PID is reused. OwnedHandle closes it on every success/error path.
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if ticks == 0 {
        return Err(io::Error::other("process creation time is unavailable"));
    }
    Ok(format!("win32-filetime-v1:{ticks}"))
}

#[cfg(any(test, target_os = "linux"))]
pub(crate) fn linux_proc_start_token(stat: &str, boot_id: &str) -> String {
    let Some(comm_end) = stat.rfind(')') else {
        return String::new();
    };
    let fields: Vec<&str> = stat[comm_end + 1..].split_whitespace().collect();
    let start_ticks = fields.get(19).copied().unwrap_or("");
    let boot_id = boot_id.trim();
    if start_ticks.is_empty() || boot_id.is_empty() {
        String::new()
    } else {
        format!("linux-proc-v1:{boot_id}:{start_ticks}")
    }
}

#[cfg(any(test, not(any(target_os = "linux", windows))))]
pub(crate) fn ps_lstart_token(platform: &str, stdout: &str) -> String {
    let started = stdout.split_whitespace().collect::<Vec<_>>().join(" ");
    if started.is_empty() {
        String::new()
    } else {
        format!("{platform}-ps-lstart-v1:{started}")
    }
}

#[cfg(any(test, not(any(target_os = "linux", windows))))]
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        other => other,
    }
}

fn parse_pid_text(raw: &str) -> Option<u32> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let value: u64 = trimmed.parse().ok()?;
    if value == 0 || value > u32::MAX as u64 {
        None
    } else {
        Some(value as u32)
    }
}

fn parse_unix_ps_line(line: &str) -> Option<(u32, String)> {
    let caps = unix_line_re().captures(line)?;
    let pid: u32 = caps.get(1)?.as_str().parse().ok()?;
    let command = caps.get(2)?.as_str().to_string();
    if pid == 0 {
        None
    } else {
        Some((pid, command))
    }
}

fn parse_windows_scan_line(line: &str) -> Option<(u32, String)> {
    if line.is_empty() {
        return None;
    }
    let mut parts = line.splitn(2, '\t');
    let pid_raw = parts.next()?.trim();
    let command = parts.next().unwrap_or("").to_string();
    let pid = parse_pid_text(pid_raw)?;
    Some((pid, command))
}

fn unix_line_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^\s*(\d+)\s+(.+)$").expect("ps line pattern"))
}

fn run_command(program: &str, args: &[&str], timeout: Duration) -> io::Result<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        if WINDOWS_PROCESS_SCAN_WINDOWS_HIDE {
            // PowerShell 的 Hidden 参数只隐藏窗口，创建标志才能避免分配控制台。
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing stdout"))?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = reader.join().unwrap_or_default();
                if status.success() {
                    return Ok(output);
                }
                return Err(io::Error::other(format!(
                    "exit {}",
                    status.code().unwrap_or(-1)
                )));
            }
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(io::Error::other("timeout"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(err) => return Err(err),
        }
    }
}

trait LivenessIo {
    fn read_to_string(&self, path: &str) -> io::Result<String>;
    fn exists(&self, path: &str) -> bool;
    fn alive(&self, pid: u32) -> bool;
    fn command(&self, pid: u32) -> String;
    fn scan(&self) -> io::Result<String>;
    fn self_pid(&self) -> u32;
    fn windows(&self) -> bool;
}

struct RealIo;

impl LivenessIo for RealIo {
    fn read_to_string(&self, path: &str) -> io::Result<String> {
        std::fs::read_to_string(path)
    }
    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }
    fn alive(&self, pid: u32) -> bool {
        is_process_alive(pid)
    }
    fn command(&self, pid: u32) -> String {
        read_process_command(pid)
    }
    fn scan(&self) -> io::Result<String> {
        if cfg!(windows) {
            run_command(
                WINDOWS_PROCESS_SCAN_PROGRAM,
                WINDOWS_PROCESS_SCAN_ARGS,
                Duration::from_millis(WINDOWS_PROCESS_SCAN_TIMEOUT_MS),
            )
        } else {
            run_command(
                "ps",
                &["-axo", "pid=,command="],
                Duration::from_millis(5_000),
            )
        }
    }
    fn self_pid(&self) -> u32 {
        std::process::id()
    }
    fn windows(&self) -> bool {
        cfg!(windows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::io;

    struct FakeIo {
        reads: RefCell<VecDeque<io::Result<String>>>,
        exists: RefCell<VecDeque<bool>>,
        alives: RefCell<VecDeque<bool>>,
        execs: RefCell<VecDeque<io::Result<String>>>,
        self_pid: u32,
        windows: bool,
    }

    impl FakeIo {
        fn new() -> Self {
            Self {
                reads: RefCell::new(VecDeque::new()),
                exists: RefCell::new(VecDeque::new()),
                alives: RefCell::new(VecDeque::new()),
                execs: RefCell::new(VecDeque::new()),
                self_pid: std::process::id(),
                windows: false,
            }
        }

        fn scanned_pid(&self) -> u32 {
            self.self_pid
                .max(123)
                .checked_add(1)
                .expect("fixture PID must differ from this process and the pid-file fixture")
        }
    }

    impl LivenessIo for FakeIo {
        fn read_to_string(&self, _path: &str) -> io::Result<String> {
            self.reads
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Err(io::Error::from(io::ErrorKind::NotFound)))
        }
        fn exists(&self, _path: &str) -> bool {
            self.exists.borrow_mut().pop_front().unwrap_or(false)
        }
        fn alive(&self, _pid: u32) -> bool {
            self.alives.borrow_mut().pop_front().unwrap_or(false)
        }
        fn command(&self, _pid: u32) -> String {
            match self.execs.borrow_mut().pop_front() {
                Some(Ok(text)) => text.trim().to_string(),
                _ => String::new(),
            }
        }
        fn scan(&self) -> io::Result<String> {
            self.execs
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Err(io::Error::other("no scan")))
        }
        fn self_pid(&self) -> u32 {
            self.self_pid
        }
        fn windows(&self) -> bool {
            self.windows
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_probe_does_not_allocate_a_console() {
        let executable = std::env::current_exe().unwrap();
        let output = run_command(
            executable.to_str().unwrap(),
            &[
                "--exact",
                "utils::pid_utils::tests::windows_console_fixture",
                "--nocapture",
            ],
            Duration::from_secs(15),
        )
        .unwrap();
        assert!(
            output
                .lines()
                .any(|line| line.trim() == "PILOT_CONSOLE_WINDOW=0"),
            "进程探针分配了控制台窗口：{output}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_console_fixture() {
        // 直接查询子进程控制台，避免为这个断言启动 PowerShell 和 C# 编译器。
        let window = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
        println!("\nPILOT_CONSOLE_WINDOW={}", window as usize);
    }

    #[test]
    fn command_runner_preserves_output_and_reports_failures() {
        let (program, success, failure): (&str, &[&str], &[&str]) = if cfg!(windows) {
            (
                "cmd.exe",
                &["/d", "/c", "echo probe-ok"],
                &["/d", "/c", "exit 7"],
            )
        } else {
            ("sh", &["-c", "printf 'probe-ok\\n'"], &["-c", "exit 7"])
        };
        assert_eq!(
            run_command(program, success, Duration::from_secs(5))
                .unwrap()
                .trim(),
            "probe-ok"
        );
        assert_eq!(
            run_command(program, failure, Duration::from_secs(5))
                .unwrap_err()
                .to_string(),
            "exit 7"
        );
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing-probe");
        assert!(run_command(missing.to_str().unwrap(), &[], Duration::from_secs(5)).is_err());
    }

    #[test]
    fn matches_strict_collector_and_updater_command_identities() {
        assert!(is_command_match(
            "/usr/bin/node /home/a/.loongsuite-pilot/bin/collector-daemon.js",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(is_command_match(
            "/home/a/.local/bin/loongsuite-pilot run-service",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(is_command_match(
            "/home/a/.loongsuite-pilot/versions/1.2.0_abc/bin/loongsuite-pilot",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(!is_command_match(
            "/home/a/.local/bin/loongsuite-pilot status",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(!is_command_match(
            "/home/a/.local/bin/loongsuite-pilot run-service-helper",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(is_command_match(
            "/usr/bin/node /home/a/.loongsuite-pilot/bin/updater-daemon.js",
            UPDATER_PROCESS_PATTERNS
        ));
        assert!(!is_command_match(
            "/usr/bin/node unrelated.js",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(!is_command_match(
            "/usr/bin/node unrelated.js",
            UPDATER_PROCESS_PATTERNS
        ));
    }

    #[test]
    fn native_extension_workers_never_match_service_daemon_names_in_plugin_paths() {
        for command in [
            "/opt/pilot/bin/loongsuite-pilot internal-span-enricher /tmp/collector-daemon.js.mjs",
            "/opt/pilot/bin/loongsuite-pilot internal-span-enricher /tmp/bin/updater-daemon/plugin.mjs",
            "/opt/pilot/bin/loongsuite-pilot internal-span-enricher /tmp/dist/interceptor/daemon/plugin.mjs",
            "/opt/pilot folder/bin/loongsuite-pilot internal-span-enricher /tmp/dist/updater/index.js.mjs",
            r#""C:\User Name\Pilot\bin\loongsuite-pilot.exe" internal-span-enricher "C:\plugins\updater-daemon.js.mjs""#,
            r#"C:\Pilot\bin\loongsuite-pilot.exe internal-span-enricher C:\plugins\collector-daemon.js.mjs"#,
        ] {
            for patterns in [COLLECTOR_PROCESS_PATTERNS,UPDATER_PROCESS_PATTERNS,INTERCEPTOR_PROCESS_PATTERNS] {
                assert!(!is_command_match(command,patterns),"{command}");
                assert!(!match_unix_process_scan(&format!("12345 {command}\n"),patterns,99999).running);
                assert!(!match_windows_process_scan(&format!("12345\t{command}\r\n"),patterns,99999).running);
            }
        }
        // The guard must not remove valid legacy or native service identities.
        assert!(is_command_match(
            "/opt/pilot/bin/loongsuite-pilot run",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(is_command_match(
            "/opt/pilot/bin/loongsuite-pilot run-updater",
            UPDATER_PROCESS_PATTERNS
        ));
        assert!(is_command_match(
            "/usr/bin/node /tmp/collector-daemon.js",
            COLLECTOR_PROCESS_PATTERNS
        ));
        assert!(is_command_match(
            "/usr/bin/node /tmp/updater-daemon.js",
            UPDATER_PROCESS_PATTERNS
        ));
    }

    #[test]
    fn windows_native_fallback_recognizes_exe_and_quoted_paths_without_crossing_role_boundaries() {
        let collector = [
            r#"C:\Pilot\bin\loongsuite-pilot.exe run"#,
            r#""C:\User Name\Pilot\bin\loongsuite-pilot.exe" run"#,
            r#""C:\User Name\Pilot\bin\loongsuite-pilot.exe""#,
            r#""C:\User Name\Pilot\loongsuite-pilot.ps1" run-service"#,
        ];
        let updater = [
            r#"C:\Pilot\bin\loongsuite-pilot.exe run-updater"#,
            r#""C:\User Name\Pilot\bin\loongsuite-pilot.exe" run-updater"#,
            r#""C:\User Name\Pilot\loongsuite-pilot.ps1" run-updater"#,
        ];
        for command in collector {
            assert!(
                is_command_match(command, COLLECTOR_PROCESS_PATTERNS),
                "{command}"
            );
            assert!(
                !is_command_match(command, UPDATER_PROCESS_PATTERNS),
                "{command}"
            );
            assert!(
                match_windows_process_scan(
                    &format!("12345\t{command}\r\n"),
                    COLLECTOR_PROCESS_PATTERNS,
                    99999
                )
                .running
            );
        }
        for command in updater {
            assert!(
                is_command_match(command, UPDATER_PROCESS_PATTERNS),
                "{command}"
            );
            assert!(
                !is_command_match(command, COLLECTOR_PROCESS_PATTERNS),
                "{command}"
            );
            assert!(
                match_windows_process_scan(
                    &format!("12345\t{command}\r\n"),
                    UPDATER_PROCESS_PATTERNS,
                    99999
                )
                .running
            );
        }
        for command in [
            r#""C:\Pilot\bin\not-loongsuite-pilot.exe" run"#,
            r#""C:\Pilot\bin\loongsuite-pilot.exe.bak" run-updater"#,
            r#""C:\Pilot\bin\loongsuite-pilot.exe" status"#,
            r#""C:\Pilot\bin\loongsuite-pilot.exe" check"#,
            r#""C:\Pilot\bin\loongsuite-pilot.exe" run-updater-helper"#,
            r#""C:\Pilot\bin\loongsuite-pilot.exe" run-service-helper"#,
            r#""C:\Pilot\bin\loongsuite-pilot.exe" internal-span-enricher "C:\plugins\updater-daemon.js.mjs""#,
        ] {
            assert!(
                !is_command_match(command, COLLECTOR_PROCESS_PATTERNS),
                "{command}"
            );
            assert!(
                !is_command_match(command, UPDATER_PROCESS_PATTERNS),
                "{command}"
            );
        }
        let mixed = format!(
            "12345\t{}\r\n23456\t{}\r\n",
            r#""C:\Pilot\bin\loongsuite-pilot.exe" internal-span-enricher "C:\plugins\updater-daemon.js.mjs""#,
            updater[1]
        );
        let found = match_windows_process_scan(&mixed, UPDATER_PROCESS_PATTERNS, 99999);
        assert_eq!(found.pid, Some(23456));
    }

    #[test]
    fn treats_eperm_from_kill_zero_as_alive() {
        assert!(process_alive_from_kill(Err(1)));
        assert!(process_alive_from_kill(Ok(())));
        assert!(!process_alive_from_kill(Err(3)));
    }

    #[test]
    fn reads_a_stable_process_start_token_from_linux_stat() {
        let stat = "123 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 4242 20 21";
        assert_eq!(
            linux_proc_start_token(stat, "boot-id-1\n"),
            "linux-proc-v1:boot-id-1:4242"
        );
        assert_eq!(
            ps_lstart_token("darwin", "Tue Aug 18 15:03:36 2026\n"),
            "darwin-ps-lstart-v1:Tue Aug 18 15:03:36 2026"
        );
    }

    #[test]
    fn current_process_start_token_uses_native_identity_and_is_stable() {
        let pid = std::process::id();
        let first = read_process_start_token(pid);
        assert!(!first.is_empty(), "当前进程必须能读到启动身份");
        assert_eq!(read_process_start_token(pid), first);
        assert!(read_process_start_token(0).is_empty());
        assert!(is_process_alive(pid));
        assert!(!is_process_alive(0));
        assert!(read_process_command(0).is_empty());
        let command = read_process_command(pid);
        let executable = std::env::current_exe().unwrap();
        let file = executable.file_name().unwrap().to_string_lossy();
        assert!(
            command.contains(file.as_ref()),
            "当前进程命令必须来自真实进程"
        );
        if cfg!(target_os = "linux") {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
            let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap();
            assert_eq!(first, linux_proc_start_token(&stat, &boot));
        } else if cfg!(windows) {
            let creation = first.strip_prefix("win32-filetime-v1:").unwrap();
            assert!(creation.parse::<u64>().unwrap() > 0);
        } else {
            assert!(first.starts_with(&format!("{}-ps-lstart-v1:", node_platform())));
            assert!(first.split_whitespace().count() >= 5);
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_process_identity_reports_invalid_pids_without_spawning_a_shell() {
        assert!(windows_process_start_token(0).is_err());
        assert!(windows_process_start_token(u32::MAX).is_err());
        let current = windows_process_start_token(std::process::id()).unwrap();
        assert!(current.starts_with("win32-filetime-v1:"));
        assert_eq!(
            current,
            windows_process_start_token(std::process::id()).unwrap()
        );
    }

    #[test]
    fn uses_pid_file_as_fast_path_when_pid_command_matches() {
        let io = FakeIo::new();
        io.reads.borrow_mut().push_back(Ok("123\n".into()));
        io.alives.borrow_mut().push_back(true);
        io.execs
            .borrow_mut()
            .push_back(Ok("/usr/bin/node /tmp/collector-daemon.js\n".into()));
        let result = check_process_liveness_with("/tmp/pilot.pid", COLLECTOR_PROCESS_PATTERNS, &io);
        assert!(result.running);
        assert_eq!(result.pid, Some(123));
        assert_eq!(result.source, ProcessLivenessSource::PidFile);
        assert_eq!(result.pid_file_state, Some(PidFileState::Matched));
    }

    #[test]
    fn falls_through_to_process_scan_when_pid_file_command_is_unreadable() {
        let io = FakeIo::new();
        let scanned_pid = io.scanned_pid();
        io.reads.borrow_mut().push_back(Ok("123\n".into()));
        io.alives.borrow_mut().push_back(true);
        io.execs.borrow_mut().push_back(Ok(String::new()));
        io.execs.borrow_mut().push_back(Ok(format!(
            "{scanned_pid} /usr/bin/node /tmp/collector-daemon.js\n"
        )));
        let result = check_process_liveness_with("/tmp/pilot.pid", COLLECTOR_PROCESS_PATTERNS, &io);
        assert!(result.running);
        assert_eq!(result.pid, Some(scanned_pid));
        assert_eq!(result.source, ProcessLivenessSource::ProcessScan);
        assert_eq!(result.pid_file_state, Some(PidFileState::Stale));
        assert_eq!(result.pid_file_process_alive, Some(true));
        assert_eq!(result.pid_file_command_matched, None);
    }

    #[test]
    fn reports_unhealthy_when_command_is_unreadable_and_scan_finds_nothing() {
        let io = FakeIo::new();
        let scanned_pid = io.scanned_pid();
        io.reads.borrow_mut().push_back(Ok("123\n".into()));
        io.alives.borrow_mut().push_back(true);
        io.execs.borrow_mut().push_back(Ok(String::new()));
        io.execs
            .borrow_mut()
            .push_back(Ok(format!("{scanned_pid} /usr/bin/node unrelated.js\n")));
        let result = check_process_liveness_with("/tmp/pilot.pid", COLLECTOR_PROCESS_PATTERNS, &io);
        assert!(!result.running);
        assert_eq!(result.pid, Some(123));
        assert_eq!(result.source, ProcessLivenessSource::None);
        assert_eq!(result.pid_file_state, Some(PidFileState::Stale));
        assert_eq!(result.pid_file_process_alive, Some(true));
        assert_eq!(result.pid_file_command_matched, None);
    }

    #[test]
    fn does_not_report_down_when_pid_changed_but_command_identity_is_present() {
        let io = FakeIo::new();
        let scanned_pid = io.scanned_pid();
        io.reads.borrow_mut().push_back(Ok("123\n".into()));
        io.alives.borrow_mut().push_back(false);
        io.execs.borrow_mut().push_back(Ok(format!(
            "{scanned_pid} /usr/bin/node /tmp/collector-daemon.js\n"
        )));
        let result = check_process_liveness_with("/tmp/pilot.pid", COLLECTOR_PROCESS_PATTERNS, &io);
        assert!(result.running);
        assert_eq!(result.pid, Some(scanned_pid));
        assert_eq!(result.source, ProcessLivenessSource::ProcessScan);
        assert_eq!(result.pid_file_state, Some(PidFileState::Stale));
    }

    #[test]
    fn reports_unhealthy_when_pid_is_stale_and_no_matching_command_exists() {
        let io = FakeIo::new();
        let scanned_pid = io.scanned_pid();
        io.reads.borrow_mut().push_back(Ok("123\n".into()));
        io.alives.borrow_mut().push_back(false);
        io.execs
            .borrow_mut()
            .push_back(Ok(format!("{scanned_pid} /usr/bin/node unrelated.js\n")));
        let result = check_process_liveness_with("/tmp/pilot.pid", COLLECTOR_PROCESS_PATTERNS, &io);
        assert!(!result.running);
        assert_eq!(result.pid, Some(123));
        assert_eq!(result.source, ProcessLivenessSource::None);
        assert_eq!(result.pid_file_state, Some(PidFileState::Stale));
    }

    #[test]
    fn falls_back_to_command_identity_when_pid_file_is_missing() {
        let io = FakeIo::new();
        let scanned_pid = io.scanned_pid();
        io.reads
            .borrow_mut()
            .push_back(Err(io::Error::new(io::ErrorKind::NotFound, "missing")));
        io.exists.borrow_mut().push_back(false);
        io.execs.borrow_mut().push_back(Ok(format!(
            "{scanned_pid} /usr/bin/node /tmp/updater-daemon.js\n"
        )));
        let result = check_process_liveness_with("/tmp/updater.pid", UPDATER_PROCESS_PATTERNS, &io);
        assert!(result.running);
        assert_eq!(result.pid, Some(scanned_pid));
        assert_eq!(result.source, ProcessLivenessSource::ProcessScan);
        assert_eq!(result.pid_file_state, Some(PidFileState::Missing));
    }

    #[test]
    fn process_scan_skips_own_matching_command_before_selecting_another_process() {
        for windows in [false, true] {
            for self_pid in [std::process::id(), 123, 456, 789] {
                let mut io = FakeIo::new();
                io.self_pid = self_pid;
                io.windows = windows;
                let scanned_pid = io.scanned_pid();
                assert_ne!(scanned_pid, self_pid);
                assert_ne!(scanned_pid, 123);
                io.reads
                    .borrow_mut()
                    .push_back(Err(io::Error::new(io::ErrorKind::NotFound, "missing")));
                io.exists.borrow_mut().push_back(false);
                let (separator, newline) = if windows { ("\t", "\r\n") } else { (" ", "\n") };
                io.execs.borrow_mut().push_back(Ok(format!(
                    "{self_pid}{separator}/usr/bin/node /tmp/collector-daemon.js{newline}{scanned_pid}{separator}/usr/bin/node /tmp/collector-daemon.js{newline}"
                )));
                let result =
                    check_process_liveness_with("/tmp/pilot.pid", COLLECTOR_PROCESS_PATTERNS, &io);
                assert!(result.running);
                assert_eq!(result.pid, Some(scanned_pid));
                assert_eq!(result.source, ProcessLivenessSource::ProcessScan);
                assert_eq!(result.pid_file_state, Some(PidFileState::Missing));
            }
        }
    }

    #[test]
    fn writes_and_removes_the_current_pid() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("loongsuite-pilot.pid");
        write_pid_file_sync(pid_file.to_str().unwrap());
        assert_eq!(
            std::fs::read_to_string(&pid_file).unwrap(),
            format!("{}\n", std::process::id())
        );
        assert_eq!(
            read_pid_file(pid_file.to_str().unwrap()),
            Some(std::process::id())
        );

        let nested = dir
            .path()
            .join("nested")
            .join("deep")
            .join("loongsuite-pilot.pid");
        write_pid_file_sync(nested.to_str().unwrap());
        assert!(nested.exists());
        assert_eq!(
            read_pid_file(nested.to_str().unwrap()),
            Some(std::process::id())
        );

        remove_own_pid_file_sync(pid_file.to_str().unwrap());
        assert!(!pid_file.exists());

        let peer = dir.path().join("peer.pid");
        let foreign = std::process::id().saturating_add(1);
        std::fs::write(&peer, format!("{foreign}\n")).unwrap();
        remove_own_pid_file_sync(peer.to_str().unwrap());
        assert!(peer.exists());
        assert_eq!(read_pid_file(peer.to_str().unwrap()), Some(foreign));

        remove_own_pid_file_sync(dir.path().join("ghost.pid").to_str().unwrap());

        let as_file = dir.path().join("a-file");
        std::fs::write(&as_file, "x").unwrap();
        let bad = as_file.join("nope.pid");
        write_pid_file_sync(bad.to_str().unwrap());
        remove_own_pid_file_sync(bad.to_str().unwrap());
        assert!(!bad.exists());
    }
    #[test]
    fn liveness_probe_native_fixture() {
        if let Ok(code) = std::env::var("PILOT_LIVENESS_EXIT_CODE") {
            std::process::exit(code.parse().unwrap());
        }
        #[cfg(unix)]
        if let Ok(pid) = std::env::var("PILOT_LIVENESS_DENIED_PID") {
            let pid = pid.parse::<u32>().unwrap();
            assert_eq!(process_zero_probe(pid), Err(libc::EPERM));
            assert!(is_process_alive(pid));
            println!("native EPERM preserved");
            return;
        }
        let Some(root) = std::env::var_os("PILOT_LIVENESS_FIXTURE_ROOT") else {
            return;
        };
        std::fs::write(
            Path::new(&root).join("ready"),
            std::process::id().to_string(),
        )
        .unwrap();
        loop {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn production_liveness_probe_distinguishes_running_and_reaped_children_and_invalid_pids() {
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "utils::pid_utils::tests::liveness_probe_native_fixture",
                "--nocapture",
            ])
            .env_clear()
            .env("PILOT_LIVENESS_FIXTURE_ROOT", root.path())
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let mut child = OwnedChild(command.spawn().unwrap());
        let start = Instant::now();
        while !root.path().join("ready").is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "native liveness fixture exited before readiness"
            );
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "native liveness fixture did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid = child.0.id();
        assert!(is_process_alive(pid));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        // Windows still owns the exited process handle here: waiting must
        // identify termination rather than merely finding its process object.
        assert!(!is_process_alive(pid));
        assert!(is_process_alive(std::process::id()));
        assert!(!is_process_alive(0));
        assert!(!is_process_alive(u32::MAX));
        #[cfg(windows)]
        {
            command.env("PILOT_LIVENESS_EXIT_CODE", "259");
            let mut exited = OwnedChild(command.spawn().unwrap());
            assert_eq!(exited.0.wait().unwrap().code(), Some(259));
            assert!(!is_process_alive(exited.0.id()));
        }
    }
}
