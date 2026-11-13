//! Port of `src/inputs/qwen-work-cn/qwen-work-cn-trace-input.ts`.

use crate::inputs::base::{
    create_hook_history_startup_checkpoint, entry_from, filter_bootstrap_history_turns, InputBody,
    InputRuntime,
};
use crate::inputs::qoder_trace::multimodal::PathToUri;
use crate::multimodal::{MultimodalProcessor, PathToUriOptions};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod, MultimodalUploadMode};
use crate::utils::{
    directory_exists, ensure_dir, get_today_date_string, resolve_home, DEFAULT_POLL_INTERVAL_MS,
};
use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const NANO_PER_MILLI: i64 = 1_000_000;
const SEGMENT_TIMING_TOLERANCE_MS: i64 = 5 * 60 * 1000;
const SEGMENT_STATE_TTL_MS: i64 = 60 * 60 * 1000;
const HOOK_OFFSET_MAP_KEY: &str = "hookLogOffsets";
const MAX_HOOK_READ_BYTES: u64 = 16 * 1024 * 1024;

pub struct QwenWorkCnTraceInput {
    pub inner: std::sync::Arc<crate::inputs::base::HostedInput<QwenWorkCnTraceBody>>,
}

pub struct QwenWorkCnTraceOptions {
    pub state_store: std::sync::Arc<crate::checkpoints::StateStore>,
    pub log_dir: Option<String>,
    pub segments_root: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub multimodal: Option<QwenWorkCnMultimodalOptions>,
}

pub struct QwenWorkCnMultimodalOptions {
    pub enabled: bool,
    pub upload_mode: MultimodalUploadMode,
    pub processor: Option<Arc<MultimodalProcessor>>,
    pub allowed_root_paths: Vec<String>,
}

pub fn qwen_work_cn_default_allowed_root_paths() -> Vec<String> {
    vec![
        resolve_home("~/.qwenworkcn/workspace"),
        resolve_home("~/.qwenworkcn/tmp"),
    ]
}

pub fn resolve_qwen_work_cn_allowed_root_paths(user_paths: &[String]) -> Vec<String> {
    crate::multimodal::resolve::merge_allowed_root_paths(
        &qwen_work_cn_default_allowed_root_paths(),
        Some(user_paths),
    )
}

struct QwenWorkCnMultimodalRuntime {
    upload_mode: MultimodalUploadMode,
    path_to_uri: PathToUri,
}

pub struct QwenWorkCnTraceBody {
    log_dir: String,
    segments_root: String,
    multimodal: Option<QwenWorkCnMultimodalRuntime>,
    multimodal_stopped: Arc<AtomicBool>,
    segment_pairs: Mutex<HashMap<String, Vec<SegmentLlmPair>>>,
    segment_tool_timings: Mutex<HashMap<String, HashMap<String, SegmentToolTiming>>>,
    subagent_turns: Mutex<HashMap<String, HashMap<String, i64>>>,
    in_flight_pairs: Mutex<HashMap<String, HashMap<String, InFlightPair>>>,
    segment_dir_by_session: Mutex<HashMap<String, CachedSegmentDir>>,
}

struct InFlightPair {
    turn_id: String,
    start_nano: String,
    model: String,
    seen_at_ms: i64,
}

struct SegmentLlmPair {
    turn_id: String,
    start_nano: String,
    end_nano: String,
    model: String,
    usage: TokenUsage,
    seen_at_ms: i64,
}

struct TokenUsage {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read: Option<i64>,
    cache_creation: Option<i64>,
}

struct SegmentToolTiming {
    requested_nano: Option<String>,
    finished_nano: Option<String>,
    seen_at_ms: i64,
}

struct CachedSegmentDir {
    path: String,
    seen_at_ms: i64,
}

impl QwenWorkCnTraceInput {
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

