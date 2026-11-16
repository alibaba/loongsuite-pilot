//! SDK hooks depend on the shipped adapters, independently of CLI hook dispatch.

use super::hook_protocol::MAX_REQUEST;
use super::outbox::Outbox;
use crate::interceptor::{adapters::parse_hook_request, HookRequest, InterceptorAgent};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub(super) struct AgentHook(InterceptorAgent);

impl AgentHook {
    pub(super) fn for_wire_id(id: &str) -> Option<Self> {
        Some(Self(match id {
            "qoder" => InterceptorAgent::Qoder,
            "qodercli" => InterceptorAgent::QoderCli,
            "codex" => InterceptorAgent::Codex,
            _ => return None,
        }))
    }

    pub(super) fn policy_id(self) -> &'static str {
        match self.0 {
            InterceptorAgent::QoderCli => "qoder",
            agent => agent.as_str(),
        }
    }

    pub(super) fn supports_blocking(self, event: &str) -> bool {
        match self.0 {
            InterceptorAgent::Codex => event == "PreToolUse",
            InterceptorAgent::Qoder | InterceptorAgent::QoderCli => {
                matches!(event, "PreToolUse" | "PostToolUse" | "UserPromptSubmit")
            }
            _ => false,
        }
    }

    pub(super) fn parse(self, payload: &Map<String, Value>, event: &str) -> Option<HookRequest> {
        // These adapters share the current session/tool field names.
        parse_hook_request(payload, self.0, Some(event))
    }

    pub(super) fn wakeup(
        self,
        payload: &Map<String, Value>,
        event: &str,
        settings: &Value,
        queue: &Outbox,
    ) {
        let Some(plan) = settings["collector_plans"].get(self.policy_id()) else {
            return;
        };
        let Some(data) = settings["data_dir"].as_str() else {
            return;
        };
        let Some(path) = payload
            .get("transcript_path")
            .or_else(|| payload.get("transcriptPath"))
            .and_then(Value::as_str)
            .filter(|path| Path::new(path).is_absolute())
            .and_then(|path| super::policy::canonical_candidate(Path::new(path)).ok())
        else {
            return;
        };
        let roots: Vec<PathBuf> = plan["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|source| source["kind"] == "transcript")
            .filter_map(|source| source["path"].as_str().map(PathBuf::from))
            .collect();
        if roots.is_empty() {
            return;
        }
        let authorized = roots.iter().any(|root| path.starts_with(root));
        let scope = crate::utils::source_access::SourceScope::new(roots, 1, MAX_REQUEST);
        // A session-start hook may precede creation of the authorized file.
        if !authorized || (path.exists() && scope.check(&path).is_err()) {
            queue.alarm(
                "SDK_HOOK_SOURCE_DENIED",
                "Hook transcript is outside the authorized source",
            );
            return;
        }
        let Some(namespace) = plan["namespace"].as_str() else {
            return;
        };
        let state = Path::new(data).join("sources").join(namespace);
        if crate::utils::source_access::private_path(&state).is_err() {
            return;
        }
        let accepted = match self.0 {
            InterceptorAgent::Qoder | InterceptorAgent::QoderCli => {
                let mut value = Value::Object(payload.clone());
                value["transcript_path"] = json!(path);
                crate::hook_process::publish_qoder_wakeup(
                    &value,
                    &state,
                    "qoder",
                    None,
                    &Map::new(),
                    &Map::new(),
                )
            }
            InterceptorAgent::Codex => codex_wakeup(payload, event, &path, &state).is_ok(),
            _ => false,
        };
        if !accepted {
            queue.alarm(
                "SDK_HOOK_WAKEUP",
                "Hook wakeup was not accepted; source progress retained",
            );
        }
    }
}

fn codex_wakeup(
    payload: &Map<String, Value>,
    event: &str,
    path: &Path,
    state: &Path,
) -> anyhow::Result<()> {
    use std::sync::Mutex;
    static MARKERS: Mutex<()> = Mutex::new(());
    let hook_event = match event {
        "UserPromptSubmit" => "user-prompt-submit",
        "SubagentStart" => "subagent-start",
        "Stop" => "stop",
        "SubagentStop" => "subagent-stop",
        "SessionStart" => "session-start",
        "SessionEnd" => "session-end",
        _ => return Ok(()),
    };
    let Some(session) = payload
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
    else {
        return Ok(());
    };
    let directory = state.join("wakeup");
    crate::utils::source_access::private_path(&directory)?;
    std::fs::create_dir_all(&directory)?;
    let file = directory.join(format!(
        "{}.json",
        crate::inputs::codex_transcript::safe_wakeup_session_part(session)
    ));
    let _guard = MARKERS.lock().unwrap();
    use std::io::Read;
    let mut bytes = Vec::new();
    let mut marker = crate::utils::source_access::open_under(&file, &directory)
        .and_then(|file| file.take(8192).read_to_end(&mut bytes))
        .ok()
        .and_then(|_| serde_json::from_slice::<Map<String, Value>>(&bytes).ok())
        .filter(|marker| marker.get("session_id").and_then(Value::as_str) == Some(session))
        .unwrap_or_default();
    marker.insert("session_id".into(), json!(session));
    marker.insert("transcript_path".into(), json!(path));
    marker.insert("hook_event".into(), json!(hook_event));
    marker.insert("received_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    if let Some(turn) = payload
        .get("turn_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 128)
    {
        if matches!(hook_event, "user-prompt-submit" | "subagent-start")
            && !marker.contains_key("recovery_turn_id")
        {
            marker
                .entry("initial_turn_id")
                .or_insert_with(|| json!(turn));
        } else if matches!(hook_event, "stop" | "subagent-stop") {
            marker.insert("recovery_turn_id".into(), json!(turn));
        }
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut temporary, &marker)?;
    temporary.persist(file)?;
    Ok(())
}
