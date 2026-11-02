use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{CliOutput, CliRunner, WukongInput, WukongInputOptions};
use crate::checkpoints::InputStatePatch;
use crate::inputs::rest_support::{entry_json, memory_state_store};
use crate::types::AgentActivityEntry;

struct EnvVarGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        unsafe { std::env::set_var(key, value) };
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => unsafe { std::env::set_var(self.key, value) },
            None => unsafe { std::env::remove_var(self.key) },
        }
    }
}

fn sample_task() -> Value {
    json!({
        "id": "task-1",
        "session_id": "sess-1",
        "name": "Test task",
        "status": "completed",
        "agent_type": "spark",
        "created_at": 1779240536440i64,
        "completed_at": 1779240561311i64,
        "started_at": 1779240536442i64,
        "last_active_at": 1779240536440i64,
        "metadata": {
            "modelName": "dingtalk_deap/dingtalk-standard",
            "modelProvider": "dingtalk_deap",
            "sandbox_level": "relaxed"
        }
    })
}

fn sample_messages() -> Value {
    json!([
        {
            "id": "msg-1",
            "conversationId": "sess-1",
            "role": "user",
            "content": "Hello wukong",
            "events": null,
            "createdAt": 1779240548629i64,
            "timestamp": 1779240548629i64,
            "turnIndex": 0
        },
        {
            "id": "msg-2",
            "conversationId": "sess-1",
            "role": "assistant",
            "content": null,
            "events": [
                { "type": "RUN_STARTED", "runId": "run-1", "threadId": "sess-1", "timestamp": 1779240557803i64 },
                { "type": "FIRST_TOKEN", "ttft_ms": 1794, "e2e_ttft_ms": 9164, "timestamp": 1779240557803i64 },
                { "type": "TEXT_MESSAGE_START", "messageId": "text-1", "role": "assistant", "timestamp": 1779240557844i64 },
                { "type": "TEXT_MESSAGE_CONTENT", "delta": "Hello! ", "messageId": "text-1", "timestamp": 1779240557844i64 },
                { "type": "TEXT_MESSAGE_CONTENT", "delta": "How can I help?", "messageId": "text-1", "timestamp": 1779240558000i64 },
                { "type": "TEXT_MESSAGE_END", "messageId": "text-1", "timestamp": 1779240559964i64 },
                { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 20, "cached_tokens": 0, "total_tokens": 120, "timestamp": 1779240561303i64 },
                { "type": "RUN_FINISHED", "runId": "run-1", "threadId": "sess-1", "timestamp": 1779240561303i64 }
            ],
            "createdAt": 1779240557803i64,
            "timestamp": 1779240557803i64,
            "turnIndex": 1
        }
    ])
}

fn list_body(items: Value) -> String {
    json!({ "hasMore": false, "items": items }).to_string()
}

fn messages_body(messages: Value) -> String {
    json!({ "messages": messages }).to_string()
}

fn out(stdout: impl Into<String>) -> Result<CliOutput, String> {
    Ok(CliOutput {
        stdout: stdout.into(),
        stderr: String::new(),
    })
}

fn routes(list: String, messages: String) -> Arc<dyn CliRunner> {
    super::scripted(move |args: &[String]| {
        let joined = args.join(" ");
        if joined.contains("list_tasks") {
            return out(list.clone());
        }
        if joined.contains("get_spark_agui_messages") {
            return out(messages.clone());
        }
        Err(format!("unexpected command: {joined}"))
    })
}

fn routes_by(
    list: String,
    messages: std::collections::HashMap<String, String>,
) -> Arc<dyn CliRunner> {
    super::scripted(move |args: &[String]| {
        let joined = args.join(" ");
        if joined.contains("list_tasks") {
            return out(list.clone());
        }
        if joined.contains("get_spark_agui_messages") {
            let id = conversation_arg(args);
            let Some(body) = messages.get(&id) else {
                return Err(format!("unexpected conversation: {id}"));
            };
            return out(body.clone());
        }
        Err(format!("unexpected command: {joined}"))
    })
}

fn conversation_arg(args: &[String]) -> String {
    args.last()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("conversationId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

struct Harness {
    _dir: tempfile::TempDir,
    store: Arc<crate::checkpoints::StateStore>,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp");
        let store = memory_state_store(dir.path());
        Self { _dir: dir, store }
    }

    fn seed(&self, extra: Value) {
        self.store.update(
            "wukong",
            InputStatePatch {
                extra: Some(extra),
                ..InputStatePatch::default()
            },
        );
    }

    async fn run(&self, runner: Arc<dyn CliRunner>) -> Vec<Value> {
        let input = WukongInput::with_runner(
            WukongInputOptions {
                state_store: Arc::clone(&self.store),
                poll_interval_ms: Some(60_000),
                cli_path: Some("/usr/bin/wukong-cli".into()),
            },
            runner,
        );
        let got = Arc::new(Mutex::new(Vec::<AgentActivityEntry>::new()));
        let slot = Arc::clone(&got);
        input.on_entries(move |batch| {
            slot.lock().expect("entries").extend(batch.iter().cloned());
        });
        input.start().await.expect("start");
        input.stop().await.expect("stop");
        let entries = got.lock().expect("entries").clone();
        entries.iter().map(entry_json).collect()
    }

    fn extra(&self) -> Value {
        self.store.get("wukong").extra().unwrap_or(Value::Null)
    }
}

fn named<'a>(rows: &'a [Value], name: &str) -> &'a Value {
    rows.iter()
        .find(|row| row.get("event.name").and_then(Value::as_str) == Some(name))
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn all_named<'a>(rows: &'a [Value], name: &str) -> Vec<&'a Value> {
    rows.iter()
        .filter(|row| row.get("event.name").and_then(Value::as_str) == Some(name))
        .collect()
}

fn tool_named<'a>(rows: &'a [Value], event: &str, name: &str) -> &'a Value {
    rows.iter()
        .find(|row| {
            row.get("event.name").and_then(Value::as_str) == Some(event)
                && row.get("gen_ai.tool.name").and_then(Value::as_str) == Some(name)
        })
        .unwrap_or_else(|| panic!("missing {event} {name}"))
}

