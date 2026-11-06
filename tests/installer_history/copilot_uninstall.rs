use super::*;
#[cfg(unix)]
use loongsuite_pilot::deployment::CopilotPluginStrategy;
use loongsuite_pilot::types::AgentDefinition;
#[cfg(unix)]
use loongsuite_pilot::types::DeployStrategy;
use loongsuite_pilot::utils::{parse_json_document, JsonSyntax};

struct CopilotInstall {
    fixture: Fixture,
    installed: PathBuf,
    plugin: PathBuf,
    settings: PathBuf,
    config: PathBuf,
}
impl CopilotInstall {
    async fn new() -> Self {
        let fixture = Fixture::new();
        let home = fixture.root.path();
        let copilot = home.join(".copilot");
        fs::create_dir_all(&copilot).unwrap();
        fs::write(home.join(".bashrc"), "export KEEP=1\n").unwrap();
        let plugin = copilot.join("installed-plugins/loongsuite-pilot/loongsuite-pilot");
        let settings = copilot.join("settings.json");
        let config = copilot.join("config.json");
        let def: AgentDefinition = serde_json::from_value(json!({
            "id":"copilot","displayName":"GitHub Copilot CLI","deployMode":"copilot-plugin",
            "detection":{"paths":[copilot],"commands":[]},
            "copilotPlugin":{"pluginRoot":plugin,"pluginId":"loongsuite-pilot",
                "settingsPath":settings,"configPath":config,
                "events":["sessionStart","userPromptSubmitted","preToolUse","postToolUse","postToolUseFailure","sessionEnd","agentStop"],
                "hookCommand":home.join("external-copilot.sh"),"format":"nested","eventSubcommand":"kebab-case","timeoutSec":5}
        })).unwrap();
        let definition = serde_json::to_string(&def).unwrap();
        fixture.package_with(&[
            ("agents.d/copilot.json", &definition),
            (
                "agents.d/cursor.json",
                include_str!("../../agents.d/cursor.json"),
            ),
        ]);
        let mut options = fixture.runtime_options(&fixture.candidate);
        let staged = fixture.helper("stage-package", &options, true);
        success(&staged);
        let installed = home
            .join("cache/versions")
            .join(String::from_utf8(staged.stdout).unwrap().trim());
        options["sourceDir"] = json!(installed);
        success(&fixture.helper("publish-package", &options, true));
        #[cfg(unix)]
        {
            let producer = CopilotPluginStrategy::new(&fixture.data).with_home_dir(home);
            let result = producer.deploy(&def).await;
            assert!(result.success, "{result:?}");
            assert!(plugin.join("plugin.json").is_file());
            assert!(fixture.data.join("state/copilot/otel-enabled").is_file());
        }
        #[cfg(windows)]
        {
            // Automatic deployment is intentionally unsupported on Windows.
            // Build exactly the producer's complete owned package to exercise
            // the common public cleanup entry for an existing installation.
            use loongsuite_pilot::deployment::{
                build_copilot_plugin_hooks, build_copilot_plugin_manifest,
            };
            fs::create_dir_all(plugin.join("hooks")).unwrap();
            fs::write(
                plugin.join("plugin.json"),
                build_copilot_plugin_manifest().to_string(),
            )
            .unwrap();
            fs::write(
                plugin.join("hooks/hooks.json"),
                build_copilot_plugin_hooks(def.copilot_plugin.as_ref().unwrap()).to_string(),
            )
            .unwrap();
            fs::write(
                plugin.join(".loongsuite-pilot-managed.json"),
                "{\"schema\":1,\"owner\":\"loongsuite-pilot\"}\n",
            )
            .unwrap();
            fs::write(
                &settings,
                "{\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true}}",
            )
            .unwrap();
            fs::write(&config, json!({"installedPlugins":[{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot","enabled":true,"cache_path":plugin}]}).to_string()).unwrap();
            fs::create_dir_all(fixture.data.join("state/copilot")).unwrap();
            fs::write(fixture.data.join("state/copilot/otel-enabled"), "").unwrap();
        }
        Self {
            fixture,
            installed,
            plugin,
            settings,
            config,
        }
    }
    fn uninstall(&self) -> Output {
        self.fixture.helper(
            "cleanup-agents",
            &json!({"dataDir":self.fixture.data,"pilotDir":self.installed}),
            true,
        )
    }
    fn parse(path: &Path) -> Value {
        parse_json_document(&fs::read_to_string(path).unwrap(), JsonSyntax::Jsonc).unwrap()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn main_uninstall_l39_public_native_preserves_jsonc_utf8_foreign_arrays_and_shell_then_repeats(
) {
    let world = CopilotInstall::new().await;
    fs::write(&world.settings, "// user settings\n{\n\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true,\n// third-party registration\n\"third@third\":true,},\"user\":\"中文\",}\n").unwrap();
    fs::write(&world.config, "// CLI managed settings\n{\"installedPlugins\":[{\"name\":\"loongsuite-pilot\",\"marketplace\":\"loongsuite-pilot\"},\n// third-party plugin metadata\n{\"name\":\"third\",\"marketplace\":\"third\"},{\"name\":\"loongsuite-pilot\",\"marketplace\":\"loongsuite-pilot\"},],\"url\":\"https://example.test/path//keep\",}\n").unwrap();
    success(&world.uninstall());
    let settings = fs::read_to_string(&world.settings).unwrap();
    let config = fs::read_to_string(&world.config).unwrap();
    assert!(settings.contains("// user settings"));
    assert!(settings.contains("// third-party registration"));
    assert_eq!(
        CopilotInstall::parse(&world.settings),
        json!({"enabledPlugins":{"third@third":true},"user":"中文"})
    );
    assert!(config.contains("// CLI managed settings"));
    assert!(config.contains("// third-party plugin metadata"));
    assert_eq!(
        CopilotInstall::parse(&world.config)["installedPlugins"],
        json!([{"name":"third","marketplace":"third"}])
    );
    assert_eq!(
        CopilotInstall::parse(&world.config)["url"],
        "https://example.test/path//keep"
    );
    assert!(!world.plugin.exists());
    assert_eq!(
        fs::read_to_string(world.fixture.root.path().join(".bashrc")).unwrap(),
        "export KEEP=1\n"
    );
    assert!(!world
        .fixture
        .data
        .join("state/copilot/otel-enabled")
        .exists());
    success(&world.uninstall());
    assert_eq!(fs::read_to_string(&world.settings).unwrap(), settings);
    assert_eq!(fs::read_to_string(&world.config).unwrap(), config);
}

#[tokio::test]
async fn main_uninstall_l74_public_native_preserves_both_foreign_separators_at_all_three_positions()
{
    for position in 0..3 {
        let world = CopilotInstall::new().await;
        let mut entries = vec!["{\"name\":\"first\"}", "{\"name\":\"last\"}"];
        entries.insert(
            position,
            "{\"name\":\"loongsuite-pilot\",\"marketplace\":\"loongsuite-pilot\"}",
        );
        fs::write(
            &world.config,
            format!(
                "{{\"installedPlugins\":[{}]}}",
                entries.join(", /* foreign separator */ ")
            ),
        )
        .unwrap();
        success(&world.uninstall());
        let raw = fs::read_to_string(&world.config).unwrap();
        assert_eq!(
            CopilotInstall::parse(&world.config)["installedPlugins"],
            json!([{"name":"first"},{"name":"last"}])
        );
        assert_eq!(raw.matches("foreign separator").count(), 2);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn main_uninstall_l84_public_native_retains_config_alias_bom_and_exact_target_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let world = CopilotInstall::new().await;
    let target = world.fixture.root.path().join("settings-target.json");
    fs::write(
        &target,
        "\u{feff}{\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true},\"foreign\":1}\n",
    )
    .unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    fs::remove_file(&world.settings).unwrap();
    symlink(&target, &world.settings).unwrap();
    success(&world.uninstall());
    assert!(fs::symlink_metadata(&world.settings)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );
    let raw = fs::read_to_string(&target).unwrap();
    assert!(raw.starts_with('\u{feff}'));
    assert_eq!(CopilotInstall::parse(&target)["foreign"], 1);
}

#[tokio::test]
async fn main_uninstall_l95_public_native_invalid_config_preserves_both_files_and_runtime_for_retry(
) {
    for invalid in ["{broken", "{\"installedPlugins\":{}}"] {
        let world = CopilotInstall::new().await;
        let settings = "// keep\n{\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true}}";
        fs::write(&world.settings, settings).unwrap();
        fs::write(&world.config, invalid).unwrap();
        let manifest = fs::read(world.plugin.join("plugin.json")).unwrap();
        let result = world.uninstall();
        assert!(!result.status.success());
        let diagnostic = String::from_utf8_lossy(&result.stderr);
        assert!(diagnostic.contains("copilot"), "{diagnostic}");
        assert!(
            !diagnostic.contains("unrecognized subcommand"),
            "{diagnostic}"
        );
        assert_eq!(fs::read_to_string(&world.settings).unwrap(), settings);
        assert_eq!(fs::read_to_string(&world.config).unwrap(), invalid);
        assert_eq!(
            fs::read(world.plugin.join("plugin.json")).unwrap(),
            manifest
        );
        assert!(world.installed.join("runtime-manifest.json").is_file());
        assert!(world
            .fixture
            .data
            .join("state/copilot/otel-enabled")
            .is_file());
    }
}

#[tokio::test]
async fn main_uninstall_l104_unavailable_verified_runtime_has_no_node_or_unsafe_cleanup_fallback() {
    let world = CopilotInstall::new().await;
    let settings = fs::read(&world.settings).unwrap();
    let config = fs::read(&world.config).unwrap();
    let manifest = fs::read(world.plugin.join("plugin.json")).unwrap();
    fs::write(world.installed.join("runtime-manifest.json"), "{invalid").unwrap();
    let result = world.uninstall();
    assert!(!result.status.success());
    let diagnostic = String::from_utf8_lossy(&result.stderr);
    assert!(
        !diagnostic.contains("unrecognized subcommand"),
        "{diagnostic}"
    );
    assert!(
        diagnostic.contains("runtime")
            || diagnostic.contains("运行")
            || diagnostic.contains("清单"),
        "{diagnostic}"
    );
    assert_eq!(fs::read(&world.settings).unwrap(), settings);
    assert_eq!(fs::read(&world.config).unwrap(), config);
    assert_eq!(
        fs::read(world.plugin.join("plugin.json")).unwrap(),
        manifest
    );
    assert!(world
        .fixture
        .data
        .join("state/copilot/otel-enabled")
        .is_file());
}

#[cfg(windows)]
#[tokio::test]
async fn main_uninstall_l112_windows_public_native_uses_the_same_lossless_jsonc_cleanup() {
    let world = CopilotInstall::new().await;
    fs::write(&world.settings, "// keep 中文\n{\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true,\"other@store\":true},\"user\":\"保留\",}").unwrap();
    fs::write(&world.config, "// foreign\n{\"installedPlugins\":[{\"name\":\"loongsuite-pilot\",\"marketplace\":\"loongsuite-pilot\"},{\"name\":\"other\"},],\"url\":\"https://example.test//keep\",}").unwrap();
    success(&world.uninstall());
    assert_eq!(
        CopilotInstall::parse(&world.settings),
        json!({"enabledPlugins":{"other@store":true},"user":"保留"})
    );
    assert_eq!(
        CopilotInstall::parse(&world.config),
        json!({"installedPlugins":[{"name":"other"}],"url":"https://example.test//keep"})
    );
    assert!(fs::read_to_string(&world.settings)
        .unwrap()
        .contains("// keep 中文"));
    assert!(fs::read_to_string(&world.config)
        .unwrap()
        .contains("// foreign"));
    assert!(!world.plugin.exists());
}
