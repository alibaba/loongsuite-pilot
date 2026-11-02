//! Exact env-helper5 source contracts; Env and all data/home roots are isolated.
use super::*;
const SID: &str = "ses_env_1";
const TP: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
fn fixture() -> (tempfile::TempDir, Env) {
    let root = tempfile::tempdir().unwrap();
    let env = Env::from([
        (
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        ),
        (
            "HOME".into(),
            root.path().join("home").to_string_lossy().into_owned(),
        ),
        (
            "USERPROFILE".into(),
            root.path().join("home").to_string_lossy().into_owned(),
        ),
        ("TRACEPARENT".into(), TP.into()),
    ]);
    (root, env)
}
fn records(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join("acp-correlate").join(format!("{SID}.jsonl")))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
#[test]
fn env_l31_writes_valid_traceparent_and_exclusive_lock() {
    let (root, env) = fixture();
    record_upstream_context_once(&env, "qwen-code-cli", SID);
    let rows = records(root.path());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["type"], "session");
    assert_eq!(rows[0]["sessionId"], SID);
    assert_eq!(rows[0]["traceparent"], TP);
    assert!(root
        .path()
        .join("acp-correlate")
        .join(format!("{SID}.env.lock"))
        .is_file());
}
#[test]
fn env_l40_records_only_once_for_the_same_session() {
    let (root, env) = fixture();
    for _ in 0..3 {
        record_upstream_context_once(&env, "qwen-code-cli", SID);
    }
    assert_eq!(records(root.path()).len(), 1);
}
#[test]
fn env_l48_absent_traceparent_creates_no_file_or_lock() {
    let (root, mut env) = fixture();
    env.remove("TRACEPARENT");
    record_upstream_context_once(&env, "qwen-code-cli", SID);
    assert!(!root
        .path()
        .join("acp-correlate")
        .join(format!("{SID}.jsonl"))
        .exists());
    assert!(!root
        .path()
        .join("acp-correlate")
        .join(format!("{SID}.env.lock"))
        .exists());
}
#[test]
fn env_l54_rejects_malformed_and_both_all_zero_identifiers() {
    let (root, mut env) = fixture();
    for tp in [
        "garbage".into(),
        "00-xyz-abc-01".into(),
        format!("00-{}-00f067aa0ba902b7-01", "0".repeat(32)),
        format!("00-4bf92f3577b34da6a3ce929d0e0e4736-{}-01", "0".repeat(16)),
    ] {
        env.insert("TRACEPARENT".into(), tp);
        record_upstream_context_once(&env, "qwen-code-cli", SID);
    }
    assert!(!root
        .path()
        .join("acp-correlate")
        .join(format!("{SID}.jsonl"))
        .exists());
}
#[test]
fn env_l62_bad_input_and_failed_io_remain_fail_open() {
    let (root, mut env) = fixture();
    record_upstream_context_once(&env, "x", "");
    assert!(!root.path().join("acp-correlate").exists());
    env.remove("LOONGSUITE_PILOT_DATA_DIR");
    // Rust hook API derives data dir from Env rather than a separate optional
    // dataDir arg. The fallback HOME is still synthetic; no real HOME is read.
    record_upstream_context_once(&env, "x", SID);
    env.insert("LOONGSUITE_PILOT_DATA_DIR".into(), "invalid\0path".into());
    record_upstream_context_once(&env, "x", SID);
}