    pub fn new(opts: QwenWorkCnTraceOptions) -> Self {
        let log_dir = opts
            .log_dir
            .unwrap_or_else(|| resolve_home("~/.loongsuite-pilot/logs/qwen-work-cn/history"));
        let segments_root = opts
            .segments_root
            .unwrap_or_else(|| resolve_home("~/.qwenworkcn/logs/sessions"));
        let stopped = Arc::new(AtomicBool::new(false));
        let multimodal = opts.multimodal.and_then(|config| {
            if !config.enabled || config.upload_mode == MultimodalUploadMode::None {
                return None;
            }
            let processor = config.processor?;
            let roots = resolve_qwen_work_cn_allowed_root_paths(&config.allowed_root_paths);
            let stopped = Arc::clone(&stopped);
            let callback: PathToUri = Arc::new(move |path, time| {
                let processor = Arc::clone(&processor);
                let roots = roots.clone();
                let stopped = Arc::clone(&stopped);
                Box::pin(async move {
                    if stopped.load(Ordering::SeqCst) {
                        return Ok(None);
                    }
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
            Some(QwenWorkCnMultimodalRuntime {
                upload_mode: config.upload_mode,
                path_to_uri: callback,
            })
        });
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QwenWorkCnTraceBody {
                    log_dir,
                    segments_root,
                    multimodal,
                    multimodal_stopped: stopped,
                    segment_pairs: Mutex::new(HashMap::new()),
                    segment_tool_timings: Mutex::new(HashMap::new()),
                    subagent_turns: Mutex::new(HashMap::new()),
                    in_flight_pairs: Mutex::new(HashMap::new()),
                    segment_dir_by_session: Mutex::new(HashMap::new()),
                },
                "QwenWorkCNTraceInput",
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
        directory_exists(&resolve_home("~/.qwenworkcn")).await
    }

    pub fn get_watch_paths(log_dir: Option<&str>, segments_root: Option<&str>) -> Vec<String> {
        vec![
            log_dir
                .map(str::to_owned)
                .unwrap_or_else(|| resolve_home("~/.loongsuite-pilot/logs/qwen-work-cn/history")),
            segments_root
                .map(str::to_owned)
                .unwrap_or_else(|| resolve_home("~/.qwenworkcn/logs/sessions")),
        ]
    }
}

#[async_trait]
impl InputBody for QwenWorkCnTraceBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "qwen-work-cn-trace"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QwenWorkCN
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }

    fn before_stop(&self) {
        self.multimodal_stopped.store(true, Ordering::SeqCst);
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        self.multimodal_stopped.store(false, Ordering::SeqCst);
        ensure_dir(&self.log_dir).await;
        let current = rt.state();
        let Some(checkpoint) =
            create_hook_history_startup_checkpoint(&current, &self.log_dir, "qwen-work-cn").await?
        else {
            return Ok(());
        };
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
        }
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let result = self.collect_inner(rt).await;
        self.evict_stale_state();
        result
    }
}

impl QwenWorkCnTraceBody {
    async fn collect_inner(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let raw = self.read_hook_jsonl(rt).await?;
        if raw.is_empty() {
            return Ok(Vec::new());
        }
        let entries = filter_bootstrap_history_turns(raw);
        for (session_id, cwd) in collect_session_cwd(&entries) {
            self.read_segments_for_session(rt, &session_id, &cwd).await;
        }
        let mut output = Vec::new();
        for turn in group_by_turn(entries).into_values() {
            let mut turn = turn;
            self.enrich_turn(&mut turn);
            inject_trace_id(&mut turn);
            for entry in &mut turn {
                entry.agent_type = ClientType::QwenWorkCN.as_str().to_owned();
                let record = crate::inputs::base::entry_map(entry);
                let _ = enrich_canonical_entry_with_git(entry, &record, "qwen-work-cn").await;
            }
            if !self.multimodal_stopped.load(Ordering::SeqCst) {
                if let Some(multimodal) = &self.multimodal {
                    super::multimodal::enrich_qwen_work_cn_multimodal(
                        &mut turn,
                        multimodal.upload_mode,
                        &multimodal.path_to_uri,
                    )
                    .await;
                }
            }
            output.extend(turn);
        }
        Ok(output)
    }

