use super::ClientType;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;
use std::str::FromStr;

macro_rules! str_enum {
    ($name:ident { $($var:ident = $s:literal),* $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $s)] $var,)*
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$($name::$var),*];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$var => $s,)*
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = String;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($s => Ok($name::$var),)*
                    other => Err(format!("unknown {}: {other}", stringify!($name))),
                }
            }
        }
    };
}

pub type JsonValue = Value;

str_enum!(ActionType {
    Create = "create",
    Edit = "edit",
    Delete = "delete",
    Read = "read",
    Search = "search",
    Execute = "execute",
    Browse = "browse",
    Other = "other",
});

str_enum!(AgentEventName {
    LlmRequest = "llm.request",
    LlmResponse = "llm.response",
    ToolCall = "tool.call",
    ToolResult = "tool.result",
    ModelRequest = "gen_ai.model.request",
    ModelResponse = "gen_ai.model.response",
    GenAiToolCall = "gen_ai.tool.call",
    GenAiToolResult = "gen_ai.tool.result",
    AgentInvoke = "gen_ai.agent.invoke",
    AgentResult = "gen_ai.agent.result",
    SkillUse = "skill.use",
    ToolApprove = "tool.approve",
    AgentInput = "agent.input",
    ReactStep = "react.step",
    Other = "other",
});

str_enum!(GuardrailAction {
    Allow = "allow",
    Block = "block",
});

str_enum!(GrokMatchStrategy {
    Id = "id",
    NameOrder = "name_order",
    Unmatched = "unmatched",
});

str_enum!(GrokTimingSource {
    Unified = "unified",
    Updates = "updates",
    Hook = "hook",
});

str_enum!(ToolCallStatus {
    Success = "success",
    Failure = "failure",
    Pending = "pending",
});

str_enum!(MessageRole {
    User = "user",
    Assistant = "assistant",
    System = "system",
    Tool = "tool",
});

str_enum!(MessageItemType {
    Text = "text",
    Thinking = "thinking",
    ToolUse = "tool_use",
    ToolResult = "tool_result",
});

str_enum!(GitHookEventType {
    PostCommit = "post-commit",
    PrePush = "pre-push",
});

