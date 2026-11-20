use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn development_deploy_registers_the_cargo_cursor_helper() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let data = root.path().join("pilot data");
    std::fs::create_dir_all(home.join(".cursor")).unwrap();
    std::fs::create_dir(&data).unwrap();
    let config = data.join("config.json");
    std::fs::write(
        &config,
        json!({"dataDir":data,"dashboard":{"enabled":false},"autoUpdate":{"enabled":false}})
            .to_string(),
    )
    .unwrap();
    let settings = home.join(".cursor/hooks.json");
    std::fs::write(
        &settings,
        r#"{"version":1,"hooks":{"stop":[{"command":"third-party-hook"}]}}"#,
    )
    .unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
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
            command.contains("loongsuite-pilot-sdk-hook")
                && command.contains("sdk-hook --channel observe --agent cursor --event stop")
        })
    }));
    assert!(!data.join("hooks").exists());
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
