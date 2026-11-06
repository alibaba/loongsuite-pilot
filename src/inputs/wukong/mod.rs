//! Wukong CLI API polling collector. Port of `wukong-input.ts`.
//!
//! The collector shells out to `wukong-cli`, checkpoints per-session message
//! counts, and turns completed AGUI turns into `AgentActivityEntry` values.

mod transform;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::checkpoints::{InputStatePatch, StateStore};
use crate::inputs::base::{HostedInput, InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{resolve_home, BoundLogger};

use transform::{
    find_last_complete_index, parse_messages, parse_task, transform_messages, ValidTask,
    WukongMessage,
};

const CLI_TIMEOUT_MS: u64 = 10_000;
const TASK_BATCH_LIMIT: u64 = 50;
const MAX_TASKS: usize = 500;
const BASELINE_CONCURRENCY: usize = 5;
const COLLECT_CONCURRENCY: usize = 5;
const STALE_PRUNE_THRESHOLD: f64 = 5.0;
const CLI_MAX_BUFFER: usize = 10 * 1024 * 1024;
const DAEMON_SOCK_REL: &str = ".real/daemon.sock";
const DEFAULT_POLL_MS: u64 = 60_000;

/// Constructor arguments for [`WukongInput`].
///
/// `poll_interval_ms` is the listener override. The unified
/// `LOONGSUITE_PILOT_POLL_INTERVAL_MS` env var wins over it. When both are
/// absent the collector polls every 60 seconds.
pub struct WukongInputOptions {
    pub state_store: Arc<StateStore>,
    pub poll_interval_ms: Option<u64>,
    pub cli_path: Option<String>,
}

/// Wukong collector hosted by the shared input runtime.
pub struct WukongInput {
    inner: Arc<HostedInput<WukongBody>>,
}

struct WukongBody {
    runner: Arc<dyn CliRunner>,
    in_flight: Arc<AtomicBool>,
    last_skip_warn_ms: AtomicU64,
    cancel: Mutex<Arc<CancelToken>>,
}

struct CliOutput {
    stdout: String,
    stderr: String,
}

struct ProcessRunner {
    cli_path: String,
}

#[cfg(test)]
type CliCallback = Arc<dyn Fn(&[String]) -> Result<CliOutput, String> + Send + Sync>;

#[cfg(test)]
struct CallbackRunner {
    func: CliCallback,
}

struct CancelToken {
    flag: AtomicBool,
    notify: Notify,
}

struct InFlightGuard(Arc<AtomicBool>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct Outcome {
    entries: Vec<AgentActivityEntry>,
    new_seen: f64,
}

struct TaskRun {
    task_id: String,
    session_id: String,
    outcome: Result<Option<Outcome>, String>,
}

#[async_trait]
trait CliRunner: Send + Sync {
    async fn exec(&self, args: &[String], cancel: &CancelToken) -> Result<CliOutput, String>;
}

impl CancelToken {
    fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

impl WukongBody {
    fn new(runner: Arc<dyn CliRunner>) -> Self {
        Self {
            runner,
            in_flight: Arc::new(AtomicBool::new(false)),
            last_skip_warn_ms: AtomicU64::new(0),
            cancel: Mutex::new(Arc::new(CancelToken::new())),
        }
    }

    fn token(&self) -> Arc<CancelToken> {
        Arc::clone(&self.cancel.lock().unwrap_or_else(|err| err.into_inner()))
    }
}

impl WukongInput {
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

    pub fn new(opts: WukongInputOptions) -> Self {
        let cli_path = opts.cli_path.clone().unwrap_or_else(Self::get_cli_path);
        Self::build(opts, Arc::new(ProcessRunner { cli_path }))
    }

    fn build(opts: WukongInputOptions, runner: Arc<dyn CliRunner>) -> Self {
        Self {
            inner: HostedInput::new(
                WukongBody::new(runner),
                "WukongInput",
                opts.state_store,
                opts.poll_interval_ms.or(Some(DEFAULT_POLL_MS)),
            ),
        }
    }

    #[cfg(test)]
    fn with_runner(opts: WukongInputOptions, runner: Arc<dyn CliRunner>) -> Self {
        Self::build(opts, runner)
    }

    /// Collector subscription used by the orchestrator.
    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }

    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }

    pub fn on_entries(&self, handler: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static) {
        self.inner.on_entries(handler);
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

    pub fn poll_interval_ms(&self) -> u64 {
        self.inner.runtime.poll_interval_ms()
    }

    pub fn get_cli_path() -> String {
        if cfg!(target_os = "macos") {
            "/Applications/Wukong.app/Contents/MacOS/wukong-cli".to_string()
        } else {
            "wukong-cli".to_string()
        }
    }

    pub fn get_watch_paths() -> Vec<String> {
        vec![Path::new(&resolve_home("~"))
            .join(DAEMON_SOCK_REL)
            .to_string_lossy()
            .into_owned()]
    }

    pub async fn check_availability() -> bool {
        let sock = Path::new(&resolve_home("~")).join(DAEMON_SOCK_REL);
        let runner = ProcessRunner {
            cli_path: Self::get_cli_path(),
        };
        check_availability_at(&sock, &runner).await
    }
}

async fn check_availability_at(sock: &Path, runner: &dyn CliRunner) -> bool {
    if tokio::fs::metadata(sock).await.is_err() {
        return false;
    }
    match runner
        .exec(&["service".into(), "status".into()], &CancelToken::new())
        .await
    {
        Ok(output) => output.stdout.to_ascii_lowercase().contains("running"),
        Err(_) => false,
    }
}

#[async_trait]
impl InputBody for WukongBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "wukong"
    }

    fn agent_type(&self) -> ClientType {
        ClientType::Wukong
    }

    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::CliApiPolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        if has_seen_counts(&rt.state().extra()) {
            return Ok(());
        }
        match self.list_all_tasks(&rt.logger).await {
            Ok(tasks) => {
                let mut seen = Map::new();
                let mut baselined = 0i64;
                for batch in tasks.chunks(BASELINE_CONCURRENCY) {
                    let mut jobs = Vec::new();
                    for task in batch {
                        let runner = Arc::clone(&self.runner);
                        let logger = rt.logger.clone();
                        let cancel = self.token();
                        let session_id = task.session_id.clone();
                        jobs.push(async move {
                            match fetch_messages(&runner, &logger, &cancel, &session_id).await {
                                Ok(messages) => (session_id, messages.len(), true),
                                Err(_) => (session_id, 0, false),
                            }
                        });
                    }
                    for result in join_ordered(jobs).await {
                        let Some((session_id, count, ok)) = result else {
                            continue;
                        };
                        seen.insert(session_id, Value::from(count as i64));
                        if ok {
                            baselined += 1;
                        }
                    }
                }
                rt.update_state(InputStatePatch {
                    extra: Some(json!({ "seenCounts": Value::Object(seen) })),
                    ..InputStatePatch::default()
                });
                let meta = log_fields(json!({ "total": tasks.len(), "baselined": baselined }));
                rt.info("baseline complete", Some(&meta));
            }
            Err(err) => {
                let meta = log_fields(json!({ "error": err }));
                rt.warn("failed to baseline wukong cursor", Some(&meta));
                rt.update_state(InputStatePatch {
                    extra: Some(json!({ "seenCounts": {} })),
                    ..InputStatePatch::default()
                });
            }
        }
        Ok(())
    }

    async fn on_stop(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        self.token().cancel();
        *self.cancel.lock().unwrap_or_else(|err| err.into_inner()) = Arc::new(CancelToken::new());
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let in_flight = Arc::clone(&self.in_flight);
        if in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            let now = now_ms();
            let last = self.last_skip_warn_ms.load(Ordering::SeqCst);
            if now.saturating_sub(last) > 60_000 {
                self.last_skip_warn_ms.store(now, Ordering::SeqCst);
                let meta = log_fields(json!({ "pollIntervalMs": rt.poll_interval_ms() }));
                rt.warn("skip collect: previous cycle still running", Some(&meta));
            }
            return Ok(Vec::new());
        }
        let _guard = InFlightGuard(in_flight);
        let started = now_ms();
        let result = self.do_collect(rt).await;
        let elapsed = now_ms().saturating_sub(started);
        if elapsed > rt.poll_interval_ms() {
            let meta = log_fields(json!({
                "elapsedMs": elapsed,
                "pollIntervalMs": rt.poll_interval_ms(),
            }));
            rt.warn("collect cycle exceeded poll interval", Some(&meta));
        }
        result
    }
}

