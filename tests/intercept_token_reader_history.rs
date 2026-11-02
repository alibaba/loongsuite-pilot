//! Immutable ef token-reader contracts through real files and isolated HOME.
use loongsuite_pilot::inputs::qoder_trace::{read_intercept_data, read_intercept_file};
use serde_json::{json, Value};
use std::path::Path;
const NOW: i64 = 1_780_000_000_000;
fn path(root: &Path) -> String {
    root.join("qodercli-intercept.jsonl")
        .to_string_lossy()
        .into_owned()
}
fn write(root: &Path, rows: &[Value]) {
    std::fs::write(
        path(root),
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
}
#[tokio::test]
async fn history_l27_missing_file_returns_empty_tokens_and_no_system_prompt() {
    let root = tempfile::tempdir().unwrap();
    let result = read_intercept_file(&path(root.path()), None).await;
    assert!(result.tokens.is_empty());
    assert!(result.system_prompt.is_none());
}
#[tokio::test]
async fn history_l33_two_token_rows_preserve_original_order_and_exact_counts() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &[
            json!({"type":"token","ts":NOW,"id":"req-1","prompt_tokens":25000,"cached_tokens":24000,"completion_tokens":50,"reasoning_tokens":10,"total_tokens":25050}),
            json!({"type":"token","ts":NOW+1000,"id":"req-2","prompt_tokens":26000,"cached_tokens":25000,"completion_tokens":100,"reasoning_tokens":20,"total_tokens":26100}),
        ],
    );
    let data = read_intercept_file(&path(root.path()), Some(NOW - 1000)).await;
    assert_eq!(data.tokens.len(), 2);
    let a = &data.tokens[0];
    assert_eq!(a.id, "req-1");
    assert_eq!(a.prompt_tokens, 25000);
    assert_eq!(a.cached_tokens, 24000);
    assert_eq!(a.completion_tokens, 50);
    assert_eq!(a.reasoning_tokens, 10);
    assert_eq!(a.total_tokens, 25050);
    let b = &data.tokens[1];
    assert_eq!(b.id, "req-2");
    assert_eq!(b.prompt_tokens, 26000);
}
#[tokio::test]
async fn history_l52_system_prompt_and_token_are_both_read() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &[
            json!({"type":"system_prompt","ts":NOW,"content":"You are Qoder, an AI assistant."}),
            json!({"type":"token","ts":NOW,"id":"req-1","prompt_tokens":100,"cached_tokens":0,"completion_tokens":10,"reasoning_tokens":0,"total_tokens":110}),
        ],
    );
    let data = read_intercept_file(&path(root.path()), Some(NOW - 1000)).await;
    assert_eq!(
        data.system_prompt.unwrap().content,
        "You are Qoder, an AI assistant."
    );
    assert_eq!(data.tokens.len(), 1);
}
#[tokio::test]
async fn history_l67_since_timestamp_filters_old_record_and_keeps_recent_id() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &[
            json!({"type":"token","ts":NOW-10000,"id":"old","prompt_tokens":1,"cached_tokens":0,"completion_tokens":1,"reasoning_tokens":0,"total_tokens":2}),
            json!({"type":"token","ts":NOW,"id":"recent","prompt_tokens":500,"cached_tokens":0,"completion_tokens":50,"reasoning_tokens":0,"total_tokens":550}),
        ],
    );
    let data = read_intercept_file(&path(root.path()), Some(NOW - 5000)).await;
    assert_eq!(data.tokens.len(), 1);
    assert_eq!(data.tokens[0].id, "recent");
}
#[tokio::test]
async fn history_l81_malformed_lines_do_not_hide_the_valid_middle_token() {
    let root = tempfile::tempdir().unwrap();
    let good = json!({"type":"token","ts":NOW,"id":"good","prompt_tokens":100,"cached_tokens":0,"completion_tokens":10,"reasoning_tokens":0,"total_tokens":110});
    std::fs::write(
        path(root.path()),
        format!("not valid json\n{good}\n{{\"incomplete\": true\n"),
    )
    .unwrap();
    let data = read_intercept_file(&path(root.path()), Some(NOW - 1000)).await;
    assert_eq!(data.tokens.len(), 1);
    assert_eq!(data.tokens[0].id, "good");
}
#[tokio::test]
async fn history_l96_real_default_and_custom_filename_are_separate_in_an_isolated_process() {
    const CHILD: &str = "PILOT_INTERCEPT_READER_HISTORY_CHILD";
    if std::env::var_os(CHILD).is_some() {
        assert!(read_intercept_data(Some(NOW - 1000), None)
            .await
            .tokens
            .is_empty());
        let data = read_intercept_data(Some(NOW - 1000), Some("qoderwork-intercept.jsonl")).await;
        assert_eq!(data.tokens.len(), 1);
        assert_eq!(data.tokens[0].id, "chatcmpl-qw-1");
        assert_eq!(data.tokens[0].prompt_tokens, 300);
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join(".loongsuite-pilot/logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("qoderwork-intercept.jsonl"),format!("{}\n",
        json!({"type":"token","ts":NOW,"id":"chatcmpl-qw-1","prompt_tokens":300,"cached_tokens":0,"completion_tokens":20,"reasoning_tokens":0,"total_tokens":320}))).unwrap();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "history_l96_real_default_and_custom_filename_are_separate_in_an_isolated_process",
            "--nocapture",
        ])
        .env_clear()
        .env(CHILD, "1")
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("APPDATA", root.path().join("appdata"))
        .env("LOCALAPPDATA", root.path().join("localappdata"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("XDG_CACHE_HOME", root.path().join("cache"))
        .env("XDG_DATA_HOME", root.path().join("data"))
        .env("TMP", root.path())
        .env("TEMP", root.path())
        .current_dir(root.path());
    for name in ["SystemRoot", "WINDIR", "ComSpec"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let output = loongsuite_pilot::utils::candidate_process::output(
        &mut command,
        std::time::Duration::from_secs(20),
        1024 * 1024,
    )
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
