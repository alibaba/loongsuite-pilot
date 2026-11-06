//! Codex hook JSONL input. Port of `codex-log-input.ts`.

use std::sync::Arc;

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{HookInputOptions, HookJsonlInput};
use crate::types::ClientType;
use crate::utils::{directory_exists, resolve_home};

const DEFAULT_DIR: &str = "~/.loongsuite-pilot/logs/codex";

pub struct CodexLogInput {
    inner: HookJsonlInput,
}

impl CodexLogInput {
    pub fn new(opts: HookInputOptions) -> Self {
        Self {
            inner: HookJsonlInput::shared(
                super::rest_support::HookInputProfile {
                    logger_name: "CodexLogInput",
                    id: "codex-log",
                    agent_type: ClientType::CodexCliHook,
                    default_dir: DEFAULT_DIR,
                    default_prefix: "codex",
                    git_namespace: "codex",
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

impl std::ops::Deref for CodexLogInput {
    type Target = HookJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
