//! Original startup contracts call the real Native planner/runner; no legacy copy.
use super::*;
use serde_json::json;
use std::path::{Path, PathBuf};
fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).into()).collect()
}
fn def(id: &str, mode: &str) -> AgentDefinition {
    serde_json::from_value(
        json!({"id":id,"displayName":id,"deployMode":mode,"detection":{"paths":[],"commands":[]}}),
    )
    .unwrap()
}
fn definitions() -> Vec<AgentDefinition> {
    vec![
        def("claude-code", "hook"),
        def("openclaw", "plugin-inject"),
        def("agentteams-codex-local-runtime", "plugin-probe"),
        def("hermes-agent", "directory-plugin"),
        def("dsh", "dsh-yaml-patch"),
        def("qoder-jetbrains", "detection-only"),
    ]
}
#[test]
fn source_l38_parser_trims_splits_deduplicates_and_preserves_ids() {
    assert_eq!(
        parse_inject_args(&strings(&["--agents=claude-code, openclaw ,claude-code,,"])).agents,
        strings(&["claude-code", "openclaw"])
    );
}
#[test]
fn source_l43_empty_explicit_lists_are_valid_sweeps() {
    for raw in ["--agents=", "--agents=  ,  "] {
        assert!(parse_inject_args(&strings(&[raw])).agents.is_empty());
    }
}
#[test]
fn source_l48_parser_reads_the_original_inline_directory_overrides() {
    let got = parse_inject_args(&strings(&[
        "--agents=claude-code",
        "--data-dir=/mnt/pilot/data",
        "--pilot-dir=/mnt/pilot",
    ]));
    assert_eq!(got.data_dir.as_deref(), Some("/mnt/pilot/data"));
    assert_eq!(got.pilot_dir.as_deref(), Some("/mnt/pilot"));
}
#[test]
fn source_l66_unknown_options_are_retained_without_preventing_later_parsing() {
    let got = parse_inject_args(&strings(&[
        "--agents=claude-code",
        "--nope",
        "--agent=x",
        "--data-dir=/after-unknown",
    ]));
    assert_eq!(got.agents, strings(&["claude-code"]));
    assert_eq!(got.unknown_flags, strings(&["--nope", "--agent=x"]));
    assert_eq!(got.data_dir.as_deref(), Some("/after-unknown"));
}
#[test]
fn source_l74_to_l108_named_plans_preserve_exact_actions_modes_unknowns_and_order() {
    let defs = definitions();
    assert_eq!(
        plan_eager_deploys(&defs, &strings(&["claude-code", "openclaw"]))
            .iter()
            .map(|p| p.action)
            .collect::<Vec<_>>(),
        [EagerAction::Deploy, EagerAction::Deploy]
    );
    assert_eq!(
        serde_json::to_value(plan_eager_deploys(
            &defs,
            &strings(&["agentteams-codex-local-runtime"])
        ))
        .unwrap(),
        json!([{"agentId":"agentteams-codex-local-runtime","action":"deferred","deployMode":"plugin-probe"}])
    );
    assert_eq!(
        plan_eager_deploys(&defs, &strings(&["hermes-agent", "dsh", "qoder-jetbrains"]))
            .iter()
            .map(|p| p.action)
            .collect::<Vec<_>>(),
        [EagerAction::Deferred; 3]
    );
    assert_eq!(
        serde_json::to_value(plan_eager_deploys(
            &defs,
            &strings(&["clade-code", "claude-code"])
        ))
        .unwrap(),
        json!([{"agentId":"clade-code","action":"unknown-id"},{"agentId":"claude-code","action":"deploy","deployMode":"hook"}])
    );
    let unknown = plan_eager_deploys(&defs, &strings(&["nope-1", "nope-2"]));
    assert_eq!(unknown.len(), 2);
    assert!(unknown.iter().all(|p| p.action == EagerAction::UnknownId));
    assert_eq!(
        plan_eager_deploys(&defs, &strings(&["openclaw", "claude-code"]))
            .iter()
            .map(|p| p.agent_id.as_str())
            .collect::<Vec<_>>(),
        ["openclaw", "claude-code"]
    );
}
#[test]
fn source_l121_to_l153_sweeps_only_safe_modes_without_deferred_unknown_or_probe_entries() {
    let defs = definitions();
    let plan = plan_eager_deploys(&defs, &[]);
    assert_eq!(
        plan.iter().map(|p| p.agent_id.as_str()).collect::<Vec<_>>(),
        ["claude-code", "openclaw"]
    );
    assert!(plan.iter().all(|p| p.action == EagerAction::Deploy));
    assert!(!plan
        .iter()
        .any(|p| matches!(p.action, EagerAction::Deferred | EagerAction::UnknownId)));
    assert!(!plan
        .iter()
        .any(|p| p.deploy_mode.as_deref() == Some("plugin-probe")));
    let probes = defs
        .iter()
        .filter(|d| d.deploy_mode == DeployMode::PluginProbe)
        .cloned()
        .collect::<Vec<_>>();
    assert!(plan_eager_deploys(&probes, &[]).is_empty());
    assert_eq!(
        plan_eager_deploys(
            &defs,
            &parse_inject_args(&strings(&["--agents=  ,  "])).agents
        ),
        plan
    );
    let copilot = [def("copilot", "copilot-plugin")];
    assert!(plan_eager_deploys(&copilot, &[]).is_empty());
    assert_eq!(
        plan_eager_deploys(&copilot, &strings(&["copilot"]))[0].action,
        EagerAction::Deferred
    );
}
#[test]
fn source_l180_all_twenty_one_gate_pairs_match_daemon_and_independent_expected_values() {
    let gates = [
        None,
        Some(json!({})),
        Some(json!({"claude-code":{"enabled":true}})),
        Some(json!({"claude-code":{"enabled":false}})),
        Some(json!({"openclaw":{"enabled":false}})),
        Some(
            json!({"claude-code":{"enabled":false},"openclaw":{"enabled":false},"hermes-agent":{"enabled":false}}),
        ),
        Some(json!({"claude-code":{}})),
    ];
    let expected = [
        [true, true, true],
        [true, true, true],
        [true, true, true],
        [false, true, true],
        [true, false, true],
        [false, false, false],
        [true, true, true],
    ];
    for (gate, want) in gates.into_iter().zip(expected) {
        let env = HashMap::new();
        let config = crate::core::assemble_config(
            Some(&json!({"agents":gate.clone().unwrap_or(json!({}))})),
            None,
            &crate::core::ConfigSources {
                env: &env,
                platform: crate::utils::Platform::current(),
                hostname: "eager-gate-fixture",
                config_path: "/unused/eager-fixture.json",
                global_poll_ms: None,
            },
        )
        .unwrap();
        for (id, value) in ["claude-code", "openclaw", "hermes-agent"]
            .into_iter()
            .zip(want)
        {
            let got = is_gate_enabled(gate.as_ref(), id);
            assert_eq!(got, value, "gate={gate:?} id={id}");
            assert_eq!(
                got,
                super::super::deploy_command::is_agent_gated_enabled(&config, id)
            );
        }
    }
}
struct World {
    _temp: tempfile::TempDir,
    root: PathBuf,
    pilot: PathBuf,
    data: PathBuf,
    home: PathBuf,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let pilot = root.join("pilot");
        let data = root.join("data");
        let home = root.join("agent");
        super::super::hook_assets::seed_development_root(&pilot);
        std::fs::create_dir_all(&home).unwrap();
        for suffix in ["sh", "ps1"] {
            for relative in [
                format!("test-agent-hook.{suffix}"),
                format!("shared/native.{suffix}"),
            ] {
                let path = pilot.join("assets/hooks").join(relative);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, "fixture").unwrap();
            }
        }
        let d = json!({"id":"test-agent","displayName":"Test","deployMode":"hook","detection":{"paths":[home],"commands":[]},"hook":{"settingsPath":home.join("settings.json"),"events":["Stop"],"hookCommand":"$PILOT_DATA/hooks/test-agent-hook.sh","format":"nested","matcher":"*"}});
        std::fs::write(
            pilot.join("agents.d/test-agent.json"),
            serde_json::to_vec(&d).unwrap(),
        )
        .unwrap();
        Self {
            _temp: temp,
            root,
            pilot,
            data,
            home,
        }
    }
    fn options(&self, gate: Option<Value>) -> EagerRunOptions {
        EagerRunOptions {
            data_dir: self.data.to_string_lossy().into_owned(),
            pilot_dir: self.pilot.to_string_lossy().into_owned(),
            builtin_agents_dir: Some(self.pilot.join("agents.d").to_string_lossy().into_owned()),
            gate,
        }
    }
    fn manager(&self) -> DeploymentManager {
        DeploymentManager::new(DeploymentManagerOptions {
            data_dir: self.data.to_string_lossy().into_owned(),
            pilot_dir: self.pilot.to_string_lossy().into_owned(),
            builtin_agents_dir: Some(self.pilot.join("agents.d").to_string_lossy().into_owned()),
            installed_by: None,
        })
    }
    fn settings(&self) -> Vec<u8> {
        std::fs::read(self.home.join("settings.json")).unwrap()
    }
}
fn commands(bytes: &[u8]) -> Vec<String> {
    let value: Value = serde_json::from_slice(bytes).unwrap();
    value["hooks"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|groups| groups.as_array().unwrap())
        .flat_map(|g| g["hooks"].as_array().unwrap())
        .map(|h| h["command"].as_str().unwrap().to_owned())
        .collect()
}
#[tokio::test]
async fn parity_l145_actual_eager_then_daemon_keeps_settings_bytes_commands_and_one_hook_identical()
{
    let f = World::new();
    let eager = run_eager_injection(f.options(None), &[]).await;
    assert_eq!(eager.exit_code, 0, "{eager:?}");
    assert_eq!(eager.injected, ["test-agent"]);
    assert!(eager
        .plan
        .iter()
        .any(|p| p.agent_id == "test-agent" && p.action == EagerAction::Deploy));
    let before = f.settings();
    assert_eq!(commands(&before).len(), 1);
    let results = f.manager().deploy_all(None).await;
    let after = f.settings();
    assert_eq!(after, before);
    assert_eq!(commands(&after), commands(&before));
    assert_eq!(commands(&after).len(), 1);
    let result = results.iter().find(|r| r.agent_id == "test-agent").unwrap();
    assert!(result.success);
    assert_eq!(result.skipped, Some(true));
    assert_eq!(result.reason, Some(DeploySkipReason::UpToDate));
    assert!(!f
        .data
        .join(super::super::hook_install_service::HOOK_INSTALL_RESULT_FILE)
        .exists());
}
#[tokio::test]
async fn parity_l165_repeated_real_eager_sweeps_are_byte_idempotent_and_do_not_duplicate_hooks() {
    let f = World::new();
    assert_eq!(run_eager_injection(f.options(None), &[]).await.exit_code, 0);
    let before = f.settings();
    let modified = std::fs::metadata(f.home.join("settings.json"))
        .unwrap()
        .modified()
        .unwrap();
    let repeated = run_eager_injection(f.options(None), &[]).await;
    assert_eq!(repeated.exit_code, 0);
    assert!(repeated.injected.is_empty());
    assert_eq!(f.settings(), before);
    assert_eq!(commands(&before).len(), 1);
    assert_eq!(
        std::fs::metadata(f.home.join("settings.json"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
}
#[tokio::test]
async fn parity_l174_real_daemon_control_deploys_without_any_prior_eager_run() {
    let f = World::new();
    assert!(!f.home.join("settings.json").exists());
    let results = f.manager().deploy_all(None).await;
    let result = results.iter().find(|r| r.agent_id == "test-agent").unwrap();
    assert!(result.success);
    assert_ne!(result.skipped, Some(true));
    assert_eq!(commands(&f.settings()).len(), 1);
}
#[tokio::test]
async fn real_runner_unknown_undetected_and_disabled_are_nonfatal_but_known_deploy_failure_is_fatal(
) {
    let f = World::new();
    let mixed = run_eager_injection(f.options(None), &strings(&["typo", "test-agent"])).await;
    assert_eq!(mixed.exit_code, 0, "{mixed:?}");
    assert_eq!(mixed.injected, ["test-agent"]);
    assert!(mixed.warnings.iter().any(|w| w.contains("typo")));
    let disabled = World::new();
    let result = run_eager_injection(
        disabled.options(Some(json!({"test-agent":{"enabled":false}}))),
        &strings(&["test-agent"]),
    )
    .await;
    assert_eq!(result.exit_code, 0);
    assert!(result.injected.is_empty());
    assert!(!disabled.home.join("settings.json").exists());
    assert!(!disabled.data.join("deployed-agents.json").exists());
    let missing = World::new();
    std::fs::remove_dir_all(&missing.home).unwrap();
    let result = run_eager_injection(missing.options(None), &strings(&["test-agent"])).await;
    assert_eq!(result.exit_code, 0);
    assert!(result.injected.is_empty());
    let broken = World::new();
    std::fs::write(broken.home.join("settings.json"), "broken [").unwrap();
    let result = run_eager_injection(broken.options(None), &strings(&["test-agent"])).await;
    assert_eq!(result.exit_code, 1);
    assert!(result.injected.is_empty());
    assert_eq!(
        std::fs::read_to_string(broken.home.join("settings.json")).unwrap(),
        "broken ["
    );
}
#[tokio::test]
async fn real_eager_state_preserves_daemon_records_and_can_be_cleaned_when_disabled() {
    let f = World::new();
    std::fs::create_dir_all(&f.data).unwrap();
    let previous =
        json!({"deployMode":"hook","deployedAt":"2020-01-01T00:00:00.000Z","installedBy":"daemon"});
    std::fs::write(
        f.data.join("deployed-agents.json"),
        serde_json::to_vec(&json!({"untouched":previous})).unwrap(),
    )
    .unwrap();
    let result = run_eager_injection(f.options(None), &[]).await;
    assert_eq!(result.exit_code, 0, "{result:?}");
    let state: Value =
        serde_json::from_slice(&std::fs::read(f.data.join("deployed-agents.json")).unwrap())
            .unwrap();
    assert_eq!(state["untouched"], previous);
    assert_eq!(state["test-agent"]["deployMode"], "hook");
    assert!(state["test-agent"]["deployedAt"].as_str().is_some());
    f.manager().deploy_all(Some(&|_| false)).await;
    assert!(commands(&f.settings()).is_empty());
    assert!(!f
        .data
        .join(super::super::hook_install_service::HOOK_INSTALL_RESULT_FILE)
        .exists());
    assert!(!Path::new(&f.root.join("collector.pid")).exists());
}
