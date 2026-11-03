//! Exact historical hook-install contracts against the real service and filesystem.
use super::*;
use serde_json::{json, Value};
#[cfg(unix)]
tokio::task_local! {static HISTORY_OWNER: u32;}
#[cfg(unix)]
pub(super) fn owner_for_history(actual: u32) -> u32 {
    HISTORY_OWNER.try_with(|owner| *owner).unwrap_or(actual)
}
struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
    pilot: PathBuf,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let data = root.join("data");
        let pilot = root.join("pilot");
        let home = root.join("agent-home");
        super::super::hook_assets::seed_development_root(&pilot);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        for suffix in ["sh", "ps1"] {
            let shared = pilot.join(format!("assets/hooks/shared/native.{suffix}"));
            std::fs::create_dir_all(shared.parent().unwrap()).unwrap();
            std::fs::write(shared, "native fixture").unwrap();
        }
        let f = Self {
            _root: temp,
            root,
            data,
            pilot,
            home,
        };
        f.add_hook("sample-agent", &f.home);
        f
    }
    fn add_hook(&self, id: &str, home: &Path) {
        std::fs::create_dir_all(home).unwrap();
        let def = json!({"id":id,"displayName":id,"deployMode":"hook","detection":{"paths":[home],"commands":[]},"hook":{"settingsPath":home.join("settings.json"),"settingsSyntax":"jsonc","events":["Stop"],"hookCommand":format!("$PILOT_DATA/hooks/{id}-hook.sh"),"format":"nested","matcher":"*"}});
        self.definition(id, &def);
        for suffix in ["sh", "ps1"] {
            std::fs::write(
                self.pilot.join(format!("assets/hooks/{id}-hook.{suffix}")),
                "fixture hook",
            )
            .unwrap();
        }
    }
    fn definition(&self, id: &str, value: &Value) {
        std::fs::write(
            self.pilot.join("agents.d").join(format!("{id}.json")),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    fn options(&self, agents: Option<&str>) -> HookInstallRunOptions<'static> {
        HookInstallRunOptions {
            data_dir: self.data.to_string_lossy().into_owned(),
            pilot_dir: self.pilot.to_string_lossy().into_owned(),
            builtin_agents_dir: Some(self.pilot.join("agents.d").to_string_lossy().into_owned()),
            agents_flag: agents.map(str::to_owned),
            env_agents: None,
            homes: HashMap::new(),
            write_result: true,
            deploy_modes: None,
            enabled: None,
            euid: Some(1),
            identity: Some(ContainerIdentity {
                identity: "c".repeat(64),
                source: crate::utils::ContainerIdentitySource::Cgroup,
            }),
            mode: "install",
        }
    }
    async fn run(&self, agents: Option<&str>) -> HookInstallRunResult {
        run_hook_install(self.options(agents)).await
    }
    fn report(&self) -> HookInstallReport {
        serde_json::from_slice(&std::fs::read(self.data.join(HOOK_INSTALL_RESULT_FILE)).unwrap())
            .unwrap()
    }
}
#[tokio::test]
async fn source_l77_all_selection_variants_and_null_warning_use_the_real_service() {
    for (flag, env, warn) in [
        (None, None, false),
        (None, Some(""), false),
        (None, Some("null"), true),
        (Some("null"), Some("claude-code"), true),
    ] {
        assert_eq!(
            select_agents(flag, env),
            AgentSelection::Detect {
                warn_literal_null: warn
            }
        );
    }
    assert_eq!(select_agents(None, Some("none")), AgentSelection::Skip);
    assert_eq!(select_agents(Some("none"), None), AgentSelection::Skip);
    assert!(matches!(
        select_agents(Some("sample-agent"), Some("none")),
        AgentSelection::Named { .. }
    ));
    let f = Fixture::new();
    let skipped = f.run(Some("none")).await;
    assert_eq!(skipped.exit_code, 0);
    assert!(!skipped.wrote_result);
    assert!(!f.data.join(HOOK_INSTALL_RESULT_FILE).exists());
    let mut opts = f.options(None);
    opts.env_agents = Some("null".into());
    let result = run_hook_install(opts).await;
    assert_eq!(result.exit_code, 0, "{:?}", result.report);
    assert_eq!(result.report.scope, "detected");
    assert_eq!(
        result
            .report
            .agents
            .iter()
            .map(|a| a.id.as_str())
            .collect::<Vec<_>>(),
        ["sample-agent"]
    );
    assert_eq!(
        result.warnings,
        ["LOONGSUITE_PILOT_AGENTS or --agents is the literal \"null\"; detecting all agents."]
    );
}
#[tokio::test]
async fn source_l100_unknown_undetected_agents_and_every_failure_reason_keep_actionable_hints() {
    for reason in HOOK_INSTALL_REASONS {
        assert!(!hint_for_reason(reason, Some("sample-agent")).is_empty());
    }
    let f = Fixture::new();
    let unknown = f.run(Some("missing-agent")).await;
    assert_eq!(unknown.exit_code, 1);
    assert_eq!(unknown.report.scope, "detected");
    let a = &unknown.report.agents[0];
    assert_eq!(a.id, "missing-agent");
    assert_eq!(a.status, "failed");
    assert_eq!(a.reason.as_deref(), Some("unknown-id"));
    assert!(!a.hint.as_ref().unwrap().is_empty());
    let identity = ContainerIdentity {
        identity: "c".repeat(64),
        source: crate::utils::ContainerIdentitySource::Cgroup,
    };
    assert_eq!(
        super::super::deployment_scope::resolve_deployment_scope(
            &identity,
            Some(&super::super::deployment_scope::DeploymentScopeResult {
                scope: Some(unknown.report.scope.clone()),
                identity: Some(unknown.report.identity.clone())
            })
        ),
        super::super::deployment_scope::DeploymentScopeMode::Auto
    );
    std::fs::remove_dir_all(&f.home).unwrap();
    let missing = f.run(Some("sample-agent")).await;
    assert_eq!(missing.exit_code, 1);
    let a = &missing.report.agents[0];
    assert_eq!(a.status, "failed");
    assert_eq!(a.reason.as_deref(), Some("not-detected"));
    assert!(a.hint.as_ref().unwrap().contains("home"));
}
#[cfg(unix)]
#[tokio::test]
async fn source_l129_injected_uid_mismatch_runs_the_actual_reporting_branch_without_root_or_chown()
{
    let f = Fixture::new();
    let mut opts = f.options(Some("sample-agent"));
    opts.euid = Some(0);
    opts.homes
        .insert("sample-agent".into(), f.home.to_string_lossy().into_owned());
    let result = HISTORY_OWNER.scope(1000, run_hook_install(opts)).await;
    assert_eq!(result.exit_code, 1);
    let a = &result.report.agents[0];
    assert_eq!(a.status, "failed");
    assert_eq!(a.reason.as_deref(), Some("uid-mismatch"));
    assert!(a.hint.as_ref().unwrap().contains("agent user"));
    assert!(!f.home.join("settings.json").exists());
}
#[tokio::test]
async fn source_l142_disk_and_public_report_match_but_only_disk_carries_alarm_sent() {
    let f = Fixture::new();
    let result = f.run(Some("sample-agent")).await;
    assert_eq!(result.exit_code, 0, "{:?}", result.report);
    assert_eq!(result.report.scope, "named");
    let disk = f.report();
    let public = to_public_report(&result.report);
    assert_eq!(public.scope, disk.scope);
    assert_eq!(public.agents, disk.agents);
    assert_eq!(disk.alarm_sent, Some(true));
    assert!(serde_json::to_value(public)
        .unwrap()
        .get("alarmSent")
        .is_none());
    assert_eq!(result.report.agents[0].status, "ok");
}
#[tokio::test]
async fn source_l154_json_in_paths_is_not_a_parse_error_and_jsonc_comments_or_blank_files_install()
{
    assert_eq!(
        classify_deploy_error("cannot write /tmp/settings.json: EACCES"),
        "deploy-failed"
    );
    assert_eq!(
        classify_deploy_error("denied (os error 13)"),
        "deploy-failed"
    );
    assert_eq!(
        classify_deploy_error("SyntaxError: Unexpected token"),
        "invalid-settings"
    );
    let f = Fixture::new();
    let path = f.home.join("settings.json");
    std::fs::write(&path, "{ /* keep */ }\n").unwrap();
    let commented = f.run(Some("sample-agent")).await;
    assert_eq!(commented.exit_code, 0, "{:?}", commented.report);
    assert_eq!(commented.report.agents[0].reason, None);
    std::fs::write(&path, "   \n").unwrap();
    let empty = f.run(Some("sample-agent")).await;
    assert_eq!(empty.report.agents[0].status, "ok");
    assert_eq!(empty.report.agents[0].reason, None);
}
#[tokio::test]
async fn source_l182_custom_kiro_home_keeps_agent_subdirectory_and_cli_settings_together() {
    let f = Fixture::new();
    let default = f.root.join("default-kiro");
    let custom = f.root.join("custom-kiro");
    let value = json!({"id":"kiro-cli","displayName":"Kiro","deployMode":"hook","detection":{"paths":[default],"commands":[]},"hook":{"settingsPath":default.join("agents/pilot-kiro.json"),"events":["stop"],"hookCommand":"$PILOT_DATA/hooks/kiro-cli-hook.sh","format":"flat","matcher":"*","eventSubcommand":"as-is","kiroAgent":{"name":"pilot-kiro","tools":["read"]}}});
    f.definition("kiro-cli", &value);
    for suffix in ["sh", "ps1"] {
        std::fs::write(
            f.pilot.join(format!("assets/hooks/kiro-cli-hook.{suffix}")),
            "fixture",
        )
        .unwrap();
    }
    let def: AgentDefinition = serde_json::from_value(value).unwrap();
    let placed = definition_at_install_home(&def, custom.to_str().unwrap()).unwrap();
    assert_eq!(
        placed.hook.unwrap().settings_path,
        custom.join("agents/pilot-kiro.json").to_string_lossy()
    );
    let mut opts = f.options(Some("kiro-cli"));
    opts.homes
        .insert("kiro-cli".into(), custom.to_string_lossy().into_owned());
    let result = run_hook_install(opts).await;
    assert_eq!(result.exit_code, 0, "{:?}", result.report);
    assert_eq!(
        result.report.agents[0].settings_path.as_deref(),
        custom.join("agents/pilot-kiro.json").to_str()
    );
    assert!(std::fs::read_to_string(custom.join("settings/cli.json"))
        .unwrap()
        .contains("pilot-kiro"));
    assert!(!default.join("agents/pilot-kiro.json").exists());
}
#[tokio::test]
async fn source_l224_real_plugin_configuration_is_written_only_under_the_explicit_home() {
    let f = Fixture::new();
    let default = f.root.join("default-opencode");
    let custom = f.root.join("custom-opencode");
    let plugin = f.root.join("pilot-plugin.mjs");
    std::fs::write(&plugin, "export default {};").unwrap();
    let spec = reqwest::Url::from_file_path(&plugin).unwrap().to_string();
    f.definition("opencode",&json!({"id":"opencode","displayName":"OpenCode","deployMode":"plugin-inject","detection":{"paths":[default],"commands":[]},"pluginInject":{"createIfMissing":true,"configPaths":[default.join("opencode.jsonc")],"pluginSpec":spec,"pluginId":"loongsuite-pilot-opencode"}}));
    let mut opts = f.options(Some("opencode"));
    opts.homes
        .insert("opencode".into(), custom.to_string_lossy().into_owned());
    let result = run_hook_install(opts).await;
    assert_eq!(result.exit_code, 0, "{:?}", result.report);
    assert!(custom.join("opencode.jsonc").is_file());
    assert!(!default.join("opencode.jsonc").exists());
}
#[tokio::test]
async fn source_l248_missing_hook_is_not_detected_until_a_successful_install_record_exists() {
    let f = Fixture::new();
    let mut opts = f.options(Some("sample-agent"));
    opts.mode = "status";
    opts.write_result = false;
    let result = run_hook_install(opts).await;
    assert_eq!(
        result.report.agents[0].reason.as_deref(),
        Some("not-detected")
    );
    assert!(!f.data.join("deployed-agents.json").exists());
}
#[tokio::test]
async fn source_l253_l282_named_reports_merge_through_full_detection_without_rewriting_earlier_settings(
) {
    for detect_between in [false, true] {
        let f = Fixture::new();
        let first = f.run(Some("sample-agent")).await;
        assert_eq!(first.exit_code, 0, "{:?}", first.report);
        assert_eq!(first.report.scope, "named");
        let settings = std::fs::read(f.home.join("settings.json")).unwrap();
        if detect_between {
            let detected = f.run(None).await;
            assert_eq!(detected.exit_code, 0);
            assert_eq!(f.report().scope, "named");
            assert!(f.report().agents.iter().any(
                |a| a.id == "sample-agent" && matches!(a.status.as_str(), "ok" | "up-to-date")
            ));
        }
        let other = f.root.join("other-home");
        f.add_hook("other-agent", &other);
        let second = f.run(Some("other-agent")).await;
        assert_eq!(second.exit_code, 0, "{:?}", second.report);
        assert_eq!(
            std::fs::read(f.home.join("settings.json")).unwrap(),
            settings
        );
        let disk = f.report();
        assert_eq!(disk.scope, "named");
        for id in ["sample-agent", "other-agent"] {
            assert!(disk
                .agents
                .iter()
                .any(|a| a.id == id && matches!(a.status.as_str(), "ok" | "up-to-date")));
        }
    }
}
#[tokio::test]
async fn source_state_l60_keeps_the_complete_daemon_record_and_sets_hook_install_ownership() {
    let f = Fixture::new();
    let daemon =
        json!({"deployMode":"hook","deployedAt":"2020-01-01T00:00:00.000Z","installedBy":"daemon"});
    std::fs::write(
        f.data.join("deployed-agents.json"),
        serde_json::to_vec(&json!({"daemon-agent":daemon})).unwrap(),
    )
    .unwrap();
    let result = f.run(Some("sample-agent")).await;
    assert_eq!(result.exit_code, 0, "{:?}", result.report);
    let state: Value =
        serde_json::from_slice(&std::fs::read(f.data.join("deployed-agents.json")).unwrap())
            .unwrap();
    assert_eq!(state["daemon-agent"], daemon);
    assert_eq!(state["sample-agent"]["installedBy"], "hook-install");
}
#[tokio::test]
async fn source_idempotency_l65_preserves_exact_settings_bytes_and_mtime_then_repairs_only_damage()
{
    let f = Fixture::new();
    let first = f.run(Some("sample-agent")).await;
    assert_eq!(first.report.agents[0].status, "ok");
    let path = f.home.join("settings.json");
    let bytes = std::fs::read(&path).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let second = f.run(Some("sample-agent")).await;
    assert_eq!(second.report.agents[0].status, "up-to-date");
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    std::fs::write(&path, "{}\n").unwrap();
    let third = f.run(Some("sample-agent")).await;
    assert_eq!(third.report.agents[0].status, "ok");
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_ne!(std::fs::read(&path).unwrap(), b"{}\n");
}
#[tokio::test]
async fn source_l326_l345_alarm_marks_cannot_replace_current_install_generation() {
    let f = Fixture::new();
    f.run(Some("sample-agent")).await;
    let path = f.data.join(HOOK_INSTALL_RESULT_FILE);
    let mut old = f.report();
    old.ts = "2020-01-01T00:00:00.000Z".into();
    old.alarm_sent = Some(false);
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let (installed, marked) = tokio::join!(
        f.run(Some("sample-agent")),
        mark_hook_install_alarm_sent(path.to_str().unwrap(), &old.ts)
    );
    assert_eq!(installed.exit_code, 0);
    marked.unwrap();
    let disk = f.report();
    assert_ne!(disk.ts, old.ts);
    assert!(disk.agents.iter().any(|a| a.id == "sample-agent"));
    let mut new_report = disk.clone();
    new_report.alarm_sent = Some(false);
    std::fs::write(&path, serde_json::to_vec(&new_report).unwrap()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(
        mark_hook_install_alarm_sent(path.to_str().unwrap(), &old.ts)
            .await
            .unwrap(),
        "stale"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let current = f.report();
    assert_eq!(current.ts, disk.ts);
    assert_eq!(current.alarm_sent, Some(false));
}
