//! Filesystem contracts from ef8953 log-retention-service.test.ts.
use super::*;
use std::sync::Arc;

fn config() -> LogRetentionConfig {
    LogRetentionConfig {
        enabled: true,
        interval_ms: 3_600_000,
        hook_history_days: 7,
        hook_error_days: 7,
        hook_debug_days: 7,
        output_days: 7,
        sls_failed_days: 7,
        otlp_failed_days: 7,
        metric_alarm_days: 7,
    }
}
fn date(days: i64) -> String {
    (Local::now().date_naive() - ChronoDuration::days(days))
        .format("%Y-%m-%d")
        .to_string()
}
struct Fixture(tempfile::TempDir);
impl Fixture {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }
    fn path(&self, path: &str) -> PathBuf {
        self.0.path().join(path)
    }
    fn write(&self, path: &str, bytes: &[u8]) -> PathBuf {
        let path = self.path(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }
    fn sized(&self, path: &str, size: u64) -> PathBuf {
        let path = self.write(path, b"");
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        make_sparse(&file);
        file.set_len(size).unwrap();
        path
    }
    fn service(&self, config: LogRetentionConfig) -> LogRetentionService {
        LogRetentionService::new(self.0.path(), config)
    }
}
fn make_sparse(_file: &std::fs::File) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::IO::DeviceIoControl;
        let mut returned = 0;
        // FSCTL_SET_SPARSE affects only this test's new tempfile. Logical byte
        // thresholds remain production values without allocating tens of GiB.
        let result = unsafe {
            DeviceIoControl(
                _file.as_raw_handle(),
                0x0009_00c4,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
    }
}
async fn large_files() -> tokio::sync::MutexGuard<'static, ()> {
    static GATE: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}
fn symlink_file(from: &Path, to: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(from, to).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(from, to).unwrap();
}
fn old_mtime(path: &Path, days: i64) {
    let time = std::time::SystemTime::now() - Duration::from_secs(days as u64 * 86_400);
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_accessed(time)
                .set_modified(time),
        )
        .unwrap();
}

