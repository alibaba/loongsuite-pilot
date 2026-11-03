//! Codex rollout transcript collector.
//!
//! Port of `codex-transcript-input.ts`. Hook JSONL stays in `codex-log`. This
//! input tails `~/.codex/sessions/**/rollout-*.jsonl`, rebuilds turns from the
//! append-only transcript, and checkpoints byte offsets in `extra.codexTranscript`.
//! Entries are emitted in bounded batches during `collect` (the TypeScript
//! collector returns an empty array after `emit('entries')`).

mod engine;
mod source_ownership;
mod wakeup;
use wakeup::{WakeupState, WakeupWatcher};

use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use crate::checkpoints::StateStore;
use crate::inputs::base::{HostedInput, InputBody, InputRuntime};
use crate::multimodal::uploader::{LruMap, MULTIMODAL_LRU_LIMIT};
use crate::multimodal::MultimodalProcessor;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod, MultimodalUploadMode};
use crate::utils::{directory_exists, ensure_dir, resolve_home, DEFAULT_POLL_INTERVAL_MS};

use super::subagent_linker::{
    CodexSubagentLinkSnapshot, CodexSubagentLinker, MAX_LINK_DESCRIPTORS,
};
use super::types::CodexTranscriptMeta;

use engine::CodexTranscriptEngine;

const DEFAULT_SESSION_DIR: &str = "~/.codex/sessions";
pub(super) const HISTORICAL_ROLLOUT_RECHECK_MS: i64 = 30_000;

pub struct CodexMultimodalOptions {
    pub enabled: bool,
    pub upload_mode: Option<MultimodalUploadMode>,
    pub processor: Option<Arc<MultimodalProcessor>>,
}

pub struct CodexTranscriptInputOptions {
    pub state_store: Arc<StateStore>,
    pub session_dir: Option<String>,
    pub wakeup_dir: Option<String>,
    pub span_context_dir: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub multimodal: Option<CodexMultimodalOptions>,
}

pub struct CodexTranscriptInput {
    pub inner: Arc<HostedInput<CodexTranscriptBody>>,
}

type BatchHandler = Arc<dyn Fn(&[AgentActivityEntry]) + Send + Sync>;

pub(super) struct CachedMeta {
    pub inode: u64,
    pub file_size: i64,
    pub owner_offset: i64,
    pub meta: CodexTranscriptMeta,
    pub estimated_bytes: usize,
    pub last_seen_at_ms: i64,
}

#[derive(Clone, Copy)]
pub(super) struct RolloutStat {
    pub ino: u64,
    pub size: i64,
    pub mtime_ms: i64,
}

pub(super) struct CachedDefault {
    pub(super) dir_mtimes: Vec<(String, i64)>,
    pub(super) files: Vec<String>,
}

pub(super) struct Shared {
    pub linker: CodexSubagentLinker,
    pub delivered_invocations: std::collections::BTreeSet<String>,
    pub pending_agent_results: IndexMap<String, super::invocation_audit::PendingAgentResult>,
    pub reported: IndexMap<String, String>,
    pub last_summary: String,
    pub last_wakeup_cleanup_at: i64,
    pub last_dynamic_warn_at: i64,
    pub last_span_cleanup_at: i64,
    pub meta_by_path: IndexMap<String, CodexTranscriptMeta>,
    pub path_by_thread: IndexMap<String, String>,
    pub meta_cache: IndexMap<String, CachedMeta>,
    pub meta_cache_bytes: usize,
    pub idle: IndexMap<String, RolloutStat>,
    pub incomplete_tails: IndexMap<String, super::scan::IncompleteJsonlTail>,
    pub last_historical_stat_at: i64,
    pub cached_default: Option<CachedDefault>,
    wakeup: WakeupState,
    #[cfg(test)]
    pub main541_discoveries: usize,
    #[cfg(test)]
    pub main541_visits: Vec<String>,
    #[cfg(test)]
    pub main541_retries: usize,
}

