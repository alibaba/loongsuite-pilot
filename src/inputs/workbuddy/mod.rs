//! WorkBuddy transcript collector.
//!
//! Port of `workbuddy-input.ts`. Hook files under `state/workbuddy/hook-events`
//! wake collection; the hosted input's poll is the fallback when `fs.watch`
//! cannot be created. The TypeScript class extends `BaseInput`, whose built-in
//! interval is [`crate::utils::DEFAULT_POLL_INTERVAL_MS`] (10s). A separate 5s
//! timer retries a Stop boundary that is not yet stable.
//!
//! Events are emitted only after the same file snapshot has been observed on
//! two collects with the same Stop time. The first collect baselines an
//! existing transcript at EOF.

mod event_builder;
mod types;
mod watch;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::checkpoints::StateStore;
use crate::inputs::base::{HostedInput, InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{directory_exists, resolve_home};

pub use event_builder::build_work_buddy_events;
pub use types::{WorkBuddyBuildOptions, WorkBuddyHookEvent, WorkBuddyRecord};

const OFFSET_MAP_KEY: &str = "workbuddyTranscriptBytes";
const FILE_META_MAP_KEY: &str = "workbuddyTranscriptFiles";
const INITIALIZED_KEY: &str = "workbuddyInitialized";
const STABILITY_RETRY_MS: u64 = 5_000;
const HOOK_ORPHAN_GRACE_MS: f64 = 60.0 * 60.0 * 1_000.0;
const HOOK_EVENT_NAMES: &[&str] = &["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

/// Construction options. `hook_event_dir` defaults to
/// `~/.loongsuite-pilot/state/workbuddy/hook-events`. The orchestrator passes
/// `dataDir/state/workbuddy/hook-events` instead.
pub struct WorkBuddyInputOptions {
    pub state_store: Arc<StateStore>,
    pub poll_interval_ms: Option<u64>,
    pub work_buddy_root: Option<String>,
    pub hook_event_dir: Option<String>,
}

pub struct WorkBuddyInput {
    pub inner: Arc<HostedInput<WorkBuddyBody>>,
}

pub struct WorkBuddyBody {
    root: String,
    projects_dir: String,
    hook_event_dir: String,
    wake: Arc<CollectorWake>,
    watches: Mutex<Vec<watch::DirWatch>>,
    retry_pending: Arc<AtomicBool>,
    retry_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

struct CollectorWake {
    hosted: Mutex<Weak<HostedInput<WorkBuddyBody>>>,
    handle: Mutex<Option<tokio::runtime::Handle>>,
}

impl CollectorWake {
    fn new() -> Self {
        Self {
            hosted: Mutex::new(Weak::new()),
            handle: Mutex::new(None),
        }
    }

    fn bind(&self, hosted: &Arc<HostedInput<WorkBuddyBody>>) {
        *self.hosted.lock().unwrap_or_else(|err| err.into_inner()) = Arc::downgrade(hosted);
        self.capture_handle();
    }

    fn capture_handle(&self) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            *self.handle.lock().unwrap_or_else(|err| err.into_inner()) = Some(handle);
        }
    }

    fn is_running(&self) -> bool {
        self.upgrade()
            .is_some_and(|hosted| hosted.runtime.is_running())
    }

    fn upgrade(&self) -> Option<Arc<HostedInput<WorkBuddyBody>>> {
        self.hosted
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .upgrade()
    }

    fn request(&self) {
        let Some(hosted) = self.upgrade() else {
            return;
        };
        if !hosted.runtime.is_running() {
            return;
        }
        let handle = self
            .handle
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        if let Some(handle) = handle {
            handle.spawn(async move {
                hosted.request_collection();
            });
        }
    }
}

#[derive(Clone)]
struct TranscriptFileMeta {
    size: f64,
    mtime_ms: f64,
    identity: Option<String>,
    observed_stop_at_ms: f64,
    handled_stop_at_ms: f64,
}

#[derive(Clone)]
struct HookTranscriptHint {
    transcript_path: String,
    event_file: String,
    session_dir: String,
    event_name: Option<String>,
    observed_at_ms: Option<f64>,
    session_id: Option<String>,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
}

impl WorkBuddyInput {
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

    pub fn new(opts: WorkBuddyInputOptions) -> Self {
        let root = opts.work_buddy_root.unwrap_or_else(default_root);
        let projects_dir = Path::new(&root)
            .join("projects")
            .to_string_lossy()
            .into_owned();
        let hook_event_dir = opts.hook_event_dir.unwrap_or_else(default_hook_event_dir);
        let wake = Arc::new(CollectorWake::new());
        let body = WorkBuddyBody {
            root,
            projects_dir,
            hook_event_dir,
            wake: Arc::clone(&wake),
            watches: Mutex::new(Vec::new()),
            retry_pending: Arc::new(AtomicBool::new(false)),
            retry_task: Mutex::new(None),
        };
        let inner = HostedInput::new(
            body,
            "WorkBuddyInput",
            opts.state_store,
            opts.poll_interval_ms,
        );
        wake.bind(&inner);
        Self { inner }
    }

    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }

    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
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

    pub fn collection_method(&self) -> CollectionMethod {
        self.inner.collection_method()
    }

    pub fn running(&self) -> bool {
        self.inner.running()
    }

    /// Direct `collect()`, without the poll cycle or an automatic state save.
    pub async fn collect_now(&self) -> Result<Vec<AgentActivityEntry>, String> {
        self.inner
            .body
            .collect(&self.inner.runtime)
            .await
            .map_err(|err| err.to_string())
    }

    /// `WorkBuddyInput.getWatchPaths`. `None` uses `~/.workbuddy`.
    pub fn watch_paths(root: Option<&str>) -> Vec<String> {
        let root = root.map(str::to_string).unwrap_or_else(default_root);
        let projects = Path::new(&root)
            .join("projects")
            .to_string_lossy()
            .into_owned();
        vec![root, projects]
    }

    pub fn get_watch_paths(root: Option<&str>) -> Vec<String> {
        Self::watch_paths(root)
    }

    /// `WorkBuddyInput.checkAvailability`. `None` uses `~/.workbuddy`.
    pub async fn check_availability(root: Option<&str>) -> bool {
        let root = root.map(str::to_string).unwrap_or_else(default_root);
        directory_exists(&root).await
    }
}

