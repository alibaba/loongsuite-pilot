//! Bounded metadata walk of mutable Pilot data directories.
//!
//! Only `logs`, `state`, `cache`, `configs`, `agents.d.local`, `acp-correlate`,
//! `sls-failed-logs`, `sls-failed-logs.delete-pending`, and `local-workers` are
//! recursed. Local-worker `bundle`, `.bundle.staging-*`, and `.bundle.backup-*`
//! trees are skipped. Symlinks are not followed. Incomplete scans keep the last
//! complete byte totals.

use crate::utils::create_logger;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;
#[path = "disk_usage_fs.rs"]
mod fs_io;
use fs_io::{Directory, FileSystem, Kind, NativeFileSystem, Node};

pub const DISK_USAGE_STALE_MS: i64 = 20 * 60 * 1000;

const SCANNED_DATA_DIRECTORIES: &[&str] = &[
    "logs",
    "state",
    "cache",
    "configs",
    "agents.d.local",
    "acp-correlate",
    "sls-failed-logs",
    "sls-failed-logs.delete-pending",
    "local-workers",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiskUsageStatus {
    Pending,
    Ok,
    Partial,
    Timeout,
    Error,
    Stale,
}

impl DiskUsageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ok => "ok",
            Self::Partial => "partial",
            Self::Timeout => "timeout",
            Self::Error => "error",
            Self::Stale => "stale",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiskUsageSnapshot {
    pub status: DiskUsageStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs_bytes: Option<u64>,
}

impl Default for DiskUsageSnapshot {
    fn default() -> Self {
        Self {
            status: DiskUsageStatus::Pending,
            sampled_at: None,
            scan_ms: None,
            data_bytes: None,
            logs_bytes: None,
        }
    }
}

pub struct DiskUsageSamplerOptions {
    pub data_dir: String,
    pub initial_delay_ms: u64,
    pub interval_ms: u64,
    pub batch_size: u64,
    pub batch_pause_ms: u64,
    pub max_depth: usize,
    pub max_entries: u64,
    pub budget_ms: u128,
}

impl DiskUsageSamplerOptions {
    pub fn new(data_dir: impl Into<String>) -> Self {
        Self {
            data_dir: data_dir.into(),
            initial_delay_ms: 30_000,
            interval_ms: 10 * 60_000,
            batch_size: 100,
            batch_pause_ms: 20,
            max_depth: 32,
            max_entries: 200_000,
            budget_ms: 10_000,
        }
    }
}

struct SamplerState {
    snapshot: DiskUsageSnapshot,
    active: bool,
    stopped: bool,
    failures: u32,
    next_attempt_at: i64,
    in_flight: bool,
    flight: Option<Arc<ScanGate>>,
    opened: Vec<PathBuf>,
}

pub struct DiskUsageSampler {
    options: DiskUsageSamplerOptions,
    state: Arc<Mutex<SamplerState>>,
    generation: Arc<AtomicU64>,
    cancel_pause: Notify,
    fs: Arc<dyn FileSystem>,
    on_sample: Arc<dyn Fn(DiskUsageSnapshot) + Send + Sync>,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    #[cfg(test)]
    test_read_calls: AtomicU64,
}

impl DiskUsageSampler {
    pub fn new(
        options: DiskUsageSamplerOptions,
        on_sample: Arc<dyn Fn(DiskUsageSnapshot) + Send + Sync>,
    ) -> Self {
        Self {
            options,
            state: Arc::new(Mutex::new(SamplerState {
                snapshot: DiskUsageSnapshot::default(),
                active: false,
                stopped: false,
                failures: 0,
                next_attempt_at: 0,
                in_flight: false,
                flight: None,
                opened: Vec::new(),
            })),
            generation: Arc::new(AtomicU64::new(0)),
            cancel_pause: Notify::new(),
            fs: Arc::new(NativeFileSystem),
            on_sample,
            now_ms: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            task: Mutex::new(None),
            #[cfg(test)]
            test_read_calls: AtomicU64::new(0),
        }
    }

    pub fn start(self: &Arc<Self>) {
        let mut state = self.state.lock().expect("disk sampler");
        if state.active {
            return;
        }
        state.active = true;
        state.stopped = false;
        state.next_attempt_at = 0;
        let generation = self.generation.load(Ordering::SeqCst);
        drop(state);
        let sampler = Arc::clone(self);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(sampler.options.initial_delay_ms)).await;
            loop {
                if !sampler.active_generation(generation) {
                    break;
                }
                let (flight, due) = {
                    let state = sampler.state.lock().expect("disk sampler");
                    (state.flight.clone(), state.next_attempt_at)
                };
                // A restart tick may encounter the old generation's outstanding
                // IO. Wait for its owner to close handles, then sample immediately.
                if let Some(flight) = flight {
                    flight.wait().await;
                    continue;
                }
                let now = (sampler.now_ms)();
                if due > now {
                    tokio::time::sleep(Duration::from_millis((due - now) as u64)).await;
                    continue;
                }
                sampler.sample().await;
            }
        });
        *self.task.lock().expect("disk task") = Some(handle);
    }
    pub fn stop(&self) {
        let mut state = self.state.lock().expect("disk sampler");
        state.active = false;
        state.stopped = true;
        drop(state);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.cancel_pause.notify_waiters();
        if let Some(task) = self.task.lock().expect("disk task").take() {
            task.abort();
        }
    }
    fn active_generation(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
            && self.state.lock().expect("disk sampler").active
    }
    async fn cancelled(&self, generation: u64) {
        loop {
            let notified = self.cancel_pause.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if generation != self.generation.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn test_is_scheduled(&self) -> bool {
        self.task.lock().expect("disk task").is_some()
    }

    pub fn get_snapshot(&self) -> DiskUsageSnapshot {
        let state = self.state.lock().expect("disk sampler");
        let mut snapshot = state.snapshot.clone();
        if snapshot.status == DiskUsageStatus::Ok {
            if let Some(sampled_at) = snapshot.sampled_at {
                if (self.now_ms)() - sampled_at > DISK_USAGE_STALE_MS {
                    snapshot.status = DiskUsageStatus::Stale;
                }
            }
        }
        snapshot
    }

    pub fn store_snapshot(&self, snapshot: DiskUsageSnapshot) {
        self.state.lock().expect("disk sampler").snapshot = snapshot;
    }

    pub fn opened_directories(&self) -> Vec<PathBuf> {
        self.state.lock().expect("disk sampler").opened.clone()
    }

    pub async fn sample(self: &Arc<Self>) {
        let generation = self.generation.load(Ordering::SeqCst);
        let (flight, lead) = {
            let mut state = self.state.lock().expect("disk sampler");
            if state.stopped {
                return;
            }
            if let Some(flight) = &state.flight {
                (Arc::clone(flight), false)
            } else {
                let flight = Arc::new(ScanGate {
                    done: AtomicBool::new(false),
                    notify: Notify::new(),
                });
                state.flight = Some(Arc::clone(&flight));
                state.in_flight = true;
                state.opened.clear();
                (flight, true)
            }
        };
        if lead {
            let sampler = Arc::clone(self);
            let done = Arc::clone(&flight);
            tokio::spawn(async move {
                let _settle = SettleScan {
                    sampler: Arc::clone(&sampler),
                    flight: done,
                };
                sampler.sample_owned(generation).await;
            });
        }
        flight.wait().await;
    }
    async fn sample_owned(&self, generation: u64) {
        let started = Instant::now();
        let outcome = walk(self, generation, started).await;
        let mut state = self.state.lock().expect("disk sampler");
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        let scan_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        if outcome.status == DiskUsageStatus::Ok {
            state.snapshot = DiskUsageSnapshot {
                status: DiskUsageStatus::Ok,
                data_bytes: Some(outcome.data_bytes),
                logs_bytes: Some(outcome.logs_bytes),
                sampled_at: Some((self.now_ms)()),
                scan_ms: Some(scan_ms),
            };
            state.failures = 0;
        } else if outcome.status != DiskUsageStatus::Pending {
            state.snapshot.status = outcome.status;
            state.snapshot.scan_ms = Some(scan_ms);
            state.failures += 1;
        }
        let multiplier = backoff_multiplier(state.failures);
        // Missed attempts are never queued after slow IO; the next interval
        // begins only after this owned scan and its directory closes settle.
        state.next_attempt_at = (self.now_ms)().saturating_add(
            (self
                .options
                .interval_ms
                .saturating_mul(u64::from(multiplier)))
            .min(i64::MAX as u64) as i64,
        );
        let published = self.get_snapshot_locked(&state);
        drop(state);
        if outcome.status != DiskUsageStatus::Ok {
            create_logger("DiskUsageSampler").debug(
                "Directory usage scan incomplete",
                Some(
                    &serde_json::json!({"status":outcome.status.as_str(),"scanMs":scan_ms})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            );
        }
        if let Err(error) =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.on_sample)(published)))
        {
            create_logger("DiskUsageSampler").warn(
                "Directory usage sample callback failed",
                Some(
                    &serde_json::json!({"err":format!("{error:?}")})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            );
        }
    }

    fn get_snapshot_locked(&self, state: &SamplerState) -> DiskUsageSnapshot {
        let mut snapshot = state.snapshot.clone();
        if snapshot.status == DiskUsageStatus::Ok {
            if let Some(sampled_at) = snapshot.sampled_at {
                if (self.now_ms)() - sampled_at > DISK_USAGE_STALE_MS {
                    snapshot.status = DiskUsageStatus::Stale;
                }
            }
        }
        snapshot
    }
}

