//! Exact original setupV2 Agent-host callbacks, followed by real Native disk
//! input, masking, preparation, conversion, export and duplicate suppression.
use crate::{
    contracts::{kind, Capture},
    host::{repo, run_host_output},
};
use loongsuite_pilot::{
    checkpoints::StateStore,
    core::InputManager,
    flushers::{
        BaseFlusher, ConvertOptions, ConvertResult, EventLogConverter, GenAiEventLogConverter,
        OtlpTraceFlusher,
    },
    inputs::{opencode_log::OpenCodeLogInput, rest_support::HookInputOptions},
    types::{AgentActivityEntry, MaskConfig, MaskMode, MaskReplacementMode},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Default)]
struct Preparation(Mutex<Vec<Vec<AgentActivityEntry>>>);
impl EventLogConverter for Preparation {
    fn convert(
        &self,
        rows: &[AgentActivityEntry],
        options: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        self.0.lock().unwrap().push(rows.to_vec());
        GenAiEventLogConverter.convert(rows, options)
    }
}
async fn records(root: &Path, index: usize, param: &Value) -> Vec<AgentActivityEntry> {
    let output = run_host_output(
        "node",
        &[
            repo()
                .join("tests/host-plugin-contracts/drivers/opencode-v2-original-main.mjs")
                .to_string_lossy()
                .into_owned(),
            repo()
                .join("assets/plugins/opencode/v2.mjs")
                .to_string_lossy()
                .into_owned(),
            index.to_string(),
            param.to_string(),
        ],
        root,
        Duration::from_secs(15),
    )
    .await;
    let raw: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!raw.is_empty());
    let history = root.join("native-history");
    std::fs::create_dir_all(&history).unwrap();
    let file = history.join(format!(
        "opencode-{}.jsonl",
        loongsuite_pilot::utils::get_today_date_string()
    ));
    let bytes = raw
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&file, &bytes).unwrap();
    let input = OpenCodeLogInput::new(HookInputOptions {
        state_store: Arc::new(StateStore::new(root.join("native-state.json"))),
        log_dir: Some(history.to_string_lossy().into_owned()),
        log_prefix: None,
        poll_interval_ms: Some(60000),
    });
    let normalized = input.collect_entries().await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), bytes);
    assert!(
        input.collect_entries().await.unwrap().is_empty(),
        "Native disk cursor replayed the producer"
    );
    assert_eq!(
        normalized
            .iter()
            .map(|e| &e.event_id)
            .collect::<HashSet<_>>()
            .len(),
        normalized.len()
    );
    assert!(normalized
        .iter()
        .all(|e| serde_json::to_value(e).unwrap()["agent.opencode.collection"] == "v2"));
    normalized
}
fn flusher(root: &Path) -> (OtlpTraceFlusher, Arc<Capture>, Arc<Preparation>) {
    let capture = Arc::new(Capture::default());
    let sink = capture.clone();
    let prepare = Arc::new(Preparation::default());
    let config=serde_json::from_value(json!({"enabled":true,"serviceName":"synthetic-v2","protocol":"http/protobuf",
  "endpoints":[{"name":"capture","endpoint":"http://localhost:4318/v1/traces","headers":{}}],"dataDir":root})).unwrap();
    let out = OtlpTraceFlusher::with_parts(
        config,
        None,
        Some(Arc::new(move |_| sink.clone())),
        Some(prepare.clone()),
    )
    .unwrap();
    (out, capture, prepare)
}
async fn cache(param: &Value) {
    let root = tempfile::tempdir().unwrap();
    let normalized = records(root.path(), 0, param).await;
    let manager = InputManager::new();
    manager.set_mask_config(MaskConfig {
        mode: MaskMode::All,
        types: vec![],
        replacement_mode: Some(MaskReplacementMode::Placeholder),
    });
    let masked = manager.prepare_restored_entries(normalized);
    let values: Vec<Value> = masked
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    let encoded = serde_json::to_string(&values).unwrap();
    assert!(encoded.contains("synthetic answer"));
    assert!(encoded.contains("synthetic result"));
    assert!(!encoded.contains("sk-1234567890abcdefghijklmnop"));
    let request = values
        .iter()
        .filter(|r| r["event.name"] == "llm.request")
        .nth(1)
        .unwrap();
    let tools: Vec<_> = request["gen_ai.input.messages_delta"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["role"] == "tool")
        .collect();
    assert_eq!(tools.len(), 2);
    for message in tools {
        let part = &message["parts"][0];
        let result = values
            .iter()
            .find(|r| r["event.name"] == "tool.result" && r["gen_ai.tool.call.id"] == part["id"])
            .unwrap();
        assert!(part["response"] == result["gen_ai.tool.call.result"]);
        assert!(part["response"].is_array());
    }
    let (out, capture, _prepared) = flusher(root.path());
    out.send_batch(masked.clone(), None).await.unwrap();
    let spans = capture.0.lock().unwrap().clone();
    let encoded =
        serde_json::to_string(&spans.iter().map(|s| &s.attributes).collect::<Vec<_>>()).unwrap();
    assert!(encoded.contains("synthetic answer"));
    assert!(!encoded.contains("sk-1234567890abcdefghijklmnop"));
    for expected in ["ENTRY", "AGENT"] {
        assert_eq!(spans.iter().filter(|s| kind(s, expected)).count(), 1);
    }
    let llms: Vec<_> = spans.iter().filter(|s| kind(s, "LLM")).collect();
    let tools: Vec<_> = spans.iter().filter(|s| kind(s, "TOOL")).collect();
    assert_eq!(llms.len(), 2);
    assert_eq!(tools.len(), 2);
    let mut ids: Vec<_> = tools
        .iter()
        .map(|s| s.attributes["gen_ai.tool.call.id"].as_str().unwrap())
        .collect();
    ids.sort();
    assert_eq!(ids, ["tool_a", "tool_b"]);
    assert!(llms
        .iter()
        .all(|s| s.attributes["gen_ai.usage.input_tokens"] == param["input"]));
    assert!(llms
        .iter()
        .chain(tools.iter())
        .all(|s| s.duration[0] * 1_000_000_000 + s.duration[1] > 0));
    let ids: HashSet<_> = spans.iter().map(|s| &s.span_id).collect();
    assert_eq!(ids.len(), spans.len());
    for span in &spans {
        if !kind(span, "ENTRY") {
            if let Some(parent) = &span.parent_span_id {
                assert!(ids.contains(parent));
            }
        }
    }
    let count = spans.len();
    out.send_batch(masked, None).await.unwrap();
    assert_eq!(capture.0.lock().unwrap().len(), count);
    out.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_opencode_v2_actual_agent_host_and_native_pipeline_keep_both_steps_parallel_tool_content_mask_and_all_four_cache_shapes(
) {
    let cases: Value = serde_json::from_str(include_str!(
        "../../fixtures/opencode-v2-original-main-matrices.json"
    ))
    .unwrap();
    for param in cases[0].as_array().unwrap() {
        tokio::time::timeout(Duration::from_secs(15), cache(param))
            .await
            .expect("original project15s per cache parameter");
    }
}
async fn terminal(param: &Value) {
    let root = tempfile::tempdir().unwrap();
    let normalized = records(root.path(), 1, param).await;
    let (out, capture, prepared) = flusher(root.path());
    out.send_batch(normalized.clone(), None).await.unwrap();
    // The recording decorator observes the actual post-prepare/drop-orphan boundary
    // and forwards unchanged to the real converter; no preparation logic is copied.
    let calls = prepared.0.lock().unwrap().clone();
    assert!(!calls.is_empty());
    assert!(calls.iter().any(|rows| rows
        .iter()
        .filter(|e| e.event_name.is_some_and(|n| n.as_str() == "tool.result"))
        .count()
        == 2));
    let spans = capture.0.lock().unwrap().clone();
    let tools: Vec<_> = spans.iter().filter(|s| kind(s, "TOOL")).collect();
    let mut ids: Vec<_> = tools
        .iter()
        .map(|s| s.attributes["gen_ai.tool.call.id"].as_str().unwrap())
        .collect();
    ids.sort();
    assert_eq!(ids, ["tool_a", "tool_b"]);
    assert!(tools
        .iter()
        .all(|s| s.duration[0] * 1_000_000_000 + s.duration[1] > 0));
    for expected in ["LLM", "ENTRY", "AGENT"] {
        assert_eq!(spans.iter().filter(|s| kind(s, expected)).count(), 1);
    }
    let count = spans.len();
    out.send_batch(normalized, None).await.unwrap();
    assert_eq!(capture.0.lock().unwrap().len(), count);
    out.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_opencode_v2_actual_agent_host_and_native_prepare_keep_both_parallel_tool_results_on_all_three_terminal_paths(
) {
    let cases: Value = serde_json::from_str(include_str!(
        "../../fixtures/opencode-v2-original-main-matrices.json"
    ))
    .unwrap();
    for param in cases[1].as_array().unwrap() {
        tokio::time::timeout(Duration::from_secs(15), terminal(param))
            .await
            .expect("original project15s per terminal parameter");
    }
}
