//! Port of `src/inputs/qoder-trace/qoder-trace-input.ts`.
//!
//! Collector-owned native transcripts and upgrade-only Hook JSONL share token
//! enrichment. CLI turns take intercept usage and, when
//! usage or the request/response interval is missing, session segments. IDE
//! turns take SQLite usage, with one shared retry when a response is still
//! unmatched. Multimodal upload is invoked only when a `path_to_uri` callback
//! is supplied; the processor itself lives outside this inputs port.

use super::legacy_hook_reader::QoderLegacyHookReader;
use super::multimodal::{PathToUri, QoderMultimodal};
use super::prompt_ownership::{NativeQoderPromptOwnershipResolver, QoderPromptOwnershipResolver};
use super::transcript_source::{QoderTranscriptSource, TranscriptBatch};
use super::{
    collect_cli_expected_request_ids, enrich_cli_from_segments, enrich_cli_primary,
    enrich_ide_turn, is_idea_db_path, needs_cli_segment_fallback, read_intercept_data,
    read_segment_tokens_for_session, read_sqlite_tokens_for_session, resolve_qoder_app_root,
    QODER_SEGMENTS_ROOT,
};
use crate::inputs::base::{
    build_canonical_hook_entry, create_hook_history_startup_checkpoint,
    filter_bootstrap_history_turns, CanonicalHookRecordOptions, InputBody, InputRuntime,
};
use crate::multimodal::{MultimodalProcessor, PathToUriOptions};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod, MultimodalUploadMode};
use crate::utils::{
    directory_exists, ensure_dir, get_today_date_string, resolve_home, DEFAULT_POLL_INTERVAL_MS,
};
use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Injectable native readers keep embedded inputs and isolated fixture sources
/// on the same collection path. Normal construction uses all production readers.
#[async_trait]
pub trait QoderTraceReaders: Send + Sync {
    async fn read_cli_intercept(&self) -> super::InterceptData {
        read_intercept_data(None, None).await
    }
    /// Defaults preserve existing injected readers. Native readers use an
    /// instance-owned index and return only usage needed by this batch.
    async fn read_cli_intercept_for(&self, _response_ids: &[String]) -> super::InterceptData {
        self.read_cli_intercept().await
    }
    async fn read_cli_segments(
        &self,
        session: &str,
        expected: &[String],
    ) -> Vec<super::SegmentTokenData> {
        read_segment_tokens_for_session(session, expected, QODER_SEGMENTS_ROOT).await
    }
    async fn read_ide_tokens(&self, session: &str) -> super::SqliteTokenResult {
        read_sqlite_tokens_for_session(session).await
    }
    async fn read_ide_images(
        &self,
        ids: &[String],
    ) -> Result<HashMap<String, super::AttachedImageLookup>, String> {
        Ok(super::read_attached_image_paths_for_request_ids(ids).await)
    }
}
#[derive(Default)]
struct NativeQoderTraceReaders {
    intercept: tokio::sync::Mutex<super::intercept_token_reader::InterceptTokenIndex>,
}
#[async_trait]
impl QoderTraceReaders for NativeQoderTraceReaders {
    async fn read_cli_intercept_for(&self, response_ids: &[String]) -> super::InterceptData {
        self.intercept
            .lock()
            .await
            .read_for_responses(
                &super::get_intercept_file("qodercli-intercept.jsonl"),
                None,
                response_ids,
            )
            .await
    }
}

pub struct QoderTraceOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub log_dir: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub multimodal_enabled: bool,
    pub upload_mode: Option<MultimodalUploadMode>,
    pub allowed_root_paths: Vec<String>,
}

pub struct QoderTraceInput {
    pub inner: Arc<crate::inputs::base::HostedInput<QoderTraceBody>>,
}

pub struct QoderTraceBody {
    log_dir: String,
    stopped: Arc<AtomicBool>,
    stop_notify: Arc<tokio::sync::Notify>,
    allowed_roots: Vec<String>,
    multimodal_enabled: bool,
    upload_mode: MultimodalUploadMode,
    path_to_uri: Mutex<Option<PathToUri>>,
    multimodal: QoderMultimodal,
    readers: Arc<dyn QoderTraceReaders>,
    transcript_source: QoderTranscriptSource,
    legacy_reader: tokio::sync::Mutex<QoderLegacyHookReader>,
}

impl QoderTraceInput {
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

