use super::*;
use crate::checkpoints::StateStore;
use crate::inputs::base::InputBody;
use crate::types::AgentEventName;
use serde_json::json;
use std::sync::Mutex;
fn input(store: Arc<StateStore>, root: &std::path::Path) -> QwenWorkCnInput {
    QwenWorkCnInput::new(QwenWorkCnOptions {
        state_store: store,
        log_dir: Some(root.to_string_lossy().into_owned()),
        log_prefix: None,
        poll_interval_ms: Some(60000),
    })
}
#[tokio::test]
async fn source_l28_actual_hook_has_product_specific_identity() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    let input = input(store, root.path());
    assert_eq!(input.id(), "qwen-work-cn-hook");
    assert_eq!(input.inner.body.agent_type(), ClientType::QwenWorkCN);
}
#[tokio::test]
async fn source_l33_actual_hook_enforces_agent_workspace_and_agent_version_contract() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    let record = json!({"event.id":"qwen-event-1","event.name":"llm.request","gen_ai.agent.type":"unexpected","gen_ai.session.id":"qwen-session-1","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"hello"}]}],"time_unix_nano":"1770000000000000000","observed_time_unix_nano":"1770000000000000000","version":"0.1.5","agent.qwenworkcn.version":"0.1.5","agent.qwenworkcn.cwd":"/workspace/qwen-work-cn"});
    std::fs::write(
        root.path().join(format!(
            "qwen-work-cn-{}.jsonl",
            crate::utils::get_today_date_string()
        )),
        format!("{record}\n"),
    )
    .unwrap();
    let input = input(store, root.path());
    let events = Arc::new(Mutex::new(Vec::new()));
    let copy = events.clone();
    input.bind_collector(
        move |batch| {
            copy.lock()
                .unwrap()
                .extend(batch.iter().map(|e| serde_json::to_value(e).unwrap()))
        },
        |_| {},
    );
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let e = events.lock().unwrap();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["gen_ai.agent.type"], "qwen-work-cn");
    assert_eq!(e[0]["gen_ai.session.id"], "qwen-session-1");
    assert_eq!(e[0]["workspace.path"], "/workspace/qwen-work-cn");
    assert!(e[0].get("version").is_none());
    assert_eq!(e[0]["agent.qwenworkcn.version"], "0.1.5");
    assert_eq!(input.agent_version(), "0.1.5");
}

#[tokio::test]
async fn history_only_listener_collects_native_stop_without_starting_trace() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let history = root.join("pilot/logs/qwen-work-cn/history");
    let pilot = root.join("pilot");
    let sdk = pilot.join("state/standalone-qwen-work-cn-sdk");
    let wakeups = sdk.join("wakeups/qwen-work-cn");
    let project = root.join("projects");
    std::fs::create_dir_all(&wakeups).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    let transcript = project.join("session.jsonl");
    let rows = [
        json!({"type":"user","uuid":"user-turn","promptId":"turn","sessionId":"history-stop",
            "message":{"role":"user","content":[{"type":"text","text":"synthetic question"}]}}),
        json!({"type":"assistant","uuid":"assistant-turn","sessionId":"history-stop",
            "message":{"role":"assistant","model":"qwen-test","id":"response",
            "content":[{"type":"text","text":"synthetic answer"}]}}),
    ];
    let source = rows
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    std::fs::write(&transcript, &source).unwrap();
    let marker = wakeups.join("001.json");
    std::fs::write(
        &marker,
        json!({"hook_event_name":"Stop","session_id":"history-stop",
        "transcript_path":transcript,"snapshot_bytes":source.len(),"cwd":project})
        .to_string(),
    )
    .unwrap();
    let store = Arc::new(StateStore::new(root.join("input-state.json")));
    let configure = |store| {
        let input = input(store, &history);
        input.set_native_wakeups(QwenWorkCnNativeWakeups {
            directory: wakeups.clone(),
            pilot_policy_dir: Some(sdk.clone()),
            transcript_roots: vec![project.clone()],
            transition_inbox: None,
            producer_data_dir: pilot.clone(),
            legacy_cursor_root: Some(pilot.clone()),
            user_id: "fixture".into(),
        });
        input
    };
    let events = Arc::new(Mutex::new(Vec::new()));
    let run = |input: &QwenWorkCnInput| {
        let events = events.clone();
        input.bind_collector(
            move |batch| events.lock().unwrap().extend_from_slice(batch),
            |_| {},
        );
    };
    let listener = configure(store.clone());
    run(&listener);
    listener.start().await.unwrap();
    listener.stop().await.unwrap();
    assert!(!marker.exists());
    let state = store.get("qwen-work-cn-hook");
    assert!(state.last_offset().is_some_and(|offset| offset > 0.0));
    assert!(store.get("qwen-work-cn-trace").last_offset().is_none());
    {
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 3);
        assert!(events
            .iter()
            .all(|entry| entry.session_id == "history-stop"));
        assert!(events
            .iter()
            .any(|entry| entry.event_name == Some(AgentEventName::LlmRequest)));
        assert!(events
            .iter()
            .any(|entry| entry.event_name == Some(AgentEventName::LlmResponse)));
    }
    store.save().await.unwrap();

    let restored = Arc::new(StateStore::new(root.join("input-state.json")));
    restored.load().await;
    let restarted = configure(restored);
    run(&restarted);
    restarted.start().await.unwrap();
    restarted.stop().await.unwrap();
    assert_eq!(events.lock().unwrap().len(), 3);
}
