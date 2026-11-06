use super::*;
use crate::checkpoints::StateStore;
use crate::inputs::base::InputBody;
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
