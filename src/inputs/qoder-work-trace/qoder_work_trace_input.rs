//! Port of `src/inputs/qoder-work-trace/qoder-work-trace-input.ts`.
//!
//! Reads today's hook JSONL, drops bootstrap history except the latest turn in
//! each batch, and enriches git context. Segment timing uses the same session
//! directory layout as the TypeScript input (`<segmentsRoot>/<encoded cwd>/<session>/segments`).
use super::enrichment::{read_hook_lines, WorkState};
use crate::inputs::base::{
    create_hook_history_startup_checkpoint, entry_from, filter_bootstrap_history_turns, InputBody,
    InputRuntime,
};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
#[cfg(test)]
use crate::utils::get_today_date_string;
use crate::utils::{directory_exists, ensure_dir, resolve_home, DEFAULT_POLL_INTERVAL_MS};
use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::path::Path;

pub struct QoderWorkTraceOptions {
    pub state_store: std::sync::Arc<crate::checkpoints::StateStore>,
    pub log_dir: Option<String>,
    pub segments_root: Option<String>,
    pub sdk_log_dir: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

pub struct QoderWorkTraceInput {
    inner: std::sync::Arc<crate::inputs::base::HostedInput<QoderWorkTraceBody>>,
}

struct QoderWorkTraceBody {
    log_dir: String,
    segments_root: String,
    sdk_log_dir: String,
    state: tokio::sync::Mutex<WorkState>,
}

impl QoderWorkTraceInput {
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

    pub fn new(opts: QoderWorkTraceOptions) -> Self {
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QoderWorkTraceBody {
                    state: tokio::sync::Mutex::new(WorkState::default()),
                    log_dir: opts.log_dir.unwrap_or_else(|| {
                        resolve_home("~/.loongsuite-pilot/logs/qoder-work/history")
                    }),
                    segments_root: opts
                        .segments_root
                        .unwrap_or_else(|| resolve_home("~/.qoderwork/logs/sessions")),
                    sdk_log_dir: opts.sdk_log_dir.unwrap_or_else(|| {
                        std::path::PathBuf::from(
                            crate::inputs::qoder_work_log::resolve_qoder_work_root("standard"),
                        )
                        .join("logs")
                        .to_string_lossy()
                        .into_owned()
                    }),
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

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home("~/.qoderwork")).await
    }

    pub fn get_watch_paths() -> Vec<String> {
        vec![
            resolve_home("~/.loongsuite-pilot/logs/qoder-work/history"),
            resolve_home("~/.qoderwork/logs/sessions"),
        ]
    }
}

#[async_trait]
impl InputBody for QoderWorkTraceBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "qoder-work-trace"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QoderWork
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        ensure_dir(&self.log_dir).await;
        let state = rt.state();
        if let Some(checkpoint) =
            create_hook_history_startup_checkpoint(&state, &self.log_dir, "qoder-work").await?
        {
            rt.set_state_fields(
                Some(checkpoint.last_file),
                Some(checkpoint.last_offset),
                Some(checkpoint.extra),
            );
            if checkpoint.skipped_existing_bytes > 0 {
                rt.warn(
                    "history checkpoint missing, baselining existing file without replay",
                    json!({ "skippedBytes": checkpoint.skipped_existing_bytes }).as_object(),
                );
            } else {
                rt.info(
                    "history checkpoint initialized before first hook record",
                    None,
                );
            }
        }
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let mut state = self.state.lock().await;
        let result: anyhow::Result<Vec<AgentActivityEntry>> = async {
            state.read_sdk(rt, &self.sdk_log_dir).await?;
            let entries = filter_bootstrap_history_turns(read_hook(&self.log_dir, rt).await?);
            if entries.is_empty() {
                return Ok(Vec::new());
            }
            let mut sessions = IndexMap::<String, String>::new();
            for entry in &entries {
                let cwd = entry
                    .extra
                    .get("agent.qoderwork.cwd")
                    .and_then(Value::as_str)
                    .filter(|cwd| !cwd.is_empty());
                if let Some(cwd) = cwd.filter(|_| !entry.session_id.is_empty()) {
                    sessions
                        .entry(entry.session_id.clone())
                        .or_insert_with(|| cwd.to_owned());
                }
            }
            for (session, cwd) in sessions {
                state
                    .read_segments(rt, &self.segments_root, &session, &cwd)
                    .await?;
            }
            let mut groups = IndexMap::<String, Vec<AgentActivityEntry>>::new();
            for entry in entries {
                let turn = entry
                    .turn_id
                    .clone()
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| "unknown".into());
                groups.entry(turn).or_default().push(entry);
            }
            let mut output = Vec::new();
            for mut entries in groups.into_values() {
                state.enrich(&mut entries);
                let trace = hex::encode(uuid::Uuid::new_v4().as_bytes());
                for entry in &mut entries {
                    entry.trace_id = Some(trace.clone());
                    let record = crate::inputs::base::entry_map(entry);
                    let _ = enrich_canonical_entry_with_git(entry, &record, "qoder-work").await;
                }
                output.extend(entries);
            }
            Ok(output)
        }
        .await;
        // Includes empty polls and failed reads; stale cache cannot live forever
        // simply because no later hook event arrives for that session.
        state.evict();
        match result {
            Err(error)
                if error.to_string().contains("Permission denied")
                    || error.to_string().contains("EACCES") =>
            {
                rt.diagnose_unreadable_path(&self.log_dir, "session directory")
                    .await;
                Ok(Vec::new())
            }
            result => result,
        }
    }
}

