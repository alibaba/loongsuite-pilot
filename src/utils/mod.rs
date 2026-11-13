//! Utility ports of `src/utils/*.ts`.
//!
//! Names that cross a process boundary — JSON fields, file names, environment
//! variables, and error strings — stay as they are in the TypeScript sources.
//! Rust items use snake_case.

pub mod agent_type_normalize;
pub mod candidate_process;
pub mod container_identity;
pub mod content_hash;
pub mod crash_breadcrumb;
pub mod data_dir;
pub mod fs_utils;
pub mod git_context;
pub mod installed_process;
pub mod json_document;
pub mod logger;
pub mod native_binary;
pub mod network_utils;
pub mod node_sqlite;
pub mod pid_utils;
pub mod poll_interval;
pub mod process_discovery;
pub mod record_utils;
pub mod restart_breadcrumb;
pub mod runtime_paths;
pub mod single_instance_lock;
pub mod sync_file_lock;
pub mod time_utils;
pub mod win_archive;

/// 在独立测试进程中执行环境变量用例，避免污染并行用例；返回 true 才执行用例主体。
#[cfg(test)]
pub(crate) fn isolated_env_test() -> bool {
    const MARKER: &str = "PILOT_ISOLATED_ENV_TEST";
    let thread = std::thread::current();
    let name = thread.name().expect("测试线程必须有名称");
    if std::env::var(MARKER).as_deref() == Ok(name) {
        return true;
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", name, "--nocapture"])
        .env(MARKER, name);
    let mut child = candidate_process::CandidateChild::spawn(&mut command).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "隔离环境测试失败：{name}");
            return false;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "隔离环境测试超时：{name}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

pub use agent_type_normalize::normalize_agent_type;
pub use container_identity::{
    identity_from_parts, read_container_identity, read_container_identity_with, ContainerIdentity,
    ContainerIdentitySource,
};
pub use content_hash::content_hash;
pub use crash_breadcrumb::{
    clear_startup_crash, read_startup_crash, resolve_breadcrumb_data_dir, startup_crash_path,
    write_startup_crash, ReportedError, StartupCrashBreadcrumb, StartupCrashWrite,
};
pub use data_dir::{
    config_json_path, config_json_path_from, pick_data_dir, read_config_agents_gate,
    read_config_file_data_dir, read_env_data_dir, resolve_data_dir, DEFAULT_CONFIG_PATH,
    DEFAULT_DATA_DIR,
};
pub use fs_utils::{
    append_line, clean_stale_tmp_files, directory_exists, ensure_dir, file_exists,
    get_today_date_string, read_installed_version, read_json_file, resolve_home, resolve_home_with,
    write_json_file, write_text_file_atomic, AtomicTextWriteOptions, AtomicWriteError, EnvSource,
    ExpectedFileState, HomeResolutionOptions, Platform, DEFAULT_STALE_TMP_MAX_AGE_MS,
};
pub use git_context::{infer_git_context, normalize_repo, BoundedTtlCache, GitContextResult};
pub use json_document::{
    detect_json_formatting, edit_jsonc, parse_json_document, read_json_document, FormattingOptions,
    JsonDocumentRead, JsonEditOptions, JsonParseError, JsonPathSeg, JsonSyntax,
};
pub use logger::{
    create_logger, flush_logs_sync, init_file_logging, redirect_root_logger_to_stderr, BoundLogger,
};
pub use network_utils::{build_user_agent, local_ip, resolve_local_ip};
pub use node_sqlite::{
    load_database_sync, query_readonly, query_readonly_paged, sqlite_engine_available,
    DatabaseSync, SqlitePageCursor, SqliteQueryError, NODE_SQLITE_PROBE, NODE_SQLITE_UNAVAILABLE,
    SQLITE_SYNC_PAGE,
};
pub use pid_utils::{
    check_process_liveness, find_process_by_command, is_command_match, is_pid_file_running,
    is_process_alive, process_alive_from_kill, read_pid_file, read_process_command,
    read_process_start_token, remove_own_pid_file_sync, write_pid_file_sync, PidFileState,
    ProcessCommandPattern, ProcessLiveness, ProcessLivenessSource, COLLECTOR_PROCESS_PATTERNS,
    INTERCEPTOR_PROCESS_PATTERNS, UPDATER_PROCESS_PATTERNS,
};
pub type ProcessLivenessProbe = std::sync::Arc<dyn Fn(&str) -> ProcessLiveness + Send + Sync>;

pub use poll_interval::{
    global_poll_interval_ms, resolve_poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, POLL_INTERVAL_ENV,
};
pub use process_discovery::{is_updater_running_on_windows_sync, updater_running_from_scan};
pub use record_utils::flatten_to_strings;
pub use restart_breadcrumb::{
    clear_restart_failure, coerce_restart_diag, describe_restart_command_error,
    is_restart_command_timeout, is_restart_failure_fresh, read_restart_failure,
    restart_failure_path, sanitize_alarm_text, summarize_restart_failure, write_restart_failure,
    RestartCommandError, RestartExitCode, RestartFailureBreadcrumb, RestartFailureWrite,
    RestartTarget, RESTART_STAGES,
};
pub use single_instance_lock::{
    acquire_single_instance_lock, HolderCommandState, HolderProcessStartState, LockAcquireResult,
    SingleInstanceLock, StaleLockReason, StaleLockRecovery,
};
pub use time_utils::format_time;
pub use win_archive::{
    extract_tar_gz, get_ascii_temp_root, is_ascii_path, make_tar_staging_dir, replace_dir_with,
    reset_inherited_acl, WinArchiveError,
};

pub mod segmented_jsonl_writer;
pub use segmented_jsonl_writer::{
    append_segmented_jsonl, append_segmented_jsonl_batch, parse_output_segment,
    with_jsonl_file_lock, DEFAULT_JSONL_SEGMENT_BYTES, LOCAL_LOG_EMERGENCY_FILE_BYTES,
};

pub(crate) mod file_identity;
pub(crate) mod raw_source;

#[cfg(all(test, windows))]
pub(crate) mod windows_test_junction;

pub(crate) mod json_size;
pub mod source_access;
