//! Exercise the actual loadable SDK through its C table, without linking its core.
#[path = "../src/sdk/abi.rs"]
pub mod abi;
#[path = "../src/sdk/host_loader.rs"]
pub mod loader;
use abi::*;
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
    hook_delay_ms: AtomicUsize,
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
    let value = serde_json::from_slice::<Value>(unsafe {
        std::slice::from_raw_parts(request.data, request.len)
    })
    .unwrap_or(Value::Null);
    let verdict: &[u8] = if value["kind"] == "managed_local"
        && matches!(
            value["request"]["agent"].as_str(),
            Some("openclaw" | "qwen-work-cn")
        ) {
        let response = value["request"]["toolResponse"].to_string();
        if response.contains("SDK fixture managed block") {
            br#"{"action":"block","matched":true,"reason":"SDK fixture managed rule"}"#
        } else if response.contains("SDK fixture managed log") {
            br#"{"action":"allow","matched":true,"ruleId":"fixture-log","ruleVersion":"1"}"#
        } else {
            br#"{"action":"allow","matched":false}"#
        }
    } else if value["command"] == "echo approved" {
        br#"{"action":"allow"}"#
    } else {
        br#"{"action":"block","reason":"SDK foreign host test"}"#
    };
    c.hook_requests.lock().unwrap().push(value);
    c.hook_entered.fetch_add(1, Ordering::SeqCst);
    while c.hook_hold.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let delay = c.hook_delay_ms.load(Ordering::SeqCst);
    if delay > 0 {
        std::thread::sleep(Duration::from_millis(delay as u64));
    }
    if c.hook_invalid.load(Ordering::SeqCst) {
        unsafe { *len = cap + 1 };
        return OK;
    }
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
    // cargo test links the workspace cdylib in deps. A previous cargo build
    // can leave a different SDK beside the profile binaries.
    [profile.join("deps").join(name), profile.join(name)]
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
        Self::start_with_home(root, None, policy, ctx)
    }

    fn start_with_home(root: &Path, home: Option<&Path>, policy: Value, ctx: Box<Context>) -> Self {
        Self::start_with_init(
            json!({"data_dir":root,"resource_dir":env!("CARGO_MANIFEST_DIR"),"user_id":"sdk-acceptance","home_dir":home}),
            policy,
            ctx,
        )
    }

    fn start_with_init(init: Value, policy: Value, ctx: Box<Context>) -> Self {
        let library = loader::Library::open(&library_path()).unwrap();
        let init = serde_json::to_vec(&init).unwrap();
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

#[test]
fn four_migrated_agents_share_one_sdk_and_resume_independent_cursors() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let data = root.join("sdk");
    let profiles = [
        ("opencode", "opencode_plugin_v1"),
        ("openclaw", "openclaw_plugin_v1"),
        ("cursor", "cursor_hook_v1"),
        ("qwen-work-cn", "qwen_work_cn_trace_v1"),
    ];
    let mut policy = json!({
        "agents": profiles.map(|(agent, _)| agent),
        "hcd": {"agent_configs": {}},
        "sdk_options": {"delivery": {"flush_interval_ms": 10}},
    });
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let log_path = |agent| root.join(agent).join(format!("{agent}-{day}.jsonl"));
    for (agent, profile) in profiles {
        let history = root.join(agent);
        std::fs::create_dir(&history).unwrap();
        std::fs::File::create(log_path(agent)).unwrap();
        policy["hcd"]["agent_configs"][agent] = json!({"collection": {
            "enabled": true,
            "profile": profile,
            "allowed_roots": [history],
            "sources": [{"id": "history", "type":"hook_jsonl", "path": history}],
            "limits": {"poll_interval_ms": 100},
        }});
    }
    let ready = |host: &Host| {
        host.ready();
        until(|| {
            let snapshot = host.snapshot();
            let statuses = snapshot["agents"].as_array().unwrap();
            statuses.len() == profiles.len()
                && statuses
                    .iter()
                    .all(|entry| entry["status"]["state"] == "running")
        });
    };
    let append = |phase| {
        let now = chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap()
            .to_string();
        for (index, (agent, _)) in profiles.iter().enumerate() {
            let row = json!({
                "event.name": "llm.response", "event.id": format!("{agent}-{phase}"),
                "gen_ai.agent.type": agent, "gen_ai.session.id": "same-native-session",
                "gen_ai.turn.id": format!("turn-{phase}"), "gen_ai.step.id": "step",
                "gen_ai.usage.input_tokens": 100 + index,
                "time_unix_nano": now,
            });
            writeln!(
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(log_path(agent))
                    .unwrap(),
                "{row}"
            )
            .unwrap();
        }
    };
    let assert_delivered = |host: &mut Host, phase| {
        until(|| host.ctx.rows.lock().unwrap().len() >= profiles.len());
        until(|| host.snapshot()["delivery"]["pending_events"] == 0);
        host.stop();
        let rows = host.ctx.rows.lock().unwrap();
        assert_eq!(rows.len(), profiles.len());
        for (index, (agent, _)) in profiles.iter().enumerate() {
            let id = format!("{agent}-{phase}");
            let row = rows
                .iter()
                .map(|row| serde_json::from_slice::<Value>(row).unwrap())
                .find(|entry| entry["event.id"] == id)
                .unwrap_or_else(|| panic!("missing {id}"));
            assert_eq!(row["gen_ai.agent.type"], *agent);
            assert_eq!(row["gen_ai.usage.input_tokens"], 100 + index);
        }
    };
    let mut host = Host::start(&data, policy.clone(), Box::default());
    ready(&host);
    append("original");
    assert_delivered(&mut host, "original");
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    ready(&resumed);
    append("resumed");
    assert_delivered(&mut resumed, "resumed");
}

#[test]
fn opencode_profile_delivers_and_resumes_existing_plugin_events() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    std::fs::create_dir(&history).unwrap();
    let data = root.join("instance");
    let policy = json!({"agents":["opencode"],"hcd":{"agent_configs":{"opencode":{"collection":{
        "enabled":true,"profile":"opencode_plugin_v1","allowed_roots":[history],
        "sources":[{"id":"history","type":"hook_jsonl","path":history}],
        "limits":{"poll_interval_ms":100}
    }}}}, "sdk_options":{"delivery":{"flush_interval_ms":10,"retry_initial_ms":20,"retry_max_ms":40}}});
    let day = chrono::Local::now().format("%Y-%m-%d");
    let log = history.join(format!("opencode-{day}.jsonl"));
    std::fs::File::create(&log).unwrap();
    let append = |id: &str| {
        writeln!(
            std::fs::OpenOptions::new().append(true).open(&log).unwrap(),
            "{}",
            json!({"event.id": id, "event.name":"llm.response",
                "gen_ai.agent.type":"opencode","gen_ai.session.id":"sample","gen_ai.turn.id":"turn",
                "gen_ai.step.id":"turn:s1","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":20,
                "time_unix_nano":"1780000000000000000","observed_time_unix_nano":"1780000000000000000"})
        ).unwrap();
    };
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, policy.clone(), ctx);
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    append("sample-first");
    until(|| host.ctx.rows.lock().unwrap().len() >= 2);
    {
        let rows = host.ctx.rows.lock().unwrap();
        assert_eq!(rows[0], rows[1]);
        let row: Value = serde_json::from_slice(&rows[0]).unwrap();
        assert_eq!(row["event.id"], "sample-first");
        assert_eq!(row["gen_ai.usage.input_tokens"], 100);
    }
    host.ctx.retry.store(false, Ordering::SeqCst);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| resumed.snapshot()["agents"][0]["status"]["state"] == "running");
    append("sample-second");
    until(|| {
        resumed.ctx.rows.lock().unwrap().iter().any(|row| {
            serde_json::from_slice::<Value>(row).is_ok_and(|row| row["event.id"] == "sample-second")
        })
    });
    assert!(resumed.ctx.rows.lock().unwrap().iter().all(|row| {
        serde_json::from_slice::<Value>(row).is_ok_and(|row| row["event.id"] != "sample-first")
    }));
    resumed.stop();
}

#[test]
fn opencode_hosted_mask_is_applied_before_activity_is_queued() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    std::fs::create_dir(&history).unwrap();
    let data = root.join("instance");
    let mask = json!({"mode":"custom","types":["apiKey"],"replacementMode":"placeholder"});
    let manifest = json!({"version":1,"rules":[{
        "id":"local-sentinel","type":"apiKey","kind":"regex","replacement":"[LOCAL_MASKED]",
        "prefilter":["private-fixture-"],"pattern":"private-fixture-[0-9]+"
    }]});
    let policy = json!({"agents":["opencode"],"hcd":{"agent_configs":{"opencode":{"collection":{
        "enabled":true,"profile":"opencode_plugin_v1","allowed_roots":[root],
        "sources":[{"id":"history","type":"hook_jsonl","path":history}],
        "limits":{"poll_interval_ms":25},
        "pilot_host":{"data_dir":root,"mask_rule_manifest":manifest}
    }}}}, "sdk_options":{"mask":mask,"delivery":{"flush_interval_ms":10}}});
    let day = chrono::Local::now().format("%Y-%m-%d");
    let log = history.join(format!("opencode-{day}.jsonl"));
    std::fs::File::create(&log).unwrap();
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, policy, ctx);
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    let text = "private-fixture-654321";
    let entry = json!({"event.id":"mask-fixture","event.name":"llm.response",
        "gen_ai.agent.type":"opencode","gen_ai.session.id":"mask-session","gen_ai.turn.id":"mask-turn",
        "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":text}]}],
        "time_unix_nano":"1780000000000000000"});
    std::fs::write(&log, format!("{entry}\n")).unwrap();
    until(|| !host.ctx.rows.lock().unwrap().is_empty());
    let db = rusqlite::Connection::open_with_flags(
        data.join("outbox/delivery.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let payload: Vec<u8> = db
        .query_row("SELECT payload FROM event", [], |row| row.get(0))
        .unwrap();
    let stored = String::from_utf8(payload.clone()).unwrap();
    assert!(stored.contains("[LOCAL_MASKED]"), "{stored}");
    assert!(!stored.contains(text));
    assert_eq!(host.ctx.rows.lock().unwrap()[0], payload);
    host.ctx.retry.store(false, Ordering::SeqCst);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
}

#[test]
fn opencode_history_advances_past_a_record_larger_than_the_poll_budget() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    std::fs::create_dir(&history).unwrap();
    let data = root.join("instance");
    let policy = json!({"agents":["opencode"],"hcd":{"agent_configs":{"opencode":{"collection":{
        "enabled":true,"profile":"opencode_plugin_v1","allowed_roots":[history],
        "sources":[{"id":"history","type":"hook_jsonl","path":history}],
        "limits":{"poll_interval_ms":100,"max_read_bytes":1024}
    }}}}, "sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let day = chrono::Local::now().format("%Y-%m-%d");
    let log = history.join(format!("opencode-{day}.jsonl"));
    std::fs::File::create(&log).unwrap();
    let row = |id: &str, padding: usize| {
        json!({"event.id":id, "event.name":"llm.response",
            "gen_ai.agent.type":"opencode", "gen_ai.session.id":"large-line-session",
            "gen_ai.turn.id":"turn", "gen_ai.step.id":"turn:s1",
            "gen_ai.usage.input_tokens":10, "time_unix_nano":"1780000000000000000",
            "source_padding":"x".repeat(padding)})
    };
    let ids = |host: &Host| {
        host.ctx
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|raw| {
                let row: Value = serde_json::from_slice(raw).unwrap();
                assert_eq!(row["gen_ai.usage.input_tokens"], 10);
                row["event.id"].as_str().unwrap().to_owned()
            })
            .collect::<Vec<_>>()
    };
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    std::fs::write(
        &log,
        format!("{}\n{}\n", row("long", 2048), row("short", 0)),
    )
    .unwrap();
    until(|| ids(&host).len() >= 2);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    assert_eq!(ids(&host), ["long", "short"]);
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| resumed.snapshot()["agents"][0]["status"]["state"] == "running");
    writeln!(
        std::fs::OpenOptions::new().append(true).open(log).unwrap(),
        "{}",
        row("next", 0)
    )
    .unwrap();
    until(|| !ids(&resumed).is_empty());
    resumed.stop();
    assert_eq!(ids(&resumed), ["next"]);
}

fn openclaw_policy(history: &Path) -> Value {
    json!({"agents":["openclaw"],"hcd":{"agent_configs":{"openclaw":{"collection":{
        "enabled":true,"profile":"openclaw_plugin_v1","allowed_roots":[history],
        "sources":[{"id":"history","type":"hook_jsonl","path":history}],
        "limits":{"poll_interval_ms":100}
    }}}}, "sdk_options":{"delivery":{"flush_interval_ms":10,"retry_initial_ms":20,"retry_max_ms":40}}})
}
#[test]
fn openclaw_profile_delivers_and_resumes_existing_plugin_events() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    std::fs::create_dir(&history).unwrap();
    let data = root.join("instance");
    let policy = openclaw_policy(&history);
    let day = chrono::Local::now().format("%Y-%m-%d");
    let log = history.join(format!("openclaw-{day}.jsonl"));
    std::fs::File::create(&log).unwrap();
    let append = |id: &str| {
        writeln!(
            std::fs::OpenOptions::new().append(true).open(&log).unwrap(),
            "{}",
            json!({"event.id": id, "event.name":"llm.response",
                "gen_ai.agent.type":"openclaw","gen_ai.session.id":"sample","gen_ai.turn.id":"turn",
                "gen_ai.step.id":"turn:s1","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":20,
                "time_unix_nano":"1780000000000000000","observed_time_unix_nano":"1780000000000000000"})
        ).unwrap();
    };
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, policy.clone(), ctx);
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    append("sample-first");
    until(|| host.ctx.rows.lock().unwrap().len() >= 2);
    {
        let rows = host.ctx.rows.lock().unwrap();
        assert_eq!(rows[0], rows[1]);
        let row: Value = serde_json::from_slice(&rows[0]).unwrap();
        assert_eq!(row["event.id"], "sample-first");
        assert_eq!(row["gen_ai.usage.input_tokens"], 100);
    }
    host.ctx.retry.store(false, Ordering::SeqCst);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| resumed.snapshot()["agents"][0]["status"]["state"] == "running");
    append("sample-second");
    until(|| {
        resumed.ctx.rows.lock().unwrap().iter().any(|row| {
            serde_json::from_slice::<Value>(row).is_ok_and(|row| row["event.id"] == "sample-second")
        })
    });
    assert!(resumed.ctx.rows.lock().unwrap().iter().all(|row| {
        serde_json::from_slice::<Value>(row).is_ok_and(|row| row["event.id"] != "sample-first")
    }));
    resumed.stop();
}

