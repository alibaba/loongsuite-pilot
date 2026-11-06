//! Fixed ef8953 retry lock, collection-selection and physical snapshot contracts.
use super::*;
fn isolated() -> (tempfile::TempDir, Env) {
    let dir = tempfile::tempdir().unwrap();
    let mut env = Env::new();
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        dir.path().to_string_lossy().into_owned(),
    );
    (dir, env)
}
fn transcript() -> &'static Path {
    Path::new("/tmp/t.jsonl")
}
fn write_lock(env: &Env, value: Value) -> PathBuf {
    let path = retry_lock_path(env, "qoder", transcript());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, value.to_string()).unwrap();
    path
}
#[test]
fn lock_l36_different_paths_have_distinct_lock_files() {
    let (_d, env) = isolated();
    let a = retry_lock_path(&env, "qoder", Path::new("/tmp/a.jsonl"));
    let b = retry_lock_path(&env, "qoder", Path::new("/tmp/b.jsonl"));
    assert_ne!(a, b);
    assert!(a.starts_with(retry_lock_dir(&env, "qoder")));
    assert_eq!(a.extension().unwrap(), "lock");
}
#[test]
fn lock_l44_same_input_stable() {
    let (_d, env) = isolated();
    assert_eq!(
        retry_lock_path(&env, "qoder", Path::new("/tmp/x.jsonl")),
        retry_lock_path(&env, "qoder", Path::new("/tmp/x.jsonl"))
    );
}
#[test]
fn lock_l51_first_acquire_records_owner_and_session() {
    let (_d, env) = isolated();
    assert!(try_acquire_retry_lock(
        &env,
        "qoder",
        transcript(),
        "sess-1"
    ));
    let lock = read_json_object(&retry_lock_path(&env, "qoder", transcript())).unwrap();
    assert_eq!(lock["pid"], std::process::id());
    assert_eq!(lock["sessionId"], "sess-1");
    assert!(lock["startedAt"].is_number());
}
#[test]
fn lock_l60_live_second_acquire_refused() {
    let (_d, env) = isolated();
    assert!(try_acquire_retry_lock(
        &env,
        "qoder",
        transcript(),
        "sess-1"
    ));
    assert!(!try_acquire_retry_lock(
        &env,
        "qoder",
        transcript(),
        "sess-1"
    ));
}
#[test]
fn lock_l65_dead_owner_replaced() {
    let (_d, env) = isolated();
    let path = write_lock(
        &env,
        json!({"pid":999999,"sessionId":"old","startedAt":now_ms()}),
    );
    assert!(try_acquire_retry_lock(
        &env,
        "qoder",
        transcript(),
        "sess-2"
    ));
    assert_eq!(read_json_object(&path).unwrap()["sessionId"], "sess-2");
    // A reaped real child also exercises Windows' exited-process handle semantics.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let dead = child.id();
    assert!(child.wait().unwrap().success());
    assert!(!crate::utils::is_process_alive(dead));
    write_lock(
        &env,
        json!({"pid":dead,"sessionId":"dead-child","startedAt":now_ms()}),
    );
    assert!(try_acquire_retry_lock(
        &env,
        "qoder",
        transcript(),
        "sess-after-child"
    ));
    assert_eq!(
        read_json_object(&path).unwrap()["sessionId"],
        "sess-after-child"
    );
}
#[test]
fn lock_l76_expired_live_owner_replaced() {
    let (_d, env) = isolated();
    let path = write_lock(
        &env,
        json!({"pid":std::process::id(),"sessionId":"old","startedAt":1}),
    );
    assert!(try_acquire_retry_lock(
        &env,
        "qoder",
        transcript(),
        "sess-2"
    ));
    assert_eq!(read_json_object(&path).unwrap()["sessionId"], "sess-2");
}
#[test]
fn lock_l86_waits_for_peer_release() {
    let (_d, mut env) = isolated();
    assert!(try_acquire_retry_lock(&env, "qoder", transcript(), "peer"));
    env.insert("HOOK_RETRY_LOCK_WAIT_MS".into(), "500".into());
    env.insert("HOOK_RETRY_LOCK_POLL_MS".into(), "5".into());
    let release = env.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        release_retry_lock(&release, "qoder", transcript());
    });
    assert!(acquire_retry_lock(&env, "qoder", transcript(), "sess-2"));
    thread.join().unwrap();
    assert_eq!(
        read_json_object(&retry_lock_path(&env, "qoder", transcript())).unwrap()["sessionId"],
        "sess-2"
    );
}
#[test]
fn lock_l99_timeout_keeps_live_peer() {
    let (_d, mut env) = isolated();
    assert!(try_acquire_retry_lock(&env, "qoder", transcript(), "peer"));
    env.insert("HOOK_RETRY_LOCK_WAIT_MS".into(), "20".into());
    env.insert("HOOK_RETRY_LOCK_POLL_MS".into(), "5".into());
    assert!(!acquire_retry_lock(&env, "qoder", transcript(), "sess-2"));
    assert_eq!(
        read_json_object(&retry_lock_path(&env, "qoder", transcript())).unwrap()["sessionId"],
        "peer"
    );
}
#[test]
fn lock_l112_release_own_pid() {
    let (_d, env) = isolated();
    assert!(try_acquire_retry_lock(
        &env,
        "qoder",
        transcript(),
        "sess-1"
    ));
    release_retry_lock(&env, "qoder", transcript());
    assert!(!retry_lock_path(&env, "qoder", transcript()).exists());
}
#[test]
fn lock_l118_preserves_other_pid() {
    let (_d, env) = isolated();
    let path = write_lock(
        &env,
        json!({"pid":std::process::id()+1,"sessionId":"peer","startedAt":now_ms()}),
    );
    release_retry_lock(&env, "qoder", transcript());
    assert!(path.exists());
    assert_eq!(read_json_object(&path).unwrap()["sessionId"], "peer");
}
#[test]
fn lock_l127_missing_release_no_error() {
    let (_d, env) = isolated();
    release_retry_lock(&env, "qoder", Path::new("/tmp/missing.jsonl"));
}
#[test]
fn lock_l133_null_is_stale() {
    assert!(lock_is_stale(None));
}
#[test]
fn lock_l137_old_is_stale() {
    assert!(lock_is_stale(Some(
        &json!({"pid":std::process::id(),"startedAt":0})
    )));
}
#[test]
fn lock_l141_fresh_live_is_not_stale() {
    assert!(!lock_is_stale(Some(
        &json!({"pid":std::process::id(),"startedAt":now_ms()})
    )));
}
#[test]
fn lock_l145_fresh_dead_is_stale() {
    assert!(lock_is_stale(Some(
        &json!({"pid":999999,"startedAt":now_ms()})
    )));
}
fn turns() -> Vec<Vec<Value>> {
    vec![
        vec![json!("turn-1")],
        vec![json!("turn-2")],
        vec![json!("turn-3")],
    ]
}
#[test]
fn segments_l153_normal_qoder_keeps_all() {
    assert_eq!(
        select_turn_segments(turns(), "incremental", "qoder"),
        turns()
    );
}
#[test]
fn segments_l157_recovered_cursor_only_latest() {
    for (reason, agent) in [("missing-cursor", "qoder"), ("truncated", "qoder-cn")] {
        assert_eq!(
            select_turn_segments(turns(), reason, agent),
            vec![vec![json!("turn-3")]]
        );
    }
}
#[test]
fn segments_l166_cn_full_reparse_only_latest() {
    assert_eq!(
        select_turn_segments(turns(), "incremental", "qoder-cn"),
        vec![vec![json!("turn-3")]]
    );
}
fn snapshot(rows: &[Value]) -> (tempfile::TempDir, Snapshot) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    fs::write(
        &path,
        rows.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
    let snapshot = read_snapshot(&path, false);
    (dir, snapshot)
}
fn progress(name: &str) -> Value {
    json!({"type":"progress","data":{"hookEvent":name}})
}
fn user(text: &str) -> Value {
    json!({"type":"user","message":{"content":text}})
}
fn assistant() -> Value {
    json!({"type":"assistant","timestamp":"2026-07-30T01:00:00.000Z","message":{"content":[{"type":"text","text":"done"}]}})
}
#[test]
fn increment_l655_preserves_queued_next_prompt() {
    let rows = vec![
        progress("UserPromptSubmit"),
        user("turn one"),
        assistant(),
        progress("Stop"),
        progress("SessionEnd"),
        progress("UserPromptSubmit"),
        user("turn two"),
    ];
    let (_d, s) = snapshot(&rows);
    assert_eq!(find_incremental_turn_end(&s, 0, rows.len()), 5);
}
#[test]
fn increment_l671_no_next_prompt_uses_scan_end() {
    let rows = vec![
        progress("UserPromptSubmit"),
        user("turn one"),
        assistant(),
        progress("Stop"),
    ];
    let (_d, s) = snapshot(&rows);
    assert_eq!(find_incremental_turn_end(&s, 0, rows.len()), rows.len());
}
#[test]
fn increment_l686_real_next_user_without_progress() {
    let rows = vec![
        user("turn one"),
        assistant(),
        progress("Stop"),
        user("turn two"),
    ];
    let (_d, s) = snapshot(&rows);
    assert_eq!(find_incremental_turn_end(&s, 0, rows.len()), 3);
}
