//! Hard deadline belongs to the main thread. This module has no collector link.
#[path = "hook_protocol.rs"]
mod protocol;
use protocol::*;
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}
fn descriptor(path: &Path) -> Option<Descriptor> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            return None;
        }
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
fn worker(args: Vec<String>, started: Instant) -> Option<String> {
    if args.first().map(String::as_str) == Some("interceptor") {
        return legacy_worker(&args[2..]);
    }
    let data = PathBuf::from(flag(&args, "--data-dir")?);
    if !data.is_absolute() {
        return None;
    }
    let channel = flag(&args, "--channel")?;
    if !matches!(channel, "cloud" | "local") {
        return None;
    }
    let agent = flag(&args, "--agent")?.to_owned();
    let event = flag(&args, "--event")?.to_owned();
    let descriptor = descriptor(&data.join(format!("sdk-hooks-{channel}.json")))?;
    if descriptor.schema != 2 || descriptor.port == 0 || !pid_alive(descriptor.pid) {
        return None;
    }
    let mut body = Vec::new();
    std::io::stdin()
        .take((MAX_REQUEST + 1) as u64)
        .read_to_end(&mut body)
        .ok()?;
    if body.len() > MAX_REQUEST
        || serde_json::from_slice::<serde_json::Value>(&body)
            .ok()?
            .as_object()
            .is_none()
    {
        return None;
    }
    let left = Duration::from_millis(DEADLINE_MS).checked_sub(started.elapsed())?;
    if left.is_zero() {
        return None;
    }
    let spool = data.join(format!("hook-requests-{channel}"));
    std::fs::create_dir_all(&spool).ok()?;
    if std::fs::symlink_metadata(&spool)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    // Bound unconsumed requests even when a stale endpoint remains in a live
    // host process. Expired requests can no longer produce a valid verdict.
    let mut count = 0;
    for entry in std::fs::read_dir(&spool).ok()?.take(65).flatten() {
        // Another SDK worker may consume a request between read_dir and
        // metadata. Its disappearance must not discard this unrelated hook.
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        };
        if meta.modified().ok()?.elapsed().unwrap_or_default() > Duration::from_secs(5) {
            let _ = std::fs::remove_file(entry.path());
        } else {
            count += 1;
        }
    }
    if count >= 32 {
        return None;
    }
    // Fixed create_new leases enforce the cap across simultaneous bin
    // processes. A directory count alone races when many hooks arrive together.
    let lease = (0..16).find_map(|slot| {
        let path = spool.join(format!("lease-{slot}"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path).ok().map(|file| (path, file))
    })?;
    struct Lease(PathBuf, std::fs::File);
    impl Drop for Lease {
        fn drop(&mut self) {
            let _ = self.1.sync_all();
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _lease = Lease(lease.0, lease.1);
    let id = format!(
        "{:08x}{:032x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos()
    );
    let path = spool.join(&id);
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        let mut file = options.open(&path).ok()?;
        file.write_all(&body).ok()?;
    }
    struct Remove(PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _remove = Remove(path);
    let request = Datagram {
        schema: 2,
        token: descriptor.token.clone(),
        id: id.clone(),
        remaining_ms: Duration::from_millis(DEADLINE_MS)
            .checked_sub(started.elapsed())?
            .as_millis() as u32,
        t0_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis()
            .saturating_sub(started.elapsed().as_millis()) as u64,
        length: body.len(),
        agent: agent.clone(),
        event: event.clone(),
    };
    let socket = UdpSocket::bind("127.0.0.1:0").ok()?;
    socket.connect(("127.0.0.1", descriptor.port)).ok()?;
    socket
        .set_read_timeout(Some(
            Duration::from_millis(DEADLINE_MS).checked_sub(started.elapsed())?,
        ))
        .ok()?;
    socket.send(&serde_json::to_vec(&request).ok()?).ok()?;
    let mut reply = [0u8; MAX_REPLY];
    let len = socket.recv(&mut reply).ok()?;
    if started.elapsed() >= Duration::from_millis(DEADLINE_MS) {
        return None;
    }
    let reply: serde_json::Value = serde_json::from_slice(&reply[..len]).ok()?;
    if reply.get("id")?.as_str() != Some(id.as_str())
        || reply.get("instance")?.as_str() != Some(descriptor.instance.as_str())
    {
        return None;
    }
    let (action, reason) = reply_action(&reply)?;
    if action == "block" {
        render_block(&agent, &event, reason)
    } else {
        None
    }
}

/// Never return while a worker can still write to the Agent. Only this main
/// thread owns stdout; process::exit terminates blocked stdin/socket workers.
pub fn run(args: Vec<String>, started: Instant) -> ! {
    let watchdog = std::thread::Builder::new()
        .name("pilot-hook-deadline".into())
        .spawn(move || {
            if let Some(left) = Duration::from_millis(DEADLINE_MS).checked_sub(started.elapsed()) {
                std::thread::sleep(left);
            }
            immediate_exit();
        });
    if watchdog.is_err() {
        std::process::exit(0);
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let spawn = std::thread::Builder::new()
        .name("pilot-hook-io".into())
        .spawn(move || {
            let _ = tx.send(worker(args, started));
        });
    if spawn.is_ok() {
        if let Some(left) = Duration::from_millis(DEADLINE_MS).checked_sub(started.elapsed()) {
            if let Ok(Some(output)) = rx.recv_timeout(left) {
                if started.elapsed() < Duration::from_millis(DEADLINE_MS) {
                    let _ = std::io::stdout().write_all(output.as_bytes());
                    let _ = std::io::stdout().flush();
                }
            }
        }
    }
    std::process::exit(0)
}

fn immediate_exit() -> ! {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn _exit(code: i32) -> !;
        }
        unsafe { _exit(0) }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
            fn TerminateProcess(process: *mut std::ffi::c_void, code: u32) -> i32;
        }
        unsafe {
            TerminateProcess(GetCurrentProcess(), 0);
        }
        loop {
            std::thread::park();
        }
    }
}