fn is_num(value: Option<&Value>, expected: i64) -> bool {
    value.and_then(Value::as_i64) == Some(expected)
        || value.and_then(Value::as_f64) == Some(expected as f64)
}

fn seen<'a>(extra: &'a Value, key: &str) -> Option<&'a Value> {
    extra.get("seenCounts").and_then(|value| value.get(key))
}

fn stale<'a>(extra: &'a Value, key: &str) -> Option<&'a Value> {
    extra.get("staleCounters").and_then(|value| value.get(key))
}

fn host_name() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_default()
}

fn pair(events: Value, id: &str, created: i64, turn: i64) -> Value {
    json!([
        {
            "id": "msg-1",
            "conversationId": "sess-1",
            "role": "user",
            "content": "Hello wukong",
            "events": null,
            "createdAt": 1779240548629i64,
            "timestamp": 1779240548629i64,
            "turnIndex": 0
        },
        {
            "id": id,
            "conversationId": "sess-1",
            "role": "assistant",
            "content": null,
            "events": events,
            "createdAt": created,
            "timestamp": created,
            "turnIndex": turn
        }
    ])
}

fn standard_runner(messages: Value) -> Arc<dyn CliRunner> {
    routes(list_body(json!([sample_task()])), messages_body(messages))
}

#[test]
fn uses_unified_poll_interval_over_the_60s_default() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let _env = EnvVarGuard::set("LOONGSUITE_PILOT_POLL_INTERVAL_MS", "3000");
    let harness = Harness::new();
    let input = WukongInput::new(WukongInputOptions {
        state_store: Arc::clone(&harness.store),
        poll_interval_ms: None,
        cli_path: Some("/usr/bin/wukong-cli".into()),
    });
    assert_eq!(input.poll_interval_ms(), 3000);
}

#[test]
fn cli_path_and_watch_paths_follow_the_platform() {
    let home = crate::utils::resolve_home("~");
    let paths = WukongInput::get_watch_paths();
    assert_eq!(paths.len(), 1);
    assert_eq!(
        Path::new(&paths[0]),
        Path::new(&home).join(".real").join("daemon.sock")
    );
    assert!(
        paths[0].starts_with(home.trim_end_matches('/')),
        "watch path {} home {home}",
        paths[0]
    );
    if cfg!(target_os = "macos") {
        assert_eq!(
            WukongInput::get_cli_path(),
            "/Applications/Wukong.app/Contents/MacOS/wukong-cli"
        );
    } else {
        assert_eq!(WukongInput::get_cli_path(), "wukong-cli");
    }
    let harness = Harness::new();
    let input = WukongInput::new(WukongInputOptions {
        state_store: Arc::clone(&harness.store),
        poll_interval_ms: Some(60_000),
        cli_path: None,
    });
    assert_eq!(input.id(), "wukong");
    assert_eq!(input.agent_type(), crate::types::ClientType::Wukong);
    assert_eq!(
        input.collection_method(),
        crate::types::CollectionMethod::CliApiPolling
    );
}

#[tokio::test]
async fn user_content_is_merged_into_step_1_llm_request() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(sample_messages())).await;
    let req = named(&rows, "llm.request");
    assert_eq!(req["gen_ai.agent.type"], "wukong");
    assert_eq!(req["gen_ai.session.id"], "sess-1");
    assert!(req.get("gen_ai.step.id").and_then(Value::as_str).is_some());
    assert_eq!(
        req["gen_ai.input.messages_delta"],
        json!([{ "role": "user", "parts": [{ "type": "text", "content": "Hello wukong" }] }])
    );
    assert_eq!(req["host.name"], host_name());
    assert_eq!(req["service.name"], "wukong");
    assert_eq!(req["gen_ai.agent.id"], "task-1");
    assert_eq!(req["gen_ai.agent.name"], "wukong");
    assert_eq!(req["gen_ai.provider.name"], "dingtalk_deap");
    assert_eq!(req["gen_ai.turn.id"], "sess-1:t1");
}

#[tokio::test]
async fn maps_assistant_events_to_llm_response_with_token_usage() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(sample_messages())).await;
    let resp = named(&rows, "llm.response");
    assert_eq!(resp["gen_ai.agent.type"], "wukong");
    assert_eq!(resp["gen_ai.session.id"], "sess-1");
    assert_eq!(resp["gen_ai.response.id"], "run-1");
    assert_eq!(
        resp["gen_ai.output.messages"],
        json!([{ "role": "assistant", "parts": [{ "type": "text", "content": "Hello! How can I help?" }] }])
    );
    assert_eq!(resp["gen_ai.usage.input_tokens"], 100);
    assert_eq!(resp["gen_ai.usage.output_tokens"], 20);
    assert_eq!(resp["gen_ai.usage.total_tokens"], 120);
    assert_eq!(resp["gen_ai.usage.cache_read.input_tokens"], 0);
    assert_eq!(resp["host.name"], host_name());
    assert_eq!(resp["service.name"], "wukong");
    assert_eq!(resp["gen_ai.agent.id"], "task-1");
    assert_eq!(resp["gen_ai.agent.name"], "wukong");
    assert_eq!(resp["gen_ai.provider.name"], "dingtalk_deap");
    assert_eq!(resp["gen_ai.turn.id"], "sess-1:t1");
}

#[tokio::test]
async fn only_collects_new_messages_appended_to_an_existing_session() {
    let mut messages = sample_messages();
    let extra = json!([
        {
            "id": "msg-3", "conversationId": "sess-1", "role": "user",
            "content": "Follow up question", "events": null,
            "createdAt": 1779240600000i64, "timestamp": 1779240600000i64, "turnIndex": 2
        },
        {
            "id": "msg-4", "conversationId": "sess-1", "role": "assistant",
            "content": null,
            "events": [
                { "type": "RUN_STARTED", "runId": "run-2", "threadId": "sess-1", "timestamp": 1779240600100i64 },
                { "type": "TEXT_MESSAGE_CONTENT", "delta": "Here is the answer.", "messageId": "text-2", "timestamp": 1779240600200i64 },
                { "type": "USAGE", "prompt_tokens": 200, "completion_tokens": 40, "total_tokens": 240, "timestamp": 1779240600300i64 },
                { "type": "RUN_FINISHED", "runId": "run-2", "threadId": "sess-1", "timestamp": 1779240600300i64 }
            ],
            "createdAt": 1779240600100i64, "timestamp": 1779240600100i64, "turnIndex": 3
        }
    ]);
    let Value::Array(base) = &mut messages else {
        panic!("array")
    };
    if let Value::Array(more) = extra {
        base.extend(more);
    }
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": { "sess-1": 2 } }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(rows.len(), 2);
    let req = named(&rows, "llm.request");
    assert_eq!(
        req["gen_ai.input.messages_delta"],
        json!([{ "role": "user", "parts": [{ "type": "text", "content": "Follow up question" }] }])
    );
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.usage.input_tokens"],
        200
    );
    assert!(is_num(seen(&harness.extra(), "sess-1"), 4));
}

