//! Opt-in developer acceptance against explicitly supplied, sanitized snapshots.
//! These tests never discover or open the developer's personal HOME directories.
//! See tests/acceptance/QWEN_WORK_CN_PERSONAL_DATA.md before using --ignored.
use loongsuite_pilot::checkpoints::{InputState, StateStore};
use loongsuite_pilot::inputs::qoder_work_sqlite::{QoderWorkSqliteInput, QoderWorkSqliteOptions};
use loongsuite_pilot::inputs::qwen_work_cn::{QwenWorkCnSqliteInput, QwenWorkCnSqliteOptions};
use loongsuite_pilot::types::{AgentActivityEntry, ClientType};
use loongsuite_pilot::utils::candidate_process::CandidateChild;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn supplied(name: &str) -> PathBuf {
    let path=std::env::var_os(name).unwrap_or_else(||panic!("{name} must explicitly point to a sanitized snapshot; no personal paths are auto-discovered"));
    let path = PathBuf::from(path);
    assert!(
        path.is_absolute() && path.is_file(),
        "{name} must be an absolute existing snapshot file"
    );
    path
}
fn database(root: &Path) -> PathBuf {
    let source = supplied("PILOT_QWEN_ACCEPTANCE_DB");
    for suffix in ["-wal", "-journal"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", source.display()));
        assert!(
            !sidecar.exists(),
            "supply a consistent exported SQLite snapshot, not a live database with {suffix}"
        );
    }
    let copy = root.join("agents.db");
    fs::copy(source, &copy).unwrap();
    copy
}
fn state(root: &Path, id: &str) -> Arc<StateStore> {
    let store = Arc::new(StateStore::new(root.join(format!("{id}-state.json"))));
    store.set(id, InputState::new().with_extra(json!({"lastUpdatedAt":0})));
    store
}
type Batch = Arc<Mutex<Vec<AgentActivityEntry>>>;
async fn wait_for_batch(batch: &Batch) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !batch.lock().unwrap().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("supplied real snapshot produced no historical entries in 10 seconds");
}
async fn compatibility(root: &Path, db: &Path) -> Vec<AgentActivityEntry> {
    let batch: Batch = Arc::default();
    let sink = Arc::clone(&batch);
    let input = QoderWorkSqliteInput::new(QoderWorkSqliteOptions {
        state_store: state(root, "qoder-work-cn-sqlite"),
        db_path: Some(db.to_string_lossy().into_owned()),
        data_root: Some(root.to_string_lossy().into_owned()),
        agent_type: Some(ClientType::QoderWorkCN),
        poll_interval_ms: Some(60_000),
    });
    input.bind_collector(
        move |rows| sink.lock().unwrap().extend_from_slice(rows),
        |_| {},
    );
    input.start().await.unwrap();
    wait_for_batch(&batch).await;
    input.stop().await.unwrap();
    let got = batch.lock().unwrap().clone();
    got
}
async fn independent(root: &Path, db: &Path) -> Vec<AgentActivityEntry> {
    let batch: Batch = Arc::default();
    let sink = Arc::clone(&batch);
    let input = QwenWorkCnSqliteInput::new(QwenWorkCnSqliteOptions {
        state_store: state(root, "qwen-work-cn-sqlite"),
        db_path: Some(db.to_string_lossy().into_owned()),
        data_root: Some(root.to_string_lossy().into_owned()),
        poll_interval_ms: Some(60_000),
    });
    input.bind_collector(
        move |rows| sink.lock().unwrap().extend_from_slice(rows),
        |_| {},
    );
    input.start().await.unwrap();
    wait_for_batch(&batch).await;
    input.stop().await.unwrap();
    let got = batch.lock().unwrap().clone();
    got
}
fn values(rows: &[AgentActivityEntry]) -> Vec<Value> {
    rows.iter()
        .map(|row| serde_json::to_value(row).unwrap())
        .collect()
}
fn request(rows: &[Value]) -> &Value {
    rows.iter()
        .find(|row| row["event.name"] == "llm.request")
        .expect("real snapshot must contain an llm.request")
}
fn canonical(rows: &[Value], agent: &str) {
    assert!(!rows.is_empty());
    for row in rows {
        assert!(row["event.id"].is_string());
        let ns = row["time_unix_nano"].as_str().unwrap();
        assert!(!ns.is_empty() && ns.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(row["gen_ai.agent.type"], agent);
        assert!(row["gen_ai.session.id"].is_string());
        assert!(row["gen_ai.request.model"].is_string());
    }
    let delta = request(rows)["gen_ai.input.messages_delta"]
        .as_array()
        .unwrap();
    assert_eq!(delta.len(), 1);
    assert_eq!(delta[0]["role"], "user");
}
#[tokio::test]
#[ignore = "requires explicit sanitized consistent real QwenWorkCN SQLite snapshot; see acceptance guide"]
async fn qwen_db_l36_real_snapshot_maps_canonical_fields_through_compatibility_input() {
    let root = tempfile::tempdir().unwrap();
    let db = database(root.path());
    let before = fs::read(&db).unwrap();
    canonical(
        &values(&compatibility(root.path(), &db).await),
        "qoder-work-cn",
    );
    assert!(
        fs::read(db).unwrap() == before,
        "acceptance must not mutate source DB"
    );
}
#[tokio::test]
#[ignore = "requires explicit sanitized consistent real QwenWorkCN SQLite snapshot; see acceptance guide"]
async fn qwen_db_l66_independent_and_compatibility_inputs_keep_the_same_field_semantics() {
    let root = tempfile::tempdir().unwrap();
    let db = database(root.path());
    let before = fs::read(&db).unwrap();
    let old = values(&compatibility(root.path(), &db).await);
    let new = values(&independent(root.path(), &db).await);
    canonical(&old, "qoder-work-cn");
    canonical(&new, "qwen-work-cn");
    assert_eq!(
        new.iter().map(|r| &r["event.name"]).collect::<Vec<_>>(),
        old.iter().map(|r| &r["event.name"]).collect::<Vec<_>>()
    );
    for key in [
        "gen_ai.input.messages_delta",
        "gen_ai.session.id",
        "gen_ai.request.model",
    ] {
        assert!(
            request(&new)[key] == request(&old)[key],
            "{key} semantic mismatch (values withheld)"
        );
    }
    assert_eq!(request(&new)["agent.source"], "qwen-work-cn-sqlite");
    assert!(
        fs::read(db).unwrap() == before,
        "acceptance must not mutate source DB"
    );
}
#[test]
#[ignore = "requires explicit sanitized real QwenWorkCN transcript; see acceptance guide"]
fn qwen_transcript_l18_real_snapshot_runs_through_dedicated_native_hook_entrypoint() {
    let original = supplied("PILOT_QWEN_ACCEPTANCE_TRANSCRIPT");
    let original_bytes = fs::read(&original).unwrap();
    let text = std::str::from_utf8(&original_bytes).unwrap();
    assert!(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|row| row["type"] == "user"));
    assert!(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|row| row["type"] == "assistant"));
    let root = tempfile::tempdir().unwrap();
    let transcript = root.path().join("real-snapshot.jsonl");
    fs::write(&transcript, &original_bytes).unwrap();
    let data = root.path().join("isolated-data");
    let home = root.path().join("isolated-home");
    fs::create_dir_all(&home).unwrap();
    let input = root.path().join("hook.json");
    fs::write(&input,json!({
        "hook_event_name":"Stop","transcript_path":transcript,"session_id":"real-snapshot","cwd":root.path()
    }).to_string()).unwrap();
    let stdout = root.path().join("stdout");
    let stderr = root.path().join("stderr");
    let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
    command
        .args([
            "hook-process",
            "qwen-work-cn",
            "--agent-id",
            "qwen-work-cn",
            "--log-prefix",
            "qwen-work-cn",
        ])
        .env_clear()
        .current_dir(root.path())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("LOONGSUITE_PILOT_DATA_DIR", &data)
        .env(
            "AGENT_DATA_COLLECTION_CONFIG",
            root.path().join("config.json"),
        )
        .stdin(fs::File::open(input).unwrap())
        .stdout(fs::File::create(&stdout).unwrap())
        .stderr(fs::File::create(&stderr).unwrap());
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = CandidateChild::spawn(&mut command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "original 30-second hook budget");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(
        status.success(),
        "native hook failed (source content and diagnostics withheld)"
    );
    assert!(fs::read_to_string(stdout).unwrap().contains("{}"));
    let directory = data.join("logs/qwen-work-cn/history");
    let mut rows = Vec::new();
    for file in fs::read_dir(directory).unwrap() {
        let path = file.unwrap().path();
        if path.extension().is_some_and(|e| e == "jsonl") {
            for line in fs::read_to_string(path)
                .unwrap()
                .lines()
                .filter(|line| !line.trim().is_empty())
            {
                rows.push(serde_json::from_str::<Value>(line).unwrap());
            }
        }
    }
    assert!(!rows.is_empty());
    request(&rows);
    assert!(rows
        .iter()
        .all(|row| row["gen_ai.agent.type"] == "qwen-work-cn"
            && row["event.id"].is_string()
            && row["gen_ai.session.id"].is_string()));
    assert!(
        fs::read(original).unwrap() == original_bytes,
        "source transcript changed"
    );
}
