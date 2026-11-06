//! Local interceptor: hook adapters, rule engine, verdict store, and loopback daemon.
//!
//! On-disk names match the TypeScript sources: `runtime.json`, `interceptor.pid`,
//! `tool-verdicts.json`, and `logs/access.log`.

pub mod adapters;
pub mod cli;
pub mod daemon;
pub mod rules;

mod access_log;
mod blocked_prompt;
mod config;
mod paths;
mod tool_verdict_store;
mod types;

pub use access_log::{
    access_input_from_hook_request, access_input_from_payload, build_access_log_entry,
    serialize_access_log_entry, write_interceptor_access_log, AccessLogAction, AccessLogLimits,
    InterceptorAccessInput, InterceptorAccessLogEntry, InterceptorAccessResult,
    ACCESS_LOG_MAX_BYTES, ACCESS_LOG_MAX_CHARS, ACCESS_LOG_ROTATE_COUNT,
};
pub use blocked_prompt::build_blocked_qoder_prompt_entry;
pub use config::{
    build_interceptor_config, build_interceptor_config_with, ensure_mask_covers_interceptor,
    is_rule_enabled, load_interceptor_config, resolve_enabled_interceptor_types,
    resolve_enabled_rule_ids,
};
pub use paths::{
    default_pilot_data_dir, interceptor_access_log_path, interceptor_data_dir,
    interceptor_lock_path, interceptor_log_path, interceptor_pid_path, interceptor_runtime_path,
    interceptor_tool_verdict_path,
};
pub use tool_verdict_store::{
    is_tool_intercept_phase, ToolInterceptPhase, ToolVerdictAction, ToolVerdictKey,
    ToolVerdictStore, TOOL_VERDICT_CHECKPOINT_INTERVAL_MS, TOOL_VERDICT_TTL_MS,
};
pub use types::*;
