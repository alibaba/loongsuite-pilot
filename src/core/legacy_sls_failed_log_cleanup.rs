//! One-shot removal of the pre-migration `sls-failed-logs` directory.
//! Port of `legacy-sls-failed-log-cleanup-service.ts`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::task::JoinHandle;

use super::{fields, logger};

pub const LEGACY_SLS_CLEANUP_STARTUP_DELAY_MS: u64 = 30_000;
pub const LEGACY_SLS_CLEANUP_FILE_DELAY_MS: u64 = 100;
pub const LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS: [u64; 3] = [250, 1_000, 4_000];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacySlsFailedLogCleanupResult {
    pub renamed: bool,
    pub deleted: u64,
    pub skipped: u64,
    pub errors: u64,
    pub logical_bytes: u64,
}

pub struct LegacySlsFailedLogCleanupService {
    legacy_dir: PathBuf,
    pending_dir: PathBuf,
    startup_delay_ms: u64,
    file_delay_ms: u64,
    retry_delays_ms: Vec<u64>,
    startup: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl LegacySlsFailedLogCleanupService {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self::with_delays(
            data_dir,
            LEGACY_SLS_CLEANUP_STARTUP_DELAY_MS,
            LEGACY_SLS_CLEANUP_FILE_DELAY_MS,
            LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS.to_vec(),
        )
    }

    pub fn with_delays(
        data_dir: impl AsRef<Path>,
        startup_delay_ms: u64,
        file_delay_ms: u64,
        retry_delays_ms: Vec<u64>,
    ) -> Self {
        let data_dir = data_dir.as_ref();
        Self {
            legacy_dir: data_dir.join("sls-failed-logs"),
            pending_dir: data_dir.join("sls-failed-logs.delete-pending"),
            startup_delay_ms,
            file_delay_ms,
            retry_delays_ms,
            startup: std::sync::Mutex::new(None),
        }
    }

