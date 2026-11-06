#![cfg(unix)]

use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;

struct World {
    _temp: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    defs: PathBuf,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("private home");
        let data = home.join("pilot data");
        let defs = home.join("definitions");
        std::fs::create_dir_all(&defs).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(home.join(".copilot")).unwrap();
        std::fs::write(home.join(".bashrc"), "export USER_SETTING=preserved\n").unwrap();
        Self {
            _temp: temp,
            home,
            data,
            defs,
        }
    }
    fn manager(&self) -> DeploymentManager {
        let mut manager = DeploymentManager::new(DeploymentManagerOptions {
            data_dir: self.data.to_string_lossy().into_owned(),
            pilot_dir: self.home.to_string_lossy().into_owned(),
            builtin_agents_dir: Some(self.defs.to_string_lossy().into_owned()),
            installed_by: None,
        });
        // Exercise the real registration strategy with an explicit private
        // HOME. The declaration's command is external, so no packaged Hook
        // assets are needed for these manager lifecycle contracts.
        manager.copilot = CopilotPluginStrategy::new(&self.data).with_home_dir(&self.home);
        manager
    }
    fn definition(&self) -> AgentDefinition {
        let root = self.home.join(".copilot");
        serde_json::from_value(json!({
            "id":"copilot","displayName":"Copilot","deployMode":"copilot-plugin",
            "detection":{"paths":[root],"commands":[]},
            "copilotPlugin":{
                "pluginRoot":root.join("installed-plugins/pilot/pilot"),"pluginId":"pilot",
                "settingsPath":root.join("settings.json"),"configPath":root.join("config.json"),
                "events":["sessionStart"],"hookCommand":self.home.join("external-copilot.sh"),
                "format":"nested"
            }
        }))
        .unwrap()
    }
    fn save(&self, def: &AgentDefinition) {
        std::fs::write(
            self.defs.join("copilot.json"),
            serde_json::to_vec(def).unwrap(),
        )
        .unwrap();
    }
    fn state(&self) -> Value {
        std::fs::read(self.data.join("deployed-agents.json"))
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
            .unwrap_or_else(|_| json!({}))
    }
}

#[tokio::test]
async fn main_l245_disabled_copilot_cleans_real_registrations_assets_and_shell_only_after_retry() {
    let world = World::new();
    let def = world.definition();
    let config = def.copilot_plugin.as_ref().unwrap();
    world.save(&def);
    let manager = world.manager();
    let initial = manager.deploy_all(None).await;
    assert!(initial[0].success, "{initial:?}");
    assert!(manager.has_record("copilot"));
    let plugin = Path::new(&config.plugin_root).join("plugin.json");
    assert!(plugin.is_file());
    assert!(std::fs::read_to_string(world.home.join(".bashrc"))
        .unwrap()
        .contains("loongsuite-pilot copilot otel"));
    std::fs::write(&config.config_path, "{broken").unwrap();
    assert!(!manager.deploy_all(Some(&|_| false)).await[0].success);
    assert!(manager.has_record("copilot"));
    assert!(plugin.is_file());
    assert!(world.data.join("state/copilot/otel-enabled").is_file());
    std::fs::write(&config.config_path, "{}").unwrap();
    assert!(manager.deploy_all(Some(&|_| false)).await[0].success);
    assert!(!manager.has_record("copilot"));
    assert!(world.state().get("copilot").is_none());
    assert!(!Path::new(&config.plugin_root).exists());
    assert!(!world.data.join("state/copilot/otel-enabled").exists());
    let profile = std::fs::read_to_string(world.home.join(".bashrc")).unwrap();
    assert!(profile.contains("export USER_SETTING=preserved"));
    assert!(!profile.contains("loongsuite-pilot copilot otel"));
    let settings: Value =
        serde_json::from_slice(&std::fs::read(&config.settings_path).unwrap()).unwrap();
    assert!(settings["enabledPlugins"].get("pilot@pilot").is_none());
}

