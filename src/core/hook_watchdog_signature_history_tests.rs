//! f84 filesystem-identity contract, with real replacements and metadata changes.
use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Fixture {
    root: tempfile::TempDir,
    settings: PathBuf,
    watch: PathBuf,
    inspected: Arc<AtomicUsize>,
    repaired: Arc<AtomicUsize>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let settings = root.path().join("hooks.json");
        let watch = root.path().join("config.toml");
        std::fs::write(
            &settings,
            r#"{"hooks":{"Stop":[{"command":"/fixture/pilot-hook.sh"}]}}"#,
        )
        .unwrap();
        Self {
            root,
            settings,
            watch,
            inspected: Arc::new(AtomicUsize::new(0)),
            repaired: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn target(&self) -> PluginCheckTarget {
        let inspected = self.inspected.clone();
        let repaired = self.repaired.clone();
        PluginCheckTarget {
            agent_id: "codex".into(),
            settings_path: self.settings.to_string_lossy().into_owned(),
            settings_syntax: JsonSyntax::Json,
            expected_hooks: vec!["Stop".into()],
            markers: vec!["pilot-hook.sh".into()],
            bin_path: None,
            install_args: Vec::new(),
            repair_fn: Some(Arc::new(move || {
                repaired.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(true) })
            })),
            needs_repair: None,
            change_watch_path: Some(self.watch.to_string_lossy().into_owned()),
            needs_repair_on_change: Some(Arc::new(move || {
                inspected.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(true) })
            })),
            enabled: None,
        }
    }
    fn wd(&self) -> HookWatchdog {
        HookWatchdog::new(
            HookWatchdogConfig {
                enabled: true,
                interval_ms: 60_000,
                repair_cooldown_ms: 0,
            },
            vec![self.target()],
            Vec::new(),
        )
    }
    fn counts(&self) -> [usize; 2] {
        [
            self.inspected.load(Ordering::SeqCst),
            self.repaired.load(Ordering::SeqCst),
        ]
    }
}
fn restore_modified(path: &Path, time: SystemTime) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(time))
        .unwrap();
}
#[tokio::test]
async fn identity_equal_size_atomic_replacement_with_restored_mtime_rechecks_trust() {
    let f = Fixture::new();
    std::fs::write(&f.watch, "model = \"alpha\"\n").unwrap();
    let before = std::fs::metadata(&f.watch).unwrap();
    let wd = f.wd();
    assert_eq!(wd.run_check().await.checked, 1);
    assert_eq!(f.counts(), [0, 0]);
    let replacement = f.root.path().join("replacement.toml");
    std::fs::write(&replacement, "model = \"bravo\"\n").unwrap();
    restore_modified(&replacement, before.modified().unwrap());
    std::fs::rename(&replacement, &f.watch).unwrap();
    let after = std::fs::metadata(&f.watch).unwrap();
    assert_eq!(before.len(), after.len());
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    assert_eq!(
        wd.run_check().await.repaired,
        1,
        "same-size atomic replacement must not disappear behind a restored mtime"
    );
    assert_eq!(f.counts(), [1, 1]);
    wd.run_check().await;
    assert_eq!(f.counts(), [1, 1]);
}
#[tokio::test]
async fn identity_same_inode_rewrite_with_restored_mtime_uses_real_change_time() {
    let f = Fixture::new();
    std::fs::write(&f.watch, "model = \"alpha\"\n").unwrap();
    let before = std::fs::metadata(&f.watch).unwrap();
    let wd = f.wd();
    wd.run_check().await;
    tokio::time::sleep(Duration::from_millis(2)).await;
    std::fs::write(&f.watch, "model = \"bravo\"\n").unwrap();
    restore_modified(&f.watch, before.modified().unwrap());
    let after = std::fs::metadata(&f.watch).unwrap();
    assert_eq!(before.len(), after.len());
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
    }
    assert_eq!(
        wd.run_check().await.repaired,
        1,
        "real ctime witnesses an in-place producer rewrite that restores LastWriteTime"
    );
    assert_eq!(f.counts(), [1, 1]);
    wd.run_check().await;
    assert_eq!(f.counts(), [1, 1]);
}
#[tokio::test]
async fn metadata_io_error_does_not_become_a_healthy_baseline_and_other_target_runs() {
    let f = Fixture::new();
    let mut bad = f.target();
    bad.change_watch_path = Some(format!("{}\0config.toml", f.root.path().display()));
    let mut healthy = f.target();
    healthy.agent_id = "healthy-peer".into();
    healthy.change_watch_path = None;
    healthy.needs_repair_on_change = None;
    let wd = HookWatchdog::new(
        HookWatchdogConfig {
            enabled: true,
            interval_ms: 60_000,
            repair_cooldown_ms: 0,
        },
        vec![bad, healthy],
        Vec::new(),
    );
    for _ in 0..2 {
        assert_eq!(
            wd.run_check().await,
            CheckResult {
                checked: 1,
                repaired: 0,
                skipped: 0
            },
            "a real invalid-path IO error must stay retryable and not be counted healthy"
        );
    }
    assert!(wd.last_change_signature.lock().unwrap().is_empty());
    assert_eq!(f.counts(), [0, 0]);
}
#[tokio::test]
async fn identity_missing_creation_removal_and_idle_polls_have_distinct_observations() {
    let f = Fixture::new();
    let wd = f.wd();
    wd.run_check().await;
    wd.run_check().await;
    assert_eq!(f.counts(), [0, 0]);
    std::fs::write(&f.watch, "model = \"created\"\n").unwrap();
    assert_eq!(wd.run_check().await.repaired, 1);
    assert_eq!(f.counts(), [1, 1]);
    wd.run_check().await;
    assert_eq!(f.counts(), [1, 1]);
    std::fs::remove_file(&f.watch).unwrap();
    assert_eq!(wd.run_check().await.repaired, 1);
    assert_eq!(f.counts(), [2, 2]);
    wd.run_check().await;
    assert_eq!(f.counts(), [2, 2]);
}
