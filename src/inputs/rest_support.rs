//! Local stand-in for `src/inputs/base` hook and session readers.
//!
//! `crate::inputs::base` was not present while these inputs were ported. The
//! offset rules, partial-line checkpoint, and canonical hook transform match
//! `base-hook-input.ts`, `base-session-input.ts`, `hook-record-transform.ts`,
//! and `canonical-hook-record.ts`. Workspace-policy filtering and
//! `input-runtime-delta` emission stay with the base port.

use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Notify;

use crate::checkpoints::{InputState, InputStatePatch, StateStore};
use crate::normalization::{
    build_agent_activity_entry, enrich_canonical_entry_with_git, is_reserved_key,
    normalize_event_name,
};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{
    create_logger, ensure_dir, get_today_date_string, resolve_home, resolve_poll_interval_ms,
    BoundLogger, DEFAULT_POLL_INTERVAL_MS,
};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type TransformFn = Arc<
    dyn Fn(Map<String, Value>) -> BoxFuture<Result<Option<AgentActivityEntry>, String>>
        + Send
        + Sync,
>;
pub type LineFn = Arc<
    dyn Fn(Map<String, Value>, String) -> BoxFuture<Result<Option<AgentActivityEntry>, String>>
        + Send
        + Sync,
>;
type Listener = Arc<dyn Fn(&[AgentActivityEntry]) + Send + Sync>;
type CollectFn = Arc<dyn Fn() -> BoxFuture<Result<Vec<AgentActivityEntry>, String>> + Send + Sync>;
type HookFn = Arc<dyn Fn() -> BoxFuture<()> + Send + Sync>;

const OFFSET_MAP_EXTRA_KEY: &str = "hookLogOffsets";
const RECENT_LOG_FILE_LIMIT: usize = 3;
const OWNERSHIP_WARN_CAP: usize = 512;

static HOOK_DATE_FILE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}\.jsonl$").expect("hook date file"));
static SENSITIVE_FIELD_NAME: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(
        r"(?i)(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$",
    )
    .expect("sensitive field")
});

const CANONICAL_PREFIXES: &[&str] = &[
    "agent.",
    "error.",
    "gen_ai.",
    "git.",
    "host.",
    "service.",
    "workspace.",
];
const CANONICAL_KEYS: &[&str] = &[
    "event.id",
    "event.name",
    "observed_time_unix_nano",
    "parent_span_id",
    "span_id",
    "time_unix_nano",
    "resourceAttributes",
    "tool.result.status",
    "trace_id",
    "user.id",
    "user.name",
    "user.email",
];
const MAX_CUSTOM_FIELD_VALUE_LENGTH: usize = 512;

/// Options shared by hook JSONL inputs. `state_store` is required.
#[derive(Clone)]
pub struct HookInputOptions {
    pub state_store: Arc<StateStore>,
    pub log_dir: Option<String>,
    pub log_prefix: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

pub struct HookInputProfile<'a> {
    pub logger_name: &'static str,
    pub id: &'static str,
    pub agent_type: ClientType,
    pub default_dir: &'a str,
    pub default_prefix: &'a str,
    pub git_namespace: &'static str,
    pub cold_start_keep_last_turn_only: bool,
}

pub struct HookJsonlConfig {
    pub logger_name: &'static str,
    pub id: &'static str,
    pub agent_type: ClientType,
    pub log_dir: String,
    pub log_prefix: String,
    pub poll_interval_ms: u64,
    pub state_store: Arc<StateStore>,
    pub cold_start_keep_last_turn_only: bool,
    pub private_log_dir: bool,
    pub cursor_first_run_guard: bool,
    pub transform: TransformFn,
}

pub struct HookJsonlInput {
    inner: Arc<HookInner>,
    poll: PollLoop,
}

struct HookInner {
    id: &'static str,
    agent_type: ClientType,
    log_dir: String,
    log_prefix: String,
    state_store: Arc<StateStore>,
    logger: BoundLogger,
    cold_start_keep_last_turn_only: bool,
    private_log_dir: bool,
    cursor_first_run_guard: bool,
    transform: TransformFn,
}

impl HookJsonlInput {
    pub fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        crate::inputs::base::InputRuntimeInfo {
            poll_interval_ms: self.poll.interval_ms(),
            source_paths: vec![self.inner.log_dir.clone()],
        }
    }

    pub fn new(config: HookJsonlConfig) -> Self {
        let logger = create_logger(config.logger_name);
        let poll = PollLoop::new(
            config.poll_interval_ms,
            logger.clone(),
            Arc::clone(&config.state_store),
        );
        let inner = Arc::new(HookInner {
            id: config.id,
            agent_type: config.agent_type,
            log_dir: config.log_dir,
            log_prefix: config.log_prefix,
            state_store: config.state_store,
            logger,
            cold_start_keep_last_turn_only: config.cold_start_keep_last_turn_only,
            private_log_dir: config.private_log_dir,
            cursor_first_run_guard: config.cursor_first_run_guard,
            transform: config.transform,
        });
        Self { inner, poll }
    }

    pub fn shared(profile: HookInputProfile<'_>, opts: HookInputOptions) -> Self {
        let HookInputProfile {
            logger_name,
            id,
            agent_type,
            default_dir,
            default_prefix,
            git_namespace,
            cold_start_keep_last_turn_only,
        } = profile;
        Self::new(HookJsonlConfig {
            logger_name,
            id,
            agent_type,
            log_dir: opts.log_dir.unwrap_or_else(|| resolve_home(default_dir)),
            log_prefix: opts
                .log_prefix
                .unwrap_or_else(|| default_prefix.to_string()),
            poll_interval_ms: resolve_poll_interval_ms(
                opts.poll_interval_ms,
                DEFAULT_POLL_INTERVAL_MS,
            ),
            state_store: opts.state_store,
            cold_start_keep_last_turn_only,
            private_log_dir: false,
            cursor_first_run_guard: false,
            transform: shared_hook_transform(agent_type, git_namespace),
        })
    }

    pub fn id(&self) -> &'static str {
        self.inner.id
    }

    pub fn agent_type(&self) -> ClientType {
        self.inner.agent_type
    }

    pub fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }

    pub fn log_dir(&self) -> &str {
        &self.inner.log_dir
    }

    pub fn log_prefix(&self) -> &str {
        &self.inner.log_prefix
    }

    pub fn state_store(&self) -> &Arc<StateStore> {
        &self.inner.state_store
    }

    pub fn running(&self) -> bool {
        self.poll.running()
    }

    pub fn on_entries<F>(&self, listener: F)
    where
        F: Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
    {
        self.poll.on_entries(listener);
    }

    pub async fn start(&self) {
        let inner = Arc::clone(&self.inner);
        let inner_collect = Arc::clone(&self.inner);
        self.poll
            .start(
                box_hook(move || {
                    let inner = Arc::clone(&inner);
                    async move { inner.on_start().await }
                }),
                box_collect(move || {
                    let inner = Arc::clone(&inner_collect);
                    async move { inner.collect().await }
                }),
                box_hook(|| async {}),
            )
            .await;
    }

    pub async fn stop(&self) {
        self.poll.stop().await;
    }

    pub async fn collect_entries(&self) -> Result<Vec<AgentActivityEntry>, String> {
        self.inner.collect().await
    }
}

