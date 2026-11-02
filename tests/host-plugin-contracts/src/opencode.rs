use crate::{
    contracts::{flusher, kind},
    host::{repo, run_host},
};
use loongsuite_pilot::{
    flushers::BaseFlusher,
    inputs::rest_support::transform_hook_record,
    types::{AgentActivityEntry, ClientType},
};
use serde_json::{json, Value};
use std::collections::HashSet;
async fn invocation(mode: &str) -> Vec<AgentActivityEntry> {
    let root = tempfile::tempdir().unwrap();
    run_host(
        "node",
        &[
            repo()
                .join("tests/fixtures/opencode/resumed-process.mjs")
                .to_string_lossy()
                .into_owned(),
            mode.into(),
        ],
        root.path(),
    )
    .await;
    let mut records = vec![];
    let mut paths: Vec<_> = std::fs::read_dir(root.path().join("logs/opencode"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    paths.sort();
    for path in paths {
        for line in std::fs::read_to_string(path).unwrap().lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            if let Some(mut entry) =
                transform_hook_record(value.as_object().unwrap(), ClientType::OpenCode, "opencode")
                    .await
                    .unwrap()
            {
                entry.trace_id = Some("a".repeat(32));
                records.push(entry);
            }
        }
    }
    records
}
#[tokio::test]
async fn history_opencode_l43_real_fresh_node_invocations_resume_across_both_poll_splits() {
    for shared in [false, true] {
        let first = invocation("first").await;
        let second = invocation("resume").await;
        let root = tempfile::tempdir().unwrap();
        let (out, capture) = flusher(root.path());
        let cut = second
            .iter()
            .position(|r| r.step_id.as_deref().is_some_and(|s| s.ends_with(":s2")))
            .unwrap();
        assert!(cut > 0);
        let initial = if shared {
            first.iter().chain(&second[..cut]).cloned().collect()
        } else {
            first.clone()
        };
        out.send_batch(initial, None).await.unwrap();
        if !shared {
            out.send_batch(second[..cut].to_vec(), None).await.unwrap();
        }
        out.send_batch(second[cut..].to_vec(), None).await.unwrap();
        // Match the original: no flush between polls, preserving late-root guard.
        let spans = capture.0.lock().unwrap().clone();
        let tools: Vec<_> = spans.iter().filter(|s| kind(s, "TOOL")).collect();
        let mut names: Vec<_> = tools
            .iter()
            .map(|s| s.attributes["gen_ai.tool.name"].as_str().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["edit", "read", "write"]);
        for expected in ["ENTRY", "AGENT"] {
            assert_eq!(spans.iter().filter(|s| kind(s, expected)).count(), 2);
        }
        assert_eq!(spans.iter().filter(|s| kind(s, "LLM")).count(), 4);
        assert_eq!(
            first
                .iter()
                .map(|r| &r.turn_id)
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert_eq!(
            second
                .iter()
                .map(|r| &r.turn_id)
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert_ne!(first[0].turn_id, second[0].turn_id);
        assert_eq!(first[0].session_id, second[0].session_id);
        let ids: HashSet<_> = spans.iter().map(|s| &s.span_id).collect();
        assert_eq!(ids.len(), spans.len());
        for tool in tools {
            assert!(ids.contains(tool.parent_span_id.as_ref().unwrap()));
            assert!(tool.duration[0] * 1_000_000_000 + tool.duration[1] > 0);
            assert!(tool
                .attributes
                .get("gen_ai.tool.call.result")
                .is_some_and(|v| v != &Value::Null && v != &json!("")));
        }
        let count = spans.len();
        out.send_batch(second, None).await.unwrap();
        assert_eq!(capture.0.lock().unwrap().len(), count);
        out.shutdown().await.unwrap();
    }
}
