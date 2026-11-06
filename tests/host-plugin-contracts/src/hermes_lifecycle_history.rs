//! Exact retained Python host assertions plus Rust assertions and Native input projection.
use crate::host::{repo, run_host_output};
use loongsuite_pilot::{
    checkpoints::StateStore,
    inputs::{
        hermes_log::HermesLogInput,
        rest_support::{transform_hook_record, SessionInputOptions},
    },
    types::ClientType,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, sync::Arc, time::Duration};
async fn source(
    name: &str,
    config: Value,
    seconds: u64,
) -> (tempfile::TempDir, std::process::Output) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("config.json"), config.to_string()).unwrap();
    let script = std::fs::read_to_string(repo().join(format!(
        "tests/host-plugin-contracts/drivers/hermes-history/{name}.py"
    )))
    .unwrap();
    let out = run_host_output(
        "python3",
        &[
            "-c".into(),
            script,
            repo()
                .join("assets/plugins/hermes-agent/loongsuite-pilot/__init__.py")
                .to_string_lossy()
                .into_owned(),
            root.path().to_string_lossy().into_owned(),
        ],
        root.path(),
        Duration::from_secs(seconds),
    )
    .await;
    (root, out)
}
async fn native(root: &Path) -> Vec<Value> {
    let input = HermesLogInput::new(SessionInputOptions {
        state_store: Arc::new(StateStore::new(root.join("native-state.json"))),
        session_dir: Some(
            root.join("logs/hermes-agent")
                .to_string_lossy()
                .into_owned(),
        ),
        file_pattern: None,
        poll_interval_ms: Some(60_000),
    });
    input
        .collect_entries()
        .await
        .unwrap()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect()
}
fn valid_hex(value: &Value, len: usize) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && s.bytes().any(|b| b != b'0')
    })
}
#[tokio::test]
async fn main_hermes_missing_input_retries_without_claiming_previous_turn_content() {
    // The exact extracted source asserts visibility before exit, first input hash,
    // staging retryability and original ordered 4 records while the turn is live.
    let (root, _) = source("realtime-00", json!({}), 30).await;
    let rows = native(root.path()).await;
    let inputs: Vec<_> = rows
        .iter()
        .filter(|r| r["agent.hermes.hook"] == "turn_start")
        .collect();
    assert_eq!(inputs.len(), 1);
    assert_eq!(
        inputs[0]["gen_ai.input.messages_delta"][0]["parts"][0]["content"],
        "current prompt"
    );
    assert_eq!(
        inputs[0]["agent.pilot.correlation.content_hash"],
        loongsuite_pilot::utils::content_hash("current prompt")
    );
}
#[tokio::test]
async fn main_hermes_input_write_failure_retries_the_same_event_and_span_identity() {
    // Source Python assertions retain failed input event/span IDs and no emitted
    // checkpoint, then require other/request/response/terminal and exact retry IDs.
    let (root, _) = source("realtime-01", json!({}), 30).await;
    let rows = native(root.path()).await;
    assert_eq!(
        rows.iter()
            .map(|r| r["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["other", "llm.request", "llm.response", "other"]
    );
    assert_eq!(
        rows.iter().filter(|r| r["gen_ai.turn.end"] == true).count(),
        1
    );
}
#[tokio::test]
async fn hermes_failed_evictions_keep_original_bounds_current_request_and_exit_retry_idempotence() {
    // Original 10s child budget, MAX_ACTIVE_TURNS=2/MAX_SESSIONS=2/retry bound2,
    // eight requests, repeated exit flush and detached snapshots remain exact.
    let (root, out) = source("realtime-02", json!({}), 10).await;
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["terminal"], 4);
    let rows = native(root.path()).await;
    assert!(!rows.is_empty());
    assert_eq!(
        rows.iter()
            .map(|r| r["event.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        rows.len()
    );
}
#[tokio::test]
async fn hermes_request_tool_append_visibility_keeps_pair_ids_and_retries_without_duplicates() {
    let (root,out)=source("realtime-visibility",json!({"agents":{"hermes-agent":{"enabled":true,"captureMessageContent":true}},"collectTrace":true}),30).await;
    let p: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(p["before_api"], json!([]));
    let after: Vec<_> = p["after_response"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["event.name"].as_str().unwrap())
        .collect();
    assert_eq!(after, ["other", "llm.request", "llm.response"]);
    assert_eq!(
        p["after_call"].as_array().unwrap().last().unwrap()["event.name"],
        "tool.call"
    );
    assert_eq!(
        p["after_result"].as_array().unwrap().last().unwrap()["event.name"],
        "tool.result"
    );
    assert_eq!(
        p["second"].as_array().unwrap().last().unwrap()["gen_ai.request.id"],
        "request2"
    );
    assert!(!p["before_end"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["gen_ai.turn.end"] == true));
    let turn: Vec<_> = p["final"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["gen_ai.turn.id"] == "turn1")
        .collect();
    let requests: Vec<_> = turn
        .iter()
        .filter(|r| r["event.name"] == "llm.request")
        .collect();
    let responses: Vec<_> = turn
        .iter()
        .filter(|r| r["event.name"] == "llm.response")
        .collect();
    assert_eq!(requests.len(), 3);
    assert_eq!(responses.len(), 3);
    assert_eq!(
        requests
            .iter()
            .map(|r| r["span_id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        3
    );
    for request in requests {
        assert!(valid_hex(&request["trace_id"], 32));
        assert!(valid_hex(&request["span_id"], 16));
        let response = responses
            .iter()
            .find(|r| r["gen_ai.response.id"] == request["gen_ai.response.id"])
            .unwrap();
        assert_eq!(response["span_id"], request["span_id"]);
        assert_eq!(response["trace_id"], request["trace_id"]);
    }
    assert_eq!(
        turn.iter().filter(|r| r["gen_ai.turn.end"] == true).count(),
        1
    );
    assert_eq!(
        turn.iter()
            .filter(|r| r["agent.hermes.hook"] == "turn_start")
            .count(),
        1
    );
    let post: Vec<_> = turn
        .iter()
        .filter(|r| r["gen_ai.tool.call.id"] == "post-only")
        .collect();
    assert_eq!(
        post.iter()
            .map(|r| r["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tool.call", "tool.result"]
    );
    assert_eq!(post[0]["span_id"], post[1]["span_id"]);
    let retry = p["retry_final"].as_array().unwrap();
    assert_eq!(
        retry
            .iter()
            .map(|r| r["event.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        retry.len()
    );
    assert_eq!(p["retained"], 1);
    let unfinished: Vec<_> = retry
        .iter()
        .filter(|r| r["gen_ai.turn.id"] == "turn2")
        .collect();
    assert_eq!(
        unfinished
            .iter()
            .map(|r| r["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["llm.request", "other"]
    );
    assert!(!unfinished
        .iter()
        .any(|r| r["agent.hermes.hook"] == "turn_start"));
    let native = native(root.path()).await;
    assert_eq!(
        native
            .iter()
            .map(|r| r["event.id"].as_str().unwrap())
            .collect::<HashSet<_>>(),
        retry
            .iter()
            .map(|r| r["event.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
    );
}
#[tokio::test]
async fn hermes_subagent_factory_preserves_exact_parent_after_eviction_and_parallel_child_start() {
    let (_, out) = source("subagent", json!({}), 30).await;
    let p: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(valid_hex(&p["span"], 16));
    let rows = p["records"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["gen_ai.session.id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["child-0", "child-1"]
    );
    assert!(rows.iter().all(|r| r["trace_id"] == p["trace"]
        && r["parent_span_id"] == p["span"]
        && r["user.id"] == "user-a"));
    for row in rows {
        let entry =
            transform_hook_record(row.as_object().unwrap(), ClientType::Hermes, "hermes-agent")
                .await
                .unwrap()
                .unwrap();
        assert_eq!(entry.trace_id.as_deref(), p["trace"].as_str());
        assert_eq!(entry.parent_span_id.as_deref(), p["span"].as_str());
        assert_eq!(entry.user_id, "user-a");
    }
}
