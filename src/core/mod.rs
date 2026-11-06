//! Collector orchestration ported from `src/core`.
//!
//! `src/lib.rs` is owned by the wiring step. Publish this module with
//! `pub mod core;` when that file is updated. Command dispatch lives in
//! `src/cli_main.rs` (`pub async fn run`).

mod agent_control_manager;
mod agent_discovery_service;
mod build_constants;
mod config_loader;
mod hook_watchdog;
mod input_manager;
mod intercept_result_linker;
mod legacy_sls_failed_log_cleanup;
mod log_retention_service;
mod orchestrator;
mod updater_watchdog;
mod upstream_link;
mod workspace_policy;

pub use agent_control_manager::AgentControlManager;
pub use agent_discovery_service::{AgentDiscoveryEvent, AgentDiscoveryService};
pub use build_constants::PROPRIETARY_BUILD;
pub use config_loader::{
    assemble_config, build_otlp_trace_config, check_config, load_config, ConfigSources,
};
pub use hook_watchdog::{
    extract_marker_block, parse_windows_user_env, strip_marker_block, CheckResult, HookWatchdog,
    InterceptCheckTarget, MarkerBlock, PluginCheckTarget, TargetResult, TargetStatus,
};
pub use input_manager::{InputCounter, InputManager, LiveInput};
pub use intercept_result_linker::InterceptResultLinker;
pub use legacy_sls_failed_log_cleanup::{
    is_legacy_jsonl_name, LegacySlsFailedLogCleanupService, LEGACY_SLS_CLEANUP_FILE_DELAY_MS,
    LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS, LEGACY_SLS_CLEANUP_STARTUP_DELAY_MS,
};
pub use log_retention_service::{
    extract_date, LogRetentionService, LOCAL_OBSERVABILITY_PRESSURE_MIN_KEEP_DAYS,
    METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES, OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES,
    OUTPUT_RETENTION_LARGE_FILE_DAYS, OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
    OUTPUT_RETENTION_MAX_TOTAL_BYTES, OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS,
    SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES,
};
pub use orchestrator::{Orchestrator, OrchestratorEvent};
pub use updater_watchdog::{
    UpdaterWatchdog, UpdaterWatchdogOptions, UpdaterWatchdogResult, UpdaterWatchdogStatus,
};
pub use upstream_link::{AcpCorrelateRetentionService, CorrelationStore, TraceLinker};
pub use workspace_policy::{validate_excluded_workspaces, WorkspacePolicy};

pub(crate) fn logger(tag: &str) -> crate::utils::BoundLogger {
    crate::utils::create_logger(tag)
}

pub(crate) fn fields(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    match value {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}
