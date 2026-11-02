//! Frozen privacy writer/cursor contracts using real disk and private Hook entry.
use super::*;
use crate::hook_process::common::write_jsonl_records;
fn fixture(text: &str) -> (tempfile::TempDir, Env, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("config.json"), text).unwrap();
    let env = Env::from([
        (
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        ),
        (
            "AGENT_DATA_COLLECTION_CONFIG".into(),
            root.join("config.json").to_string_lossy().into_owned(),
        ),
    ]);
    (dir, env, root)
}
fn record(root: &Path, session: &str, private: bool) -> Obj {
    json!({"gen_ai.session.id":session,"gen_ai.agent.type":"qoder","cwd":root.join(if private{"private"}else{"public"}),"content":"synthetic-text"}).as_object().unwrap().clone()
}
fn configure(root: &Path) {
    fs::write(
        root.join("config.json"),
        json!({"privacy":{"excludeWorkspaces":[root.join("private")]}}).to_string(),
    )
    .unwrap();
}
#[test]
fn privacy_excluded_content_creates_no_history_and_sticky_decisions_are_shared() {
    let (_dir, env, root) = fixture("{}");
    configure(&root);
    let mut secret = record(&root, "secret-session", true);
    secret.insert("gen_ai.agent.type".into(), json!("claude-code"));
    write_jsonl_records(
        &env,
        &root.join("history"),
        "claude-code",
        &[secret.clone()],
    )
    .unwrap();
    assert!(!root.join("history").exists());
    secret.insert("cwd".into(), json!(root.join("public")));
    assert!(filter_workspace_records(&env, &[secret], "claude-code")
        .unwrap()
        .is_empty());
    assert_eq!(
        filter_workspace_records(
            &env,
            &[json!({"gen_ai.session.id":"unknown"})
                .as_object()
                .unwrap()
                .clone()],
            "claude-code"
        )
        .unwrap()
        .len(),
        1
    );
}
#[test]
fn privacy_bom_config_keeps_valid_public_history() {
    let (_dir, env, root) = fixture("{}");
    let policy = json!({"privacy":{"excludeWorkspaces":[root.join("private")]}}).to_string();
    fs::write(root.join("config.json"), format!("\u{feff}{policy}")).unwrap();
    write_jsonl_records(
        &env,
        &root.join("history"),
        "qoder",
        &[record(&root, "public-session", false)],
    )
    .unwrap();
    assert_eq!(fs::read_dir(root.join("history")).unwrap().count(), 1);
}
#[test]
fn privacy_invalid_policy_never_consumes_cursor_and_retries_after_repair() {
    for invalid in [
        "{\"privacy\":",
        r#"{"privacy":{"excludeWorkspaces":["relative"]}}"#,
        r#"{"privacy":{"excludeWorkspaces":[null]}}"#,
        r#"{"privacy":{"excludeWorkspaces":"not-an-array"}}"#,
    ] {
        let (_dir, env, root) = fixture(invalid);
        let row = record(&root, "public-session", false);
        assert!(write_jsonl_records(
            &env,
            &root.join("history"),
            "qoder",
            std::slice::from_ref(&row)
        )
        .is_err());
        let before = load_line_record(&env, "qoder", "public-session");
        let attempt = append_history(&env, "qoder", "qoder", std::slice::from_ref(&row));
        assert!(!attempt);
        if attempt {
            update_line_record(
                &env,
                "qoder",
                &root.join("transcript.jsonl"),
                "public-session",
                20,
            );
        }
        assert_eq!(load_line_record(&env, "qoder", "public-session"), before);
        assert!(!root.join("history").exists());
        assert!(!root.join("logs/qoder/history").exists());
        configure(&root);
        assert!(append_history(&env, "qoder", "qoder", &[row]));
    }
}
#[test]
fn privacy_real_config_read_error_is_retryable_and_creates_no_history() {
    let (_dir, env, root) = fixture("{}");
    fs::remove_file(root.join("config.json")).unwrap();
    fs::create_dir(root.join("config.json")).unwrap();
    assert!(write_jsonl_records(
        &env,
        &root.join("history"),
        "qoder",
        &[record(&root, "public-session", false)]
    )
    .is_err());
    assert!(!root.join("history").exists());
}
fn failed_persistence_scenario() {
    let (_dir, env, root) = fixture("{}");
    configure(&root);
    fs::write(root.join("state"), "pre-existing file").unwrap();
    assert!(
        filter_workspace_records(&env, &[record(&root, "public-session", true)], "qoder")
            .unwrap()
            .is_empty()
    );
    let mut unknown = record(&root, "public-session", false);
    unknown.remove("cwd");
    assert!(
        filter_workspace_records(&env, std::slice::from_ref(&unknown), "qoder")
            .unwrap()
            .is_empty(),
        "an IO failure must not forget a blocked session before the next Hook write"
    );
    unknown.insert("gen_ai.session.id".into(), json!("another"));
    assert_eq!(
        filter_workspace_records(&env, &[unknown], "qoder")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn privacy_failure_subprocess_worker() {
    if std::env::var("PILOT_PRIVACY_FAILURE_WORKER").as_deref() == Ok("1") {
        failed_persistence_scenario();
    }
}
#[test]
fn privacy_failed_persistence_keeps_same_process_exclusion() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "hook_process::qoder::shared_privacy_history_tests::privacy_failure_subprocess_worker",
            "--nocapture",
        ])
        .env("PILOT_PRIVACY_FAILURE_WORKER", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(
        stderr
            .matches("[workspace-privacy] Cannot persist session exclusions")
            .count(),
        1,
        "{stderr}"
    );
}
