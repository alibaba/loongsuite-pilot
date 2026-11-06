//! Frozen shared event-emitter contracts, using the actual native writer and IDs.
use super::*;
use serde_json::json;
use std::process::Command;
use std::time::{Duration, Instant};
fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
#[test]
fn emitter_trace_id_has_thirty_two_lowercase_hex_characters() {
    assert!(is_hex(&random_hex(16), 32));
}
#[test]
fn emitter_span_id_has_sixteen_lowercase_hex_characters() {
    assert!(is_hex(&random_hex(8), 16));
}
#[test]
fn emitter_successive_trace_and_span_ids_differ() {
    assert_ne!(random_hex(16), random_hex(16));
    assert_ne!(random_hex(8), random_hex(8));
}
#[test]
fn emitter_concurrency_subprocess_worker() {
    let Ok(root) = std::env::var("PILOT_EMITTER_WORKER_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let session = std::env::var("PILOT_EMITTER_WORKER_SESSION").unwrap();
    fs::write(root.join(format!("{session}.ready")), b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !root.join("go").exists() {
        assert!(Instant::now() < deadline, "parent did not release writer");
        std::thread::sleep(Duration::from_millis(5));
    }
    let env = Env::from([(
        "AGENT_DATA_COLLECTION_DIR".into(),
        root.to_string_lossy().into_owned(),
    )]);
    let records = (0..40)
        .map(|i| {
            json!({"session":session,"i":i,"pad":"x".repeat(2048)})
                .as_object()
                .unwrap()
                .clone()
        })
        .collect::<Vec<_>>();
    write_jsonl_records(&env, &root, "grok-build", &records).unwrap();
}
#[test]
fn emitter_two_real_processes_preserve_all_eighty_large_jsonl_records() {
    let root = tempfile::tempdir().unwrap();
    let exe = std::env::current_exe().unwrap();
    let spawn = |session: &str| {
        Command::new(&exe)
        .args(["--exact","hook_process::common::shared_emitter_history_tests::emitter_concurrency_subprocess_worker","--nocapture"])
        .env("PILOT_EMITTER_WORKER_ROOT",root.path())
        .env("PILOT_EMITTER_WORKER_SESSION",session)
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap()
    };
    let a = spawn("session-a");
    let b = spawn("session-b");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !root.path().join("session-a.ready").exists()
        || !root.path().join("session-b.ready").exists()
    {
        assert!(
            Instant::now() < deadline,
            "both real writer processes must become ready"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    fs::write(root.path().join("go"), b"go").unwrap();
    for child in [a, b] {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let files = fs::read_dir(root.path())
        .unwrap()
        .map(Result::unwrap)
        .map(|x| x.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    let text = fs::read_to_string(&files[0]).unwrap();
    let rows = text
        .lines()
        .map(|x| serde_json::from_str::<Value>(x).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 80);
    for session in ["session-a", "session-b"] {
        let selected = rows
            .iter()
            .filter(|x| x["session"] == session)
            .collect::<Vec<_>>();
        assert_eq!(selected.len(), 40);
        for (i, row) in selected.iter().enumerate() {
            assert_eq!(row["i"], i);
            assert_eq!(row["pad"], "x".repeat(2048));
        }
    }
}
