//! Exact main standard-event content/identity boundary across real native
//! transcript facts, current restoration policy, JSONL, HTTP, and SLS serializer.
//! SLS AK SDK poster is observed at the same boundary mocked by upstream.
use async_trait::async_trait;
use loongsuite_pilot::{
    checkpoints::StateStore,
    core::InputManager,
    flushers::{
        AkPoster, BaseFlusher, HttpFlusher, JsonlFlusher, ReqwestSlsHttp, SendError, SlsFlusher,
        SlsLogGroupPayload,
    },
    inputs::codex_transcript::{CodexTranscriptInput, CodexTranscriptInputOptions},
    normalization::expand_agent_input_events,
    types::{AgentActivityEntry, AgentsConfig, SlsEndpoint},
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const RELATIONS: &[&str] = &[
    "gen_ai.session.id",
    "gen_ai.turn.id",
    "gen_ai.step.id",
    "gen_ai.agent.id",
    "gen_ai.agent.parent.id",
    "gen_ai.agent.peer.id",
    "gen_ai.agent.peer.name",
    "gen_ai.agent.invocation.id",
    "gen_ai.agent.parent.invocation.id",
    "gen_ai.tool.call.id",
    "trace_id",
    "span_id",
    "parent_span_id",
];
const CONTENT: &[&str] = &[
    "gen_ai.input.messages",
    "gen_ai.input.messages_delta",
    "gen_ai.output.messages",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.system_instructions",
    "gen_ai.tool.definitions",
];
const NAMES: &[&str] = &[
    "llm.request",
    "llm.response",
    "tool.call",
    "tool.result",
    "gen_ai.model.request",
    "gen_ai.model.response",
    "gen_ai.tool.call",
    "gen_ai.tool.result",
];
#[derive(Default)]
struct Poster(Mutex<Vec<(String, SlsLogGroupPayload)>>);
#[async_trait]
impl AkPoster for Poster {
    async fn post_log_store_logs(
        &self,
        _: &SlsEndpoint,
        project: &str,
        logstore: &str,
        group: &SlsLogGroupPayload,
        _: &str,
    ) -> Result<(), SendError> {
        assert_eq!(project, "test-project");
        self.0
            .lock()
            .unwrap()
            .push((logstore.into(), group.clone()));
        Ok(())
    }
}
async fn native(root: &Path) -> Vec<AgentActivityEntry> {
    let sessions = root.join("sessions");
    let wakes = root.join("wakeups");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&wakes).unwrap();
    let input = CodexTranscriptInput::new(CodexTranscriptInputOptions {
        state_store: Arc::new(StateStore::new(root.join("native-state.json"))),
        session_dir: Some(sessions.to_string_lossy().into_owned()),
        wakeup_dir: Some(wakes.to_string_lossy().into_owned()),
        span_context_dir: Some(root.join("contexts").to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
        multimodal: None,
    });
    let rows = Arc::new(Mutex::new(Vec::new()));
    let capture = rows.clone();
    input.on_entries(move |batch| capture.lock().unwrap().extend_from_slice(batch));
    input.start().await.unwrap();
    input.run_cycle().await;
    let records = [
        (
            "session_meta",
            json!({"id":"native-parent","timestamp":"2026-08-07T02:00:00Z","model_provider":"openai"}),
        ),
        (
            "turn_context",
            json!({"turn_id":"native-turn","model":"gpt-test"}),
        ),
        (
            "event_msg",
            json!({"type":"task_started","turn_id":"native-turn"}),
        ),
        (
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"parent input"}]}),
        ),
        (
            "response_item",
            json!({"type":"function_call","call_id":"spawn-batch","name":"spawn_agent","arguments":json!({"agents":[{"message":"task A"},{"prompt":"task B"}]}).to_string()}),
        ),
        (
            "response_item",
            json!({"type":"function_call_output","call_id":"spawn-batch","output":json!({"agents":[{"agent_id":"child-A","nickname":"Newton"},{"agent_id":"child-B","nickname":"Curie"}]}).to_string()}),
        ),
        (
            "response_item",
            json!({"type":"function_call","call_id":"wait-batch","name":"wait","arguments":json!({"ids":["child-A","child-B"]}).to_string()}),
        ),
        (
            "response_item",
            json!({"type":"function_call_output","call_id":"wait-batch","output":json!({"status":{"child-A":{"completed":"result A"},"child-B":{"completed":"result B"}}}).to_string()}),
        ),
        (
            "event_msg",
            json!({"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}),
        ),
        (
            "event_msg",
            json!({"type":"task_complete","turn_id":"native-turn","last_agent_message":"done"}),
        ),
    ];
    let epoch = chrono::DateTime::parse_from_rfc3339("2026-08-07T02:00:00Z")
        .unwrap()
        .timestamp_millis();
    let transcript = sessions.join("rollout-parent.jsonl");
    let text = records
        .into_iter()
        .enumerate()
        .map(|(i, (kind, payload))| {
            let ts = chrono::DateTime::from_timestamp_millis(epoch + i as i64 * 1000)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            json!({"timestamp":ts,"type":kind,"payload":payload}).to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&transcript, text).unwrap();
    std::fs::write(wakes.join("native-parent.json"),json!({
  "session_id":"native-parent","turn_id":"native-turn","initial_turn_id":"native-turn","transcript_path":transcript,
  "hook_event":"stop","received_at":chrono::Utc::now().to_rfc3339()
 }).to_string()).unwrap();
    input.run_cycle().await;
    input.stop().await.unwrap();
    let audit: Vec<_> = rows
        .lock()
        .unwrap()
        .iter()
        .filter(|e| {
            e.event_name.is_some_and(|n| {
                matches!(n.as_str(), "gen_ai.agent.invoke" | "gen_ai.agent.result")
            })
        })
        .cloned()
        .collect();
    let values: Vec<Value> = audit
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    assert_eq!(
        values
            .iter()
            .map(|r| r["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "gen_ai.agent.invoke",
            "gen_ai.agent.invoke",
            "gen_ai.agent.result",
            "gen_ai.agent.result"
        ]
    );
    for (i, row) in values.iter().enumerate() {
        let (field, role, text) = if i < 2 {
            ("gen_ai.input.messages", "user", ["task A", "task B"][i])
        } else {
            (
                "gen_ai.output.messages",
                "assistant",
                ["result A", "result B"][i - 2],
            )
        };
        assert!(row[field] == json!([{"role":role,"parts":[{"type":"text","content":text}]}]));
        assert_eq!(
            row["gen_ai.agent.peer.name"],
            ["Newton", "Curie", "Newton", "Curie"][i]
        );
        assert!(row.get("gen_ai.tool.call.arguments").is_none());
    }
    audit
}
struct Receiver {
    url: String,
    task: tokio::task::JoinHandle<Value>,
}
impl Receiver {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/events", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            let end = loop {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                assert!(bytes.len() <= 1048576);
                if let Some(i) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let length: usize = headers
                .lines()
                .find_map(|s| s.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            while bytes.len() < end + length {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                assert!(bytes.len() <= 1048576);
            }
            let body: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
            body
        });
        Self { url, task }
    }
}
fn raw(index: usize, name: &str) -> AgentActivityEntry {
    serde_json::from_value(json!({
 "gen_ai.session.id":"child-session","gen_ai.turn.id":"child-turn","gen_ai.step.id":"child-step",
 "gen_ai.agent.id":"child-agent","gen_ai.agent.parent.id":"parent-agent",
 "gen_ai.agent.peer.id":"grandchild-agent","gen_ai.agent.peer.name":"Grandchild",
 "gen_ai.agent.invocation.id":"outgoing-work","gen_ai.agent.parent.invocation.id":"incoming-work",
 "gen_ai.tool.call.id":"native-tool-call","trace_id":"a".repeat(32),"span_id":"b".repeat(16),"parent_span_id":"c".repeat(16),
 "event.name":name,"event.id":format!("codex-event-{index}"),"time_unix_nano":"1700000000000000000",
 "user.id":"test-user","gen_ai.agent.type":"codex",
 "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"prompt"}]}],
 "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"prompt"}]}],
 "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"result"}]}],
 "gen_ai.tool.call.arguments":{"prompt":"delegated task"},"gen_ai.tool.call.result":{"output":"delegated result"},
 "gen_ai.system_instructions":[{"type":"text","content":"instructions"}],
 "gen_ai.tool.definitions":[{"type":"function","name":"spawn_agent"}]
 })).unwrap()
}
fn string_log(group: &SlsLogGroupPayload) -> Vec<Value> {
    group.logs.iter().map(|r| json!(r.content)).collect()
}
fn identities(logs: &[Value], entries: &[Value]) {
    assert_eq!(logs.len(), entries.len());
    let ids: std::collections::BTreeSet<_> = logs
        .iter()
        .map(|r| r["event.id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), logs.len());
    for (log, entry) in logs.iter().zip(entries) {
        for key in ["event.name", "event.id"] {
            assert!(log[key] == entry[key], "{key}");
        }
        for field in RELATIONS {
            let expected = entry.get(*field);
            let actual = log.get(*field);
            assert!(actual == expected, "relation {field}");
        }
    }
}
async fn scenario(legacy: bool) {
    let root = tempfile::tempdir().unwrap();
    let receiver = Receiver::new().await;
    let jsonl = JsonlFlusher::new(
        serde_json::from_value(
            json!({"enabled":true,"outputDir":root.path(),"rotateDaily":false,"maxFileSizeMb":100}),
        )
        .unwrap(),
    );
    let http=HttpFlusher::new(serde_json::from_value(json!({"enabled":true,"url":receiver.url,"batchMaxSize":100,"flushIntervalMs":60000,"requestTimeoutMs":5000})).unwrap());
    let poster = Arc::new(Poster::default());
    let sls=SlsFlusher::with_io(serde_json::from_value(json!({
  "enabled":true,"mode":"ak","endpoint":"https://example.invalid","accessKeyId":"","accessKeySecret":"","apiKey":"","serviceNamePrefix":"","batchMaxSize":100,"flushIntervalMs":60000,
  "endpoints":[
   {"name":"activity","endpoint":"https://example.invalid","project":"test-project","logstore":"activity","kind":"agentActivity","mode":"ak","redact":false},
   {"name":"redacted","endpoint":"https://example.invalid","project":"test-project","logstore":"redacted","kind":"agentActivity","mode":"ak","redact":true}
  ]
 })).unwrap(),root.path().to_str().unwrap(),Some("test-build".into()),Arc::new(ReqwestSlsHttp::new()),poster.clone());
    jsonl.start().await.unwrap();
    let native = native(root.path()).await;
    let mut rows: Vec<_> = NAMES.iter().enumerate().map(|(i, n)| raw(i, n)).collect();
    rows.extend(native.clone());
    let manager = InputManager::new();
    let agents: AgentsConfig =
        serde_json::from_value(json!({"codex":{"captureMessageContent":legacy}})).unwrap();
    manager.set_agents_config(&agents);
    let entries = manager.prepare_restored_entries(rows.clone());
    for field in CONTENT {
        assert!(
            serde_json::to_value(&entries[0]).unwrap()[*field]
                == serde_json::to_value(&rows[0]).unwrap()[*field],
            "{field}"
        );
    }
    let output = expand_agent_input_events(entries.clone());
    assert_eq!(output.len(), entries.len());
    jsonl.send_batch(output.clone(), None).await.unwrap();
    http.send_batch(output.clone(), None).await.unwrap();
    sls.send_batch(output, None).await.unwrap();
    http.flush().await.unwrap();
    sls.flush().await.unwrap();
    let json_logs: Vec<Value> = std::fs::read_to_string(root.path().join("codex-all.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let received = receiver.task.await.unwrap();
    let http_logs = received["entries"].as_array().unwrap();
    let post = poster.0.lock().unwrap().clone();
    assert_eq!(post.len(), 2);
    let prepared: Vec<Value> = entries
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    identities(&json_logs, &prepared);
    identities(http_logs, &prepared);
    for (_, group) in &post {
        identities(&string_log(group), &prepared);
    }
    let activity = &post.iter().find(|(name, _)| name == "activity").unwrap().1;
    let redacted = &post.iter().find(|(name, _)| name == "redacted").unwrap().1;
    for field in CONTENT {
        assert!(json_logs[0][*field] == prepared[0][*field], "{field}");
        let decoded: Value = serde_json::from_str(http_logs[0][*field].as_str().unwrap()).unwrap();
        assert!(decoded == prepared[0][*field], "{field}");
        let decoded: Value = serde_json::from_str(&activity.logs[0].content[*field]).unwrap();
        assert!(decoded == prepared[0][*field], "{field}");
    }
    for entry in native {
        let index = entries
            .iter()
            .position(|e| e.event_id == entry.event_id)
            .unwrap();
        let field = if serde_json::to_value(&entry).unwrap()["event.name"] == "gen_ai.agent.invoke"
        {
            "gen_ai.input.messages"
        } else {
            "gen_ai.output.messages"
        };
        let value = serde_json::to_value(entry).unwrap();
        assert!(json_logs[index][field] == value[field]);
        assert!(
            serde_json::from_str::<Value>(http_logs[index][field].as_str().unwrap()).unwrap()
                == value[field]
        );
        assert!(
            serde_json::from_str::<Value>(&activity.logs[index].content[field]).unwrap()
                == value[field]
        );
    }
    for log in &redacted.logs {
        for field in [
            "gen_ai.input.messages",
            "gen_ai.tool.call.arguments",
            "gen_ai.tool.call.result",
        ] {
            assert!(!log.content.contains_key(field));
        }
    }
    jsonl.shutdown().await.unwrap();
    http.shutdown().await.unwrap();
    sls.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_codex_all_eight_standard_and_legacy_names_and_four_native_agent_facts_keep_exact_content_and_identity_on_jsonl_http_and_two_sls_routes(
) {
    for legacy in [true, false] {
        tokio::time::timeout(Duration::from_secs(15), scenario(legacy))
            .await
            .expect("original project15s per legacy-content parameter");
    }
}
