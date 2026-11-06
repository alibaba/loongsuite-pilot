//! Mimo Code hook JSONL input. Port of `mimo-code-log-input.ts`.

use std::sync::Arc;

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{HookInputOptions, HookJsonlInput};
use crate::types::ClientType;
use crate::utils::{directory_exists, resolve_home};

const DEFAULT_DIR: &str = "~/.loongsuite-pilot/logs/mimo-code";

pub struct MimoCodeLogInput {
    inner: HookJsonlInput,
}

impl MimoCodeLogInput {
    pub fn new(opts: HookInputOptions) -> Self {
        Self {
            inner: HookJsonlInput::shared(
                super::rest_support::HookInputProfile {
                    logger_name: "MimoCodeLogInput",
                    id: "mimo-code-log",
                    agent_type: ClientType::MimoCode,
                    default_dir: DEFAULT_DIR,
                    default_prefix: "mimo-code",
                    git_namespace: "mimo-code",
                    cold_start_keep_last_turn_only: false,
                },
                opts,
            ),
        }
    }

    pub fn with_store(state_store: Arc<StateStore>) -> Self {
        Self::new(HookInputOptions {
            state_store,
            log_dir: None,
            log_prefix: None,
            poll_interval_ms: None,
        })
    }

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home(DEFAULT_DIR)).await
    }

    pub fn watch_paths() -> Vec<String> {
        vec![resolve_home(DEFAULT_DIR)]
    }
}

impl std::ops::Deref for MimoCodeLogInput {
    type Target = HookJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::inputs::rest_support::{entry_json, memory_state_store};
    use crate::utils::get_today_date_string;

    #[tokio::test]
    async fn normalizes_plugin_cwd_into_workspace_and_git_fields() {
        let dir = tempfile::tempdir().expect("temp");
        let store = memory_state_store(dir.path());
        let today = get_today_date_string();
        let cwd = dir.path().to_string_lossy().to_string();
        let record = json!({
            "time_unix_nano": "1784188800000000000",
            "event.id": "mimo-event-1",
            "event.name": "llm.response",
            "gen_ai.session.id": "mimo-session-1",
            "gen_ai.agent.type": ClientType::MimoCode.as_str(),
            "agent.mimo-code.cwd": cwd,
        });
        std::fs::write(
            dir.path().join(format!("mimo-code-{today}.jsonl")),
            format!("{record}\n"),
        )
        .expect("write");
        let input = MimoCodeLogInput::new(HookInputOptions {
            state_store: Arc::clone(&store),
            log_dir: Some(cwd.clone()),
            log_prefix: None,
            poll_interval_ms: Some(60_000),
        });
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().expect("entries").extend(batch.to_vec()));
        input.start().await;
        input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        let value = entry_json(&entries[0]);
        assert_eq!(value["event.id"], "mimo-event-1");
        assert_eq!(value["gen_ai.agent.type"], ClientType::MimoCode.as_str());
        assert_eq!(value["agent.mimo-code.cwd"], cwd);
        assert_eq!(value["workspace.path"], cwd);
    }
}
