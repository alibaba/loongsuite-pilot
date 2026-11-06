//! Copilot hooks publish discovery metadata only; the collector owns parsing.
use super::common::{self, HookRequest};
use serde_json::{json, Value};

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let event = request
        .args
        .first()
        .map(|event| event.trim())
        .unwrap_or_default();
    if [
        "session-start",
        "user-prompt-submit",
        "user-prompt-submitted",
        "pre-tool-use",
        "post-tool-use",
        "post-tool-use-failure",
        "session-end",
        "stop",
        "agent-stop",
    ]
    .contains(&event)
    {
        let decoded = common::decode_payload(request.stdin);
        if let Ok(Value::Object(input)) = serde_json::from_str::<Value>(&decoded) {
            let session = input
                .get("sessionId")
                .or_else(|| input.get("session_id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !session.is_empty() {
                let name = std::path::Path::new(session)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown")
                    .chars()
                    .map(|ch| {
                        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                            ch
                        } else {
                            '_'
                        }
                    })
                    .collect::<String>();
                let directory = common::data_dir(request.env).join("state/copilot/session-wakeups");
                let file = format!("{}.json", if name.is_empty() { "unknown" } else { &name });
                let existing = std::fs::read_to_string(directory.join(&file))
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                let mut marker = existing;
                marker.insert("session_id".into(), json!(session));
                for (camel, snake, target) in [
                    ("turnId", "turn_id", "turn_id"),
                    ("interactionId", "interaction_id", "interaction_id"),
                    ("cwd", "cwd", "cwd"),
                ] {
                    if let Some(value) = input
                        .get(camel)
                        .or_else(|| input.get(snake))
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                    {
                        marker.insert(target.into(), json!(value));
                    }
                }
                let home = common::env_get(request.env, "COPILOT_HOME")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| common::home_dir(request.env).join(".copilot"));
                marker.insert(
                    "copilot_session_dir".into(),
                    json!(home.join("session-state").join(session)),
                );
                marker.insert("hook_event".into(), json!(event));
                marker.insert(
                    "received_at".into(),
                    json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                );
                marker.remove("otel_file");
                if let Some(path) = common::env_get(request.env, "COPILOT_OTEL_FILE_EXPORTER_PATH")
                {
                    marker.insert("otel_file".into(), json!(path));
                }
                if common::write_atomic_json(&directory, &file, &Value::Object(marker)).is_err() {
                    eprintln!("[loongsuite-pilot] Copilot discovery marker could not be written");
                }
            }
        }
    }
    common::write_empty(request.stdout);
    0
}

#[cfg(test)]
mod tests {
    use super::super::common::Env;
    use super::*;
    #[test]
    fn hook_only_publishes_atomic_discovery_and_preserves_real_exporter_path() {
        let root = tempfile::tempdir().unwrap();
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        );
        env.insert("HOME".into(), root.path().to_string_lossy().into_owned());
        env.insert(
            "COPILOT_OTEL_FILE_EXPORTER_PATH".into(),
            "/native/real.jsonl".into(),
        );
        let args = vec!["session-start".into()];
        let mut stdout = Vec::new();
        assert_eq!(
            run(&mut HookRequest {
                args: &args,
                stdin:
                    br#"{"sessionId":"session-test","turnId":"0","interactionId":"interaction-a"}"#,
                env: &env,
                stdout: &mut stdout
            }),
            0
        );
        assert_eq!(stdout, b"{}\n");
        let path = root
            .path()
            .join("state/copilot/session-wakeups/session-test.json");
        let marker: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(marker["otel_file"], "/native/real.jsonl");
        assert_eq!(marker["interaction_id"], "interaction-a");
        assert!(!root.path().join("logs").exists());
    }
    #[test]
    fn malformed_payload_and_marker_failure_are_fail_open() {
        let root = tempfile::tempdir().unwrap();
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        );
        std::fs::write(root.path().join("state"), "blocked").unwrap();
        for payload in [
            b"broken".as_slice(),
            br#"{"sessionId":"session-test"}"#.as_slice(),
        ] {
            let mut stdout = Vec::new();
            assert_eq!(
                run(&mut HookRequest {
                    args: &["pre-tool-use".into()],
                    stdin: payload,
                    env: &env,
                    stdout: &mut stdout
                }),
                0
            );
            assert_eq!(stdout, b"{}\n");
        }
    }
}
