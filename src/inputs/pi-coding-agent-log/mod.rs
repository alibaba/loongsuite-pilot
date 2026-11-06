//! PI Coding Agent hook JSONL input. Port of `pi-coding-agent-log-input.ts`.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{
    build_canonical_hook_entry, ensure_private_dir, resolve_pilot_log_dir, BoxFuture,
    CanonicalHookOptions, HookJsonlConfig, HookJsonlInput, TransformFn,
};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::ClientType;
use crate::utils::{directory_exists, resolve_poll_interval_ms, DEFAULT_POLL_INTERVAL_MS};

const LOG_NAME: &str = "pi-coding-agent";
const MISSING_STORE: &str = "PiCodingAgentLogInput requires a stateStore";

pub type AgentEnabled = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Native construction requires a shared checkpoint store at compile time.
/// Omitting it cannot create an input with an unusable lifecycle.
///
/// ```compile_fail,E0063
/// use loongsuite_pilot::inputs::pi_coding_agent_log::PiCodingAgentLogInputOptions;
/// let options = PiCodingAgentLogInputOptions {
///     log_dir: None,
///     log_prefix: None,
///     poll_interval_ms: None,
///     data_dir: None,
///     agent_enabled: None,
/// };
/// ```
///
/// ```no_run
/// use std::sync::Arc;
/// use loongsuite_pilot::checkpoints::StateStore;
/// use loongsuite_pilot::inputs::pi_coding_agent_log::{PiCodingAgentLogInputOptions, PiCodingAgentLogInput};
/// let input = PiCodingAgentLogInput::new(PiCodingAgentLogInputOptions {
///     state_store: Arc::new(StateStore::new("synthetic-state.json")),
///     log_dir: None,
///     log_prefix: None,
///     poll_interval_ms: None,
///     data_dir: None,
///     agent_enabled: None,
/// });
/// ```
pub struct PiCodingAgentLogInputOptions {
    pub state_store: Arc<StateStore>,
    pub log_dir: Option<String>,
    pub log_prefix: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub data_dir: Option<String>,
    pub agent_enabled: Option<AgentEnabled>,
}

pub struct PiCodingAgentLogInput {
    inner: HookJsonlInput,
}

impl PiCodingAgentLogInput {
    pub fn new(opts: PiCodingAgentLogInputOptions) -> Self {
        let log_dir = opts
            .log_dir
            .clone()
            .unwrap_or_else(|| resolve_pi_coding_agent_log_dir(opts.data_dir.as_deref()));
        let enabled = opts.agent_enabled.unwrap_or_else(|| Arc::new(|_| true));
        let inner = HookJsonlInput::new(HookJsonlConfig {
            logger_name: "PiCodingAgentLogInput",
            id: "pi-coding-agent-log",
            agent_type: ClientType::PiCodingAgent,
            log_dir,
            log_prefix: opts
                .log_prefix
                .unwrap_or_else(|| "pi-coding-agent".to_string()),
            poll_interval_ms: resolve_poll_interval_ms(
                opts.poll_interval_ms,
                DEFAULT_POLL_INTERVAL_MS,
            ),
            state_store: opts.state_store,
            cold_start_keep_last_turn_only: false,
            private_log_dir: true,
            cursor_first_run_guard: false,
            transform: pi_transform(enabled),
        });
        Self { inner }
    }

    pub async fn check_availability(data_dir: Option<&str>) -> bool {
        directory_exists(&resolve_pi_coding_agent_log_dir(data_dir)).await
    }

    pub fn watch_paths(data_dir: Option<&str>) -> Vec<String> {
        vec![resolve_pi_coding_agent_log_dir(data_dir)]
    }
}

pub fn resolve_pi_coding_agent_log_dir(data_dir: Option<&str>) -> String {
    resolve_pilot_log_dir(data_dir, LOG_NAME)
}

pub async fn ensure_pi_coding_agent_log_dir(log_dir: &str) {
    ensure_private_dir(log_dir).await;
}

pub fn require_pi_state_store(
    state_store: Option<Arc<StateStore>>,
) -> Result<Arc<StateStore>, &'static str> {
    state_store.ok_or(MISSING_STORE)
}

