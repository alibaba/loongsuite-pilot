//! Exact loader source contracts through real temporary JSON definitions.
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
    fn loader(&self) -> AgentDefLoader {
        AgentDefLoader::new(AgentDefLoaderOptions {
            builtin_dir: self
                .root
                .path()
                .join("agents.d")
                .to_string_lossy()
                .into_owned(),
            local_dir: self
                .root
                .path()
                .join("agents.d.local")
                .to_string_lossy()
                .into_owned(),
            pilot_dir: "/opt/pilot".into(),
            data_dir: "/home/user/.loongsuite-pilot".into(),
        })
        .with_env(HashMap::new())
    }
    fn write(&self, local: bool, name: &str, value: &Value) {
        let dir = self
            .root
            .path()
            .join(if local { "agents.d.local" } else { "agents.d" });
        std::fs::write(dir.join(name), value.to_string()).unwrap();
    }
    async fn load(&self) -> Vec<Value> {
        self.loader()
            .load()
            .await
            .into_iter()
            .map(|def| serde_json::to_value(def).unwrap())
            .collect()
    }
}
fn simple(id: &str) -> Value {
    json!({"id":id,"displayName":"Test","deployMode":"hook","detection":{"paths":["~/.test"],"commands":[]},"hook":{"settingsPath":"~/.test/settings.json","events":["Stop"],"hookCommand":"test.sh","format":"flat"}})
}
fn pi_valid() -> Value {
    json!({"id":"acme-code","displayName":"Acme Code","deployMode":"plugin-inject","detection":{"paths":["/tmp/acme"],"commands":["acme"]},"piSdk":{"schemaVersion":1,"agentDir":"/tmp/acme/pi"},"pluginInject":{"configPaths":["/tmp/acme/pi/settings.json"],"pluginSpec":"$PILOT_DATA/plugins/pi-coding-agent/agents/acme-code.mjs","pluginId":"loongsuite-pilot-pi-sdk-acme-code","configKey":"extensions"}})
}
fn dsh() -> Value {
    json!({"id":"dsh","displayName":"DeepSeek Harness","deployMode":"dsh-yaml-patch","detection":{"paths":["~/.dsh"],"commands":["dsh"]},"dshYamlPatch":{"pluginSource":"$PILOT_DATA/plugins/dsh/plugin.mjs","entryId":"loongsuite-pilot-observability","marker":"PILOT-OBSERVABILITY-MANAGED"}})
}

