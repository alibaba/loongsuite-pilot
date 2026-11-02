use super::*;
use crate::checkpoints::{InputState, StateStore};
use std::io::Write;
use std::sync::Arc;
const CWD: &str = "/Users/test/qwen-workspace";
const ENCODED: &str = "-Users-test-qwen-workspace";
struct Fixture {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
    history: std::path::PathBuf,
    segments: std::path::PathBuf,
    store: Arc<StateStore>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let history = root.join("history");
        let segments = root.join("sessions");
        std::fs::create_dir_all(&history).unwrap();
        std::fs::create_dir_all(&segments).unwrap();
        let store = Arc::new(StateStore::new(root.join("state.json")));
        store.set(
            "qwen-work-cn-trace",
            InputState::new()
                .with_last_file(dated(0))
                .with_last_offset(0.0),
        );
        Self {
            _temp: temp,
            root,
            history,
            segments,
            store,
        }
    }
    fn input(&self) -> QwenWorkCnTraceInput {
        QwenWorkCnTraceInput::new(QwenWorkCnTraceOptions {
            state_store: self.store.clone(),
            log_dir: Some(self.history.to_string_lossy().into_owned()),
            segments_root: Some(self.segments.to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
        })
    }
    fn history(&self, records: &[Value]) {
        std::fs::write(self.history.join(dated(0)), lines(records)).unwrap();
    }
    fn segments(&self, records: &[Value]) -> std::path::PathBuf {
        let directory = self.segments.join(ENCODED).join("session-1/segments");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("run.jsonl");
        std::fs::write(&file, lines(records)).unwrap();
        file
    }
    async fn collect(&self) -> Vec<Value> {
        let input = self.input();
        let events = Arc::new(Mutex::new(Vec::new()));
        let copy = events.clone();
        input.bind_collector(
            move |batch| {
                copy.lock()
                    .unwrap()
                    .extend(batch.iter().map(|e| serde_json::to_value(e).unwrap()))
            },
            |_| {},
        );
        input.start().await.unwrap();
        input.stop().await.unwrap();
        self.store.save().await.unwrap();
        let result = events.lock().unwrap().clone();
        result
    }
}
fn dated(offset: i64) -> String {
    format!(
        "qwen-work-cn-{}.jsonl",
        (chrono::Local::now().date_naive() + chrono::Duration::days(offset)).format("%Y-%m-%d")
    )
}
fn lines(records: &[Value]) -> String {
    records.iter().map(|v| format!("{v}\n")).collect()
}
fn entry(id: &str, kind: &str) -> Value {
    json!({"event.id":id,"event.name":kind,"gen_ai.agent.type":"qwen-work-cn","gen_ai.session.id":"session-1","gen_ai.turn.id":"turn-1","gen_ai.step.id":"turn-1:s1","agent.qwenworkcn.cwd":CWD,"time_unix_nano":"1785996005000000000"})
}
fn request() -> Value {
    let mut r = entry("request", "llm.request");
    r["gen_ai.request.model"] = json!("unknown");
    r
}
fn response(id: &str) -> Value {
    let mut r = entry("response", "llm.response");
    r["gen_ai.request.model"] = json!("unknown");
    r["gen_ai.response.id"] = json!(id);
    r
}
fn segment_pair(input: i64, output: i64, cache: bool) -> Vec<Value> {
    let mut data = json!({"model":"qmodel_latest","input_tokens":input,"output_tokens":output});
    if cache {
        data["cache_read_input_tokens"] = json!(60);
        data["cache_creation_input_tokens"] = json!(10);
    }
    vec![
        json!({"ts":"2026-08-06T06:00:00.000Z","type":"model.request.started","turn_id":"turn-1","request_id":"request-1","data":{"model":"qmodel_latest"}}),
        json!({"ts":"2026-08-06T06:00:05.000Z","type":"model.response.completed","turn_id":"turn-1","request_id":"request-1","data":data}),
    ]
}
#[tokio::test]
async fn source_l74_real_trace_identity_and_default_and_explicit_native_watch_paths() {
    let f = Fixture::new();
    let input = f.input();
    assert_eq!(input.inner.id(), "qwen-work-cn-trace");
    assert_eq!(input.inner.body.agent_type(), ClientType::QwenWorkCN);
    assert_eq!(
        input.inner.body.collection_method(),
        CollectionMethod::HookJsonl
    );
    let defaults = QwenWorkCnTraceInput::get_watch_paths(None, None);
    assert!(defaults[0]
        .replace('\\', "/")
        .ends_with("qwen-work-cn/history"));
    assert!(defaults[1]
        .replace('\\', "/")
        .ends_with(".qwenworkcn/logs/sessions"));
    assert_eq!(
        QwenWorkCnTraceInput::get_watch_paths(
            Some(f.history.to_str().unwrap()),
            Some(f.segments.to_str().unwrap())
        ),
        vec![f.history.to_string_lossy(), f.segments.to_string_lossy()]
    );
}
#[tokio::test]
async fn source_l89_real_trace_strips_bare_version_and_preserves_agent_scoped_version() {
    let f = Fixture::new();
    let mut record = entry("event", "llm.response");
    record["version"] = json!("0.1.5");
    record["agent.qwenworkcn.version"] = json!("0.1.5");
    f.history(&[record]);
    let e = f.collect().await;
    assert_eq!(e.len(), 1);
    assert!(e[0].get("version").is_none());
    assert_eq!(e[0]["agent.qwenworkcn.version"], "0.1.5");
}
#[tokio::test]
async fn source_l104_native_zero_usage_keeps_model_and_timing_without_legacy_intercept_overlay() {
    let f = Fixture::new();
    let mut call = entry("tool-call", "tool.call");
    call["gen_ai.request.model"] = json!("unknown");
    let mut result = entry("tool-result", "tool.result");
    result["gen_ai.request.model"] = json!("unknown");
    f.history(&[request(), call, result, response("chatcmpl-qwen-1")]);
    f.segments(&segment_pair(0, 0, false));
    let legacy = lines(&[
        json!({"type":"token","ts":chrono::Utc::now().timestamp_millis(),"id":"chatcmpl-qwen-1","prompt_tokens":32244,"completion_tokens":667,"cached_tokens":24576,"reasoning_tokens":285,"total_tokens":32911}),
        json!({"type":"system_prompt","ts":chrono::Utc::now().timestamp_millis(),"content":"Synthetic legacy instructions"}),
    ]);
    let path = f.root.join("qwenworkcn-intercept.jsonl");
    std::fs::write(&path, &legacy).unwrap();
    let e = f.collect().await;
    assert_eq!(e.len(), 4);
    let response = e.iter().find(|v| v["event.id"] == "response").unwrap();
    let request = e.iter().find(|v| v["event.id"] == "request").unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), legacy);
    assert_eq!(request["time_unix_nano"], "1785996000000000000");
    assert_eq!(response["time_unix_nano"], "1785996005000000000");
    assert!(request.get("gen_ai.system_instructions").is_none());
    for field in [
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "gen_ai.usage.cache_read.input_tokens",
        "gen_ai.usage.reasoning_tokens",
        "gen_ai.usage.total_tokens",
    ] {
        assert!(response.get(field).is_none(), "{field}");
    }
    assert_eq!(response["workspace.path"], CWD);
    assert_eq!(response["gen_ai.request.model"], "qmodel_latest");
    assert_eq!(response["gen_ai.response.model"], "qmodel_latest");
    assert!(e
        .iter()
        .all(|v| v["gen_ai.request.model"] == "qmodel_latest"
            && v["gen_ai.agent.type"] == "qwen-work-cn"));
    assert!(regex::Regex::new("^[0-9a-f]{32}$")
        .unwrap()
        .is_match(e[0]["trace_id"].as_str().unwrap()));
}
#[tokio::test]
async fn source_l164_native_tokens_and_both_cache_fields_win_without_intercept_reasoning() {
    let f = Fixture::new();
    f.history(&[request(), response("chatcmpl-qwen-2")]);
    f.segments(&segment_pair(100, 20, true));
    let path = f.root.join("qwenworkcn-intercept.jsonl");
    let legacy = lines(&[
        json!({"type":"token","ts":chrono::Utc::now().timestamp_millis(),"id":"chatcmpl-qwen-2","prompt_tokens":999,"completion_tokens":999,"cached_tokens":80,"reasoning_tokens":7,"total_tokens":1998}),
    ]);
    std::fs::write(&path, &legacy).unwrap();
    let e = f.collect().await;
    let response = e.iter().find(|v| v["event.id"] == "response").unwrap();
    for (field, value) in [
        ("gen_ai.usage.input_tokens", 100),
        ("gen_ai.usage.output_tokens", 20),
        ("gen_ai.usage.total_tokens", 120),
        ("gen_ai.usage.cache_read.input_tokens", 60),
        ("gen_ai.usage.cache_creation.input_tokens", 10),
    ] {
        assert_eq!(response[field], json!(value));
    }
    assert!(response.get("gen_ai.usage.reasoning_tokens").is_none());
    assert_eq!(std::fs::read_to_string(path).unwrap(), legacy);
}
#[tokio::test]
async fn source_l189_foreign_qoder_intercept_does_not_supply_usage() {
    let f = Fixture::new();
    f.history(&[request(), response("chatcmpl-qoder-only")]);
    let path = f.root.join("qoderwork-intercept.jsonl");
    let legacy = lines(&[
        json!({"type":"token","ts":chrono::Utc::now().timestamp_millis(),"id":"chatcmpl-qoder-only","prompt_tokens":100,"completion_tokens":20,"total_tokens":120}),
    ]);
    std::fs::write(&path, &legacy).unwrap();
    let e = f.collect().await;
    let response = e.iter().find(|v| v["event.id"] == "response").unwrap();
    assert!(response.get("gen_ai.usage.input_tokens").is_none());
    assert_eq!(std::fs::read_to_string(path).unwrap(), legacy);
}
#[tokio::test]
async fn source_l204_actual_legacy_multiday_checkpoint_drains_pending_files_without_replay() {
    let f = Fixture::new();
    let old = dated(-2);
    let middle = dated(-1);
    let consumed = lines(&[entry("old-consumed", "other")]);
    std::fs::write(
        f.history.join(&old),
        format!("{consumed}{}", lines(&[entry("old-pending", "other")])),
    )
    .unwrap();
    std::fs::write(
        f.history.join(&middle),
        lines(&[entry("middle-new", "other")]),
    )
    .unwrap();
    f.history(&[entry("today-new", "other")]);
    f.store.set(
        "qwen-work-cn-trace",
        InputState::new()
            .with_last_file(&old)
            .with_last_offset(consumed.len() as f64),
    );
    let first = f.collect().await;
    assert_eq!(
        first
            .iter()
            .map(|v| v["event.id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["old-pending", "middle-new", "today-new"]
    );
    let offsets = f.store.get("qwen-work-cn-trace").extra().unwrap()["hookLogOffsets"].clone();
    for name in [old, middle, dated(0)] {
        assert_eq!(
            offsets[&name].as_f64(),
            Some(std::fs::metadata(f.history.join(name)).unwrap().len() as f64)
        );
    }
    assert!(f.collect().await.is_empty());
}
#[tokio::test]
async fn source_l232_incomplete_hook_tail_does_not_checkpoint_until_newline() {
    let f = Fixture::new();
    let file = f.history.join(dated(0));
    std::fs::write(&file, entry("completed-later", "other").to_string()).unwrap();
    assert!(f.collect().await.is_empty());
    assert_eq!(
        f.store.get("qwen-work-cn-trace").extra().unwrap()["hookLogOffsets"][dated(0)].as_f64(),
        Some(0.0)
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(file)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    let e = f.collect().await;
    assert_eq!(
        e.iter()
            .map(|v| v["event.id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["completed-later"]
    );
}
#[tokio::test]
async fn source_l245_actual_segment_reader_defers_incomplete_row_and_pair_until_newline() {
    let f = Fixture::new();
    let record = segment_pair(0, 0, false).remove(0);
    let file = f.segments(&[]);
    std::fs::write(&file, record.to_string()).unwrap();
    let input = f.input();
    let path = file.to_string_lossy().into_owned();
    let key = format!("qwen-work-cn-trace:segment:{path}");
    input
        .inner
        .body
        .read_segment_file(&input.inner.runtime, "session-1", &path)
        .await;
    assert_eq!(f.store.get_offset(&key), 0.0);
    assert!(!input
        .inner
        .body
        .in_flight_pairs
        .lock()
        .unwrap()
        .contains_key("session-1"));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    input
        .inner
        .body
        .read_segment_file(&input.inner.runtime, "session-1", &path)
        .await;
    assert_eq!(
        f.store.get_offset(&key),
        std::fs::metadata(file).unwrap().len() as f64
    );
    assert!(
        input.inner.body.in_flight_pairs.lock().unwrap()["session-1"].contains_key("request-1")
    );
}