#[tokio::test]
async fn picks_up_new_tasks_without_emitting_unpaired_users() {
    let task2 = json!({
        "id": "task-2",
        "session_id": "sess-2",
        "name": "Test task",
        "status": "completed",
        "agent_type": "spark",
        "created_at": 1,
        "metadata": sample_task()["metadata"].clone()
    });
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": { "sess-1": 2 } }));
    let rows = harness
        .run(routes_by(
            list_body(json!([sample_task(), task2])),
            std::collections::HashMap::from([
                ("sess-1".into(), messages_body(sample_messages())),
                (
                    "sess-2".into(),
                    messages_body(json!([{
                        "id": "msg-t2-1", "conversationId": "sess-2", "role": "user",
                        "content": "New session", "events": null,
                        "createdAt": 1779240700000i64, "timestamp": 1779240700000i64, "turnIndex": 0
                    }])),
                ),
            ]),
        ))
        .await;
    assert!(rows.is_empty());
    assert!(
        seen(&harness.extra(), "sess-2").is_none() || is_num(seen(&harness.extra(), "sess-2"), 0)
    );
}

#[tokio::test]
async fn handles_daemon_not_running_gracefully() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness
        .run(super::scripted(|_args| {
            Err("connect ENOENT /daemon.sock".into())
        }))
        .await;
    assert!(rows.is_empty());
}

#[tokio::test]
async fn maps_tool_call_start_and_end_to_tool_events() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-2", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-1", "toolName": "web_search", "timestamp": 1779240560100i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-1", "toolName": "web_search", "result": { "url": "https://example.com" }, "timestamp": 1779240560500i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Found result.", "messageId": "text-2", "timestamp": 1779240560600i64 },
            { "type": "USAGE", "prompt_tokens": 200, "completion_tokens": 30, "total_tokens": 230, "timestamp": 1779240560700i64 },
            { "type": "RUN_FINISHED", "runId": "run-2", "threadId": "sess-1", "timestamp": 1779240560700i64 }
        ]),
        "msg-tool",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let call = named(&rows, "tool.call");
    assert_eq!(call["gen_ai.tool.name"], "web_search");
    assert_eq!(call["gen_ai.tool.call.id"], "tc-1");
    let result = named(&rows, "tool.result");
    assert_eq!(result["gen_ai.tool.name"], "web_search");
    assert_eq!(
        result["gen_ai.tool.call.result"],
        json!({ "url": "https://example.com" })
    );
}

#[tokio::test]
async fn skips_user_messages_with_empty_content() {
    let messages = json!([
        {
            "id": "msg-1", "conversationId": "sess-1", "role": "user", "content": "",
            "events": null, "createdAt": 1, "timestamp": 1, "turnIndex": 0
        },
        {
            "id": "msg-null", "conversationId": "sess-1", "role": "user", "content": null,
            "events": null, "createdAt": 2, "timestamp": 2, "turnIndex": 0
        }
    ]);
    let harness = Harness::new();
    let rows = harness.run(standard_runner(messages)).await;
    assert!(rows.is_empty());
}

#[tokio::test]
async fn baselines_on_first_start_to_avoid_replaying_history() {
    let harness = Harness::new();
    let rows = harness.run(standard_runner(sample_messages())).await;
    assert!(rows.is_empty());
    assert!(is_num(seen(&harness.extra(), "sess-1"), 2));
}

#[tokio::test]
async fn paginates_through_all_tasks_when_has_more_is_true() {
    let task2 = json!({
        "id": "task-2", "session_id": "sess-2", "name": "Test task",
        "status": "completed", "agent_type": "spark", "metadata": {}
    });
    let lists = Arc::new(AtomicUsize::new(0));
    let lists_cb = Arc::clone(&lists);
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness
        .run(super::scripted(move |args| {
            let joined = args.join(" ");
            if joined.contains("list_tasks") {
                let n = lists_cb.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    return out(json!({
                        "hasMore": true,
                        "items": [sample_task()],
                        "nextCursor": "cursor-1"
                    })
                    .to_string());
                }
                return out(json!({ "hasMore": false, "items": [task2.clone()] }).to_string());
            }
            if joined.contains("get_spark_agui_messages") {
                let id = conversation_arg(args);
                if id == "sess-1" {
                    return out(messages_body(sample_messages()));
                }
                return out(messages_body(json!([{
                    "id": "msg-t2-1", "conversationId": "sess-2", "role": "user",
                    "content": "Page 2 task", "events": null,
                    "createdAt": 1779240700000i64, "timestamp": 1779240700000i64, "turnIndex": 0
                }])));
            }
            Err(format!("unexpected: {joined}"))
        }))
        .await;
    assert_eq!(lists.load(Ordering::SeqCst), 2);
    let sessions: HashSet<_> = rows
        .iter()
        .filter_map(|row| row.get("gen_ai.session.id").and_then(Value::as_str))
        .collect();
    assert!(sessions.contains("sess-1"));
}

#[tokio::test]
async fn does_not_prune_seen_counts_on_first_miss() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": { "sess-1": 2, "stale-sess": 10 } }));
    let _rows = harness.run(standard_runner(sample_messages())).await;
    let extra = harness.extra();
    assert!(is_num(seen(&extra, "sess-1"), 2));
    assert!(is_num(seen(&extra, "stale-sess"), 10));
    assert!(is_num(stale(&extra, "stale-sess"), 1));
}