#[test]
fn openclaw_drains_history_larger_than_one_sdk_memory_budget() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    std::fs::create_dir(&history).unwrap();
    let day = chrono::Local::now().format("%Y-%m-%d");
    let log = history.join(format!("openclaw-{day}.jsonl"));
    let output = "bounded response ".repeat(150);
    let expected = (0..48)
        .map(|number| format!("bulk-response-{number}"))
        .collect::<Vec<_>>();
    let mut file = std::fs::File::create(&log).unwrap();
    for id in &expected {
        let row = json!({
            "event.id":id,"event.name":"llm.response","gen_ai.agent.type":"openclaw",
            "gen_ai.session.id":"sample","gen_ai.turn.id":"turn","gen_ai.step.id":"turn:s1",
            "time_unix_nano":"1780000000000000000","gen_ai.usage.output_tokens":20,
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":output}]}],
        });
        writeln!(file, "{row}").unwrap();
    }
    drop(file);
    let memory_limit = 64 * 1024;
    assert!(std::fs::metadata(&log).unwrap().len() > memory_limit);
    let mut policy = openclaw_policy(&history);
    policy["sdk_options"]["delivery"]["max_batch_bytes"] = json!(memory_limit);
    policy["sdk_options"]["delivery"]["max_event_bytes"] = json!(memory_limit);
    policy["sdk_options"]["delivery"]["queue_memory_bytes"] = json!(memory_limit);
    let mut host = Host::start(&root.join("instance"), policy, Box::default());
    host.ready();
    until(|| host.ctx.rows.lock().unwrap().len() >= expected.len());
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    let rows = host.ctx.rows.lock().unwrap();
    let actual = rows
        .iter()
        .map(|bytes| {
            let row: Value = serde_json::from_slice(bytes).unwrap();
            assert_eq!(row["gen_ai.usage.output_tokens"], 20);
            assert_eq!(
                row["gen_ai.output.messages"][0]["parts"][0]["content"],
                output
            );
            row["event.id"].as_str().unwrap().to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

#[test]
fn openclaw_advances_past_an_oversized_excluded_entry() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    let excluded = root.join("excluded");
    std::fs::create_dir(&history).unwrap();
    std::fs::create_dir(&excluded).unwrap();
    let day = chrono::Local::now().format("%Y-%m-%d");
    let mut file = std::fs::File::create(history.join(format!("openclaw-{day}.jsonl"))).unwrap();
    let memory_limit = 64 * 1024;
    for (id, workspace, output) in [
        ("excluded", &excluded, "x".repeat(memory_limit * 2)),
        ("allowed", &root, "small response".to_owned()),
    ] {
        let row = json!({
            "event.id":id,"event.name":"llm.response","gen_ai.agent.type":"openclaw",
            "gen_ai.session.id":id,"gen_ai.turn.id":"turn","gen_ai.step.id":"turn:s1",
            "time_unix_nano":"1780000000000000000","workspace.path":workspace,
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":output}]}],
        });
        writeln!(file, "{row}").unwrap();
    }
    drop(file);
    let mut policy = openclaw_policy(&history);
    policy["hcd"]["agent_configs"]["openclaw"]["collection"]["pilot_host"] = json!({
        "data_dir": history, "capture_message_content": true, "exclude_workspaces": [excluded],
    });
    policy["sdk_options"]["delivery"]["max_batch_bytes"] = json!(memory_limit);
    policy["sdk_options"]["delivery"]["max_event_bytes"] = json!(memory_limit);
    policy["sdk_options"]["delivery"]["queue_memory_bytes"] = json!(memory_limit);
    let mut host = Host::start(&root.join("instance"), policy, Box::default());
    host.ready();
    until(|| !host.ctx.rows.lock().unwrap().is_empty());
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    let rows = host.ctx.rows.lock().unwrap();
    assert_eq!(rows.len(), 1);
    let row: Value = serde_json::from_slice(&rows[0]).unwrap();
    assert_eq!(row["event.id"], "allowed");
}

#[test]
fn openclaw_history_advances_past_a_record_larger_than_the_poll_budget() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    std::fs::create_dir(&history).unwrap();
    let data = root.join("instance");
    let policy = json!({"agents":["openclaw"],"hcd":{"agent_configs":{"openclaw":{"collection":{
        "enabled":true,"profile":"openclaw_plugin_v1","allowed_roots":[history],
        "sources":[{"id":"history","type":"hook_jsonl","path":history}],
        "limits":{"poll_interval_ms":100,"max_read_bytes":4096}
    }}}}, "sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let day = chrono::Local::now().format("%Y-%m-%d");
    let log = history.join(format!("openclaw-{day}.jsonl"));
    std::fs::File::create(&log).unwrap();
    let row = |id: &str, padding: usize| {
        json!({"event.id":id, "event.name":"llm.response",
            "gen_ai.agent.type":"openclaw", "gen_ai.session.id":"large-line-session",
            "gen_ai.turn.id":"turn", "gen_ai.step.id":"turn:s1",
            "gen_ai.usage.input_tokens":10, "time_unix_nano":"1780000000000000000",
            "source_padding":"x".repeat(padding)})
    };
    let ids = |host: &Host| {
        host.ctx
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|raw| {
                let row: Value = serde_json::from_slice(raw).unwrap();
                assert_eq!(row["gen_ai.usage.input_tokens"], 10);
                row["event.id"].as_str().unwrap().to_owned()
            })
            .collect::<Vec<_>>()
    };
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    std::fs::write(
        &log,
        format!("{}\n{}\n", row("long", 10 * 1024), row("short", 0)),
    )
    .unwrap();
    until(|| ids(&host).len() >= 2);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    assert_eq!(ids(&host), ["long", "short"]);
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| resumed.snapshot()["agents"][0]["status"]["state"] == "running");
    writeln!(
        std::fs::OpenOptions::new().append(true).open(log).unwrap(),
        "{}",
        row("next", 0)
    )
    .unwrap();
    until(|| !ids(&resumed).is_empty());
    resumed.stop();
    assert_eq!(ids(&resumed), ["next"]);
}

#[test]
fn cursor_native_inbox_filters_before_disk_and_recovers_independent_sessions() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let pilot = root.join("pilot");
    let data = pilot.join("state/standalone-cursor-sdk");
    let history = pilot.join("logs/cursor/history");
    std::fs::create_dir_all(&history).unwrap();
    std::fs::create_dir(pilot.join("hooks")).unwrap();
    let config = root.join("cursor-policy.json");
    std::fs::write(
        &config,
        json!({"agents":{
            "cursor":{"captureMessageContent":false},
            "cursor-cli":{"captureMessageContent":true},
        }})
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        pilot.join("hooks/cursor-config-path"),
        json!({"path":config,
        "implicitDefault":false})
        .to_string(),
    )
    .unwrap();
    let queue = |session, generation, version, name, field: &str, value| {
        let mut body = json!({"conversation_id":session,"generation_id":generation,
            "cursor_version":version,"cwd":root,"model":"cursor-test"});
        body[field] = json!(value);
        let reply = sdk_hook_command(&pilot, "observe", "cursor", name, &body)
            .wait_with_output()
            .unwrap();
        assert!(reply.status.success() && reply.stderr.is_empty());
        assert_eq!(String::from_utf8_lossy(&reply.stdout).trim(), "{}");
    };
    let cli = "2026.11.25-abcd";
    let ide = "3.30.14";
    queue(
        "ide-session",
        "a",
        ide,
        "beforeSubmitPrompt",
        "prompt",
        "private-ide",
    );
    queue(
        "cli-session",
        "b",
        cli,
        "beforeSubmitPrompt",
        "prompt",
        "collect-cli",
    );
    queue(
        "ambiguous",
        "c",
        "unknown",
        "beforeSubmitPrompt",
        "prompt",
        "private-ambiguous",
    );
    let (late, guard) = hold_test_rollback_ingress(&root, &pilot);
    queue("cli-session", "b", cli, "stop", "status", "completed");
    queue(
        "ide-session",
        "a",
        ide,
        "afterAgentResponse",
        "text",
        "private-ide-answer",
    );
    queue("ide-session", "a", ide, "stop", "status", "completed");
    queue(
        "cli-session",
        "b",
        cli,
        "afterAgentResponse",
        "text",
        "collect-cli-answer",
    );
    assert_eq!(std::fs::read_dir(&late).unwrap().count(), 4);
    drop(guard);
    let inbox = pilot.join("state/cursor/deferred/inbox");
    let files: Vec<_> = std::fs::read_dir(&inbox)
        .unwrap()
        .chain(std::fs::read_dir(&late).unwrap())
        .map(|f| f.unwrap().path())
        .collect();
    assert_eq!(files.len(), 7);
    for file in files {
        let raw = std::fs::read_to_string(file).unwrap();
        assert!(!raw.contains("private-"));
        let value: Value = serde_json::from_str(&raw).unwrap();
        if value["cursor_hook"]["conversation_id"] != "cli-session" {
            assert_eq!(value["content_omitted"], true);
        }
    }

    let policy = json!({"agents":["cursor"],"hcd":{"agent_configs":{"cursor":{"collection":{
        "enabled":true,"profile":"cursor_hook_v1","allowed_roots":[pilot],
        "sources":[{"id":"history","type":"hook_jsonl","path":history}],
        "limits":{"poll_interval_ms":100},"pilot_host":{"data_dir":pilot}
    }}}},"sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    let response_sessions = |host: &Host| {
        host.ctx
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter_map(|row| {
                let entry: Value = serde_json::from_slice(row).unwrap();
                (entry["event.name"] == "llm.response")
                    .then(|| entry["gen_ai.session.id"].as_str().unwrap().to_owned())
            })
            .collect::<std::collections::BTreeSet<_>>()
    };
    until(|| response_sessions(&host).len() >= 2);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    assert_eq!(std::fs::read_dir(&late).unwrap().count(), 0);
    assert_eq!(
        response_sessions(&host),
        ["cli-session".to_owned(), "ide-session".to_owned()].into()
    );
    let rows = host.ctx.rows.lock().unwrap();
    let ids: std::collections::HashSet<_> = rows
        .iter()
        .map(|row| {
            serde_json::from_slice::<Value>(row).unwrap()["event.id"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(ids.len(), rows.len());
    assert!(rows
        .iter()
        .any(|row| String::from_utf8_lossy(row).contains("collect-cli-answer")));
    assert!(rows
        .iter()
        .all(|row| !String::from_utf8_lossy(row).contains("private-")));
    drop(rows);
    host.stop();
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    queue(
        "after-restart",
        "d",
        cli,
        "beforeSubmitPrompt",
        "prompt",
        "next prompt",
    );
    queue(
        "after-restart",
        "d",
        cli,
        "afterAgentResponse",
        "text",
        "next answer",
    );
    queue("after-restart", "d", cli, "stop", "status", "completed");
    until(|| !response_sessions(&resumed).is_empty());
    assert_eq!(
        response_sessions(&resumed),
        ["after-restart".to_owned()].into()
    );
    resumed.stop();
}

fn hold_test_rollback_ingress(root: &Path, owner: &Path) -> (std::path::PathBuf, std::fs::File) {
    let cache = root.join("rollback-cache");
    let installed = cache.join("versions/native");
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(cache.join("current"), b"native\n").unwrap();
    std::fs::write(
        installed.join("runtime-manifest.json"),
        br#"{"runtime":"rust"}"#,
    )
    .unwrap();
    let late = cache.join(".sdk-hook-rollback-inbox");
    std::fs::create_dir(&late).unwrap();
    std::fs::write(
        owner.join(".sdk-hook-ingress-install.json"),
        json!(cache.canonicalize().unwrap()).to_string(),
    )
    .unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(owner.join(".sdk-hook-ingress.lock"))
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&lock).unwrap();
    (late, lock)
}

#[test]
fn cursor_history_advances_past_a_record_larger_than_the_poll_budget() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    std::fs::create_dir(&history).unwrap();
    let data = root.join("instance");
    let policy = json!({"agents":["cursor"],"hcd":{"agent_configs":{"cursor":{"collection":{
        "enabled":true,"profile":"cursor_hook_v1","allowed_roots":[history],
        "sources":[{"id":"history","type":"hook_jsonl","path":history}],
        "limits":{"poll_interval_ms":100,"max_read_bytes":8388608}
    }}}}, "sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let day = chrono::Local::now().format("%Y-%m-%d");
    let log = history.join(format!("cursor-{day}.jsonl"));
    std::fs::File::create(&log).unwrap();
    let row = |id: &str, padding: usize| {
        json!({"event.id":id, "event.name":"llm.response",
            "gen_ai.agent.type":"cursor", "gen_ai.session.id":"large-line-session",
            "gen_ai.turn.id":"turn", "gen_ai.step.id":"turn:s1",
            "gen_ai.usage.input_tokens":10, "time_unix_nano":"1780000000000000000",
            "source_padding":"x".repeat(padding)})
    };
    let ids = |host: &Host| {
        host.ctx
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|raw| {
                let row: Value = serde_json::from_slice(raw).unwrap();
                assert_eq!(row["gen_ai.usage.input_tokens"], 10);
                row["event.id"].as_str().unwrap().to_owned()
            })
            .collect::<Vec<_>>()
    };
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    std::fs::write(
        &log,
        format!("{}\n{}\n", row("long", 9 * 1024 * 1024), row("short", 0)),
    )
    .unwrap();
    until(|| ids(&host).len() >= 2);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    assert_eq!(ids(&host), ["long", "short"]);
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| resumed.snapshot()["agents"][0]["status"]["state"] == "running");
    writeln!(
        std::fs::OpenOptions::new().append(true).open(log).unwrap(),
        "{}",
        row("next", 0)
    )
    .unwrap();
    until(|| !ids(&resumed).is_empty());
    resumed.stop();
    assert_eq!(ids(&resumed), ["next"]);
}

#[test]
fn qwen_history_and_segments_use_the_dynamic_sdk_with_restart_and_retry() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("history");
    let segments = root.join("segments");
    std::fs::create_dir(&history).unwrap();
    std::fs::create_dir(&segments).unwrap();
    let policy = json!({"version":"qwen-v1","agents":["qwen-work-cn"],
        "hcd":{"agent_configs":{"qwen-work-cn":{"collection":{
            "enabled":true,"profile":"qwen_work_cn_trace_v1",
            "allowed_roots":[history,segments],
            "sources":[{"id":"history","type":"hook_jsonl","path":history},
                       {"id":"segments","type":"segments","path":segments}],
            "limits":{"poll_interval_ms":100}}}}},
        "sdk_options":{"delivery":{"flush_interval_ms":10,"retry_initial_ms":20,"retry_max_ms":40}}});
    let data = root.join("data");
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, policy.clone(), ctx);
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");

    let segment_dir = segments.join("-workspace/session-1/segments");
    std::fs::create_dir_all(&segment_dir).unwrap();
    let segment = [
        json!({"ts":"2026-08-06T06:00:00.000Z","type":"model.request.started",
            "turn_id":"turn-1","request_id":"request-1","data":{"model":"qmodel_latest"}}),
        json!({"ts":"2026-08-06T06:00:05.000Z","type":"model.response.completed",
            "turn_id":"turn-1","request_id":"request-1",
            "data":{"model":"qmodel_latest","input_tokens":100,"output_tokens":20}}),
    ];
    std::fs::write(
        segment_dir.join("run.jsonl"),
        format!("{}\n{}\n", segment[0], segment[1]),
    )
    .unwrap();
    let mut request = json!({"event.id":"qwen-sdk-request","event.name":"llm.request",
        "time_unix_nano":"1785996005000000000","gen_ai.agent.type":"qwen-work-cn",
        "gen_ai.session.id":"session-1","gen_ai.turn.id":"turn-1",
        "gen_ai.step.id":"turn-1:s1","agent.qwenworkcn.cwd":"/workspace"});
    request["gen_ai.request.model"] = json!("unknown");
    let mut response = request.clone();
    response["event.id"] = json!("qwen-sdk-response");
    response["event.name"] = json!("llm.response");
    response["gen_ai.response.id"] = json!("qwen-response-1");
    let history_file = history.join(format!(
        "qwen-work-cn-{}.jsonl",
        chrono::Local::now().format("%Y-%m-%d")
    ));
    std::fs::write(&history_file, format!("{request}\n{response}\n")).unwrap();
    until(|| host.ctx.rows.lock().unwrap().len() >= 4);
    let retry = host.ctx.rows.lock().unwrap().clone();
    assert_eq!(retry[0], retry[2]);
    assert_eq!(retry[1], retry[3]);
    let rows: Vec<Value> = retry[..2]
        .iter()
        .map(|row| serde_json::from_slice(row).unwrap())
        .collect();
    let response = rows
        .iter()
        .find(|row| row["event.id"] == "qwen-sdk-response")
        .unwrap();
    assert_eq!(response["gen_ai.usage.input_tokens"], 100);
    assert_eq!(response["gen_ai.usage.output_tokens"], 20);
    assert_eq!(response["gen_ai.request.model"], "qmodel_latest");
    host.ctx.retry.store(false, Ordering::SeqCst);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| resumed.snapshot()["agents"][0]["status"]["state"] == "running");
    request["event.id"] = json!("qwen-sdk-next");
    request["gen_ai.turn.id"] = json!("turn-2");
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(history_file)
            .unwrap(),
        "{request}"
    )
    .unwrap();
    until(|| !resumed.ctx.rows.lock().unwrap().is_empty());
    let delivered = resumed.ctx.rows.lock().unwrap().clone();
    let ids: Vec<Value> = delivered
        .iter()
        .map(|row| serde_json::from_slice::<Value>(row).unwrap()["event.id"].clone())
        .collect();
    assert_eq!(ids, vec![json!("qwen-sdk-next")]);
    resumed.stop();
}

