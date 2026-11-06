use super::*;
use serde_json::json;

fn assemble(file: Value, global_poll_ms: Option<u64>) -> AnalyticsConfig {
    let env = HashMap::new();
    assemble_config(
        Some(&file),
        None,
        &ConfigSources {
            env: &env,
            platform: Platform::current(),
            hostname: "synthetic",
            config_path: "not-read.json",
            global_poll_ms,
        },
    )
    .unwrap()
}

#[test]
fn main_listener_defaults_include_copilot_and_passive_doubao() {
    let built = assemble(json!({}), None);
    for name in ["copilot-log", "doubao-work", "opencode-log", "workbuddy"] {
        assert_eq!(
            serde_json::to_value(&built.listeners[name]).unwrap(),
            json!({"enabled":true,"pollInterval":10000}),
            "{name}"
        );
    }
}

#[test]
fn main_copilot_file_override_preserves_other_listener_overrides() {
    let built = assemble(
        json!({"listeners":{
            "qoder":{"enabled":false,"pollInterval":120000},
            "opencode-log":{"pollInterval":1000},
            "copilot-log":{"enabled":false,"pollInterval":45000}
        }}),
        None,
    );
    assert_eq!(
        serde_json::to_value(&built.listeners["copilot-log"]).unwrap(),
        json!({"enabled":false,"pollInterval":45000})
    );
    assert!(!built.listeners["qoder"].enabled);
    assert_eq!(built.listeners["qoder"].poll_interval, 120000);
    assert_eq!(
        serde_json::to_value(&built.listeners["opencode-log"]).unwrap(),
        json!({"enabled":true,"pollInterval":1000})
    );
}

#[test]
fn main_global_poll_override_keeps_copilot_disabled_and_replaces_its_interval() {
    let built = assemble(
        json!({"listeners":{
            "qoder":{"enabled":false,"pollInterval":120000},
            "kiro-cli-session":{"enabled":true,"pollInterval":60000},
            "copilot-log":{"enabled":false,"pollInterval":45000}
        }}),
        Some(3000),
    );
    assert_eq!(
        serde_json::to_value(&built.listeners["copilot-log"]).unwrap(),
        json!({"enabled":false,"pollInterval":3000})
    );
    assert!(!built.listeners["qoder"].enabled);
    for listener in built.listeners.values() {
        assert_eq!(listener.poll_interval, 3000);
    }
}

#[test]
fn main_passive_doubao_override_leaves_workbuddy_at_its_defaults() {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    let file = json!({"listeners":{"doubao-work":{
        "enabled":false,"pollInterval":1200,"logDir":logs
    }}});
    let before = file.clone();
    let built = assemble(file.clone(), None);
    assert_eq!(
        serde_json::to_value(&built.listeners["doubao-work"]).unwrap(),
        json!({"enabled":false,"pollInterval":1200,"logDir":logs})
    );
    assert_eq!(
        serde_json::to_value(&built.listeners["workbuddy"]).unwrap(),
        json!({"enabled":true,"pollInterval":10000})
    );
    assert_eq!(file, before);
    assert!(!logs.exists());
}