impl HookInner {
    async fn on_start(&self) {
        if self.private_log_dir {
            ensure_private_dir(&self.log_dir).await;
        } else {
            ensure_dir(&self.log_dir).await;
        }
    }

    async fn collect(&self) -> Result<Vec<AgentActivityEntry>, String> {
        if self.cursor_first_run_guard {
            cursor_first_run_guard(self).await;
        }
        collect_hook_files(self).await
    }
}

pub fn shared_hook_transform(agent_type: ClientType, git_namespace: &'static str) -> TransformFn {
    Arc::new(move |record| {
        Box::pin(async move { transform_hook_record(&record, agent_type, git_namespace).await })
            as BoxFuture<_>
    })
}

pub async fn ensure_private_dir(path: &str) {
    let _ = tokio::fs::create_dir_all(path).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
}

/// `dataDir || LOONGSUITE_PILOT_DATA_DIR || ~/.loongsuite-pilot`, then `logs/<name>`.
pub fn resolve_pilot_log_dir(data_dir: Option<&str>, log_name: &str) -> String {
    let base = match data_dir.map(str::trim).filter(|value| !value.is_empty()) {
        Some(dir) => resolve_home(dir),
        None => match std::env::var("LOONGSUITE_PILOT_DATA_DIR") {
            Ok(value) if !value.trim().is_empty() => resolve_home(value.trim()),
            _ => resolve_home("~/.loongsuite-pilot"),
        },
    };
    Path::new(&base)
        .join("logs")
        .join(log_name)
        .to_string_lossy()
        .to_string()
}

pub(crate) fn box_hook<F, Fut>(function: F) -> HookFn
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    Arc::new(move || Box::pin(function()) as BoxFuture<()>)
}

pub(crate) fn box_collect<F, Fut>(function: F) -> CollectFn
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Vec<AgentActivityEntry>, String>> + Send + 'static,
{
    Arc::new(move || Box::pin(function()) as BoxFuture<_>)
}

struct PollInner {
    poll: Duration,
    logger: BoundLogger,
    state_store: Arc<StateStore>,
    running: AtomicBool,
    listeners: Mutex<Vec<Listener>>,
    cycle: tokio::sync::Mutex<()>,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    shutdown: Notify,
    on_stop: Mutex<Option<HookFn>>,
    collect: Mutex<Option<CollectFn>>,
}

#[derive(Clone)]
pub struct PollLoop {
    inner: Arc<PollInner>,
}

impl PollLoop {
    pub fn interval_ms(&self) -> u64 {
        self.inner.poll.as_millis() as u64
    }

    pub fn new(poll_interval_ms: u64, logger: BoundLogger, state_store: Arc<StateStore>) -> Self {
        Self {
            inner: Arc::new(PollInner {
                poll: Duration::from_millis(poll_interval_ms),
                logger,
                state_store,
                running: AtomicBool::new(false),
                listeners: Mutex::new(Vec::new()),
                cycle: tokio::sync::Mutex::new(()),
                timer: Mutex::new(None),
                shutdown: Notify::new(),
                on_stop: Mutex::new(None),
                collect: Mutex::new(None),
            }),
        }
    }

    pub fn running(&self) -> bool {
        self.inner.running.load(Ordering::SeqCst)
    }

    pub fn on_entries<F>(&self, listener: F)
    where
        F: Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
    {
        self.inner
            .listeners
            .lock()
            .expect("entry listeners")
            .push(Arc::new(listener));
    }

    pub async fn start(&self, on_start: HookFn, collect: CollectFn, on_stop: HookFn) {
        if self.inner.running.swap(true, Ordering::SeqCst) {
            return;
        }
        *self.inner.on_stop.lock().expect("on_stop") = Some(on_stop);
        *self.inner.collect.lock().expect("collect") = Some(collect);
        self.inner.logger.info("starting", None);
        on_start().await;
        if !self.running() {
            self.finish_stop().await;
            return;
        }
        self.run_cycle().await;
        if !self.running() {
            self.finish_stop().await;
            return;
        }
        let inner = Arc::clone(&self.inner);
        let handle = tokio::spawn(async move { inner.timer_loop().await });
        *self.inner.timer.lock().expect("timer") = Some(handle);
    }

    pub async fn stop(&self) {
        if !self.inner.running.swap(false, Ordering::SeqCst) {
            return;
        }
        self.inner.shutdown.notify_waiters();
        let _guard = self.inner.cycle.lock().await;
        drop(_guard);
        if let Some(handle) = self.inner.timer.lock().expect("timer").take() {
            handle.abort();
        }
        self.finish_stop().await;
    }