#[test]
fn qwen_history_and_collaboration_share_sdk_with_independent_recovery() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let history = base.join("history");
    let collaboration = base.join("collaboration");
    let allowed = collaboration.join("test-env/account-a/channel-v1");
    let excluded = collaboration.join("test-env/account-b/channel-v1");
    std::fs::create_dir_all(&history).unwrap();
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::create_dir_all(&excluded).unwrap();
    let policy = json!({"version":"qwen-collaboration","agents":["qwen-work-cn"],
        "hcd":{"agent_configs":{"qwen-work-cn":{"collection":{
            "enabled":true,"profile":"qwen_work_cn_trace_v1",
            "allowed_roots":[history,collaboration],
            "sources":[{"id":"history","type":"hook_jsonl","path":history},
                       {"id":"collaboration","type":"collaboration","path":collaboration}],
            "include_conversation_ids":["allowed"],"capture_message_content":false,
            "limits":{"poll_interval_ms":100}}}}},
        "sdk_options":{"delivery":{"flush_interval_ms":10,"retry_initial_ms":20,"retry_max_ms":40}}});
    let data = base.join("data");
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, policy.clone(), ctx);
    host.ready();
    until(|| {
        let snapshot = host.snapshot();
        snapshot["agents"].as_array().is_some_and(|agents| {
            agents.len() == 2
                && agents
                    .iter()
                    .all(|agent| agent["status"]["state"] == "running")
        })
    });
    let now = chrono::Utc::now().timestamp() + 2;
    let fixture = |conversation: &str, reply: &str| {
        json!({"version":1,"accounts":{"account":{
        "userId":"owner","orgId":"org","messages":{
            "prompt":{"messageId":"prompt","conversationId":conversation,"text":"private prompt",
                "createdAt":{"seconds":now,"nanos":1},"sender":{"id":"owner","type":"HUMAN"}},
            reply:{"messageId":reply,"conversationId":conversation,"replyToMessageId":"prompt",
                "sender":{"id":"agent","type":"AGENT"},"cardRef":{"cardId":"card"}}},
        "cards":{"card":{"cardId":"card","resourceState":"AVAILABLE","contentStatus":"FINAL",
            "messageLink":{"cid":conversation,"messageId":reply},
            "terminalAt":{"seconds":now+1,"nanos":0},"content":"private answer"}}}}})
    };
    std::fs::write(
        allowed.join("state.json"),
        fixture("allowed", "first").to_string(),
    )
    .unwrap();
    std::fs::write(
        excluded.join("state.json"),
        fixture("excluded", "ignored").to_string(),
    )
    .unwrap();
    let history_file = history.join(format!(
        "qwen-work-cn-{}.jsonl",
        chrono::Local::now().format("%Y-%m-%d")
    ));
    let record = json!({"event.id":"qwen-history-independent","event.name":"llm.request",
        "time_unix_nano":"1785996005000000000","gen_ai.agent.type":"qwen-work-cn",
        "gen_ai.session.id":"session-1","gen_ai.turn.id":"turn-1","gen_ai.step.id":"turn-1:s1"});
    std::fs::write(history_file, format!("{record}\n")).unwrap();
    until(|| {
        let rows = host.ctx.rows.lock().unwrap();
        let parsed: Vec<Value> = rows
            .iter()
            .filter_map(|row| serde_json::from_slice(row).ok())
            .collect();
        parsed
            .iter()
            .any(|row| row["event.id"] == "qwen-history-independent")
            && parsed
                .iter()
                .filter(|row| row["agent.source"] == "qwen-work-cn-collaboration")
                .map(|row| row["event.id"].as_str().unwrap_or(""))
                .collect::<std::collections::HashSet<_>>()
                .len()
                == 2
    });
    let retry = host.ctx.rows.lock().unwrap().clone();
    let mut original = std::collections::HashMap::<String, Vec<u8>>::new();
    for row in &retry {
        let value: Value = serde_json::from_slice(row).unwrap();
        let id = value["event.id"].as_str().unwrap().to_owned();
        if let Some(before) = original.insert(id, row.clone()) {
            assert_eq!(&before, row, "RETRY changed delivered bytes");
        }
        assert!(!String::from_utf8_lossy(row).contains("private prompt"));
        assert!(!String::from_utf8_lossy(row).contains("private answer"));
    }
    host.ctx.retry.store(false, Ordering::SeqCst);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
    drop(host);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| {
        resumed.snapshot()["agents"]
            .as_array()
            .is_some_and(|agents| {
                agents.len() == 2
                    && agents
                        .iter()
                        .all(|agent| agent["status"]["state"] == "running")
            })
    });
    std::fs::write(
        allowed.join("state.json"),
        fixture("allowed", "second").to_string(),
    )
    .unwrap();
    until(|| {
        resumed
            .ctx
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|row| {
                serde_json::from_slice::<Value>(row)
                    .is_ok_and(|value| value["agent.source"] == "qwen-work-cn-collaboration")
            })
            .count()
            == 2
    });
    let delivered = resumed.ctx.rows.lock().unwrap();
    assert_eq!(delivered.len(), 2);
    assert!(delivered.iter().all(|row| {
        let value: Value = serde_json::from_slice(row).unwrap();
        !original.contains_key(value["event.id"].as_str().unwrap())
            && !String::from_utf8_lossy(row).contains("private ")
    }));
    drop(delivered);
    resumed.stop();
}

