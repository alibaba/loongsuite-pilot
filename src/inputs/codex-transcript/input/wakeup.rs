//! Named native filesystem notifications and a bounded fixed-window wakeup queue.
//! Polling remains an independent correctness fallback; known notifications never
//! enumerate rollout directories just to find the already indexed owner.
use super::{CodexTranscriptBody, HostedInput};
use indexmap::IndexSet;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;

const WAKEUP_WINDOW: Duration = Duration::from_millis(200);
const MAX_DIRTY_MARKERS: usize = 1024;

#[derive(Default)]
pub(super) struct WakeupState {
    pub dirty: IndexSet<String>,
    pub only_requested: bool,
    pub discovery_pending: bool,
    pub discovery_revision: u64,
    pub last_full_scan_at: Option<Instant>,
    pub paths: HashMap<String, BTreeSet<String>>,
    deadline: Option<Instant>,
}

pub(super) struct WakeupPlan {
    pub full: bool,
    pub targeted: BTreeSet<String>,
    pub revision: u64,
}

impl WakeupState {
    pub fn note(&mut self, filename: Option<&str>, now: Instant) -> bool {
        if let Some(name) = filename {
            let Some(stem) = name.strip_suffix(".json") else {
                return false;
            };
            if stem.is_empty()
                || !stem
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return false;
            }
        }
        if self.dirty.len() < MAX_DIRTY_MARKERS {
            self.dirty.insert(filename.unwrap_or("*").to_owned());
        } else {
            self.discovery_pending = true;
            self.discovery_revision = self.discovery_revision.wrapping_add(1);
        }
        self.deadline.get_or_insert(now + WAKEUP_WINDOW);
        true
    }

    fn due(&mut self, now: Instant) -> bool {
        if self.dirty.is_empty() {
            self.deadline = None;
            return false;
        }
        if self.deadline.is_none_or(|deadline| deadline > now) {
            return false;
        }
        self.only_requested = true;
        // A busy HostedInput may coalesce this request. Preserve the set and
        // retry until collect consumes it, rather than clearing on timer fire.
        self.deadline = Some(now + WAKEUP_WINDOW);
        true
    }

    pub fn take(&mut self, now: Instant, poll_interval_ms: u64) -> WakeupPlan {
        let only = std::mem::take(&mut self.only_requested);
        let dirty = std::mem::take(&mut self.dirty);
        self.deadline = None;
        let mut targeted = BTreeSet::new();
        for marker in dirty {
            if let Some(paths) = self.paths.get(&marker) {
                targeted.extend(paths.iter().cloned());
            } else {
                self.discovery_pending = true;
                self.discovery_revision = self.discovery_revision.wrapping_add(1);
            }
        }
        WakeupPlan {
            full: !only
                || self.last_full_scan_at.is_none_or(|last| {
                    now.saturating_duration_since(last) >= Duration::from_millis(poll_interval_ms)
                }),
            targeted,
            revision: self.discovery_revision,
        }
    }
}

impl CodexTranscriptBody {
    pub(super) fn note_wakeup(&self, filename: Option<&str>) {
        if self.with_shared(|shared| shared.wakeup.note(filename, Instant::now())) {
            self.wakeup_signal.notify_one();
        }
    }
}

pub(super) struct WakeupWatcher {
    watcher: Option<RecommendedWatcher>,
    pub(super) task: tokio::task::JoinHandle<()>,
}

impl WakeupWatcher {
    pub async fn stop(mut self) {
        // Drop joins the platform watcher backend before clearing input state.
        self.watcher.take();
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for WakeupWatcher {
    fn drop(&mut self) {
        self.watcher.take();
        self.task.abort();
    }
}

fn spawn_named_watcher(
    dir: &str,
    on_change: impl Fn(Option<String>) + Send + Sync + 'static,
) -> Option<RecommendedWatcher> {
    if crate::utils::source_access::current().is_some() {
        return None;
    }
    let directory = Path::new(dir).to_path_buf();
    let callback_directory = directory.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        match result {
            Ok(event) => {
                // Reads performed by this input must not recursively wake it.
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                if event.need_rescan() || event.paths.is_empty() {
                    on_change(None);
                    return;
                }
                for path in event.paths {
                    let name = if path == callback_directory {
                        None
                    } else {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .map(str::to_owned)
                    };
                    on_change(name);
                }
            }
            // A backend overflow/error retains filename-less evidence until a
            // full pass; it never acknowledges or advances source progress.
            Err(_) => on_change(None),
        }
    })
    .ok()?;
    watcher
        .watch(&directory, RecursiveMode::NonRecursive)
        .ok()?;
    Some(watcher)
}

