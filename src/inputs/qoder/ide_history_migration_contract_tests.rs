//! Literal historical Qoder IDE contracts through the public input and real files.
use super::*;
use crate::checkpoints::StateStore;
use crate::types::CollectionMethod;
use std::sync::Mutex;

struct Fixture {
    root: tempfile::TempDir,
    store: Arc<StateStore>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        Self { root, store }
    }

    fn input(&self, snapshot: &str) -> QoderInput {
        QoderInput::new(QoderOptions {
            state_store: Arc::clone(&self.store),
            data_root: Some(self.root.path().to_string_lossy().into_owned()),
            snapshot_store_path: Some(
                self.root
                    .path()
                    .join(snapshot)
                    .to_string_lossy()
                    .into_owned(),
            ),
            poll_interval_ms: Some(60_000),
            snapshot_retention_ms: None,
        })
    }

    fn history(&self, name: &str, value: &Value) {
        let dir = self.root.path().join("User").join("History").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("entries.json"), value.to_string()).unwrap();
    }

    fn tracker(&self, name: &str, text: &str) -> std::path::PathBuf {
        let dir = self
            .root
            .path()
            .join("SharedClientCache")
            .join("cache")
            .join("ai_tracker");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, text).unwrap();
        file
    }

    async fn drain(&self, snapshot: &str) -> Vec<Value> {
        let input = self.input(snapshot);
        let out = Arc::new(Mutex::new(Vec::new()));
        let copy = Arc::clone(&out);
        input.bind_collector(
            move |batch| {
                copy.lock().unwrap().extend(
                    batch
                        .iter()
                        .map(|entry| serde_json::to_value(entry).unwrap()),
                );
            },
            |_| {},
        );
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert!(!input.running());
        let entries = out.lock().unwrap().clone();
        entries
    }
}

fn tracker_rows(entries: &[Value]) -> Vec<&Value> {
    entries
        .iter()
        .filter(|entry| entry["agent.toolName"] == "qoder-ai-tracker")
        .collect()
}

#[test]
fn source_l35_real_qoder_ide_identity() {
    let fixture = Fixture::new();
    let input = fixture.input("snapshot.json");
    assert_eq!(input.id(), "qoder");
    assert_eq!(input.agent_type(), ClientType::Qoder);
    assert_eq!(
        input.inner.collection_method(),
        CollectionMethod::IdeSnapshotPolling
    );
}

#[tokio::test]
async fn source_l42_scans_literal_user_history_entry() {
    let fixture = Fixture::new();
    fixture.history("hash123", &json!({"resource":"/proj/file.ts","entries":[{"id":"e1","timestamp":now_ms(),"source":"qoder-completion"}]}));
    let entries = fixture.drain("snapshot.json").await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["agent.file_path"], "/proj/file.ts");
    assert_eq!(entries[0]["agent.action_type"], ActionType::Edit.as_str());
}

#[tokio::test]
async fn source_l64_filters_manual_history() {
    let fixture = Fixture::new();
    fixture.history("hash456", &json!({"resource":"/proj/manual.ts","entries":[{"id":"e1","timestamp":now_ms(),"source":"user-manual-edit"}]}));
    assert!(fixture.drain("snapshot.json").await.is_empty());
}

#[tokio::test]
async fn source_l84_missing_history_directory_is_tolerated() {
    let fixture = Fixture::new();
    assert!(fixture.drain("snapshot.json").await.is_empty());
}

#[tokio::test]
async fn source_l95_real_ai_tracker_jsonl_has_original_path_and_tool() {
    let fixture = Fixture::new();
    fixture.tracker("tracker-2026.jsonl", &format!("{}\n", json!({"filePath":"/proj/tracked.ts","aiAddedLines":["const x = 1;"],"aiDeletedLines":[],"aiModifiedContent":"modified code"})));
    let entries = fixture.drain("snapshot.json").await;
    assert!(!entries.is_empty());
    let tracker = tracker_rows(&entries);
    assert_eq!(tracker.len(), 1);
    assert_eq!(tracker[0]["agent.file_path"], "/proj/tracked.ts");
}

#[tokio::test]
async fn source_l119_reconstructed_input_keeps_actual_tracker_offset() {
    use std::io::Write;
    let fixture = Fixture::new();
    let file = fixture.tracker(
        "track.jsonl",
        &format!("{}\n", json!({"filePath":"/first.ts"})),
    );
    let first = fixture.drain("snapshot.json").await;
    assert!(!first.is_empty());
    let first_offset = fixture
        .store
        .get("qoder-tracker:track.jsonl")
        .last_offset()
        .unwrap();
    assert_eq!(first_offset as u64, std::fs::metadata(&file).unwrap().len());
    let mut append = std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap();
    writeln!(append, "{}", json!({"filePath":"/second.ts"})).unwrap();
    drop(append);
    let second = fixture.drain("snapshot2.json").await;
    let tracker = tracker_rows(&second);
    assert_eq!(tracker.len(), 1);
    assert_eq!(tracker[0]["agent.file_path"], "/second.ts");
}

