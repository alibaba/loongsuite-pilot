//! Startup-critical eager injection, sharing daemon strategies and data-dir precedence.
//! Only hook/plugin-inject may run here. The caller must never wait for worker
//! activation, package downloads or an updater/collector startup.
use super::deployment_manager::{DeploymentManager, DeploymentManagerOptions};
use crate::types::{AgentDefinition, DeployMode, DeploySkipReason};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InjectArgs {
    pub agents: Vec<String>,
    pub data_dir: Option<String>,
    pub pilot_dir: Option<String>,
    pub unknown_flags: Vec<String>,
}
pub fn parse_inject_args(argv: &[String]) -> InjectArgs {
    let mut out = InjectArgs::default();
    for arg in argv {
        if let Some(raw) = arg.strip_prefix("--agents=") {
            let mut ids = Vec::new();
            for part in raw
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
            {
                if !ids.iter().any(|id| id == part) {
                    ids.push(part.to_owned());
                }
            }
            out.agents = ids;
        } else if let Some(raw) = arg.strip_prefix("--data-dir=") {
            out.data_dir = Some(raw.to_owned());
        } else if let Some(raw) = arg.strip_prefix("--pilot-dir=") {
            out.pilot_dir = Some(raw.to_owned());
        } else if arg.starts_with("--") {
            out.unknown_flags.push(arg.to_owned());
        }
    }
    out
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EagerAction {
    Deploy,
    Deferred,
    UnknownId,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EagerPlanEntry {
    pub agent_id: String,
    pub action: EagerAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deploy_mode: Option<String>,
}
fn eager_safe(mode: DeployMode) -> bool {
    matches!(mode, DeployMode::Hook | DeployMode::PluginInject)
}
pub fn plan_eager_deploys(
    definitions: &[AgentDefinition],
    requested_ids: &[String],
) -> Vec<EagerPlanEntry> {
    let entry = |def: &AgentDefinition| EagerPlanEntry {
        agent_id: def.id.clone(),
        action: if eager_safe(def.deploy_mode) {
            EagerAction::Deploy
        } else {
            EagerAction::Deferred
        },
        deploy_mode: Some(def.deploy_mode.as_str().to_owned()),
    };
    if requested_ids.is_empty() {
        return definitions
            .iter()
            .filter(|def| eager_safe(def.deploy_mode))
            .map(entry)
            .collect();
    }
    let by_id: HashMap<_, _> = definitions
        .iter()
        .map(|def| (def.id.as_str(), def))
        .collect();
    requested_ids
        .iter()
        .map(|id| match by_id.get(id.as_str()) {
            Some(def) => entry(def),
            None => EagerPlanEntry {
                agent_id: id.clone(),
                action: EagerAction::UnknownId,
                deploy_mode: None,
            },
        })
        .collect()
}
pub fn is_gate_enabled(gate: Option<&Value>, id: &str) -> bool {
    gate.and_then(|value| value.get(id))
        .and_then(|slot| slot.get("enabled"))
        != Some(&Value::Bool(false))
}
pub struct EagerRunOptions {
    pub data_dir: String,
    pub pilot_dir: String,
    pub builtin_agents_dir: Option<String>,
    pub gate: Option<Value>,
}
#[derive(Debug)]
pub struct EagerRunResult {
    pub exit_code: i32,
    pub injected: Vec<String>,
    pub warnings: Vec<String>,
    pub plan: Vec<EagerPlanEntry>,
}
pub async fn run_eager_injection(
    options: EagerRunOptions,
    requested_ids: &[String],
) -> EagerRunResult {
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: options.data_dir,
        pilot_dir: options.pilot_dir,
        builtin_agents_dir: options.builtin_agents_dir,
        installed_by: None,
    });
    let definitions = manager.load_definitions().await;
    let by_id: HashMap<_, _> = definitions
        .iter()
        .map(|def| (def.id.as_str(), def))
        .collect();
    let plan = plan_eager_deploys(&definitions, requested_ids);
    let mut warnings = Vec::new();
    let mut injected = Vec::new();
    let mut failed = false;
    let sweep = requested_ids.is_empty();
    for item in &plan {
        match item.action {
            EagerAction::UnknownId => {
                warnings.push(format!("no agent definition has id \"{}\" — skipping it; the daemon will still deploy every agent it detects, so collection is unaffected",item.agent_id));
                continue;
            }
            EagerAction::Deferred => {
                warnings.push(format!("{} uses deployMode={}, which is not deployed eagerly — leaving it to the daemon",item.agent_id,item.deploy_mode.as_deref().unwrap_or("")));
                continue;
            }
            EagerAction::Deploy => {}
        }
        if !is_gate_enabled(options.gate.as_ref(), &item.agent_id) {
            if !sweep {
                warnings.push(format!(
                    "{} is disabled via config.agents — skipping eager injection",
                    item.agent_id
                ));
            }
            continue;
        }
        let definition = by_id[item.agent_id.as_str()];
        let active = match manager.recorded_definition(definition) {
            Ok(active) => active,
            Err(error) => {
                failed = true;
                warnings.push(format!("failed to inject {}: {error}", item.agent_id));
                continue;
            }
        };
        let result = manager.deploy_single(&active).await;
        if !result.success {
            failed = true;
            warnings.push(format!(
                "failed to inject {}: {}",
                item.agent_id,
                result.error.as_deref().unwrap_or("unknown error")
            ));
        } else if result.skipped == Some(true) {
            if !sweep && result.reason == Some(DeploySkipReason::NotDetected) {
                warnings.push(format!(
                    "{} not detected in this container — skipping",
                    item.agent_id
                ));
            }
        } else {
            injected.push(item.agent_id.clone());
        }
    }
    if !injected.is_empty() {
        warnings.push(format!(
            "injected {} agent(s) before startup: {}",
            injected.len(),
            injected.join(", ")
        ));
    }
    EagerRunResult {
        exit_code: i32::from(failed),
        injected,
        warnings,
        plan,
    }
}
pub async fn run_cli(argv: &[String]) -> i32 {
    crate::utils::redirect_root_logger_to_stderr();
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        println!("Usage: loongsuite-pilot inject-hooks [--agents=IDS] [--data-dir=PATH] [--pilot-dir=PATH]\nSynchronously deploys only hook/plugin-inject before startup; unknown options are tolerated.");
        return 0;
    }
    let parsed = parse_inject_args(argv);
    for flag in &parsed.unknown_flags {
        // Flags can carry credentials. Keep the diagnostic, never echo a value.
        eprintln!(
            "[pilot-inject] ignoring unrecognized option {}",
            flag.split('=').next().unwrap_or(flag)
        );
    }
    let data_dir = crate::utils::resolve_data_dir(parsed.data_dir.as_deref());
    let pilot_dir = match crate::utils::runtime_paths::resolve_resource_root(
        &data_dir,
        parsed
            .pilot_dir
            .as_deref()
            .filter(|value| !value.is_empty()),
        &[],
    ) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            eprintln!("[pilot-inject] aborted: {error:#}");
            return 1;
        }
    };
    let result = run_eager_injection(
        EagerRunOptions {
            data_dir,
            pilot_dir,
            builtin_agents_dir: None,
            gate: crate::utils::read_config_agents_gate(),
        },
        &parsed.agents,
    )
    .await;
    for warning in result.warnings {
        eprintln!("[pilot-inject] {warning}");
    }
    result.exit_code
}
#[cfg(test)]
#[path = "eager_injection_history_contract_tests.rs"]
mod history_contract_tests;