#[cfg(test)]
#[derive(Clone)]
struct CodexInitializationWait {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

pub struct CodexTranscriptBody {
    pub(super) session_dir: String,
    pub(super) wakeup_dir: String,
    pub(super) span_context_dir: String,
    pub(super) include_multimodal: bool,
    pub(super) upload_mode: MultimodalUploadMode,
    pub(super) processor: Option<Arc<MultimodalProcessor>>,
    pub(super) uri_cache: Mutex<LruMap<crate::multimodal::types::UriResult>>,
    pub(super) shared: Mutex<Shared>,
    batch_handlers: Mutex<Vec<BatchHandler>>,
    host: Mutex<Option<Weak<HostedInput<CodexTranscriptBody>>>>,
    watcher_stop: Mutex<Option<WakeupWatcher>>,
    wakeup_signal: Arc<tokio::sync::Notify>,
    #[cfg(test)]
    initialization_wait: Mutex<Option<CodexInitializationWait>>,
}

impl CodexTranscriptInput {
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

    pub fn new(opts: CodexTranscriptInputOptions) -> Self {
        let multimodal = opts.multimodal;
        let processor = multimodal.as_ref().and_then(|item| item.processor.clone());
        let include = multimodal.as_ref().is_some_and(|item| item.enabled) && processor.is_some();
        let upload_mode = multimodal
            .as_ref()
            .and_then(|item| item.upload_mode)
            .unwrap_or(MultimodalUploadMode::None);
        let body = CodexTranscriptBody {
            session_dir: opts
                .session_dir
                .unwrap_or_else(|| resolve_home(DEFAULT_SESSION_DIR)),
            wakeup_dir: opts.wakeup_dir.unwrap_or_else(default_wakeup_dir),
            span_context_dir: opts
                .span_context_dir
                .unwrap_or_else(default_span_context_dir),
            include_multimodal: include,
            upload_mode,
            processor: if include { processor } else { None },
            uri_cache: Mutex::new(LruMap::new(MULTIMODAL_LRU_LIMIT).expect("lru")),
            shared: Mutex::new(Shared {
                linker: CodexSubagentLinker::new(),
                delivered_invocations: Default::default(),
                pending_agent_results: Default::default(),
                reported: IndexMap::new(),
                last_summary: String::new(),
                last_wakeup_cleanup_at: 0,
                last_dynamic_warn_at: 0,
                last_span_cleanup_at: 0,
                meta_by_path: IndexMap::new(),
                path_by_thread: IndexMap::new(),
                meta_cache: IndexMap::new(),
                meta_cache_bytes: 0,
                idle: IndexMap::new(),
                incomplete_tails: IndexMap::new(),
                last_historical_stat_at: 0,
                cached_default: None,
                wakeup: WakeupState::default(),
                #[cfg(test)]
                main541_discoveries: 0,
                #[cfg(test)]
                main541_visits: Vec::new(),
                #[cfg(test)]
                main541_retries: 0,
            }),
            batch_handlers: Mutex::new(Vec::new()),
            host: Mutex::new(None),
            watcher_stop: Mutex::new(None),
            wakeup_signal: Arc::new(tokio::sync::Notify::new()),
            #[cfg(test)]
            initialization_wait: Mutex::new(None),
        };
        let inner = HostedInput::new(
            body,
            "CodexTranscriptInput",
            opts.state_store,
            opts.poll_interval_ms.or(Some(DEFAULT_POLL_INTERVAL_MS)),
        );
        *inner
            .body
            .host
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(Arc::downgrade(&inner));
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
    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }
    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }
    pub async fn run_cycle(&self) {
        self.inner.run_cycle().await;
    }
    pub fn request_collection(&self) {
        self.inner.request_collection();
    }