#[tokio::test]
async fn history_l72_deletes_only_expired_history_files() {
    let f = Fixture::new();
    let old = f.write(
        &format!("logs/cursor-hook/history/cursor-{}.jsonl", date(10)),
        b"{\"test\":1}\n",
    );
    let recent = f.write(
        &format!("logs/cursor-hook/history/cursor-{}.jsonl", date(3)),
        b"{\"test\":2}\n",
    );
    let today = f.write(
        &format!("logs/cursor-hook/history/cursor-{}.jsonl", date(0)),
        b"{\"test\":3}\n",
    );
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert!(recent.exists());
    assert!(today.exists());
}
#[tokio::test]
async fn history_l97_applies_each_category_retention() {
    let f = Fixture::new();
    let history = f.write(
        &format!("logs/qoder/history/qoder-cli-{}.jsonl", date(5)),
        b"",
    );
    let debug = f.write(
        &format!("logs/qoder/debug/qoder-cli-debug-{}.log", date(5)),
        b"",
    );
    let errors = f.write(
        &format!("logs/qoder/errors/qoder-cli-error-{}.log", date(5)),
        b"",
    );
    let mut cfg = config();
    cfg.hook_debug_days = 3;
    assert_eq!(f.service(cfg).run_cleanup().await, (1, 0));
    assert!(history.exists());
    assert!(!debug.exists());
    assert!(errors.exists());
}
#[tokio::test]
async fn history_l125_protects_today_with_zero_retention() {
    let f = Fixture::new();
    let path = f.write(
        &format!("logs/test-agent/history/test-{}.jsonl", date(0)),
        b"{\"safe\":true}\n",
    );
    let mut cfg = config();
    cfg.hook_history_days = 0;
    assert_eq!(f.service(cfg).run_cleanup().await, (0, 0));
    assert!(path.exists());
}
#[tokio::test]
async fn history_l140_cleans_output_and_keeps_today() {
    let f = Fixture::new();
    let old = f.write(&format!("logs/output/events-{}.jsonl", date(10)), b"");
    let today = f.write(&format!("logs/output/events-{}.jsonl", date(0)), b"");
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert!(today.exists());
}
#[tokio::test]
async fn history_l155_applies_early_large_file_retention() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let old = f.sized(
        &format!("logs/output/cursor-{}.jsonl", date(3)),
        OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES + 1,
    );
    let small = f.sized(&format!("logs/output/qoder-{}.jsonl", date(3)), 1024);
    let recent = f.sized(
        &format!("logs/output/codex-{}.jsonl", date(1)),
        OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES + 1,
    );
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert!(small.exists());
    assert!(recent.exists());
}
#[tokio::test]
async fn history_l176_deletes_oldest_output_under_hard_limit_pressure() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let size = OUTPUT_RETENTION_MAX_TOTAL_BYTES / 5;
    let mut paths = Vec::new();
    for (agent, days) in [
        ("cursor", 6),
        ("qoder", 5),
        ("codex", 4),
        ("claude-code", 1),
        ("opencode", 0),
        ("wukong", 3),
    ] {
        paths.push(f.sized(&format!("logs/output/{agent}-{}.jsonl", date(days)), size));
    }
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!paths[0].exists());
    assert!(paths[1..].iter().all(|p| p.exists()));
}
#[tokio::test]
async fn history_l204_cleans_expired_sls_failed_logs() {
    let f = Fixture::new();
    let old = f.write(
        &format!("logs/sls-failed-logs/failed-{}.jsonl", date(40)),
        b"",
    );
    let recent = f.write(
        &format!("logs/sls-failed-logs/failed-{}.jsonl", date(2)),
        b"",
    );
    let mut cfg = config();
    cfg.sls_failed_days = 30;
    assert_eq!(f.service(cfg).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert!(recent.exists());
}
#[tokio::test]
async fn history_l217_preserves_active_sls_segment_under_total_pressure() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let size = SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES / 3;
    let old = f.sized(
        &format!(
            "logs/sls-failed-logs/activity-deadbeef00-0000-{}.jsonl",
            date(0)
        ),
        size,
    );
    let middle = f.sized(
        &format!(
            "logs/sls-failed-logs/activity-deadbeef00-0001-{}.jsonl",
            date(0)
        ),
        size,
    );
    let active = f.sized(
        &format!(
            "logs/sls-failed-logs/activity-deadbeef00-0002-{}.jsonl",
            date(0)
        ),
        size + 3,
    );
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert!(middle.exists());
    assert!(active.exists());
}
#[tokio::test]
async fn history_l237_keeps_recent_and_legacy_otlp_files() {
    let f = Fixture::new();
    let old = f.write(
        &format!("logs/otlp-failed/service-primary-{}.jsonl", date(10)),
        b"old\n",
    );
    let recent = f.write(
        &format!("logs/otlp-failed/service-primary-{}.jsonl", date(0)),
        b"recent\n",
    );
    let legacy = f.write("logs/otlp-failed/service.jsonl", b"legacy\n");
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert_eq!(std::fs::read(recent).unwrap(), b"recent\n");
    assert_eq!(std::fs::read(legacy).unwrap(), b"legacy\n");
}
#[tokio::test]
async fn history_l256_removes_only_managed_metric_daily_and_legacy_files() {
    let f = Fixture::new();
    let old = f.write(
        &format!("logs/metric_alarm/pilot-metrics-{}.jsonl", date(10)),
        b"old\n",
    );
    let legacy = f.write("logs/metric_alarm/pilot-input-metrics.jsonl", b"legacy\n");
    let state = f.write(
        "logs/metric_alarm/token-usage-state.json",
        b"{\"state\":true}",
    );
    let unknown = f.write("logs/metric_alarm/user-data.jsonl", b"unknown\n");
    let dated = f.write(
        &format!("logs/metric_alarm/user-data-{}.jsonl", date(10)),
        b"unknown dated\n",
    );
    for path in [&legacy, &state, &unknown] {
        old_mtime(path, 10);
    }
    assert_eq!(f.service(config()).run_cleanup().await, (2, 0));
    assert!(!old.exists());
    assert!(!legacy.exists());
    assert_eq!(std::fs::read(state).unwrap(), b"{\"state\":true}");
    assert_eq!(std::fs::read(unknown).unwrap(), b"unknown\n");
    assert_eq!(std::fs::read(dated).unwrap(), b"unknown dated\n");
}
#[tokio::test]
async fn history_l286_metric_pressure_preserves_today_and_yesterday() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let size = METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES / 3 + 1;
    let old = f.sized(
        &format!("logs/metric_alarm/pilot-metrics-{}.jsonl", date(2)),
        size,
    );
    let yesterday = f.sized(
        &format!("logs/metric_alarm/pilot-metrics-{}.jsonl", date(1)),
        size,
    );
    let today = f.sized(
        &format!("logs/metric_alarm/pilot-metrics-{}.jsonl", date(0)),
        size,
    );
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert!(yesterday.exists());
    assert!(today.exists());
}
#[tokio::test]
async fn history_l306_otlp_protected_days_can_exceed_soft_limit() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let size = OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES / 2 + 1;
    let yesterday = f.sized(&format!("logs/otlp-failed/service-{}.jsonl", date(1)), size);
    let today = f.sized(&format!("logs/otlp-failed/service-{}.jsonl", date(0)), size);
    assert_eq!(f.service(config()).run_cleanup().await, (0, 0));
    assert!(yesterday.exists());
    assert!(today.exists());
}
#[tokio::test]
async fn history_l323_protected_days_survive_zero_metric_retention() {
    let f = Fixture::new();
    let old = f.write(
        &format!("logs/metric_alarm/pilot-alarms-{}.jsonl", date(2)),
        b"old\n",
    );
    let yesterday = f.write(
        &format!("logs/metric_alarm/pilot-alarms-{}.jsonl", date(1)),
        b"yesterday\n",
    );
    let today = f.write(
        &format!("logs/metric_alarm/pilot-alarms-{}.jsonl", date(0)),
        b"today\n",
    );
    let mut cfg = config();
    cfg.metric_alarm_days = 0;
    assert_eq!(f.service(cfg).run_cleanup().await, (1, 0));
    assert!(!old.exists());
    assert!(yesterday.exists());
    assert!(today.exists());
}
#[tokio::test]
async fn history_l342_skips_state_unknown_hidden_symlink_and_directory() {
    let f = Fixture::new();
    let state = f.write("logs/metric_alarm/token-usage-state.json", b"{}");
    let unknown = f.write(
        &format!("logs/metric_alarm/user-data-{}.jsonl", date(10)),
        b"unknown\n",
    );
    let hidden = f.write(
        &format!("logs/metric_alarm/.pilot-metrics-{}.jsonl", date(10)),
        b"hidden\n",
    );
    let external = f.write("external.jsonl", b"external\n");
    let link = f.path(&format!(
        "logs/metric_alarm/pilot-metrics-{}.jsonl",
        date(10)
    ));
    symlink_file(&external, &link);
    let directory = f.path(&format!(
        "logs/metric_alarm/pilot-alarms-{}.jsonl",
        date(10)
    ));
    std::fs::create_dir(&directory).unwrap();
    assert_eq!(f.service(config()).run_cleanup().await, (0, 0));
    assert!(state.exists() && unknown.exists() && hidden.exists());
    assert!(std::fs::symlink_metadata(link).unwrap().is_symlink());
    assert!(directory.is_dir());
    assert_eq!(std::fs::read(external).unwrap(), b"external\n");
}
#[tokio::test]
async fn history_l371_skips_unknown_subdirectories() {
    let f = Fixture::new();
    let path = f.write(&format!("logs/unknown-stuff/data-{}.jsonl", date(100)), b"");
    assert_eq!(f.service(config()).run_cleanup().await, (0, 0));
    assert!(path.exists());
}
#[tokio::test]
async fn history_l385_ignores_undated_state_and_readme_files() {
    let f = Fixture::new();
    let paths = ["input-state.json", ".line_records.test.json", "README.md"]
        .map(|name| f.write(&format!("logs/test/history/{name}"), b"{}"));
    let mut cfg = config();
    cfg.hook_history_days = 1;
    assert_eq!(f.service(cfg).run_cleanup().await, (0, 0));
    assert!(paths.iter().all(|p| p.exists()));
}
#[cfg(unix)]
#[tokio::test]
async fn readonly_cleanup_child() {
    let Ok(root) = std::env::var("PILOT_RETENTION_READONLY_CHILD") else {
        return;
    };
    assert_eq!(
        LogRetentionService::new(root, config()).run_cleanup().await,
        (0, 2)
    );
}
#[tokio::test]
async fn history_l401_continues_after_two_real_unlink_errors() {
    let f = Fixture::new();
    let paths = ["a", "b"].map(|name| {
        f.write(
            &format!("logs/agent/history/{name}-{}.jsonl", date(10)),
            b"",
        )
    });
    #[cfg(unix)]
    {
        use std::os::unix::{fs::PermissionsExt, process::CommandExt};
        for path in [
            f.0.path().to_path_buf(),
            f.path("logs"),
            f.path("logs/agent"),
            f.path("logs/agent/history"),
        ] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o555)).unwrap();
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "core::log_retention_service::history_tests::readonly_cleanup_child",
                "--nocapture",
            ])
            .env("PILOT_RETENTION_READONLY_CHILD", f.0.path());
        // Root otherwise bypasses readonly directory permissions and would hide
        // the source's errors==2 assertion. Only this isolated child drops UID.
        if unsafe { libc::geteuid() } == 0 {
            child.uid(65534).gid(65534);
        }
        let output = child.output().unwrap();
        for path in [
            f.0.path().to_path_buf(),
            f.path("logs"),
            f.path("logs/agent"),
            f.path("logs/agent/history"),
        ] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        // Readonly attributes do not reliably prevent std::fs::remove_file.
        // These live handles allow metadata IO but deliberately deny delete
        // sharing, making both real unlink attempts fail with a sharing violation.
        let held = paths
            .iter()
            .map(|path| {
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .open(path)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let outcome = f.service(config()).run_cleanup().await;
        assert_eq!(outcome, (0, 2));
        assert!(paths.iter().all(|path| path.exists()));
        drop(held);
    }
    assert!(paths.iter().all(|p| p.exists()));
}
#[tokio::test]
async fn history_l423_missing_logs_is_a_noop() {
    let f = Fixture::new();
    assert_eq!(
        LogRetentionService::new(f.path("nonexistent"), config())
            .run_cleanup()
            .await,
        (0, 0)
    );
}
#[tokio::test]
async fn history_l435_stop_cancels_all_started_tasks() {
    let f = Fixture::new();
    let service = Arc::new(f.service(config()));
    service.start();
    service.stop();
    assert!(service.startup.lock().unwrap().is_none());
    assert!(service.interval.lock().unwrap().is_none());
    assert!(service.pressure.lock().unwrap().is_none());
}
#[tokio::test]
async fn history_l442_disabled_never_schedules_tasks() {
    let f = Fixture::new();
    let mut cfg = config();
    cfg.enabled = false;
    let service = Arc::new(f.service(cfg));
    service.start();
    service.stop();
    assert!(service.startup.lock().unwrap().is_none());
    assert!(service.interval.lock().unwrap().is_none());
    assert!(service.pressure.lock().unwrap().is_none());
}
#[test]
fn history_l451_extracts_standard_jsonl_and_log_dates() {
    for (name, expected) in [
        ("cursor-2026-05-01.jsonl", "2026-05-01"),
        ("qoder-cli-2025-12-31.jsonl", "2025-12-31"),
        ("agent-debug-2026-01-15.log", "2026-01-15"),
    ] {
        assert_eq!(extract_date(name).as_deref(), Some(expected));
    }
}
#[test]
fn history_l457_undated_names_have_no_date() {
    for name in [
        "input-state.json",
        ".line_records.test.json",
        "README.md",
        "data.jsonl",
    ] {
        assert_eq!(extract_date(name), None);
    }
}
#[test]
fn history_l464_rejects_malformed_and_out_of_range_dates() {
    for name in [
        "file-2026-13-01.jsonl",
        "file-2026-00-01.jsonl",
        "file-2026-01-32.jsonl",
        "file-1999-01-01.jsonl",
    ] {
        assert_eq!(extract_date(name), None);
    }
}
#[test]
fn history_l471_preserves_edge_dates() {
    assert_eq!(
        extract_date("file-2020-01-01.jsonl").as_deref(),
        Some("2020-01-01")
    );
    assert_eq!(
        extract_date("file-2099-12-31.log").as_deref(),
        Some("2099-12-31")
    );
}

