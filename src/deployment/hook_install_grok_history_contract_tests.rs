use super::*;
use serde_json::json;
#[cfg(unix)]
use serde_json::Value;
struct World {
    _temp: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
    defs: PathBuf,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let data = root.join("data");
        let defs = root.join("agents.d");
        std::fs::create_dir_all(&defs).unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/grok-build.json")).unwrap();
        let missing = root.join("missing-grok-home");
        def.detection.paths = vec![missing.to_string_lossy().into_owned()];
        def.detection.commands.clear();
        def.hook.as_mut().unwrap().settings_path = missing
            .join("hooks/loongsuite-pilot.json")
            .to_string_lossy()
            .into_owned();
        std::fs::write(
            defs.join("grok-build.json"),
            serde_json::to_vec(&def).unwrap(),
        )
        .unwrap();
        Self {
            _temp: temp,
            root,
            data,
            defs,
        }
    }
    fn options(&self, home: &Path) -> HookInstallRunOptions<'static> {
        HookInstallRunOptions {
            data_dir: self.data.to_string_lossy().into_owned(),
            pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
            builtin_agents_dir: Some(self.defs.to_string_lossy().into_owned()),
            agents_flag: Some("grok-build".into()),
            env_agents: None,
            homes: HashMap::from([("grok-build".into(), home.to_string_lossy().into_owned())]),
            write_result: true,
            deploy_modes: None,
            enabled: None,
            euid: Some(1),
            identity: Some(ContainerIdentity {
                identity: "e".repeat(64),
                source: crate::utils::ContainerIdentitySource::Cgroup,
            }),
            mode: "install",
        }
    }
    async fn install(&self, home: &Path) -> HookInstallRunResult {
        run_hook_install(self.options(home)).await
    }
    fn settings(home: &Path) -> PathBuf {
        home.join("hooks/loongsuite-pilot.json")
    }
    #[cfg(unix)]
    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }
}
#[tokio::test]
async fn grok_l72_each_home_has_distinct_status_and_idempotent_settings_without_scope_redirection()
{
    let f = World::new();
    let first = f.root.join("u/aaa");
    let second = f.root.join("u/bbb");
    let initial = f.install(&first).await;
    assert_eq!(initial.exit_code, 0);
    assert_eq!(initial.report.agents[0].status, "ok");
    assert!(World::settings(&first).is_file());
    let mut status = f.options(&second);
    status.mode = "status";
    status.write_result = false;
    let unseen = run_hook_install(status).await;
    assert_ne!(unseen.report.agents[0].status, "ok");
    assert_eq!(
        unseen.report.agents[0].reason.as_deref(),
        Some("not-detected")
    );
    let installed = f.install(&second).await;
    assert_eq!(installed.report.agents[0].status, "ok");
    let second_bytes = std::fs::read(World::settings(&second)).unwrap();
    assert!(std::str::from_utf8(&second_bytes)
        .unwrap()
        .contains("grok-build-loongsuite-pilot-hook"));
    let before = std::fs::metadata(World::settings(&first))
        .unwrap()
        .modified()
        .unwrap();
    let repeated = f.install(&first).await;
    assert_eq!(repeated.report.agents[0].status, "up-to-date");
    assert_eq!(
        std::fs::metadata(World::settings(&first))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(
        std::fs::read(World::settings(&second)).unwrap(),
        second_bytes
    );
    let def: AgentDefinition =
        serde_json::from_slice(&std::fs::read(f.defs.join("grok-build.json")).unwrap()).unwrap();
    let record: crate::types::DeployedAgentRecord = serde_json::from_value(
        json!({"deployMode":"hook","deployedAt":"2020-01-01T00:00:00.000Z",
        "hookSettingsPath":World::settings(&first),"hookSettingsPaths":[World::settings(&first)]}),
    )
    .unwrap();
    let next = super::super::persisted_deploy_paths::apply_persisted_deploy_targets(
        &def,
        Some(&record),
        Some(
            &super::super::persisted_deploy_paths::PersistedTargetOptions {
                preserve_hook_settings: true,
                preserve_plugin_config: false,
            },
        ),
    )
    .unwrap();
    assert_eq!(
        next.hook.unwrap().settings_path,
        def.hook.unwrap().settings_path
    );
}
#[cfg(unix)]
#[tokio::test]
async fn grok_l117_root_other_owner_failure_keeps_first_home_bytes_and_success_report() {
    let f = World::new();
    let first = f.root.join("u/eee");
    let second = f.root.join("u/fff");
    assert_eq!(f.install(&first).await.exit_code, 0);
    let bytes = std::fs::read(World::settings(&first)).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let mut options = f.options(&second);
    options.euid = Some(0);
    let failed =
        super::history_contract_tests::with_owner_for_history(1000, run_hook_install(options))
            .await;
    assert_eq!(failed.exit_code, 1);
    assert_eq!(failed.report.agents[0].status, "failed");
    assert_eq!(std::fs::read(World::settings(&first)).unwrap(), bytes);
    assert!(!World::settings(&second).exists());
    let report = World::read(&f.data.join(HOOK_INSTALL_RESULT_FILE));
    assert!(report["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["id"] == "grok-build" && a["status"] == "ok"));
}
#[tokio::test]
async fn grok_l142_real_manager_repair_route_restores_every_recorded_settings_file() {
    let f = World::new();
    let first = f.root.join("u/ccc");
    let second = f.root.join("u/ddd");
    assert_eq!(f.install(&first).await.exit_code, 0);
    assert_eq!(f.install(&second).await.exit_code, 0);
    for home in [&first, &second] {
        std::fs::write(World::settings(home), "{}\n").unwrap();
    }
    let manager = super::super::DeploymentManager::new(super::super::DeploymentManagerOptions {
        data_dir: f.data.to_string_lossy().into_owned(),
        pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
        builtin_agents_dir: Some(f.defs.to_string_lossy().into_owned()),
        installed_by: Some(crate::types::InstalledBy::Daemon),
    });
    let defs = manager.load_definitions().await;
    let def = defs.iter().find(|d| d.id == "grok-build").unwrap();
    let repaired = manager.deploy_single(def).await;
    assert!(repaired.success, "{repaired:?}");
    for home in [&first, &second] {
        assert!(std::fs::read_to_string(World::settings(home))
            .unwrap()
            .contains("grok-build-loongsuite-pilot-hook"));
    }
}
