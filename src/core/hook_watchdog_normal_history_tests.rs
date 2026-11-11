//! Frozen ef8953 hook-watchdog contracts through real settings files and processes.
use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Barrier, Condvar};

fn config() -> HookWatchdogConfig {
    HookWatchdogConfig {
        enabled: true,
        interval_ms: 60_000,
        repair_cooldown_ms: 600_000,
    }
}
const EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "PreCompact",
    "SubagentStart",
    "SubagentStop",
    "Notification",
];
struct Fixture {
    root: tempfile::TempDir,
    path: PathBuf,
    calls: Arc<AtomicUsize>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".claude").join("settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        Self {
            root,
            path,
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn target(&self) -> PluginCheckTarget {
        let calls = self.calls.clone();
        PluginCheckTarget {
            agent_id: "claude-code".into(),
            settings_path: self.path.to_string_lossy().into_owned(),
            settings_syntax: JsonSyntax::Json,
            expected_hooks: EVENTS.iter().map(|s| s.to_string()).collect(),
            markers: vec!["otel-claude-hook".into(), "hook-entry.sh".into()],
            bin_path: None,
            install_args: Vec::new(),
            repair_fn: Some(Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(true) })
            })),
            needs_repair: None,
            change_watch_path: None,
            needs_repair_on_change: None,
            enabled: None,
        }
    }
    fn write(&self, value: &Value) {
        std::fs::write(&self.path, value.to_string()).unwrap();
    }
    fn healthy(&self) -> Value {
        let hooks = EVENTS.iter().map(|e| (e.to_string(), json!([{"matcher":"*", "hooks":[{"type":"command", "command":"bash /fixture/otel-claude-hook"}]}]))).collect::<serde_json::Map<_, _>>();
        json!({"theme":"foreign-preserved", "hooks": hooks})
    }
    fn wd(&self, target: PluginCheckTarget) -> HookWatchdog {
        HookWatchdog::new(config(), vec![target], Vec::new())
    }
    fn count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}
