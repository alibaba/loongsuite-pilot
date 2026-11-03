//! Exact main Python producers and original delay/repeated-prompt matrices,
//! followed by the actual Native session input, manager and upstream linker.
use crate::{
    contracts::{flusher, kind},
    host::{repo, run_host_output, Records},
};
use loongsuite_pilot::{
    checkpoints::StateStore,
    core::{CorrelationStore, InputManager, LiveInput, TraceLinker},
    flushers::{
        BaseFlusher, ConvertOptions, EventLogConverter, GenAiEventLogConverter, MultiFlusher,
        ReadableSpan,
    },
    inputs::{hermes_log::HermesLogInput, rest_support::SessionInputOptions},
    types::AgentActivityEntry,
    utils::content_hash,
};
use serde_json::{json, Value};
use std::{collections::HashSet, io::Write, path::Path, sync::Arc, time::Duration};
fn original() -> Vec<Value> {
    std::fs::read_to_string(repo().join("tests/fixtures/hermes-agent/real-tool-turn-hooks.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn append(file: &Path, rows: &[Value]) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .unwrap();
    for row in rows {
        writeln!(file, "{row}").unwrap();
    }
}
fn tree(spans: &[ReadableSpan], trace: &str, parent: &str, usage: &[[i64; 2]]) {
    assert_eq!(spans.len(), 7);
    assert!(spans.iter().all(|s| s.trace_id == trace));
    assert_eq!(
        spans
            .iter()
            .find(|s| kind(s, "ENTRY"))
            .unwrap()
            .parent_span_id
            .as_deref(),
        Some(parent)
    );
    let actual: Vec<_> = spans
        .iter()
        .filter(|s| kind(s, "LLM"))
        .map(|s| {
            [
                s.attributes["gen_ai.usage.input_tokens"].as_i64().unwrap(),
                s.attributes["gen_ai.usage.output_tokens"].as_i64().unwrap(),
            ]
        })
        .collect();
    assert_eq!(actual, usage);
    let agent = spans.iter().find(|s| kind(s, "AGENT")).unwrap();
    assert_eq!(
        agent.attributes["gen_ai.usage.input_tokens"],
        usage.iter().map(|u| u[0]).sum::<i64>()
    );
    assert_eq!(
        agent.attributes["gen_ai.usage.output_tokens"],
        usage.iter().map(|u| u[1]).sum::<i64>()
    );
}
struct Pipeline {
    input: Arc<HermesLogInput>,
    manager: Arc<InputManager>,
    records: Arc<Records>,
    trace: Arc<loongsuite_pilot::flushers::OtlpTraceFlusher>,
    spans: Arc<crate::contracts::Capture>,
}
impl Pipeline {
    async fn new(root: &Path, session: &Path, correlate: &Path) -> Self {
        let input = Arc::new(HermesLogInput::new(SessionInputOptions {
            state_store: Arc::new(StateStore::new(root.join("native-state.json"))),
            session_dir: Some(session.to_string_lossy().into_owned()),
            file_pattern: None,
            poll_interval_ms: Some(60000),
        }));
        let manager = Arc::new(InputManager::new());
        let records = Arc::new(Records::default());
        let (trace, spans) = flusher(root);
        let trace = Arc::new(trace);
        trace.start().await.unwrap();
        manager.set_flusher(Arc::new(MultiFlusher::new(vec![
            records.clone(),
            trace.clone(),
        ])));
        manager.set_trace_linker(Arc::new(TraceLinker::with_retry(
            CorrelationStore::new(correlate),
            0,
            0,
        )));
        let (running, start, stop) = (input.clone(), input.clone(), input.clone());
        manager.register_input(LiveInput::new(
            "hermes-agent-log",
            "hermes-agent",
            "session",
            move || running.running(),
            move || {
                let input = start.clone();
                Box::pin(async move {
                    input.start().await;
                    Ok(())
                })
            },
            move || {
                let input = stop.clone();
                Box::pin(async move { input.stop().await })
            },
        ));
        let weak = Arc::downgrade(&manager);
        input.on_entries(move |rows| {
            if let Some(m) = weak.upgrade() {
                m.bind_entries("hermes-agent-log", rows.to_vec());
            }
        });
        Self {
            input,
            manager,
            records,
            trace,
            spans,
        }
    }
    async fn cycle(&self) {
        self.manager.start_input(self.input.id()).await;
        self.manager.stop_input(self.input.id()).await;
    }
    fn all(&self) -> Vec<AgentActivityEntry> {
        self.records
            .0
            .lock()
            .unwrap()
            .iter()
            .flatten()
            .cloned()
            .collect()
    }
    async fn close(&self) {
        self.manager.stop_all().await;
        self.trace.shutdown().await.unwrap();
    }
}
async fn delayed(stage: &str, initial: &str) {
    let root = tempfile::tempdir().unwrap();
    let producer = root.path().join("producer");
    let session = root.path().join("collector");
    let correlate = root.path().join("correlate");
    std::fs::create_dir_all(&session).unwrap();
    std::fs::create_dir_all(&correlate).unwrap();
    let fixture = original();
    let prompt = fixture
        .iter()
        .find(|e| e["hook"] == "pre_llm_call")
        .unwrap()["payload"]["user_message"]
        .as_str()
        .unwrap();
    let trace = "1".repeat(32);
    let parent = "2".repeat(16);
    append(
        &correlate.join("fixture-session-001.jsonl"),
        &[
            json!({"type":"turn","contentHash":content_hash(prompt),"traceparent":format!("00-{trace}-{parent}-01")}),
        ],
    );
    run_host_output(
        "python3",
        &[
            "-c".into(),
            include_str!("../drivers/hermes-delayed-original-main.py").into(),
            repo()
                .join("assets/plugins/hermes-agent/loongsuite-pilot/__init__.py")
                .to_string_lossy()
                .into_owned(),
            repo()
                .join("tests/fixtures/hermes-agent/real-tool-turn-hooks.jsonl")
                .to_string_lossy()
                .into_owned(),
            producer.to_string_lossy().into_owned(),
            stage.into(),
            initial.into(),
        ],
        &producer,
        Duration::from_secs(15),
    )
    .await;
    let batches: Vec<Vec<Value>> =
        serde_json::from_slice(&std::fs::read(producer.join("batches.json")).unwrap()).unwrap();
    let source: Vec<_> = batches.iter().flatten().collect();
    assert_eq!(source[0]["agent.hermes.hook"], "turn_start");
    assert_eq!(
        source[0]["agent.pilot.correlation.content_hash"],
        content_hash(prompt)
    );
    assert_eq!(
        source
            .iter()
            .filter(|r| r["agent.hermes.hook"] == "turn_start")
            .count(),
        1
    );
    let pipeline = Pipeline::new(root.path(), &session, &correlate).await;
    for batch in &batches {
        append(&session.join("hermes-agent-delayed.jsonl"), batch);
        pipeline.cycle().await;
    }
    let all = pipeline.all();
    assert!(!all.is_empty());
    assert!(all.iter().all(|e| e.trace_id.as_deref() == Some(&trace)));
    assert_eq!(
        all.iter()
            .map(|e| &e.event_id)
            .collect::<HashSet<_>>()
            .len(),
        all.len()
    );
    let spans = pipeline.spans.0.lock().unwrap().clone();
    tree(&spans, &trace, &parent, &[[1711, 31], [1794, 36]]);
    for request in source.iter().filter(|r| r["event.name"] == "llm.request") {
        let span = spans
            .iter()
            .find(|s| kind(s, "LLM") && s.span_id == request["span_id"].as_str().unwrap())
            .expect("source request span retained");
        let source_time = request["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<i128>()
            .unwrap();
        let start = span.start_time[0] as i128 * 1_000_000_000 + span.start_time[1] as i128;
        assert!(
            (start - source_time).abs() < 1_000_000,
            "original <1ms timestamp tolerance"
        );
        let entry = all
            .iter()
            .find(|e| e.event_id == request["event.id"].as_str().unwrap())
            .unwrap();
        assert!(
            serde_json::to_value(entry).unwrap()["time_unix_nano"] == request["time_unix_nano"]
        );
    }
    pipeline.close().await;
}
#[tokio::test]
async fn main_hermes_delayed_request_or_terminal_input_preserves_upstream_identity_across_all_four_native_poll_matrices(
) {
    for stage in ["request", "terminal"] {
        for initial in ["empty", "missing"] {
            tokio::time::timeout(Duration::from_secs(15), delayed(stage, initial))
                .await
                .expect("original project15s per expanded delayed case");
        }
    }
}
async fn upstream(case: &Value) {
    let root = tempfile::tempdir().unwrap();
    let producer = root.path().join("producer");
    let session = root.path().join("collector");
    let correlate = root.path().join("correlate");
    std::fs::create_dir_all(&session).unwrap();
    std::fs::create_dir_all(&correlate).unwrap();
    let prompt = case["prompt"].as_str().unwrap();
    let turns = case["turns"].as_array().unwrap();
    for turn in turns {
        let mut row = json!({"type":"turn","sessionId":"hermes-native-session","contentHash":content_hash(prompt),
   "traceparent":format!("00-{}-{}-01",turn["trace"].as_str().unwrap(),turn["parent"].as_str().unwrap())});
        if case["input"] != "long-hash-only" {
            row["contentPrefix"] = prompt.into();
        }
        append(&correlate.join("hermes-native-session.jsonl"), &[row]);
    }
    let event_path = root.path().join("events.json");
    std::fs::write(&event_path, case["events"].to_string()).unwrap();
    run_host_output(
        "python3",
        &[
            "-c".into(),
            include_str!("../drivers/hermes-upstream-original-main.py").into(),
            repo()
                .join("assets/plugins/hermes-agent/loongsuite-pilot/__init__.py")
                .to_string_lossy()
                .into_owned(),
            event_path.to_string_lossy().into_owned(),
        ],
        &producer,
        Duration::from_secs(15),
    )
    .await;
    let paths: Vec<_> = std::fs::read_dir(producer.join("logs/hermes-agent"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(paths.len(), 1);
    let source: Vec<Value> = std::fs::read_to_string(&paths[0])
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let pipeline = Pipeline::new(root.path(), &session, &correlate).await;
    let batches: Vec<Vec<Value>> = if case["splitBatches"] == true {
        source.into_iter().map(|e| vec![e]).collect()
    } else {
        vec![source]
    };
    for batch in &batches {
        append(&session.join("hermes-agent-replay.jsonl"), batch);
        pipeline.cycle().await;
    }
    let all = pipeline.all();
    let values: Vec<Value> = all
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    let usage: Vec<_> = case["usage"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            [
                u["prompt_tokens"].as_i64().unwrap(),
                u["output_tokens"].as_i64().unwrap(),
            ]
        })
        .collect();
    for turn in turns {
        let rows: Vec<_> = values
            .iter()
            .filter(|r| r["gen_ai.turn.id"] == turn["id"])
            .collect();
        assert!(!rows.is_empty());
        assert!(rows.iter().all(|r| r["trace_id"] == turn["trace"]));
        let inputs: Vec<_> = rows
            .iter()
            .filter(|r| r["event.name"] == "other" && r["agent.hermes.hook"] == "turn_start")
            .collect();
        assert_eq!(inputs.len(), 1);
        let input = inputs[0];
        assert!(input["parent_span_id"] == turn["parent"]);
        assert_eq!(
            input["agent.pilot.correlation.content_hash"],
            content_hash(prompt)
        );
        let expected = if case["input"] == "long-hash-only" {
            prompt.chars().take(32768).collect::<String>() + "...[truncated]"
        } else {
            prompt.into()
        };
        assert!(
            input["gen_ai.input.messages_delta"][0]["parts"][0]["content"] == expected,
            "original prompt projection mismatch (content withheld)"
        );
        for key in ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"] {
            assert!(input.get(key).is_none());
        }
        for (key, val) in [
            ("event.name", json!("agent.input")),
            ("gen_ai.turn.start", json!(true)),
            ("gen_ai.turn.end", json!(true)),
        ] {
            assert_eq!(rows.iter().filter(|r| r[key] == val).count(), 1, "{key}");
        }
        let entries: Vec<_> = all
            .iter()
            .filter(|e| {
                e.turn_id.as_deref() == turn["id"].as_str()
                    && e.event_name.map(|v| v.as_str()) != Some("agent.input")
            })
            .cloned()
            .collect();
        let converted = GenAiEventLogConverter
            .convert(
                &entries,
                &ConvertOptions {
                    strict: false,
                    passthrough_keys: vec![],
                },
            )
            .unwrap();
        assert!(converted.warnings.is_empty());
        tree(
            &converted.spans,
            turn["trace"].as_str().unwrap(),
            turn["parent"].as_str().unwrap(),
            &usage,
        );
    }
    let spans = pipeline.spans.0.lock().unwrap().clone();
    assert_eq!(spans.len(), 14);
    for turn in turns {
        let rows: Vec<_> = spans
            .iter()
            .filter(|s| s.trace_id == turn["trace"].as_str().unwrap())
            .cloned()
            .collect();
        tree(
            &rows,
            turn["trace"].as_str().unwrap(),
            turn["parent"].as_str().unwrap(),
            &usage,
        );
    }
    pipeline.close().await;
}
#[tokio::test]
async fn main_hermes_repeated_identical_prompts_consume_both_upstream_turns_once_across_all_ten_native_poll_matrices(
) {
    let cases: Value = serde_json::from_str(include_str!(
        "../../fixtures/hermes-upstream-main-original-matrices.json"
    ))
    .unwrap();
    for case in cases["cases"].as_array().unwrap() {
        tokio::time::timeout(Duration::from_secs(15), upstream(case))
            .await
            .expect("original project15s per expanded upstream case");
    }
}