pub(super) fn spawn_wakeup_watcher(
    dir: &str,
    host: Weak<HostedInput<CodexTranscriptBody>>,
    signal: Arc<Notify>,
) -> Option<WakeupWatcher> {
    let callback_host = host.clone();
    let watcher = spawn_named_watcher(dir, move |name| {
        if let Some(host) = callback_host.upgrade() {
            host.body.note_wakeup(name.as_deref());
        }
    })?;
    let task = tokio::spawn(async move {
        loop {
            let notified = signal.notified();
            let Some(input) = host.upgrade() else {
                break;
            };
            let deadline = input.body.with_shared(|s| s.wakeup.deadline);
            drop(input);
            if let Some(deadline) = deadline {
                tokio::time::sleep_until(deadline).await;
                let Some(input) = host.upgrade() else {
                    break;
                };
                if !input.running() {
                    break;
                }
                if input.body.with_shared(|s| s.wakeup.due(Instant::now())) {
                    input.request_collection();
                }
            } else {
                notified.await;
            }
        }
    });
    Some(WakeupWatcher {
        watcher: Some(watcher),
        task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main541_fixed_window_is_not_postponed_by_sustained_bursts_and_ignores_temporary_names() {
        let now = Instant::now();
        let mut state = WakeupState {
            last_full_scan_at: Some(now),
            ..Default::default()
        };
        state
            .paths
            .insert("a.json".into(), BTreeSet::from(["/sessions/a".into()]));
        state
            .paths
            .insert("b.json".into(), BTreeSet::from(["/sessions/b".into()]));
        for _ in 0..1000 {
            assert!(state.note(Some("a.json"), now));
        }
        state.note(Some("b.json"), now);
        assert!(!state.note(Some(".a.json.123.tmp"), now));
        assert!(!state.note(Some("._a.json"), now));
        assert!(!state.due(now + Duration::from_millis(199)));
        state.note(Some("a.json"), now + Duration::from_millis(199));
        assert!(state.due(now + Duration::from_millis(200)));
        let plan = state.take(now + Duration::from_millis(200), 10_000);
        assert!(!plan.full);
        assert_eq!(
            plan.targeted,
            BTreeSet::from(["/sessions/a".into(), "/sessions/b".into()])
        );
        assert!(state.dirty.is_empty());
    }

    #[test]
    fn main541_busy_requests_retain_dirty_markers_until_collect_takes_them() {
        let now = Instant::now();
        let mut state = WakeupState::default();
        state.note(Some("a.json"), now);
        for millis in [200, 400, 600] {
            assert!(state.due(now + Duration::from_millis(millis)));
        }
        assert!(state.dirty.contains("a.json"));
        assert!(state.due(now + Duration::from_millis(800)));
        state.take(now + Duration::from_millis(800), 10_000);
        assert!(state.dirty.is_empty());
        assert!(!state.due(now + Duration::from_millis(1000)));
    }

    #[test]
    fn main541_unknown_overflow_and_continuous_events_preserve_full_poll_fallback() {
        let now = Instant::now();
        let mut state = WakeupState {
            last_full_scan_at: Some(now),
            ..Default::default()
        };
        state.note(Some("new.json"), now);
        assert!(state.due(now + Duration::from_millis(200)));
        let plan = state.take(now + Duration::from_millis(200), 10_000);
        assert!(!plan.full);
        assert!(plan.targeted.is_empty());
        assert!(state.discovery_pending);
        assert!(state.take(now + Duration::from_millis(201), 10_000).full);
        state.note(Some("a.json"), now + Duration::from_millis(10_000));
        assert!(state.due(now + Duration::from_millis(10_200)));
        assert!(state.take(now + Duration::from_millis(10_200), 10_000).full);
        for index in 0..1025 {
            state.note(Some(&format!("session-{index}.json")), now);
        }
        assert_eq!(state.dirty.len(), 1024);
        assert!(state.discovery_pending);
        let revision = state.discovery_revision;
        state.note(None, now);
        assert_eq!(state.dirty.len(), 1024);
        assert!(state.discovery_revision > revision);
    }

    #[tokio::test]
    async fn idle_watcher_stops_and_drop_reaps_without_another_filesystem_event() {
        let root = tempfile::tempdir().unwrap();
        for explicit_stop in [true, false] {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let watcher = spawn_named_watcher(root.path().to_str().unwrap(), move |name| {
                let _ = tx.send(name);
            })
            .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                if explicit_stop {
                    drop(watcher);
                } else {
                    let _owned = watcher;
                }
                while rx.recv().await.is_some() {}
            })
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn watcher_drains_bursts_and_can_restart_on_the_same_unicode_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("唤醒 空格 🐉");
        std::fs::create_dir(&dir).unwrap();
        for round in 0..2 {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let watcher = spawn_named_watcher(dir.to_str().unwrap(), move |name| {
                let _ = tx.send(name);
            })
            .unwrap();
            for index in 0..160 {
                std::fs::write(dir.join(format!("marker-{round}-{index}.json")), "{}").unwrap();
            }
            let mut names = BTreeSet::new();
            tokio::time::timeout(Duration::from_secs(2), async {
                while names.len() < 160 {
                    match rx.recv().await {
                        Some(Some(name)) => {
                            names.insert(name);
                        }
                        Some(None) => {}
                        None => panic!("watch backend ended before draining burst"),
                    }
                }
            })
            .await
            .unwrap();
            drop(watcher);
            while rx.try_recv().is_ok() {}
            assert!(rx.recv().await.is_none());
        }
    }

    #[tokio::test]
    async fn invalid_wakeup_directory_does_not_create_a_task() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            spawn_named_watcher(root.path().join("missing").to_str().unwrap(), |_| {}).is_none()
        );
        assert!(spawn_named_watcher("bad\0path", |_| {}).is_none());
    }
}