impl WukongBody {
    async fn do_collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let state = rt.state();
        let extra = state.extra().unwrap_or(Value::Null);
        let mut seen = object_map(extra.get("seenCounts"));
        let mut stale = object_map(extra.get("staleCounters"));
        let tasks = match self.list_all_tasks(&rt.logger).await {
            Ok(tasks) => tasks,
            Err(err) => {
                let meta = log_fields(json!({ "error": err }));
                rt.debug(
                    "wukong list_tasks failed (daemon may be stopped)",
                    Some(&meta),
                );
                return Ok(Vec::new());
            }
        };
        if tasks.is_empty() {
            return Ok(Vec::new());
        }

        let mut entries = Vec::new();
        let mut state_changed = false;
        for batch in tasks.chunks(COLLECT_CONCURRENCY) {
            if !rt.is_running() {
                break;
            }
            let mut jobs = Vec::new();
            for task in batch {
                let prev = read_count(&seen, &task.session_id);
                jobs.push(process_one(
                    Arc::clone(&self.runner),
                    rt.logger.clone(),
                    self.token(),
                    task.clone(),
                    prev,
                ));
            }
            let results = join_ordered(jobs).await;
            let mut batch_changed = false;
            for (task, result) in batch.iter().zip(results) {
                match result {
                    Some(run) => match run.outcome {
                        Ok(Some(outcome)) => {
                            entries.extend(outcome.entries);
                            seen.insert(run.session_id, count_value(outcome.new_seen));
                            batch_changed = true;
                        }
                        Ok(None) => {}
                        Err(message) => {
                            let meta = log_fields(json!({
                                "taskId": run.task_id,
                                "sessionId": run.session_id,
                                "error": message,
                            }));
                            rt.warn("failed to process task", Some(&meta));
                        }
                    },
                    None => {
                        let meta = log_fields(json!({
                            "taskId": task.id,
                            "sessionId": task.session_id,
                            "error": "task panicked",
                        }));
                        rt.warn("failed to process task", Some(&meta));
                    }
                }
            }
            if batch_changed {
                state_changed = true;
            }
        }

