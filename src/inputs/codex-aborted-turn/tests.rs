use std::sync::{Arc, Mutex};

use crate::checkpoints::StateStore;
use crate::types::AgentEventName;

use super::input::CodexAbortedTurnInput;
use super::CodexAbortedTurnInputOptions;

#[tokio::test]
async fn recovers_one_aborted_turn_from_fixture() {
    let root = tempfile::tempdir().expect("tempdir");
    let session_dir = root.path().join("sessions");
    tokio::fs::create_dir_all(&session_dir)
        .await
        .expect("session dir");
    let store = Arc::new(StateStore::new(root.path().join("input-state.json")));
    let input = CodexAbortedTurnInput::new(CodexAbortedTurnInputOptions {
        state_store: Arc::clone(&store),
        session_dir: Some(session_dir.to_string_lossy().into_owned()),
        hook_state_dir: Some(
            root.path()
                .join("hook-state")
                .to_string_lossy()
                .into_owned(),
        ),
        diagnostic_dir: Some(
            root.path()
                .join("diagnostics")
                .to_string_lossy()
                .into_owned(),
        ),
        hook_gap_grace_ms: Some(60_000.0),
        poll_interval_ms: Some(60_000),
    });
    let collected = Arc::new(Mutex::new(Vec::new()));
    let slot = Arc::clone(&collected);
    input.on_entries(move |batch| {
        slot.lock().expect("entries").extend(batch.iter().cloned());
    });
    input.start().await.expect("start");
    let fixture = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/unit/inputs/codex-aborted-turn/fixtures/aborted-turn.jsonl"
    ));
    let transcript = session_dir.join("rollout-session-aborted.jsonl");
    tokio::fs::write(&transcript, fixture)
        .await
        .expect("fixture");
    input.run_cycle().await;
    let first_len = collected.lock().expect("entries").len();
    input.run_cycle().await;
    input.stop().await.expect("stop");

    let entries = collected.lock().expect("entries").clone();
    assert!(first_len > 0, "aborted turn produced no entries");
    assert_eq!(
        entries.len(),
        first_len,
        "checkpoint replayed the aborted turn"
    );
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::LlmResponse)
            && entry
                .finish_reasons
                .as_ref()
                .is_some_and(|reasons| reasons.iter().any(|reason| reason == "cancelled"))
            && entry.turn_end == Some(true)
            && entry.session_id == "session-aborted"
            && entry
                .extra
                .get("agent.codex.turn_status")
                .and_then(|value| value.as_str())
                == Some("interrupted")
    }));
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::ToolResult)
            && entry.tool_call_id.as_deref() == Some("call-bash")
            && entry.tool_result_status.as_deref() == Some("success")
    }));
    assert!(entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::Other)
            && serde_json::to_string(&entry.input_messages_delta)
                .unwrap_or_default()
                .contains("solve the task")
    }));
    let key = format!("codex-aborted-turn:{}", transcript.to_string_lossy());
    let checkpoint = store
        .get(&key)
        .extra()
        .and_then(|extra| extra.get("codexAbortedTurn").cloned())
        .expect("aborted checkpoint");
    let ids = checkpoint
        .get("emittedAbortedTurnIds")
        .and_then(|value| value.as_array())
        .expect("emitted ids");
    assert!(ids.iter().any(|id| id.as_str() == Some("turn-aborted")));
}
