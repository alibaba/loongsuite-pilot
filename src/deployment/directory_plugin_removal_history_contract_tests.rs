use super::*;

#[tokio::test]
async fn current_install_marker_cannot_authorize_deletion_of_user_modified_plugin_content() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root
        .path()
        .join("Hermes O'Brien 🚀/plugins/loongsuite-pilot");
    let data = root.path().join("data");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("__init__.py"), "managed = True\n").unwrap();
    let def: AgentDefinition = serde_json::from_value(json!({
        "id":"hermes-agent","displayName":"Hermes","deployMode":"directory-plugin",
        "detection":{"paths":[],"commands":[]},
        "directoryPlugin":{"sourceDir":source,"targetDir":target}
    }))
    .unwrap();
    let strategy = DirectoryPluginStrategy::new(Some(data.to_string_lossy().into_owned()));
    assert!(strategy.deploy_directory(&def).await.success);
    let marker = std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap();
    std::fs::write(target.join("__init__.py"), "user_modified = True\n").unwrap();
    std::fs::write(target.join("customer.py"), "customer = 'keep'\n").unwrap();
    assert!(!strategy.remove_directory(&def).await);
    assert_eq!(
        std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap(),
        marker
    );
    assert_eq!(
        std::fs::read_to_string(target.join("__init__.py")).unwrap(),
        "user_modified = True\n"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("customer.py")).unwrap(),
        "customer = 'keep'\n"
    );
    std::fs::write(target.join("__init__.py"), "managed = True\n").unwrap();
    std::fs::remove_file(target.join("customer.py")).unwrap();
    assert!(strategy.remove_directory(&def).await);
    assert!(!target.exists());
}
