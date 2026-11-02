//! Port of `src/inputs/qoder/qoder-input.ts`.

use crate::checkpoints::InputStatePatch;
use crate::inputs::base::{env_poll_or, hosted_ide, qoder_root, IdeBody, InputRuntime};
use crate::normalization::build_agent_activity_entry;
use crate::types::{ActionType, AgentActivityEntry, ClientType, CodeGenerationEvent};
use crate::utils::{resolve_home, DEFAULT_POLL_INTERVAL_MS};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::{Arc, LazyLock};

static AI_SOURCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"qoder|ai|agent|copilot|assistant|completion").expect("ai source")
});

pub struct QoderInput {
    pub inner: Arc<crate::inputs::base::HostedInput<crate::inputs::base::IdeAdapter<QoderBody>>>,
}

pub struct QoderBody {
    data_root: String,
    snapshot: crate::checkpoints::SnapshotStore,
}

pub struct QoderOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub data_root: Option<String>,
    pub snapshot_store_path: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub snapshot_retention_ms: Option<f64>,
}

impl QoderInput {
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

    pub fn new(opts: QoderOptions) -> Self {
        let data_root = opts.data_root.unwrap_or_else(resolve_qoder_root);
        let snapshot_path = opts.snapshot_store_path.unwrap_or_else(|| {
            resolve_home("~/.loongsuite-pilot/logs/qoder/qoder-snapshot-store.json")
        });
        let snapshot = match opts.snapshot_retention_ms {
            Some(retention) => {
                crate::checkpoints::SnapshotStore::with_retention(snapshot_path, retention)
            }
            None => crate::checkpoints::SnapshotStore::new(snapshot_path),
        };
        let poll = env_poll_or(opts.poll_interval_ms, "QODER_ANALYTICS_POLL_INTERVAL")
            .or(Some(DEFAULT_POLL_INTERVAL_MS));
        let inner = hosted_ide(
            QoderBody {
                data_root,
                snapshot,
            },
            "QoderInput",
            opts.state_store,
            poll,
        );
        Self { inner }
    }

    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }

    pub fn id(&self) -> &str {
        self.inner.id()
    }

    pub fn agent_type(&self) -> ClientType {
        self.inner.agent_type()
    }

    pub fn running(&self) -> bool {
        self.inner.running()
    }

    pub fn get_watch_paths() -> Vec<String> {
        let root = resolve_qoder_root();
        let parent = Path::new(&root)
            .parent()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.clone());
        vec![parent, root]
    }

    pub async fn check_availability() -> bool {
        tokio::fs::metadata(resolve_qoder_root()).await.is_ok()
    }
}

pub fn resolve_qoder_root() -> String {
    qoder_root("Qoder")
}

#[async_trait]
impl IdeBody for QoderBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned(), "qoder-tracker".into()])
    }

    fn id(&self) -> &str {
        "qoder"
    }

    fn agent_type(&self) -> ClientType {
        ClientType::Qoder
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
            ClientType::Qoder,
            "qoder-history",
            &mut events,
        )
        .await;
        scan_ai_tracker(
            rt,
            &self.data_root,
            "qoder-tracker:",
            ClientType::Qoder,
            "qoder-ai-tracker",
            false,
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
        Ok(Some(build_qoder_entry(event, ClientType::Qoder)))
    }
}

pub fn build_qoder_entry(event: &CodeGenerationEvent, agent: ClientType) -> AgentActivityEntry {
    let session_id = event
        .raw_data
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| event.raw_data.get("entryId").and_then(Value::as_str))
        .unwrap_or("");
    let mut opts = Map::new();
    opts.insert("sessionId".into(), Value::String(session_id.to_owned()));
    opts.insert("userId".into(), Value::String(String::new()));
    opts.insert("agentType".into(), Value::String(agent.as_str().to_owned()));
    opts.insert(
        "actionType".into(),
        Value::String(event.action_type.as_str().to_owned()),
    );
    opts.insert("filePath".into(), Value::String(event.file_path.clone()));
    if let Some(content) = &event.content {
        opts.insert("content".into(), Value::String(content.clone()));
    }
    if let Some(diff) = &event.diff {
        opts.insert("inlineDiffMessage".into(), Value::String(diff.clone()));
    }
    opts.insert("timestamp".into(), json!(event.source_timestamp));
    opts.insert("extra".into(), Value::Object(event.raw_data.clone()));
    build_agent_activity_entry(&Value::Object(opts))
}

