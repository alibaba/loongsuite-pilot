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
        channel: &str,
        settings: &Value,
        queue: &Outbox,
    ) -> bool {
        let Some(plan) = settings["collector_plans"].get(self.policy_id()) else {
            return false;
        };
        let Some(data) = settings["data_dir"].as_str() else {
            return false;
        };
        let qoder_host = (self.policy_id() == "qoder")
            .then(|| plan.pointer("/pilot_host/data_dir").and_then(Value::as_str))
            .flatten();
        if qoder_host.is_some() && channel != "observe" {
            return false;
        }
        let Some(path) = payload
            .get("transcript_path")
            .or_else(|| payload.get("transcriptPath"))
            .and_then(Value::as_str)
            .filter(|path| Path::new(path).is_absolute())
            .and_then(|path| super::policy::canonical_candidate(Path::new(path)).ok())
        else {
            return false;
        };
        let roots: Vec<PathBuf> = plan["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|source| source["kind"] == "transcript")
            .filter_map(|source| source["path"].as_str().map(PathBuf::from))
            .collect();
        if roots.is_empty() {
            return false;
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
        let state = if let Some(host) = qoder_host {
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
                if qoder_host.is_some() {
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
