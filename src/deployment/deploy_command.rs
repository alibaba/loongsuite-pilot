//! 构建期一次性部署：明确的准入门禁、机器可读报告与 worker 清理结果。

use crate::types::{AgentDefinition, AnalyticsConfig, DeployResult, DeploySkipReason};
use crate::utils::{create_logger, resolve_home};
use std::collections::HashSet;

use super::deployment_manager::{DeploymentManager, DeploymentManagerOptions};

fn logger() -> crate::utils::BoundLogger {
    create_logger("DeployCommand")
}

pub const DEFAULT_DATA_DIR: &str = "~/.loongsuite-pilot";

pub fn is_agent_gated_enabled(config: &AnalyticsConfig, agent_id: &str) -> bool {
    if config.agents.is_empty() {
        return true;
    }
    config.agents.get(agent_id).and_then(|agent| agent.enabled) != Some(false)
}

pub fn resolve_pilot_dir(data_dir: &str, module_roots: &[&str]) -> Result<String, String> {
    crate::utils::runtime_paths::resolve_resource_root(data_dir, None, module_roots)
        .map(|root| root.to_string_lossy().into_owned())
        .map_err(|err| err.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployCommandOptions {
    pub required: Vec<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmetRequirement {
    pub agent_id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployReport<'a> {
    data_dir: &'a str,
    pilot_dir: &'a str,
    results: &'a [DeployResult],
    required: &'a [String],
    unmet: &'a [UnmetRequirement],
    worker_stop_failed: bool,
}

fn human_report(report: &DeployReport<'_>) -> (String, String) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut deployed = 0;
    let mut skipped = 0;
    let mut failed = 0;
    for result in report.results {
        if !result.success {
            failed += 1;
            stdout.push(format!(
                "  ❌ {} ({}) 部署失败：{}",
                result.agent_id,
                result.deploy_mode,
                result.error.as_deref().unwrap_or("原因未报告")
            ));
        } else if result.skipped == Some(true) {
            skipped += 1;
            let reason = match result.reason {
                Some(DeploySkipReason::NotDetected) => "未检测到",
                Some(DeploySkipReason::UpToDate) => "已部署且无需更新",
                Some(DeploySkipReason::Disabled) => "已被 config.agents 禁用",
                None => "原因未报告",
            };
            stdout.push(format!(
                "  ➖ {} ({}) 跳过：{reason}",
                result.agent_id, result.deploy_mode
            ));
        } else {
            deployed += 1;
            stdout.push(format!(
                "  ✅ {} ({}) 已部署",
                result.agent_id, result.deploy_mode
            ));
        }
    }
    stdout.push(format!(
        "部署完成：{deployed} 已部署，{skipped} 跳过，{failed} 失败"
    ));
    if report.worker_stop_failed {
        stderr.push("probe worker 未能停止；不能把遗留的进程或 worker.pid 封入镜像".into());
    }
    if report.unmet.is_empty() && !report.required.is_empty() {
        stdout.push(format!(
            "所有必需 Agent 均已部署：{}",
            report.required.join(", ")
        ));
    }
    for item in report.unmet {
        stderr.push(format!(
            "必需 Agent {} 未就绪：{}{}",
            item.agent_id,
            item.reason,
            item.error
                .as_ref()
                .map(|error| format!("：{error}"))
                .unwrap_or_default()
        ));
    }
    (stdout.join("\n"), stderr.join("\n"))
}

pub fn deploy_exit_code(
    results: &[DeployResult],
    unmet: &[UnmetRequirement],
    worker_stop_failed: bool,
) -> i32 {
    if !unmet.is_empty() || results.iter().any(|result| !result.success) || worker_stop_failed {
        1
    } else {
        0
    }
}

pub fn collect_unmet(
    required: &[String],
    known_ids: &HashSet<String>,
    results: &[DeployResult],
) -> Vec<UnmetRequirement> {
    let mut unmet = Vec::new();
    for agent_id in required {
        if !known_ids.contains(agent_id) {
            unmet.push(UnmetRequirement {
                agent_id: agent_id.clone(),
                reason: "unknown-id".into(),
                error: None,
            });
            continue;
        }
        let Some(result) = results.iter().find(|result| result.agent_id == *agent_id) else {
            unmet.push(UnmetRequirement {
                agent_id: agent_id.clone(),
                reason: "not-detected".into(),
                error: None,
            });
            continue;
        };
        if !result.success {
            unmet.push(UnmetRequirement {
                agent_id: agent_id.clone(),
                reason: "failed".into(),
                error: result.error.clone(),
            });
            continue;
        }
        if result.skipped == Some(true) && result.reason != Some(DeploySkipReason::UpToDate) {
            let reason = if result.reason == Some(DeploySkipReason::Disabled) {
                "disabled"
            } else {
                "not-detected"
            };
            unmet.push(UnmetRequirement {
                agent_id: agent_id.clone(),
                reason: reason.into(),
                error: None,
            });
        }
    }
    unmet
}

pub fn parse_args(argv: &[String]) -> Result<DeployCommandOptions, String> {
    let mut required = Vec::new();
    let mut json = false;
    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        if arg == "--json" {
            json = true;
        } else if arg == "--require" {
            index += 1;
            required.extend(require_ids(
                argv.get(index).map(String::as_str),
                "--require <ids>",
            )?);
        } else if let Some(raw) = arg.strip_prefix("--require=") {
            required.extend(require_ids(Some(raw), "--require=<ids>")?);
        } else {
            return Err(format!("unknown option: {arg}"));
        }
        index += 1;
    }
    let mut seen = HashSet::new();
    required.retain(|id| seen.insert(id.clone()));
    Ok(DeployCommandOptions { required, json })
}

fn require_ids(raw: Option<&str>, usage: &str) -> Result<Vec<String>, String> {
    let Some(raw) = raw else {
        return Err(format!("{usage} requires a value (got nothing)"));
    };
    if raw.starts_with("--") {
        return Err(format!("{usage} requires a value (got {raw})"));
    }
    let ids: Vec<String> = raw
        .split(',')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect();
    if ids.is_empty() {
        return Err(format!("{usage} was given an empty value. Omit --require entirely if no agent is required — an empty list would silently disable the check."));
    }
    Ok(ids)
}

pub async fn deploy_loaded_config(
    config: &AnalyticsConfig,
    argv: &[String],
    module_roots: &[&str],
) -> Result<(i32, Vec<DeployResult>, Vec<UnmetRequirement>), String> {
    let opts = parse_args(argv)?;
    let data_dir = resolve_home(if config.data_dir.is_empty() {
        DEFAULT_DATA_DIR
    } else {
        &config.data_dir
    });
    let pilot_dir = resolve_pilot_dir(&data_dir, module_roots)?;
    if let Err(error) = crate::pi_sdk::ensure_registered_pi_sdk_wrappers(&data_dir).await {
        logger().warn(
            "无法恢复已注册的 PI SDK wrapper",
            serde_json::json!({"error": error.to_string()}).as_object(),
        );
    }
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: data_dir.clone(),
        pilot_dir: pilot_dir.clone(),
        builtin_agents_dir: None,
        installed_by: Some(crate::types::InstalledBy::Build),
    });
    let results = manager
        .deploy_all(Some(&|def: &AgentDefinition| {
            is_agent_gated_enabled(config, &def.id)
        }))
        .await;
    let worker_stop_failed = match manager.stop_workers().await {
        Ok(()) => false,
        Err(error) => {
            logger().error(
                "无法停止 probe worker",
                serde_json::json!({"error": error}).as_object(),
            );
            true
        }
    };
    let known: HashSet<String> = manager
        .get_definitions()
        .iter()
        .map(|def| def.id.clone())
        .collect();
    let unmet = collect_unmet(&opts.required, &known, &results);
    let code = deploy_exit_code(&results, &unmet, worker_stop_failed);
    let report = DeployReport {
        data_dir: &data_dir,
        pilot_dir: &pilot_dir,
        results: &results,
        required: &opts.required,
        unmet: &unmet,
        worker_stop_failed,
    };
    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|err| err.to_string())?
        );
    } else {
        let (stdout, stderr) = human_report(&report);
        println!("{stdout}");
        if !stderr.is_empty() {
            eprintln!("{stderr}");
        }
    }
    Ok((code, results, unmet))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DeployMode;

    fn result(
        id: &str,
        success: bool,
        skipped: Option<bool>,
        reason: Option<DeploySkipReason>,
    ) -> DeployResult {
        DeployResult {
            success,
            agent_id: id.into(),
            deploy_mode: DeployMode::Hook,
            skipped,
            reason,
            error: None,
            plugin_inject_config_path: None,
        }
    }

    #[test]
    fn deployment_gate_covers_each_historical_result_and_worker_failure() {
        let known = HashSet::from(["hermes-agent".into()]);
        let required = vec!["hermes-agent".into()];
        for (success, skipped, reason, expected) in [
            (true, None, None, None),
            (true, Some(true), Some(DeploySkipReason::UpToDate), None),
            (
                true,
                Some(true),
                Some(DeploySkipReason::NotDetected),
                Some("not-detected"),
            ),
            (
                true,
                Some(true),
                Some(DeploySkipReason::Disabled),
                Some("disabled"),
            ),
            (false, None, None, Some("failed")),
        ] {
            let mut item = result("hermes-agent", success, skipped, reason);
            item.error = (!success).then(|| "plugin extract failed".into());
            let results = vec![item];
            let unmet = collect_unmet(&required, &known, &results);
            assert_eq!(unmet.first().map(|item| item.reason.as_str()), expected);
            assert_eq!(
                deploy_exit_code(&results, &unmet, false),
                i32::from(expected.is_some())
            );
            assert_eq!(deploy_exit_code(&results, &[], false), i32::from(!success));
            assert_eq!(deploy_exit_code(&results, &[], true), 1);
            if !success {
                assert_eq!(unmet[0].error.as_deref(), Some("plugin extract failed"));
            }
        }
        assert_eq!(
            collect_unmet(&required, &known, &[])[0].reason,
            "not-detected"
        );
        let unknown = collect_unmet(&["hermez-agent".into()], &known, &[]);
        assert_eq!(
            serde_json::to_value(&unknown).unwrap(),
            serde_json::json!([{"agentId":"hermez-agent", "reason":"unknown-id"}])
        );
    }

    #[test]
    fn argument_contract_never_silently_disables_requirements() {
        for args in [
            vec!["--require", ""],
            vec!["--require", " , "],
            vec!["--require="],
            vec!["--require"],
            vec!["--require", "--json"],
            vec!["--force"],
        ] {
            assert!(
                parse_args(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>()).is_err(),
                "{args:?}"
            );
        }
        for args in [vec!["--require", "a, b ,a"], vec!["--require=a,b"]] {
            assert_eq!(
                parse_args(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
                    .unwrap()
                    .required,
                ["a", "b"]
            );
        }
        assert!(parse_args(&[]).unwrap().required.is_empty());
        assert_eq!(
            parse_args(&["--json".into()]).unwrap(),
            DeployCommandOptions {
                required: vec![],
                json: true
            }
        );
    }

    #[test]
    fn report_keeps_machine_fields_and_human_failure_diagnostics() {
        let results = vec![result("cursor", false, None, None)];
        let required = vec!["cursor".into()];
        let unmet = collect_unmet(&required, &HashSet::from(["cursor".into()]), &results);
        let report = DeployReport {
            data_dir: "/数据",
            pilot_dir: "/候选",
            results: &results,
            required: &required,
            unmet: &unmet,
            worker_stop_failed: true,
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["dataDir"], "/数据");
        assert_eq!(json["pilotDir"], "/候选");
        assert_eq!(json["workerStopFailed"], true);
        assert_eq!(json["results"][0]["agentId"], "cursor");
        let (stdout, stderr) = human_report(&report);
        assert!(stdout.contains("1 失败"));
        assert!(stderr.contains("worker.pid"));
        assert!(stderr.contains("cursor 未就绪：failed"));
    }

    #[test]
    fn empty_require_is_rejected_and_up_to_date_is_met() {
        assert!(parse_args(&["--require".into(), "".into()]).is_err());
        assert!(parse_args(&["--require".into()]).is_err());
        let opts =
            parse_args(&["--require".into(), "codex,cursor".into(), "--json".into()]).unwrap();
        assert!(opts.json);
        assert_eq!(
            opts.required,
            vec!["codex".to_string(), "cursor".to_string()]
        );
        let mut known = HashSet::new();
        known.insert("codex".into());
        let unmet = collect_unmet(
            &["codex".into(), "missing".into()],
            &known,
            &[result(
                "codex",
                true,
                Some(true),
                Some(DeploySkipReason::UpToDate),
            )],
        );
        assert_eq!(unmet.len(), 1);
        assert_eq!(unmet[0].reason, "unknown-id");
        assert_eq!(
            deploy_exit_code(
                &[result(
                    "codex",
                    true,
                    Some(true),
                    Some(DeploySkipReason::UpToDate)
                )],
                &[],
                false
            ),
            0
        );
        assert_eq!(
            deploy_exit_code(&[result("codex", false, None, None)], &[], false),
            1
        );
    }
}

#[cfg(test)]
#[path = "deploy_command_history_contract_tests.rs"]
mod history_contract_tests;
