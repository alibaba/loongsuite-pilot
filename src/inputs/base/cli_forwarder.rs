//! Port of `src/inputs/base/base-cli-forwarder.ts`.

use super::input_runtime::{HostedInput, InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{append_line, ensure_dir, get_today_date_string};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub struct ForwarderPaths {
    pub raw_telemetry_path: String,
    pub history_dir: String,
    pub history_prefix: String,
    /// Replaces the base poll interval after construction, including the
    /// global env override. `None` means 5000, matching `forwarderPollMs ?? 5_000`.
    pub forwarder_poll_ms: Option<u64>,
}

#[async_trait]
pub trait CliForwarderBody: Send + Sync + 'static {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        None
    }
    fn id(&self) -> &str;
    fn agent_type(&self) -> ClientType;
    fn paths(&self) -> &ForwarderPaths;
    fn is_relevant_event(&self, event: &Map<String, Value>) -> bool;
    async fn transform_payload(
        &self,
        rt: &InputRuntime,
        event: &Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>>;
}

pub struct CliForwarderAdapter<T: CliForwarderBody> {
    inner: T,
}

impl<T: CliForwarderBody> CliForwarderAdapter<T> {
    pub fn new(inner: T) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl<T: CliForwarderBody> InputBody for CliForwarderAdapter<T> {
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
        CollectionMethod::CliTelemetryForwarding
    }

    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        ensure_dir(&self.inner.paths().history_dir).await;
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let records = forward_new(&self.inner, rt).await?;
        let mut entries = Vec::new();
        for record in records {
            match self.inner.transform_payload(rt, &record).await {
                Ok(Some(entry)) => entries.push(entry),
                Ok(None) => {}
                Err(err) => {
                    rt.warn(
                        "transformPayload failed",
                        serde_json::json!({ "error": err.to_string() }).as_object(),
                    );
                }
            }
        }
        Ok(entries)
    }
}

async fn forward_new<T: CliForwarderBody>(
    body: &T,
    rt: &InputRuntime,
) -> anyhow::Result<Vec<Map<String, Value>>> {
    let meta = match tokio::fs::metadata(&body.paths().raw_telemetry_path).await {
        Ok(meta) => meta,
        Err(_) => return Ok(Vec::new()),
    };
    let offset_key = format!("{}:raw", rt.id);
    let offset = rt.state_store.get_offset(&offset_key);
    if (meta.len() as f64) <= offset {
        return Ok(Vec::new());
    }
    let mut file = tokio::fs::File::open(&body.paths().raw_telemetry_path).await?;
    file.seek(std::io::SeekFrom::Start(offset as u64)).await?;
    let mut buf = vec![0_u8; meta.len().saturating_sub(offset as u64) as usize];
    let mut filled = 0;
    while filled < buf.len() {
        let read = file.read(&mut buf[filled..]).await?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buf.truncate(filled);
    let text = String::from_utf8_lossy(&buf);
    rt.state_store.set_offset(&offset_key, meta.len() as f64);
    let mut records = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if !body.is_relevant_event(&obj) {
            continue;
        }
        let history_file = Path::new(&body.paths().history_dir).join(format!(
            "{}-{}.jsonl",
            body.paths().history_prefix,
            get_today_date_string()
        ));
        append_line(
            history_file.to_string_lossy().as_ref(),
            &serde_json::to_string(&obj).unwrap_or_else(|_| "{}".into()),
        )
        .await;
        records.push(obj);
    }
    Ok(records)
}

pub fn hosted_cli_forwarder<T: CliForwarderBody>(
    body: T,
    logger_name: &str,
    state_store: Arc<crate::checkpoints::StateStore>,
    base_poll_ms: Option<u64>,
) -> Arc<HostedInput<CliForwarderAdapter<T>>> {
    let forwarder_poll = body.paths().forwarder_poll_ms.unwrap_or(5_000);
    let hosted = HostedInput::new(
        CliForwarderAdapter::new(body),
        logger_name,
        state_store,
        base_poll_ms,
    );
    hosted.runtime.force_poll_interval_ms(forwarder_poll);
    hosted
}
