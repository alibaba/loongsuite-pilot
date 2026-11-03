//! Survivability of Native uninstall when DSH state cannot be inspected.
use loongsuite_pilot::deployment::DshYamlPatchStrategy;
use loongsuite_pilot::types::AgentDefinition;
use std::fs;
#[tokio::test]
async fn dsh_survivability_absent_patch_is_a_noop_but_real_read_error_is_not_success() {
    for unreadable in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("private-data");
        let source = data.join("plugins/dsh/plugin.mjs");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "private host module remains").unwrap();
        let config = data.join("config.json");
        fs::write(&config, "private reporting credentials remain").unwrap();
        let patch = root.path().join("第三方 DSH [read-error]/cordis.patch.yml");
        if unreadable {
            fs::create_dir_all(&patch).unwrap();
        }
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../agents.d/dsh.json")).unwrap();
        let cfg = def.dsh_yaml_patch.as_mut().unwrap();
        cfg.plugin_source = source.to_string_lossy().into_owned();
        cfg.patch_path = Some(patch.to_string_lossy().into_owned());
        let result = DshYamlPatchStrategy::new(data.to_string_lossy().into_owned())
            .undeploy_recorded(&def, None)
            .await;
        assert_eq!(
            result, !unreadable,
            "a real read error cannot be interpreted as no managed patch"
        );
        assert_eq!(fs::read(&source).unwrap(), b"private host module remains");
        assert_eq!(
            fs::read(&config).unwrap(),
            b"private reporting credentials remain"
        );
        assert_eq!(patch.exists(), unreadable);
    }
}

#[tokio::test]
async fn dsh_survivability_manager_keeps_deployment_state_and_resource_bytes_on_real_read_error() {
    use loongsuite_pilot::deployment::{DeploymentManager, DeploymentManagerOptions};
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("private-data");
    let source = data.join("plugins/dsh/plugin.mjs");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(&source, "private host module remains").unwrap();
    let config = data.join("config.json");
    fs::write(&config, "private reporting credentials remain").unwrap();
    let patch = root.path().join("private-patch-directory");
    fs::create_dir_all(&patch).unwrap();
    let state_path = data.join("deployed-agents.json");
    let state = serde_json::json!({"dsh":{"deployMode":"dsh-yaml-patch","deployedAt":"2026-11-03T00:00:00Z","dshPatchPath":patch},
        "cursor":{"deployMode":"hook","deployedAt":"2026-11-03T00:00:00Z"}});
    fs::write(&state_path, format!("\u{feff}{state}\n")).unwrap();
    let state_before = fs::read(&state_path).unwrap();
    let mut def: AgentDefinition =
        serde_json::from_str(include_str!("../agents.d/dsh.json")).unwrap();
    let cfg = def.dsh_yaml_patch.as_mut().unwrap();
    cfg.plugin_source = source.to_string_lossy().into_owned();
    cfg.patch_path = Some(patch.to_string_lossy().into_owned());
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: data.to_string_lossy().into_owned(),
        pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
        builtin_agents_dir: None,
        installed_by: None,
    });
    assert!(
        !manager.undeploy_agent(&def).await,
        "unknown patch read must not clear persisted deployment state"
    );
    assert_eq!(fs::read(state_path).unwrap(), state_before);
    assert_eq!(fs::read(source).unwrap(), b"private host module remains");
    assert_eq!(
        fs::read(config).unwrap(),
        b"private reporting credentials remain"
    );
    assert!(patch.is_dir());
}
