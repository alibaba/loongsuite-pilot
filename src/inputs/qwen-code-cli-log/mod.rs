//! Qwen Code CLI hook JSONL input.
//!
//! Tails files written by `assets/hooks/qwen-code-cli-hook-processor.mjs`.
//! Records already use canonical `gen_ai.*` fields, so this delegates to the
//! shared hook transform. Port of `qwen-code-cli-log-input.ts`.

use std::sync::Arc;

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{HookInputOptions, HookJsonlInput};
use crate::types::ClientType;
use crate::utils::{directory_exists, resolve_home};

const DEFAULT_DIR: &str = "~/.loongsuite-pilot/logs/qwen-code-cli";

pub struct QwenCodeCliLogInput {
    inner: HookJsonlInput,
}

impl QwenCodeCliLogInput {
    pub fn new(opts: HookInputOptions) -> Self {
        Self {
            inner: HookJsonlInput::shared(
                super::rest_support::HookInputProfile {
                    logger_name: "QwenCodeCliLogInput",
                    id: "qwen-code-cli-log",
                    agent_type: ClientType::QwenCodeCli,
                    default_dir: DEFAULT_DIR,
                    default_prefix: "qwen-code-cli",
                    git_namespace: "qwen-code-cli",
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

impl std::ops::Deref for QwenCodeCliLogInput {
    type Target = HookJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
