use std::sync::{Arc, Mutex};

use crate::checkpoints::StateStore;
use crate::types::AgentEventName;

use super::input::CodexTranscriptInput;
use super::CodexTranscriptInputOptions;

fn completed_turn() -> String {
    fn record(timestamp: &str, kind: &str, payload: serde_json::Value) -> String {
        serde_json::json!({ "timestamp": timestamp, "type": kind, "payload": payload }).to_string()
    }
    [
        record(
            "2026-06-24T06:00:00.000Z",
            "session_meta",
            serde_json::json!({
                "id": "session-1",
                "model_provider": "openai",
                "dynamic_tools": [{ "name": "exec_command", "description": "Run a command" }],
            }),
        ),
        record(
            "2026-06-24T06:00:01.000Z",
            "turn_context",
            serde_json::json!({
                "turn_id": "turn-1",
                "model": "gpt-5.5",
                "cwd": "/tmp/project",
                "developer_instructions": "Follow the project conventions.",
            }),
        ),
        record(
            "2026-06-24T06:00:02.000Z",
            "event_msg",
            serde_json::json!({ "type": "task_started", "turn_id": "turn-1" }),
        ),
        record(
            "2026-06-24T06:00:03.000Z",
            "response_item",
            serde_json::json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "fix it" }],
            }),
        ),
        record(
            "2026-06-24T06:00:04.000Z",
            "event_msg",
            serde_json::json!({
                "type": "agent_message",
                "message": "inspect the script first",
                "phase": "commentary",
            }),
        ),
        record(
            "2026-06-24T06:00:05.000Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "id": "fc-1",
                "call_id": "call-1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}",
            }),
        ),
        record(
            "2026-06-24T06:00:06.000Z",
            "response_item",
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "\"/tmp/project\"",
            }),
        ),
        record(
            "2026-06-24T06:00:06.000Z",
            "event_msg",
            serde_json::json!({
                "type": "token_count",
                "info": {
                    "total_token_usage": { "total_tokens": 110 },
                    "last_token_usage": {
                        "input_tokens": 100,
                        "output_tokens": 10,
                        "cached_input_tokens": 0,
                        "reasoning_output_tokens": 9,
                        "total_tokens": 110,
                    },
                },
            }),
        ),
        record(
            "2026-06-24T06:00:10.000Z",
            "event_msg",
            serde_json::json!({ "type": "agent_message", "message": "fixed", "phase": "final" }),
        ),
        record(
            "2026-06-24T06:00:10.000Z",
            "event_msg",
            serde_json::json!({
                "type": "token_count",
                "info": {
                    "total_token_usage": { "total_tokens": 143 },
                    "last_token_usage": {
                        "input_tokens": 130,
                        "output_tokens": 13,
                        "cached_input_tokens": 0,
                        "reasoning_output_tokens": 12,
                        "total_tokens": 143,
                    },
                },
            }),
        ),
        record(
            "2026-06-24T06:00:11.000Z",
            "event_msg",
            serde_json::json!({
                "type": "task_complete",
                "turn_id": "turn-1",
                "last_agent_message": "fixed",
            }),
        ),
    ]
    .join("\n")
        + "\n"
}

#[tokio::test]
async fn collects_one_completed_transcript_turn() {
    let root = tempfile::tempdir().expect("tempdir");
    let session_dir = root.path().join("sessions");
    tokio::fs::create_dir_all(&session_dir)
        .await
        .expect("session dir");
    let store = Arc::new(StateStore::new(root.path().join("input-state.json")));
    let input = CodexTranscriptInput::new(CodexTranscriptInputOptions {
        state_store: Arc::clone(&store),
        session_dir: Some(session_dir.to_string_lossy().into_owned()),
        wakeup_dir: Some(root.path().join("wakeups").to_string_lossy().into_owned()),
        span_context_dir: Some(root.path().join("spans").to_string_lossy().into_owned()),
        poll_interval_ms: Some(60_000),
        multimodal: None,
    });
    let collected = Arc::new(Mutex::new(Vec::new()));
    let slot = Arc::clone(&collected);
    input.on_entries(move |batch| {
        slot.lock().expect("entries").extend(batch.iter().cloned());
    });
    // Publish the empty live source before startup so collection does not
    // depend on when the OS exposes a later directory-mtime update.
    let transcript = session_dir.join("rollout-session-1.jsonl");
    tokio::fs::write(&transcript, "")
        .await
        .expect("empty live source");
    store.set_offset(
        &format!("codex-transcript:{}", transcript.to_string_lossy()),
        0.0,
    );
    input.start().await.expect("start");
    tokio::fs::write(&transcript, completed_turn())
        .await
        .expect("write rollout");
    input.run_cycle().await;
    let first_len = collected.lock().expect("entries").len();
    input.run_cycle().await;
    input.stop().await.expect("stop");

    let entries = collected.lock().expect("entries").clone();
    assert!(first_len > 0, "completed turn produced no entries");
    assert_eq!(
        entries.len(),
        first_len,
        "caught-up checkpoint replayed the turn"
    );
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::Other)
            && entry.turn_end != Some(true)
            && serde_json::to_string(&entry.input_messages_delta)
                .unwrap_or_default()
                .contains("fix it")
    }));
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::LlmResponse)
            && entry
                .finish_reasons
                .as_ref()
                .is_some_and(|reasons| reasons.iter().any(|reason| reason == "stop"))
            && entry.session_id == "session-1"
            && entry.request_model.as_deref() == Some("gpt-5.5")
    }));
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::ToolResult)
            && entry.tool_call_id.as_deref() == Some("call-1")
            && entry.tool_result_status.as_deref() == Some("success")
    }));
    assert!(entries.iter().any(
        |entry| entry.event_name == Some(AgentEventName::Other) && entry.turn_end == Some(true)
    ));
    let key = format!("codex-transcript:{}", transcript.to_string_lossy());
    let state = store.get(&key);
    assert!(state.last_offset().unwrap_or(0.0) > 0.0);
    let extra = state.extra().expect("checkpoint extra");
    assert!(extra.get("codexTranscript").is_some());
}