pub fn default_root() -> String {
    resolve_home("~/.workbuddy")
}

pub fn default_hook_event_dir() -> String {
    resolve_home("~/.loongsuite-pilot/state/workbuddy/hook-events")
}

#[async_trait]
impl InputBody for WorkBuddyBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "workbuddy"
    }

    fn agent_type(&self) -> ClientType {
        ClientType::WorkBuddy
    }

    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }

    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        tokio::fs::create_dir_all(&self.hook_event_dir).await?;
        self.wake.capture_handle();
        let mut watches = Vec::new();
        if let Some(watch) = watch::DirWatch::start(&self.projects_dir, Arc::clone(&self.wake)) {
            watches.push(watch);
        }
        if let Some(watch) = watch::DirWatch::start(&self.hook_event_dir, Arc::clone(&self.wake)) {
            watches.push(watch);
        }
        *self.watches.lock().unwrap_or_else(|err| err.into_inner()) = watches;
        Ok(())
    }

    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        let watches =
            std::mem::take(&mut *self.watches.lock().unwrap_or_else(|err| err.into_inner()));
        for mut watch in watches {
            watch.close();
        }
        self.cancel_retry();
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let state = rt.state();
        let extra = state.extra();
        let extra_obj = extra.as_ref().and_then(Value::as_object);
        let initialized = extra_obj
            .and_then(|map| map.get(INITIALIZED_KEY))
            .and_then(Value::as_bool)
            == Some(true);
        let offsets = normalize_offset_map(extra_obj.and_then(|map| map.get(OFFSET_MAP_KEY)));
        let file_meta =
            normalize_file_meta_map(extra_obj.and_then(|map| map.get(FILE_META_MAP_KEY)));
        let mut next_offsets = offsets.clone();
        let mut next_meta = file_meta.clone();

        let (scan_files, scan_complete) = self.scan_transcript_files().await;
        let mut hints = self.read_hook_transcript_hints().await;
        hints = self.remove_committed_hook_events(hints, &file_meta).await;
        hints = self
            .remove_deleted_transcript_sessions(hints, scan_complete, &next_meta)
            .await;
        self.remove_deleted_transcript_checkpoints(
            scan_complete,
            &mut next_offsets,
            &mut next_meta,
        )
        .await;

        let mut candidates: Vec<String> = hints
            .iter()
            .map(|hint| hint.transcript_path.clone())
            .collect();
        candidates.extend(scan_files);
        let transcript_paths = self.resolve_transcript_paths(&candidates).await;
        let stop_hints = self.resolve_stop_hints(&hints).await;
        let mut entries = Vec::new();

        for transcript_path in transcript_paths {
            let Some(mut opened) = open_transcript_snapshot(&transcript_path).await else {
                continue;
            };
            let size = opened.size;
            let size_f64 = size as f64;
            let mtime = opened.mtime_ms;
            let identity = opened.identity;
            let prior = file_meta.get(&transcript_path);
            let same_snapshot = prior.is_some_and(|item| {
                item.size == size_f64
                    && item.mtime_ms == mtime
                    && item.identity.as_deref() == Some(identity.as_str())
            });
            let latest_stop = stop_hints.get(&transcript_path).copied().unwrap_or(0.0);
            let prior_handled = prior.map(|item| item.handled_stop_at_ms).unwrap_or(0.0);
            let unhandled_stop = latest_stop > prior_handled;
            let stable_stop = same_snapshot
                && unhandled_stop
                && prior.map(|item| item.observed_stop_at_ms) == Some(latest_stop);
            let replaced = prior.is_some_and(|item| {
                item.identity.as_deref() != Some(identity.as_str()) || size_f64 < item.size
            });
            let mut committed = if replaced {
                Some(0)
            } else {
                offsets.get(&transcript_path).copied()
            };
            if !initialized && committed.is_none() {
                committed = Some(size);
            }
            let mut committed = committed.unwrap_or(0);
            if committed > size {
                committed = 0;
            }
            next_offsets.insert(transcript_path.clone(), committed);
            let mut handled = prior_handled;
            if stable_stop {
                match read_jsonl_range(&mut opened.file, committed, size).await {
                    Some((records, next_offset)) if next_offset == size => {
                        let session_id = basename_without_ext(&transcript_path, ".jsonl");
                        let hook_events = self
                            .resolve_hook_events(
                                &hints,
                                &transcript_path,
                                &session_id,
                                prior_handled,
                                latest_stop,
                            )
                            .await;
                        let built = build_work_buddy_events(
                            &records,
                            &WorkBuddyBuildOptions {
                                session_id,
                                hook_events,
                            },
                        )
                        .await
                        .map_err(anyhow::Error::msg)?;
                        entries.extend(built);
                        next_offsets.insert(transcript_path.clone(), next_offset);
                        handled = latest_stop;
                    }
                    _ => self.schedule_stability_retry(),
                }
            } else if latest_stop > handled {
                self.schedule_stability_retry();
            }
            next_meta.insert(
                transcript_path,
                TranscriptFileMeta {
                    size: size_f64,
                    mtime_ms: mtime,
                    identity: Some(identity),
                    observed_stop_at_ms: latest_stop,
                    handled_stop_at_ms: handled,
                },
            );
        }

        rt.set_state_fields(
            None,
            None,
            Some(checkpoint_extra(&next_offsets, &next_meta)),
        );
        entries.sort_by(|left, right| {
            parse_nano(&left.time_unix_nano).cmp(&parse_nano(&right.time_unix_nano))
        });
        Ok(entries)
    }
}