#[tokio::test]
async fn marks_error_type_when_tool_event_has_error() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-3", "threadId": "sess-1", "timestamp": 1779240570000i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-err", "toolName": "file_read", "timestamp": 1779240570100i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-err", "toolName": "file_read", "isError": true, "error": "ENOENT: file not found", "timestamp": 1779240570500i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240570600i64 },
            { "type": "RUN_FINISHED", "runId": "run-3", "threadId": "sess-1", "timestamp": 1779240570600i64 }
        ]),
        "msg-tool-err",
        1779240570000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        named(&rows, "tool.result")["error.type"],
        "ENOENT: file not found"
    );
}

#[tokio::test]
async fn uses_message_id_as_turn_id_when_turn_index_is_negative() {
    let mut messages = sample_messages();
    messages[0]["turnIndex"] = json!(-1);
    messages[1]["turnIndex"] = json!(-1);
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        named(&rows, "llm.request")["gen_ai.turn.id"],
        "sess-1:msg-2"
    );
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.turn.id"],
        "sess-1:msg-2"
    );
}

#[tokio::test]
async fn computes_tool_call_duration_from_timestamps() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-5", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-d1", "toolName": "bash", "timestamp": 1779240560100i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-d1", "toolName": "bash", "result": "ok", "timestamp": 1779240560500i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240560600i64 },
            { "type": "RUN_FINISHED", "runId": "run-5", "threadId": "sess-1", "timestamp": 1779240560600i64 }
        ]),
        "msg-tool-dur",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        named(&rows, "tool.result")["gen_ai.tool.call.duration"].as_f64(),
        Some(400.0)
    );
}

#[tokio::test]
async fn computes_duration_without_tool_call_id() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-6", "threadId": "sess-1", "timestamp": 1779240590000i64 },
            { "type": "TOOL_CALL_START", "toolName": "bash", "timestamp": 1779240590100i64 },
            { "type": "TOOL_CALL_END", "toolName": "bash", "result": "ok", "timestamp": 1779240590350i64 },
            { "type": "USAGE", "prompt_tokens": 50, "completion_tokens": 5, "total_tokens": 55, "timestamp": 1779240590400i64 },
            { "type": "RUN_FINISHED", "runId": "run-6", "threadId": "sess-1", "timestamp": 1779240590400i64 }
        ]),
        "msg-tool-noId",
        1779240590000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        named(&rows, "tool.result")["gen_ai.tool.call.duration"].as_f64(),
        Some(250.0)
    );
}

#[tokio::test]
async fn generates_unique_event_ids_for_tool_calls_without_ids() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-4", "threadId": "sess-1", "timestamp": 1779240580000i64 },
            { "type": "TOOL_CALL_START", "toolName": "bash", "timestamp": 1779240580100i64 },
            { "type": "TOOL_CALL_END", "toolName": "bash", "result": "ok", "timestamp": 1779240580200i64 },
            { "type": "TOOL_CALL_START", "toolName": "bash", "timestamp": 1779240580300i64 },
            { "type": "TOOL_CALL_END", "toolName": "bash", "result": "done", "timestamp": 1779240580400i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240580500i64 },
            { "type": "RUN_FINISHED", "runId": "run-4", "threadId": "sess-1", "timestamp": 1779240580500i64 }
        ]),
        "msg-multi-tool",
        1779240580000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let calls = all_named(&rows, "tool.call");
    let results = all_named(&rows, "tool.result");
    assert_eq!(calls.len(), 2);
    assert_eq!(results.len(), 2);
    let mut ids = HashSet::new();
    for row in calls.into_iter().chain(results) {
        ids.insert(row["event.id"].as_str().unwrap_or("").to_string());
    }
    assert_eq!(ids.len(), 4);
}

#[tokio::test]
async fn computes_duration_for_multiple_tool_calls_without_ids() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-7", "threadId": "sess-1", "timestamp": 1779240600000i64 },
            { "type": "TOOL_CALL_START", "toolName": "bash", "timestamp": 1779240600100i64 },
            { "type": "TOOL_CALL_END", "toolName": "bash", "result": "ok", "timestamp": 1779240600300i64 },
            { "type": "TOOL_CALL_START", "toolName": "read", "timestamp": 1779240600400i64 },
            { "type": "TOOL_CALL_END", "toolName": "read", "result": "data", "timestamp": 1779240600900i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240601000i64 },
            { "type": "RUN_FINISHED", "runId": "run-7", "threadId": "sess-1", "timestamp": 1779240601000i64 }
        ]),
        "msg-multi-dur",
        1779240600000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let results = all_named(&rows, "tool.result");
    assert_eq!(results.len(), 2);
    assert_eq!(
        results[0]["gen_ai.tool.call.duration"].as_f64(),
        Some(200.0)
    );
    assert_eq!(
        results[1]["gen_ai.tool.call.duration"].as_f64(),
        Some(500.0)
    );
}

#[tokio::test]
async fn sets_step_id_on_fallback_single_step() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(sample_messages())).await;
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.step.id"],
        "sess-1:t1:s1"
    );
}

#[tokio::test]
async fn generates_step_id_from_step_started_events() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-s1", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "STEP_STARTED", "messageId": "step-uuid-1", "stepName": "Read file", "timestamp": 1779240560010i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-s1", "toolName": "file_read", "timestamp": 1779240560100i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-s1", "toolName": "file_read", "result": "content", "timestamp": 1779240560300i64 },
            { "type": "STEP_FINISHED", "messageId": "step-uuid-1", "timestamp": 1779240560400i64 },
            { "type": "STEP_STARTED", "messageId": "step-uuid-2", "stepName": "Respond", "timestamp": 1779240560500i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Done!", "messageId": "text-1", "timestamp": 1779240560600i64 },
            { "type": "USAGE", "prompt_tokens": 200, "completion_tokens": 30, "total_tokens": 230, "timestamp": 1779240560700i64 },
            { "type": "STEP_FINISHED", "messageId": "step-uuid-2", "timestamp": 1779240560700i64 },
            { "type": "RUN_FINISHED", "runId": "run-s1", "threadId": "sess-1", "timestamp": 1779240560800i64 }
        ]),
        "msg-steps",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(named(&rows, "tool.call")["gen_ai.step.id"], "sess-1:t1:s1");
    assert_eq!(
        named(&rows, "tool.result")["gen_ai.step.id"],
        "sess-1:t1:s1"
    );
    let responses = all_named(&rows, "llm.response");
    assert_eq!(responses.len(), 2);
    let s1 = responses
        .iter()
        .find(|row| row["gen_ai.step.id"] == "sess-1:t1:s1")
        .expect("s1");
    let s2 = responses
        .iter()
        .find(|row| row["gen_ai.step.id"] == "sess-1:t1:s2")
        .expect("s2");
    assert_eq!(s1["gen_ai.response.finish_reasons"], json!(["tool_calls"]));
    assert_eq!(s2["gen_ai.response.finish_reasons"], json!(["end_turn"]));
    assert_eq!(s2["gen_ai.usage.input_tokens"], 200);
    assert_eq!(s2["gen_ai.usage.output_tokens"], 30);
}

