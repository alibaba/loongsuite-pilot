//! Exercise the actual loadable SDK through its C table, without linking its core.
#[path = "../src/sdk/host_loader.rs"]
pub mod loader;
use loader::abi::*;
use serde_json::{json, Value};
use std::ffi::c_void;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Default)]
struct Context {
    started: AtomicUsize,
    stopped: AtomicUsize,
    failed: AtomicUsize,
    retry: AtomicBool,
    monitor_hold: AtomicBool,
    monitor_entered: AtomicBool,
    hook_hold: AtomicBool,
    hook_entered: AtomicUsize,
    hook_invalid: AtomicBool,
    hook_requests: Mutex<Vec<Value>>,
    rows: Mutex<Vec<Vec<u8>>>,
    metrics: Mutex<Vec<Value>>,
}
unsafe fn context<'a>(p: *mut c_void) -> &'a Context {
    unsafe { &*p.cast::<Context>() }
}
unsafe extern "C" fn activity(p: *mut c_void, rows: *const PilotJsonView, n: usize) -> i32 {
    let c = unsafe { context(p) };
    for view in unsafe { std::slice::from_raw_parts(rows, n) } {
        c.rows
            .lock()
            .unwrap()
            .push(unsafe { std::slice::from_raw_parts(view.data, view.len) }.to_vec());
    }
    if c.retry.load(Ordering::SeqCst) {
        RETRY
    } else {
        ACK
    }
}
unsafe extern "C" fn monitoring(p: *mut c_void, rows: *const PilotJsonView, n: usize) -> i32 {
    let c = unsafe { context(p) };
    c.monitor_entered.store(true, Ordering::SeqCst);
    while c.monitor_hold.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    for view in unsafe { std::slice::from_raw_parts(rows, n) } {
        if let Ok(value) =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(view.data, view.len) })
        {
            c.metrics.lock().unwrap().push(value);
        }
    }
    ACK
}
unsafe extern "C" fn on_start(p: *mut c_void, _: *mut PilotHandle, code: i32, _: PilotJsonView) {
    let c = unsafe { context(p) };
    c.started.fetch_add(1, Ordering::SeqCst);
    if code != OK {
        c.failed.fetch_add(1, Ordering::SeqCst);
    }
}
unsafe extern "C" fn on_stop(p: *mut c_void, _: *mut PilotHandle, code: i32, _: PilotJsonView) {
    let c = unsafe { context(p) };
    c.stopped.fetch_add(1, Ordering::SeqCst);
    if code != OK {
        c.failed.fetch_add(1, Ordering::SeqCst);
    }
}
unsafe extern "C" fn on_hook(
    p: *mut c_void,
    request: PilotJsonView,
    _: u32,
    output: *mut u8,
    cap: usize,
    len: *mut usize,
) -> i32 {
    let c = unsafe { context(p) };
    if let Ok(value) =
        serde_json::from_slice(unsafe { std::slice::from_raw_parts(request.data, request.len) })
    {
        c.hook_requests.lock().unwrap().push(value);
    }
    c.hook_entered.fetch_add(1, Ordering::SeqCst);
    while c.hook_hold.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    if c.hook_invalid.load(Ordering::SeqCst) {
        unsafe {
            *len = cap + 1;
        }
        return OK;
    }
    let verdict = br#"{"action":"block","reason":"SDK foreign host test"}"#;
    if cap < verdict.len() {
        return FAILURE;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(verdict.as_ptr(), output, verdict.len());
        *len = verdict.len();
    }
    OK
}
#[track_caller]
fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "SDK acceptance deadline exceeded"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn library_path() -> PathBuf {
    if let Some(path) = std::env::var_os("PILOT_TEST_SDK_LIBRARY") {
        return PathBuf::from(path);
    }
    let exe = std::env::current_exe().unwrap();
    let name = if cfg!(windows) {
        "loongsuite_pilot.dll"
    } else if cfg!(target_os = "macos") {
        "libloongsuite_pilot.dylib"
    } else {
        "libloongsuite_pilot.so"
    };
    let profile = exe.parent().unwrap().parent().unwrap();
    [profile.join(name), profile.join("deps").join(name)]
        .into_iter()
        .find(|p| p.is_file())
        .expect("build the real cdylib before SDK acceptance")
}
struct Host {
    library: loader::Library,
    ctx: Box<Context>,
    handle: *mut PilotHandle,
}
impl Host {
    fn start(root: &Path, policy: Value, ctx: Box<Context>) -> Self {
        let library = loader::Library::open(&library_path()).unwrap();
        let init = serde_json::to_vec(&json!({"data_dir":root,"resource_dir":env!("CARGO_MANIFEST_DIR"),"user_id":"sdk-acceptance"})).unwrap();
        let policy = serde_json::to_vec(&policy).unwrap();
        let mut host = Self {
            library,
            ctx,
            handle: std::ptr::null_mut(),
        };
        let started = Instant::now();
        let code = unsafe {
            (host.api().start)(
                PilotJsonView::from_bytes(&init),
                PilotJsonView::from_bytes(&policy),
                Some(activity),
                Some(monitoring),
                Some(on_hook),
                Some(on_start),
                Some(on_stop),
                std::ptr::from_ref(&*host.ctx).cast_mut().cast(),
                &mut host.handle,
            )
        };
        assert_eq!(code, OK);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            host.ctx.started.load(Ordering::SeqCst),
            0,
            "no inline or pre-handoff notification"
        );
        host
    }
    fn api(&self) -> &PilotApiV2 {
        self.library.api()
    }
    fn pump(&self) {
        assert_eq!(unsafe { (self.api().dispatch)(self.handle, 0) }, OK);
    }
    fn ready(&self) {
        until(|| {
            self.pump();
            self.ctx.started.load(Ordering::SeqCst) == 1
        });
        assert_eq!(self.ctx.failed.load(Ordering::SeqCst), 0);
    }
    fn snapshot(&self) -> Value {
        let mut text = std::ptr::null_mut();
        let mut len = 0;
        assert_eq!(
            unsafe { (self.api().snapshot)(self.handle, &mut text, &mut len) },
            OK
        );
        let value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(text.cast::<u8>(), len) })
                .unwrap();
        unsafe { (self.api().string_free)(text) };
        value
    }
    fn apply(&self, policy: Value) -> (i32, Value) {
        let bytes = serde_json::to_vec(&policy).unwrap();
        let mut text = std::ptr::null_mut();
        let mut len = 0;
        let code = unsafe {
            (self.api().apply_policy)(
                self.handle,
                PilotJsonView::from_bytes(&bytes),
                &mut text,
                &mut len,
            )
        };
        let report = if text.is_null() {
            Value::Null
        } else {
            let value = serde_json::from_slice(unsafe {
                std::slice::from_raw_parts(text.cast::<u8>(), len)
            })
            .unwrap();
            unsafe { (self.api().string_free)(text) };
            value
        };
        (code, report)
    }
    fn stop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        let before = Instant::now();
        assert!(matches!(
            unsafe { (self.api().stop)(self.handle, 0) },
            OK | BUSY
        ));
        assert!(before.elapsed() < Duration::from_secs(1));
        until(|| {
            self.pump();
            self.ctx.stopped.load(Ordering::SeqCst) == 1
        });
        until(|| unsafe { (self.api().destroy)(self.handle) } == OK);
        let mut text = std::ptr::null_mut();
        let mut len = 0;
        assert_eq!(
            unsafe { (self.api().snapshot)(self.handle, &mut text, &mut len) },
            BAD_ARGUMENT
        );
        self.handle = std::ptr::null_mut();
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.ctx.monitor_hold.store(false, Ordering::SeqCst);
        self.ctx.hook_hold.store(false, Ordering::SeqCst);
        self.stop();
    }
}
fn empty_policy() -> Value {
    json!({"version":"original","agents":[],"hcd":{"agent_configs":{}}})
}
fn qoder_policy(source: &Path) -> Value {
    json!({"version":"qoder-v1","agents":["qoder"],"hcd":{"agent_configs":{"qoder":{"collection":{"enabled":true,"profile":"qoder_trace_v1","allowed_roots":[source],"sources":[{"id":"hook","type":"hook_jsonl","path":source}],"limits":{"poll_interval_ms":100}}}}},"sdk_options":{"delivery":{"flush_interval_ms":10,"retry_initial_ms":20,"retry_max_ms":40}}})
}

