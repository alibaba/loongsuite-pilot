use super::*;
use serde_json::json;
use std::path::PathBuf;
tokio::task_local! {static WINDOWS_OVERRIDE: bool;}
pub(super) fn windows_for_history(actual: bool) -> bool {
    WINDOWS_OVERRIDE.try_with(|v| *v).unwrap_or(actual)
}
struct World {
    _temp: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
    settings: PathBuf,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let data = root.join("pilot-data");
        let settings = root.join(".pi/agent/settings.json");
        Self {
            _temp: temp,
            root,
            data,
            settings,
        }
    }
    fn strategy(&self) -> PluginInjectStrategy {
        PluginInjectStrategy::new(
            self.data.to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        )
    }
    fn pi(&self) -> AgentDefinition {
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![self.settings.to_string_lossy().into_owned()];
        def
    }
    fn write(&self, value: Value) {
        std::fs::create_dir_all(self.settings.parent().unwrap()).unwrap();
        std::fs::write(&self.settings, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn read(&self) -> Value {
        serde_json::from_slice(&std::fs::read(&self.settings).unwrap()).unwrap()
    }
    fn expected_pi(&self) -> String {
        let raw = self
            .data
            .join("plugins/pi-coding-agent/index.mjs")
            .to_string_lossy()
            .into_owned();
        if cfg!(windows) {
            raw.replace('\\', "/")
        } else {
            raw
        }
    }
}
#[tokio::test]
async fn flat_l46_l124_real_pi_extension_keeps_theme_other_entries_and_uninstalls_idempotently() {
    let f = World::new();
    f.write(json!({"theme":"dark","extensions":["/other.mjs"]}));
    let def = f.pi();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    assert_eq!(
        f.read(),
        json!({"theme":"dark","extensions":["/other.mjs",f.expected_pi()]})
    );
    assert!(!strategy.needs_deploy(&def, None).await);
    assert!(strategy.deploy(&def).await.success);
    assert_eq!(f.read()["extensions"].as_array().unwrap().len(), 2);
    assert!(strategy.undeploy(&def).await);
    assert_eq!(f.read()["extensions"], json!(["/other.mjs"]));
    let bytes = std::fs::read(&f.settings).unwrap();
    assert!(strategy.undeploy(&def).await);
    assert_eq!(std::fs::read(&f.settings).unwrap(), bytes);
    let empty = World::new();
    let def = empty.pi();
    let strategy = empty.strategy();
    assert!(strategy.deploy(&def).await.success);
    assert!(strategy.deploy(&def).await.success);
    assert_eq!(empty.read()["extensions"].as_array().unwrap().len(), 1);
    assert!(strategy.undeploy(&def).await);
    assert_eq!(empty.read()["extensions"], json!([]));
}
#[tokio::test]
async fn flat_l62_existing_later_config_is_reported_exactly_without_creating_the_missing_first_candidate(
) {
    let f = World::new();
    f.write(json!({}));
    let missing = f.root.join("missing-pi/settings.json");
    let mut def = f.pi();
    def.plugin_inject
        .as_mut()
        .unwrap()
        .config_paths
        .insert(0, missing.to_string_lossy().into_owned());
    let result = f.strategy().deploy(&def).await;
    assert!(result.success, "{result:?}");
    assert_eq!(
        result.plugin_inject_config_path.as_deref(),
        f.settings.to_str()
    );
    assert_eq!(f.read()["extensions"], json!([f.expected_pi()]));
    assert!(!missing.exists());
}
#[tokio::test]
async fn flat_l80_l111_l116_missing_config_health_is_readonly_and_creation_policy_is_enforced() {
    let f = World::new();
    let strategy = f.strategy();
    let mut def = f.pi();
    assert!(strategy.needs_deploy(&def, None).await);
    assert!(!f.settings.exists());
    def.plugin_inject.as_mut().unwrap().create_if_missing = Some(false);
    let result = strategy.deploy(&def).await;
    assert!(!result.success);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("no config file found"));
    assert!(!f.settings.exists());
    def.plugin_inject.as_mut().unwrap().create_if_missing = Some(true);
    assert!(strategy.deploy(&def).await.success);
    assert_eq!(f.read()["extensions"], json!([f.expected_pi()]));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&f.settings).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
