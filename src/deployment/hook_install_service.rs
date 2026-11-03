//! `loongsuite-pilot hook install` selection, home rewrite, and result file.

use crate::types::{AgentDefinition, DeployResult};
use crate::updater::ActivationTransaction;
use crate::utils::read_json_document;
use crate::utils::runtime_paths::runtime_metadata;
use crate::utils::JsonDocumentRead;
use crate::utils::{read_container_identity, resolve_home, ContainerIdentity, JsonSyntax};
use anyhow::{ensure, Context};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::deployed_state_merge::with_deployed_state_lock;
use super::deployment_manager::{DeploymentManager, DeploymentManagerOptions};
use super::paths::{is_absolute, node_resolve};

pub const HOOK_INSTALL_RESULT_FILE: &str = "last-hook-install.json";
pub const HOOK_INSTALL_SIGNAL_FILE: &str = "hook-install.signal";

pub const HOOK_INSTALL_REASONS: &[&str] = &[
    "not-detected",
    "uid-mismatch",
    "invalid-settings",
    "invalid-deployment-state",
    "overwritten",
    "disabled",
    "unknown-id",
    "settings-dir-missing",
    "deploy-failed",
    "lock-timeout",
    "activation-pending",
    "activation-failed",
    "runtime-unprepared",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInstallAgentResult {
    pub id: String,
    pub status: String,
    pub reason: Option<String>,
    pub hint: Option<String>,
    pub settings_path: Option<String>,
    pub deploy_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInstallReport {
    pub schema: u8,
    pub identity: String,
    pub ts: String,
    pub scope: String,
    pub agents: Vec<HookInstallAgentResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alarm_sent: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSelection {
    Skip,
    Detect {
        warn_literal_null: bool,
    },
    Named {
        ids: Vec<String>,
        warn_literal_null: bool,
    },
}

pub fn select_agents(flag: Option<&str>, env_value: Option<&str>) -> AgentSelection {
    let chosen = flag.or(env_value);
    let warn_literal_null = chosen.unwrap_or("").trim() == "null";
    let normalized = chosen.unwrap_or("").trim();
    if chosen.is_none() || normalized.is_empty() || normalized == "null" {
        return AgentSelection::Detect { warn_literal_null };
    }
    if normalized == "none" {
        return AgentSelection::Skip;
    }
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for id in normalized.split(',') {
        let id = id.trim();
        if !id.is_empty() && seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    }
    if ids.is_empty() {
        AgentSelection::Detect { warn_literal_null }
    } else {
        AgentSelection::Named {
            ids,
            warn_literal_null: false,
        }
    }
}

pub fn hint_for_reason(reason: &str, agent_id: Option<&str>) -> String {
    let id = agent_id.unwrap_or("");
    match reason {
        "not-detected" => format!("Agent {id} was not detected. Set its home variable or install its command on PATH.").replace("  ", " "),
        "uid-mismatch" => "Run hook install as the agent user. The home directory belongs to a different uid.".into(),
        "invalid-settings" => "The settings file is not valid JSON. Fix the reported file and line, then run hook install again.".into(),
        "invalid-deployment-state" => "部署状态损坏或路径布局无效。请修复 deployed-agents.json 后重试；原配置与资源已保留。".into(),
        "overwritten" => "Settings changed after injection. Run hook install after rendering config, before the agent reads it.".into(),
        "disabled" => format!("Agent {id} is disabled in config.agents.").trim().to_string(),
        "unknown-id" => format!("Unknown agent id {id}. Use an id from agents.d.").replace("  ", " "),
        "settings-dir-missing" => "The settings directory is missing and could not be created. Check the home path and permissions.".into(),
        "deploy-failed" => "Deployment failed. Check the error and run hook install again.".into(),
        "lock-timeout" => "Timed out waiting for the deployment state lock. Retry hook install.".into(),
        "activation-pending" => "Plugin activation is still pending. Retry hook install after the agent finishes starting.".into(),
        "activation-failed" => "Plugin activation failed. Check the agent log and retry hook install.".into(),
        "runtime-unprepared" => "The Pilot data directory could not be prepared. Check --pilot-dir and directory permissions.".into(),
        other => other.to_string(),
    }
}

pub fn relative_to_detection_home(
    declared_path: &str,
    detection_paths: &[String],
) -> Option<String> {
    let declared = node_resolve(&resolve_home(declared_path));
    for detection_path in detection_paths {
        if detection_path.trim().is_empty() {
            continue;
        }
        let root = node_resolve(&resolve_home(detection_path));
        let rel = super::paths::relative(&root, &declared);
        if rel.is_empty()
            || is_absolute(&rel)
            || Path::new(&rel)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            continue;
        }
        return Some(rel);
    }
    None
}

pub fn definition_at_install_home(def: &AgentDefinition, home: &str) -> Option<AgentDefinition> {
    let root = node_resolve(&resolve_home(home));
    let relocate = |path: &str| {
        relative_to_detection_home(path, &def.detection.paths)
            .map(|rel| Path::new(&root).join(rel).to_string_lossy().into_owned())
    };
    if let Some(hook) = &def.hook {
        let mut hook = hook.clone();
        hook.settings_path = relocate(&hook.settings_path)?;
        if let Some(trust) = &mut hook.trust_toml {
            // 关联配置无法迁移时整体拒绝，不能把 trust 留在其他 Agent home。
            trust.config_path = relocate(&trust.config_path)?;
        }
        let mut next = def.clone();
        next.detection.paths.insert(0, root.clone());
        next.hook = Some(hook);
        return Some(next);
    }
    if let Some(inject) = def
        .plugin_inject
        .as_ref()
        .filter(|inject| !inject.config_paths.is_empty())
    {
        let mut rewritten = Vec::new();
        for config_path in &inject.config_paths {
            rewritten.push(
                Path::new(&root)
                    .join(relative_to_detection_home(
                        config_path,
                        &def.detection.paths,
                    )?)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        let mut next = def.clone();
        next.detection.paths.insert(0, root);
        next.plugin_inject.as_mut().unwrap().config_paths = rewritten;
        return Some(next);
    }
    None
}

pub fn hook_install_result_path(data_dir: &str) -> String {
    Path::new(data_dir)
        .join(HOOK_INSTALL_RESULT_FILE)
        .to_string_lossy()
        .into_owned()
}

pub fn hook_install_signal_path(data_dir: &str) -> String {
    Path::new(data_dir)
        .join(HOOK_INSTALL_SIGNAL_FILE)
        .to_string_lossy()
        .into_owned()
}

pub fn merge_installed_agents(
    existing: Option<&[HookInstallAgentResult]>,
    current: &[HookInstallAgentResult],
) -> Vec<HookInstallAgentResult> {
    let current_by_id: HashMap<_, _> = current
        .iter()
        .map(|agent| (agent.id.clone(), agent.clone()))
        .collect();
    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    for previous in existing.unwrap_or(&[]) {
        if previous.status != "ok" && previous.status != "up-to-date" {
            continue;
        }
        seen.insert(previous.id.clone());
        match current_by_id.get(&previous.id) {
            Some(now) if now.status == "ok" || now.status == "up-to-date" => {
                merged.push(now.clone())
            }
            Some(now) if now.status == "failed" => {
                merged.push(previous.clone());
                merged.push(now.clone());
            }
            _ => merged.push(previous.clone()),
        }
    }
    for now in current {
        if !seen.contains(&now.id) {
            merged.push(now.clone());
        }
    }
    merged
}

pub fn exit_code_for(agents: &[HookInstallAgentResult]) -> i32 {
    if agents
        .iter()
        .all(|agent| matches!(agent.status.as_str(), "ok" | "up-to-date" | "skipped"))
    {
        0
    } else {
        1
    }
}

pub fn to_public_report(report: &HookInstallReport) -> HookInstallReport {
    HookInstallReport {
        alarm_sent: None,
        ..report.clone()
    }
}

pub fn classify_deploy_error(error: &str) -> &'static str {
    if error.contains("lock-timeout") {
        "lock-timeout"
    } else if error.contains("ENOENT") || error.contains("settings directory") {
        "settings-dir-missing"
    } else if regex::Regex::new(r"(?i)\bactivation\b")
        .unwrap()
        .is_match(error)
        && regex::Regex::new(r"(?i)\bpending\b")
            .unwrap()
            .is_match(error)
    {
        "activation-pending"
    } else if regex::Regex::new(r"(?i)\bactivation\b")
        .unwrap()
        .is_match(error)
        && regex::Regex::new(r"(?i)\bfail").unwrap().is_match(error)
    {
        "activation-failed"
    } else if error.contains("SyntaxError")
        || regex::Regex::new(r"(?i)\binvalid JSONC?\b")
            .unwrap()
            .is_match(error)
        || error.contains("invalid settings")
    {
        "invalid-settings"
    } else {
        "deploy-failed"
    }
}

pub struct HookInstallRunOptions<'a> {
    pub data_dir: String,
    pub pilot_dir: String,
    pub builtin_agents_dir: Option<String>,
    pub agents_flag: Option<String>,
    pub env_agents: Option<String>,
    pub homes: HashMap<String, String>,
    pub write_result: bool,
    pub deploy_modes: Option<HashSet<String>>,
    pub enabled: Option<&'a dyn Fn(&str) -> bool>,
    pub euid: Option<u32>,
    pub identity: Option<ContainerIdentity>,
    pub mode: &'a str,
}

pub struct HookInstallRunResult {
    pub exit_code: i32,
    pub report: HookInstallReport,
    pub warnings: Vec<String>,
    pub wrote_result: bool,
}

fn failed(
    id: &str,
    reason: &str,
    deploy_mode: Option<&str>,
    settings_path: Option<String>,
) -> HookInstallAgentResult {
    HookInstallAgentResult {
        id: id.into(),
        status: "failed".into(),
        reason: Some(reason.into()),
        hint: Some(hint_for_reason(reason, Some(id))),
        settings_path,
        deploy_mode: deploy_mode.map(|value| value.to_string()),
    }
}

fn from_deploy(
    def: &AgentDefinition,
    result: &DeployResult,
    settings_path: Option<String>,
) -> HookInstallAgentResult {
    if result.success
        && result.skipped == Some(true)
        && result.reason == Some(crate::types::DeploySkipReason::UpToDate)
    {
        return HookInstallAgentResult {
            id: def.id.clone(),
            status: "up-to-date".into(),
            reason: None,
            hint: None,
            settings_path,
            deploy_mode: Some(def.deploy_mode.as_str().into()),
        };
    }
    if result.success
        && result.skipped == Some(true)
        && result.reason == Some(crate::types::DeploySkipReason::NotDetected)
    {
        return failed(
            &def.id,
            "not-detected",
            Some(def.deploy_mode.as_str()),
            settings_path,
        );
    }
    if result.success
        && result.skipped == Some(true)
        && result.reason == Some(crate::types::DeploySkipReason::Disabled)
    {
        return failed(
            &def.id,
            "disabled",
            Some(def.deploy_mode.as_str()),
            settings_path,
        );
    }
    if result.success && result.skipped != Some(true) {
        return HookInstallAgentResult {
            id: def.id.clone(),
            status: "ok".into(),
            reason: None,
            hint: None,
            settings_path,
            deploy_mode: Some(def.deploy_mode.as_str().into()),
        };
    }
    failed(
        &def.id,
        classify_deploy_error(result.error.as_deref().unwrap_or("")),
        Some(def.deploy_mode.as_str()),
        settings_path,
    )
}

fn report_targets(file: &str) -> anyhow::Result<(PathBuf, BTreeMap<String, PathBuf>)> {
    let file = Path::new(file);
    ensure!(file.is_absolute(), "Hook 报告路径必须为绝对路径");
    let data = file.parent().context("Hook 报告缺少父目录")?;
    ensure!(runtime_metadata(data)?.is_dir(), "Hook 报告目录类型无效");
    Ok((
        data.join(".hook-report"),
        BTreeMap::from([
            ("report".into(), file.into()),
            ("signal".into(), data.join(HOOK_INSTALL_SIGNAL_FILE)),
        ]),
    ))
}

fn report_pending(directory: &Path) -> bool {
    match std::fs::symlink_metadata(directory) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return false,
        Ok(_) if runtime_metadata(directory).is_ok_and(|meta| meta.is_dir()) => {}
        _ => return true,
    }
    !matches!(std::fs::symlink_metadata(directory.join("update-recovery.json")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound)
}

fn parse_report(bytes: &[u8]) -> anyhow::Result<HookInstallReport> {
    let raw = std::str::from_utf8(bytes).context("Hook 报告编码无效，原文件保留")?;
    let report: HookInstallReport = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|_| anyhow::anyhow!("Hook 报告 JSON 或 schema 无效，原文件保留"))?;
    ensure!(report.schema == 1, "Hook 报告 schema 不受支持，原文件保留");
    ensure!(
        matches!(report.scope.as_str(), "named" | "detected")
            && !report.identity.trim().is_empty()
            && chrono::DateTime::parse_from_rfc3339(&report.ts).is_ok()
            && report.agents.iter().all(|agent| {
                !agent.id.trim().is_empty()
                    && matches!(
                        agent.status.as_str(),
                        "ok" | "up-to-date" | "failed" | "skipped"
                    )
            }),
        "Hook 报告字段无效，原文件保留"
    );
    Ok(report)
}

fn read_report(file: &str) -> anyhow::Result<Option<(HookInstallReport, String)>> {
    match std::fs::symlink_metadata(file) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
        Ok(_) => {}
    }
    let meta = runtime_metadata(Path::new(file))?;
    ensure!(
        meta.is_file() && meta.len() <= 4 * 1024 * 1024,
        "Hook 报告类型或大小无效"
    );
    let mut bytes = Vec::new();
    std::fs::File::open(file)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4 * 1024 * 1024, "Hook 报告读取超限");
    let report = parse_report(&bytes)?;
    Ok(Some((report, String::from_utf8(bytes)?)))
}

