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
pub const OFFLINE_DENY_FILE: &str = "sdk-offline-deny.json";
pub const OFFLINE_POLICY_LOCK: &str = "sdk-offline-deny.lock";
pub const POLICY_FILES_DIR: &str = "sdk-hook-policy";
pub const OFFLINE_DENY_LIMIT: u64 = 4096;

pub fn can_deny_offline(event: &str) -> bool {
    matches!(event, "PreToolUse" | "UserPromptSubmit")
}

pub type OfflineDenyRules = std::collections::BTreeMap<String, std::collections::BTreeSet<String>>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OfflineDeny {
    pub schema: u32,
    pub events: OfflineDenyRules,
}

pub fn read_offline_deny(root: &std::path::Path) -> Option<OfflineDenyRules> {
    use std::io::Read;
    let path = root.join(OFFLINE_DENY_FILE);
    let lock_path = root.join(OFFLINE_POLICY_LOCK);
    if !std::fs::symlink_metadata(&lock_path).ok()?.is_file() {
        return None;
    }
    let policy_lock = std::fs::File::open(lock_path).ok()?;
    policy_lock.try_lock_shared().ok()?;
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > OFFLINE_DENY_LIMIT {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if meta.permissions().mode() & 0o077 != 0 {
            return None;
        }
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(OFFLINE_DENY_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > OFFLINE_DENY_LIMIT {
        return None;
    }
    // An interrupted deployment may have written the new file before commit.
    let journal = root.join(POLICY_FILES_DIR).join("update-recovery.json");
    if !matches!(std::fs::symlink_metadata(journal), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return None;
    }
    let policy: OfflineDeny = serde_json::from_slice(&bytes).ok()?;
    (policy.schema == 1).then_some(policy.events)
}

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
    if !matches!(
        agent,
        "qoder" | "qodercli" | "qoder-cn" | "qoderclicn" | "codex" | "qwen-work-cn"
    ) {
        return None;
    }
    let host_reason;
    let reason = if agent == "qwen-work-cn" {
        host_reason = wrapped_host_reason(event, Some(reason));
        &host_reason
    } else {
        block_reason(reason)
    };
    let output = match event {
        "UserPromptSubmit" => {
            json!({"decision":if matches!(agent, "qodercli" | "qoderclicn") {"deny"} else {"block"},"reason":reason})
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

/// Match the native Qwen Work command-hook response, including its localized message.
pub fn wrapped_host_reason(event: &str, reason: Option<&str>) -> String {
    let detail = reason.unwrap_or("").trim();
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!("：{detail}")
    };
    match event {
        "UserPromptSubmit" => format!("检测到敏感信息{detail}，本轮对话终止"),
        "PostToolUse" => format!(
            "检测到非预期行为{detail}，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。"
        ),
        _ => format!(
            "检测到非预期行为{detail}，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。"
        ),
    }
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
