use super::*;
use crate::checkpoints::StateStore;
use flate2::{write::DeflateEncoder, Compression};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;

const SESSION: &str = "111111111111111111111111";
const REPLY: &str = "222222222222222222222222";
const TURN: &str = "333333333333333333333333";
const TRACE: &str = "44444444444444444444444444444444";
const HISTORY: &str = "555555555555555555555555";

fn setup(root: &Path, state: Arc<StateStore>) -> TraeCnLogInput {
    let mut input = TraeCnLogInput::new(
        SessionInputOptions {
            state_store: state,
            session_dir: Some(root.join("history").to_string_lossy().into_owned()),
            file_pattern: None,
            poll_interval_ms: None,
        },
        &root.to_string_lossy(),
    );
    let sources = Arc::get_mut(&mut input.sources).unwrap();
    sources.env.remove("AGENT_DATA_COLLECTION_CONFIG");
    sources.agent_dir = root.to_owned();
    sources.hub_dir = root.join("hub");
    sources.native_dir = root.join("native");
    input
}

fn write_native(root: &Path, include_missing_receipt: bool) {
    let path = root.join("native/20261124T170001/Modular/ai_agent-1-2026-11-24.alaudalog");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut header = [0; 178];
    header[..4].copy_from_slice(b"AalG");
    header[152..156].copy_from_slice(b"AALG");
    header[168..172].copy_from_slice(&6_u32.to_le_bytes());
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(&header).unwrap();
    let mut encoded = DeflateEncoder::new(file, Compression::fast());
    let mut rows = vec![
        json!({"message":"context resolve applied to task request","session_id":SESSION,"turn_id":TURN}),
        json!({"message":"cloud stream response headers","url":"https://example.test/api/agent/v3/create_agent_task","resp_logid":"request-one"}),
        json!({"message":"streaming ToolCall dispatch","require_local_execution":true,"toolcall_id":"call-fixture"}),
        json!({"message":"tool execution started","toolcall_id":"call-fixture","tool_name":"Read"}),
        json!({"message":"recording history entry","history_source":"Server","source":"llm_default","history_id":HISTORY}),
        json!({"message":"[Hub] task event contract","event_type":"token_usage","conversation_id":SESSION,"task_id":REPLY,"event_seq":3}),
    ];
    if include_missing_receipt {
        rows.push(json!({"message":"[Hub] task event contract","event_type":"token_usage","conversation_id":SESSION,"task_id":REPLY,"event_seq":7}));
    }
    rows.extend([
        json!({"message":"routing CommitReady","has_async_child":false,"has_foreground":false,"parent_result_count":1}),
        json!({"message":"commit_results","conversation_id":SESSION,"result_count":1}),
        json!({"message":"chat: runner completed","turn_id":TURN}),
    ]);
    for (index, mut fields) in rows.into_iter().enumerate() {
        fields["trace_id"] = json!(TRACE);
        let row =
            json!({"span":123, "time":[2026,328,17,0,2,index * 10000,0,0,0], "fields":fields});
        ciborium::ser::into_writer(&row, &mut encoded).unwrap();
    }
    encoded.finish().unwrap();
}

fn hub_row(seq: u64, kind: &str, mut data: Value) -> Value {
    data["reply_to_message_id"] = json!(REPLY);
    json!({"seq":seq,"type":kind,"data":data.to_string()})
}

