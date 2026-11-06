//! Synthetic native rollouts through the real Input/Manager/Multi/JSONL/OTLP
//! lifecycle. Capture exporter replaces only the wire, covered separately.
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{
    BaseFlusher, CodexTurnJournal, JsonlFlusher, MultiFlusher, OtlpTraceFlusher, ReadableSpan,
    TraceExporter,
};
use loongsuite_pilot::inputs::codex_transcript::{
    CodexTranscriptInput, CodexTranscriptInputOptions,
};
use loongsuite_pilot::types::{AgentActivityEntry, JsonlFlusherConfig};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PEER: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GRANDCHILD: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

fn at(second: f64) -> String {
    (chrono::DateTime::parse_from_rfc3339("2026-08-07T02:00:00Z").unwrap()
        + chrono::Duration::milliseconds((second * 1000.0).round() as i64))
    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn record(second: f64, kind: &str, payload: Value) -> String {
    json!({"timestamp":at(second),"type":kind,"payload":payload}).to_string()
}
fn metadata(session: &str, second: f64, parent: Option<&str>, depth: usize) -> String {
    let mut payload =
        json!({"id":session,"session_id":PARENT,"timestamp":at(second),"model_provider":"openai"});
    if let Some(parent) = parent {
        payload["thread_source"] = json!("subagent");
        payload["source"] =
            json!({"subagent":{"thread_spawn":{"parent_thread_id":parent,"depth":depth}}});
    } else {
        payload["thread_source"] = json!("user");
    }
    record(second, "session_meta", payload)
}
fn begin(turn: &str, second: f64, prompt: &str, delegated: bool) -> Vec<String> {
    vec![
        record(
            second,
            "turn_context",
            json!({"turn_id":turn,"model":"gpt-test"}),
        ),
        record(
            second + 0.01,
            "event_msg",
            json!({"type":"task_started","turn_id":turn}),
        ),
        record(
            second + 0.02,
            "response_item",
            if delegated {
                json!({"type":"agent_message","author":"/root","recipient":"/root/fixture",
                "internal_chat_message_metadata_passthrough":{"turn_id":turn},
                "content":[{"type":"input_text","text":prompt}]})
            } else {
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":prompt}]})
            },
        ),
    ]
}
fn token(second: f64, input: u64, output: u64) -> String {
    record(
        second,
        "event_msg",
        json!({"type":"token_count","info":{"last_token_usage":{
            "input_tokens":input,"output_tokens":output,"total_tokens":input+output,"cached_input_tokens":0
        }}}),
    )
}
fn end(turn: &str, second: f64) -> Vec<String> {
    vec![
        record(
            second,
            "event_msg",
            json!({"type":"agent_message","message":"fixture-result","phase":"final"}),
        ),
        token(second + 0.01, 11, 7),
        record(
            second + 0.02,
            "event_msg",
            json!({"type":"task_complete","turn_id":turn,"last_agent_message":"fixture-result"}),
        ),
    ]
}
fn work(turn: &str, second: f64, prompt: &str) -> Vec<String> {
    let mut records = begin(turn, second, prompt, true);
    records.extend(end(turn, second + 1.0));
    records
}
fn dispatch(call: &str, child: &str, second: f64, prompt: &str, name: &str) -> Vec<String> {
    vec![
        record(
            second,
            "response_item",
            json!({"type":"function_call","call_id":call,"name":name,
            "arguments":if name == "spawn_agent" { json!({"message":prompt}) } else { json!({"target":child,"message":prompt}) }.to_string()}),
        ),
        record(
            second + 0.01,
            "response_item",
            json!({"type":"function_call_output","call_id":call,
            "output":json!({"agent_id":child,"nickname":"Fixture"}).to_string()}),
        ),
    ]
}
fn tool(second: f64, call: &str) -> Vec<String> {
    vec![
        record(
            second,
            "response_item",
            json!({"type":"function_call","call_id":call,"name":"exec_command","arguments":r#"{"cmd":"pwd"}"#}),
        ),
        record(
            second + 1.0,
            "response_item",
            json!({"type":"function_call_output","call_id":call,"output":r#""/tmp/project""#}),
        ),
    ]
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(4), future)
        .await
        .expect("native subagent lifecycle did not settle")
}
struct Capture(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
struct Running {
    state: Arc<StateStore>,
    manager: Arc<InputManager>,
    input: Arc<CodexTranscriptInput>,
    trace: Arc<OtlpTraceFlusher>,
    jsonl: Arc<JsonlFlusher>,
}
struct Harness {
    root: tempfile::TempDir,
    spans: Arc<Mutex<Vec<ReadableSpan>>>,
    emitted: Arc<Mutex<Vec<AgentActivityEntry>>>,
    running: Option<Running>,
    current_privacy: bool,
    wire_endpoint: Option<String>,
}
type NativeExporterFactory =
    Arc<dyn Fn(loongsuite_pilot::flushers::ExporterOpts) -> Arc<dyn TraceExporter> + Send + Sync>;
impl Harness {
    async fn new() -> Self {
        Self::with_wire_endpoint(None).await
    }
    async fn with_wire_endpoint(wire_endpoint: Option<String>) -> Self {
        let mut harness = Self {
            root: tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap())
                .unwrap(),
            spans: Arc::new(Mutex::new(Vec::new())),
            emitted: Arc::new(Mutex::new(Vec::new())),
            running: None,
            current_privacy: false,
            wire_endpoint,
        };
        tokio::fs::create_dir(harness.root.path().join("sessions"))
            .await
            .unwrap();
        harness.start().await;
        harness
    }
    async fn start(&mut self) {
        assert!(self.running.is_none());
        let root = self.root.path();
        let state = Arc::new(StateStore::new(root.join("state.json")));
        state.load().await;
        let manager = Arc::new(InputManager::new());
        manager.set_state_store(Arc::clone(&state));
        manager.set_user_id("synthetic-user");
        if self.current_privacy {
            let legacy: loongsuite_pilot::types::AgentsConfig =
                serde_json::from_value(json!({"codex":{"captureMessageContent":false}})).unwrap();
            manager.set_agents_config(&legacy);
            manager.set_mask_config(loongsuite_pilot::types::MaskConfig {
                mode: loongsuite_pilot::types::MaskMode::All,
                types: Vec::new(),
                replacement_mode: Some(loongsuite_pilot::types::MaskReplacementMode::Placeholder),
            });
            manager.set_workspace_policy(
                loongsuite_pilot::core::WorkspacePolicy::new(
                    &[root
                        .join("excluded-workspace")
                        .to_string_lossy()
                        .into_owned()],
                    None,
                )
                .unwrap(),
            );
        }
        let weak = Arc::downgrade(&manager);
        let capture = Arc::new(Capture(Arc::clone(&self.spans)));
        let factory: Option<NativeExporterFactory> = if self.wire_endpoint.is_some() {
            None
        } else {
            Some(Arc::new(move |_| {
                Arc::clone(&capture) as Arc<dyn TraceExporter>
            }))
        };
        let trace = Arc::new(OtlpTraceFlusher::with_parts(
            serde_json::from_value(json!({
                "enabled":true,"protocol":"http/protobuf","serviceName":"codex-matrix",
                "endpoints":[{"name":"capture","endpoint":self.wire_endpoint.as_deref().unwrap_or("http://127.0.0.1:4318"),"compression":"none"}],
                "dataDir":root,"turnIdleTimeoutMs":0
            })).unwrap(),
            None,
            factory,
            None,
        ).unwrap().with_codex_journal(
            Arc::new(CodexTurnJournal::new(root.join("journal"))),
            move |entries| Ok(weak.upgrade().expect("running manager").prepare_restored_entries(entries)),
        ));
        let jsonl = Arc::new(JsonlFlusher::new(JsonlFlusherConfig {
            enabled: true,
            output_dir: root.join("output").to_string_lossy().into_owned(),
            rotate_daily: false,
            max_file_size_mb: 100.into(),
        }));
        bounded(jsonl.start()).await.unwrap();
        bounded(trace.start()).await.unwrap();
        manager.set_flusher(Arc::new(MultiFlusher::new(vec![
            jsonl.clone(),
            trace.clone(),
        ])));
        let input = Arc::new(CodexTranscriptInput::new(CodexTranscriptInputOptions {
            state_store: Arc::clone(&state),
            session_dir: Some(root.join("sessions").to_string_lossy().into_owned()),
            wakeup_dir: Some(root.join("wakeups").to_string_lossy().into_owned()),
            span_context_dir: Some(root.join("span-contexts").to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
            multimodal: None,
        }));
        let (running, start, stop) = (Arc::clone(&input), Arc::clone(&input), Arc::clone(&input));
        manager.register_input(LiveInput::new(
            "codex-transcript",
            "codex",
            "session-file-polling",
            move || running.collector_running(),
            move || {
                let input = Arc::clone(&start);
                Box::pin(async move { input.start().await })
            },
            move || {
                let input = Arc::clone(&stop);
                Box::pin(async move {
                    input.stop().await.unwrap();
                })
            },
        ));
        let weak = Arc::downgrade(&manager);
        let emitted = Arc::clone(&self.emitted);
        input.on_entries(move |entries| {
            emitted.lock().unwrap().extend_from_slice(entries);
            if let Some(manager) = weak.upgrade() {
                manager.bind_entries("codex-transcript", entries.to_vec());
            }
        });
        bounded(manager.start_input("codex-transcript")).await;
        self.running = Some(Running {
            state,
            manager,
            input,
            trace,
            jsonl,
        });
    }
    async fn stop(&mut self) {
        let Some(running) = self.running.take() else {
            return;
        };
        bounded(running.manager.stop_all()).await;
        bounded(running.state.save()).await.unwrap();
        bounded(running.trace.shutdown()).await.unwrap();
        bounded(running.jsonl.shutdown()).await.unwrap();
    }
    async fn restart(&mut self) {
        self.stop().await;
        self.start().await;
    }
    async fn write(&self, session: &str, records: Vec<String>, initial_turn: Option<&str>) {
        let root = self.root.path();
        let file = root
            .join("sessions")
            .join("2026")
            .join("08")
            .join("07")
            .join(format!("rollout-{session}.jsonl"));
        tokio::fs::create_dir_all(file.parent().unwrap())
            .await
            .unwrap();
        let mut output = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .await
            .unwrap();
        output
            .write_all((records.join("\n") + "\n").as_bytes())
            .await
            .unwrap();
        output.flush().await.unwrap();
        drop(output);
        if let Some(turn) = initial_turn {
            let wakeups = root.join("wakeups");
            tokio::fs::create_dir_all(&wakeups).await.unwrap();
            tokio::fs::write(
                wakeups.join(format!("{session}.json")),
                json!({
                    "session_id":session,"turn_id":turn,"initial_turn_id":turn,
                    "transcript_path":file,"hook_event":"subagent-stop",
                    "received_at":chrono::Utc::now().to_rfc3339()
                })
                .to_string(),
            )
            .await
            .unwrap();
        }
        let running = self.running.as_ref().unwrap();
        bounded(running.input.run_cycle()).await;
        bounded(running.input.run_cycle()).await;
        bounded(running.state.save()).await.unwrap();
    }
    async fn logs(&self) -> Vec<Value> {
        let raw =
            tokio::fs::read_to_string(self.root.path().join("output").join("codex-all.jsonl"))
                .await
                .unwrap();
        raw.lines()
            .filter(|s| !s.is_empty())
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn captured(&self) -> Vec<ReadableSpan> {
        self.spans.lock().unwrap().clone()
    }
    async fn pending(&self) -> Vec<AgentActivityEntry> {
        let journal = Arc::new(CodexTurnJournal::new(self.root.path().join("journal")));
        let mut replay = journal.load(None).await.unwrap();
        let mut entries = Vec::new();
        while let Some(group) = replay.next_group().await.unwrap() {
            entries.extend(group);
        }
        entries
    }
}
fn agent(spans: &[ReadableSpan], session: &str, turn: &str) -> ReadableSpan {
    spans
        .iter()
        .find(|s| {
            s.attributes["gen_ai.span.kind"] == "AGENT"
                && s.attributes["gen_ai.session.id"] == session
                && s.attributes["gen_ai.turn.id"] == format!("{session}:{turn}")
        })
        .unwrap_or_else(|| panic!("missing {session}/{turn} AGENT"))
        .clone()
}
fn invocation<'a>(logs: &'a [Value], call: &str) -> &'a Value {
    let matches: Vec<_> = logs
        .iter()
        .filter(|e| e["event.name"] == "gen_ai.agent.invoke" && e["gen_ai.tool.call.id"] == call)
        .collect();
    assert_eq!(matches.len(), 1, "invocation for {call}");
    matches[0]
}
fn assert_child(logs: &[Value], spans: &[ReadableSpan], session: &str, turn: &str, call: &str) {
    let invoke = invocation(logs, call);
    let own: Vec<_> = logs
        .iter()
        .filter(|e| {
            e["gen_ai.session.id"] == session && e["gen_ai.turn.id"] == format!("{session}:{turn}")
        })
        .collect();
    assert!(!own.is_empty(), "missing child raw events");
    assert!(own.iter().all(|e|e["gen_ai.agent.parent.invocation.id"]==invoke["gen_ai.agent.invocation.id"]),"child work lost incoming invocation");
    let tool = spans
        .iter()
        .find(|s| {
            s.attributes["gen_ai.span.kind"] == "TOOL"
                && s.attributes.get("gen_ai.tool.call.id") == Some(&json!(call))
        })
        .expect("delegation TOOL");
    let child = agent(spans, session, turn);
    assert_eq!(child.parent_span_id.as_deref(), Some(tool.span_id.as_str()));
    assert_eq!(child.trace_id, tool.trace_id);
    assert_eq!(
        child.attributes["gen_ai.agent.parent.invocation.id"],
        invoke["gen_ai.agent.invocation.id"]
    );
    for entry in own
        .iter()
        .filter(|e| e["event.name"] == "llm.request" || e["event.name"] == "llm.response")
    {
        let model = spans
            .iter()
            .find(|s| Some(s.span_id.as_str()) == entry["span_id"].as_str())
            .expect("model operation span");
        for key in ["gen_ai.session.id", "gen_ai.turn.id", "gen_ai.step.id"] {
            assert_eq!(model.attributes[key], entry[key]);
        }
    }
}
fn assert_unique(logs: &[Value], spans: &[ReadableSpan]) {
    let event_ids: BTreeSet<_> = logs
        .iter()
        .map(|e| e["event.id"].as_str().unwrap())
        .collect();
    assert_eq!(event_ids.len(), logs.len(), "raw event was duplicated");
    let span_ids: BTreeSet<_> = spans.iter().map(|s| s.span_id.as_str()).collect();
    assert_eq!(span_ids.len(), spans.len(), "operation span was duplicated");
}
async fn parent_with_dispatch(h: &Harness) {
    let mut records = vec![metadata(PARENT, 0.0, None, 1)];
    records.extend(begin("p1", 1.0, "delegate", false));
    records.extend(dispatch("spawn-a", CHILD, 2.0, "child-a", "spawn_agent"));
    records.extend(end("p1", 3.0));
    h.write(PARENT, records, None).await;
}

#[tokio::test]
async fn native_codex_parallel_agent_id_only_work_has_independent_identity_and_exact_tokens() {
    let mut h = Harness::new().await;
    let mut records = vec![metadata(PARENT, 0.0, None, 1)];
    records.extend(begin("p1", 1.0, "delegate", false));
    records.extend(dispatch("spawn-a", CHILD, 2.0, "child-a", "spawn_agent"));
    records.extend(dispatch("spawn-b", PEER, 3.0, "child-b", "spawn_agent"));
    records.extend(end("p1", 4.0));
    h.write(PARENT, records, None).await;
    for (session, turn, second, prompt) in [
        (CHILD, "c1", 2.005, "child-a"),
        (PEER, "b1", 3.005, "child-b"),
    ] {
        let mut records = vec![metadata(session, second, Some(PARENT), 1)];
        records.extend(work(turn, 5.0, prompt));
        h.write(session, records, Some(turn)).await;
    }
    let logs = h.logs().await;
    let spans = h.captured();
    assert_child(&logs, &spans, CHILD, "c1", "spawn-a");
    assert_child(&logs, &spans, PEER, "b1", "spawn-b");
    assert_ne!(
        invocation(&logs, "spawn-a")["gen_ai.agent.invocation.id"],
        invocation(&logs, "spawn-b")["gen_ai.agent.invocation.id"]
    );
    assert_unique(&logs, &spans);
    assert_eq!(
        spans
            .iter()
            .filter(|s| s.attributes["gen_ai.span.kind"] == "ENTRY")
            .count(),
        1
    );
    assert!(!logs
        .iter()
        .any(|e| e["event.name"] == "gen_ai.agent.result"));
    let span_tokens: u64 = spans
        .iter()
        .filter(|s| s.attributes["gen_ai.span.kind"] == "LLM")
        .map(|s| {
            s.attributes["gen_ai.usage.input_tokens"]
                .as_u64()
                .unwrap_or(0)
        })
        .sum();
    let raw_tokens: u64 = logs
        .iter()
        .filter(|e| e["event.name"] == "llm.response")
        .map(|e| e["gen_ai.usage.input_tokens"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(span_tokens, raw_tokens);
    h.stop().await;
}

#[tokio::test]
async fn native_codex_parent_finishes_before_background_child_and_invocation_spans_child_turns() {
    let mut h = Harness::new().await;
    let mut parent = vec![metadata(PARENT, 0.0, None, 1)];
    parent.extend(begin("p1", 1.0, "delegate", false));
    parent.extend(dispatch("spawn-a", CHILD, 2.0, "child-a", "spawn_agent"));
    parent.push(end("p1", 3.0)[1].clone());
    h.write(PARENT, parent, None).await;
    let mut child = vec![metadata(CHILD, 2.005, Some(PARENT), 1)];
    child.extend(begin("c1", 4.0, "child-a", true));
    h.write(CHILD, child, Some("c1")).await;
    h.write(PARENT, end("p1", 5.0), None).await;
    let parent = agent(&h.captured(), PARENT, "p1");
    assert!(!h
        .emitted
        .lock()
        .unwrap()
        .iter()
        .any(|e| e.session_id == CHILD && e.turn_end == Some(true)));
    assert!(!h
        .captured()
        .iter()
        .any(|s| s.attributes["gen_ai.session.id"] == CHILD));
    let mut completion = end("c1", 10.0);
    completion.extend(work("c2", 12.0, "child-a"));
    h.write(CHILD, completion, None).await;
    let logs = h.logs().await;
    let spans = h.captured();
    assert_child(&logs, &spans, CHILD, "c1", "spawn-a");
    assert_child(&logs, &spans, CHILD, "c2", "spawn-a");
    assert_eq!(agent(&spans, PARENT, "p1").end_time, parent.end_time);
    assert_eq!(
        spans
            .iter()
            .filter(|s| s.attributes["gen_ai.session.id"] == PARENT
                && s.attributes["gen_ai.span.kind"] == "AGENT")
            .count(),
        1
    );
    assert_eq!(
        spans
            .iter()
            .filter(|s| s.attributes["gen_ai.session.id"] == CHILD
                && s.attributes["gen_ai.span.kind"] == "AGENT")
            .count(),
        2
    );
    assert_unique(&logs, &spans);
    assert!(!h
        .emitted
        .lock()
        .unwrap()
        .iter()
        .any(|e| e.get("agent.codex.turn_status") == Some(&json!("interrupted"))));
    h.stop().await;
}

#[tokio::test]
async fn native_codex_followup_rebinds_reused_session_and_nested_work_keeps_both_invocations() {
    let mut h = Harness::new().await;
    parent_with_dispatch(&h).await;
    let mut child = vec![metadata(CHILD, 2.005, Some(PARENT), 1)];
    child.extend(work("c1", 4.0, "child-a"));
    h.write(CHILD, child, Some("c1")).await;
    let mut parent = begin("p2", 7.0, "again", false);
    parent.extend(dispatch("follow-a", CHILD, 8.0, "second", "followup_task"));
    parent.extend(end("p2", 9.0));
    h.write(PARENT, parent, None).await;
    let mut child = begin("c2", 10.0, "second", true);
    child.extend(dispatch(
        "spawn-grandchild",
        GRANDCHILD,
        11.0,
        "nested",
        "spawn_agent",
    ));
    child.extend(end("c2", 12.0));
    h.write(CHILD, child, None).await;
    let mut grandchild = vec![metadata(GRANDCHILD, 11.005, Some(CHILD), 2)];
    grandchild.extend(work("g1", 13.0, "nested"));
    h.write(GRANDCHILD, grandchild, Some("g1")).await;
    let logs = h.logs().await;
    let spans = h.captured();
    assert_child(&logs, &spans, CHILD, "c1", "spawn-a");
    assert_child(&logs, &spans, CHILD, "c2", "follow-a");
    assert_child(&logs, &spans, GRANDCHILD, "g1", "spawn-grandchild");
    let first = invocation(&logs, "spawn-a");
    let second = invocation(&logs, "follow-a");
    let nested = invocation(&logs, "spawn-grandchild");
    for (invoke, prompt) in [(first, "child-a"), (second, "second"), (nested, "nested")] {
        assert_eq!(
            invoke["gen_ai.input.messages"],
            json!([{"role":"user","parts":[{"type":"text","content":prompt}]}])
        );
    }
    assert_ne!(
        first["gen_ai.agent.invocation.id"],
        second["gen_ai.agent.invocation.id"]
    );
    assert_eq!(
        nested["gen_ai.agent.parent.invocation.id"],
        second["gen_ai.agent.invocation.id"]
    );
    assert_ne!(
        nested["gen_ai.agent.invocation.id"],
        nested["gen_ai.agent.parent.invocation.id"]
    );
    assert_ne!(
        agent(&spans, CHILD, "c1").trace_id,
        agent(&spans, CHILD, "c2").trace_id
    );
    assert_unique(&logs, &spans);
    h.stop().await;
}

#[tokio::test]
async fn native_codex_completed_parent_delegation_survives_fresh_input_manager_and_journal() {
    let mut h = Harness::new().await;
    parent_with_dispatch(&h).await;
    let before = invocation(&h.logs().await, "spawn-a").clone();
    h.restart().await;
    let mut child = vec![metadata(CHILD, 2.005, Some(PARENT), 1)];
    child.extend(work("c1", 4.0, "child-a"));
    h.write(CHILD, child, Some("c1")).await;
    h.restart().await;
    let logs = h.logs().await;
    let spans = h.captured();
    assert_child(&logs, &spans, CHILD, "c1", "spawn-a");
    let after = invocation(&logs, "spawn-a");
    assert_eq!(after["event.id"], before["event.id"]);
    assert_eq!(
        after["gen_ai.input.messages"],
        before["gen_ai.input.messages"]
    );
    assert_unique(&logs, &spans);
    h.stop().await;
}

#[tokio::test]
async fn native_codex_three_wave_prefix_recovers_tools_tokens_and_unique_spans_after_restart() {
    let mut h = Harness::new().await;
    let mut prefix = vec![metadata(PARENT, 0.0, None, 1)];
    prefix.extend(begin("p1", 1.0, "three waves", false));
    prefix.push(record(
        4.0,
        "event_msg",
        json!({"type":"agent_message","message":"first wave","phase":"commentary"}),
    ));
    prefix.extend(tool(5.0, "tool-one"));
    prefix.push(token(6.0, 100, 10));
    prefix.push(record(
        7.0,
        "event_msg",
        json!({"type":"agent_message","message":"next wave","phase":"commentary"}),
    ));
    h.write(PARENT, prefix, None).await;
    let pending = h.pending().await;
    assert!(pending
        .iter()
        .any(|e| e.tool_call_id.as_deref() == Some("tool-one")));
    assert!(pending
        .iter()
        .any(|e| e.event_name.map(|n| n.as_str()) == Some("llm.response")));
    assert!(h.captured().is_empty());
    h.restart().await;
    assert!(h.captured().is_empty());
    let mut remaining = tool(8.0, "tool-two");
    remaining.push(token(9.0, 120, 12));
    remaining.push(record(
        10.0,
        "event_msg",
        json!({"type":"agent_message","message":"done","phase":"final"}),
    ));
    remaining.push(token(10.0, 130, 13));
    remaining.push(record(
        11.0,
        "event_msg",
        json!({"type":"task_complete","turn_id":"p1","last_agent_message":"done"}),
    ));
    h.write(PARENT, remaining, None).await;
    let spans = h.captured();
    let logs = h.logs().await;
    assert_eq!(spans.len(), 10);
    assert_unique(&logs, &spans);
    assert_eq!(
        spans
            .iter()
            .filter(|s| s.attributes["gen_ai.span.kind"] == "AGENT")
            .count(),
        1
    );
    let calls: BTreeSet<_> = spans
        .iter()
        .filter(|s| s.attributes["gen_ai.span.kind"] == "TOOL")
        .map(|s| s.attributes["gen_ai.tool.call.id"].as_str().unwrap())
        .collect();
    assert_eq!(calls, BTreeSet::from(["tool-one", "tool-two"]));
    let models: Vec<_> = spans
        .iter()
        .filter(|s| s.attributes["gen_ai.span.kind"] == "LLM")
        .collect();
    assert_eq!(models.len(), 3);
    assert_eq!(
        models
            .iter()
            .map(|s| s.attributes["gen_ai.usage.input_tokens"]
                .as_u64()
                .unwrap_or(0))
            .sum::<u64>(),
        350
    );
    assert_eq!(
        models
            .iter()
            .map(|s| s.attributes["gen_ai.usage.output_tokens"]
                .as_u64()
                .unwrap_or(0))
            .sum::<u64>(),
        35
    );
    assert!(h.pending().await.is_empty());
    h.restart().await;
    assert_eq!(h.captured().len(), 10);
    h.stop().await;
}

#[tokio::test]
async fn native_codex_direct_user_turn_stays_independent_when_prompt_repeats_delegated_work() {
    let mut h = Harness::new().await;
    parent_with_dispatch(&h).await;
    let mut child = vec![metadata(CHILD, 2.005, Some(PARENT), 1)];
    child.extend(work("c1", 4.0, "child-a"));
    h.write(CHILD, child, Some("c1")).await;
    let mut direct = begin("direct-user-turn", 8.0, "child-a", false);
    direct.extend(end("direct-user-turn", 9.0));
    h.write(CHILD, direct, None).await;
    let logs = h.logs().await;
    let spans = h.captured();
    let own: Vec<_> = logs
        .iter()
        .filter(|e| e["gen_ai.turn.id"] == format!("{CHILD}:direct-user-turn"))
        .collect();
    assert!(!own.is_empty());
    assert!(own
        .iter()
        .all(|e| e["gen_ai.agent.parent.invocation.id"].is_null()));
    let direct = agent(&spans, CHILD, "direct-user-turn");
    assert!(direct
        .attributes
        .get("gen_ai.agent.parent.invocation.id")
        .is_none());
    assert_ne!(direct.trace_id, agent(&spans, CHILD, "c1").trace_id);
    assert_eq!(
        logs.iter()
            .filter(|e| e["event.name"] == "gen_ai.agent.invoke")
            .count(),
        1
    );
    assert_unique(&logs, &spans);
    h.stop().await;
}

#[tokio::test]
async fn native_codex_current_mask_and_workspace_policy_cover_fresh_collection_and_journal_replay()
{
    let mut h = Harness::new().await;
    let api_key = "sk-1234567890abcdefghijklmnop";
    let excluded = h.root.path().join("excluded-workspace/project");
    let sensitive_tool = |second: f64, call: &str| {
        vec![
            record(
                second,
                "response_item",
                json!({"type":"function_call","call_id":call,"name":"exec_command",
            "arguments":json!({"cmd":format!("echo {api_key}")}).to_string()}),
            ),
            record(
                second + 1.0,
                "response_item",
                json!({"type":"function_call_output","call_id":call,
            "output":format!("prefix-result {api_key}")}),
            ),
        ]
    };
    let prefix = |session: &str, turn: &str, prompt: &str, excluded_path: bool| {
        let mut begin = begin(turn, 1.0, prompt, false);
        if excluded_path {
            begin[0] = record(
                1.0,
                "turn_context",
                json!({"turn_id":turn,"model":"gpt-test","cwd":excluded}),
            );
        }
        let mut records = vec![metadata(session, 0.0, None, 1)];
        records.extend(begin);
        records.push(record(
            4.0,
            "event_msg",
            json!({"type":"agent_message","message":"first wave","phase":"commentary"}),
        ));
        records.extend(sensitive_tool(5.0, "tool-one"));
        records.push(token(6.0, 100, 10));
        records.push(record(
            7.0,
            "event_msg",
            json!({"type":"agent_message","message":"next wave","phase":"commentary"}),
        ));
        records
    };
    // Old policy accepted these prefixes into the actual durable journal.
    h.write(
        PARENT,
        prefix(PARENT, "p1", &format!("restored child-a {api_key}"), false),
        None,
    )
    .await;
    h.write(
        CHILD,
        prefix(
            CHILD,
            "excluded",
            &format!("excluded-content-sentinel {api_key}"),
            true,
        ),
        None,
    )
    .await;
    let old_pending = h.pending().await;
    assert!(old_pending.iter().any(|entry| entry.session_id == PARENT));
    let excluded_entry = old_pending
        .iter()
        .find(|entry| entry.session_id == CHILD)
        .unwrap()
        .clone();
    assert!(
        serde_json::to_string(&old_pending)
            .unwrap()
            .contains(api_key),
        "fixture never exercised an old unmasked journal"
    );
    assert!(h.captured().is_empty());
    let before = h.logs().await.len();

    // A fresh manager configures current policy before trace.start() replays
    // the old journal; both masking and workspace exclusion use production code.
    h.current_privacy = true;
    h.restart().await;
    assert!(
        h.captured().is_empty(),
        "unfinished restored prefix must remain unfinished"
    );
    assert!(
        h.pending()
            .await
            .iter()
            .all(|entry| entry.session_id != CHILD),
        "excluded old journal bypassed current workspace policy"
    );

    let mut completion = sensitive_tool(8.0, "tool-two");
    completion.push(token(9.0, 120, 12));
    completion.push(record(
        10.0,
        "event_msg",
        json!({"type":"agent_message","message":"fixture-result","phase":"final"}),
    ));
    completion.push(token(10.0, 130, 13));
    completion.push(record(
        11.0,
        "event_msg",
        json!({"type":"task_complete","turn_id":"p1","last_agent_message":"fixture-result"}),
    ));
    h.write(PARENT, completion, None).await;
    h.write(CHILD, end("excluded", 15.0), None).await;

    // Entirely new native work must pass through exactly the same current
    // manager policy, rather than relying only on the journal callback.
    let mut fresh = vec![metadata(PEER, 19.0, None, 1)];
    fresh.extend(begin(
        "fresh",
        20.0,
        &format!("fresh child-a {api_key}"),
        false,
    ));
    fresh.push(record(
        21.0,
        "event_msg",
        json!({"type":"agent_message","message":"inspect first","phase":"commentary"}),
    ));
    fresh.extend(sensitive_tool(22.0, "fresh-tool"));
    fresh.push(token(23.0, 10, 2));
    fresh.extend(end("fresh", 25.0));
    h.write(PEER, fresh, None).await;

    let logs = h.logs().await;
    let current = &logs[before..];
    let spans = h.captured();
    assert!(current
        .iter()
        .any(|entry| entry["gen_ai.session.id"] == PEER));
    assert!(!current
        .iter()
        .any(|entry| entry["gen_ai.session.id"] == CHILD));
    assert!(!spans
        .iter()
        .any(|span| span.attributes.get("gen_ai.session.id") == Some(&json!(CHILD))));
    assert!(
        spans
            .iter()
            .any(|span| span.attributes.get("gen_ai.tool.call.id") == Some(&json!("tool-one"))),
        "restored prefix tool disappeared instead of being masked"
    );
    assert!(spans
        .iter()
        .any(|span| span.attributes.get("gen_ai.tool.call.id") == Some(&json!("fresh-tool"))));
    for text in [
        serde_json::to_string(current).unwrap(),
        serde_json::to_string(
            &spans
                .iter()
                .map(|span| &span.attributes)
                .collect::<Vec<_>>(),
        )
        .unwrap(),
    ] {
        assert!(text.contains("child-a"));
        assert!(text.contains("fixture-result"));
        assert!(text.contains("[APIKEY_MASKED]"));
        assert!(!text.contains(api_key));
        assert!(!text.contains("excluded-content-sentinel"));
    }
    assert!(h.pending().await.is_empty());
    let journal = Arc::new(CodexTurnJournal::new(h.root.path().join("journal")));
    assert!(
        !journal.is_acknowledged(&excluded_entry).await.unwrap(),
        "workspace filtering fabricated backend acknowledgement"
    );
    assert_unique(&logs, &spans);
    h.stop().await;
}

mod native_wire {
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Export {
        #[prost(message, repeated, tag = "1")]
        pub resources: Vec<Resource>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Resource {
        #[prost(message, repeated, tag = "2")]
        pub scopes: Vec<Scope>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Scope {
        #[prost(message, repeated, tag = "2")]
        pub spans: Vec<Span>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Span {
        #[prost(bytes = "vec", tag = "1")]
        pub trace_id: Vec<u8>,
        #[prost(bytes = "vec", tag = "2")]
        pub span_id: Vec<u8>,
        #[prost(bytes = "vec", tag = "4")]
        pub parent_span_id: Vec<u8>,
        #[prost(message, repeated, tag = "9")]
        pub attributes: Vec<Attribute>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Attribute {
        #[prost(string, tag = "1")]
        pub key: String,
        #[prost(message, optional, tag = "2")]
        pub value: Option<AnyValue>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct AnyValue {
        #[prost(string, optional, tag = "1")]
        pub text: Option<String>,
    }
}
struct WireReceiver {
    endpoint: String,
    spans: Arc<Mutex<Vec<native_wire::Span>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for WireReceiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl WireReceiver {
    async fn new() -> Self {
        use prost::Message;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let spans = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&spans);
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut part = [0; 4096];
                let header_end = loop {
                    let n = socket.read(&mut part).await.unwrap();
                    if n == 0 {
                        break None;
                    }
                    bytes.extend_from_slice(&part[..n]);
                    assert!(bytes.len() <= 10 * 1024 * 1024 + 65536);
                    if let Some(i) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                        break Some(i + 4);
                    }
                };
                let Some(end) = header_end else { continue };
                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                assert!(
                    !headers.contains("content-encoding: gzip"),
                    "fixture selects actual uncompressed protobuf"
                );
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                assert!(length <= 10 * 1024 * 1024);
                while bytes.len() < end + length {
                    let n = socket.read(&mut part).await.unwrap();
                    assert_ne!(n, 0);
                    bytes.extend_from_slice(&part[..n]);
                }
                let decoded = native_wire::Export::decode(&bytes[end..end + length]).unwrap();
                let decoded = decoded
                    .resources
                    .into_iter()
                    .flat_map(|resource| resource.scopes)
                    .flat_map(|scope| scope.spans)
                    .collect::<Vec<_>>();
                assert!(
                    !decoded.is_empty(),
                    "real OTLP request must contain protobuf spans"
                );
                sink.lock().unwrap().extend(decoded);
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
        });
        Self {
            endpoint,
            spans,
            task,
        }
    }
}
fn wire_string<'a>(span: &'a native_wire::Span, key: &str) -> Option<&'a str> {
    span.attributes
        .iter()
        .find(|attribute| attribute.key == key)
        .and_then(|attribute| attribute.value.as_ref())
        .and_then(|value| value.text.as_deref())
}
#[tokio::test]
async fn native_codex_subagent_real_http_protobuf_matches_jsonl_operation_ids_and_parent_tree() {
    let receiver = WireReceiver::new().await;
    let mut h = Harness::with_wire_endpoint(Some(receiver.endpoint.clone())).await;
    h.write(
        PARENT,
        [
            vec![metadata(PARENT, 0.0, None, 1)],
            begin("p1", 1.0, "delegate", false),
            dispatch("spawn-a", CHILD, 2.0, "child-a", "spawn_agent"),
            end("p1", 3.0),
        ]
        .concat(),
        None,
    )
    .await;
    h.write(
        CHILD,
        [
            vec![metadata(CHILD, 2.005, Some(PARENT), 1)],
            work("c1", 4.0, "child-a"),
        ]
        .concat(),
        Some("c1"),
    )
    .await;
    let logs = h.logs().await;
    h.stop().await;
    let spans = receiver.spans.lock().unwrap().clone();
    assert!(!spans.is_empty());
    let tool = spans
        .iter()
        .find(|span| {
            wire_string(span, "gen_ai.tool.call.id") == Some("spawn-a")
                && wire_string(span, "gen_ai.span.kind") == Some("TOOL")
        })
        .unwrap();
    let child = spans
        .iter()
        .find(|span| {
            wire_string(span, "gen_ai.span.kind") == Some("AGENT")
                && wire_string(span, "gen_ai.session.id") == Some(CHILD)
        })
        .unwrap();
    assert_eq!(child.parent_span_id, tool.span_id);
    assert_eq!(child.trace_id, tool.trace_id);
    let mut checked = 0;
    for entry in logs.iter().filter(|entry| {
        matches!(
            entry["event.name"].as_str(),
            Some("llm.request" | "llm.response" | "tool.call" | "tool.result")
        )
    }) {
        let operation = spans
            .iter()
            .find(|span| hex::encode(&span.span_id) == entry["span_id"].as_str().unwrap())
            .expect("every physical JSONL operation must exist on real protobuf wire");
        assert_eq!(
            hex::encode(&operation.trace_id),
            entry["trace_id"].as_str().unwrap()
        );
        for key in ["gen_ai.session.id", "gen_ai.turn.id", "gen_ai.step.id"] {
            assert_eq!(wire_string(operation, key), entry[key].as_str(), "{key}");
        }
        checked += 1;
    }
    assert!(
        checked > 0,
        "operation identity comparison must not be vacuous"
    );
    assert_eq!(
        spans
            .iter()
            .map(|span| &span.span_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        spans.len()
    );
}

#[tokio::test]
async fn native_codex_legacy_optout_keeps_masked_subagent_invocation_tree_and_excludes_peer_workspace(
) {
    let mut h = Harness::new().await;
    h.stop().await;
    h.current_privacy = true;
    h.start().await;
    let key = "sk-1234567890abcdefghijklmnop";
    let prompt = format!("child-a {key}");
    h.write(
        PARENT,
        [
            vec![metadata(PARENT, 0.0, None, 1)],
            begin("p1", 1.0, "delegate", false),
            dispatch("spawn-a", CHILD, 2.0, &prompt, "spawn_agent"),
            end("p1", 3.0),
        ]
        .concat(),
        None,
    )
    .await;
    h.write(
        CHILD,
        [
            vec![metadata(CHILD, 2.005, Some(PARENT), 1)],
            work("c1", 4.0, &prompt),
        ]
        .concat(),
        Some("c1"),
    )
    .await;
    let mut excluded = begin("excluded-turn", 8.0, "excluded-content-sentinel", false);
    excluded[0] = record(
        8.0,
        "turn_context",
        json!({"turn_id":"excluded-turn","model":"gpt-test",
        "cwd":h.root.path().join("excluded-workspace/project")}),
    );
    h.write(
        PEER,
        [
            vec![metadata(PEER, 7.0, None, 1)],
            excluded,
            end("excluded-turn", 9.0),
        ]
        .concat(),
        None,
    )
    .await;
    let logs = h.logs().await;
    let spans = h.captured();
    assert_child(&logs, &spans, CHILD, "c1", "spawn-a");
    assert!(logs
        .iter()
        .any(|row| !row["gen_ai.input.messages"].is_null()
            || !row["gen_ai.input.messages_delta"].is_null()));
    for field in [
        "gen_ai.output.messages",
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
    ] {
        assert!(
            logs.iter().any(|row| !row[field].is_null()),
            "legacy switch removed {field}"
        );
    }
    for text in [
        serde_json::to_string(&logs).unwrap(),
        serde_json::to_string(
            &spans
                .iter()
                .map(|span| &span.attributes)
                .collect::<Vec<_>>(),
        )
        .unwrap(),
    ] {
        for retained in ["child-a", "fixture-result", "[APIKEY_MASKED]"] {
            assert!(text.contains(retained));
        }
        assert!(!text.contains(key));
        assert!(!text.contains("excluded-content-sentinel"));
    }
    assert!(!logs.iter().any(|row| row["gen_ai.session.id"] == PEER));
    assert!(!spans
        .iter()
        .any(|span| span.attributes.get("gen_ai.session.id") == Some(&json!(PEER))));
    assert_unique(&logs, &spans);
    h.stop().await;
}
