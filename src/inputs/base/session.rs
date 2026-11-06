//! Port of `src/inputs/base/base-session-input.ts`.

use super::input_runtime::{HostedInput, InputBody, InputRuntime};
use super::jsonl::{self, decode_complete, record_byte_length};
use super::runtime_metrics::{CommittedInputBatch, InputRuntimeAccumulator};
use crate::checkpoints::InputStatePatch;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::io::ErrorKind;

pub struct SessionPaths {
    pub session_dir: String,
    pub file_pattern: String,
}

#[async_trait]
pub trait SessionBody: Send + Sync + 'static {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        None
    }
    fn id(&self) -> &str;
    fn agent_type(&self) -> ClientType;
    fn paths(&self) -> &SessionPaths;
    async fn discover_session_files(&self, rt: &InputRuntime) -> anyhow::Result<Vec<String>>;
    async fn process_session_line(
        &self,
        rt: &InputRuntime,
        record: &Map<String, Value>,
        file_path: &str,
    ) -> anyhow::Result<Option<AgentActivityEntry>>;
    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        Ok(())
    }
    fn agent_version(&self) -> String {
        String::new()
    }
    fn before_stop(&self) {}
}

pub struct SessionAdapter<T: SessionBody> {
    inner: T,
}

impl<T: SessionBody> SessionAdapter<T> {
    pub fn new(inner: T) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &T {
        &self.inner
    }
}

#[async_trait]
impl<T: SessionBody> InputBody for SessionAdapter<T> {
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
        CollectionMethod::SessionFilePolling
    }

    fn agent_version(&self) -> String {
        self.inner.agent_version()
    }

    fn before_stop(&self) {
        self.inner.before_stop();
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        self.inner.on_start(rt).await
    }

    async fn on_stop(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        self.inner.on_stop(rt).await
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let files = self.inner.discover_session_files(rt).await?;
        let mut all = Vec::new();
        for file_path in files {
            all.extend(process_file(&self.inner, rt, &file_path).await?);
        }
        Ok(all)
    }
}

async fn process_file<T: SessionBody>(
    body: &T,
    rt: &InputRuntime,
    file_path: &str,
) -> anyhow::Result<Vec<AgentActivityEntry>> {
    // Identity and bytes must refer to the same opened file. In particular,
    // Windows cannot use MetadataExt::ino (the former fallback was always 0),
    // and a rename between path metadata and a later open must not lend the
    // old checkpoint to replacement content.
    let opened = match tokio::fs::File::open(file_path).await {
        Ok(file) => file.into_std().await,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) if InputRuntime::is_unreadable_error(&err) => {
            rt.diagnose_unreadable_path(file_path, "event file").await;
            return Ok(Vec::new());
        }
        Err(err) => return Err(err.into()),
    };
    let identity = crate::utils::file_identity::identity_from_open(&opened)?;
    let state_key = format!("{}:{file_path}", rt.id);
    let previous = rt.state_store.get(&state_key);
    let extra = previous.extra();
    let previous_inode = extra
        .as_ref()
        .and_then(|extra| extra.get("inode"))
        .and_then(json_inode);
    let previous_device = extra
        .as_ref()
        .and_then(|extra| extra.get("device"))
        .and_then(json_inode);
    let identity_changed = previous_inode
        .filter(|inode| *inode != 0)
        .is_some_and(|inode| inode != identity.ino)
        || previous_device.is_some_and(|device| device != identity.dev);
    let mut offset = previous.last_offset().unwrap_or(0.0);
    if identity_changed || (identity.size as f64) < offset {
        rt.info(
            "file truncated or rotated, resetting offset",
            json!({ "file": file_path, "recorded": offset, "actual": identity.size }).as_object(),
        );
        offset = 0.0;
        rt.state_store.set_offset(&state_key, 0.0);
    }
    let identity_changed_or_missing =
        previous_inode != Some(identity.ino) || previous_device != Some(identity.dev);
    if identity_changed_or_missing && (identity.size > 0 || previous_inode.is_some()) {
        rt.state_store.update(
            &state_key,
            InputStatePatch {
                extra: Some(json!({ "inode": identity.ino, "device": identity.dev })),
                ..InputStatePatch::default()
            },
        );
    }
    if (identity.size as f64) <= offset {
        return Ok(Vec::new());
    }
    let requested = identity.size.saturating_sub(offset as u64);
    rt.with_accumulator(|acc| acc.observe_backlog(requested));
    let started = InputRuntimeAccumulator::now();
    let read = match read_opened_file_slice(opened, identity.size, offset as u64).await {
        Ok(read) => read,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) if InputRuntime::is_unreadable_error(&err) => {
            rt.diagnose_unreadable_path(file_path, "event file").await;
            return Ok(Vec::new());
        }
        Err(err) => return Err(err.into()),
    };
    rt.with_accumulator(|acc| {
        acc.observe_read(
            read.bytes.len() as u64,
            requested,
            InputRuntimeAccumulator::now() - started,
        );
    });
    let Some(newline) = jsonl::last_newline(&read.bytes) else {
        return Ok(Vec::new());
    };
    let complete = &read.bytes[..=newline];
    rt.state_store
        .set_offset(&state_key, offset + complete.len() as f64);
    let (text, ascii) = decode_complete(complete);
    let mut entries = Vec::new();
    let mut records = 0_u64;
    let mut parse_success = 0_u64;
    let mut parse_failed = 0_u64;
    let mut max_record_bytes = 0_u64;
    let mut cursor = 0_usize;
    for line in text.split('\n') {
        let Some(record_bytes) = record_byte_length(ascii, line, complete, &mut cursor) else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        records += 1;
        max_record_bytes = max_record_bytes.max(record_bytes as u64);
        let parsed = match jsonl::parse_object_line(line) {
            Ok(parsed) => {
                parse_success += 1;
                parsed
            }
            Err(err) => {
                parse_failed += 1;
                if !err.contains("not an object") {
                    rt.warn(
                        "invalid session line",
                        json!({ "file": file_path, "error": err }).as_object(),
                    );
                }
                continue;
            }
        };
        match body.process_session_line(rt, &parsed, file_path).await {
            Ok(Some(entry)) => entries.push(entry),
            Ok(None) => {}
            Err(err) => {
                rt.warn(
                    "invalid session line",
                    json!({ "file": file_path, "error": err.to_string() }).as_object(),
                );
            }
        }
    }
    rt.with_accumulator(|acc| {
        acc.observe_committed_batch(CommittedInputBatch {
            records,
            bytes: complete.len() as u64,
            parse_success_records: parse_success,
            parse_failed_records: parse_failed,
            max_record_bytes,
        });
    });
    Ok(entries)
}

async fn read_opened_file_slice(
    file: std::fs::File,
    size: u64,
    offset: u64,
) -> std::io::Result<jsonl::FileSlice> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::from_std(file);
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut bytes = Vec::new();
    file.take(size.saturating_sub(offset))
        .read_to_end(&mut bytes)
        .await?;
    Ok(jsonl::FileSlice { bytes, size })
}

fn json_inode(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_f64().map(|n| n as u64))
}

pub fn hosted_session<T: SessionBody>(
    body: T,
    logger_name: &str,
    state_store: std::sync::Arc<crate::checkpoints::StateStore>,
    poll_interval_ms: Option<u64>,
) -> std::sync::Arc<HostedInput<SessionAdapter<T>>> {
    HostedInput::new(
        SessionAdapter::new(body),
        logger_name,
        state_store,
        poll_interval_ms,
    )
}
