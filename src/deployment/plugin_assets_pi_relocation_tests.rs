use super::*;
use crate::deployment::{DeploymentManager, DeploymentManagerOptions};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[tokio::test]
async fn interrupted_pi_state_last_transaction_recovers_before_fresh_manager_load_and_retry() {
    let started = Instant::now();
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let defs = temp.path().join("defs");
    let current = temp.path().join("current-home").join("settings.json");
    let old = temp.path().join("old-home").join("settings.json");
    for path in [
        &data,
        &defs,
        current.parent().unwrap(),
        old.parent().unwrap(),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(
        &current,
        "{\n // durable original\n \"extensions\":[\"third-party\"]\n}\n"
            .replace("\\n", "\n")
            .replace("\\\"", "\""),
    )
    .unwrap();
    let mut def: AgentDefinition =
        serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
    def.detection.paths = vec![current.parent().unwrap().to_string_lossy().into_owned()];
    def.detection.commands.clear();
    def.plugin_inject.as_mut().unwrap().config_paths = vec![current.to_string_lossy().into_owned()];
    std::fs::write(
        defs.join("pi-coding-agent.json"),
        serde_json::to_vec(&def).unwrap(),
    )
    .unwrap();
    let initial = json!({"pi-coding-agent":{"deployMode":"plugin-inject","deployedAt":"2026-01-01","pluginInjectConfigPath":old},
        "unrelated":{"deployMode":"hook","deployedAt":"keep-original"}});
    let state = data.join("deployed-agents.json");
    std::fs::write(&state, serde_json::to_vec(&initial).unwrap()).unwrap();
    let assets = PluginAssets::load(&def, Path::new(env!("CARGO_MANIFEST_DIR")), &data).unwrap();
    let mut targets = assets.install_targets(&current).unwrap();
    targets.extend(assets.state_role());
    std::fs::create_dir(data.join(".plugin-install")).unwrap();
    let mut interrupted =
        ActivationTransaction::begin(&data.join(".plugin-install"), targets).unwrap();
    assets.prepare(&mut interrupted).unwrap();
    PluginAssets::write_config(
        &mut interrupted,
        Some(PluginConfigEdit {
            content: json!({"extensions":[data.join("plugins/pi-coding-agent/index.mjs").to_string_lossy().replace('\\', "/")]})
                .to_string(),
            backup: true,
        }),
    )
    .unwrap();
    let mut intended = initial.clone();
    intended["pi-coding-agent"]["pluginInjectConfigPath"] = json!(current);
    intended["unrelated"]["deployedAt"] = json!("uncommitted-must-roll-back");
    interrupted
        .write_preserving_mode(
            "deployment-state",
            &serde_json::to_vec(&intended).unwrap(),
            0o600,
        )
        .unwrap();
    // The real durable journal is left at the exact crash-before-commit phase.
    // No Drop rollback runs; the new manager must recover all original bytes.
    std::mem::forget(interrupted);
    assert!(recovery_pending(&data));
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&state).unwrap()).unwrap(),
        intended
    );
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: data.to_string_lossy().into_owned(),
        pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
        builtin_agents_dir: Some(defs.to_string_lossy().into_owned()),
        installed_by: None,
    });
    // Real OS locks, held by independent file handles, prove the public
    // recovery caller waits for all three lock domains before changing bytes.
    let locks = [
        data.join(".plugin-assets.lock"),
        PathBuf::from(format!("{}.loongsuite-pilot.lock", current.display())),
        data.join("deployed-agents.json.lock"),
    ]
    .map(|path| {
        let file = crate::deployment::deployed_state_merge::open_state_lock(&path)
            .unwrap()
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&file).unwrap();
        file
    });
    let recovery = manager.deploy_single(&def);
    tokio::pin!(recovery);
    for lock in locks {
        assert!(
            tokio::time::timeout(Duration::from_millis(75), &mut recovery)
                .await
                .is_err(),
            "recovery bypassed a held installation/config/state lock"
        );
        assert!(recovery_pending(&data));
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&state).unwrap()).unwrap(),
            intended
        );
        drop(lock);
    }
    let result = tokio::time::timeout(Duration::from_secs(5), recovery)
        .await
        .unwrap();
    assert!(result.success, "{:?}", result.error);
    assert!(!recovery_pending(&data));
    let after: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
    assert_eq!(after["unrelated"], initial["unrelated"]);
    assert_eq!(
        after["pi-coding-agent"]["pluginInjectConfigPath"],
        json!(current)
    );
    let config_text = std::fs::read_to_string(&current).unwrap();
    let config: Value =
        crate::utils::parse_json_document(&config_text, crate::utils::JsonSyntax::Jsonc).unwrap();
    assert!(config_text.contains("durable original"));
    assert_eq!(
        config["extensions"],
        json!([
            "third-party",
            data.join("plugins/pi-coding-agent/index.mjs")
                .to_string_lossy()
                .replace('\\', "/")
        ])
    );
    assert!(assets.healthy());
    assert!(!old.exists());
    assert!(started.elapsed() < Duration::from_secs(15));
}