// f84-only declarations below: separate main provenance, not baseline additions.
#[tokio::test]
async fn main_l74_reclaims_six_giant_mirrors_but_keeps_the_source_checkpoint() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let mut paths = Vec::new();
    for category in ["output", "otlp-debug", "otlp-failed"] {
        for name in [
            format!("copilot-{}.jsonl", date(0)),
            format!(
                "copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-{}.jsonl",
                date(0)
            ),
        ] {
            paths.push(f.sized(
                &format!("logs/{category}/{name}"),
                LOCAL_LOG_EMERGENCY_FILE_BYTES + 1,
            ));
        }
    }
    let checkpoint = f.write("state/copilot/source-index.sqlite", b"checkpoint");
    assert_eq!(f.service(config()).run_pressure_cleanup().await, (6, 0));
    assert!(paths.iter().all(|p| !p.exists()));
    assert_eq!(std::fs::read(checkpoint).unwrap(), b"checkpoint");
}
#[tokio::test]
async fn main_l90_reclaims_today_closed_failed_segment_but_keeps_active() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let closed = f.sized(
        &format!(
            "logs/otlp-failed/copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-{}.jsonl",
            date(0)
        ),
        OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES + 1,
    );
    let active = f.write(
        &format!("logs/otlp-failed/copilot-{}.jsonl", date(0)),
        b"{\"failed\":\"current\"}\n",
    );
    assert_eq!(f.service(config()).run_pressure_cleanup().await, (1, 0));
    assert!(!closed.exists());
    assert_eq!(
        std::fs::read(active).unwrap(),
        b"{\"failed\":\"current\"}\n"
    );
}
#[tokio::test]
async fn main_l101_debug_pressure_does_not_rescan_hook_history() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let closed = f.sized(
        &format!(
            "logs/otlp-debug/copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-{}.jsonl",
            date(0)
        ),
        OUTPUT_RETENTION_MAX_TOTAL_BYTES + 1,
    );
    let active = f.write(
        &format!("logs/otlp-debug/copilot-{}.jsonl", date(0)),
        b"{\"trace\":\"current\"}\n",
    );
    let history = f.write(
        &format!("logs/copilot/history/copilot-{}.jsonl", date(100)),
        b"{}\n",
    );
    let service = f.service(config());
    assert_eq!(service.run_pressure_cleanup().await, (1, 0));
    assert!(!closed.exists());
    assert_eq!(std::fs::read(active).unwrap(), b"{\"trace\":\"current\"}\n");
    assert_eq!(std::fs::read(&history).unwrap(), b"{}\n");
    assert_eq!(service.run_cleanup().await, (1, 0));
    assert!(!history.exists());
}
#[tokio::test]
async fn main_l116_never_traverses_a_managed_directory_symlink() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let external = f.sized(
        &format!("external/copilot-{}.jsonl", date(0)),
        LOCAL_LOG_EMERGENCY_FILE_BYTES + 1,
    );
    std::fs::create_dir(f.path("logs")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.path("external"), f.path("logs/otlp-debug")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(f.path("external"), f.path("logs/otlp-debug")).unwrap();
    assert_eq!(f.service(config()).run_cleanup().await, (0, 0));
    assert_eq!(
        std::fs::metadata(external).unwrap().len(),
        LOCAL_LOG_EMERGENCY_FILE_BYTES + 1
    );
}
#[tokio::test]
async fn main_l125_rechecks_a_real_scanned_oversized_path_under_the_append_lock() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let active = f.sized(
        &format!("logs/output/copilot-{}.jsonl", date(0)),
        LOCAL_LOG_EMERGENCY_FILE_BYTES + 1,
    );
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let writing_path = active.clone();
    let writing = tokio::spawn(async move {
        with_jsonl_file_lock(&writing_path, || async {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            std::fs::write(&writing_path, b"{\"new\":\"data\"}\n").unwrap();
        })
        .await;
    });
    entered_rx.await.unwrap();
    let files = collect_output_dated(&f.path("logs/output"), &read_dir(&f.path("logs/output")));
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].size, LOCAL_LOG_EMERGENCY_FILE_BYTES + 1);
    let (cleaning_tx, cleaning_rx) = tokio::sync::oneshot::channel();
    let cleaning = tokio::spawn(async move {
        cleaning_tx.send(()).unwrap();
        reclaim_oversized_files(&files, false).await
    });
    cleaning_rx.await.unwrap();
    tokio::task::yield_now().await;
    assert!(
        !cleaning.is_finished(),
        "cleanup must wait for the real append lock"
    );
    release_tx.send(()).unwrap();
    writing.await.unwrap();
    assert_eq!(cleaning.await.unwrap(), (0, 0));
    assert_eq!(std::fs::read(active).unwrap(), b"{\"new\":\"data\"}\n");
}
#[tokio::test]
async fn main_l297_output_pressure_preserves_all_today_active_files() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let active = f.sized(
        &format!("logs/output/copilot-{}.jsonl", date(0)),
        OUTPUT_RETENTION_MAX_TOTAL_BYTES / 2,
    );
    let closed = f.sized(
        &format!(
            "logs/output/copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-{}.jsonl",
            date(0)
        ),
        OUTPUT_RETENTION_MAX_TOTAL_BYTES / 2,
    );
    let other = f.sized(&format!("logs/output/cursor-{}.jsonl", date(0)), 1024);
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!closed.exists());
    assert!(active.exists());
    assert!(other.exists());
    assert_eq!(std::fs::read_dir(f.path("logs/output")).unwrap().count(), 2);
}
#[tokio::test]
async fn main_l310_capacity_includes_undated_closed_segments_without_following_symlinks() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let closed = f.sized(
        "logs/output/copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-all.jsonl",
        OUTPUT_RETENTION_MAX_TOTAL_BYTES,
    );
    let active = f.sized(&format!("logs/output/cursor-{}.jsonl", date(0)), 1024);
    let external = f.sized("external.jsonl", OUTPUT_RETENTION_MAX_TOTAL_BYTES);
    let link = f.path(&format!(
        "logs/output/copilot.part-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-{}.jsonl",
        date(0)
    ));
    symlink_file(&external, &link);
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!closed.exists());
    assert!(active.exists());
    assert!(external.exists());
    assert!(std::fs::symlink_metadata(link).unwrap().is_symlink());
}
#[tokio::test]
async fn main_l393_hook_latency_mirror_follows_metric_retention() {
    let f = Fixture::new();
    let expired = f.write(
        &format!("logs/metric_alarm/pilot-hook-metrics-{}.jsonl", date(10)),
        b"old\n",
    );
    let recent = f.write(
        &format!("logs/metric_alarm/pilot-hook-metrics-{}.jsonl", date(1)),
        b"recent\n",
    );
    assert_eq!(f.service(config()).run_cleanup().await, (1, 0));
    assert!(!expired.exists());
    assert_eq!(std::fs::read(recent).unwrap(), b"recent\n");
}
async fn eventually(mut ready: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(
            std::time::Instant::now() < deadline,
            "real filesystem operation did not finish"
        );
        tokio::task::yield_now().await;
    }
}
#[tokio::test(start_paused = true)]
async fn main_l558_pressure_ticks_each_minute_and_stop_cancels_both_schedules() {
    let _gate = large_files().await;
    let f = Fixture::new();
    let mut cfg = config();
    cfg.interval_ms = 6 * 60 * 60 * 1000;
    // Prevent paused-clock auto-advance while real filesystem IO is in flight.
    // Like the source vi fake clock, only advance() changes scheduler time.
    let keep_clock_fixed = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    let history = f.write(
        &format!("logs/copilot/history/copilot-{}.jsonl", date(100)),
        b"first",
    );
    let service = Arc::new(f.service(cfg));
    service.start();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(29)).await;
    assert!(history.exists());
    tokio::time::advance(Duration::from_secs(1)).await;
    eventually(|| !history.exists() && service.interval.lock().unwrap().is_some()).await;

    let next_history = f.write(
        &format!("logs/copilot/history/copilot-{}.jsonl", date(100)),
        b"second",
    );
    let closed = f.sized(
        &format!(
            "logs/otlp-debug/copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-{}.jsonl",
            date(0)
        ),
        OUTPUT_RETENTION_MAX_TOTAL_BYTES + 1,
    );
    let active = f.write(
        &format!("logs/otlp-debug/copilot-{}.jsonl", date(0)),
        b"active",
    );
    tokio::time::advance(Duration::from_secs(60)).await;
    eventually(|| !closed.exists()).await;
    assert!(next_history.exists());
    assert_eq!(std::fs::read(&active).unwrap(), b"active");
    service.stop();
    let after_stop = f.sized(
        &format!(
            "logs/otlp-debug/copilot.part-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-{}.jsonl",
            date(0)
        ),
        OUTPUT_RETENTION_MAX_TOTAL_BYTES + 1,
    );
    tokio::time::advance(Duration::from_secs(6 * 60 * 60)).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert!(next_history.exists() && after_stop.exists());
    assert!(service.startup.lock().unwrap().is_none());
    assert!(service.interval.lock().unwrap().is_none());
    assert!(service.pressure.lock().unwrap().is_none());
    keep_clock_fixed.abort();
}

#[test]
fn calendar_retention_preserves_distinct_days_across_dst_boundaries() {
    use chrono::NaiveDate;
    for (today, yesterday, two_days_ago) in [
        ("2026-11-01", "2026-10-31", "2026-10-30"),
        ("2026-11-02", "2026-11-01", "2026-10-31"),
        ("2026-03-08", "2026-03-07", "2026-03-06"),
        ("2024-03-01", "2024-02-29", "2024-02-28"),
    ] {
        let date = NaiveDate::parse_from_str(today, "%Y-%m-%d").unwrap();
        assert_eq!(calendar_date_cutoff(date, 0), today);
        assert_eq!(calendar_date_cutoff(date, 1), yesterday);
        assert_eq!(calendar_date_cutoff(date, 2), two_days_ago);
    }
}
