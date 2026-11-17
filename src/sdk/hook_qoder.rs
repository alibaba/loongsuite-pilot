//! Resolve the Qoder surface for registrations shared by the IDE and CLI.
//! Inspect bounded native ancestry without starting a subprocess.

pub(super) fn agent() -> &'static str {
    if cli_ancestor() {
        "qodercli"
    } else {
        "qoder"
    }
}

fn is_cli(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    ["qodercli", "qoder-cli", "qoder_cli"].iter().any(|prefix| {
        name.strip_prefix(prefix).is_some_and(|suffix| {
            suffix.is_empty()
                || suffix
                    .strip_prefix('-')
                    .is_some_and(|version| version.starts_with(|c: char| c.is_ascii_digit()))
        })
    }) || name
        .strip_prefix("qoder-")
        .is_some_and(|version| version.starts_with(|c: char| c.is_ascii_digit()))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn cli_ancestor() -> bool {
    let mut pid = unsafe { libc::getppid() };
    for _ in 0..12 {
        if pid <= 1 {
            break;
        }
        let Some((parent, name)) = process(pid) else {
            break;
        };
        if is_cli(&name) {
            return true;
        }
        pid = parent;
    }
    false
}

#[cfg(target_os = "linux")]
fn process(pid: libc::pid_t) -> Option<(libc::pid_t, String)> {
    let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
    let stat = String::from_utf8_lossy(&stat);
    let (_, rest) = stat.split_once('(')?;
    let (name, fields) = rest.rsplit_once(") ")?;
    let parent = fields.split_whitespace().nth(1)?.parse().ok()?;
    Some((parent, name.to_owned()))
}

#[cfg(target_os = "macos")]
fn process(pid: libc::pid_t) -> Option<(libc::pid_t, String)> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdshortinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdshortinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    // SAFETY: a successful proc_pidinfo initialized the complete structure.
    let info = unsafe { info.assume_init() };
    let name = info.pbsi_comm.map(|character| character as u8);
    let nul = name
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(name.len());
    Some((
        info.pbsi_ppid as libc::pid_t,
        String::from_utf8_lossy(&name[..nul]).into_owned(),
    ))
}

#[cfg(windows)]
fn cli_ancestor() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return false;
    }
    // SAFETY: a zeroed PROCESSENTRY32W with dwSize set is the documented input.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut processes = std::collections::HashMap::new();
    while found != 0 {
        let name = &entry.szExeFile;
        let nul = name
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(name.len());
        processes.insert(
            entry.th32ProcessID,
            (
                entry.th32ParentProcessID,
                is_cli(&String::from_utf16_lossy(&name[..nul])),
            ),
        );
        found = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    let mut pid = std::process::id();
    for _ in 0..12 {
        let Some(&(parent, _)) = processes.get(&pid) else {
            break;
        };
        let Some(&(_, cli)) = processes.get(&parent) else {
            break;
        };
        if cli {
            return true;
        }
        pid = parent;
    }
    false
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn cli_ancestor() -> bool {
    false
}
