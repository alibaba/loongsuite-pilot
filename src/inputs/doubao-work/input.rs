//! Read-only, bounded collector for observed Doubao Work lifecycle and native evidence.
use super::budget::{DoubaoWorkBudget, DoubaoWorkBudgetOptions, DoubaoWorkError, Result};
use super::content::{enrich_native_tool_events, native_task_content, native_tool_observations};
use super::execution::{
    build_native_execution_events, is_unique_native_tool_owner, NativeExecution,
};
use super::log::{
    build_doubao_task_events, is_doubao_presentation_inspection, parse_doubao_log_line,
};
use super::native::{build_native_tool_events, NativeGraph};
use super::paths::resolve_doubao_work_paths;
use super::reader::{DoubaoWorkNativeReader, NativeReaderOptions};
use super::rounds::{NativeRoundReconstruction, NativeRoundSteps};
use super::state::*;
use super::types::*;
use super::util::*;
use crate::checkpoints::StateStore;
use crate::inputs::base::{
    CommittedInputBatch, HostedInput, InputBody, InputRuntime, InputRuntimeDelta, InputRuntimeInfo,
};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use async_trait::async_trait;
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::fs::File;
const MAX_FILES: usize = 128;
const READ_BYTES: usize = 1024 * 1024;
const COMPLETED_TTL: i64 = 7 * 86_400_000;
static FILE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^saman(?:_frontend)?_\d{4}\.\d{4}\.\d+\.log$").unwrap());
static CHILD_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[mos]_[a-zA-Z0-9]+$").unwrap());
static MUTATION_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[os]_[a-zA-Z0-9]+$").unwrap());
pub struct DoubaoWorkInputOptions {
    pub state_store: Arc<StateStore>,
    pub log_dir: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub sessions_root: Option<String>,
    pub snapshot_root: Option<String>,
    pub native_scan_interval_ms: Option<u64>,
    pub work_budget: Option<DoubaoWorkBudgetOptions>,
}
impl DoubaoWorkInputOptions {
    pub fn new(state_store: Arc<StateStore>) -> Self {
        Self {
            state_store,
            log_dir: None,
            poll_interval_ms: None,
            sessions_root: None,
            snapshot_root: None,
            native_scan_interval_ms: None,
            work_budget: None,
        }
    }
}
pub struct DoubaoWorkInput {
    pub inner: Arc<HostedInput<DoubaoWorkBody>>,
}
impl DoubaoWorkInput {
    pub fn new(options: DoubaoWorkInputOptions) -> Self {
        Self::new_with_paths(options, resolve_doubao_work_paths())
    }
    fn new_with_paths(
        options: DoubaoWorkInputOptions,
        defaults: super::paths::DoubaoWorkPaths,
    ) -> Self {
        let log_dir = options
            .log_dir
            .filter(|s| !s.is_empty())
            .map(|p| absolute_path(&p))
            .or(defaults.log_dir);
        let scope = digest(log_dir.as_deref().unwrap_or("unsupported-platform"));
        let snapshot_root = options.snapshot_root.clone().or(defaults.snapshot_root);
        let has_snapshots = snapshot_root.is_some();
        let reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            sessions_root: options.sessions_root.clone(),
            user_data_root: defaults.user_data_root.clone(),
            snapshot_root,
            diagnostic: Some(Arc::new(|reason| {
                crate::utils::create_logger("DoubaoWorkInput").warn(
                    "Doubao Work bounded native collection degraded",
                    json!({"reason":reason}).as_object(),
                );
            })),
            ..Default::default()
        });
        let body = DoubaoWorkBody {
            recovery: super::source_ownership::SourceRecovery::new(
                options.state_store.file_path(),
                scope.clone(),
            ),
            log_dir,
            scope,
            has_native: options.sessions_root.is_some() || defaults.user_data_root.is_some(),
            has_snapshots,
            native_interval: Duration::from_millis(
                options.native_scan_interval_ms.unwrap_or(10_000),
            ),
            limits: options.work_budget.unwrap_or_default(),
            state: tokio::sync::Mutex::new(Shared::new(reader)),
            host: Mutex::new(None),
            wakeup: Mutex::new(None),
            watcher: Mutex::new(None),
        };
        let inner = HostedInput::new(
            body,
            "DoubaoWorkInput",
            options.state_store,
            options
                .poll_interval_ms
                .or(Some(crate::utils::DEFAULT_POLL_INTERVAL_MS)),
        );
        *inner.body.host.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::downgrade(&inner));
        Self { inner }
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
    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }
    pub(crate) fn collector_runtime_info(&self) -> InputRuntimeInfo {
        InputRuntimeInfo {
            source_paths: Self::watch_paths(self.inner.body.log_dir.as_deref()),
            ..self.inner.runtime.runtime_info()
        }
    }

    /// Apply validated collector exclusions before any collection or upload.
    pub(crate) fn set_collector_workspace_policy(
        &self,
        policy: crate::inputs::base::WorkspacePolicy,
    ) {
        self.inner.runtime.set_workspace_policy(policy);
    }
    pub async fn start(&self) -> std::result::Result<(), String> {
        self.inner.start().await
    }
    pub async fn stop(&self) -> std::result::Result<(), String> {
        self.inner.stop().await
    }
    pub async fn run_cycle(&self) {
        self.inner.run_cycle().await;
    }
    pub fn request_collection(&self) {
        self.inner.request_collection();
    }
    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }
    pub fn on_entries(&self, on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static) {
        self.inner.on_entries(on_entries);
    }
    pub fn default_log_dir() -> Option<String> {
        resolve_doubao_work_paths().log_dir
    }
    pub fn watch_paths(log_dir: Option<&str>) -> Vec<String> {
        log_dir
            .map(|s| vec![s.to_owned()])
            .unwrap_or_else(|| Self::default_log_dir().into_iter().collect())
    }
    pub async fn check_availability(log_dir: Option<&str>) -> bool {
        let owned = log_dir.map(str::to_owned).or_else(Self::default_log_dir);
        let Some(dir) = owned else { return false };
        let Ok(mut files) = tokio::fs::read_dir(dir).await else {
            return false;
        };
        while let Ok(Some(file)) = files.next_entry().await {
            if FILE_PATTERN.is_match(&file.file_name().to_string_lossy())
                && file.file_type().await.is_ok_and(|t| t.is_file())
            {
                return true;
            }
        }
        false
    }
}
fn absolute_path(path: &str) -> String {
    let path = Path::new(path);
    let full = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    // path.resolve removes lexical dots without resolving symlinks.
    let mut result = PathBuf::new();
    for part in full.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part.as_os_str()),
        }
    }
    result.to_string_lossy().into_owned()
}
pub struct DoubaoWorkBody {
    log_dir: Option<String>,
    scope: String,
    has_native: bool,
    has_snapshots: bool,
    native_interval: Duration,
    limits: DoubaoWorkBudgetOptions,
    recovery: super::source_ownership::SourceRecovery,
    state: tokio::sync::Mutex<Shared>,
    host: Mutex<Option<Weak<HostedInput<DoubaoWorkBody>>>>,
    wakeup: Mutex<Option<tokio::task::JoinHandle<()>>>,
    watcher: Mutex<Option<Watcher>>,
}
struct Baseline {
    checkpoint: Checkpoint,
    names: Vec<String>,
    index: usize,
}
struct Sweep {
    names: Vec<String>,
    index: usize,
    drained: bool,
}
struct ReconstructionJob {
    version: String,
    conversation: String,
    bytes: usize,
    updated_ms: i64,
    steps: Option<NativeRoundSteps>,
    graph: Arc<NativeGraph>,
    executions: Option<Vec<NativeExecution>>,
}
struct Shared {
    reader: DoubaoWorkNativeReader,
    committed: Option<Checkpoint>,
    loaded: bool,
    revision: Option<u64>,
    recovery_epoch: Option<i64>,
    unsupported: bool,
    baseline: Option<Baseline>,
    sweep: Option<Sweep>,
    finalize: Option<Vec<String>>,
    jobs: IndexMap<String, ReconstructionJob>,
    cycle_graphs: IndexMap<String, Option<Arc<NativeGraph>>>,
    normalized: bool,
    warned_file_limit: bool,
    next_native_scan: Option<Instant>,
    next_compaction: i64,
    next_diagnostics: i64,
    execution_scan_cursor: Option<String>,
    native_deferred: bool,
    reported_io: HashSet<i32>,
    #[cfg(test)]
    expire_log_read: Option<usize>,
}
impl Shared {
    fn new(reader: DoubaoWorkNativeReader) -> Self {
        Self {
            reader,
            committed: None,
            loaded: false,
            revision: None,
            recovery_epoch: None,
            unsupported: false,
            baseline: None,
            sweep: None,
            finalize: None,
            jobs: IndexMap::new(),
            cycle_graphs: IndexMap::new(),
            normalized: false,
            warned_file_limit: false,
            next_native_scan: None,
            next_compaction: 0,
            next_diagnostics: 0,
            execution_scan_cursor: None,
            native_deferred: false,
            reported_io: HashSet::new(),
            #[cfg(test)]
            expire_log_read: None,
        }
    }
}
#[async_trait]
impl InputBody for DoubaoWorkBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "doubao-work"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::DoubaoWork
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }
    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        let Some(dir) = &self.log_dir else {
            return Ok(());
        };
        let weak = self.host.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(weak) = weak {
            let watcher = spawn_watcher(dir, weak);
            if watcher.is_none() {
                rt.logger.warn(
                    "Doubao Work file watcher unavailable; using bounded polling",
                    None,
                );
            }
            *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = watcher;
        }
        Ok(())
    }
    fn before_stop(&self) {
        if let Some(task) = self.wakeup.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
        if let Some(watcher) = self
            .watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            drop(watcher);
        }
    }
    async fn on_stop(&self, _: &InputRuntime) -> anyhow::Result<()> {
        self.before_stop();
        let mut shared = self.state.lock().await;
        shared.reader.clear();
        shared.cycle_graphs.clear();
        shared.jobs.clear();
        shared.sweep = None;
        shared.finalize = None;
        shared.committed = None;
        shared.loaded = false;
        shared.recovery_epoch = None;
        shared.unsupported = false;
        shared.baseline = None;
        shared.normalized = false;
        Ok(())
    }
    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let Some(dir) = &self.log_dir else {
            return Ok(vec![]);
        };
        let mut shared = self.state.lock().await;
        let mut budget = DoubaoWorkBudget::new(self.limits, Some(rt));
        #[cfg(test)]
        if let Some(length) = shared.expire_log_read.take() {
            budget.expire_after_read(length);
        }
        shared.cycle_graphs.clear();
        shared.native_deferred = false;
        let now = now_ms();
        shared.jobs.retain(|_, job| now - job.updated_ms <= 60_000);
        // Resume the bounded sweep without paying a fresh directory scan before
        // every unit of progress. A completed sweep refreshes the directory next cycle.
        let all_names = match if let Some(baseline) = &shared.baseline {
            Ok(baseline.names.clone())
        } else if let Some(sweep) = &shared.sweep {
            Ok(sweep.names.clone())
        } else if let Some(names) = &shared.finalize {
            Ok(names.clone())
        } else {
            log_names(dir).await
        } {
            Ok(v) => v,
            Err(_) => {
                rt.logger.warn(
                    "Doubao Work log directory unavailable; preserving checkpoint",
                    None,
                );
                return Ok(vec![]);
            }
        };
        if all_names.len() > MAX_FILES && !shared.warned_file_limit {
            shared.warned_file_limit = true;
            rt.logger.warn(
                "Doubao Work source file limit reached; only newest files are read",
                json!({"limit":MAX_FILES}).as_object(),
            );
        }
        let names = all_names
            .into_iter()
            .rev()
            .take(MAX_FILES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        let observed_revision = rt.state_store.revision();
        if !shared.loaded || shared.revision != Some(observed_revision) {
            shared.committed = None;
            shared.unsupported = false;
            let state = rt.state();
            if let Some(saved) = state.extra().as_ref().and_then(|v| v.get("doubaoWork")) {
                if saved.get("schema").and_then(Value::as_u64) != Some(1) {
                    shared.unsupported = true;
                } else {
                    match serde_json::from_value(saved.clone()) {
                        Ok(v) => shared.committed = Some(v),
                        Err(_) => shared.unsupported = true,
                    }
                }
            }
            shared.loaded = true;
            shared.revision = Some(observed_revision);
        }
        if shared.unsupported {
            rt.logger.warn(
                "Unsupported Doubao Work checkpoint schema; preserving state",
                None,
            );
            return Ok(vec![]);
        }
        if shared.recovery_epoch.is_none() {
            let proposed = shared.committed.as_ref().map_or(now, |c| c.since_ms);
            let epoch = self.recovery.initial_epoch(proposed).await?;
            shared.recovery_epoch = Some(epoch);
        }
        if shared
            .committed
            .as_ref()
            .is_some_and(|c| Some(c.since_ms) != shared.recovery_epoch)
        {
            return Err(anyhow::anyhow!(
                "Doubao checkpoint exclusion epoch differs from its durable source proof"
            ));
        }
        if shared.committed.is_none() {
            let mut baseline = shared.baseline.take().unwrap_or_else(|| Baseline {
                checkpoint: Checkpoint::new(
                    shared.recovery_epoch.expect("initialized recovery epoch"),
                ),
                names: names.clone(),
                index: 0,
            });
            while baseline.index < baseline.names.len() {
                if budget.exhausted() {
                    self.defer(&mut shared, rt, &DoubaoWorkError::deferred("cycle_budget"));
                    shared.baseline = Some(baseline);
                    return Ok(vec![]);
                }
                let name = baseline.names[baseline.index].clone();
                let result = async {
                    let path = Path::new(dir).join(&name);
                    let mut file = super::source_ownership::open_source(path.clone()).await?;
                    self.recovery
                        .historical(&path, &mut file, &mut budget)
                        .await
                }
                .await;
                match result {
                    Ok(cursor) => baseline.checkpoint.files.set(name, cursor),
                    Err(error) => {
                        if self.defer(&mut shared, rt, &error) {
                            shared.baseline = Some(baseline);
                            return Ok(vec![]);
                        }
                        return Err(error.into());
                    }
                }
                baseline.index += 1;
            }
            let revision = commit(rt, &baseline.checkpoint)?;
            shared.committed = Some(baseline.checkpoint);
            shared.revision = Some(revision);
            return Ok(vec![]);
        }
        let base = shared.committed.as_ref().unwrap().clone();
        let mut next = base.clone();
        if !shared.normalized {
            let remove: Vec<_> = next
                .tools
                .iter()
                .filter(|(_, p)| {
                    [&p.start, &p.end]
                        .into_iter()
                        .filter_map(|e| e.as_ref().and_then(|v| v.tool.as_ref()))
                        .any(|t| is_doubao_presentation_inspection(&t.name, &t.id))
                })
                .map(|(k, _)| k.clone())
                .collect();
            for key in remove {
                next.tools.remove(&key);
            }
        }
        let mut active: HashSet<_> = next
            .pending
            .values()
            .filter_map(|p| {
                p.conversation_id
                    .clone()
                    .or_else(|| p.terminal.as_ref().and_then(|v| v.conversation_id.clone()))
            })
            .collect();
        active.extend(shared.jobs.values().map(|j| j.conversation.clone()));
        for tool in next
            .tools
            .values()
            .filter_map(|v| v.start.as_ref().and_then(|v| v.tool.as_ref()))
        {
            if let Some(boxes) = next.sandboxes.get(&tool.sandbox_id) {
                let roots: Vec<_> = boxes
                    .actors
                    .iter()
                    .filter(|a| !CHILD_PATTERN.is_match(a))
                    .collect();
                if roots.len() == 1 {
                    if let Some(root) = next
                        .roots
                        .get(roots[0])
                        .and_then(|r| r.conversation_id.as_ref())
                    {
                        active.insert(root.clone());
                    }
                }
            }
        }
        if let Err(error) = shared.reader.begin_cycle(active) {
            if !self.defer(&mut shared, rt, &error) {
                rt.logger
                    .warn("Doubao Work bounded native cache cannot begin cycle", None);
            }
        }
        let finalization = shared.finalize.take().as_ref() == Some(&names);
        let mut sweep = shared.sweep.take().unwrap_or_else(|| Sweep {
            names: names.clone(),
            index: 0,
            drained: true,
        });
        let mut drained = finalization || sweep.drained;
        let mut more = false;
        let mut events = Vec::new();
        if !finalization {
            while sweep.index < sweep.names.len() {
                if budget.exhausted() {
                    break;
                }
                let name = &sweep.names[sweep.index];
                if !names.contains(name) {
                    drained = false;
                    sweep.index += 1;
                    continue;
                }
                match read_log(dir, name, &next, &mut budget, rt, &self.recovery).await {
                    Ok(result) => {
                        drained &= result.drained;
                        more |= result.more;
                        events.extend(result.events);
                        next.files.set(name.clone(), result.cursor);
                    }
                    Err(error) => {
                        if error.reason() == Some("cycle_budget") {
                            self.defer(&mut shared, rt, &error);
                            more = true;
                            break;
                        }
                        drained = false;
                        if !self.defer(&mut shared, rt, &error) {
                            rt.logger.warn(
                                "Doubao Work log read unavailable; preserving file checkpoint",
                                None,
                            );
                        }
                    }
                }
                sweep.index += 1;
            }
            if sweep.index < sweep.names.len() {
                sweep.drained = drained;
                drained = false;
                more = true;
                shared.sweep = Some(sweep);
            } else {
                drained &= names == sweep.names;
            }
        }
        if more {
            self.defer(
                &mut shared,
                rt,
                &DoubaoWorkError::deferred("source_backlog"),
            );
        }
        events.sort_by_key(|event| nanos(&event.time_nano).unwrap_or(0));
        for event in &events {
            consume(&mut next, event, now);
        }
        let mut entries = Vec::new();
        if drained {
            if shared.jobs.keys().any(|key| key.starts_with("execution:")) {
                self.complete_executions(&mut shared, &mut next, &mut entries, &mut budget, rt)
                    .await?;
            }
            let mut pending = rotated_keys(&next.pending, next.pending_scan_cursor.as_deref());
            pending.sort_by_key(|key| !shared.jobs.contains_key(&format!("request:{key}")));
            let mut attempts = 0;
            for key in pending {
                if budget.exhausted() {
                    self.defer(&mut shared, rt, &DoubaoWorkError::deferred("cycle_budget"));
                    break;
                }
                let Some(pending) = next
                    .pending
                    .get(&key)
                    .cloned()
                    .filter(|p| p.start_observed && p.terminal.is_some())
                else {
                    continue;
                };
                if attempts >= 4 {
                    break;
                }
                attempts += 1;
                next.pending_scan_cursor = Some(key.clone());
                self.complete_request(
                    &mut shared,
                    &mut next,
                    &key,
                    &pending,
                    &mut entries,
                    &mut budget,
                    rt,
                )
                .await?;
            }
            if !budget.exhausted()
                && shared
                    .next_native_scan
                    .is_none_or(|at| Instant::now() >= at)
            {
                shared.next_native_scan = Instant::now().checked_add(self.native_interval);
                self.complete_native(&mut shared, &mut next, &mut entries, &mut budget, rt)
                    .await;
                self.complete_executions(&mut shared, &mut next, &mut entries, &mut budget, rt)
                    .await?;
                if shared.native_deferred {
                    shared.next_native_scan = None;
                }
            }
        }
        if drained && budget.exhausted() {
            shared.finalize = Some(names.clone());
        }
        let remove: Vec<_> = next
            .files
            .keys()
            .filter(|name| !names.contains(name))
            .cloned()
            .collect();
        for name in remove {
            next.files.remove(&name);
        }
        if !events.is_empty() || !entries.is_empty() || now >= shared.next_compaction {
            shared.next_compaction = now + 60_000;
            next.compact(now);
        }
        let changed = !next.unchanged(&base);
        if changed {
            let revision = commit(rt, &next)?;
            shared.committed = Some(next);
            shared.revision = Some(revision);
        }
        shared.normalized = true;
        if changed || shared.native_deferred || now >= shared.next_diagnostics {
            shared.next_diagnostics = now + 60_000;
            rt.logger.debug(
                "Doubao Work native cache statistics",
                { let stats=shared.reader.stats(); json!({"bodyReadBytes":stats.body_read_bytes,"parsedRows":stats.parsed_rows,"cacheHits":stats.cache_hits,"resets":stats.resets,"evictions":stats.evictions,"retainedBytes":stats.retained_bytes,"files":stats.files}) }.as_object(),
            );
        }
        entries
            .into_iter()
            .map(|v| serde_json::from_value(Value::Object(v)).map_err(Into::into))
            .collect()
    }
}
fn commit(rt: &InputRuntime, state: &Checkpoint) -> anyhow::Result<u64> {
    let revision = rt.state_store.revision();
    rt.set_state_fields(
        None,
        None,
        Some(json!({"doubaoWork":serde_json::to_value(state)?})),
    );
    Ok(revision + 1)
}
fn rotated_keys<T>(map: &CowMap<T>, after: Option<&str>) -> Vec<String> {
    let keys: Vec<_> = map.keys().cloned().collect();
    let Some(pos) = after.and_then(|a| keys.iter().position(|k| k == a)) else {
        return keys;
    };
    keys[pos + 1..]
        .iter()
        .chain(keys[..pos + 1].iter())
        .cloned()
        .collect()
}
async fn log_names(dir: &str) -> std::io::Result<Vec<String>> {
    let mut reader = tokio::fs::read_dir(dir).await?;
    let mut names = Vec::new();
    while let Some(file) = reader.next_entry().await? {
        let name = file.file_name().to_string_lossy().into_owned();
        if FILE_PATTERN.is_match(&name) && file.file_type().await?.is_file() {
            names.push(name);
        }
    }
    names.sort_by_key(|a| natural_key(a));
    Ok(names)
}
fn natural_key(name: &str) -> Vec<(String, u64)> {
    static SEGMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+|\D+").unwrap());
    SEGMENT
        .find_iter(name)
        .map(|m| {
            let text = m.as_str();
            if text.as_bytes()[0].is_ascii_digit() {
                (String::new(), text.parse().unwrap_or(u64::MAX))
            } else {
                (text.to_owned(), 0)
            }
        })
        .collect()
}
async fn opened_identity(file: &File) -> Result<(String, u64)> {
    let clone = file.try_clone().await?.into_std().await;
    let id = crate::utils::file_identity::identity_from_open(&clone)?;
    Ok((format!("{}:{}", id.dev, id.ino), id.size))
}
async fn boundary_anchor(
    file: &mut File,
    offset: u64,
    budget: &mut DoubaoWorkBudget<'_>,
    finishing: bool,
) -> Result<String> {
    let length = offset.min(64) as usize;
    if length == 0 {
        return Ok(digest(""));
    }
    let mut buffer = [0_u8; 64];
    let read = budget
        .read(file, &mut buffer, length, offset - length as u64, finishing)
        .await?;
    if read != length {
        return Err(DoubaoWorkError::invalid(
            "Doubao Work cursor boundary changed during read",
        ));
    }
    let hex: String = buffer[..length]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(digest(&hex))
}
struct ReadResult {
    cursor: FileCursor,
    events: Vec<DoubaoLogEvent>,
    drained: bool,
    more: bool,
}
async fn read_log(
    dir: &str,
    name: &str,
    state: &Checkpoint,
    budget: &mut DoubaoWorkBudget<'_>,
    rt: &InputRuntime,
    recovery: &super::source_ownership::SourceRecovery,
) -> Result<ReadResult> {
    let path = Path::new(dir).join(name);
    let mut file = super::source_ownership::open_source(path.clone()).await?;
    let full_identity = super::source_ownership::identity(&file).await?;
    let (identity, size) = (
        format!("{}:{}", full_identity.dev, full_identity.ino),
        full_identity.size,
    );
    let prior = state
        .files
        .get(name)
        .or_else(|| state.files.values().find(|v| v.identity == identity));
    let same_birth = |c: &FileCursor| {
        c.birthtime_bits
            .is_none_or(|bits| bits == full_identity.birthtime_ms.to_bits())
    };
    let mut new_source =
        prior.is_none_or(|c| c.identity != identity || c.offset > size || !same_birth(c));
    let mut cursor = prior
        .filter(|c| c.identity == identity && c.offset <= size && same_birth(c))
        .cloned()
        .unwrap_or_else(|| FileCursor {
            identity: identity.clone(),
            ..Default::default()
        });
    cursor.birthtime_bits = Some(full_identity.birthtime_ms.to_bits());
    if let Some(anchor) = &cursor.anchor {
        if anchor != &boundary_anchor(&mut file, cursor.offset, budget, false).await? {
            cursor.offset = 0;
            cursor.skipping_line = false;
            new_source = true;
        }
    }
    if new_source {
        recovery.before_live_read(&path, &mut file, budget).await?;
    }
    let unread = size - cursor.offset;
    rt.with_accumulator(|a| a.observe_backlog(unread));
    let mut events = Vec::new();
    let (mut drained, mut more) = (true, false);
    if unread > 0 {
        let requested = (READ_BYTES as u64)
            .min(budget.remaining_bytes().saturating_sub(64))
            .min(unread) as usize;
        if requested == 0 {
            return Err(DoubaoWorkError::deferred("cycle_budget"));
        }
        let mut chunk = vec![0_u8; requested];
        let bytes = budget
            .read(&mut file, &mut chunk, requested, cursor.offset, false)
            .await?;
        chunk.truncate(bytes);
        if (bytes as u64) < unread {
            drained = false;
            more = true;
        }
        let (mut from, mut records, mut parsed, mut max_line) = (0, 0_u64, 0_u64, 0_u64);
        while from < chunk.len() {
            if budget.exhausted() && from > 0 {
                drained = false;
                break;
            }
            let Some(newline) = chunk[from..]
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| i + from)
            else {
                break;
            };
            let end = newline + 1;
            records += 1;
            max_line = max_line.max((end - from) as u64);
            let mut recognized = false;
            if !cursor.skipping_line {
                if let Some(event) =
                    parse_doubao_log_line(&String::from_utf8_lossy(&chunk[from..newline]), name)
                {
                    parsed += 1;
                    recognized = true;
                    events.push(event);
                }
            }
            budget.record(u64::from(recognized), 1);
            cursor.skipping_line = false;
            from = end;
            budget.yield_if_needed().await;
        }
        if from == 0 && bytes == READ_BYTES && !chunk.contains(&b'\n') {
            from = bytes;
            cursor.skipping_line = true;
            rt.logger
                .warn("Doubao Work oversized log line skipped", None);
        }
        cursor.offset += from as u64;
        let after = opened_identity(&file).await?;
        if after.0 != identity || after.1 < cursor.offset {
            return Err(DoubaoWorkError::invalid(
                "Doubao source identity changed during read",
            ));
        }
        cursor.anchor = Some(boundary_anchor(&mut file, cursor.offset, budget, true).await?);
        if cursor.offset < size {
            drained = false;
        }
        if from > 0 && budget.exhausted() && cursor.offset < size {
            more = true;
        }
        rt.with_accumulator(|a| {
            a.observe_committed_batch(CommittedInputBatch {
                bytes: from as u64,
                records,
                parse_success_records: parsed,
                parse_failed_records: 0,
                max_record_bytes: max_line,
            })
        });
    }
    Ok(ReadResult {
        cursor,
        events,
        drained,
        more,
    })
}

