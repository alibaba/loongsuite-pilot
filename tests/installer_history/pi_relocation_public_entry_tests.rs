use super::*;
use loongsuite_pilot::deployment::{DeploymentManager, DeploymentManagerOptions};

#[test]
fn pi_original_l664_relocated_record_is_consumed_by_the_whole_public_uninstall_script() {
    let started = Instant::now();
    let entry = Entry::new(CandidateMode::Current);
    let current = entry.f.root.path().join("current-pi/settings.json");
    let stale = entry.f.root.path().join("stale-pi/settings.json");
    fs::create_dir_all(current.parent().unwrap()).unwrap();
    let spec = entry.f.data.join("plugins/pi-coding-agent/index.mjs");
    let mut definition: Value =
        serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
    definition["detection"] = json!({"paths":[current.parent().unwrap()],"commands":[]});
    definition["pluginInject"]["configPaths"] = json!([current]);
    let definition_text = definition.to_string();
    let custom_defs = entry.f.root.path().join("manager-only-custom-defs");
    fs::create_dir(&custom_defs).unwrap();
    fs::write(custom_defs.join("pi-coding-agent.json"), &definition_text).unwrap();
    // Add the actual shipped Pi definition and both verified resource files
    // before signing the immutable current Native package used by public SH.
    fs::remove_file(entry.f.candidate.join("runtime-manifest.json")).unwrap();
    entry.f.package_with(&[
        (
            "agents.d/pi-coding-agent.json",
            include_str!("../../agents.d/pi-coding-agent.json"),
        ),
        (
            "assets/plugins/pi-coding-agent/index.mjs",
            include_str!("../../assets/plugins/pi-coding-agent/index.mjs"),
        ),
        (
            "assets/plugins/shared/resource-context.mjs",
            include_str!("../../assets/plugins/shared/resource-context.mjs"),
        ),
    ]);
    copy_tree(&entry.f.candidate, &entry.installed);
    let shipped: Value = serde_json::from_slice(
        &fs::read(entry.installed.join("agents.d/pi-coding-agent.json")).unwrap(),
    )
    .unwrap();
    assert_ne!(shipped["pluginInject"]["configPaths"], json!([current]));
    assert!(!entry.f.root.path().join(".pi/agent/settings.json").exists());

    fs::write(
        &current,
        json!({"extensions":["/opt/third-party/extension.mjs"]}).to_string(),
    )
    .unwrap();
    fs::write(
        entry.f.data.join("deployed-agents.json"),
        json!({
        "pi-coding-agent":{"deployMode":"plugin-inject","deployedAt":"2026-01-01T00:00:00.000Z",
            "pluginInjectConfigPath":stale}})
        .to_string(),
    )
    .unwrap();
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: entry.f.data.to_string_lossy().into_owned(),
        pilot_dir: entry.f.candidate.to_string_lossy().into_owned(),
        builtin_agents_dir: Some(custom_defs.to_string_lossy().into_owned()),
        installed_by: None,
    });
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(manager.deploy_all(Some(&|def| def.id == "pi-coding-agent")));
    let deployed = result
        .iter()
        .find(|result| result.agent_id == "pi-coding-agent")
        .unwrap();
    assert!(deployed.success, "{:?}", deployed.error);
    assert_ne!(deployed.skipped, Some(true));
    let record: Value =
        serde_json::from_slice(&fs::read(entry.f.data.join("deployed-agents.json")).unwrap())
            .unwrap();
    assert_eq!(
        record["pi-coding-agent"]["pluginInjectConfigPath"],
        json!(current)
    );
    let configured: Value = serde_json::from_slice(&fs::read(&current).unwrap()).unwrap();
    assert_eq!(
        configured["extensions"],
        json!(["/opt/third-party/extension.mjs", spec])
    );
    assert!(!stale.exists());
    let output = shell(&entry, CandidateMode::Current);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(current).unwrap()).unwrap(),
        json!({"extensions":["/opt/third-party/extension.mjs"]})
    );
    assert!(!stale.exists());
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "original explicit twenty-second complete scenario"
    );
}
