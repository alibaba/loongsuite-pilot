use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

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