    pub fn start(self: &std::sync::Arc<Self>) {
        if self.startup.lock().expect("startup").is_some() {
            return;
        }
        let this = std::sync::Arc::clone(self);
        *self.startup.lock().expect("startup") = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(this.startup_delay_ms)).await;
            *this.startup.lock().expect("startup") = None;
            let _ = this.run_cleanup().await;
        }));
    }

    pub fn stop(&self) {
        if let Some(task) = self.startup.lock().expect("startup").take() {
            task.abort();
        }
    }

    pub async fn run_cleanup(&self) -> LegacySlsFailedLogCleanupResult {
        match self.run_once().await {
            Ok(result) => result,
            Err(err) => {
                logger("LegacySlsFailureCleanup").warn(
                    "legacy SLS failure cleanup failed",
                    Some(&fields(serde_json::json!({ "error": err }))),
                );
                LegacySlsFailedLogCleanupResult {
                    errors: 1,
                    ..Default::default()
                }
            }
        }
    }

    async fn run_once(&self) -> Result<LegacySlsFailedLogCleanupResult, String> {
        let mut result = LegacySlsFailedLogCleanupResult::default();
        if self.pending_dir.exists() {
            if !self.pending_dir.is_dir()
                || self
                    .pending_dir
                    .symlink_metadata()
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false)
            {
                logger("LegacySlsFailureCleanup").warn(
                    "legacy pending path is not a regular directory; skipping",
                    Some(&fields(
                        serde_json::json!({ "path": "sls-failed-logs.delete-pending" }),
                    )),
                );
                result.skipped += 1;
                return Ok(result);
            }
            self.clean_pending(&mut result).await;
            self.log_result(&result);
            return Ok(result);
        }
        if !self.legacy_dir.exists() {
            return Ok(result);
        }
        if !self.legacy_dir.is_dir()
            || crate::utils::runtime_paths::runtime_metadata(&self.legacy_dir).is_err()
        {
            logger("LegacySlsFailureCleanup").warn(
                "legacy SLS failure path is not a regular directory; skipping",
                Some(&fields(serde_json::json!({ "path": "sls-failed-logs" }))),
            );
            result.skipped += 1;
            return Ok(result);
        }
        if !self.retry_rename().await {
            result.errors += 1;
            return Ok(result);
        }
        result.renamed = true;
        self.clean_pending(&mut result).await;
        self.log_result(&result);
        Ok(result)
    }

    async fn clean_pending(&self, result: &mut LegacySlsFailedLogCleanupResult) {
        if !crate::utils::runtime_paths::runtime_metadata(&self.pending_dir)
            .is_ok_and(|metadata| metadata.is_dir())
        {
            result.skipped += 1;
            return;
        }
        let entries = match std::fs::read_dir(&self.pending_dir) {
            Ok(entries) => entries.filter_map(|entry| entry.ok()).collect::<Vec<_>>(),
            Err(err) => {
                result.errors += 1;
                logger("LegacySlsFailureCleanup").warn(
                    "failed to enumerate legacy SLS failure directory",
                    Some(&fields(serde_json::json!({ "error": err.to_string() }))),
                );
                return;
            }
        };
        let mut candidates = Vec::new();
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_legacy_jsonl_name(&name) {
                candidates.push(name);
            } else {
                result.skipped += 1;
                logger("LegacySlsFailureCleanup").warn(
                    "skipping unknown legacy SLS failure entry",
                    Some(&fields(serde_json::json!({ "file": name }))),
                );
            }
        }
        // A failed earlier file must not depend on read_dir's platform-specific order.
        candidates.sort();
        for (index, name) in candidates.iter().enumerate() {
            let path = self.pending_dir.join(name);
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(err) => {
                    result.errors += 1;
                    logger("LegacySlsFailureCleanup").warn(
                        "failed to inspect legacy SLS failure file",
                        Some(&fields(
                            serde_json::json!({ "file": name, "error": err.to_string() }),
                        )),
                    );
                    continue;
                }
            };
            if meta.file_type().is_symlink() || !meta.is_file() {
                result.skipped += 1;
                continue;
            }
            if self.retry_unlink(&path).await {
                result.deleted += 1;
                result.logical_bytes += meta.len();
            } else {
                result.errors += 1;
            }
            if index + 1 < candidates.len() && self.file_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.file_delay_ms)).await;
            }
        }
        if let Ok(remaining) = std::fs::read_dir(&self.pending_dir) {
            if remaining.count() == 0 {
                let _ = std::fs::remove_dir(&self.pending_dir);
            }
        }
    }

    async fn retry_rename(&self) -> bool {
        self.retry(
            || std::fs::rename(&self.legacy_dir, &self.pending_dir),
            "rename",
        )
        .await
    }

    async fn retry_unlink(&self, path: &Path) -> bool {
        let path = path.to_path_buf();
        self.retry(move || std::fs::remove_file(&path), "unlink")
            .await
    }

    async fn retry<F>(&self, mut operation: F, name: &str) -> bool
    where
        F: FnMut() -> std::io::Result<()>,
    {
        let mut attempt = 0;
        loop {
            match operation() {
                Ok(()) => return true,
                Err(err) => {
                    let code = io_code(&err);
                    if let Some(delay) = self
                        .retry_delays_ms
                        .get(attempt)
                        .copied()
                        .filter(|_| is_transient(&code))
                    {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }
                    logger("LegacySlsFailureCleanup").warn(
                        "legacy SLS failure cleanup operation failed",
                        Some(&fields(serde_json::json!({ "operation": name, "error": code, "attempts": attempt + 1 }))),
                    );
                    return false;
                }
            }
        }
    }

    fn log_result(&self, result: &LegacySlsFailedLogCleanupResult) {
        if !result.renamed && result.deleted == 0 && result.skipped == 0 && result.errors == 0 {
            return;
        }
        logger("LegacySlsFailureCleanup").info(
            "legacy SLS failure cleanup complete",
            Some(&fields(serde_json::json!({
                "renamed": result.renamed,
                "deleted": result.deleted,
                "skipped": result.skipped,
                "errors": result.errors,
                "logicalBytes": result.logical_bytes,
            }))),
        );
    }
}

pub fn is_legacy_jsonl_name(name: &str) -> bool {
    !name.starts_with('.') && name.len() > ".jsonl".len() && name.ends_with(".jsonl")
}

fn is_transient(code: &str) -> bool {
    matches!(code, "EPERM" | "EBUSY" | "EACCES")
}