fn consume(state: &mut Checkpoint, event: &DoubaoLogEvent, now: i64) {
    if let Some(first) = &event.first_output {
        let matched: Vec<_> = state
            .pending
            .iter()
            .filter(|(_, p)| {
                p.turn_id == event.turn_id.as_deref().unwrap_or("")
                    && p.start_observed
                    && p.query_ms >= state.since_ms
                    && nanos(&event.time_nano)
                        .is_some_and(|time| i128::from(p.query_ms) * 1_000_000 <= time)
            })
            .map(|(k, p)| (k.clone(), p.clone()))
            .collect();
        if matched.len() != 1 {
            return;
        }
        let (key, mut pending) = matched[0].clone();
        if pending
            .first_output
            .as_ref()
            .and_then(|e| e.first_output.as_ref())
            .is_some_and(|v| v != first)
        {
            pending.first_output_conflict = true;
        }
        if pending.first_output.is_none() {
            pending.first_output = Some(event.clone())
        }
        state.pending.set(key, pending);
        return;
    }
    if let Some(command) = &event.command {
        if nanos(&event.time_nano).unwrap_or(0) < i128::from(state.since_ms) * 1_000_000 {
            return;
        }
        let mut sandbox = state
            .sandboxes
            .get(&command.sandbox_id)
            .cloned()
            .unwrap_or_default();
        if !sandbox.actors.contains(&command.agent_id) {
            if sandbox.actors.len() >= 64 {
                sandbox.conflict = true
            } else {
                sandbox.actors.push(command.agent_id.clone());
            }
        }
        sandbox.updated_ms = now;
        state.sandboxes.set(command.sandbox_id.clone(), sandbox);
        return;
    }
    if let Some(tool) = &event.tool {
        if nanos(&event.time_nano).unwrap_or(0) < i128::from(state.since_ms) * 1_000_000 {
            return;
        }
        let key = encode(&json!([tool.sandbox_id, tool.id]));
        let mut pending = state.tools.get(&key).cloned().unwrap_or_default();
        let side = if tool.phase == "received" {
            &mut pending.start
        } else {
            &mut pending.end
        };
        if let Some(prior) = &side {
            if prior.turn_id != event.turn_id
                || prior.tool.as_ref().map(|v| (&v.name, &v.status))
                    != Some((&tool.name, &tool.status))
            {
                pending.conflict = true;
            }
        }
        if side.is_none() {
            *side = Some(event.clone())
        }
        pending.updated_ms = now;
        if let (Some(start), Some(end)) = (&pending.start, &pending.end) {
            if let (Some(actor), Some(a), Some(b)) = (&start.turn_id, &start.tool, &end.tool) {
                let actor_key = encode(&json!([a.sandbox_id, actor]));
                if pending.conflict
                    && state
                        .native_mutation_actors
                        .get(&actor_key)
                        .is_some_and(|v| v.call_id == a.id)
                {
                    state.native_mutation_actors.remove(&actor_key);
                }
                if !pending.conflict
                    && MUTATION_PATTERN.is_match(actor)
                    && ["Write", "Edit"].contains(&a.name.as_str())
                    && a.name == b.name
                    && a.id == b.id
                    && a.sandbox_id == b.sandbox_id
                    && a.phase == "received"
                    && b.phase == "settled"
                    && b.status.as_deref() == Some("success")
                    && nanos(&end.time_nano) > nanos(&start.time_nano)
                {
                    state.native_mutation_actors.set(
                        actor_key,
                        MutationActor {
                            call_id: a.id.clone(),
                            time_nano: Some(end.time_nano.clone()),
                            updated_ms: now,
                        },
                    );
                }
            }
        }
        state.tools.set(key, pending);
        return;
    }
    if event.name == "general_agent_message_id_mapping" {
        if let (Some(local), Some(conversation)) = (&event.local_message_id, &event.conversation_id)
        {
            let keys: Vec<_> = state
                .pending
                .iter()
                .filter(|(_, p)| p.local_message_id.as_ref() == Some(local))
                .map(|(k, _)| k.clone())
                .collect();
            for key in keys {
                let mut p = state.pending[&key].clone();
                p.conversation_id = Some(conversation.clone());
                state.pending.set(key, p);
            }
        }
        return;
    }
    let (Some(turn), Some(query)) = (&event.turn_id, event.query_ms) else {
        return;
    };
    if query < state.since_ms.max(now - COMPLETED_TTL) {
        return;
    }
    let key = format!("{turn}:{query}");
    if state.completed.contains_key(&key) {
        return;
    }
    let mut pending = state.pending.get(&key).cloned().unwrap_or_default();
    pending.turn_id = turn.clone();
    pending.query_ms = query;
    pending.updated_ms = now;
    if event.name == "on_message_session_end" {
        pending.terminal = Some(event.clone());
    } else {
        if event.conversation_id.is_some() {
            pending.conversation_id = event.conversation_id.clone();
        }
        if event.local_message_id.is_some() {
            pending.local_message_id = event.local_message_id.clone();
        }
        pending.start_observed |=
            event.name == "on_message_session_start" || event.name == "on_message_sending_start";
    }
    if event.selected_skills.is_some() {
        pending.selected_skills = event.selected_skills.clone();
    }
    if event.selected_partners.is_some() {
        pending.selected_partners = event.selected_partners.clone();
    }
    state.pending.set(key, pending);
}
impl DoubaoWorkBody {
    fn schedule_wakeup(&self) {
        let mut wakeup = self.wakeup.lock().unwrap_or_else(|e| e.into_inner());
        if wakeup.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let weak = self.host.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(weak) = weak {
            *wakeup = Some(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Some(host) = weak.upgrade() {
                    host.request_collection();
                }
            }));
        }
    }
    fn defer(&self, shared: &mut Shared, rt: &InputRuntime, error: &DoubaoWorkError) -> bool {
        let reason = if let Some(reason) = error.reason() {
            reason
        } else if let Some(io) = error.as_io() {
            // Preserve ordinary failures as failures. Only source unavailability is deferred.
            let retry = matches!(
                io.kind(),
                std::io::ErrorKind::PermissionDenied
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::ResourceBusy
                    | std::io::ErrorKind::StorageFull
            ) || matches!(
                io.raw_os_error(),
                Some(1 | 5 | 13 | 16 | 23 | 24 | 110 | 116)
            ) || cfg!(windows) && matches!(io.raw_os_error(), Some(5 | 32 | 33 | 1450));
            if !retry {
                return false;
            }
            let code = io.raw_os_error().unwrap_or(-1);
            if shared.reported_io.insert(code) {
                rt.logger.warn(
                    "Doubao Work source I/O unavailable; preserving pending work",
                    json!({"code":code,"reason":"native_io_retry"}).as_object(),
                );
            }
            "native_io_retry"
        } else {
            return false;
        };
        shared.native_deferred = true;
        rt.logger.debug(
            "Doubao Work telemetry work deferred",
            json!({"reason":reason}).as_object(),
        );
        if [
            "cycle_budget",
            "round_queue",
            "source_refresh",
            "source_backlog",
        ]
        .contains(&reason)
        {
            self.schedule_wakeup();
        }
        true
    }
    async fn graph(
        &self,
        shared: &mut Shared,
        conversation: &str,
        job_key: Option<&str>,
        revalidate: bool,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<Option<Arc<NativeGraph>>> {
        if let Some(job) = job_key.and_then(|key| shared.jobs.get(key)) {
            return Ok(Some(job.graph.clone()));
        }
        if !revalidate {
            if let Some(graph) = shared.cycle_graphs.get(conversation) {
                return Ok(graph.clone());
            }
        }
        let graph = shared.reader.graph(conversation, budget).await?;
        shared
            .cycle_graphs
            .insert(conversation.into(), graph.clone());
        Ok(graph)
    }
    #[allow(clippy::too_many_arguments)]
    async fn reconstruct(
        &self,
        shared: &mut Shared,
        key: &str,
        conversation: &str,
        graph: Arc<NativeGraph>,
        actor: &str,
        query_ms: i64,
        end_nano: &str,
        call_ids: &[String],
        scope: &str,
        executions: Option<&[NativeExecution]>,
        budget: &mut DoubaoWorkBudget<'_>,
        rt: &InputRuntime,
    ) -> Result<Option<NativeRoundReconstruction>> {
        let Some(content) = graph.content.as_ref() else {
            shared.jobs.shift_remove(key);
            return Ok(None);
        };
        let version = encode(&json!([
            content.source_versions.get(actor),
            actor,
            query_ms,
            end_nano,
            call_ids,
            scope
        ]));
        if shared
            .jobs
            .get(key)
            .is_some_and(|job| job.version != version)
        {
            shared.jobs.shift_remove(key);
            return Err(DoubaoWorkError::deferred("source_refresh"));
        }
        if !shared.jobs.contains_key(key) {
            let bytes = content.source_bytes.get(actor).copied().unwrap_or(0)
                + content.assignments.get(actor).map_or(0, |rows| {
                    rows.iter().map(|a| a.text.len() * 2).sum::<usize>()
                })
                + 512 * 1024;
            if bytes > 32 * 1024 * 1024 {
                rt.logger.warn(
                    "Doubao Work reconstruction content exceeds bounded cache",
                    json!({"reason":"round_cache_capacity"}).as_object(),
                );
                return Ok(None);
            }
            if shared.jobs.len() >= 4
                || shared.jobs.values().map(|j| j.bytes).sum::<usize>() + bytes > 32 * 1024 * 1024
            {
                return Err(DoubaoWorkError::deferred("round_queue"));
            }
            // Scoped Arc rows retain only this actor. Other actors' transcripts must not be pinned by a paused job.
            let mut scoped = super::content::NativeContent::default();
            scoped.calls.extend(
                content
                    .calls
                    .iter()
                    .filter(|(_, v)| v.actor == actor)
                    .map(|(k, v)| (k.clone(), v.clone())),
            );
            if let Some(v) = content.assignments.get(actor) {
                scoped.assignments.insert(actor.into(), v.clone());
            }
            if let Some(v) = content.last_answers.get(actor) {
                scoped.last_answers.insert(actor.into(), v.clone());
            }
            scoped.transcripts.insert(
                actor.into(),
                content.transcripts.get(actor).cloned().unwrap_or_default(),
            );
            scoped.transcript_offsets.insert(
                actor.into(),
                content.transcript_offsets.get(actor).copied().unwrap_or(0),
            );
            if let Some(v) = content.source_versions.get(actor) {
                scoped.source_versions.insert(actor.into(), v.clone());
            }
            scoped.source_bytes.insert(
                actor.into(),
                content.source_bytes.get(actor).copied().unwrap_or(0),
            );
            // Reader index is immutable and tiny relative to actor text. Limit it to the selected actor.
            if let Some(index) = content.user_rows.as_ref().and_then(|m| m.get(actor)) {
                scoped.user_rows = Some(Arc::new(IndexMap::from([(actor.into(), index.clone())])));
            }
            let scoped = Arc::new(NativeGraph {
                main: graph.main.clone(),
                edges: graph.edges.clone(),
                content: Some(scoped),
            });
            let Some(steps) = NativeRoundSteps::from_graph(
                scoped.clone(),
                actor,
                query_ms,
                end_nano,
                call_ids,
                scope,
            ) else {
                return Ok(None);
            };
            shared.jobs.insert(
                key.into(),
                ReconstructionJob {
                    version,
                    conversation: conversation.into(),
                    bytes,
                    updated_ms: now_ms(),
                    steps: Some(steps),
                    graph: scoped,
                    executions: executions.map(<[NativeExecution]>::to_vec),
                },
            );
        }
        let job = shared.jobs.get_mut(key).unwrap();
        job.updated_ms = now_ms();
        while !budget.exhausted() {
            let next = job.steps.as_mut().unwrap().next_step();
            if let Some(count) = next {
                budget.record(count, count);
                budget.yield_if_needed().await;
            } else {
                let mut job = shared.jobs.shift_remove(key).unwrap();
                return Ok(job.steps.take().and_then(NativeRoundSteps::finish));
            }
        }
        Err(DoubaoWorkError::deferred("cycle_budget"))
    }
    #[allow(clippy::too_many_arguments)]
    async fn complete_request(
        &self,
        shared: &mut Shared,
        state: &mut Checkpoint,
        key: &str,
        pending: &DoubaoPendingTurn,
        entries: &mut Vec<RawEvent>,
        budget: &mut DoubaoWorkBudget<'_>,
        rt: &InputRuntime,
    ) -> anyhow::Result<()> {
        let Some(terminal) = &pending.terminal else {
            return Ok(());
        };
        let matched: Vec<_> = state
            .tools
            .iter()
            .filter(|(_, tool)| {
                tool.start.as_ref().and_then(|s| s.turn_id.as_ref()) == Some(&pending.turn_id)
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let pairs: Vec<_> = matched
            .iter()
            .filter_map(|(_, p)| {
                if p.conflict {
                    None
                } else {
                    Some(DoubaoToolPair {
                        start: p.start.clone()?,
                        end: p.end.clone()?,
                    })
                }
            })
            .collect();
        let mut complete =
            build_doubao_task_events(&self.scope, pending, terminal, now_ms(), &pairs);
        if complete.is_empty() {
            return Ok(());
        }
        let conversation = terminal
            .conversation_id
            .as_ref()
            .or(pending.conversation_id.as_ref());
        if let Some(conversation) = conversation {
            let result = async {
                let job_key = format!("request:{key}");
                let Some(graph) = self
                    .graph(shared, conversation, Some(&job_key), false, budget)
                    .await?
                else {
                    return Ok::<_, DoubaoWorkError>(false);
                };
                for event in &mut complete {
                    set(event, "gen_ai.agent.id", json!(graph.main));
                }
                complete = enrich_native_tool_events(
                    std::mem::take(&mut complete),
                    graph.content.as_ref(),
                );
                let call_ids: Vec<_> = pairs
                    .iter()
                    .filter_map(|p| p.start.tool.as_ref().map(|t| t.id.clone()))
                    .collect();
                let io = native_task_content(
                    graph.content.as_ref(),
                    &graph.main,
                    pending.query_ms,
                    &terminal.time_nano,
                    &call_ids,
                );
                if io.get("input").is_some()
                    && io.get("output").is_none()
                    && now_ms() - pending.updated_ms < 2000
                {
                    return Ok(true);
                }
                attach_io(&mut complete, &io, false);
                let reconstruction = self
                    .reconstruct(
                        shared,
                        &job_key,
                        conversation,
                        graph.clone(),
                        &graph.main,
                        pending.query_ms,
                        &terminal.time_nano,
                        &call_ids,
                        "client_request",
                        None,
                        budget,
                        rt,
                    )
                    .await?;
                if let Some(rounds) = reconstruction {
                    set(
                        &mut complete[0],
                        "agent.doubao_work.assistant_rounds",
                        serde_json::to_value(rounds)?,
                    );
                }
                Ok(false)
            }
            .await;
            match result {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => {
                    if self.defer(shared, rt, &error) {
                        return Ok(());
                    }
                    rt.logger.warn("Doubao Work native content unavailable; emitting only confirmed request metadata",None);
                }
            }
        }
        let emitted_calls: HashSet<String> = complete
            .iter()
            .filter(|e| text(e.get("event.name")) == Some("tool.call"))
            .filter_map(|e| text(e.get("gen_ai.tool.call.id")).map(str::to_owned))
            .collect();
        let omitted = matched.len().saturating_sub(emitted_calls.len());
        if omitted > 0 {
            rt.logger.warn(
                "Doubao Work local tools lack a complete unambiguous in-request boundary; omitted",
                json!({"tools":omitted}).as_object(),
            );
        }
        entries.extend(complete);
        if state
            .roots
            .get(&pending.turn_id)
            .is_none_or(|p| p.query_ms == pending.query_ms)
        {
            let mut root = pending.clone();
            root.conversation_id = conversation.cloned();
            state.roots.set(pending.turn_id.clone(), root);
        }
        state.pending.remove(key);
        state.completed.set(key.into(), now_ms());
        for (key, pair) in matched {
            if pair
                .start
                .as_ref()
                .and_then(|s| s.tool.as_ref())
                .is_some_and(|t| emitted_calls.contains(&t.id))
            {
                state.tools.remove(&key);
            }
        }
        Ok(())
    }
    async fn complete_native(
        &self,
        shared: &mut Shared,
        state: &mut Checkpoint,
        entries: &mut Vec<RawEvent>,
        budget: &mut DoubaoWorkBudget<'_>,
        rt: &InputRuntime,
    ) {
        if !self.has_native {
            return;
        }
        let mut scanned = None::<String>;
        let mut graph = None::<Arc<NativeGraph>>;
        for key in rotated_keys(&state.tools, state.native_scan_cursor.as_deref())
            .into_iter()
            .take(4096)
        {
            if budget.exhausted() {
                self.defer(shared, rt, &DoubaoWorkError::deferred("cycle_budget"));
                break;
            }
            if state.native_completed.contains_key(&key) {
                continue;
            }
            let p = &state.tools[&key];
            if p.conflict {
                continue;
            }
            let (Some(start), Some(end)) = (&p.start, &p.end) else {
                continue;
            };
            let (Some(tool), Some(actor)) = (&start.tool, &start.turn_id) else {
                continue;
            };
            let Some(sandbox) = state
                .sandboxes
                .get(&tool.sandbox_id)
                .filter(|b| !b.conflict && b.actors.contains(actor))
            else {
                continue;
            };
            let roots: Vec<_> = sandbox
                .actors
                .iter()
                .filter(|a| !CHILD_PATTERN.is_match(a))
                .collect();
            if roots.len() != 1 {
                continue;
            }
            let Some(root) = state
                .roots
                .get(roots[0])
                .filter(|r| r.conversation_id.is_some() && r.turn_id != *actor)
                .cloned()
            else {
                continue;
            };
            let conversation = root.conversation_id.as_ref().unwrap();
            if scanned.as_ref().is_some_and(|s| s != conversation) {
                continue;
            }
            let pair = DoubaoToolPair {
                start: start.clone(),
                end: end.clone(),
            };
            let actors = sandbox.actors.clone();
            if scanned.is_none() {
                scanned = Some(conversation.clone());
                state.native_scan_cursor = Some(key.clone());
                match self.graph(shared, conversation, None, true, budget).await {
                    Ok(g) => graph = g,
                    Err(error) => {
                        if !self.defer(shared, rt, &error) {
                            rt.logger.warn("Doubao Work native graph temporarily unavailable; preserving child tools",None);
                        }
                    }
                }
            }
            let Some(graph) = &graph else { continue };
            let mut visited = HashSet::new();
            let mut current = actor.as_str();
            while current != graph.main
                && graph.edges.contains_key(current)
                && actors.iter().any(|s| s == current)
                && visited.insert(current)
            {
                current = &graph.edges[current].parent;
            }
            if current != graph.main {
                continue;
            }
            let fragment = build_native_tool_events(&self.scope, &root, graph, &pair, now_ms());
            if fragment.is_empty() {
                continue;
            }
            let only_tools: Vec<_> = fragment
                .into_iter()
                .filter(|e| matches!(text(e.get("event.name")), Some("tool.call" | "tool.result")))
                .map(|mut event| {
                    set(
                        &mut event,
                        "loongsuite.doubao_work.root_turn_id",
                        json!(root.turn_id),
                    );
                    set(
                        &mut event,
                        "loongsuite.doubao_work.trace_role",
                        json!("log_only"),
                    );
                    event
                })
                .collect();
            let mut observations = enrich_native_tool_events(only_tools, graph.content.as_ref());
            for e in &mut observations {
                remove(e, &["parent_span_id"]);
            }
            entries.extend(observations);
            state.native_completed.set(key, now_ms());
        }
    }

    async fn complete_executions(
        &self,
        shared: &mut Shared,
        state: &mut Checkpoint,
        entries: &mut Vec<RawEvent>,
        budget: &mut DoubaoWorkBudget<'_>,
        rt: &InputRuntime,
    ) -> anyhow::Result<()> {
        if !self.has_native || !self.has_snapshots {
            return Ok(());
        }
        let roots: Vec<_> = state
            .roots
            .values()
            .filter(|r| r.conversation_id.is_some() && r.local_message_id.is_some())
            .cloned()
            .collect();
        let mut conversations: Vec<_> = roots
            .iter()
            .filter_map(|r| r.conversation_id.clone())
            .collect();
        conversations.sort();
        conversations.dedup();
        if conversations.is_empty() {
            return Ok(());
        }
        let after = shared
            .execution_scan_cursor
            .as_ref()
            .or(state.execution_scan_cursor.as_ref())
            .and_then(|c| conversations.iter().position(|s| s == c));
        let resumed = shared
            .jobs
            .iter()
            .find(|(key, job)| {
                key.starts_with("execution:") && conversations.contains(&job.conversation)
            })
            .map(|(key, job)| {
                (
                    key.clone(),
                    job.conversation.clone(),
                    job.graph.clone(),
                    job.executions.clone(),
                )
            });
        let conversation = resumed.as_ref().map(|v| v.1.clone()).unwrap_or_else(|| {
            conversations[after.map_or(0, |i| (i + 1) % conversations.len())].clone()
        });
        shared.execution_scan_cursor = Some(conversation.clone());
        let read=async{
   let executions=if let Some(executions)=resumed.as_ref().and_then(|r|r.3.clone()){executions}else{shared.reader.executions(&conversation,budget).await?};
   if executions.is_empty(){return Ok::<_,DoubaoWorkError>(None)}
   for execution in &executions{if state.executions_completed.get(&execution.execution_key).is_some_and(|p|p.digest!=digest(&encode(execution))){rt.logger.warn("Doubao Work completed native execution changed; not exporting a conflicting span",None);}}
   if !executions.iter().any(|e|e.agent_type!="main_agent"&&e.started_at_ms>=state.since_ms&&!state.executions_completed.contains_key(&e.execution_key)){return Ok(None)}
   let graph=if let Some(r)=&resumed{Some(r.2.clone())}else{self.graph(shared,&conversation,None,true,budget).await?};
   Ok(graph.map(|graph|(executions,graph)))
  }.await;
        let (executions, graph) = match read {
            Ok(Some(v)) => v,
            Ok(None) => return Ok(()),
            Err(error) => {
                if !self.defer(shared, rt, &error) && !error.missing() {
                    rt.logger.warn(
                        "Doubao Work native execution metadata unavailable; preserving checkpoint",
                        None,
                    );
                }
                return Ok(());
            }
        };
        for execution in &executions {
            let job_key = format!("execution:{}", execution.execution_key);
            if resumed.as_ref().is_some_and(|r| r.0 != job_key) {
                continue;
            }
            if budget.exhausted() {
                self.defer(shared, rt, &DoubaoWorkError::deferred("cycle_budget"));
                break;
            }
            if execution.started_at_ms < state.since_ms {
                continue;
            }
            let matched: Vec<_> = roots
                .iter()
                .filter(|root| {
                    root.conversation_id.as_ref() == Some(&execution.conversation_id)
                        && root.local_message_id.as_ref() == Some(&execution.query_message_id)
                })
                .collect();
            if matched.len() != 1 {
                continue;
            }
            let root = matched[0];
            let Some(sandbox) = state.sandboxes.get(&execution.sandbox_id).filter(|b| {
                !b.conflict
                    && b.actors.contains(&root.turn_id)
                    && b.actors.contains(&execution.agent_id)
                    && b.actors
                        .iter()
                        .filter(|s| !CHILD_PATTERN.is_match(s))
                        .count()
                        == 1
            }) else {
                continue;
            };
            if state
                .executions_completed
                .contains_key(&execution.execution_key)
            {
                continue;
            }
            let eligible: Vec<_> = executions
                .iter()
                .filter(|e| {
                    e.started_at_ms >= state.since_ms && sandbox.actors.contains(&e.agent_id)
                })
                .cloned()
                .collect();
            let pairs: Vec<_> = state
                .tools
                .iter()
                .filter_map(|(key, p)| {
                    if p.conflict {
                        return None;
                    }
                    let (start, end) = (p.start.as_ref()?, p.end.as_ref()?);
                    let tool = start.tool.as_ref()?;
                    end.tool.as_ref()?;
                    if start.turn_id.as_ref() != Some(&execution.agent_id)
                        || tool.sandbox_id != execution.sandbox_id
                        || nanos(&start.time_nano)?
                            < i128::from(execution.started_at_ms) * 1_000_000
                        || nanos(&end.time_nano)? > i128::from(execution.ended_at_ms) * 1_000_000
                        || !is_unique_native_tool_owner(
                            execution,
                            &eligible,
                            &start.time_nano,
                            &end.time_nano,
                        )
                    {
                        return None;
                    }
                    Some((
                        key.clone(),
                        DoubaoToolPair {
                            start: start.clone(),
                            end: end.clone(),
                        },
                    ))
                })
                .collect();
            let mut events = build_native_execution_events(
                &self.scope,
                root,
                &graph,
                execution,
                &eligible,
                now_ms(),
            );
            if events.is_empty() {
                continue;
            }
            let first_seen = state
                .execution_first_seen
                .get(&execution.execution_key)
                .copied()
                .unwrap_or_else(now_ms);
            state
                .execution_first_seen
                .set(execution.execution_key.clone(), first_seen);
            state.execution_scan_cursor = Some(conversation.clone());
            let parent = graph
                .edges
                .get(&execution.agent_id)
                .map(|e| e.parent.as_str());
            let Some(terminal) = root.terminal.as_ref() else {
                continue;
            };
            let background = i128::from(execution.ended_at_ms) * 1_000_000
                > nanos(&terminal.time_nano).unwrap_or(0);
            if !background
                && parent != Some(graph.main.as_str())
                && text(events[0].get("loongsuite.doubao_work.parent_resolution"))
                    == Some("root_request_ancestor")
            {
                let has_parent = eligible.iter().any(|e| {
                    Some(e.agent_id.as_str()) == parent
                        && e.query_message_id == execution.query_message_id
                        && e.conversation_id == execution.conversation_id
                        && e.sandbox_id == execution.sandbox_id
                });
                let parent_mutation = state
                    .native_mutation_actors
                    .get(&encode(&json!([execution.sandbox_id, parent])));
                let current_write = parent_mutation
                    .and_then(|v| v.time_nano.as_deref())
                    .filter(|t| t.len() == 19 && t.bytes().all(|b| b.is_ascii_digit()))
                    .and_then(nanos)
                    .is_some_and(|t| {
                        t >= i128::from(root.query_ms) * 1_000_000
                            && t <= nanos(&terminal.time_nano).unwrap_or(0)
                    });
                let grace = if !has_parent && current_write {
                    120_000
                } else {
                    30_000
                };
                if now_ms() - first_seen < grace {
                    continue;
                }
            }
            let call_ids: Vec<_> = pairs
                .iter()
                .filter_map(|(_, p)| p.start.tool.as_ref().map(|t| t.id.clone()))
                .collect();
            let observations = native_tool_observations(
                &pairs.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>(),
                graph.content.as_ref(),
            );
            let end = ms_nanos(execution.ended_at_ms);
            let io = native_task_content(
                graph.content.as_ref(),
                &execution.agent_id,
                root.query_ms,
                &end,
                &call_ids,
            );
            for event in &mut events {
                remove(event, &["gen_ai.turn.id"]);
                remove(event, &["gen_ai.agent.scope"]);
            }
            set(
                &mut events[0],
                "agent.doubao_work.tool_observations",
                json!(observations),
            );
            let reconstruction = self
                .reconstruct(
                    shared,
                    &job_key,
                    &conversation,
                    graph.clone(),
                    &execution.agent_id,
                    root.query_ms,
                    &end,
                    &call_ids,
                    "local_execution_fragment",
                    Some(&executions),
                    budget,
                    rt,
                )
                .await;
            match reconstruction {
                Ok(Some(rounds)) => set(
                    &mut events[0],
                    "agent.doubao_work.assistant_rounds",
                    serde_json::to_value(rounds)?,
                ),
                Ok(None) => {}
                Err(error) => {
                    if self.defer(shared, rt, &error) {
                        break;
                    }
                    return Err(error.into());
                }
            }
            attach_io(&mut events, &io, true);
            entries.extend(events);
            for (key, _) in pairs {
                state.tools.remove(&key);
            }
            state.executions_completed.set(
                execution.execution_key.clone(),
                CompletedExecution {
                    digest: digest(&encode(execution)),
                    updated_ms: now_ms(),
                },
            );
            state.execution_first_seen.remove(&execution.execution_key);
        }
        Ok(())
    }
}
fn attach_io(events: &mut [RawEvent], io: &Value, task: bool) {
    if events.is_empty() {
        return;
    }
    if let Some(input) = io.get("input") {
        if task {
            set(
                &mut events[0],
                "agent.doubao_work.task_input",
                input.clone(),
            );
        }
        set(
            &mut events[0],
            "gen_ai.input.messages_delta",
            json!([{"role":"user","parts":[{"type":"text","content":input}]}]),
        );
    }
    if let Some(output) = io.get("output") {
        if task {
            set(
                &mut events[0],
                "agent.doubao_work.task_output",
                output.clone(),
            );
        }
        let last = events.len() - 1;
        set(
            &mut events[last],
            "gen_ai.output.messages",
            json!([{"role":"assistant","parts":[{"type":"text","content":output}]}]),
        );
    }
}
struct Watcher {
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Watcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn spawn_watcher(dir: &str, host: Weak<HostedInput<DoubaoWorkBody>>) -> Option<Watcher> {
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        let path = CString::new(dir).ok()?;
        // SAFETY: the returned descriptor is immediately owned and is never aliased.
        let raw = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if raw < 0 {
            return None;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let watch = unsafe {
            libc::inotify_add_watch(
                fd.as_raw_fd(),
                path.as_ptr(),
                libc::IN_CREATE | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE | libc::IN_MODIFY,
            )
        };
        if watch < 0 {
            return None;
        }
        // SAFETY: AsyncFd retains the owned nonblocking descriptor throughout every readiness wait.
        let fd = unsafe {
            tokio::io::unix::AsyncFd::register_with_interest(fd, tokio::io::Interest::READABLE)
        }
        .ok()?;
        Some(Watcher {
            task: tokio::spawn(async move {
                loop {
                    let Ok(mut guard) = fd.readable().await else {
                        break;
                    };
                    let mut buffer = [0_u8; 4096];
                    let result = guard.try_io(|fd| {
                        let read = unsafe {
                            libc::read(
                                fd.get_ref().as_raw_fd(),
                                buffer.as_mut_ptr().cast(),
                                buffer.len(),
                            )
                        };
                        if read < 0 {
                            Err(std::io::Error::last_os_error())
                        } else {
                            Ok(read as usize)
                        }
                    });
                    match result {
                        Ok(Ok(0)) => break,
                        Ok(Ok(count)) => {
                            let mut offset = 0;
                            let mut relevant = false;
                            while offset + std::mem::size_of::<libc::inotify_event>() <= count {
                                // SAFETY: bounds cover the fixed header; read_unaligned handles the byte buffer's alignment.
                                let event = unsafe {
                                    std::ptr::read_unaligned(
                                        buffer[offset..].as_ptr().cast::<libc::inotify_event>(),
                                    )
                                };
                                let from = offset + std::mem::size_of::<libc::inotify_event>();
                                let end = from.saturating_add(event.len as usize).min(count);
                                let name = &buffer[from..end];
                                let name = &name
                                    [..name.iter().position(|b| *b == 0).unwrap_or(name.len())];
                                if name.is_empty()
                                    || FILE_PATTERN.is_match(&String::from_utf8_lossy(name))
                                {
                                    relevant = true
                                }
                                if event.mask
                                    & (libc::IN_IGNORED | libc::IN_DELETE_SELF | libc::IN_MOVE_SELF)
                                    != 0
                                {
                                    return;
                                }
                                offset = from + event.len as usize;
                            }
                            if relevant {
                                let Some(host) = host.upgrade() else { break };
                                host.body.schedule_wakeup();
                            }
                        }
                        Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {
                            continue
                        }
                        Ok(Err(_)) => break,
                        Err(_) => continue,
                    }
                }
            }),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (dir, host);
        None
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod input_tests;