#[tokio::test]
async fn source_l42_valid_builtin_definition_is_loaded() {
    let f = F::new();
    f.write(false, "test.json", &simple("test-agent"));
    let defs = f.load().await;
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0]["id"], "test-agent");
}
#[tokio::test]
async fn source_l59_invalid_json_file_is_skipped() {
    let f = F::new();
    std::fs::write(f.root.path().join("agents.d/broken.json"), "{invalid").unwrap();
    assert!(f.load().await.is_empty());
}
#[tokio::test]
async fn source_l68_missing_required_fields_are_skipped() {
    let f = F::new();
    f.write(false, "bad.json", &json!({"id":"missing-fields"}));
    assert!(f.load().await.is_empty());
}
#[tokio::test]
async fn source_l78_local_definition_overrides_builtin_by_exact_id() {
    let f = F::new();
    f.write(false,"cursor.json",&json!({"id":"cursor","displayName":"Cursor Builtin","deployMode":"hook","detection":{"paths":["~/.cursor"],"commands":[]}}));
    f.write(true,"cursor.json",&json!({"id":"cursor","displayName":"Cursor Local Override","deployMode":"hook","detection":{"paths":["~/.cursor-custom"],"commands":[]}}));
    let defs = f.load().await;
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0]["displayName"], "Cursor Local Override");
}
#[tokio::test]
async fn source_l102_valid_pi_sdk_loads_and_malformed_or_spoofed_markers_are_rejected() {
    let f = F::new();
    let valid = pi_valid();
    f.write(true, "valid.json", &valid);
    let mut invalid = valid.clone();
    invalid["id"] = json!("broken-pi-sdk");
    invalid["pluginInject"]["configKey"] = json!("plugins");
    f.write(true, "invalid.json", &invalid);
    let mut spoofed = valid;
    spoofed["id"] = json!("spoofed-pi-sdk");
    spoofed["pluginInject"]["pluginId"] = json!("loongsuite-pilot-pi-sdk-someone-else");
    f.write(true, "spoofed.json", &spoofed);
    let defs = f.load().await;
    assert_eq!(
        defs.iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["acme-code"]
    );
    assert_eq!(
        defs[0]["piSdk"],
        json!({"schemaVersion":1,"agentDir":"/tmp/acme/pi"})
    );
}
#[tokio::test]
async fn source_l137_pi_sdk_local_shadow_cannot_replace_reserved_builtin() {
    let f = F::new();
    let builtin = json!({"id":"pi-coding-agent","displayName":"Pi Coding Agent","deployMode":"plugin-inject","detection":{"paths":["~/.pi/agent"],"commands":["pi"]},"pluginInject":{"configPaths":["~/.pi/agent/settings.json"],"pluginSpec":"$PILOT_DATA/plugins/pi-coding-agent/index.mjs","pluginId":"loongsuite-pilot-pi-coding-agent","configKey":"extensions"}});
    f.write(false, "pi.json", &builtin);
    let mut shadow = builtin;
    shadow["displayName"] = json!("Shadowed Pi");
    shadow["piSdk"] = json!({"schemaVersion":1,"agentDir":"/tmp/shadow-pi"});
    shadow["pluginInject"] = json!({"configPaths":["/tmp/shadow-pi/settings.json"],"pluginSpec":"$PILOT_DATA/plugins/pi-coding-agent/agents/pi-coding-agent.mjs","pluginId":"loongsuite-pilot-pi-sdk-pi-coding-agent","configKey":"extensions"});
    f.write(true, "pi-shadow.json", &shadow);
    let defs = f.load().await;
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0]["id"], "pi-coding-agent");
    assert_eq!(defs[0]["displayName"], "Pi Coding Agent");
}
#[tokio::test]
async fn source_l170_pilot_dir_and_data_placeholders_reach_actual_loaded_fields() {
    let f = F::new();
    f.write(false,"var.json",&json!({"id":"var-test","displayName":"Var Test","deployMode":"hook","detection":{"paths":["$PILOT_DATA/logs"],"commands":[]},"hook":{"settingsPath":"$PILOT_DATA/settings.json","events":["Stop"],"hookCommand":"$PILOT_DIR/hooks/test.sh","format":"flat"}}));
    let defs = f.load().await;
    assert_eq!(
        defs[0]["detection"]["paths"][0],
        "/home/user/.loongsuite-pilot/logs"
    );
    assert_eq!(
        defs[0]["hook"]["hookCommand"],
        if cfg!(windows) {
            "/opt/pilot/hooks/test.ps1"
        } else {
            "/opt/pilot/hooks/test.sh"
        }
    );
}
#[tokio::test]
async fn source_l192_tilde_expands_to_actual_synthetic_user_home() {
    let f = F::new();
    f.write(false,"tilde.json",&json!({"id":"tilde-test","displayName":"Tilde Test","deployMode":"hook","detection":{"paths":["~/.cursor"],"commands":[]}}));
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap()
    } else {
        std::env::var("HOME").unwrap()
    };
    let expected = Path::new(&home)
        .join(".cursor")
        .to_string_lossy()
        .replace('\\', "/");
    let defs = f.load().await;
    assert_eq!(defs[0]["detection"]["paths"][0], expected);
}
#[tokio::test]
async fn source_l653_missing_definition_directories_return_empty() {
    let f = F::new();
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        builtin_dir: f
            .root
            .path()
            .join("nonexistent")
            .to_string_lossy()
            .into_owned(),
        local_dir: f
            .root
            .path()
            .join("also-nonexistent")
            .to_string_lossy()
            .into_owned(),
        pilot_dir: "/opt/pilot".into(),
        data_dir: "/home/user/.loongsuite-pilot".into(),
    })
    .with_env(HashMap::new());
    assert!(loader.load().await.is_empty());
}
#[tokio::test]
async fn source_l678_valid_dsh_yaml_patch_keeps_entry_id() {
    let f = F::new();
    f.write(false, "dsh.json", &dsh());
    let defs = f.load().await;
    assert_eq!(defs.len(), 1);
    assert_eq!(
        defs[0]["dshYamlPatch"]["entryId"],
        "loongsuite-pilot-observability"
    );
}
#[tokio::test]
async fn source_l685_unknown_deploy_mode_is_rejected() {
    let f = F::new();
    let mut value = dsh();
    value["id"] = json!("unknown-mode");
    value["deployMode"] = json!("made-up-mode");
    f.write(false, "unknown.json", &value);
    assert!(f.load().await.is_empty());
}
#[tokio::test]
async fn source_l695_dsh_patch_configuration_is_required() {
    let f = F::new();
    let mut value = dsh();
    value["id"] = json!("missing-cfg");
    value.as_object_mut().unwrap().remove("dshYamlPatch");
    f.write(false, "missing-cfg.json", &value);
    assert!(f.load().await.is_empty());
}
#[tokio::test]
async fn source_l705_empty_required_dsh_field_is_rejected() {
    let f = F::new();
    let mut value = dsh();
    value["id"] = json!("empty-entry");
    value["dshYamlPatch"]["entryId"] = json!("");
    f.write(false, "empty-entry.json", &value);
    assert!(f.load().await.is_empty());
}
#[tokio::test]
async fn source_l715_wrong_required_dsh_field_type_is_rejected() {
    let f = F::new();
    let mut value = dsh();
    value["id"] = json!("wrong-type");
    value["dshYamlPatch"]["marker"] = json!(123);
    f.write(false, "wrong-type.json", &value);
    assert!(f.load().await.is_empty());
}
#[tokio::test]
async fn source_l725_wrong_nonempty_dsh_patch_path_type_is_rejected() {
    let f = F::new();
    let mut value = dsh();
    value["id"] = json!("bad-path");
    value["dshYamlPatch"]["patchPath"] = json!(42);
    f.write(false, "bad-path.json", &value);
    assert!(f.load().await.is_empty());
}
