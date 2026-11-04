use super::*;
use crate::inputs::base::InputRuntimeDelta;
use std::time::Duration;

struct ObservedInput {
    input: DshLogInput,
    store: Arc<StateStore>,
    entries: Arc<Mutex<Vec<AgentActivityEntry>>>,
    deltas: Arc<Mutex<Vec<InputRuntimeDelta>>>,
}

async fn observed(dir: &Path) -> ObservedInput {
    let store = Arc::new(StateStore::new(dir.join("input-state.json")));
    let input = make_input(dir, store.clone()).await;
    let entries = Arc::new(Mutex::new(Vec::new()));
    let entry_sink = entries.clone();
    input.on_entries(move |batch| entry_sink.lock().unwrap().extend_from_slice(batch));
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let delta_sink = deltas.clone();
    input.on_runtime_delta(move |delta| delta_sink.lock().unwrap().push(delta.clone()));
    ObservedInput {
        input,
        store,
        entries,
        deltas,
    }
}

async fn poll(input: &ObservedInput) -> (Vec<AgentActivityEntry>, InputRuntimeDelta) {
    input.entries.lock().unwrap().clear();
    input.deltas.lock().unwrap().clear();
    input.input.start().await;
    input.input.stop().await;
    let entries = input.entries.lock().unwrap().clone();
    let deltas = input.deltas.lock().unwrap();
    assert_eq!(deltas.len(), 1, "one actual runtime delta per poll");
    (entries, deltas[0].clone())
}

async fn original_budget(future: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("original f72 DSH per-case 15000ms budget");
}

fn serialize(records: &[Value]) -> String {
    records.iter().map(|record| format!("{record}\n")).collect()
}

fn chunk_record(sid: &str) -> Value {
    json!({"type":"assistant/chunk","sid":sid,"time":10,
        "data":{"turn":1,"step":1,"chunk":{"type":"block-start"}}})
}

fn events(entries: &[AgentActivityEntry]) -> Vec<&str> {
    entries
        .iter()
        .map(|entry| entry.event_name.expect("actual DSH event").as_str())
        .collect()
}

fn state_key(path: &Path) -> String {
    format!("dsh-log:{}", path.to_string_lossy())
}

#[tokio::test]
async fn main553_idle_polls_preserve_shared_checkpoint_and_legacy_metadata() {
    original_budget(async {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dsh-session-a.jsonl");
        let mut records = prefix("session-a", "provider-a", "prompt-a");
        records.push(chunk_record("session-a"));
        records.push(json!({"type":"turn/end","sid":"session-a","time":11,"data":{"turn":1}}));
        append(&file, &records);
        let first = observed(dir.path()).await;
        poll(&first).await;
        let state_path = dir.path().join("input-state.json");
        let mut persisted: Value =
            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        persisted[&state_key(&file)]["extra"]
            .as_object_mut()
            .unwrap()
            .remove("dshDiscardedLineStartOffset");
        persisted["another-input"] = json!({"extra":{"retained":"unrelated checkpoint"}});
        std::fs::write(&state_path, persisted.to_string()).unwrap();
        let original_bytes = std::fs::read(&state_path).unwrap();
        let second = observed(dir.path()).await;
        assert!(poll(&second).await.0.is_empty());
        let (entries, idle) = poll(&second).await;
        assert!(entries.is_empty());
        assert_eq!(idle.raw_read_calls, 0);
        assert_eq!(idle.raw_read_bytes, 0);
        assert_eq!(idle.raw_in_bytes, 0);
        assert_eq!(second.store.revision(), 0);
        assert_eq!(std::fs::read(&state_path).unwrap(), original_bytes);
        let after: Value = serde_json::from_slice(&original_bytes).unwrap();
        assert_eq!(after, persisted);
    })
    .await;
}

#[tokio::test]
async fn main553_complete_twelve_mib_record_commits_and_restores_header_after_restart() {
    original_budget(async {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dsh-session-a.jsonl");
        let mut header = prefix("session-a", "provider-a", "prompt-a")[3].clone();
        header["padding"] = json!("字".repeat(4 * 1024 * 1024));
        append(&file, &[header]);
        let bytes = std::fs::metadata(&file).unwrap().len();
        let first = observed(dir.path()).await;
        let (_, metrics) = poll(&first).await;
        assert_eq!(first.store.get_offset(&state_key(&file)), bytes as f64);
        assert_eq!(metrics.raw_read_bytes, bytes);
        assert_eq!(metrics.raw_in_bytes, bytes);
        assert_eq!(metrics.raw_in_records, 1);
        assert_eq!(metrics.raw_in_max_record_bytes, bytes);
        assert_eq!(metrics.raw_backlog_bytes_max, bytes);
        assert_eq!(metrics.parse_success_records, 1);
        assert_eq!(metrics.parse_failed_records, 0);
        assert!(metrics.raw_read_calls > 1);
        assert!(metrics.raw_in_max_batch_bytes <= 256 * 1024);
        let mut suffix = prefix("session-a", "provider-a", "prompt-a")[..3].to_vec();
        suffix.push(chunk_record("session-a"));
        append(&file, &suffix);
        let second = observed(dir.path()).await;
        let (entries, resumed) = poll(&second).await;
        let models: Vec<_> = entries
            .iter()
            .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .map(|entry| entry_json(entry)["gen_ai.request.model"].clone())
            .collect();
        assert_eq!(models, vec![json!("provider-a-model")]);
        assert!(resumed.raw_read_bytes > resumed.raw_in_bytes);
        assert_eq!(resumed.raw_in_records, 4);
    })
    .await;
}

