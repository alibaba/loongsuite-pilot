//! WorkBuddy hook wakeup writer. Port of `assets/hooks/workbuddy-hook-event-writer.mjs`.
//!
//! The hook only records structural fields. Prompt text, tool arguments, and
//! tool results stay out of the file. Any failure still prints `{}`.

use super::common::{data_dir, decode_payload, sha256_hex, write_empty, HookRequest};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let _ = write_event(request);
    write_empty(request.stdout);
    0
}

fn write_event(request: &HookRequest<'_>) -> Result<(), ()> {
    let text = decode_payload(request.stdin);
    let payload: Value = serde_json::from_str(text.trim()).map_err(|_| ())?;
    let session_id = string_field(payload.get("session_id")).ok_or(())?;
    let transcript_path = string_field(payload.get("transcript_path")).ok_or(())?;
    let subcommand = request.args.first().map(String::as_str).unwrap_or("");
    let event_name = string_field(payload.get("hook_event_name"))
        .or_else(|| event_name_from_subcommand(subcommand))
        .or_else(|| {
            if subcommand.is_empty() {
                None
            } else {
                Some(subcommand.to_string())
            }
        })
        .unwrap_or_else(|| "unknown".to_string());
    let observed_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let mut record = json!({
        "observed_at_ms": observed_at_ms,
        "hook_event_name": event_name,
        "session_id": session_id.clone(),
        "transcript_path": transcript_path,
    });
    let object = record.as_object_mut().ok_or(())?;
    insert_optional(object, "cwd", string_field(payload.get("cwd")));
    insert_optional(object, "tool_name", string_field(payload.get("tool_name")));
    insert_optional(
        object,
        "tool_call_id",
        string_field(payload.get("call_id")).or_else(|| string_field(payload.get("tool_use_id"))),
    );
    insert_optional(object, "model", string_field(payload.get("model")));
    insert_optional(
        object,
        "permission_mode",
        string_field(payload.get("permission_mode")),
    );
    insert_optional(
        object,
        "agent_type",
        string_field(payload.get("agent_type")),
    );

    let dir = data_dir(request.env)
        .join("state")
        .join("workbuddy")
        .join("hook-events")
        .join(safe_session_dir_name(&session_id));
    fs::create_dir_all(&dir).map_err(|_| ())?;
    set_dir_mode(&dir);
    let unique = format!(
        "{observed_at_ms}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let temporary = dir.join(format!(".{unique}.tmp"));
    let destination = dir.join(format!("{unique}.json"));
    let body = serde_json::to_string(&record).map_err(|_| ())?;
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| ())?;
        set_file_mode(&temporary);
        file.write_all(body.as_bytes()).map_err(|_| ())?;
        fs::rename(&temporary, &destination).map_err(|_| ())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(());
    }
    Ok(())
}

fn insert_optional(object: &mut serde_json::Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        object.insert(key.to_string(), Value::String(value));
    }
}

fn string_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn event_name_from_subcommand(subcommand: &str) -> Option<String> {
    match subcommand {
        "session-start" => Some("SessionStart".into()),
        "user-prompt-submit" => Some("UserPromptSubmit".into()),
        "pre-tool-use" => Some("PreToolUse".into()),
        "post-tool-use" => Some("PostToolUse".into()),
        "stop" => Some("Stop".into()),
        _ => None,
    }
}

fn safe_session_dir_name(session_id: &str) -> String {
    let base = Path::new(session_id)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(session_id);
    let mut readable: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if readable.is_empty() {
        readable = "session".to_string();
    }
    let digest = sha256_hex(session_id.as_bytes());
    format!("{readable}-{}", &digest[..12])
}

fn set_dir_mode(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn set_file_mode(path: &Path) {
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

#[cfg(test)]
mod tests {
    use super::super::common::Env;
    use super::*;
    use std::fs;

    #[test]
    fn writes_structural_fields_and_fails_open() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            dir.path().to_string_lossy().into_owned(),
        );
        let input = r#"{"session_id":"safe-session","transcript_path":"/tmp/safe/session.jsonl","cwd":"/tmp/safe","hook_event_name":"PreToolUse","tool_name":"Bash","call_id":"safe-call","prompt":"DO_NOT_PERSIST_PROMPT","tool_input":{"command":"DO_NOT_PERSIST_ARGUMENTS"},"tool_response":"DO_NOT_PERSIST_RESULT"}"#;
        let mut stdout = Vec::new();
        let mut request = HookRequest {
            args: &["pre-tool-use".into()],
            stdin: input.as_bytes(),
            env: &env,
            stdout: &mut stdout,
        };
        assert_eq!(run(&mut request), 0);
        assert_eq!(String::from_utf8(stdout).unwrap().trim(), "{}");
        let records = read_records(dir.path());
        assert_eq!(records.len(), 1);
        let text = records[0].to_string();
        assert!(text.contains("safe-session"));
        assert!(text.contains("safe-call"));
        assert!(!text.contains("DO_NOT_PERSIST"));

        let mut stdout = Vec::new();
        let mut request = HookRequest {
            args: &["stop".into()],
            stdin: b"{bad-json",
            env: &env,
            stdout: &mut stdout,
        };
        assert_eq!(run(&mut request), 0);
        assert_eq!(String::from_utf8(stdout).unwrap().trim(), "{}");
    }

    #[test]
    fn concurrent_events_do_not_share_one_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            dir.path().to_string_lossy().into_owned(),
        );
        for index in 0..8 {
            let input = format!(
                r#"{{"session_id":"parallel-session","transcript_path":"/tmp/parallel-session.jsonl","hook_event_name":"PreToolUse","tool_name":"ParallelTool","call_id":"call-{index}"}}"#
            );
            let mut stdout = Vec::new();
            let mut request = HookRequest {
                args: &["pre-tool-use".into()],
                stdin: input.as_bytes(),
                env: &env,
                stdout: &mut stdout,
            };
            assert_eq!(run(&mut request), 0);
        }
        let records = read_records(dir.path());
        assert_eq!(records.len(), 8);
        let ids: std::collections::HashSet<_> = records
            .iter()
            .filter_map(|record| record.get("tool_call_id").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        assert_eq!(ids.len(), 8);
    }

    fn read_records(root: &Path) -> Vec<Value> {
        let events = root.join("state").join("workbuddy").join("hook-events");
        let mut records = Vec::new();
        let Ok(sessions) = fs::read_dir(&events) else {
            return records;
        };
        for session in sessions.flatten() {
            let Ok(files) = fs::read_dir(session.path()) else {
                continue;
            };
            for file in files.flatten() {
                if file.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(file.path()) {
                    if let Ok(value) = serde_json::from_str(&text) {
                        records.push(value);
                    }
                }
            }
        }
        records
    }
}
