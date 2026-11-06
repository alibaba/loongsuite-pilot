//! 注入验证的固定矩阵与失败关闭门禁；不把模拟报告当成平台验收。

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Targets {
    schema: u32,
    targets: Vec<Target>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Target {
    target: String,
    runner: String,
    archive: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u32,
    scope: String,
    common_scenarios: Vec<String>,
    agents: Vec<Agent>,
    detection_scenarios: Vec<String>,
    cross_agent_scenarios: Vec<String>,
    no_injection: Vec<NoInjection>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Agent {
    id: String,
    deploy_mode: String,
    extra_scenarios: Vec<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NoInjection {
    id: String,
    reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    agent_id: String,
    deploy_mode: String,
    scenario: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    target: String,
    agent_id: String,
    deploy_mode: String,
    scenario: String,
    outcome: String,
    duration_ms: u64,
    package_sha256: String,
    commit: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    schema: u32,
    scope: String,
    target: String,
    commit: String,
    package_sha256: String,
    status: String,
    records: Vec<Record>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PackageIndex {
    schema: u32,
    commit: String,
    packages: Vec<Package>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Package {
    target: String,
    sha256: String,
}

struct Matrix {
    targets: Targets,
    manifest: Manifest,
    cases: BTreeSet<Case>,
}

fn identifier(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn digest(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl Matrix {
    fn load(root: &Path) -> Result<Self> {
        let targets: Targets =
            serde_json::from_str(include_str!("../../tests/e2e-injection/targets.json"))?;
        let manifest: Manifest =
            serde_json::from_str(include_str!("../../tests/e2e-injection/manifest.json"))?;
        ensure!(
            targets.schema == 1
                && targets.targets.len()
                    == loongsuite_pilot::utils::runtime_paths::SUPPORTED_TARGETS.len(),
            "六平台清单缺项"
        );
        ensure!(
            manifest.schema == 1 && manifest.scope == "injection-only",
            "注入清单 schema/scope 无效"
        );
        ensure!(
            targets
                .targets
                .iter()
                .map(|target| target.target.as_str())
                .collect::<BTreeSet<_>>()
                == loongsuite_pilot::utils::runtime_paths::SUPPORTED_TARGETS
                    .into_iter()
                    .collect(),
            "注入矩阵必须与运行时支持的平台完全一致"
        );
        let mut seen = BTreeSet::new();
        for target in &targets.targets {
            ensure!(
                identifier(&target.target.replace('_', "-")) && seen.insert(&target.target),
                "目标平台重复或无效"
            );
            ensure!(
                !target.runner.is_empty() && !target.runner.ends_with("-latest"),
                "必须固定 runner 代际"
            );
            ensure!(
                target.archive
                    == if target.target.contains("windows") {
                        "zip"
                    } else {
                        "tar.gz"
                    },
                "归档格式与平台不一致"
            );
        }
        let mut definitions = BTreeMap::new();
        for entry in fs::read_dir(root.join("agents.d"))? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            ensure!(entry.file_type()?.is_file(), "Agent 声明必须是普通文件");
            let value: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
            let id = value["id"].as_str().context("Agent 声明缺少 ID")?;
            ensure!(
                path.file_stem().and_then(|s| s.to_str()) == Some(id),
                "Agent 文件名与 ID 不一致"
            );
            let mode = value
                .get("deployMode")
                .map(|v| v.as_str().context("deployMode 不是字符串"))
                .transpose()?
                .unwrap_or("hook");
            ensure!(
                definitions
                    .insert(id.to_string(), mode.to_string())
                    .is_none(),
                "Agent 声明重复"
            );
        }
        let mut agents = BTreeMap::new();
        let mut cases = BTreeSet::new();
        for agent in &manifest.agents {
            ensure!(
                identifier(&agent.id)
                    && agents
                        .insert(agent.id.clone(), agent.deploy_mode.clone())
                        .is_none(),
                "Agent 清单重复或无效"
            );
            ensure!(
                matches!(
                    agent.deploy_mode.as_str(),
                    "hook"
                        | "plugin-inject"
                        | "directory-plugin"
                        | "dsh-yaml-patch"
                        | "detection-only"
                        | "copilot-plugin"
                ),
                "不允许未登记部署类型"
            );
            if agent.deploy_mode == "detection-only" {
                ensure!(
                    matches!(agent.id.as_str(), "qoder-jetbrains" | "doubao-work"),
                    "不可新增检测豁免而不审查门禁"
                );
            }
            let base = if agent.deploy_mode == "detection-only" {
                &manifest.detection_scenarios
            } else {
                &manifest.common_scenarios
            };
            ensure!(base.iter().any(|s| s == "baseline"), "Agent 缺少基础场景");
            for scenario in base.iter().chain(&agent.extra_scenarios) {
                ensure!(identifier(scenario), "场景 ID 无效");
                ensure!(
                    cases.insert(Case {
                        agent_id: agent.id.clone(),
                        deploy_mode: agent.deploy_mode.clone(),
                        scenario: scenario.clone()
                    }),
                    "Agent 场景重复"
                );
            }
        }
        ensure!(
            !agents.is_empty() && agents == definitions,
            "注入清单与 agents.d 不完全相等；新增声明必须登记场景和 fixture"
        );
        for scenario in &manifest.cross_agent_scenarios {
            ensure!(
                identifier(scenario)
                    && cases.insert(Case {
                        agent_id: "all-agents".into(),
                        deploy_mode: "cross-agent".into(),
                        scenario: scenario.clone()
                    }),
                "跨 Agent 场景重复或无效"
            );
        }
        ensure!(
            manifest.no_injection.len() == 1
                && manifest.no_injection[0].id == "wukong"
                && !manifest.no_injection[0].reason.trim().is_empty()
                && !agents.contains_key("wukong"),
            "无注入豁免只能登记 Wukong polling"
        );
        Ok(Self {
            targets,
            manifest,
            cases,
        })
    }

    fn validate(
        &self,
        index: &PackageIndex,
        reports: &[Report],
        commit: &str,
    ) -> Result<serde_json::Value> {
        ensure!(digest(commit, 40), "验收提交必须为完整 SHA");
        ensure!(
            index.schema == 1 && index.commit == commit,
            "候选包索引的提交或 schema 不匹配"
        );
        let targets: BTreeSet<_> = self
            .targets
            .targets
            .iter()
            .map(|t| t.target.as_str())
            .collect();
        let mut packages = BTreeMap::new();
        for package in &index.packages {
            ensure!(
                digest(&package.sha256, 64) && targets.contains(package.target.as_str()),
                "候选包摘要或平台无效"
            );
            ensure!(
                packages
                    .insert(package.target.as_str(), package.sha256.as_str())
                    .is_none(),
                "候选包平台重复"
            );
        }
        ensure!(
            packages.keys().copied().collect::<BTreeSet<_>>() == targets,
            "候选包必须包含全部六平台"
        );
        let mut seen_targets = BTreeSet::new();
        let mut record_count = 0;
        for report in reports {
            ensure!(
                report.schema == 1 && report.scope == "injection-only",
                "报告 schema/scope 无效"
            );
            ensure!(
                report.commit == commit && report.status == "passed",
                "报告不是当前提交的完整成功结果"
            );
            let sha = packages
                .get(report.target.as_str())
                .context("报告出现未声明平台")?;
            ensure!(report.package_sha256 == *sha, "报告的候选包摘要不匹配");
            ensure!(seen_targets.insert(report.target.as_str()), "平台报告重复");
            let mut cases = BTreeSet::new();
            for record in &report.records {
                ensure!(
                    record.target == report.target
                        && record.commit == commit
                        && record.package_sha256 == *sha,
                    "记录来源与平台/提交/候选包不一致"
                );
                ensure!(record.duration_ms <= 60_000, "单用例超过 60 秒上限");
                let case = Case {
                    agent_id: record.agent_id.clone(),
                    deploy_mode: record.deploy_mode.clone(),
                    scenario: record.scenario.clone(),
                };
                ensure!(
                    self.cases.contains(&case) && cases.insert(case),
                    "报告包含未声明或重复的 Agent/场景"
                );
                let expected = if record.deploy_mode == "detection-only" {
                    "detected"
                } else {
                    "passed"
                };
                ensure!(
                    record.outcome == expected,
                    "Agent/场景失败或伪装为 skip：{}/{}/{}",
                    report.target,
                    record.agent_id,
                    record.scenario
                );
            }
            ensure!(
                cases == self.cases,
                "平台报告缺少 Agent/场景：{}",
                report.target
            );
            record_count += cases.len();
        }
        ensure!(
            seen_targets == targets,
            "必须收齐全部六平台报告，缺失/取消/跳过不可通过"
        );
        Ok(serde_json::json!({
            "schema": 1, "scope": "injection-only", "commit": commit,
            "targets": targets.len(), "agents": self.manifest.agents.len(),
            "baselineResults": targets.len() * self.manifest.agents.len(),
            "scenarioResults": record_count, "noInjection": self.manifest.no_injection,
            "packages": index.packages, "ok": true,
        }))
    }
}

pub fn matrix(root: &Path) -> Result<()> {
    let matrix = Matrix::load(root)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "include": matrix.targets.targets,
            "scope": "injection-only",
            "agents": matrix.manifest.agents,
            "cases": matrix.cases,
            "noInjection": matrix.manifest.no_injection,
        }))?
    );
    Ok(())
}

fn report_paths(root: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        ensure!(!kind.is_symlink(), "报告目录不能包含符号链接");
        if kind.is_dir() {
            report_paths(&entry.path(), out)?;
        } else if entry
            .file_name()
            .to_string_lossy()
            .starts_with("injection-")
            && entry.path().extension().and_then(|s| s.to_str()) == Some("json")
        {
            out.push(entry.path());
        }
    }
    Ok(())
}

pub fn check_reports(
    root: &Path,
    reports_root: &Path,
    packages: &Path,
    commit: &str,
) -> Result<()> {
    let matrix = Matrix::load(root)?;
    let index: PackageIndex = serde_json::from_slice(&fs::read(packages)?)?;
    let mut paths = Vec::new();
    report_paths(reports_root, &mut paths)?;
    ensure!(
        paths.len() == matrix.targets.targets.len(),
        "平台报告文件数量必须为六，不接受缺失或重复"
    );
    let reports: Vec<Report> = paths
        .iter()
        .map(|path| {
            let report: Report = serde_json::from_slice(&fs::read(path)?)
                .with_context(|| format!("报告格式无效：{}", path.display()))?;
            ensure!(
                path.file_name().and_then(|s| s.to_str())
                    == Some(format!("injection-{}.json", report.target).as_str()),
                "报告文件名与平台不一致"
            );
            Ok(report)
        })
        .collect::<Result<_>>()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&matrix.validate(&index, &reports, commit)?)?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
    }
    fn fixtures(matrix: &Matrix) -> (PackageIndex, Vec<Report>) {
        let commit = "a".repeat(40);
        let packages: Vec<_> = matrix
            .targets
            .targets
            .iter()
            .enumerate()
            .map(|(i, t)| Package {
                target: t.target.clone(),
                sha256: format!("{i:064x}"),
            })
            .collect();
        let reports = packages
            .iter()
            .map(|package| Report {
                schema: 1,
                scope: "injection-only".into(),
                target: package.target.clone(),
                commit: commit.clone(),
                package_sha256: package.sha256.clone(),
                status: "passed".into(),
                records: matrix
                    .cases
                    .iter()
                    .map(|case| Record {
                        target: package.target.clone(),
                        agent_id: case.agent_id.clone(),
                        deploy_mode: case.deploy_mode.clone(),
                        scenario: case.scenario.clone(),
                        outcome: if case.deploy_mode == "detection-only" {
                            "detected"
                        } else {
                            "passed"
                        }
                        .into(),
                        duration_ms: 1,
                        package_sha256: package.sha256.clone(),
                        commit: commit.clone(),
                    })
                    .collect(),
            })
            .collect();
        (
            PackageIndex {
                schema: 1,
                commit,
                packages,
            },
            reports,
        )
    }

    #[test]
    fn fixed_six_platform_matrix_has_132_baselines_plus_required_scenarios() {
        let matrix = Matrix::load(root()).unwrap();
        let (index, reports) = fixtures(&matrix);
        let summary = matrix.validate(&index, &reports, &index.commit).unwrap();
        assert_eq!(summary["baselineResults"], 132);
        assert!(summary["scenarioResults"].as_u64().unwrap() > 132);
        assert_eq!(summary["noInjection"][0]["id"], "wukong");
    }

    #[test]
    fn doubao_detection_still_requires_each_platform_baseline_and_readonly_report() {
        let matrix = Matrix::load(root()).unwrap();
        let cases: Vec<_> = matrix
            .cases
            .iter()
            .filter(|case| case.agent_id == "doubao-work")
            .collect();
        assert_eq!(cases.len(), 2);
        assert!(cases
            .iter()
            .all(|case| case.deploy_mode == "detection-only"));
        assert_eq!(
            cases
                .iter()
                .map(|case| case.scenario.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["baseline", "status-read-only"])
        );
        let (index, complete) = fixtures(&matrix);
        for target in 0..complete.len() {
            for scenario in ["baseline", "status-read-only"] {
                let mut reports = complete.clone();
                reports[target]
                    .records
                    .retain(|row| !(row.agent_id == "doubao-work" && row.scenario == scenario));
                assert!(
                    matrix.validate(&index, &reports, &index.commit).is_err(),
                    "missing Doubao {scenario} must fail for target {}",
                    reports[target].target
                );
            }
        }
    }

    #[test]
    fn rejects_missing_duplicate_empty_skipped_failed_stale_and_wrong_digest() {
        let matrix = Matrix::load(root()).unwrap();
        let (index, reports) = fixtures(&matrix);
        for fault in 0..13 {
            let mut bad = reports.clone();
            match fault {
                0 => {
                    bad.pop();
                }
                1 => {
                    bad[0].records.pop();
                }
                2 => {
                    let duplicate = bad[0].records[0].clone();
                    bad[0].records.push(duplicate);
                }
                3 => {
                    bad[0].records.clear();
                }
                4 => {
                    bad[0].records[0].outcome = "skipped".into();
                }
                5 => {
                    bad[0].records[0].outcome = "failed".into();
                }
                6 => {
                    bad[0].commit = "b".repeat(40);
                }
                7 => {
                    bad[0].package_sha256 = "f".repeat(64);
                }
                8 => {
                    bad[0].records[0].commit = "b".repeat(40);
                }
                9 => {
                    bad[0].records[0].package_sha256 = "f".repeat(64);
                }
                10 => {
                    bad[0].status = "cancelled".into();
                }
                11 => {
                    bad.push(bad[0].clone());
                }
                12 => {
                    bad[0].records[0].duration_ms = 60_001;
                }
                _ => unreachable!(),
            }
            assert!(
                matrix.validate(&index, &bad, &index.commit).is_err(),
                "故障 {fault} 被错误接受"
            );
        }
        let mut bad = reports;
        let detection = bad[0]
            .records
            .iter_mut()
            .find(|r| r.deploy_mode == "detection-only")
            .unwrap();
        detection.outcome = "passed".into();
        assert!(matrix.validate(&index, &bad, &index.commit).is_err());
    }

    #[test]
    fn candidate_index_requires_exact_platform_set_and_commit() {
        let matrix = Matrix::load(root()).unwrap();
        let (index, reports) = fixtures(&matrix);
        for fault in 0..5 {
            let mut bad = index.clone();
            match fault {
                0 => {
                    bad.packages.pop();
                }
                1 => {
                    bad.packages.push(bad.packages[0].clone());
                }
                2 => {
                    bad.commit = "b".repeat(40);
                }
                3 => {
                    bad.packages[0].sha256 = "missing".into();
                }
                4 => {
                    bad.packages[0].target = "unsupported".into();
                }
                _ => unreachable!(),
            }
            assert!(matrix.validate(&bad, &reports, &index.commit).is_err());
        }
    }

    #[test]
    fn new_or_missing_agent_definition_requires_manifest_change() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("agents.d")).unwrap();
        for entry in fs::read_dir(root().join("agents.d")).unwrap() {
            let entry = entry.unwrap();
            fs::copy(
                entry.path(),
                tmp.path().join("agents.d").join(entry.file_name()),
            )
            .unwrap();
        }
        assert!(Matrix::load(tmp.path()).is_ok());
        fs::write(
            tmp.path().join("agents.d/new-agent.json"),
            r#"{"id":"new-agent","deployMode":"hook"}"#,
        )
        .unwrap();
        assert!(Matrix::load(tmp.path()).is_err());
        fs::remove_file(tmp.path().join("agents.d/new-agent.json")).unwrap();
        fs::remove_file(tmp.path().join("agents.d/codex.json")).unwrap();
        assert!(Matrix::load(tmp.path()).is_err());
    }

    #[test]
    fn disk_gate_rejects_missing_and_duplicate_report_files() {
        let matrix = Matrix::load(root()).unwrap();
        let (index, reports) = fixtures(&matrix);
        let tmp = tempfile::tempdir().unwrap();
        let packages = tmp.path().join("packages.json");
        fs::write(&packages, serde_json::to_vec(&index).unwrap()).unwrap();
        assert!(check_reports(root(), tmp.path(), &packages, &index.commit).is_err());
        for report in &reports {
            fs::write(
                tmp.path().join(format!("injection-{}.json", report.target)),
                serde_json::to_vec(report).unwrap(),
            )
            .unwrap();
        }
        check_reports(root(), tmp.path(), &packages, &index.commit).unwrap();
        fs::create_dir(tmp.path().join("duplicate")).unwrap();
        fs::write(
            tmp.path()
                .join("duplicate")
                .join(format!("injection-{}.json", reports[0].target)),
            serde_json::to_vec(&reports[0]).unwrap(),
        )
        .unwrap();
        assert!(check_reports(root(), tmp.path(), &packages, &index.commit).is_err());
    }
}