/// 消费者与报告写入者共享锁，待恢复事务不能被当作已提交结果。
pub async fn read_committed_hook_install_report(
    file: &str,
) -> Result<Option<HookInstallReport>, String> {
    if !Path::new(file).is_absolute() {
        return Err("Hook 报告路径必须为绝对路径".into());
    }
    let parent = Path::new(file).parent().ok_or("Hook 报告缺少父目录")?;
    if matches!(std::fs::symlink_metadata(parent), Err(err) if err.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(None);
    }
    let (directory, _) = report_targets(file).map_err(|err| err.to_string())?;
    with_deployed_state_lock(
        &format!("{file}.lock"),
        || async {
            ensure!(
                !report_pending(&directory),
                "Hook 报告事务待恢复，保留现有部署范围"
            );
            Ok(read_report(file)?.map(|(report, _)| report))
        },
        10_000,
    )
    .await
    .map_err(|err| err.to_string())
}

async fn persist_hook_install_report(
    file: &str,
    current: &HookInstallReport,
) -> anyhow::Result<HookInstallReport> {
    let (directory, targets) = report_targets(file)?;
    with_deployed_state_lock(
        &format!("{file}.lock"),
        || async {
            super::hook_assets::private_directory(&directory)?;
            let mut transaction = ActivationTransaction::begin(&directory, targets)?;
            let result: anyhow::Result<HookInstallReport> = (|| {
                let latest = transaction
                    .original_bytes("report")?
                    .map(|raw| parse_report(&raw))
                    .transpose()?;
                let same = latest.as_ref().is_some_and(|latest| {
                    latest.scope == "named" && latest.identity == current.identity
                });
                let agents = if same {
                    merge_installed_agents(
                        latest.as_ref().map(|report| report.agents.as_slice()),
                        &current.agents,
                    )
                } else {
                    current.agents.clone()
                };
                let installed = agents
                    .iter()
                    .any(|agent| matches!(agent.status.as_str(), "ok" | "up-to-date"));
                let next = HookInstallReport {
                    scope: if installed && (current.scope == "named" || same) {
                        "named"
                    } else {
                        "detected"
                    }
                    .into(),
                    agents,
                    ..current.clone()
                };
                transaction.write_preserving_mode(
                    "report",
                    &serde_json::to_vec_pretty(&next)?,
                    0o600,
                )?;
                let signal = format!(
                    "{}\n",
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
                );
                transaction.write_preserving_mode("signal", signal.as_bytes(), 0o600)?;
                transaction.commit()?;
                Ok(next)
            })();
            match result {
                Ok(next) => Ok(next),
                Err(err) => match transaction.rollback() {
                    Ok(()) => Err(err),
                    Err(rollback) => {
                        Err(err.context(format!("Hook 报告与信号恢复失败：{rollback:#}")))
                    }
                },
            }
        },
        10_000,
    )
    .await
}

