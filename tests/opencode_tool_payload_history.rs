//! Exact historical OpenCode V1/V2 and text payloads via the real disk input.
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::inputs::opencode_log::OpenCodeLogInput;
use loongsuite_pilot::inputs::rest_support::HookInputOptions;
use serde_json::{json, Value};
use std::sync::Arc;
#[tokio::test]
async fn opencode_main_l12_l19_disk_pipeline_restores_v1_keeps_v2_and_does_not_mutate_source_bytes()
{
    let root = tempfile::tempdir().unwrap();
    let input = OpenCodeLogInput::new(HookInputOptions {
        state_store: Arc::new(StateStore::new(root.path().join("state.json"))),
        log_dir: Some(root.path().to_string_lossy().into_owned()),
        log_prefix: None,
        poll_interval_ms: Some(60_000),
    });
    let arguments = json!({"path":"synthetic.txt"});
    let result = json!([{"type":"text","content":"result"}]);
    let cases = [
        (
            "v1",
            "tool.call",
            json!(arguments.to_string()),
            json!(result.to_string()),
        ),
        ("v2", "tool.call", arguments.clone(), result.clone()),
        (
            "plain",
            "tool.result",
            Value::Null,
            json!("plain tool output"),
        ),
        (
            "truncated",
            "tool.result",
            Value::Null,
            json!("{truncated JSON"),
        ),
    ];
    let mut bytes = Vec::new();
    for (id, event, args, result) in &cases {
        let row = json!({
            "event.id":id,"event.name":event,"user.id":"fixture-user",
            "gen_ai.agent.type":"opencode","gen_ai.session.id":"session","gen_ai.turn.id":"turn",
            "gen_ai.tool.call.id":id,"gen_ai.tool.name":"read",
            "gen_ai.tool.call.arguments":args,"gen_ai.tool.call.result":result,
            "time_unix_nano":"1793270000000000000"
        });
        bytes.extend_from_slice(row.to_string().as_bytes());
        bytes.push(b'\n');
    }
    let file = root.path().join(format!(
        "opencode-{}.jsonl",
        loongsuite_pilot::utils::get_today_date_string()
    ));
    std::fs::write(&file, &bytes).unwrap();
    let rows = input.collect_entries().await.unwrap();
    assert_eq!(rows.len(), 4);
    for row in &rows[..2] {
        assert_eq!(row.tool_call_arguments.as_ref(), Some(&arguments));
        assert_eq!(row.tool_call_result.as_ref(), Some(&result));
    }
    assert_eq!(rows[2].tool_call_result, Some(json!("plain tool output")));
    assert_eq!(rows[3].tool_call_result, Some(json!("{truncated JSON")));
    assert_eq!(std::fs::read(file).unwrap(), bytes);
    assert!(input.collect_entries().await.unwrap().is_empty());
}
