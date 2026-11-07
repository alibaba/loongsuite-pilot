//! Small protocol helpers shared by the SDK and the native hook bin.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub const MAX_REQUEST: usize = 1024 * 1024;
pub const MAX_REPLY: usize = 32 * 1024;
pub const DEADLINE_MS: u64 = 3000;
#[derive(Clone, Serialize, Deserialize)]
pub struct Descriptor {
    pub schema: u32,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub instance: String,
}
#[derive(Serialize, Deserialize)]
pub struct Datagram {
    pub schema: u32,
    pub token: String,
    pub id: String,
    pub remaining_ms: u32,
    pub t0_unix_ms: u64,
    pub length: usize,
    pub agent: String,
    pub event: String,
}
pub fn render_block(agent: &str, event: &str, reason: &str) -> Option<String> {
    if !matches!(agent, "qoder" | "qodercli") {
        return None;
    }
    let reason = if reason.is_empty() {
        "Blocked by security policy"
    } else {
        reason
    };
    let output = match event {
        "UserPromptSubmit" => {
            json!({"decision":if agent=="qoder"{"block"}else{"deny"},"reason":reason})
        }
        "PreToolUse" => {
            json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}})
        }
        "PostToolUse" => {
            json!({"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":reason}})
        }
        _ => return None,
    };
    Some(format!("{output}\n"))
}
pub fn reply_action(reply: &Value) -> Option<(&str, &str)> {
    let action = reply.get("action").and_then(Value::as_str)?;
    if !matches!(action, "allow" | "block") {
        return None;
    }
    Some((
        action,
        reply.get("reason").and_then(Value::as_str).unwrap_or(""),
    ))
}