    async fn read_hook_jsonl(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let today = get_today_date_string();
        let state = rt.state();
        let file_names = list_hook_files(&self.log_dir).await;
        if file_names.is_empty() {
            return Ok(Vec::new());
        }
        let persisted = hook_offset_map(
            state
                .extra()
                .as_ref()
                .and_then(|extra| extra.get(HOOK_OFFSET_MAP_KEY)),
        );
        let mut offsets = if let Some(persisted) = persisted.clone() {
            persisted
        } else {
            seed_hook_offsets(
                &self.log_dir,
                &file_names,
                state.last_file(),
                state.last_offset(),
                &today,
            )
            .await
        };
        let candidates = &file_names;
        let mut remaining = crate::utils::raw_source::CYCLE_BYTES;
        let mut identities = state
            .extra()
            .and_then(|extra| extra["hookLogIdentities"].as_object().cloned())
            .unwrap_or_default();
        let mut entries = Vec::new();
        for file_name in candidates {
            if remaining == 0 {
                break;
            }
            let result = read_hook_file(
                &self.log_dir,
                file_name,
                offsets.get(file_name).copied().unwrap_or(0.0),
                identities.get(file_name).and_then(Value::as_str),
                remaining,
                rt,
            )
            .await?;
            offsets.insert(file_name.clone(), result.0);
            entries.extend(result.1);
            if let Some(identity) = result.2 {
                identities.insert(file_name.clone(), identity.into());
            }
            remaining = remaining.saturating_sub(result.3);
        }
        let live: std::collections::BTreeSet<&str> =
            file_names.iter().map(String::as_str).collect();
        offsets.retain(|name, _| live.contains(name.as_str()));
        identities.retain(|name, _| live.contains(name.as_str()));
        let checkpoint_file = candidates
            .last()
            .cloned()
            .or_else(|| file_names.last().cloned());
        if let Some(checkpoint_file) = checkpoint_file {
            let offset = offsets.get(&checkpoint_file).copied().unwrap_or(0.0);
            let changed = persisted.is_none()
                || state.last_file() != Some(checkpoint_file.as_str())
                || state.last_offset() != Some(offset)
                || persisted
                    .as_ref()
                    .is_some_and(|previous| !same_offsets(previous, &offsets))
                || state
                    .extra()
                    .as_ref()
                    .and_then(|extra| extra["hookLogIdentities"].as_object())
                    != Some(&identities);
            if changed {
                let mut extra = match state.extra() {
                    Some(Value::Object(map)) => map,
                    _ => Map::new(),
                };
                extra.insert(HOOK_OFFSET_MAP_KEY.into(), json!(offsets));
                extra.insert("hookLogDir".into(), self.log_dir.clone().into());
                extra.insert("hookLogPrefix".into(), "qwen-work-cn".into());
                extra.insert("hookLogIdentities".into(), identities.into());
                rt.set_state_fields(
                    Some(checkpoint_file),
                    Some(offset),
                    Some(Value::Object(extra)),
                );
            }
        }
        Ok(entries)
    }