#[tokio::test]
async fn sets_finish_reasons_to_tool_calls_when_step_has_tool_calls() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-fr", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-fr", "toolName": "bash", "timestamp": 1779240560100i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-fr", "toolName": "bash", "result": "ok", "timestamp": 1779240560300i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Ran command.", "messageId": "text-1", "timestamp": 1779240560400i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "timestamp": 1779240560500i64 },
            { "type": "RUN_FINISHED", "runId": "run-fr", "threadId": "sess-1", "timestamp": 1779240560500i64 }
        ]),
        "msg-fr-tools",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.response.finish_reasons"],
        json!(["tool_calls"])
    );
}

#[tokio::test]
async fn sets_finish_reasons_to_end_turn_for_text_only_responses() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(sample_messages())).await;
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.response.finish_reasons"],
        json!(["end_turn"])
    );
}

#[tokio::test]
async fn sets_finish_reasons_to_stop_on_run_error() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-err", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Working...", "messageId": "text-1", "timestamp": 1779240560100i64 },
            { "type": "RUN_ERROR", "code": "CANCELLED", "message": "任务已终止", "runId": "run-err", "timestamp": 1779240560200i64 },
            { "type": "RUN_FINISHED", "runId": "run-err", "threadId": "sess-1", "timestamp": 1779240560200i64 }
        ]),
        "msg-err",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let resp = named(&rows, "llm.response");
    assert_eq!(resp["gen_ai.response.finish_reasons"], json!(["stop"]));
    assert_eq!(resp["error.type"], "CANCELLED");
    assert_eq!(resp["error.message"], "任务已终止");
}

#[tokio::test]
async fn accumulates_tool_call_args_delta() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-a", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-a", "toolName": "browser_use", "timestamp": 1779240560100i64 },
            { "type": "TOOL_CALL_ARGS", "toolCallId": "tc-a", "delta": "{\"action\":", "timestamp": 1779240560150i64 },
            { "type": "TOOL_CALL_ARGS", "toolCallId": "tc-a", "delta": "\"click\",\"selector\":\"#btn\"}", "timestamp": 1779240560200i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-a", "toolName": "browser_use", "result": "clicked", "timestamp": 1779240560500i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Clicked.", "messageId": "text-1", "timestamp": 1779240560600i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240560700i64 },
            { "type": "RUN_FINISHED", "runId": "run-a", "threadId": "sess-1", "timestamp": 1779240560700i64 }
        ]),
        "msg-args",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        named(&rows, "tool.call")["gen_ai.tool.call.arguments"],
        json!({ "action": "click", "selector": "#btn" })
    );
}

#[tokio::test]
async fn transforms_activity_snapshot_into_tool_pair() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-act", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            {
                "type": "ACTIVITY_SNAPSHOT", "activityType": "TERMINAL", "timestamp": 1779240560100i64,
                "content": { "command": "ls -la", "output": "total 0\ndrwxr-xr-x", "exit_code": 0, "start_time": 1779240560100i64, "finish_time": 1779240560300i64 }
            },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Listed files.", "messageId": "text-1", "timestamp": 1779240560400i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240560500i64 },
            { "type": "RUN_FINISHED", "runId": "run-act", "threadId": "sess-1", "timestamp": 1779240560500i64 }
        ]),
        "msg-activity",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let call = named(&rows, "tool.call");
    assert_eq!(call["gen_ai.tool.name"], "terminal");
    assert_eq!(
        call["gen_ai.tool.call.arguments"],
        json!({ "command": "ls -la" })
    );
    let result = named(&rows, "tool.result");
    assert_eq!(result["gen_ai.tool.name"], "terminal");
    assert_eq!(
        result["gen_ai.tool.call.result"],
        json!({ "output": "total 0\ndrwxr-xr-x", "exit_code": 0 })
    );
    assert_eq!(result["gen_ai.tool.call.duration"].as_f64(), Some(200.0));
}

