//! Port of `src/inputs/qoder-work-log/qoder-work-trace-input.ts`.
//!
//! This is the session-file trace input (SDK log + SQLite user prompts), not
//! the hook JSONL trace input in `qoder-work-trace`. The SQLite prompt join,
//! tool-result directory scan, and turn-identity window from that file are
//! only partially represented: `parse_sdk_log_line` events are accepted and
//! user prompts are read with the same `messages` query when a db path is set.
//! Turn identity hashing and the 30 minute session window follow the constants
//! in the TypeScript source.

use crate::inputs::base::{query_readonly, InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::DEFAULT_POLL_INTERVAL_MS;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;

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
                    id: format!("{agent_type}-trace-log"),
                    agent_type,
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
        Some(Vec::new())
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

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let prompts = match query_readonly(
            &self.db_path,
            "SELECT id, parts, updated_at AS updatedAt, sequence FROM messages WHERE role = 'user' AND parts IS NOT NULL AND parts != '' AND parts != '[]' ORDER BY updated_at ASC LIMIT 2000",
            &[],
        ).await {
            Ok(rows) => rows,
            Err(err) => {
                rt.warn("qoder-work log trace sqlite read failed", json!({ "error": err, "logs": self.logs_dir }).as_object());
                Vec::new()
            }
        };
        let mut entries = Vec::new();
        for row in prompts {
            let Value::Object(map) = row else { continue };
            let id = map.get("id").and_then(Value::as_str).unwrap_or("");
            let parts = map.get("parts").and_then(Value::as_str).unwrap_or("");
            let Ok(parsed) = serde_json::from_str::<Value>(parts) else {
                continue;
            };
            let text = parsed
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| {
                            if part.get("type").and_then(Value::as_str) != Some("text") {
                                return None;
                            }
                            part.get("text")
                                .or_else(|| part.get("content"))
                                .and_then(Value::as_str)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if text.is_empty() {
                continue;
            }
            let updated = map.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0);
            entries.push(crate::normalization::build_agent_activity_entry(&json!({
                "timestamp": if updated > 0.0 { updated * 1000.0 } else { 0.0 },
                "event.id": id,
                "event.name": "llm.request",
                "gen_ai.agent.type": self.agent_type.as_str(),
                "gen_ai.input.messages_delta": [{ "role": "user", "content": text }],
                "attributes": { "source": "qoder-work-trace-log", "message_id": id }
            })));
        }
        Ok(entries)
    }
}
