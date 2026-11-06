//! Port of `src/inputs/base/base-sqlite-input.ts`.

use super::input_runtime::{HostedInput, InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::sync::Arc;

#[async_trait]
pub trait SqliteBody: Send + Sync + 'static {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        None
    }
    fn id(&self) -> &str;
    fn agent_type(&self) -> ClientType;
    fn db_path(&self) -> &str;
    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
    async fn read_new_rows(
        &self,
        rt: &InputRuntime,
        last_row_id: f64,
    ) -> anyhow::Result<Vec<Map<String, Value>>>;
    async fn transform_row(
        &self,
        rt: &InputRuntime,
        row: &Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>>;
}

pub struct SqliteAdapter<T: SqliteBody> {
    inner: T,
}

impl<T: SqliteBody> SqliteAdapter<T> {
    pub fn new(inner: T) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &T {
        &self.inner
    }
}

#[async_trait]
impl<T: SqliteBody> InputBody for SqliteAdapter<T> {
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
        CollectionMethod::SqlitePolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        self.inner.on_start(rt).await
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let last_row_id = rt.state_store.get_row_id(rt.id.as_str());
        let rows = match self.inner.read_new_rows(rt, last_row_id).await {
            Ok(rows) => rows,
            Err(err) => {
                rt.error(
                    "failed to read SQLite rows",
                    serde_json::json!({ "error": err.to_string() }).as_object(),
                );
                return Ok(Vec::new());
            }
        };
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        let mut max_row_id = last_row_id;
        for row in rows {
            let row_id = row.get("rowid").and_then(Value::as_f64).unwrap_or(0.0);
            match self.inner.transform_row(rt, &row).await {
                Ok(Some(entry)) => entries.push(entry),
                Ok(None) => {}
                Err(err) => {
                    rt.warn(
                        "row transform failed",
                        serde_json::json!({ "rowid": row_id, "error": err.to_string() })
                            .as_object(),
                    );
                }
            }
            if row_id > max_row_id {
                max_row_id = row_id;
            }
        }
        rt.state_store.set_row_id(rt.id.as_str(), max_row_id);
        Ok(entries)
    }
}

pub fn hosted_sqlite<T: SqliteBody>(
    body: T,
    logger_name: &str,
    state_store: Arc<crate::checkpoints::StateStore>,
    poll_interval_ms: Option<u64>,
) -> Arc<HostedInput<SqliteAdapter<T>>> {
    HostedInput::new(
        SqliteAdapter::new(body),
        logger_name,
        state_store,
        poll_interval_ms,
    )
}
