//! Collection-level ef8953 source contracts, with explicit isolated source readers.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::{InputState, StateStore};
use loongsuite_pilot::inputs::base::{InputBody, InputRuntimeDelta};
use loongsuite_pilot::inputs::qoder_trace::{
    AttachedImageLookup, InterceptData, QoderTraceInput, QoderTraceOptions, QoderTraceReaders,
    SegmentTokenData, SqliteTokenResult,
};
use loongsuite_pilot::types::AgentActivityEntry;
use loongsuite_pilot::utils::get_today_date_string;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct Readers {
    segments: Vec<SegmentTokenData>,
    queries: Mutex<Vec<Vec<String>>>,
}
#[async_trait]
impl QoderTraceReaders for Readers {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, ids: &[String]) -> Vec<SegmentTokenData> {
        self.queries.lock().unwrap().push(ids.to_vec());
        self.segments.clone()
    }
    async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
        SqliteTokenResult {
            rows: vec![],
            matched_db_path: None,
        }
    }
    async fn read_ide_images(
        &self,
        _: &[String],
    ) -> Result<HashMap<String, AttachedImageLookup>, String> {
        Ok(HashMap::new())
    }
}
fn input(root: &Path, store: Arc<StateStore>, readers: Arc<Readers>) -> QoderTraceInput {
    QoderTraceInput::with_readers(
        QoderTraceOptions {
            state_store: store,
            log_dir: Some(root.to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
            multimodal_enabled: false,
            upload_mode: None,
            allowed_root_paths: vec![],
        },
        readers,
    )
}
fn filename() -> String {
    format!("qoder-{}.jsonl", get_today_date_string())
}
fn initialized(root: &Path) -> Arc<StateStore> {
    let store = Arc::new(StateStore::new(root.join("state.json")));
    store.set(
        "qoder-trace",
        InputState::new()
            .with_last_file(filename())
            .with_last_offset(0.0)
            .with_extra(json!({"hookHistoryInitialized":true})),
    );
    store
}
fn base(id: &str, turn: &str, name: &str, time: &str) -> Value {
    json!({"event.id":id,"event.name":name,"gen_ai.session.id":"sess-1",
 "gen_ai.turn.id":turn,"gen_ai.step.id":format!("{turn}:s1"),"gen_ai.agent.type":"qoder-cli","time_unix_nano":time})
}
fn write(root: &Path, values: &[Value]) -> PathBuf {
    let p = root.join(filename());
    std::fs::write(
        &p,
        values.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
    p
}
fn append(path: &Path, values: &[Value]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    for v in values {
        writeln!(f, "{v}").unwrap();
    }
}
fn event<'a>(values: &'a [AgentActivityEntry], id: &str) -> &'a AgentActivityEntry {
    values.iter().find(|e| e.event_id == id).unwrap()
}
#[tokio::test]
async fn collect_l1461_segments_only_after_primary_gap_in_source_order() {
    // Repeated fresh maps expose the old randomized HashMap traversal reliably.
    for _ in 0..64 {
        let d = tempfile::tempdir().unwrap();
        let store = initialized(d.path());
        let mut complete = base(
            "complete-response",
            "turn-complete",
            "llm.response",
            "1780000001000000000",
        );
        complete["gen_ai.usage.input_tokens"] = json!(100);
        complete["gen_ai.usage.output_tokens"] = json!(20);
        complete["gen_ai.usage.total_tokens"] = json!(120);
        let file = write(
            d.path(),
            &[
                base(
                    "complete-request",
                    "turn-complete",
                    "llm.request",
                    "1780000000000000000",
                ),
                complete,
            ],
        );
        let readers = Arc::new(Readers {
            segments: vec![
                SegmentTokenData {
                    request_id: "missing-request-id".into(),
                    input_tokens: 200,
                    output_tokens: 30,
                    request_start_ts: 1780000002000,
                    response_end_ts: 1780000003000,
                    ..Default::default()
                },
                SegmentTokenData {
                    request_id: "second-missing-request-id".into(),
                    input_tokens: 300,
                    output_tokens: 40,
                    request_start_ts: 1780000004000,
                    response_end_ts: 1780000005000,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        let input = input(d.path(), store, readers.clone());
        let first = input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .unwrap();
        assert_eq!(event(&first, "complete-response").total_tokens, Some(120));
        assert!(readers.queries.lock().unwrap().is_empty());
        let mut response = base(
            "missing-response",
            "turn-missing",
            "llm.response",
            "1780000004000000000",
        );
        response["agent.client_request_id"] = json!("missing-request-id");
        let mut second_response = base(
            "second-missing-response",
            "turn-second-missing",
            "llm.response",
            "1780000006000000000",
        );
        second_response["agent.client_request_id"] = json!("second-missing-request-id");
        append(
            &file,
            &[
                base(
                    "missing-request",
                    "turn-missing",
                    "llm.request",
                    "1780000004000000000",
                ),
                response,
                base(
                    "second-missing-request",
                    "turn-second-missing",
                    "llm.request",
                    "1780000006000000000",
                ),
                second_response,
            ],
        );
        let second = input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .unwrap();
        assert_eq!(
            *readers.queries.lock().unwrap(),
            vec![vec!["missing-request-id", "second-missing-request-id"]]
        );
        let a = event(&second, "missing-response");
        assert_eq!(a.input_tokens, Some(200));
        assert_eq!(a.output_tokens, Some(30));
        assert_eq!(a.time_unix_nano, "1780000003000000000");
        let b = event(&second, "second-missing-response");
        assert_eq!(b.input_tokens, Some(300));
        assert_eq!(b.output_tokens, Some(40));
        assert_eq!(b.time_unix_nano, "1780000005000000000");
    }
}
fn bootstrap(id: &str, turn: &str, batch: &str, session: bool) -> Value {
    let mut record = json!({"event.id":id,"event.name":"llm.response","gen_ai.agent.type":"qoder","gen_ai.turn.id":turn,
  "agent.transcript.cursor_mode":"bootstrap","agent.transcript.cursor_batch_id":batch,"time_unix_nano":"1780000000000000000"});
    if session {
        record["gen_ai.session.id"] = json!(batch);
    }
    record
}
fn batches(session: bool) -> Vec<Value> {
    vec![
        bootstrap(
            "session-a-old",
            "session-a-old-turn",
            "session-a-batch",
            session,
        ),
        bootstrap(
            "session-a-latest",
            "session-a-latest-turn",
            "session-a-batch",
            session,
        ),
        bootstrap(
            "session-b-old",
            "session-b-old-turn",
            "session-b-batch",
            session,
        ),
        bootstrap(
            "session-b-latest",
            "session-b-latest-turn",
            "session-b-batch",
            session,
        ),
    ]
}
#[tokio::test]
async fn history_l3032_empty_start_preserves_later_batches() {
    let d = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(d.path().join("state.json")));
    let input = input(d.path(), store.clone(), Arc::new(Readers::default()));
    input.start().await.unwrap();
    let state = store.get("qoder-trace");
    assert_eq!(state.last_file(), Some(filename().as_str()));
    assert_eq!(state.last_offset(), Some(0.0));
    assert_eq!(state.extra().unwrap()["hookHistoryInitialized"], true);
    write(d.path(), &batches(true));
    let entries = input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap();
    input.stop().await.unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["session-a-latest", "session-b-latest"]
    );
}
#[tokio::test]
async fn history_l3079_initialized_file_protects_later_old_sessions() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), &batches(false));
    let store = Arc::new(StateStore::new(d.path().join("state.json")));
    store.set(
        "qoder-trace",
        InputState::new()
            .with_last_file(filename())
            .with_last_offset(0.0),
    );
    let input = input(d.path(), store, Arc::new(Readers::default()));
    let entries = Arc::new(Mutex::new(vec![]));
    let output = entries.clone();
    input.bind_collector(
        move |batch| output.lock().unwrap().extend_from_slice(batch),
        |_| {},
    );
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(
        entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["session-a-latest", "session-b-latest"]
    );
}
#[tokio::test]
async fn runtime_l3125_physical_complete_records_and_half_line() {
    let d = tempfile::tempdir().unwrap();
    let store = initialized(d.path());
    let current = base("current", "turn-1", "llm.response", "1780000001000000000").to_string();
    let later = base("later", "turn-2", "llm.response", "1780000001000000000").to_string();
    let split = later.len() / 2;
    let prefix = format!("not-json\n{current}\n");
    let first = format!("{prefix}{}", &later[..split]);
    let file = d.path().join(filename());
    std::fs::write(&file, &first).unwrap();
    let input = input(d.path(), store.clone(), Arc::new(Readers::default()));
    let deltas: Arc<Mutex<Vec<InputRuntimeDelta>>> = Arc::new(Mutex::new(vec![]));
    let output = deltas.clone();
    input.bind_collector(
        |_| {},
        move |delta| output.lock().unwrap().push(delta.clone()),
    );
    input.start().await.unwrap();
    input.stop().await.unwrap();
    {
        let deltas = deltas.lock().unwrap();
        assert_eq!(deltas.len(), 1);
        let delta = &deltas[0];
        assert_eq!(delta.source_kind, "primary");
        assert_eq!(delta.raw_read_calls, 1);
        assert_eq!(delta.raw_read_bytes, first.len() as u64);
        assert_eq!(delta.raw_in_records, 2);
        assert_eq!(delta.raw_in_bytes, prefix.len() as u64);
        assert_eq!(delta.parse_success_records, 1);
        assert_eq!(delta.parse_failed_records, 1);
        assert_eq!(delta.raw_in_max_record_bytes, (current.len() + 1) as u64);
    }
    assert_eq!(
        store.get("qoder-trace").last_offset(),
        Some(prefix.len() as f64)
    );
    {
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new().append(true).open(file).unwrap(),
            "{}",
            &later[split..]
        )
        .unwrap();
    }
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let deltas = deltas.lock().unwrap();
    assert_eq!(deltas.len(), 2);
    let delta = &deltas[1];
    assert_eq!(delta.raw_read_calls, 1);
    assert_eq!(delta.raw_read_bytes, (later.len() + 1) as u64);
    assert_eq!(delta.raw_in_records, 1);
    assert_eq!(delta.raw_in_bytes, (later.len() + 1) as u64);
    assert_eq!(delta.parse_success_records, 1);
    assert_eq!(delta.parse_failed_records, 0);
}