#[tokio::test]
async fn main_l261_actual_post_write_failure_survives_restart_and_uses_persisted_cleanup_targets() {
    let world = World::new();
    let def = world.definition();
    let config = def.copilot_plugin.as_ref().unwrap();
    world.save(&def);
    // A real filesystem obstruction fails install_shell after both external
    // configs and the complete owned plugin have already been written.
    let obstruction = world.data.join("state/copilot/otel");
    std::fs::create_dir_all(obstruction.parent().unwrap()).unwrap();
    std::fs::write(&obstruction, "unknown user file\n").unwrap();
    assert!(!world.manager().deploy_all(None).await[0].success);
    let state = world.state();
    assert_eq!(state["copilot"]["targetDir"], config.plugin_root);
    assert_eq!(state["copilot"]["hookSettingsPath"], config.settings_path);
    assert_eq!(
        state["copilot"]["pluginInjectConfigPath"],
        config.config_path
    );
    assert!(Path::new(&config.plugin_root).join("plugin.json").is_file());
    let settings: Value =
        serde_json::from_slice(&std::fs::read(&config.settings_path).unwrap()).unwrap();
    assert_eq!(settings["enabledPlugins"]["pilot@pilot"], true);
    std::fs::write(&config.config_path, "{broken").unwrap();
    let restarted = world.manager();
    assert!(!restarted.deploy_all(Some(&|_| false)).await[0].success);
    assert!(restarted.has_record("copilot"));
    std::fs::write(&config.config_path, "{}").unwrap();
    let mut moved = def.clone();
    let fresh = world.home.join("must-not-create-new-target");
    let moved_config = moved.copilot_plugin.as_mut().unwrap();
    moved_config.plugin_root = fresh.join("plugin").to_string_lossy().into_owned();
    moved_config.settings_path = fresh.join("settings.json").to_string_lossy().into_owned();
    moved_config.config_path = fresh.join("config.json").to_string_lossy().into_owned();
    world.save(&moved);
    assert!(world.manager().deploy_all(Some(&|_| false)).await[0].success);
    assert!(world.state().get("copilot").is_none());
    assert!(!Path::new(&config.plugin_root).exists());
    assert!(!fresh.exists());
    assert_eq!(
        std::fs::read_to_string(obstruction).unwrap(),
        "unknown user file\n"
    );
    let settings: Value =
        serde_json::from_slice(&std::fs::read(&config.settings_path).unwrap()).unwrap();
    assert!(settings["enabledPlugins"].get("pilot@pilot").is_none());
}

#[tokio::test]
async fn main_l287_validation_only_failure_has_no_cleanup_record_and_repair_becomes_up_to_date() {
    let world = World::new();
    let def = world.definition();
    let config = def.copilot_plugin.as_ref().unwrap();
    world.save(&def);
    std::fs::write(&config.settings_path, "{invalid").unwrap();
    let manager = world.manager();
    assert!(!manager.deploy_all(None).await[0].success);
    assert!(!manager.has_record("copilot"));
    assert!(world.state().get("copilot").is_none());
    assert!(!Path::new(&config.plugin_root).exists());
    assert!(!world.data.join("state/copilot/otel-enabled").exists());
    std::fs::write(&config.settings_path, "{}").unwrap();
    std::fs::remove_file(world.home.join(".bashrc")).unwrap();
    std::fs::create_dir(world.home.join(".bashrc")).unwrap();
    assert!(!manager.deploy_all(None).await[0].success);
    // Native validation catches this old Node partial-install trigger before
    // external writes. A real post-write failure is covered independently.
    assert!(!manager.has_record("copilot"));
    assert!(!Path::new(&config.plugin_root).exists());
    std::fs::remove_dir(world.home.join(".bashrc")).unwrap();
    std::fs::write(
        world.home.join(".bashrc"),
        "export USER_SETTING=preserved\n",
    )
    .unwrap();
    assert!(world.manager().deploy_all(None).await[0].success);
    assert!(world.state().get("copilot").is_some());
    let healthy = world.manager().deploy_all(None).await;
    assert!(healthy[0].success);
    assert_eq!(healthy[0].reason, Some(DeploySkipReason::UpToDate));
}
