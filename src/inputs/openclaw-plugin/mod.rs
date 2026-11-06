//! OpenClaw plugin JSONL input. Port of `openclaw-plugin-input.ts`.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{
    ensure_private_dir, resolve_pilot_log_dir, shared_hook_transform, BoxFuture, HookJsonlConfig,
    HookJsonlInput, TransformFn,
};
use crate::types::ClientType;
use crate::utils::{directory_exists, resolve_poll_interval_ms, DEFAULT_POLL_INTERVAL_MS};

const LOG_NAME: &str = "openclaw";
const MISSING_STORE: &str = "OpenClawPluginInput requires a stateStore";

/// Native construction requires a shared checkpoint store at compile time.
/// Omitting it cannot create an input with an unusable lifecycle.
///
/// ```compile_fail,E0063
/// use loongsuite_pilot::inputs::openclaw_plugin::OpenClawPluginInputOptions;
/// let options = OpenClawPluginInputOptions {
///     log_dir: None,
///     log_prefix: None,
///     poll_interval_ms: None,
///     data_dir: None,
///
/// };
/// ```
///
/// ```no_run
/// use std::sync::Arc;
/// use loongsuite_pilot::checkpoints::StateStore;
/// use loongsuite_pilot::inputs::openclaw_plugin::{OpenClawPluginInputOptions, OpenClawPluginInput};
/// let input = OpenClawPluginInput::new(OpenClawPluginInputOptions {
///     state_store: Arc::new(StateStore::new("synthetic-state.json")),
///     log_dir: None,
///     log_prefix: None,
///     poll_interval_ms: None,
///     data_dir: None,
///
/// });
/// ```
pub struct OpenClawPluginInputOptions {
    pub state_store: Arc<StateStore>,
    pub log_dir: Option<String>,
    pub log_prefix: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub data_dir: Option<String>,
}

pub struct OpenClawPluginInput {
    inner: HookJsonlInput,
}

impl OpenClawPluginInput {
    pub fn new(opts: OpenClawPluginInputOptions) -> Self {
        let log_dir = opts
            .log_dir
            .unwrap_or_else(|| resolve_openclaw_plugin_log_dir(opts.data_dir.as_deref()));
        let transform = openclaw_transform();
        let inner = HookJsonlInput::new(HookJsonlConfig {
            logger_name: "OpenClawPluginInput",
            id: "openclaw-plugin-log",
            agent_type: ClientType::OpenClaw,
            log_dir,
            log_prefix: opts.log_prefix.unwrap_or_else(|| "openclaw".to_string()),
            poll_interval_ms: resolve_poll_interval_ms(
                opts.poll_interval_ms,
                DEFAULT_POLL_INTERVAL_MS,
            ),
            state_store: opts.state_store,
            cold_start_keep_last_turn_only: false,
            private_log_dir: true,
            cursor_first_run_guard: false,
            transform,
        });
        Self { inner }
    }

    pub async fn check_availability(data_dir: Option<&str>) -> bool {
        directory_exists(&resolve_openclaw_plugin_log_dir(data_dir)).await
    }

    pub fn watch_paths(data_dir: Option<&str>) -> Vec<String> {
        vec![resolve_openclaw_plugin_log_dir(data_dir)]
    }
}

pub fn resolve_openclaw_plugin_log_dir(data_dir: Option<&str>) -> String {
    resolve_pilot_log_dir(data_dir, LOG_NAME)
}

pub async fn ensure_openclaw_plugin_log_dir(log_dir: &str) {
    ensure_private_dir(log_dir).await;
}

pub fn require_openclaw_state_store(
    state_store: Option<Arc<StateStore>>,
) -> Result<Arc<StateStore>, &'static str> {
    state_store.ok_or(MISSING_STORE)
}