    pub fn new(opts: QoderTraceOptions) -> Self {
        let data_dir = qoder_data_dir_from_state(&opts.state_store);
        Self::new_with_data_dir(opts, data_dir)
    }
    pub fn new_with_data_dir(opts: QoderTraceOptions, data_dir: PathBuf) -> Self {
        Self::new_with_sources(
            opts,
            data_dir,
            Arc::new(NativeQoderTraceReaders::default()),
            Arc::new(NativeQoderPromptOwnershipResolver::default()),
        )
    }
    pub fn with_readers(opts: QoderTraceOptions, readers: Arc<dyn QoderTraceReaders>) -> Self {
        let data_dir = qoder_data_dir_from_state(&opts.state_store);
        Self::new_with_sources(
            opts,
            data_dir,
            readers,
            Arc::new(NativeQoderPromptOwnershipResolver::default()),
        )
    }
    pub fn new_with_sources(
        opts: QoderTraceOptions,
        data_dir: PathBuf,
        readers: Arc<dyn QoderTraceReaders>,
        resolver: Arc<dyn QoderPromptOwnershipResolver>,
    ) -> Self {
        let enabled = opts.multimodal_enabled;
        let image_readers = Arc::clone(&readers);
        let multimodal = QoderMultimodal::with_lookup(Arc::new(move |ids| {
            let readers = Arc::clone(&image_readers);
            Box::pin(async move { readers.read_ide_images(&ids).await })
        }));
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QoderTraceBody {
                    log_dir: opts
                        .log_dir
                        .unwrap_or_else(|| resolve_home("~/.loongsuite-pilot/logs/qoder/history")),
                    stopped: Arc::new(AtomicBool::new(false)),
                    stop_notify: Arc::new(tokio::sync::Notify::new()),
                    multimodal_enabled: enabled,
                    upload_mode: opts.upload_mode.unwrap_or(MultimodalUploadMode::None),
                    path_to_uri: Mutex::new(None),
                    multimodal,
                    readers,
                    transcript_source: QoderTranscriptSource::new(
                        data_dir,
                        "qoder".into(),
                        resolver,
                    ),
                    legacy_reader: tokio::sync::Mutex::new(QoderLegacyHookReader::default()),
                    allowed_roots: if enabled {
                        resolve_qoder_allowed_root_paths(&opts.allowed_root_paths)
                    } else {
                        Vec::new()
                    },
                },
                "QoderTraceInput",
                opts.state_store,
                opts.poll_interval_ms.or(Some(DEFAULT_POLL_INTERVAL_MS)),
            ),
        }
    }

    pub(crate) fn set_trace_linker(&self, linker: Arc<crate::core::TraceLinker>) {
        self.inner.body.transcript_source.set_trace_linker(linker);
    }

    /// Attach the configured shared processor; path policy stays on every call.
    pub fn set_multimodal_processor(&self, processor: Arc<MultimodalProcessor>) {
        let roots = self.inner.body.allowed_roots.clone();
        let callback: PathToUri = Arc::new(move |path, time| {
            let processor = Arc::clone(&processor);
            let roots = roots.clone();
            Box::pin(async move {
                Ok(processor
                    .path_to_uri(
                        &path,
                        Some(time as f64),
                        PathToUriOptions {
                            allowed_root_paths: Some(roots),
                            deadline_ms: None,
                        },
                    )
                    .await)
            })
        });
        self.set_multimodal_handler(callback);
    }

    /// Embedders can provide the same fallible async URI adapter as the shared processor.
    pub fn set_multimodal_handler(&self, callback: PathToUri) {
        let stopped = Arc::clone(&self.inner.body.stopped);
        let notify = Arc::clone(&self.inner.body.stop_notify);
        let guarded: PathToUri = Arc::new(move |path, time| {
            let callback = Arc::clone(&callback);
            let stopped = Arc::clone(&stopped);
            let notify = Arc::clone(&notify);
            Box::pin(async move {
                let stopping = notify.notified();
                tokio::pin!(stopping);
                stopping.as_mut().enable();
                if stopped.load(Ordering::SeqCst) {
                    return Ok(None);
                }
                let result = tokio::select! {
                    biased;
                    _=stopping=>Ok(None),
                    result=callback(path,time)=>result,
                };
                if stopped.load(Ordering::SeqCst) {
                    Ok(None)
                } else {
                    result
                }
            })
        });
        *self
            .inner
            .body
            .path_to_uri
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(guarded);
    }

    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }
    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }
    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home("~/.qoder")).await
    }
    pub fn get_watch_paths() -> Vec<String> {
        vec![
            resolve_home("~/.loongsuite-pilot/logs/qoder/history"),
            resolve_home(QODER_SEGMENTS_ROOT),
        ]
    }
}

