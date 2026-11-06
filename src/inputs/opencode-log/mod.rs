//! OpenCode hook JSONL input. Port of `opencode-log-input.ts`.

use std::sync::Arc;

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{
    shared_hook_transform, BoxFuture, HookInputOptions, HookJsonlConfig, HookJsonlInput,
    TransformFn,
};
use crate::types::ClientType;
use crate::utils::{
    directory_exists, resolve_home, resolve_poll_interval_ms, DEFAULT_POLL_INTERVAL_MS,
};
use serde_json::{Map, Value};

const DEFAULT_DIR: &str = "~/.loongsuite-pilot/logs/opencode";

pub struct OpenCodeLogInput {
    inner: HookJsonlInput,
}

impl OpenCodeLogInput {
    pub fn new(opts: HookInputOptions) -> Self {
        Self {
            inner: HookJsonlInput::new(HookJsonlConfig {
                logger_name: "OpenCodeLogInput",
                id: "opencode-log",
                agent_type: ClientType::OpenCode,
                log_dir: opts.log_dir.unwrap_or_else(|| resolve_home(DEFAULT_DIR)),
                log_prefix: opts.log_prefix.unwrap_or_else(|| "opencode".into()),
                poll_interval_ms: resolve_poll_interval_ms(
                    opts.poll_interval_ms,
                    DEFAULT_POLL_INTERVAL_MS,
                ),
                state_store: opts.state_store,
                cold_start_keep_last_turn_only: false,
                private_log_dir: false,
                cursor_first_run_guard: false,
                transform: opencode_transform(),
            }),
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

impl std::ops::Deref for OpenCodeLogInput {
    type Target = HookJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

fn opencode_transform() -> TransformFn {
    let shared = shared_hook_transform(ClientType::OpenCode, "opencode");
    Arc::new(move |mut record: Map<String, Value>| {
        let shared = Arc::clone(&shared);
        Box::pin(async move {
            for key in ["gen_ai.tool.call.arguments", "gen_ai.tool.call.result"] {
                let Some(text) = record.get(key).and_then(Value::as_str) else {
                    continue;
                };
                if !text.trim_start().starts_with(['{', '[']) {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    record.insert(key.into(), value);
                }
            }
            shared(record).await
        }) as BoxFuture<_>
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn v1_and_v2_tool_payloads_have_one_canonical_shape_and_truncated_text_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        let input = OpenCodeLogInput::new(HookInputOptions {
            state_store: Arc::new(StateStore::new(root.path().join("state.json"))),
            log_dir: Some(root.path().to_string_lossy().into_owned()),
            log_prefix: None,
            poll_interval_ms: Some(60000),
        });
        let arguments = json!({"path":"中文🚀","options":[1,true,null]});
        let result = json!([{"ok":true},2]);
        let cases = [
            (
                "v1",
                json!(arguments.to_string()),
                json!(result.to_string()),
            ),
            ("v2", arguments.clone(), result.clone()),
            (
                "truncated",
                json!("{broken...[truncated]"),
                json!("[truncated"),
            ),
            ("plain", json!("42"), json!("plain result")),
        ];
        let records: Vec<_> = cases
            .iter()
            .map(|(id, args, result)| {
                json!({
                    "event.id":id,"event.name":"tool.result","user.id":"fixture-user",
                    "gen_ai.agent.type":"opencode","gen_ai.session.id":"s","gen_ai.turn.id":"t",
                    "gen_ai.tool.call.id":id,"gen_ai.tool.name":"read",
                    "gen_ai.tool.call.arguments":args,"gen_ai.tool.call.result":result,
                    "time_unix_nano":"1793270000000000000",
                })
                .to_string()
            })
            .collect();
        std::fs::write(
            root.path().join(format!(
                "opencode-{}.jsonl",
                crate::utils::get_today_date_string()
            )),
            records.join("\n") + "\n",
        )
        .unwrap();
        let entries = input.collect_entries().await.unwrap();
        assert_eq!(entries.len(), cases.len());
        for entry in &entries[..2] {
            assert_eq!(entry.tool_call_arguments.as_ref(), Some(&arguments));
            assert_eq!(entry.tool_call_result.as_ref(), Some(&result));
        }
        assert_eq!(
            entries[2].tool_call_arguments,
            Some(json!("{broken...[truncated]"))
        );
        assert_eq!(entries[2].tool_call_result, Some(json!("[truncated")));
        assert_eq!(entries[3].tool_call_arguments, Some(json!("42")));
        assert_eq!(entries[3].tool_call_result, Some(json!("plain result")));
        assert!(input.collect_entries().await.unwrap().is_empty());
    }
}
