use super::*;
use serde_json::json;

fn directory(def_target: &str, source: &str) -> AgentDefinition {
    serde_json::from_value(json!({
        "id":"hermes-agent","displayName":"Hermes","deployMode":"directory-plugin",
        "detection":{"paths":["/unchanged-detection"],"commands":[]},
        "directoryPlugin":{"sourceDir":source,"targetDir":def_target}
    }))
    .unwrap()
}
fn record(target: Option<&str>) -> DeployedAgentRecord {
    serde_json::from_value(json!({
        "deployMode":"directory-plugin","deployedAt":"2026-11-03T00:00:00.000Z","targetDir":target
    }))
    .unwrap()
}
#[test]
fn recorded_directory_target_is_exclusive_without_changing_detection_or_sdk_source() {
    let root = tempfile::tempdir().unwrap();
    let fallback = root.path().join("default/plugins/loongsuite-pilot");
    let custom = root
        .path()
        .join("recorded O'Brien [隔离] 🚀/plugins/loongsuite-pilot");
    let source = root.path().join("sdk-source");
    let def = directory(&fallback.to_string_lossy(), &source.to_string_lossy());
    let state = record(Some(&custom.to_string_lossy()));
    let options = PersistedTargetOptions {
        preserve_hook_settings: true,
        preserve_plugin_config: true,
    };
    let selected = apply_persisted_deploy_targets(&def, Some(&state), Some(&options)).unwrap();
    assert_eq!(
        selected.directory_plugin.as_ref().unwrap().target_dir,
        node_resolve(&custom.to_string_lossy())
    );
    assert_eq!(selected.detection.paths, def.detection.paths);
    assert_eq!(
        selected.directory_plugin.as_ref().unwrap().source_dir,
        def.directory_plugin.as_ref().unwrap().source_dir
    );
    assert_eq!(
        def.directory_plugin.as_ref().unwrap().target_dir,
        fallback.to_string_lossy()
    );
    assert_eq!(
        serde_json::to_value(apply_persisted_deploy_targets(&def, None, None).unwrap()).unwrap(),
        serde_json::to_value(&def).unwrap()
    );
    assert_eq!(
        serde_json::to_value(
            apply_persisted_deploy_targets(&def, Some(&record(None)), None).unwrap()
        )
        .unwrap(),
        serde_json::to_value(&def).unwrap()
    );
}
#[test]
fn invalid_recorded_directory_target_is_an_error_instead_of_falling_back_to_the_definition() {
    let root = tempfile::tempdir().unwrap();
    let def = directory(
        &root.path().join("owned-default").to_string_lossy(),
        &root.path().join("source").to_string_lossy(),
    );
    for target in [
        "",
        "   ",
        "relative/plugin",
        "../foreign/plugin",
        "/absolute/\ninvalid",
        "/absolute/\0invalid",
    ] {
        assert!(
            apply_persisted_deploy_targets(&def, Some(&record(Some(target))), None).is_err(),
            "{target:?}"
        );
    }
}