    pub fn request_collection(&self) {
        if !self.running() {
            return;
        }
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move { inner.run_cycle().await });
    }

    async fn finish_stop(&self) {
        let on_stop = self.inner.on_stop.lock().expect("on_stop").take();
        if let Some(on_stop) = on_stop {
            on_stop().await;
            self.inner.logger.info("stopped", None);
        }
    }

    async fn run_cycle(&self) {
        self.inner.run_cycle().await;
    }
}

impl PollInner {
    async fn timer_loop(self: Arc<Self>) {
        loop {
            if !self.running.load(Ordering::SeqCst) {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(self.poll) => {}
                _ = self.shutdown.notified() => break,
            }
            if !self.running.load(Ordering::SeqCst) {
                break;
            }
            self.run_cycle().await;
        }
    }

    async fn run_cycle(&self) {
        let _guard = self.cycle.lock().await;
        if !self.running.load(Ordering::SeqCst) {
            return;
        }
        let collect = self.collect.lock().expect("collect").clone();
        let Some(collect) = collect else {
            return;
        };
        match collect().await {
            Ok(entries) => {
                if !entries.is_empty() {
                    self.emit(&entries);
                    self.logger.debug(
                        "cycle produced entries",
                        Some(&string_meta(&[("count", entries.len().to_string())])),
                    );
                }
                if let Err(err) = self.state_store.save().await {
                    self.logger.error(
                        "collection cycle failed",
                        Some(&string_meta(&[("error", err.to_string())])),
                    );
                }
            }
            Err(err) => {
                self.logger.error(
                    "collection cycle failed",
                    Some(&string_meta(&[("error", err)])),
                );
            }
        }
    }

    fn emit(&self, entries: &[AgentActivityEntry]) {
        let listeners = self.listeners.lock().expect("listeners").clone();
        for listener in listeners {
            listener(entries);
        }
    }
}

async fn cursor_first_run_guard(inner: &HookInner) {
    let state = inner.state_store.get(inner.id);
    if has_last_file(&state) {
        return;
    }
    let today = get_today_date_string();
    let log_file_name = format!("{}-{today}.jsonl", inner.log_prefix);
    let log_file = Path::new(&inner.log_dir).join(&log_file_name);
    match tokio::fs::metadata(&log_file).await {
        Ok(meta) if meta.len() > 0 => {
            inner.state_store.update(
                inner.id,
                InputStatePatch {
                    last_file: Some(log_file_name.clone()),
                    last_offset: Some(meta.len() as f64),
                    ..InputStatePatch::default()
                },
            );
            inner.logger.info(
                "first-run guard: skipping existing history",
                Some(&string_meta(&[
                    ("file", log_file_name),
                    ("skippedBytes", meta.len().to_string()),
                ])),
            );
        }
        Ok(_) | Err(_) => {
            inner.state_store.update(
                inner.id,
                InputStatePatch {
                    last_file: Some(log_file_name),
                    last_offset: Some(0.0),
                    ..InputStatePatch::default()
                },
            );
        }
    }
}

async fn collect_hook_files(inner: &HookInner) -> Result<Vec<AgentActivityEntry>, String> {
    let today = get_today_date_string();
    let state = inner.state_store.get(inner.id);
    let cold_start = !has_last_file(&state);
    let file_names = list_hook_log_files(&inner.log_dir, &inner.log_prefix).await;
    if file_names.is_empty() {
        return Ok(Vec::new());
    }
    let persisted = persisted_offset_map(&state);
    let should_persist = persisted.is_none();
    let mut offsets = match &persisted {
        Some(map) => map.clone(),
        None => {
            seed_offset_map(
                &inner.log_dir,
                &inner.log_prefix,
                &file_names,
                &state,
                &today,
            )
            .await
        }
    };
    let candidates =
        candidate_file_names(&inner.log_prefix, &file_names, state.last_file(), &today);
    let mut entries = Vec::new();
    for name in &candidates {
        let path = Path::new(&inner.log_dir).join(name);
        let start = offsets.get(name).copied().unwrap_or(0);
        let (file_entries, offset) = collect_hook_file(inner, &path, start).await?;
        offsets.insert(name.clone(), offset);
        entries.extend(file_entries);
    }
    let live: std::collections::HashSet<&str> = file_names.iter().map(String::as_str).collect();
    let mut pruned = Map::new();
    for (name, offset) in &offsets {
        if live.contains(name.as_str()) {
            pruned.insert(name.clone(), Value::Number((*offset).into()));
        }
    }
    let newest = candidates.last().cloned();
    if let Some(newest) = newest {
        let newest_offset = offsets.get(&newest).copied().unwrap_or(0);
        let last_changed = state.last_file() != Some(newest.as_str())
            || state
                .last_offset()
                .map(|value| value != newest_offset as f64)
                .unwrap_or(true);
        if should_persist || last_changed || offset_map_changed(persisted.as_ref(), &pruned) {
            let mut extra = Map::new();
            extra.insert(OFFSET_MAP_EXTRA_KEY.to_string(), Value::Object(pruned));
            inner.state_store.update(
                inner.id,
                InputStatePatch {
                    last_file: Some(newest),
                    last_offset: Some(newest_offset as f64),
                    extra: Some(Value::Object(extra)),
                    ..InputStatePatch::default()
                },
            );
        }
    }
    if inner.cold_start_keep_last_turn_only && cold_start && !entries.is_empty() {
        let mut turn_ids = Vec::new();
        for entry in &entries {
            let label = turn_label(entry);
            if !turn_ids.iter().any(|existing| existing == &label) {
                turn_ids.push(label);
            }
        }
        if turn_ids.len() > 1 {
            let keep = turn_label(entries.last().expect("entries"));
            inner.logger.info(
                "cold start detected, skipping historical turns",
                Some(&string_meta(&[
                    ("skipped", (turn_ids.len() - 1).to_string()),
                    ("totalTurns", turn_ids.len().to_string()),
                    ("keepTurnId", keep.clone()),
                ])),
            );
            entries.retain(|entry| turn_label(entry) == keep);
        }
    }
    Ok(entries)
}

