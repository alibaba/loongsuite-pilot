//! Delayed sidecar scan scheduler for Kiro CLI.
//!
//! Port of `kiro-cli-session-input.ts`. This input never emits entries. It
//! claims mature pending-stop files and runs
//! `loongsuite-pilot hook-process kiro-cli delayedCollect`.
//! `KiroCliLogInput` tails the JSONL that subprocess appends.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

use crate::checkpoints::StateStore;
use crate::inputs::rest_support::{box_collect, box_hook, PollLoop};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{create_logger, resolve_home, resolve_poll_interval_ms, BoundLogger};

const DEFAULT_MATURE_DELAY_MS: u64 = 10_000;
const DEFAULT_MAX_AGE_MS: u64 = 5 * 60 * 1000;
const DEFAULT_SUBPROCESS_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_CONCURRENT: usize = 4;
const DEFAULT_POLL_MS: u64 = 60_000;

pub struct KiroCliSessionInputOptions {
    pub state_store: Arc<StateStore>,
    pub data_dir: String,
    pub poll_interval_ms: Option<u64>,
    pub mature_delay_ms: Option<u64>,
    pub max_age_ms: Option<u64>,
    pub subprocess_timeout_ms: Option<u64>,
    pub max_concurrent: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct PendingRecord {
    #[serde(default, rename = "enqueueMs")]
    enqueue_ms: Option<f64>,
    #[serde(default, rename = "stopUnixMs")]
    stop_unix_ms: Option<f64>,
}

struct PendingItem {
    ready_path: PathBuf,
    record: PendingRecord,
}

pub struct KiroCliSessionInput {
    ready_dir: PathBuf,
    inflight_dir: PathBuf,
    mature_delay_ms: u64,
    max_age_ms: u64,
    subprocess_timeout_ms: u64,
    max_concurrent: usize,
    logger: BoundLogger,
    poll: PollLoop,
    timer: AsyncMutex<Option<tokio::task::JoinHandle<()>>>,
    signal_task: AsyncMutex<Option<tokio::task::JoinHandle<()>>>,
    running_flag: Arc<AtomicBool>,
}

impl KiroCliSessionInput {
    pub fn new(opts: KiroCliSessionInputOptions) -> Self {
        let pending_root = Path::new(&opts.data_dir)
            .join("state")
            .join("kiro-cli")
            .join("pending-stops");
        let logger = create_logger("KiroCliSessionInput");
        let poll_ms = opts.poll_interval_ms.unwrap_or(DEFAULT_POLL_MS);
        let poll_ms = resolve_poll_interval_ms(Some(poll_ms), DEFAULT_POLL_MS);
        let poll = PollLoop::new(poll_ms, logger.clone(), Arc::clone(&opts.state_store));
        Self {
            ready_dir: pending_root.join("ready"),
            inflight_dir: pending_root.join("inflight"),
            mature_delay_ms: opts.mature_delay_ms.unwrap_or(DEFAULT_MATURE_DELAY_MS),
            max_age_ms: opts.max_age_ms.unwrap_or(DEFAULT_MAX_AGE_MS),
            subprocess_timeout_ms: opts
                .subprocess_timeout_ms
                .unwrap_or(DEFAULT_SUBPROCESS_TIMEOUT_MS),
            max_concurrent: opts.max_concurrent.unwrap_or(DEFAULT_MAX_CONCURRENT),
            logger,
            poll,
            timer: AsyncMutex::new(None),
            signal_task: AsyncMutex::new(None),
            running_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn id(&self) -> &'static str {
        "kiro-cli-session"
    }

    pub fn agent_type(&self) -> ClientType {
        ClientType::KiroCli
    }

    pub fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }

    pub fn watch_paths(data_dir: Option<&str>) -> Vec<String> {
        let root = data_dir
            .map(|dir| dir.to_string())
            .unwrap_or_else(|| resolve_home("~/.loongsuite-pilot"));
        vec![Path::new(&root)
            .join("state")
            .join("kiro-cli")
            .join("pending-stops")
            .to_string_lossy()
            .to_string()]
    }

    pub async fn check_availability() -> bool {
        // processor 编译在当前二进制内；可用性不再取决于旧 MJS 文件或 Shell wrapper。
        let Ok(binary) = std::env::current_exe() else {
            return false;
        };
        tokio::fs::metadata(binary)
            .await
            .is_ok_and(|meta| meta.is_file())
    }

    pub fn running(&self) -> bool {
        self.poll.running()
    }

