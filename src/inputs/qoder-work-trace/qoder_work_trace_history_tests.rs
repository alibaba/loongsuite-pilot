//! Real isolated hook/segments/SDK files for the pinned Qoder Work contracts.
use super::*;
use crate::checkpoints::{InputState, StateStore};
use std::sync::Arc;
const CWD: &str = "/Users/test/.qoderwork/workspace/wsabc";
const ENCODED: &str = "-Users-test--qoderwork-workspace-wsabc";
struct Fixture {
    root: tempfile::TempDir,
    input: Arc<QoderWorkTraceInput>,
    store: Arc<StateStore>,
}
impl Fixture {
    fn new() -> Self {
        Self::initialized(true)
    }
    fn initialized(initialized: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        for dir in ["hook-history", "sessions", "sdk-logs"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        if initialized {
            store.set(
                "qoder-work-trace",
                InputState::new()
                    .with_last_file(filename())
                    .with_last_offset(0.0)
                    .with_extra(json!({"hookHistoryInitialized":true})),
            );
        }
        let input = Arc::new(QoderWorkTraceInput::new(QoderWorkTraceOptions {
            state_store: store.clone(),
            log_dir: Some(
                root.path()
                    .join("hook-history")
                    .to_string_lossy()
                    .into_owned(),
            ),
            segments_root: Some(root.path().join("sessions").to_string_lossy().into_owned()),
            sdk_log_dir: Some(root.path().join("sdk-logs").to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
        }));
        Self { root, input, store }
    }
    fn hook(&self, rows: &[Value]) {
        write_lines(
            &self.root.path().join("hook-history").join(filename()),
            rows,
        );
    }
    fn segments(&self, session: &str, file: &str, rows: &[Value]) {
        let path = self
            .root
            .path()
            .join("sessions")
            .join(ENCODED)
            .join(session)
            .join("segments")
            .join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_lines(&path, rows);
    }
    async fn collect(&self) -> Vec<AgentActivityEntry> {
        self.input
            .inner
            .body
            .collect(&self.input.inner.runtime)
            .await
            .unwrap()
    }
}
fn filename() -> String {
    format!("qoder-work-{}.jsonl", get_today_date_string())
}
fn write_lines(path: &Path, rows: &[Value]) {
    std::fs::write(
        path,
        rows.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
}
fn entry(id: &str, name: &str, session: &str, turn: &str, step: usize) -> Value {
    json!({"event.id":id,"event.name":name,"gen_ai.session.id":session,"gen_ai.turn.id":turn,
 "gen_ai.step.id":format!("{turn}:s{step}"),"gen_ai.agent.type":"qoder-work",
 "gen_ai.output.messages":"[{\"role\":\"assistant\",\"parts\":[{\"type\":\"reasoning\",\"content\":\"thinking\"},{\"type\":\"text\",\"content\":\"hello\"}]}]",
 "agent.source":"qoder-transcript-hook","agent.qoderwork.cwd":CWD,"time_unix_nano":"1780000000000000000"})
}
fn nano(iso: &str) -> String {
    (chrono::DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .timestamp_millis() as i128
        * 1000000)
        .to_string()
}
fn find<'a>(entries: &'a [AgentActivityEntry], id: &str) -> &'a AgentActivityEntry {
    entries.iter().find(|e| e.event_id == id).unwrap()
}
#[tokio::test]
async fn work_l721_retry_pairs_by_loop_despite_changed_request_id() {
    let f = Fixture::new();
    let sid = "sess-retry-loop";
    let turn = "turn-retry-loop";
    let loop_id = format!("{turn}:1");
    f.hook(&[
        entry("retry-req", "llm.request", sid, turn, 1),
        entry("retry-resp", "llm.response", sid, turn, 1),
    ]);
    f.segments(sid,"retry.jsonl",&[
  json!({"ts":"2026-08-25T11:33:40.419+08:00","type":"loop.iteration.started","turn_id":turn,"loop_id":loop_id,"data":{"request_index":1}}),
  json!({"ts":"2026-08-25T11:33:40.421+08:00","type":"model.request.started","turn_id":turn,"request_id":"request-a","loop_id":loop_id,"data":{"model":"initial-model"}}),
  json!({"ts":"2026-08-25T11:33:41.722+08:00","type":"model.request.attempt_failed","turn_id":turn,"request_id":"request-a","loop_id":loop_id,"data":{"attempt_had_payload":false,"stream_event_count":0}}),
  json!({"ts":"2026-08-25T11:33:57.690+08:00","type":"model.response.completed","turn_id":turn,"request_id":"request-b","loop_id":loop_id,"data":{"model":"final-model","input_tokens":123,"output_tokens":45}}),
  json!({"ts":"2026-08-25T11:34:01.320+08:00","type":"loop.iteration.finished","turn_id":turn,"loop_id":loop_id,"data":{"request_index":1}}),
 ]);
    let out = f.collect().await;
    let request = find(&out, "retry-req");
    let response = find(&out, "retry-resp");
    assert_eq!(
        request.time_unix_nano,
        nano("2026-08-25T11:33:40.421+08:00")
    );
    assert_eq!(
        request.extra["agent.qoderwork.step.start_time_unix_nano"],
        nano("2026-08-25T11:33:40.419+08:00")
    );
    assert_eq!(
        request.extra["agent.qoderwork.step.end_time_unix_nano"],
        nano("2026-08-25T11:34:01.320+08:00")
    );
    assert_eq!(
        response.time_unix_nano,
        nano("2026-08-25T11:33:57.690+08:00")
    );
    assert_eq!(response.response_model.as_deref(), Some("final-model"));
    assert_eq!(response.input_tokens, Some(123));
    assert_eq!(response.output_tokens, Some(45));
}

fn value(e: &AgentActivityEntry) -> Value {
    serde_json::to_value(e).unwrap()
}
fn segment(
    kind: &str,
    turn: &str,
    request: Option<&str>,
    time: &str,
    data: Value,
    loop_id: Option<&str>,
) -> Value {
    let mut e = json!({"type":kind,"turn_id":turn,"ts":time,"data":data});
    if let Some(id) = request {
        e["request_id"] = json!(id);
    }
    if let Some(id) = loop_id {
        e["loop_id"] = json!(id);
    }
    e
}
fn start(turn: &str, id: &str, time: &str, model: &str, loop_id: Option<&str>) -> Value {
    segment(
        "model.request.started",
        turn,
        Some(id),
        time,
        json!({"model":model}),
        loop_id,
    )
}
fn end(
    turn: &str,
    id: &str,
    time: &str,
    model: &str,
    usage: Value,
    loop_id: Option<&str>,
) -> Value {
    let mut data = usage.as_object().unwrap().clone();
    data.insert("model".into(), json!(model));
    segment(
        "model.response.completed",
        turn,
        Some(id),
        time,
        Value::Object(data),
        loop_id,
    )
}
fn iteration(turn: &str, id: &str, index: usize, kind: &str, time: &str) -> Value {
    segment(
        &format!("loop.iteration.{kind}"),
        turn,
        None,
        time,
        json!({"request_index":index}),
        Some(id),
    )
}
fn tool(turn: &str, id: &str, kind: &str, time: &str) -> Value {
    let mut e = segment(
        kind,
        turn,
        None,
        time,
        json!({"tool_name":"TodoWrite","status":"success"}),
        None,
    );
    e["tool_call_id"] = json!(id);
    e
}
fn hook_tool(sid: &str, id: &str, kind: &str, source: &str, time: &str) -> Value {
    let mut e = segment(
        "hook.started",
        sid,
        None,
        time,
        json!({"hook_event_name":kind,"source":source}),
        None,
    );
    e["tool_call_id"] = json!(id);
    e
}
fn pair(sid: &str, turn: &str, step: usize, prefix: &str) -> Vec<Value> {
    vec![
        entry(&format!("{prefix}-req"), "llm.request", sid, turn, step),
        entry(&format!("{prefix}-resp"), "llm.response", sid, turn, step),
    ]
}
fn append(path: &Path, rows: &[Value]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    for row in rows {
        writeln!(f, "{row}").unwrap();
    }
}
impl Fixture {
    fn hook_path(&self) -> std::path::PathBuf {
        self.root.path().join("hook-history").join(filename())
    }
    fn append(&self, rows: &[Value]) {
        append(&self.hook_path(), rows);
    }
    fn sdk(&self, name: &str, sid: &str, start: &str, end: &str, input: i64, output: i64) {
        let d = self.root.path().join("sdk-logs").join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("main.log"),
            sdk_lines(sid, start, end, input, output),
        )
        .unwrap();
    }
    async fn start(&self) -> Vec<AgentActivityEntry> {
        let output = Arc::new(std::sync::Mutex::new(Vec::new()));
        let got = output.clone();
        self.input.bind_collector(
            move |rows| got.lock().unwrap().extend_from_slice(rows),
            |_| {},
        );
        self.input.start().await.unwrap();
        let result = std::mem::take(&mut *output.lock().unwrap());
        result
    }
}
fn sdk_lines(sid: &str, start: &str, end: &str, input: i64, output: i64) -> String {
    format!("[{start}] [INFO] [SDK] [QueryHandler] Received message: stream_event {}\n[{end}] [INFO] [SDK] [QueryHandler] Received message: stream_event {}\n",
 json!({"event":{"type":"message_start","message":{"id":"sdk-message-1"}},"session_id":sid}),
 json!({"event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":input,"output_tokens":output}},"session_id":sid}))
}
#[test]
fn work_l169_identity() {
    let f = Fixture::new();
    assert_eq!(f.input.inner.body.id(), "qoder-work-trace");
    assert_eq!(f.input.inner.body.agent_type(), ClientType::QoderWork);
    assert_eq!(
        f.input.inner.body.collection_method(),
        CollectionMethod::HookJsonl
    );
}
#[tokio::test]
async fn work_l176_hook_jsonl_trace_and_workspace() {
    let f = Fixture::new();
    f.hook(&[entry("test-id", "llm.response", "sess-1", "turn-1", 1)]);
    let out = f.collect().await;
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].trace_id.as_deref().unwrap().len(), 32);
    assert_eq!(value(&out[0])["workspace.path"], CWD);
}
#[tokio::test]
async fn work_l191_bare_version_stripped_scoped_version_preserved() {
    let f = Fixture::new();
    let mut e = entry("test-id", "llm.response", "sess-1", "turn-1", 1);
    e["version"] = json!("1.1.26");
    e["agent.qoderwork.version"] = json!("1.1.26");
    f.hook(&[e]);
    let out = f.collect().await;
    assert_eq!(out.len(), 1);
    let v = value(&out[0]);
    assert!(v.get("version").is_none());
    assert_eq!(v["agent.qoderwork.version"], "1.1.26");
}
#[tokio::test]
async fn work_l208_second_poll_resumes_offset() {
    let f = Fixture::new();
    f.hook(&[entry("e1", "llm.response", "sess-1", "turn-1", 1)]);
    assert_eq!(f.collect().await.len(), 1);
    f.append(&[entry("e2", "llm.response", "sess-1", "turn-2", 1)]);
    let out = f.collect().await;
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].event_id, "e2");
}
#[tokio::test]
async fn work_l226_baseline_history_then_new_append() {
    let f = Fixture::initialized(false);
    let mut old = pair("sess-1", "turn-old", 1, "old");
    old.extend(pair("sess-1", "turn-latest", 1, "latest"));
    f.hook(&old);
    let size = std::fs::metadata(f.hook_path()).unwrap().len();
    assert!(f.start().await.is_empty());
    assert_eq!(
        f.store.get("qoder-work-trace").last_offset(),
        Some(size as f64)
    );
    assert_eq!(
        f.store.get("qoder-work-trace").extra().unwrap()["hookHistoryInitialized"],
        true
    );
    f.append(&[entry(
        "next-response",
        "llm.response",
        "sess-1",
        "turn-next",
        1,
    )]);
    assert_eq!(
        f.collect()
            .await
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["next-response"]
    );
    f.input.stop().await.unwrap();
}
#[tokio::test]
async fn work_l277_lazy_first_history_starts_at_zero() {
    let f = Fixture::initialized(false);
    assert!(f.start().await.is_empty());
    let state = f.store.get("qoder-work-trace");
    assert_eq!(state.last_file(), Some(filename().as_str()));
    assert_eq!(state.last_offset(), Some(0.0));
    assert_eq!(state.extra().unwrap()["hookHistoryInitialized"], true);
    f.hook(&[entry(
        "only-response",
        "llm.response",
        "sess-1",
        "turn-only",
        1,
    )]);
    assert_eq!(
        f.collect()
            .await
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["only-response"]
    );
    f.input.stop().await.unwrap();
}
#[tokio::test]
async fn work_l300_every_bootstrap_session_after_empty_start() {
    let f = Fixture::initialized(false);
    assert!(f.start().await.is_empty());
    let mut records = Vec::new();
    for (id, turn, batch, mode) in [
        (
            "session-a-old",
            "session-a-turn-old",
            "session-a-bootstrap",
            "bootstrap",
        ),
        (
            "session-a-latest",
            "session-a-turn-latest",
            "session-a-bootstrap",
            "bootstrap",
        ),
        (
            "session-b-old",
            "session-b-turn-old",
            "session-b-bootstrap",
            "bootstrap",
        ),
        (
            "session-b-latest",
            "session-b-turn-latest",
            "session-b-bootstrap",
            "bootstrap",
        ),
        (
            "normal-incremental",
            "normal-turn",
            "normal-batch",
            "incremental",
        ),
    ] {
        let mut e = entry(id, "llm.response", "sess-1", turn, 1);
        e["agent.transcript.cursor_mode"] = json!(mode);
        e["agent.transcript.cursor_batch_id"] = json!(batch);
        records.push(e);
    }
    f.hook(&records);
    assert_eq!(
        f.collect()
            .await
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["session-a-latest", "session-b-latest", "normal-incremental"]
    );
    f.input.stop().await.unwrap();
}
#[tokio::test]
async fn work_l335_large_existing_history_is_only_baselined() {
    let f = Fixture::initialized(false);
    let mut old = entry("large-old", "llm.response", "sess-1", "turn-old", 1);
    old["agent.qoderwork.padding"] = json!("x".repeat(17 * 1024 * 1024));
    f.hook(&[
        old,
        entry("large-latest", "llm.response", "sess-1", "turn-latest", 1),
    ]);
    let size = std::fs::metadata(f.hook_path()).unwrap().len();
    assert!(f.start().await.is_empty());
    f.input.stop().await.unwrap();
    assert_eq!(
        f.store.get("qoder-work-trace").last_offset(),
        Some(size as f64)
    );
}
#[tokio::test]
async fn work_l353_previous_tool_result_capped_before_next_request() {
    let f = Fixture::new();
    let mut rows = vec![
        entry("s1-req", "llm.request", "sess-cap", "turn-cap", 1),
        entry("s1-resp", "llm.response", "sess-cap", "turn-cap", 1),
        entry("s1-tool", "tool.result", "sess-cap", "turn-cap", 1),
        entry("s2-req", "llm.request", "sess-cap", "turn-cap", 2),
        entry("s2-resp", "llm.response", "sess-cap", "turn-cap", 2),
    ];
    for (row, time) in rows.iter_mut().zip([
        "1000000000000000000",
        "1010000000000000000",
        "1500000000000000000",
        "1200000000000000000",
        "1210000000000000000",
    ]) {
        row["time_unix_nano"] = json!(time);
    }
    f.hook(&rows);
    let out = f.collect().await;
    assert_eq!(find(&out, "s1-tool").time_unix_nano, "1199999999999000000");
    assert_eq!(find(&out, "s1-resp").time_unix_nano, "1010000000000000000");
    assert_eq!(find(&out, "s2-req").time_unix_nano, "1200000000000000000");
}
#[tokio::test]
async fn work_l422_each_turn_has_its_own_trace() {
    let f = Fixture::new();
    f.hook(&[
        entry("e1", "llm.response", "sess-1", "turn-A", 1),
        entry("e2", "llm.response", "sess-1", "turn-A", 1),
        entry("e3", "llm.response", "sess-1", "turn-B", 1),
    ]);
    let out = f.collect().await;
    assert_eq!(out.len(), 3);
    assert!(out[0].trace_id.is_some());
    assert_eq!(out[0].trace_id, out[1].trace_id);
    assert_ne!(out[0].trace_id, out[2].trace_id);
}
#[tokio::test]
async fn work_l438_segments_own_model_and_exact_llm_timing() {
    let f = Fixture::new();
    let sid = "sess-seg";
    let turn = "hook-turn-1";
    let mut rows = pair(sid, turn, 1, "x");
    rows[0]["time_unix_nano"] = json!("1000000000000000000");
    rows[1]["time_unix_nano"] = json!("1000010000000000000");
    for row in &mut rows {
        row["gen_ai.request.model"] = json!("auto");
    }
    f.hook(&rows);
    f.segments(
        sid,
        "run1.jsonl",
        &[
            segment(
                "turn.started",
                turn,
                None,
                "2026-06-16T10:00:00.000Z",
                json!({"is_subagent":false}),
                None,
            ),
            start(
                turn,
                "req-X",
                "2026-06-16T10:00:00.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "req-X",
                "2026-06-16T10:00:05.000Z",
                "qwork-ultimate",
                json!({}),
                None,
            ),
        ],
    );
    let out = f.collect().await;
    let req = find(&out, "x-req");
    let resp = find(&out, "x-resp");
    assert_eq!(req.time_unix_nano, nano("2026-06-16T10:00:00.000Z"));
    assert_eq!(resp.time_unix_nano, nano("2026-06-16T10:00:05.000Z"));
    assert_eq!(req.request_model.as_deref(), Some("qwork-ultimate"));
    assert_eq!(resp.request_model.as_deref(), Some("qwork-ultimate"));
    assert_eq!(resp.response_model.as_deref(), Some("qwork-ultimate"));
}
#[tokio::test]
async fn work_l485_segment_usage_including_cache() {
    let f = Fixture::new();
    let sid = "sess-segment-usage";
    let turn = "turn-segment-usage";
    f.hook(&pair(sid, turn, 1, "usage"));
    f.segments(sid,"usage.jsonl",&[start(turn,"r","2026-06-16T10:00:00.000Z","qwork-ultimate",None),
 end(turn,"r","2026-06-16T10:00:05.000Z","qwork-ultimate",json!({"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}),None)]);
    let out = f.collect().await;
    let e = find(&out, "usage-resp");
    assert_eq!(e.input_tokens, Some(120));
    assert_eq!(e.output_tokens, Some(30));
    assert_eq!(e.total_tokens, Some(150));
    assert_eq!(e.cache_read_input_tokens, Some(50));
    assert_eq!(e.cache_creation_input_tokens, Some(10));
}
#[tokio::test]
async fn work_l525_sdk_fallback_is_token_only() {
    let f = Fixture::new();
    let sid = "sess-sdk-usage";
    let turn = "turn-sdk-usage";
    let mut rows = pair(sid, turn, 1, "sdk");
    rows[0]["time_unix_nano"] = json!(nano("2026-06-16T10:00:00.000Z"));
    rows[1]["time_unix_nano"] = json!(nano("2026-06-16T10:00:05.000Z"));
    f.hook(&rows);
    f.sdk(
        "sdk-session",
        sid,
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:00:05.000Z",
        321,
        45,
    );
    let out = f.collect().await;
    let e = find(&out, "sdk-resp");
    assert_eq!(e.input_tokens, Some(321));
    assert_eq!(e.output_tokens, Some(45));
    assert_eq!(e.total_tokens, Some(366));
    assert_eq!(e.time_unix_nano, nano("2026-06-16T10:00:05.000Z"));
    assert!(e.response_model.is_none());
    assert!(find(&out, "sdk-req").request_model.is_none());
}
#[tokio::test]
async fn work_l561_session_id_directory_fallback() {
    let f = Fixture::new();
    let sid = "sess-segment-directory-fallback";
    let turn = "turn-segment-directory-fallback";
    f.hook(&pair(sid, turn, 1, "fallback"));
    let dir = f
        .root
        .path()
        .join("sessions/writer-format-changed")
        .join(sid)
        .join("segments");
    std::fs::create_dir_all(&dir).unwrap();
    write_lines(
        &dir.join("fallback.jsonl"),
        &[
            start(
                turn,
                "r",
                "2026-06-16T10:00:00.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "r",
                "2026-06-16T10:00:05.000Z",
                "qwork-fallback",
                json!({}),
                None,
            ),
        ],
    );
    let out = f.collect().await;
    assert_eq!(
        find(&out, "fallback-resp").response_model.as_deref(),
        Some("qwork-fallback")
    );
}
#[tokio::test]
async fn work_l594_empty_poll_evicts_aged_cache_data() {
    let f = Fixture::new();
    let sid = "sess-stale-segment";
    let turn = "turn-stale-segment";
    let mut call = entry("stale-tool-call", "tool.call", sid, turn, 1);
    call["gen_ai.tool.call.id"] = json!("stale-tool");
    f.hook(&[call]);
    f.segments(
        sid,
        "stale.jsonl",
        &[
            segment(
                "turn.started",
                "stale-subagent",
                None,
                "2026-06-16T10:00:00.000Z",
                json!({"is_subagent":true}),
                None,
            ),
            start(
                turn,
                "stale-request",
                "2026-06-16T10:00:00.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "stale-request",
                "2026-06-16T10:00:01.000Z",
                "qwork-ultimate",
                json!({}),
                None,
            ),
            tool(
                turn,
                "stale-tool",
                "tool.requested",
                "2026-06-16T10:00:00.100Z",
            ),
        ],
    );
    f.collect().await;
    {
        let mut state = f.input.inner.body.state.lock().await;
        let counts = state.fixture_cache_counts();
        assert_eq!(counts[0], 1);
        assert_eq!(counts[2], 1);
        state.fixture_backdate_cache();
    }
    assert!(f.collect().await.is_empty());
    assert_eq!(
        f.input.inner.body.state.lock().await.fixture_cache_counts(),
        [0, 0, 0, 0]
    );
}
#[tokio::test]
async fn work_l631_subagent_pairs_do_not_shift_main_steps() {
    let f = Fixture::new();
    let sid = "sess-sub";
    let turn = "hook-turn-1";
    f.hook(&pair(sid, turn, 1, "x"));
    f.segments(
        sid,
        "run1.jsonl",
        &[
            segment(
                "turn.started",
                "sub-turn",
                None,
                "2026-06-16T09:00:00.000Z",
                json!({"is_subagent":true}),
                None,
            ),
            start(
                "sub-turn",
                "sub-r",
                "2026-06-16T09:00:00.000Z",
                "qwork-fast",
                None,
            ),
            end(
                "sub-turn",
                "sub-r",
                "2026-06-16T09:00:01.000Z",
                "qwork-fast",
                json!({}),
                None,
            ),
            segment(
                "turn.started",
                turn,
                None,
                "2026-06-16T10:00:00.000Z",
                json!({"is_subagent":false}),
                None,
            ),
            start(
                turn,
                "main-r",
                "2026-06-16T10:00:00.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "main-r",
                "2026-06-16T10:00:05.000Z",
                "qwork-ultimate",
                json!({}),
                None,
            ),
        ],
    );
    let out = f.collect().await;
    let e = find(&out, "x-resp");
    assert_eq!(e.response_model.as_deref(), Some("qwork-ultimate"));
    assert_eq!(e.time_unix_nano, nano("2026-06-16T10:00:05.000Z"));
}
#[tokio::test]
async fn work_l673_legacy_pairs_keep_fifo_step_order() {
    let f = Fixture::new();
    let sid = "sess-multi";
    let turn = "hook-turn-multi";
    let mut rows = Vec::new();
    for i in 1..=3 {
        rows.extend(pair(sid, turn, i, &format!("s{i}")));
    }
    f.hook(&rows);
    f.segments(
        sid,
        "run1.jsonl",
        &[
            start(
                turn,
                "r1",
                "2026-06-16T10:00:00.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "r1",
                "2026-06-16T10:00:01.000Z",
                "qwork-ultimate",
                json!({}),
                None,
            ),
            start(
                turn,
                "r2",
                "2026-06-16T10:00:02.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "r2",
                "2026-06-16T10:00:03.000Z",
                "qwork-ultimate",
                json!({}),
                None,
            ),
            start(
                turn,
                "r3",
                "2026-06-16T10:00:04.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "r3",
                "2026-06-16T10:00:05.000Z",
                "qwork-ultimate",
                json!({}),
                None,
            ),
        ],
    );
    let out = f.collect().await;
    for (i, end) in [
        (1, "2026-06-16T10:00:01.000Z"),
        (2, "2026-06-16T10:00:03.000Z"),
        (3, "2026-06-16T10:00:05.000Z"),
    ] {
        assert_eq!(find(&out, &format!("s{i}-resp")).time_unix_nano, nano(end));
    }
}
#[tokio::test]
async fn work_l767_ten_reverse_file_iterations_keep_retry_alignment() {
    let f = Fixture::new();
    let sid = "sess-ten-retry-loops";
    let turn = "turn-ten-retry-loops";
    let mut hooks = Vec::new();
    let mut groups = Vec::new();
    let base = chrono::DateTime::parse_from_rfc3339("2026-08-25T10:00:00.000Z")
        .unwrap()
        .timestamp_millis();
    let iso = |ms| {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    for i in 1..=10 {
        hooks.extend(pair(sid, turn, i, &format!("ten-s{i}")));
        let id = format!("{turn}:{i}");
        let model = format!("model-{i}");
        let a = format!("request-{i}-a");
        let mut events = vec![
            iteration(turn, &id, i, "started", &iso(base + i as i64 * 10000 - 1)),
            start(turn, &a, &iso(base + i as i64 * 10000), &model, Some(&id)),
        ];
        if i == 1 || i == 3 {
            events.push(segment(
                "model.request.attempt_failed",
                turn,
                Some(&a),
                &iso(base + i as i64 * 10000 + 1000),
                json!({"attempt_had_payload":false,"stream_event_count":0}),
                Some(&id),
            ));
        }
        let completed = if i == 1 || i == 3 {
            format!("request-{i}-b")
        } else {
            a
        };
        events.extend([
            end(
                turn,
                &completed,
                &iso(base + i as i64 * 10000 + 5000),
                &model,
                json!({}),
                Some(&id),
            ),
            iteration(
                turn,
                &id,
                i,
                "finished",
                &iso(base + i as i64 * 10000 + 5001),
            ),
        ]);
        groups.push(events);
    }
    f.hook(&hooks);
    f.segments(
        sid,
        "ten.jsonl",
        &groups.into_iter().rev().flatten().collect::<Vec<_>>(),
    );
    let out = f.collect().await;
    for i in 1..=10 {
        assert_eq!(
            find(&out, &format!("ten-s{i}-req")).time_unix_nano,
            ((base + i * 10000) as i128 * 1000000).to_string()
        );
        assert_eq!(
            find(&out, &format!("ten-s{i}-resp")).time_unix_nano,
            ((base + i * 10000 + 5000) as i128 * 1000000).to_string()
        );
    }
}
#[tokio::test]
async fn work_l842_interrupted_index_never_consumes_later_pair() {
    let f = Fixture::new();
    let sid = "sess-interrupted-loop";
    let turn = "turn-interrupted-loop";
    let mut hooks = Vec::new();
    for i in 1..=2 {
        let mut rows = pair(sid, turn, i, &format!("interrupted-s{i}"));
        rows[0]["time_unix_nano"] = json!((1000000000000000000i128 + i as i128).to_string());
        rows[1]["time_unix_nano"] = json!((1000000000100000000i128 + i as i128).to_string());
        hooks.extend(rows);
    }
    f.hook(&hooks);
    let one = format!("{turn}:1");
    let two = format!("{turn}:2");
    f.segments(
        sid,
        "interrupted.jsonl",
        &[
            iteration(turn, &one, 1, "started", "2026-06-16T10:00:00.000Z"),
            start(
                turn,
                "interrupted-request",
                "2026-06-16T10:00:00.001Z",
                "model-1",
                Some(&one),
            ),
            iteration(turn, &two, 2, "started", "2026-06-16T10:00:10.000Z"),
            start(
                turn,
                "complete-request",
                "2026-06-16T10:00:10.001Z",
                "model-2",
                Some(&two),
            ),
            end(
                turn,
                "complete-request",
                "2026-06-16T10:00:15.000Z",
                "model-2",
                json!({}),
                Some(&two),
            ),
            iteration(turn, &two, 2, "finished", "2026-06-16T10:00:15.001Z"),
        ],
    );
    let out = f.collect().await;
    assert_eq!(
        find(&out, "interrupted-s1-req").time_unix_nano,
        "1000000000000000001"
    );
    assert_eq!(
        find(&out, "interrupted-s2-req").time_unix_nano,
        nano("2026-06-16T10:00:10.001Z")
    );
    assert_eq!(
        find(&out, "interrupted-s2-resp").time_unix_nano,
        nano("2026-06-16T10:00:15.000Z")
    );
}
#[tokio::test]
async fn work_l888_loop_pair_can_span_segment_files() {
    let f = Fixture::new();
    let sid = "sess-cross-file-loop";
    let turn = "turn-cross-file-loop";
    let id = format!("{turn}:1");
    f.hook(&pair(sid, turn, 1, "cross-file"));
    f.segments(
        sid,
        "001.jsonl",
        &[
            iteration(turn, &id, 1, "started", "2026-06-16T10:00:00.000Z"),
            start(
                turn,
                "cross-file-a",
                "2026-06-16T10:00:00.010Z",
                "first-model",
                Some(&id),
            ),
            segment(
                "model.request.attempt_failed",
                turn,
                Some("cross-file-a"),
                "2026-06-16T10:00:01.000Z",
                json!({"attempt_had_payload":false,"stream_event_count":0}),
                Some(&id),
            ),
        ],
    );
    f.segments(
        sid,
        "002.jsonl",
        &[
            end(
                turn,
                "cross-file-b",
                "2026-06-16T10:00:05.000Z",
                "final-model",
                json!({}),
                Some(&id),
            ),
            iteration(turn, &id, 1, "finished", "2026-06-16T10:00:05.010Z"),
        ],
    );
    let out = f.collect().await;
    assert_eq!(
        find(&out, "cross-file-req").time_unix_nano,
        nano("2026-06-16T10:00:00.010Z")
    );
    assert_eq!(
        find(&out, "cross-file-resp").response_model.as_deref(),
        Some("final-model")
    );
}
#[tokio::test]
async fn work_l928_iteration_start_falls_back_without_model_start() {
    let f = Fixture::new();
    let sid = "sess-missing-model-start";
    let turn = "turn-missing-model-start";
    let id = format!("{turn}:1");
    f.hook(&pair(sid, turn, 1, "missing-start"));
    f.segments(
        sid,
        "missing-start.jsonl",
        &[
            iteration(turn, &id, 1, "started", "2026-06-16T10:00:00.000Z"),
            end(
                turn,
                "completed-only",
                "2026-06-16T10:00:05.000Z",
                "fallback-model",
                json!({}),
                Some(&id),
            ),
            iteration(turn, &id, 1, "finished", "2026-06-16T10:00:05.010Z"),
        ],
    );
    let out = f.collect().await;
    assert_eq!(
        find(&out, "missing-start-req").time_unix_nano,
        nano("2026-06-16T10:00:00.000Z")
    );
    assert_eq!(
        find(&out, "missing-start-resp").time_unix_nano,
        nano("2026-06-16T10:00:05.000Z")
    );
}

#[tokio::test]
async fn work_l964_turn_matching_hook_source_priority_and_real_step_spans() {
    use crate::flushers::{
        apply_qoder_work_step_timing, hr_time_to_nano, ConvertOptions, EventLogConverter,
        GenAiEventLogConverter,
    };
    let f = Fixture::new();
    let sid = "sess-background-pair";
    let turn = "prompt-real-turn";
    let id = "tool-call-real";
    let mut hooks = vec![
        entry("s1-req", "llm.request", sid, turn, 1),
        entry("s1-resp", "llm.response", sid, turn, 1),
        entry("s1-tool-call", "tool.call", sid, turn, 1),
        entry("s1-tool-result", "tool.result", sid, turn, 1),
        entry("s2-req", "llm.request", sid, turn, 2),
        entry("s2-resp", "llm.response", sid, turn, 2),
    ];
    for (row, time) in hooks.iter_mut().zip([
        "2026-06-18T02:37:42.905Z",
        "2026-06-18T02:38:05.180Z",
        "2026-06-18T02:38:05.180Z",
        "2026-06-18T02:38:06.722Z",
        "2026-06-18T02:38:06.722Z",
        "2026-06-18T02:38:11.107Z",
    ]) {
        row["time_unix_nano"] = json!(nano(time));
        row["agent.qoderwork.promptId"] = json!(turn);
    }
    hooks[2]["gen_ai.tool.call.id"] = json!(id);
    hooks[3]["gen_ai.tool.call.id"] = json!(id);
    f.hook(&hooks);
    let one = format!("{turn}:1");
    let two = format!("{turn}:2");
    let ignored = "qoderwork-memory-sink-fork-qoderwork-memory-sink";
    f.segments(
        sid,
        "run1.jsonl",
        &[
            start(
                ignored,
                "memory-1",
                "2026-06-18T09:39:42.866+08:00",
                "qwork-ultimate",
                None,
            ),
            end(
                ignored,
                "memory-1",
                "2026-06-18T09:39:50.736+08:00",
                "qwork-ultimate",
                json!({}),
                None,
            ),
            iteration(turn, &one, 1, "started", "2026-06-18T10:37:43.000+08:00"),
            start(
                turn,
                "real-1",
                "2026-06-18T10:37:43.032+08:00",
                "qwork-ultimate",
                Some(&one),
            ),
            tool(turn, id, "tool.requested", "2026-06-18T10:38:05.093+08:00"),
            end(
                turn,
                "real-1",
                "2026-06-18T10:38:05.168+08:00",
                "qwork-ultimate",
                json!({}),
                Some(&one),
            ),
            hook_tool(
                sid,
                id,
                "PreToolUse",
                "user",
                "2026-06-18T10:38:05.180+08:00",
            ),
            hook_tool(
                sid,
                id,
                "PreToolUse",
                "plugins",
                "2026-06-18T10:38:05.190+08:00",
            ),
            hook_tool(
                sid,
                id,
                "PreToolUse",
                "runtime",
                "2026-06-18T10:38:05.200+08:00",
            ),
            hook_tool(
                sid,
                id,
                "PostToolUse",
                "plugins",
                "2026-06-18T10:38:06.400+08:00",
            ),
            hook_tool(
                sid,
                id,
                "PostToolUse",
                "user",
                "2026-06-18T10:38:06.500+08:00",
            ),
            tool(
                turn,
                id,
                "tool.execution.finished",
                "2026-06-18T10:38:06.616+08:00",
            ),
            iteration(turn, &one, 1, "finished", "2026-06-18T10:38:06.700+08:00"),
            iteration(turn, &two, 2, "started", "2026-06-18T10:38:06.800+08:00"),
            start(
                turn,
                "real-2",
                "2026-06-18T10:38:06.840+08:00",
                "qwork-ultimate",
                Some(&two),
            ),
            end(
                turn,
                "real-2",
                "2026-06-18T10:38:11.107+08:00",
                "qwork-ultimate",
                json!({}),
                Some(&two),
            ),
            iteration(turn, &two, 2, "finished", "2026-06-18T10:38:11.200+08:00"),
        ],
    );
    let out = f.collect().await;
    for (id, time) in [
        ("s1-req", "2026-06-18T10:37:43.032+08:00"),
        ("s1-resp", "2026-06-18T10:38:05.168+08:00"),
        ("s1-tool-call", "2026-06-18T10:38:05.200+08:00"),
        ("s1-tool-result", "2026-06-18T10:38:06.500+08:00"),
        ("s2-req", "2026-06-18T10:38:06.840+08:00"),
        ("s2-resp", "2026-06-18T10:38:11.107+08:00"),
    ] {
        assert_eq!(find(&out, id).time_unix_nano, nano(time), "{id}");
    }
    assert_eq!(
        find(&out, "s1-req").extra["agent.qoderwork.step.start_time_unix_nano"],
        nano("2026-06-18T10:37:43.000+08:00")
    );
    assert_eq!(
        find(&out, "s1-req").extra["agent.qoderwork.step.end_time_unix_nano"],
        nano("2026-06-18T10:38:06.700+08:00")
    );
    let mut converted = GenAiEventLogConverter
        .convert(&out, &ConvertOptions::default())
        .unwrap();
    apply_qoder_work_step_timing(&out, &mut converted.spans);
    let mut steps = converted
        .spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("STEP")))
        .collect::<Vec<_>>();
    steps.sort_by_key(|s| s.start_time);
    assert_eq!(steps.len(), 2);
    assert_eq!(
        hr_time_to_nano(steps[0].start_time),
        nano("2026-06-18T10:37:43.000+08:00")
    );
    assert_eq!(
        hr_time_to_nano(steps[0].end_time),
        nano("2026-06-18T10:38:06.700+08:00")
    );
    assert_eq!(
        hr_time_to_nano(steps[1].start_time),
        nano("2026-06-18T10:38:06.800+08:00")
    );
    assert_eq!(
        hr_time_to_nano(steps[1].end_time),
        nano("2026-06-18T10:38:11.200+08:00")
    );
}
#[tokio::test]
async fn work_l1093_tool_timing_survives_split_hook_batches() {
    let f = Fixture::new();
    let sid = "sess-split-tool";
    let turn = "prompt-split-tool";
    let id = "tool-call-split";
    let mut hooks = pair(sid, turn, 1, "x");
    hooks[0]["time_unix_nano"] = json!(nano("2026-06-18T02:00:00.000Z"));
    hooks[1]["time_unix_nano"] = json!(nano("2026-06-18T02:00:05.000Z"));
    let mut call = entry("tool-call", "tool.call", sid, turn, 1);
    call["gen_ai.tool.call.id"] = json!(id);
    call["time_unix_nano"] = json!(nano("2026-06-18T02:00:05.100Z"));
    hooks.push(call);
    f.hook(&hooks);
    f.segments(
        sid,
        "run1.jsonl",
        &[
            start(
                turn,
                "r1",
                "2026-06-18T10:00:00.000+08:00",
                "qwork-ultimate",
                None,
            ),
            tool(turn, id, "tool.requested", "2026-06-18T10:00:05.050+08:00"),
            end(
                turn,
                "r1",
                "2026-06-18T10:00:05.200+08:00",
                "qwork-ultimate",
                json!({}),
                None,
            ),
            tool(
                turn,
                id,
                "tool.execution.finished",
                "2026-06-18T10:00:06.700+08:00",
            ),
        ],
    );
    let first = f.collect().await;
    assert_eq!(
        find(&first, "tool-call").time_unix_nano,
        nano("2026-06-18T10:00:05.200+08:00")
    );
    let mut result = entry("tool-result", "tool.result", sid, turn, 1);
    result["gen_ai.tool.call.id"] = json!(id);
    result["time_unix_nano"] = json!(nano("2026-06-18T02:00:06.900Z"));
    f.append(&[result]);
    let second = f.collect().await;
    assert_eq!(
        find(&second, "tool-result").time_unix_nano,
        nano("2026-06-18T10:00:06.700+08:00")
    );
}
#[tokio::test]
async fn work_l1155_missing_segments_keep_hook_clock() {
    let f = Fixture::new();
    let mut hooks = pair("sess-no-seg", "turn-x", 1, "x");
    hooks[0]["time_unix_nano"] = json!("1700000000000000000");
    hooks[1]["time_unix_nano"] = json!("1700001000000000000");
    f.hook(&hooks);
    let out = f.collect().await;
    assert_eq!(find(&out, "x-req").time_unix_nano, "1700000000000000000");
    assert_eq!(find(&out, "x-resp").time_unix_nano, "1700001000000000000");
}
#[tokio::test]
async fn work_l1186_model_completion_is_tool_start_without_pre_hook() {
    let f = Fixture::new();
    let sid = "sess-tc";
    let turn = "turn-tc";
    let mut hooks = pair(sid, turn, 1, "x");
    hooks[0]["time_unix_nano"] = json!("1000000000000000000");
    hooks[1]["time_unix_nano"] = json!("1000010000000000000");
    let mut call = entry("tc", "tool.call", sid, turn, 1);
    call["gen_ai.tool.call.id"] = json!("tool-no-pre");
    call["time_unix_nano"] = json!("999999999999000000");
    hooks.push(call);
    f.hook(&hooks);
    f.segments(
        sid,
        "run1.jsonl",
        &[
            segment(
                "turn.started",
                turn,
                None,
                "2026-06-16T10:00:00.000Z",
                json!({"is_subagent":false}),
                None,
            ),
            start(
                turn,
                "r1",
                "2026-06-16T10:00:00.000Z",
                "qwork-ultimate",
                None,
            ),
            end(
                turn,
                "r1",
                "2026-06-16T10:00:05.000Z",
                "qwork-ultimate",
                json!({}),
                None,
            ),
        ],
    );
    let out = f.collect().await;
    assert_eq!(
        find(&out, "tc").time_unix_nano,
        nano("2026-06-16T10:00:05.000Z")
    );
}
#[tokio::test]
async fn work_l1231_native_usage_wins_with_and_without_cache() {
    for has_cache in [true, false] {
        let f = Fixture::new();
        let sid = "sess-native-usage";
        let turn = "turn-native-usage";
        let mut hooks = pair(sid, turn, 1, "native");
        hooks[0]["time_unix_nano"] = json!(nano("2026-06-16T10:00:00.000Z"));
        hooks[1]["time_unix_nano"] = json!(nano("2026-06-16T10:00:05.000Z"));
        hooks[1]["gen_ai.response.id"] = json!("chatcmpl-native-usage");
        f.hook(&hooks);
        let mut usage = json!({"input_tokens":120,"output_tokens":30});
        if has_cache {
            usage["cache_read_input_tokens"] = json!(50);
            usage["cache_creation_input_tokens"] = json!(10);
        }
        f.segments(
            sid,
            "native.jsonl",
            &[
                start(
                    turn,
                    "native-req",
                    "2026-06-16T10:00:00.000Z",
                    "qwork-ultimate",
                    None,
                ),
                end(
                    turn,
                    "native-req",
                    "2026-06-16T10:00:05.000Z",
                    "qwork-ultimate",
                    usage,
                    None,
                ),
            ],
        );
        f.sdk(
            "sdk-session",
            sid,
            "2026-06-16T10:00:00.000Z",
            "2026-06-16T10:00:05.000Z",
            800,
            90,
        );
        let out = f.collect().await;
        assert_eq!(out.len(), 2);
        assert!(f.collect().await.is_empty());
        let e = find(&out, "native-resp");
        assert_eq!(e.input_tokens, Some(120));
        assert_eq!(e.output_tokens, Some(30));
        assert_eq!(e.total_tokens, Some(150));
        assert_eq!(
            e.cache_read_input_tokens,
            if has_cache { Some(50) } else { None }
        );
        assert_eq!(
            e.cache_creation_input_tokens,
            if has_cache { Some(10) } else { None }
        );
        assert_eq!(
            e.time_unix_nano,
            hooks[1]["time_unix_nano"].as_str().unwrap()
        );
        let request = find(&out, "native-req");
        assert_eq!(
            request.time_unix_nano,
            hooks[0]["time_unix_nano"].as_str().unwrap()
        );
        assert!(value(request).get("gen_ai.system_instructions").is_none());
    }
}
#[tokio::test]
async fn acceptance_real_manager_jsonl_receives_segment_usage_model_and_clock() {
    use crate::core::{InputManager, LiveInput};
    use crate::flushers::{BaseFlusher, JsonlFlusher};
    let f = Fixture::new();
    let sid = "jsonl-session";
    let turn = "jsonl-turn";
    f.hook(&pair(sid, turn, 1, "delivery"));
    f.segments(
        sid,
        "run.jsonl",
        &[
            start(turn, "r", "2026-06-16T10:00:00.000Z", "actual-model", None),
            end(
                turn,
                "r",
                "2026-06-16T10:00:05.000Z",
                "actual-model",
                json!({"input_tokens":120,"output_tokens":30}),
                None,
            ),
        ],
    );
    let output = f.root.path().join("output");
    let flusher = Arc::new(JsonlFlusher::new(
        serde_json::from_value(json!({
  "enabled":true,"outputDir":output,"rotateDaily":false,"maxFileSizeMb":1}))
        .unwrap(),
    ));
    flusher.start().await.unwrap();
    let manager = Arc::new(InputManager::new());
    manager.set_state_store(f.store.clone());
    manager.set_flusher(flusher);
    manager.set_user_id("synthetic-user");
    let (a, b, c) = (f.input.clone(), f.input.clone(), f.input.clone());
    manager.register_input(LiveInput::new(
        "qoder-work-trace",
        "qoder-work",
        "hook-jsonl",
        move || a.collector_running(),
        move || {
            let i = b.clone();
            Box::pin(async move { i.start().await })
        },
        move || {
            let i = c.clone();
            Box::pin(async move {
                i.stop().await.unwrap();
            })
        },
    ));
    let weak = Arc::downgrade(&manager);
    f.input.bind_collector(
        move |entries| {
            if let Some(m) = weak.upgrade() {
                m.bind_entries("qoder-work-trace", entries.to_vec());
            }
        },
        |_| {},
    );
    f.input.start().await.unwrap();
    manager.stop_all().await;
    let lines = std::fs::read_dir(output)
        .unwrap()
        .flat_map(|f| {
            std::fs::read_to_string(f.unwrap().path())
                .unwrap()
                .lines()
                .map(|s| serde_json::from_str::<Value>(s).unwrap())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let req = lines
        .iter()
        .find(|v| v["event.id"] == "delivery-req")
        .unwrap();
    let resp = lines
        .iter()
        .find(|v| v["event.id"] == "delivery-resp")
        .unwrap();
    assert_eq!(req["time_unix_nano"], nano("2026-06-16T10:00:00.000Z"));
    assert_eq!(resp["time_unix_nano"], nano("2026-06-16T10:00:05.000Z"));
    assert_eq!(req["gen_ai.request.model"], "actual-model");
    assert_eq!(resp["gen_ai.response.model"], "actual-model");
    assert_eq!(resp["gen_ai.usage.input_tokens"], 120);
    assert_eq!(resp["gen_ai.usage.output_tokens"], 30);
    assert_eq!(resp["gen_ai.usage.total_tokens"], 150);
    assert_eq!(req["trace_id"], resp["trace_id"]);
    assert_eq!(req["user.id"], "synthetic-user");
}
#[tokio::test]
async fn acceptance_legacy_sdk_layout_never_changes_hook_model_or_timing() {
    let f = Fixture::new();
    let sid = "legacy-sdk";
    let turn = "legacy-sdk-turn";
    let mut hooks = pair(sid, turn, 1, "legacy");
    hooks[0]["time_unix_nano"] = json!(nano("2026-06-16T10:00:00.000Z"));
    hooks[1]["time_unix_nano"] = json!(nano("2026-06-16T10:00:05.000Z"));
    hooks[0]["gen_ai.request.model"] = json!("hook-model");
    hooks[1]["gen_ai.response.model"] = json!("hook-response-model");
    f.hook(&hooks);
    let dir = f.root.path().join("sdk-logs/session/main");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("sdk-001.log"),
        sdk_lines(
            sid,
            "2026-06-16T10:00:00.000Z",
            "2026-06-16T10:00:05.000Z",
            11,
            22,
        ),
    )
    .unwrap();
    let out = f.collect().await;
    assert_eq!(
        find(&out, "legacy-req").request_model.as_deref(),
        Some("hook-model")
    );
    assert_eq!(
        find(&out, "legacy-resp").response_model.as_deref(),
        Some("hook-response-model")
    );
    assert_eq!(find(&out, "legacy-resp").input_tokens, Some(11));
    assert_eq!(find(&out, "legacy-resp").output_tokens, Some(22));
    assert_eq!(
        find(&out, "legacy-req").time_unix_nano,
        hooks[0]["time_unix_nano"].as_str().unwrap()
    );
    assert_eq!(
        find(&out, "legacy-resp").time_unix_nano,
        hooks[1]["time_unix_nano"].as_str().unwrap()
    );
}
#[tokio::test]
async fn acceptance_partial_segment_and_rotation_preserve_reader_checkpoint() {
    use std::io::Write;
    let f = Fixture::new();
    let sid = "partial";
    let turn = "partial-turn";
    f.hook(&pair(sid, turn, 1, "first"));
    let dir = f
        .root
        .path()
        .join("sessions")
        .join(ENCODED)
        .join(sid)
        .join("segments");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("run.jsonl");
    let start = start(turn, "r", "2026-06-16T10:00:00.000Z", "part-model", None).to_string();
    let end = end(
        turn,
        "r",
        "2026-06-16T10:00:05.000Z",
        "part-model",
        json!({}),
        None,
    )
    .to_string();
    let split = end.len() / 2;
    std::fs::write(&path, format!("{start}\n{}", &end[..split])).unwrap();
    let first = f.collect().await;
    assert_eq!(
        find(&first, "first-req").time_unix_nano,
        "1780000000000000000"
    );
    let key = format!("qoder-work-trace:seg:{}", path.display());
    assert_eq!(f.store.get_offset(&key), (start.len() + 1) as f64);
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap(),
        "{}",
        &end[split..]
    )
    .unwrap();
    f.append(&pair(sid, turn, 1, "afterpart"));
    let second = f.collect().await;
    assert_eq!(
        find(&second, "afterpart-resp").response_model.as_deref(),
        Some("part-model")
    );
    std::fs::rename(&path, dir.join("run.jsonl.old")).unwrap();
    let rotated = "rotated-turn";
    write_lines(
        &path,
        &[
            start_event_for_rotation(rotated),
            end_event_for_rotation(rotated),
        ],
    );
    f.append(&pair(sid, rotated, 1, "rotated"));
    let third = f.collect().await;
    assert_eq!(
        find(&third, "rotated-resp").response_model.as_deref(),
        Some("rotated-model")
    );
    assert_eq!(
        find(&third, "rotated-req").time_unix_nano,
        nano("2026-06-16T10:01:00.000Z")
    );
}
fn start_event_for_rotation(turn: &str) -> Value {
    start(
        turn,
        "rotated-r",
        "2026-06-16T10:01:00.000Z",
        "rotated-model",
        None,
    )
}
fn end_event_for_rotation(turn: &str) -> Value {
    end(
        turn,
        "rotated-r",
        "2026-06-16T10:01:05.000Z",
        "rotated-model",
        json!({"padding":"x".repeat(1000)}),
        None,
    )
}