    /// Registers the batch listener used by the collector. `collect` emits
    /// bounded batches itself and returns no entries to [`HostedInput`].
    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }

    pub fn on_entries(&self, handler: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static) {
        self.inner
            .body
            .batch_handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(Arc::new(handler));
    }

    pub fn subagent_link_snapshot(&self) -> CodexSubagentLinkSnapshot {
        self.inner
            .body
            .shared
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .linker
            .snapshot()
    }

    pub fn watch_paths(wakeup_dir: Option<&str>, session_dir: Option<&str>) -> Vec<String> {
        vec![
            session_dir
                .map(str::to_owned)
                .unwrap_or_else(|| resolve_home(DEFAULT_SESSION_DIR)),
            wakeup_dir
                .map(str::to_owned)
                .unwrap_or_else(default_wakeup_dir),
        ]
    }

    pub async fn check_availability(wakeup_dir: Option<&str>, session_dir: Option<&str>) -> bool {
        let session = session_dir
            .map(str::to_owned)
            .unwrap_or_else(|| resolve_home(DEFAULT_SESSION_DIR));
        if directory_exists(&session).await {
            return true;
        }
        let wakeup = wakeup_dir
            .map(str::to_owned)
            .unwrap_or_else(default_wakeup_dir);
        let mut entries = match tokio::fs::read_dir(&wakeup).await {
            Ok(entries) => entries,
            Err(_) => return false,
        };
        let mut names = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_name().to_string_lossy().ends_with(".json") {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        names.sort_by(|left, right| right.cmp(left));
        names.truncate(super::discovery::MAX_WAKEUP_MARKERS_FOR_DISCOVERY);
        let now = super::utils::now_ms() as i64;
        for name in names {
            let roots = super::discovery::read_codex_wakeup_roots(
                &Path::new(&wakeup).join(name).to_string_lossy(),
                now,
            )
            .await;
            for candidate in roots.into_iter().flatten() {
                if directory_exists(&candidate).await {
                    return true;
                }
            }
        }
        false
    }
}

pub fn codex_default_allowed_root_paths() -> Vec<String> {
    vec![resolve_home("~/.codex")]
}

pub fn default_wakeup_dir() -> String {
    let data = std::env::var("LOONGSUITE_PILOT_DATA_DIR")
        .unwrap_or_else(|_| resolve_home("~/.loongsuite-pilot"));
    Path::new(&data)
        .join("state")
        .join("codex")
        .join("transcript-wakeups")
        .to_string_lossy()
        .into_owned()
}

pub fn default_span_context_dir() -> String {
    let data = std::env::var("LOONGSUITE_PILOT_DATA_DIR")
        .unwrap_or_else(|_| resolve_home("~/.loongsuite-pilot"));
    Path::new(&data)
        .join("state")
        .join("codex")
        .join("transcript-span-contexts")
        .to_string_lossy()
        .into_owned()
}

