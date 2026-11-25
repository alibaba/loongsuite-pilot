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
            "qoder-cn" => InterceptorAgent::QoderCn,
            "qoderclicn" => InterceptorAgent::QoderCliCn,
            "codex" => InterceptorAgent::Codex,
            _ => return None,
        }))
    }

    pub(super) fn policy_id(self) -> &'static str {
        match self.0 {
            InterceptorAgent::QoderCli => "qoder",
            InterceptorAgent::QoderCliCn => "qoder-cn",
            agent => agent.as_str(),
        }
    }

    pub(super) fn supports_blocking(self, event: &str) -> bool {
        match self.0 {
            InterceptorAgent::Qoder
            | InterceptorAgent::QoderCli
            | InterceptorAgent::QoderCn
            | InterceptorAgent::QoderCliCn
            | InterceptorAgent::Codex => {
                matches!(event, "PreToolUse" | "PostToolUse" | "UserPromptSubmit")
            }
            _ => false,
        }
    }

    pub(super) fn supports_channel(self, channel: &str) -> bool {
        !self.0.is_qoder_cn() || channel == "local"
    }

    pub(super) fn parse(self, payload: &Map<String, Value>, event: &str) -> Option<HookRequest> {
        // These adapters share the current session/tool field names.
        parse_hook_request(payload, self.0, Some(event))
    }

    pub(super) fn wakeup(
        self,
        payload: &Map<String, Value>,
        event: &str,
        channel: &str,
        settings: &Value,
        queue: &Outbox,
    ) -> bool {
        if self.0.is_qoder_cn() {
            return false;
        }
        let is_codex = self.0 == InterceptorAgent::Codex;
        let codex_event = codex_observe_event(event);
        let codex_prompt =
            is_codex && event == "UserPromptSubmit" && matches!(channel, "local" | "cloud");
        if is_codex && (codex_event.is_none() || (channel != "observe" && !codex_prompt)) {
            return false;
        }
        let Some(plan) = settings["collector_plans"].get(self.policy_id()) else {
            return false;
        };
        let Some(data) = settings["data_dir"].as_str() else {
            return false;
        };
        let pilot_host = plan.pointer("/pilot_host/data_dir").and_then(Value::as_str);
        if pilot_host.is_some() && channel != "observe" && !codex_prompt {
            return false;
        }
        if is_codex && plan["profile"] != "codex_rollout_v1" {
            return false;
        }
        let Some(path) = (if is_codex && event == "SubagentStop" {
            payload.get("agent_transcript_path")
        } else {
            None
        })
        .or_else(|| payload.get("transcript_path"))
        .or_else(|| payload.get("transcriptPath"))
        .and_then(Value::as_str)
        .filter(|path| Path::new(path).is_absolute())
        .and_then(|path| super::policy::canonical_candidate(Path::new(path)).ok()) else {
            return false;
        };
        let mut roots: Vec<PathBuf> = plan["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|source| source["kind"] == "transcript")
            .filter_map(|source| source["path"].as_str().map(PathBuf::from))
            .collect();
        if roots.is_empty() {
            return false;
        }
        let codex_home = is_codex
            .then(|| roots[0].parent())
            .flatten()
            .map(Path::to_path_buf);
        if let Some(home) = codex_home.as_ref().filter(|_| pilot_host.is_some()) {
            if let Some(sessions) = crate::hook_process::codex::isolated_session_dir(&path, home) {
                roots.push(sessions);
            }
        }
        let authorized = roots.iter().any(|root| path.starts_with(root));
        let scope = crate::utils::source_access::SourceScope::new(roots, 1, MAX_REQUEST);
        // A session-start hook may precede creation of the authorized file.
        if !authorized || (path.exists() && scope.check(&path).is_err()) {
            queue.alarm(
                "SDK_HOOK_SOURCE_DENIED",
                "Hook transcript is outside the authorized source",
            );
            return false;
        }
        let state = if let Some(host) = pilot_host {
            PathBuf::from(host)
        } else {
            let Some(namespace) = plan["namespace"].as_str() else {
                return false;
            };
            Path::new(data).join("sources").join(namespace)
        };
        if crate::utils::source_access::private_path(&state).is_err() {
            return false;
        }
        let accepted = match self.0 {
            InterceptorAgent::Qoder | InterceptorAgent::QoderCli => {
                let mut value = Value::Object(payload.clone());
                value["transcript_path"] = json!(path);
                value["hook_event_name"] = json!(event);
                if pilot_host.is_some() {
                    let Some(home) = settings["home_dir"].as_str() else {
                        return false;
                    };
                    crate::hook_process::publish_sdk_host_wakeup(&value, &state, Path::new(home))
                } else {
                    crate::hook_process::publish_qoder_wakeup(
                        &value,
                        &state,
                        "qoder",
                        None,
                        &Map::new(),
                        &Map::new(),
                    )
                }
            }
            InterceptorAgent::Codex => codex_home.is_some_and(|home| {
                crate::hook_process::codex::publish_sdk_wakeup(
                    payload,
                    codex_event.expect("validated Codex event"),
                    &path,
                    &state,
                    &home,
                )
            }),
            _ => false,
        };
        if !accepted {
            queue.alarm(
                "SDK_HOOK_WAKEUP",
                "Hook wakeup was not accepted; source progress retained",
            );
        }
        accepted
    }
}