    async fn read_segments_for_session(&self, rt: &InputRuntime, session_id: &str, cwd: &str) {
        let Some(segment_dir) = self.resolve_segments_dir(session_id, cwd).await else {
            return;
        };
        let mut files = Vec::new();
        let mut dir = match tokio::fs::read_dir(&segment_dir).await {
            Ok(dir) => dir,
            Err(_) => return,
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".jsonl") {
                files.push(
                    Path::new(&segment_dir)
                        .join(name)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        files.sort();
        for file in files {
            self.read_segment_file(rt, session_id, &file).await;
        }
    }

    async fn resolve_segments_dir(&self, session_id: &str, cwd: &str) -> Option<String> {
        if let Some(cached) = self.segment_dir_by_session.lock().ok()?.get_mut(session_id) {
            cached.seen_at_ms = now_ms();
            return Some(cached.path.clone());
        }
        let preferred = Path::new(&self.segments_root)
            .join(encode_workspace(cwd))
            .join(session_id)
            .join("segments");
        if is_dir(&preferred).await {
            let path = preferred.to_string_lossy().into_owned();
            self.segment_dir_by_session.lock().ok()?.insert(
                session_id.to_owned(),
                CachedSegmentDir {
                    path: path.clone(),
                    seen_at_ms: now_ms(),
                },
            );
            return Some(path);
        }
        let mut dir = tokio::fs::read_dir(&self.segments_root).await.ok()?;
        while let Ok(Some(entry)) = dir.next_entry().await {
            if !entry
                .file_type()
                .await
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let candidate = entry.path().join(session_id).join("segments");
            if is_dir(&candidate).await {
                let path = candidate.to_string_lossy().into_owned();
                self.segment_dir_by_session.lock().ok()?.insert(
                    session_id.to_owned(),
                    CachedSegmentDir {
                        path: path.clone(),
                        seen_at_ms: now_ms(),
                    },
                );
                return Some(path);
            }
        }
        None
    }

    async fn read_segment_file(&self, rt: &InputRuntime, session_id: &str, file_path: &str) {
        let Some((file, identity)) = open_segment_file(file_path).await else {
            return;
        };
        self.read_opened_segment(rt, session_id, file_path, file, identity)
            .await;
    }

    async fn read_opened_segment(
        &self,
        rt: &InputRuntime,
        session_id: &str,
        file_path: &str,
        mut file: tokio::fs::File,
        identity: crate::utils::file_identity::OpenedFileIdentity,
    ) {
        let state_key = format!("{}:segment:{file_path}", rt.id);
        let inode = identity.ino;
        let previous = rt.state_store.get(&state_key);
        let previous_inode = previous
            .extra()
            .and_then(|extra| extra.get("inode").and_then(Value::as_u64));
        let previous_dev = previous
            .extra()
            .and_then(|extra| extra.get("dev").and_then(Value::as_u64));
        if (previous_inode.is_some() && previous_inode != Some(inode))
            || (previous_dev.is_some() && previous_dev != Some(identity.dev))
        {
            rt.state_store.set_offset(&state_key, 0.0);
        }
        let mut offset = rt.state_store.get_offset(&state_key);
        if offset > 0.0 && (identity.size as f64) < offset {
            offset = 0.0;
            rt.state_store.set_offset(&state_key, 0.0);
        }
        if (identity.size as f64) <= offset {
            rt.state_store.update(
                &state_key,
                crate::checkpoints::InputStatePatch {
                    extra: Some(json!({ "inode": inode, "dev": identity.dev })),
                    ..crate::checkpoints::InputStatePatch::default()
                },
            );
            return;
        }
        let read_size = (identity.size - offset as u64).min(MAX_HOOK_READ_BYTES) as usize;
        if file
            .seek(std::io::SeekFrom::Start(offset as u64))
            .await
            .is_err()
        {
            return;
        }
        let mut bytes = vec![0; read_size];
        let mut filled = 0;
        while filled < bytes.len() {
            match file.read(&mut bytes[filled..]).await {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(_) => return,
            }
        }
        bytes.truncate(filled);
        let Some(newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
            rt.state_store.update(
                &state_key,
                crate::checkpoints::InputStatePatch {
                    extra: Some(json!({ "inode": inode, "dev": identity.dev })),
                    ..crate::checkpoints::InputStatePatch::default()
                },
            );
            return;
        };
        let text = String::from_utf8_lossy(&bytes[..newline]);
        rt.state_store
            .set_offset(&state_key, offset + newline as f64 + 1.0);
        rt.state_store.update(
            &state_key,
            crate::checkpoints::InputStatePatch {
                extra: Some(json!({ "inode": inode, "dev": identity.dev })),
                ..crate::checkpoints::InputStatePatch::default()
            },
        );
        for line in text.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(event) => self.handle_segment_event(session_id, &event),
                Err(_) => rt.warn("invalid QwenWorkCN segment JSONL line", None),
            }
        }
    }