#[async_trait]
impl InputBody for CodexTranscriptBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "codex-transcript"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::CodexCliHook
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        // A restart must baseline the actual directory generation before any
        // output; equal directory timestamps do not prove equal inventories.
        self.with_shared(|shared| shared.cached_default = None);
        self.engine().restore_delegation_state(rt);
        self.engine().discard_legacy_global_turn_registry(rt);
        let discovered = self.engine().discover_session_files().await;
        self.engine()
            .index_discovered_transcript_owners(rt, &discovered, None)
            .await?;
        for file in &discovered {
            if !file.baseline_on_start {
                continue;
            }
            let key = self.engine().state_key(&file.file_path);
            let meta = self.with_shared(|shared| shared.meta_by_path.get(&file.file_path).cloned());
            let needed = meta.as_ref().is_some_and(|meta| {
                meta.depth == 1
                    && meta.parent_thread_id.as_ref().is_some_and(|parent| {
                        self.engine().has_pending_fusion_for_parent(rt, parent)
                    })
            });
            if needed
                || self.engine().read_checkpoint(rt, &key).is_some()
                || rt.state_store.get(&key).last_offset().is_some()
            {
                continue;
            }
            // Live ownership survives a failed first output, without advancing
            // canonical offsets or supplying firstOwned to copied-history bootstrap.
            if let Some(floor) =
                source_ownership::baseline_floor(&self.wakeup_dir, &file.file_path).await?
            {
                if floor.copied {
                    self.engine()
                        .restore_fork_baseline(rt, &file.file_path, &key, floor)
                        .await?;
                } else {
                    self.engine()
                        .restore_baseline_file(rt, &file.file_path, &key, floor)
                        .await?;
                }
                continue;
            }
            if source_ownership::was_live(&self.wakeup_dir, &file.file_path).await? {
                continue;
            }
            if engine::has_copied_history_prefix(meta.as_ref()) {
                self.engine()
                    .park_fork_baseline(rt, &file.file_path, &key)
                    .await?;
            } else {
                self.engine()
                    .baseline_file(rt, &file.file_path, &key)
                    .await?;
            }
        }
        ensure_dir(&self.wakeup_dir).await;
        ensure_dir(&self.span_context_dir).await;
        self.start_wakeup_watcher(rt);
        #[cfg(test)]
        {
            let wait = self
                .initialization_wait
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone();
            if let Some(wait) = wait {
                wait.entered.notify_one();
                wait.release.notified().await;
            }
        }
        Ok(())
    }

    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        self.stop_wakeup_watcher().await;
        if let Ok(mut cache) = self.uri_cache.lock() {
            cache.clear();
        }
        self.with_shared(|shared| {
            shared.wakeup = WakeupState::default();
            shared.meta_cache.clear();
            shared.incomplete_tails.clear();
            shared.meta_cache_bytes = 0;
        });
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let now = super::utils::now_ms() as i64;
        let plan = self.with_shared(|shared| {
            shared
                .wakeup
                .take(tokio::time::Instant::now(), rt.poll_interval_ms())
        });
        self.engine().cleanup_expired_span_contexts(rt, now).await;
        let mut discovered;
        let mut skip = std::collections::HashSet::new();
        if plan.full {
            // Full collection owns rediscovery. Coarse or restored directory
            // clocks must not hide new rollouts; targeted wakeups retain the
            // existing direct-path fast path and all owner/body caches.
            self.with_shared(|shared| shared.cached_default = None);
            discovered = self.engine().discover_session_files().await;
            let paths: std::collections::HashSet<String> = discovered
                .iter()
                .map(|file| file.file_path.clone())
                .collect();
            self.with_shared(|shared| {
                shared.wakeup.last_full_scan_at = Some(tokio::time::Instant::now());
                shared.idle.retain(|path, _| paths.contains(path));
            });
            skip = self.engine().historical_skip_paths(&discovered, now);
            if self.with_shared(|shared| shared.wakeup.discovery_pending) {
                skip.clear();
            }
            for path in &plan.targeted {
                skip.remove(path);
            }
            self.engine()
                .index_discovered_transcript_owners(rt, &discovered, Some(&skip))
                .await?;
            self.with_shared(|shared| {
                shared.wakeup.paths.clear();
                for file in &discovered {
                    if let Some(meta) = shared.meta_by_path.get(&file.file_path) {
                        let marker = format!(
                            "{}.json",
                            super::discovery::safe_wakeup_session_part(&meta.thread_id)
                        );
                        shared
                            .wakeup
                            .paths
                            .entry(marker)
                            .or_default()
                            .insert(file.file_path.clone());
                    }
                }
                if shared.wakeup.discovery_revision == plan.revision {
                    shared.wakeup.discovery_pending = false;
                }
            });
        } else {
            discovered = plan
                .targeted
                .into_iter()
                .map(|file_path| super::discovery::DiscoveredSessionFile {
                    file_path,
                    baseline_on_start: false,
                })
                .collect();
            self.engine()
                .index_targeted_transcript_owners(rt, &discovered)
                .await?;
        }
        discovered.sort_by(|left, right| {
            let left_depth = self.with_shared(|shared| {
                shared
                    .meta_by_path
                    .get(&left.file_path)
                    .map(|meta| meta.depth)
                    .unwrap_or(0)
            });
            let right_depth = self.with_shared(|shared| {
                shared
                    .meta_by_path
                    .get(&right.file_path)
                    .map(|meta| meta.depth)
                    .unwrap_or(0)
            });
            left_depth
                .cmp(&right_depth)
                .then_with(|| left.file_path.cmp(&right.file_path))
        });
        let mut emitted = 0usize;
        for file in &discovered {
            if skip.contains(&file.file_path) {
                continue;
            }
            emitted += self.engine().process_file(rt, &file.file_path).await?;
        }
        if plan.full {
            emitted += self.engine().retry_pending_agent_results(rt).await?;
        }
        self.engine().save_delegation_state(rt);
        self.engine().report_subagent_links(rt);
        if emitted > 0 {
            let meta = json!({ "count": emitted });
            rt.debug("cycle produced entries", meta.as_object());
        }
        Ok(Vec::new())
    }
}