impl WorkBuddyBody {
    fn schedule_stability_retry(&self) {
        if !self.wake.is_running() {
            return;
        }
        if self.retry_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let pending = Arc::clone(&self.retry_pending);
        let wake = Arc::clone(&self.wake);
        let task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(STABILITY_RETRY_MS)).await;
            pending.store(false, Ordering::Release);
            wake.request();
        });
        *self
            .retry_task
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(task);
    }

    fn cancel_retry(&self) {
        self.retry_pending.store(false, Ordering::Release);
        if let Some(task) = self
            .retry_task
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            task.abort();
        }
    }

    async fn scan_transcript_files(&self) -> (Vec<String>, bool) {
        let mut projects = match tokio::fs::read_dir(&self.projects_dir).await {
            Ok(read) => read,
            Err(_) => return (Vec::new(), false),
        };
        let mut files = Vec::new();
        let mut complete = true;
        loop {
            let entry = match projects.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(_) => return (Vec::new(), false),
            };
            let is_dir = match entry.file_type().await {
                Ok(kind) => kind.is_dir(),
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            if !is_dir {
                continue;
            }
            let full = entry.path();
            let mut names = match tokio::fs::read_dir(&full).await {
                Ok(read) => read,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            loop {
                match names.next_entry().await {
                    Ok(Some(file)) => {
                        let name = file.file_name();
                        let name = name.to_string_lossy();
                        if name.ends_with(".jsonl") {
                            files.push(full.join(name.as_ref()).to_string_lossy().into_owned());
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        complete = false;
                        break;
                    }
                }
            }
        }
        (files, complete)
    }

    async fn read_hook_transcript_hints(&self) -> Vec<HookTranscriptHint> {
        let mut sessions = match tokio::fs::read_dir(&self.hook_event_dir).await {
            Ok(read) => read,
            Err(_) => return Vec::new(),
        };
        let mut hints = Vec::new();
        loop {
            let entry = match sessions.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(_) => break,
            };
            let is_dir = entry
                .file_type()
                .await
                .map(|kind| kind.is_dir())
                .unwrap_or(false);
            if !is_dir {
                continue;
            }
            let session_dir = entry.path();
            let mut names = match tokio::fs::read_dir(&session_dir).await {
                Ok(read) => read,
                Err(_) => continue,
            };
            let mut event_files = Vec::new();
            while let Ok(Some(file)) = names.next_entry().await {
                event_files.push(file.file_name().to_string_lossy().into_owned());
            }
            event_files.sort();
            for name in event_files {
                let event_file = session_dir.join(&name);
                let event_file_text = event_file.to_string_lossy().into_owned();
                if name.starts_with('.') && name.ends_with(".tmp") {
                    if let Ok(meta) = tokio::fs::metadata(&event_file).await {
                        if now_ms() - mtime_ms(&meta) > HOOK_ORPHAN_GRACE_MS {
                            let _ = tokio::fs::remove_file(&event_file).await;
                        }
                    }
                    continue;
                }
                if !name.ends_with(".json") {
                    continue;
                }
                let Ok(text) = tokio::fs::read_to_string(&event_file).await else {
                    continue;
                };
                match serde_json::from_str::<Value>(&text) {
                    Ok(Value::Object(record)) => {
                        let transcript = record.get("transcript_path").and_then(Value::as_str);
                        if transcript.is_some_and(|path| path.ends_with(".jsonl")) {
                            hints.push(HookTranscriptHint {
                                transcript_path: transcript.unwrap_or("").to_string(),
                                event_file: event_file_text,
                                session_dir: session_dir.to_string_lossy().into_owned(),
                                event_name: record
                                    .get("hook_event_name")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                observed_at_ms: finite_number(record.get("observed_at_ms")),
                                session_id: record
                                    .get("session_id")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                tool_name: record
                                    .get("tool_name")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                tool_call_id: record
                                    .get("tool_call_id")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                            });
                        } else {
                            let _ = tokio::fs::remove_file(&event_file).await;
                        }
                    }
                    _ => {
                        let _ = tokio::fs::remove_file(&event_file).await;
                    }
                }
            }
            let _ = tokio::fs::remove_dir(&session_dir).await;
        }
        hints
    }

    async fn remove_committed_hook_events(
        &self,
        hints: Vec<HookTranscriptHint>,
        file_meta: &IndexMap<String, TranscriptFileMeta>,
    ) -> Vec<HookTranscriptHint> {
        let mut retained = Vec::new();
        let mut touched = HashSet::new();
        for hint in hints {
            let mut canonical = node_resolve(&hint.transcript_path);
            if let Some(real) = canonicalize_path(&hint.transcript_path).await {
                canonical = real;
            }
            let meta = file_meta
                .get(&hint.transcript_path)
                .or_else(|| file_meta.get(&canonical));
            let committed = hint.observed_at_ms.is_some_and(|observed| {
                meta.is_some_and(|item| observed <= item.handled_stop_at_ms)
            });
            if !committed {
                retained.push(hint);
                continue;
            }
            match tokio::fs::remove_file(&hint.event_file).await {
                Ok(()) => {
                    touched.insert(hint.session_dir);
                }
                Err(_) => retained.push(hint),
            }
        }
        self.remove_empty_session_dirs(&touched).await;
        retained
    }

    async fn remove_deleted_transcript_sessions(
        &self,
        hints: Vec<HookTranscriptHint>,
        transcript_scan_complete: bool,
        file_meta: &IndexMap<String, TranscriptFileMeta>,
    ) -> Vec<HookTranscriptHint> {
        if !transcript_scan_complete {
            return hints;
        }
        let mut grouped: IndexMap<String, Vec<HookTranscriptHint>> = IndexMap::new();
        for hint in &hints {
            grouped
                .entry(hint.session_dir.clone())
                .or_default()
                .push(hint.clone());
        }
        let mut removed = HashSet::new();
        for (session_dir, session_hints) in grouped {
            let mut transcript_paths = Vec::new();
            for hint in &session_hints {
                if !transcript_paths
                    .iter()
                    .any(|path: &String| path == &hint.transcript_path)
                {
                    transcript_paths.push(hint.transcript_path.clone());
                }
            }
            let session_ids: HashSet<String> = session_hints
                .iter()
                .filter_map(|hint| {
                    hint.session_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                })
                .collect();
            let mut all_missing = !transcript_paths.is_empty();
            for transcript_path in &transcript_paths {
                match tokio::fs::metadata(transcript_path).await {
                    Ok(_) => {
                        all_missing = false;
                        break;
                    }
                    Err(err) if is_not_found(&err) => {}
                    Err(_) => {
                        all_missing = false;
                        break;
                    }
                }
            }
            if !all_missing {
                continue;
            }
            let previously_observed = file_meta.keys().any(|checkpoint| {
                transcript_paths
                    .iter()
                    .any(|transcript| node_resolve(checkpoint) == node_resolve(transcript))
                    || session_ids.contains(&basename_without_ext(checkpoint, ".jsonl"))
            });
            let observed_times: Vec<f64> = session_hints
                .iter()
                .filter_map(|hint| hint.observed_at_ms)
                .collect();
            let within_grace = observed_times
                .into_iter()
                .reduce(f64::max)
                .is_some_and(|latest| now_ms() - latest <= HOOK_ORPHAN_GRACE_MS);
            if !previously_observed && within_grace {
                continue;
            }
            if tokio::fs::remove_dir_all(&session_dir).await.is_ok() {
                removed.insert(session_dir);
            }
        }
        hints
            .into_iter()
            .filter(|hint| !removed.contains(&hint.session_dir))
            .collect()
    }

    async fn remove_deleted_transcript_checkpoints(
        &self,
        transcript_scan_complete: bool,
        offsets: &mut IndexMap<String, u64>,
        file_meta: &mut IndexMap<String, TranscriptFileMeta>,
    ) {
        if !transcript_scan_complete {
            return;
        }
        let mut paths = Vec::new();
        for path in offsets.keys().chain(file_meta.keys()) {
            if !paths.iter().any(|existing: &String| existing == path) {
                paths.push(path.clone());
            }
        }
        for transcript_path in paths {
            match tokio::fs::metadata(&transcript_path).await {
                Ok(_) => {}
                Err(err) if is_not_found(&err) => {
                    offsets.shift_remove(&transcript_path);
                    file_meta.shift_remove(&transcript_path);
                }
                Err(_) => {}
            }
        }
    }

    async fn remove_empty_session_dirs(&self, session_dirs: &HashSet<String>) {
        for session_dir in session_dirs {
            let _ = tokio::fs::remove_dir(session_dir).await;
        }
    }

    async fn resolve_transcript_paths(&self, candidates: &[String]) -> Vec<String> {
        let Some(real_root) = canonicalize_path(&self.root).await else {
            return Vec::new();
        };
        let mut resolved = HashSet::new();
        for candidate in candidates {
            if !Path::new(candidate).is_absolute() || !candidate.ends_with(".jsonl") {
                continue;
            }
            let Some(real_candidate) = canonicalize_path(candidate).await else {
                continue;
            };
            if is_path_within(&real_root, &real_candidate) {
                resolved.insert(real_candidate);
            }
        }
        let mut paths: Vec<String> = resolved.into_iter().collect();
        paths.sort();
        paths
    }

    async fn resolve_stop_hints(&self, hints: &[HookTranscriptHint]) -> HashMap<String, f64> {
        let Some(real_root) = canonicalize_path(&self.root).await else {
            return HashMap::new();
        };
        let mut stops = HashMap::new();
        for hint in hints {
            let Some(event_name) = hint.event_name.as_deref() else {
                continue;
            };
            if event_name.to_lowercase() != "stop" {
                continue;
            }
            let Some(observed) = hint.observed_at_ms else {
                continue;
            };
            if !Path::new(&hint.transcript_path).is_absolute()
                || !hint.transcript_path.ends_with(".jsonl")
            {
                continue;
            }
            let Some(real_candidate) = canonicalize_path(&hint.transcript_path).await else {
                continue;
            };
            if !is_path_within(&real_root, &real_candidate) {
                continue;
            }
            let entry = stops.entry(real_candidate).or_insert(0.0);
            *entry = f64::max(*entry, observed);
        }
        stops
    }

    async fn resolve_hook_events(
        &self,
        hints: &[HookTranscriptHint],
        transcript_path: &str,
        session_id: &str,
        after_ms: f64,
        through_ms: f64,
    ) -> Vec<WorkBuddyHookEvent> {
        let mut events = Vec::new();
        for hint in hints {
            let Some(event_name) = hint.event_name.clone() else {
                continue;
            };
            let Some(observed) = hint.observed_at_ms else {
                continue;
            };
            if !HOOK_EVENT_NAMES.iter().any(|name| *name == event_name) {
                continue;
            }
            if observed <= after_ms || observed > through_ms {
                continue;
            }
            if let Some(hint_session) = hint.session_id.as_deref().filter(|id| !id.is_empty()) {
                if hint_session != session_id {
                    continue;
                }
            }
            let Some(real_candidate) = canonicalize_path(&hint.transcript_path).await else {
                continue;
            };
            if real_candidate != transcript_path {
                continue;
            }
            events.push(WorkBuddyHookEvent {
                event_name,
                observed_at_ms: observed,
                session_id: hint.session_id.clone(),
                tool_name: hint.tool_name.clone(),
                tool_call_id: hint.tool_call_id.clone(),
            });
        }
        events
    }
}

