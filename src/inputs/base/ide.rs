//! Port of `src/inputs/base/base-ide-input.ts`.

use super::input_runtime::{HostedInput, InputBody, InputRuntime};
use crate::checkpoints::SnapshotStore;
use crate::types::{AgentActivityEntry, ClientType, CodeGenerationEvent, CollectionMethod};
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait IdeBody: Send + Sync + 'static {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        None
    }
    fn id(&self) -> &str;
    fn agent_type(&self) -> ClientType;
    fn data_root(&self) -> &str;
    fn snapshot_store(&self) -> &SnapshotStore;
    async fn scan_history_entries(
        &self,
        rt: &InputRuntime,
        since_ts: f64,
    ) -> anyhow::Result<Vec<CodeGenerationEvent>>;
    async fn build_entry(
        &self,
        rt: &InputRuntime,
        event: &CodeGenerationEvent,
    ) -> anyhow::Result<Option<AgentActivityEntry>>;
    fn snapshot_key(&self, event: &CodeGenerationEvent) -> String {
        format!(
            "{}@@{}@@{}",
            event.file_path,
            event.source_timestamp,
            event.agent_type.as_str()
        )
    }
    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
}

pub struct IdeAdapter<T: IdeBody> {
    inner: T,
}

impl<T: IdeBody> IdeAdapter<T> {
    pub fn new(inner: T) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &T {
        &self.inner
    }
}

#[async_trait]
impl<T: IdeBody> InputBody for IdeAdapter<T> {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        self.inner.checkpoint_namespaces()
    }

    fn id(&self) -> &str {
        self.inner.id()
    }

    fn agent_type(&self) -> ClientType {
        self.inner.agent_type()
    }

    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::IdeSnapshotPolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        self.inner.snapshot_store().load().await;
        self.inner.on_start(rt).await
    }

    async fn on_stop(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        self.inner.snapshot_store().flush().await?;
        self.inner.on_stop(rt).await
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let since_ts = self.inner.snapshot_store().get_suggested_since_timestamp();
        let raw_events = self.inner.scan_history_entries(rt, since_ts).await?;
        let mut entries = Vec::new();
        for event in raw_events {
            let key = self.inner.snapshot_key(&event);
            if !self.inner.snapshot_store().should_process(&key) {
                continue;
            }
            self.inner
                .snapshot_store()
                .mark_pending(&key, event.source_timestamp as f64);
            match self.inner.build_entry(rt, &event).await {
                Ok(Some(entry)) => {
                    entries.push(entry);
                    self.inner.snapshot_store().mark_processed(&key, None);
                }
                Ok(None) => {}
                Err(err) => {
                    rt.warn(
                        "failed to build entry",
                        serde_json::json!({ "key": key, "error": err.to_string() }).as_object(),
                    );
                }
            }
        }
        self.inner.snapshot_store().flush().await?;
        Ok(entries)
    }
}

pub fn hosted_ide<T: IdeBody>(
    body: T,
    logger_name: &str,
    state_store: Arc<crate::checkpoints::StateStore>,
    poll_interval_ms: Option<u64>,
) -> Arc<HostedInput<IdeAdapter<T>>> {
    HostedInput::new(
        IdeAdapter::new(body),
        logger_name,
        state_store,
        poll_interval_ms,
    )
}
