//! CN SDK-session trace contracts: actual registered concrete input, SDK files and StateStore.
use super::*;
use crate::checkpoints::{InputState, StateStore};
use serde_json::json;
use std::sync::{Arc, Mutex};
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
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(&file, b"").unwrap();
        let store = Arc::new(StateStore::new(root.join("state.json")));
        store.set_offset(&format!("qoder-work-cn-trace:{}", file.display()), 0.0);
        Self {
            _temp: temp,
            root,
            file,
            store,
        }
    }
    fn input(&self) -> QoderWorkLogTraceInput {
        let mut input = QoderWorkLogTraceInput::new(QoderWorkLogTraceOptions {
            state_store: self.store.clone(),
            data_root: Some(self.root.to_string_lossy().into_owned()),
            agent_type: Some(ClientType::QoderWorkCN),
            poll_interval_ms: Some(60000),
        });
        // The production constructor's HOME-derived optional tool root is
        // redirected to this synthetic root; no real Agent project is read.
        let hosted = Arc::get_mut(&mut input.inner).unwrap();
        hosted.body.projects_dir = self.root.join("projects");
        input
    }
    fn write(&self, records: &[String]) {
        std::fs::write(&self.file, records.concat()).unwrap();
    }
    fn append(&self, records: &[String]) {
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&self.file)
            .unwrap()
            .write_all(records.concat().as_bytes())
            .unwrap();
    }
    async fn once(&self) -> Vec<Value> {
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
        let data = events.lock().unwrap().clone();
        data
    }
}
fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S%.3f")
        .to_string()
}
fn line(ms: i64, kind: &str, payload: Value) -> String {
    format!(
        "[{}] [INFO] [SDK] [QueryHandler] Received message: {kind} {payload}\n",
        iso(ms)
    )
}
fn init(ms: i64, s: &str) -> String {
    line(
        ms,
        "system",
        json!({"subtype":"init","session_id":s,"model":"Premium","cwd":"/tmp","agents":[],"tools":[]}),
    )
}
fn stream(ms: i64, s: &str, event: Value) -> String {
    line(ms, "stream_event", json!({"session_id":s,"event":event}))
}
fn result(ms: i64, s: &str) -> String {
    line(
        ms,
        "result",
        json!({"session_id":s,"subtype":"success","duration_ms":0,"duration_api_ms":0,"num_turns":1,"context_usage_ratio":0}),
    )
}
fn turn(
    s: &str,
    msg: &str,
    clock_and_usage: (i64, i64, i64, i64),
    text: Option<&str>,
    tools: &[(&str, &str, &str)],
) -> Vec<String> {
    let (start, end, input, output) = clock_and_usage;
    let mut out = vec![stream(
        start,
        s,
        json!({"type":"message_start","message":{"id":msg}}),
    )];
    let mut index = 0;
    if let Some(text) = text {
        out.push(stream(
            start + 30,
            s,
            json!({"type":"content_block_start","index":index,"content_block":{"type":"text"}}),
        ));
        out.push(stream(start+40,s,json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}})));
        index += 1;
    }
    for (id, name, args) in tools {
        out.push(stream(start+50+index*200,s,json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name}})));
        out.push(stream(start+60+index*200,s,json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":args}})));
        index += 1;
    }
    let stop = if tools.is_empty() {
        "end_turn"
    } else {
        "tool_use"
    };
    out.push(stream(end-10,s,json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"input_tokens":input,"output_tokens":output}})));
    out.push(stream(end, s, json!({"type":"message_stop"})));
    out
}
fn full(
    s: &str,
    msg: &str,
    clock_and_usage: (i64, i64, i64, i64),
    text: Option<&str>,
    tools: &[(&str, &str, &str)],
) -> Vec<String> {
    let (start, end, input, output) = clock_and_usage;
    let mut out = vec![init(start - 100, s)];
    out.extend(turn(s, msg, (start, end, input, output), text, tools));
    out.push(result(end + 100, s));
    out
}
fn find<'a>(data: &'a [Value], kind: &str, step: Option<&str>) -> &'a Value {
    data.iter()
        .find(|v| {
            v["event.name"] == kind
                && step.is_none_or(|s| {
                    v["gen_ai.step.id"]
                        .as_str()
                        .is_some_and(|id| id.ends_with(s))
                })
        })
        .unwrap()
}
fn policy(ms: i64, model: &str) -> String {
    let payload = json!({"requestId":"rq-1","request":{"type":"control_request","request_id":"rq-1","request":{"subtype":"set_model_policy","scene":"qwork","chat":{"model":model},"compact":{"model":"auto"},"scene_model":{"model":"auto"}}}});
    format!(
        "[{}] [INFO] [SDK] [QueryHandler] Sending control request: set_model_policy {payload}\n",
        iso(ms)
    )
}
#[tokio::test]
async fn source_l54_real_registered_sdk_trace_constructor_matches_cn_spec_id_and_agent() {
    let f = Fixture::new();
    let input = f.input();
    assert_eq!(input.inner.id(), "qoder-work-cn-trace");
    assert_eq!(input.inner.agent_type(), ClientType::QoderWorkCN);
    assert_eq!(
        input.inner.body.collection_method(),
        CollectionMethod::SessionFilePolling
    );
}
#[tokio::test]
async fn source_l60_actual_sdk_span_tree_uses_exact_integer_nanosecond_strings() {
    let f = Fixture::new();
    f.write(&full(
        "sess-1",
        "msg-1",
        (1717950000123, 1717950005456, 100, 20),
        Some("hello world"),
        &[],
    ));
    let data = f.once().await;
    assert!(!data.is_empty());
    let first = find(&data, "other", Some(":s1"));
    let response = find(&data, "llm.response", Some(":s1"));
    for value in [first, response] {
        let time = value["time_unix_nano"].as_str().unwrap();
        assert!(time.len() >= 16 && time.chars().all(|c| c.is_ascii_digit()));
        assert!(time.ends_with("000000"));
        assert_eq!(value["gen_ai.agent.type"], "qoder-work-cn");
        assert_eq!(value["agent.source"], "qoder-work-cn-trace");
    }
    assert!(
        response["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<i128>()
            .unwrap()
            > first["time_unix_nano"]
                .as_str()
                .unwrap()
                .parse::<i128>()
                .unwrap()
    );
}
#[tokio::test]
async fn source_l102_actual_overlap_caps_tool_result_before_next_step_request() {
    let f = Fixture::new();
    let mut records = vec![init(900, "sess-overlap")];
    records.extend(turn(
        "sess-overlap",
        "msg-1",
        (1000, 5000, 50, 10),
        None,
        &[("tc-1", "Read", "{\"path\":\"/tmp\"}")],
    ));
    records.extend(turn(
        "sess-overlap",
        "msg-2",
        (3000, 7000, 80, 15),
        None,
        &[],
    ));
    records.push(result(7100, "sess-overlap"));
    f.write(&records);
    let data = f.once().await;
    let tool = find(&data, "tool.result", None);
    let next = find(&data, "llm.request", Some(":s2"));
    assert!(
        tool["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<i128>()
            .unwrap()
            < next["time_unix_nano"]
                .as_str()
                .unwrap()
                .parse::<i128>()
                .unwrap()
    );
}
#[tokio::test]
async fn source_l138_next_request_delta_orders_assistant_tool_call_before_tool_response() {
    let f = Fixture::new();
    let s = "sess-toolmsg";
    let mut records = vec![init(900, s)];
    records.extend(turn(
        s,
        "msg-1",
        (1000, 2000, 50, 10),
        Some("Let me read that file."),
        &[("tc-1", "Read", "{\"path\":\"/tmp/x.txt\"}")],
    ));
    records.push(line(2100,"control_request",json!({"requestId":"rq-ptu","request":{"type":"control_request","request_id":"rq-ptu","input":{"hook_event_name":"PostToolUse","session_id":s,"tool_use_id":"tc-1","tool_name":"Read","tool_response":"file contents here","transcript_path":"/tmp/transcript.jsonl"}}})));
    records.extend(turn(s, "msg-2", (3000, 4000, 80, 15), None, &[]));
    records.push(result(4100, s));
    f.write(&records);
    let data = f.once().await;
    let delta = &find(&data, "llm.request", Some(":s2"))["gen_ai.input.messages_delta"];
    assert_eq!(
        delta
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["assistant", "tool"]
    );
    assert_eq!(
        delta[0],
        json!({"role":"assistant","parts":[{"type":"tool_call","id":"tc-1","name":"Read","arguments":{"path":"/tmp/x.txt"}}]})
    );
    let response = delta[1]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["type"] == "tool_call_response")
        .unwrap();
    assert_eq!(response["id"], "tc-1");
    assert_eq!(response["response"], "file contents here");
}
#[tokio::test]
async fn source_l187_actual_step_response_retains_input_output_and_total_usage() {
    let f = Fixture::new();
    f.write(&full(
        "sess-tokens",
        "msg-tokens",
        (1000, 2000, 1234, 567),
        Some("done"),
        &[],
    ));
    let data = f.once().await;
    let response = find(&data, "llm.response", Some(":s1"));
    assert_eq!(response["gen_ai.usage.input_tokens"], 1234);
    assert_eq!(response["gen_ai.usage.output_tokens"], 567);
    assert_eq!(response["gen_ai.usage.total_tokens"], 1801);
}
#[tokio::test]
async fn source_l212_result_windows_survive_reconstructed_input_with_distinct_persisted_turn_ids() {
    let f = Fixture::new();
    f.write(&full(
        "sess-repeat",
        "msg-first",
        (1000, 2000, 10, 2),
        Some("first"),
        &[],
    ));
    let first = f.once().await;
    assert!(!first.is_empty());
    let first_id = first
        .iter()
        .find_map(|v| v["gen_ai.turn.id"].as_str())
        .unwrap()
        .to_owned();
    assert_eq!(first_id, "sess-repeat:t1");
    f.append(&full(
        "sess-repeat",
        "msg-second",
        (3000, 4000, 20, 4),
        Some("second"),
        &[],
    ));
    let second = f.once().await;
    assert!(!second.is_empty());
    let second_id = second
        .iter()
        .find_map(|v| v["gen_ai.turn.id"].as_str())
        .unwrap();
    assert_eq!(second_id, "sess-repeat:t2");
    assert_ne!(first_id, second_id);
}
#[tokio::test]
async fn source_l250_sdk_policy_selects_step_response_model() {
    let f = Fixture::new();
    let mut records = vec![
        init(1000, "sess-model"),
        policy(1000, "claude-sonnet-4-20250514"),
    ];
    records.extend(turn(
        "sess-model",
        "msg-model",
        (1500, 2000, 100, 20),
        None,
        &[],
    ));
    records.push(result(2500, "sess-model"));
    f.write(&records);
    let data = f.once().await;
    assert_eq!(
        find(&data, "llm.response", Some(":s1"))["gen_ai.response.model"],
        "claude-sonnet-4-20250514"
    );
}
#[tokio::test]
async fn source_l272_sdk_tool_use_emits_argument_call_and_corresponding_result() {
    let f = Fixture::new();
    f.write(&full(
        "sess-tool",
        "msg-tool",
        (1000, 3000, 100, 20),
        None,
        &[("tc-abc", "Bash", "{\"command\":\"ls\"}")],
    ));
    let data = f.once().await;
    let call = find(&data, "tool.call", None);
    let result = find(&data, "tool.result", None);
    assert_eq!(call["gen_ai.tool.name"], "Bash");
    assert_eq!(call["gen_ai.tool.call.id"], "tc-abc");
    assert_eq!(call["gen_ai.tool.call.arguments"], json!({"command":"ls"}));
    assert_eq!(result["gen_ai.tool.name"], "Bash");
    assert_eq!(result["gen_ai.tool.call.id"], "tc-abc");
}
#[tokio::test]
async fn source_l300_multiple_tool_blocks_keep_both_calls_and_results_in_order() {
    let f = Fixture::new();
    f.write(&full(
        "sess-multi",
        "msg-multi",
        (1100, 1700, 50, 10),
        None,
        &[
            ("tc-A", "Read", "{\"path\":\"/a\"}"),
            ("tc-B", "Write", "{\"path\":\"/b\"}"),
        ],
    ));
    let data = f.once().await;
    let calls = data
        .iter()
        .filter(|v| v["event.name"] == "tool.call")
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["gen_ai.tool.call.id"], "tc-A");
    assert_eq!(calls[0]["gen_ai.tool.name"], "Read");
    assert_eq!(calls[1]["gen_ai.tool.call.id"], "tc-B");
    assert_eq!(calls[1]["gen_ai.tool.name"], "Write");
    assert_eq!(
        data.iter()
            .filter(|v| v["event.name"] == "tool.result")
            .count(),
        2
    );
}

