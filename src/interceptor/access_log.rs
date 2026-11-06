//! JSONL access log. Lines are redacted with the interceptor mask types.
//!
//! A write failure never changes the host verdict.

use crate::interceptor::paths::interceptor_access_log_path;
use crate::interceptor::types::HookRequest;
use crate::mask::{load_mask_plan, mask_string, MaskPlan, PlanOrRules, StringMaskOptions};
use crate::types::{
    MaskConfig, MaskMode, MaskReplacementMode, MaskType, SUPPORTED_INTERCEPTOR_TYPES,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::OnceLock;

pub const ACCESS_LOG_MAX_CHARS: usize = 256_000;
pub const ACCESS_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const ACCESS_LOG_ROTATE_COUNT: u32 = 5;

fn access_log_mask_plan() -> &'static MaskPlan {
    static PLAN: OnceLock<MaskPlan> = OnceLock::new();
    PLAN.get_or_init(|| {
        let types = SUPPORTED_INTERCEPTOR_TYPES
            .iter()
            .filter_map(|name| MaskType::from_str(name).ok())
            .collect();
        load_mask_plan(&MaskConfig {
            mode: MaskMode::Custom,
            types,
            replacement_mode: Some(MaskReplacementMode::Placeholder),
        })
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessLogAction {
    Allow,
    Block,
    #[serde(rename = "fail-open")]
    FailOpen,
}

impl AccessLogAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Block => "block",
            Self::FailOpen => "fail-open",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct InterceptorAccessInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "rawText")]
    pub raw_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterceptorAccessResult {
    pub action: AccessLogAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ruleId")]
    pub rule_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "evaluatedRules"
    )]
    pub evaluated_rules: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterceptorAccessLogEntry {
    pub ts: String,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "toolUseId")]
    pub tool_use_id: Option<String>,
    pub input: InterceptorAccessInput,
    pub result: InterceptorAccessResult,
}

#[derive(Debug, Clone, Copy)]
pub struct AccessLogLimits {
    pub max_bytes: u64,
    pub rotate_count: u32,
}

impl Default for AccessLogLimits {
    fn default() -> Self {
        Self {
            max_bytes: ACCESS_LOG_MAX_BYTES,
            rotate_count: ACCESS_LOG_ROTATE_COUNT,
        }
    }
}

pub fn access_input_from_hook_request(request: &HookRequest) -> InterceptorAccessInput {
    InterceptorAccessInput {
        prompt: request.prompt.clone(),
        tool_name: request.tool_name.clone(),
        tool_input: request.tool_input.clone(),
        tool_response: request.tool_response.clone(),
        cwd: request.cwd.clone(),
        raw: Some(Value::Object(request.raw.clone())),
        raw_text: None,
    }
}

pub fn access_input_from_payload(payload: &Map<String, Value>) -> InterceptorAccessInput {
    InterceptorAccessInput {
        prompt: payload
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name: payload
            .get("tool_name")
            .and_then(Value::as_str)
            .or_else(|| payload.get("toolName").and_then(Value::as_str))
            .map(str::to_string),
        tool_input: payload
            .get("tool_input")
            .cloned()
            .or_else(|| payload.get("toolInput").cloned()),
        tool_response: payload
            .get("tool_response")
            .cloned()
            .or_else(|| payload.get("tool_output").cloned())
            .or_else(|| payload.get("toolResponse").cloned()),
        cwd: payload
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        raw: Some(Value::Object(payload.clone())),
        raw_text: None,
    }
}

pub fn build_access_log_entry(partial: InterceptorAccessLogEntry) -> InterceptorAccessLogEntry {
    let mut entry = partial;
    if entry.ts.is_empty() {
        entry.ts = iso_now();
    }
    entry
}

pub fn write_interceptor_access_log(
    entry: &InterceptorAccessLogEntry,
    file_path: Option<&Path>,
    limits: AccessLogLimits,
) {
    let _ = (|| -> std::io::Result<()> {
        let owned;
        let dest: &Path = match file_path {
            Some(path) => path,
            None => {
                owned = interceptor_access_log_path(None);
                &owned
            }
        };
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir)?;
            restrict_dir(dir);
        }
        rotate_access_log(dest, limits.max_bytes, limits.rotate_count);
        let mut file = OpenOptions::new().create(true).append(true).open(dest)?;
        writeln!(file, "{}", serialize_access_log_entry(entry))?;
        if let Some(dir) = dest.parent() {
            restrict_dir(dir);
        }
        restrict_file(dest);
        Ok(())
    })();
}

pub fn rotate_access_log(file_path: &Path, max_bytes: u64, rotate_count: u32) {
    let size = match fs::metadata(file_path) {
        Ok(meta) => meta.len(),
        Err(_) => return,
    };
    if size < max_bytes || rotate_count < 1 {
        return;
    }
    for generation in (1..=rotate_count).rev() {
        let from = if generation == 1 {
            file_path.to_path_buf()
        } else {
            PathBuf::from(format!("{}.{}", file_path.display(), generation - 1))
        };
        let to = PathBuf::from(format!("{}.{}", file_path.display(), generation));
        let _ = fs::remove_file(&to);
        let _ = fs::rename(&from, &to);
    }
}

