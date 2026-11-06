//! Historical SDK-log input contracts through real layout, offsets and HostedInput.
use super::*;
use crate::checkpoints::StateStore;
use crate::types::CollectionMethod;
use std::sync::Arc;
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    store: Arc<StateStore>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let file = root.join("logs/2026-05-14T10-00-00/main/sdk-001.log");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"").unwrap();
        let store = Arc::new(StateStore::new(root.join("state.json")));
        store.set_offset(&format!("qoder-work-log:{}", file.display()), 0.0);
        Self {
            _temp: temp,
            root,
            file,
            store,
        }
    }
    fn input(&self, kind: ClientType) -> QoderWorkLogInput {
        QoderWorkLogInput::new(QoderWorkLogOptions {
            state_store: self.store.clone(),
            data_root: Some(self.root.to_string_lossy().into_owned()),
            agent_type: Some(kind),
            poll_interval_ms: Some(60000),
        })
    }
    fn write(&self, records: &[String]) {
        std::fs::write(&self.file, records.concat()).unwrap();
    }
    async fn once(&self) -> Vec<Value> {
        let input = self.input(ClientType::QoderWork);
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
        let data = events.lock().unwrap().clone();
        data
    }
}
fn line(kind: &str, payload: Value) -> String {
    format!("[2026-05-14T10:00:00.000] [INFO] [SDK] [QueryHandler] Received message: {kind} {payload}\n")
}
fn init(id: &str, tier: &str, cwd: &str) -> String {
    line(
        "system",
        json!({"subtype":"init","session_id":id,"model":tier,"cwd":cwd,"agents":[],"tools":[]}),
    )
}
fn policy(chat: &str, scene: &str) -> String {
    let payload = json!({"requestId":format!("req_{chat}"),"request":{"type":"control_request","request_id":format!("req_{chat}"),"request":{"subtype":"set_model_policy","scene":"qwork","chat":{"model":chat},"compact":{"model":scene},"scene_model":{"model":scene}}}});
    format!("[2026-05-14T10:00:00.000] [INFO] [SDK] [QueryHandler] Sending control request: set_model_policy {payload}\n")
}
fn stream(id: &str, event: Value) -> String {
    line("stream_event", json!({"session_id":id,"event":event}))
}
fn turn(id: &str, message: &str, input: i64, output: i64) -> Vec<String> {
    vec![
        stream(id, json!({"type":"message_start","message":{"id":message}})),
        stream(
            id,
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":input,"output_tokens":output}}),
        ),
        stream(id, json!({"type":"message_stop"})),
    ]
}
fn result(id: &str, turns: i64, duration: i64) -> String {
    line(
        "result",
        json!({"session_id":id,"subtype":"success","duration_ms":duration,"duration_api_ms":1200,"num_turns":turns,"context_usage_ratio":0.42}),
    )
}
fn wave() -> Vec<String> {
    let s = "sess-1";
    vec![
        init(s, "Standard", "/home/dev/proj"),
        stream(s, json!({"type":"message_start","message":{"id":"msg-1"}})),
        stream(
            s,
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}),
        ),
        stream(
            s,
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"analyse user intent"}}),
        ),
        stream(
            s,
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text"}}),
        ),
        stream(
            s,
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I will read the file."}}),
        ),
        stream(
            s,
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool-call-1","name":"Read"}}),
        ),
        stream(
            s,
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"/tmp/x.txt\"}"}}),
        ),
        stream(
            s,
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":1234,"output_tokens":56}}),
        ),
        stream(s, json!({"type":"message_stop"})),
        result(s, 1, 0),
    ]
}
#[tokio::test]
async fn source_l30_actual_sdk_input_identity_and_session_file_method() {
    let f = Fixture::new();
    let input = f.input(ClientType::QoderWork);
    assert_eq!(input.inner.id(), "qoder-work-log");
    assert_eq!(input.inner.body.agent_type(), ClientType::QoderWork);
    assert_eq!(
        input.inner.body.collection_method(),
        CollectionMethod::SessionFilePolling
    );
}
#[tokio::test]
async fn source_l37_sdk_metadata_response_and_tool_call_do_not_reconstruct_unordered_content() {
    let f = Fixture::new();
    f.write(&wave());
    let data = f.once().await;
    let responses = data
        .iter()
        .filter(|v| v["event.name"] == "llm.response")
        .collect::<Vec<_>>();
    let tools = data
        .iter()
        .filter(|v| v["event.name"] == "tool.call")
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 1);
    assert_eq!(tools.len(), 1);
    let response = responses[0];
    let tool = tools[0];
    assert!(response.get("gen_ai.output.messages").is_none());
    for (field, value) in [
        ("gen_ai.usage.input_tokens", json!(1234)),
        ("gen_ai.usage.output_tokens", json!(56)),
        ("gen_ai.usage.total_tokens", json!(1290)),
        ("gen_ai.session.id", json!("sess-1")),
        ("gen_ai.response.id", json!("msg-1")),
        ("gen_ai.response.model", json!("unknown")),
        ("agent.subscription_tier", json!("Standard")),
        ("agent.cwd", json!("/home/dev/proj")),
        ("gen_ai.response.finish_reasons", json!(["tool_use"])),
        ("agent.event_kind", json!("response")),
        ("agent.tool_use_count", json!(1)),
    ] {
        assert_eq!(response.get(field), Some(&value), "{field}");
    }
    assert_eq!(tool["gen_ai.tool.name"], "Read");
    assert_eq!(tool["gen_ai.tool.call.id"], "tool-call-1");
    assert!(tool.get("gen_ai.tool.call.arguments").is_none());
    assert_eq!(tool["agent.subscription_tier"], "Standard");
    assert_eq!(tool["agent.cwd"], "/home/dev/proj");
}
#[tokio::test]
async fn source_l87_init_and_unfinished_message_start_emit_no_entries() {
    let f = Fixture::new();
    f.write(&[
        init("s", "m", ""),
        stream("s", json!({"type":"message_start","message":{"id":"mid"}})),
    ]);
    assert!(f.once().await.is_empty());
}
#[tokio::test]
async fn source_l106_sdk_result_summary_retains_event_kind_duration_and_turn_count() {
    let f = Fixture::new();
    f.write(&[init("s2", "m", ""), result("s2", 1, 1500)]);
    let data = f.once().await;
    assert_eq!(data.len(), 1);
    assert_eq!(data[0]["event.name"], "other");
    assert_eq!(data[0]["agent.event_kind"], "result");
    assert_eq!(data[0]["agent.duration_ms"].as_f64(), Some(1500.0));
    assert_eq!(data[0]["agent.num_turns"].as_f64(), Some(1.0));
}
#[tokio::test]
async fn source_l133_persisted_per_file_cursor_does_not_reemit_unchanged_sdk_log() {
    let f = Fixture::new();
    let mut records = vec![init("sess-2", "Standard", "/tmp")];
    records.extend(turn("sess-2", "msg-2", 100, 10));
    records.push(result("sess-2", 1, 0));
    f.write(&records);
    assert!(!f.once().await.is_empty());
    assert!(f.once().await.is_empty());
}
#[tokio::test]
async fn source_l160_each_turn_snapshots_latest_chat_policy_and_summary_uses_latest_policy() {
    let f = Fixture::new();
    let mut records = vec![
        init("sess-policy", "Premium", "/tmp"),
        policy("qwork-ultimate", "qwork-auto"),
    ];
    records.extend(turn("sess-policy", "msg-A", 100, 20));
    records.push(policy("qwork-auto", "qwork-auto"));
    records.extend(turn("sess-policy", "msg-B", 200, 30));
    records.push(result("sess-policy", 2, 0));
    f.write(&records);
    let data = f.once().await;
    let mut responses = data
        .iter()
        .filter(|v| v["event.name"] == "llm.response")
        .collect::<Vec<_>>();
    responses.sort_by_key(|v| v["gen_ai.response.id"].as_str().unwrap());
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["gen_ai.response.id"], "msg-A");
    assert_eq!(responses[0]["gen_ai.response.model"], "qwork-ultimate");
    assert_eq!(responses[1]["gen_ai.response.id"], "msg-B");
    assert_eq!(responses[1]["gen_ai.response.model"], "qwork-auto");
    let summary = data
        .iter()
        .find(|v| v["agent.event_kind"] == "result")
        .unwrap();
    assert_eq!(summary["gen_ai.response.model"], "qwork-auto");
}
#[tokio::test]
async fn source_l207_parallel_premium_and_standard_sessions_use_distinct_chat_scene_slots() {
    let f = Fixture::new();
    let mut records = vec![
        init("sess-summarizer", "Standard", "/"),
        init(
            "sess-main",
            "Premium",
            "/Users/wsy/.qoderwork/workspace/foo",
        ),
        policy("qwork-ultimate", "qwork-auto"),
    ];
    records.extend(turn("sess-main", "msg-main", 100, 20));
    records.extend(turn("sess-summarizer", "msg-sum", 50, 5));
    records.push(result("sess-main", 1, 0));
    records.push(result("sess-summarizer", 1, 0));
    f.write(&records);
    let data = f.once().await;
    for (kind, session, model) in [
        ("llm.response", "sess-main", "qwork-ultimate"),
        ("llm.response", "sess-summarizer", "qwork-auto"),
        ("result", "sess-main", "qwork-ultimate"),
        ("result", "sess-summarizer", "qwork-auto"),
    ] {
        let entry = data
            .iter()
            .find(|v| {
                v["gen_ai.session.id"] == session
                    && if kind == "result" {
                        v["agent.event_kind"] == "result"
                    } else {
                        v["event.name"] == kind
                    }
            })
            .unwrap();
        assert_eq!(entry["gen_ai.response.model"], model);
    }
}
#[tokio::test]
async fn source_l282_cn_sdk_input_has_distinct_id_and_agent() {
    let f = Fixture::new();
    let input = f.input(ClientType::QoderWorkCN);
    assert_eq!(input.inner.id(), "qoder-work-cn-log");
    assert_eq!(input.inner.body.agent_type(), ClientType::QoderWorkCN);
}