async fn collect_hook_file(
    inner: &HookInner,
    path: &Path,
    start_offset: u64,
) -> Result<(Vec<AgentActivityEntry>, u64), String> {
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(_) => return Ok((Vec::new(), start_offset)),
    };
    let mut offset = start_offset;
    let size = meta.len();
    if offset > 0 && size < offset {
        inner.logger.info(
            "file truncated, resetting offset",
            Some(&string_meta(&[
                ("file", path.display().to_string()),
                ("recorded", offset.to_string()),
                ("actual", size.to_string()),
            ])),
        );
        offset = 0;
    }
    if size <= offset {
        return Ok((Vec::new(), size));
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| err.to_string())?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|err| err.to_string())?;
    let want = (size - offset) as usize;
    let mut buf = vec![0_u8; want];
    let mut filled = 0;
    while filled < want {
        let n = file
            .read(&mut buf[filled..])
            .await
            .map_err(|err| err.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    let Some(last_nl) = buf.iter().rposition(|byte| *byte == b'\n') else {
        return Ok((Vec::new(), offset));
    };
    let complete_len = last_nl + 1;
    let checkpoint = offset + complete_len as u64;
    let complete = &buf[..complete_len];
    let text = String::from_utf8_lossy(complete);
    let ascii = complete.iter().all(|byte| *byte < 128);
    let mut entries = Vec::new();
    let mut record_start = 0usize;
    for line in text.split('\n') {
        if !ascii {
            let Some(rel) = complete[record_start..]
                .iter()
                .position(|byte| *byte == b'\n')
            else {
                break;
            };
            record_start += rel + 1;
        }
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(err) => {
                inner.logger.warn(
                    "invalid JSONL line",
                    Some(&string_meta(&[
                        ("error", err.to_string()),
                        ("line", line.chars().take(200).collect()),
                    ])),
                );
                continue;
            }
        };
        let Some(record) = parsed.as_object().cloned() else {
            continue;
        };
        match (inner.transform)(record).await {
            Ok(Some(entry)) => entries.push(entry),
            Ok(None) => {}
            Err(err) => {
                inner.logger.warn(
                    "invalid JSONL line",
                    Some(&string_meta(&[
                        ("error", err),
                        ("line", line.chars().take(200).collect()),
                    ])),
                );
            }
        }
    }
    Ok((entries, checkpoint))
}

async fn list_hook_log_files(log_dir: &str, prefix: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut dir = match tokio::fs::read_dir(log_dir).await {
        Ok(dir) => dir,
        Err(_) => return names,
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hook_log_file(&name, prefix) {
            names.push(name);
        }
    }
    names.sort();
    names
}

fn is_hook_log_file(name: &str, prefix: &str) -> bool {
    let head = format!("{prefix}-");
    let Some(suffix) = name.strip_prefix(&head) else {
        return false;
    };
    HOOK_DATE_FILE.is_match(suffix)
}

fn candidate_file_names(
    prefix: &str,
    file_names: &[String],
    last_file: Option<&str>,
    today: &str,
) -> Vec<String> {
    let today_name = format!("{prefix}-{today}.jsonl");
    let mut names = Vec::new();
    let mut push = |name: &str| {
        if file_names.iter().any(|existing| existing == name)
            && !names.iter().any(|existing| existing == name)
        {
            names.push(name.to_string());
        }
    };
    let start = file_names.len().saturating_sub(RECENT_LOG_FILE_LIMIT);
    for name in &file_names[start..] {
        push(name);
    }
    if let Some(last) = last_file {
        push(last);
    }
    push(&today_name);
    names.sort();
    names
}

fn persisted_offset_map(state: &InputState) -> Option<BTreeMap<String, u64>> {
    let extra = state.extra()?;
    let raw = extra.get(OFFSET_MAP_EXTRA_KEY)?.as_object()?;
    let mut offsets = BTreeMap::new();
    for (name, value) in raw {
        if let Some(offset) = value_u64(value) {
            offsets.insert(name.clone(), offset);
        }
    }
    if offsets.is_empty() {
        None
    } else {
        Some(offsets)
    }
}

fn offset_map_changed(previous: Option<&BTreeMap<String, u64>>, next: &Map<String, Value>) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous.len() != next.len() {
        return true;
    }
    next.iter().any(|(name, value)| {
        value_u64(value)
            .map(|offset| previous.get(name).copied() != Some(offset))
            .unwrap_or(true)
    })
}

async fn seed_offset_map(
    log_dir: &str,
    prefix: &str,
    file_names: &[String],
    state: &InputState,
    today: &str,
) -> BTreeMap<String, u64> {
    let mut offsets = BTreeMap::new();
    for name in file_names {
        let path = Path::new(log_dir).join(name);
        let size = tokio::fs::metadata(&path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        offsets.insert(name.clone(), size);
    }
    let today_name = format!("{prefix}-{today}.jsonl");
    if let Some(last) = state.last_file() {
        if file_names.iter().any(|name| name == last) {
            let resume = state.last_offset().unwrap_or(0.0).max(0.0) as u64;
            offsets.insert(last.to_string(), resume);
            if last != today_name && file_names.iter().any(|name| name == &today_name) {
                offsets.insert(today_name, 0);
            }
            return offsets;
        }
    }
    if file_names.iter().any(|name| name == &today_name) {
        offsets.insert(today_name, 0);
    }
    offsets
}

fn has_last_file(state: &InputState) -> bool {
    state.last_file().is_some_and(|value| !value.is_empty())
}

fn turn_label(entry: &AgentActivityEntry) -> String {
    match entry.turn_id.as_deref() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => "unknown".to_string(),
    }
}

fn value_u64(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    if let Some(number) = value.as_i64() {
        return u64::try_from(number).ok();
    }
    let number = value.as_f64()?;
    if number.is_finite() && number >= 0.0 {
        Some(number as u64)
    } else {
        None
    }
}

