//! Installer probe for one agent definition.

use crate::types::AgentDefinition;
use std::collections::HashMap;

use super::detect_utils::{command_exists, detect_agent};
use super::dsh_runtime_locator::{DshRuntimeLocator, DshRuntimeTarget};
use super::openclaw_version_resolver::{
    is_openclaw_host_bound, openclaw_binding_problem, resolve_openclaw_host, OpenClawResolveMode,
};
use crate::utils::resolve_home;
use crate::utils::{directory_exists, file_exists};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbeResult {
    pub id: String,
    pub display_name: String,
    pub detected: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openclaw_cli_path: Option<String>,
}

#[derive(Default)]
pub struct CliProbeOptions {
    pub list_only: bool,
    pub installer: bool,
    pub dsh_runtime_locator: Option<DshRuntimeLocator>,
}

#[async_trait::async_trait]
trait GenericProbeDetector: Send + Sync {
    async fn detect(&self, detection: &crate::types::AgentDetectionConfig) -> Result<bool, String>;
}
struct NativeGenericProbeDetector;
#[async_trait::async_trait]
impl GenericProbeDetector for NativeGenericProbeDetector {
    async fn detect(&self, detection: &crate::types::AgentDetectionConfig) -> Result<bool, String> {
        // Preserve the original paths-first and commands-in-order short circuit.
        let paths_only = crate::types::AgentDetectionConfig {
            paths: detection.paths.clone(),
            commands: Vec::new(),
        };
        if detect_agent(&paths_only).await {
            return Ok(true);
        }
        for command in &detection.commands {
            // execFile rejects NUL argv before launching which/where. It is an
            // error only if collection actually reaches this command.
            if command.contains('\0') {
                return Err(
                    "generic detector failed: detection command contains an embedded NUL".into(),
                );
            }
            if command_exists(command).await {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Fallible native equivalent of the original async/throwing probe API.
/// Actual CLI probes use this path so generic errors are not silently misses.
pub async fn try_probe_agent_definition(
    def: &AgentDefinition,
    options: &CliProbeOptions,
) -> Result<CliProbeResult, String> {
    probe_agent_definition_with_detector(def, options, &NativeGenericProbeDetector).await
}

/// Preserve the existing nonfallible embedding API; the public CLI uses try_*.
pub async fn probe_agent_definition(
    def: &AgentDefinition,
    options: &CliProbeOptions,
) -> CliProbeResult {
    try_probe_agent_definition(def, options)
        .await
        .unwrap_or_else(|_| CliProbeResult {
            id: def.id.clone(),
            display_name: def.display_name.clone(),
            detected: false,
            reason: String::new(),
            openclaw_cli_path: None,
        })
}

pub async fn try_probe_agent_definitions(
    definitions: &[AgentDefinition],
    options: &CliProbeOptions,
) -> Result<Vec<CliProbeResult>, String> {
    let mut results = Vec::new();
    for def in definitions {
        if def.detection.paths.is_empty() && def.detection.commands.is_empty() {
            continue;
        }
        results.push(try_probe_agent_definition(def, options).await?);
    }
    Ok(results)
}

async fn probe_agent_definition_with_detector(
    def: &AgentDefinition,
    options: &CliProbeOptions,
    detector: &dyn GenericProbeDetector,
) -> Result<CliProbeResult, String> {
    let mut result = CliProbeResult {
        id: def.id.clone(),
        display_name: def.display_name.clone(),
        detected: false,
        reason: String::new(),
        openclaw_cli_path: None,
    };
    if options.list_only {
        return Ok(result);
    }
    if def.id == "openclaw" {
        let mut env = HashMap::new();
        for (key, value) in std::env::vars() {
            env.insert(key, value);
        }
        let cwd = std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".into());
        let mut detail = None;
        let host = resolve_openclaw_host(
            &env,
            &cwd,
            Some(|message: String| detail = Some(message)),
            if options.installer {
                OpenClawResolveMode::Installer
            } else {
                OpenClawResolveMode::Runtime
            },
        )
        .await;
        let bound = is_openclaw_host_bound(host.as_ref());
        result.detected = bound;
        if bound {
            result.openclaw_cli_path = host.as_ref().and_then(|host| host.executable.clone());
        }
        result.reason = if bound {
            let host = host.unwrap();
            let recovered = host
                .recovered_from
                .as_ref()
                .map(|value| {
                    format!(
                        "; replacing missing entry {}",
                        serde_json::to_string(value).unwrap_or_default()
                    )
                })
                .unwrap_or_default();
            format!(
                "{} ({}, {}, bound entry){recovered}",
                host.source, host.version, host.adapter
            )
        } else {
            openclaw_binding_problem(host.as_ref(), detail.as_deref())
        };
        return Ok(result);
    }
    if def.deploy_mode == crate::types::DeployMode::DshYamlPatch {
        let locator = options.dsh_runtime_locator.as_ref();
        let owned = DshRuntimeLocator::new();
        let locator = locator.unwrap_or(&owned);
        return Ok(match locator.locate(def, None).await {
            Ok(Some(target)) => {
                result.detected = true;
                result.reason = if target.source
                    == super::dsh_runtime_locator::DshRuntimeTargetSource::StandardDetection
                {
                    find_detection_reason(def).await
                } else {
                    describe_dsh_target(&target)
                };
                result
            }
            _ => result,
        });
    }
    let detected = detector.detect(&def.detection).await?;
    result.detected = detected;
    if detected {
        result.reason = find_detection_reason(def).await;
    }
    Ok(result)
}

pub async fn probe_agent_definitions(
    definitions: &[AgentDefinition],
    options: &CliProbeOptions,
) -> Vec<CliProbeResult> {
    let mut results = Vec::new();
    for def in definitions {
        if def.detection.paths.is_empty() && def.detection.commands.is_empty() {
            continue;
        }
        results.push(probe_agent_definition(def, options).await);
    }
    results
}

async fn find_detection_reason(def: &AgentDefinition) -> String {
    for configured in &def.detection.paths {
        let resolved = resolve_home(configured);
        if directory_exists(&resolved).await || file_exists(&resolved).await {
            return configured.clone();
        }
    }
    for command in &def.detection.commands {
        if command_exists(command).await {
            return format!("command: {command}");
        }
    }
    String::new()
}

fn describe_dsh_target(target: &DshRuntimeTarget) -> String {
    match target.source {
        super::dsh_runtime_locator::DshRuntimeTargetSource::RunningProcess => {
            format!(
                "running process: DSH_HOME={}{}",
                target.home,
                target
                    .pid
                    .map(|pid| format!(" (pid {pid})"))
                    .unwrap_or_default()
            )
        }
        super::dsh_runtime_locator::DshRuntimeTargetSource::PilotEnv => {
            format!("DSH_HOME={}", target.home)
        }
        super::dsh_runtime_locator::DshRuntimeTargetSource::ConfiguredPatch => {
            format!("configured patch: {}", target.patch_path)
        }
        super::dsh_runtime_locator::DshRuntimeTargetSource::Persisted => {
            format!("persisted patch: {}", target.patch_path)
        }
        super::dsh_runtime_locator::DshRuntimeTargetSource::StandardDetection => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_json_keeps_the_bound_openclaw_entry() {
        let mut result = CliProbeResult {
            id: "openclaw".into(),
            display_name: "OpenClaw".into(),
            detected: true,
            reason: "bound entry".into(),
            openclaw_cli_path: Some("目录 O'Brien 🚀/openclaw".into()),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["openclawCliPath"], "目录 O'Brien 🚀/openclaw");
        assert_eq!(json["displayName"], "OpenClaw");
        result.openclaw_cli_path = None;
        assert!(serde_json::to_value(&result)
            .unwrap()
            .get("openclawCliPath")
            .is_none());
    }
}

#[cfg(test)]
#[path = "cli_probe_detector_history_contract_tests.rs"]
mod history_contract_tests;
