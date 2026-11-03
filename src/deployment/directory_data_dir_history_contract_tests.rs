use super::*;
use serde_json::json;

struct World {
    _temp: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    old_data: PathBuf,
    new_data: PathBuf,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("package source");
        let target = temp.path().join("hermes/plugins/loongsuite-pilot");
        let old_data = temp.path().join("old install data");
        let new_data = temp.path().join("new install data");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("plugin.yaml"), "name: loongsuite-pilot\n").unwrap();
        std::fs::write(source.join("plugin.py"), "print('owned plugin')\n").unwrap();
        Self {
            _temp: temp,
            source,
            target,
            old_data,
            new_data,
        }
    }
    fn definition(&self) -> AgentDefinition {
        serde_json::from_value(json!({
            "id":"hermes-agent","displayName":"Hermes Agent","deployMode":"directory-plugin",
            "detection":{"paths":[self.target.parent().unwrap()],"commands":[]},
            "directoryPlugin":{"sourceDir":self.source,"targetDir":self.target}
        }))
        .unwrap()
    }
    fn old(&self) -> DirectoryPluginStrategy {
        DirectoryPluginStrategy::new(Some(self.old_data.to_string_lossy().into_owned()))
    }
    fn new_install(&self) -> DirectoryPluginStrategy {
        DirectoryPluginStrategy::new(Some(self.new_data.to_string_lossy().into_owned()))
    }
    fn marker(&self) -> PathBuf {
        self.target.join(DEFAULT_MARKER_FILE)
    }
}

#[tokio::test]
async fn original_l278_reports_data_ownership_and_safe_old_install_cleanup_allows_explicit_retry() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let world = World::new();
        let def = world.definition();
        let old = world.old();
        let new_install = world.new_install();
        assert!(old.deploy_directory(&def).await.success);
        let marker = std::fs::read(world.marker()).unwrap();
        let plugin = std::fs::read(world.target.join("plugin.py")).unwrap();
        assert!(new_install.directory_needs_deploy(&def, None).await);
        let refused = new_install.deploy_directory(&def).await;
        assert!(!refused.success);
        assert_eq!(std::fs::read(world.marker()).unwrap(), marker);
        assert_eq!(
            std::fs::read(world.target.join("plugin.py")).unwrap(),
            plugin
        );
        assert!(!old.directory_needs_deploy(&def, None).await);
        // This is explicit cleanup by the owning dataDir, not automatic
        // adoption by the other installation or a marker-only relocation API.
        assert!(old.undeploy(&def).await);
        assert!(!world.target.exists());
        assert!(new_install.deploy_directory(&def).await.success);
        let current: Value =
            serde_json::from_slice(&std::fs::read(world.marker()).unwrap()).unwrap();
        assert_eq!(
            Path::new(current["dataDir"].as_str().unwrap()),
            world.new_data
        );
        assert!(!new_install.directory_needs_deploy(&def, None).await);
        let diagnostic = refused.error.unwrap();
        assert!(
            diagnostic.contains("dataDir ownership differs"),
            "{diagnostic}"
        );
        assert!(diagnostic.contains("owning installation"), "{diagnostic}");
        assert!(diagnostic.contains("retry"), "{diagnostic}");
    })
    .await
    .expect("original five-second test deadline");
}

#[tokio::test]
async fn original_l278_retry_never_removes_dirty_old_or_unknown_plugin_content() {
    let world = World::new();
    let def = world.definition();
    let old = world.old();
    let new_install = world.new_install();
    assert!(old.deploy_directory(&def).await.success);
    std::fs::write(world.target.join("plugin.py"), "print('user changed')\n").unwrap();
    std::fs::write(world.target.join("foreign.txt"), "unknown sibling\n").unwrap();
    let marker = std::fs::read(world.marker()).unwrap();
    assert!(!new_install.deploy_directory(&def).await.success);
    assert!(!old.undeploy(&def).await);
    assert!(!new_install.deploy_directory(&def).await.success);
    assert_eq!(std::fs::read(world.marker()).unwrap(), marker);
    assert_eq!(
        std::fs::read_to_string(world.target.join("plugin.py")).unwrap(),
        "print('user changed')\n"
    );
    assert_eq!(
        std::fs::read_to_string(world.target.join("foreign.txt")).unwrap(),
        "unknown sibling\n"
    );
}
