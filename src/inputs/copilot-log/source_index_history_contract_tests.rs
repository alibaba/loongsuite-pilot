//! Exact recovery and diagnostic contracts through real SQLite and source files.
use super::*;
use serde_json::json;
use std::io::Write;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/copilot/conversation.json"
    ))
    .unwrap()
}
fn lines(rows: &[Value]) -> String {
    rows.iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
#[test]
fn index_l19_malformed_complete_records_report_exact_source_byte_offsets_only_once() {
    const CHILD: &str = "PILOT_COPILOT_INDEX_WARNING_CHILD";
    if let Some(root) = std::env::var_os(CHILD) {
        let root = PathBuf::from(root);
        let file = root.join("events.jsonl");
        let db = root.join("index.sqlite");
        let f = fixture();
        let events = f["events"].as_array().unwrap();
        std::fs::write(
            &file,
            lines(&events[..1]) + "{broken\nnull\n" + &lines(&events[1..]),
        )
        .unwrap();
        let index = CopilotSourceIndex::open(&db).unwrap();
        index.ingest(&file, "event").unwrap();
        assert!(index
            .load("session-test", "interaction-a")
            .unwrap()
            .events
            .iter()
            .any(|r| r["type"] == "assistant.turn_end"));
        assert_eq!(
            integer(
                &rows(&index.db, "SELECT offset FROM sources", []).unwrap()[0],
                0
            ) as u64,
            std::fs::metadata(&file).unwrap().len()
        );
        index.ingest(&file, "event").unwrap();
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let stdout = root.path().join("stdout");
    let stderr = root.path().join("stderr");
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            std::thread::current().name().unwrap(),
            "--nocapture",
        ])
        .env_clear()
        .env(CHILD, root.path())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("LOONGSUITE_PILOT_DATA_DIR", home.join("pilot"))
        .env("PATH", home.join("no-runtime"))
        .stdin(std::process::Stdio::null())
        .stdout(std::fs::File::create(&stdout).unwrap())
        .stderr(std::fs::File::create(&stderr).unwrap());
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = crate::utils::candidate_process::CandidateChild::spawn(&mut command).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "native diagnostic subprocess timeout"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    assert!(
        status.success(),
        "{}",
        std::fs::read_to_string(stderr).unwrap()
    );
    let warnings = std::fs::read_to_string(stdout)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row["tag"] == "CopilotSourceIndex" && row["level"] == "WARN")
        .collect::<Vec<_>>();
    assert_eq!(warnings.len(), 2);
    let file = root
        .path()
        .join("events.jsonl")
        .to_string_lossy()
        .into_owned();
    let prefix = lines(&fixture()["events"].as_array().unwrap()[..1]).len() as u64;
    assert_eq!(warnings[0]["file"], file);
    assert_eq!(warnings[0]["offset"], prefix);
    assert_eq!(warnings[1]["file"], file);
    assert_eq!(warnings[1]["offset"], prefix + 8);
}
#[test]
fn index_l31_corrupt_session_start_never_fabricates_source_identity() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("events.jsonl");
    let f = fixture();
    std::fs::write(
        &file,
        "{bad session start\n".to_owned() + &lines(&f["events"].as_array().unwrap()[1..]),
    )
    .unwrap();
    let index = CopilotSourceIndex::open(&root.path().join("index.sqlite")).unwrap();
    index.ingest(&file, "event").unwrap();
    assert!(index.pending().unwrap().is_empty());
}
#[test]
fn index_l35_partial_ten_mib_line_keeps_four_mib_progress_across_restart_and_unchanged_eof() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("events.jsonl");
    let db = root.path().join("index.sqlite");
    let f = fixture();
    let prefix = lines(&[f["events"][0].clone()]);
    let mut user = f["events"][1].clone();
    user["data"]["content"] = json!("x".repeat(10 * 1024 * 1024));
    std::fs::write(&file, prefix.clone() + &user.to_string()).unwrap();
    let index = CopilotSourceIndex::open(&db).unwrap();
    index.ingest(&file, "event").unwrap();
    assert_eq!(
        integer(
            &rows(&index.db, "SELECT position FROM partial_sources", []).unwrap()[0],
            0
        ),
        READ_BUDGET as i64
    );
    assert_eq!(
        integer(
            &rows(&index.db, "SELECT offset FROM sources", []).unwrap()[0],
            0
        ),
        prefix.len() as i64
    );
    drop(index);
    let index = CopilotSourceIndex::open(&db).unwrap();
    index.ingest(&file, "event").unwrap();
    assert_eq!(
        integer(
            &rows(&index.db, "SELECT position FROM partial_sources", []).unwrap()[0],
            0
        ),
        2 * READ_BUDGET as i64
    );
    index.ingest(&file, "event").unwrap();
    let before = rows(
        &index.db,
        "SELECT position,length(body) FROM partial_chunks ORDER BY position",
        [],
    )
    .unwrap();
    index.ingest(&file, "event").unwrap();
    assert_eq!(
        rows(
            &index.db,
            "SELECT position,length(body) FROM partial_chunks ORDER BY position",
            []
        )
        .unwrap(),
        before
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    index.ingest(&file, "event").unwrap();
    assert!(rows(&index.db, "SELECT * FROM partial_chunks", [])
        .unwrap()
        .is_empty());
    assert_eq!(
        index
            .load("session-test", "interaction-a")
            .unwrap()
            .events
            .last()
            .unwrap()["data"]["content"]
            .as_str()
            .unwrap()
            .len(),
        10 * 1024 * 1024
    );
}
#[test]
fn index_l52_copy_truncate_discards_prior_fragments_and_accepts_five_complete_events() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("events.jsonl");
    std::fs::write(
        &file,
        "{\"padding\":\"".to_owned() + &"x".repeat(2 * READ_BUDGET as usize),
    )
    .unwrap();
    let index = CopilotSourceIndex::open(&root.path().join("index.sqlite")).unwrap();
    index.ingest(&file, "event").unwrap();
    assert!(!rows(&index.db, "SELECT * FROM partial_chunks", [])
        .unwrap()
        .is_empty());
    let f = fixture();
    std::fs::write(&file, lines(f["events"].as_array().unwrap())).unwrap();
    index.ingest(&file, "event").unwrap();
    assert!(rows(&index.db, "SELECT * FROM partial_chunks", [])
        .unwrap()
        .is_empty());
    assert_eq!(
        index
            .load("session-test", "interaction-a")
            .unwrap()
            .events
            .len(),
        5
    );
}
#[test]
fn index_l58_database_failure_rolls_back_records_cursor_and_fragments_then_retries() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("events.jsonl");
    let f = fixture();
    std::fs::write(
        &file,
        lines(f["events"].as_array().unwrap()) + "{\"unfinished\":",
    )
    .unwrap();
    let index = CopilotSourceIndex::open(&root.path().join("index.sqlite")).unwrap();
    index.db.execute_batch("CREATE TRIGGER fail_cursor BEFORE INSERT ON sources BEGIN SELECT RAISE(FAIL,'injected DB failure'); END;").unwrap();
    assert!(index.ingest(&file, "event").is_err());
    for table in ["records", "sources", "partial_chunks", "partial_sources"] {
        assert!(
            rows(&index.db, &format!("SELECT * FROM {table}"), [])
                .unwrap()
                .is_empty(),
            "{table} was not rolled back"
        );
    }
    index.db.execute_batch("DROP TRIGGER fail_cursor").unwrap();
    index.ingest(&file, "event").unwrap();
    assert_eq!(index.pending().unwrap().len(), 1);
}
#[test]
fn index_l69_failed_schema_initialization_releases_connection_and_retries_cleanly() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("index.sqlite");
    std::fs::write(&db, "not a SQLite database").unwrap();
    assert!(CopilotSourceIndex::open(&db).is_err());
    // A failed native constructor returns no half-open instance; real rename
    // also checks handle cleanup on Windows.
    std::fs::rename(&db, root.path().join("failed-index.sqlite")).unwrap();
    let index = CopilotSourceIndex::open(&db).unwrap();
    assert!(rows(&index.db, "SELECT * FROM sources", [])
        .unwrap()
        .is_empty());
}