#[tokio::test]
async fn cn_sdk_state_keeps_wrong_placeholder_namespace_unknown_state_and_correct_extra() {
    let f = Fixture::new();
    let obsolete = InputState::new()
        .with_last_offset(99999.0)
        .with_extra(json!(["old", 42]))
        .with_checkpoint_extension("futureMetadata", json!({"keep":9007199254740993u64}));
    let old_file = format!("qoder-work-cn-trace-log:{}", f.file.display());
    f.store.set("qoder-work-cn-trace-log", obsolete.clone());
    f.store.set(&old_file, obsolete.clone());
    f.store.set(
        "qoder-work-cn-trace",
        InputState::new()
            .with_last_row_id(313.0)
            .with_extra(json!(42))
            .with_checkpoint_extension("futureMetadata", json!({"keep":true})),
    );
    f.store.set_offset("other-input", 77.0);
    f.write(&full(
        "owned",
        "msg-owned",
        (1000, 2000, 10, 2),
        Some("new sdk"),
        &[],
    ));
    let data = f.once().await;
    assert!(!data.is_empty());
    assert_eq!(f.store.get("qoder-work-cn-trace-log"), obsolete);
    assert_eq!(f.store.get(&old_file), obsolete);
    assert_eq!(f.store.get("qoder-work-cn-trace").extra(), Some(json!(42)));
    assert_eq!(
        f.store.get("qoder-work-cn-trace").last_row_id(),
        Some(313.0)
    );
    assert_eq!(
        f.store
            .get("qoder-work-cn-trace")
            .get_field("futureMetadata"),
        Some(json!({"keep":true}))
    );
    assert_eq!(f.store.get_offset("other-input"), 77.0);
    let fresh = StateStore::new(f.root.join("state.json"));
    fresh.load().await;
    assert_eq!(fresh.get("qoder-work-cn-trace-log"), obsolete);
    assert_eq!(fresh.get(&old_file), obsolete);
}
#[tokio::test]
async fn cn_sdk_wrong_id_offset_is_not_adopted_and_initial_closed_history_stays_excluded() {
    let f = Fixture::new();
    let correct = format!("qoder-work-cn-trace:{}", f.file.display());
    let old = format!("qoder-work-cn-trace-log:{}", f.file.display());
    f.store.delete(&correct);
    f.store.set_offset(&old, 999999.0);
    f.write(&full(
        "history",
        "msg-history",
        (1000, 2000, 10, 2),
        Some("closed old"),
        &[],
    ));
    let input = f.input();
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
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(
        f.store.get_offset(&correct),
        std::fs::metadata(&f.file).unwrap().len() as f64
    );
    assert_eq!(f.store.get_offset(&old), 999999.0);
    f.append(&full(
        "fresh",
        "msg-fresh",
        (3000, 4000, 20, 4),
        Some("fresh sdk"),
        &[],
    ));
    input.inner.run_cycle().await;
    input.stop().await.unwrap();
    let data = events.lock().unwrap();
    assert_eq!(
        data.iter()
            .filter(|v| v["event.name"] == "llm.response")
            .map(|v| v["gen_ai.response.id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["msg-fresh"]
    );
    assert_eq!(f.store.get_offset(&old), 999999.0);
}
#[tokio::test]
async fn cn_sdk_complete_result_requires_newline_and_preserves_unfinished_window() {
    use std::io::Write;
    let f = Fixture::new();
    let now = chrono::Local::now()
        .naive_local()
        .and_utc()
        .timestamp_millis();
    let records = full(
        "pending",
        "msg-pending",
        (now, now + 50, 10, 2),
        Some("pending"),
        &[],
    );
    let text = records.concat();
    std::fs::write(&f.file, text.trim_end_matches('\n')).unwrap();
    let input = f.input();
    let events = Arc::new(Mutex::new(Vec::new()));
    let copy = events.clone();
    input.bind_collector(
        move |batch| copy.lock().unwrap().extend_from_slice(batch),
        |_| {},
    );
    input.start().await.unwrap();
    assert!(events.lock().unwrap().is_empty());
    let key = format!("qoder-work-cn-trace:{}", f.file.display());
    assert!(f.store.get_offset(&key) < text.len() as f64 - 1.0);
    std::fs::OpenOptions::new()
        .append(true)
        .open(&f.file)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    input.inner.run_cycle().await;
    assert!(!events.lock().unwrap().is_empty());
    assert_eq!(f.store.get_offset(&key), text.len() as f64);
    let count = events.lock().unwrap().len();
    input.inner.run_cycle().await;
    assert_eq!(events.lock().unwrap().len(), count);
    input.stop().await.unwrap();
}
#[tokio::test]
async fn cn_sdk_identity_and_range_remain_on_the_same_opened_file() {
    let f = Fixture::new();
    let old = full(
        "session-old",
        "message-old",
        (1000, 2000, 10, 2),
        Some("old"),
        &[],
    );
    f.write(&old);
    let input = f.input();
    let path = f.file.to_string_lossy().into_owned();
    let (opened, identity) = super::open_log_file(&path).await.unwrap();
    let expected = identity.ino;
    std::fs::rename(&f.file, f.root.join("parked.log")).unwrap();
    f.write(&full(
        "session-new",
        "message-new",
        (3000, 4000, 20, 4),
        Some("new"),
        &[],
    ));
    let windows = input
        .inner
        .body
        .read_opened_file(&input.inner.runtime, &path, opened, identity)
        .await
        .unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].session.turns[0].message_id, "message-old");
    let key = format!("qoder-work-cn-trace:{path}");
    assert_eq!(f.store.get(&key).extra().unwrap()["inode"], json!(expected));
    let data = f.once().await;
    assert_eq!(
        find(&data, "llm.response", Some(":s1"))["gen_ai.response.id"],
        "message-new"
    );
}
#[tokio::test]
async fn cn_sdk_optional_real_sqlite_prompt_join_and_tool_result_keep_source_identity() {
    use rusqlite::Connection;
    let f = Fixture::new();
    let database = f.root.join("data/agents.db");
    let connection = Connection::open(database).unwrap();
    connection.execute_batch("CREATE TABLE sub_chats(id TEXT PRIMARY KEY,session_id TEXT,model_level TEXT);CREATE TABLE messages(id TEXT,sub_chat_id TEXT,sequence INTEGER,role TEXT,parts TEXT,updated_at INTEGER);INSERT INTO sub_chats VALUES('sc','db-session','model');").unwrap();
    connection
        .execute(
            "INSERT INTO messages VALUES('prompt-1','sc',0,'user',?1,0)",
            [json!([{"type":"text","text":"hello via sqlite"}]).to_string()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO messages VALUES('tool-1','sc',1,'assistant',?1,0)",
            [
                json!([{"type":"tool-Read","toolCallId":"tc-db","output":"database tool result"}])
                    .to_string(),
            ],
        )
        .unwrap();
    drop(connection);
    f.write(&full(
        "db-session",
        "msg-db",
        (1000, 2000, 10, 2),
        None,
        &[("tc-db", "Read", "{\"path\":\"/a\"}")],
    ));
    let data = f.once().await;
    assert!(data
        .iter()
        .all(|v| v["gen_ai.turn.id"] == "db-session:prompt-1"));
    assert_eq!(
        find(&data, "llm.request", Some(":s1"))["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"hello via sqlite"}]}])
    );
    assert_eq!(
        find(&data, "tool.result", None)["gen_ai.tool.call.result"],
        "database tool result"
    );
}
fn input_with_projects(f: &Fixture) -> QoderWorkLogTraceInput {
    let mut input = f.input();
    let hosted = Arc::get_mut(&mut input.inner).unwrap();
    let body = &mut hosted.body;
    body.projects_dir = f.root.join("projects");
    input
}
async fn drain(input: &QoderWorkLogTraceInput) -> Vec<Value> {
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
    let data = events.lock().unwrap().clone();
    data
}
#[tokio::test]
async fn cn_sdk_file_tool_result_is_bounded_to_real_opened_project_root() {
    let f = Fixture::new();
    let directory = f.root.join("projects/encoded/file-session/tool-results");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("tc-file.txt"), "file result 中文").unwrap();
    f.write(&full(
        "file-session",
        "msg-file",
        (1000, 2000, 10, 2),
        None,
        &[("tc-file", "Read", "{\"path\":\"/a\"}")],
    ));
    let data = drain(&input_with_projects(&f)).await;
    assert_eq!(
        find(&data, "tool.result", None)["gen_ai.tool.call.result"],
        "file result 中文"
    );
}
#[cfg(unix)]
#[tokio::test]
async fn cn_sdk_file_tool_result_never_imports_an_outside_symlink_target() {
    let f = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("outside.txt");
    std::fs::write(&secret, "outside must not escape").unwrap();
    let directory = f.root.join("projects/encoded/file-session/tool-results");
    std::fs::create_dir_all(&directory).unwrap();
    std::os::unix::fs::symlink(secret, directory.join("tc-file.txt")).unwrap();
    f.write(&full(
        "file-session",
        "msg-file",
        (1000, 2000, 10, 2),
        None,
        &[("tc-file", "Read", "{\"path\":\"/a\"}")],
    ));
    let data = drain(&input_with_projects(&f)).await;
    assert!(find(&data, "tool.result", None)
        .get("gen_ai.tool.call.result")
        .is_none());
}
#[tokio::test]
async fn cn_sdk_workspace_policy_is_checked_before_optional_content_enrichment() {
    let f = Fixture::new();
    let excluded = f.root.join("excluded");
    std::fs::create_dir_all(&excluded).unwrap();
    let mut records = full(
        "private",
        "msg-private",
        (1000, 2000, 10, 2),
        Some("private content"),
        &[],
    );
    records[0] = line(
        900,
        "system",
        json!({"subtype":"init","session_id":"private","model":"Premium","cwd":excluded.to_string_lossy(),"agents":[],"tools":[]}),
    );
    f.write(&records);
    let input = f.input();
    input
        .inner
        .runtime
        .set_workspace_policy(crate::inputs::base::WorkspacePolicy::new(
            vec![excluded.to_string_lossy().into_owned()],
            None,
        ));
    assert!(drain(&input).await.is_empty());
}