fn summary(checked: u64, repaired: u64, skipped: u64) -> CheckResult {
    CheckResult {
        checked,
        repaired,
        skipped,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lifecycle_stop_during_startup_check_cannot_publish_a_new_interval() {
    assert_eq!(STARTUP_DELAY_MS, 30_000);
    let entered = Arc::new((Mutex::new(false), Condvar::new()));
    let release = Arc::new(Barrier::new(2));
    let seen = entered.clone();
    let gate = release.clone();
    let target = InterceptCheckTarget {
        id: "isolated-startup-stop-race".into(),
        enabled: Arc::new(|| true),
        precondition: Arc::new(|| Box::pin(async { true })),
        check: Arc::new(move || {
            let seen = seen.clone();
            let gate = gate.clone();
            Box::pin(async move {
                *seen.0.lock().unwrap() = true;
                seen.1.notify_one();
                gate.wait();
                true
            })
        }),
        repair: Arc::new(|| Box::pin(async { panic!("healthy target cannot repair") })),
        cleanup: None,
    };
    let wd = Arc::new(HookWatchdog::new(config(), Vec::new(), vec![target]));
    let started = std::time::Instant::now();
    wd.start();
    let (lock, cv) = &*entered;
    let ready = cv
        .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(35), |v| !*v)
        .unwrap();
    let reached = *ready.0;
    drop(ready);
    if !reached {
        wd.stop();
        panic!("actual 30s startup check never entered");
    }
    assert!(started.elapsed() >= Duration::from_secs(30));
    wd.stop();
    release.wait();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let leaked = wd.interval.lock().unwrap().is_some();
    wd.stop();
    assert!(
        !leaked,
        "stop during an in-flight startup check must not publish a fresh periodic task"
    );
}

const COMMAND_CHILD: &str =
    "core::hook_watchdog::normal_history_tests::native_repair_command_fixture";
#[test]
fn native_repair_command_fixture() {
    let args = std::env::args().collect::<Vec<_>>();
    let Some(payload) = args
        .iter()
        .find_map(|s| s.strip_prefix("pilot-hook-fixture:"))
    else {
        return;
    };
    let spec: Value = serde_json::from_str(payload).unwrap();
    let file = Path::new(spec["record"].as_str().unwrap());
    let mut stream = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .unwrap();
    use std::io::Write;
    writeln!(stream, "{}", json!({"pid":std::process::id(),"args":args})).unwrap();
    stream.sync_all().unwrap();
    std::process::exit(spec["exit"].as_i64().unwrap() as i32);
}
impl Fixture {
    fn command(&self, code: i32) -> PluginCheckTarget {
        let mut target = self.target();
        target.repair_fn = None;
        target.bin_path = Some(
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        target.install_args = vec![
            "--exact".into(),
            COMMAND_CHILD.into(),
            "--nocapture".into(),
            "--skip".into(),
            format!(
                "pilot-hook-fixture:{}",
                json!({"record":self.root.path().join("native child argv.jsonl"),"exit":code,"argument":"value with spaces & $ literal"})
            ),
        ];
        target
    }
    fn native_rows(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("native child argv.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn assert_argv(&self, target: &PluginCheckTarget) {
        let rows = self.native_rows();
        assert_eq!(rows.len(), 1);
        let args = rows[0]["args"].as_array().unwrap();
        assert_eq!(args[0], target.bin_path.as_deref().unwrap());
        assert_eq!(
            args[1..],
            target
                .install_args
                .iter()
                .map(|s| Value::String(s.clone()))
                .collect::<Vec<_>>()
        );
        assert_ne!(rows[0]["pid"], std::process::id());
    }
}
#[tokio::test]
async fn normal_l120_all_expected_hooks_present_do_not_spawn() {
    let f = Fixture::new();
    f.write(&f.healthy());
    let t = f.command(0);
    assert_eq!(f.wd(t).run_check().await, summary(1, 0, 0));
    assert!(f.native_rows().is_empty());
}
#[tokio::test]
async fn normal_l133_qwen_jsonc_retains_healthy_hook_and_model() {
    let f = Fixture::new();
    let mut t = f.target();
    t.agent_id = "qwen-code-cli".into();
    t.settings_syntax = JsonSyntax::Jsonc;
    t.expected_hooks = vec!["Stop".into()];
    t.markers = vec!["qwen-code-cli-loongsuite-pilot-hook.sh".into()];
    let body="{ // official JSONC\n\"model\":\"qwen-max\", \"hooks\":{\"Stop\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"/opt/qwen-code-cli-loongsuite-pilot-hook.sh stop\"}]}]}}\n";
    std::fs::write(&f.path, body).unwrap();
    assert_eq!(f.wd(t).run_check().await, summary(1, 0, 0));
    assert_eq!(f.count(), 0);
    assert_eq!(std::fs::read_to_string(&f.path).unwrap(), body);
}
#[tokio::test]
async fn normal_l172_missing_hook_invokes_actual_native_binary_and_exact_argv() {
    let f = Fixture::new();
    let mut settings = f.healthy();
    settings["hooks"].as_object_mut().unwrap().remove("Stop");
    f.write(&settings);
    let t = f.command(0);
    let wd = f.wd(t);
    let target = &wd.targets[0];
    let result = wd.check_target(target).await.unwrap();
    assert_eq!(result.status, TargetStatus::Repaired);
    assert_eq!(result.missing, ["Stop"]);
    f.assert_argv(target);
    assert_eq!(
        std::fs::read_to_string(&f.path).unwrap(),
        settings.to_string()
    );
}
#[tokio::test]
async fn normal_l191_empty_event_array_is_missing() {
    let f = Fixture::new();
    let mut settings = f.healthy();
    settings["hooks"]["PreToolUse"] = json!([]);
    f.write(&settings);
    let wd = f.wd(f.target());
    let result = wd.check_target(&wd.targets[0]).await.unwrap();
    assert_eq!(result.missing, ["PreToolUse"]);
    assert_eq!(result.status, TargetStatus::Repaired);
    assert_eq!(f.count(), 1);
}
#[tokio::test]
async fn normal_l205_foreign_commands_do_not_satisfy_owned_hook() {
    let f = Fixture::new();
    let mut settings = f.healthy();
    settings["hooks"]["UserPromptSubmit"] =
        json!([{"type":"command","command":"bash /some/other/tool.sh"}]);
    f.write(&settings);
    let wd = f.wd(f.target());
    let result = wd.check_target(&wd.targets[0]).await.unwrap();
    assert_eq!(result.missing, ["UserPromptSubmit"]);
    assert_eq!(f.count(), 1);
    assert_eq!(
        std::fs::read_to_string(&f.path).unwrap(),
        settings.to_string()
    );
}
#[tokio::test]
async fn normal_l223_actual_command_is_not_repeated_inside_original_cooldown() {
    let f = Fixture::new();
    f.write(&json!({"hooks":{}}));
    let t = f.command(0);
    let mut cfg = config();
    cfg.repair_cooldown_ms = 60_000_000;
    let wd = HookWatchdog::new(cfg, vec![t], Vec::new());
    assert_eq!(wd.run_check().await, summary(0, 1, 0));
    assert_eq!(
        wd.check_target(&wd.targets[0]).await.unwrap().status,
        TargetStatus::Cooldown
    );
    assert_eq!(wd.run_check().await.repaired, 0);
    f.assert_argv(&wd.targets[0]);
}
#[tokio::test]
async fn normal_l249_missing_native_binary_is_unavailable_without_spawn() {
    let f = Fixture::new();
    f.write(&f.healthy());
    let mut t = f.command(0);
    t.bin_path = Some(
        f.root
            .path()
            .join("missing native program")
            .to_string_lossy()
            .into_owned(),
    );
    assert_eq!(f.wd(t).run_check().await, summary(0, 0, 1));
    assert!(f.native_rows().is_empty());
}
#[tokio::test]
async fn normal_l261_missing_settings_parent_is_unavailable() {
    let f = Fixture::new();
    let mut t = f.command(0);
    t.settings_path = f
        .root
        .path()
        .join("absent-parent")
        .join("settings.json")
        .to_string_lossy()
        .into_owned();
    assert_eq!(f.wd(t).run_check().await, summary(0, 0, 1));
    assert!(f.native_rows().is_empty());
}
#[tokio::test]
async fn normal_l275_existing_parent_and_absent_settings_repair_all_hooks() {
    let f = Fixture::new();
    assert!(!f.path.exists());
    let wd = f.wd(f.command(0));
    let r = wd.check_target(&wd.targets[0]).await.unwrap();
    assert_eq!(r.status, TargetStatus::Repaired);
    assert_eq!(r.missing, EVENTS);
    f.assert_argv(&wd.targets[0]);
}
#[tokio::test]
async fn normal_l290_disabled_command_target_never_injects() {
    let f = Fixture::new();
    f.write(&json!({"hooks":{}}));
    let mut t = f.command(0);
    t.enabled = Some(Arc::new(|| false));
    assert_eq!(f.wd(t).run_check().await, summary(0, 0, 1));
    assert!(f.native_rows().is_empty());
}
#[tokio::test]
async fn normal_l306_disabled_callback_target_is_not_repaired() {
    let f = Fixture::new();
    let mut t = f.target();
    t.enabled = Some(Arc::new(|| false));
    assert_eq!(f.wd(t).run_check().await, summary(0, 0, 1));
    assert_eq!(f.count(), 0);
}
#[tokio::test]
async fn normal_l326_enabled_target_runs_actual_native_repair() {
    let f = Fixture::new();
    f.write(&json!({"hooks":{}}));
    let mut t = f.command(0);
    t.enabled = Some(Arc::new(|| true));
    let wd = f.wd(t);
    assert_eq!(wd.run_check().await, summary(0, 1, 0));
    f.assert_argv(&wd.targets[0]);
}
#[tokio::test]
async fn normal_l342_real_nonzero_exit_is_contained_as_repair_failed() {
    let f = Fixture::new();
    let wd = f.wd(f.command(23));
    let r = wd.check_target(&wd.targets[0]).await.unwrap();
    assert_eq!(r.status, TargetStatus::RepairFailed);
    assert_eq!(r.missing, EVENTS);
    f.assert_argv(&wd.targets[0]);
}
#[tokio::test]
async fn normal_l354_real_spawn_error_after_existing_file_is_contained() {
    let f = Fixture::new();
    let invalid = f.root.path().join("invalid native executable");
    std::fs::write(&invalid, "this is not a native executable").unwrap();
    let mut t = f.command(0);
    t.bin_path = Some(invalid.to_string_lossy().into_owned());
    let wd = f.wd(t);
    assert_eq!(
        wd.check_target(&wd.targets[0]).await.unwrap().status,
        TargetStatus::RepairFailed
    );
    assert!(f.native_rows().is_empty());
}
#[tokio::test]
async fn normal_l366_invalid_existing_jsonc_is_preserved_without_repair() {
    let f = Fixture::new();
    let body = "{ // incomplete JSONC\n\"model\":\"qwen-max\",\n";
    std::fs::write(&f.path, body).unwrap();
    let mut t = f.target();
    t.settings_syntax = JsonSyntax::Jsonc;
    assert_eq!(f.wd(t).run_check().await, summary(0, 0, 1));
    assert_eq!(f.count(), 0);
    assert_eq!(std::fs::read_to_string(&f.path).unwrap(), body);
}
#[tokio::test]
async fn normal_l390_whitespace_only_jsonc_repairs_once() {
    let f = Fixture::new();
    std::fs::write(&f.path, "  \n").unwrap();
    let mut t = f.target();
    t.settings_syntax = JsonSyntax::Jsonc;
    assert_eq!(f.wd(t).run_check().await, summary(0, 1, 0));
    assert_eq!(f.count(), 1);
}
#[tokio::test]
async fn normal_l410_invalid_logs_are_suppressed_then_resume_after_recovery() {
    const CHILD: &str = "PILOT_HOOK_WATCHDOG_INVALID_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let f = Fixture::new();
        let mut t = f.target();
        t.agent_id = "qwen-code-cli".into();
        t.settings_syntax = JsonSyntax::Jsonc;
        let wd = f.wd(t);
        let invalid = "{ // incomplete JSONC\n\"model\":\"qwen-max\",\n";
        std::fs::write(&f.path, invalid).unwrap();
        assert_eq!(wd.run_check().await, summary(0, 0, 1));
        assert_eq!(wd.run_check().await, summary(0, 0, 1));
        f.write(&f.healthy());
        assert_eq!(wd.run_check().await, summary(1, 0, 0));
        std::fs::write(&f.path, invalid).unwrap();
        assert_eq!(wd.run_check().await, summary(0, 0, 1));
        assert_eq!(f.count(), 0);
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact","core::hook_watchdog::normal_history_tests::normal_l410_invalid_logs_are_suppressed_then_resume_after_recovery","--nocapture"])
        .env_clear().env(CHILD,"1").env("HOME",root.path()).env("USERPROFILE",root.path()).env("LOG_LEVEL","debug")
        .env("PATH",root.path()).env("TMP",root.path()).env("TEMP",root.path()).env("TMPDIR",root.path()).kill_on_drop(true);
    for key in ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let records = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect::<Vec<_>>();
    let errors = records
        .iter()
        .filter(|r| r["msg"] == "hook-watchdog.invalid-config")
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 2);
    assert!(errors
        .iter()
        .all(|r| r["agent"] == "qwen-code-cli" && r["level"] == "ERROR"));
    let suppressed = records
        .iter()
        .filter(|r| r["msg"] == "hook-watchdog.invalid-config-suppressed")
        .collect::<Vec<_>>();
    assert_eq!(suppressed.len(), 1);
    assert_eq!(suppressed[0]["agent"], "qwen-code-cli");
    assert_eq!(suppressed[0]["level"], "DEBUG");
}
#[tokio::test]
async fn normal_l460_disabled_watchdog_never_arms_background_tasks() {
    let f = Fixture::new();
    let mut cfg = config();
    cfg.enabled = false;
    let wd = Arc::new(HookWatchdog::new(cfg, vec![f.command(0)], Vec::new()));
    wd.start();
    assert!(wd.startup.lock().unwrap().is_none());
    assert!(wd.interval.lock().unwrap().is_none());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(f.native_rows().is_empty());
    wd.stop();
}
#[tokio::test]
async fn normal_l473_real_thirty_second_startup_then_periodic_checks_stop() {
    assert_eq!(STARTUP_DELAY_MS, 30_000);
    let calls = Arc::new(AtomicUsize::new(0));
    let notify = Arc::new(tokio::sync::Notify::new());
    let seen = calls.clone();
    let wake = notify.clone();
    let target = InterceptCheckTarget {
        id: "real-startup".into(),
        enabled: Arc::new(|| true),
        precondition: Arc::new(|| Box::pin(async { true })),
        check: Arc::new(move || {
            let seen = seen.clone();
            let wake = wake.clone();
            Box::pin(async move {
                seen.fetch_add(1, Ordering::SeqCst);
                wake.notify_one();
                true
            })
        }),
        repair: Arc::new(|| Box::pin(async { panic!("healthy target cannot repair") })),
        cleanup: None,
    };
    let mut cfg = config();
    cfg.interval_ms = 50;
    let wd = Arc::new(HookWatchdog::new(cfg, Vec::new(), vec![target]));
    let start = std::time::Instant::now();
    wd.start();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    tokio::time::timeout(Duration::from_secs(35), notify.notified())
        .await
        .unwrap();
    assert!(start.elapsed() >= Duration::from_secs(30));
    tokio::time::timeout(Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    wd.stop();
    assert!(wd.startup.lock().unwrap().is_none());
    assert!(wd.interval.lock().unwrap().is_none());
    let before = calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(calls.load(Ordering::SeqCst), before);
}
#[tokio::test]
async fn normal_l493_healthy_and_broken_targets_are_isolated() {
    let a = Fixture::new();
    a.write(&a.healthy());
    let b = Fixture::new();
    let mut settings = b.healthy();
    settings["hooks"].as_object_mut().unwrap().remove("Stop");
    b.write(&settings);
    let mut t = b.command(0);
    t.agent_id = "codex".into();
    let wd = HookWatchdog::new(config(), vec![a.command(0), t], Vec::new());
    assert_eq!(wd.run_check().await, summary(1, 1, 0));
    assert!(a.native_rows().is_empty());
    b.assert_argv(&wd.targets[1]);
}
#[tokio::test]
async fn normal_l533_healthy_callback_target_skips_both_repair_modes() {
    let f = Fixture::new();
    f.write(&f.healthy());
    assert_eq!(f.wd(f.target()).run_check().await, summary(1, 0, 0));
    assert_eq!(f.count(), 0);
    assert!(f.native_rows().is_empty());
}
fn changed_target(
    f: &Fixture,
    responses: Vec<bool>,
) -> (PluginCheckTarget, Arc<AtomicUsize>, PathBuf) {
    f.write(&f.healthy());
    let path = f.root.path().join("config.toml");
    std::fs::write(&path, "model = \"first\"\n").unwrap();
    let inspected = Arc::new(AtomicUsize::new(0));
    let seen = inspected.clone();
    let mut t = f.target();
    t.agent_id = "codex".into();
    t.change_watch_path = Some(path.to_string_lossy().into_owned());
    t.needs_repair_on_change = Some(Arc::new(move || {
        let i = seen.fetch_add(1, Ordering::SeqCst);
        let result = responses[i.min(responses.len() - 1)];
        Box::pin(async move { Ok(result) })
    }));
    (t, inspected, path)
}
#[tokio::test]
async fn normal_l547_only_changed_config_runs_trust_inspection_and_shared_repair() {
    let f = Fixture::new();
    let (t, inspected, path) = changed_target(&f, vec![true, false]);
    let mut cfg = config();
    cfg.repair_cooldown_ms = 0;
    let wd = HookWatchdog::new(cfg, vec![t], Vec::new());
    assert_eq!(wd.run_check().await, summary(1, 0, 0));
    wd.run_check().await;
    assert_eq!(inspected.load(Ordering::SeqCst), 0);
    assert_eq!(f.count(), 0);
    std::fs::write(&path, "model = \"changed-and-longer\"\n").unwrap();
    assert_eq!(wd.run_check().await, summary(0, 1, 0));
    assert_eq!(inspected.load(Ordering::SeqCst), 1);
    assert_eq!(f.count(), 1);
    std::fs::write(&path, "model = \"reconciled\"\n").unwrap();
    wd.run_check().await;
    wd.run_check().await;
    assert_eq!(inspected.load(Ordering::SeqCst), 2);
    assert_eq!(f.count(), 1);
}
#[tokio::test]
async fn normal_l584_config_edit_before_first_poll_is_detected() {
    let f = Fixture::new();
    let (t, inspected, path) = changed_target(&f, vec![true]);
    let wd = f.wd(t);
    std::fs::write(&path, "model = \"changed-before-first-check\"\n").unwrap();
    assert_eq!(wd.run_check().await, summary(0, 1, 0));
    assert_eq!(inspected.load(Ordering::SeqCst), 1);
    assert_eq!(f.count(), 1);
}
#[tokio::test]
async fn normal_l632_changed_config_stays_pending_until_real_callback_success() {
    let f = Fixture::new();
    let (mut t, inspected, path) = changed_target(&f, vec![true]);
    let repairs = f.calls.clone();
    t.repair_fn = Some(Arc::new(move || {
        let call = repairs.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(call != 0) })
    }));
    let mut cfg = config();
    cfg.repair_cooldown_ms = 0;
    let wd = HookWatchdog::new(cfg, vec![t], Vec::new());
    wd.run_check().await;
    std::fs::write(&path, "model = \"changed\"\n").unwrap();
    assert_eq!(wd.run_check().await.repaired, 0);
    assert_eq!(wd.run_check().await.repaired, 1);
    assert_eq!(inspected.load(Ordering::SeqCst), 2);
    assert_eq!(f.count(), 2);
    wd.run_check().await;
    assert_eq!(inspected.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn normal_l657_missing_callback_hook_runs_callback_without_native_command() {
    let f = Fixture::new();
    let mut settings = f.healthy();
    settings["hooks"].as_object_mut().unwrap().remove("Stop");
    f.write(&settings);
    assert_eq!(f.wd(f.target()).run_check().await, summary(0, 1, 0));
    assert_eq!(f.count(), 1);
    assert!(f.native_rows().is_empty());
}
#[tokio::test]
async fn normal_l672_callback_false_counts_checked_repair_failure() {
    let f = Fixture::new();
    let mut t = f.target();
    let calls = f.calls.clone();
    t.repair_fn = Some(Arc::new(move || {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(false) })
    }));
    assert_eq!(f.wd(t).run_check().await, summary(1, 0, 0));
    assert_eq!(f.count(), 1);
}
#[tokio::test]
async fn normal_l695_callback_repair_needs_no_external_binary() {
    let f = Fixture::new();
    let mut t = f.target();
    t.bin_path = Some(
        f.root
            .path()
            .join("missing-ignored-bin")
            .to_string_lossy()
            .into_owned(),
    );
    assert_eq!(f.wd(t).run_check().await, summary(0, 1, 0));
    assert_eq!(f.count(), 1);
}
#[tokio::test]
async fn normal_l709_native_and_callback_targets_repair_independently() {
    let native = Fixture::new();
    let callback = Fixture::new();
    let mut t = callback.target();
    t.agent_id = "cursor".into();
    let wd = HookWatchdog::new(config(), vec![native.command(0), t], Vec::new());
    assert_eq!(wd.run_check().await, summary(0, 2, 0));
    native.assert_argv(&wd.targets[0]);
    assert_eq!(callback.count(), 1);
    assert!(callback.native_rows().is_empty());
}