#[test]
fn qwen_passive_prompt_leaves_no_hook_state() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().canonicalize().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"))
        .args([
            "sdk-hook",
            "--data-dir",
            data.to_str().unwrap(),
            "--channel",
            "observe",
            "--agent",
            "qwen-work-cn",
            "--event",
            "UserPromptSubmit",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert!(std::fs::read_dir(data).unwrap().next().is_none());
}

#[test]
fn qwen_stop_accepts_a_replacement_after_the_queued_transcript_is_removed() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let source = root.join("transcripts");
    let data = root.join("data");
    std::fs::create_dir(&source).unwrap();
    let policy = json!({"version":"qwen-replacement","agents":["qwen-work-cn"],
        "hcd":{"agent_configs":{"qwen-work-cn":{"collection":{
            "enabled":true,"profile":"qwen_work_cn_trace_v1","allowed_roots":[source],
            "sources":[{"id":"transcript","type":"transcript","path":source}],
            "limits":{"poll_interval_ms":100}}}}},
        "sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let mut initialized = Host::start(&data, policy.clone(), Box::default());
    initialized.ready();
    initialized.stop();
    drop(initialized);

    let session = "qwen-same-session";
    let publish = |path: &Path| {
        let payload = json!({"hook_event_name":"Stop","session_id":session,
            "transcript_path":path,"cwd":"/workspace"});
        let output = sdk_hook_command(&data, "observe", "qwen-work-cn", "Stop", &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
    };
    let old = source.join("old.jsonl");
    std::fs::write(&old, "{}\n").unwrap();
    publish(&old);
    let wakeups = data.join("wakeups/qwen-work-cn");
    let old_marker = std::fs::read_dir(&wakeups)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::remove_file(&old).unwrap();

    let expired = wakeups.join("000-expired.json");
    let expired_file = std::fs::File::create(&expired).unwrap();
    (&expired_file)
        .write_all(
            &serde_json::to_vec(&json!({"session_id":session,
        "transcript_path":source.join("expired.jsonl"),"snapshot_bytes":1}))
            .unwrap(),
        )
        .unwrap();
    expired_file
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    drop(expired_file);

    let replacement = source.join("replacement.jsonl");
    let before = json!({"type":"user","uuid":"prompt","promptId":"p1","sessionId":session,
        "cwd":"/workspace","message":{"role":"user","content":"replacement prompt"}});
    let after = json!({"type":"assistant","uuid":"response","sessionId":session,
        "cwd":"/workspace","message":{"id":"r1","role":"assistant","model":"qwen-test",
            "content":[{"type":"text","text":"replacement accepted"}],"stop_reason":"end_turn"}});
    std::fs::write(&replacement, format!("{before}\n{after}\n")).unwrap();
    publish(&replacement);
    assert_eq!(std::fs::read_dir(&wakeups).unwrap().count(), 3);

    let mut host = Host::start(&data, policy, Box::default());
    host.ready();
    until(|| {
        host.ctx.rows.lock().unwrap().iter().any(|row| {
            let entry: Value = serde_json::from_slice(row).unwrap();
            entry["event.name"] == "llm.response" && entry["gen_ai.session.id"] == session
        })
    });
    until(|| std::fs::read_dir(&wakeups).unwrap().count() == 1);
    assert!(
        old_marker.is_file(),
        "a new missing marker remains retryable"
    );
    assert!(!expired.exists());
    assert!(replacement.is_file());
    host.stop();
}

#[test]
fn qwen_native_stop_is_durable_while_sdk_is_stopped_and_resumes_after_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let projects = root.join("projects");
    let source = root.join("logs/hooks");
    std::fs::create_dir(&projects).unwrap();
    std::fs::create_dir_all(&source).unwrap();
    let transcript = source.join("session.jsonl");
    let data = root.join("data");
    let user = |turn: &str| {
        json!({"type":"user","uuid":turn,"promptId":turn,
        "sessionId":"sdk-qwen-session","cwd":"/workspace",
        "message":{"role":"user","content":[{"type":"text","text":"private-prompt"}]}})
    };
    let assistant = |turn: &str| {
        json!({"type":"assistant","uuid":format!("{turn}-response"),
        "sessionId":"sdk-qwen-session","cwd":"/workspace",
        "message":{"role":"assistant","id":format!("{turn}-model"),"model":"qwen-test",
            "content":[{"type":"text","text":"private-answer"}]}})
    };
    std::fs::write(
        &transcript,
        format!("{}\n{}\n", user("turn-1"), assistant("turn-1")),
    )
    .unwrap();
    // Many valid short native rows make this Stop larger than the SDK's
    // default 8 MiB read budget without exceeding the per-record limit.
    let padding = json!({"type":"progress","data":"x".repeat(1024)}).to_string();
    {
        let mut transcript = std::io::BufWriter::new(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&transcript)
                .unwrap(),
        );
        for _ in 0..9000 {
            writeln!(transcript, "{padding}").unwrap();
        }
    }
    assert!(std::fs::metadata(&transcript).unwrap().len() > 9 * 1024 * 1024);
    let payload = json!({"hook_event_name":"Stop","session_id":"sdk-qwen-session",
        "transcript_path":transcript,"cwd":"/workspace","prompt":"private-prompt"});
    let publish = || {
        let output = sdk_hook_command(&data, "observe", "qwen-work-cn", "Stop", &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
    };
    publish();
    let wakeups = data.join("wakeups/qwen-work-cn");
    assert!(!wakeups.exists(), "no collection policy must fail closed");
    let policy = json!({"version":"qwen-native","agents":["qwen-work-cn"],
        "hcd":{"agent_configs":{"qwen-work-cn":{"collection":{
            "enabled":true,"profile":"qwen_work_cn_trace_v1","allowed_roots":[projects,source],
            "sources":[{"id":"transcript","type":"transcript","path":projects},
                {"id":"flash-transcript","type":"transcript","path":source}],
            "capture_message_content":false,"limits":{"poll_interval_ms":500}}}}},
        "sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let mut initialized = Host::start(&data, policy.clone(), Box::default());
    initialized.ready();
    initialized.stop();
    drop(initialized);
    publish();
    let saved = std::fs::read_dir(&wakeups)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let marker = std::fs::read_to_string(&saved).unwrap();
    assert!(!marker.contains("private-prompt"));
    // One damaged or unauthorized SDK-owned marker must not permanently
    // block a valid wakeup behind it or delete the external source.
    std::fs::write(wakeups.join("000-invalid.json"), b"{").unwrap();
    let outside = root.join("outside.jsonl");
    std::fs::write(&outside, b"not an authorized source").unwrap();
    std::fs::write(
        wakeups.join("001-outside.json"),
        json!({"session_id":"outside","transcript_path":outside}).to_string(),
    )
    .unwrap();
    let missing = wakeups.join("002-missing.json");
    std::fs::write(
        &missing,
        json!({"session_id":"missing",
        "transcript_path":source.join("missing.jsonl"),"snapshot_bytes":1})
        .to_string(),
    )
    .unwrap();
    // Shut down on the first partial pass. The input keeps the marker while
    // the paused reader is joined, then resumes from the durable boundary.
    let mut interrupted = Host::start(&data, policy.clone(), Box::default());
    interrupted.ready();
    until(|| interrupted.snapshot()["agents"][0]["status"]["state"] == "running");
    assert!(saved.is_file());
    interrupted.stop();
    assert!(saved.is_file());
    assert!(interrupted.ctx.rows.lock().unwrap().is_empty());
    drop(interrupted);

    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    until(|| host.ctx.rows.lock().unwrap().len() >= 3);
    let first = host.ctx.rows.lock().unwrap().clone();
    let event_ids = first
        .iter()
        .map(|row| {
            serde_json::from_slice::<Value>(row).unwrap()["event.id"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        event_ids.len(),
        first.len(),
        "each recovered event was delivered once"
    );
    assert!(first
        .iter()
        .all(|row| !String::from_utf8_lossy(row).contains("private-")));
    assert!(first
        .iter()
        .any(|row| serde_json::from_slice::<Value>(row).unwrap()["event.name"] == "llm.response"));
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    assert!(missing.exists(), "unavailable source must remain retryable");
    std::fs::remove_file(&missing).unwrap();
    until(|| std::fs::read_dir(&wakeups).unwrap().next().is_none());
    assert!(outside.exists());
    host.stop();
    drop(host);

    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap(),
        "{}\n{}",
        user("turn-2"),
        assistant("turn-2")
    )
    .unwrap();
    publish();
    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| resumed.ctx.rows.lock().unwrap().len() >= 3);
    let next = resumed.ctx.rows.lock().unwrap().clone();
    assert!(next
        .iter()
        .all(|row| serde_json::from_slice::<Value>(row).unwrap()["gen_ai.turn.id"] == "turn-2"));
    until(|| std::fs::read_dir(&wakeups).unwrap().next().is_none());
    assert_eq!(resumed.apply(empty_policy()).0, OK);
    publish();
    assert!(std::fs::read_dir(&wakeups).unwrap().next().is_none());
    resumed.stop();
}

#[test]
fn qwen_sdk_can_share_authorized_node_cursor_for_cutover_and_rollback() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let source = root.join("transcripts");
    let old_pilot = root.join("old-pilot");
    let data = root.join("sdk");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(old_pilot.join("state/hooks")).unwrap();
    let transcript = source.join("session.jsonl");
    let user = |turn: &str| {
        json!({"type":"user","uuid":turn,"promptId":turn,
        "sessionId":"shared-session","timestamp":"2026-11-17T10:00:00Z",
        "message":{"role":"user","content":[{"type":"text","text":turn}]}})
    };
    let assistant = |turn: &str| {
        json!({"type":"assistant","uuid":format!("{turn}-answer"),
        "sessionId":"shared-session","timestamp":"2026-11-17T10:00:01Z",
        "message":{"role":"assistant","id":format!("{turn}-model"),"model":"qwen-test",
            "content":[{"type":"text","text":"ok"}]}})
    };
    std::fs::write(
        &transcript,
        format!("{}\n{}\n", user("old"), assistant("old")),
    )
    .unwrap();
    let mut shadow = serde_json::Map::new();
    shadow.insert(
        transcript.to_string_lossy().into_owned(),
        json!({
            "session_id":"shared-session","last_line_count":2,"updated_at":"2026-11-17 10:00:01"
        }),
    );
    std::fs::write(
        old_pilot.join("state/hooks/qwen-work-cn-line-records.json"),
        Value::Object(shadow).to_string(),
    )
    .unwrap();
    let policy = json!({"version":"shared-node-cursor","agents":["qwen-work-cn"],
        "hcd":{"agent_configs":{"qwen-work-cn":{"collection":{
            "enabled":true,"profile":"qwen_work_cn_trace_v1","allowed_roots":[source,old_pilot],
            "sources":[{"id":"transcript","type":"transcript","path":source}],
            "pilot_host":{"data_dir":old_pilot},"limits":{"poll_interval_ms":100}}}}},
        "sdk_options":{"delivery":{"flush_interval_ms":10}}});
    let payload = json!({"hook_event_name":"Stop","session_id":"shared-session",
        "transcript_path":transcript,"cwd":"/tmp"});
    let publish = || {
        let output = sdk_hook_command(&data, "observe", "qwen-work-cn", "Stop", &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
    };
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    publish();
    let wakeups = data.join("wakeups/qwen-work-cn");
    until(|| std::fs::read_dir(&wakeups).unwrap().next().is_none());
    assert!(
        host.ctx.rows.lock().unwrap().is_empty(),
        "old turn must not be replayed"
    );
    host.stop();
    drop(host);
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap(),
        "{}\n{}",
        user("sdk-turn"),
        assistant("sdk-turn")
    )
    .unwrap();
    let (late, guard) = hold_test_rollback_ingress(&root, &data);
    publish();
    assert_eq!(std::fs::read_dir(&wakeups).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(&late).unwrap().count(), 1);
    drop(guard);
    let mut host = Host::start(&data, policy, Box::default());
    host.ready();
    until(|| host.ctx.rows.lock().unwrap().len() >= 3);
    assert_eq!(std::fs::read_dir(&late).unwrap().count(), 0);
    assert!(host
        .ctx
        .rows
        .lock()
        .unwrap()
        .iter()
        .all(|row| serde_json::from_slice::<Value>(row).unwrap()["gen_ai.turn.id"] == "sdk-turn"));
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    until(|| std::fs::read_dir(&wakeups).unwrap().next().is_none());
    host.stop();
    drop(host);

    // The pinned Node release uses this cursor format. Verify bytes written
    // by the SDK, without invoking a retired Rust producer as a Node stand-in.
    let cursor: Value = serde_json::from_slice(
        &std::fs::read(old_pilot.join("state/hooks/qwen-work-cn-line-records.json")).unwrap(),
    )
    .unwrap();
    let shadow = &cursor[transcript.to_string_lossy().as_ref()];
    assert_eq!(shadow["session_id"], "shared-session");
    assert_eq!(shadow["last_line_count"], 4);
    assert!(!old_pilot.join("logs/qwen-work-cn/history").exists());
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
        let output = cloud.wait_with_output().unwrap();
        let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(verdict["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(verdict["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap()
            .contains("Retry the operation"));
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
fn sdk_rejects_invalid_codex_sources_without_replacing_the_running_policy() {
    let root = tempfile::tempdir().unwrap();
    let mut host = Host::start(root.path(), empty_policy(), Box::default());
    host.ready();
    let policy = json!({"agents":["codex"],"hcd":{"agent_configs":{"codex":{"collection":{
        "enabled":true,"profile":"codex_rollout_v1","allowed_roots":[root.path()],
        "sources":[{"id":"rollout","type":"sqlite","path":root.path()}]
    }}}}});
    assert_eq!(host.apply(policy).0, BAD_ARGUMENT);
    assert_eq!(host.snapshot()["effective_version"], "original");

    let output = sdk_hook_command(
        root.path(),
        "cloud",
        "codex",
        "PreToolUse",
        &json!({
            "hook_event_name":"PreToolUse","session_id":"not-an-sdk-agent"
        }),
    )
    .wait_with_output()
    .unwrap();
    assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
    assert_eq!(host.ctx.hook_entered.load(Ordering::SeqCst), 0);

    let mut report = std::ptr::null_mut();
    let mut length = 0;
    let status = unsafe {
        (host.api().host_hook)(
            PilotJsonView::from_bytes(br#"["hook-process","codex","stop"]"#),
            PilotJsonView::from_bytes(b"{}"),
            &mut report,
            &mut length,
        )
    };
    assert_eq!(status, BAD_ARGUMENT);
    assert!(report.is_null() && length == 0);
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
fn sdk_rejects_policy_when_its_legacy_checkpoint_cannot_be_imported() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let sessions = root.join("codex/sessions");
    let pilot = root.join("pilot");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(pilot.join("logs")).unwrap();
    std::fs::write(pilot.join("logs/input-state.json"), "{").unwrap();

    let mut host = Host::start_with_home(
        &root.join("sdk"),
        Some(&root),
        empty_policy(),
        Box::default(),
    );
    host.ready();
    let policy = json!({"version":"invalid-checkpoint","agents":["codex"],"hcd":{"agent_configs":{"codex":{"collection":{
        "enabled":true,"profile":"codex_rollout_v1","allowed_roots":[sessions,pilot],
        "sources":[{"id":"rollout","type":"transcript","path":sessions}],
        "pilot_host":{"data_dir":pilot}
    }}}}});
    let (code, result) = host.apply(policy.clone());
    assert_eq!(code, FAILURE, "invalid checkpoint result: {result}");
    assert!(
        result["reason"].as_str().unwrap().contains("EOF"),
        "{result}"
    );
    assert_eq!(host.snapshot()["effective_version"], "original");

    std::fs::write(pilot.join("logs/input-state.json"), "{}").unwrap();
    let (code, result) = host.apply(policy.clone());
    assert_eq!(code, OK, "repaired checkpoint result: {result}");
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    let namespace = host.snapshot()["agents"][0]["status"]["source_namespace"]
        .as_str()
        .unwrap()
        .to_owned();
    let sdk = root.join("sdk");
    let db = rusqlite::Connection::open(sdk.join("outbox/delivery.sqlite")).unwrap();
    db.execute(
        "INSERT OR REPLACE INTO checkpoint(source,json) VALUES(?1,'{}')",
        [&namespace],
    )
    .unwrap();
    let mirror = sdk
        .join("sources")
        .join(&namespace)
        .join("input-state.json");
    if mirror.exists() {
        std::fs::remove_file(&mirror).unwrap();
    }
    std::fs::create_dir(&mirror).unwrap();
    let mut replacement = policy.clone();
    replacement["version"] = json!("replacement");
    replacement["hcd"]["agent_configs"]["codex"]["collection"]["limits"] =
        json!({"poll_interval_ms":2000});
    let (code, result) = host.apply(replacement.clone());
    assert_eq!(code, FAILURE, "{result}");
    let snapshot = host.snapshot();
    assert_eq!(snapshot["effective_version"], policy["version"]);
    assert_eq!(snapshot["agents"][0]["status"]["state"], "running");
    assert!(mirror.is_dir());
    std::fs::remove_dir(&mirror).unwrap();

    assert_eq!(host.apply(replacement).0, OK);
    host.stop();
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
    sdk_hook_command(data, channel, "qoder", event, payload)
}

fn sdk_hook_command(
    data: &Path,
    channel: &str,
    agent: &str,
    event: &str,
    payload: &Value,
) -> std::process::Child {
    let binary = std::env::var_os("PILOT_TEST_SDK_HOOK")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook").into());
    let mut child = Command::new(binary)
        .args([
            "sdk-hook",
            "--data-dir",
            data.to_str().unwrap(),
            "--channel",
            channel,
            "--agent",
            agent,
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
fn shared_hook_binary_publishes_standalone_qoder_wakeup() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let transcript = root.path().join("session.jsonl");
    std::fs::write(&transcript, "{}\n").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"))
        .args([
            "hook-process",
            "qoder",
            "--wakeup-only",
            "--data-dir",
            data.to_str().unwrap(),
        ])
        .env("LOONGSUITE_PILOT_SDK_LIBRARY", library_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let payload = json!({
        "hook_event_name": "Stop",
        "session_id": "standalone-shared-helper",
        "transcript_path": transcript,
    });
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();

    let result = child.wait_with_output().unwrap();
    assert!(result.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&result.stdout).unwrap(),
        json!({})
    );
    let sources = data.join("state/qoder-transcripts/qoder/sources");
    let entry = std::fs::read_dir(sources).unwrap().next().unwrap().unwrap();
    let source: Value =
        serde_json::from_slice(&std::fs::read(entry.path().join("source.json")).unwrap()).unwrap();
    assert_eq!(source["sessionId"], "standalone-shared-helper");
    assert_eq!(source["event"], "Stop");
}

#[test]
fn shared_hook_binary_publishes_standalone_codex_wakeup() {
    for fault in ["full", "locked", "directory"] {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let home = root.join("codex");
        let sessions = home.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let data = root.join("sdk");
        let state = root.join("pilot");
        let metrics = state.join("state/hook-metrics");
        std::fs::create_dir_all(&metrics).unwrap();
        let spool = metrics.join("codex.jsonl");
        let lock = metrics.join("codex.jsonl.lock");
        let full = "x".repeat(1024 * 1024);
        match fault {
            "full" => std::fs::write(&spool, &full).unwrap(),
            "locked" => std::fs::write(&lock, "holder").unwrap(),
            _ => {
                std::fs::remove_dir(&metrics).unwrap();
                std::fs::write(&metrics, "occupied").unwrap();
            }
        }
        let policy = json!({"agents":["codex"],"hcd":{"agent_configs":{"codex":{"collection":{
            "enabled":true,"profile":"codex_rollout_v1","allowed_roots":[sessions,state],
            "sources":[{"id":"rollout","type":"transcript","path":sessions}],
            "pilot_host":{"data_dir":state}
        }}}}});
        let mut host = Host::start_with_home(&data, Some(&root), policy, Box::default());
        host.ready();
        let session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let transcript = sessions.join(format!("rollout-{session}.jsonl"));
        let input =
            json!({"session_id":session,"turn_id":"fixture-turn","transcript_path":transcript});
        let output = sdk_hook_command(&data, "observe", "codex", "Stop", &input)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
        let marker = state
            .join("state/codex/transcript-wakeups")
            .join(format!("{session}.json"));
        until(|| marker.exists());
        let content: Value = serde_json::from_slice(&std::fs::read(marker).unwrap()).unwrap();
        assert_eq!(content["recovery_turn_id"], "fixture-turn");
        assert_eq!(content["hook_event"], "stop");
        assert_eq!(content["session_dir"], json!(sessions));
        match fault {
            "full" => assert_eq!(std::fs::read_to_string(&spool).unwrap(), full),
            "locked" => assert_eq!(std::fs::read_to_string(&lock).unwrap(), "holder"),
            _ => assert_eq!(std::fs::read_to_string(&metrics).unwrap(), "occupied"),
        }
        host.stop();
    }
}

#[test]
fn native_hook_fails_open_quickly_without_a_live_sdk_port() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let source = root.path().join("source");
    let payload = json!({"hook_event_name":"PreToolUse","tool_name":"Bash",
        "tool_input":{"command":"echo pilot-sdk-port-probe"}});
    let assert_fast_allow = |channel| {
        let started = Instant::now();
        let output = hook_command(&data, channel, "PreToolUse", &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(started.elapsed() < Duration::from_secs(1), "{channel}");
    };
    for channel in ["cloud", "local"] {
        assert_fast_allow(channel);
    }

    let mut policy = qoder_policy(&source);
    policy["hcd"]["agent_configs"]["qoder"]["collection"]["enabled"] = json!(false);
    let mut host = Host::start(&data, policy, Box::default());
    host.ready();
    // A live process and an open UDP socket alone do not prove that the SDK
    // still owns a stale descriptor's port. Neither channel waits for a verdict.
    let unresponsive = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    for channel in ["cloud", "local"] {
        let path = data.join(format!("sdk-hooks-{channel}.json"));
        let original = std::fs::read(&path).unwrap();
        let mut descriptor: Value = serde_json::from_slice(&original).unwrap();
        descriptor["port"] = json!(unresponsive.local_addr().unwrap().port());
        std::fs::write(&path, descriptor.to_string()).unwrap();
        assert_fast_allow(channel);
        std::fs::write(path, original).unwrap();
    }
    assert_eq!(host.ctx.hook_entered.load(Ordering::SeqCst), 0);
    host.stop();
}

#[test]
fn cloud_verdict_uses_trusted_capabilities_and_local_requires_managed_rules() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let mut policy = json!({"agents":["qoder"],"hcd":{"agent_configs":{"qoder":{"collection":{"enabled":false}}}},
        "sdk_options":{"hooks":{"local":{"mode":"all","types":[]}},"delivery":{"flush_interval_ms":10}}});
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    let payload = json!({"hook_event_name":"PreToolUse","session_id":"security-session","tool_name":"Bash",
        "tool_use_id":"security-tool","tool_input":{"command":"export KEY=sk-1234567890abcdefghijklmnop"},
        "supports_blocking":false,"unknown_u64":18446744073709551615u64});
    let output = hook_command(&data, "cloud", "PreToolUse", &payload)
        .wait_with_output()
        .unwrap();
    assert!(output.status.success());
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        verdict.pointer("/hookSpecificOutput/permissionDecision"),
        Some(&json!("deny"))
    );
    let local = hook_command(&data, "local", "PreToolUse", &payload)
        .wait_with_output()
        .unwrap();
    assert!(local.status.success() && local.stdout.is_empty());
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
fn qoder_cli_pre_tool_block_exits_two_and_only_required_checks_refuse_on_failure() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let mut policy = json!({"agents":["qoder"],"hcd":{"agent_configs":{"qoder":{"collection":{"enabled":false}}}},
        "sdk_options":{"hooks":{"local":{"mode":"all","types":[]}},"delivery":{"flush_interval_ms":10}}});
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    let payload = json!({"hook_event_name":"PreToolUse","session_id":"sdk-cli-permissions",
        "tool_use_id":"tool-1","tool_name":"Bash","tool_input":{"command":"export KEY=sk-1234567890abcdefghijklmnop"}});
    let run = |channel| {
        sdk_hook_command(&data, channel, "qodercli", "PreToolUse", &payload)
            .wait_with_output()
            .unwrap()
    };

    let output = run("cloud");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"SDK foreign host test\n");

    let assert_allowed = |output: std::process::Output| {
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    };
    assert_allowed(run("local"));
    assert_allowed(run("observe"));
    host.ctx.hook_invalid.store(true, Ordering::SeqCst);
    let failure = run("cloud");
    assert_eq!(failure.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&failure.stderr).contains("Retry the operation"));
    policy["sdk_options"]["hooks"]["blocking_agents"] = json!([]);
    assert_eq!(host.apply(policy).0, OK);
    assert_allowed(run("cloud"));
    host.stop();
    assert_allowed(run("cloud"));
}

#[test]
fn qoder_cn_native_hook_selects_the_host_surface_and_remains_local() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().canonicalize().unwrap();
    let data = home.join("state/standalone-qoder-cn-sdk");
    let policy = json!({
        "agents": ["qoder-cn"],
        "hcd": {"agent_configs": {"qoder-cn": {"collection": {"enabled": false}}}},
        "sdk_options": {"hooks": {"local": {"mode": "all"}, "pilot_qoder_use_host_collector": {
            "data_dir": home, "capture_message_content": false, "exclude_workspaces": [],
        }}},
    });
    let mut host = Host::start_with_home(&data, Some(&home), policy, Box::default());
    host.ready();
    assert!(data.join("sdk-hooks-local.json").is_file());
    assert!(!data.join("sdk-hooks-cloud.json").exists());
    assert!(!data.join("sdk-hooks-observe.json").exists());

    let run = |event: &str, product: &str| {
        sdk_hook_command(
            &data,
            "local",
            "qoder-cn-auto",
            event,
            &json!({
                "parent_business_info":{"product":product}, "prompt":"block fixture",
                "session_id":"cn-fixture", "tool_name":"Bash", "tool_use_id":"tool-fixture",
            }),
        )
        .wait_with_output()
        .unwrap()
    };
    for (product, decision) in [("app", "block"), ("cli", "deny")] {
        let output = run("UserPromptSubmit", product);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap()["decision"],
            decision
        );
    }
    let pre = run("PreToolUse", "cli");
    assert_eq!(pre.status.code(), Some(2));
    assert!(pre.stdout.is_empty());
    assert!(String::from_utf8_lossy(&pre.stderr).contains("SDK foreign host test"));
    let post = run("PostToolUse", "app");
    assert!(post.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&post.stdout).unwrap()["hookSpecificOutput"]
            ["updatedToolOutput"],
        "SDK foreign host test"
    );
    let managed_agents: Vec<_> = host
        .ctx
        .hook_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request["kind"] == "managed_local")
        .filter_map(|request| request["request"]["agent"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(
        managed_agents,
        ["qoder-cn", "qoderclicn", "qoderclicn", "qoder-cn"]
    );

    until(|| {
        let prompts: Vec<_> = host
            .ctx
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|row| serde_json::from_slice::<Value>(row).unwrap())
            .filter(|row| row["event.name"] == "llm.request")
            .collect();
        if prompts.len() < 2 {
            return false;
        }
        assert_eq!(prompts.len(), 2);
        assert!(prompts
            .iter()
            .all(|row| row["gen_ai.agent.type"] == "qoder-cn"
                && row.get("gen_ai.input.messages").is_none()
                && row.get("gen_ai.input.messages_delta").is_none()));
        true
    });
    host.stop();
    let stopped = run("PreToolUse", "cli");
    assert!(stopped.status.success() && stopped.stdout.is_empty());
}

#[test]
fn explicit_offline_deny_survives_stop_and_is_revoked_by_the_next_policy() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let data = root.path().join("data");
    let mut policy = qoder_policy(&source);
    policy["sdk_options"]["hooks"]["offline_deny"] = json!({"qoder":["PreToolUse"]});

    let run = |channel, event| {
        sdk_hook_command(
            &data,
            channel,
            "qodercli",
            event,
            &json!({
                "hook_event_name":event,"session_id":"offline-fixture",
                "tool_use_id":"tool-fixture","tool_name":"Bash","tool_input":{"command":"true"}
            }),
        )
        .wait_with_output()
        .unwrap()
    };
    let mut host = Host::start(&data, policy.clone(), Box::default());
    host.ready();
    let mut invalid = policy.clone();
    invalid["sdk_options"]["hooks"]["offline_deny"] = json!({"qoder":["Stop"]});
    assert_eq!(host.apply(invalid).0, BAD_ARGUMENT);
    assert_eq!(host.snapshot()["effective_version"], "qoder-v1");

    host.stop();
    let blocked = run("cloud", "PreToolUse");
    assert_eq!(blocked.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("SDK is unavailable"));
    assert!(run("cloud", "UserPromptSubmit").status.success());
    assert!(run("observe", "PreToolUse").status.success());
    assert!(run("local", "PreToolUse").status.success());

    let path = data.join("sdk-offline-deny.json");
    let saved = std::fs::read(&path).unwrap();
    std::fs::write(&path, b"invalid JSON").unwrap();
    assert!(run("cloud", "PreToolUse").status.success());
    std::fs::write(&path, saved).unwrap();
    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    assert_eq!(resumed.apply(empty_policy()).0, OK);
    resumed.stop();
    assert!(run("cloud", "PreToolUse").status.success());
}

