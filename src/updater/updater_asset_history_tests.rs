// Component tests call the production verified updater activation path.
// Candidate execution responses are scripted; real candidate subprocess coverage lives in installer_native.
fn asset_history_package(root: &Path, version: &str, commit: &str, reference: &str) -> VersionManifest {
    let manifest = native_package_version(root, version, commit);
    let mut runtime: crate::utils::runtime_paths::RuntimeManifest =
        serde_json::from_slice(&std::fs::read(root.join("runtime-manifest.json")).unwrap()).unwrap();
    for (relative, text) in [
        ("assets/skills/loongsuite-pilot-ops/references/cursor-diagnostics.md", reference),
        ("assets/plugins/dsh/plugin.mjs", include_str!("../../assets/plugins/dsh/plugin.mjs")),
        ("assets/plugins/shared/resource-context.mjs", include_str!("../../assets/plugins/shared/resource-context.mjs")),
    ] {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        runtime.resources.push(crate::utils::runtime_paths::RuntimeResource {
            path: relative.into(), sha256: crate::utils::runtime_paths::sha256_file(&path).unwrap(),
        });
    }
    std::fs::write(root.join("runtime-manifest.json"), serde_json::to_vec(&runtime).unwrap()).unwrap();
    manifest
}

#[tokio::test]
async fn updater_asset_preflight_failure_never_touches_live_resources_or_version() {
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join("versions/candidate");
    let manifest = asset_history_package(&staging, "1.2.0", &"a".repeat(40), "candidate reference\n");
    let net = ScriptedNet::new(vec![], vec![Err(CommandFailure::message("private preflight denied"))]);
    let mut updater = Updater::with_net(base_config(), root.path().to_str(), net);
    updater.paths.loongsuite_pilot_bin = root.path().join("bin/service").to_string_lossy().into_owned();
    std::fs::write(&updater.config_path, b"{\"user\":\"keep\"}\n").unwrap();
    let error = match updater.activate_staged(&staging, &manifest).await {
        Ok(_) => panic!("denied candidate was activated"), Err(error) => error,
    };
    assert!(error.contains("private preflight denied"), "{error}");
    assert!(!root.path().join("skills/loongsuite-pilot-ops/references/cursor-diagnostics.md").exists());
    assert!(!root.path().join("plugins").exists());
    assert!(!root.path().join("current").exists());
    assert!(!root.path().join("update-recovery.json").exists());
    assert!(staging.is_dir());
    assert_eq!(std::fs::read(&updater.config_path).unwrap(), b"{\"user\":\"keep\"}\n");
}

#[tokio::test]
async fn updater_activation_and_rollback_use_one_tree_and_pointer_journal() {
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join("versions/candidate");
    let manifest = asset_history_package(&staging, "1.2.0", &"a".repeat(40), "candidate reference\n");
    let net = ScriptedNet::new(vec![], preflight_outputs(&manifest));
    let mut updater = Updater::with_net(base_config(), root.path().to_str(), net);
    updater.paths.loongsuite_pilot_bin = root.path().join("bin/service").to_string_lossy().into_owned();
    std::fs::write(&updater.config_path, "{}").unwrap();
    let mut transaction = updater.activate_staged(&staging, &manifest).await.unwrap();
    assert_eq!(std::fs::read(root.path().join("skills/loongsuite-pilot-ops/references/cursor-diagnostics.md")).unwrap(), b"candidate reference\n");
    assert_eq!(std::fs::read(root.path().join("plugins/dsh/plugin.mjs")).unwrap(),
        include_bytes!("../../assets/plugins/dsh/plugin.mjs"));
    assert_eq!(std::fs::read(root.path().join("plugins/shared/resource-context.mjs")).unwrap(),
        include_bytes!("../../assets/plugins/shared/resource-context.mjs"));
    assert!(root.path().join("current").is_file());
    let journal: Value = serde_json::from_slice(&std::fs::read(root.path().join("update-recovery.json")).unwrap()).unwrap();
    assert_eq!(journal["schema"], 2);
    assert!(journal.get("directories").is_none());
    assert!(journal["targets"].as_object().unwrap().keys().any(|key| key.starts_with("runtime-resource:")));
    assert!(!root.path().join("plugins/dsh/.collection-enabled").exists());
    transaction.rollback().unwrap();
    assert!(!root.path().join("skills/loongsuite-pilot-ops/references/cursor-diagnostics.md").exists());
    assert!(!root.path().join("plugins/dsh/plugin.mjs").exists());
    assert!(!root.path().join("plugins/shared/resource-context.mjs").exists());
    assert!(!root.path().join("current").exists());
    assert!(!root.path().join("update-recovery.json").exists());
    assert_eq!(std::fs::read(&updater.config_path).unwrap(), b"{}");
}

#[tokio::test]
async fn updater_owned_asset_upgrade_commits_and_preserves_unknown_documents() {
    let root = tempfile::tempdir().unwrap();
    let old = root.path().join("versions/1.1.0_old");
    asset_history_package(&old, "1.1.0", &"b".repeat(40), "old reference\n");
    std::fs::write(root.path().join("current"), "1.1.0_old\n").unwrap();
    let old_manifest = validate_runtime(&old, "1.1.0", build_target(), build_edition()).unwrap();
    let assets = crate::deployment::runtime_data_assets::RuntimeDataAssets::load(
        &old, root.path(), root.path(), &old_manifest).unwrap();
    let mut producer = ActivationTransaction::begin(
        &root.path().join("fixture-initial-assets"), assets.targets(root.path(), false).unwrap()).unwrap();
    assets.install(&mut producer, false).unwrap();
    producer.commit().unwrap();
    std::fs::write(root.path().join("skills/user.md"), "private user reference\n").unwrap();
    let staging = root.path().join("versions/candidate");
    let manifest = asset_history_package(&staging, "1.2.0", &"a".repeat(40), "new reference\n");
    let net = ScriptedNet::new(vec![], preflight_outputs(&manifest));
    let mut updater = Updater::with_net(base_config(), root.path().to_str(), net);
    updater.paths.loongsuite_pilot_bin = root.path().join("bin/service").to_string_lossy().into_owned();
    std::fs::write(&updater.config_path, "{}").unwrap();
    let mut transaction = updater.activate_staged(&staging, &manifest).await.unwrap();
    transaction.commit().unwrap();
    assert_eq!(std::fs::read(root.path().join("skills/loongsuite-pilot-ops/references/cursor-diagnostics.md")).unwrap(), b"new reference\n");
    assert_eq!(std::fs::read(root.path().join("skills/user.md")).unwrap(), b"private user reference\n");
    assert_eq!(std::fs::read(root.path().join("previous")).unwrap(), b"1.1.0_old\n");
    assert!(!root.path().join("update-recovery.json").exists());
    for path in [root.path().join(".skills.loongsuite-pilot-activation-backup"),
        root.path().join("plugins/.dsh.loongsuite-pilot-activation-backup"),
        root.path().join("plugins/.shared.loongsuite-pilot-activation-backup")] {
        assert!(!path.exists());
    }
}
