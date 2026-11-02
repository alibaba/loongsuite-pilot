use crate::host::{repo, run_host, Records};
use loongsuite_pilot::{
    checkpoints::StateStore,
    core::{CorrelationStore, InputManager, LiveInput, TraceLinker},
    flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter},
    inputs::openclaw_plugin::{OpenClawPluginInput, OpenClawPluginInputOptions},
    types::AgentActivityEntry,
    utils::content_hash,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
    time::Duration,
};
fn setup(root: &Path) -> (Arc<OpenClawPluginInput>, Arc<InputManager>, Arc<Records>) {
    let input = Arc::new(OpenClawPluginInput::new(OpenClawPluginInputOptions {
        state_store: Arc::new(StateStore::new(root.join("state.json"))),
        log_dir: None,
        log_prefix: None,
        poll_interval_ms: Some(60_000),
        data_dir: Some(root.to_string_lossy().into_owned()),
    }));
    let manager = Arc::new(InputManager::new());
    let sink = Arc::new(Records::default());
    manager.set_flusher(sink.clone());
    let running = input.clone();
    let start = input.clone();
    let stop = input.clone();
    manager.register_input(LiveInput::new(
        input.id(),
        "openclaw",
        "hook-jsonl",
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
    let bound = manager.clone();
    let id = input.id().to_owned();
    input.on_entries(move |batch| bound.bind_entries(&id, batch.to_vec()));
    (input, manager, sink)
}
async fn collect(input: &OpenClawPluginInput, manager: &InputManager) {
    manager.start_input(input.id()).await;
    manager.stop_input(input.id()).await;
}
fn convert(rows: &[AgentActivityEntry]) -> loongsuite_pilot::flushers::ConvertResult {
    let records: Vec<_> = rows
        .iter()
        .filter(|r| serde_json::to_value(r).unwrap()["event.name"] != "agent.input")
        .cloned()
        .collect();
    GenAiEventLogConverter
        .convert(
            &records,
            &ConvertOptions {
                strict: false,
                passthrough_keys: vec![],
            },
        )
        .unwrap()
}
#[tokio::test]
async fn history_openclaw_l25_actual_node_plugin_both_callback_orders_to_native_input_and_spans() {
    for order in ["end-first", "message-first"] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("config.json"),json!({"userId":"plugin-config-user","agents":{"openclaw":{"captureMessageContent":true}}}).to_string()).unwrap();
        run_host(
            "node",
            &[
                repo()
                    .join("tests/host-plugin-contracts/drivers/openclaw.mjs")
                    .to_string_lossy()
                    .into_owned(),
                order.into(),
            ],
            root.path(),
        )
        .await;
        let (input, manager, sink) = setup(root.path());
        manager.set_configured_user_id("collector-config-user");
        manager.set_user_id("collector-fallback-user");
        collect(&input, &manager).await;
        let batches = sink.0.lock().unwrap().clone();
        assert_eq!(batches.len(), 1);
        let all = &batches[0];
        let rows: Vec<Value> = all
            .iter()
            .map(|r| serde_json::to_value(r).unwrap())
            .collect();
        assert!(rows.len() > 10);
        assert!(rows
            .iter()
            .all(|r| r["gen_ai.agent.type"] == "openclaw" && r["user.id"] == "channel-sender"));
        assert!(rows
            .iter()
            .all(|r| r["agent.openclaw.session_key"].is_string()));
        assert_eq!(
            rows.iter()
                .map(|r| r["agent.openclaw.session_key"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert!(rows
            .iter()
            .all(|r| r.get("agent.pilot.invocation.user.id").is_none()));
        let run = rows
            .iter()
            .find(|r| r["agent.openclaw.hook"] == "before_agent_run")
            .unwrap();
        assert_eq!(
            run["gen_ai.input.messages_delta"].as_array().unwrap().len(),
            1
        );
        let terminal = rows
            .iter()
            .find(|r| r["agent.openclaw.hook"] == "llm_output")
            .unwrap();
        for (key,expected) in json!({"event.name":"other","agent.openclaw.aggregate_usage.input_tokens":27452,
        "agent.openclaw.aggregate_usage.output_tokens":326,"agent.openclaw.aggregate_usage.total_tokens":27778,
        "agent.openclaw.per_call_usage.count":2,"gen_ai.turn.end":true}).as_object().unwrap(){assert_eq!(&terminal[key],expected,"{key}");}
        let starts: Vec<_> = rows
            .iter()
            .filter(|r| r["gen_ai.turn.start"] == true)
            .collect();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["event.name"], "other");
        assert_eq!(
            rows.iter().filter(|r| r["gen_ai.turn.end"] == true).count(),
            1
        );
        assert!(terminal.get("gen_ai.usage.input_tokens").is_none());
        assert!(terminal.get("gen_ai.output.messages").is_none());
        let responses: Vec<_> = rows
            .iter()
            .filter(|r| r["event.name"] == "llm.response")
            .collect();
        assert_eq!(responses.len(), 2);
        let usage: Vec<_> = responses
            .iter()
            .map(|r| {
                json!([
                    r["gen_ai.usage.input_tokens"],
                    r["gen_ai.usage.output_tokens"],
                    r["gen_ai.response.finish_reasons"]
                ])
            })
            .collect();
        assert_eq!(
            usage,
            vec![
                json!([13578, 129, ["tool_calls"]]),
                json!([13874, 197, ["stop"]])
            ]
        );
        let converted = convert(all);
        assert!(converted.warnings.is_empty(), "{:?}", converted.warnings);
        let spans = &converted.spans;
        let counts = spans.iter().fold(HashMap::new(), |mut c, s| {
            *c.entry(s.attributes["gen_ai.span.kind"].as_str().unwrap())
                .or_insert(0) += 1;
            c
        });
        assert_eq!(
            counts,
            HashMap::from([
                ("ENTRY", 1),
                ("AGENT", 1),
                ("STEP", 2),
                ("LLM", 2),
                ("TOOL", 2)
            ])
        );
        assert_eq!(
            spans
                .iter()
                .map(|s| &s.trace_id)
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert!(spans
            .iter()
            .all(|s| s.attributes["gen_ai.user.id"] == "channel-sender"));
        let llms: Vec<_> = spans
            .iter()
            .filter(|s| s.attributes["gen_ai.span.kind"] == "LLM")
            .collect();
        assert_eq!(
            llms.iter()
                .map(|s| s.attributes["gen_ai.response.time_to_first_token"].clone())
                .collect::<Vec<_>>(),
            [json!(50_000_000), json!(50_000_000)]
        );
        let usage: Vec<_> = llms
            .iter()
            .map(|s| {
                json!([
                    s.attributes["gen_ai.usage.input_tokens"],
                    s.attributes["gen_ai.usage.output_tokens"],
                    s.attributes["gen_ai.usage.cache_read.input_tokens"],
                    s.attributes["gen_ai.usage.total_tokens"],
                    s.attributes["gen_ai.response.finish_reasons"]
                ])
            })
            .collect();
        assert_eq!(
            usage,
            vec![
                json!([13578, 129, 12672, 13707, ["tool_calls"]]),
                json!([13874, 197, 12672, 14071, ["stop"]])
            ]
        );
        assert!(llms.iter().all(|s| s.attributes["gen_ai.response.id"]
            .as_str()
            .unwrap()
            .starts_with("chatcmpl-")));
        let output: Value = serde_json::from_str(
            llms[1].attributes["gen_ai.output.messages"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let parts = output[0]["parts"].as_array().unwrap();
        assert_eq!(
            parts
                .iter()
                .map(Value::to_string)
                .collect::<HashSet<_>>()
                .len(),
            parts.len()
        );
        let second: Value = serde_json::from_str(
            llms[1].attributes["gen_ai.input.messages"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            second
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "tool")
                .count(),
            2
        );
        let agent = spans
            .iter()
            .find(|s| s.attributes["gen_ai.span.kind"] == "AGENT")
            .unwrap();
        for (key, value) in [
            ("gen_ai.usage.input_tokens", 27452),
            ("gen_ai.usage.output_tokens", 326),
            ("gen_ai.usage.total_tokens", 27778),
        ] {
            assert_eq!(agent.attributes[key], value);
        }
        let input: Value =
            serde_json::from_str(agent.attributes["gen_ai.input.messages"].as_str().unwrap())
                .unwrap();
        assert_eq!(input.as_array().unwrap().len(), 1);
        assert_eq!(input[0]["role"], "user");
    }
}
#[tokio::test]
async fn main_openclaw_l28_real_plugin_two_turns_links_each_trace_under_both_live_poll_boundaries()
{
    for split in [false, true] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("config.json"), "{}").unwrap();
        let correlate = root.path().join("acp-correlate");
        std::fs::create_dir(&correlate).unwrap();
        let turns = [
            ("Inspect the first project", "1".repeat(32), "1".repeat(16)),
            ("Inspect the second project", "2".repeat(32), "2".repeat(16)),
        ];
        std::fs::write(correlate.join("native-openclaw-session.jsonl"),turns.iter().map(|(prompt,trace,parent)|json!({"type":"turn","sessionId":"native-openclaw-session","contentHash":content_hash(prompt),"contentPrefix":prompt,"traceparent":format!("00-{trace}-{parent}-01")}).to_string()).collect::<Vec<_>>().join("\n")+"\n").unwrap();
        let (input, manager, sink) = setup(root.path());
        manager.set_trace_linker(Arc::new(TraceLinker::with_retry(
            CorrelationStore::new(&correlate),
            0,
            0,
        )));
        let dir = root.path().to_owned();
        let mode = if split {
            "upstream-split"
        } else {
            "upstream-whole"
        };
        let child = tokio::spawn(async move {
            run_host(
                "node",
                &[
                    repo()
                        .join("tests/host-plugin-contracts/drivers/openclaw.mjs")
                        .to_string_lossy()
                        .into_owned(),
                    mode.into(),
                ],
                &dir,
            )
            .await;
        });
        if split {
            for index in 0..6 {
                let ready = root.path().join(format!("checkpoint-{index}.ready"));
                tokio::time::timeout(Duration::from_secs(20), async {
                    while !ready.exists() {
                        assert!(
                            !child.is_finished(),
                            "host exited before checkpoint {index}"
                        );
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                let marker: Value =
                    serde_json::from_str(&std::fs::read_to_string(&ready).unwrap()).unwrap();
                let before = sink.0.lock().unwrap().len();
                collect(&input, &manager).await;
                if marker["type"] == "redundant-model-hook" {
                    assert_eq!(sink.0.lock().unwrap().len(), before);
                }
                std::fs::write(root.path().join(format!("checkpoint-{index}.resume")), "").unwrap();
            }
        }
        child.await.unwrap();
        if !split {
            collect(&input, &manager).await;
        }
        manager.stop_input(input.id()).await;
        let all: Vec<_> = sink.0.lock().unwrap().iter().flatten().cloned().collect();
        let rows: Vec<_> = all
            .iter()
            .map(|r| serde_json::to_value(r).unwrap())
            .collect();
        assert!(!rows
            .iter()
            .any(|r| r["agent.openclaw.hook"] == "before_model_resolve"));
        for (index, (_, trace, parent)) in turns.iter().enumerate() {
            let id = format!("upstream-run-{index}");
            let turn: Vec<_> = rows.iter().filter(|r| r["gen_ai.turn.id"] == id).collect();
            assert!(turn.len() > 10);
            assert!(turn.iter().all(|r| r["trace_id"] == *trace));
            let input: Vec<_> = turn
                .iter()
                .filter(|r| r["agent.openclaw.hook"] == "before_agent_run")
                .collect();
            assert_eq!(input.len(), 2);
            assert!(input.iter().all(|r| r["parent_span_id"] == *parent));
            assert_eq!(
                turn.iter()
                    .filter(|r| r["gen_ai.turn.start"] == true)
                    .count(),
                1
            );
            let records: Vec<_> = all
                .iter()
                .filter(|r| r.turn_id.as_deref() == Some(&id))
                .cloned()
                .collect();
            let converted = convert(&records);
            assert!(converted.warnings.is_empty(), "{:?}", converted.warnings);
            assert!(!converted.spans.is_empty());
            assert!(converted.spans.iter().all(|s| s.trace_id == *trace));
            assert_eq!(
                converted
                    .spans
                    .iter()
                    .find(|s| s.attributes["gen_ai.span.kind"] == "ENTRY")
                    .unwrap()
                    .parent_span_id
                    .as_deref(),
                Some(parent.as_str())
            );
        }
    }
}
