use super::*;
use std::time::{Duration, Instant};

fn seed_stale(f: &World, def: &AgentDefinition) -> PathBuf {
    let old = f.root.join("old-home").join(".pi").join("settings.json");
    std::fs::create_dir_all(old.parent().unwrap()).unwrap();
    let state = json!({
        def.id.clone(): {"deployMode":"plugin-inject","deployedAt":"2026-01-01T00:00:00Z",
            "pluginInjectConfigPath":old},
        "unrelated": {"deployMode":"hook","deployedAt":"2025-01-01T00:00:00Z","hookSettingsPath":"/keep/unchanged.json","unknownFutureField":{"keep":[1,"exact"]}}
    });
    std::fs::write(
        f.data.join("deployed-agents.json"),
        serde_json::to_vec_pretty(&state).unwrap(),
    )
    .unwrap();
    old
}
#[tokio::test]
async fn pi_missing_recorded_home_automatically_injects_current_config_and_persists_the_new_target()
{
    let started = Instant::now();
    let f = World::new();
    let def = f.pi();
    f.save(&def);
    let current = Path::new(&def.plugin_inject.as_ref().unwrap().config_paths[0]);
    std::fs::write(current, "{\n // keep user comment\n \"extensions\":[\"/third-party/ext.mjs\"], \"theme\":\"用户🚀\"\n}\n".replace("\\n","\n").replace("\\\"","\"")).unwrap();
    let old = seed_stale(&f, &def);
    let unrelated = f.state()["unrelated"].clone();
    let result = f.manager().deploy_all(None).await;
    assert!(result[0].success, "{:?}", result[0].error);
    assert_ne!(result[0].skipped, Some(true));
    assert!(!old.exists(), "missing old HOME must never be recreated");
    let current_text = std::fs::read_to_string(current).unwrap();
    assert!(current_text.contains("keep user comment") && current_text.contains("用户🚀"));
    let current_json: Value =
        crate::utils::parse_json_document(&current_text, crate::utils::JsonSyntax::Jsonc).unwrap();
    let own = f.data.join("plugins/pi-coding-agent/index.mjs");
    assert_eq!(
        current_json["extensions"],
        json!([
            "/third-party/ext.mjs",
            own.to_string_lossy().replace('\\', "/")
        ])
    );
    assert_eq!(f.state()[&def.id]["pluginInjectConfigPath"], json!(current));
    assert_eq!(f.state()["unrelated"], unrelated);
    assert!(own.is_file() && f.data.join("plugins/shared/resource-context.mjs").is_file());
    let recreated = f.manager();
    assert!(recreated.undeploy_agent(&def).await);
    let after: Value = crate::utils::parse_json_document(
        &std::fs::read_to_string(current).unwrap(),
        crate::utils::JsonSyntax::Jsonc,
    )
    .unwrap();
    assert_eq!(after["extensions"], json!(["/third-party/ext.mjs"]));
    assert_eq!(f.state()["unrelated"], unrelated);
    assert!(started.elapsed() < Duration::from_secs(15));
}
#[tokio::test]
async fn pi_already_injected_current_home_only_moves_record_without_rewriting_config() {
    let started = Instant::now();
    let f = World::new();
    let def = f.pi();
    f.save(&def);
    let current = Path::new(&def.plugin_inject.as_ref().unwrap().config_paths[0]);
    std::fs::write(current, "{}\n").unwrap();
    assert!(f.manager().deploy_single(&def).await.success);
    let before = std::fs::read(current).unwrap();
    let mtime = std::fs::metadata(current).unwrap().modified().unwrap();
    let old = seed_stale(&f, &def);
    let results = f.manager().deploy_all(None).await;
    assert!(results[0].success, "{:?}", results[0].error);
    assert_eq!(results[0].reason, Some(DeploySkipReason::UpToDate));
    assert_eq!(results[0].skipped, Some(true));
    assert!(!old.exists());
    assert_eq!(std::fs::read(current).unwrap(), before);
    assert_eq!(
        std::fs::metadata(current).unwrap().modified().unwrap(),
        mtime
    );
    assert_eq!(f.state()[&def.id]["pluginInjectConfigPath"], json!(current));
    let mut fallback = def.clone();
    let default = f.root.join("default-pi/settings.json");
    fallback.detection.paths = vec![default.parent().unwrap().to_string_lossy().into_owned()];
    fallback.plugin_inject.as_mut().unwrap().config_paths =
        vec![default.to_string_lossy().into_owned()];
    assert!(f.manager().undeploy_agent(&fallback).await);
    let after = World::read(current);
    assert!(!after["extensions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry
            .as_str()
            .is_some_and(|entry| entry.ends_with("/pi-coding-agent/index.mjs"))));
    assert!(!default.exists());
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[tokio::test]
async fn pi_missing_current_config_can_be_created_at_current_home_without_recreating_old_home() {
    let started = Instant::now();
    let f = World::new();
    let def = f.pi();
    f.save(&def);
    let old = seed_stale(&f, &def);
    let current = Path::new(&def.plugin_inject.as_ref().unwrap().config_paths[0]);
    assert!(!current.exists());
    let result = f.manager().deploy_single(&def).await;
    assert!(result.success, "{:?}", result.error);
    assert!(!old.exists());
    assert_eq!(
        World::read(current)["extensions"],
        json!([f
            .data
            .join("plugins/pi-coding-agent/index.mjs")
            .to_string_lossy()
            .replace('\\', "/")])
    );
    assert_eq!(f.state()[&def.id]["pluginInjectConfigPath"], json!(current));
    assert!(started.elapsed() < Duration::from_secs(15));
}
#[tokio::test]
async fn pi_late_state_write_failure_rolls_back_current_config_resources_backup_and_record() {
    let started = Instant::now();
    let f = World::new();
    let def = f.pi();
    f.save(&def);
    let current = Path::new(&def.plugin_inject.as_ref().unwrap().config_paths[0]);
    // Use actual JSONC and a real readonly state file; the transaction reaches
    // state last after config and both verified assets have been written.
    std::fs::write(
        current,
        "{\n // original\n \"extensions\":[\"third-party\"], \"theme\":\"original\"\n}\n"
            .replace("\\n", "\n")
            .replace("\\\"", "\""),
    )
    .unwrap();
    let old = seed_stale(&f, &def);
    let original_config = std::fs::read(current).unwrap();
    let state = f.data.join("deployed-agents.json");
    let original_state = std::fs::read(&state).unwrap();
    let permissions = std::fs::metadata(&state).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&state, readonly).unwrap();
    let result = f.manager().deploy_single(&def).await;
    std::fs::set_permissions(&state, permissions).unwrap();
    assert!(!result.success, "readonly state unexpectedly committed");
    assert!(!old.exists());
    assert_eq!(std::fs::read(current).unwrap(), original_config);
    assert_eq!(std::fs::read(state).unwrap(), original_state);
    assert!(!Path::new(&format!("{}.bak", current.display())).exists());
    assert!(!f.data.join("plugins/pi-coding-agent/index.mjs").exists());
    assert!(!f.data.join("plugins/shared/resource-context.mjs").exists());
    assert!(!super::super::super::plugin_assets::recovery_pending(
        &f.data
    ));
    assert!(started.elapsed() < Duration::from_secs(15));
}
