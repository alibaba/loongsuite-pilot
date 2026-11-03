//! Declarative agent deployment.
//!
//! Public names follow the TypeScript modules. `src/lib.rs` is owned by
//! another porting step and is the place that publishes `pub mod deployment`.

mod agent_def_loader;
mod cli_probe_detector;
mod codex_trust_writer;
mod copilot_plugin_strategy;
mod deploy_command;
mod deploy_notification;
mod deployed_state_merge;
mod deployment_manager;
mod deployment_scope;
mod detect_utils;
mod detection_only_strategy;
mod directory_plugin_strategy;
mod dsh_runtime_locator;
mod dsh_yaml_patch_strategy;
mod env_agent_dirs;
mod grok_build_assets;
mod hook_assets;
mod hook_command;
mod hook_install_alarm;
mod hook_install_service;
mod hook_strategy;
mod inject_command;
mod installer_config;
pub(crate) mod installer_helper;
mod legacy_cli_cleanup;
mod legacy_uninstall;
mod native_hermes_rollback;
pub(crate) mod native_install;
mod native_installer_stop;
mod native_uninstall;
mod openclaw_compat;
mod openclaw_version_resolver;
mod paths;
mod persisted_deploy_paths;
mod pi_sdk_identity;
mod plugin_assets;
mod plugin_inject_strategy;
mod plugin_migration;
mod plugin_probe_strategy;
mod runtime_launcher;
mod worker_manifest_supervisor;
mod worker_process;

pub use agent_def_loader::{AgentDefLoader, AgentDefLoaderOptions};
pub use cli_probe_detector::{
    probe_agent_definition, probe_agent_definitions, try_probe_agent_definition,
    try_probe_agent_definitions, CliProbeOptions, CliProbeResult,
};
pub use codex_trust_writer::{
    compute_hook_trust_hash, compute_installed_hook_trust_hash, hook_state_key,
    installed_hook_state_key, remove_trust_block, remove_trust_state_keys, verify_trust_hashes,
    write_trusted_hashes, InstalledCodexCommandHandler, InstalledCodexHookLocation,
    InstalledTrustOpts, InvalidCodexConfigError, LegacyTrustOpts, TrustOpts, TrustPlatform,
    VerifyResult, CODEX_HOOK_EVENT_KEYS,
};
pub use copilot_plugin_strategy::{
    build_copilot_plugin_hooks, build_copilot_plugin_manifest, copilot_shell_block,
    CopilotPluginStrategy,
};
pub use deploy_command::{
    collect_unmet, deploy_exit_code, deploy_loaded_config, is_agent_gated_enabled, parse_args,
    resolve_pilot_dir, DeployCommandOptions, UnmetRequirement, DEFAULT_DATA_DIR,
};
pub use deploy_notification::{
    build_rc_snippet, read_pending_notifications, write_deploy_notification,
};
pub use deployed_state_merge::{
    merge_deployed_agents_state, merge_hook_settings_paths, with_deployed_state_lock,
};
pub use deployment_manager::{DeploymentManager, DeploymentManagerOptions};
pub use deployment_scope::{resolve_deployment_scope, DeploymentScopeMode, DeploymentScopeResult};
pub use detect_utils::{command_exists, detect_agent};
pub use detection_only_strategy::DetectionOnlyStrategy;
pub use directory_plugin_strategy::DirectoryPluginStrategy;
pub use dsh_runtime_locator::{DshRuntimeLocator, DshRuntimeTarget, DshRuntimeTargetSource};
pub use dsh_yaml_patch_strategy::{DshYamlPatchStrategy, DSH_ENABLED_MARKER};
pub use env_agent_dirs::{
    resolve_dsh_home, resolve_grok_home, resolve_pi_coding_agent_dir, DEFAULT_DSH_HOME,
    DEFAULT_GROK_HOME, DEFAULT_PI_CODING_AGENT_DIR,
};
pub use grok_build_assets::{
    are_grok_build_hook_assets_healthy, restore_grok_build_hook_assets, GROK_BUILD_HOOK_ASSETS,
};
pub use hook_command::{parse_hook_args, run_hook_command_with_config, ParsedHookArgs};
pub use hook_install_alarm::{
    hook_install_alarm_key, should_relay_hook_install_alarm, HookInstallAlarmAgent,
    HookInstallAlarmReport,
};
pub use hook_install_service::{
    classify_deploy_error, definition_at_install_home, exit_code_for, hint_for_reason,
    hook_install_result_path, hook_install_signal_path, mark_hook_install_alarm_sent,
    merge_installed_agents, read_committed_hook_install_report, relative_to_detection_home,
    run_hook_install, select_agents, to_public_report, AgentSelection, HookInstallReport,
    HookInstallRunOptions, HookInstallRunResult, HOOK_INSTALL_REASONS, HOOK_INSTALL_RESULT_FILE,
    HOOK_INSTALL_SIGNAL_FILE,
};
pub use hook_strategy::HookStrategy;
pub use inject_command::{inject_claude_directory, merge_claude_hooks, parse_inject_command_args};
pub use openclaw_compat::{open_claw_capabilities, OpenClawCapabilities, MIN_OPENCLAW_VERSION};
pub use openclaw_version_resolver::{
    is_openclaw_host_bound, openclaw_binding_problem, resolve_openclaw_host, OpenClawHost,
    OpenClawResolveMode,
};
pub use persisted_deploy_paths::{
    apply_persisted_deploy_targets, backfill_lifecycle_fields, definition_at_hook_settings,
    home_from_config_file, lifecycle_fields_for_deploy,
};
pub use plugin_inject_strategy::PluginInjectStrategy;
pub use plugin_migration::{run_plugin_migration, PluginMigrationReport};
pub use plugin_probe_strategy::{PluginProbeDeployOptions, PluginProbeStrategy};
pub use worker_manifest_supervisor::{
    WorkerManifest, WorkerManifestOptions, WorkerManifestSupervisor,
};

pub(crate) mod runtime_retirement;

pub mod eager_injection;

pub(crate) use deployed_state_merge::open_state_lock;
pub(crate) mod runtime_data_assets;
