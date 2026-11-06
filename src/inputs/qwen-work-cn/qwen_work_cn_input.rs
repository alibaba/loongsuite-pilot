//! Port of `src/inputs/qwen-work-cn/qwen-work-cn-input.ts`.

use crate::inputs::base::{hosted_hook, HookBody, HookPaths, InputRuntime};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::{AgentActivityEntry, ClientType};
use crate::utils::{directory_exists, resolve_home, DEFAULT_POLL_INTERVAL_MS};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};

pub struct QwenWorkCnInput {
    inner: Arc<crate::inputs::base::HostedInput<crate::inputs::base::HookAdapter<QwenWorkCnBody>>>,
}

struct QwenWorkCnBody {
    paths: HookPaths,
    last_agent_version: Mutex<String>,
}

pub struct QwenWorkCnOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub log_dir: Option<String>,
    pub log_prefix: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

impl QwenWorkCnInput {
    pub(crate) fn collector_runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        self.inner.runtime.runtime_info()
    }

    /// Apply validated collector exclusions before any collection or upload.
    pub(crate) fn set_collector_workspace_policy(
        &self,
        policy: crate::inputs::base::WorkspacePolicy,
    ) {
        self.inner.runtime.set_workspace_policy(policy);
    }

    /// Collector subscription. Forwards to the hosted runtime without exposing its body type.
    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[crate::types::AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }

    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }

    pub fn new(opts: QwenWorkCnOptions) -> Self {
        let paths = HookPaths {
            log_dir: opts
                .log_dir
                .unwrap_or_else(|| resolve_home("~/.loongsuite-pilot/logs/qwen-work-cn/history")),
            log_prefix: opts.log_prefix.unwrap_or_else(|| "qwen-work-cn".into()),
            cold_start_keep_last_turn_only: false,
        };
        Self {
            inner: hosted_hook(
                QwenWorkCnBody {
                    paths,
                    last_agent_version: Mutex::new(String::new()),
                },
                "QwenWorkCNInput",
                opts.state_store,
                opts.poll_interval_ms.or(Some(DEFAULT_POLL_INTERVAL_MS)),
            ),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }

    pub fn id(&self) -> &str {
        "qwen-work-cn-hook"
    }

    pub fn agent_version(&self) -> String {
        self.inner.agent_version()
    }

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home("~/.qwenworkcn")).await
    }

    pub fn get_watch_paths() -> Vec<String> {
        vec![resolve_home("~/.qwenworkcn")]
    }
}

#[async_trait]
impl HookBody for QwenWorkCnBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "qwen-work-cn-hook"
    }

    fn agent_type(&self) -> ClientType {
        ClientType::QwenWorkCN
    }

    fn paths(&self) -> &HookPaths {
        &self.paths
    }

    fn agent_version(&self) -> String {
        self.last_agent_version
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    async fn transform_record(
        &self,
        _rt: &InputRuntime,
        record: &mut Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        if record.get("event.name").and_then(Value::as_str).is_none() {
            return Ok(None);
        }
        if record.get("event.id").and_then(Value::as_str).is_none() {
            return Ok(None);
        }
        if record
            .get("time_unix_nano")
            .and_then(Value::as_str)
            .is_none()
        {
            return Ok(None);
        }
        let version = record
            .get("agent.qwenworkcn.version")
            .cloned()
            .or_else(|| record.get("version").cloned());
        if let Some(Value::String(version)) = version {
            if !version.is_empty() {
                *self
                    .last_agent_version
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) = version;
            }
        }
        record.remove("version");
        let mut opts = record.clone();
        opts.insert(
            "gen_ai.agent.type".into(),
            Value::String(ClientType::QwenWorkCN.as_str().to_owned()),
        );
        let mut entry = crate::normalization::build_agent_activity_entry(&Value::Object(opts));
        let _ = enrich_canonical_entry_with_git(&mut entry, record, "qwen-work-cn").await;
        Ok(Some(entry))
    }
}

#[cfg(test)]
#[path = "hook_migration_contract_tests.rs"]
mod qwen_history_migration_contract_tests;