    pub async fn start(self: &Arc<Self>) {
        let this = Arc::clone(self);
        let this_collect = Arc::clone(self);
        let this_stop = Arc::clone(self);
        self.running_flag.store(true, Ordering::SeqCst);
        self.poll
            .start(
                box_hook(move || {
                    let this = Arc::clone(&this);
                    async move { this.on_start().await }
                }),
                box_collect(move || {
                    let this = Arc::clone(&this_collect);
                    async move { this.collect().await }
                }),
                box_hook(move || {
                    let this = Arc::clone(&this_stop);
                    async move { this.on_stop().await }
                }),
            )
            .await;
    }

    pub async fn stop(&self) {
        self.running_flag.store(false, Ordering::SeqCst);
        self.poll.stop().await;
    }

    /// Schedule a collect after the mature delay. Mirrors the SIGUSR1 handler.
    pub async fn notify_stop(self: &Arc<Self>) {
        self.arm_timer().await;
    }

    async fn on_start(self: &Arc<Self>) {
        self.ensure_dirs().await;
        let recovered = self.recover_inflight().await;
        if recovered > 0 {
            let mut meta = Map::new();
            meta.insert("count".to_string(), Value::from(recovered));
            self.logger
                .info("recovered inflight pending-stops", Some(&meta));
        }
        self.spawn_signal_listener().await;
    }

    async fn on_stop(&self) {
        if let Some(task) = self.signal_task.lock().await.take() {
            task.abort();
        }
        if let Some(timer) = self.timer.lock().await.take() {
            timer.abort();
        }
    }

    async fn spawn_signal_listener(self: &Arc<Self>) {
        #[cfg(unix)]
        {
            let this = Arc::clone(self);
            let task = tokio::spawn(async move {
                let mut signals = match tokio::signal::unix::signal(
                    tokio::signal::unix::SignalKind::user_defined1(),
                ) {
                    Ok(signals) => signals,
                    Err(err) => {
                        let mut meta = Map::new();
                        meta.insert("error".to_string(), Value::String(err.to_string()));
                        this.logger.warn("failed to register SIGUSR1", Some(&meta));
                        return;
                    }
                };
                while signals.recv().await.is_some() {
                    this.arm_timer().await;
                }
            });
            *self.signal_task.lock().await = Some(task);
        }
    }

