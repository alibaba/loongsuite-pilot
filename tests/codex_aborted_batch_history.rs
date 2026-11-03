//! Exact main aborted-child batch matrices through real Native input, manager,
//! checkpoint hold, turn journal and OTLP converter. No JS collector is executed.
use async_trait::async_trait;
use loongsuite_pilot::{
    checkpoints::StateStore,
    flushers::{
        BaseFlusher, CodexTurnJournal, FlushError, OtlpTraceFlusher, ReadableSpan, TraceExporter,
    },
    inputs::codex_transcript::{CodexTranscriptInput, CodexTranscriptInputOptions},
    normalization::TurnBoundaryProcessor,
    types::AgentActivityEntry,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Default)]
struct Capture(Mutex<Vec<ReadableSpan>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, rows: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(rows);
        Ok(())
    }
    async fn shutdown(&self) {}
}
struct Audit {
    trace: Arc<OtlpTraceFlusher>,
    journal: Arc<CodexTurnJournal>,
    capture: Arc<Capture>,
    batches: Mutex<Vec<Vec<AgentActivityEntry>>>,
}
#[async_trait]
impl BaseFlusher for Audit {
    fn name(&self) -> &str {
        "aborted-terminal-audit"
    }
    async fn send(&self, e: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.send_batch(vec![e], None).await
    }
    async fn send_batch(
        &self,
        rows: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        assert!(!rows.is_empty());
        let terminal = rows.iter().any(|e| e.turn_end == Some(true));
        if !terminal {
            assert!(
                self.capture.0.lock().unwrap().is_empty(),
                "export before native child terminal"
            );
            assert!(
                !self.journal.is_acknowledged(&rows[0]).await.unwrap(),
                "ACK before native child terminal"
            );
        }
        self.batches.lock().unwrap().push(rows.clone());
        self.trace.send_batch(rows.clone(), None).await?;
        if !terminal {
            assert!(self.capture.0.lock().unwrap().is_empty());
            assert!(!self.journal.is_acknowledged(&rows[0]).await.unwrap());
        }
        Ok(())
    }
    async fn flush(&self) -> Result<(), FlushError> {
        self.trace.flush().await
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        self.trace.shutdown().await
    }
}
fn record(second: f64, kind: &str, payload: Value) -> String {
    let epoch = chrono::DateTime::parse_from_rfc3339("2026-08-07T02:00:00Z")
        .unwrap()
        .timestamp_millis();
    let at = chrono::DateTime::from_timestamp_millis(epoch + (second * 1000.0).round() as i64)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    json!({"timestamp":at,"type":kind,"payload":payload}).to_string()
}
async fn scenario(tools: usize, output_size: usize) {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    let wakes = root.path().join("wakeups");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&wakes).unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    let input = Arc::new(CodexTranscriptInput::new(CodexTranscriptInputOptions {
        state_store: store.clone(),
        session_dir: Some(sessions.to_string_lossy().into_owned()),
        wakeup_dir: Some(wakes.to_string_lossy().into_owned()),
        span_context_dir: Some(root.path().join("contexts").to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
        multimodal: None,
    }));
    let journal = Arc::new(CodexTurnJournal::new(root.path().join("journal")));
    let capture = Arc::new(Capture::default());
    let sink = capture.clone();
    let trace = Arc::new(
        OtlpTraceFlusher::with_parts(
            serde_json::from_value(json!({
             "enabled":true,"serviceName":"aborted-child-test","protocol":"http/protobuf",
             "endpoints":[{"name":"test","endpoint":"http://unused:4318"}],"dataDir":root.path()
            }))
            .unwrap(),
            None,
            Some(Arc::new(move |_| sink.clone())),
            None,
        )
        .unwrap()
        .with_codex_journal(journal.clone(), Ok),
    );
    let audit = Arc::new(Audit {
        trace: trace.clone(),
        journal: journal.clone(),
        capture: capture.clone(),
        batches: Mutex::new(Vec::new()),
    });
    // Match the original's direct serial production flusher queue rather than
    // adding manager/masking work absent from that particular source contract.
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<(
        Vec<AgentActivityEntry>,
        loongsuite_pilot::checkpoints::CheckpointOutputHold,
    )>();
    let queue_audit = audit.clone();
    let worker = tokio::spawn(async move {
        let mut boundaries = TurnBoundaryProcessor::new();
        while let Some((mut rows, hold)) = receiver.recv().await {
            boundaries.enrich(&mut rows);
            let result = queue_audit
                .send_batch(rows, None)
                .await
                .map_err(|e| e.to_string());
            hold.finish(result);
        }
    });
    let send = sender.clone();
    let saved = store.clone();
    input.on_entries(move |rows| {
        let hold = saved.begin_output();
        send.send((rows.to_vec(), hold)).unwrap();
    });
    trace.start().await.unwrap();
    input.start().await.unwrap();
    input.run_cycle().await;
    let session = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let turn = "aborted-child";
    let transcript = sessions.join(format!("rollout-{session}.jsonl"));
    let mut records = vec![
        record(
            0.0,
            "session_meta",
            json!({"id":session,"timestamp":"2026-08-07T02:00:00Z","model_provider":"openai","thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","depth":1}}}}),
        ),
        record(
            1.0,
            "turn_context",
            json!({"turn_id":turn,"model":"gpt-test"}),
        ),
        record(
            1.01,
            "event_msg",
            json!({"type":"task_started","turn_id":turn}),
        ),
        record(
            1.02,
            "response_item",
            json!({"type":"agent_message","author":"/root","recipient":"/root/child","internal_chat_message_metadata_passthrough":{"turn_id":turn},"content":[{"type":"input_text","text":"perform the delegated work"}]}),
        ),
    ];
    for index in 0..tools {
        records.push(record(2.0+index as f64*0.01,"response_item",json!({"type":"function_call","call_id":format!("tool-{index}"),"name":"exec_command","arguments":json!({"cmd":format!("echo marker-{index}")}).to_string()})));
        records.push(record(4.0+index as f64*0.01,"response_item",json!({"type":"function_call_output","call_id":format!("tool-{index}"),"output":format!("marker-{index}:{}", "x".repeat(output_size))})));
    }
    records.push(record(7.0,"event_msg",json!({"type":"token_count","info":{"last_token_usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"cached_input_tokens":0}}})));
    records.push(record(
        8.0,
        "event_msg",
        json!({"type":"turn_aborted","turn_id":turn,"reason":"interrupted"}),
    ));
    std::fs::write(&transcript, records.join("\n") + "\n").unwrap();
    std::fs::write(
        wakes.join(format!("{session}.json")),
        json!({
         "session_id":session,"turn_id":turn,"initial_turn_id":turn,"transcript_path":transcript,
         "hook_event":"subagent-stop","received_at":chrono::Utc::now().to_rfc3339(),
        })
        .to_string(),
    )
    .unwrap();
    input.run_cycle().await;
    store.save().await.unwrap();
    let batches = audit.batches.lock().unwrap().clone();
    assert!(batches.len() > 1, "must cross original batch boundary");
    assert!(batches
        .iter()
        .take(batches.len() - 1)
        .flatten()
        .all(|e| e.turn_end != Some(true)));
    assert_eq!(
        batches
            .iter()
            .flatten()
            .filter(|e| e.turn_end == Some(true))
            .count(),
        1
    );
    assert!(batches.iter().flatten().all(|e| e.session_id == session));
    let spans = capture.0.lock().unwrap().clone();
    let actual: BTreeSet<_> = spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
        .map(|s| {
            s.attributes["gen_ai.tool.call.id"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(actual, (0..tools).map(|i| format!("tool-{i}")).collect());
    assert_eq!(
        spans
            .iter()
            .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
            .count(),
        tools
    );
    assert!(journal.is_acknowledged(&batches[0][0]).await.unwrap());
    let markers = std::fs::read_dir(root.path().join("journal"))
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("codex-done-")
        })
        .count();
    assert_eq!(markers, 1, "exactly one durable acknowledged child turn");
    input.stop().await.unwrap();
    drop(input);
    drop(sender);
    worker.await.unwrap();
    trace.shutdown().await.unwrap();
}
// Original Vitest it.each parameter cases run sequentially in this file.
static ORIGINAL_CASE_ORDER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[tokio::test]
async fn native_aborted_child_130_tools_cross_256_entries_without_early_export_or_ack() {
    let _case = ORIGINAL_CASE_ORDER.lock().await;
    tokio::time::timeout(Duration::from_secs(15), scenario(130, 10))
        .await
        .expect("original project15s per expanded case budget");
}
#[tokio::test]
async fn native_aborted_child_three_large_results_cross_one_mib_without_early_export_or_ack() {
    let _case = ORIGINAL_CASE_ORDER.lock().await;
    tokio::time::timeout(Duration::from_secs(15), scenario(3, 600_000))
        .await
        .expect("original project15s per expanded case budget");
}
