use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[test]
fn development_deploy_registers_the_cargo_cursor_helper() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let data = root.path().join("pilot data");
    let resources = root.path().join("development resources");
    let profile = resources.join("target/debug");
    std::fs::create_dir_all(&profile).unwrap();
    for directory in ["src", "assets", "agents.d"] {
        std::fs::create_dir(resources.join(directory)).unwrap();
    }
    std::fs::write(resources.join("Cargo.toml"), b"").unwrap();
    std::fs::write(resources.join("src/main.rs"), b"").unwrap();
    std::fs::write(
        resources.join("agents.d/cursor.json"),
        include_bytes!("../agents.d/cursor.json"),
    )
    .unwrap();
    // Cargo can put the test's executables outside the checkout. Exercise the
    // real development layout without expecting that build path to be target/.
    let pilot = Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
    let helper = Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"));
    let staged_pilot = profile.join(pilot.file_name().unwrap());
    let staged_helper = profile.join(helper.file_name().unwrap());
    std::fs::copy(pilot, &staged_pilot).unwrap();
    std::fs::copy(helper, &staged_helper).unwrap();
    let lib_name = match std::env::consts::OS {
        "windows" => "loongsuite_pilot.dll",
        "macos" => "libloongsuite_pilot.dylib",
        _ => "libloongsuite_pilot.so",
    };
    let cargo_profile = pilot.parent().unwrap();
    let library = [cargo_profile.join("deps"), cargo_profile.to_path_buf()]
        .into_iter()
        .map(|path| path.join(lib_name))
        .find(|path| path.is_file())
        .expect("Cargo must build the SDK used by the deployed executable");
    std::fs::copy(library, profile.join(lib_name)).unwrap();
    std::fs::create_dir_all(home.join(".cursor")).unwrap();
    std::fs::create_dir(&data).unwrap();
    let config = root.path().join("explicit-configuration.json");
    std::fs::write(
        &config,
        json!({"dataDir":data,"dashboard":{"enabled":false},"autoUpdate":{"enabled":false},
            "agents":{"cursor":{"captureMessageContent":false}}})
        .to_string(),
    )
    .unwrap();
    let settings = home.join(".cursor/hooks.json");
    std::fs::write(
        &settings,
        r#"{"version":1,"hooks":{"stop":[{"command":"third-party-hook"}]}}"#,
    )
    .unwrap();
    let mut command = Command::new(staged_pilot);
    command
        .env_clear()
        .current_dir(root.path())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("PATH", root.path().join("no-agent-binaries"))
        .env("AGENT_DATA_COLLECTION_CONFIG", &config)
        .args(["deploy", "--require=cursor", "--json"]);
    #[cfg(windows)]
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let first = std::fs::read_to_string(&settings).unwrap();
    let parsed: Value = serde_json::from_str(&first).unwrap();
    let stop = parsed["hooks"]["stop"].as_array().unwrap();
    assert_eq!(stop.len(), 2);
    assert!(stop
        .iter()
        .any(|hook| hook["command"] == "third-party-hook"));
    assert!(stop.iter().any(|hook| {
        hook["command"].as_str().is_some_and(|command| {
            command.contains("development resources")
                && command.contains("loongsuite-pilot-sdk-hook")
                && command.contains("sdk-hook --channel observe --agent cursor --event stop")
        })
    }));
    let hooks = data.join("hooks");
    let marker = hooks.join("cursor-config-path");
    let owned: Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
    assert_eq!(owned["path"], json!(config));
    assert_eq!(owned["implicitDefault"], false);
    assert_eq!(std::fs::read_dir(&hooks).unwrap().count(), 1);

    // The Agent process need not inherit the configuration override used
    // during deploy. The native binary must enforce the recorded choice.
    let mut hook = Command::new(staged_helper)
        .args([
            "sdk-hook",
            "--channel",
            "observe",
            "--agent",
            "cursor",
            "--event",
            "beforeSubmitPrompt",
            "--data-dir",
        ])
        .arg(data.canonicalize().unwrap())
        .env_remove("AGENT_DATA_COLLECTION_CONFIG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    hook.stdin.take().unwrap().write_all(
        br#"{"cursor_version":"3.30.14","conversation_id":"installed-session","generation_id":"installed-turn","prompt":"private-from-external-config"}"#,
    ).unwrap();
    let output = hook.wait_with_output().unwrap();
    assert!(output.status.success());
    let pending = std::fs::read_dir(data.join("state/cursor/deferred/inbox"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let raw = std::fs::read_to_string(pending).unwrap();
    assert!(!raw.contains("private-from-external-config"));
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["content_omitted"],
        true
    );

    let second = command.output().unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stdout)
    );
    assert_eq!(std::fs::read_to_string(settings).unwrap(), first);
}