#[tokio::test]
async fn maps_activity_snapshots_to_canonical_fields() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-act-2", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "FILE_READ", "timestamp": 1779240560100i64, "content": {
                "path": "/repo/src/index.ts", "content": "export const a = 1;", "snippet": "export const a = 1;",
                "total_lines": 1, "status": "success", "start_time": 1779240560100i64, "finish_time": 1779240560200i64
            }},
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "SEARCH", "timestamp": 1779240560300i64, "content": {
                "queries": ["loongsuite pilot"], "search_type": "web", "results": [{ "title": "result-1" }],
                "status": "success", "start_time": 1779240560300i64, "finish_time": 1779240560400i64
            }},
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "DIRECTORY_LIST", "timestamp": 1779240560500i64, "content": {
                "path": "/repo/src", "files": ["index.ts", "utils.ts"], "total_count": 2,
                "status": "success", "start_time": 1779240560500i64, "finish_time": 1779240560600i64
            }},
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "SKILL", "timestamp": 1779240560700i64, "content": {
                "skill_name": "search_skills", "purpose": "find relevant skill", "output": "skill-output",
                "status": "success", "start_time": 1779240560700i64, "finish_time": 1779240560800i64
            }},
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "ARTIFACT", "timestamp": 1779240560900i64, "content": {
                "artifactsMetadata": [{ "id": "artifact-1", "name": "report.md" }], "generatedAt": 1779240560900i64,
                "start_time": 1779240560900i64, "finish_time": 1779240561000i64
            }},
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "FILE_WRITE", "timestamp": 1779240561100i64, "content": {
                "file_path": "/repo/src/new-file.ts", "status": "done",
                "start_time": 1779240561100i64, "finish_time": 1779240561200i64
            }},
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Done.", "messageId": "text-2", "timestamp": 1779240561300i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240561400i64 },
            { "type": "RUN_FINISHED", "runId": "run-act-2", "threadId": "sess-1", "timestamp": 1779240561400i64 }
        ]),
        "msg-activity-2",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        tool_named(&rows, "tool.call", "file_read")["gen_ai.tool.call.arguments"],
        json!({ "path": "/repo/src/index.ts" })
    );
    assert_eq!(
        tool_named(&rows, "tool.result", "file_read")["gen_ai.tool.call.result"],
        json!({ "content": "export const a = 1;", "snippet": "export const a = 1;", "total_lines": 1, "status": "success" })
    );
    assert_eq!(
        tool_named(&rows, "tool.call", "search")["gen_ai.tool.call.arguments"],
        json!({ "queries": ["loongsuite pilot"], "search_type": "web" })
    );
    assert_eq!(
        tool_named(&rows, "tool.result", "search")["gen_ai.tool.call.result"],
        json!({ "results": [{ "title": "result-1" }], "status": "success" })
    );
    assert_eq!(
        tool_named(&rows, "tool.result", "directory_list")["gen_ai.tool.call.result"],
        json!({ "files": ["index.ts", "utils.ts"], "total_count": 2, "status": "success" })
    );
    assert_eq!(
        tool_named(&rows, "tool.call", "skill")["gen_ai.tool.call.arguments"],
        json!({ "skill_name": "search_skills", "purpose": "find relevant skill" })
    );
    assert_eq!(
        tool_named(&rows, "tool.result", "skill")["gen_ai.tool.call.result"],
        json!({ "output": "skill-output", "status": "success" })
    );
    assert!(tool_named(&rows, "tool.call", "artifact")
        .get("gen_ai.tool.call.arguments")
        .is_none());
    assert_eq!(
        tool_named(&rows, "tool.result", "artifact")["gen_ai.tool.call.result"],
        json!({ "artifactsMetadata": [{ "id": "artifact-1", "name": "report.md" }], "generatedAt": 1779240560900i64 })
    );
    assert_eq!(
        tool_named(&rows, "tool.call", "file_write")["gen_ai.tool.call.arguments"],
        json!({ "path": "/repo/src/new-file.ts" })
    );
}

#[tokio::test]
async fn omits_null_activity_arguments_and_marks_failed_snapshots() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-act-failure", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "FILE_WRITE", "timestamp": 1779240560100i64, "content": {
                "file_path": null, "status": "done", "start_time": 1779240560100i64, "finish_time": 1779240560200i64
            }},
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "FILE_READ", "timestamp": 1779240560300i64, "content": {
                "path": "/missing.ts", "status": "failed", "error_message": "file not found",
                "start_time": 1779240560300i64, "finish_time": 1779240560400i64
            }},
            { "type": "ACTIVITY_SNAPSHOT", "activityType": "SKILL", "timestamp": 1779240560500i64, "content": {
                "skill_name": "missing_skill", "status": "error", "error_message": "skill failed",
                "start_time": 1779240560500i64, "finish_time": 1779240560600i64
            }},
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Done.", "messageId": "text-3", "timestamp": 1779240560700i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "timestamp": 1779240560800i64 },
            { "type": "RUN_FINISHED", "runId": "run-act-failure", "threadId": "sess-1", "timestamp": 1779240560800i64 }
        ]),
        "msg-activity-failure",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert!(tool_named(&rows, "tool.call", "file_write")
        .get("gen_ai.tool.call.arguments")
        .is_none());
    let file_read = tool_named(&rows, "tool.result", "file_read");
    assert_eq!(file_read["tool.result.status"], "failure");
    assert_eq!(file_read["error.type"], "_OTHER");
    assert_eq!(file_read["error.message"], "file not found");
    assert_eq!(
        file_read["gen_ai.tool.call.result"],
        json!({ "status": "failed", "error_message": "file not found" })
    );
    let skill = tool_named(&rows, "tool.result", "skill");
    assert_eq!(skill["tool.result.status"], "failure");
    assert_eq!(skill["error.type"], "_OTHER");
    assert_eq!(skill["error.message"], "skill failed");
}

#[tokio::test]
async fn generates_trace_id_and_span_id() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(sample_messages())).await;
    let resp = named(&rows, "llm.response");
    let trace = resp["trace_id"].as_str().unwrap_or("");
    let span = resp["span_id"].as_str().unwrap_or("");
    let parent = resp["parent_span_id"].as_str().unwrap_or("");
    assert!(
        trace.len() == 32
            && trace
                .chars()
                .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
    );
    assert!(
        span.len() == 16
            && span
                .chars()
                .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
    );
    assert!(
        parent.len() == 16
            && parent
                .chars()
                .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
    );
}

#[tokio::test]
async fn does_not_process_incomplete_assistant_messages() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-inc", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Still thinking...", "messageId": "text-1", "timestamp": 1779240560100i64 }
        ]),
        "msg-incomplete",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert!(rows.is_empty());
    assert!(
        seen(&harness.extra(), "sess-1").is_none() || is_num(seen(&harness.extra(), "sess-1"), 0)
    );
}