        let active: HashSet<String> = tasks.iter().map(|task| task.session_id.clone()).collect();
        let seen_keys: Vec<String> = seen.keys().cloned().collect();
        for key in seen_keys {
            if active.contains(&key) {
                if stale.contains_key(&key) {
                    stale.remove(&key);
                    state_changed = true;
                }
                continue;
            }
            let missed = read_count(&stale, &key) + 1.0;
            if missed >= STALE_PRUNE_THRESHOLD {
                seen.remove(&key);
                stale.remove(&key);
                state_changed = true;
            } else {
                stale.insert(key, count_value(missed));
                state_changed = true;
            }
        }
        let stale_keys: Vec<String> = stale.keys().cloned().collect();
        for key in stale_keys {
            if !seen.contains_key(&key) {
                stale.remove(&key);
                state_changed = true;
            }
        }
        if state_changed {
            rt.update_state(InputStatePatch {
                extra: Some(json!({
                    "seenCounts": Value::Object(seen),
                    "staleCounters": Value::Object(stale),
                })),
                ..InputStatePatch::default()
            });
        }
        Ok(entries)
    }

    async fn list_all_tasks(&self, logger: &BoundLogger) -> Result<Vec<ValidTask>, String> {
        let cancel = self.token();
        let mut tasks = Vec::new();
        let mut cursor: Option<String> = None;
        let mut has_more = false;
        loop {
            let output = self
                .runner
                .exec(&list_args(cursor.as_deref()), &cancel)
                .await?;
            if blank(&output.stdout) {
                let meta = log_fields(json!({ "stderr": snippet(&output.stderr, 256) }));
                logger.debug("wukong-cli list_tasks returned empty stdout", Some(&meta));
                break;
            }
            let parsed = parse_stdout(&output.stdout, &output.stderr, "list_tasks")?;
            let items = parsed
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| "unexpected listTasks response structure".to_string())?;
            for item in items {
                if let Some(task) = parse_task(item) {
                    tasks.push(task);
                }
            }
            has_more = json_truthy(parsed.get("hasMore"));
            cursor = if has_more {
                match parsed.get("nextCursor") {
                    Some(Value::String(next)) if !next.is_empty() => Some(next.clone()),
                    _ => None,
                }
            } else {
                None
            };
            if cursor.as_ref().is_some_and(|value| !value.is_empty()) && tasks.len() < MAX_TASKS {
                continue;
            }
            break;
        }
        if cursor.as_ref().is_some_and(|value| !value.is_empty()) && has_more {
            let meta = log_fields(json!({ "limit": MAX_TASKS, "fetched": tasks.len() }));
            logger.warn("wukong task pagination truncated by MAX_TASKS", Some(&meta));
        }
        Ok(tasks)
    }
}