pub async fn mark_hook_install_alarm_sent(
    file: &str,
    expected_ts: &str,
) -> Result<&'static str, String> {
    let file = file.to_string();
    let expected_ts = expected_ts.to_string();
    let (directory, targets) = report_targets(&file).map_err(|err| err.to_string())?;
    with_deployed_state_lock(
        &format!("{file}.lock"),
        || async {
            ensure!(
                !report_pending(&directory),
                "Hook 报告事务待恢复，拒绝改写告警标记"
            );
            let Some((mut current, raw)) = read_report(&file)? else {
                return Ok("stale");
            };
            if current.ts != expected_ts {
                return Ok("stale");
            }
            if current.alarm_sent == Some(true) {
                return Ok("already");
            }
            current.alarm_sent = Some(true);
            super::hook_assets::private_directory(&directory)?;
            let mut transaction = ActivationTransaction::begin(&directory, targets)?;
            // 持锁后的发布与提交不跨 await，取消不能使后台 rename 越过锁的生命周期。
            let result = (|| -> anyhow::Result<_> {
                ensure!(
                    transaction.original_bytes("report")?.as_deref() == Some(raw.as_bytes()),
                    "Hook 报告被外部修改，拒绝覆盖告警标记"
                );
                transaction.write_preserving_mode(
                    "report",
                    &serde_json::to_vec_pretty(&current)?,
                    0o600,
                )?;
                transaction.commit()?;
                Ok("marked")
            })();
            match result {
                Ok(marked) => Ok(marked),
                Err(err) => match transaction.rollback() {
                    Ok(()) => Err(err),
                    Err(rollback) => {
                        Err(err.context(format!("Hook 告警标记恢复失败：{rollback:#}")))
                    }
                },
            }
        },
        10_000,
    )
    .await
    .map_err(|err| err.to_string())
}

