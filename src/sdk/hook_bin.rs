//! Hard deadline belongs to the main thread. This module has no collector link.
#[path = "hook_protocol.rs"]
mod protocol;
#[path = "hook_qoder.rs"]
mod qoder;
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
pub type LegacyHook = fn(&[String]) -> Option<String>;

pub fn is_hook(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("sdk-hook") => true,
        Some("interceptor") => args.get(1).is_some_and(|arg| arg == "hook"),
        Some("hook-process") => match args.get(1).map(String::as_str) {
            Some("qoder") => args.iter().any(|arg| arg == "--wakeup-only"),
            _ => false,
        },
        _ => false,
    }
}

enum HookOutput {
    Json(String),
    Block(String),
}

struct RequestTrace {
    path: PathBuf,
    id: String,
    channel: String,
    started: Instant,
    instance: Option<String>,
    receipt_ms: Option<u128>,
    status: &'static str,
    send_attempts: usize,
    reply_status: Option<String>,
}

impl Drop for RequestTrace {
    fn drop(&mut self) {
        append_hook_trace(
            &self.path,
            serde_json::json!({
                "id": self.id, "instance": self.instance, "channel": self.channel,
                "at_unix_ms": unix_time().map(|time| time.as_millis() as u64),
                "elapsed_ms": self.started.elapsed().as_millis(), "receipt_ms": self.receipt_ms,
                "status": self.status, "send_attempts": self.send_attempts, "reply_status": self.reply_status,
            }),
        );
    }
}

fn unix_time() -> Option<Duration> {
    SystemTime::now().duration_since(UNIX_EPOCH).ok()
}

