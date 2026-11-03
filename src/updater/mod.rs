//! Updater process: version comparison, canary rollout, download, and rollback.
//!
//! `src/updater/index.ts` is the standalone process entry. It is ported as
//! [`run_updater_main`] but is not wired from `src/main.rs` in this change.

pub(crate) mod activation_file_targets;
mod activation_transaction;
mod auto_update_config;
mod package_archive;
mod release_manifest;
#[path = "updater.rs"]
mod runtime;
mod runtime_state;
mod startup_crash_classifier;
mod updater_metrics;
mod version_utils;

pub(crate) use activation_transaction::ActivationTransaction;
pub use auto_update_config::{build_auto_update_config, build_auto_update_config_with};
pub use package_archive::{unpack as unpack_release_archive, UnpackedPackage};
pub use release_manifest::{ArchiveFormat, LatestManifest, ReleaseAsset, VersionManifest};
pub use runtime::{
    backoff_ms, build_paths, build_paths_for, collector_command_invocation, format_command_failure,
    pilot_bin_path, verify_checksum, LocalVersion, ResolvedTarget, UpdateChannel, Updater,
    UpdaterNet, UpdaterPaths, MAX_BACKOFF_MS, MAX_CONSECUTIVE_FAILURES,
};
pub use runtime_state::{updater_runtime_path, UpdaterRuntimeState, UpdaterRuntimeStatus};
pub use startup_crash_classifier::{
    classify_startup_crash, StartupCrashClassification, StartupCrashReason,
};
pub use updater_metrics::{UpdaterEventExtra, UpdaterMetrics, UpdaterMetricsOptions};
pub use version_utils::{compare_versions, compute_sha256, deterministic_bucket};

use crate::updater::updater_metrics::UpdaterMetricsOptions as MetricsOptions;
use crate::utils::{
    acquire_single_instance_lock, create_logger, flush_logs_sync, init_file_logging,
    read_installed_version, remove_own_pid_file_sync, write_pid_file_sync, Platform,
    SingleInstanceLock, UPDATER_PROCESS_PATTERNS,
};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Arc;

struct ProcessGuard {
    lock: SingleInstanceLock,
    pid_file: Option<String>,
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        if let Some(path) = self.pid_file.as_deref() {
            remove_own_pid_file_sync(path);
        }
        self.lock.release();
        flush_logs_sync();
    }
}

/// Standalone updater process. Mirrors `src/updater/index.ts`.
pub async fn run_updater_main() -> i32 {
    let logger = create_logger("UpdaterMain");
    let data_dir = crate::utils::resolve_data_dir(None);
    if let Err(err) = init_file_logging(
        &Path::new(&data_dir)
            .join("logs")
            .join("loongsuite-pilot-updater.log")
            .to_string_lossy(),
    )
    .await
    {
        eprintln!("更新器日志初始化失败：{err}");
        return 1;
    }
    logger.info("updater process starting", None);
    let config_path = crate::utils::config_json_path();
    let file = match runtime::read_config_for_update(&config_path).await {
        Ok(file) => file,
        Err(err) => {
            eprintln!("更新器配置读取失败：{err}");
            flush_logs_sync();
            return 1;
        }
    };
    let config = build_auto_update_config(Some(&file));
    if !config.enabled {
        logger.info("auto-update disabled via config, exiting", None);
        flush_logs_sync();
        return 0;
    }
    let lock_path = Path::new(&data_dir)
        .join("updater.lock")
        .to_string_lossy()
        .into_owned();
    let acquired = acquire_single_instance_lock(&lock_path, Some(UPDATER_PROCESS_PATTERNS));
    let Some(lock) = acquired.lock else {
        if let Some(err) = acquired.error {
            eprintln!("更新器单实例锁创建失败：{err}");
            flush_logs_sync();
            return 1;
        }
        let mut meta = Map::new();
        meta.insert("lockPath".into(), Value::String(lock_path));
        logger.warn(
            "another updater instance already holds the lock; exiting",
            Some(&meta),
        );
        flush_logs_sync();
        return 0;
    };
    let pid_file = if Platform::current() == Platform::Win32 {
        Some(
            Path::new(&data_dir)
                .join("loongsuite-pilot-updater.pid")
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        None
    };
    if let Some(pid_file) = pid_file.as_deref() {
        write_pid_file_sync(pid_file);
    }
    let _process = ProcessGuard { lock, pid_file };
    let user_id = std::env::var("LOONGSUITE_PILOT_USER_ID").ok().or_else(|| {
        file.get("userId")
            .or_else(|| file.get("user.id"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let user_id = user_id.unwrap_or_else(|| {
        hostname::get()
            .ok()
            .and_then(|name| name.into_string().ok())
            .unwrap_or_else(|| "unknown".into())
    });
    let version = read_installed_version(&data_dir);
    crate::internal::configure_telemetry(&data_dir).await;
    let metrics = Arc::new(UpdaterMetrics::new(MetricsOptions {
        data_dir: data_dir.clone(),
        version,
        collector_pid_file: Path::new(&data_dir)
            .join("loongsuite-pilot.pid")
            .to_string_lossy()
            .into_owned(),
        user_id,
        collector_liveness: None,
        date_string: None,
        now_ms: None,
        alarm_sender: None,
        ip: None,
    }));
    metrics.start().await;
    let updater = Updater::new(config, None);
    updater.set_metrics(metrics.clone());
    updater
        .run_until(crate::cli_main::wait_for_shutdown())
        .await;
    metrics.stop().await;
    flush_logs_sync();
    0
}

#[cfg(test)]
mod process_tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_entry_scope_releases_only_owned_lock_and_pid() {
        let root = tempfile::tempdir().unwrap();
        let lock_path = root
            .path()
            .join("updater.lock")
            .to_string_lossy()
            .into_owned();
        let pid_file = root
            .path()
            .join("updater.pid")
            .to_string_lossy()
            .into_owned();
        let lock = acquire_single_instance_lock(&lock_path, None).lock.unwrap();
        write_pid_file_sync(&pid_file);
        let future = async {
            let _guard = ProcessGuard {
                lock,
                pid_file: Some(pid_file.clone()),
            };
            std::future::pending::<()>().await;
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), future)
                .await
                .is_err()
        );
        assert!(!Path::new(&lock_path).exists());
        assert!(!Path::new(&pid_file).exists());
        let lock = acquire_single_instance_lock(&lock_path, None).lock.unwrap();
        let guard = ProcessGuard {
            lock,
            pid_file: Some(pid_file.clone()),
        };
        std::fs::write(&pid_file, "1").unwrap();
        drop(guard);
        assert_eq!(std::fs::read_to_string(pid_file).unwrap(), "1");
    }
}