struct OpenedTranscript {
    file: tokio::fs::File,
    size: u64,
    mtime_ms: f64,
    identity: String,
}

// Keep the snapshot facts and the range read on the same open file. A path
// can name a replacement by the time collection reaches the stable Stop.
async fn open_transcript_snapshot(path: &str) -> Option<OpenedTranscript> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path).ok()?;
        let metadata = file.metadata().ok()?;
        let identity = crate::utils::file_identity::identity_from_open(&file).ok()?;
        Some(OpenedTranscript {
            file: tokio::fs::File::from_std(file),
            size: metadata.len(),
            mtime_ms: mtime_ms(&metadata),
            identity: format!("{}:{}", identity.dev, identity.ino),
        })
    })
    .await
    .ok()?
}

async fn read_jsonl_range(
    file: &mut tokio::fs::File,
    start: u64,
    end: u64,
) -> Option<(Vec<Value>, u64)> {
    if start >= end {
        return Some((Vec::new(), start));
    }
    let len = usize::try_from(end - start).ok()?;
    file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    let mut bytes = vec![0u8; len];
    let mut filled = 0;
    while filled < bytes.len() {
        let read = file.read(&mut bytes[filled..]).await.ok()?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    bytes.truncate(filled);
    Some(parse_jsonl(&bytes, start))
}

fn parse_jsonl(bytes: &[u8], start_offset: u64) -> (Vec<Value>, u64) {
    let mut records = Vec::new();
    let mut line_start = 0usize;
    let mut next_offset = start_offset;
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'\n' {
            index += 1;
            continue;
        }
        if !parse_jsonl_line(&bytes[line_start..index], &mut records) {
            return (records, next_offset);
        }
        line_start = index + 1;
        next_offset = start_offset + line_start as u64;
        index += 1;
    }
    if line_start < bytes.len() && parse_jsonl_line(&bytes[line_start..], &mut records) {
        next_offset = start_offset + bytes.len() as u64;
    }
    (records, next_offset)
}

