//! Grok Build hook JSONL input. Port of `grok-build-log-input.ts`.

use std::sync::Arc;

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{HookInputOptions, HookJsonlInput};
use crate::types::ClientType;
use crate::utils::{directory_exists, resolve_home};

const DEFAULT_DIR: &str = "~/.loongsuite-pilot/logs/grok-build";

pub struct GrokBuildLogInput {
    inner: HookJsonlInput,
}

impl GrokBuildLogInput {
    pub fn new(opts: HookInputOptions) -> Self {
        Self {
            inner: HookJsonlInput::shared(
                super::rest_support::HookInputProfile {
                    logger_name: "GrokBuildLogInput",
                    id: "grok-build-log",
                    agent_type: ClientType::GrokBuildHook,
                    default_dir: DEFAULT_DIR,
                    default_prefix: "grok-build",
                    git_namespace: "grok-build",
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

impl std::ops::Deref for GrokBuildLogInput {
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
    use crate::checkpoints::InputState;
    use crate::inputs::rest_support::{entry_json, memory_state_store};
    use crate::types::CollectionMethod;
    use crate::utils::get_today_date_string;

    #[tokio::test]
    async fn registers_as_grok_hook_jsonl_and_preserves_reconstruction_fields() {
        let dir = tempfile::tempdir().expect("temp");
        let store = memory_state_store(dir.path());
        let today = get_today_date_string();
        store.set(
            "grok-build-log",
            InputState::new()
                .with_last_file(format!("grok-build-{today}.jsonl"))
                .with_last_offset(0.0),
        );
        let record = json!({
            "time_unix_nano": "1785296938000000000",
            "event.id": "grok-tool-result",
            "event.name": "tool.result",
            "gen_ai.session.id": "session-1",
            "gen_ai.turn.id": "prompt-1",
            "gen_ai.agent.type": "grok-build",
            "gen_ai.tool.name": "read_file",
            "gen_ai.tool.call.id": "tool-1",
            "gen_ai.tool.call.duration": 125,
            "tool.result.status": "failure",
            "loongsuite.grok.match.strategy": "id",
            "loongsuite.grok.timing.source": "unified"
        });
        let path = dir.path().join(format!("grok-build-{today}.jsonl"));
        std::fs::write(&path, format!("{record}\n")).expect("write");

        let input = GrokBuildLogInput::new(HookInputOptions {
            state_store: Arc::clone(&store),
            log_dir: Some(dir.path().to_string_lossy().to_string()),
            log_prefix: Some("grok-build".to_string()),
            poll_interval_ms: Some(60_000),
        });
        assert_eq!(input.id(), "grok-build-log");
        assert_eq!(input.agent_type(), ClientType::GrokBuildHook);
        assert_eq!(input.collection_method(), CollectionMethod::HookJsonl);

        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().expect("entries").extend(batch.to_vec()));
        input.start().await;
        input.stop().await;

        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        let value = entry_json(&entries[0]);
        assert_eq!(value["gen_ai.agent.type"], "grok-build");
        assert_eq!(value["tool.result.status"], "failure");
        assert_eq!(value["loongsuite.grok.match.strategy"], "id");
        assert_eq!(value["loongsuite.grok.timing.source"], "unified");
        assert_eq!(value["gen_ai.tool.call.duration"].as_f64(), Some(125.0));
    }
}
