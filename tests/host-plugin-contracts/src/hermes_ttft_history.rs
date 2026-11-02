//! Historical native Python streaming-callback contracts, with real Native input replay.
use crate::host::{repo, run_host_output};
use loongsuite_pilot::{
    checkpoints::StateStore,
    inputs::{hermes_log::HermesLogInput, rest_support::SessionInputOptions},
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
const KEY: &str = "gen_ai.response.time_to_first_token";
struct Probe {
    responses: Vec<Value>,
    extra: Value,
    hostname: String,
}
async fn scenario(index: usize, parameter: Option<&str>, config: Value) -> Probe {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("config.json"), config.to_string()).unwrap();
    let prefix = include_str!("../drivers/hermes-history/ttft-driver.py");
    let body = std::fs::read_to_string(repo().join(format!(
        "tests/host-plugin-contracts/drivers/hermes-history/ttft-{index:02}.py"
    )))
    .unwrap()
    .replace("__FIRST_DELTA__", parameter.unwrap_or("unused"))
    .replace(
        "__SCENARIO_JSON__",
        &serde_json::to_string(parameter.unwrap_or("unused")).unwrap(),
    );
    let script = format!("{prefix}\n{body}\nimport socket\nprint(json.dumps(dict(extra=extra,hostname=socket.gethostname())))");
    // Original TTFT spawnSync budget is 15s. Native callback joins/writer/1s
    // delivery windows remain unchanged inside the exact extracted source.
    let out = run_host_output(
        "python3",
        &[
            "-c".into(),
            script,
            repo()
                .join("assets/plugins/hermes-agent/loongsuite-pilot/__init__.py")
                .to_string_lossy()
                .into_owned(),
        ],
        root.path(),
        Duration::from_secs(15),
    )
    .await;
    let transport: Value = serde_json::from_slice(&out.stdout).unwrap();
    let log = root.path().join("logs/hermes-agent");
    let mut paths = if log.exists() {
        std::fs::read_dir(&log)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|v| v == "jsonl"))
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    paths.sort();
    let mut records = vec![];
    for path in paths {
        records.extend(
            std::fs::read_to_string(path)
                .unwrap()
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| serde_json::from_str::<Value>(l).unwrap()),
        );
    }
    let responses: Vec<_> = records
        .iter()
        .filter(|r| r["event.name"] == "llm.response")
        .cloned()
        .collect();
    let input = HermesLogInput::new(SessionInputOptions {
        state_store: Arc::new(StateStore::new(root.path().join("state.json"))),
        session_dir: Some(log.to_string_lossy().into_owned()),
        file_pattern: None,
        poll_interval_ms: Some(60_000),
    });
    let normalized = input.collect_entries().await.unwrap();
    let raw: BTreeMap<_, _> = responses
        .iter()
        .map(|r| {
            (
                r["event.id"].as_str().unwrap().to_owned(),
                r.get(KEY).cloned(),
            )
        })
        .collect();
    let native: BTreeMap<_, _> = normalized
        .iter()
        .filter(|r| serde_json::to_value(r).unwrap()["event.name"] == "llm.response")
        .map(|r| {
            (
                r.event_id.clone(),
                serde_json::to_value(r).unwrap().get(KEY).cloned(),
            )
        })
        .collect();
    assert_eq!(
        native, raw,
        "real Native input must preserve the same callback identity and exact nanoseconds/absence"
    );
    Probe {
        responses,
        extra: transport["extra"].clone(),
        hostname: transport["hostname"].as_str().unwrap().into(),
    }
}
async fn run(index: usize) -> Probe {
    scenario(index, None, json!({})).await
}
fn ttft(row: &Value) -> Option<i64> {
    row.get(KEY).and_then(Value::as_i64)
}
#[tokio::test]
async fn hermes_ttft_blocked_other_session_writer_does_not_block_first_delta() {
    let p = run(0).await;
    assert_eq!(p.extra["native_delivered_before_writer_released"], true);
    assert_eq!(p.extra["stream_completed_before_writer_released"], true);
    assert_eq!(p.responses.len(), 1);
    assert_eq!(ttft(&p.responses[0]), Some(40));
}
#[tokio::test]
async fn hermes_ttft_context_copy_matches_native_turn() {
    let p = run(1).await;
    assert_eq!(ttft(&p.responses[0]), Some(250_000_000));
}
#[tokio::test]
async fn hermes_ttft_ambiguous_and_mismatched_requests_are_not_guessed() {
    let p = run(2).await;
    assert_eq!(p.responses.len(), 2);
    assert!(p.responses.iter().all(|r| r.get(KEY).is_none()));
}
#[tokio::test]
async fn hermes_ttft_lazy_forwarder_keeps_facade_and_callback() {
    let p = run(3).await;
    assert_eq!(p.responses.len(), 1);
    assert_eq!(ttft(&p.responses[0]), Some(250_000_000));
    assert_eq!(p.extra, json!({"seen":["called"],"facade_unchanged":true}));
}
#[tokio::test]
async fn hermes_ttft_first_delta_keeps_all_callback_args_returns_and_invocations() {
    let p = run(4).await;
    assert_eq!(p.responses.len(), 1);
    assert_eq!(ttft(&p.responses[0]), Some(125_000_000));
    assert_eq!(
        p.extra,
        json!({"result":{"values":["callback-result","callback-result"],"response":"native-result"},"seen":[[42,"kept"],[42,"kept"]],"calls":1})
    );
}
#[tokio::test]
async fn hermes_ttft_two_overlapping_sessions_keep_separate_timing() {
    let p = run(5).await;
    let values: BTreeMap<_, _> = p
        .responses
        .iter()
        .map(|r| (r["gen_ai.session.id"].as_str().unwrap(), ttft(r)))
        .collect();
    assert_eq!(
        values,
        BTreeMap::from([("one", Some(30)), ("two", Some(900))])
    );
}
#[tokio::test]
async fn hermes_ttft_overlapping_turns_keep_identity_and_distinct_trace() {
    let p = run(6).await;
    assert_eq!(p.responses.len(), 2);
    let values: BTreeMap<_, _> = p
        .responses
        .iter()
        .map(|r| (r["gen_ai.turn.id"].as_str().unwrap(), r))
        .collect();
    assert_eq!(ttft(values["foreground"]), Some(30));
    assert_eq!(ttft(values["background"]), Some(900));
    assert_eq!(values["foreground"]["user.id"], "im-user-A");
    assert!([p.hostname.as_str(), "im-user-A"]
        .contains(&values["background"]["user.id"].as_str().unwrap()));
    assert_ne!(
        values["foreground"]["trace_id"],
        values["background"]["trace_id"]
    );
}
#[tokio::test]
async fn hermes_ttft_no_delta_omits_timing() {
    let p = run(7).await;
    assert_eq!(p.responses.len(), 1);
    assert!(p.responses[0].get(KEY).is_none());
}
#[tokio::test]
async fn hermes_ttft_nonstreaming_fallback_keeps_native_callback_and_omits_timing() {
    let p = run(8).await;
    assert_eq!(p.extra["disabled_streaming"], true);
    assert_eq!(
        p.extra["result"],
        json!({"values":["full-response-ready"],"response":"native-result"})
    );
    assert_eq!(p.responses.len(), 1);
    assert!(p.responses[0].get(KEY).is_none());
}
#[tokio::test]
async fn hermes_ttft_both_zero_and_negative_elapsed_times_omit_timing() {
    for v in ["100", "99"] {
        let p = scenario(9, Some(v), json!({})).await;
        assert_eq!(p.responses.len(), 1);
        assert!(p.responses[0].get(KEY).is_none());
    }
}
#[tokio::test]
async fn hermes_ttft_legacy_capture_false_keeps_original_timing_and_content() {
    let p = scenario(
        10,
        None,
        json!({"agents":{"hermes-agent":{"captureMessageContent":false}}}),
    )
    .await;
    assert_eq!(p.responses.len(), 1);
    assert_eq!(ttft(&p.responses[0]), Some(80));
    assert_eq!(
        p.responses[0]["gen_ai.output.messages"][0]["parts"],
        json!([{"type":"text","content":"done"}])
    );
}
#[tokio::test]
async fn hermes_ttft_all_five_unsupported_native_contracts_preserve_behavior() {
    for v in [
        "old-signature",
        "missing-module",
        "missing-pre",
        "unsupported-mode",
        "wrong-session",
    ] {
        let p = scenario(11, Some(v), json!({})).await;
        assert_eq!(
            p.responses.len(),
            if v == "missing-pre" { 2 } else { 1 },
            "{v}"
        );
        assert!(p.responses.iter().all(|r| r.get(KEY).is_none()));
        assert_eq!(
            p.extra["result"],
            if v == "old-signature" {
                json!("old-result")
            } else {
                json!({"values":["preserved"],"response":"native-result"})
            }
        );
    }
}
#[tokio::test]
async fn hermes_ttft_error_and_late_callback_cannot_contaminate_retry() {
    let p = run(12).await;
    assert_eq!(p.responses.len(), 2);
    assert!(p.responses.iter().all(|r| r.get(KEY).is_none()));
}
#[tokio::test]
async fn hermes_ttft_native_exception_identity_survives_and_retry_is_measured() {
    let p = run(13).await;
    assert_eq!(p.extra["same_exception"], true);
    assert_eq!(p.responses.len(), 2);
    assert_eq!(ttft(&p.responses[1]), Some(90));
}
#[tokio::test]
async fn hermes_ttft_saved_callback_after_closure_cannot_write_timing() {
    let p = run(14).await;
    assert_eq!(p.extra["callback_result"], "preserved-after-close");
    assert_eq!(p.responses.len(), 2);
    assert!(p.responses.iter().all(|r| r.get(KEY).is_none()));
}
#[tokio::test]
async fn hermes_ttft_clock_failure_preserves_native_callback() {
    let p = run(15).await;
    assert_eq!(
        p.extra["result"],
        json!({"values":["still-called"],"response":"native-result"})
    );
    assert_eq!(p.responses.len(), 1);
    assert!(p.responses[0].get(KEY).is_none());
}
#[tokio::test]
async fn hermes_ttft_lazy_module_registration_is_idempotent() {
    let p = run(16).await;
    assert_eq!(p.extra["same_wrapper"], true);
    assert_eq!(
        p.responses.iter().map(ttft).collect::<Vec<_>>(),
        [Some(50), Some(80), None]
    );
}
#[tokio::test]
async fn hermes_ttft_rediscovery_uses_new_plugin_context_without_rewrapping() {
    let p = run(17).await;
    assert_eq!(p.extra["same_wrapper"], true);
    let values: BTreeMap<_, _> = p
        .responses
        .iter()
        .map(|r| (r["gen_ai.session.id"].as_str().unwrap(), ttft(r)))
        .collect();
    assert_eq!(
        values,
        BTreeMap::from([
            ("original-plugin", Some(50)),
            ("rediscovered-plugin", Some(80))
        ])
    );
}
