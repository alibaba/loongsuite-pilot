//! Small protocol helpers shared by the SDK and the native hook bin.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub const MAX_REQUEST: usize = 1024 * 1024;
pub const MAX_REPLY: usize = 32 * 1024;
pub const DEADLINE_MS: u64 = 3000;
pub const RECEIPT_TIMEOUT_MS: u64 = 200;
pub const CLOUD_WORKERS: usize = 32;
pub const CLOUD_QUEUE: usize = 32;
pub const CLOUD_IN_FLIGHT: usize = CLOUD_WORKERS + CLOUD_QUEUE;
pub const REPLY_MARGIN_MS: u64 = 100;
pub const TEMPORARY_DENIAL: &str =
    "Pilot could not complete the security check. Retry the operation.";
pub const TRACE_LIMIT: u64 = 8 * 1024 * 1024;
pub const CODEX_OBSERVE_CONTEXT: &str = "_pilot_codex_observe_context";
pub const QODER_OBSERVE_CONTEXT: &str = "_pilot_qoder_observe_context";
pub const QODER_OBSERVE_ENV: [&str; 4] = [
    "TRACEPARENT",
    "AGENTTEAMS_WORKER_NAME",
    "AGENTTEAMS_INSTANCE_ID",
    "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
];
#[derive(Clone, Serialize, Deserialize)]
pub struct Descriptor {
    pub schema: u32,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub instance: String,
    #[serde(default)]
    pub request_receipts: bool,
    #[serde(default)]
    pub cloud_capacity: bool,
}
#[derive(Serialize, Deserialize)]
pub struct Datagram {
    pub schema: u32,
    pub token: String,
    pub id: String,
    pub remaining_ms: u32,
    pub t0_unix_ms: u64,
    pub length: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub managed: bool,
    pub agent: String,
    pub event: String,
    #[serde(default)]
    pub want_receipt: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub capacity_probe: bool,
}
pub fn block_reason(reason: &str) -> &str {
    if reason.is_empty() {
        "Blocked by security policy"
    } else {
        reason
    }
}

pub fn render_block(agent: &str, event: &str, reason: &str) -> Option<String> {
    if !matches!(agent, "qoder" | "qodercli" | "codex") {
        return None;
    }
    let reason = block_reason(reason);
    let output = match event {
        "UserPromptSubmit" => {
            json!({"decision":if agent!="qodercli"{"block"}else{"deny"},"reason":reason})
        }
        "PreToolUse" => {
            json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}})
        }
        "PostToolUse" if agent == "codex" => json!({"decision":"block","reason":reason}),
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

/// Append one complete JSON line without waiting on other processes. The SDK
/// rotates its two files; an offline client may leave a full file in place.
pub fn append_hook_trace(path: &std::path::Path, row: Value) {
    use std::io::Write;
    if std::fs::symlink_metadata(path)
        .is_ok_and(|meta| !meta.is_file() || meta.len() >= TRACE_LIMIT)
    {
        return;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    if let Ok(mut file) = options.open(path) {
        if file
            .metadata()
            .is_ok_and(|meta| meta.is_file() && meta.len() < TRACE_LIMIT)
        {
            let mut bytes = row.to_string().into_bytes();
            bytes.push(b'\n');
            let _ = file.write_all(&bytes);
        }
    }
}