    fn handle_segment_event(&self, session_id: &str, event: &Value) {
        let seen = now_ms();
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let turn_id = event.get("turn_id").and_then(Value::as_str).unwrap_or("");
        let request_id = event
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let ts = event.get("ts").and_then(Value::as_str).unwrap_or("");
        if kind == "turn.started" {
            if !turn_id.is_empty()
                && (event.pointer("/data/is_subagent").and_then(Value::as_bool) == Some(true)
                    || is_ignored_turn(turn_id))
            {
                self.subagent_turns
                    .lock()
                    .unwrap()
                    .entry(session_id.to_owned())
                    .or_default()
                    .insert(turn_id.to_owned(), seen);
            }
            return;
        }
        if kind == "model.request.started" {
            if turn_id.is_empty()
                || request_id.is_empty()
                || ts.is_empty()
                || self.should_skip_turn(session_id, turn_id)
            {
                return;
            }
            let Some(start_nano) = iso_to_nano(ts) else {
                return;
            };
            self.in_flight_pairs
                .lock()
                .unwrap()
                .entry(session_id.to_owned())
                .or_default()
                .insert(
                    request_id.to_owned(),
                    InFlightPair {
                        turn_id: turn_id.to_owned(),
                        start_nano,
                        model: event
                            .pointer("/data/model")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        seen_at_ms: seen,
                    },
                );
            return;
        }
        if kind == "model.response.completed" {
            if turn_id.is_empty()
                || request_id.is_empty()
                || ts.is_empty()
                || self.should_skip_turn(session_id, turn_id)
            {
                return;
            }
            let Some(end_nano) = iso_to_nano(ts) else {
                return;
            };
            let in_flight = self
                .in_flight_pairs
                .lock()
                .unwrap()
                .get_mut(session_id)
                .and_then(|pairs| pairs.remove(request_id));
            let Some(in_flight) = in_flight else { return };
            self.segment_pairs
                .lock()
                .unwrap()
                .entry(session_id.to_owned())
                .or_default()
                .push(SegmentLlmPair {
                    turn_id: in_flight.turn_id,
                    start_nano: in_flight.start_nano,
                    end_nano,
                    model: event
                        .pointer("/data/model")
                        .and_then(Value::as_str)
                        .filter(|model| !model.is_empty())
                        .unwrap_or(&in_flight.model)
                        .to_owned(),
                    usage: extract_usage(event.get("data")),
                    seen_at_ms: seen,
                });
            return;
        }
        if kind == "tool.requested" || kind == "tool.execution.finished" {
            let call_id = event
                .get("tool_call_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            if turn_id.is_empty()
                || call_id.is_empty()
                || ts.is_empty()
                || self.should_skip_turn(session_id, turn_id)
            {
                return;
            }
            let Some(timestamp) = iso_to_nano(ts) else {
                return;
            };
            let mut timings = self.segment_tool_timings.lock().unwrap();
            let timing = timings
                .entry(session_id.to_owned())
                .or_default()
                .entry(call_id.to_owned())
                .or_insert(SegmentToolTiming {
                    requested_nano: None,
                    finished_nano: None,
                    seen_at_ms: seen,
                });
            timing.seen_at_ms = seen;
            if kind == "tool.requested" {
                timing.requested_nano = Some(timestamp);
            } else {
                timing.finished_nano = Some(timestamp);
            }
        }
    }

    fn should_skip_turn(&self, session_id: &str, turn_id: &str) -> bool {
        is_ignored_turn(turn_id)
            || self
                .subagent_turns
                .lock()
                .unwrap()
                .get(session_id)
                .is_some_and(|turns| turns.contains_key(turn_id))
    }

    fn enrich_turn(&self, entries: &mut [AgentActivityEntry]) {
        let session_id = entries.iter().find_map(|entry| {
            if entry.session_id.is_empty() {
                None
            } else {
                Some(entry.session_id.clone())
            }
        });
        let turn_id = entries.iter().find_map(|entry| entry.turn_id.clone());
        let step_order = step_ids(entries);
        if let Some(session_id) = session_id.as_deref() {
            for step_id in &step_order {
                let request_index = entries.iter().position(|entry| {
                    entry.step_id.as_deref() == Some(step_id.as_str())
                        && crate::inputs::base::is_event(entry, "llm.request")
                });
                let response_index = entries.iter().position(|entry| {
                    entry.step_id.as_deref() == Some(step_id.as_str())
                        && crate::inputs::base::is_event(entry, "llm.response")
                });
                if let (Some(request_index), Some(response_index)) = (request_index, response_index)
                {
                    let request_nano = entries[request_index].time_unix_nano.clone();
                    let response_id = entries[response_index].event_id.clone();
                    let response_nano = entries[response_index].time_unix_nano.clone();
                    let request_snapshot = entries[request_index].clone();
                    let response_snapshot = entries[response_index].clone();
                    if let Some(pair) = self.take_segment_pair(
                        session_id,
                        turn_id.as_deref(),
                        &request_snapshot,
                        &response_snapshot,
                    ) {
                        let model = pair.model.clone();
                        for entry in entries.iter_mut() {
                            if entry.step_id.as_deref() != Some(step_id.as_str()) {
                                continue;
                            }
                            if crate::inputs::base::is_event(entry, "llm.request")
                                && entry.time_unix_nano == request_nano
                            {
                                entry.time_unix_nano = pair.start_nano.clone();
                            }
                            if crate::inputs::base::is_event(entry, "llm.response")
                                && entry.event_id == response_id
                            {
                                entry.time_unix_nano = pair.end_nano.clone();
                                apply_usage(entry, &pair.usage);
                                if !model.is_empty() {
                                    entry.response_model = Some(model.clone());
                                }
                            }
                            if !model.is_empty() && missing_model(entry.request_model.as_deref()) {
                                entry.request_model = Some(model.clone());
                            }
                        }
                        let _ = response_nano;
                    }
                }
                self.apply_tool_timing(session_id, entries);
            }
        }
        for index in 0..step_order.len().saturating_sub(1) {
            let next_start = entries.iter().find(|entry| {
                entry.step_id.as_deref() == Some(step_order[index + 1].as_str())
                    && crate::inputs::base::is_event(entry, "llm.request")
            });
            let Some(next_start) = next_start.map(|entry| entry.time_unix_nano.clone()) else {
                continue;
            };
            let Ok(next_start_nano) = next_start.parse::<i128>() else {
                continue;
            };
            let current_step = step_order[index].clone();
            for entry in entries.iter_mut() {
                if entry.step_id.as_deref() != Some(current_step.as_str())
                    || !crate::inputs::base::is_event(entry, "tool.result")
                {
                    continue;
                }
                if let Ok(timestamp) = entry.time_unix_nano.parse::<i128>() {
                    if timestamp > next_start_nano {
                        entry.time_unix_nano =
                            (next_start_nano - NANO_PER_MILLI as i128).to_string();
                    }
                }
            }
        }
    }

    fn take_segment_pair(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        request: &AgentActivityEntry,
        response: &AgentActivityEntry,
    ) -> Option<SegmentLlmPair> {
        let mut pairs = self.segment_pairs.lock().unwrap();
        let list = pairs.get_mut(session_id)?;
        let mut index = turn_id
            .and_then(|turn_id| list.iter().position(|pair| pair.turn_id == turn_id))
            .unwrap_or(usize::MAX);
        if index == usize::MAX {
            index = list
                .iter()
                .position(|pair| is_compatible_pair(pair, request, response))
                .unwrap_or(usize::MAX);
        }
        if index == usize::MAX {
            return None;
        }
        let pair = list.remove(index);
        if list.is_empty() {
            pairs.remove(session_id);
        }
        Some(pair)
    }

    fn apply_tool_timing(&self, session_id: &str, entries: &mut [AgentActivityEntry]) {
        let timings = self.segment_tool_timings.lock().unwrap();
        let Some(timings) = timings.get(session_id) else {
            return;
        };
        for entry in entries {
            let Some(call_id) = entry.tool_call_id.as_deref() else {
                continue;
            };
            let Some(timing) = timings.get(call_id) else {
                continue;
            };
            if crate::inputs::base::is_event(entry, "tool.call") {
                if let Some(nano) = &timing.requested_nano {
                    entry.time_unix_nano = nano.clone();
                }
            } else if crate::inputs::base::is_event(entry, "tool.result") {
                if let Some(nano) = &timing.finished_nano {
                    entry.time_unix_nano = nano.clone();
                }
            }
        }
    }

    fn evict_stale_state(&self) {
        let cutoff = now_ms() - SEGMENT_STATE_TTL_MS;
        self.segment_pairs.lock().unwrap().retain(|_, pairs| {
            pairs.retain(|pair| pair.seen_at_ms >= cutoff);
            !pairs.is_empty()
        });
        self.segment_tool_timings
            .lock()
            .unwrap()
            .retain(|_, timings| {
                timings.retain(|_, timing| timing.seen_at_ms >= cutoff);
                !timings.is_empty()
            });
        self.subagent_turns.lock().unwrap().retain(|_, turns| {
            turns.retain(|_, seen| *seen >= cutoff);
            !turns.is_empty()
        });
        self.in_flight_pairs.lock().unwrap().retain(|_, pairs| {
            pairs.retain(|_, pair| pair.seen_at_ms >= cutoff);
            !pairs.is_empty()
        });
        self.segment_dir_by_session
            .lock()
            .unwrap()
            .retain(|_, cached| cached.seen_at_ms >= cutoff);
    }
}

fn apply_usage(entry: &mut AgentActivityEntry, usage: &TokenUsage) {
    if let Some(value) = usage.input_tokens {
        entry.input_tokens = Some(value);
    }
    if let Some(value) = usage.output_tokens {
        entry.output_tokens = Some(value);
    }
    if usage.input_tokens.is_some() || usage.output_tokens.is_some() {
        entry.total_tokens =
            Some(usage.input_tokens.unwrap_or(0) + usage.output_tokens.unwrap_or(0));
    }
    if let Some(value) = usage.cache_read {
        entry.cache_read_input_tokens = Some(value);
    }
    if let Some(value) = usage.cache_creation {
        entry.cache_creation_input_tokens = Some(value);
    }
}

fn missing_model(value: Option<&str>) -> bool {
    matches!(value, None | Some("") | Some("auto") | Some("unknown"))
}

fn group_by_turn(entries: Vec<AgentActivityEntry>) -> IndexMap<String, Vec<AgentActivityEntry>> {
    let mut groups = IndexMap::new();
    for entry in entries {
        let turn_id = entry
            .turn_id
            .clone()
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| "unknown".into());
        groups.entry(turn_id).or_insert_with(Vec::new).push(entry);
    }
    groups
}

fn step_ids(entries: &[AgentActivityEntry]) -> Vec<String> {
    let mut ids = Vec::new();
    for entry in entries {
        let Some(step_id) = entry.step_id.clone().filter(|id| !id.is_empty()) else {
            continue;
        };
        if !ids.iter().any(|existing| existing == &step_id) {
            ids.push(step_id);
        }
    }
    ids
}

fn inject_trace_id(entries: &mut [AgentActivityEntry]) {
    let trace_id = hex::encode(uuid::Uuid::new_v4().as_bytes());
    for entry in entries {
        entry.trace_id = Some(trace_id.clone());
    }
}

fn collect_session_cwd(entries: &[AgentActivityEntry]) -> Vec<(String, String)> {
    let mut sessions = Vec::new();
    for entry in entries {
        if entry.session_id.is_empty() {
            continue;
        }
        let Some(cwd) = entry
            .extra
            .get("agent.qwenworkcn.cwd")
            .and_then(Value::as_str)
        else {
            continue;
        };
        if cwd.is_empty() || sessions.iter().any(|(id, _)| id == &entry.session_id) {
            continue;
        }
        sessions.push((entry.session_id.clone(), cwd.to_owned()));
    }
    sessions
}

fn encode_workspace(cwd: &str) -> String {
    cwd.replace(['/', '.'], "-")
}

async fn list_hook_files(log_dir: &str) -> Vec<String> {
    crate::utils::raw_source::daily_files(Path::new(log_dir), "qwen-work-cn")
        .await
        .unwrap_or_default()
}

fn hook_offset_map(raw: Option<&Value>) -> Option<HashMap<String, f64>> {
    let Some(Value::Object(map)) = raw else {
        return None;
    };
    let mut offsets = HashMap::new();
    for (name, offset) in map {
        if let Some(value) = offset.as_f64() {
            if value.is_finite() && value >= 0.0 {
                offsets.insert(name.clone(), value);
            }
        }
    }
    if offsets.is_empty() {
        None
    } else {
        Some(offsets)
    }
}

async fn seed_hook_offsets(
    log_dir: &str,
    file_names: &[String],
    last_file: Option<&str>,
    last_offset: Option<f64>,
    today: &str,
) -> HashMap<String, f64> {
    let mut offsets = HashMap::new();
    for file_name in file_names {
        let size = tokio::fs::metadata(Path::new(log_dir).join(file_name))
            .await
            .map(|meta| meta.len() as f64)
            .unwrap_or(0.0);
        offsets.insert(file_name.clone(), size);
    }
    if let Some(last_file) = last_file {
        if file_names.iter().any(|name| name == last_file) {
            offsets.insert(last_file.to_owned(), last_offset.unwrap_or(0.0));
            for file_name in file_names {
                if file_name.as_str() > last_file {
                    offsets.insert(file_name.clone(), 0.0);
                }
            }
            return offsets;
        }
    }
    let today_file = format!("qwen-work-cn-{today}.jsonl");
    if file_names.iter().any(|name| name == &today_file) {
        offsets.insert(today_file, 0.0);
    }
    offsets
}

fn same_offsets(left: &HashMap<String, f64>, right: &HashMap<String, f64>) -> bool {
    left.len() == right.len()
        && right
            .iter()
            .all(|(name, offset)| left.get(name) == Some(offset))
}

async fn read_hook_file(
    log_dir: &str,
    file_name: &str,
    start_offset: f64,
    previous_identity: Option<&str>,
    budget: u64,
    rt: &InputRuntime,
) -> anyhow::Result<(f64, Vec<AgentActivityEntry>, Option<String>, u64)> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let log_file = Path::new(log_dir).join(file_name);
    let (mut file, id) =
        match crate::inputs::qoder_work_log::open_log_file(&log_file.to_string_lossy()).await {
            Ok(opened) => opened,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((start_offset, Vec::new(), None, 0))
            }
            Err(error) => return Err(error.into()),
        };
    let identity = if cfg!(any(target_os = "macos", windows)) {
        format!("{}:{}:{}", id.dev, id.ino, id.birthtime_ms)
    } else {
        format!("{}:{}", id.dev, id.ino)
    };
    let offset = if previous_identity.is_some_and(|previous| previous != identity)
        || start_offset > id.size as f64
    {
        0
    } else {
        start_offset as u64
    };
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut bytes = Vec::new();
    let requested = id.size.saturating_sub(offset);
    file.take(requested.min(budget).min(MAX_HOOK_READ_BYTES))
        .read_to_end(&mut bytes)
        .await?;
    let physical = bytes.len() as u64;
    let Some(newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return Ok((offset as f64, Vec::new(), Some(identity), physical));
    };
    let text = String::from_utf8_lossy(&bytes[..newline]);
    let mut entries = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(mut record) = serde_json::from_str::<Value>(line) else {
            rt.warn("invalid QwenWorkCN history JSONL line", None);
            continue;
        };
        let Some(object) = record.as_object_mut() else {
            continue;
        };
        object.remove("version");
        if object.get("event.name").is_none() {
            continue;
        }
        let map = std::mem::take(object);
        entries.push(entry_from(map));
    }
    Ok((
        offset as f64 + newline as f64 + 1.0,
        entries,
        Some(identity),
        physical,
    ))
}