fn write_hub(root: &Path) -> PathBuf {
    let path = root.join(format!("hub/current/{REPLY}.jsonl"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let rows = [
        hub_row(
            1,
            "metadata",
            json!({"session_id":SESSION,"trace_id":TRACE}),
        ),
        hub_row(
            2,
            "plan_item",
            json!({"id":"plan-1","reasoning_content":"fixture trace reasoning",
            "tool_call_info":{"meta":{"llm_toolcall_id":"call-fixture"}}}),
        ),
        hub_row(
            3,
            "token_usage",
            json!({"prompt_tokens":8,"completion_tokens":9,"total_tokens":17,
            "cache_read_input_tokens":2}),
        ),
        hub_row(4, "done", json!({})),
    ];
    let mut file = fs::File::create(&path).unwrap();
    for row in rows {
        writeln!(file, "{row}").unwrap();
    }
    path
}

fn append_response(root: &Path, id: &str) {
    fs::create_dir_all(root.join("history")).unwrap();
    let mut history = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("history/trae-cn-fixture.jsonl"))
        .unwrap();
    writeln!(history, "{}", json!({
        "event.id":id, "event.name":"llm.response","time_unix_nano":"1795539600000000000",
        "gen_ai.agent.type":"trae-cn","user.id":"isolated-fixture","gen_ai.session.id":SESSION,
        "gen_ai.turn.id":"fixture-turn","gen_ai.step.id":"fixture-step",
        "gen_ai.request.model":"fixture-model","gen_ai.response.model":"fixture-model",
        "gen_ai.response.id":"fixture-response","agent.trae-cn.tool_call_ids":["call-fixture"],
        "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"fixture answer"}]}],
    })).unwrap();
}

#[tokio::test]
async fn trae_hub_matches_native_round_and_persists_node_compatible_cursor() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let state_path = root.join("checkpoint.json");
    let state = Arc::new(StateStore::new(&state_path));
    let input = setup(&root, Arc::clone(&state));
    write_native(&root, false);
    let cache = write_hub(&root);
    // Open the cache before the producer unlinks it. The collector retains the handle.
    input.sources.capture_hub();
    fs::remove_file(cache).unwrap();
    append_response(&root, "fixture-first");
    let events = input.collect_entries().await.unwrap();
    assert_eq!(events.len(), 1);
    let response = &events[0];
    assert_eq!(response.input_tokens, Some(8));
    assert_eq!(response.output_tokens, Some(9));
    assert_eq!(response.cache_read_input_tokens, Some(2));
    assert!(response.get("agent.trae-cn.tool_call_ids").is_none());
    assert_eq!(
        response.get("agent.trae-cn.hub.complete"),
        Some(&json!(true))
    );
    let rounds = response.get("loongsuite.trae_cn.model_responses").unwrap();
    assert_eq!(rounds[0]["id"], HISTORY);
    assert_eq!(rounds[0]["toolIds"], json!(["call-fixture"]));
    assert_eq!(rounds[0]["input"], 8);
    assert_eq!(
        response.output_messages.as_ref().unwrap()[0]["parts"][0]["type"],
        "reasoning"
    );
    state.save().await.unwrap();
    let key = format!(
        "{LISTENER}:{}",
        root.join("history/trae-cn-fixture.jsonl").display()
    );
    assert!(state.get_offset(&key) > 0.0);
    drop(input);
    let restored = Arc::new(StateStore::new(&state_path));
    restored.load().await;
    let restarted = setup(&root, restored);
    append_response(&root, "fixture-after-restart");
    let rows = restarted.collect_entries().await.unwrap();
    assert_eq!(
        rows.iter()
            .map(|entry| entry.event_id.as_str())
            .collect::<Vec<_>>(),
        ["fixture-after-restart"]
    );
}

#[tokio::test]
async fn trae_incomplete_token_receipts_are_observed_but_not_authoritative() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    write_native(&root, true);
    write_hub(&root);
    append_response(&root, "fixture-incomplete");
    let input = setup(
        &root,
        Arc::new(StateStore::new(root.join("checkpoint.json"))),
    );
    let events = input.collect_entries().await.unwrap();
    let response = &events[0];
    assert_eq!(response.input_tokens, None);
    assert_eq!(response.output_tokens, None);
    assert_eq!(
        response.get("agent.trae-cn.hub.complete"),
        Some(&json!(false))
    );
    assert_eq!(
        response.get("agent.trae-cn.hub.missing_usage_seqs"),
        Some(&json!("7"))
    );
    assert_eq!(
        response.get("agent.trae-cn.hub.total_tokens_observed"),
        Some(&json!(17))
    );
}