/// Shared `transformHookRecord` for hook JSONL agents.
pub async fn transform_hook_record(
    record: &Map<String, Value>,
    agent_type: ClientType,
    git_namespace: &str,
) -> Result<Option<AgentActivityEntry>, String> {
    let Some(raw_event) = non_empty_string(record.get("event.name")) else {
        return Ok(None);
    };
    let mut opts = record.clone();
    set_string(
        &mut opts,
        "time_unix_nano",
        non_empty_string(record.get("time_unix_nano")),
    );
    set_string(
        &mut opts,
        "observed_time_unix_nano",
        non_empty_string(record.get("observed_time_unix_nano")),
    );
    set_string(
        &mut opts,
        "event.id",
        non_empty_string(record.get("event.id")),
    );
    opts.insert(
        "event.name".to_string(),
        Value::String(
            normalize_event_name(Some(&Value::String(raw_event)))
                .as_str()
                .to_string(),
        ),
    );
    opts.insert(
        "user.id".to_string(),
        Value::String(non_empty_string(record.get("user.id")).unwrap_or_default()),
    );
    opts.insert(
        "gen_ai.session.id".to_string(),
        Value::String(
            non_empty_string(record.get("gen_ai.session.id"))
                .or_else(|| non_empty_string(record.get("session.id")))
                .unwrap_or_default(),
        ),
    );
    set_string(
        &mut opts,
        "gen_ai.turn.id",
        non_empty_string(record.get("gen_ai.turn.id"))
            .or_else(|| non_empty_string(record.get("turn.id"))),
    );
    set_string(
        &mut opts,
        "gen_ai.step.id",
        non_empty_string(record.get("gen_ai.step.id"))
            .or_else(|| non_empty_string(record.get("step.id"))),
    );
    opts.insert(
        "gen_ai.agent.type".to_string(),
        Value::String(agent_type.as_str().to_string()),
    );
    set_string(
        &mut opts,
        "gen_ai.provider.name",
        non_empty_string(record.get("gen_ai.provider.name"))
            .or_else(|| non_empty_string(record.get("provider.name"))),
    );
    set_string(
        &mut opts,
        "gen_ai.request.model",
        non_empty_string(record.get("gen_ai.request.model"))
            .or_else(|| non_empty_string(record.get("request.model"))),
    );
    set_string(
        &mut opts,
        "gen_ai.response.model",
        non_empty_string(record.get("gen_ai.response.model"))
            .or_else(|| non_empty_string(record.get("response.model"))),
    );
    set_string(
        &mut opts,
        "response.finish_reasons",
        non_empty_string(record.get("response.finish_reasons")),
    );
    set_number(
        &mut opts,
        "gen_ai.usage.input_tokens",
        first_finite_number(record, &["gen_ai.usage.input_tokens", "usage.input_tokens"]),
    );
    set_number(
        &mut opts,
        "gen_ai.usage.output_tokens",
        first_finite_number(
            record,
            &["gen_ai.usage.output_tokens", "usage.output_tokens"],
        ),
    );
    set_number(
        &mut opts,
        "gen_ai.usage.cache_read.input_tokens",
        first_finite_number(
            record,
            &[
                "gen_ai.usage.cache_read.input_tokens",
                "usage.cache_read_tokens",
            ],
        ),
    );
    set_number(
        &mut opts,
        "gen_ai.usage.total_tokens",
        first_finite_number(record, &["gen_ai.usage.total_tokens", "usage.total_tokens"]),
    );
    set_string(
        &mut opts,
        "gen_ai.input.messages_hash",
        non_empty_string(record.get("gen_ai.input.messages_hash"))
            .or_else(|| non_empty_string(record.get("input.messages_hash"))),
    );
    set_json(
        &mut opts,
        "gen_ai.input.messages_delta",
        coalesce_value(
            record,
            "gen_ai.input.messages_delta",
            "input.messages_delta",
        ),
    );
    set_json(
        &mut opts,
        "gen_ai.input.messages",
        coalesce_value(record, "gen_ai.input.messages", "input.messages"),
    );
    set_json(
        &mut opts,
        "gen_ai.output.messages",
        coalesce_value(record, "gen_ai.output.messages", "output.messages"),
    );
    set_string(
        &mut opts,
        "gen_ai.tool.name",
        non_empty_string(record.get("gen_ai.tool.name"))
            .or_else(|| non_empty_string(record.get("tool.name"))),
    );
    set_string(
        &mut opts,
        "gen_ai.tool.call.id",
        non_empty_string(record.get("gen_ai.tool.call.id"))
            .or_else(|| non_empty_string(record.get("tool.call.id"))),
    );
    set_json(
        &mut opts,
        "gen_ai.tool.call.arguments",
        coalesce_value(record, "gen_ai.tool.call.arguments", "tool.arguments"),
    );
    set_json(
        &mut opts,
        "gen_ai.tool.call.result",
        coalesce_value(record, "gen_ai.tool.call.result", "tool.result"),
    );
    set_string(
        &mut opts,
        "tool.result.status",
        non_empty_string(record.get("tool.result.status")),
    );
    set_number(
        &mut opts,
        "gen_ai.tool.call.duration",
        first_finite_number(
            record,
            &[
                "gen_ai.tool.call.duration",
                "gen_ai.tool.call.duration_ms",
                "tool.result.duration",
                "tool.result.duration_ms",
            ],
        ),
    );
    set_string(
        &mut opts,
        "gen_ai.skill.name",
        non_empty_string(record.get("gen_ai.skill.name")),
    );
    set_string(
        &mut opts,
        "gen_ai.skill.id",
        non_empty_string(record.get("gen_ai.skill.id")),
    );
    set_string(
        &mut opts,
        "gen_ai.skill.description",
        non_empty_string(record.get("gen_ai.skill.description")),
    );
    set_string(
        &mut opts,
        "gen_ai.skill.version",
        non_empty_string(record.get("gen_ai.skill.version")),
    );
    set_json(
        &mut opts,
        "gen_ai.system_instructions",
        record
            .get("gen_ai.system_instructions")
            .filter(|value| !value.is_null())
            .cloned(),
    );
    set_json(
        &mut opts,
        "gen_ai.tool.definitions",
        record
            .get("gen_ai.tool.definitions")
            .filter(|value| !value.is_null())
            .cloned(),
    );
    set_string(
        &mut opts,
        "error.type",
        non_empty_string(record.get("error.type")),
    );
    set_string(
        &mut opts,
        "error.message",
        non_empty_string(record.get("error.message")),
    );

    let mut entry = build_agent_activity_entry(&Value::Object(opts));
    enrich_canonical_entry_with_git(&mut entry, record, git_namespace).await?;
    Ok(Some(entry))
}

