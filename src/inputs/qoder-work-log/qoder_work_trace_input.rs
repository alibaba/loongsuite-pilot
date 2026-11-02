//! SDK log + optional SQLite prompts for a result-window session trace.
//! This concrete input is the class registered for qoder-work-cn-trace.
use super::qoder_work_log_input::{open_log_file, parse_sdk_log_line};
use super::sdk_trace_model::{Policy, TraceState, Window};
use super::sdk_trace_output::{emit, WindowCheckpoint};
use crate::inputs::base::{InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::DEFAULT_POLL_INTERVAL_MS;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;
pub struct QoderWorkLogTraceOptions {
    pub state_store: std::sync::Arc<crate::checkpoints::StateStore>,
    pub data_root: Option<String>,
    pub agent_type: Option<ClientType>,
    pub poll_interval_ms: Option<u64>,
}
pub struct QoderWorkLogTraceInput {
    inner: std::sync::Arc<crate::inputs::base::HostedInput<QoderWorkLogTraceBody>>,
}
struct QoderWorkLogTraceBody {
    id: String,
    agent_type: ClientType,
    db_path: String,
    logs_dir: String,
    projects_dir: PathBuf,
    state: Mutex<TraceState>,
}
impl QoderWorkLogTraceInput {
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

    pub fn new(opts: QoderWorkLogTraceOptions) -> Self {
        let agent_type = opts.agent_type.unwrap_or(ClientType::QoderWork);
        let variant = if agent_type == ClientType::QoderWorkCN {
            "cn"
        } else {
            "standard"
        };
        let root = opts
            .data_root
            .unwrap_or_else(|| super::resolve_qoder_work_root(variant));
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QoderWorkLogTraceBody {
                    id: format!("{agent_type}-trace"),
                    agent_type,
                    state: Mutex::new(TraceState::default()),
                    projects_dir: PathBuf::from(crate::utils::resolve_home(
                        if agent_type == ClientType::QoderWorkCN {
                            "~/.qoderworkcn/projects"
                        } else {
                            "~/.qoderwork/projects"
                        },
                    )),
                    db_path: PathBuf::from(&root)
                        .join("data")
                        .join("agents.db")
                        .to_string_lossy()
                        .into_owned(),
                    logs_dir: PathBuf::from(&root)
                        .join("logs")
                        .to_string_lossy()
                        .into_owned(),
                },
                "QoderWorkTraceInput",
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
}

#[async_trait]
impl InputBody for QoderWorkLogTraceBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id.clone()])
    }
    fn id(&self) -> &str {
        &self.id
    }
    fn agent_type(&self) -> ClientType {
        self.agent_type
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }
    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        // The old placeholder's trace-log keys never described SDK files.
        // Do not adopt them or alter unknown old state.
        WindowCheckpoint::load(&rt.state())?;
        for path in self.discover().await {
            let key = format!("{}:{path}", self.id);
            if rt.state_store.get(&key).last_offset().is_some() {
                continue;
            }
            let Ok((mut file, identity)) = open_log_file(&path).await else {
                continue;
            };
            let boundary = find_result_boundary(&mut file, identity.size).await?;
            rt.state_store.update(
                &key,
                crate::checkpoints::InputStatePatch {
                    last_offset: Some(boundary as f64),
                    extra: Some(json!({"inode":identity.ino,"dev":identity.dev})),
                    ..Default::default()
                },
            );
        }
        Ok(())
    }
    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let mut checkpoint = WindowCheckpoint::load(&rt.state())?;
        let mut windows = Vec::new();
        for path in self.discover().await {
            match self.read_file(rt, &path).await {
                Ok(completed) => windows.extend(completed),
                Err(error) => rt.warn(
                    "SDK trace file unavailable; retaining unread range",
                    json!({"path":path,"error":error.to_string()}).as_object(),
                ),
            }
        }
        windows.extend(
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .evict(chrono::Utc::now().timestamp_millis()),
        );
        let mut entries = Vec::new();
        let source = if self.agent_type == ClientType::QoderWorkCN {
            "qoder-work-cn-trace"
        } else {
            "qoder-work-trace"
        };
        for window in windows {
            entries.extend(
                emit(
                    window,
                    rt,
                    &self.db_path,
                    &self.projects_dir,
                    source,
                    &mut checkpoint,
                )
                .await?,
            );
        }
        Ok(entries)
    }
}
impl QoderWorkLogTraceBody {
    async fn discover(&self) -> Vec<String> {
        let mut files = Vec::new();
        let Ok(mut directories) = tokio::fs::read_dir(&self.logs_dir).await else {
            return files;
        };
        while let Ok(Some(directory)) = directories.next_entry().await {
            if !directory
                .file_type()
                .await
                .ok()
                .is_some_and(|kind| kind.is_dir())
            {
                continue;
            }
            let main = directory.path().join("main.log");
            if tokio::fs::metadata(&main)
                .await
                .ok()
                .is_some_and(|meta| meta.is_file())
            {
                files.push(main.to_string_lossy().into_owned());
                continue;
            }
            let Ok(mut nested) = tokio::fs::read_dir(directory.path().join("main")).await else {
                continue;
            };
            while let Ok(Some(entry)) = nested.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("sdk-")
                    && name.ends_with(".log")
                    && entry
                        .file_type()
                        .await
                        .ok()
                        .is_some_and(|kind| kind.is_file())
                {
                    files.push(entry.path().to_string_lossy().into_owned());
                }
            }
        }
        files.sort();
        files
    }
    async fn read_file(&self, rt: &InputRuntime, path: &str) -> anyhow::Result<Vec<Window>> {
        let (file, identity) = open_log_file(path).await?;
        self.read_opened_file(rt, path, file, identity).await
    }
    async fn read_opened_file(
        &self,
        rt: &InputRuntime,
        path: &str,
        mut file: tokio::fs::File,
        identity: crate::utils::file_identity::OpenedFileIdentity,
    ) -> anyhow::Result<Vec<Window>> {
        let key = format!("{}:{path}", self.id);
        let previous = rt.state_store.get(&key);
        let extra = previous.extra().unwrap_or(Value::Null);
        let replaced = extra
            .get("inode")
            .and_then(Value::as_u64)
            .is_some_and(|v| v != identity.ino)
            || extra
                .get("dev")
                .and_then(Value::as_u64)
                .is_some_and(|v| v != identity.dev);
        let offset = previous
            .last_offset()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(0.0) as u64;
        let offset = if replaced || offset > identity.size {
            0
        } else {
            offset
        };
        if identity.size <= offset {
            return Ok(Vec::new());
        }
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        let length = (identity.size - offset).min(MAX_READ_BYTES) as usize;
        let mut bytes = vec![0; length];
        let mut filled = 0;
        while filled < length {
            let read = file.read(&mut bytes[filled..]).await?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        bytes.truncate(filled);
        let Some(newline) = bytes.iter().rposition(|b| *b == b'\n') else {
            return Ok(Vec::new());
        };
        let events = String::from_utf8_lossy(&bytes[..newline])
            .split('\n')
            .filter_map(parse_sdk_log_line)
            .collect();
        let mut policy = if replaced {
            Policy::default()
        } else {
            extra
                .get("modelPolicy")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default()
        };
        let completed = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process(events, &mut policy);
        rt.state_store.update(
            &key,
            crate::checkpoints::InputStatePatch {
                last_offset: Some((offset + newline as u64 + 1) as f64),
                extra: Some(json!({"inode":identity.ino,"dev":identity.dev,"modelPolicy":policy})),
                ..Default::default()
            },
        );
        Ok(completed)
    }
}
// Reverse chunks locate the latest complete result with bounded memory.
// Over-budget individual records never advance an owned range.
async fn find_result_boundary(file: &mut tokio::fs::File, size: u64) -> std::io::Result<u64> {
    let mut cursor = size;
    let mut suffix = Vec::new();
    while cursor > 0 {
        let start = cursor.saturating_sub(64 * 1024);
        let length = (cursor - start) as usize;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let mut bytes = vec![0; length];
        let mut filled = 0;
        while filled < length {
            let read = file.read(&mut bytes[filled..]).await?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        bytes.truncate(filled);
        bytes.extend_from_slice(&suffix);
        let first = if start == 0 {
            0
        } else {
            bytes
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| n + 1)
                .unwrap_or(bytes.len())
        };
        let mut bounds = Vec::new();
        let mut line_start = first;
        for (end, byte) in bytes.iter().enumerate().skip(first) {
            if *byte == b'\n' {
                bounds.push((line_start, end));
                line_start = end + 1;
            }
        }
        for (begin, end) in bounds.into_iter().rev() {
            if matches!(
                parse_sdk_log_line(&String::from_utf8_lossy(&bytes[begin..end])),
                Some(super::qoder_work_log_input::SdkEvent::Result { .. })
            ) {
                return Ok(start + end as u64 + 1);
            }
        }
        suffix = if first <= MAX_READ_BYTES as usize {
            bytes[..first].to_vec()
        } else {
            Vec::new()
        };
        cursor = start;
    }
    Ok(0)
}
#[cfg(test)]
#[path = "cn_trace_history_migration_contract_tests.rs"]
mod cn_sdk_trace_history_migration_contract_tests;