fn parse_jsonl_line(line: &[u8], records: &mut Vec<Value>) -> bool {
    let text = String::from_utf8_lossy(line);
    let text = text.trim();
    if text.is_empty() {
        return true;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) => {
            records.push(value);
            true
        }
        Err(_) => false,
    }
}

fn checkpoint_extra(
    offsets: &IndexMap<String, u64>,
    file_meta: &IndexMap<String, TranscriptFileMeta>,
) -> Value {
    let mut bytes = Map::new();
    for (path, offset) in offsets {
        bytes.insert(path.clone(), Value::from(*offset));
    }
    let mut files = Map::new();
    for (path, item) in file_meta {
        let mut object = Map::new();
        object.insert("size".into(), json_f64(item.size));
        object.insert("mtimeMs".into(), json_f64(item.mtime_ms));
        if let Some(identity) = &item.identity {
            object.insert("identity".into(), Value::String(identity.clone()));
        }
        object.insert(
            "observedStopAtMs".into(),
            json_f64(item.observed_stop_at_ms),
        );
        object.insert("handledStopAtMs".into(), json_f64(item.handled_stop_at_ms));
        files.insert(path.clone(), Value::Object(object));
    }
    let mut extra = Map::new();
    extra.insert(INITIALIZED_KEY.to_string(), Value::Bool(true));
    extra.insert(OFFSET_MAP_KEY.to_string(), Value::Object(bytes));
    extra.insert(FILE_META_MAP_KEY.to_string(), Value::Object(files));
    Value::Object(extra)
}