pub async fn run_hook_install(opts: HookInstallRunOptions<'_>) -> HookInstallRunResult {
    let selection = select_agents(opts.agents_flag.as_deref(), opts.env_agents.as_deref());
    let mut warnings = Vec::new();
    if !matches!(selection, AgentSelection::Skip) {
        let warn = match &selection {
            AgentSelection::Detect { warn_literal_null }
            | AgentSelection::Named {
                warn_literal_null, ..
            } => *warn_literal_null,
            AgentSelection::Skip => false,
        };
        if warn {
            warnings.push("LOONGSUITE_PILOT_AGENTS or --agents is the literal \"null\"; detecting all agents.".into());
        }
    }
    let identity = opts.identity.unwrap_or_else(read_container_identity);
    let ts = super::paths::iso_now();
    if matches!(selection, AgentSelection::Skip) {
        return HookInstallRunResult {
            exit_code: 0,
            report: HookInstallReport {
                schema: 1,
                identity: identity.identity,
                ts,
                scope: "detected".into(),
                agents: vec![],
                alarm_sent: None,
            },
            warnings,
            wrote_result: false,
        };
    }
    if opts.mode != "status" && tokio::fs::create_dir_all(&opts.data_dir).await.is_err() {
        return HookInstallRunResult {
            exit_code: 1,
            report: HookInstallReport {
                schema: 1,
                identity: identity.identity,
                ts,
                scope: "detected".into(),
                agents: vec![failed("*", "runtime-unprepared", None, None)],
                alarm_sent: None,
            },
            warnings,
            wrote_result: false,
        };
    }
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: opts.data_dir.clone(),
        pilot_dir: opts.pilot_dir.clone(),
        builtin_agents_dir: opts.builtin_agents_dir.clone(),
        installed_by: if opts.mode == "status" {
            None
        } else {
            Some(crate::types::InstalledBy::HookInstall)
        },
    });
    let defs = manager.load_definitions().await;
    let by_id: HashMap<_, _> = defs
        .iter()
        .map(|def| (def.id.clone(), def.clone()))
        .collect();
    let enabled = opts.enabled;
    let euid = opts.euid.unwrap_or_else(|| {
        #[cfg(unix)]
        {
            // geteuid 无参数、无指针；直接读取调用进程身份，不依赖外部命令。
            unsafe { libc::geteuid() }
        }
        #[cfg(not(unix))]
        {
            0
        }
    });
    let status_only = opts.mode == "status";
    let mut selected = Vec::new();
    let mut agents = Vec::new();
    match &selection {
        AgentSelection::Named { ids, .. } => {
            for id in ids {
                let Some(def) = by_id.get(id) else {
                    agents.push(failed(id, "unknown-id", None, None));
                    continue;
                };
                if opts
                    .deploy_modes
                    .as_ref()
                    .is_some_and(|modes| !modes.contains(def.deploy_mode.as_str()))
                {
                    continue;
                }
                selected.push(def.clone());
            }
        }
        _ => {
            for def in &defs {
                if opts
                    .deploy_modes
                    .as_ref()
                    .is_some_and(|modes| !modes.contains(def.deploy_mode.as_str()))
                {
                    continue;
                }
                selected.push(def.clone());
            }
        }
    }
    let state_error = manager.validate_state().await.err();
    if let Some(err) = &state_error {
        warnings.push(err.clone());
        if selected.is_empty() {
            agents.push(failed("*", "invalid-deployment-state", None, None));
        }
    }
    let mut runtime_prepared = false;
    for def in &selected {
        if state_error.is_some() {
            agents.push(failed(
                &def.id,
                "invalid-deployment-state",
                Some(def.deploy_mode.as_str()),
                None,
            ));
            continue;
        }
        if enabled.is_some_and(|enabled| !enabled(&def.id)) {
            if matches!(selection, AgentSelection::Named { .. }) {
                agents.push(failed(
                    &def.id,
                    "disabled",
                    Some(def.deploy_mode.as_str()),
                    None,
                ));
            }
            continue;
        }
        let home = opts.homes.get(&def.id).cloned();
        let targeted = if let Some(home) = &home {
            definition_at_install_home(def, home)
        } else {
            match manager.recorded_definition(def) {
                Ok(targeted) => Some(targeted),
                Err(err) => {
                    warnings.push(err);
                    agents.push(failed(
                        &def.id,
                        "invalid-deployment-state",
                        Some(def.deploy_mode.as_str()),
                        None,
                    ));
                    continue;
                }
            }
        };
        if home.is_some() && targeted.is_none() {
            let mut unsupported = failed(
                &def.id,
                "deploy-failed",
                Some(def.deploy_mode.as_str()),
                None,
            );
            unsupported.hint = Some(format!("--home cannot be applied to {}. The definition has no settings path under its detection home.", def.id));
            agents.push(unsupported);
            continue;
        }
        let active = targeted.unwrap_or_else(|| def.clone());
        let plugin_path = match manager.plugin_config_path(&active).await {
            Ok(path) => path,
            Err(err) => {
                let mut result = failed(
                    &def.id,
                    "invalid-settings",
                    Some(active.deploy_mode.as_str()),
                    None,
                );
                result.hint = Some(err);
                agents.push(result);
                continue;
            }
        };
        let settings_path = active
            .hook
            .as_ref()
            .map(|hook| hook.settings_path.clone())
            .or(plugin_path)
            .or_else(|| {
                active
                    .plugin_inject
                    .as_ref()
                    .and_then(|inject| inject.config_paths.first().cloned())
            });
        if let Some(home) = &home {
            if euid == 0 {
                if let Ok(meta) = tokio::fs::metadata(home).await {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::MetadataExt;
                        #[cfg(test)]
                        let owner = history_contract_tests::owner_for_history(meta.uid());
                        #[cfg(not(test))]
                        let owner = meta.uid();
                        if owner != 0 {
                            agents.push(failed(
                                &def.id,
                                "uid-mismatch",
                                Some(active.deploy_mode.as_str()),
                                settings_path.clone(),
                            ));
                            continue;
                        }
                    }
                    let _ = meta;
                }
            }
        }
        if let Some(file) = &settings_path {
            let syntax = active
                .hook
                .as_ref()
                .and_then(|hook| hook.settings_syntax)
                .map(|syntax| match syntax {
                    crate::types::SettingsSyntax::Jsonc => JsonSyntax::Jsonc,
                    crate::types::SettingsSyntax::Json => JsonSyntax::Json,
                })
                .unwrap_or_else(|| {
                    // 插件策略读取 JSONC；扩展名为 .json 的 OpenClaw 配置也允许注释。
                    if active.plugin_inject.is_some() || file.ends_with(".jsonc") {
                        JsonSyntax::Jsonc
                    } else {
                        JsonSyntax::Json
                    }
                });
            if let JsonDocumentRead::Error { error } = read_json_document(file, syntax).await {
                let mut result = failed(
                    &def.id,
                    "invalid-settings",
                    Some(active.deploy_mode.as_str()),
                    Some(file.clone()),
                );
                result.hint = Some(format!(
                    "{} {file}: {}",
                    hint_for_reason("invalid-settings", Some(&def.id)),
                    error.message
                ));
                agents.push(result);
                continue;
            }
        }
        if status_only {
            let detected = if home.is_some() {
                true
            } else {
                manager.is_agent_detected(&active).await
            };
            if !detected {
                if matches!(selection, AgentSelection::Named { .. }) {
                    agents.push(failed(
                        &def.id,
                        "not-detected",
                        Some(active.deploy_mode.as_str()),
                        settings_path,
                    ));
                }
                continue;
            }
            let needs = manager
                .needs_redeploy(
                    &active,
                    if home.is_some() {
                        settings_path.as_deref()
                    } else {
                        None
                    },
                )
                .await;
            if !needs {
                agents.push(HookInstallAgentResult {
                    id: def.id.clone(),
                    status: "ok".into(),
                    reason: None,
                    hint: None,
                    settings_path,
                    deploy_mode: Some(active.deploy_mode.as_str().into()),
                });
                continue;
            }
            let known = if def.id == "grok-build" {
                settings_path.as_ref().is_some_and(|path| {
                    manager
                        .recorded_settings_paths(&def.id)
                        .iter()
                        .any(|item| item == &node_resolve(path))
                })
            } else {
                manager.has_record(&def.id)
            };
            agents.push(failed(
                &def.id,
                if known { "overwritten" } else { "not-detected" },
                Some(active.deploy_mode.as_str()),
                settings_path,
            ));
            continue;
        }
        // Prepare only after a concrete target passes the same read-only
        // gates as deployment. Failed/unsupported targets must not publish
        // unrelated global runtime resources.
        if home.is_none() && !manager.is_agent_detected(&active).await {
            if matches!(selection, AgentSelection::Named { .. }) {
                agents.push(failed(
                    &def.id,
                    "not-detected",
                    Some(active.deploy_mode.as_str()),
                    settings_path,
                ));
            }
            continue;
        }
        let host_probe = super::plugin_inject_strategy::PluginInjectStrategy::new(
            opts.data_dir.clone(),
            opts.pilot_dir.clone(),
        );
        if let Err(error) = host_probe.preflight_eager_host(&active).await {
            let mut failure = failed(
                &def.id,
                classify_deploy_error(&error),
                Some(active.deploy_mode.as_str()),
                settings_path,
            );
            failure.hint = Some(error);
            agents.push(failure);
            continue;
        }
        if !runtime_prepared {
            if let Err(error) = super::runtime_data_assets::prepare_eager(
                Path::new(&opts.pilot_dir),
                Path::new(&opts.data_dir),
            )
            .await
            {
                warnings.push(format!("运行资源准备失败；已有资源和配置保留：{error:#}"));
                agents.push(failed(
                    &def.id,
                    "runtime-unprepared",
                    Some(active.deploy_mode.as_str()),
                    settings_path,
                ));
                return HookInstallRunResult {
                    exit_code: 1,
                    report: HookInstallReport {
                        schema: 1,
                        identity: identity.identity,
                        ts,
                        scope: "detected".into(),
                        agents,
                        alarm_sent: None,
                    },
                    warnings,
                    wrote_result: false,
                };
            }
            runtime_prepared = true;
        }
        let result = if home.is_some() {
            manager.deploy_prepared(&active, true).await
        } else {
            manager.deploy_single(&active).await
        };
        if matches!(selection, AgentSelection::Detect { .. })
            && result.skipped == Some(true)
            && result.reason == Some(crate::types::DeploySkipReason::NotDetected)
        {
            continue;
        }
        agents.push(from_deploy(def, &result, settings_path));
    }
    let has_failure = agents.iter().any(|agent| agent.status == "failed");
    let alarm_sent = !has_failure;
    let mut scope = if matches!(selection, AgentSelection::Named { .. })
        && agents
            .iter()
            .any(|agent| agent.status == "ok" || agent.status == "up-to-date")
    {
        "named".to_string()
    } else {
        "detected".to_string()
    };
    let mut wrote_result = false;
    let mut persistence_failed = false;
    if opts.write_result && !status_only {
        let file = hook_install_result_path(&opts.data_dir);
        let next = HookInstallReport {
            schema: 1,
            identity: identity.identity.clone(),
            ts: ts.clone(),
            scope: scope.clone(),
            agents: agents.clone(),
            alarm_sent: Some(alarm_sent),
        };
        match persist_hook_install_report(&file, &next).await {
            Ok(persisted) => {
                scope = persisted.scope;
                wrote_result = true;
            }
            Err(err) => {
                persistence_failed = true;
                warnings.push(format!(
                    "Hook 报告或信号保存失败：{err:#}。已提交的 Agent 配置保留，请修复后重试。"
                ));
                for agent in &mut agents {
                    if matches!(agent.status.as_str(), "ok" | "up-to-date") {
                        agent.status = "failed".into();
                        agent.reason = Some("runtime-unprepared".into());
                        agent.hint = Some("Agent 配置已提交，但安装报告或刷新信号未能保存；请修复数据目录后重试。".into());
                    }
                }
                if agents.is_empty() {
                    agents.push(failed("*", "runtime-unprepared", None, None));
                }
            }
        }
    }
    HookInstallRunResult {
        exit_code: if persistence_failed {
            1
        } else {
            exit_code_for(&agents)
        },
        report: HookInstallReport {
            schema: 1,
            identity: identity.identity,
            ts,
            scope,
            agents,
            alarm_sent: None,
        },
        warnings,
        wrote_result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report_fixture(id: &str) -> HookInstallReport {
        HookInstallReport {
            schema: 1,
            identity: "isolated-report-fixture".into(),
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
            scope: "named".into(),
            agents: vec![HookInstallAgentResult {
                id: id.into(),
                status: "ok".into(),
                reason: None,
                hint: None,
                settings_path: None,
                deploy_mode: Some("hook".into()),
            }],
            alarm_sent: Some(false),
        }
    }

    #[tokio::test]
    async fn reports_and_signals_commit_together_and_preserve_previous_on_failure() {
        let root = tempfile::tempdir().unwrap();
        let file = hook_install_result_path(root.path().to_str().unwrap());
        let signal = hook_install_signal_path(root.path().to_str().unwrap());
        persist_hook_install_report(&file, &report_fixture("first"))
            .await
            .unwrap();
        let original = std::fs::read(&file).unwrap();
        let old_signal = std::fs::read(&signal).unwrap();
        for path in [&file, &signal] {
            let writable = std::fs::metadata(path).unwrap().permissions();
            let mut readonly = writable.clone();
            readonly.set_readonly(true);
            std::fs::set_permissions(path, readonly).unwrap();
            let failed = persist_hook_install_report(&file, &report_fixture("second")).await;
            std::fs::set_permissions(path, writable).unwrap();
            assert!(failed.is_err(), "{path}");
            assert_eq!(std::fs::read(&file).unwrap(), original);
            assert_eq!(std::fs::read(&signal).unwrap(), old_signal);
            assert!(!report_pending(&root.path().join(".hook-report")));
        }
        let next = persist_hook_install_report(&file, &report_fixture("second"))
            .await
            .unwrap();
        assert_eq!(
            next.agents
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_ne!(std::fs::read(&signal).unwrap(), old_signal);
        assert_eq!(
            read_committed_hook_install_report(&file)
                .await
                .unwrap()
                .unwrap(),
            next
        );
        assert_eq!(
            mark_hook_install_alarm_sent(&file, "stale").await.unwrap(),
            "stale"
        );
        let signal_before_mark = std::fs::read(&signal).unwrap();
        assert_eq!(
            mark_hook_install_alarm_sent(&file, &next.ts).await.unwrap(),
            "marked"
        );
        assert_eq!(
            mark_hook_install_alarm_sent(&file, &next.ts).await.unwrap(),
            "already"
        );
        assert_eq!(std::fs::read(&signal).unwrap(), signal_before_mark);
    }

    #[tokio::test]
    async fn report_recovery_blocks_consumers_and_alarm_marks_until_install_retries() {
        let root = tempfile::tempdir().unwrap();
        let file = hook_install_result_path(root.path().to_str().unwrap());
        let first = report_fixture("first");
        persist_hook_install_report(&file, &first).await.unwrap();
        let (directory, targets) = report_targets(&file).unwrap();
        let mut transaction = ActivationTransaction::begin(&directory, targets).unwrap();
        transaction
            .write_preserving_mode(
                "report",
                &serde_json::to_vec(&report_fixture("uncommitted")).unwrap(),
                0o600,
            )
            .unwrap();
        std::mem::forget(transaction);
        let pending = std::fs::read(&file).unwrap();
        assert!(read_committed_hook_install_report(&file).await.is_err());
        assert!(
            mark_hook_install_alarm_sent(&file, &report_fixture("uncommitted").ts)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&file).unwrap(), pending);
        let next = persist_hook_install_report(&file, &report_fixture("second"))
            .await
            .unwrap();
        assert_eq!(
            next.agents
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert!(!report_pending(&directory));
    }

    #[tokio::test]
    async fn concurrent_reports_merge_and_corrupt_reports_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let file = hook_install_result_path(root.path().to_str().unwrap());
        let first = report_fixture("first");
        let second = report_fixture("second");
        let (a, b) = tokio::join!(
            persist_hook_install_report(&file, &first),
            persist_hook_install_report(&file, &second)
        );
        a.unwrap();
        b.unwrap();
        let mut ids: Vec<_> = read_committed_hook_install_report(&file)
            .await
            .unwrap()
            .unwrap()
            .agents
            .into_iter()
            .map(|agent| agent.id)
            .collect();
        ids.sort();
        assert_eq!(ids, ["first", "second"]);
        let signal = hook_install_signal_path(root.path().to_str().unwrap());
        let signal_before = std::fs::read(&signal).unwrap();
        for invalid in ["broken [", "[]", "{\"schema\":9}"] {
            std::fs::write(&file, invalid).unwrap();
            assert!(persist_hook_install_report(&file, &first).await.is_err());
            assert!(read_committed_hook_install_report(&file).await.is_err());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), invalid);
            assert_eq!(std::fs::read(&signal).unwrap(), signal_before);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_and_signal_links_never_modify_external_files() {
        for name in [
            HOOK_INSTALL_RESULT_FILE,
            HOOK_INSTALL_SIGNAL_FILE,
            ".hook-report",
        ] {
            let root = tempfile::tempdir().unwrap();
            let data = root.path().join("data");
            std::fs::create_dir(&data).unwrap();
            let external = root.path().join("external");
            if name == ".hook-report" {
                std::fs::create_dir(&external).unwrap();
            } else {
                std::fs::write(&external, "external content").unwrap();
            }
            std::os::unix::fs::symlink(&external, data.join(name)).unwrap();
            let file = hook_install_result_path(data.to_str().unwrap());
            assert!(persist_hook_install_report(&file, &report_fixture("first"))
                .await
                .is_err());
            if external.is_file() {
                assert_eq!(
                    std::fs::read_to_string(&external).unwrap(),
                    "external content"
                );
            } else {
                assert_eq!(std::fs::read_dir(&external).unwrap().count(), 0);
            }
        }
    }

    #[tokio::test]
    async fn cancelled_report_lock_wait_never_publishes_and_can_retry() {
        let root = tempfile::tempdir().unwrap();
        let file = hook_install_result_path(root.path().to_str().unwrap());
        let first = report_fixture("first");
        persist_hook_install_report(&file, &first).await.unwrap();
        let original = std::fs::read(&file).unwrap();
        let signal = root.path().join(HOOK_INSTALL_SIGNAL_FILE);
        let original_signal = std::fs::read(&signal).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!("{file}.lock"))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        let next = report_fixture("second");
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(80),
            persist_hook_install_report(&file, &next)
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(&file).unwrap(), original);
        assert_eq!(std::fs::read(&signal).unwrap(), original_signal);
        assert!(!report_pending(&root.path().join(".hook-report")));
        drop(lock);
        assert_eq!(
            persist_hook_install_report(&file, &next)
                .await
                .unwrap()
                .agents
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn report_external_edit_preserves_conflict_and_recovery_evidence() {
        let root = tempfile::tempdir().unwrap();
        let file = hook_install_result_path(root.path().to_str().unwrap());
        persist_hook_install_report(&file, &report_fixture("first"))
            .await
            .unwrap();
        let (directory, targets) = report_targets(&file).unwrap();
        let mut transaction = ActivationTransaction::begin(&directory, targets).unwrap();
        transaction
            .write_preserving_mode(
                "report",
                &serde_json::to_vec(&report_fixture("pending")).unwrap(),
                0o600,
            )
            .unwrap();
        std::mem::forget(transaction);
        let external = serde_json::to_vec(&report_fixture("external")).unwrap();
        std::fs::write(&file, &external).unwrap();
        let journal = directory.join("update-recovery.json");
        let evidence = std::fs::read(&journal).unwrap();
        let signal = root.path().join(HOOK_INSTALL_SIGNAL_FILE);
        let old_signal = std::fs::read(&signal).unwrap();
        assert!(persist_hook_install_report(&file, &report_fixture("retry"))
            .await
            .is_err());
        assert_eq!(std::fs::read(&file).unwrap(), external);
        assert_eq!(std::fs::read(&signal).unwrap(), old_signal);
        assert_eq!(std::fs::read(&journal).unwrap(), evidence);
        assert!(read_committed_hook_install_report(&file).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_alarm_marks_never_replace_new_install_report() {
        let root = tempfile::tempdir().unwrap();
        let file = hook_install_result_path(root.path().to_str().unwrap());
        let first = report_fixture("first");
        persist_hook_install_report(&file, &first).await.unwrap();
        for index in 0..16 {
            let old = read_committed_hook_install_report(&file)
                .await
                .unwrap()
                .unwrap();
            let next = report_fixture(&format!("agent-{index}"));
            let mark_path = file.clone();
            let mark =
                tokio::spawn(
                    async move { mark_hook_install_alarm_sent(&mark_path, &old.ts).await },
                );
            let persisted = persist_hook_install_report(&file, &next).await.unwrap();
            let marked = mark.await.unwrap().unwrap();
            assert!(matches!(marked, "marked" | "stale"));
            let disk = read_committed_hook_install_report(&file)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(disk, persisted);
            assert_eq!(disk.alarm_sent, Some(false));
        }
        let signal = root.path().join(HOOK_INSTALL_SIGNAL_FILE);
        let original_signal = std::fs::read(&signal).unwrap();
        let report = std::fs::read(&file).unwrap();
        let writable = std::fs::metadata(&file).unwrap().permissions();
        let mut readonly = writable.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&file, readonly).unwrap();
        let ts = read_committed_hook_install_report(&file)
            .await
            .unwrap()
            .unwrap()
            .ts;
        let result = mark_hook_install_alarm_sent(&file, &ts).await;
        std::fs::set_permissions(&file, writable).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(&file).unwrap(), report);
        assert_eq!(std::fs::read(&signal).unwrap(), original_signal);
        assert!(!report_pending(&root.path().join(".hook-report")));
    }

    #[test]
    fn report_process_exit_helper() {
        let Some(data) = std::env::var_os("PILOT_REPORT_EXIT_TEST") else {
            return;
        };
        let file = hook_install_result_path(Path::new(&data).to_str().unwrap());
        let (directory, targets) = report_targets(&file).unwrap();
        let mut transaction = ActivationTransaction::begin(&directory, targets).unwrap();
        transaction
            .write_preserving_mode(
                "report",
                &serde_json::to_vec(&report_fixture("uncommitted")).unwrap(),
                0o600,
            )
            .unwrap();
        std::process::exit(73);
    }

    #[tokio::test]
    async fn report_retry_recovers_after_real_process_exit() {
        let root = tempfile::tempdir().unwrap();
        let file = hook_install_result_path(root.path().to_str().unwrap());
        persist_hook_install_report(&file, &report_fixture("first"))
            .await
            .unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "deployment::hook_install_service::tests::report_process_exit_helper",
            ])
            .env_clear()
            .env("PILOT_REPORT_EXIT_TEST", root.path())
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .current_dir(root.path());
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let output = crate::utils::candidate_process::output(
            &mut tokio::process::Command::from(command),
            std::time::Duration::from_secs(10),
            1024 * 1024,
        )
        .await
        .unwrap();
        assert_eq!(output.status.code(), Some(73));
        assert!(read_committed_hook_install_report(&file).await.is_err());
        let next = persist_hook_install_report(&file, &report_fixture("second"))
            .await
            .unwrap();
        assert_eq!(
            next.agents
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert!(!report_pending(&root.path().join(".hook-report")));
    }

    #[test]
    fn report_validation_rejects_invalid_scope_identity_time_and_status() {
        let valid = serde_json::to_value(report_fixture("first")).unwrap();
        for (key, value) in [
            ("schema", serde_json::json!(2)),
            ("scope", serde_json::json!("auto")),
            ("identity", serde_json::json!("")),
            ("ts", serde_json::json!("not-a-date")),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(parse_report(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        let mut invalid = valid.clone();
        invalid["agents"][0]["status"] = serde_json::json!("unexpected");
        assert!(parse_report(&serde_json::to_vec(&invalid).unwrap()).is_err());
        let mut bom = b"\xef\xbb\xbf".to_vec();
        bom.extend(serde_json::to_vec(&valid).unwrap());
        assert!(parse_report(&bom).is_ok());
    }

    #[test]
    fn selects_none_null_and_named_ids() {
        assert!(matches!(
            select_agents(None, None),
            AgentSelection::Detect {
                warn_literal_null: false
            }
        ));
        assert!(matches!(
            select_agents(Some("null"), None),
            AgentSelection::Detect {
                warn_literal_null: true
            }
        ));
        assert!(matches!(
            select_agents(Some("none"), None),
            AgentSelection::Skip
        ));
        match select_agents(Some(" codex, codex , cursor "), None) {
            AgentSelection::Named { ids, .. } => {
                assert_eq!(ids, vec!["codex".to_string(), "cursor".to_string()])
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn classifies_errors_and_merges_previous_success() {
        assert_eq!(classify_deploy_error("lock-timeout"), "lock-timeout");
        assert_eq!(
            classify_deploy_error("ENOENT: settings directory"),
            "settings-dir-missing"
        );
        assert_eq!(
            classify_deploy_error("invalid JSONC at 1"),
            "invalid-settings"
        );
        assert_eq!(
            classify_deploy_error("activation pending"),
            "activation-pending"
        );
        assert_eq!(
            classify_deploy_error("activation failed"),
            "activation-failed"
        );
        assert_eq!(classify_deploy_error("boom"), "deploy-failed");
        let previous = HookInstallAgentResult {
            id: "codex".into(),
            status: "ok".into(),
            reason: None,
            hint: None,
            settings_path: Some("/a".into()),
            deploy_mode: Some("hook".into()),
        };
        let failed = HookInstallAgentResult {
            id: "codex".into(),
            status: "failed".into(),
            reason: Some("deploy-failed".into()),
            hint: None,
            settings_path: None,
            deploy_mode: Some("hook".into()),
        };
        let merged = merge_installed_agents(
            Some(std::slice::from_ref(&previous)),
            std::slice::from_ref(&failed),
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].status, "ok");
        assert_eq!(exit_code_for(&merged), 1);
        assert_eq!(exit_code_for(&[previous]), 0);
    }

    #[test]
    fn explicit_home_rewrites_codex_trust_and_rejects_external_trust() {
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/codex.json")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("Codex 用户🚀");
        let rewritten = definition_at_install_home(&def, home.to_str().unwrap()).unwrap();
        let hook = rewritten.hook.unwrap();
        assert_eq!(Path::new(&hook.settings_path), home.join("hooks.json"));
        assert_eq!(
            Path::new(&hook.trust_toml.unwrap().config_path),
            home.join("config.toml")
        );
        assert_eq!(
            def.hook.as_ref().unwrap().settings_path,
            "~/.codex/hooks.json"
        );
        def.hook
            .as_mut()
            .unwrap()
            .trust_toml
            .as_mut()
            .unwrap()
            .config_path = dir
            .path()
            .join("unrelated.toml")
            .to_string_lossy()
            .into_owned();
        assert!(definition_at_install_home(&def, home.to_str().unwrap()).is_none());
    }

    #[test]
    fn relative_paths_use_components_not_dot_prefixes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("agent");
        let roots = vec![root.to_string_lossy().into_owned()];
        assert_eq!(
            relative_to_detection_home(root.join("..valid.json").to_str().unwrap(), &roots),
            Some("..valid.json".into())
        );
        assert!(
            relative_to_detection_home(root.join("../outside.json").to_str().unwrap(), &roots)
                .is_none()
        );
        assert!(relative_to_detection_home(root.to_str().unwrap(), &roots).is_none());
    }

    #[test]
    fn rewrites_a_settings_file_under_the_install_home() {
        let def = AgentDefinition {
            id: "grok-build".into(),
            display_name: "Grok".into(),
            deploy_mode: crate::types::DeployMode::Hook,
            detection: crate::types::AgentDetectionConfig {
                paths: vec!["/root/.grok".into()],
                commands: vec![],
            },
            local_worker_runtime: None,
            hook: Some(crate::types::AgentHookConfig {
                settings_path: "/root/.grok/hooks/loongsuite-pilot.json".into(),
                settings_syntax: None,
                events: vec!["stop".into()],
                hook_command: "/pilot/hook.sh".into(),
                format: crate::types::HookFormat::Nested,
                matcher: None,
                event_matchers: None,
                replace_hook_commands: None,
                retired_events: None,
                trust_toml: None,
                event_subcommand: None,
                raw_command: None,
                win_shell: None,
                env: None,
                kiro_agent: None,
                interceptor: None,
            }),
            plugin_probe: None,
            plugin_inject: None,
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: None,
            dsh_yaml_patch: None,
            input: None,
            runtime: None,
        };
        let rewritten = definition_at_install_home(&def, "/workspace/.grok").unwrap();
        let path = rewritten.hook.unwrap().settings_path;
        let expected = std::path::PathBuf::from(node_resolve("/workspace/.grok"))
            .join("hooks")
            .join("loongsuite-pilot.json");
        assert_eq!(std::path::Path::new(&path), expected);
    }
}

#[cfg(test)]
#[path = "hook_install_service_history_contract_tests.rs"]
mod history_contract_tests;

#[cfg(test)]
#[path = "hook_install_grok_history_contract_tests.rs"]
mod grok_history_contract_tests;