#[tokio::test]
async fn normal_poll_discovers_new_rollout_in_an_already_cached_bucket_without_wakeup_or_cache_reset(
) {
    use std::time::Duration;

    let root = tempfile::tempdir().expect("synthetic root");
    let session_dir = root.path().join("sessions");
    let bucket = session_dir.join("2026").join("11").join("02");
    tokio::fs::create_dir_all(&bucket)
        .await
        .expect("dated bucket");
    tokio::fs::write(bucket.join("rollout-historical-empty.jsonl"), "")
        .await
        .expect("preexisting file warms real discovery cache");
    let store = Arc::new(StateStore::new(root.path().join("input-state.json")));
    let input = CodexTranscriptInput::new(CodexTranscriptInputOptions {
        state_store: Arc::clone(&store),
        session_dir: Some(session_dir.to_string_lossy().into_owned()),
        wakeup_dir: Some(root.path().join("wakeups").to_string_lossy().into_owned()),
        span_context_dir: Some(root.path().join("spans").to_string_lossy().into_owned()),
        poll_interval_ms: Some(10),
        multimodal: None,
    });
    let collected = Arc::new(Mutex::new(Vec::new()));
    let slot = Arc::clone(&collected);
    input.on_entries(move |entries| {
        slot.lock()
            .expect("entries")
            .extend(entries.iter().cloned());
    });
    input.start().await.expect("start and initial native scan");
    assert!(collected.lock().expect("entries").is_empty());

    let transcript = bucket.join("rollout-session-1.jsonl");
    let key = format!("codex-transcript:{}", transcript.to_string_lossy());
    assert!(store.get(&key).last_offset().is_none());
    let contents = completed_turn();
    tokio::fs::write(&transcript, &contents)
        .await
        .expect("new rollout after cached initial scan");

    // Only the configured normal poll can discover and read this new path.
    // No marker, manual cycle, cache invalidation or mtime forcing is used.
    let discovery = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let terminal = collected.lock().expect("entries").iter().any(|entry| {
                entry.event_name == Some(AgentEventName::Other) && entry.turn_end == Some(true)
            });
            if terminal && store.get_offset(&key) == contents.len() as f64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    input.stop().await.expect("stop normal poll");
    discovery.expect("normal poll did not discover new file in the cached bucket");
    let entries = collected.lock().expect("entries").clone();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name == Some(AgentEventName::Other)
                && entry.turn_end == Some(true))
            .count(),
        1,
        "poll replayed a completed turn"
    );
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::Other)
            && entry.turn_end != Some(true)
            && serde_json::to_string(&entry.input_messages_delta)
                .expect("actual user input")
                .contains("fix it")
    }));
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::LlmResponse)
            && entry.session_id == "session-1"
            && entry.request_model.as_deref() == Some("gpt-5.5")
            && entry
                .finish_reasons
                .as_ref()
                .is_some_and(|reasons| reasons.iter().any(|reason| reason == "stop"))
    }));
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::ToolResult)
            && entry.tool_call_id.as_deref() == Some("call-1")
            && entry.tool_result_status.as_deref() == Some("success")
    }));
    assert_eq!(store.get_offset(&key), contents.len() as f64);
    assert!(store.get(&key).extra().expect("native checkpoint")["codexTranscript"].is_object());
}