    async fn arm_timer(self: &Arc<Self>) {
        if let Some(existing) = self.timer.lock().await.take() {
            existing.abort();
        }
        let this = Arc::clone(self);
        let delay = self.mature_delay_ms;
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            *this.timer.lock().await = None;
            this.poll.request_collection();
        });
        *self.timer.lock().await = Some(task);
    }

    async fn collect(self: &Arc<Self>) -> Result<Vec<AgentActivityEntry>, String> {
        if !self.running_flag.load(Ordering::SeqCst) && !self.poll.running() {
            return Ok(Vec::new());
        }
        self.ensure_dirs().await;
        let items = self.list_ready().await;
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_ms();
        let mut due = Vec::new();
        for item in items {
            let stop_ms = item
                .record
                .stop_unix_ms
                .or(item.record.enqueue_ms)
                .unwrap_or(0.0);
            if stop_ms > 0.0 && now - stop_ms < self.mature_delay_ms as f64 {
                continue;
            }
            due.push(item);
            if due.len() >= self.max_concurrent {
                break;
            }
        }
        if due.is_empty() {
            return Ok(Vec::new());
        }
        let mut joins = Vec::new();
        for item in due {
            let this = Arc::clone(self);
            joins.push(tokio::spawn(
                async move { this.process_one(item, now).await },
            ));
        }
        for join in joins {
            let _ = join.await;
        }
        Ok(Vec::new())
    }

    async fn process_one(self: &Arc<Self>, item: PendingItem, now_ms: f64) {
        let Some(claimed) = self.claim(&item.ready_path).await else {
            return;
        };
        let stop_ms = item
            .record
            .stop_unix_ms
            .or(item.record.enqueue_ms)
            .unwrap_or(now_ms);
        let allow_fallback = now_ms - stop_ms >= self.max_age_ms as f64;
        let mut args = vec!["delayedCollect".to_string(), claimed.display().to_string()];
        if allow_fallback {
            args.push("--allow-fallback".to_string());
        }
        match self.spawn_processor(&args).await {
            Ok(status) if status == "ok" || status == "no_data" => {
                self.discard_inflight(&claimed).await
            }
            Ok(_) => self.release_inflight(&claimed).await,
            Err(err) => {
                let mut meta = Map::new();
                meta.insert(
                    "file".to_string(),
                    Value::String(claimed.display().to_string()),
                );
                meta.insert("error".to_string(), Value::String(err));
                self.logger.warn("delayedCollect spawn failed", Some(&meta));
                self.release_inflight(&claimed).await;
            }
        }
    }

    async fn spawn_processor(&self, args: &[String]) -> Result<String, String> {
        let bin = std::env::current_exe().map_err(|err| err.to_string())?;
        let mut child = Command::new(bin)
            .arg("hook-process")
            .arg("kiro-cli")
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| err.to_string())?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let timeout = Duration::from_millis(self.subprocess_timeout_ms);
        let wait = async {
            let status = child.wait().await.map_err(|err| err.to_string())?;
            let mut out = String::new();
            let mut err = String::new();
            if let Some(stdout) = stdout {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    out.push_str(&line);
                    out.push('\n');
                }
            }
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr);
                let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut err).await;
            }
            if !status.success() {
                let code = status.code().unwrap_or(-1);
                return Err(format!(
                    "delayedCollect exit {code}: {}",
                    err.trim().chars().take(200).collect::<String>()
                ));
            }
            Ok(parse_status(&out))
        };
        match tokio::time::timeout(timeout, wait).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "delayedCollect timeout after {}ms",
                self.subprocess_timeout_ms
            )),
        }
    }

    async fn list_ready(&self) -> Vec<PendingItem> {
        let mut names = match tokio::fs::read_dir(&self.ready_dir).await {
            Ok(dir) => dir,
            Err(_) => return Vec::new(),
        };
        let mut items = Vec::new();
        while let Ok(Some(entry)) = names.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.ends_with(".tmp") {
                continue;
            }
            let ready_path = entry.path();
            match tokio::fs::read_to_string(&ready_path).await {
                Ok(raw) => match serde_json::from_str::<PendingRecord>(&raw) {
                    Ok(record) => items.push(PendingItem { ready_path, record }),
                    Err(_) => {
                        let _ = tokio::fs::remove_file(&ready_path).await;
                    }
                },
                Err(_) => {
                    let _ = tokio::fs::remove_file(&ready_path).await;
                }
            }
        }
        items.sort_by(|left, right| {
            let a = left.record.enqueue_ms.unwrap_or(0.0);
            let b = right.record.enqueue_ms.unwrap_or(0.0);
            a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
        });
        items
    }

    async fn claim(&self, ready_path: &Path) -> Option<PathBuf> {
        let name = ready_path.file_name()?;
        let inflight = self.inflight_dir.join(name);
        tokio::fs::rename(ready_path, &inflight).await.ok()?;
        Some(inflight)
    }

    async fn discard_inflight(&self, inflight_path: &Path) {
        let _ = tokio::fs::remove_file(inflight_path).await;
    }

    async fn release_inflight(&self, inflight_path: &Path) {
        let Some(name) = inflight_path.file_name() else {
            return;
        };
        let ready = self.ready_dir.join(name);
        if tokio::fs::rename(inflight_path, &ready).await.is_err() {
            let _ = tokio::fs::remove_file(inflight_path).await;
        }
    }

    async fn recover_inflight(&self) -> usize {
        let mut dir = match tokio::fs::read_dir(&self.inflight_dir).await {
            Ok(dir) => dir,
            Err(_) => return 0,
        };
        let mut count = 0;
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let ready = self.ready_dir.join(&name);
            if tokio::fs::rename(entry.path(), &ready).await.is_ok() {
                count += 1;
            } else {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
        count
    }

    async fn ensure_dirs(&self) {
        let _ = tokio::fs::create_dir_all(&self.ready_dir).await;
        let _ = tokio::fs::create_dir_all(&self.inflight_dir).await;
    }
}

fn parse_status(stdout: &str) -> String {
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(status) = value.get("status").and_then(Value::as_str) {
                return status.to_string();
            }
        }
    }
    "unknown".to_string()
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    #[test]
    fn parse_status_skips_trailing_empty_object() {
        let stdout = "{\"status\":\"timing_pending\"}\n{}\n";
        assert_eq!(parse_status(stdout), "timing_pending");
        assert_eq!(parse_status("{}\n"), "unknown");
        assert_eq!(parse_status("not-json\n{\"status\":\"ok\"}\n"), "ok");
    }
}