pub fn backoff_multiplier(failures: u32) -> u32 {
    if failures < 2 {
        1
    } else {
        6.min(2u32.saturating_pow(failures.saturating_sub(1).min(3)))
    }
}

struct WalkOutcome {
    status: DiskUsageStatus,
    data_bytes: u64,
    logs_bytes: u64,
}

struct ScanGate {
    done: AtomicBool,
    notify: Notify,
}
impl ScanGate {
    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.done.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}
struct SettleScan {
    sampler: Arc<DiskUsageSampler>,
    flight: Arc<ScanGate>,
}
impl Drop for SettleScan {
    fn drop(&mut self) {
        let mut state = self.sampler.state.lock().expect("disk sampler");
        if state
            .flight
            .as_ref()
            .is_some_and(|flight| Arc::ptr_eq(flight, &self.flight))
        {
            state.flight = None;
            state.in_flight = false;
        }
        drop(state);
        self.flight.done.store(true, Ordering::SeqCst);
        self.flight.notify.notify_waiters();
    }
}
struct Frame {
    path: PathBuf,
    dir: Box<dyn Directory>,
    identity: (u64, u64),
    in_logs: bool,
}
fn check(
    sampler: &DiskUsageSampler,
    generation: u64,
    started: Instant,
) -> Result<(), DiskUsageStatus> {
    if generation != sampler.generation.load(Ordering::SeqCst) {
        return Err(DiskUsageStatus::Pending);
    }
    if started.elapsed().as_millis() >= sampler.options.budget_ms {
        return Err(DiskUsageStatus::Timeout);
    }
    Ok(())
}
async fn paths_still(
    sampler: &DiskUsageSampler,
    paths: &[(PathBuf, (u64, u64))],
    root: &Path,
    generation: u64,
    started: Instant,
) -> Result<(), DiskUsageStatus> {
    for (path, identity) in paths {
        let meta = sampler.fs.metadata(path).await;
        check(sampler, generation, started)?;
        if !meta.is_ok_and(|meta| meta.kind == Kind::Directory && meta.identity == *identity) {
            return Err(if path == root {
                DiskUsageStatus::Error
            } else {
                DiskUsageStatus::Partial
            });
        }
    }
    Ok(())
}
async fn open_frame(
    sampler: &DiskUsageSampler,
    path: PathBuf,
    meta: Node,
    in_logs: bool,
    ancestors: Vec<(PathBuf, (u64, u64))>,
    root: &Path,
    attempt: (u64, Instant),
) -> Result<Frame, DiskUsageStatus> {
    let (generation, started) = attempt;
    check(sampler, generation, started)?;
    let resolved = sampler.fs.realpath(&path).await;
    check(sampler, generation, started)?;
    if !resolved.is_ok_and(|resolved| resolved == path && resolved.starts_with(root)) {
        return Err(if path == root {
            DiskUsageStatus::Error
        } else {
            DiskUsageStatus::Partial
        });
    }
    let opened = sampler.fs.open(&path).await;
    let late = check(sampler, generation, started);
    let mut dir = match opened {
        Ok(dir) => dir,
        Err(_) => {
            late?;
            return Err(if path == root {
                DiskUsageStatus::Error
            } else {
                DiskUsageStatus::Partial
            });
        }
    };
    sampler
        .state
        .lock()
        .expect("disk sampler")
        .opened
        .push(path.clone());
    let mut paths = ancestors;
    paths.push((path.clone(), meta.identity));
    let valid = if let Err(status) = late {
        Err(status)
    } else if dir.identity() != meta.identity {
        Err(if path == root {
            DiskUsageStatus::Error
        } else {
            DiskUsageStatus::Partial
        })
    } else {
        paths_still(sampler, &paths, root, generation, started).await
    };
    if let Err(status) = valid {
        let _ = dir.close().await;
        return Err(status);
    }
    Ok(Frame {
        path,
        dir,
        identity: meta.identity,
        in_logs,
    })
}
async fn walk(sampler: &DiskUsageSampler, generation: u64, started: Instant) -> WalkOutcome {
    let empty = |status| WalkOutcome {
        status,
        data_bytes: 0,
        logs_bytes: 0,
    };
    let root = sampler
        .fs
        .realpath(Path::new(&sampler.options.data_dir))
        .await;
    if let Err(status) = check(sampler, generation, started) {
        return empty(status);
    }
    let root = match root {
        Ok(root) => root,
        Err(_) => return empty(DiskUsageStatus::Error),
    };
    let meta = sampler.fs.metadata(&root).await;
    if let Err(status) = check(sampler, generation, started) {
        return empty(status);
    }
    let meta = match meta {
        Ok(meta) if meta.kind == Kind::Directory => meta,
        _ => return empty(DiskUsageStatus::Error),
    };
    let frame = match open_frame(
        sampler,
        root.clone(),
        meta,
        false,
        Vec::new(),
        &root,
        (generation, started),
    )
    .await
    {
        Ok(frame) => frame,
        Err(status) => return empty(status),
    };
    let mut frames = vec![frame];
    let mut entries = 0u64;
    let mut data_bytes = 0u64;
    let mut logs_bytes = 0u64;
    let mut status = DiskUsageStatus::Ok;
    loop {
        if frames.is_empty() {
            break;
        }
        if let Err(interrupted) = check(sampler, generation, started) {
            status = interrupted;
            break;
        }
        if entries >= sampler.options.max_entries {
            status = DiskUsageStatus::Partial;
            break;
        }
        let paths = frames
            .iter()
            .map(|frame| (frame.path.clone(), frame.identity))
            .collect::<Vec<_>>();
        if let Err(failure) = paths_still(sampler, &paths, &root, generation, started).await {
            status = failure;
            break;
        }
        let last = frames.len() - 1;
        #[cfg(test)]
        sampler.test_read_calls.fetch_add(1, Ordering::SeqCst);
        let next = frames[last].dir.read().await;
        if let Err(failure) = check(sampler, generation, started) {
            status = failure;
            break;
        }
        // A root/ancestor removed during the read cannot become a false empty
        // success, even when the OS returns end-of-directory.
        if let Err(failure) = paths_still(sampler, &paths, &root, generation, started).await {
            status = failure;
            break;
        }
        let name = match next {
            Ok(Some(name)) => name,
            Ok(None) => {
                let mut frame = frames.pop().unwrap();
                if frame.dir.close().await.is_err() {
                    status = DiskUsageStatus::Partial;
                    break;
                }
                // Enumeration is complete: a slow final close is not a timeout.
                continue;
            }
            Err(_) => {
                status = DiskUsageStatus::Partial;
                break;
            }
        };
        entries += 1;
        if sampler.options.batch_size > 0 && entries.is_multiple_of(sampler.options.batch_size) {
            tokio::select! {_=tokio::time::sleep(Duration::from_millis(sampler.options.batch_pause_ms))=>{},_=sampler.cancelled(generation)=>{}}
            if let Err(failure) = check(sampler, generation, started) {
                status = failure;
                break;
            }
        }
        let parent = frames[last].path.clone();
        let path = parent.join(&name);
        let meta = sampler.fs.metadata(&path).await;
        if let Err(failure) = check(sampler, generation, started) {
            status = failure;
            break;
        }
        let meta = match meta {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                status = DiskUsageStatus::Partial;
                break;
            }
        };
        match meta.kind {
            Kind::Link | Kind::Other => {}
            Kind::File => {
                let Some(total) = data_bytes.checked_add(meta.bytes) else {
                    status = DiskUsageStatus::Partial;
                    break;
                };
                data_bytes = total;
                if frames[last].in_logs {
                    let Some(total) = logs_bytes.checked_add(meta.bytes) else {
                        status = DiskUsageStatus::Partial;
                        break;
                    };
                    logs_bytes = total;
                }
            }
            Kind::Directory => {
                let normalized = name.to_string_lossy().to_lowercase();
                if parent == root && !SCANNED_DATA_DIRECTORIES.contains(&normalized.as_str()) {
                    continue;
                }
                if is_local_worker_payload(&parent, &normalized, &root) {
                    continue;
                }
                if frames.len() >= sampler.options.max_depth {
                    status = DiskUsageStatus::Partial;
                    break;
                }
                let in_logs = frames[last].in_logs || (parent == root && normalized == "logs");
                let ancestors = frames
                    .iter()
                    .map(|frame| (frame.path.clone(), frame.identity))
                    .collect();
                match open_frame(
                    sampler,
                    path,
                    meta,
                    in_logs,
                    ancestors,
                    &root,
                    (generation, started),
                )
                .await
                {
                    Ok(frame) => frames.push(frame),
                    Err(failure) => {
                        status = failure;
                        break;
                    }
                }
            }
        }
    }
    // Every frame stays owned through its last outstanding IO and close,
    // including cancellation/timeout/error paths. Never publish partial totals.
    while let Some(mut frame) = frames.pop() {
        if frame.dir.close().await.is_err() && status == DiskUsageStatus::Ok {
            status = DiskUsageStatus::Partial;
        }
    }
    if generation != sampler.generation.load(Ordering::SeqCst) {
        status = DiskUsageStatus::Pending;
    }
    WalkOutcome {
        status,
        data_bytes,
        logs_bytes,
    }
}
fn is_local_worker_payload(directory: &Path, name: &str, root: &Path) -> bool {
    directory
        .parent()
        .is_some_and(|parent| parent == root.join("local-workers"))
        && (name == "bundle"
            || name.starts_with(".bundle.staging-")
            || name.starts_with(".bundle.backup-"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn write_file(path: &Path, bytes: usize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    #[tokio::test]
    async fn counts_mutable_data_and_skips_managed_roots_and_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join(".hidden"), 3);
        write_file(&root.join("logs").join("output").join("a.jsonl"), 7);
        write_file(&root.join("local-workers").join("logs").join("b"), 11);
        write_file(&root.join("versions").join("payload.bin"), 1000);
        write_file(
            &root
                .join("local-workers")
                .join("lw_1")
                .join("state")
                .join("checkpoint.json"),
            5,
        );
        write_file(
            &root
                .join("local-workers")
                .join("lw_1")
                .join("bundle")
                .join("index.js"),
            101,
        );
        write_file(&root.join("state").join("checkpoint.json"), 7);
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("logs"), root.join("linked-logs")).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_cb = calls.clone();
        let sampler = Arc::new(DiskUsageSampler::new(
            DiskUsageSamplerOptions {
                batch_pause_ms: 0,
                ..DiskUsageSamplerOptions::new(root.to_string_lossy())
            },
            Arc::new(move |_| {
                calls_cb.fetch_add(1, Ordering::SeqCst);
            }),
        ));
        assert_eq!(sampler.get_snapshot().status, DiskUsageStatus::Pending);
        sampler.sample().await;
        let snapshot = sampler.get_snapshot();
        assert_eq!(snapshot.status, DiskUsageStatus::Ok);
        assert_eq!(snapshot.data_bytes, Some(3 + 7 + 11 + 5 + 7));
        assert_eq!(snapshot.logs_bytes, Some(7));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let opened = sampler.opened_directories();
        assert!(opened.iter().all(|path| !path.ends_with("versions")));
        assert!(opened
            .iter()
            .all(|path| path.file_name().and_then(|name| name.to_str()) != Some("bundle")));
        let copy = sampler.get_snapshot();
        assert_eq!(copy.data_bytes, Some(33));
    }

    #[tokio::test]
    async fn reports_an_empty_directory_as_zero_and_returns_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let sampler = Arc::new(DiskUsageSampler::new(
            DiskUsageSamplerOptions {
                batch_pause_ms: 0,
                ..DiskUsageSamplerOptions::new(dir.path().to_string_lossy())
            },
            Arc::new(|_| {}),
        ));
        sampler.sample().await;
        let mut snapshot = sampler.get_snapshot();
        assert_eq!(snapshot.data_bytes, Some(0));
        snapshot.data_bytes = Some(999);
        assert_eq!(snapshot.data_bytes, Some(999));
        assert_eq!(sampler.get_snapshot().data_bytes, Some(0));
    }

    #[tokio::test]
    async fn does_not_publish_partial_sums_when_the_entry_budget_is_hit() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..30 {
            write_file(&dir.path().join("logs").join(format!("f{index}")), 4);
        }
        let sampler = Arc::new(DiskUsageSampler::new(
            DiskUsageSamplerOptions {
                batch_pause_ms: 0,
                max_entries: 5,
                ..DiskUsageSamplerOptions::new(dir.path().to_string_lossy())
            },
            Arc::new(|_| {}),
        ));
        sampler.sample().await;
        let snapshot = sampler.get_snapshot();
        assert_eq!(snapshot.status, DiskUsageStatus::Partial);
        assert!(snapshot.data_bytes.is_none());
    }

    #[test]
    fn backs_off_after_two_failures() {
        assert_eq!(backoff_multiplier(0), 1);
        assert_eq!(backoff_multiplier(1), 1);
        assert_eq!(backoff_multiplier(2), 2);
        assert_eq!(backoff_multiplier(3), 4);
        assert_eq!(backoff_multiplier(4), 6);
        assert_eq!(backoff_multiplier(8), 6);
    }

    #[tokio::test]
    async fn marks_a_missing_root_as_error() {
        let sampler = Arc::new(DiskUsageSampler::new(
            DiskUsageSamplerOptions::new("/no/such/pilot-data-dir"),
            Arc::new(|_| {}),
        ));
        sampler.sample().await;
        assert_eq!(sampler.get_snapshot().status, DiskUsageStatus::Error);
        assert!(sampler.get_snapshot().data_bytes.is_none());
    }
}

#[cfg(test)]
#[path = "disk_sampler_history_contract_tests.rs"]
mod history_contract_tests;