pub(crate) fn codex_command(
    executable: &Path,
    data_dir: &Path,
    event: &str,
    channel: &str,
) -> Option<String> {
    let codex = AgentHook::for_wire_id("codex")?;
    let supported = match channel {
        "local" | "cloud" => codex.supports_blocking(event),
        "observe" => codex_observe_event(event).is_some(),
        _ => false,
    };
    if !supported {
        return None;
    }
    let executable = quote_codex_path(executable)?;
    let data_dir = quote_codex_path(data_dir)?;
    Some(format!(
        "{executable} sdk-hook --channel {channel} --agent codex --event {event} --data-dir {data_dir} --pilot-sdk-managed"
    ))
}

pub(crate) fn codex_command_executable(command: &str) -> Option<PathBuf> {
    let (quoted, _) = command.split_once(" sdk-hook --channel ")?;
    let executable = if cfg!(windows) {
        quoted.strip_prefix('"')?.strip_suffix('"')?.to_owned()
    } else {
        quoted
            .strip_prefix('\'')?
            .strip_suffix('\'')?
            .replace("'\\''", "'")
    };
    let executable = PathBuf::from(executable);
    (quote_codex_path(&executable).as_deref() == Some(quoted)).then_some(executable)
}

pub(crate) fn codex_shell_path(path: &Path) -> std::borrow::Cow<'_, Path> {
    #[cfg(windows)]
    if let Some(path) = path.to_str() {
        // cmd.exe cannot execute a verbatim-prefixed program path. Keep
        // verbatim paths for filesystem I/O and lower them at the command boundary.
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return std::borrow::Cow::Owned(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(disk) = path.strip_prefix(r"\\?\").filter(|rest| {
            let bytes = rest.as_bytes();
            bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1..3) == Some(b":\\")
        }) {
            return std::borrow::Cow::Owned(PathBuf::from(disk));
        }
    }
    std::borrow::Cow::Borrowed(path)
}

pub(crate) fn quote_codex_path(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let shell_path = codex_shell_path(path);
    let path = shell_path.to_str()?;
    if path.chars().any(char::is_control) {
        return None;
    }
    if cfg!(windows) {
        // cmd.exe expands these even inside a quoted argument.
        if path.contains(['"', '%', '!']) {
            return None;
        }
        Some(format!("\"{path}\""))
    } else {
        Some(format!("'{}'", path.replace('\'', "'\\''")))
    }
}

fn codex_observe_event(event: &str) -> Option<&'static str> {
    Some(match event {
        "SessionStart" => "session-start",
        "UserPromptSubmit" => "user-prompt-submit",
        "SubagentStart" => "subagent-start",
        "SubagentStop" => "subagent-stop",
        "Stop" => "stop",
        _ => return None,
    })
}
