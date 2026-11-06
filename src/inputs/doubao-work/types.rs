use serde::{Deserialize, Serialize};
fn false_value(value: &bool) -> bool {
    !*value
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstOutput {
    pub event_id: String,
    pub duration_ms: i64,
    pub answer_id: String,
    pub message_id: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub agent_id: String,
    pub sandbox_id: String,
    pub id: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTool {
    pub id: String,
    pub name: String,
    pub sandbox_id: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoLogEvent {
    pub name: String,
    pub time_nano: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_partners: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_output: Option<FirstOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Command>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<LocalTool>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoPendingTurn {
    pub turn_id: String,
    pub query_ms: i64,
    pub updated_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_partners: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_output: Option<DoubaoLogEvent>,
    #[serde(default, skip_serializing_if = "false_value")]
    pub first_output_conflict: bool,
    #[serde(default, skip_serializing_if = "false_value")]
    pub start_observed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<DoubaoLogEvent>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DoubaoToolPair {
    pub start: DoubaoLogEvent,
    pub end: DoubaoLogEvent,
}
