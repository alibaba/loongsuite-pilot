use super::*;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
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
        std::fs::create_dir_all(&data).unwrap();
        Self {
            _temp: temp,
            root,
            data,
            defs,
        }
    }
    fn manager(&self) -> DeploymentManager {
        DeploymentManager::new(DeploymentManagerOptions {
            data_dir: self.data.to_string_lossy().into_owned(),
            pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
            builtin_agents_dir: Some(self.defs.to_string_lossy().into_owned()),
            installed_by: None,
        })
    }
    fn save(&self, def: &AgentDefinition) {
        std::fs::write(
            self.defs.join(format!("{}.json", def.id)),
            serde_json::to_vec(def).unwrap(),
        )
        .unwrap();
    }
    fn hook(&self, id: &str, detected: bool) -> AgentDefinition {
        serde_json::from_value(json!({"id":id,"displayName":id,"deployMode":"hook",
        "detection":{"paths":[if detected {self.root.join("data")} else {self.root.join("missing-detection")}],"commands":[]},
        "hook":{"settingsPath":self.root.join(format!("{id}-hooks.json")),"events":["Stop"],
            "hookCommand":self.root.join(format!("{id}-external-hook.sh")),"format":"flat","rawCommand":true}})).unwrap()
    }
    fn settings(def: &AgentDefinition) -> &Path {
        Path::new(&def.hook.as_ref().unwrap().settings_path)
    }
    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }
    fn state(&self) -> Value {
        Self::read(&self.data.join("deployed-agents.json"))
    }
    fn pi(&self) -> AgentDefinition {
        let dir = self.root.join("pi-agent");
        std::fs::create_dir_all(&dir).unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
        def.detection.paths = vec![dir.to_string_lossy().into_owned()];
        def.detection.commands.clear();
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![dir.join("settings.json").to_string_lossy().into_owned()];
        def
    }
    fn directory(&self) -> AgentDefinition {
        let source = self.data.join("plugins/hermes-agent/loongsuite-pilot");
        let target = self.root.join("hermes-home/plugins/loongsuite-pilot");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(source.join("plugin.yaml"), "name: loongsuite-pilot\n").unwrap();
        serde_json::from_value(json!({"id":"hermes-agent","displayName":"Hermes Agent","deployMode":"directory-plugin",
            "detection":{"paths":[target.parent().unwrap()],"commands":[]},"directoryPlugin":{"sourceDir":source,"targetDir":target}})).unwrap()
    }
    fn dsh(&self, patch: Option<&Path>) -> AgentDefinition {
        let plugin = self.data.join("plugins/dsh/plugin.mjs");
        std::fs::create_dir_all(plugin.parent().unwrap()).unwrap();
        std::fs::write(&plugin, "export default function apply() {}\n").unwrap();
        serde_json::from_value(json!({"id":"dsh","displayName":"DSH","deployMode":"dsh-yaml-patch",
            "detection":{"paths":[self.root.join("missing-standard-home")],"commands":[]},
            "dshYamlPatch":{"pluginSource":plugin,"patchPath":patch,"entryId":"loongsuite-pilot-observability","marker":"PILOT-OBSERVABILITY-MANAGED"}})).unwrap()
    }
    fn dsh_manager(&self, home: &Path) -> DeploymentManager {
        self.manager()
            .with_test_dsh_locator(super::super::dsh_runtime_locator::DshRuntimeLocator {
                proc_root: self.root.join("no-proc").to_string_lossy().into_owned(),
                platform: std::env::consts::OS.into(),
                env: HashMap::from([("DSH_HOME".into(), home.to_string_lossy().into_owned())]),
                cwd: self.root.to_string_lossy().into_owned(),
                uid: None,
            })
    }
}
#[tokio::test]
async fn manager_l75_l98_l182_l190_l205_skip_reasons_are_distinct_and_a_real_second_install_is_up_to_date(
) {
    let f = World::new();
    let def = f.hook("cursor-test", true);
    f.save(&def);
    let manager = f.manager();
    let first = manager.deploy_all(None).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].agent_id, "cursor-test");
    assert!(first[0].success);
    assert_ne!(first[0].skipped, Some(true));
    assert!(World::settings(&def).is_file());
    let second = manager.deploy_all(None).await;
    assert!(second[0].success);
    assert_eq!(second[0].skipped, Some(true));
    assert_eq!(second[0].reason, Some(DeploySkipReason::UpToDate));
    let disabled = manager.deploy_all(Some(&|_| false)).await;
    assert!(disabled[0].success);
    assert_eq!(disabled[0].skipped, Some(true));
    assert_eq!(disabled[0].reason, Some(DeploySkipReason::Disabled));
    let absent = World::new();
    let def = absent.hook("missing-agent", false);
    absent.save(&def);
    let missing = absent.manager().deploy_all(None).await;
    assert_eq!(missing.len(), 1);
    assert!(missing[0].success);
    assert_eq!(missing[0].skipped, Some(true));
    assert_eq!(missing[0].reason, Some(DeploySkipReason::NotDetected));
    assert!(!World::settings(&def).exists());
}
#[tokio::test]
async fn manager_l121_l361_disabled_definitions_never_reach_detection_or_create_settings() {
    let f = World::new();
    let on = f.hook("enabled-agent", true);
    let off = f.hook("disabled-agent", true);
    f.save(&on);
    f.save(&off);
    let manager = f.manager();
    let results = manager
        .deploy_all(Some(&|def| def.id == "enabled-agent"))
        .await;
    assert_eq!(results.len(), 2);
    assert_eq!(
        manager
            .history_strategy_detection_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let skipped = results
        .iter()
        .find(|r| r.agent_id == "disabled-agent")
        .unwrap();
    assert_eq!(skipped.skipped, Some(true));
    assert!(World::settings(&on).exists());
    assert!(!World::settings(&off).exists());
    let never = World::new();
    let def = never.hook("never-deployed", true);
    never.save(&def);
    let manager = never.manager();
    let result = manager.deploy_all(Some(&|_| false)).await;
    assert_eq!(result[0].skipped, Some(true));
    assert_eq!(
        manager
            .history_strategy_detection_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert!(!World::settings(&def).exists());
    assert!(!never.data.join("hooks").exists());
}
#[tokio::test]
async fn manager_l214_l426_disable_removes_current_and_retired_hooks_from_the_recorded_file() {
    let f = World::new();
    let mut def = f.hook("retired-agent", true);
    def.hook.as_mut().unwrap().events.push("PreToolUse".into());
    f.save(&def);
    let manager = f.manager();
    assert!(manager.deploy_all(None).await[0].success);
    let value = World::read(World::settings(&def));
    assert!(value["hooks"].get("Stop").is_some());
    assert!(value["hooks"].get("PreToolUse").is_some());
    // Use the same platform-resolved command that the real deployment loaded.
    let command = manager
        .get_definitions()
        .into_iter()
        .find(|loaded| loaded.id == def.id)
        .unwrap()
        .hook
        .unwrap()
        .hook_command;
    assert!(std::fs::read_to_string(World::settings(&def))
        .unwrap()
        .contains(command.replace('\\', "\\\\").as_str()));
    def.hook.as_mut().unwrap().events = vec!["Stop".into()];
    def.hook.as_mut().unwrap().retired_events = Some(vec!["PreToolUse".into()]);
    f.save(&def);
    let result = manager.deploy_all(Some(&|_| false)).await;
    assert!(result[0].success);
    assert_eq!(result[0].skipped, Some(true));
    assert!(!std::fs::read_to_string(World::settings(&def))
        .unwrap()
        .contains(command.replace('\\', "\\\\").as_str()));
    assert!(!manager.has_record(&def.id));
}
#[tokio::test]
async fn manager_l386_failed_cleanup_retains_the_record_and_retries_until_success() {
    let f = World::new();
    let def = f.hook("retry-agent", true);
    f.save(&def);
    let manager = f.manager();
    assert!(manager.deploy_all(None).await[0].success);
    let settings = World::settings(&def);
    let saved = std::fs::read(settings).unwrap();
    std::fs::remove_file(settings).unwrap();
    std::fs::create_dir(settings).unwrap();
    for _ in 0..2 {
        let result = manager.deploy_all(Some(&|_| false)).await;
        assert!(!result[0].success);
        assert!(manager.has_record(&def.id));
        assert!(f.state().get(&def.id).is_some());
    }
    std::fs::remove_dir(settings).unwrap();
    std::fs::write(settings, saved).unwrap();
    assert!(manager.deploy_all(Some(&|_| false)).await[0].success);
    assert!(!manager.has_record(&def.id));
    std::fs::remove_file(settings).unwrap();
    assert!(manager.deploy_all(Some(&|_| false)).await[0].success);
    assert!(!settings.exists());
}
#[tokio::test]
async fn manager_l467_l499_one_real_install_failure_does_not_stop_other_definitions_or_lose_state()
{
    let f = World::new();
    let bad = f.hook("agent-bad", true);
    let good = f.hook("agent-ok", true);
    f.save(&bad);
    f.save(&good);
    std::fs::create_dir(World::settings(&bad)).unwrap();
    let results = f.manager().deploy_all(None).await;
    assert_eq!(results.len(), 2);
    assert!(
        !results
            .iter()
            .find(|r| r.agent_id == "agent-bad")
            .unwrap()
            .success
    );
    assert!(
        results
            .iter()
            .find(|r| r.agent_id == "agent-ok")
            .unwrap()
            .success
    );
    assert!(World::settings(&good).exists());
    assert_eq!(f.state()["agent-ok"]["deployMode"], json!("hook"));
}
#[tokio::test]
async fn manager_l245_explicit_dsh_patch_is_removed_with_collection_marker_on_disable() {
    let f = World::new();
    let patch = f.root.join("dsh-home/cordis.patch.yml");
    let def = f.dsh(Some(&patch));
    f.save(&def);
    let manager = f.dsh_manager(&f.root.join("unused-env-home"));
    assert!(manager.deploy_all(None).await[0].success);
    assert!(std::fs::read_to_string(&patch)
        .unwrap()
        .contains("PILOT-OBSERVABILITY-MANAGED"));
    let enabled = f.data.join("plugins/dsh/.collection-enabled");
    assert_eq!(std::fs::read(&enabled).unwrap(), b"enabled\n");
    let result = manager.deploy_all(Some(&|_| false)).await;
    assert!(result[0].success);
    assert_eq!(result[0].skipped, Some(true));
    assert!(!patch.exists());
    assert!(!enabled.exists());
    assert!(f.state().get("dsh").is_none());
}
#[tokio::test]
async fn manager_l280_l319_custom_dsh_home_beats_absent_standard_detection_and_recorded_path_beats_env_drift(
) {
    let f = World::new();
    let a = f.root.join("home-a");
    let b = f.root.join("home-b");
    let def = f.dsh(None);
    f.save(&def);
    assert!(!super::super::detect_utils::detect_agent(&def.detection).await);
    let manager = f.dsh_manager(&a);
    let result = manager.deploy_all(None).await;
    assert!(result[0].success);
    assert_ne!(result[0].skipped, Some(true));
    let patch = a.join("cordis.patch.yml");
    assert!(std::fs::read_to_string(&patch)
        .unwrap()
        .contains("PILOT-OBSERVABILITY-MANAGED"));
    assert_eq!(f.state()["dsh"]["dshPatchPath"], json!(patch));
    let drifted = f.dsh_manager(&b);
    let result = drifted.deploy_all(Some(&|_| false)).await;
    assert!(result[0].success);
    assert_eq!(result[0].skipped, Some(true));
    assert!(!patch.exists());
    assert!(!b.join("cordis.patch.yml").exists());
}
#[tokio::test]
async fn manager_l523_recorded_grok_settings_survive_definition_home_drift() {
    let f = World::new();
    let mut def: AgentDefinition =
        serde_json::from_str(include_str!("../../agents.d/grok-build.json")).unwrap();
    let home = f.root.join("custom-grok");
    std::fs::create_dir_all(&home).unwrap();
    def.detection.paths = vec![home.to_string_lossy().into_owned()];
    def.detection.commands.clear();
    let settings = home.join("hooks/loongsuite-pilot.json");
    def.hook.as_mut().unwrap().settings_path = settings.to_string_lossy().into_owned();
    def.hook.as_mut().unwrap().hook_command = f
        .data
        .join("hooks/grok-build-loongsuite-pilot-hook.sh")
        .to_string_lossy()
        .into_owned();
    f.save(&def);
    let manager = f.manager();
    let results = manager.deploy_all(None).await;
    assert!(results[0].success, "{results:?}");
    // Real callers keep the manager's loaded definition; only its target home drifts.
    def = manager
        .get_definitions()
        .into_iter()
        .find(|loaded| loaded.id == "grok-build")
        .unwrap();
    assert_eq!(
        f.state()["grok-build"]["hookSettingsPath"],
        json!(node_resolve(settings.to_str().unwrap()))
    );
    let value = World::read(&settings);
    let hooks = value["hooks"]["stop"].as_array().unwrap();
    assert!(hooks.iter().any(|m| m["matcher"] == json!("")
        && m["hooks"].as_array().unwrap().iter().any(|h| h["command"]
            .as_str()
            .unwrap()
            .contains("grok-build-loongsuite-pilot-hook"))));
    let drift = f.root.join("default-grok/hooks/loongsuite-pilot.json");
    def.hook.as_mut().unwrap().settings_path = drift.to_string_lossy().into_owned();
    assert!(manager.undeploy_agent(&def).await);
    assert!(World::read(&settings)["hooks"].get("stop").is_none());
    assert!(!drift.exists());
}
#[tokio::test]
async fn manager_l569_recorded_pi_config_survives_definition_home_drift() {
    let f = World::new();
    let def = f.pi();
    f.save(&def);
    let manager = f.manager();
    assert!(manager.deploy_all(None).await[0].success);
    let path = Path::new(&def.plugin_inject.as_ref().unwrap().config_paths[0]);
    assert_eq!(
        f.state()["pi-coding-agent"]["pluginInjectConfigPath"],
        json!(node_resolve(path.to_str().unwrap()))
    );
    let spec = manager
        .inject
        .resolve_existing_config_path(def.plugin_inject.as_ref().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(node_resolve(&spec), node_resolve(path.to_str().unwrap()));
    let own = f
        .data
        .join("plugins/pi-coding-agent/index.mjs")
        .to_string_lossy()
        .replace('\\', "/");
    assert!(World::read(path)["extensions"]
        .as_array()
        .unwrap()
        .contains(&json!(own)));
    let mut drift = def.clone();
    let missing = f.root.join("default-pi/settings.json");
    drift.plugin_inject.as_mut().unwrap().config_paths =
        vec![missing.to_string_lossy().into_owned()];
    assert!(manager.undeploy_agent(&drift).await);
    assert!(!World::read(path)["extensions"]
        .as_array()
        .unwrap()
        .contains(&json!(own)));
    assert!(!missing.exists());
}
#[tokio::test]
async fn manager_l721_l911_l928_empty_and_loaded_definition_public_views_are_exact() {
    let f = World::new();
    let manager = f.manager();
    assert!(manager.get_definitions().is_empty());
    assert!(manager.deploy_all(None).await.is_empty());
    assert!(manager.get_definitions().is_empty());
    let def = f.hook("def-test", true);
    f.save(&def);
    manager.deploy_all(None).await;
    let defs = manager.get_definitions();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].id, "def-test");
}
#[tokio::test]
async fn manager_l727_l764_l785_routes_real_directory_plugin_and_serializes_duplicate_public_deploys(
) {
    let f = World::new();
    let def = f.directory();
    f.save(&def);
    let manager = f.manager();
    let (one, two) = tokio::join!(manager.deploy_single(&def), manager.deploy_single(&def));
    assert!(one.success && two.success, "{one:?} {two:?}");
    assert_eq!(one.agent_id, "hermes-agent");
    assert_eq!(
        [one.skipped, two.skipped]
            .into_iter()
            .filter(|v| *v == Some(true))
            .count(),
        1
    );
    let target = Path::new(&def.directory_plugin.as_ref().unwrap().target_dir);
    let marker = World::read(&target.join(".loongsuite-pilot-managed.json"));
    assert_eq!(marker["owner"], json!("loongsuite-pilot"));
    assert_eq!(marker["agentId"], json!("hermes-agent"));
    assert_eq!(
        f.state()["hermes-agent"]["deployMode"],
        json!("directory-plugin")
    );
    assert_eq!(
        f.state()["hermes-agent"]["targetDir"],
        json!(node_resolve(target.to_str().unwrap()))
    );
    let again = World::new();
    let def = again.directory();
    again.save(&def);
    let result = again.manager().deploy_all(None).await;
    assert_eq!(result.len(), 1);
    assert!(result[0].success);
    assert_eq!(result[0].deploy_mode, DeployMode::DirectoryPlugin);
    let single = f.hook("single-test", true);
    let result = manager.deploy_single(&single).await;
    assert!(result.success);
    assert_eq!(result.agent_id, "single-test");
}
#[tokio::test]
async fn manager_l820_concurrent_public_deployments_keep_both_real_state_updates() {
    let f = World::new();
    let manager = Arc::new(f.manager());
    let a = f.hook("agent-a", true);
    let b = f.hook("agent-b", true);
    // Both actual public operations must enter the same exclusion gate.
    // Holding it makes the boundary observable without mocking deployAgent.
    let gate = manager.gate.lock().await;
    let both = async { tokio::join!(manager.deploy_single(&a), manager.deploy_single(&b)) };
    tokio::pin!(both);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), &mut both)
            .await
            .is_err()
    );
    assert!(!World::settings(&a).exists());
    assert!(!World::settings(&b).exists());
    drop(gate);
    let (one, two) = tokio::time::timeout(std::time::Duration::from_secs(2), both)
        .await
        .unwrap();
    assert!(one.success && two.success);
    let state = f.state();
    for id in ["agent-a", "agent-b"] {
        assert_eq!(state[id]["deployMode"], json!("hook"));
    }
    assert!(World::settings(&a).exists());
    assert!(World::settings(&b).exists());
    assert!(manager.gate.try_lock().is_ok());
}
#[tokio::test]
async fn manager_l870_l881_l891_l898_real_plugin_health_requires_owned_bundle_and_exact_reference()
{
    let f = World::new();
    let def = f.pi();
    let manager = f.manager();
    let path = Path::new(&def.plugin_inject.as_ref().unwrap().config_paths[0]);
    assert!(manager.needs_redeploy(&def, None).await);
    assert!(manager.deploy_single(&def).await.success);
    assert!(!manager.needs_redeploy(&def, None).await);
    std::fs::write(path, r#"{"extensions":["some-other-plugin"]}"#).unwrap();
    assert!(manager.needs_redeploy(&def, None).await);
    std::fs::write(
        path,
        r#"{"extensions":["loongsuite-pilot-pi-coding-agent@1.2.3"]}"#,
    )
    .unwrap();
    assert!(manager.needs_redeploy(&def, None).await);
    std::fs::remove_file(path).unwrap();
    assert!(manager.needs_redeploy(&def, None).await);
}
#[tokio::test]
async fn manager_l606_l675_stale_recorded_pi_path_does_not_silently_adopt_another_home() {
    for injected in [false, true] {
        let f = World::new();
        let def = f.pi();
        f.save(&def);
        let current = PathBuf::from(&def.plugin_inject.as_ref().unwrap().config_paths[0]);
        let stale = f.root.join("stale-pi").join("settings.json");
        let manager = f.manager();
        assert!(manager.deploy_single(&def).await.success);
        let spec = f
            .data
            .join("plugins/pi-coding-agent/index.mjs")
            .to_string_lossy()
            .replace('\\', "/");
        let other = f
            .root
            .join("another-install/plugins/pi-coding-agent/index.mjs");
        let foreign = if injected {
            json!({"extensions":[spec,other,"/opt/third-party/extension.mjs"]})
        } else {
            json!({"extensions":[other,"/opt/third-party/extension.mjs"]})
        };
        std::fs::write(&current, serde_json::to_vec(&foreign).unwrap()).unwrap();
        let before = std::fs::read(&current).unwrap();
        let mut state = f.state();
        state["pi-coding-agent"]["pluginInjectConfigPath"] = json!(stale);
        std::fs::write(
            f.data.join("deployed-agents.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        let result = f.manager().deploy_all(None).await;
        assert!(!result[0].success);
        assert_eq!(std::fs::read(&current).unwrap(), before);
        assert_eq!(
            f.state()["pi-coding-agent"]["pluginInjectConfigPath"],
            json!(node_resolve(stale.to_str().unwrap()))
        );
        assert_eq!(World::read(&current), foreign);
    }
}

#[path = "pi_config_relocation_history_tests.rs"]
mod pi_relocation_tests;
