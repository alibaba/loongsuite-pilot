use crate::host::{repo, run_host, Records};
use loongsuite_pilot::{
    checkpoints::StateStore,
    core::{InputManager, LiveInput},
    flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter},
    inputs::{hermes_log::HermesLogInput, rest_support::SessionInputOptions},
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
fn definition() -> Value {
    json!({"type":"function","name":"terminal","description":"Run a command.",
    "parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}})
}
const SYSTEM: &str = "You are Hermes, a meticulous personal assistant.";
#[tokio::test]
async fn history_hermes_l46_real_python_plugin_input_manager_and_seven_span_tree() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("config.json"),
        json!({"userId":"plugin-config-user",
        "agents":{"hermes-agent":{"captureMessageContent":true}}})
        .to_string(),
    )
    .unwrap();
    let fixture = repo().join("tests/fixtures/hermes-agent/real-tool-turn-hooks.jsonl");
    let mut events: Vec<Value> = std::fs::read_to_string(fixture)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let def = definition();
    for e in &mut events {
        if e["hook"] == "pre_api_request" {
            e["payload"]["request"] = json!({"method":"POST","body":{
        "model":"qwen3-coder-plus","messages":[{"role":"system","content":SYSTEM}],"tools":[{"type":"function","function":{
            "name":def["name"],"description":def["description"],"parameters":def["parameters"]}}]}});
        }
    }
    let observer = root.path().join("observer.jsonl");
    std::fs::write(
        &observer,
        events
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    run_host(
        "python3",
        &[
            repo()
                .join("tests/host-plugin-contracts/drivers/hermes.py")
                .to_string_lossy()
                .into_owned(),
            repo()
                .join("assets/plugins/hermes-agent/loongsuite-pilot/__init__.py")
                .to_string_lossy()
                .into_owned(),
            observer.to_string_lossy().into_owned(),
        ],
        root.path(),
    )
    .await;
    let input = Arc::new(HermesLogInput::new(SessionInputOptions {
        state_store: Arc::new(StateStore::new(root.path().join("state.json"))),
        session_dir: Some(
            root.path()
                .join("logs/hermes-agent")
                .to_string_lossy()
                .into_owned(),
        ),
        file_pattern: None,
        poll_interval_ms: Some(60_000),
    }));
    let manager = Arc::new(InputManager::new());
    manager.set_configured_user_id("collector-config-user");
    manager.set_user_id("collector-fallback-user");
    let sink = Arc::new(Records::default());
    manager.set_flusher(sink.clone());
    let running = input.clone();
    let start = input.clone();
    let stop = input.clone();
    manager.register_input(LiveInput::new(
        input.id(),
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
    let bound = manager.clone();
    let id = input.id().to_owned();
    input.on_entries(move |batch| bound.bind_entries(&id, batch.to_vec()));
    manager.start_input(input.id()).await;
    manager.stop_input(input.id()).await;
    let batches = sink.0.lock().unwrap().clone();
    assert_eq!(batches.len(), 1);
    let all = &batches[0];
    let values: Vec<Value> = all
        .iter()
        .map(|r| serde_json::to_value(r).unwrap())
        .collect();
    assert_eq!(
        values
            .iter()
            .filter(|v| v["gen_ai.turn.end"] == true)
            .count(),
        1
    );
    assert_eq!(
        values
            .iter()
            .filter(|v| v["agent.hermes.hook"] == "turn_start" && v["event.name"] == "other")
            .count(),
        1
    );
    assert_eq!(
        values
            .iter()
            .filter(|v| v["event.name"] == "agent.input")
            .count(),
        1
    );
    let mut records: Vec<_> = values
        .iter()
        .filter(|v| v["event.name"] != "other" && v["event.name"] != "agent.input")
        .collect();
    records.sort_by_key(|v| {
        v["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
    });
    assert_eq!(
        records
            .iter()
            .map(|v| v["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "llm.request",
            "llm.response"
        ]
    );
    assert!(records.iter().all(
        |v| v["user.id"] == "fixture-user" && v.get("agent.pilot.invocation.user.id").is_none()
    ));
    assert_eq!(
        records
            .iter()
            .filter(|v| v["event.name"] == "llm.response")
            .map(|v| v["gen_ai.response.time_to_first_token"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [125_000_000, 250_000_000]
    );
    let requests: Vec<_> = records
        .iter()
        .filter(|v| v["event.name"] == "llm.request")
        .collect();
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert_eq!(
            request["gen_ai.system_instructions"],
            json!([{"type":"text","content":SYSTEM}])
        );
        assert_eq!(request["gen_ai.tool.definitions"], json!([definition()]));
        for key in ["gen_ai.input.messages", "gen_ai.input.messages_delta"] {
            assert!(!request[key]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["role"] == "system")));
        }
    }
    let rows: Vec<_> = all
        .iter()
        .filter(|r| serde_json::to_value(r).unwrap()["event.name"] != "agent.input")
        .cloned()
        .collect();
    let converted = GenAiEventLogConverter
        .convert(
            &rows,
            &ConvertOptions {
                strict: false,
                passthrough_keys: vec![],
            },
        )
        .unwrap();
    assert!(converted.warnings.is_empty(), "{:?}", converted.warnings);
    assert_eq!(converted.spans.len(), 7);
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
            ("TOOL", 1)
        ])
    );
    assert_eq!(
        spans
            .iter()
            .map(|s| &s.trace_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        1
    );
    assert!(spans
        .iter()
        .all(|s| s.attributes["gen_ai.user.id"] == "fixture-user"));
    for s in spans {
        let kind = s.attributes["gen_ai.span.kind"].as_str().unwrap();
        let parent = s
            .parent_span_id
            .as_ref()
            .and_then(|id| spans.iter().find(|p| &p.span_id == id))
            .map(|p| p.attributes["gen_ai.span.kind"].as_str().unwrap());
        match kind {
            "AGENT" => assert_eq!(parent, Some("ENTRY")),
            "STEP" => assert_eq!(parent, Some("AGENT")),
            "LLM" | "TOOL" => assert_eq!(parent, Some("STEP")),
            _ => {}
        }
        if matches!(kind, "ENTRY" | "AGENT" | "LLM") {
            let messages: Value =
                serde_json::from_str(s.attributes["gen_ai.input.messages"].as_str().unwrap())
                    .unwrap();
            assert_eq!(messages[0]["role"], "user");
            assert!(!messages
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["role"] == "system"));
            if kind == "ENTRY" {
                assert!(!s.attributes.contains_key("gen_ai.system_instructions"));
            } else {
                assert!(s.attributes["gen_ai.system_instructions"]
                    .as_str()
                    .unwrap()
                    .contains(SYSTEM));
                let tools: Value =
                    serde_json::from_str(s.attributes["gen_ai.tool.definitions"].as_str().unwrap())
                        .unwrap();
                assert_eq!(tools, json!([definition()]));
            }
        }
    }
    let mut ttft: Vec<_> = spans
        .iter()
        .filter(|s| s.attributes["gen_ai.span.kind"] == "LLM")
        .map(|s| {
            s.attributes["gen_ai.response.time_to_first_token"]
                .as_u64()
                .unwrap()
        })
        .collect();
    ttft.sort();
    assert_eq!(ttft, [125_000_000, 250_000_000]);
}