impl CodexTranscriptBody {
    fn engine(&self) -> CodexTranscriptEngine<'_> {
        CodexTranscriptEngine { body: self }
    }

    pub(super) fn with_shared<R>(&self, f: impl FnOnce(&mut Shared) -> R) -> R {
        let mut guard = self.shared.lock().unwrap_or_else(|err| err.into_inner());
        f(&mut guard)
    }

    pub(super) fn emit_batches(&self, entries: Vec<AgentActivityEntry>) -> usize {
        let handlers = self
            .batch_handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        let mut emitted = 0usize;
        let mut batch = Vec::new();
        let mut batch_bytes = 0usize;
        for entry in entries {
            let entry_bytes = serde_json::to_vec(&entry)
                .map(|bytes| bytes.len())
                .unwrap_or(engine::MAX_EMIT_BATCH_BYTES);
            if !batch.is_empty()
                && (batch.len() >= engine::MAX_EMIT_BATCH_ENTRIES
                    || batch_bytes + entry_bytes > engine::MAX_EMIT_BATCH_BYTES)
            {
                flush_batch(&handlers, &mut batch, &mut batch_bytes, &mut emitted);
            }
            batch.push(entry);
            batch_bytes += entry_bytes;
        }
        flush_batch(&handlers, &mut batch, &mut batch_bytes, &mut emitted);
        emitted
    }

    fn start_wakeup_watcher(&self, rt: &InputRuntime) {
        let Some(host) = self
            .host
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
        else {
            return;
        };
        match wakeup::spawn_wakeup_watcher(&self.wakeup_dir, host, self.wakeup_signal.clone()) {
            Some(stop) => {
                *self
                    .watcher_stop
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) = Some(stop);
            }
            None => {
                let meta = json!({ "wakeupDir": self.wakeup_dir });
                rt.warn(
                    "failed to watch Codex wakeup directory; polling remains active",
                    meta.as_object(),
                );
            }
        }
    }

    async fn stop_wakeup_watcher(&self) {
        let watcher = self
            .watcher_stop
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take();
        if let Some(watcher) = watcher {
            watcher.stop().await;
        }
    }
}

fn flush_batch(
    handlers: &[BatchHandler],
    batch: &mut Vec<AgentActivityEntry>,
    batch_bytes: &mut usize,
    emitted: &mut usize,
) {
    if batch.is_empty() {
        return;
    }
    for entry in batch.iter_mut() {
        crate::multimodal::attach_multimodal_metadata_for_entry(entry);
    }
    for handler in handlers {
        handler(batch);
    }
    *emitted += batch.len();
    batch.clear();
    *batch_bytes = 0;
}

#[allow(dead_code)]
fn _link_cap() -> usize {
    MAX_LINK_DESCRIPTORS
}

#[allow(dead_code)]
fn _map_hint(value: &Map<String, Value>) -> usize {
    value.len()
}