#[derive(Default)]
pub struct CanonicalHookOptions {
    pub preserve_safe_custom_top_level_fields: bool,
}

pub fn build_canonical_hook_entry(
    record: &Map<String, Value>,
    fallback_agent_type: &str,
    attributes: Option<&Map<String, Value>>,
    options: CanonicalHookOptions,
) -> Option<AgentActivityEntry> {
    if !is_canonical_hook_record(record) {
        return None;
    }
    let mut opts = Map::new();
    for (key, raw) in record {
        if !is_canonical_key(key) {
            continue;
        }
        if let Some(value) = json_value_from(raw) {
            opts.insert(key.clone(), value);
        }
    }
    let agent_type = non_empty_string(record.get("gen_ai.agent.type"))
        .unwrap_or_else(|| fallback_agent_type.to_string());
    opts.insert("gen_ai.agent.type".to_string(), Value::String(agent_type));
    if !truthy_json(opts.get("gen_ai.request.model")) {
        opts.insert(
            "gen_ai.request.model".to_string(),
            Value::String("unknown".to_string()),
        );
    }
    if !truthy_json(opts.get("gen_ai.response.model")) {
        let request = opts
            .get("gen_ai.request.model")
            .cloned()
            .unwrap_or(Value::String("unknown".to_string()));
        opts.insert("gen_ai.response.model".to_string(), request);
    }
    if let Some(attributes) = attributes {
        opts.insert(
            "attributes".to_string(),
            Value::Object(json_object_from(attributes)),
        );
    } else {
        opts.insert("attributes".to_string(), Value::Object(Map::new()));
    }
    let mut entry = build_agent_activity_entry(&Value::Object(opts));
    if options.preserve_safe_custom_top_level_fields {
        attach_safe_custom_top_level_fields(&mut entry, record);
    }
    Some(entry)
}

fn attach_safe_custom_top_level_fields(
    entry: &mut AgentActivityEntry,
    record: &Map<String, Value>,
) {
    let existing = serde_json::to_value(&*entry).unwrap_or(Value::Null);
    for (raw_key, raw_value) in record {
        if is_canonical_key(raw_key) {
            continue;
        }
        let key = raw_key.trim();
        if key.is_empty() || key.contains(',') || key.contains('=') || is_reserved_key(key) {
            continue;
        }
        if SENSITIVE_FIELD_NAME.is_match(key) {
            continue;
        }
        let Some(text) = raw_value.as_str() else {
            continue;
        };
        let value = text.trim();
        if value.is_empty() || value.len() > MAX_CUSTOM_FIELD_VALUE_LENGTH || value.contains(',') {
            continue;
        }
        if existing.get(key).is_some() {
            continue;
        }
        entry
            .extra
            .insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn is_canonical_hook_record(record: &Map<String, Value>) -> bool {
    record.get("event.name").and_then(Value::as_str).is_some()
        && record
            .get("gen_ai.agent.type")
            .and_then(Value::as_str)
            .is_some()
}

fn is_canonical_key(key: &str) -> bool {
    CANONICAL_KEYS.contains(&key)
        || CANONICAL_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

fn truthy_json(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

pub fn json_object_from(value: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, raw) in value {
        if let Some(json) = json_value_from(raw) {
            out.insert(key.clone(), json);
        }
    }
    out
}

fn json_value_from(value: &Value) -> Option<Value> {
    Some(value.clone())
}

pub fn strip_token_cost_fields(entry: &mut AgentActivityEntry) {
    entry.input_tokens = None;
    entry.output_tokens = None;
    entry.cache_read_input_tokens = None;
    entry.cache_creation_input_tokens = None;
    entry.total_tokens = None;
    entry.input_cost = None;
    entry.output_cost = None;
    entry.cache_read_input_cost = None;
    entry.cache_creation_input_cost = None;
    entry.total_cost = None;
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn set_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    match value {
        Some(text) => {
            map.insert(key.to_string(), Value::String(text));
        }
        None => {
            map.remove(key);
        }
    }
}

fn set_number(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(number) => {
            map.insert(key.to_string(), number);
        }
        None => {
            map.remove(key);
        }
    }
}

fn set_json(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(json) => {
            map.insert(key.to_string(), json);
        }
        None => {
            map.remove(key);
        }
    }
}

fn coalesce_value(record: &Map<String, Value>, primary: &str, alias: &str) -> Option<Value> {
    match record.get(primary) {
        Some(Value::Null) | None => record.get(alias).filter(|value| !value.is_null()).cloned(),
        Some(value) => Some(value.clone()),
    }
}

fn first_finite_number(record: &Map<String, Value>, keys: &[&str]) -> Option<Value> {
    for key in keys {
        let Some(value) = record.get(*key) else {
            continue;
        };
        if value.as_f64().is_some_and(|number| number.is_finite()) {
            return Some(value.clone());
        }
    }
    None
}

fn string_meta(pairs: &[(&str, String)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), Value::String(value.clone())))
        .collect()
}

pub struct SessionInputOptions {
    pub state_store: Arc<StateStore>,
    pub session_dir: Option<String>,
    pub file_pattern: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

pub struct SessionJsonlInput {
    id: &'static str,
    agent_type: ClientType,
    tail: Arc<SessionTail>,
    poll: PollLoop,
    on_line: LineFn,
}

pub struct SessionTail {
    pub id: &'static str,
    pub session_dir: String,
    pub file_pattern: String,
    pub state_store: Arc<StateStore>,
    pub logger: BoundLogger,
    warned: Mutex<VecDeque<String>>,
}

impl SessionJsonlInput {
    pub fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        crate::inputs::base::InputRuntimeInfo {
            poll_interval_ms: self.poll.interval_ms(),
            source_paths: vec![self.tail.session_dir.clone()],
        }
    }