#[tokio::test]
async fn source_l154_missing_tracker_directory_is_tolerated() {
    let fixture = Fixture::new();
    assert!(fixture.drain("snapshot.json").await.is_empty());
}

#[tokio::test]
async fn source_l166_built_entry_keeps_qoder_identity_and_edit() {
    let fixture = Fixture::new();
    fixture.history("hash-be", &json!({"resource":"/proj/be.ts","entries":[{"id":"be1","timestamp":now_ms(),"source":"ai-completion"}]}));
    let entries = fixture.drain("snapshot.json").await;
    assert!(!entries.is_empty());
    assert_eq!(entries[0]["gen_ai.agent.type"], "qoder");
    assert_eq!(entries[0]["agent.action_type"], ActionType::Edit.as_str());
}

#[tokio::test]
async fn source_l187_all_literal_ai_patterns_match_and_manual_does_not() {
    let fixture = Fixture::new();
    let now = now_ms();
    fixture.history(
        "hash-src",
        &json!({"resource":"/proj/src.ts","entries":[
            {"id":"s1","timestamp":now,"source":"copilot-suggestion"},
            {"id":"s2","timestamp":now+1,"source":"assistant-edit"},
            {"id":"s3","timestamp":now+2,"source":"agent-action"},
            {"id":"s4","timestamp":now+3,"source":"manual-typing"}
        ]}),
    );
    assert_eq!(fixture.drain("snapshot.json").await.len(), 3);
}

#[tokio::test]
async fn source_l212_missing_source_is_not_ai() {
    let fixture = Fixture::new();
    fixture.history(
        "hash-nosrc",
        &json!({"resource":"/proj/nosrc.ts","entries":[{"id":"ns1","timestamp":now_ms()}]}),
    );
    assert!(fixture.drain("snapshot.json").await.is_empty());
}

#[tokio::test]
async fn source_l230_old_timestamp_is_excluded_by_snapshot_retention() {
    let fixture = Fixture::new();
    fixture.history("hash-old", &json!({"resource":"/proj/old.ts","entries":[{"id":"o1","timestamp":100,"source":"qoder-ai"}]}));
    assert!(fixture.drain("snapshot.json").await.is_empty());
    // Positive control proves the same real adapter still reads retained history.
    fixture.history("hash-current", &json!({"resource":"/proj/current.ts","entries":[{"id":"current","timestamp":now_ms(),"source":"qoder-ai"}]}));
    let current = fixture.drain("snapshot.json").await;
    assert_eq!(current.len(), 1);
    assert_eq!(current[0]["agent.file_path"], "/proj/current.ts");
}

#[tokio::test]
async fn source_l248_missing_entries_array_is_tolerated() {
    let fixture = Fixture::new();
    fixture.history("hash-noarr", &json!({"resource":"/proj/noarr.ts"}));
    assert!(fixture.drain("snapshot.json").await.is_empty());
}

#[tokio::test]
async fn source_l264_corrupt_history_json_is_tolerated() {
    let fixture = Fixture::new();
    let dir = fixture
        .root
        .path()
        .join("User")
        .join("History")
        .join("hash-corrupt");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("entries.json"), "not json").unwrap();
    assert!(fixture.drain("snapshot.json").await.is_empty());
}

#[tokio::test]
async fn source_l280_tracker_empty_lines_do_not_hide_valid_row() {
    let fixture = Fixture::new();
    fixture.tracker(
        "edge.jsonl",
        &format!("\n\n{}\n\n", json!({"filePath":"/valid.ts"})),
    );
    let entries = fixture.drain("snapshot.json").await;
    assert!(!tracker_rows(&entries).is_empty());
}

#[tokio::test]
async fn source_l297_tracker_bad_json_does_not_hide_valid_row() {
    let fixture = Fixture::new();
    fixture.tracker(
        "bad.jsonl",
        &format!("not json\n{}\n", json!({"filePath":"/ok.ts"})),
    );
    let entries = fixture.drain("snapshot.json").await;
    assert!(!tracker_rows(&entries).is_empty());
}

#[tokio::test]
async fn source_l314_tracker_ignores_non_jsonl_file() {
    let fixture = Fixture::new();
    fixture.tracker("readme.txt", "not a jsonl file");
    fixture.tracker(
        "valid.jsonl",
        &format!("{}\n", json!({"filePath":"/valid.ts"})),
    );
    let entries = fixture.drain("snapshot.json").await;
    assert!(!tracker_rows(&entries).is_empty());
}
