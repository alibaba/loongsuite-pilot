use super::*;
use serde_json::json;

const EVENTS: [&str; 7] = [
    "sessionStart",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "sessionEnd",
    "agentStop",
];
const COMMAND: &str = "/tmp/pilot-data/hooks/copilot-loongsuite-pilot-hook.sh";

fn definition(home: &Path) -> AgentDefinition {
    let root = home.join(".copilot");
    serde_json::from_value(json!({
        "id":"copilot","displayName":"GitHub Copilot CLI","deployMode":"copilot-plugin",
        "detection":{"paths":[root],"commands":[]},
        "copilotPlugin":{
            "pluginRoot":root.join("installed-plugins/loongsuite-pilot/loongsuite-pilot"),
            "pluginId":"loongsuite-pilot","settingsPath":root.join("settings.json"),
            "configPath":root.join("config.json"),"events":EVENTS,
            "hookCommand":COMMAND,"format":"nested","eventSubcommand":"kebab-case","timeoutSec":5
        }
    }))
    .unwrap()
}

#[test]
fn main_l53_manifest_has_the_exact_agent_plugins_shape() {
    let manifest = build_copilot_plugin_manifest();
    assert_eq!(manifest["name"], "loongsuite-pilot");
    assert_eq!(manifest["version"], "0.1.0");
    assert_eq!(manifest["hooks"], "hooks/hooks.json");
    assert_eq!(manifest["author"]["name"], "loongsuite-pilot");
    assert_eq!(manifest["license"], "Apache-2.0");
}

#[test]
fn main_l62_l74_l82_all_seven_camelcase_events_have_exact_timeouts_and_bare_or_kebab_commands() {
    let def = definition(Path::new("/fixtures"));
    let mut config = def.copilot_plugin.unwrap();
    let hooks = build_copilot_plugin_hooks(&config);
    assert_eq!(hooks["version"], 1);
    let mut actual = hooks["hooks"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    actual.sort();
    let mut expected = EVENTS.map(str::to_owned).to_vec();
    expected.sort();
    assert_eq!(actual, expected);
    for event in EVENTS {
        let entries = hooks["hooks"][event].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["type"], "command");
        assert_eq!(entries[0]["timeoutSec"], 5);
    }
    for (event, suffix) in [
        ("sessionStart", "session-start"),
        ("userPromptSubmitted", "user-prompt-submitted"),
        ("postToolUseFailure", "post-tool-use-failure"),
    ] {
        assert_eq!(
            hooks["hooks"][event][0]["command"],
            format!("{COMMAND} {suffix}")
        );
    }
    config.event_subcommand = None;
    let bare = build_copilot_plugin_hooks(&config);
    for event in EVENTS {
        assert_eq!(bare["hooks"][event][0]["command"], COMMAND);
    }
}