    pub fn new(
        logger_name: &'static str,
        id: &'static str,
        agent_type: ClientType,
        default_dir: &str,
        default_pattern: &str,
        opts: SessionInputOptions,
        on_line: LineFn,
    ) -> Self {
        let logger = create_logger(logger_name);
        let poll_ms = resolve_poll_interval_ms(opts.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
        let state_store = Arc::clone(&opts.state_store);
        let tail = Arc::new(SessionTail {
            id,
            session_dir: opts
                .session_dir
                .unwrap_or_else(|| resolve_home(default_dir)),
            file_pattern: opts
                .file_pattern
                .unwrap_or_else(|| default_pattern.to_string()),
            state_store: opts.state_store,
            logger: logger.clone(),
            warned: Mutex::new(VecDeque::new()),
        });
        Self {
            id,
            agent_type,
            tail,
            poll: PollLoop::new(poll_ms, logger, state_store),
            on_line,
        }
    }

    pub fn id(&self) -> &'static str {
        self.id
    }

    pub fn agent_type(&self) -> ClientType {
        self.agent_type
    }

    pub fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }

    pub fn session_dir(&self) -> &str {
        &self.tail.session_dir
    }

    pub fn state_store(&self) -> &Arc<StateStore> {
        &self.tail.state_store
    }

    pub fn running(&self) -> bool {
        self.poll.running()
    }

    pub fn on_entries<F>(&self, listener: F)
    where
        F: Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
    {
        self.poll.on_entries(listener);
    }

    pub async fn discover_session_files(&self) -> Vec<String> {
        self.tail.discover_matching_files().await
    }

    pub async fn collect_entries(&self) -> Result<Vec<AgentActivityEntry>, String> {
        let files = self.tail.discover_matching_files().await;
        let mut entries = Vec::new();
        for path in files {
            entries.extend(self.tail.read_new_lines(&path, &self.on_line).await?);
        }
        Ok(entries)
    }

    pub async fn start(&self) {
        let this_tail = Arc::clone(&self.tail);
        let on_line = Arc::clone(&self.on_line);
        self.poll
            .start(
                box_hook(|| async {}),
                box_collect(move || {
                    let tail = Arc::clone(&this_tail);
                    let on_line = Arc::clone(&on_line);
                    async move {
                        let files = tail.discover_matching_files().await;
                        let mut entries = Vec::new();
                        for path in files {
                            entries.extend(tail.read_new_lines(&path, &on_line).await?);
                        }
                        Ok(entries)
                    }
                }),
                box_hook(|| async {}),
            )
            .await;
    }

    pub fn ownership_warning_count(&self) -> usize {
        self.tail.warned.lock().expect("ownership warnings").len()
    }

    pub async fn stop(&self) {
        self.poll.stop().await;
    }
}

