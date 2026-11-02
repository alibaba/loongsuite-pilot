//! Frozen loader env/settings/activation contracts; actual temp definitions and binaries.
use super::*;
use serde_json::json;
struct F {
    root: tempfile::TempDir,
}
impl F {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("agents.d")).unwrap();
        std::fs::create_dir_all(root.path().join("agents.d.local")).unwrap();
        Self { root }
    }
    fn path(&self, relative: &str) -> String {
        self.root
            .path()
            .join(relative)
            .to_string_lossy()
            .into_owned()
    }
    async fn load(&self, value: Value, mut env: HashMap<String, String>) -> AgentDefinition {
        // No fallback may probe the host's actual Hermes/uv installation.
        env.entry("HERMES_HOME".into())
            .or_insert_with(|| self.path("absent-hermes"));
        env.entry("HOME".into())
            .or_insert_with(|| self.path("home"));
        env.entry("USERPROFILE".into())
            .or_insert_with(|| self.path("home"));
        std::fs::write(
            self.root.path().join("agents.d/test.json"),
            value.to_string(),
        )
        .unwrap();
        let loader = AgentDefLoader::new(AgentDefLoaderOptions {
            builtin_dir: self.path("agents.d"),
            local_dir: self.path("agents.d.local"),
            pilot_dir: "/opt/pilot".into(),
            data_dir: "/home/user/.loongsuite-pilot".into(),
        })
        .with_env(env);
        let mut defs = loader.load().await;
        assert_eq!(defs.len(), 1);
        defs.remove(0)
    }
}
fn normalized(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}
fn home() -> std::path::PathBuf {
    std::path::PathBuf::from(if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap()
    } else {
        std::env::var("HOME").unwrap()
    })
}
fn hermes() -> Value {
    json!({"id":"hermes-agent","displayName":"Hermes Agent","deployMode":"directory-plugin","detection":{"paths":["$HERMES_HOME"],"commands":["hermes"]},"directoryPlugin":{"sourceDir":"$PILOT_DIR/assets/plugins/hermes-agent/loongsuite-pilot","targetDir":"$HERMES_HOME/plugins/loongsuite-pilot","activation":{"command":"$HERMES_CLI","enableArgs":["plugins","enable","loongsuite-pilot"]}}})
}
fn pi() -> Value {
    json!({"id":"pi-coding-agent","displayName":"Pi Coding Agent","deployMode":"plugin-inject","detection":{"paths":["$PI_CODING_AGENT_DIR"],"commands":["pi"]},"pluginInject":{"configPaths":["$PI_CODING_AGENT_DIR/settings.json"],"pluginSpec":"$PILOT_DATA/plugins/pi-coding-agent/index.mjs","pluginId":"loongsuite-pilot-pi-coding-agent","configKey":"extensions","createIfMissing":true}})
}
fn grok() -> Value {
    json!({"id":"grok-build","displayName":"Grok Build","deployMode":"hook","detection":{"paths":["$GROK_HOME"],"commands":[]},"hook":{"settingsPath":"$GROK_HOME/hooks/loongsuite-pilot.json","events":["stop"],"hookCommand":"$PILOT_DATA/hooks/grok-build-loongsuite-pilot-hook.sh","format":"nested"}})
}
fn dsh() -> Value {
    json!({"id":"dsh","displayName":"DeepSeek Harness","deployMode":"dsh-yaml-patch","detection":{"paths":["$DSH_HOME"],"commands":["dsh"]},"dshYamlPatch":{"pluginSource":"$PILOT_DATA/plugins/dsh/plugin.mjs","entryId":"loongsuite-pilot-observability","marker":"PILOT-OBSERVABILITY-MANAGED"}})
}
fn env(key: &str, value: String) -> HashMap<String, String> {
    HashMap::from([(key.to_owned(), value)])
}
fn touch(file: &Path) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, "").unwrap();
}

