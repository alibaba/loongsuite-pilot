//! Additional main declaration: preserve each historical event name.
use loongsuite_pilot::normalization::build_agent_activity_entry;
use loongsuite_pilot::types::ClientType;
use serde_json::json;
#[test]
fn build_entry_main_l12_keeps_each_historical_event_name_without_a_standard_copy() {
    for name in ["llm.request", "llm.response", "tool.call", "tool.result"] {
        let row = build_agent_activity_entry(&json!({
            "event.name":name,"gen_ai.agent.type":ClientType::CodexCliHook.as_str()
        }));
        let value = serde_json::to_value(row).unwrap();
        assert_eq!(value["event.name"], name);
    }
}