/// Unified AI agent event. Dotted keys mirror the SLS wide-table schema.
/// Unknown keys round-trip through `extra`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AgentActivityEntry {
    #[serde(default)]
    pub time_unix_nano: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_time_unix_nano: Option<String>,
    #[serde(rename = "event.id", default)]
    pub event_id: String,
    #[serde(rename = "user.id", default)]
    pub user_id: String,
    #[serde(rename = "user.name", default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(
        rename = "user.email",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub user_email: Option<String>,
    #[serde(
        rename = "event.name",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub event_name: Option<AgentEventName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    #[serde(rename = "host.name", default, skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
    #[serde(rename = "host.ip", default, skip_serializing_if = "Option::is_none")]
    pub host_ip: Option<String>,
    #[serde(
        rename = "service.name",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub service_name: Option<String>,
    #[serde(rename = "gen_ai.session.id", default)]
    pub session_id: String,
    #[serde(
        rename = "gen_ai.turn.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub turn_id: Option<String>,
    #[serde(
        rename = "gen_ai.step.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub step_id: Option<String>,
    #[serde(
        rename = "gen_ai.turn.start",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub turn_start: Option<bool>,
    #[serde(
        rename = "gen_ai.turn.end",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub turn_end: Option<bool>,
    #[serde(
        rename = "gen_ai.response.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub response_id: Option<String>,
    #[serde(rename = "gen_ai.agent.type", default)]
    pub agent_type: String,
    #[serde(
        rename = "gen_ai.agent.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_id: Option<String>,
    #[serde(
        rename = "gen_ai.agent.name",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_name: Option<String>,
    #[serde(
        rename = "gen_ai.agent.description",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_description: Option<String>,
    #[serde(
        rename = "gen_ai.data_source.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub data_source_id: Option<String>,
    #[serde(rename = "gen_ai.provider.name", default)]
    pub provider_name: String,
    #[serde(
        rename = "gen_ai.request.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub request_id: Option<String>,
    #[serde(
        rename = "http.response.status_code",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub http_response_status_code: Option<i64>,
    #[serde(
        rename = "gen_ai.request.model",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub request_model: Option<String>,
    #[serde(
        rename = "gen_ai.response.model",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub response_model: Option<String>,
    #[serde(
        rename = "gen_ai.response.finish_reasons",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub finish_reasons: Option<Vec<String>>,
    #[serde(
        rename = "gen_ai.response.time_to_first_token",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub time_to_first_token: Option<i64>,
    #[serde(
        rename = "gen_ai.usage.input_tokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_tokens: Option<i64>,
    #[serde(
        rename = "gen_ai.usage.output_tokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub output_tokens: Option<i64>,
    #[serde(
        rename = "gen_ai.usage.cache_read.input_tokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_read_input_tokens: Option<i64>,
    #[serde(
        rename = "gen_ai.usage.cache_creation.input_tokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_creation_input_tokens: Option<i64>,
    #[serde(
        rename = "gen_ai.usage.total_tokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub total_tokens: Option<i64>,
    #[serde(
        rename = "gen_ai.usage.input_cost",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_cost: Option<f64>,
    #[serde(
        rename = "gen_ai.usage.output_cost",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub output_cost: Option<f64>,
    #[serde(
        rename = "gen_ai.usage.cache_read.input_cost",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_read_input_cost: Option<f64>,
    #[serde(
        rename = "gen_ai.usage.cache_creation.input_cost",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_creation_input_cost: Option<f64>,
    #[serde(
        rename = "gen_ai.usage.total_cost",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub total_cost: Option<f64>,
    #[serde(
        rename = "gen_ai.input.messages_hash",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_messages_hash: Option<String>,
    #[serde(
        rename = "gen_ai.input.messages_delta",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_messages_delta: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.input.messages",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_messages: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.input.multimodal_metadata",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_multimodal_metadata: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.input.multimodal_metadata_delta",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_multimodal_metadata_delta: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.output.messages",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub output_messages: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.output.multimodal_metadata",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub output_multimodal_metadata: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.tool.name",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_name: Option<String>,
    #[serde(
        rename = "gen_ai.tool.call.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_id: Option<String>,
    #[serde(
        rename = "gen_ai.tool.call.exec.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_exec_id: Option<String>,
    #[serde(
        rename = "gen_ai.tool.call.arguments",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_arguments: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.tool.call.result",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_result: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.tool.call.duration",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_duration: Option<f64>,
    #[serde(
        rename = "gen_ai.guardrail.triggered",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub guardrail_triggered: Option<bool>,
    #[serde(
        rename = "gen_ai.guardrail.action",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub guardrail_action: Option<GuardrailAction>,
    #[serde(
        rename = "agent.workbuddy.usage.credit",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workbuddy_usage_credit: Option<f64>,
    #[serde(
        rename = "tool.result.status",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_result_status: Option<String>,
    #[serde(
        rename = "loongsuite.grok.match.strategy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub grok_match_strategy: Option<GrokMatchStrategy>,
    #[serde(
        rename = "loongsuite.grok.timing.source",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub grok_timing_source: Option<GrokTimingSource>,
    #[serde(
        rename = "gen_ai.skill.name",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub skill_name: Option<String>,
    #[serde(
        rename = "gen_ai.skill.id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub skill_id: Option<String>,
    #[serde(
        rename = "gen_ai.skill.description",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub skill_description: Option<String>,
    #[serde(
        rename = "gen_ai.skill.version",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub skill_version: Option<String>,
    #[serde(
        rename = "gen_ai.system_instructions",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub system_instructions: Option<JsonValue>,
    #[serde(
        rename = "gen_ai.tool.definitions",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_definitions: Option<JsonValue>,
    #[serde(rename = "git.repo", default, skip_serializing_if = "Option::is_none")]
    pub git_repo: Option<String>,
    #[serde(
        rename = "git.branch",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub git_branch: Option<String>,
    #[serde(
        rename = "git.repo_root",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub git_repo_root: Option<String>,
    #[serde(
        rename = "git.domain",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub git_domain: Option<String>,
    #[serde(
        rename = "workspace.current_root",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_current_root: Option<String>,
    #[serde(
        rename = "workspace.path",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_path: Option<String>,
    #[serde(
        rename = "error.type",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub error_type: Option<String>,
    #[serde(
        rename = "error.message",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub error_message: Option<String>,
    #[serde(
        rename = "resourceAttributes",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub resource_attributes: Option<Map<String, JsonValue>>,
    #[serde(flatten)]
    pub extra: Map<String, JsonValue>,
}

impl AgentActivityEntry {
    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        self.extra.get(key)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeGenerationEvent {
    pub agent_type: ClientType,
    pub file_path: String,
    pub action_type: ActionType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    pub source_timestamp: i64,
    pub raw_data: Map<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Map<String, JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub status: ToolCallStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MessageItem {
    #[serde(rename = "type")]
    pub item_type: MessageItemType,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MessageRecord {
    pub role: MessageRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<MessageItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    pub agent_type: ClientType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<MessageRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
}

pub type SerializedLogEntry = indexmap::IndexMap<String, String>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitHookEvent {
    pub event_type: GitHookEventType,
    pub repo_root: String,
    pub commit_hash: String,
    pub branch_name: String,
    pub changed_files: Vec<String>,
    pub timestamp: i64,
}