#[tokio::test]
async fn source_l207_hermes_home_cli_and_directory_plugin_fields_are_resolved() {
    let f = F::new();
    let profile = f.path("hermes-profile");
    let cli = f.path("hermes-bin/hermes");
    let mut vars = env("HERMES_HOME", profile.clone());
    vars.insert("HERMES_CLI".into(), cli.clone());
    let def = serde_json::to_value(f.load(hermes(), vars).await).unwrap();
    assert_eq!(def["deployMode"], "directory-plugin");
    assert_eq!(def["detection"]["paths"][0], normalized(&profile));
    assert_eq!(
        def["directoryPlugin"]["sourceDir"],
        "/opt/pilot/assets/plugins/hermes-agent/loongsuite-pilot"
    );
    assert_eq!(
        def["directoryPlugin"]["targetDir"],
        normalized(Path::new(&profile).join("plugins/loongsuite-pilot"))
    );
    assert_eq!(
        def["directoryPlugin"]["activation"]["command"],
        normalized(&cli)
    );
}
#[tokio::test]
async fn source_l250_absent_hermes_bundle_and_uv_shim_fall_back_to_path_command() {
    let f = F::new();
    let def = serde_json::to_value(
        f.load(hermes(), env("HERMES_HOME", f.path("hermes-profile")))
            .await,
    )
    .unwrap();
    assert_eq!(
        def["directoryPlugin"]["activation"]["command"],
        if cfg!(windows) {
            "hermes.exe"
        } else {
            "hermes"
        }
    );
}
#[tokio::test]
async fn source_l295_existing_uv_tool_shim_is_selected_before_path_fallback() {
    let f = F::new();
    let executable = if cfg!(windows) {
        "hermes.exe"
    } else {
        "hermes"
    };
    let shim = f.root.path().join("home/.local/bin").join(executable);
    touch(&shim);
    let def = serde_json::to_value(
        f.load(hermes(), env("HERMES_HOME", f.path("home/.hermes")))
            .await,
    )
    .unwrap();
    assert_eq!(
        def["directoryPlugin"]["activation"]["command"],
        normalized(shim)
    );
}
#[tokio::test]
async fn source_l345_official_bundled_hermes_cli_is_selected_when_present() {
    let f = F::new();
    let profile = f.path("hermes-profile");
    let bundled = Path::new(&profile)
        .join("hermes-agent/venv")
        .join(if cfg!(windows) { "Scripts" } else { "bin" })
        .join(if cfg!(windows) {
            "hermes.exe"
        } else {
            "hermes"
        });
    touch(&bundled);
    let def = serde_json::to_value(f.load(hermes(), env("HERMES_HOME", profile)).await).unwrap();
    assert_eq!(
        def["directoryPlugin"]["activation"]["command"],
        normalized(bundled)
    );
}
#[tokio::test]
async fn source_l388_pi_override_reaches_detection_and_settings_paths() {
    let f = F::new();
    let profile = f.path("pi-profile");
    let def = f
        .load(pi(), env("PI_CODING_AGENT_DIR", profile.clone()))
        .await;
    assert_eq!(def.detection.paths[0], normalized(&profile));
    assert_eq!(
        def.plugin_inject.unwrap().config_paths[0],
        normalized(Path::new(&profile).join("settings.json"))
    );
}
#[tokio::test]
async fn source_l418_pi_unset_defaults_to_user_pi_agent_for_detection_and_settings() {
    let f = F::new();
    let expected = home().join(".pi/agent");
    let def = f.load(pi(), HashMap::new()).await;
    assert_eq!(def.detection.paths[0], normalized(&expected));
    assert_eq!(
        def.plugin_inject.unwrap().config_paths[0],
        normalized(expected.join("settings.json"))
    );
}
#[tokio::test]
async fn source_l447_pi_blank_override_is_unset() {
    let f = F::new();
    let def = f.load(pi(), env("PI_CODING_AGENT_DIR", "   ".into())).await;
    assert_eq!(def.detection.paths[0], normalized(home().join(".pi/agent")));
}
#[tokio::test]
async fn source_l481_grok_override_reaches_detection_and_hook_settings() {
    let f = F::new();
    let profile = f.path("grok-profile");
    let def = f.load(grok(), env("GROK_HOME", profile.clone())).await;
    assert_eq!(def.detection.paths[0], normalized(&profile));
    assert_eq!(
        def.hook.unwrap().settings_path,
        normalized(Path::new(&profile).join("hooks/loongsuite-pilot.json"))
    );
}
#[tokio::test]
async fn source_l510_grok_unset_defaults_to_user_home_for_detection_and_settings() {
    let f = F::new();
    let expected = home().join(".grok");
    let def = f.load(grok(), HashMap::new()).await;
    assert_eq!(def.detection.paths[0], normalized(&expected));
    assert_eq!(
        def.hook.unwrap().settings_path,
        normalized(expected.join("hooks/loongsuite-pilot.json"))
    );
}
#[tokio::test]
async fn source_l539_grok_blank_override_is_unset() {
    let f = F::new();
    let def = f.load(grok(), env("GROK_HOME", "   ".into())).await;
    assert_eq!(def.detection.paths[0], normalized(home().join(".grok")));
}
#[tokio::test]
async fn source_l567_dsh_override_keeps_detection_and_absent_patch_path_for_process_locator() {
    let f = F::new();
    let profile = f.path("dsh-profile");
    let def = f.load(dsh(), env("DSH_HOME", profile.clone())).await;
    assert_eq!(def.detection.paths[0], normalized(profile));
    assert!(def.dsh_yaml_patch.unwrap().patch_path.is_none());
}
#[tokio::test]
async fn source_l595_dsh_unset_defaults_to_user_dsh() {
    let f = F::new();
    let def = f.load(dsh(), HashMap::new()).await;
    assert_eq!(def.detection.paths[0], normalized(home().join(".dsh")));
}
#[tokio::test]
async fn source_l620_dsh_blank_override_is_unset() {
    let f = F::new();
    let def = f.load(dsh(), env("DSH_HOME", "   ".into())).await;
    assert_eq!(def.detection.paths[0], normalized(home().join(".dsh")));
}
#[test]
fn source_l473_l559_l645_shipped_pi_grok_and_dsh_placeholders_remain_unresolved_in_assets() {
    let pi: Value =
        serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
    assert_eq!(pi["detection"]["paths"], json!(["$PI_CODING_AGENT_DIR"]));
    assert_eq!(
        pi["pluginInject"]["configPaths"],
        json!(["$PI_CODING_AGENT_DIR/settings.json"])
    );
    let grok: Value = serde_json::from_str(include_str!("../../agents.d/grok-build.json")).unwrap();
    assert_eq!(grok["detection"]["paths"], json!(["$GROK_HOME"]));
    assert_eq!(
        grok["hook"]["settingsPath"],
        "$GROK_HOME/hooks/loongsuite-pilot.json"
    );
    let dsh: Value = serde_json::from_str(include_str!("../../agents.d/dsh.json")).unwrap();
    assert_eq!(dsh["detection"]["paths"], json!(["$DSH_HOME"]));
    assert!(dsh["dshYamlPatch"].get("patchPath").is_none());
}