fn normalize_offset_map(value: Option<&Value>) -> IndexMap<String, u64> {
    let Some(Value::Object(map)) = value else {
        return IndexMap::new();
    };
    let mut out = IndexMap::new();
    for (file, offset) in map {
        if let Some(offset) = non_negative_integer(offset) {
            out.insert(file.clone(), offset);
        }
    }
    out
}

fn normalize_file_meta_map(value: Option<&Value>) -> IndexMap<String, TranscriptFileMeta> {
    let Some(Value::Object(map)) = value else {
        return IndexMap::new();
    };
    let mut out = IndexMap::new();
    for (file, raw) in map {
        let Some(meta) = raw.as_object() else {
            continue;
        };
        let (Some(size), Some(mtime_ms)) = (
            finite_number(meta.get("size")),
            finite_number(meta.get("mtimeMs")),
        ) else {
            continue;
        };
        out.insert(
            file.clone(),
            TranscriptFileMeta {
                size,
                mtime_ms,
                identity: meta
                    .get("identity")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                observed_stop_at_ms: finite_number(meta.get("observedStopAtMs")).unwrap_or(0.0),
                handled_stop_at_ms: finite_number(meta.get("handledStopAtMs")).unwrap_or(0.0),
            },
        );
    }
    out
}

fn non_negative_integer(value: &Value) -> Option<u64> {
    let Value::Number(number) = value else {
        return None;
    };
    if let Some(value) = number.as_u64() {
        return Some(value);
    }
    let value = number.as_f64()?;
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= u64::MAX as f64 {
        Some(value as u64)
    } else {
        None
    }
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn json_f64(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&value)
    {
        Value::Number((value as i64).into())
    } else if let Some(number) = serde_json::Number::from_f64(value) {
        Value::Number(number)
    } else {
        Value::from(0)
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

async fn canonicalize_path(path: &str) -> Option<String> {
    tokio::fs::canonicalize(path)
        .await
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

fn is_path_within(root: &str, candidate: &str) -> bool {
    match Path::new(candidate).strip_prefix(Path::new(root)) {
        Ok(relative) => !relative.as_os_str().is_empty(),
        Err(_) => false,
    }
}

fn node_resolve(path: &str) -> String {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

fn basename_without_ext(path: &str, ext: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if name.len() > ext.len() && name.ends_with(ext) {
        name[..name.len() - ext.len()].to_string()
    } else {
        name
    }
}

fn is_not_found(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}

fn parse_nano(text: &str) -> i128 {
    text.parse::<i128>().unwrap_or(0)
}

#[cfg(test)]
mod tests;