#[async_trait]
impl CliRunner for ProcessRunner {
    async fn exec(&self, args: &[String], cancel: &CancelToken) -> Result<CliOutput, String> {
        if cancel.is_cancelled() {
            return Err("The operation was aborted".into());
        }
        let mut command = Command::new(&self.cli_path);
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|err| err.to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "wukong-cli stdout missing".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "wukong-cli stderr missing".to_string())?;
        let read_handle = tokio::spawn(async move {
            tokio::join!(
                read_capped(stdout, CLI_MAX_BUFFER),
                read_capped(stderr, CLI_MAX_BUFFER)
            )
        });
        let abort = read_handle.abort_handle();
        enum Wait {
            Timeout,
            Cancelled,
            Finished(Result<((Vec<u8>, bool), (Vec<u8>, bool)), tokio::task::JoinError>),
        }
        let wait = tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(CLI_TIMEOUT_MS)) => Wait::Timeout,
            _ = cancel.cancelled() => Wait::Cancelled,
            joined = read_handle => Wait::Finished(joined),
        };
        match wait {
            Wait::Timeout => {
                abort.abort();
                let _ = child.kill().await;
                Err(format!("wukong-cli timed out after {CLI_TIMEOUT_MS}ms"))
            }
            Wait::Cancelled => {
                abort.abort();
                let _ = child.kill().await;
                Err("The operation was aborted".into())
            }
            Wait::Finished(joined) => {
                let ((out_buf, out_over), (err_buf, err_over)) =
                    joined.map_err(|err| err.to_string())?;
                if out_over {
                    let _ = child.kill().await;
                    return Err("stdout maxBuffer length exceeded".into());
                }
                if err_over {
                    let _ = child.kill().await;
                    return Err("stderr maxBuffer length exceeded".into());
                }
                let status = child.wait().await.map_err(|err| err.to_string())?;
                let stdout = String::from_utf8_lossy(&out_buf).into_owned();
                let stderr = String::from_utf8_lossy(&err_buf).into_owned();
                if !status.success() {
                    let code = status
                        .code()
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".into());
                    return Err(format!(
                        "wukong-cli exited {code}: {}",
                        snippet(&stderr, 256)
                    ));
                }
                Ok(CliOutput { stdout, stderr })
            }
        }
    }
}

#[cfg(test)]
#[async_trait]
impl CliRunner for CallbackRunner {
    async fn exec(&self, args: &[String], cancel: &CancelToken) -> Result<CliOutput, String> {
        if cancel.is_cancelled() {
            return Err("The operation was aborted".into());
        }
        (self.func)(args)
    }
}

async fn fetch_messages(
    runner: &Arc<dyn CliRunner>,
    logger: &BoundLogger,
    cancel: &CancelToken,
    conversation_id: &str,
) -> Result<Vec<WukongMessage>, String> {
    let output = runner.exec(&message_args(conversation_id), cancel).await?;
    if blank(&output.stdout) {
        let stderr_snippet = snippet(&output.stderr, 256);
        let meta = log_fields(json!({
            "conversationId": conversation_id,
            "stderr": stderr_snippet,
        }));
        if stderr_snippet.is_empty() {
            logger.debug(
                "wukong-cli get_spark_agui_messages returned empty stdout, treating as no messages",
                Some(&meta),
            );
        } else {
            logger.warn(
                "wukong-cli get_spark_agui_messages returned empty stdout, treating as no messages",
                Some(&meta),
            );
        }
        return Ok(Vec::new());
    }
    let parsed = parse_stdout(&output.stdout, &output.stderr, "get_spark_agui_messages")?;
    let messages = parsed
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "unexpected getMessages response structure".to_string())?;
    Ok(parse_messages(messages))
}