impl SessionTail {
    pub async fn discover_matching_files(&self) -> Vec<String> {
        let mut dir = match tokio::fs::read_dir(&self.session_dir).await {
            Ok(dir) => dir,
            Err(err) => {
                if is_unreadable_io(&err) {
                    self.diagnose_unreadable_path(&self.session_dir, "session directory")
                        .await;
                    return Vec::new();
                }
                if err.kind() != std::io::ErrorKind::NotFound {
                    self.logger.warn(
                        "failed to discover session files",
                        Some(&string_meta(&[
                            ("sessionDir", self.session_dir.clone()),
                            ("error", err.to_string()),
                        ])),
                    );
                }
                return Vec::new();
            }
        };
        let mut files = Vec::new();
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = match entry.file_type().await {
                Ok(kind) => kind,
                Err(_) => continue,
            };
            if file_type.is_file() && glob_match(&self.file_pattern, &name) {
                files.push(
                    Path::new(&self.session_dir)
                        .join(name)
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
        files.sort();
        files
    }

    pub async fn read_new_lines(
        &self,
        file_path: &str,
        on_line: &LineFn,
    ) -> Result<Vec<AgentActivityEntry>, String> {
        let (file, identity) = match open_session_file(file_path).await {
            Ok(opened) => opened,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) if is_unreadable_io(&err) => {
                self.diagnose_unreadable_path(file_path, "event file").await;
                return Ok(Vec::new());
            }
            Err(err) => return Err(err.to_string()),
        };
        self.read_opened_lines(file_path, on_line, file, identity)
            .await
    }

    async fn read_opened_lines(
        &self,
        file_path: &str,
        on_line: &LineFn,
        mut file: tokio::fs::File,
        identity: crate::utils::file_identity::OpenedFileIdentity,
    ) -> Result<Vec<AgentActivityEntry>, String> {
        let state_key = format!("{}:{file_path}", self.id);
        let inode = identity.ino;
        let prev = self.state_store.get(&state_key);
        let prev_inode = prev
            .extra()
            .as_ref()
            .and_then(|extra| extra.get("inode"))
            .and_then(value_u64);
        let prev_dev = prev
            .extra()
            .as_ref()
            .and_then(|extra| extra.get("dev"))
            .and_then(value_u64);
        if (prev_inode.is_some() && prev_inode != Some(inode))
            || (prev_dev.is_some() && prev_dev != Some(identity.dev))
        {
            self.state_store.set_offset(&state_key, 0.0);
            self.store_identity(&state_key, &identity);
        }
        let mut offset = self.state_store.get_offset(&state_key).max(0.0) as u64;
        let size = identity.size;
        if offset > 0 && size < offset {
            self.logger.info(
                "file truncated or rotated, resetting offset",
                Some(&string_meta(&[
                    ("file", file_path.to_string()),
                    ("recorded", offset.to_string()),
                    ("actual", size.to_string()),
                ])),
            );
            offset = 0;
            self.state_store.set_offset(&state_key, 0.0);
            self.store_identity(&state_key, &identity);
        }
        if size <= offset {
            return Ok(Vec::new());
        }
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|err| err.to_string())?;
        let want = (size - offset) as usize;
        let mut buf = vec![0_u8; want];
        let mut filled = 0;
        while filled < want {
            let n = file
                .read(&mut buf[filled..])
                .await
                .map_err(|err| err.to_string())?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        buf.truncate(filled);
        self.store_identity(&state_key, &identity);
        let Some(last_nl) = buf.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };
        let complete = &buf[..last_nl + 1];
        self.state_store
            .set_offset(&state_key, (offset + complete.len() as u64) as f64);
        let text = String::from_utf8_lossy(complete);
        let ascii = complete.iter().all(|byte| *byte < 128);
        let mut entries = Vec::new();
        let mut record_start = 0usize;
        for line in text.split('\n') {
            if !ascii {
                let Some(rel) = complete[record_start..]
                    .iter()
                    .position(|byte| *byte == b'\n')
                else {
                    break;
                };
                record_start += rel + 1;
            }
            if line.trim().is_empty() {
                continue;
            }
            let parsed: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(err) => {
                    self.logger.warn(
                        "invalid session line",
                        Some(&string_meta(&[
                            ("file", file_path.to_string()),
                            ("error", err.to_string()),
                        ])),
                    );
                    continue;
                }
            };
            let Some(record) = parsed.as_object().cloned() else {
                continue;
            };
            match on_line(record, file_path.to_string()).await {
                Ok(Some(entry)) => entries.push(entry),
                Ok(None) => {}
                Err(err) => {
                    self.logger.warn(
                        "invalid session line",
                        Some(&string_meta(&[
                            ("file", file_path.to_string()),
                            ("error", err),
                        ])),
                    );
                }
            }
        }
        Ok(entries)
    }

    fn store_identity(
        &self,
        state_key: &str,
        identity: &crate::utils::file_identity::OpenedFileIdentity,
    ) {
        let mut extra = Map::new();
        extra.insert("inode".to_string(), Value::Number(identity.ino.into()));
        extra.insert("dev".to_string(), Value::Number(identity.dev.into()));
        self.state_store.update(
            state_key,
            InputStatePatch {
                extra: Some(Value::Object(extra)),
                ..InputStatePatch::default()
            },
        );
    }

    async fn diagnose_unreadable_path(&self, target_path: &str, kind: &str) {
        let warn_key = format!("{kind}:{target_path}");
        {
            let mut warned = self.warned.lock().expect("ownership warnings");
            if warned.iter().any(|existing| existing == &warn_key) {
                return;
            }
            if warned.len() >= OWNERSHIP_WARN_CAP {
                warned.pop_front();
            }
            warned.push_back(warn_key);
        }
        let owner_uid = owner_uid(Path::new(target_path));
        let daemon_uid = current_uid();
        let mut meta = Map::new();
        meta.insert("path".to_string(), Value::String(target_path.to_string()));
        meta.insert("kind".to_string(), Value::String(kind.to_string()));
        if let Some(uid) = owner_uid {
            meta.insert("ownerUid".to_string(), Value::Number(uid.into()));
        }
        if let Some(uid) = daemon_uid {
            meta.insert("daemonUid".to_string(), Value::Number(uid.into()));
        }
        let message = if daemon_uid.is_none() {
            format!(
                "ownership-mismatch: cannot read {kind} (EACCES); this platform exposes no process uid, so ensure the process writing agent events runs as the same user as this daemon"
            )
        } else if owner_uid.is_some() && owner_uid != daemon_uid {
            format!(
                "ownership-mismatch: cannot read {kind} (EACCES): owned by uid {}, but this daemon runs as uid {}. A process running as a different uid loaded the pilot plugin and writes event files this daemon cannot read. Fix: run every process that loads the plugin as uid {} (drop the privileges of the uid-{} process, e.g. via su or runAsUser)",
                owner_uid.unwrap_or(0),
                daemon_uid.unwrap_or(0),
                daemon_uid.unwrap_or(0),
                owner_uid.unwrap_or(0),
            )
        } else {
            format!(
                "ownership-mismatch: cannot read {kind} (EACCES) despite matching uid {}; check the surrounding directory permissions or security modules (SELinux/AppArmor/ACLs)",
                daemon_uid.unwrap_or(0)
            )
        };
        self.logger.warn(&message, Some(&meta));
    }
}

pub fn glob_match(pattern: &str, file_name: &str) -> bool {
    let mut source = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        match ch {
            '*' => source.push_str(".*"),
            '?' => source.push('.'),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                source.push('\\');
                source.push(ch);
            }
            other => source.push(other),
        }
        index += 1;
    }
    source.push('$');
    Regex::new(&source)
        .map(|re| re.is_match(file_name))
        .unwrap_or(false)
}

pub fn is_unreadable_io(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::PermissionDenied || matches!(err.raw_os_error(), Some(1 | 13))
}

async fn open_session_file(
    path: &str,
) -> std::io::Result<(
    tokio::fs::File,
    crate::utils::file_identity::OpenedFileIdentity,
)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path)?;
        let identity = crate::utils::file_identity::identity_from_open(&file)?;
        Ok((tokio::fs::File::from_std(file), identity))
    })
    .await
    .map_err(std::io::Error::other)?
}

fn owner_uid(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        let meta = std::fs::metadata(path).ok()?;
        Some(std::os::unix::fs::MetadataExt::uid(&meta))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

pub fn process_uid() -> Option<u32> {
    current_uid()
}

fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        extern "C" {
            fn getuid() -> u32;
        }
        Some(unsafe { getuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

pub fn entry_json(entry: &AgentActivityEntry) -> Value {
    serde_json::to_value(entry).unwrap_or(Value::Null)
}

pub fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

/// Test stores live entirely in memory until `save`. The path only matters when a cycle flushes.
pub fn memory_state_store(dir: &Path) -> Arc<StateStore> {
    Arc::new(StateStore::new(dir.join("input-state.json")))
}

pub fn positive_number(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| number > 0.0)
}

#[cfg(test)]
#[path = "session_tail_identity_tests.rs"]
mod session_tail_identity_tests;