#[test]
fn qoder_auto_uses_native_ancestor_and_accepts_event_from_stdin() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let policy = json!({"agents":["qoder"],"hcd":{"agent_configs":{"qoder":{"collection":{"enabled":false}}}}});
    let mut host = Host::start(&data, policy, Box::default());
    host.ready();

    for (name, expected_status) in [("Qoder", "desktop"), ("qodercli-1.1.76", "cli")] {
        let binary = root
            .path()
            .join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        let current = std::env::current_exe().unwrap();
        if std::fs::hard_link(&current, &binary).is_err() {
            std::fs::copy(current, &binary).unwrap();
        }
        let mut command = Command::new(&binary);
        command
            .args(["--exact", "qoder_auto_ancestor_fixture", "--nocapture"])
            .env("PILOT_TEST_QODER_AUTO_DATA", &data)
            .env("PILOT_TEST_QODER_AUTO_SURFACE", expected_status);
        // A parallel test can fork while the cross-device copy has its
        // destination open. Retry only this transient exec race.
        let mut races = 0;
        let output = loop {
            match command.output() {
                Err(error)
                    if error.kind() == std::io::ErrorKind::ExecutableFileBusy && races < 5 =>
                {
                    races += 1;
                    std::thread::sleep(Duration::from_millis(10));
                }
                result => break result.unwrap(),
            }
        };
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
    host.stop();
}

#[test]
fn qoder_auto_ancestor_fixture() {
    let Some(data) = std::env::var_os("PILOT_TEST_QODER_AUTO_DATA") else {
        return;
    };
    let mut hook = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"))
        .arg("sdk-hook")
        .arg("--data-dir")
        .arg(data)
        .args(["--channel", "cloud", "--agent", "qoder-auto"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    hook.stdin.take().unwrap().write_all(
        br#"{"hook_event_name":"PreToolUse","session_id":"auto","tool_name":"Bash","tool_input":{"command":"echo probe"}}"#,
    ).unwrap();
    let output = hook.wait_with_output().unwrap();
    if std::env::var("PILOT_TEST_QODER_AUTO_SURFACE").as_deref() == Ok("cli") {
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(output.stderr, b"SDK foreign host test\n");
        assert!(output.stdout.is_empty());
    } else {
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            verdict.pointer("/hookSpecificOutput/permissionDecision"),
            Some(&json!("deny"))
        );
    }
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
fn full_pilot_sdk_observe_preserves_qoder_wakeup_context() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let data = root.join("pilot");
    let home = root.join("home");
    let sdk = data.join("state/standalone-qoder-sdk");
    std::fs::create_dir_all(&home).unwrap();
    let file = home.join("session.jsonl");
    std::fs::write(&file, "{}\\n").unwrap();
    let policy = json!({
        "agents": ["qoder"],
        "hcd": {"agent_configs":{"qoder":{"collection":{"enabled":false}}}},
        "sdk_options": {"hooks":{"pilot_qoder_use_host_collector":{
            "data_dir":data, "capture_message_content": false
        }}}
    });
    let mut host = Host::start_with_home(&sdk, Some(&home), policy, Box::default());
    host.ready();

    let traceparent = "00-00112233445566778899aabbccddeeff-0123456789abcdef-01";
    #[cfg(unix)]
    let mut command = {
        let hooks = root.join("hooks");
        std::fs::create_dir_all(hooks.join("shared")).unwrap();
        for name in ["qoder-loongsuite-pilot-hook.sh", "shared/native.sh"] {
            std::fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("assets/hooks")
                    .join(name),
                hooks.join(name),
            )
            .unwrap();
        }
        std::fs::write(
            hooks.join("pilot-bin"),
            env!("CARGO_BIN_EXE_loongsuite-pilot"),
        )
        .unwrap();
        let mut command = Command::new("/bin/bash");
        command
            .arg(hooks.join("qoder-loongsuite-pilot-hook.sh"))
            .env("LOONGSUITE_PILOT_DATA_DIR", &data);
        command
    };
    #[cfg(not(unix))]
    let mut command = {
        let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"));
        command
            .args(["sdk-hook", "--channel", "observe", "--agent", "qoder-auto"])
            .arg("--data-dir")
            .arg(&sdk);
        command
    };
    let mut child = command
        .env("TRACEPARENT", traceparent)
        .env("AGENTTEAMS_WORKER_NAME", "sdk-hook-worker")
        .env(
            "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
            "custom.origin=full-hook",
        )
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let payload = json!({
        "session_id":"sdk-full-wakeup",
        "transcript_path":file,
        "hook_event_name":"Stop"
    });
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());

    let source = std::fs::read_dir(data.join("state/qoder-transcripts/qoder/sources"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let wakeup: Value =
        serde_json::from_slice(&std::fs::read(source.join("source.json")).unwrap()).unwrap();
    assert_eq!(wakeup["userIdentity"], json!({"name":"","email":""}));
    assert_eq!(
        wakeup["resourceAttributes"]["agentteams.worker.name"],
        "sdk-hook-worker"
    );
    assert_eq!(wakeup["spanAttributes"]["custom.origin"], "full-hook");
    assert!(host.ctx.hook_requests.lock().unwrap().iter().any(|row| {
        row["kind"] == "qoder_upstream"
            && row["session_id"] == "sdk-full-wakeup"
            && row["traceparent"] == traceparent
    }));
    assert!(!data.join("acp-correlate").exists());
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
        .any(
            |bytes| serde_json::from_slice::<Value>(bytes).is_ok_and(|v| v["gen_ai.session.id"]
                == "both-stops-session"
                && v["gen_ai.agent.id"] == v["gen_ai.session.id"]
                && v["event.name"] == "tool.call"
                && v["workspace.path"] == json!(root.path()))
        ));
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    host.stop();
}