fn extract_usage(data: Option<&Value>) -> TokenUsage {
    TokenUsage {
        input_tokens: positive_i64(data.and_then(|data| data.get("input_tokens"))),
        output_tokens: positive_i64(data.and_then(|data| data.get("output_tokens"))),
        cache_read: positive_i64(data.and_then(|data| data.get("cache_read_input_tokens"))),
        cache_creation: positive_i64(data.and_then(|data| data.get("cache_creation_input_tokens"))),
    }
}

fn positive_i64(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|number| *number > 0)
        .or_else(|| {
            value
                .and_then(Value::as_f64)
                .filter(|number| number.is_finite() && *number > 0.0)
                .map(|number| number as i64)
        })
}

fn iso_to_nano(value: &str) -> Option<String> {
    let millis = chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())?;
    Some((millis as i128 * NANO_PER_MILLI as i128).to_string())
}

fn is_compatible_pair(
    pair: &SegmentLlmPair,
    request: &AgentActivityEntry,
    response: &AgentActivityEntry,
) -> bool {
    !request.time_unix_nano.is_empty()
        && !response.time_unix_nano.is_empty()
        && within_tolerance(&pair.start_nano, &request.time_unix_nano)
        && within_tolerance(&pair.end_nano, &response.time_unix_nano)
}

fn within_tolerance(left: &str, right: &str) -> bool {
    let Ok(left) = left.parse::<i128>() else {
        return false;
    };
    let Ok(right) = right.parse::<i128>() else {
        return false;
    };
    (left - right).abs() <= SEGMENT_TIMING_TOLERANCE_MS as i128 * NANO_PER_MILLI as i128
}

fn is_ignored_turn(turn_id: &str) -> bool {
    turn_id.starts_with("qoderwork-memory-sink")
}

async fn is_dir(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
}

async fn open_segment_file(
    path: &str,
) -> Option<(
    tokio::fs::File,
    crate::utils::file_identity::OpenedFileIdentity,
)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path).ok()?;
        let identity = crate::utils::file_identity::identity_from_open(&file).ok()?;
        Some((tokio::fs::File::from_std(file), identity))
    })
    .await
    .ok()?
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "segment_identity_tests.rs"]
mod segment_identity_tests;

#[cfg(test)]
#[path = "trace_migration_contract_tests.rs"]
mod qwen_history_migration_contract_tests;