pub fn qoder_default_allowed_root_paths() -> Vec<String> {
    let app_root = resolve_qoder_app_root();
    let mut roots = vec![
        resolve_home("~/.qoder/tmp"),
        resolve_home("~/.qoder/vibe_images"),
        Path::new(&app_root)
            .join("SharedClientCache")
            .join("cache")
            .join("images")
            .to_string_lossy()
            .into_owned(),
    ];
    if let Ok(entries) = crate::utils::source_access::read_dir(&app_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "SharedClientCache" {
                continue;
            }
            roots.push(
                Path::new(&app_root)
                    .join(name)
                    .join("SharedClientCache")
                    .join("cache")
                    .join("images")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    roots
}

pub fn resolve_qoder_allowed_root_paths(user_paths: &[String]) -> Vec<String> {
    crate::multimodal::resolve::merge_allowed_root_paths(
        &qoder_default_allowed_root_paths(),
        Some(user_paths),
    )
}

#[async_trait]
impl InputBody for QoderTraceBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "qoder-trace"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QoderCli
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }
    fn before_stop(&self) {
        self.transcript_source.stop();
        self.stopped.store(true, Ordering::SeqCst);
        self.stop_notify.notify_waiters();
    }

    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        self.transcript_source.stop();
        self.legacy_reader.lock().await.reset();
        self.multimodal.clear_cache();
        Ok(())
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        self.transcript_source.start();
        self.legacy_reader.lock().await.reset();
        self.stopped.store(false, Ordering::SeqCst);
        ensure_dir(&self.log_dir).await;
        let state = rt.state();
        if let Some(checkpoint) =
            create_hook_history_startup_checkpoint(&state, &self.log_dir, "qoder").await?
        {
            rt.set_state_fields(
                Some(checkpoint.last_file),
                Some(checkpoint.last_offset),
                Some(checkpoint.extra),
            );
            if checkpoint.skipped_existing_bytes > 0 {
                rt.warn(
                    "history checkpoint missing, baselining existing file without replay",
                    serde_json::json!({ "skippedBytes": checkpoint.skipped_existing_bytes })
                        .as_object(),
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
        let persisted = rt
            .state_store
            .is_persisted(&rt.id, Some("qoderTranscripts"));
        let mut raw =
            read_hook_jsonl(&self.log_dir, rt, &mut *self.legacy_reader.lock().await).await?;
        let extra = rt.state().extra();
        let native = self
            .transcript_source
            .read_shared(
                extra.as_ref().and_then(|e| e.get("qoderTranscripts")),
                persisted,
            )
            .await?;
        for observation in &native.metrics.reads {
            rt.with_accumulator(|a| {
                a.observe_read(
                    observation.bytes,
                    observation.requested,
                    observation.duration_ms,
                )
            });
        }
        for record in &native.records {
            if let Some(record) = record.as_object() {
                if let Some(entry) = transform_record(record).await {
                    raw.push(entry)
                }
            }
        }
        if raw.is_empty() {
            if !self.stopped.load(Ordering::SeqCst) {
                save_native_state(rt, &native);
            }
            return Ok(Vec::new());
        }
        let groups = group_by_turn(&raw);
        let mut intercept = None;
        let mut ide_sessions: IndexMap<String, Vec<usize>> = IndexMap::new();
        let mut cli_fallback: HashMap<String, Vec<Vec<usize>>> = HashMap::new();
        for indexes in groups.values() {
            let variant = infer_variant(&raw, indexes);
            let session = extract_session(&raw, indexes);
            if variant == "qoder-cli" {
                if let Some(session) = session {
                    if intercept.is_none() {
                        let mut response_ids = raw
                            .iter()
                            .filter(|entry| {
                                entry.event_name == Some(crate::types::AgentEventName::LlmResponse)
                            })
                            .filter_map(|entry| entry.response_id.clone())
                            .collect::<Vec<_>>();
                        response_ids.sort_unstable();
                        response_ids.dedup();
                        intercept = Some(self.readers.read_cli_intercept_for(&response_ids).await);
                    }
                    let data = intercept.as_ref().unwrap();
                    // Every index belongs to exactly one turn group. No await,
                    // fallible operation, or return occurs until ownership is
                    // restored to raw below; other tasks cannot observe it.
                    let mut slice: Vec<AgentActivityEntry> = indexes
                        .iter()
                        .map(|index| std::mem::take(&mut raw[*index]))
                        .collect();
                    enrich_cli_primary(
                        &mut slice,
                        data.system_prompt
                            .as_ref()
                            .map(|prompt| prompt.content.as_str()),
                        &data.tokens,
                    );
                    let needs_fallback = needs_cli_segment_fallback(&slice);
                    for (index, entry) in indexes.iter().zip(slice) {
                        raw[*index] = entry;
                    }
                    if needs_fallback {
                        cli_fallback
                            .entry(session)
                            .or_default()
                            .push(indexes.clone());
                    }
                }
            } else if variant == "qoder" || variant == "qoder-idea" {
                if let Some(session) = session {
                    ide_sessions
                        .entry(session)
                        .or_default()
                        .extend(indexes.iter().copied());
                }
            }
        }
        for (session, turns) in &cli_fallback {
            let expected = turns
                .iter()
                .flat_map(|indexes| {
                    let slice: Vec<AgentActivityEntry> =
                        indexes.iter().map(|index| raw[*index].clone()).collect();
                    collect_cli_expected_request_ids(&slice)
                })
                .collect::<Vec<_>>();
            let segments = self.readers.read_cli_segments(session, &expected).await;
            for indexes in turns {
                let mut slice: Vec<AgentActivityEntry> =
                    indexes.iter().map(|index| raw[*index].clone()).collect();
                enrich_cli_from_segments(&mut slice, &segments);
                for (pos, index) in indexes.iter().enumerate() {
                    raw[*index] = slice[pos].clone();
                }
            }
        }
        // Read every session's initial snapshot before spending the one shared
        // delay. A lagging session must not serialize waits for the rest.
        let mut ide_batches = Vec::with_capacity(ide_sessions.len());
        for (session, indexes) in &ide_sessions {
            let result = self.readers.read_ide_tokens(session).await;
            let mut probe: Vec<AgentActivityEntry> =
                indexes.iter().map(|index| raw[*index].clone()).collect();
            enrich_ide_turn(&mut probe, &result.rows);
            let retry = needs_ide_retry(&probe);
            ide_batches.push((session, indexes, result, probe, retry));
        }
        if ide_batches.iter().any(|(_, _, _, _, retry)| *retry)
            && !self.stopped.load(Ordering::SeqCst)
        {
            let stopped = self.stop_notify.notified();
            tokio::pin!(stopped);
            stopped.as_mut().enable();
            if !self.stopped.load(Ordering::SeqCst) {
                tokio::select! {
                    _ = &mut stopped => {},
                    _ = tokio::time::sleep(std::time::Duration::from_millis(1_000)) => {},
                }
            }
        }
        for (session, indexes, mut result, mut probe, retry_needed) in ide_batches {
            if retry_needed && !self.stopped.load(Ordering::SeqCst) {
                let retry = self.readers.read_ide_tokens(session).await;
                if retry.rows.len() >= result.rows.len() {
                    result = retry;
                    probe = indexes.iter().map(|index| raw[*index].clone()).collect();
                    enrich_ide_turn(&mut probe, &result.rows);
                }
            }
            let relabel = indexes
                .iter()
                .all(|index| raw[*index].agent_type == ClientType::Qoder.as_str())
                && is_idea_db_path(result.matched_db_path.as_deref());
            for (pos, index) in indexes.iter().enumerate() {
                raw[*index] = probe[pos].clone();
                if relabel {
                    raw[*index].agent_type = ClientType::QoderIdea.as_str().to_owned();
                }
            }
        }
        rt.with_workspace_policy(|policy| policy.preflight_entries(&raw, ClientType::QoderCli));
        let callback = self
            .path_to_uri
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if self.multimodal_enabled && self.upload_mode != MultimodalUploadMode::None {
            if let Some(callback) = callback {
                let mut synthetic = Vec::new();
                for indexes in ide_sessions.values() {
                    if self.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    let permitted = rt.with_workspace_policy(|policy| {
                        indexes
                            .iter()
                            .all(|index| policy.allows_entry(&raw[*index], ClientType::QoderCli))
                    });
                    if !permitted
                        || indexes
                            .iter()
                            .any(|index| raw[*index].agent_type == "qoder-idea")
                    {
                        continue;
                    }
                    let mut entries = indexes
                        .iter()
                        .map(|index| raw[*index].clone())
                        .collect::<Vec<_>>();
                    self.multimodal
                        .enrich_ide(&mut entries, self.upload_mode, &callback)
                        .await;
                    for (position, index) in indexes.iter().enumerate() {
                        raw[*index] = entries[position].clone();
                    }
                    synthetic.extend(entries.into_iter().skip(indexes.len()));
                }
                // Keep original indexes valid until both enrichment passes finish.
                for indexes in groups.values() {
                    if self.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    if infer_variant(&raw, indexes) != "qoder-cli" {
                        continue;
                    }
                    let permitted = rt.with_workspace_policy(|policy| {
                        indexes
                            .iter()
                            .all(|index| policy.allows_entry(&raw[*index], ClientType::QoderCli))
                    });
                    if !permitted {
                        continue;
                    }
                    let mut entries = indexes
                        .iter()
                        .map(|index| raw[*index].clone())
                        .collect::<Vec<_>>();
                    self.multimodal
                        .enrich_cli(&mut entries, self.upload_mode, &callback)
                        .await;
                    for (position, index) in indexes.iter().enumerate() {
                        raw[*index] = entries[position].clone();
                    }
                }
                for entry in synthetic {
                    let at = raw
                        .iter()
                        .position(|candidate| {
                            candidate.event_name == Some(crate::types::AgentEventName::LlmResponse)
                                && candidate.turn_id == entry.turn_id
                                && candidate.request_id == entry.request_id
                        })
                        .unwrap_or(raw.len());
                    raw.insert(at, entry);
                }
            }
        }
        for entry in &mut raw {
            entry.extra.remove("agent.qoder.attachments");
        }
        for indexes in group_by_turn(&raw).values() {
            // Match inject_trace_id: one UUID per existing turn group, with
            // only the small trace string cloned for each member.
            let trace_id = indexes
                .iter()
                .find_map(|&index| {
                    let entry = &raw[index];
                    (entry.get("agent.qoder.trace_context_locked") == Some(&Value::Bool(true)))
                        .then(|| entry.trace_id.clone())
                        .flatten()
                })
                .unwrap_or_else(|| hex::encode(uuid::Uuid::new_v4().as_bytes()));
            for &index in indexes {
                raw[index].trace_id = Some(trace_id.clone());
            }
        }
        if !self.stopped.load(Ordering::SeqCst) {
            save_native_state(rt, &native);
        }
        Ok(raw)
    }
}
fn qoder_data_dir_from_state(store: &crate::checkpoints::StateStore) -> PathBuf {
    let parent = store.file_path().parent().unwrap_or(Path::new("."));
    if parent.file_name().is_some_and(|name| name == "logs") {
        parent.parent().unwrap_or(parent).to_owned()
    } else {
        parent.to_owned()
    }
}
fn save_native_state(rt: &InputRuntime, native: &TranscriptBatch) {
    if !native.changed {
        return;
    }
    let mut extra = match rt.state().extra() {
        Some(Value::Object(extra)) => extra,
        _ => Default::default(),
    };
    extra.insert("qoderTranscripts".into(), native.state.clone());
    rt.set_state_fields(None, None, Some(Value::Object(extra)));
}

fn needs_ide_retry(entries: &[AgentActivityEntry]) -> bool {
    entries.iter().any(|entry| {
        if !entry
            .event_name
            .map(|name| name.as_str() == "llm.response")
            .unwrap_or(false)
        {
            return false;
        }
        let positive =
            entry.input_tokens.is_some_and(|n| n > 0) || entry.output_tokens.is_some_and(|n| n > 0);
        entry.response_id.as_ref().is_none_or(|id| id.is_empty()) || !positive
    })
}

async fn read_hook_jsonl(
    log_dir: &str,
    rt: &InputRuntime,
    reader: &mut QoderLegacyHookReader,
) -> anyhow::Result<Vec<AgentActivityEntry>> {
    let today = get_today_date_string();
    let name = format!("qoder-{today}.jsonl");
    let path = Path::new(log_dir).join(&name);
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return Ok(Vec::new());
    };
    let state = rt.state();
    let mut offset = if state.last_file() == Some(name.as_str()) {
        state.last_offset().unwrap_or(0.0)
    } else {
        0.0
    };
    if offset > 0.0 && (meta.len() as f64) < offset {
        rt.info(
            "file truncated, resetting offset",
            serde_json::json!({ "file": path, "recorded": offset, "actual": meta.len() })
                .as_object(),
        );
        offset = 0.0;
    }
    if (meta.len() as f64) <= offset {
        return Ok(Vec::new());
    }
    rt.with_accumulator(|acc| acc.observe_backlog(meta.len().saturating_sub(offset as u64)));
    let read = reader
        .read_observed(&path, offset as u64, |bytes, requested, duration| {
            rt.with_accumulator(|a| a.observe_read(bytes, requested, duration))
        })
        .await?;
    let committed = read.next_offset.saturating_sub(offset as u64);
    if !read.quarantine.is_empty() {
        let mut extra = rt
            .state()
            .extra()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let mut previous = extra
            .get("qoderLegacyQuarantine")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for range in &read.quarantine {
            let mut value = serde_json::to_value(range)?;
            value["file"] = serde_json::json!(name);
            previous.push(value);
            rt.warn("oversized legacy Hook record quarantined; source retained",serde_json::json!({"file":path,"from":range.from,"to":range.to,"bytes":range.bytes,"reason":range.reason}).as_object());
        }
        if previous.len() > 32 {
            previous.drain(..previous.len() - 32);
        }
        extra.insert("qoderLegacyQuarantine".into(), Value::Array(previous));
        rt.set_state_fields(None, None, Some(Value::Object(extra)));
    }
    if committed > 0 {
        rt.set_state_fields(Some(name), Some(read.next_offset as f64), None);
    }
    let skipped = read
        .quarantine
        .iter()
        .filter(|r| r.to.is_some())
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut batch = crate::inputs::base::CommittedInputBatch {
        bytes: committed,
        records: skipped.len() as u64,
        parse_success_records: 0,
        parse_failed_records: skipped.len() as u64,
        max_record_bytes: skipped.iter().map(|r| r.bytes).max().unwrap_or(0),
    };
    // Count source bytes before lossy decoding; UTF-8 and half lines must not
    // turn a physical read into committed records or inflate a record's size.
    for bytes in read.buffer.split_inclusive(|byte| *byte == b'\n') {
        let line = String::from_utf8_lossy(bytes);
        if line.trim().is_empty() {
            continue;
        }
        batch.records += 1;
        batch.max_record_bytes = batch.max_record_bytes.max(bytes.len() as u64);
        let record = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Object(record)) => {
                batch.parse_success_records += 1;
                record
            }
            _ => {
                batch.parse_failed_records += 1;
                rt.warn("invalid JSONL line", None);
                continue;
            }
        };
        if let Some(entry) = transform_record(&record).await {
            entries.push(entry);
        }
    }
    rt.with_accumulator(|acc| acc.observe_committed_batch(batch));
    Ok(filter_bootstrap_history_turns(entries))
}

