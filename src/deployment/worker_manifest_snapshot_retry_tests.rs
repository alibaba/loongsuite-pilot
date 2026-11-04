//! Stop snapshots can race an already-exiting owned worker on Windows.
//! Query errors retain identity protection and spend the existing phase deadline.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug)]
enum DeniedSnapshot {
    Identity,
    Descendants,
}

struct ExitingSnapshotProcesses {
    root: ProcessIdentity,
    site: DeniedSnapshot,
    persistent: bool,
    reused: bool,
    denied: AtomicBool,
    identity_calls: AtomicUsize,
    descendant_calls: AtomicUsize,
    signals: Mutex<Vec<(u32, bool)>>,
}

impl ExitingSnapshotProcesses {
    fn new(site: DeniedSnapshot, persistent: bool, reused: bool) -> Self {
        Self {
            root: ProcessIdentity {
                pid: 40001,
                creation_time: "owned-generation".into(),
                executable_path: "owned-worker".into(),
            },
            site,
            persistent,
            reused,
            denied: AtomicBool::new(false),
            identity_calls: AtomicUsize::new(0),
            descendant_calls: AtomicUsize::new(0),
            signals: Mutex::new(Vec::new()),
        }
    }
}

impl ProcessOperations for ExitingSnapshotProcesses {
    fn identity(&self, pid: u32) -> std::io::Result<Option<ProcessIdentity>> {
        assert_eq!(pid, self.root.pid, "unknown PIDs never become authorized");
        self.identity_calls.fetch_add(1, Ordering::SeqCst);
        if matches!(self.site, DeniedSnapshot::Identity)
            && (self.persistent || !self.denied.swap(true, Ordering::SeqCst))
        {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        if self.denied.load(Ordering::SeqCst) && !self.persistent {
            return Ok(self.reused.then(|| ProcessIdentity {
                pid,
                creation_time: "foreign-reused-generation".into(),
                executable_path: "foreign-worker".into(),
            }));
        }
        Ok(Some(self.root.clone()))
    }

    fn descendants(&self, root: &ProcessIdentity) -> std::io::Result<Vec<ProcessIdentity>> {
        assert!(self.root.matches(root));
        self.descendant_calls.fetch_add(1, Ordering::SeqCst);
        if matches!(self.site, DeniedSnapshot::Descendants)
            && (self.persistent || !self.denied.swap(true, Ordering::SeqCst))
        {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        Ok(Vec::new())
    }

    fn signal(&self, expected: &ProcessIdentity, force: bool) -> std::io::Result<()> {
        self.signals.lock().unwrap().push((expected.pid, force));
        // The complete snapshot is never available while the process is owned.
        // Any signal would therefore bypass the stop identity/snapshot gate.
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "unexpected signal while snapshot ownership is unconfirmed",
        ))
    }
}

#[tokio::test(start_paused = true)]
async fn transient_denied_stop_snapshot_accepts_gone_or_reused_root_without_any_signal() {
    for site in [DeniedSnapshot::Identity, DeniedSnapshot::Descendants] {
        for reused in [false, true] {
            let ops = ExitingSnapshotProcesses::new(site, false, reused);
            let grace = Duration::from_millis(150);
            let started = Instant::now();
            let result = tokio::time::timeout(
                grace * 2 + Duration::from_millis(50),
                stop_process_tree(&ops, &ops.root, grace),
            )
            .await
            .expect("snapshot retry cannot create a third phase deadline");
            assert!(result.is_ok(), "{site:?}, reused={reused}: {result:?}");
            assert!(ops.denied.load(Ordering::SeqCst));
            assert!(ops.identity_calls.load(Ordering::SeqCst) >= 2);
            assert!(ops.signals.lock().unwrap().is_empty());
            assert!(started.elapsed() <= grace * 2);
            if matches!(site, DeniedSnapshot::Descendants) {
                assert_eq!(ops.descendant_calls.load(Ordering::SeqCst), 1);
            }
        }
    }
}

#[tokio::test(start_paused = true)]
async fn persistent_denied_stop_snapshot_fails_closed_with_only_two_existing_phase_graces() {
    for site in [DeniedSnapshot::Identity, DeniedSnapshot::Descendants] {
        let ops = ExitingSnapshotProcesses::new(site, true, false);
        let grace = Duration::from_millis(150);
        let started = Instant::now();
        let result = tokio::time::timeout(
            grace * 2 + Duration::from_millis(50),
            stop_process_tree(&ops, &ops.root, grace),
        )
        .await
        .expect("snapshot denial remains bounded by the two original phases");
        let (remaining, error) = result.expect_err("unconfirmed ownership cannot report stopped");
        assert_eq!(remaining, vec![ops.root.pid], "{site:?}");
        assert!(!error.is_empty(), "{site:?}");
        assert!(ops.signals.lock().unwrap().is_empty(), "{site:?}");
        assert_eq!(started.elapsed(), grace * 2, "{site:?}");
        assert!(ops.identity_calls.load(Ordering::SeqCst) > 2, "{site:?}");
        if matches!(site, DeniedSnapshot::Descendants) {
            assert!(ops.descendant_calls.load(Ordering::SeqCst) > 2);
        }
    }
}
