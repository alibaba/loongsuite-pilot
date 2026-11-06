//! Aborted-turn recovery types. Port of `codex-aborted-turn-types.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_EMITTED_ABORTED_TURNS: usize = 100;
pub const MAX_PENDING_COMPLETED_TURNS: usize = 100;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexActiveTurn {
    pub turn_id: String,
    pub start_offset: i64,
    pub started_at_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCompletedTurn {
    pub turn_id: String,
    pub session_id: String,
    pub completed_at_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAbortedCheckpoint {
    pub inode: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev: Option<u64>,
    pub scan_offset: i64,
    pub active_turn: Option<CodexActiveTurn>,
    pub latest_session_meta_offset: Option<i64>,
    pub latest_session_id: Option<String>,
    pub emitted_aborted_turn_ids: Vec<String>,
    pub pending_completed_turns: Vec<CodexCompletedTurn>,
    pub emitted_hook_gap_turn_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexTranscriptMeta {
    pub session_id: String,
    pub provider: String,
    pub base_instructions: Option<String>,
    pub tool_definitions: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AssistantMessage {
    pub timestamp_ms: f64,
    pub sequence: u64,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub timestamp_ms: f64,
    pub sequence: u64,
    pub call_id: String,
    pub name: String,
    pub input: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub timestamp_ms: f64,
    pub sequence: u64,
    pub call_id: String,
    pub output: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TimelineEvent {
    Assistant(AssistantMessage),
    ToolCall(ToolCall),
    ToolResult(ToolResult),
}

impl TimelineEvent {
    pub fn timestamp_ms(&self) -> f64 {
        match self {
            Self::Assistant(event) => event.timestamp_ms,
            Self::ToolCall(event) => event.timestamp_ms,
            Self::ToolResult(event) => event.timestamp_ms,
        }
    }

    pub fn sequence(&self) -> u64 {
        match self {
            Self::Assistant(event) => event.sequence,
            Self::ToolCall(event) => event.sequence,
            Self::ToolResult(event) => event.sequence,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexTokenUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cached_input_tokens: f64,
    pub cache_creation_tokens: f64,
    pub reasoning_output_tokens: Option<f64>,
    pub total_tokens: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexTokenUsageSample {
    pub timestamp_ms: f64,
    pub sequence: u64,
    pub usage: CodexTokenUsage,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexExtractedAbortedTurn {
    pub session_id: String,
    pub transcript_turn_id: String,
    pub provider: String,
    pub model: String,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub developer_instructions: Option<String>,
    pub base_instructions: Option<String>,
    pub tool_definitions: Option<Value>,
    pub started_at_ms: f64,
    pub aborted_at_ms: f64,
    pub reason: String,
    pub timeline: Vec<TimelineEvent>,
    pub usage_samples: Vec<CodexTokenUsageSample>,
}
