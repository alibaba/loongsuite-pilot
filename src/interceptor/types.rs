//! Hook names, verdicts, and daemon identity.
//!
//! JSON names match `src/interceptor/types.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SUPPORTED_HOOK_EVENTS: &[&str] = &["UserPromptSubmit", "PreToolUse", "PostToolUse"];
pub const INTERCEPTOR_AGENTS: &[&str] = &["qoder", "qodercli", "openclaw", "qwen-work-cn"];

pub const INTERCEPTOR_SERVICE: &str = "loongsuite-pilot-interceptor";
pub const INTERCEPTOR_DEFAULT_PORT: u16 = 18791;
pub const INTERCEPTOR_HOOK_TIMEOUT_MS: u64 = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HookEventName {
    #[serde(rename = "UserPromptSubmit")]
    UserPromptSubmit,
    #[serde(rename = "PreToolUse")]
    PreToolUse,
    #[serde(rename = "PostToolUse")]
    PostToolUse,
}

impl HookEventName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
        }
    }

    pub fn timeout_sec(self) -> u64 {
        match self {
            Self::UserPromptSubmit => 15,
            Self::PreToolUse | Self::PostToolUse => 10,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InterceptorAgent {
    #[serde(rename = "qoder")]
    Qoder,
    #[serde(rename = "qodercli")]
    QoderCli,
    #[serde(rename = "openclaw")]
    OpenClaw,
    #[serde(rename = "qwen-work-cn")]
    QwenWorkCn,
}

impl InterceptorAgent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Qoder => "qoder",
            Self::QoderCli => "qodercli",
            Self::OpenClaw => "openclaw",
            Self::QwenWorkCn => "qwen-work-cn",
        }
    }
}

pub fn is_interceptor_agent(value: &str) -> bool {
    InterceptorAgent::parse(value).is_some()
}

impl InterceptorAgent {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "qoder" => Some(Self::Qoder),
            "qodercli" => Some(Self::QoderCli),
            "openclaw" => Some(Self::OpenClaw),
            "qwen-work-cn" => Some(Self::QwenWorkCn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QoderSurface {
    #[serde(rename = "qoder")]
    Qoder,
    #[serde(rename = "qodercli")]
    QoderCli,
}

impl QoderSurface {
    pub fn as_agent(self) -> InterceptorAgent {
        match self {
            Self::Qoder => InterceptorAgent::Qoder,
            Self::QoderCli => InterceptorAgent::QoderCli,
        }
    }

    pub fn as_str(self) -> &'static str {
        self.as_agent().as_str()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerdictAction {
    Allow,
    Block,
}

impl VerdictAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Block => "block",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookRequest {
    pub agent: InterceptorAgent,
    pub event: HookEventName,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "transcriptPath"
    )]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "toolName")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "toolInput")]
    pub tool_input: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "toolResponse"
    )]
    pub tool_response: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "toolUseId")]
    pub tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default)]
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleResult {
    Miss,
    Match { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluateHookResponse {
    pub action: VerdictAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ruleId")]
    pub rule_id: Option<String>,
    #[serde(rename = "evaluatedRules")]
    pub evaluated_rules: Vec<String>,
    /// The host is allowed because evaluation failed, not because rules passed.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "failOpen")]
    pub fail_open: Option<bool>,
}

impl EvaluateHookResponse {
    pub fn allow(evaluated_rules: Vec<String>) -> Self {
        Self {
            action: VerdictAction::Allow,
            reason: None,
            rule_id: None,
            evaluated_rules,
            fail_open: None,
        }
    }

    pub fn fail_open(evaluated_rules: Vec<String>) -> Self {
        Self {
            action: VerdictAction::Allow,
            reason: None,
            rule_id: None,
            evaluated_rules,
            fail_open: Some(true),
        }
    }

    pub fn block(reason: String, rule_id: String, evaluated_rules: Vec<String>) -> Self {
        Self {
            action: VerdictAction::Block,
            reason: Some(reason),
            rule_id: Some(rule_id),
            evaluated_rules,
            fail_open: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterceptorHealth {
    pub service: String,
    pub status: String,
    pub pid: u64,
    pub version: String,
    pub daemon_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterceptorRuntime {
    pub service: String,
    pub status: String,
    pub pid: u64,
    pub version: String,
    pub daemon_port: u16,
    #[serde(rename = "packageVersion")]
    pub package_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "gitCommit")]
    pub git_commit: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "processStartToken"
    )]
    pub process_start_token: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}