#[test]
fn real_library_lifecycle_policy_isolation_and_repeat_unload() {
    for _ in 0..8 {
        let root = tempfile::tempdir().unwrap();
        let mut a = Host::start(&root.path().join("a"), empty_policy(), Box::default());
        a.ready();
        let mut b = Host::start(&root.path().join("b"), empty_policy(), Box::default());
        b.ready();
        assert_ne!(a.snapshot()["instance_id"], b.snapshot()["instance_id"]);
        assert_eq!(
            a.apply(json!({"version":"bad","agents":["qoder"],"hcd":{}}))
                .0,
            BAD_ARGUMENT
        );
        assert_eq!(a.snapshot()["effective_version"], "original");
        assert_eq!(b.snapshot()["effective_version"], "original");
        until(|| {
            a.ctx.metrics.lock().unwrap().iter().any(|v| {
                v["event.name"] == "pilot.metrics.l1" && v["metrics_scope"] == "host_process"
            })
        });
        a.stop();
        b.stop();
    }
}
#[test]
fn blocked_foreign_callback_prevents_stop_notification_and_unload() {
    let root = tempfile::tempdir().unwrap();
    let ctx = Box::<Context>::default();
    ctx.monitor_hold.store(true, Ordering::SeqCst);
    let mut host = Host::start(root.path(), empty_policy(), ctx);
    host.ready();
    until(|| host.ctx.monitor_entered.load(Ordering::SeqCst));
    assert_eq!(unsafe { (host.api().stop)(host.handle, 0) }, OK);
    for _ in 0..10 {
        host.pump();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(host.ctx.stopped.load(Ordering::SeqCst), 0);
    assert_eq!(unsafe { (host.api().destroy)(host.handle) }, BUSY);
    host.ctx.monitor_hold.store(false, Ordering::SeqCst);
    host.stop();
}
#[test]
fn real_qoder_source_retry_restart_preserves_original_event_bytes() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let name = format!("qoder-{}.jsonl", chrono::Local::now().format("%Y-%m-%d"));
    let file = source.join(name);
    std::fs::write(&file, "").unwrap();
    let data = root.path().join("data");
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, qoder_policy(&source), ctx);
    host.ready();
    std::thread::sleep(Duration::from_millis(350));
    let row = json!({"event.id":"sdk-original-event","event.name":"llm.request","time_unix_nano":"1780000000000000001","gen_ai.agent.type":"qoder-cli","gen_ai.session.id":"sdk-session","gen_ai.turn.id":"sdk-turn","gen_ai.step.id":"sdk-step","gen_ai.provider.name":"qoder","gen_ai.request.model":"model","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"sdk acceptance"}]}],"gen_ai.sdk_unknown":{"integer":18446744073709551615u64,"array":[1,true]}});
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap(),
        "{row}"
    )
    .unwrap();
    until(|| host.ctx.rows.lock().unwrap().len() >= 2);
    let bytes = host.ctx.rows.lock().unwrap()[0].clone();
    assert_eq!(host.ctx.rows.lock().unwrap()[1], bytes);
    let decoded: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(decoded["event.id"], "sdk-original-event");
    assert_eq!(
        decoded["gen_ai.sdk_unknown"]["integer"].as_u64(),
        Some(u64::MAX)
    );
    host.stop();
    drop(host);
    let mut resumed = Host::start(&data, qoder_policy(&source), Box::default());
    resumed.ready();
    until(|| !resumed.ctx.rows.lock().unwrap().is_empty());
    assert_eq!(resumed.ctx.rows.lock().unwrap()[0], bytes);
    until(|| resumed.snapshot()["delivery"]["pending_events"] == 0);
    resumed.stop();
}

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_loongsuite-pilot")
}
#[test]
fn native_hook_terminates_entire_process_when_stdin_never_closes() {
    let started = Instant::now();
    let mut child = Command::new(bin())
        .args(["interceptor", "hook", "--agent", "qoder"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap(); // Keep the writer open past the deadline.
    until(|| child.try_wait().unwrap().is_some());
    assert!(started.elapsed() >= Duration::from_millis(2600));
    assert!(started.elapsed() < Duration::from_secs(4));
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
}
#[test]
fn cloud_hook_deadline_and_local_hook_are_independent_of_activity_retry() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let mut policy = qoder_policy(&source);
    policy["hcd"]["agent_configs"]["qoder"]["collection"]["enabled"] = json!(false);
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    ctx.hook_hold.store(true, Ordering::SeqCst);
    let mut host = Host::start(&root.path().join("data"), policy, ctx);
    host.ready();
    let spawn = |channel: &str| {
        let mut child = Command::new(bin())
            .args([
                "sdk-hook",
                "--data-dir",
                root.path().join("data").to_str().unwrap(),
                "--channel",
                channel,
                "--agent",
                "qoder",
                "--event",
                "PreToolUse",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo sdk"}}"#).unwrap();
        child
    };
    let mut clouds = (0..8).map(|_| spawn("cloud")).collect::<Vec<_>>();
    until(|| host.ctx.hook_entered.load(Ordering::SeqCst) == 8);
    let started = Instant::now();
    let output = spawn("local").wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(started.elapsed() < Duration::from_secs(2));
    for mut cloud in clouds.drain(..) {
        until(|| cloud.try_wait().unwrap().is_some());
        assert!(cloud.wait_with_output().unwrap().stdout.is_empty());
    }
    assert_eq!(unsafe { (host.api().stop)(host.handle, 0) }, OK);
    assert_eq!(unsafe { (host.api().destroy)(host.handle) }, BUSY);
    host.ctx.hook_hold.store(false, Ordering::SeqCst);
    host.stop();
}

#[test]
fn c_header_and_real_host_example_match_the_exported_table() {
    // This is an actual foreign C program, not a Rust layout mirror. Windows
    // native CI compiles it with cl.exe in its SDK step.
    if cfg!(windows) {
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let executable = temporary.path().join("host");
    let library = library_path();
    let library_dir = library.parent().unwrap();
    let result = Command::new("cc")
        .args([
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Iinclude",
            "examples/pilot_sdk_host.c",
            "-L",
        ])
        .arg(library_dir)
        .arg("-lloongsuite_pilot")
        .arg(format!("-Wl,-rpath,{}", library_dir.display()))
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let init = temporary.path().join("init.json");
    let policy = temporary.path().join("policy.json");
    std::fs::write(
        &init,
        json!({"data_dir":temporary.path().join("data"),"resource_dir":env!("CARGO_MANIFEST_DIR")})
            .to_string(),
    )
    .unwrap();
    std::fs::write(&policy, empty_policy().to_string()).unwrap();
    let output = Command::new(&executable)
        .arg(init)
        .arg(policy)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn real_codex_transcript_collects_through_the_same_dynamic_abi() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("sessions");
    std::fs::create_dir(&source).unwrap();
    let policy = json!({"agents":["codex"],"hcd":{"agent_configs":{"codex":{"collection":{
        "enabled":true,"profile":"codex_rollout_v1","allowed_roots":[source],
        "sources":[{"id":"rollout","type":"transcript","path":source}],"limits":{"poll_interval_ms":100}
    }}}},"sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let mut host = Host::start(&root.path().join("data"), policy, Box::default());
    host.ready();
    std::thread::sleep(Duration::from_millis(250));
    // Existing checked-in native Codex fixture, created after startup so old
    // history remains baselined according to the production collector contract.
    let fixture=include_str!("fixtures/codex-subagent/rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    std::fs::write(
        source.join("rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
        fixture,
    )
    .unwrap();
    until(|| {
        host.ctx.rows.lock().unwrap().iter().any(|bytes| {
            serde_json::from_slice::<Value>(bytes).is_ok_and(|v| v["event.name"] == "llm.response")
        })
    });
    let rows = host.ctx.rows.lock().unwrap().clone();
    assert!(rows.iter().all(|b| serde_json::from_slice::<Value>(b)
        .is_ok_and(|v| v["event.id"].as_str().is_some_and(|s| !s.is_empty()))));
    host.stop();
}

#[test]
fn invalid_paths_and_profiles_do_not_replace_a_running_policy() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("allowed");
    std::fs::create_dir(&source).unwrap();
    let mut host = Host::start(&root.path().join("data"), empty_policy(), Box::default());
    host.ready();
    let mut policy = qoder_policy(&source);
    policy["hcd"]["agent_configs"]["qoder"]["collection"]["sources"][0]["path"] =
        json!(root.path().join("foreign"));
    assert_eq!(host.apply(policy).0, BAD_ARGUMENT);
    let mut policy = qoder_policy(&source);
    policy["hcd"]["agent_configs"]["qoder"]["collection"]["profile"] = json!("unrecognized");
    assert_eq!(host.apply(policy).0, BAD_ARGUMENT);
    let mut bad = empty_policy();
    bad["sdk_options"] = json!({"hooks":{"local":{"mode":"typo"}}});
    let (code, report) = host.apply(bad);
    assert_eq!(code, BAD_ARGUMENT);
    assert_eq!(report["previous_policy_retained"], true);
    assert_eq!(host.snapshot()["effective_version"], "original");
    host.stop();
}

#[test]
fn start_failure_releases_its_workers_and_preserves_the_original_owner() {
    let root = tempfile::tempdir().unwrap();
    let mut owner = Host::start(root.path(), empty_policy(), Box::default());
    owner.ready();
    let mut other = Host::start(root.path(), empty_policy(), Box::default());
    until(|| {
        other.pump();
        other.ctx.started.load(Ordering::SeqCst) == 1
    });
    assert_eq!(other.ctx.failed.load(Ordering::SeqCst), 1);
    assert_eq!(other.snapshot()["state"], "failed");
    other.stop();
    assert_eq!(owner.snapshot()["state"], "running");
    owner.stop();
}

#[test]
fn sdk_crash_child() {
    let Some(root) = std::env::var_os("PILOT_SDK_CRASH_STATE").map(PathBuf::from) else {
        return;
    };
    let source = root.join("source");
    let context = Box::<Context>::default();
    context.retry.store(true, Ordering::SeqCst);
    let host = Host::start(&root.join("data"), qoder_policy(&source), context);
    host.ready();
    std::thread::sleep(Duration::from_millis(300));
    let file = source.join(format!(
        "qoder-{}.jsonl",
        chrono::Local::now().format("%Y-%m-%d")
    ));
    let event = json!({"event.id":"crash-durable-original","event.name":"llm.request","gen_ai.agent.type":"qoder-cli",
        "gen_ai.session.id":"crash-session","gen_ai.turn.id":"crash-turn","gen_ai.step.id":"crash-step",
        "time_unix_nano":"1780000000000000001","gen_ai.provider.name":"qoder","gen_ai.request.model":"model"});
    writeln!(
        std::fs::OpenOptions::new().append(true).open(file).unwrap(),
        "{event}"
    )
    .unwrap();
    until(|| !host.ctx.rows.lock().unwrap().is_empty());
    std::fs::write(
        root.join("receipt"),
        host.ctx.rows.lock().unwrap()[0].clone(),
    )
    .unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn hard_killed_sdk_replays_its_durable_outbox_without_regenerating_ids() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(
        source.join(format!(
            "qoder-{}.jsonl",
            chrono::Local::now().format("%Y-%m-%d")
        )),
        "",
    )
    .unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "sdk_crash_child", "--nocapture"])
        .env("PILOT_SDK_CRASH_STATE", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let receipt = root.path().join("receipt");
    until(|| {
        assert!(
            child.try_wait().unwrap().is_none(),
            "SDK crash fixture exited before its receipt"
        );
        receipt.is_file()
    });
    let bytes = std::fs::read(receipt).unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    let mut resumed = Host::start(
        &root.path().join("data"),
        qoder_policy(&source),
        Box::default(),
    );
    resumed.ready();
    until(|| !resumed.ctx.rows.lock().unwrap().is_empty());
    assert_eq!(resumed.ctx.rows.lock().unwrap()[0], bytes);
    until(|| resumed.snapshot()["delivery"]["pending_events"] == 0);
    resumed.stop();
}

fn hook_command(data: &Path, channel: &str, event: &str, payload: &Value) -> std::process::Child {
    let mut child = Command::new(bin())
        .args([
            "sdk-hook",
            "--data-dir",
            data.to_str().unwrap(),
            "--channel",
            channel,
            "--agent",
            "qoder",
            "--event",
            event,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();
    child
}
#[test]
fn cloud_and_local_verdicts_use_trusted_capabilities_and_the_existing_qoder_protocol() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let mut policy = json!({"agents":["qoder"],"hcd":{"agent_configs":{"qoder":{"collection":{"enabled":false}}}},
        "sdk_options":{"hooks":{"local":{"mode":"all","types":[]}},"delivery":{"flush_interval_ms":10}}});
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    let payload = json!({"hook_event_name":"PreToolUse","session_id":"security-session","tool_name":"Bash",
        "tool_use_id":"security-tool","tool_input":{"command":"export KEY=sk-1234567890abcdefghijklmnop"},
        "supports_blocking":false,"unknown_u64":18446744073709551615u64});
    for channel in ["cloud", "local"] {
        let output = hook_command(&data, channel, "PreToolUse", &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
        let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            verdict.pointer("/hookSpecificOutput/permissionDecision"),
            Some(&json!("deny"))
        );
    }
    let requests = host.ctx.hook_requests.lock().unwrap().clone();
    assert_eq!(requests[0]["supports_blocking"], true);
    assert_eq!(requests[0]["session_id"], "security-session");
    assert_eq!(
        requests[0]["command"],
        "export KEY=sk-1234567890abcdefghijklmnop"
    );
    assert_eq!(requests[0]["unknown_u64"].as_u64(), Some(u64::MAX));
    policy["sdk_options"]["hooks"]["blocking_agents"] = json!([]);
    assert_eq!(host.apply(policy).0, OK);
    assert!(hook_command(&data, "cloud", "PreToolUse", &payload)
        .wait_with_output()
        .unwrap()
        .stdout
        .is_empty());
    assert_eq!(
        host.ctx.hook_requests.lock().unwrap().last().unwrap()["supports_blocking"],
        false
    );
    host.ctx.hook_invalid.store(true, Ordering::SeqCst);
    assert!(hook_command(&data, "cloud", "PreToolUse", &payload)
        .wait_with_output()
        .unwrap()
        .stdout
        .is_empty());
    host.stop();
}

#[test]
fn missing_sources_wait_without_creating_agent_directories_and_can_be_disabled() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing-agent-source");
    let mut host = Host::start(
        &root.path().join("data"),
        qoder_policy(&missing),
        Box::default(),
    );
    host.ready();
    until(|| {
        host.snapshot()["agents"].as_array().is_some_and(|agents| {
            agents
                .iter()
                .any(|a| a.pointer("/status/reason") == Some(&json!("source_not_found")))
        })
    });
    assert!(!missing.exists());
    assert_eq!(host.apply(empty_policy()).0, OK);
    assert_eq!(host.snapshot()["agents"], json!([]));
    assert!(!missing.exists());
    host.stop();
}

#[test]
fn qoder_native_wakeup_transcript_and_checkpoint_share_the_dynamic_delivery_path() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("transcripts");
    std::fs::create_dir(&source).unwrap();
    let file = source.join("native-session.jsonl");
    let data = root.path().join("data");
    let policy = json!({"agents":["qoder"],"hcd":{"agent_configs":{"qoder":{"collection":{
        "enabled":true,"profile":"qoder_trace_v1","allowed_roots":[source],
        "sources":[{"id":"native","type":"transcript","path":source}],"limits":{"poll_interval_ms":100}
    }}}},"sdk_options":{"hooks":{"blocking_agents":[]},"delivery":{"flush_interval_ms":10}}});
    let mut host = Host::start(&data, policy, Box::default());
    host.ready();
    let mut payload = json!({"hook_event_name":"UserPromptSubmit","session_id":"both-stops-session","transcript_path":file,
        "cwd":root.path(),"parent_business_info":{"product":"cli","version":"sdk-fixture"}});
    assert!(hook_command(&data, "cloud", "UserPromptSubmit", &payload)
        .wait_with_output()
        .unwrap()
        .stdout
        .is_empty());
    std::fs::write(
        &file,
        include_str!("fixtures/qoder/transcript-both-stops.jsonl"),
    )
    .unwrap();
    payload["hook_event_name"] = json!("Stop");
    assert!(hook_command(&data, "cloud", "Stop", &payload)
        .wait_with_output()
        .unwrap()
        .stdout
        .is_empty());
    until(|| {
        host.ctx.rows.lock().unwrap().iter().any(|bytes| {
            serde_json::from_slice::<Value>(bytes).is_ok_and(|v| v["event.name"] == "llm.request")
        })
    });
    assert!(host
        .ctx
        .rows
        .lock()
        .unwrap()
        .iter()
        .any(|bytes| serde_json::from_slice::<Value>(bytes)
            .is_ok_and(|v| v["gen_ai.session.id"] == "both-stops-session"
                && v["event.name"] == "tool.call")));
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
}