async fn transform_record(record: &Map<String, Value>) -> Option<AgentActivityEntry> {
    let mut entry = build_canonical_hook_entry(
        record,
        ClientType::QoderCli.as_str(),
        None,
        CanonicalHookRecordOptions {
            preserve_safe_custom_top_level_fields: true,
        },
    )?;
    let _ = enrich_canonical_entry_with_git(&mut entry, record, "qoder").await;
    Some(entry)
}

fn group_by_turn(entries: &[AgentActivityEntry]) -> IndexMap<String, Vec<usize>> {
    // Source JS Map order determines per-session expected IDs and IDE turn joins.
    let mut groups = IndexMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let turn = entry
            .turn_id
            .clone()
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| "unknown".into());
        groups.entry(turn).or_insert_with(Vec::new).push(index);
    }
    groups
}

fn infer_variant(entries: &[AgentActivityEntry], indexes: &[usize]) -> &'static str {
    for index in indexes {
        match entries[*index].agent_type.as_str() {
            "qoder-cli" => return "qoder-cli",
            "qoder-idea" => return "qoder-idea",
            "qoder" => return "qoder",
            _ => {}
        }
    }
    "qoder-cli"
}

fn extract_session(entries: &[AgentActivityEntry], indexes: &[usize]) -> Option<String> {
    indexes
        .iter()
        .map(|index| entries[*index].session_id.clone())
        .find(|id| !id.is_empty())
}