async fn process_one(
    runner: Arc<dyn CliRunner>,
    logger: BoundLogger,
    cancel: Arc<CancelToken>,
    task: ValidTask,
    prev: f64,
) -> TaskRun {
    let task_id = task.id.clone();
    let session_id = task.session_id.clone();
    let outcome: Result<Option<Outcome>, String> = async {
        let messages = fetch_messages(&runner, &logger, &cancel, &session_id).await?;
        if (messages.len() as f64) <= prev {
            return Ok(None);
        }
        let start = count_index(prev, messages.len());
        let new_messages = &messages[start..];
        let last = find_last_complete_index(new_messages);
        if last < 0 {
            return Ok(None);
        }
        let processable = &new_messages[..=last as usize];
        let entries = transform_messages(&task, processable);
        let new_seen = prev + processable.len() as f64;
        Ok(Some(Outcome { entries, new_seen }))
    }
    .await;
    TaskRun {
        task_id,
        session_id,
        outcome,
    }
}

async fn join_ordered<T: Send + 'static>(
    jobs: Vec<impl std::future::Future<Output = T> + Send + 'static>,
) -> Vec<Option<T>> {
    let mut set = tokio::task::JoinSet::new();
    let count = jobs.len();
    for (index, job) in jobs.into_iter().enumerate() {
        set.spawn(async move { (index, job.await) });
    }
    let mut slots = Vec::with_capacity(count);
    slots.resize_with(count, || None);
    while let Some(joined) = set.join_next().await {
        if let Ok((index, value)) = joined {
            slots[index] = Some(value);
        }
    }
    slots
}

async fn read_capped(mut reader: impl AsyncRead + Unpin, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => return (buf, false),
            Ok(n) => {
                if buf.len().saturating_add(n) > cap {
                    return (buf, true);
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            Err(_) => return (buf, false),
        }
    }
}

fn list_args(cursor: Option<&str>) -> Vec<String> {
    let params = match cursor {
        Some(cursor) => json!({ "limit": TASK_BATCH_LIMIT, "cursor": cursor }),
        None => json!({ "limit": TASK_BATCH_LIMIT }),
    };
    vec![
        "agent".into(),
        "data".into(),
        "list_tasks".into(),
        "--json".into(),
        params.to_string(),
    ]
}

fn message_args(conversation_id: &str) -> Vec<String> {
    let params = json!({ "conversationId": conversation_id });
    vec![
        "agent".into(),
        "data".into(),
        "get_spark_agui_messages".into(),
        "--json".into(),
        params.to_string(),
    ]
}

fn parse_stdout(stdout: &str, stderr: &str, command: &str) -> Result<Value, String> {
    serde_json::from_str(stdout).map_err(|err| {
        format!(
            "wukong-cli {command} returned non-JSON (stderr={}, head={}): {err}",
            snippet(stderr, 256),
            snippet(stdout, 256),
        )
    })
}

fn has_seen_counts(extra: &Option<Value>) -> bool {
    matches!(
        extra.as_ref().and_then(|value| value.get("seenCounts")),
        Some(Value::Object(_))
    )
}

fn object_map(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn read_count(map: &Map<String, Value>, key: &str) -> f64 {
    match map.get(key) {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

fn count_value(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&value)
    {
        Value::from(value as i64)
    } else if let Some(number) = serde_json::Number::from_f64(value) {
        Value::Number(number)
    } else {
        Value::from(0)
    }
}

fn count_index(prev: f64, len: usize) -> usize {
    if !prev.is_finite() || prev <= 0.0 {
        return 0;
    }
    (prev.trunc() as usize).min(len)
}

fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|value| value != 0.0 && value.is_finite()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
        None | Some(Value::Null) => false,
    }
}

fn blank(text: &str) -> bool {
    !text.chars().any(|ch| !ch.is_whitespace())
}

fn snippet(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn log_fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
fn scripted(
    func: impl Fn(&[String]) -> Result<CliOutput, String> + Send + Sync + 'static,
) -> Arc<dyn CliRunner> {
    Arc::new(CallbackRunner {
        func: Arc::new(func),
    })
}

#[cfg(test)]
mod tests;
