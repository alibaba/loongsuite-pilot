//! Frozen f84 Doubao input -> identity/mask -> real JSONL and native OTLP conversion.
use async_trait::async_trait;
use chrono::{Datelike, TimeZone};
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{
    BaseFlusher, JsonlFlusher, MultiFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter,
};
use loongsuite_pilot::inputs::base::InputBody;
use loongsuite_pilot::inputs::doubao_work::{
    DoubaoWorkBudgetOptions, DoubaoWorkInput, DoubaoWorkInputOptions,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

// Invoke the actual production native validator, without a Node subprocess or a second Cargo build.
#[path = "../xtask/src/jsonl_validate.rs"]
mod native_jsonl_validator;
#[derive(clap::Parser)]
struct ValidatorCli {
    #[command(flatten)]
    options: native_jsonl_validator::Options,
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
struct Fixture {
    root: tempfile::TempDir,
    source: PathBuf,
    input: Arc<DoubaoWorkInput>,
    store: Arc<StateStore>,
    epoch: i64,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("source");
        tokio::fs::create_dir(&logs).await.unwrap();
        let epoch = chrono::Utc::now().timestamp_millis() + 1000;
        let date = chrono::Local.timestamp_millis_opt(epoch).single().unwrap();
        let source = logs.join(format!(
            "saman_frontend_{}.{:02}{:02}.0.log",
            date.year(),
            date.month(),
            date.day()
        ));
        tokio::fs::write(&source, "").await.unwrap();
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        let input = Arc::new(DoubaoWorkInput::new(DoubaoWorkInputOptions {
            log_dir: Some(logs.to_string_lossy().into_owned()),
            sessions_root: Some(root.path().join("native").to_string_lossy().into_owned()),
            snapshot_root: Some(root.path().join("snapshots").to_string_lossy().into_owned()),
            poll_interval_ms: Some(100),
            native_scan_interval_ms: Some(0),
            work_budget: Some(DoubaoWorkBudgetOptions {
                milliseconds: 1000,
                ..Default::default()
            }),
            ..DoubaoWorkInputOptions::new(store.clone())
        }));
        assert!(input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .unwrap()
            .is_empty());
        Self {
            root,
            source,
            input,
            store,
            epoch,
        }
    }
    fn line(&self, name: &str, meta: Value, offset: i64) -> String {
        let at = chrono::Local
            .timestamp_millis_opt(self.epoch + offset)
            .single()
            .unwrap();
        let mut base = json!({"chat_session_id":"synthetic-turn","query_send_timestamp":self.epoch,
            "conversation_id":"12345678","send_local_message_id":"00000000-0000-4000-8000-000000000002",
            "session_success":"1","receive_success":"1"});
        base.as_object_mut()
            .unwrap()
            .extend(meta.as_object().unwrap().clone());
        let payload =
            json!({"version":1,"type":"event","level":"info","eventName":name,"meta":base});
        format!(
            r#"[100:200:{}123:INFO:FRONTEND(0)] [neotix] [office-api-logger] "[webview][unknown][flow-web][logifier-report]: {}", source: (0)"#,
            at.format("%m%d/%H%M%S.%3f"),
            payload
        ) + "\n"
    }
    fn tool(&self, data: Value, offset: i64) -> String {
        let at = chrono::Local
            .timestamp_millis_opt(self.epoch + offset)
            .single()
            .unwrap();
        let mut base = json!({"name":"Read","sandbox_id":"synthetic-sandbox","status":"received",
            "tcid":"synthetic-call","agent_id":"synthetic-turn"});
        base.as_object_mut()
            .unwrap()
            .extend(data.as_object().unwrap().clone());
        format!(
            r#"[100:200:{}123:INFO:FRONTEND(0)] [neotix] [agent-task] "{}", source: local-file-local-tools-sse-wiring.ts (0)"#,
            at.format("%m%d/%H%M%S.%3f"),
            json!({"event":"toolcall","data":base})
        ) + "\n"
    }
    fn command(&self, actor: &str, offset: i64) -> String {
        self.tool(json!({"name":"sandbox","agent_id":actor,"sand_box_id":"synthetic-sandbox","command_id":format!("command-{actor}")}),offset)
            .replace(r#""event":"toolcall""#,r#""event":"command""#)
    }
    fn first(&self) -> String {
        self.line("flow_message_time",json!({"task_session_id":"synthetic-turn","metric_scene":"sse",
            "ev_name":"cot_first_token","ev_type":"query_duration","event_instance_id":"synthetic-turn:sync:6:1",
            "task_stage":"sync","is_recovery":false,"occurrence_index":1,"duration":1000,
            "answer_id":"synthetic-answer","message_id":"synthetic-query","prompt":"SYNTHETIC_PRIVATE_PROMPT"}),1002)
    }
    async fn append(&self, text: &str) {
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&self.source)
            .await
            .unwrap();
        file.write_all(text.as_bytes()).await.unwrap();
        file.flush().await.unwrap();
    }
    async fn native_actor(&self, actor: &str, rows: &[Value], assignment: Option<&str>) {
        let folder = self
            .root
            .path()
            .join("native/12345678/agents")
            .join(actor)
            .join("system");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        tokio::fs::write(
            folder.join("trajectory.jsonl"),
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .await
        .unwrap();
        if let Some(text) = assignment {
            let at = chrono::Utc
                .timestamp_millis_opt(self.epoch + 10)
                .single()
                .unwrap();
            tokio::fs::write(
                folder.join("assignment.md"),
                format!("## [{}] 需求\n{text}\n", at.to_rfc3339()),
            )
            .await
            .unwrap();
        }
    }
    async fn ancestry(&self) {
        self.native_actor("m_nativeMain",&[
            json!({"role":"assistant","tool_calls":[{"id":"root-create","function":{"name":"create_agent","arguments":{"subtask":"SYNTHETIC_PRIVATE"}}}]}),
            json!({"role":"tool","tool_call_id":"root-create","content":"create_agent ok\nagent_id: o_nativeOrg\nparent_id: main_agent\nthread_id: 101\nagent_type: organizer\nsubtask: SYNTHETIC_PRIVATE"}),
        ],None).await;
        self.native_actor("o_nativeOrg",&[
            json!({"role":"assistant","tool_calls":[{"id":"child-create","function":{"name":"create_agent","arguments":{"subtask":"SYNTHETIC_PRIVATE"}}}]}),
            json!({"role":"tool","tool_call_id":"child-create","content":"create_agent ok\nagent_id: s_nativeLeaf\nparent_id: o_nativeOrg\nthread_id: 102\nagent_type: sub_agent\nsubtask: SYNTHETIC_PRIVATE"}),
        ],None).await;
    }
    async fn execution(&self, key: &str, actor: &str, start: i64, end: i64, private: bool) {
        let folder = self.root.path().join("snapshots/123/12345678").join(key);
        tokio::fs::create_dir_all(&folder).await.unwrap();
        let mut execution = json!({"executionKey":key,"conversationId":"12345678",
            "queryMessageId":"00000000-0000-4000-8000-000000000002","agentId":actor,
            "agentType":if actor.starts_with("o_"){"organizer"}else{"sub_agent"},"sandboxId":"synthetic-sandbox",
            "startedAtMs":self.epoch+start,"endedAtMs":self.epoch+end});
        if private {
            execution["userId"] = json!("SYNTHETIC_PRIVATE_ACCOUNT");
        }
        tokio::fs::write(
            folder.join(format!("{actor}.json")),
            json!({"execution":execution,
            "fileContents":"SYNTHETIC_PRIVATE_BODY"})
            .to_string(),
        )
        .await
        .unwrap();
    }
}
struct Harness {
    fixture: Fixture,
    manager: Arc<InputManager>,
    output: Arc<MultiFlusher>,
    spans: Arc<Mutex<Vec<ReadableSpan>>>,
}
impl Harness {
    async fn new(service: &str) -> Self {
        let fixture = Fixture::new().await;
        let spans = Arc::new(Mutex::new(Vec::new()));
        let sink = spans.clone();
        let trace = Arc::new(
            OtlpTraceFlusher::with_parts(
                serde_json::from_value(json!({
                    "enabled":true,"endpoints":[{"name":"capture","endpoint":"http://127.0.0.1:1"}],
                    "protocol":"http/protobuf","serviceName":service,"dataDir":fixture.root.path()
                }))
                .unwrap(),
                None,
                Some(Arc::new(move |_| Arc::new(Capture(sink.clone())))),
                None,
            )
            .unwrap(),
        );
        let jsonl=Arc::new(JsonlFlusher::new(serde_json::from_value(json!({
            "enabled":true,"outputDir":fixture.root.path().join("output"),"rotateDaily":false,"maxFileSizeMb":1
        })).unwrap()));
        let output = Arc::new(MultiFlusher::new(vec![jsonl, trace]));
        let manager = Arc::new(InputManager::new());
        manager.set_state_store(fixture.store.clone());
        manager.set_flusher(output.clone());
        manager.set_user_id("synthetic-host");
        manager.set_configured_user_id("synthetic-employee");
        manager.set_mask_config(loongsuite_pilot::types::MaskConfig {
            mode: loongsuite_pilot::types::MaskMode::All,
            types: vec![],
            replacement_mode: None,
        });
        let (running, start, stop) = (
            fixture.input.clone(),
            fixture.input.clone(),
            fixture.input.clone(),
        );
        manager.register_input(LiveInput::new(
            "doubao-work",
            "doubao-work",
            "session-file-polling",
            move || running.collector_running(),
            move || {
                let input = start.clone();
                Box::pin(async move { input.start().await })
            },
            move || {
                let input = stop.clone();
                Box::pin(async move {
                    input.stop().await.unwrap();
                })
            },
        ));
        let weak = Arc::downgrade(&manager);
        fixture.input.on_entries(move |entries| {
            if let Some(manager) = weak.upgrade() {
                manager.bind_entries("doubao-work", entries.to_vec());
            }
        });
        Self {
            fixture,
            manager,
            output,
            spans,
        }
    }
    async fn start(&self) {
        self.output.start().await.unwrap();
        self.manager.start_input("doubao-work").await;
        assert!(self.fixture.input.collector_running());
    }
    async fn stop(&self) {
        // The capture exporter can complete before the concurrent JSONL child.
        // Observe actual all-output acceptance before exercising bounded shutdown.
        tokio::time::timeout(Duration::from_secs(3), self.fixture.store.save())
            .await
            .unwrap()
            .unwrap();
        assert!(!self.fixture.store.waiting_for_output());
        self.manager.stop_all().await;
        self.output.flush().await.unwrap();
    }
    async fn rows(&self) -> Vec<Value> {
        let folder = self.fixture.root.path().join("output");
        let mut rows = Vec::new();
        if let Ok(mut files) = tokio::fs::read_dir(folder).await {
            while let Some(file) = files.next_entry().await.unwrap() {
                if file.path().extension().is_some_and(|e| e == "jsonl") {
                    rows.extend(
                        tokio::fs::read_to_string(file.path())
                            .await
                            .unwrap()
                            .lines()
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| serde_json::from_str::<Value>(s).unwrap()),
                    );
                }
            }
        }
        rows
    }
}
async fn eventually(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native watched Doubao pipeline did not settle");
}
fn delivered_content(rows: &[Value], spans: &[ReadableSpan]) -> String {
    serde_json::to_string(rows).unwrap()
        + &loongsuite_pilot::flushers::create_readable_span_to_otlp_span_json_array(spans)
            .join("\n")
}
fn kind(span: &ReadableSpan) -> &str {
    span.attributes
        .get("gen_ai.span.kind")
        .and_then(Value::as_str)
        .unwrap_or("")
}
fn strict_validate(output: &Path) {
    use clap::Parser;
    let cli = ValidatorCli::try_parse_from([
        "native-jsonl-validate",
        "--input-dir",
        output.to_str().unwrap(),
        "--agent-filter",
        "doubao-work",
        "--strict",
        "--format",
        "json",
    ])
    .unwrap();
    assert_eq!(native_jsonl_validator::run(cli.options), 0);
}
#[tokio::test]
async fn native_pipeline_first_output_late_nested_executions_reach_jsonl_and_exact_task_spans_without_child_llms(
) {
    let h = Harness::new("doubao-execution-pipeline").await;
    let f = &h.fixture;
    h.start().await;
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.command("synthetic-turn", 20)
            + &f.command("o_nativeOrg", 3500)
            + &f.first()
            + &f.command("s_nativeLeaf", 4000)
            + &f.line("on_message_session_end", json!({}), 6000)),
    )
    .await;
    eventually(|| h.spans.lock().unwrap().len() == 2).await;
    f.ancestry().await;
    f.execution(
        "00000000-0000-4000-8000-000000000001",
        "s_nativeLeaf",
        4000,
        5000,
        true,
    )
    .await;
    f.execution(
        "00000000-0000-4000-8000-000000000003",
        "o_nativeOrg",
        3500,
        5500,
        false,
    )
    .await;
    eventually(|| h.spans.lock().unwrap().len() == 4).await;
    h.stop().await;
    let rows = h.rows().await;
    assert_eq!(rows.len(), 10);
    assert_eq!(
        rows.iter()
            .map(|r| r["event.id"].to_string())
            .collect::<BTreeSet<_>>()
            .len(),
        10
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r["event.name"] == "agent.input")
            .count(),
        3
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r["gen_ai.turn.start"] == true)
            .count(),
        1
    );
    assert_eq!(
        rows.iter().filter(|r| r["gen_ai.turn.end"] == true).count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(
                |r| r["loongsuite.doubao_work.local_execution_phase"] == "start"
                    && r["event.name"] == "other"
            )
            .count(),
        2
    );
    strict_validate(&f.root.path().join("output"));
    let spans = h.spans.lock().unwrap().clone();
    let root = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
    let child = spans
        .iter()
        .find(|s| {
            s.attributes
                .get("loongsuite.doubao_work.native_execution_id")
                == Some(&json!("00000000-0000-4000-8000-000000000001"))
        })
        .unwrap();
    let parent = spans
        .iter()
        .find(|s| {
            s.attributes
                .get("loongsuite.doubao_work.native_execution_id")
                == Some(&json!("00000000-0000-4000-8000-000000000003"))
        })
        .unwrap();
    assert_eq!(kind(child), "TASK");
    assert_eq!(
        child.parent_span_id.as_deref(),
        Some(parent.span_id.as_str())
    );
    assert_eq!(
        parent.parent_span_id.as_deref(),
        Some(root.span_id.as_str())
    );
    assert_eq!(parent.links[0]["context"]["spanId"], root.span_id);
    assert_eq!(child.trace_id, root.trace_id);
    assert_eq!(
        child.attributes["gen_ai.agent.name"],
        root.attributes["gen_ai.agent.name"]
    );
    assert_eq!(
        child.start_time,
        [
            (f.epoch + 4000) / 1000,
            ((f.epoch + 4000) % 1000) * 1_000_000
        ]
    );
    assert_eq!(
        child.attributes["loongsuite.doubao_work.parent_resolution"],
        "same_query_native_execution"
    );
    assert_eq!(spans.iter().filter(|s| kind(s) == "ENTRY").count(), 1);
    assert!(!spans
        .iter()
        .any(|s| matches!(kind(s), "STEP" | "LLM" | "TOOL")));
    assert!(!delivered_content(&rows, &spans).contains("SYNTHETIC_PRIVATE"));
    h.output.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_pipeline_watched_metadata_keeps_configured_identity_masking_and_log_only_child_tools(
) {
    let h = Harness::new("doubao-integration").await;
    let f = &h.fixture;
    h.start().await;
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.command("synthetic-turn", 20)
            + &f.line(
                "on_message_session_end",
                json!({"session_success":"1","agent_error":"0",
            "content":"SYNTHETIC_CAPACITY_NOTICE","prompt":"SYNTHETIC_SECRET_PROMPT",
            "error_message":"SYNTHETIC_SECRET_ERROR"}),
                3000,
            )),
    )
    .await;
    eventually(|| h.spans.lock().unwrap().len() == 2).await;
    f.ancestry().await;
    f.append(&(f.command("s_nativeLeaf",4000)+&f.command("o_nativeOrg",4050)
        +&f.tool(json!({"agent_id":"s_nativeLeaf","tcid":"pipeline-child","private":"SYNTHETIC_SECRET"}),4100)
        +&f.tool(json!({"toolCallID":"pipeline-child","phase":"execution_settled","status":"success"}),4200))).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while h.rows().await.len() != 5 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    h.stop().await;
    let rows = h.rows().await;
    assert_eq!(rows.len(), 5);
    assert_eq!(
        rows.iter().filter(|r| r["event.name"] == "other").count(),
        2
    );
    assert!(rows.iter().all(|r| r["user.id"] == "synthetic-employee"));
    assert!(rows
        .iter()
        .all(|r| r["loongsuite.doubao_work.business_outcome"] == "unknown"));
    assert_eq!(
        rows.iter()
            .filter(|r| r["gen_ai.turn.start"] == true)
            .count(),
        1
    );
    assert_eq!(
        rows.iter().filter(|r| r["gen_ai.turn.end"] == true).count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r["event.name"] == "tool.call")
            .count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r["loongsuite.doubao_work.trace_role"] == "log_only")
            .count(),
        2
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["event.id"].to_string())
            .collect::<BTreeSet<_>>()
            .len(),
        5
    );
    let spans = h.spans.lock().unwrap().clone();
    assert_eq!(spans.iter().filter(|s| kind(s) == "AGENT").count(), 1);
    assert!(spans.iter().all(|s| s.status["code"] == 0));
    let text = delivered_content(&rows, &spans);
    assert!(!text.contains("SYNTHETIC_SECRET"));
    assert!(!text.contains("SYNTHETIC_CAPACITY_NOTICE"));
    h.output.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_pipeline_exact_current_io_and_decoded_tool_content_are_masked_before_jsonl_and_tool_span_projection(
) {
    let h = Harness::new("doubao-content").await;
    let f = &h.fixture;
    let secret = format!("sk-{}", "x".repeat(24));
    f.native_actor("m_nativeMain",&[
        json!({"role":"assistant","tool_calls":[{"id":"current-call","function":{"name":"Read","arguments":json!({"file_path":"synthetic-file","key":secret}).to_string()}}]}),
        json!({"role":"tool","tool_call_id":"current-call","content":format!("CURRENT_TOOL {secret}")}),
        json!({"role":"assistant","content":format!("CURRENT_ANSWER {secret}")}),
    ],Some(&format!("CURRENT_INPUT {secret}"))).await;
    h.start().await;
    f.append(&(f.line("on_message_session_start",json!({}),10)
        +&f.tool(json!({"tcid":"current-call","name":"Read"}),100)
        +&f.tool(json!({"toolCallID":"current-call","name":"Read","phase":"execution_settled","status":"success"}),200)
        +&f.line("on_message_session_end",json!({}),3000))).await;
    eventually(|| h.spans.lock().unwrap().len() == 7).await;
    h.stop().await;
    let rows = h.rows().await;
    let spans = h.spans.lock().unwrap().clone();
    let agent = spans.iter().find(|s| kind(s) == "AGENT").unwrap();
    assert!(agent.attributes["gen_ai.input.messages"]
        .as_str()
        .unwrap()
        .contains("CURRENT_INPUT"));
    assert!(agent.attributes["gen_ai.output.messages"]
        .as_str()
        .unwrap()
        .contains("CURRENT_ANSWER"));
    let tool = spans.iter().find(|s| kind(s) == "TOOL").unwrap();
    let step = spans
        .iter()
        .find(|s| Some(s.span_id.as_str()) == tool.parent_span_id.as_deref())
        .unwrap();
    assert_eq!(kind(step), "STEP");
    assert_eq!(step.parent_span_id.as_deref(), Some(agent.span_id.as_str()));
    let llms: Vec<_> = spans.iter().filter(|s| kind(s) == "LLM").collect();
    assert_eq!(llms.len(), 2);
    assert!(llms[0].attributes["gen_ai.input.messages"]
        .as_str()
        .unwrap()
        .contains("CURRENT_INPUT"));
    assert!(llms[1].attributes["gen_ai.input.messages"]
        .as_str()
        .unwrap()
        .contains("CURRENT_TOOL"));
    assert!(llms[1].attributes["gen_ai.output.messages"]
        .as_str()
        .unwrap()
        .contains("CURRENT_ANSWER"));
    assert!(tool.attributes["gen_ai.tool.call.result"]
        .as_str()
        .unwrap()
        .contains("CURRENT_TOOL"));
    assert!(tool.attributes["gen_ai.tool.call.arguments"]
        .as_str()
        .unwrap()
        .contains("synthetic-file"));
    let call = rows
        .iter()
        .find(|r| r["event.name"] == "tool.call")
        .unwrap();
    assert!(call["gen_ai.tool.call.arguments"].is_object());
    assert_eq!(
        call["gen_ai.tool.call.arguments"]["file_path"],
        "synthetic-file"
    );
    assert!(!delivered_content(&rows, &spans).contains(&secret));
    h.output.shutdown().await.unwrap();
}