#[test]
fn native_cursor_observe_keeps_a_redacted_turn_signal_while_the_collector_is_down() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config.json");
    std::fs::write(
        &config,
        r#"{"agents":{"cursor":{"captureMessageContent":false}}}"#,
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"))
        .args([
            "sdk-hook",
            "--channel",
            "observe",
            "--agent",
            "cursor",
            "--event",
            "beforeSubmitPrompt",
            "--data-dir",
        ])
        .arg(root.path())
        .env("AGENT_DATA_COLLECTION_CONFIG", &config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(
        json!({"conversation_id":"session-1","generation_id":"turn-1","prompt":"omit-from-disk"})
            .to_string().as_bytes(),
    ).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "{}");
    let files = std::fs::read_dir(root.path().join("state/cursor/deferred/inbox"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(files.len(), 1);
    let raw = std::fs::read_to_string(files[0].path()).unwrap();
    assert!(!raw.contains("omit-from-disk"));
    let row: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(row["redacted_prompt"], true);
    assert_eq!(row["cursor_hook"]["conversation_id"], "session-1");
    assert_eq!(row["cursor_hook"]["generation_id"], "turn-1");
}

#[test]
fn cursor_native_hook_recovers_legacy_windows_encoding_only_in_windows_context() {
    let root = tempfile::tempdir().unwrap();
    let raw = br#"{"conversation_id":"cursor-session","generation_id":"cursor-turn","prompt":"Recovered?}"#;
    for (index, platform) in ["Windows_NT", "linux"].into_iter().enumerate() {
        let data = root.path().join(index.to_string());
        std::fs::create_dir(&data).unwrap();
        let data = data.canonicalize().unwrap();
        let mut hook = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"))
            .args(["sdk-hook", "--channel", "observe", "--agent", "cursor"])
            .args(["--event", "beforeSubmitPrompt", "--data-dir"])
            .arg(&data)
            .env("LOONGSUITE_CURSOR_PLATFORM", platform)
            .env_remove("LOONGSUITE_PLATFORM")
            .env_remove("OS")
            .env_remove("AGENT_DATA_COLLECTION_CONFIG")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        hook.stdin.take().unwrap().write_all(raw).unwrap();
        let output = hook.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(&output.stdout, b"{}\n");
        let inbox = data.join("state/cursor/deferred/inbox");
        if index == 0 || cfg!(windows) {
            let entry = std::fs::read_dir(inbox).unwrap().next().unwrap().unwrap();
            let record: Value =
                serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
            assert_eq!(record["cursor_hook"]["prompt"], "Recovered");
        } else {
            assert!(!inbox.exists(), "never rewrite invalid Unix input");
        }
    }
}

#[test]
fn retired_cursor_and_qwen_commands_cannot_write_activity() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().canonicalize().unwrap();
    let transcript = data.join("old-qwen-session.jsonl");
    std::fs::write(
        &transcript,
        r#"{"type":"user","message":{"role":"user","content":"prompt"}}"#,
    )
    .unwrap();
    for (args, payload, rejects_obsolete_syntax) in [
        (
            &["cursor", "--defer-assembly"][..],
            json!({"hook_event_name":"stop","conversation_id":"cursor-session",
                "generation_id":"cursor-turn","status":"completed"}),
            true,
        ),
        (
            &[
                "qwen-work-cn",
                "--agent-id",
                "qwen-work-cn",
                "--log-prefix",
                "qwen-work-cn",
            ][..],
            json!({"hook_event_name":"Stop","transcript_path":transcript,"session_id":"old-qwen-session"}),
            false,
        ),
        (&["cursor"][..], json!({"hook_event_name":"stop"}), false),
        (
            &["qwen-work-cn"][..],
            json!({"hook_event_name":"Stop"}),
            false,
        ),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"))
            .arg("hook-process")
            .args(args)
            .env("HOME", &data)
            .env("USERPROFILE", &data)
            .env("LOONGSUITE_PILOT_DATA_DIR", &data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = serde_json::to_vec(&payload).unwrap();
        if let Err(error) = child.stdin.take().unwrap().write_all(&input) {
            assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
        }
        let output = child.wait_with_output().unwrap();
        if rejects_obsolete_syntax {
            assert_eq!(output.status.code(), Some(2), "{output:?}");
            assert!(output.stdout.is_empty());
        } else {
            assert!(output.status.success(), "{output:?}");
            assert_eq!(&output.stdout, b"{}\n");
        }
    }
    assert_eq!(std::fs::read_dir(data).unwrap().count(), 1);
}