#[tokio::test]
async fn processes_incomplete_message_once_it_becomes_complete() {
    let incomplete = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-s", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Thinking...", "messageId": "text-1", "timestamp": 1779240560100i64 }
        ]),
        "msg-stream",
        1779240560000,
        1,
    );
    let complete = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-s", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Thinking...", "messageId": "text-1", "timestamp": 1779240560100i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": " Done!", "messageId": "text-1", "timestamp": 1779240560200i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "timestamp": 1779240560300i64 },
            { "type": "RUN_FINISHED", "runId": "run-s", "threadId": "sess-1", "timestamp": 1779240560300i64 }
        ]),
        "msg-stream",
        1779240560000,
        1,
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_cb = Arc::clone(&calls);
    let runner = super::scripted(move |args| {
        let joined = args.join(" ");
        if joined.contains("list_tasks") {
            return out(list_body(json!([sample_task()])));
        }
        if joined.contains("get_spark_agui_messages") {
            let n = calls_cb.fetch_add(1, Ordering::SeqCst);
            let body = if n == 0 {
                incomplete.clone()
            } else {
                complete.clone()
            };
            return out(messages_body(body));
        }
        Err(format!("unexpected: {joined}"))
    });
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let first = harness.run(Arc::clone(&runner)).await;
    assert!(first.is_empty());
    assert!(
        seen(&harness.extra(), "sess-1").is_none() || is_num(seen(&harness.extra(), "sess-1"), 0)
    );
    let second = harness.run(runner).await;
    let resp = named(&second, "llm.response");
    assert_eq!(resp["gen_ai.usage.input_tokens"], 100);
    assert_eq!(resp["gen_ai.usage.output_tokens"], 20);
    assert_eq!(
        resp["gen_ai.output.messages"],
        json!([{ "role": "assistant", "parts": [{ "type": "text", "content": "Thinking... Done!" }] }])
    );
}

#[tokio::test]
async fn sets_tool_name_on_result_from_tool_call_start() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-tn", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-tn", "toolName": "web_search", "timestamp": 1779240560100i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-tn", "result": "found", "timestamp": 1779240560500i64 },
            { "type": "USAGE", "prompt_tokens": 50, "completion_tokens": 5, "total_tokens": 55, "timestamp": 1779240560600i64 },
            { "type": "RUN_FINISHED", "runId": "run-tn", "threadId": "sess-1", "timestamp": 1779240560600i64 }
        ]),
        "msg-tn",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    assert_eq!(
        named(&rows, "tool.result")["gen_ai.tool.name"],
        "web_search"
    );
}

#[tokio::test]
async fn emits_llm_response_for_run_error_only_turn() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-eo", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "RUN_ERROR", "code": "CANCELLED", "message": "任务被取消", "runId": "run-eo", "timestamp": 1779240560100i64 },
            { "type": "RUN_FINISHED", "runId": "run-eo", "threadId": "sess-1", "timestamp": 1779240560100i64 }
        ]),
        "msg-erronly",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let resp = named(&rows, "llm.response");
    assert_eq!(resp["gen_ai.response.finish_reasons"], json!(["stop"]));
    assert_eq!(resp["error.type"], "CANCELLED");
    assert_eq!(resp["error.message"], "任务被取消");
}

#[tokio::test]
async fn handles_null_metadata() {
    let mut task = sample_task();
    task["metadata"] = Value::Null;
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness
        .run(routes(
            list_body(json!([task])),
            messages_body(sample_messages()),
        ))
        .await;
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.request.model"],
        "unknown"
    );
}

#[tokio::test]
async fn sanitizes_invalid_event_timestamps() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-bad", "threadId": "sess-1", "timestamp": "not-a-number" },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "hi", "messageId": "text-1", "timestamp": null },
            { "type": "USAGE", "prompt_tokens": 50, "completion_tokens": 5, "total_tokens": 55, "timestamp": 1779240560700i64 },
            { "type": "RUN_FINISHED", "runId": "run-bad", "threadId": "sess-1" }
        ]),
        "msg-bad-ts",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let nanos = named(&rows, "llm.response")["time_unix_nano"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(!nanos.contains("NaN"));
    assert!(nanos.parse::<f64>().unwrap().is_finite());
}

#[tokio::test]
async fn step_finished_captures_per_step_usage() {
    let messages = pair(
        json!([
            { "type": "RUN_STARTED", "runId": "run-ms", "threadId": "sess-1", "timestamp": 1779240560000i64 },
            { "type": "STEP_STARTED", "messageId": "step-1", "stepName": "Search", "timestamp": 1779240560010i64 },
            { "type": "TOOL_CALL_START", "toolCallId": "tc-1", "toolName": "search", "timestamp": 1779240560020i64 },
            { "type": "TOOL_CALL_END", "toolCallId": "tc-1", "toolName": "search", "result": "data", "timestamp": 1779240560100i64 },
            { "type": "USAGE", "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "timestamp": 1779240560110i64 },
            { "type": "STEP_FINISHED", "messageId": "step-1", "timestamp": 1779240560120i64 },
            { "type": "STEP_STARTED", "messageId": "step-2", "stepName": "Answer", "timestamp": 1779240560200i64 },
            { "type": "TEXT_MESSAGE_CONTENT", "delta": "Final answer", "messageId": "text-1", "timestamp": 1779240560300i64 },
            { "type": "USAGE", "prompt_tokens": 250, "completion_tokens": 50, "total_tokens": 300, "timestamp": 1779240560400i64 },
            { "type": "STEP_FINISHED", "messageId": "step-2", "timestamp": 1779240560400i64 },
            { "type": "RUN_FINISHED", "runId": "run-ms", "threadId": "sess-1", "timestamp": 1779240560500i64 }
        ]),
        "msg-multistep",
        1779240560000,
        1,
    );
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(standard_runner(messages)).await;
    let responses = all_named(&rows, "llm.response");
    assert_eq!(responses.len(), 2);
    let s1 = responses
        .iter()
        .find(|row| row["gen_ai.step.id"] == "sess-1:t1:s1")
        .expect("s1");
    let s2 = responses
        .iter()
        .find(|row| row["gen_ai.step.id"] == "sess-1:t1:s2")
        .expect("s2");
    assert_eq!(s1["gen_ai.usage.input_tokens"], 100);
    assert_eq!(s1["gen_ai.usage.output_tokens"], 20);
    assert_eq!(s2["gen_ai.usage.input_tokens"], 250);
    assert_eq!(s2["gen_ai.usage.output_tokens"], 50);
    assert_eq!(s1["gen_ai.response.finish_reasons"], json!(["tool_calls"]));
    assert_eq!(s2["gen_ai.response.finish_reasons"], json!(["end_turn"]));
}

#[tokio::test]
async fn filters_tasks_with_null_session_id() {
    let null_task = json!({
        "id": "task-null", "session_id": null, "status": "failed",
        "name": "bad", "agent_type": "spark", "metadata": {}
    });
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_cb = Arc::clone(&calls);
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness
        .run(super::scripted(move |args| {
            let joined = args.join(" ");
            if joined.contains("list_tasks") {
                return out(list_body(json!([sample_task(), null_task.clone()])));
            }
            if joined.contains("get_spark_agui_messages") {
                calls_cb.lock().expect("calls").push(conversation_arg(args));
                return out(messages_body(sample_messages()));
            }
            Err(format!("unexpected: {joined}"))
        }))
        .await;
    let sessions: HashSet<_> = rows
        .iter()
        .filter_map(|row| row.get("gen_ai.session.id").and_then(Value::as_str))
        .collect();
    assert!(sessions.contains("sess-1"));
    assert_eq!(calls.lock().expect("calls").as_slice(), ["sess-1"]);
}

#[tokio::test]
async fn handles_empty_stdout_from_get_messages() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness
        .run(super::scripted(|args| {
            let joined = args.join(" ");
            if joined.contains("list_tasks") {
                return out(list_body(json!([sample_task()])));
            }
            if joined.contains("get_spark_agui_messages") {
                return out("");
            }
            Err(format!("unexpected: {joined}"))
        }))
        .await;
    assert!(rows.is_empty());
}