#[tokio::test]
async fn flat_l136_windows_separator_aliases_do_not_duplicate_and_are_written_in_forward_form() {
    WINDOWS_OVERRIDE
        .scope(true, async {
            let f = World::new();
            let mut strategy = f.strategy();
            assert_eq!(
                strategy.normalize_spec(
                    r"C:\Users\pilot\.loongsuite-pilot/plugins/pi-coding-agent/index.mjs"
                ),
                "C:/Users/pilot/.loongsuite-pilot/plugins/pi-coding-agent/index.mjs"
            );
            let def = f.pi();
            assert!(strategy.deploy(&def).await.success);
            let expected = f
                .data
                .join("plugins/pi-coding-agent/index.mjs")
                .to_string_lossy()
                .replace('\\', "/");
            let mixed = expected.replace('/', "\\");
            f.write(json!({"extensions":[mixed]}));
            assert!(!strategy.needs_deploy_with(&def, None).await);
            assert!(strategy.deploy_with(&def).await.success);
            assert_eq!(f.read()["extensions"].as_array().unwrap().len(), 1);
            f.write(json!({"extensions":[]}));
            assert!(strategy.deploy_with(&def).await.success);
            assert_eq!(f.read()["extensions"], json!([expected]));
        })
        .await
}
#[tokio::test]
async fn flat_l93_immutable_ef_single_file_and_current_shipped_directory_both_install_first_config()
{
    for legacy in [true, false] {
        let f = World::new();
        let text = if legacy {
            include_str!("../../tests/fixtures/deployment-history/opencode-ef8953.json")
        } else {
            include_str!("../../agents.d/opencode.json")
        };
        let mut def: AgentDefinition = serde_json::from_str(text).unwrap();
        let config = def.plugin_inject.as_mut().unwrap();
        config.config_paths = config
            .config_paths
            .iter()
            .map(|p| {
                f.root
                    .join(p.strip_prefix("~/").unwrap())
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        let result = f.strategy().deploy(&def).await;
        assert!(result.success, "legacy={legacy} {result:?}");
        let target = f.root.join(".config/opencode/opencode.jsonc");
        let actual: Value = serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        let path = f.data.join(if legacy {
            "plugins/opencode/plugin.mjs"
        } else {
            "plugins/opencode"
        });
        let expected = reqwest::Url::from_file_path(&path).unwrap().to_string();
        assert_eq!(actual["plugin"], json!([expected]));
        assert!(!f.strategy().needs_deploy(&def, None).await);
        for relative in ["index.js", "plugin.mjs", "package.json", "v2.mjs"] {
            assert!(f.data.join("plugins/opencode").join(relative).is_file());
        }
        assert!(f.data.join("plugins/shared/resource-context.mjs").is_file());
    }
}
#[tokio::test]
async fn flat_l159_opencode_existing_plugins_array_keeps_its_key_and_other_plugin() {
    let f = World::new();
    f.write(json!({"plugins":["existing"]}));
    let mut def = f.pi();
    let config = def.plugin_inject.as_mut().unwrap();
    config.plugin_spec = "file://$PILOT_DATA/plugins/opencode/plugin.mjs".into();
    config.plugin_id = "loongsuite-pilot-opencode".into();
    config.config_key = None;
    config.create_if_missing = Some(false);
    // The original declaration deliberately retains the PI identity while
    // selecting an OpenCode array. Exercise that exact definition at the
    // production config transformation boundary. Native asset installation
    // additionally binds an official bundle to its agent identity.
    assert_eq!(def.id, "pi-coding-agent");
    let config = def.plugin_inject.as_ref().unwrap();
    let strategy = f.strategy();
    let expected = strategy.resolve_spec(&config.plugin_spec);
    let mut document = f.read();
    assert!(strategy.flat_array_inject(&mut document, &expected, config));
    assert_eq!(document["plugins"], json!(["existing", expected]));
    assert!(document.get("plugin").is_none());
    assert!(!strategy.flat_array_inject(&mut document, &expected, config));
    let before = std::fs::read(&f.settings).unwrap();
    let result = strategy.deploy(&def).await;
    assert!(!result.success);
    assert_eq!(std::fs::read(&f.settings).unwrap(), before);
    assert!(!f.data.join("plugins/opencode").exists());
}
fn opencode(f: &World, legacy: bool) -> AgentDefinition {
    let text = if legacy {
        include_str!("../../tests/fixtures/deployment-history/opencode-ef8953.json")
    } else {
        include_str!("../../agents.d/opencode.json")
    };
    let mut def: AgentDefinition = serde_json::from_str(text).unwrap();
    def.plugin_inject.as_mut().unwrap().config_paths =
        vec![f.settings.to_string_lossy().into_owned()];
    def.detection.paths = vec![f.settings.parent().unwrap().to_string_lossy().into_owned()];
    def
}
#[tokio::test]
async fn official_legacy_entry_migrates_to_preferred_directory_without_touching_another_install() {
    let f = World::new();
    let old = opencode(&f, true);
    assert!(f.strategy().deploy(&old).await.success);
    let own_old = reqwest::Url::from_file_path(f.data.join("plugins/opencode/plugin.mjs"))
        .unwrap()
        .to_string();
    let foreign =
        reqwest::Url::from_file_path(f.root.join("other-install/plugins/opencode/plugin.mjs"))
            .unwrap()
            .to_string();
    f.write(json!({"theme":"dark","plugin":[own_old,"user-plugin",foreign]}));
    let current = opencode(&f, false);
    assert!(f.strategy().deploy(&current).await.success);
    let own = reqwest::Url::from_file_path(f.data.join("plugins/opencode"))
        .unwrap()
        .to_string();
    assert_eq!(f.read()["plugin"], json!(["user-plugin", foreign, own]));
    assert!(f.strategy().undeploy(&current).await);
    assert_eq!(f.read()["plugin"], json!(["user-plugin", foreign]));
}
#[tokio::test]
async fn exact_legacy_entry_still_rejects_other_single_files_and_noncanonical_aliases() {
    for relative in [
        "opencode/not-allowed.mjs",
        "opencode/../opencode/plugin.mjs",
        "opencode/./plugin.mjs",
        "opencode/plugin.mjs/extra",
    ] {
        let f = World::new();
        let mut def = opencode(&f, true);
        def.plugin_inject.as_mut().unwrap().plugin_spec =
            format!("file://$PILOT_DATA/plugins/{relative}");
        assert!(!f.strategy().deploy(&def).await.success, "{relative}");
        assert!(!f.settings.exists());
        assert!(!f.data.join("plugins/opencode").exists());
    }
}
fn test_pilot(root: &Path, valid: bool, missing_companion: bool) -> PathBuf {
    use crate::utils::runtime_paths::{build_edition, build_target};
    let pilot = root.join("manifest-pilot");
    super::super::hook_assets::seed_development_root(&pilot);
    let mut resources = Vec::new();
    for relative in [
        "opencode/index.js",
        "opencode/package.json",
        "opencode/plugin.mjs",
        "opencode/v2.mjs",
        "shared/resource-context.mjs",
    ] {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets/plugins")
            .join(relative);
        let target = pilot.join("assets/plugins").join(relative);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(source, &target).unwrap();
        resources.push(json!({"path":format!("assets/plugins/{relative}"),"sha256":crate::utils::runtime_paths::sha256_file(&target).unwrap()}));
    }
    if !valid {
        resources[2]["sha256"] = json!("0".repeat(64));
    }
    std::fs::write(pilot.join("runtime-manifest.json"),json!({"schema":1,"runtime":"rust","version":env!("CARGO_PKG_VERSION"),"target":build_target(),"edition":build_edition(),"gitCommit":"a".repeat(40),"binary":"bin/loongsuite-pilot","resources":resources}).to_string()).unwrap();
    if missing_companion {
        std::fs::remove_file(pilot.join("assets/plugins/opencode/v2.mjs")).unwrap();
    }
    pilot
}
#[tokio::test]
async fn legacy_entry_never_bypasses_manifest_hashes_or_required_companions() {
    for (valid, missing) in [(true, false), (false, false), (true, true)] {
        let f = World::new();
        let pilot = test_pilot(&f.root, valid, missing);
        let strategy = PluginInjectStrategy::new(
            f.data.to_string_lossy().into_owned(),
            pilot.to_string_lossy().into_owned(),
        );
        let def = opencode(&f, true);
        let result = strategy.deploy(&def).await;
        assert_eq!(result.success, valid && !missing, "{result:?}");
        if valid && !missing {
            assert!(!strategy.needs_deploy(&def, None).await);
        } else {
            assert!(!f.settings.exists());
            assert!(!f.data.join("plugins/opencode").exists());
        }
    }
}
#[cfg(unix)]
#[tokio::test]
async fn legacy_entry_keeps_source_and_destination_symlink_boundaries() {
    for source_link in [true, false] {
        let f = World::new();
        let pilot = test_pilot(&f.root, true, false);
        let outside = f.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        if source_link {
            let source = pilot.join("assets/plugins/opencode/plugin.mjs");
            let copy = outside.join("plugin.mjs");
            std::fs::copy(&source, &copy).unwrap();
            std::fs::remove_file(&source).unwrap();
            std::os::unix::fs::symlink(&copy, &source).unwrap();
        } else {
            std::fs::create_dir_all(f.data.join("plugins")).unwrap();
            std::os::unix::fs::symlink(&outside, f.data.join("plugins/opencode")).unwrap();
        }
        let before = std::fs::read_dir(&outside).unwrap().count();
        let strategy = PluginInjectStrategy::new(
            f.data.to_string_lossy().into_owned(),
            pilot.to_string_lossy().into_owned(),
        );
        assert!(!strategy.deploy(&opencode(&f, true)).await.success);
        assert!(!f.settings.exists());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), before);
    }
}
#[tokio::test]
async fn manager_cleans_the_recorded_legacy_path_after_default_config_and_spec_drift() {
    use super::super::{DeploymentManager, DeploymentManagerOptions};
    let f = World::new();
    std::fs::create_dir_all(f.settings.parent().unwrap()).unwrap();
    let old = opencode(&f, true);
    let options = || DeploymentManagerOptions {
        data_dir: f.data.to_string_lossy().into_owned(),
        pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
        builtin_agents_dir: None,
        installed_by: None,
    };
    let first = DeploymentManager::new(options());
    let result = first.deploy_single(&old).await;
    assert!(result.success, "{result:?}");
    drop(first);
    let drift = f.root.join("new-home/settings.json");
    std::fs::create_dir_all(drift.parent().unwrap()).unwrap();
    let untouched = b"{\"theme\":\"leave\",\"plugin\":[\"foreign-module\"]}\n";
    std::fs::write(&drift, untouched).unwrap();
    let mut current = opencode(&f, false);
    current.plugin_inject.as_mut().unwrap().config_paths =
        vec![drift.to_string_lossy().into_owned()];
    let manager = DeploymentManager::new(options());
    assert!(manager.undeploy_agent(&current).await);
    assert_eq!(std::fs::read(&drift).unwrap(), untouched);
    assert_eq!(f.read()["plugin"], json!([]));
    assert!(!manager.has_record("opencode"));
}
