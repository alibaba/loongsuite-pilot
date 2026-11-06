//! Native filesystem round trips for the original integration restore contracts.
use loongsuite_pilot::checkpoints::{InputState, SnapshotStore, StateStore};
use loongsuite_pilot::inputs::qoder_trace::{QoderTraceInput, QoderTraceOptions};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
#[tokio::test]
async fn state_restore_preserves_offsets_row_id_extra_and_three_disk_generations() {
    let root = root();
    let path = root.path().join("state.json");
    let first = StateStore::new(&path);
    first.load().await;
    first.set_offset("agent-a", 1024.0);
    first.set_offset("agent-b", 2048.0);
    first.set_row_id("agent-c", 42.0);
    first.set(
        "agent-x",
        InputState::new()
            .with_last_offset(500.0)
            .with_extra(json!({"inode":123456,"customField":"value"})),
    );
    first.set_offset("a", 100.0);
    first.save().await.unwrap();
    drop(first);
    let second = StateStore::new(&path);
    second.load().await;
    assert_eq!(second.get_offset("agent-a"), 1024.0);
    assert_eq!(second.get_offset("agent-b"), 2048.0);
    assert_eq!(second.get_row_id("agent-c"), 42.0);
    let extra = second.get("agent-x");
    assert_eq!(extra.last_offset(), Some(500.0));
    assert_eq!(
        extra.extra().unwrap(),
        json!({"inode":123456,"customField":"value"})
    );
    assert_eq!(second.get_offset("a"), 100.0);
    second.set_offset("a", 200.0);
    second.set_offset("b", 50.0);
    second.save().await.unwrap();
    drop(second);
    let third = StateStore::new(&path);
    third.load().await;
    assert_eq!(third.get_offset("a"), 200.0);
    assert_eq!(third.get_offset("b"), 50.0);
    assert_eq!(third.get_offset("agent-a"), 1024.0);
    assert_eq!(third.get_row_id("agent-c"), 42.0);
}
#[tokio::test]
async fn snapshot_restore_preserves_processed_pending_and_actual_max_watermark() {
    let root = root();
    let path = root.path().join("processed.json");
    let first = SnapshotStore::new(&path);
    // Above the real retention floor, so a missing watermark cannot satisfy
    // the assertion simply by falling back to today's timestamp.
    let lower = 3_000_000_000_000.0;
    let higher = 4_000_000_000_000.0;
    first.mark_pending("key-1", lower);
    first.mark_processed("key-1", None);
    first.mark_pending("key-2", higher);
    first.mark_processed("key-2", None);
    first.flush().await.unwrap();
    drop(first);
    let second = SnapshotStore::new(&path);
    second.load().await;
    assert!(!second.should_process("key-1"));
    assert!(!second.should_process("key-2"));
    assert!(second.should_process("key-3"));
    assert_eq!(second.get_suggested_since_timestamp(), higher);
    let pending = root.path().join("pending.json");
    let first = SnapshotStore::new(&pending);
    first.mark_pending("pending-key", 3000.0);
    first.flush().await.unwrap();
    drop(first);
    let second = SnapshotStore::new(&pending);
    second.load().await;
    assert!(!second.should_process("pending-key"));
    assert_eq!(second.size(), 1);
}
fn record(turn: &str, index: usize) -> String {
    json!({
        "event.name":"tool.result","event.id":format!("{turn}-{index}"),"gen_ai.turn.id":turn,
        "gen_ai.step.id":format!("{turn}:s1"),"gen_ai.session.id":"restart-sess","gen_ai.agent.type":"qoder-cli",
        "gen_ai.tool.name":"write_to_file","gen_ai.tool.call.id":format!("{turn}-call-{index}"),
        "tool.result.status":"success","agent.source":"qoder-transcript-hook",
        "time_unix_nano":format!("17800000{index:02}000000000"),"observed_time_unix_nano":format!("17800000{index:02}000000000"),
        "git.repo":"synthetic/repo","git.branch":"fixture"
    }).to_string()+"\n"
}
async fn collect(logs: &Path, store: Arc<StateStore>) -> Vec<AgentActivityEntry> {
    let input = QoderTraceInput::new(QoderTraceOptions {
        state_store: store,
        log_dir: Some(logs.to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
        multimodal_enabled: false,
        upload_mode: None,
        allowed_root_paths: Vec::new(),
    });
    let entries = Arc::new(Mutex::new(Vec::new()));
    let seen = entries.clone();
    input
        .inner
        .on_entries(move |batch| seen.lock().unwrap().extend_from_slice(batch));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let result = entries.lock().unwrap().clone();
    result
}
#[tokio::test]
async fn actual_qoder_trace_resumes_three_then_two_after_a_new_store_disk_load() {
    use std::io::Write;
    let root = root();
    let logs = root.path().join("logs");
    std::fs::create_dir(&logs).unwrap();
    let name = format!(
        "qoder-{}.jsonl",
        loongsuite_pilot::utils::get_today_date_string()
    );
    let file = logs.join(&name);
    std::fs::write(&file, "").unwrap();
    let path = root.path().join("state.json");
    let first = Arc::new(StateStore::new(&path));
    first.load().await;
    assert!(collect(&logs, first.clone()).await.is_empty());
    let mut writer = std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap();
    for index in 0..3 {
        write!(writer, "{}", record("turn-batch1", index)).unwrap()
    }
    writer.flush().unwrap();
    let entries = collect(&logs, first.clone()).await;
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        ["turn-batch1-0", "turn-batch1-1", "turn-batch1-2"]
    );
    assert_eq!(
        first.get_offset("qoder-trace"),
        std::fs::metadata(&file).unwrap().len() as f64
    );
    assert_eq!(first.get("qoder-trace").last_file(), Some(name.as_str()));
    first.save().await.unwrap();
    drop(first);
    for index in 0..2 {
        write!(writer, "{}", record("turn-batch2", index)).unwrap()
    }
    writer.flush().unwrap();
    drop(writer);
    let second = Arc::new(StateStore::new(&path));
    second.load().await;
    let entries = collect(&logs, second.clone()).await;
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        ["turn-batch2-0", "turn-batch2-1"]
    );
    assert!(entries
        .iter()
        .all(|e| serde_json::to_value(e).unwrap()["event.name"] == "tool.result"));
    assert_eq!(
        second.get_offset("qoder-trace"),
        std::fs::metadata(&file).unwrap().len() as f64
    );
    assert!(collect(&logs, second).await.is_empty());
}