#[tokio::test]
async fn main553_oversized_record_skip_progress_survives_restart_and_resumes_following_rows() {
    original_budget(async {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dsh-session-a.jsonl");
        let records = prefix("session-a", "provider-a", "prompt-a");
        let start = serialize(&records[..1]);
        let oversized =
            json!({"type":"ignored","padding":"x".repeat(25 * 1024 * 1024)}).to_string() + "\n";
        let start_bytes = start.len() as u64;
        std::fs::write(&file, start + &oversized).unwrap();
        let first = observed(dir.path()).await;
        let (entries, initial) = poll(&first).await;
        assert!(entries.is_empty());
        assert_eq!(initial.raw_read_bytes, 8 * 1024 * 1024);
        assert_eq!(
            first.store.get_offset(&state_key(&file)),
            start_bytes as f64
        );
        let (_, skipping) = poll(&first).await;
        assert_eq!(skipping.raw_read_bytes, 16 * 1024 * 1024);
        assert_eq!(skipping.raw_in_records, 0);
        assert_eq!(
            first.store.get_offset(&state_key(&file)),
            (start_bytes + 16 * 1024 * 1024) as f64
        );
        let mut suffix_records = records[1..].to_vec();
        suffix_records.push(chunk_record("session-a"));
        let suffix = serialize(&suffix_records);
        use std::io::Write;
        let mut output = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        output.write_all(suffix.as_bytes()).unwrap();
        drop(output);
        let second = observed(dir.path()).await;
        let (entries, continued) = poll(&second).await;
        assert!(entries.is_empty());
        assert_eq!(continued.raw_read_bytes, start_bytes + 8 * 1024 * 1024);
        let resume = start_bytes + 24 * 1024 * 1024;
        assert_eq!(second.store.get_offset(&state_key(&file)), resume as f64);
        let (entries, resumed) = poll(&second).await;
        assert_eq!(events(&entries), vec!["other", "llm.request"]);
        let bytes = start_bytes + oversized.len() as u64 + suffix.len() as u64;
        assert_eq!(resumed.raw_read_bytes, bytes - resume);
        assert_eq!(resumed.raw_in_max_record_bytes, oversized.len() as u64);
        assert_eq!(resumed.raw_in_records, 6);
        assert_eq!(resumed.parse_success_records, 5);
        assert_eq!(resumed.parse_failed_records, 1);
        assert_eq!(second.store.get_offset(&state_key(&file)), bytes as f64);
        assert_eq!(poll(&second).await.1.raw_read_bytes, 0);
    })
    .await;
}

#[tokio::test]
async fn main553_truncate_and_replace_clear_persisted_oversized_progress() {
    for variant in ["truncated", "replaced"] {
        original_budget(async {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("dsh-session-a.jsonl");
            std::fs::write(&file, "x".repeat(16 * 1024 * 1024)).unwrap();
            let first = observed(dir.path()).await;
            poll(&first).await;
            assert_eq!(
                first.store.get_offset(&state_key(&file)),
                (16 * 1024 * 1024) as f64
            );
            let replacement = if variant == "truncated" {
                file.clone()
            } else {
                dir.path().join("replacement.jsonl")
            };
            let mut records = prefix("session-new", "new-provider", "new-prompt");
            records.push(chunk_record("session-new"));
            std::fs::write(&replacement, serialize(&records)).unwrap();
            if variant == "replaced" {
                std::fs::rename(&replacement, &file).unwrap();
            }
            let second = observed(dir.path()).await;
            let (entries, metrics) = poll(&second).await;
            let sessions: Vec<_> = entries
                .iter()
                .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
                .map(|entry| entry.session_id.clone())
                .collect();
            assert_eq!(sessions, vec!["session-new"], "{variant}");
            assert_eq!(metrics.parse_failed_records, 0, "{variant}");
        })
        .await;
    }
}

#[tokio::test]
async fn main553_static_incomplete_tail_reads_zero_until_append_and_counts_bad_json() {
    original_budget(async {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dsh-session-a.jsonl");
        let initial = serialize(&prefix("session-a", "provider-a", "prompt-a"));
        let partial = chunk_record("session-a").to_string();
        std::fs::write(&file, initial.clone() + &partial).unwrap();
        let input = observed(dir.path()).await;
        let (_, metrics) = poll(&input).await;
        assert_eq!(
            metrics.raw_read_bytes,
            (initial.len() + partial.len()) as u64
        );
        assert_eq!(metrics.raw_in_bytes, initial.len() as u64);
        assert_eq!(metrics.raw_in_records, 5);
        let revision = input.store.revision();
        let (_, idle) = poll(&input).await;
        assert_eq!(idle.raw_read_bytes, 0);
        assert_eq!(idle.raw_in_bytes, 0);
        assert_eq!(idle.raw_backlog_bytes_max, partial.len() as u64);
        assert_eq!(input.store.revision(), revision);
        use std::io::Write;
        let mut output = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        output.write_all(b"\n{bad json}\n").unwrap();
        drop(output);
        let (entries, resumed) = poll(&input).await;
        assert_eq!(events(&entries), vec!["llm.request"]);
        assert_eq!(
            resumed.raw_read_bytes,
            (partial.len() + "\n{bad json}\n".len()) as u64
        );
        assert_eq!(resumed.raw_in_records, 2);
        assert_eq!(resumed.parse_success_records, 1);
        assert_eq!(resumed.parse_failed_records, 1);
    })
    .await;
}
