use super::*;
use crate::types::{DeployMode, DeployedAgentRecord};
use serde_json::json;
use std::path::Path;
fn def(id: &str, mode: &str, settings: &Path) -> AgentDefinition {
    serde_json::from_value(json!({"id":id,"displayName":id,"deployMode":mode,
        "detection":{"paths":[settings.parent().unwrap()],"commands":[]},
        "hook":{"settingsPath":settings,"events":["stop"],"hookCommand":"/pilot/hooks/grok.sh","format":"nested"}})).unwrap()
}
fn record(hook: Option<&Path>, plugin: Option<&Path>) -> DeployedAgentRecord {
    serde_json::from_value(json!({"deployMode":if hook.is_some() {"hook"}else{"plugin-inject"},
        "deployedAt":"2026-01-01T00:00:00.000Z","hookSettingsPath":hook,"pluginInjectConfigPath":plugin})).unwrap()
}
#[test]
fn persisted_l12_l17_hooks_parent_and_plain_settings_parent_resolve_to_the_exact_home() {
    let t = tempfile::tempdir().unwrap();
    let grok = t.path().join("workspace/.grok");
    let pi = t.path().join("pi-agent");
    assert_eq!(
        std::path::PathBuf::from(home_from_config_file(
            grok.join("hooks/loongsuite-pilot.json").to_str().unwrap()
        )),
        grok
    );
    assert_eq!(
        std::path::PathBuf::from(home_from_config_file(
            pi.join("settings.json").to_str().unwrap()
        )),
        pi
    );
}
#[test]
fn persisted_l22_grok_pi_selected_absolute_paths_and_native_all_hook_ownership_are_explicit() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let settings = root.join("custom/.grok/hooks/loongsuite-pilot.json");
    let grok = def("grok-build", "hook", &settings);
    assert_eq!(
        lifecycle_fields_for_deploy(&grok, None),
        (Some(node_resolve(settings.to_str().unwrap())), None)
    );
    let stale = root.join("stale-pi/settings.json");
    let current = root.join("current-pi/settings.json");
    let mut pi: AgentDefinition =
        serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
    pi.plugin_inject.as_mut().unwrap().config_paths = vec![
        stale.to_string_lossy().into_owned(),
        current.to_string_lossy().into_owned(),
    ];
    assert_eq!(
        lifecycle_fields_for_deploy(&pi, None),
        (None, Some(node_resolve(stale.to_str().unwrap())))
    );
    let resolved = record(None, Some(&current));
    assert_eq!(
        lifecycle_fields_for_deploy(&pi, Some(&resolved)),
        (None, Some(node_resolve(current.to_str().unwrap())))
    );
    let cursor_settings = root.join("user/.cursor/hooks.json");
    let cursor = def("cursor", "hook", &cursor_settings);
    // Native must record every installed hook target to support safe exact cleanup.
    // The original L22 assertion expecting Cursor {} stays explicitly partial.
    assert_eq!(
        lifecycle_fields_for_deploy(&cursor, None),
        (Some(node_resolve(cursor_settings.to_str().unwrap())), None)
    );
    let mut unrelated = cursor.clone();
    unrelated.deploy_mode = DeployMode::DetectionOnly;
    unrelated.hook = None;
    assert_eq!(lifecycle_fields_for_deploy(&unrelated, None), (None, None));
}
#[test]
fn persisted_l82_l104_overlay_precedes_defaults_and_backfill_keeps_the_recorded_target() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let original = root.join("workspace/.grok/hooks/loongsuite-pilot.json");
    let current = root.join("root/.grok/hooks/loongsuite-pilot.json");
    let grok = def("grok-build", "hook", &current);
    let mut saved = record(Some(&original), None);
    let next = apply_persisted_deploy_targets(&grok, Some(&saved), None).unwrap();
    assert_eq!(
        next.hook.as_ref().unwrap().settings_path,
        node_resolve(original.to_str().unwrap())
    );
    assert_eq!(
        next.detection.paths[0],
        node_resolve(root.join("workspace/.grok").to_str().unwrap())
    );
    let before = saved.hook_settings_path.clone();
    backfill_lifecycle_fields(&mut saved, &grok);
    assert_eq!(saved.hook_settings_path, before);
    assert_eq!(saved.hook_settings_path.as_deref(), original.to_str());
    assert_eq!(
        grok.hook.as_ref().unwrap().settings_path,
        current.to_string_lossy()
    );
    let mut pi: AgentDefinition =
        serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
    let own = root.join("recorded-pi/settings.json");
    let foreign = root.join("new-home/settings.json");
    pi.plugin_inject.as_mut().unwrap().config_paths = vec![foreign.to_string_lossy().into_owned()];
    let next = apply_persisted_deploy_targets(&pi, Some(&record(None, Some(&own))), None).unwrap();
    assert_eq!(
        next.plugin_inject.unwrap().config_paths,
        vec![node_resolve(own.to_str().unwrap())]
    );
    assert_eq!(
        pi.plugin_inject.unwrap().config_paths,
        vec![foreign.to_string_lossy().into_owned()]
    );
}