impl std::ops::Deref for PiCodingAgentLogInput {
    type Target = HookJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

fn pi_transform(enabled: AgentEnabled) -> TransformFn {
    Arc::new(move |record: Map<String, Value>| {
        let enabled = Arc::clone(&enabled);
        Box::pin(async move {
            let record_agent = record
                .get("gen_ai.agent.type")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(ClientType::PiCodingAgent.as_str())
                .to_string();
            if !enabled(&record_agent) {
                return Ok(None);
            }
            let Some(mut entry) = build_canonical_hook_entry(
                &record,
                ClientType::PiCodingAgent.as_str(),
                None,
                CanonicalHookOptions::default(),
            ) else {
                return Ok(None);
            };
            enrich_canonical_entry_with_git(&mut entry, &record, record_agent.as_str()).await?;
            Ok(Some(entry))
        }) as BoxFuture<_>
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::inputs::rest_support::{entry_json, memory_state_store};
    use crate::types::CollectionMethod;
    use crate::utils::get_today_date_string;

    fn opts(
        store: Arc<crate::checkpoints::StateStore>,
        log_dir: Option<String>,
        data_dir: Option<String>,
        agent_enabled: Option<AgentEnabled>,
    ) -> PiCodingAgentLogInputOptions {
        PiCodingAgentLogInputOptions {
            state_store: store,
            log_dir,
            log_prefix: None,
            poll_interval_ms: Some(60_000),
            data_dir,
            agent_enabled,
        }
    }

    #[test]
    fn reports_contract_error_when_state_store_is_missing() {
        assert_eq!(
            require_pi_state_store(None).expect_err("missing"),
            "PiCodingAgentLogInput requires a stateStore"
        );
    }

    #[tokio::test]
    async fn resolves_defaults_from_pilot_data_dir() {
        if !crate::utils::isolated_env_test() {
            return;
        }
        let dir = tempfile::tempdir().expect("temp");
        let data_dir = dir.path().join("pilot-data");
        let expected = data_dir.join("logs").join("pi-coding-agent");
        std::fs::create_dir_all(&expected).unwrap();
        let previous = std::env::var("LOONGSUITE_PILOT_DATA_DIR").ok();
        std::env::set_var("LOONGSUITE_PILOT_DATA_DIR", &data_dir);
        let input =
            PiCodingAgentLogInput::new(opts(memory_state_store(dir.path()), None, None, None));
        assert_eq!(input.log_dir(), expected.to_string_lossy());
        assert_eq!(
            PiCodingAgentLogInput::watch_paths(None),
            vec![expected.to_string_lossy().to_string()]
        );
        assert!(PiCodingAgentLogInput::check_availability(None).await);
        match previous {
            Some(value) => std::env::set_var("LOONGSUITE_PILOT_DATA_DIR", value),
            None => std::env::remove_var("LOONGSUITE_PILOT_DATA_DIR"),
        }
    }

    #[tokio::test]
    async fn accepts_explicit_data_dir() {
        let dir = tempfile::tempdir().expect("temp");
        let data_dir = dir.path().join("explicit-data");
        let expected = data_dir.join("logs").join("pi-coding-agent");
        std::fs::create_dir_all(&expected).unwrap();
        let data = data_dir.to_string_lossy().to_string();
        let input = PiCodingAgentLogInput::new(opts(
            memory_state_store(dir.path()),
            None,
            Some(data.clone()),
            None,
        ));
        assert_eq!(input.log_dir(), expected.to_string_lossy());
        assert_eq!(
            PiCodingAgentLogInput::watch_paths(Some(&data)),
            vec![expected.to_string_lossy().to_string()]
        );
        assert!(PiCodingAgentLogInput::check_availability(Some(&data)).await);
    }

    #[tokio::test]
    async fn reads_extension_jsonl() {
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
            "gen_ai.agent.type": "pi-coding-agent",
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4-5",
            "gen_ai.response.model": "claude-sonnet-4-5",
            "gen_ai.response.id": "response-1",
            "gen_ai.agent.name": "Pi Coding Agent",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 20,
            "agent.pi-coding-agent.cwd": "/workspace/repo"
        });
        std::fs::write(
            dir.path().join(format!("pi-coding-agent-{today}.jsonl")),
            format!("{record}\n"),
        )
        .unwrap();
        let input = PiCodingAgentLogInput::new(opts(
            memory_state_store(dir.path()),
            Some(dir.path().to_string_lossy().to_string()),
            None,
            None,
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        input.start().await;
        input.stop().await;
        assert_eq!(input.agent_type(), ClientType::PiCodingAgent);
        assert_eq!(input.collection_method(), CollectionMethod::HookJsonl);
        let entries = seen.lock().unwrap();
        assert_eq!(entries.len(), 1);
        let value = entry_json(&entries[0]);
        assert_eq!(value["event.id"], "event-1");
        assert_eq!(value["event.name"], "llm.response");
        assert_eq!(value["gen_ai.session.id"], "session-1");
        assert_eq!(value["gen_ai.agent.type"], "pi-coding-agent");
        assert_eq!(value["gen_ai.agent.name"], "Pi Coding Agent");
        assert_eq!(value["gen_ai.response.id"], "response-1");
        assert_eq!(value["gen_ai.provider.name"], "anthropic");
        assert_eq!(value["gen_ai.usage.input_tokens"], json!(100));
        assert_eq!(value["gen_ai.usage.output_tokens"], json!(20));
    }

    #[tokio::test]
    async fn uses_byte_offsets_to_avoid_replay() {
        let dir = tempfile::tempdir().expect("temp");
        let today = get_today_date_string();
        let record = json!({
            "event.name": "tool.call",
            "gen_ai.agent.type": "pi-coding-agent",
            "gen_ai.session.id": "session-1",
            "gen_ai.tool.name": "read"
        });
        std::fs::write(
            dir.path().join(format!("pi-coding-agent-{today}.jsonl")),
            format!("{record}\n"),
        )
        .unwrap();
        let store = memory_state_store(dir.path());
        let log_dir = dir.path().to_string_lossy().to_string();
        let first =
            PiCodingAgentLogInput::new(opts(Arc::clone(&store), Some(log_dir.clone()), None, None));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        first.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        first.start().await;
        first.stop().await;
        assert_eq!(seen.lock().unwrap().len(), 1);

        let second = PiCodingAgentLogInput::new(opts(store, Some(log_dir), None, None));
        let seen2 = Arc::new(Mutex::new(Vec::new()));
        let slot2 = Arc::clone(&seen2);
        second.on_entries(move |batch| slot2.lock().unwrap().extend(batch.to_vec()));
        second.start().await;
        second.stop().await;
        assert!(seen2.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn preserves_registered_sdk_agent_identity() {
        let dir = tempfile::tempdir().expect("temp");
        let today = get_today_date_string();
        let cwd = dir.path().to_string_lossy().to_string();
        let record = json!({
            "event.name": "llm.response",
            "gen_ai.session.id": "custom-session",
            "gen_ai.agent.type": "acme-code",
            "gen_ai.agent.id": "acme-code",
            "gen_ai.agent.name": "Acme Code Agent",
            "gen_ai.agent.system": "pi",
            "gen_ai.framework": "pi-coding-agent",
            "agent.acme-code.cwd": cwd,
            "gen_ai.response.finish_reasons": ["stop"]
        });
        std::fs::write(
            dir.path().join(format!("pi-coding-agent-{today}.jsonl")),
            format!("{record}\n"),
        )
        .unwrap();
        let input = PiCodingAgentLogInput::new(opts(
            memory_state_store(dir.path()),
            Some(cwd.clone()),
            None,
            None,
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        input.start().await;
        input.stop().await;
        let entries = seen.lock().unwrap();
        assert_eq!(entries.len(), 1);
        let value = entry_json(&entries[0]);
        assert_eq!(value["gen_ai.agent.type"], "acme-code");
        assert_eq!(value["gen_ai.agent.id"], "acme-code");
        assert_eq!(value["gen_ai.agent.name"], "Acme Code Agent");
        assert_eq!(value["gen_ai.agent.system"], "pi");
        assert_eq!(value["gen_ai.framework"], "pi-coding-agent");
        assert_eq!(value["workspace.path"], cwd);
    }

    #[tokio::test]
    async fn drops_disabled_sdk_agent_without_replay() {
        let dir = tempfile::tempdir().expect("temp");
        let today = get_today_date_string();
        let records = ["disabled-code", "enabled-code"].map(|agent_type| {
            json!({
                "event.id": format!("{agent_type}-event"),
                "event.name": "llm.response",
                "gen_ai.session.id": format!("{agent_type}-session"),
                "gen_ai.agent.type": agent_type,
                "gen_ai.agent.id": agent_type,
                "gen_ai.response.finish_reasons": ["stop"]
            })
            .to_string()
        });
        std::fs::write(
            dir.path().join(format!("pi-coding-agent-{today}.jsonl")),
            format!("{}\n", records.join("\n")),
        )
        .unwrap();
        let store = memory_state_store(dir.path());
        let log_dir = dir.path().to_string_lossy().to_string();
        let input = PiCodingAgentLogInput::new(opts(
            Arc::clone(&store),
            Some(log_dir.clone()),
            None,
            Some(Arc::new(|agent_type| agent_type != "disabled-code")),
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        input.start().await;
        input.stop().await;
        let types: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|entry| {
                entry_json(entry)["gen_ai.agent.type"]
                    .as_str()
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert_eq!(types, vec!["enabled-code".to_string()]);

        let restarted =
            PiCodingAgentLogInput::new(opts(store, Some(log_dir), None, Some(Arc::new(|_| true))));
        let replay = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&replay);
        restarted.on_entries(move |batch| slot.lock().unwrap().extend(batch.to_vec()));
        restarted.start().await;
        restarted.stop().await;
        assert!(replay.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tightens_existing_log_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp");
        let mut perms = std::fs::metadata(dir.path()).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dir.path(), perms).unwrap();
        let input = PiCodingAgentLogInput::new(opts(
            memory_state_store(dir.path()),
            Some(dir.path().to_string_lossy().to_string()),
            None,
            None,
        ));
        input.start().await;
        input.stop().await;
        let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