fn io_code(err: &std::io::Error) -> String {
    #[cfg(windows)]
    match err.raw_os_error() {
        Some(5) => return "EACCES".into(),
        Some(32 | 33) => return "EBUSY".into(),
        _ => {}
    }
    match err.raw_os_error() {
        Some(1) => "EPERM".into(),
        Some(2) => "ENOENT".into(),
        Some(13) => "EACCES".into(),
        Some(16) => "EBUSY".into(),
        _ => match err.kind() {
            std::io::ErrorKind::NotFound => "ENOENT".into(),
            std::io::ErrorKind::PermissionDenied => "EACCES".into(),
            _ => err.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonl_names_exclude_hidden_and_short_files() {
        assert!(is_legacy_jsonl_name("failed.jsonl"));
        assert!(is_legacy_jsonl_name("internal-sls.jsonl"));
        assert!(is_legacy_jsonl_name("a.jsonl"));
        assert!(!is_legacy_jsonl_name(".hidden.jsonl"));
        assert!(!is_legacy_jsonl_name(".jsonl"));
        assert!(!is_legacy_jsonl_name("notes.txt"));
    }

    #[tokio::test]
    async fn renames_the_legacy_directory_and_deletes_jsonl_files() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("sls-failed-logs");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("one.jsonl"), b"abcdef").unwrap();
        std::fs::write(legacy.join("notes.txt"), b"skip").unwrap();
        let service = LegacySlsFailedLogCleanupService::with_delays(dir.path(), 0, 0, vec![]);
        let result = service.run_cleanup().await;
        assert!(result.renamed);
        assert_eq!(result.deleted, 1);
        assert_eq!(result.logical_bytes, 6);
        assert_eq!(result.skipped, 1);
        let pending = dir.path().join("sls-failed-logs.delete-pending");
        assert!(pending.join("notes.txt").exists());
        assert!(!pending.join("one.jsonl").exists());
    }
    #[tokio::test(start_paused = true)]
    async fn scheduled_cleanup_waits_for_its_deadline_and_stop_cancels_real_work() {
        for cancel in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let legacy = root.path().join("sls-failed-logs");
            std::fs::create_dir(&legacy).unwrap();
            std::fs::write(legacy.join("old.jsonl"), "not parsed").unwrap();
            let service = std::sync::Arc::new(LegacySlsFailedLogCleanupService::with_delays(
                root.path(),
                30_000,
                0,
                Vec::new(),
            ));
            service.start();
            tokio::task::yield_now().await;
            assert!(service
                .startup
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|task| !task.is_finished()));
            tokio::time::advance(Duration::from_millis(29_999)).await;
            tokio::task::yield_now().await;
            assert!(legacy.join("old.jsonl").is_file());
            assert!(!root.path().join("sls-failed-logs.delete-pending").exists());
            if cancel {
                service.stop();
                assert!(service.startup.lock().unwrap().is_none());
                tokio::time::advance(Duration::from_secs(60)).await;
                tokio::task::yield_now().await;
                assert!(legacy.join("old.jsonl").is_file());
                // The file is eligible; only cancellation kept it intact.
                assert_eq!(service.run_cleanup().await.deleted, 1);
            } else {
                tokio::time::advance(Duration::from_millis(1)).await;
                tokio::task::yield_now().await;
                assert!(!legacy.exists());
                assert!(!root.path().join("sls-failed-logs.delete-pending").exists());
                assert!(service.startup.lock().unwrap().is_none());
            }
        }
    }

    #[tokio::test]
    async fn startup_task_does_not_keep_the_native_runtime_alive() {
        const CHILD: &str = "PILOT_LEGACY_CLEANUP_RUNTIME_EXIT_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            let service = std::sync::Arc::new(LegacySlsFailedLogCleanupService::with_delays(
                std::path::PathBuf::from(root),
                60_000,
                0,
                Vec::new(),
            ));
            service.start();
            tokio::task::yield_now().await;
            assert!(service.startup.lock().unwrap().is_some());
            // Returning drops the owning Tokio runtime without waiting for the task's timer.
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "core::legacy_sls_failed_log_cleanup::tests::startup_task_does_not_keep_the_native_runtime_alive", "--nocapture"])
            .env_clear().env(CHILD,root.path()).env("HOME",root.path()).env("USERPROFILE",root.path())
            .env("PATH",root.path()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
            .spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!("startup timer kept the runtime alive: {output:?}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(!root.path().join("sls-failed-logs.delete-pending").exists());
    }

    #[tokio::test(start_paused = true)]
    async fn sparse_ten_gib_cleanup_keeps_unknown_entries_and_delays_only_between_files() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("sls-failed-logs");
        let pending = root.path().join("sls-failed-logs.delete-pending");
        std::fs::create_dir_all(legacy.join("unknown-dir")).unwrap();
        let large = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(legacy.join("internal-sls.jsonl"))
            .unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // FSCTL_SET_SPARSE avoids allocating ten GiB of physical NTFS blocks.
            use windows_sys::Win32::System::IO::DeviceIoControl;
            let mut returned = 0;
            let marked = unsafe {
                DeviceIoControl(
                    large.as_raw_handle(),
                    0x0009_00c4,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            assert_ne!(
                marked,
                0,
                "cannot safely create sparse fixture: {}",
                std::io::Error::last_os_error()
            );
        }
        use std::io::Write;
        (&large).write_all(b"{invalid json").unwrap();
        large.set_len(10 * 1024 * 1024 * 1024).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert!(large.metadata().unwrap().blocks() * 512 < 1024 * 1024);
        }
        drop(large);
        std::fs::write(legacy.join("user-sls.jsonl"), "also invalid").unwrap();
        std::fs::write(legacy.join("README.md"), "keep").unwrap();
        let service =
            LegacySlsFailedLogCleanupService::with_delays(root.path(), 0, 100, Vec::new());
        let started = tokio::time::Instant::now();
        let result = service.run_cleanup().await;
        assert!(result.renamed);
        assert_eq!(result.deleted, 2);
        assert!(result.logical_bytes >= 10 * 1024 * 1024 * 1024);
        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_millis(100)
        );
        assert!(!legacy.exists());
        assert!(!pending.join("internal-sls.jsonl").exists());
        assert!(!pending.join("user-sls.jsonl").exists());
        assert!(pending.join("README.md").is_file());
        assert!(pending.join("unknown-dir").is_dir());
    }

    #[tokio::test]
    async fn existing_pending_directory_resumes_and_is_removed_after_its_last_file() {
        let root = tempfile::tempdir().unwrap();
        let pending = root.path().join("sls-failed-logs.delete-pending");
        std::fs::create_dir(&pending).unwrap();
        std::fs::write(pending.join("remaining.jsonl"), "not parsed").unwrap();
        let service = LegacySlsFailedLogCleanupService::with_delays(root.path(), 0, 0, Vec::new());
        let result = service.run_cleanup().await;
        assert!(!result.renamed);
        assert_eq!(result.deleted, 1);
        assert!(!pending.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn transient_rename_retry_uses_exact_250_and_1000_millisecond_backoff() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("sls-failed-logs");
        let pending = root.path().join("sls-failed-logs.delete-pending");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("failed.jsonl"), "x").unwrap();
        let service = Arc::new(LegacySlsFailedLogCleanupService::with_delays(
            root.path(),
            0,
            0,
            LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS.to_vec(),
        ));
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        let worker = service.clone();
        let renaming = tokio::spawn(async move {
            worker
                .retry(
                    || {
                        if count.fetch_add(1, Ordering::SeqCst) < 2 {
                            Err(std::io::Error::new(
                                std::io::ErrorKind::PermissionDenied,
                                "temporarily busy",
                            ))
                        } else {
                            std::fs::rename(&legacy, &pending)
                        }
                    },
                    "rename",
                )
                .await
        });
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_millis(249)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_millis(999)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(renaming.await.unwrap());
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(service.run_cleanup().await.deleted, 1);
    }

    #[tokio::test]
    async fn symlink_legacy_or_pending_root_never_deletes_external_jsonl_files() {
        for link_pending in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let outside = root.path().join("outside");
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("keep.jsonl"), "keep").unwrap();
            let link = root.path().join(if link_pending {
                "sls-failed-logs.delete-pending"
            } else {
                "sls-failed-logs"
            });
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(&outside, &link).unwrap();
            let result =
                LegacySlsFailedLogCleanupService::with_delays(root.path(), 0, 0, Vec::new())
                    .run_cleanup()
                    .await;
            assert_eq!(result.skipped, 1);
            assert_eq!(result.deleted, 0);
            assert_eq!(result.logical_bytes, 0);
            assert_eq!(
                std::fs::read_to_string(outside.join("keep.jsonl")).unwrap(),
                "keep"
            );
            assert!(std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }
    #[tokio::test(start_paused = true)]
    async fn unlink_retry_has_four_attempts_and_leaves_failed_file_intact() {
        let root = tempfile::tempdir().unwrap();
        let busy = root.path().join("busy.jsonl");
        std::fs::write(&busy, "retain original bytes").unwrap();
        let service = LegacySlsFailedLogCleanupService::new(root.path());
        let mut attempts = 0;
        let started = tokio::time::Instant::now();
        let removed = service
            .retry(
                || {
                    attempts += 1;
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "occupied",
                    ))
                },
                "unlink",
            )
            .await;
        assert!(!removed);
        assert_eq!(attempts, 4);
        assert!(is_transient("EPERM"));
        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_millis(250 + 1000 + 4000)
        );
        assert_eq!(
            std::fs::read_to_string(&busy).unwrap(),
            "retain original bytes"
        );
    }
    async fn assert_one_real_unlink_failure_does_not_abort_its_sibling(root: &Path) {
        let pending = root.join("sls-failed-logs.delete-pending");
        let started = tokio::time::Instant::now();
        let result = LegacySlsFailedLogCleanupService::with_delays(
            root,
            0,
            0,
            LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS.to_vec(),
        )
        .run_cleanup()
        .await;
        assert_eq!(
            result,
            LegacySlsFailedLogCleanupResult {
                renamed: false,
                deleted: 1,
                skipped: 0,
                errors: 1,
                logical_bytes: b"deletable sibling".len() as u64,
            }
        );
        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_millis(5250)
        );
        assert!(pending.is_dir());
        assert!(pending.join("busy.jsonl").is_file());
        assert!(!pending.join("ok.jsonl").exists());
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    #[ignore = "Requires a root Unix test environment to create an owned sticky directory and drop privileges; run this exact test with --ignored"]
    async fn sticky_directory_unlink_denial_keeps_busy_file_and_continues_same_cleanup_cycle() {
        use std::os::unix::fs::PermissionsExt;
        const CHILD: &str = "PILOT_LEGACY_UNLINK_DENIAL_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            assert_ne!(
                unsafe { libc::getuid() },
                0,
                "the child must actually drop root"
            );
            assert_one_real_unlink_failure_does_not_abort_its_sibling(&PathBuf::from(root)).await;
            return;
        }
        assert_eq!(
            unsafe { libc::getuid() },
            0,
            "run this fixture in the root container"
        );
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let pending = root.path().join("sls-failed-logs.delete-pending");
        std::fs::create_dir(&pending).unwrap();
        std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o1777)).unwrap();
        std::fs::write(pending.join("busy.jsonl"), b"original protected content").unwrap();
        std::fs::set_permissions(
            pending.join("busy.jsonl"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        std::fs::write(pending.join("ok.jsonl"), b"deletable sibling").unwrap();
        let child_uid = 65_534;
        std::os::unix::fs::chown(pending.join("ok.jsonl"), Some(child_uid), Some(child_uid))
            .unwrap();
        let executable = root.path().join("isolated-unlink-fixture");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = std::process::Command::new(executable);
        command.args(["--exact","core::legacy_sls_failed_log_cleanup::tests::sticky_directory_unlink_denial_keeps_busy_file_and_continues_same_cleanup_cycle","--ignored","--nocapture"])
            .env_clear().env(CHILD,root.path()).env("HOME",root.path()).env("USERPROFILE",root.path())
            .env("PATH",root.path()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        use std::os::unix::process::CommandExt;
        command.uid(child_uid).gid(child_uid);
        let mut child = command.spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!("sticky directory fixture timed out: {output:?}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            std::fs::read(pending.join("busy.jsonl")).unwrap(),
            b"original protected content"
        );
        assert!(!pending.join("ok.jsonl").exists());
    }

    #[cfg(windows)]
    #[tokio::test(start_paused = true)]
    async fn sharing_violation_keeps_busy_file_and_continues_same_cleanup_cycle() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let pending = root.path().join("sls-failed-logs.delete-pending");
        std::fs::create_dir(&pending).unwrap();
        let path = pending.join("busy.jsonl");
        std::fs::write(&path, b"original protected content").unwrap();
        std::fs::write(pending.join("ok.jsonl"), b"deletable sibling").unwrap();
        // Deny all sharing so the actual unlink reports ERROR_SHARING_VIOLATION.
        let occupied = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert_one_real_unlink_failure_does_not_abort_its_sibling(root.path()).await;
        drop(occupied);
        assert_eq!(std::fs::read(&path).unwrap(), b"original protected content");
    }

    #[cfg(windows)]
    #[test]
    fn windows_access_sharing_and_lock_violations_are_transient_cleanup_errors() {
        for (code, expected) in [(5, "EACCES"), (32, "EBUSY"), (33, "EBUSY")] {
            let error = std::io::Error::from_raw_os_error(code);
            assert_eq!(io_code(&error), expected);
            assert!(is_transient(&io_code(&error)));
        }
    }
    #[cfg(unix)]
    mod ordinary_unix_unlink_fixture {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::prelude::*;

        #[derive(Default)]
        struct RecordedFields(Vec<(String, String)>);
        impl tracing::field::Visit for RecordedFields {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                self.0.push((field.name().to_owned(), value.to_owned()));
            }
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.0.push((field.name().to_owned(), format!("{value:?}")));
            }
        }

        struct RestoreOnlyAfterGiveup {
            pending: PathBuf,
            started: tokio::time::Instant,
            observations: Arc<Mutex<Vec<(u32, Duration)>>>,
        }
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RestoreOnlyAfterGiveup {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                if *event.metadata().level() != tracing::Level::WARN
                    || event.metadata().target() != "loongsuite_pilot"
                {
                    return;
                }
                let mut fields = RecordedFields::default();
                event.record(&mut fields);
                let tag = fields
                    .0
                    .iter()
                    .any(|(key, value)| key == "tag" && value == "LegacySlsFailureCleanup");
                let final_failure = fields.0.iter().any(|(key, value)| {
                    key == "message" && value == "legacy SLS failure cleanup operation failed"
                });
                if !tag || !final_failure {
                    return;
                }
                // This observes the existing real logger event after retry gives up.
                // No unlink callback or filesystem operation is substituted.
                let mode = std::fs::metadata(&self.pending)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777;
                let elapsed = tokio::time::Instant::now() - self.started;
                self.observations.lock().unwrap().push((mode, elapsed));
                assert_eq!(
                    mode, 0o555,
                    "the first file must stay unwritable throughout every retry"
                );
                assert_eq!(elapsed, Duration::from_millis(5250));
                std::fs::set_permissions(&self.pending, std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
        }

        struct WritableOnDrop(PathBuf);
        impl Drop for WritableOnDrop {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }

        pub(super) async fn exercise(home: &Path) {
            assert_ne!(unsafe { libc::getuid() }, 0);
            assert_ne!(unsafe { libc::geteuid() }, 0);
            let fixture = tempfile::Builder::new()
                .prefix("unlink-owner-")
                .tempdir_in(home)
                .unwrap();
            let pending = fixture.path().join("sls-failed-logs.delete-pending");
            std::fs::create_dir(&pending).unwrap();
            std::fs::write(pending.join("busy.jsonl"), b"original protected content").unwrap();
            std::fs::write(pending.join("ok.jsonl"), b"deletable sibling").unwrap();
            let _restore = WritableOnDrop(pending.clone());
            let observations = Arc::new(Mutex::new(Vec::new()));
            let started = tokio::time::Instant::now();
            let subscriber = tracing_subscriber::registry().with(RestoreOnlyAfterGiveup {
                pending: pending.clone(),
                started,
                observations: observations.clone(),
            });
            let _subscriber = tracing::subscriber::set_default(subscriber);
            std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o555)).unwrap();
            let result = LegacySlsFailedLogCleanupService::with_delays(
                fixture.path(),
                0,
                0,
                LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS.to_vec(),
            )
            .run_cleanup()
            .await;
            assert_eq!(
                result,
                LegacySlsFailedLogCleanupResult {
                    renamed: false,
                    deleted: 1,
                    skipped: 0,
                    errors: 1,
                    logical_bytes: b"deletable sibling".len() as u64,
                }
            );
            assert_eq!(
                tokio::time::Instant::now() - started,
                Duration::from_millis(5250)
            );
            assert_eq!(
                observations.lock().unwrap().as_slice(),
                &[(0o555, Duration::from_millis(5250))]
            );
            assert_eq!(
                std::fs::metadata(&pending).unwrap().permissions().mode() & 0o777,
                0o755
            );
            assert_eq!(
                std::fs::read(pending.join("busy.jsonl")).unwrap(),
                b"original protected content"
            );
            assert!(!pending.join("ok.jsonl").exists());
        }

        pub(super) struct RestoreChildHome(pub PathBuf);
        impl Drop for RestoreChildHome {
            fn drop(&mut self) {
                // A killed fixture cannot run its own guard. These are exclusively
                // our synthetic temp directories, and links are never followed.
                for entry in walkdir::WalkDir::new(&self.0)
                    .follow_links(false)
                    .into_iter()
                    .flatten()
                {
                    if entry.file_type().is_dir() {
                        let _ = std::fs::set_permissions(
                            entry.path(),
                            std::fs::Permissions::from_mode(0o755),
                        );
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn unwritable_directory_unlink_denial_restores_permissions_only_after_giveup_and_continues_same_cleanup_cycle(
    ) {
        use std::os::unix::fs::PermissionsExt;
        const CHILD: &str = "PILOT_CLEANUP_ORDINARY_UNIX_UNLINK_CHILD";
        const EXPECTED_UID: &str = "PILOT_CLEANUP_ORDINARY_UNIX_UNLINK_UID";
        if let Some(home) = std::env::var_os(CHILD) {
            let expected: u32 = std::env::var(EXPECTED_UID).unwrap().parse().unwrap();
            assert_eq!(unsafe { libc::getuid() }, expected);
            assert_eq!(unsafe { libc::geteuid() }, expected);
            ordinary_unix_unlink_fixture::exercise(&PathBuf::from(home)).await;
            return;
        }
        // /tmp has traversable ancestors even for a root macOS test process;
        // user-private TMPDIR ancestors may not be traversable after setuid.
        let parent = tempfile::Builder::new()
            .prefix("pilot-cleanup-unlink-")
            .tempdir_in("/tmp")
            .unwrap();
        std::fs::set_permissions(parent.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let home = parent.path().join("child-home");
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        let drop_root = unsafe { libc::geteuid() } == 0;
        let child_uid = if drop_root { 65_534 } else { uid };
        if drop_root {
            std::os::unix::fs::chown(&home, Some(child_uid), Some(child_uid)).unwrap();
        }
        let _restore = ordinary_unix_unlink_fixture::RestoreChildHome(home.clone());
        let executable = parent.path().join("isolated-unlink-tests");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = std::process::Command::new(executable);
        command.args(["--exact","core::legacy_sls_failed_log_cleanup::tests::unwritable_directory_unlink_denial_restores_permissions_only_after_giveup_and_continues_same_cleanup_cycle","--nocapture"])
            .env_clear().env(CHILD,&home).env(EXPECTED_UID,child_uid.to_string())
            .env("HOME",&home).env("USERPROFILE",&home)
            .env("TMPDIR",&home).env("TMP",&home).env("TEMP",&home)
            .env("LOG_LEVEL","warn").env("PATH",parent.path().join("no-agent-runtimes"))
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        if drop_root {
            use std::os::unix::process::CommandExt;
            command.uid(child_uid).gid(child_uid);
        }
        let mut child = command.spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "ordinary Unix unlink fixture timed out: stdout={} stderr={}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "ordinary Unix unlink fixture failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        // The real Pino record carries retry metadata not included by the tracing
        // bridge. Assert that record too, instead of inferring attempts only from time.
        let stdout = String::from_utf8_lossy(&output.stdout);
        let warnings: Vec<serde_json::Value> = stdout
            .lines()
            .filter_map(|line| {
                let json_start = line.find("{\"level\"")?;
                serde_json::from_str(&line[json_start..]).ok()
            })
            .filter(|row: &serde_json::Value| {
                row.get("msg").and_then(serde_json::Value::as_str)
                    == Some("legacy SLS failure cleanup operation failed")
            })
            .collect();
        assert_eq!(
            warnings.len(),
            1,
            "missing or duplicate real giveup WARN: {stdout}"
        );
        let warning = &warnings[0];
        assert_eq!(warning["level"], "WARN");
        assert_eq!(warning["tag"], "LegacySlsFailureCleanup");
        assert_eq!(warning["operation"], "unlink");
        assert_eq!(warning["error"], "EACCES");
        assert_eq!(warning["attempts"].as_u64(), Some(4));
    }
}
