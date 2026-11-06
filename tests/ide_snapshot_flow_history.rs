use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::inputs::qoder::{QoderInput, QoderOptions};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
async fn collect(dir: &Path, store: Arc<StateStore>, snapshot: &Path) -> Vec<AgentActivityEntry> {
    let input = QoderInput::new(QoderOptions {
        state_store: store,
        data_root: Some(dir.to_string_lossy().into_owned()),
        snapshot_store_path: Some(snapshot.to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
        snapshot_retention_ms: None,
    });
    let entries = Arc::new(Mutex::new(Vec::new()));
    let observed = entries.clone();
    input
        .inner
        .on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let result = entries.lock().unwrap().clone();
    result
}
fn assert_original_schema(entry: &AgentActivityEntry) {
    let v = serde_json::to_value(entry).unwrap();
    for key in ["time_unix_nano", "observed_time_unix_nano"] {
        assert!(
            v[key]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())),
            "{v}"
        );
    }
    for key in ["event.id", "gen_ai.agent.type", "gen_ai.provider.name"] {
        assert!(v[key].as_str().is_some_and(|s| !s.is_empty()), "{v}");
    }
    assert!(v["user.id"].is_string());
    assert!(v["gen_ai.session.id"].is_string());
    assert!(matches!(
        v["event.name"].as_str(),
        Some(
            "llm.request"
                | "llm.response"
                | "tool.call"
                | "tool.result"
                | "skill.use"
                | "tool.approve"
                | "agent.input"
                | "other"
        )
    ));
}
#[tokio::test]
async fn l25_real_qoder_history_scan_normalize_snapshot_flush_and_recreated_input_dedup() {
    let root = root();
    let history = root.path().join("User/History/hash001");
    std::fs::create_dir_all(&history).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    std::fs::write(history.join("entries.json"),json!({"resource":"/proj/app.ts","entries":[{"id":"e1","timestamp":now,"source":"qoder-ai-completion"},{"id":"e2","timestamp":now+1000,"source":"qoder-assistant"}]}).to_string()).unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.load().await;
    let snapshot = root.path().join("snapshot.json");
    let entries = collect(root.path(), store.clone(), &snapshot).await;
    assert!(!entries.is_empty());
    for entry in &entries {
        assert_eq!(entry.agent_type, "qoder");
        assert_original_schema(entry)
    }
    assert!(snapshot.is_file());
    let text: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&snapshot).unwrap()).unwrap();
    assert!(!text["entries"].as_array().unwrap().is_empty());
    assert!(collect(root.path(), store, &snapshot).await.is_empty());
}
#[tokio::test]
async fn l86_real_qoder_ai_tracker_jsonl_is_collected_and_offset_is_durable() {
    let root = root();
    let tracker = root.path().join("SharedClientCache/cache/ai_tracker");
    std::fs::create_dir_all(&tracker).unwrap();
    let file = tracker.join("track-integ.jsonl");
    std::fs::write(&file,json!({"filePath":"/proj/tracked.ts","aiAddedLines":["line 1"],"aiDeletedLines":[],"aiModifiedContent":"content"}).to_string()+"\n").unwrap();
    let path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.load().await;
    let entries = collect(
        root.path(),
        store.clone(),
        &root.path().join("snapshot.json"),
    )
    .await;
    assert!(entries
        .iter()
        .any(|e| serde_json::to_value(e).unwrap()["agent.toolName"] == "qoder-ai-tracker"));
    store.save().await.unwrap();
    assert!(store.get_offset("qoder-tracker:track-integ.jsonl") > 0.0);
    let new = StateStore::new(path);
    new.load().await;
    assert_eq!(
        new.get_offset("qoder-tracker:track-integ.jsonl"),
        std::fs::metadata(file).unwrap().len() as f64
    );
}
