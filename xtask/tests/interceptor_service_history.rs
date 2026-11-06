//! Native shell/PowerShell interceptor service boundaries from original seven AST.
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::process::{Command, Stdio};
fn between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    let source = source
        .split_once(start)
        .expect("actual production boundary exists")
        .1;
    source
        .split_once(end)
        .expect("actual production boundary ends")
        .0
}
#[test]
fn source_interceptor_l9_unix_service_registry_has_no_standalone_interceptor_or_daemon_command() {
    let s = include_str!("../../scripts/loongsuite-pilot.sh");
    let install = between(s, "autostart_install() {", "autostart_remove() {");
    for text in [
        "_write_launchd_interceptor_plist",
        "loongsuite-pilot-interceptor",
    ] {
        assert!(!install.contains(text), "{text}");
    }
    for text in [
        "retire_standalone_interceptor",
        "start-interceptor",
        "restart-interceptor",
        "run-interceptor",
        "interceptor-daemon.js",
    ] {
        assert!(!s.contains(text), "{text}");
    }
    assert!(s.contains("interceptor_embedded_status()"));
    assert!(s.contains("cmd_run() {\n    ensure_dirs"));
}
#[test]
fn source_interceptor_l25_every_installer_and_service_entry_keeps_interceptor_in_process() {
    let sh = include_str!("../../scripts/loongsuite-pilot.sh");
    let ps = include_str!("../../scripts/loongsuite-pilot.ps1");
    let reference = include_str!("../../deploy/autostart.sh");
    assert!(!sh.contains("cmd_run_interceptor"));
    assert!(!ps.contains("function Cmd-RunInterceptor"));
    assert!(!ps.contains("interceptor-daemon"));
    assert!(!reference.contains("interceptor"));
    for source in [
        include_str!("../../deploy/installer-opensource.sh"),
        include_str!("../../deploy/installer-opensource.ps1"),
    ] {
        for text in [
            "interceptor-daemon.js",
            "loongsuite-pilot-interceptor",
            "interceptor/interceptor.pid",
            "LoongsuitePilotInterceptor",
        ] {
            assert!(!source.contains(text), "{text}");
        }
    }
}
#[test]
fn source_interceptor_l39_hook_cli_has_no_daemon_ensure_or_spawn_dispatch() {
    assert!(!include_str!("../../scripts/loongsuite-pilot.sh").contains("daemon ensure"));
    let native = include_str!("../../src/interceptor/cli/mod.rs");
    assert!(native.contains("Some(\"hook\") =>"));
    assert!(
        !native.contains("Some(\"ensure\")")
            && !native.contains("spawn_daemon")
            && !native.contains("Command::new")
    );
}
#[test]
fn source_interceptor_l46_powershell_has_no_standalone_task_or_restart_dispatch() {
    let s = include_str!("../../scripts/loongsuite-pilot.ps1");
    for text in [
        "function Remove-StandaloneInterceptor",
        "function Install-InterceptorTask",
        "function Cmd-RestartInterceptor",
        "start-interceptor",
        "restart-interceptor",
        "run-interceptor",
        "LoongsuitePilotInterceptor",
    ] {
        assert!(!s.contains(text), "{text}");
    }
    assert!(s.contains("function Test-InterceptorEmbedded"));
    let run = between(s, "function Cmd-Run {", "\n}\n");
    assert!(run.contains("Invoke-Pilot -Arguments @(\"run\")"));
    assert!(!run.contains("interceptor") && !run.contains("Start-Process"));
}
#[test]
fn source_interceptor_l58_qwen_hook_assets_use_the_exact_surface_in_both_shells() {
    let shell = include_str!("../../assets/hooks/interceptor-qwenworkcn-hook.sh");
    let ps = include_str!("../../assets/hooks/interceptor-qwenworkcn-hook.ps1");
    assert!(shell.contains("NATIVE_ARGS=('interceptor' 'hook' '--agent' 'qwen-work-cn' \"$@\")"));
    assert!(
        ps.contains("$NativeArgs = @('interceptor', 'hook', '--agent', 'qwen-work-cn') + $args")
    );
    for source in [shell, ps] {
        assert!(!source.contains("qoder-auto"));
    }
}

#[test]
fn source_interceptor_l67_qwen_declaration_separates_stop_collection_and_head_interception() {
    let definition: serde_json::Value =
        serde_json::from_str(include_str!("../../agents.d/qwen-work-cn.json")).unwrap();
    assert_eq!(definition["hook"]["events"], serde_json::json!(["Stop"]));
    assert_eq!(
        definition["hook"]["interceptor"]["events"],
        serde_json::json!(["UserPromptSubmit", "PreToolUse", "PostToolUse"])
    );
    assert!(definition["hook"]["interceptor"]["hookCommand"]
        .as_str()
        .unwrap()
        .contains("interceptor-qwenworkcn-hook.sh"));
    assert_eq!(definition["hook"]["interceptor"]["insert"], "head");
}
#[test]
fn source_interceptor_l75_reference_autostart_keeps_collector_updater_only() {
    let source = include_str!("../../deploy/autostart.sh");
    assert!(
        source.contains("autostart_install()") && source.contains("_LOONGSUITE_PILOT_UPDATER_UNIT")
    );
    assert!(!source.contains("interceptor"));
}

#[cfg(unix)]
#[test]
fn actual_qwen_interceptor_shell_wrapper_forwards_agent_and_extra_args_to_pinned_native_program() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("用户 O'Brien 🚀");
    let data = home.join("data [隔离]");
    let hooks = data.join("hooks");
    fs::create_dir_all(hooks.join("shared")).unwrap();
    fs::create_dir_all(home.join("other-cache")).unwrap();
    fs::create_dir_all(home.join("no-runtimes")).unwrap();
    let script = hooks.join("interceptor-qwenworkcn-hook.sh");
    fs::write(
        &script,
        include_bytes!("../../assets/hooks/interceptor-qwenworkcn-hook.sh"),
    )
    .unwrap();
    fs::write(
        hooks.join("shared/native.sh"),
        include_bytes!("../../assets/hooks/shared/native.sh"),
    )
    .unwrap();
    let binary = home.join("实际 Native 程序");
    fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &binary).unwrap();
    fs::write(hooks.join("pilot-bin"), format!("{}\n", binary.display())).unwrap();
    fs::write(home.join("other-cache/current"), "../../foreign\n").unwrap();
    let log = home.join("native-argv.jsonl");
    let result = Command::new("/bin/bash")
        .arg(script)
        .args(["--event", "PreToolUse", "literal space", "Unicode 研发"])
        .env_clear()
        .current_dir(&home)
        .stdin(Stdio::null())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("PATH", home.join("no-runtimes"))
        .env("LOONGSUITE_PILOT_DATA_DIR", &data)
        .env("LOONGSUITE_PILOT_CACHE_DIR", home.join("other-cache"))
        .env("PILOT_FIXTURE_MODE", "exit")
        .env("PILOT_FIXTURE_LOG", &log)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let records = fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0]["args"],
        serde_json::json!([
            "interceptor",
            "hook",
            "--agent",
            "qwen-work-cn",
            "--event",
            "PreToolUse",
            "literal space",
            "Unicode 研发"
        ])
    );
    assert!(!home.join("other-cache/node-bin").exists());
}