// Keep full Pilot's existing HTTP/Agent protocol, while covering cold library
// loading and stdin with the same process-wide native deadline.
fn legacy_worker(args: &[String]) -> Option<String> {
    use crate::host_loader::{self, abi::PilotJsonView, Library};
    let mut body = Vec::new();
    std::io::stdin()
        .take(5 * 1024 * 1024 + 1)
        .read_to_end(&mut body)
        .ok()?;
    if body.len() > 5 * 1024 * 1024 {
        return None;
    }
    let library = Library::open(&host_loader::library_path().ok()?).ok()?;
    let argv = serde_json::to_vec(args).ok()?;
    let mut report = std::ptr::null_mut();
    let mut length = 0;
    // SAFETY: buffers and library remain owned through the synchronous call.
    let code = unsafe {
        (library.api().host_hook)(
            PilotJsonView::from_bytes(&argv),
            PilotJsonView::from_bytes(&body),
            &mut report,
            &mut length,
        )
    };
    if report.is_null() {
        return None;
    }
    // SAFETY: SDK-owned output with explicit length, freed by the same library.
    let result = serde_json::from_slice::<serde_json::Value>(unsafe {
        std::slice::from_raw_parts(report.cast::<u8>(), length)
    });
    unsafe {
        (library.api().string_free)(report);
    }
    // The hook process exits immediately; retain any process-global logger.
    std::mem::forget(library);
    if code != 0 {
        return None;
    }
    result.ok()?.get("stdout")?.as_str().map(str::to_owned)
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            let handle = OpenProcess(0x1000, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0;
            let success = GetExitCodeProcess(handle, &mut code) != 0 && code == 259;
            CloseHandle(handle);
            success
        }
    }
}
