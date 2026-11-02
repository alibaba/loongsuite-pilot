//! Error contracts use actual filesystem failures, distinct from false and panic.
use super::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

fn cfg() -> HookWatchdogConfig {
    HookWatchdogConfig {
        enabled: true,
        interval_ms: 60_000,
        repair_cooldown_ms: 600_000,
    }
}
fn target(root: &Path, calls: Arc<AtomicUsize>) -> PluginCheckTarget {
    let path = root.join("hooks.json");
    std::fs::write(&path,json!({"hooks":{"stop":[{"hooks":[{"command":"/fixture/cursor-loongsuite-pilot-hook.sh"}]}],"preToolUse":[{"hooks":[{"command":"/fixture/cursor-loongsuite-pilot-hook.sh"}]}]}}).to_string()).unwrap();
    PluginCheckTarget {
        agent_id: "cursor".into(),
        settings_path: path.to_string_lossy().into_owned(),
        settings_syntax: JsonSyntax::Json,
        expected_hooks: vec!["stop".into(), "preToolUse".into()],
        markers: vec!["cursor-loongsuite-pilot-hook.sh".into()],
        bin_path: None,
        install_args: Vec::new(),
        repair_fn: Some(Arc::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(true) })
        })),
        change_watch_path: None,
        needs_repair_on_change: None,
        enabled: None,
    }
}
#[tokio::test]
async fn normal_l607_real_inspection_io_error_does_not_accept_the_changed_signature() {
    let root = tempfile::tempdir().unwrap();
    let repairs = Arc::new(AtomicUsize::new(0));
    let mut t = target(root.path(), repairs.clone());
    let config = root.path().join("config.toml");
    std::fs::write(&config, "model = \"initial\"\n").unwrap();
    t.agent_id = "codex".into();
    t.change_watch_path = Some(config.to_string_lossy().into_owned());
    let inspection = root.path().join("actual trust inspection");
    std::fs::create_dir(&inspection).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let input = inspection.clone();
    t.needs_repair_on_change = Some(Arc::new(move || {
        let input = input.clone();
        seen.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            std::fs::read_to_string(input)
                .map(|body| body != "healthy")
                .map_err(|error| error.to_string())
        })
    }));
    let wd = HookWatchdog::new(cfg(), vec![t], Vec::new());
    assert_eq!(wd.run_check().await.checked, 1);
    std::fs::write(&config, "model = \"externally changed\"\n").unwrap();
    assert_eq!(
        wd.run_check().await,
        CheckResult::default(),
        "a real inspection IO Err is not a successful healthy observation"
    );
    std::fs::remove_dir(&inspection).unwrap();
    std::fs::write(&inspection, "healthy").unwrap();
    assert_eq!(wd.run_check().await.checked, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(repairs.load(Ordering::SeqCst), 0);
    wd.run_check().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "accepted successful inspection becomes the stable baseline"
    );
}
#[tokio::test]
async fn normal_l685_real_repair_io_error_is_contained_logged_and_next_target_runs() {
    const CHILD: &str = "PILOT_HOOK_WATCHDOG_REPAIR_IO_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let root = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut t = target(root.path(), calls.clone());
        std::fs::remove_file(&t.settings_path).unwrap();
        let destination = root.path().join("repair-write-denied-by-directory");
        std::fs::create_dir(&destination).unwrap();
        let seen = calls.clone();
        t.repair_fn = Some(Arc::new(move || {
            let destination = destination.clone();
            seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                std::fs::write(destination, "hook repair")
                    .map(|()| true)
                    .map_err(|error| error.to_string())
            })
        }));
        let healthy_root = tempfile::tempdir().unwrap();
        let other_calls = Arc::new(AtomicUsize::new(0));
        let mut other = target(healthy_root.path(), other_calls.clone());
        other.agent_id = "other-healthy-agent".into();
        let wd = HookWatchdog::new(cfg(), vec![t, other], Vec::new());
        let result = wd.run_check().await;
        assert_eq!(
            result,
            CheckResult {
                checked: 2,
                repaired: 0,
                skipped: 0
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(other_calls.load(Ordering::SeqCst), 0);
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact","core::hook_watchdog::failure_history_tests::normal_l685_real_repair_io_error_is_contained_logged_and_next_target_runs","--nocapture"])
        .env_clear().env(CHILD,"1").env("HOME",root.path()).env("USERPROFILE",root.path()).env("PATH",root.path())
        .env("TMP",root.path()).env("TEMP",root.path()).env("TMPDIR",root.path()).kill_on_drop(true);
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
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|v| v["msg"] == "hook-watchdog.repair-failed")
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["agent"], "cursor");
    assert_eq!(records[0]["level"], "ERROR");
    assert!(!records[0]["error"].as_str().unwrap().is_empty());
}
#[tokio::test]
async fn callback_programming_panic_remains_distinct_from_an_io_error_or_false() {
    let root = tempfile::tempdir().unwrap();
    let mut t = target(root.path(), Arc::new(AtomicUsize::new(0)));
    std::fs::remove_file(&t.settings_path).unwrap();
    t.repair_fn = Some(Arc::new(|| {
        Box::pin(async { panic!("intentional test-only programming defect, not an IO Err") })
    }));
    let wd = Arc::new(HookWatchdog::new(cfg(), vec![t], Vec::new()));
    let panic = tokio::spawn(async move { wd.run_check().await })
        .await
        .unwrap_err();
    assert!(
        panic.is_panic(),
        "a Rust panic must not silently become a normal callback Err or false"
    );
}