#[test]
fn qoder_native_batch_preserves_activity_across_retry_ack_and_restart() {
    use std::collections::BTreeMap;

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("transcripts");
    std::fs::create_dir(&source).unwrap();
    let file = source.join("native-session.jsonl");
    let data = root.path().join("data");
    let session = "qoder-sdk-batch-session";
    let policy = json!({"agents":["qoder"],"hcd":{"agent_configs":{"qoder":{"collection":{
        "enabled":true,"profile":"qoder_trace_v1","allowed_roots":[source],
        "sources":[{"id":"native","type":"transcript","path":source}],"limits":{"poll_interval_ms":100}
    }}}},"sdk_options":{"hooks":{"blocking_agents":[]},
        "delivery":{"flush_interval_ms":10,"retry_initial_ms":20,"retry_max_ms":40}}});
    let notify = |event| {
        let payload = json!({"hook_event_name":event,"session_id":session,"transcript_path":file,
            "cwd":root.path(),"parent_business_info":{"product":"cli","version":"sdk-fixture"}});
        let output = hook_command(&data, "observe", event, &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
    };
    let append_turn = |turn: u32| {
        notify("UserPromptSubmit");
        // Use the native CLI record shape from the public performance fixture.
        let started = chrono::Utc::now();
        let stamp = |offset| (started + chrono::Duration::milliseconds(offset)).to_rfc3339();
        let progress = |event, offset| json!({"type":"progress","timestamp":stamp(offset),"data":{"hookEvent":event}});
        let tool = format!("tool-{turn}");
        let rows = [
            progress("UserPromptSubmit", 0),
            json!({"type":"user","entrypoint":"cli","uuid":format!("prompt-{turn}"),"timestamp":stamp(1),
                "message":{"role":"user","content":format!("read fixture {turn}")}}),
            json!({"type":"assistant","timestamp":stamp(2),"message":{
                "id":format!("response-{turn}-call"),"role":"assistant","model":"synthetic-model",
                "usage":{"input_tokens":35,"output_tokens":11},
                "content":[{"type":"tool_use","id":tool,"name":"Read","input":{"path":"fixture.txt"}}],
                "stop_reason":"tool_use"}}),
            progress("PreToolUse", 3),
            json!({"type":"user","timestamp":stamp(4),"message":{"role":"user","content":[
                {"type":"tool_result","tool_use_id":tool,"content":format!("fixture result {turn}")}]}}),
            progress("PostToolUse", 5),
            json!({"type":"assistant","timestamp":stamp(6),"message":{
                "id":format!("response-{turn}-final"),"role":"assistant","model":"synthetic-model",
                "usage":{"input_tokens":35,"output_tokens":11},
                "content":[{"type":"text","text":format!("fixture answer {turn}")}],"stop_reason":"end_turn"}}),
            progress("Stop", 7),
            json!({"type":"last-prompt"}),
        ];
        let mut transcript = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .unwrap();
        for row in rows {
            writeln!(transcript, "{row}").unwrap();
        }
        notify("Stop");
    };
    let deliveries = |context: &Context| {
        let mut by_id = BTreeMap::<String, (Vec<u8>, usize)>::new();
        for bytes in context.rows.lock().unwrap().iter() {
            let row: Value = serde_json::from_slice(bytes).unwrap();
            if !matches!(
                row["event.name"].as_str(),
                Some("llm.request" | "llm.response" | "tool.call" | "tool.result")
            ) {
                continue;
            }
            let id = row["event.id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .unwrap();
            let (original, count) = by_id.entry(id.into()).or_insert((bytes.clone(), 0));
            assert_eq!(
                original.as_slice(),
                bytes.as_slice(),
                "retry changed the delivered JSON"
            );
            *count += 1;
        }
        by_id
    };
    let verify_turn = |turn: u32, delivered: &BTreeMap<String, (Vec<u8>, usize)>| {
        let mut kinds = BTreeMap::<String, usize>::new();
        for (bytes, _) in delivered.values() {
            let row: Value = serde_json::from_slice(bytes).unwrap();
            assert_eq!(row["gen_ai.session.id"], session);
            assert!(row["gen_ai.turn.id"]
                .as_str()
                .is_some_and(|id| !id.is_empty()));
            let kind = row["event.name"].as_str().unwrap();
            match kind {
                "llm.request" => assert!(row["gen_ai.input.messages_delta"].is_array()),
                "llm.response" => {
                    assert_eq!(row["gen_ai.usage.input_tokens"], 35);
                    assert_eq!(row["gen_ai.usage.output_tokens"], 11);
                    assert!(row["gen_ai.output.messages"].is_array());
                }
                "tool.call" => {
                    assert_eq!(row["gen_ai.tool.name"], "Read");
                    assert!(row["gen_ai.tool.call.arguments"]
                        .to_string()
                        .contains("fixture.txt"));
                }
                "tool.result" => assert!(row["gen_ai.tool.call.result"]
                    .to_string()
                    .contains(&format!("fixture result {turn}"))),
                _ => unreachable!(),
            }
            *kinds.entry(kind.into()).or_default() += 1;
        }
        assert_eq!(kinds["llm.request"], 2);
        assert_eq!(kinds["llm.response"], 2);
        assert_eq!(kinds["tool.call"], 1);
        assert_eq!(kinds["tool.result"], 1);
    };

    let context = Box::<Context>::default();
    context.retry.store(true, Ordering::SeqCst);
    let mut first = Host::start(&data, policy.clone(), context);
    first.ready();
    append_turn(1);
    until(|| {
        let rows = deliveries(&first.ctx);
        rows.len() >= 6 && rows.values().all(|(_, copies)| *copies >= 2)
    });
    first.stop();
    let initial = deliveries(&first.ctx);
    verify_turn(1, &initial);
    drop(first);

    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| deliveries(&resumed.ctx).len() >= 6);
    until(|| resumed.snapshot()["delivery"]["pending_events"] == 0);
    let replayed = deliveries(&resumed.ctx);
    assert_eq!(replayed.len(), 6);
    for (id, (original, _)) in &initial {
        assert_eq!(replayed.get(id), Some(&(original.clone(), 1)));
    }

    append_turn(2);
    until(|| deliveries(&resumed.ctx).len() >= 12);
    until(|| resumed.snapshot()["delivery"]["pending_events"] == 0);
    resumed.stop();
    let mut combined = deliveries(&resumed.ctx);
    for (id, (original, _)) in initial {
        assert_eq!(combined.remove(&id), Some((original, 1)));
    }
    assert!(combined.values().all(|(_, copies)| *copies == 1));
    verify_turn(2, &combined);
}

#[test]
fn real_library_reports_version_hook_and_durable_usage_without_host_mapping() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let file = source.join(format!(
        "qoder-{}.jsonl",
        chrono::Local::now().format("%Y-%m-%d")
    ));
    std::fs::write(&file, "").unwrap();
    let data = root.path().join("data");
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut policy = qoder_policy(&source);
    policy["sdk_options"]["delivery"]["retry_alarm_after_ms"] = json!(1);
    let mut host = Host::start(&data, policy, ctx);
    host.ready();
    until(|| {
        host.ctx.metrics.lock().unwrap().iter().any(|r| {
            r["event.name"] == "pilot.metrics.l1"
                && r["metric_json"]["cpu_available"] == "true"
                && r["metric_json"]["mem_available"] == "true"
                && r["mem"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .is_some_and(|m| m > 1.0)
        })
    });
    std::thread::sleep(Duration::from_millis(350));
    let record = json!({"event.id":"usage-wire-original","event.name":"llm.response","version":"agent-version","time_unix_nano":"1794066484438000000","gen_ai.agent.type":"qoder","gen_ai.session.id":"wire-session","gen_ai.turn.id":"wire-turn","gen_ai.step.id":"wire-step","gen_ai.response.id":"wire-response","gen_ai.response.model":"model","gen_ai.response.finish_reasons":["stop"],"gen_ai.usage.input_tokens":23,"gen_ai.usage.output_tokens":7,"gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"done"}]}],"gen_ai.sdk_unknown":{"integer":18446744073709551615u64}});
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap(),
        "{record}"
    )
    .unwrap();
    until(|| {
        host.ctx.rows.lock().unwrap().iter().any(|b| {
            serde_json::from_slice::<Value>(b).unwrap()["event.id"] == "usage-wire-original"
        })
    });
    let payload = json!({"hook_event_name":"PreToolUse","session_id":"wire-session","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/sdk-test"}});
    let _ = hook_command(&data, "cloud", "PreToolUse", &payload)
        .wait_with_output()
        .unwrap();
    until(|| {
        host.ctx.metrics.lock().unwrap().iter().any(|r| {
            r["event.name"] == "pilot.metrics.l2"
                && r["hooks"].as_array().is_some_and(|h| {
                    h.iter()
                        .any(|r| r["hook_channel"] == "cloud" && r["hook_event"] == "PreToolUse")
                })
        })
    });
    until(|| {
        host.ctx.metrics.lock().unwrap().iter().any(|r| {
            r["event.name"] == "pilot.token_usage"
                && r["input_tokens_total"] == 23
                && r["llm_responses_total"] == 1
        })
    });
    until(|| {
        host.ctx.metrics.lock().unwrap().iter().any(|r| {
            r["alarm_type"] == "SDK_DELIVERY_RETRY"
                && r["user_id"] == "sdk-acceptance"
                && r.get("alarm_level").is_some()
                && r.get("__time__").is_some()
        })
    });
    let original = host
        .ctx
        .rows
        .lock()
        .unwrap()
        .iter()
        .find(|b| serde_json::from_slice::<Value>(b).unwrap()["event.id"] == "usage-wire-original")
        .unwrap()
        .clone();
    let decoded: Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(decoded["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        decoded["gen_ai.sdk_unknown"]["integer"].as_u64(),
        Some(u64::MAX)
    );
    host.ctx.retry.store(false, Ordering::SeqCst);
    until(|| host.snapshot()["delivery"]["pending_events"] == 0);
    until(|| {
        host.ctx.metrics.lock().unwrap().iter().any(|r| {
            r["event.name"] == "pilot.metrics.l2"
                && r["flushers"].as_array().is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row["flusher"] == "callback"
                            && !row["last_flush_time"].as_str().unwrap_or("").is_empty()
                            && row["total_delay_ms"]
                                .as_str()
                                .and_then(|s| s.parse::<i64>().ok())
                                .unwrap_or(0)
                                > 0
                    })
                })
        })
    });
    host.stop();
    drop(host);
    let mut resumed = Host::start(&data, qoder_policy(&source), Box::default());
    resumed.ready();
    until(|| {
        resumed.ctx.metrics.lock().unwrap().iter().any(|r| {
            r["event.name"] == "pilot.token_usage"
                && r["input_tokens_total"] == 23
                && r["llm_responses_total"] == 1
        })
    });
    resumed.stop();
}

#[cfg(target_os = "macos")]
#[test]
fn macos_foreign_host_releases_all_instance_sockets() {
    let root = tempfile::tempdir().unwrap();
    let probe = root.path().join("sdk-macos-lifecycle");
    let build = Command::new("cc")
        .args([
            "-std=c11",
            "-D_DARWIN_C_SOURCE",
            "-Wall",
            "-Wextra",
            "-Werror",
        ])
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/sdk_macos_lifecycle.c"
        ))
        .arg("-o")
        .arg(&probe)
        .output()
        .unwrap();
    assert!(
        build.status.success(),
        "{}",
        String::from_utf8_lossy(&build.stderr)
    );

    let source = root.path().join("transcripts");
    let home = root.path().join("home");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir(&home).unwrap();
    let library = library_path();
    let copy = root.path().join("copied-sdk.dylib");
    std::fs::copy(&library, &copy).unwrap();
    let init = json!({"data_dir": root.path().join("data"),
                     "resource_dir": env!("CARGO_MANIFEST_DIR"), "home_dir": home});
    for args in [
        vec!["--load-only".to_owned()],
        vec![init.to_string(), qoder_policy(&source).to_string()],
    ] {
        let output = Command::new(&probe)
            .args(args)
            .args([&library, &library, &copy])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }
}