pub async fn scan_file_history(
    data_root: &str,
    since_ts: f64,
    agent: ClientType,
    tool_name: &str,
    events: &mut Vec<CodeGenerationEvent>,
) {
    let history_root = Path::new(data_root).join("User").join("History");
    let mut dir = match tokio::fs::read_dir(&history_root).await {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = dir.next_entry().await {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    for name in names {
        let entries_file = history_root.join(&name).join("entries.json");
        let Ok(raw) = tokio::fs::read_to_string(&entries_file).await else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(resource) = data.get("resource").and_then(Value::as_str) else {
            continue;
        };
        let Some(list) = data.get("entries").and_then(Value::as_array) else {
            continue;
        };
        if resource.is_empty() {
            continue;
        }
        for entry in list {
            let ts = entry
                .get("timestamp")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if ts < since_ts {
                continue;
            }
            let source = entry.get("source").and_then(Value::as_str).unwrap_or("");
            if !AI_SOURCE.is_match(&source.to_lowercase()) {
                continue;
            }
            let mut raw_data = Map::new();
            raw_data.insert("historyDir".into(), Value::String(name.clone()));
            if let Some(id) = entry.get("id") {
                raw_data.insert("entryId".into(), id.clone());
            }
            if let Some(source) = entry.get("source") {
                raw_data.insert("source".into(), source.clone());
            }
            raw_data.insert("toolName".into(), Value::String(tool_name.to_owned()));
            events.push(CodeGenerationEvent {
                agent_type: agent,
                file_path: resource.to_owned(),
                action_type: ActionType::Edit,
                content: None,
                diff: None,
                source_timestamp: ts as i64,
                raw_data,
            });
        }
    }
}

pub async fn scan_ai_tracker(
    rt: &InputRuntime,
    data_root: &str,
    state_prefix: &str,
    agent: ClientType,
    tool_name: &str,
    use_record_timestamp: bool,
    events: &mut Vec<CodeGenerationEvent>,
) {
    let tracker_dir = Path::new(data_root)
        .join("SharedClientCache")
        .join("cache")
        .join("ai_tracker");
    let mut dir = match tokio::fs::read_dir(&tracker_dir).await {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let mut files = Vec::new();
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".jsonl") {
            files.push(name);
        }
    }
    for file in files {
        let file_path = tracker_dir.join(&file);
        let state_key = format!("{state_prefix}{file}");
        let Ok(meta) = tokio::fs::metadata(&file_path).await else {
            rt.warn(
                "failed to scan ai_tracker file",
                json!({ "file": file, "error": "stat failed" }).as_object(),
            );
            continue;
        };
        let prev = rt.state_store.get(&state_key);
        let offset = prev.last_offset().unwrap_or(0.0);
        if (meta.len() as f64) <= offset {
            continue;
        }
        match crate::inputs::base::read_file_slice(
            file_path.to_string_lossy().as_ref(),
            offset as u64,
        )
        .await
        {
            Ok(Some(slice)) => {
                let text = String::from_utf8_lossy(&slice.bytes);
                rt.state_store.update(
                    &state_key,
                    InputStatePatch {
                        last_offset: Some(meta.len() as f64),
                        ..InputStatePatch::default()
                    },
                );
                for line in text.split('\n') {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(record) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    let Some(record) = record.as_object() else {
                        continue;
                    };
                    let fp = record.get("filePath").and_then(Value::as_str).unwrap_or("");
                    let added = record
                        .get("aiAddedLines")
                        .cloned()
                        .unwrap_or(Value::Array(Vec::new()));
                    let deleted = record
                        .get("aiDeletedLines")
                        .cloned()
                        .unwrap_or(Value::Array(Vec::new()));
                    let modified = record
                        .get("aiModifiedContent")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let record_ts = if use_record_timestamp {
                        record
                            .get("timestamp")
                            .and_then(Value::as_f64)
                            .map(|ts| ts as i64)
                            .unwrap_or_else(now_ms)
                    } else {
                        now_ms()
                    };
                    let mut raw_data = Map::new();
                    raw_data.insert("toolName".into(), Value::String(tool_name.to_owned()));
                    raw_data.insert("trackerFile".into(), Value::String(file.clone()));
                    raw_data.insert("aiAddedLines".into(), added);
                    raw_data.insert("aiDeletedLines".into(), deleted);
                    events.push(CodeGenerationEvent {
                        agent_type: agent,
                        file_path: fp.to_owned(),
                        action_type: ActionType::Edit,
                        source_timestamp: record_ts,
                        content: Some(modified.chars().take(2000).collect()),
                        diff: None,
                        raw_data,
                    });
                }
            }
            Ok(None) => {}
            Err(err) => {
                rt.warn(
                    "failed to scan ai_tracker file",
                    json!({ "file": file, "error": err.to_string() }).as_object(),
                );
            }
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "ide_history_migration_contract_tests.rs"]
mod ide_history_migration_contract_tests;