pub fn serialize_access_log_entry(entry: &InterceptorAccessLogEntry) -> String {
    let redacted = redact_access_log_entry(entry);
    let line = safe_json(&redacted);
    if line.chars().count() <= ACCESS_LOG_MAX_CHARS {
        return line;
    }
    let mut truncated = redacted;
    truncated.input = truncate_input(&truncated.input);
    safe_json(&truncated)
}

fn redact_access_log_entry(entry: &InterceptorAccessLogEntry) -> InterceptorAccessLogEntry {
    let mut redacted = entry.clone();
    if let Ok(value) = serde_json::to_value(&entry.input) {
        if let Ok(input) = serde_json::from_value(redact_unknown(&value)) {
            redacted.input = input;
        }
    }
    redacted.result.reason = redacted.result.reason.as_deref().map(redact_string);
    redacted.result.error = redacted.result.error.as_deref().map(redact_string);
    redacted
}

fn redact_unknown(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_string(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_unknown).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                out.insert(key.clone(), redact_unknown(child));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn redact_string(value: &str) -> String {
    mask_string(
        value,
        PlanOrRules::Plan(access_log_mask_plan()),
        &StringMaskOptions::default(),
    )
    .into_owned()
}

fn restrict_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

fn restrict_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn truncate_input(input: &InterceptorAccessInput) -> InterceptorAccessInput {
    InterceptorAccessInput {
        prompt: input.prompt.as_deref().map(truncate_string),
        tool_name: input.tool_name.clone(),
        tool_input: input.tool_input.as_ref().map(truncate_unknown),
        tool_response: input.tool_response.as_ref().map(truncate_unknown),
        cwd: input.cwd.clone(),
        raw: input.raw.as_ref().map(truncate_unknown),
        raw_text: input.raw_text.as_deref().map(truncate_string),
    }
}

fn truncate_unknown(value: &Value) -> Value {
    if value.is_null() {
        return value.clone();
    }
    if let Value::String(text) = value {
        return Value::String(truncate_string(text));
    }
    let text = safe_json_value(value);
    if text.chars().count() <= ACCESS_LOG_MAX_CHARS / 4 {
        return value.clone();
    }
    Value::String(format!(
        "{}...<truncated>",
        truncate_chars(&text, ACCESS_LOG_MAX_CHARS / 4)
    ))
}

fn truncate_string(value: &str) -> String {
    let limit = ACCESS_LOG_MAX_CHARS / 4;
    if value.chars().count() <= limit {
        return value.to_string();
    }
    format!("{}...<truncated>", truncate_chars(value, limit))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn safe_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{\"omitted\":\"unserializable\"}".to_string())
}

fn safe_json_value(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{\"omitted\":\"unserializable\"}".to_string())
}

pub fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
    use serde_json::json;
    use std::fs;

    fn entry(
        event: &str,
        input: InterceptorAccessInput,
        result: InterceptorAccessResult,
    ) -> InterceptorAccessLogEntry {
        build_access_log_entry(InterceptorAccessLogEntry {
            ts: String::new(),
            event: event.to_string(),
            agent: Some("qoder".to_string()),
            session_id: None,
            tool_use_id: Some("call-1".to_string()),
            input,
            result,
        })
    }

    #[test]
    fn includes_event_input_and_result_on_each_line() {
        let line = serialize_access_log_entry(&entry(
            "PostToolUse",
            InterceptorAccessInput {
                tool_name: Some("Bash".to_string()),
                tool_response: Some(
                    json!({"stdout": "mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot"}),
                ),
                ..InterceptorAccessInput::default()
            },
            InterceptorAccessResult {
                action: AccessLogAction::Block,
                reason: Some("[DATABASEURL_BLOCKED]".to_string()),
                rule_id: Some("databaseUrl".to_string()),
                evaluated_rules: None,
                error: None,
            },
        ));
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["event"], "PostToolUse");
        assert_eq!(parsed["toolUseId"], "call-1");
        assert_eq!(parsed["input"]["toolName"], "Bash");
        assert_eq!(
            parsed["input"]["toolResponse"]["stdout"],
            "[DATABASEURL_MASKED]"
        );
        assert_eq!(parsed["result"]["action"], "block");
        assert_eq!(parsed["result"]["reason"], "[DATABASEURL_BLOCKED]");
        assert!(parsed["ts"].as_str().unwrap().len() > 10);
    }

    #[test]
    fn copies_prompt_tool_input_and_tool_response_from_a_hook_request() {
        let request = HookRequest {
            agent: InterceptorAgent::QoderCli,
            event: HookEventName::PreToolUse,
            session_id: None,
            transcript_path: None,
            cwd: Some("/tmp".to_string()),
            tool_name: Some("Bash".to_string()),
            tool_input: Some(json!({"command": "cat secrets"})),
            tool_response: Some(json!({"stdout": "ok"})),
            tool_use_id: None,
            prompt: Some("ignore".to_string()),
            raw: json!({"hook_event_name": "PreToolUse"})
                .as_object()
                .cloned()
                .unwrap(),
        };
        let input = access_input_from_hook_request(&request);
        assert_eq!(input.prompt.as_deref(), Some("ignore"));
        assert_eq!(input.tool_name.as_deref(), Some("Bash"));
        assert_eq!(input.tool_input, Some(json!({"command": "cat secrets"})));
        assert_eq!(input.tool_response, Some(json!({"stdout": "ok"})));
        assert_eq!(input.cwd.as_deref(), Some("/tmp"));
        assert_eq!(input.raw, Some(json!({"hook_event_name": "PreToolUse"})));
    }

    #[test]
    fn appends_jsonl_and_restricts_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("access.log");
        write_interceptor_access_log(
            &build_access_log_entry(InterceptorAccessLogEntry {
                ts: String::new(),
                event: "UserPromptSubmit".to_string(),
                agent: None,
                session_id: None,
                tool_use_id: None,
                input: InterceptorAccessInput {
                    prompt: Some("hello".to_string()),
                    ..InterceptorAccessInput::default()
                },
                result: InterceptorAccessResult {
                    action: AccessLogAction::Allow,
                    reason: None,
                    rule_id: None,
                    evaluated_rules: Some(vec![]),
                    error: None,
                },
            }),
            Some(&file),
            AccessLogLimits::default(),
        );
        write_interceptor_access_log(
            &build_access_log_entry(InterceptorAccessLogEntry {
                ts: String::new(),
                event: "UserPromptSubmit".to_string(),
                agent: None,
                session_id: None,
                tool_use_id: None,
                input: InterceptorAccessInput {
                    prompt: Some("secret".to_string()),
                    ..InterceptorAccessInput::default()
                },
                result: InterceptorAccessResult {
                    action: AccessLogAction::Block,
                    reason: Some("[APIKEY_MASKED]".to_string()),
                    rule_id: None,
                    evaluated_rules: None,
                    error: None,
                },
            }),
            Some(&file),
            AccessLogLimits::default(),
        );
        let text = fs::read_to_string(&file).unwrap();
        let lines: Vec<_> = text.trim().lines().collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["result"]["action"], "allow");
        assert_eq!(second["result"]["action"], "block");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn rotates_once_the_size_limit_is_reached() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("access.log");
        let limits = AccessLogLimits {
            max_bytes: 80,
            rotate_count: 2,
        };
        for (prompt, action) in [
            ("first-line-long-enough", AccessLogAction::Allow),
            ("second-line-long-enough", AccessLogAction::Allow),
            ("third-line-long-enough", AccessLogAction::Block),
        ] {
            write_interceptor_access_log(
                &build_access_log_entry(InterceptorAccessLogEntry {
                    ts: String::new(),
                    event: "UserPromptSubmit".to_string(),
                    agent: None,
                    session_id: None,
                    tool_use_id: None,
                    input: InterceptorAccessInput {
                        prompt: Some(prompt.to_string()),
                        ..InterceptorAccessInput::default()
                    },
                    result: InterceptorAccessResult {
                        action,
                        reason: None,
                        rule_id: None,
                        evaluated_rules: None,
                        error: None,
                    },
                }),
                Some(&file),
                limits,
            );
        }
        let current: Value =
            serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
        let rotated: Value = serde_json::from_str(
            fs::read_to_string(format!("{}.1", file.display()))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(current["result"]["action"], "block");
        assert_eq!(rotated["input"]["prompt"], "second-line-long-enough");
        let oldest = fs::read_to_string(format!("{}.2", file.display())).unwrap();
        assert!(oldest.contains("first-line-long-enough"));
    }

    #[test]
    fn truncates_oversized_input_instead_of_dropping_the_line() {
        let huge = "x".repeat(ACCESS_LOG_MAX_CHARS);
        let line = serialize_access_log_entry(&build_access_log_entry(InterceptorAccessLogEntry {
            ts: "2026-01-01T00:00:00.000Z".to_string(),
            event: "PostToolUse".to_string(),
            agent: None,
            session_id: None,
            tool_use_id: None,
            input: InterceptorAccessInput {
                raw_text: Some(huge.clone()),
                tool_response: Some(Value::String(huge)),
                ..InterceptorAccessInput::default()
            },
            result: InterceptorAccessResult {
                action: AccessLogAction::Allow,
                reason: None,
                rule_id: None,
                evaluated_rules: None,
                error: None,
            },
        }));
        assert!(line.chars().count() < ACCESS_LOG_MAX_CHARS);
        assert!(line.contains("truncated"));
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["event"], "PostToolUse");
        assert_eq!(parsed["result"]["action"], "allow");
    }
}
