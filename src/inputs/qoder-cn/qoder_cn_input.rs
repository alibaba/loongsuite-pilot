//! Port of `src/inputs/qoder-cn/qoder-cn-input.ts`.

use crate::inputs::base::{env_poll_or, hosted_ide, qoder_root, IdeBody, InputRuntime};
use crate::inputs::qoder::{build_qoder_entry, scan_ai_tracker, scan_file_history};
use crate::types::{AgentActivityEntry, ClientType, CodeGenerationEvent};
use crate::utils::{resolve_home, DEFAULT_POLL_INTERVAL_MS};
use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;

pub struct QoderCnInput {
    pub inner: Arc<crate::inputs::base::HostedInput<crate::inputs::base::IdeAdapter<QoderCnBody>>>,
}

pub struct QoderCnBody {
    data_root: String,
    snapshot: crate::checkpoints::SnapshotStore,
}

pub struct QoderCnOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub data_root: Option<String>,
    pub snapshot_store_path: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub snapshot_retention_ms: Option<f64>,
}

impl QoderCnInput {
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

    pub fn new(opts: QoderCnOptions) -> Self {
        let data_root = opts.data_root.unwrap_or_else(resolve_qoder_cn_root);
        let snapshot_path = opts.snapshot_store_path.unwrap_or_else(|| {
            resolve_home("~/.loongsuite-pilot/logs/qoder-cn/qoder-cn-snapshot-store.json")
        });
        let snapshot = match opts.snapshot_retention_ms {
            Some(retention) => {
                crate::checkpoints::SnapshotStore::with_retention(snapshot_path, retention)
            }
            None => crate::checkpoints::SnapshotStore::new(snapshot_path),
        };
        let poll = env_poll_or(opts.poll_interval_ms, "QODER_CN_ANALYTICS_POLL_INTERVAL")
            .or(Some(DEFAULT_POLL_INTERVAL_MS));
        Self {
            inner: hosted_ide(
                QoderCnBody {
                    data_root,
                    snapshot,
                },
                "QoderCnInput",
                opts.state_store,
                poll,
            ),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }

    pub fn get_watch_paths() -> Vec<String> {
        let root = resolve_qoder_cn_root();
        let parent = Path::new(&root)
            .parent()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.clone());
        vec![parent, root]
    }

    pub async fn check_availability() -> bool {
        tokio::fs::metadata(resolve_qoder_cn_root()).await.is_ok()
    }
}

pub fn resolve_qoder_cn_root() -> String {
    qoder_root("QoderCN")
}

#[async_trait]
impl IdeBody for QoderCnBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned(), "qoder-cn-tracker".into()])
    }

    fn id(&self) -> &str {
        "qoder-cn"
    }

    fn agent_type(&self) -> ClientType {
        ClientType::QoderCn
    }

    fn data_root(&self) -> &str {
        &self.data_root
    }

    fn snapshot_store(&self) -> &crate::checkpoints::SnapshotStore {
        &self.snapshot
    }

    async fn scan_history_entries(
        &self,
        rt: &InputRuntime,
        since_ts: f64,
    ) -> anyhow::Result<Vec<CodeGenerationEvent>> {
        let mut events = Vec::new();
        scan_file_history(
            &self.data_root,
            since_ts,
            ClientType::QoderCn,
            "qoder-cn-history",
            &mut events,
        )
        .await;
        scan_ai_tracker(
            rt,
            &self.data_root,
            "qoder-cn-tracker:",
            ClientType::QoderCn,
            "qoder-cn-ai-tracker",
            true,
            &mut events,
        )
        .await;
        Ok(events)
    }

    async fn build_entry(
        &self,
        _rt: &InputRuntime,
        event: &CodeGenerationEvent,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        Ok(Some(build_qoder_entry(event, ClientType::QoderCn)))
    }
}