fn hook_trace(data: &Path, file: &str) -> Vec<Value> {
    std::fs::read_to_string(data.join(file))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn cloud_qoder_hook(data: &Path) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"))
        .args([
            "sdk-hook",
            "--data-dir",
            data.to_str().unwrap(),
            "--channel",
            "cloud",
            "--agent",
            "qodercli",
            "--event",
            "PreToolUse",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn send_pre_tool(child: &mut std::process::Child, index: usize) {
    let command = if index.is_multiple_of(2) {
        "echo approved"
    } else {
        "echo declined"
    };
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({
                "hook_event_name":"PreToolUse", "session_id":format!("capacity-{index}"),
                "tool_name":"Bash", "tool_input":{"command":command}
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
}

#[test]
fn fifty_overlapping_cloud_hooks_receive_real_verdicts_with_a_one_second_callback() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let mut policy = qoder_policy(&root.path().join("source"));
    policy["hcd"]["agent_configs"]["qoder"]["collection"]["enabled"] = json!(false);
    let ctx = Box::<Context>::default();
    ctx.hook_delay_ms.store(1000, Ordering::SeqCst);
    let mut host = Host::start(&data, policy, ctx);
    host.ready();

    let mut children: Vec<_> = (0..50).map(|_| cloud_qoder_hook(&data)).collect();
    for (index, child) in children.iter_mut().enumerate() {
        send_pre_tool(child, index);
        // Stagger I/O startup briefly while requiring all 50 to remain in flight.
        if index % 8 == 7 {
            std::thread::sleep(Duration::from_millis(3));
        }
    }
    let outputs: Vec<_> = children
        .into_iter()
        .map(|child| {
            (
                format!("{:08x}", child.id()),
                child.wait_with_output().unwrap(),
            )
        })
        .collect();
    host.stop();

    let logs = hook_trace(&data, "hook-verdict.jsonl");
    let clients = hook_trace(&data, "hook-client.jsonl");
    for (index, (pid, output)) in outputs.iter().enumerate() {
        let client = clients
            .iter()
            .find(|row| row["id"].as_str().is_some_and(|id| id.starts_with(pid)));
        let stages: Vec<_> = logs
            .iter()
            .filter(|row| row["id"].as_str().is_some_and(|id| id.starts_with(pid)))
            .map(|row| (&row["stage"], &row["detail"]))
            .collect();
        let (code, stderr): (i32, &[u8]) = if index.is_multiple_of(2) {
            (0, b"")
        } else {
            (2, b"SDK foreign host test\n")
        };
        assert_eq!(
            output.status.code(),
            Some(code),
            "request {index}: client {client:?}, SDK stages {stages:?}"
        );
        assert_eq!(
            output.stderr, stderr,
            "request {index}: client {client:?}, SDK stages {stages:?}"
        );
        assert!(output.stdout.is_empty(), "request {index}");
    }
    assert_eq!(
        host.ctx.hook_entered.load(Ordering::SeqCst),
        50,
        "SDK stages: {logs:?}, native Hook results: {clients:?}"
    );
    let callbacks = logs
        .iter()
        .filter(|row| row["stage"] == "callback_end")
        .collect::<Vec<_>>();
    assert_eq!(callbacks.len(), 50);
    assert!(callbacks
        .iter()
        .all(|row| row["detail"]["duration_ms"].as_u64().unwrap() >= 1000));
    let first_finish = callbacks
        .iter()
        .map(|row| row["at_unix_ms"].as_i64().unwrap())
        .min()
        .unwrap();
    let overlap = logs
        .iter()
        .filter(|row| {
            row["stage"] == "admitted" && row["at_unix_ms"].as_i64().unwrap() < first_finish
        })
        .count();
    assert_eq!(
        overlap, 50,
        "all requests must be in flight before any callback returns"
    );
    let peak = logs
        .iter()
        .filter_map(|row| row["detail"]["active"].as_u64())
        .max();
    assert_eq!(peak, Some(32));
    let replies = logs
        .iter()
        .filter(|row| row["stage"] == "reply")
        .collect::<Vec<_>>();
    assert_eq!(clients.len(), 50);
    assert_eq!(replies.len(), 50);
    let duration_ms = clients
        .iter()
        .filter_map(|row| row["elapsed_ms"].as_u64())
        .max()
        .unwrap();
    eprintln!("Qoder hook capacity: in-flight overlap={overlap}, worker peak={}, max client elapsed={duration_ms} ms", peak.unwrap());
    assert!(clients.iter().all(
        |client| replies.iter().any(|reply| reply["id"] == client["id"]
            && reply["detail"]["sent"] == true
            && reply["detail"]["status"] == "verdict"
            && client["reply_status"] == "verdict")
    ));
}

#[test]
fn live_cloud_rejects_over_capacity_only_for_required_tool_checks() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let mut policy = qoder_policy(&root.path().join("source"));
    policy["hcd"]["agent_configs"]["qoder"]["collection"]["enabled"] = json!(false);
    let ctx = Box::<Context>::default();
    ctx.hook_hold.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, policy, ctx);
    host.ready();

    let mut children: Vec<_> = (0..64).map(|_| cloud_qoder_hook(&data)).collect();
    for (index, child) in children.iter_mut().enumerate() {
        send_pre_tool(child, index);
    }
    let full = || {
        hook_trace(&data, "hook-verdict.jsonl")
            .iter()
            .any(|row| row["stage"] == "admitted" && row["detail"]["queued"] == 32)
    };
    until(full);

    let started = Instant::now();
    let mut overflow = cloud_qoder_hook(&data);
    send_pre_tool(&mut overflow, 65);
    let overflow = overflow.wait_with_output().unwrap();
    assert_eq!(overflow.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&overflow.stderr).contains("Retry the operation"));
    assert!(started.elapsed() < Duration::from_secs(1));

    let unforced = sdk_hook_command(&data, "cloud", "qodercli", "Stop", &json!({}))
        .wait_with_output()
        .unwrap();
    assert!(unforced.status.success() && unforced.stderr.is_empty());
    assert_eq!(host.ctx.hook_entered.load(Ordering::SeqCst), 32);

    host.ctx.hook_hold.store(false, Ordering::SeqCst);
    for (index, child) in children.into_iter().enumerate() {
        assert_eq!(
            child.wait_with_output().unwrap().status.code(),
            Some(if index.is_multiple_of(2) { 0 } else { 2 })
        );
    }
    host.stop();
    let traces = hook_trace(&data, "hook-verdict.jsonl");
    assert_eq!(
        traces
            .iter()
            .filter(|row| row["detail"]["status"] == "overload")
            .count(),
        2
    );
    assert_eq!(host.ctx.hook_entered.load(Ordering::SeqCst), 64);
    assert_eq!(
        std::fs::read_dir(data.join("hook-requests-cloud"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn cloud_bin_retries_a_lost_first_datagram_with_the_same_request_id() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let mut host = Host::start(&data, empty_policy(), Box::default());
    host.ready();
    let descriptor_path = data.join("sdk-hooks-cloud.json");
    let saved = std::fs::read(&descriptor_path).unwrap();
    let mut descriptor: Value = serde_json::from_slice(&saved).unwrap();
    let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    descriptor["port"] = json!(socket.local_addr().unwrap().port());
    std::fs::write(&descriptor_path, descriptor.to_string()).unwrap();

    let mut child = cloud_qoder_hook(&data);
    send_pre_tool(&mut child, 1);
    let mut buf = [0u8; 4096];
    let (len, first_peer) = socket.recv_from(&mut buf).unwrap();
    let first: Value = serde_json::from_slice(&buf[..len]).unwrap();
    let (len, peer) = socket.recv_from(&mut buf).unwrap();
    let second: Value = serde_json::from_slice(&buf[..len]).unwrap();
    assert_eq!(peer, first_peer);
    assert_eq!(first, second);
    let response = json!({"id": second["id"], "instance": descriptor["instance"],
        "action": "block", "reason": "SDK retry test", "status": "verdict"});
    socket
        .send_to(response.to_string().as_bytes(), peer)
        .unwrap();

    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stderr, b"SDK retry test\n");
    let logs = hook_trace(&data, "hook-client.jsonl");
    assert_eq!(logs.len(), 1);
    assert!(logs[0]["send_attempts"].as_u64().unwrap() >= 2);
    std::fs::write(descriptor_path, saved).unwrap();
    host.stop();
}

#[test]
fn codex_sdk_observe_delivery_retry_and_interception_share_the_native_library() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let sessions = root_path.join("codex/sessions");
    let day = sessions.join("2026/08/07");
    std::fs::create_dir_all(&day).unwrap();
    let data = root_path.join("sdk");
    let session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let rollout = day.join(format!("rollout-2026-08-07T10-00-00-{session}.jsonl"));
    let policy = json!({"agents":["codex"],"hcd":{"agent_configs":{"codex":{"collection":{
        "enabled":true,"profile":"codex_rollout_v1","allowed_roots":[sessions],
        "sources":[{"id":"rollout","type":"transcript","path":sessions}],
        "limits":{"poll_interval_ms":60000},
    }}}},"sdk_options":{"delivery":{"flush_interval_ms":10},"hooks":{
        "local":{"mode":"all"}
    }}});
    let infile = include_str!("fixtures/codex-subagent/rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    let (header, activity) = infile.split_once('\n').unwrap();
    std::fs::write(&rollout, format!("{header}\n")).unwrap();
    let ctx = Box::<Context>::default();
    ctx.retry.store(true, Ordering::SeqCst);
    let mut host = Host::start(&data, policy.clone(), ctx);
    host.ready();
    until(|| host.snapshot()["agents"][0]["status"]["state"] == "running");
    std::fs::OpenOptions::new()
        .append(true)
        .open(&rollout)
        .unwrap()
        .write_all(activity.as_bytes())
        .unwrap();
    let output = sdk_hook_command(
        &data,
        "observe",
        "codex",
        "Stop",
        &json!({"session_id":session,"transcript_path":rollout}),
    )
    .wait_with_output()
    .unwrap();
    assert!(output.status.success() && output.stdout.is_empty());
    until(|| {
        host.snapshot()["delivery"]["pending_events"]
            .as_u64()
            .is_some_and(|count| count > 0)
    });
    until(|| !host.ctx.rows.lock().unwrap().is_empty());
    let original = host.ctx.rows.lock().unwrap()[0].clone();
    let first: Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(first["gen_ai.session.id"], session);
    assert!(first["event.id"].is_string());

    for (channel, event, payload) in [
        (
            "local",
            "UserPromptSubmit",
            json!({"prompt":"LTAI1234567890ABCD"}),
        ),
        (
            "cloud",
            "PreToolUse",
            json!({"tool_name":"Bash","tool_input":{"command":"echo blocked"}}),
        ),
        (
            "local",
            "PostToolUse",
            json!({"tool_name":"Bash","tool_response":"LTAI1234567890ABCD"}),
        ),
    ] {
        let output = sdk_hook_command(&data, channel, "codex", event, &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
        if channel == "cloud" {
            let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(verdict["hookSpecificOutput"]["permissionDecision"], "deny");
        } else {
            assert!(output.stdout.is_empty());
        }
    }
    host.stop();
    let mut resumed = Host::start(&data, policy, Box::default());
    resumed.ready();
    until(|| !resumed.ctx.rows.lock().unwrap().is_empty());
    assert_eq!(resumed.ctx.rows.lock().unwrap()[0], original);
    until(|| resumed.snapshot()["delivery"]["pending_events"] == 0);
    resumed.stop();
}

#[test]
fn codex_sdk_embedded_recovery_uses_one_owner_and_resumes() {
    let fixture = include_str!("unit/inputs/codex-aborted-turn/fixtures/aborted-turn.jsonl");
    for (profile, combined) in [("codex_aborted_turn_v1", false), ("codex_rollout_v1", true)] {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let sessions = root.join("codex/sessions");
        let data = root.join("sdk");
        std::fs::create_dir_all(&sessions).unwrap();
        let mut policy = json!({"agents":["codex"],"hcd":{"agent_configs":{"codex":{"collection":{
            "enabled":true,"profile":profile,"allowed_roots":[sessions],
            "sources":[{"id":"rollout","type":"transcript","path":sessions}],
            "limits":{"poll_interval_ms":50},
        }}}},"sdk_options":{"delivery":{"flush_interval_ms":10}}});
        if combined {
            policy["hcd"]["agent_configs"]["codex"]["collection"]["codex_recovery"] = json!(true);
        }
        let mut host = Host::start(&data, policy.clone(), Box::default());
        host.ready();
        let count = if combined { 2 } else { 1 };
        let started = |host: &Host| {
            let status = host.snapshot();
            let agents = status["agents"].as_array().unwrap();
            agents.len() == count && agents.iter().all(|a| a["status"]["state"] == "running")
        };
        until(|| started(&host));
        let rollout = sessions.join("rollout-session-aborted.jsonl");
        std::fs::write(&rollout, fixture).unwrap();
        let cancelled = |rows: &[Vec<u8>]| {
            rows.iter()
                .map(|row| serde_json::from_slice::<Value>(row).unwrap())
                .filter(|row| {
                    row["event.name"] == "llm.response"
                        && row["gen_ai.response.finish_reasons"]
                            .as_array()
                            .is_some_and(|reasons| reasons.contains(&json!("cancelled")))
                })
                .collect::<Vec<_>>()
        };
        until(|| !cancelled(&host.ctx.rows.lock().unwrap()).is_empty());
        until(|| host.snapshot()["delivery"]["pending_events"] == 0);
        std::thread::sleep(Duration::from_millis(200));
        let rows = cancelled(&host.ctx.rows.lock().unwrap());
        assert_eq!(rows.len(), 1, "{profile} must have one source owner");
        assert_eq!(rows[0]["gen_ai.session.id"], "session-aborted");
        if combined {
            assert_eq!(rows[0]["gen_ai.turn.id"], "session-aborted:turn-aborted");
        } else {
            assert_eq!(
                rows[0]["gen_ai.turn.id"],
                "session-aborted:aborted:turn-aborted"
            );
            assert_eq!(rows[0]["agent.codex.transcript_turn_id"], "turn-aborted");
        }
        host.stop();

        let mut resumed = Host::start(&data, policy, Box::default());
        resumed.ready();
        until(|| started(&resumed));
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            resumed.ctx.rows.lock().unwrap().is_empty(),
            "{profile} replayed an ACKed turn"
        );
        resumed.stop();
    }
}

#[test]
fn codex_management_lists_live_hooks_and_trust_and_clears_after_stop() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let home = root.join("codex");
    let sessions = home.join("sessions");
    let settings = home.join("hooks.json");
    let trust = home.join("config.toml");
    let resources = root.join("package");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(resources.join("bin")).unwrap();
    let binary = Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"));
    std::fs::copy(
        binary,
        resources.join("bin").join(binary.file_name().unwrap()),
    )
    .unwrap();
    let init = json!({"data_dir":root.join("sdk"),"resource_dir":resources,"codex_home":home});
    let plan = json!({"version":"v1","agents":["codex"],"hcd":{"agent_configs":{"codex":{
        "collection":{"enabled":true,"profile":"codex_rollout_v1","allowed_roots":[sessions],
        "sources":[{"id":"rollout","type":"transcript","path":sessions}]},
        "hook_deployment":{"settings_path":settings,"channel":"cloud"}
    }}}});
    let foreign = json!({"type":"command","command":"third-party-hook"});
    std::fs::write(
        &settings,
        json!({"hooks":{"Stop":[{"hooks":[foreign]}]}}).to_string(),
    )
    .unwrap();
    let foreign_key = format!("{}:stop:0:0", settings.display());
    let foreign_trust = format!(
        "[hooks.state.{}]\nenabled = false\ntrusted_hash = 'keep'\n",
        serde_json::to_string(&foreign_key).unwrap()
    );
    std::fs::write(&trust, &foreign_trust).unwrap();
    let mut host = Host::start_with_init(init.clone(), plan.clone(), Box::default());
    host.ready();
    assert_ne!(host.api().capabilities & CAP_CODEX_HOOK_CONTROL, 0);
    let saved_settings = std::fs::read(&settings).unwrap();
    let saved_trust = std::fs::read(&trust).unwrap();
    std::fs::write(&settings, "{invalid").unwrap();
    assert_eq!(host.apply(empty_policy()).0, FAILURE);
    assert_eq!(host.snapshot()["effective_version"], "v1");
    assert_eq!(std::fs::read(&trust).unwrap(), saved_trust);
    std::fs::write(&settings, saved_settings).unwrap();
    assert_eq!(host.apply(plan.clone()).0, OK);
    let request = |op| json!({"hook_management":{"agent":"codex","operation":op}});
    let (code, list) = host.apply(request("list"));
    assert_eq!(code, OK, "{list}");
    let entries = list["hooks"].as_array().unwrap();
    let records = list["trust_records"].as_array().unwrap();
    assert_eq!(entries.len(), 7);
    assert_eq!(records.len(), 7);
    for hook in entries {
        assert!(records
            .iter()
            .any(|r| r["key"] == hook["trust_key"] && r["trusted_hash"].is_string()));
    }
    assert_eq!(host.apply(request("clear")).0, BUSY);
    assert_eq!(unsafe { (host.api().stop)(host.handle, 0) }, OK);
    until(|| {
        host.pump();
        host.ctx.stopped.load(Ordering::SeqCst) == 1
    });
    assert_eq!(host.apply(request("list")).1, list);
    let mut replacement = Host::start_with_init(init, plan, Box::default());
    replacement.ready();
    assert_eq!(host.apply(request("clear")).0, BUSY);
    replacement.stop();
    let mut altered: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    altered["hooks"]["Stop"].as_array_mut().unwrap().swap(0, 1);
    // Another event has a group and handler index but no executable.
    altered["hooks"]["PreToolUse"][0]["hooks"][0] = json!({});
    std::fs::write(&settings, altered.to_string()).unwrap();
    let (code, reordered) = host.apply(request("list"));
    assert_eq!(code, OK);
    let stop = reordered["hooks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["event"] == "Stop")
        .unwrap();
    assert_eq!(stop["group_index"], 0);
    assert!(stop["trust_key"].is_null());
    assert!(reordered["trust_records"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["key"] != foreign_key));
    let before = std::fs::read_to_string(&trust).unwrap();
    let owned_stop = records
        .iter()
        .find(|r| r["key"].as_str().unwrap().ends_with(":stop:1:0"))
        .unwrap();
    let key = owned_stop["key"].as_str().unwrap();
    let quoted = serde_json::to_string(key).unwrap();
    let hash = &owned_stop["trusted_hash"];
    let inline = before.replace(
        &format!("[hooks.state.{quoted}]\ntrusted_hash = {hash}"),
        &format!("[hooks.state]\n{quoted} = {{ trusted_hash = {hash} }}"),
    );
    assert_ne!(inline, before);
    std::fs::write(&trust, &inline).unwrap();
    assert_eq!(host.apply(request("list")).1, reordered);
    let updated = host.apply(request("list")).1;
    assert_eq!(updated["hooks"].as_array().unwrap().len(), 6);
    assert_eq!(updated["trust_records"].as_array().unwrap().len(), 7);
    for _ in 0..2 {
        assert_eq!(host.apply(request("clear")).0, OK);
        let report = host.apply(request("list")).1;
        assert_eq!(report["hooks"], json!([]));
        assert_eq!(report["trust_records"], json!([]));
        assert!(std::fs::read_to_string(&settings)
            .unwrap()
            .contains("third-party-hook"));
        assert!(std::fs::read_to_string(&trust)
            .unwrap()
            .contains(foreign_trust.trim()));
    }
    host.stop();
}

#[test]
fn codex_sdk_deploys_trusted_hooks_and_cleans_only_its_own() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("Codex 用户");
    let sessions = home.join("sessions");
    let settings = home.join("hooks.json");
    let trust = home.join("config.toml");
    let data = root.join("SDK state");
    let resources = root.join("SDK resources");
    std::fs::create_dir_all(&sessions).unwrap();
    let original = json!({"foreign":true,"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"third-party-hook"}]}]}});
    std::fs::write(&settings, original.to_string()).unwrap();
    std::fs::write(&trust, "# user settings\nmodel = 'test-model'\n").unwrap();
    std::fs::create_dir_all(resources.join("bin")).unwrap();
    let binary = Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"));
    std::fs::copy(
        binary,
        resources.join("bin").join(binary.file_name().unwrap()),
    )
    .unwrap();
    let init = json!({"data_dir":data,"resource_dir":resources,"codex_home":home});
    let policy = json!({"version":"codex-managed","agents":["codex"],"hcd":{"agent_configs":{"codex":{
        "collection":{"enabled":true,"profile":"codex_rollout_v1","codex_recovery":true,
            "allowed_roots":[sessions],"sources":[{"id":"rollout","type":"transcript","path":sessions}]},
        "hook_deployment":{"settings_path":settings,"channel":"cloud"}
    }}}});
    let mut host = Host::start_with_init(init.clone(), policy.clone(), Box::default());
    host.ready();
    assert_eq!(
        host.snapshot()["codex_hook_deployment"]["state"],
        "deployed"
    );
    let installed = std::fs::read(&settings).unwrap();
    let trusted = std::fs::read(&trust).unwrap();
    let hooks: Value = serde_json::from_slice(&installed).unwrap();
    assert_eq!(hooks["hooks"]["Stop"][0], original["hooks"]["Stop"][0]);
    let config: toml::Value = std::str::from_utf8(&trusted).unwrap().parse().unwrap();
    assert_eq!(config["hooks"]["state"].as_table().unwrap().len(), 7);
    for (event, payload) in [
        ("UserPromptSubmit", json!({"prompt":"blocked prompt"})),
        (
            "PreToolUse",
            json!({"tool_name":"Bash","tool_input":{"command":"echo blocked"}}),
        ),
        (
            "PostToolUse",
            json!({"tool_name":"Bash","tool_response":"blocked result"}),
        ),
    ] {
        let command = hooks["hooks"][event][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        #[cfg(unix)]
        let mut process = {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", command]);
            c
        };
        #[cfg(windows)]
        let mut process = {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new("cmd.exe");
            assert!(!command.starts_with(r#""\\?\"#), "{command}");
            c.args(["/D", "/S", "/C"]).raw_arg(format!("\"{command}\""));
            c
        };
        let mut child = process
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(result.status.success());
        let verdict: Value = serde_json::from_slice(&result.stdout).unwrap();
        if event == "PreToolUse" {
            assert_eq!(verdict["hookSpecificOutput"]["permissionDecision"], "deny");
        } else {
            assert_eq!(verdict["decision"], "block");
        }
    }
    assert_eq!(host.ctx.hook_requests.lock().unwrap().len(), 3);
    let managed_hook = || {
        let mut child = Command::new(binary)
            .args([
                "sdk-hook",
                "--data-dir",
                data.to_str().unwrap(),
                "--agent",
                "codex",
                "--channel",
                "cloud",
                "--event",
                "PreToolUse",
                "--pilot-sdk-managed",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"tool_name":"Bash","tool_input":{"command":"echo blocked"}}"#)
            .ok();
        child.wait_with_output().unwrap()
    };
    let assert_managed_deny = || {
        let result = managed_hook();
        assert!(result.status.success());
        let output: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "deny");
    };
    let mut same = policy.clone();
    same["version"] = json!("same-channel");
    same["hcd"]["agent_configs"]["codex"]["collection"]["limits"] =
        json!({"poll_interval_ms":2000});
    assert_eq!(host.apply(same).0, OK);
    let journal = data.join("sdk-hook-policy/update-recovery.json");
    std::fs::write(&journal, "{}").unwrap();
    assert_managed_deny();
    let mut local = policy.clone();
    local["version"] = json!("new-channel");
    local["hcd"]["agent_configs"]["codex"]["hook_deployment"]["channel"] = json!("local");
    assert_eq!(host.apply(local.clone()).0, FAILURE);
    assert_eq!(host.snapshot()["effective_version"], "same-channel");
    assert!(journal.exists());
    assert_managed_deny();
    assert_eq!(host.ctx.hook_requests.lock().unwrap().len(), 5);
    std::fs::remove_file(journal).unwrap();
    assert_eq!(host.apply(local).0, OK);
    let stale = managed_hook();
    assert!(stale.status.success() && stale.stdout.is_empty());
    assert_eq!(host.ctx.hook_requests.lock().unwrap().len(), 5);
    host.stop();

    let mut cleanup = Host::start_with_init(init, empty_policy(), Box::default());
    cleanup.ready();
    assert_eq!(
        cleanup.snapshot()["codex_hook_deployment"]["state"],
        "disabled"
    );
    let cleared = std::fs::read(&settings).unwrap();
    let kept = std::fs::read(&trust).unwrap();
    let after: Value = serde_json::from_slice(&cleared).unwrap();
    assert_eq!(after["foreign"], original["foreign"]);
    assert_eq!(after["hooks"]["Stop"], original["hooks"]["Stop"]);
    assert!(!String::from_utf8_lossy(&cleared).contains("--pilot-sdk-managed"));
    assert!(String::from_utf8_lossy(&kept).contains("# user settings"));
    assert!(!String::from_utf8_lossy(&kept).contains("trusted_hash"));
    for _ in 0..6 {
        assert_eq!(cleanup.apply(policy.clone()).0, OK);
        assert_eq!(std::fs::read(&settings).unwrap(), installed);
        assert_eq!(std::fs::read(&trust).unwrap(), trusted);
        assert_eq!(cleanup.apply(empty_policy()).0, OK);
        assert_eq!(std::fs::read(&settings).unwrap(), cleared);
        assert_eq!(std::fs::read(&trust).unwrap(), kept);
    }
    assert_eq!(cleanup.apply(policy.clone()).0, OK);
    let mut with_later_hook: Value =
        serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    let event = &mut with_later_hook["hooks"]["PreToolUse"];
    event.as_array_mut().unwrap().push(json!({
        "matcher":"Bash","hooks":[{"type":"command","command":"another-trusted-tool-hook"}]
    }));
    let foreign = event[1].clone();
    std::fs::write(&settings, with_later_hook.to_string()).unwrap();
    assert_eq!(cleanup.apply(empty_policy()).0, OK);
    let after: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    assert_eq!(
        after["hooks"]["PreToolUse"][1], foreign,
        "foreign trust location moved"
    );
    assert!(after["hooks"]["PreToolUse"][0]["hooks"]
        .as_array()
        .unwrap()
        .is_empty());
    let cleared = std::fs::read(&settings).unwrap();
    assert_eq!(cleanup.apply(policy).0, OK);
    assert_eq!(cleanup.apply(empty_policy()).0, OK);
    assert_eq!(std::fs::read(&settings).unwrap(), cleared);
    cleanup.stop();
}

#[test]
fn openclaw_native_local_command_preserves_allow_block_and_unavailable_behavior() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("sdk");
    let policy = json!({
        "agents": ["openclaw"],
        "hcd": {"agent_configs": {"openclaw": {"collection": {"enabled": false}}}},
        "sdk_options": {"hooks": {"local": {"mode": "all", "types": []}}},
    });
    let mut host = Host::start(&data, policy, Box::default());
    host.ready();
    let call = |content: &str| {
        let payload = json!({"openclaw_hook":"tool_result_persist","session_id":"native-edge","tool_name":"read","tool_response":content});
        sdk_hook_command(&data, "local", "openclaw", "PostToolUse", &payload)
            .wait_with_output()
            .unwrap()
    };
    let allowed = call("ordinary tool result");
    assert!(allowed.status.success());
    assert!(allowed.stdout.is_empty());
    assert!(call("LTAI1234567890ABCD").stdout.is_empty());
    let denied = call("SDK fixture managed block");
    assert!(denied.status.success());
    let post: Value = serde_json::from_slice(&denied.stdout).unwrap();
    assert!(post["action"] == "block");
    assert!(post.to_string().contains("SDK fixture managed rule"));
    host.stop();
    let offline = call("SDK fixture managed block");
    assert!(offline.status.success());
    assert!(offline.stdout.is_empty());
}

#[test]
fn openclaw_native_post_tool_audits_coalesce_only_two_clean_allows() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("sdk");
    let policy = json!({
        "agents": ["openclaw"],
        "hcd": {"agent_configs": {"openclaw": {"collection": {"enabled": false}}}},
        "sdk_options": {
            "delivery": {"flush_interval_ms": 1},
            "hooks": {"local": {"mode": "all", "types": []}},
        },
    });
    let mut host = Host::start(&data, policy, Box::default());
    host.ready();
    let call = |hook: &str, session: &str, key: &str, response: Value| {
        let payload = json!({
            "openclaw_hook": hook, "session_id": session, "tool_use_id": "test-call",
            "tool_name": "read", "tool_response": response, "openclaw_post_tool_audit_key": key,
        });
        let output = sdk_hook_command(&data, "local", "openclaw", "PostToolUse", &payload)
            .wait_with_output()
            .unwrap();
        assert!(output.status.success());
        output.stdout
    };
    let audits = || {
        host.ctx
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter_map(|row| serde_json::from_slice::<Value>(row).ok())
            .filter(|row| row["event.kind"] == "interceptor.result")
            .collect::<Vec<_>>()
    };
    let remembered = "a".repeat(64);
    let other = "b".repeat(64);
    let result = json!({
        "content": [{"type": "text", "text": "ordinary"}], "details": {"elapsed": 1},
    });
    let mut message = result.clone();
    message["role"] = json!("toolResult");
    message["toolCallId"] = json!("test-call");
    message["toolName"] = json!("read");
    message["isError"] = json!(false);
    message["timestamp"] = json!(1000);
    message["__openclaw"] = json!({"runId": "run-1"});
    assert!(call("tool_result_middleware", "first", &remembered, result).is_empty());
    until(|| {
        audits()
            .iter()
            .any(|row| row["gen_ai.session.id"] == "first")
    });
    assert!(call(
        "tool_result_persist",
        "other-session",
        &remembered,
        message.clone()
    )
    .is_empty());
    let denied = call(
        "tool_result_persist",
        "first",
        &remembered,
        json!({"details": {"nested":["SDK fixture managed block"]}}),
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&denied).unwrap()["action"],
        "block"
    );
    assert!(call("tool_result_persist", "", &remembered, message).is_empty());
    assert!(call("tool_result_persist", "unpaired", &other, json!("ordinary")).is_empty());
    assert!(call(
        "tool_result_persist",
        "consumed",
        &remembered,
        json!("ordinary")
    )
    .is_empty());
    let log_key = "c".repeat(64);
    for hook in ["tool_result_middleware", "tool_result_persist"] {
        assert!(call(hook, "logged", &log_key, json!("SDK fixture managed log")).is_empty());
    }
    until(|| {
        let rows = audits();
        ["first", "other-session", "unpaired", "consumed"]
            .into_iter()
            .all(|session| rows.iter().any(|row| row["gen_ai.session.id"] == session))
            && rows.iter().any(|row| row["hook.action"] == "block")
            && rows
                .iter()
                .filter(|row| row["gen_ai.session.id"] == "logged")
                .count()
                == 2
    });
    // Both paired callbacks receive real SDK verdicts. Only the second
    // identical clean allow omits its extra interceptor.result event.
    let replies = || {
        hook_trace(&data, "hook-verdict.jsonl")
            .into_iter()
            .filter(|row| row["stage"] == "reply")
            .collect::<Vec<_>>()
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    while replies().len() < 8 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let replies = replies();
    assert_eq!(replies.len(), 8, "SDK replies: {replies:?}");
    assert!(
        replies
            .iter()
            .all(|row| row["detail"]["status"] == "verdict"),
        "SDK replies: {replies:?}"
    );
    assert_eq!(audits().len(), 7, "paired clean allows produced two audits");
    host.stop();
}

#[test]
fn qwen_work_cn_native_local_command_preserves_allow_block_and_unavailable_behavior() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("sdk");
    let policy = json!({
        "agents": ["qwen-work-cn"],
        "hcd": {"agent_configs": {"qwen-work-cn": {"collection": {"enabled": false}}}},
        "sdk_options": {"hooks": {"local": {"mode": "all", "types": []}}},
    });
    let mut host = Host::start(&data, policy, Box::default());
    host.ready();
    let call = |content: &str| {
        let payload =
            json!({"session_id":"native-edge","tool_name":"read","tool_response":content});
        sdk_hook_command(&data, "local", "qwen-work-cn", "PostToolUse", &payload)
            .wait_with_output()
            .unwrap()
    };
    let allowed = call("ordinary tool result");
    assert!(allowed.status.success());
    assert!(allowed.stdout.is_empty());
    assert!(call("SDK fixture managed log").stdout.is_empty());
    assert!(call("LTAI1234567890ABCD").stdout.is_empty());
    let denied = call("SDK fixture managed block");
    assert!(denied.status.success());
    let post: Value = serde_json::from_slice(&denied.stdout).unwrap();
    assert!(post["hookSpecificOutput"]["hookEventName"] == "PostToolUse");
    assert!(post.to_string().contains("SDK fixture managed rule"));
    host.stop();
    let offline = call("SDK fixture managed block");
    assert!(offline.status.success());
    assert!(offline.stdout.is_empty());
}