#[tokio::test]
async fn handles_whitespace_stdout_from_get_messages() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness
        .run(super::scripted(|args| {
            let joined = args.join(" ");
            if joined.contains("list_tasks") {
                return out(list_body(json!([sample_task()])));
            }
            if joined.contains("get_spark_agui_messages") {
                return out("  \n  ");
            }
            Err(format!("unexpected: {joined}"))
        }))
        .await;
    assert!(rows.is_empty());
}

#[tokio::test]
async fn handles_empty_stdout_from_list_tasks() {
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let rows = harness.run(super::scripted(|_args| out(""))).await;
    assert!(rows.is_empty());
}

#[tokio::test]
async fn prunes_seen_counts_after_stale_threshold() {
    let harness = Harness::new();
    harness.seed(json!({
        "seenCounts": { "sess-1": 2, "stale-sess": 10 },
        "staleCounters": { "stale-sess": 4 }
    }));
    let _rows = harness.run(standard_runner(sample_messages())).await;
    let extra = harness.extra();
    assert!(seen(&extra, "stale-sess").is_none());
    assert!(stale(&extra, "stale-sess").is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn collects_through_a_real_cli_script() {
    let dir = tempfile::tempdir().expect("temp");
    let list_path = dir.path().join("list.json");
    let msg_path = dir.path().join("messages.json");
    std::fs::write(&list_path, list_body(json!([sample_task()]))).unwrap();
    std::fs::write(&msg_path, messages_body(sample_messages())).unwrap();
    let script = format!(
        "#!/bin/sh\ncase \"$*\" in\n*list_tasks*)\ncat '{}'\n;;\n*get_spark_agui_messages*)\ncat '{}'\n;;\n*)\necho unexpected >&2\nexit 1\n;;\nesac\n",
        list_path.display(),
        msg_path.display()
    );
    let cli = dir.path().join("wukong-cli");
    std::fs::write(&cli, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&cli).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&cli, perms).unwrap();
    }
    let harness = Harness::new();
    harness.seed(json!({ "seenCounts": {} }));
    let input = WukongInput::new(WukongInputOptions {
        state_store: Arc::clone(&harness.store),
        poll_interval_ms: Some(60_000),
        cli_path: Some(cli.to_string_lossy().into_owned()),
    });
    let got = Arc::new(Mutex::new(Vec::<AgentActivityEntry>::new()));
    let slot = Arc::clone(&got);
    input.on_entries(move |batch| {
        slot.lock().expect("entries").extend(batch.iter().cloned());
    });
    input.start().await.expect("start");
    input.stop().await.expect("stop");
    let rows: Vec<Value> = got
        .lock()
        .expect("entries")
        .iter()
        .map(entry_json)
        .collect();
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.usage.input_tokens"],
        100
    );
}

#[cfg(unix)]
fn write_cli(dir: &Path, body: &str) {
    let path = dir.join("wukong-cli");
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
    }
}

#[tokio::test]
async fn check_availability_is_false_when_socket_is_missing() {
    let home = tempfile::tempdir().expect("home");
    let runner = super::scripted(|_| panic!("missing socket must not invoke CLI"));
    assert!(
        !super::check_availability_at(
            &home.path().join(".real").join("daemon.sock"),
            runner.as_ref()
        )
        .await
    );
}

#[tokio::test]
async fn check_availability_is_false_when_status_fails() {
    let home = tempfile::tempdir().expect("home");
    let sock = home.path().join("daemon.sock");
    std::fs::write(&sock, b"").unwrap();
    let runner = super::scripted(|args| {
        assert_eq!(args, ["service", "status"]);
        Err("connection refused".into())
    });
    assert!(!super::check_availability_at(&sock, runner.as_ref()).await);
}

#[tokio::test]
async fn check_availability_is_true_when_service_is_running() {
    let home = tempfile::tempdir().expect("home");
    let sock = home.path().join("daemon.sock");
    std::fs::write(&sock, b"").unwrap();
    let runner = super::scripted(|args| {
        assert_eq!(args, ["service", "status"]);
        out("Service is running")
    });
    assert!(super::check_availability_at(&sock, runner.as_ref()).await);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn public_availability_resolves_default_socket_and_invokes_real_cli() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let home = tempfile::tempdir().expect("home");
    let bin = tempfile::tempdir().expect("bin");
    std::fs::create_dir_all(home.path().join(".real")).unwrap();
    std::fs::write(home.path().join(".real/daemon.sock"), b"").unwrap();
    let path = format!(
        "{}:{}",
        bin.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let _home = EnvVarGuard::set("HOME", &home.path().to_string_lossy());
    let _path = EnvVarGuard::set("PATH", &path);
    write_cli(
        bin.path(),
        "#!/bin/sh\n[ \"$1\" = service ] && [ \"$2\" = status ] || exit 7\necho 'Service is running'\n",
    );
    assert!(WukongInput::check_availability().await);
    write_cli(
        bin.path(),
        "#!/bin/sh\necho connection refused >&2\nexit 1\n",
    );
    assert!(!WukongInput::check_availability().await);
}