#[cfg(test)]
mod native_cache_binding_tests {
    use super::*;
    use crate::types::AgentEventName;
    use std::io::Write;

    const CASE: &str = "inputs::qoder_trace::qoder_trace_input::native_cache_binding_tests::native_reader_cache_roundtrips_real_sidecar_fields";
    const CHILD: &str = "PILOT_NATIVE_CACHE_BINDING_CHILD";

    #[tokio::test]
    async fn native_reader_cache_roundtrips_real_sidecar_fields() {
        // Native uses the actual HOME sidecar. Isolate HOME in a child process;
        // never mutate process-global environment in the parallel test harness.
        if std::env::var_os(CHILD).is_none() {
            let root = tempfile::tempdir().unwrap();
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", CASE, "--nocapture"])
                .env_clear()
                .env(CHILD, "1")
                .env("HOME", root.path())
                .env("USERPROFILE", root.path())
                .env("APPDATA", root.path().join("appdata"))
                .env("LOCALAPPDATA", root.path().join("localappdata"))
                .env("PATH", root.path().join("no-runtimes"))
                .current_dir(root.path());
            for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
            let out = crate::utils::candidate_process::output(
                &mut command,
                std::time::Duration::from_secs(30),
                1024 * 1024,
            )
            .await
            .unwrap();
            assert!(
                out.status.success(),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            return;
        }
        let path = PathBuf::from(super::super::get_intercept_file("qodercli-intercept.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let ts = chrono::Utc::now().timestamp_millis();
        let row = |id: &str, input: i64, output: i64| serde_json::json!({"type":"token","ts":ts,"id":id,"prompt_tokens":input,"completion_tokens":output,"cached_tokens":3,"reasoning_tokens":2,"total_tokens":input+output});
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                serde_json::json!({"type":"system_prompt","ts":ts,"content":"native prompt"}),
                row("selected", 35, 11),
                row("unrelated", 999, 999)
            ),
        )
        .unwrap();
        let readers: Arc<dyn QoderTraceReaders> = Arc::new(NativeQoderTraceReaders::default());
        let ids = vec!["selected".to_owned()];
        let first = readers.read_cli_intercept_for(&ids).await;
        assert_eq!(
            first.tokens.len(),
            1,
            "the default unfiltered trait method would return both IDs"
        );
        assert_eq!(first.tokens[0].id, "selected");
        assert_eq!(
            (
                first.tokens[0].prompt_tokens,
                first.tokens[0].completion_tokens,
                first.tokens[0].cached_tokens,
                first.tokens[0].reasoning_tokens,
                first.tokens[0].total_tokens
            ),
            (35, 11, 3, 2, 46)
        );
        assert_eq!(
            first.system_prompt.as_ref().unwrap().content,
            "native prompt"
        );
        let mut entries = vec![
            AgentActivityEntry {
                event_name: Some(AgentEventName::LlmRequest),
                step_id: Some("step".into()),
                ..Default::default()
            },
            AgentActivityEntry {
                event_name: Some(AgentEventName::LlmResponse),
                response_id: Some("selected".into()),
                ..Default::default()
            },
        ];
        enrich_cli_primary(
            &mut entries,
            first.system_prompt.as_ref().map(|p| p.content.as_str()),
            &first.tokens,
        );
        assert_eq!(
            (
                entries[1].input_tokens,
                entries[1].output_tokens,
                entries[1].total_tokens,
                entries[1].cache_read_input_tokens
            ),
            (Some(35), Some(11), Some(46), Some(3))
        );
        assert!(entries[0].system_instructions.is_some());
        assert_eq!(
            readers.read_cli_intercept_for(&ids).await,
            first,
            "warm cache preserves fields"
        );
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap(),
            "{}",
            row("selected", 40, 13)
        )
        .unwrap();
        let late = readers.read_cli_intercept_for(&ids).await;
        assert_eq!(
            (
                late.tokens[0].prompt_tokens,
                late.tokens[0].completion_tokens
            ),
            (40, 13),
            "same-ts later physical usage must replace the prior row"
        );
        assert!(readers
            .read_cli_intercept_for(&["not-present".into()])
            .await
            .tokens
            .is_empty());
        assert_eq!(
            readers.read_cli_intercept().await.tokens.len(),
            3,
            "old public reader contract remains unfiltered"
        );
    }
}