#[tokio::test]
async fn main_l275_missing_configuration_has_the_original_clear_diagnostic_and_no_assets() {
    let temp = tempfile::tempdir().unwrap();
    let mut def = definition(temp.path());
    def.copilot_plugin = None;
    let strategy = CopilotPluginStrategy::new(temp.path().join("data")).with_home_dir(temp.path());
    let result = strategy.deploy(&def).await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("missing copilotPlugin"));
    assert!(!temp.path().join(".copilot").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn main_l269_windows_rejects_automatic_copilot_deployment_without_creating_a_plugin() {
    let temp = tempfile::tempdir().unwrap();
    let def = definition(temp.path());
    let config = def.copilot_plugin.as_ref().unwrap();
    let strategy = CopilotPluginStrategy::new(temp.path().join("data")).with_home_dir(temp.path());
    assert!(!strategy.detect(&def).await);
    assert!(!strategy.deploy(&def).await.success);
    assert!(!Path::new(&config.plugin_root).exists());
}

#[cfg(unix)]
mod unix {
    use super::*;
    use serde_json::Value;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;
    use std::time::Duration;

    struct World {
        _temp: tempfile::TempDir,
        home: PathBuf,
        data: PathBuf,
        def: AgentDefinition,
    }
    impl World {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("private home");
            std::fs::create_dir_all(home.join(".copilot")).unwrap();
            std::fs::write(home.join(".bashrc"), "export USER_SETTING=preserved\n").unwrap();
            let data = home.join("pilot's data");
            let def = definition(&home);
            Self {
                _temp: temp,
                home,
                data,
                def,
            }
        }
        fn strategy(&self) -> CopilotPluginStrategy {
            CopilotPluginStrategy::new(&self.data).with_home_dir(&self.home)
        }
        fn config(&self) -> &CopilotPluginHookConfig {
            self.def.copilot_plugin.as_ref().unwrap()
        }
        fn json(&self, path: &str) -> Value {
            parse_json_document(&std::fs::read_to_string(path).unwrap(), JsonSyntax::Jsonc).unwrap()
        }
        async fn activate(&self, extra: &[(&str, &str)]) -> String {
            let mut command = tokio::process::Command::new("bash");
            command
                .args(["--noprofile", "--rcfile"])
                .arg(self.home.join(".bashrc"))
                .arg("-ic")
                .arg(concat!(
                    "printf '%s' \"$",
                    "{COPILOT_OTEL_FILE_EXPORTER_PATH-unset}\""
                ))
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .env("HOME", &self.home)
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            for (key, value) in extra {
                command.env(key, value);
            }
            let output = command.output().await.unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap()
        }
    }
    async fn within_original_five_second_budget(future: impl std::future::Future<Output = ()>) {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("original test deadline");
    }

    #[tokio::test]
    async fn main_l113_to_l186_l260_real_package_registration_repair_idempotency_and_uninstall() {
        let world = World::new();
        let strategy = world.strategy();
        let config = world.config();
        assert!(strategy.needs_deploy(&world.def, None).await);
        let result = strategy.deploy(&world.def).await;
        assert!(result.success, "{result:?}");
        assert_eq!(result.deploy_mode, DeployMode::CopilotPlugin);
        let root = Path::new(&config.plugin_root);
        let manifest = world.json(root.join("plugin.json").to_str().unwrap());
        assert_eq!(manifest["name"], "loongsuite-pilot");
        assert_eq!(manifest["hooks"], "hooks/hooks.json");
        let hooks = world.json(root.join("hooks/hooks.json").to_str().unwrap());
        assert_eq!(hooks["version"], 1);
        assert_eq!(hooks["hooks"].as_object().unwrap().len(), 7);
        assert_eq!(
            hooks["hooks"]["sessionStart"][0]["command"],
            format!("{COMMAND} session-start")
        );
        assert_eq!(
            world.json(&config.settings_path)["enabledPlugins"],
            json!({"loongsuite-pilot@loongsuite-pilot":true})
        );
        let installed = world.json(&config.config_path);
        let entry = installed["installedPlugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "loongsuite-pilot")
            .unwrap();
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["cache_path"], config.plugin_root);
        assert!(!strategy.needs_deploy(&world.def, None).await);
        std::fs::remove_file(root.join("plugin.json")).unwrap();
        assert!(strategy.needs_deploy(&world.def, None).await);
        assert!(strategy.deploy(&world.def).await.success);
        std::fs::write(root.join("hooks/hooks.json"), "{\"version\":1}").unwrap();
        assert!(strategy.needs_deploy(&world.def, None).await);
        assert!(strategy.deploy(&world.def).await.success);
        assert!(!strategy.needs_deploy(&world.def, None).await);
        std::fs::write(&config.settings_path, "{}").unwrap();
        assert!(strategy.needs_deploy(&world.def, None).await);
        assert!(strategy.deploy(&world.def).await.success);
        std::fs::write(
            &config.config_path,
            "{\"installedPlugins\":[{\"name\":\"other\"}]}",
        )
        .unwrap();
        assert!(strategy.needs_deploy(&world.def, None).await);
        assert!(strategy.deploy(&world.def).await.success);
        assert!(!strategy.needs_deploy(&world.def, None).await);
        assert!(strategy.deploy(&world.def).await.success);
        let settings = world.json(&config.settings_path);
        assert_eq!(
            settings["enabledPlugins"]
                .as_object()
                .unwrap()
                .keys()
                .filter(|key| *key == "loongsuite-pilot@loongsuite-pilot")
                .count(),
            1
        );
        let installed = world.json(&config.config_path);
        assert_eq!(
            installed["installedPlugins"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["name"] == "loongsuite-pilot"
                    && entry["marketplace"] == "loongsuite-pilot")
                .count(),
            1
        );
        assert!(installed["installedPlugins"]
            .as_array()
            .unwrap()
            .contains(&json!({"name":"other"})));
        assert!(strategy.undeploy(&world.def).await);
        assert!(!root.exists());
        assert!(world.json(&config.settings_path)["enabledPlugins"]
            .get("loongsuite-pilot@loongsuite-pilot")
            .is_none());
        assert_eq!(
            world.json(&config.config_path)["installedPlugins"],
            json!([{"name":"other"}])
        );
    }

    #[tokio::test]
    async fn main_l201_l216_l236_jsonc_trivia_foreign_registration_and_exact_modes_survive() {
        let world = World::new();
        let config = world.config();
        std::fs::write(&config.settings_path, "{// keep comment\n\"user\":42,\"enabledPlugins\":{\"spark@copilot-plugins\":true,},}\n").unwrap();
        std::fs::set_permissions(
            &config.settings_path,
            std::fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        std::fs::write(
            &config.config_path,
            "{\"userConfig\":\"keep\",\"installedPlugins\":[{\"name\":\"other\"},],}",
        )
        .unwrap();
        let strategy = world.strategy();
        assert!(strategy.deploy(&world.def).await.success);
        assert!(std::fs::read_to_string(&config.settings_path)
            .unwrap()
            .contains("// keep comment"));
        assert_eq!(
            std::fs::metadata(&config.settings_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        let settings = world.json(&config.settings_path);
        assert_eq!(settings["user"], 42);
        assert_eq!(settings["enabledPlugins"]["spark@copilot-plugins"], true);
        assert_eq!(
            settings["enabledPlugins"]["loongsuite-pilot@loongsuite-pilot"],
            true
        );
        assert_eq!(world.json(&config.config_path)["userConfig"], "keep");
        assert!(strategy.undeploy(&world.def).await);
        assert_eq!(
            world.json(&config.settings_path),
            json!({"user":42,"enabledPlugins":{"spark@copilot-plugins":true}})
        );
        assert_eq!(
            std::fs::metadata(&config.settings_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }

    #[tokio::test]
    async fn main_l249_either_invalid_config_keeps_both_configs_and_owned_assets_byte_identical() {
        for corrupt_settings in [false, true] {
            let world = World::new();
            let strategy = world.strategy();
            assert!(strategy.deploy(&world.def).await.success);
            let config = world.config();
            let corrupt = if corrupt_settings {
                &config.settings_path
            } else {
                &config.config_path
            };
            std::fs::write(corrupt, "{broken").unwrap();
            let settings = std::fs::read(&config.settings_path).unwrap();
            let installed = std::fs::read(&config.config_path).unwrap();
            let manifest =
                std::fs::read(Path::new(&config.plugin_root).join("plugin.json")).unwrap();
            assert!(!strategy.deploy(&world.def).await.success);
            assert!(!strategy.undeploy(&world.def).await);
            assert_eq!(std::fs::read(&config.settings_path).unwrap(), settings);
            assert_eq!(std::fs::read(&config.config_path).unwrap(), installed);
            assert_eq!(
                std::fs::read(Path::new(&config.plugin_root).join("plugin.json")).unwrap(),
                manifest
            );
            assert!(world.data.join("state/copilot/otel-enabled").is_file());
        }
    }

    #[tokio::test]
    async fn main_shell_l16_real_fresh_shell_activation_and_idempotent_repair() {
        let world = World::new();
        within_original_five_second_budget(async {
            let strategy = world.strategy();
            assert!(strategy.deploy(&world.def).await.success);
            assert!(strategy.deploy(&world.def).await.success);
            let profile = std::fs::read_to_string(world.home.join(".bashrc")).unwrap();
            assert_eq!(profile.matches(BEGIN).count(), 1);
            assert!(profile.contains("export USER_SETTING=preserved"));
            assert!(!strategy.needs_deploy(&world.def, None).await);
            assert!(world.activate(&[]).await.starts_with(
                world
                    .data
                    .join("state/copilot/otel/copilot-")
                    .to_str()
                    .unwrap()
            ));
            std::fs::write(
                world.home.join(".bashrc"),
                "export USER_SETTING=preserved\n",
            )
            .unwrap();
            assert!(strategy.needs_deploy(&world.def, None).await);
            assert!(strategy.deploy(&world.def).await.success);
            assert_eq!(
                std::fs::read_to_string(world.home.join(".bashrc"))
                    .unwrap()
                    .matches(BEGIN)
                    .count(),
                1
            );
        })
        .await;
    }

    #[tokio::test]
    async fn main_shell_l21_real_fresh_shell_preserves_explicit_exporters_and_disable_settings() {
        let world = World::new();
        within_original_five_second_budget(async {
            assert!(world.strategy().deploy(&world.def).await.success);
            assert_eq!(
                world
                    .activate(&[("COPILOT_OTEL_FILE_EXPORTER_PATH", "/tmp/user-otel.jsonl")])
                    .await,
                "/tmp/user-otel.jsonl"
            );
            for setting in [
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318"),
                ("COPILOT_OTEL_ENABLED", "false"),
                ("COPILOT_OTEL_EXPORTER_TYPE", "otlp-http"),
            ] {
                assert_eq!(world.activate(&[setting]).await, "unset");
            }
        })
        .await;
    }

    #[tokio::test]
    async fn main_shell_l26_profile_alias_and_exact_target_mode_survive_real_install_and_cleanup() {
        let world = World::new();
        within_original_five_second_budget(async {
            let target = world.home.join("actual rc");
            std::fs::write(&target, "export KEEP=1\n").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o664)).unwrap();
            let alias = world.home.join(".bashrc");
            std::fs::remove_file(&alias).unwrap();
            symlink(&target, &alias).unwrap();
            let strategy = world.strategy();
            let result = strategy.deploy(&world.def).await;
            assert!(result.success, "{result:?}");
            assert!(std::fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o664
            );
            assert!(!strategy.needs_deploy(&world.def, None).await);
            assert!(world.activate(&[]).await.contains("copilot-"));
            assert!(strategy.undeploy(&world.def).await);
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "export KEEP=1\n");
            assert!(std::fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o664
            );
        })
        .await;
    }

    #[tokio::test]
    async fn main_shell_l37_dangling_profile_alias_is_preserved_without_creating_its_target() {
        let world = World::new();
        let alias = world.home.join(".bashrc");
        let missing = world.home.join("missing profile");
        std::fs::remove_file(&alias).unwrap();
        symlink(&missing, &alias).unwrap();
        assert!(!world.strategy().deploy(&world.def).await.success);
        assert!(std::fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!missing.exists());
        assert!(!Path::new(&world.config().plugin_root).exists());
    }

    #[tokio::test]
    async fn main_shell_l42_cleanup_preserves_user_profile_and_disables_the_next_real_shell() {
        let world = World::new();
        within_original_five_second_budget(async {
            let strategy = world.strategy();
            assert!(strategy.deploy(&world.def).await.success);
            assert!(strategy.undeploy(&world.def).await);
            assert_eq!(world.activate(&[]).await, "unset");
            assert_eq!(
                std::fs::read_to_string(world.home.join(".bashrc")).unwrap(),
                "export USER_SETTING=preserved\n"
            );
            assert!(strategy.needs_deploy(&world.def, None).await);
        })
        .await;
    }
}