impl std::ops::Deref for OpenClawPluginInput {
    type Target = HookJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

fn openclaw_transform() -> TransformFn {
    let shared = shared_hook_transform(ClientType::OpenClaw, "openclaw");
    Arc::new(move |record: Map<String, Value>| {
        let shared = Arc::clone(&shared);
        Box::pin(async move {
            let hook = record
                .get("agent.openclaw.hook")
                .and_then(Value::as_str)
                .map(str::to_string);
            if hook.as_deref().is_some_and(|name| {
                matches!(
                    name,
                    "session_start" | "session_end" | "before_model_resolve"
                )
            }) {
                return Ok(None);
            }
            shared(record).await
        }) as BoxFuture<_>
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::inputs::rest_support::{entry_json, memory_state_store};
    use crate::types::{AgentActivityEntry, CollectionMethod};
    use crate::utils::get_today_date_string;

    fn options(
        store: Arc<crate::checkpoints::StateStore>,
        log_dir: Option<String>,
        data_dir: Option<String>,
    ) -> OpenClawPluginInputOptions {
        OpenClawPluginInputOptions {
            state_store: store,
            log_dir,
            log_prefix: None,
            poll_interval_ms: Some(60_000),
            data_dir,
        }
    }

    #[test]
    fn reports_contract_error_when_state_store_is_missing() {
        let err = require_openclaw_state_store(None).expect_err("missing");
        assert_eq!(err, "OpenClawPluginInput requires a stateStore");
    }

    #[tokio::test]
    async fn resolves_defaults_from_pilot_data_dir() {
        if !crate::utils::isolated_env_test() {
            return;
        }
        let dir = tempfile::tempdir().expect("temp");
        let data_dir = dir.path().join("pilot-data");
        let expected = data_dir.join("logs").join("openclaw");
        std::fs::create_dir_all(&expected).expect("mkdir");
        let previous = std::env::var("LOONGSUITE_PILOT_DATA_DIR").ok();
        std::env::set_var("LOONGSUITE_PILOT_DATA_DIR", &data_dir);
        let store = memory_state_store(dir.path());
        let input = OpenClawPluginInput::new(options(store, None, None));
        assert_eq!(input.log_dir(), expected.to_string_lossy());
        assert_eq!(
            OpenClawPluginInput::watch_paths(None),
            vec![expected.to_string_lossy().to_string()]
        );
        assert!(OpenClawPluginInput::check_availability(None).await);
        match previous {
            Some(value) => std::env::set_var("LOONGSUITE_PILOT_DATA_DIR", value),
            None => std::env::remove_var("LOONGSUITE_PILOT_DATA_DIR"),
        }
    }

    #[tokio::test]
    async fn accepts_explicit_data_dir() {
        let dir = tempfile::tempdir().expect("temp");
        let data_dir = dir.path().join("explicit-data");
        let expected = data_dir.join("logs").join("openclaw");
        std::fs::create_dir_all(&expected).expect("mkdir");
        let store = memory_state_store(dir.path());
        let input = OpenClawPluginInput::new(options(
            store,
            None,
            Some(data_dir.to_string_lossy().to_string()),
        ));
        assert_eq!(input.log_dir(), expected.to_string_lossy());
        assert_eq!(
            OpenClawPluginInput::watch_paths(Some(data_dir.to_str().unwrap())),
            vec![expected.to_string_lossy().to_string()]
        );
        assert!(OpenClawPluginInput::check_availability(Some(data_dir.to_str().unwrap())).await);
    }

    #[tokio::test]
    async fn reads_plugin_jsonl() {
        let dir = tempfile::tempdir().expect("temp");
        let today = get_today_date_string();
        let record = json!({
            "time_unix_nano": "1784188800000000000",
            "event.id": "event-1",
            "event.name": "llm.response",
            "user.id": "user-1",
            "gen_ai.session.id": "session-1",
            "gen_ai.turn.id": "turn-1",
            "gen_ai.step.id": "step-1",
            "gen_ai.agent.type": "openclaw",
            "gen_ai.provider.name": "dashscope",
            "gen_ai.request.model": "qwen3.7-max",
            "gen_ai.response.model": "qwen3.7-max",
            "gen_ai.response.id": "response-1",
            "gen_ai.agent.name": "OpenClaw",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 20
        });
        std::fs::write(
            dir.path().join(format!("openclaw-{today}.jsonl")),
            format!("{record}\n"),
        )
        .unwrap();
        let store = memory_state_store(dir.path());
        let input = OpenClawPluginInput::new(options(
            store,
            Some(dir.path().to_string_lossy().to_string()),
            None,
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        input.start().await;
        input.stop().await;
        assert_eq!(input.agent_type(), ClientType::OpenClaw);
        assert_eq!(input.collection_method(), CollectionMethod::HookJsonl);
        let entries = seen.lock().unwrap();
        assert_eq!(entries.len(), 1);
        let value = entry_json(&entries[0]);
        assert_eq!(value["event.id"], "event-1");
        assert_eq!(value["event.name"], "llm.response");
        assert_eq!(value["gen_ai.session.id"], "session-1");
        assert_eq!(value["gen_ai.agent.type"], "openclaw");
        assert_eq!(value["gen_ai.agent.name"], "OpenClaw");
        assert_eq!(value["gen_ai.response.id"], "response-1");
        assert_eq!(value["gen_ai.provider.name"], "dashscope");
        assert_eq!(value["gen_ai.usage.input_tokens"], json!(100));
        assert_eq!(value["gen_ai.usage.output_tokens"], json!(20));
    }

    #[tokio::test]
    async fn drops_session_lifecycle_events() {
        let dir = tempfile::tempdir().expect("temp");
        let today = get_today_date_string();
        let mut lines = Vec::new();
        for (index, hook) in ["session_start", "session_end"].iter().enumerate() {
            lines.push(
                json!({
                    "time_unix_nano": format!("{}", 1784188800000000000u64 + index as u64),
                    "event.id": format!("session-event-{index}"),
                    "event.name": "other",
                    "user.id": "user-1",
                    "trace_id": "session-trace",
                    "gen_ai.session.id": "session-1",
                    "gen_ai.agent.type": "openclaw",
                    "agent.openclaw.hook": hook
                })
                .to_string(),
            );
        }
        std::fs::write(
            dir.path().join(format!("openclaw-{today}.jsonl")),
            format!("{}\n", lines.join("\n")),
        )
        .unwrap();
        let input = OpenClawPluginInput::new(options(
            memory_state_store(dir.path()),
            Some(dir.path().to_string_lossy().to_string()),
            None,
        ));
        let seen = Arc::new(Mutex::new(Vec::<AgentActivityEntry>::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        input.start().await;
        input.stop().await;
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn uses_before_agent_run_as_turn_input_source() {
        let dir = tempfile::tempdir().expect("temp");
        let today = get_today_date_string();
        let prompt = json!([{ "role": "user", "parts": [{ "type": "text", "content": "hello" }] }]);
        let records = [
            json!({
                "event.name": "other",
                "user.id": "user-1",
                "gen_ai.session.id": "session-1",
                "gen_ai.turn.id": "turn-1",
                "gen_ai.agent.type": "openclaw",
                "time_unix_nano": "1784188800000000000",
                "event.id": "model-resolve",
                "agent.openclaw.hook": "before_model_resolve",
                "gen_ai.input.messages_delta": prompt,
                "input.messages": prompt
            }),
            json!({
                "event.name": "other",
                "user.id": "user-1",
                "gen_ai.session.id": "session-1",
                "gen_ai.turn.id": "turn-1",
                "gen_ai.agent.type": "openclaw",
                "time_unix_nano": "1784188800000000001",
                "event.id": "agent-run",
                "agent.openclaw.hook": "before_agent_run",
                "gen_ai.input.messages_delta": prompt,
                "gen_ai.system_instructions": [{ "type": "text", "content": "system prompt" }]
            }),
        ];
        let body = records
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(
            dir.path().join(format!("openclaw-{today}.jsonl")),
            format!("{body}\n"),
        )
        .unwrap();
        let input = OpenClawPluginInput::new(options(
            memory_state_store(dir.path()),
            Some(dir.path().to_string_lossy().to_string()),
            None,
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        input.start().await;
        input.stop().await;
        let entries = seen.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries.iter().all(|entry| {
            entry_json(entry)
                .get("agent.openclaw.hook")
                .and_then(Value::as_str)
                != Some("before_model_resolve")
        }));
        let agent = entries
            .iter()
            .find(|entry| {
                entry_json(entry)
                    .get("agent.openclaw.hook")
                    .and_then(|v| v.as_str())
                    == Some("before_agent_run")
            })
            .expect("agent");
        let agent_json = entry_json(agent);
        assert_eq!(agent_json["gen_ai.input.messages_delta"], prompt);
        assert_eq!(
            agent_json["gen_ai.system_instructions"],
            json!([{ "type": "text", "content": "system prompt" }])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tightens_existing_log_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path();
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
        let input = OpenClawPluginInput::new(options(
            memory_state_store(path),
            Some(path.to_string_lossy().to_string()),
            None,
        ));
        input.start().await;
        input.stop().await;
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