async fn read_hook(log_dir: &str, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
    let dir = Path::new(log_dir);
    let names = crate::utils::raw_source::daily_files(dir, "qoder-work").await?;
    let previous = rt.state();
    let mut entries = Vec::new();
    let mut offsets = serde_json::Map::new();
    let mut identities = serde_json::Map::new();
    let mut blocked = serde_json::Map::new();
    let mut read_bytes = 0_u64;
    let mut last = None;
    let mut legacy = serde_json::Map::new();
    for name in names {
        let key = format!("{}:{name}", rt.id);
        let before = rt.state_store.get_offset(&key).max(0.0) as u64;
        let lines = if read_bytes < crate::utils::raw_source::CYCLE_BYTES {
            read_hook_lines(rt, &dir.join(&name), &name).await?
        } else {
            Vec::new()
        };
        let cursor = rt.state_store.get(&key);
        if let (Some(offset), Some(extra)) = (cursor.last_offset(), cursor.extra()) {
            if let Some(identity) = extra["fileIdentity"].as_str() {
                offsets.insert(name.clone(), serde_json::json!(offset));
                identities.insert(name.clone(), identity.into());
                if extra["retentionBlocked"] == true {
                    blocked.insert(name.clone(), true.into());
                }
                let consumed = (offset as u64).saturating_sub(before);
                read_bytes = read_bytes.saturating_add(consumed);
                if consumed > 0 || (last.is_none() && previous.last_file() == Some(&name)) {
                    for field in ["fileIdentity", "inode", "skippingLine", "retentionBlocked"] {
                        legacy.remove(field);
                        if let Some(value) = extra.get(field) {
                            legacy.insert(field.to_owned(), value.clone());
                        }
                    }
                    if consumed > 0 {
                        last = Some((name, offset));
                    }
                }
            }
        }
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
                rt.warn("invalid JSONL line", None);
                continue;
            };
            let Some(object) = value.as_object_mut() else {
                continue;
            };
            object.remove("version");
            if object.get("event.name").is_none() {
                continue;
            };
            entries.push(entry_from(std::mem::take(object)));
        }
    }
    legacy.extend([
        ("hookLogDir".into(), log_dir.into()),
        ("hookLogPrefix".into(), "qoder-work".into()),
        ("hookLogOffsets".into(), Value::Object(offsets)),
        ("hookLogIdentities".into(), Value::Object(identities)),
        ("hookLogRetentionBlocked".into(), Value::Object(blocked)),
    ]);
    let extra = Value::Object(legacy);
    if !extra["hookLogOffsets"]
        .as_object()
        .is_none_or(serde_json::Map::is_empty)
        && (last.is_some()
            || previous.extra().as_ref().is_none_or(|saved| {
                [
                    "hookLogOffsets",
                    "hookLogIdentities",
                    "hookLogRetentionBlocked",
                ]
                .iter()
                .any(|key| saved[*key] != extra[*key])
            }))
    {
        let (file, offset) = last.map_or((None, None), |(file, offset)| (Some(file), Some(offset)));
        rt.set_state_fields(file, offset, Some(extra));
    }
    Ok(entries)
}

#[cfg(test)]
#[path = "qoder_work_trace_history_tests.rs"]
mod history_tests;
