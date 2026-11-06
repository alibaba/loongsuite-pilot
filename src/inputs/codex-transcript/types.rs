//! Codex rollout types. Port of `codex-transcript-types.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type JsonValue = Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexTerminalStatus {
    Completed,
    Interrupted,
}

impl CodexTerminalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexThreadSource {
    User,
    Subagent,
    Unknown,
}

impl CodexThreadSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Subagent => "subagent",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTranscriptSourceRange {
    pub start_offset: i64,
    pub end_offset: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTranscriptInputContext {
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<Vec<JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_messages: Option<Vec<JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_range: Option<CodexTranscriptSourceRange>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPendingFusionChild {
    pub parent_tool_call_id: String,
    pub parent_trace_id: String,
    pub spawned_at_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexActiveTranscriptTurn {
    pub turn_id: String,
    pub start_offset: i64,
    pub started_at_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_step_started_at_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_cumulative_token_total: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub emitted_prompt: bool,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub emitted_step_count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emitted_step_request_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emitted_step_response_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emitted_tool_call_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emitted_tool_result_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_context: Option<CodexTranscriptInputContext>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subagent_spawns: Vec<CodexPendingFusionChild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<super::subagent_linker::CodexSubagentLink>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub delegation_unbound: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emitted_trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emitted_audit_event_ids: Vec<String>,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Default for CodexActiveTranscriptTurn {
    fn default() -> Self {
        Self {
            turn_id: String::new(),
            start_offset: 0,
            started_at_ms: 0.0,
            next_step_started_at_ms: None,
            last_cumulative_token_total: None,
            model: None,
            cwd: None,
            developer_instructions: None,
            emitted_prompt: false,
            emitted_step_count: 0,
            emitted_step_request_ids: Vec::new(),
            emitted_step_response_ids: Vec::new(),
            emitted_tool_call_ids: Vec::new(),
            emitted_tool_result_ids: Vec::new(),
            input_context: None,
            subagent_spawns: Vec::new(),
            delegation: None,
            delegation_unbound: false,
            emitted_trace_id: None,
            emitted_audit_event_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPendingFusionTurn {
    pub turn_id: String,
    pub parent_thread_id: String,
    pub parent_trace_id: String,
    pub terminal_end_offset: i64,
    pub children: Vec<CodexPendingFusionChild>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FusionConfidence {
    #[serde(rename = "explicit_id")]
    ExplicitId,
    #[serde(rename = "agent_path")]
    AgentPath,
}

impl FusionConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitId => "explicit_id",
            Self::AgentPath => "agent_path",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "explicit_id" => Some(Self::ExplicitId),
            "agent_path" => Some(Self::AgentPath),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPendingSubagentTurn {
    pub turn_id: String,
    pub parent_thread_id: String,
    pub parent_turn_id: String,
    pub parent_trace_id: String,
    pub parent_tool_call_id: String,
    pub confidence: FusionConfidence,
    pub terminal_end_offset: i64,
    pub active_turn: CodexActiveTranscriptTurn,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTerminalRecoveryFailure {
    pub source_version: String,
    pub retry_at_ms: f64,
    pub delay_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDeferredTerminalTurn {
    pub active_turn: CodexActiveTranscriptTurn,
    pub pending_terminal: CodexPendingTerminalTurn,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPendingTerminalTurn {
    pub turn_id: String,
    pub terminal_end_offset: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_pending_at_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_at_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_record_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<CodexTerminalRecoveryFailure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForkBootstrapState {
    #[serde(rename = "live-pending")]
    LivePending,
    #[serde(rename = "baseline-search")]
    BaselineSearch,
    #[serde(rename = "baseline-tail")]
    BaselineTail,
}

impl ForkBootstrapState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LivePending => "live-pending",
            Self::BaselineSearch => "baseline-search",
            Self::BaselineTail => "baseline-tail",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexForkBootstrap {
    pub state: ForkBootstrapState,
    pub search_offset: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail_candidate: Option<CodexActiveTranscriptTurn>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTranscriptCheckpoint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_owned_turn_id: Option<String>,
    pub inode: u64,
    pub scan_offset: i64,
    pub active_turn: Option<CodexActiveTranscriptTurn>,
    pub pending_terminal: Option<CodexPendingTerminalTurn>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deferred_terminals: Vec<CodexDeferredTerminalTurn>,
    pub pending_fusion: Option<CodexPendingFusionTurn>,
    pub pending_subagent: Option<CodexPendingSubagentTurn>,
    pub owner_session_meta_offset: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_bootstrap: Option<CodexForkBootstrap>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTranscriptMeta {
    pub thread_id: String,
    pub root_session_id: String,
    pub thread_source: CodexThreadSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forked_from_id: Option<String>,
    pub depth: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_definitions: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexTranscriptUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cached_input_tokens: f64,
    pub cache_creation_tokens: f64,
    pub reasoning_output_tokens: Option<f64>,
    pub total_tokens: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexTranscriptTool {
    pub call_id: String,
    pub name: String,
    pub input: Option<JsonValue>,
    pub started_at_ms: f64,
    pub output: Option<JsonValue>,
    pub completed_at_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexTranscriptStep {
    pub started_at_ms: f64,
    pub response_at_ms: f64,
    pub has_response_evidence: bool,
    pub completed_at_ms: f64,
    pub response_id: Option<String>,
    pub input_messages: Option<Vec<JsonValue>>,
    pub reasoning: Vec<String>,
    pub tools: Vec<CodexTranscriptTool>,
    pub token_usage: Option<CodexTranscriptUsage>,
    pub final_text: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CodexTranscriptSourceRecord {
    pub start_offset: i64,
    pub end_offset: i64,
    pub record: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexPartialTurnExtraction {
    pub turn: CodexExtractedTranscriptTurn,
    pub committed_step_count: usize,
    pub committed_step_ranges: Vec<CodexTranscriptSourceRange>,
    pub consumed_end_offset: i64,
    pub next_step_started_at_ms: Option<f64>,
    pub last_cumulative_token_total: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexExtractedTranscriptTurn {
    pub session_id: String,
    pub transcript_turn_id: String,
    pub provider: String,
    pub model: String,
    pub status: CodexTerminalStatus,
    pub started_at_ms: f64,
    pub terminal_at_ms: f64,
    pub prompt: Option<String>,
    pub prompt_ready: bool,
    pub input_messages: Vec<JsonValue>,
    pub cwd: Option<String>,
    pub developer_instructions: Option<String>,
    pub base_instructions: Option<String>,
    pub tool_definitions: Option<JsonValue>,
    pub steps: Vec<CodexTranscriptStep>,
    pub unmatched_token_usages: Vec<CodexTranscriptUsage>,
}
