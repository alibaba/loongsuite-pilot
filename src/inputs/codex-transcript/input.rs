//! Codex rollout transcript collector.
//!
//! Port of `codex-transcript-input.ts`. Hook JSONL stays in `codex-log`. This
//! input tails `~/.codex/sessions/**/rollout-*.jsonl`, rebuilds turns from the
//! append-only transcript, and checkpoints byte offsets in `extra.codexTranscript`.
//! Entries are emitted in bounded batches during `collect` (the TypeScript
//! collector returns an empty array after `emit('entries')`).

mod engine;
mod source_ownership;

use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
#[cfg(target_os = "linux")]
use std::time::Duration;

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
            }),
            batch_handlers: Mutex::new(Vec::new()),
            host: Mutex::new(None),
            watcher_stop: Mutex::new(None),
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
            shared.meta_cache.clear();
            shared.incomplete_tails.clear();
            shared.meta_cache_bytes = 0;
        });
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let now = super::utils::now_ms() as i64;
        self.engine().cleanup_expired_span_contexts(rt, now).await;
        let mut discovered = self.engine().discover_session_files().await;
        let paths: std::collections::HashSet<String> = discovered
            .iter()
            .map(|file| file.file_path.clone())
            .collect();
        self.with_shared(|shared| {
            shared.idle.retain(|path, _| paths.contains(path));
        });
        let skip = self.engine().historical_skip_paths(&discovered, now);
        self.engine()
            .index_discovered_transcript_owners(rt, &discovered, Some(&skip))
            .await?;
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
        emitted += self.engine().retry_pending_agent_results(rt).await?;
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
        match spawn_wakeup_watcher(&self.wakeup_dir, host) {
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

struct WakeupWatcher {
    task: tokio::task::JoinHandle<()>,
}

impl WakeupWatcher {
    async fn stop(mut self) {
        // abort 唤醒空闲的 readable 等待；等待任务回收以保证描述符已释放。
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for WakeupWatcher {
    fn drop(&mut self) {
        // 输入被直接丢弃或停止 Future 被取消时也不能留下脱离生命周期的监听。
        self.task.abort();
    }
}

fn spawn_wakeup_watcher(
    dir: &str,
    host: Weak<HostedInput<CodexTranscriptBody>>,
) -> Option<WakeupWatcher> {
    #[cfg(target_os = "linux")]
    {
        spawn_inotify_watcher(dir, move || {
            if let Some(host) = host.upgrade() {
                host.request_collection();
            }
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (dir, host);
        None
    }
}

#[cfg(target_os = "linux")]
fn spawn_inotify_watcher(
    dir: &str,
    on_change: impl Fn() + Send + 'static,
) -> Option<WakeupWatcher> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let path = CString::new(dir).ok()?;
    let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    if fd < 0 {
        return None;
    }
    // 描述符自创建起由 OwnedFd 唯一持有；后续任意失败出口自动关闭。
    let file = unsafe { OwnedFd::from_raw_fd(fd) };
    let watch = unsafe {
        libc::inotify_add_watch(
            file.as_raw_fd(),
            path.as_ptr(),
            libc::IN_CREATE | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE | libc::IN_MODIFY,
        )
    };
    if watch < 0 {
        return None;
    }
    // 安全性：OwnedFd 在 AsyncFd 的整个生命周期内既不替换也不提前关闭。
    let async_fd = unsafe {
        tokio::io::unix::AsyncFd::register_with_interest(file, tokio::io::Interest::READABLE)
    }
    .ok()?;
    let task = tokio::spawn(async move {
        loop {
            let mut guard = match async_fd.readable().await {
                Ok(guard) => guard,
                Err(_) => break,
            };
            let mut buf = [0u8; 4096];
            let result = guard.try_io(|fd| {
                let n = unsafe {
                    libc::read(fd.get_ref().as_raw_fd(), buf.as_mut_ptr().cast(), buf.len())
                };
                if n < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(n)
                }
            });
            // 只在 WouldBlock 时清除就绪；否则队列超过一个缓冲区时会丢失后续唤醒。
            match result {
                Ok(Ok(0)) => break,
                Ok(Ok(_)) => on_change(),
                Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(Err(_)) => break,
                Err(_) => continue,
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    Some(WakeupWatcher { task })
}

#[cfg(all(test, target_os = "linux"))]
mod watcher_tests {
    use super::*;

    #[tokio::test]
    async fn idle_watcher_stops_and_drop_reaps_without_another_filesystem_event() {
        let root = tempfile::tempdir().unwrap();
        let watcher = spawn_inotify_watcher(root.path().to_str().unwrap(), || {}).unwrap();
        let task = watcher.task.abort_handle();
        tokio::task::yield_now().await;
        tokio::time::timeout(Duration::from_secs(2), watcher.stop())
            .await
            .unwrap();
        assert!(task.is_finished());
        let watcher = spawn_inotify_watcher(root.path().to_str().unwrap(), || {}).unwrap();
        let task = watcher.task.abort_handle();
        tokio::task::yield_now().await;
        drop(watcher);
        tokio::time::timeout(Duration::from_secs(2), async {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn watcher_drains_bursts_and_can_restart_on_the_same_unicode_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("唤醒 空格 🐉");
        std::fs::create_dir(&dir).unwrap();
        for round in 0..2 {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let watcher = spawn_inotify_watcher(dir.to_str().unwrap(), move || {
                let _ = tx.send(());
            })
            .unwrap();
            // 每个独立名称产生不同事件，队列总量超过一次 4096 字节读取。
            for index in 0..160 {
                std::fs::write(dir.join(format!("marker-{round}-{index}.json")), "{}").unwrap();
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                for _ in 0..2 {
                    rx.recv().await.unwrap();
                }
            })
            .await
            .unwrap();
            watcher.stop().await;
            while rx.try_recv().is_ok() {}
            assert!(rx.recv().await.is_none());
        }
    }

    #[tokio::test]
    async fn invalid_wakeup_directory_does_not_create_a_task() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            spawn_inotify_watcher(root.path().join("missing").to_str().unwrap(), || {}).is_none()
        );
        assert!(spawn_inotify_watcher("bad\0path", || {}).is_none());
    }
}

#[allow(dead_code)]
fn _link_cap() -> usize {
    MAX_LINK_DESCRIPTORS
}

#[allow(dead_code)]
fn _map_hint(value: &Map<String, Value>) -> usize {
    value.len()
}