struct Remove(PathBuf);
impl Drop for Remove {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn private_new_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn block_output(agent: &str, event: &str, reason: &str) -> Option<HookOutput> {
    // Qoder CLI uses the native exit status and stderr for PreToolUse.
    if agent == "qodercli" && event == "PreToolUse" {
        Some(HookOutput::Block(block_reason(reason).to_owned()))
    } else {
        render_block(agent, event, reason).map(HookOutput::Json)
    }
}

fn offline_block(
    rules: &OfflineDenyRules,
    agent: &str,
    event: &str,
    trace: &mut RequestTrace,
) -> Option<HookOutput> {
    if can_deny_offline(event)
        && rules
            .get(agent)
            .is_some_and(|events| events.contains(event))
    {
        trace.status = "offline_block";
        trace.reply_status = Some("offline_policy".into());
        block_output(
            agent,
            event,
            "Pilot SDK is unavailable. Retry the operation.",
        )
    } else {
        None
    }
}

fn worker(args: Vec<String>, started: Instant, legacy: Option<LegacyHook>) -> Option<HookOutput> {
    if args.first().map(String::as_str) == Some("interceptor") {
        return legacy?(&args[2..]).map(HookOutput::Json);
    }
    if args.first().map(String::as_str) == Some("hook-process") {
        return legacy?(&args).map(HookOutput::Json);
    }
    let data = PathBuf::from(flag(&args, "--data-dir")?);
    if !data.is_absolute() {
        return None;
    }
    let channel = flag(&args, "--channel")?;
    if !matches!(channel, "observe" | "local" | "cloud") {
        return None;
    }
    let configured_agent = flag(&args, "--agent")?;
    let managed =
        configured_agent == "codex" && args.iter().any(|arg| arg == "--pilot-sdk-managed");
    let configured_event = flag(&args, "--event");
    if configured_event.is_none() && configured_agent != "qoder-auto" {
        return None;
    }
    let id = format!("{:08x}{:032x}", std::process::id(), unix_time()?.as_nanos());
    let mut trace = RequestTrace {
        path: data.join("hook-client.jsonl"),
        id: id.clone(),
        channel: channel.to_owned(),
        started,
        instance: None,
        receipt_ms: None,
        status: "sdk_unavailable",
        send_attempts: 0,
        reply_status: None,
    };
    let descriptor = descriptor(&data.join(format!("sdk-hooks-{channel}.json")))
        .filter(|item| item.schema == 2 && item.port != 0 && pid_alive(item.pid));
    let unavailable_rules = if descriptor.is_none() {
        if channel != "cloud" {
            return None;
        }
        Some(read_offline_deny(&data).filter(|rules| !rules.is_empty())?)
    } else {
        None
    };
    trace.instance = descriptor.as_ref().map(|item| item.instance.clone());
    trace.status = "invalid_input";
    let mut body = Vec::new();
    std::io::stdin()
        .take((MAX_REQUEST + 1) as u64)
        .read_to_end(&mut body)
        .ok()?;
    if body.len() > MAX_REQUEST {
        return None;
    }
    let mut payload = serde_json::from_slice::<serde_json::Value>(&body).ok()?;
    let payload = payload.as_object_mut()?;
    let event = configured_event
        .or_else(|| {
            payload
                .get("hook_event_name")
                .and_then(serde_json::Value::as_str)
        })?
        .to_owned();
    let agent = if configured_agent == "qoder-auto" {
        match payload
            .get("parent_business_info")
            .and_then(|parent| parent["product"].as_str())
        {
            Some("app") => "qoder",
            Some("cli") => "qodercli",
            _ => qoder::agent(),
        }
    } else {
        configured_agent
    }
    .to_owned();
    let offline = |trace: &mut RequestTrace| {
        if channel != "cloud" {
            return None;
        }
        let owned = unavailable_rules
            .is_none()
            .then(|| read_offline_deny(&data))
            .flatten();
        offline_block(
            unavailable_rules.as_ref().or(owned.as_ref())?,
            &agent,
            &event,
            trace,
        )
    };
    let Some(descriptor) = descriptor else {
        trace.status = "sdk_unavailable";
        return offline(&mut trace);
    };
    let codex_observe = configured_agent == "codex"
        && (channel == "observe" || (channel == "local" && event == "UserPromptSubmit"));
    if (channel == "observe" && configured_agent == "qoder-auto") || codex_observe {
        let context_key = if configured_agent == "codex" {
            CODEX_OBSERVE_CONTEXT
        } else {
            QODER_OBSERVE_CONTEXT
        };
        let context: serde_json::Map<_, _> = QODER_OBSERVE_ENV
            .into_iter()
            .filter_map(|key| {
                std::env::var(key)
                    .ok()
                    .map(|value| (key.into(), value.into()))
            })
            .collect();
        if !context.is_empty() {
            payload.insert(context_key.into(), serde_json::Value::Object(context));
            if let Ok(encoded) = serde_json::to_vec(&payload) {
                if encoded.len() <= MAX_REQUEST {
                    body = encoded;
                }
            }
        }
    }
    trace.status = "client_admission_failed";
    let spool = data.join(format!("hook-requests-{channel}"));
    std::fs::create_dir_all(&spool).ok()?;
    if !std::fs::symlink_metadata(&spool).ok()?.is_dir() {
        return None;
    }

    let lease_limit = if descriptor.cloud_capacity {
        CLOUD_IN_FLIGHT
    } else {
        16
    };
    let mut count = 0;
    // The lease is authoritative. In particular, Windows may temporarily
    // report access denied for an entry another process is deleting.
    for entry in std::fs::read_dir(&spool)
        .ok()?
        .take(2 * lease_limit + 1)
        .flatten()
    {
        let modified = entry.metadata().and_then(|meta| meta.modified());
        if modified.is_ok_and(|time| time.elapsed().unwrap_or_default() > Duration::from_secs(5)) {
            let _ = std::fs::remove_file(entry.path());
        } else {
            count += 1;
        }
    }
    // A directory count alone races across concurrent bin processes.
    let lease = (descriptor.cloud_capacity || count < 32)
        .then(|| {
            let first_slot = std::process::id() as usize % lease_limit;
            (0..lease_limit).find_map(|offset| {
                let slot = (first_slot + offset) % lease_limit;
                let path = spool.join(format!("lease-{slot}"));
                private_new_file(&path).ok().map(|_| Remove(path))
            })
        })
        .flatten();
    let capacity_probe = lease.is_none();
    let _lease = lease;
    if capacity_probe && !descriptor.cloud_capacity {
        trace.status = "legacy_client_capacity";
        return None;
    }
    // At capacity the authenticated zero-body notice lets a live SDK check
    // whether this is a mandatory hook. It never reserves a slot or a file.
    let _payload = if capacity_probe {
        None
    } else {
        let path = spool.join(&id);
        let mut file = private_new_file(&path).ok()?;
        let cleanup = Remove(path);
        file.write_all(&body).ok()?;
        Some(cleanup)
    };
    let request = Datagram {
        schema: 2,
        token: descriptor.token.clone(),
        id: id.clone(),
        remaining_ms: Duration::from_millis(DEADLINE_MS)
            .checked_sub(started.elapsed())?
            .as_millis() as u32,
        t0_unix_ms: unix_time()?
            .as_millis()
            .saturating_sub(started.elapsed().as_millis()) as u64,
        length: if capacity_probe { 0 } else { body.len() },
        managed,
        agent: agent.clone(),
        event: event.clone(),
        want_receipt: descriptor.request_receipts,
        capacity_probe,
    };
    trace.status = if capacity_probe {
        "capacity_probe_unanswered"
    } else {
        "sdk_unreachable"
    };
    let Ok(socket) = UdpSocket::bind("127.0.0.1:0") else {
        return offline(&mut trace);
    };
    if socket.connect(("127.0.0.1", descriptor.port)).is_err() {
        return offline(&mut trace);
    }
    let request = serde_json::to_vec(&request).ok()?;
    let deadline = started + Duration::from_millis(DEADLINE_MS);
    let parse = |bytes: &[u8]| {
        let reply: serde_json::Value = serde_json::from_slice(bytes).ok()?;
        (reply["id"].as_str() == Some(id.as_str())
            && reply["instance"].as_str() == Some(descriptor.instance.as_str()))
        .then_some(reply)
    };
    let reply =
        |until: Instant, valid_until: Instant, is_expected: &dyn Fn(&serde_json::Value) -> bool| {
            let mut bytes = [0u8; MAX_REPLY];
            loop {
                let wait = until
                    .checked_duration_since(Instant::now())
                    .filter(|wait| !wait.is_zero())
                    .ok_or(std::io::ErrorKind::TimedOut)?;
                socket.set_read_timeout(Some(wait))?;
                let len = socket.recv(&mut bytes)?;
                if let Some(reply) = parse(&bytes[..len])
                    .filter(|row| Instant::now() < valid_until && is_expected(row))
                {
                    return Ok::<_, std::io::Error>(reply);
                }
            }
        };
    let first_deadline = if descriptor.request_receipts {
        deadline.min(Instant::now() + Duration::from_millis(RECEIPT_TIMEOUT_MS))
    } else {
        deadline
    };
    let is_receipt_or_verdict =
        |row: &serde_json::Value| reply_action(row).is_some() || row["received"] == true;
    let first = loop {
        trace.send_attempts += 1;
        if socket.send(&request).is_err() {
            return offline(&mut trace);
        }
        let until = if descriptor.cloud_capacity {
            first_deadline.min(Instant::now() + Duration::from_millis(50))
        } else {
            first_deadline
        };
        match reply(until, deadline, &is_receipt_or_verdict) {
            Ok(reply) => break reply,
            Err(error)
                if descriptor.cloud_capacity
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    )
                    && Instant::now() + Duration::from_millis(10) < first_deadline => {}
            Err(error)
                if descriptor.cloud_capacity
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
            {
                // A busy host can deschedule the bin after the kernel queued
                // its receipt. Check without exceeding the availability wait.
                socket.set_nonblocking(true).ok()?;
                let mut bytes = [0u8; MAX_REPLY];
                let Some(first) = socket
                    .recv(&mut bytes)
                    .ok()
                    .and_then(|len| parse(&bytes[..len]).filter(is_receipt_or_verdict))
                else {
                    return offline(&mut trace);
                };
                socket.set_nonblocking(false).ok()?;
                if Instant::now() >= deadline {
                    return None;
                }
                break first;
            }
            Err(_) => return offline(&mut trace),
        }
    };
    let reply = if descriptor.request_receipts
        && first.get("received").and_then(serde_json::Value::as_bool) == Some(true)
    {
        trace.receipt_ms = Some(started.elapsed().as_millis());
        let required = descriptor.cloud_capacity
            && channel == "cloud"
            && event == "PreToolUse"
            && first["required"] == true;
        let until = if required {
            deadline - Duration::from_millis(REPLY_MARGIN_MS)
        } else {
            deadline
        };
        trace.status = "verdict_unavailable";
        // A delayed/replayed receipt is not a final verdict.
        let reply = reply(until, until, &|row| reply_action(row).is_some()).ok();
        if required && reply.is_none() {
            trace.status = "temporary_block";
            trace.reply_status = Some("confirmed_timeout".to_owned());
            return block_output(&agent, &event, TEMPORARY_DENIAL);
        }
        reply?
    } else {
        first
    };
    let (action, reason) = reply_action(&reply)?;
    let blocked = action == "block" && channel != "observe";
    trace.reply_status = reply["status"].as_str().map(str::to_owned);
    trace.status = match (blocked, trace.reply_status.as_deref()) {
        (false, _) => "allow",
        (
            true,
            Some(
                "overload" | "audit_overload" | "expired" | "callback_failed" | "input_unavailable",
            ),
        ) => "temporary_block",
        (true, _) => "block",
    };
    blocked
        .then(|| block_output(&agent, &event, reason))
        .flatten()
}

/// Never return while a worker can still write to the Agent. Only this main
/// thread owns output; process::exit terminates blocked stdin/socket workers.
pub fn run(args: Vec<String>, started: Instant, legacy: Option<LegacyHook>) -> ! {
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
            let _ = tx.send(worker(args, started, legacy));
        });
    if spawn.is_ok() {
        if let Some(left) = Duration::from_millis(DEADLINE_MS).checked_sub(started.elapsed()) {
            if let Ok(Some(output)) = rx.recv_timeout(left) {
                if started.elapsed() < Duration::from_millis(DEADLINE_MS) {
                    match output {
                        HookOutput::Json(output) => {
                            let mut stdout = std::io::stdout().lock();
                            let _ = stdout.write_all(output.as_bytes());
                            let _ = stdout.flush();
                        }
                        HookOutput::Block(reason) => {
                            let mut stderr = std::io::stderr().lock();
                            let _ = writeln!(stderr, "{reason}");
                            let _ = stderr.flush();
                            std::process::exit(2);
                        }
                    }
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
