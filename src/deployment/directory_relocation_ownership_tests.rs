use super::*;
use std::time::Duration;

struct RelocationFixture {
    _temp: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    old: PathBuf,
    new: PathBuf,
}
impl RelocationFixture {
    fn new(old_id: Option<&str>, new_id: Option<&str>) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("agent/plugins/loongsuite-pilot");
        let old = temp.path().join("old-data");
        let new = temp.path().join("new-data");
        for path in [&source, &old, &new] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(source.join("plugin.yaml"), "name: loongsuite-pilot\n").unwrap();
        std::fs::write(source.join("plugin.py"), "print('managed')\n").unwrap();
        for (path, id) in [(&old, old_id), (&new, new_id)] {
            let value = id
                .map(|id| json!({"autoUpdate":{"installId":id},"unrelated":"must remain private"}))
                .unwrap_or_else(|| json!({}));
            std::fs::write(path.join("config.json"), value.to_string()).unwrap();
        }
        Self {
            _temp: temp,
            source,
            target,
            old,
            new,
        }
    }
    fn def(&self) -> AgentDefinition {
        serde_json::from_value(
            json!({"id":"hermes-agent","displayName":"Hermes","deployMode":"directory-plugin",
        "detection":{"paths":[self.target.parent().unwrap()],"commands":[]},
        "directoryPlugin":{"sourceDir":self.source,"targetDir":self.target}}),
        )
        .unwrap()
    }
    fn strategy(&self, old: bool) -> DirectoryPluginStrategy {
        DirectoryPluginStrategy::new(Some(
            if old { &self.old } else { &self.new }
                .to_string_lossy()
                .into_owned(),
        ))
    }
    fn marker(&self) -> PathBuf {
        self.target.join(DEFAULT_MARKER_FILE)
    }
}
#[tokio::test]
async fn same_install_id_automatically_moves_a_healthy_directory_after_new_install_succeeds() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let f = RelocationFixture::new(Some("same-install"), Some("same-install"));
        let def = f.def();
        assert!(f.strategy(true).deploy_directory(&def).await.success);
        let before = std::fs::read(f.target.join("plugin.py")).unwrap();
        let result = f.strategy(false).deploy_directory(&def).await;
        assert!(
            result.success,
            "same-install relocation failed: {:?}",
            result.error
        );
        let marker: Value = serde_json::from_slice(&std::fs::read(f.marker()).unwrap()).unwrap();
        assert_eq!(marker["dataDir"], f.new.to_string_lossy().as_ref());
        assert_eq!(marker["installId"], "same-install");
        assert_eq!(std::fs::read(f.target.join("plugin.py")).unwrap(), before);
        assert!(!f.strategy(false).directory_needs_deploy(&def, None).await);
        assert!(!f.strategy(true).undeploy(&def).await);
        assert!(!std::fs::read_dir(f.target.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".loongsuite-pilot.loongsuite-pilot-")));
    })
    .await
    .expect("original five-second directory contract");
}
#[tokio::test]
async fn legacy_schema_one_without_marker_id_uses_only_matching_old_config_install_id() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let f = RelocationFixture::new(Some("legacy-install"), Some("legacy-install"));
        let def = f.def();
        assert!(f.strategy(true).deploy_directory(&def).await.success);
        let mut marker: Value =
            serde_json::from_slice(&std::fs::read(f.marker()).unwrap()).unwrap();
        marker.as_object_mut().unwrap().remove("installId");
        std::fs::write(f.marker(), serde_json::to_vec(&marker).unwrap()).unwrap();
        assert!(f.strategy(false).deploy_directory(&def).await.success);
        let marker: Value = serde_json::from_slice(&std::fs::read(f.marker()).unwrap()).unwrap();
        assert_eq!(marker["installId"], "legacy-install");
        assert_eq!(marker["dataDir"], f.new.to_string_lossy().as_ref());
    })
    .await
    .expect("original five-second directory contract");
}
#[tokio::test]
async fn different_or_unproven_installations_and_dirty_targets_cannot_be_adopted() {
    for (old_id, new_id, dirty) in [
        (Some("first"), Some("second"), false),
        (Some("foreign-owner"), Some("second"), false),
        (Some("same"), Some("same"), true),
    ] {
        tokio::time::timeout(Duration::from_secs(5), async {
            let f = RelocationFixture::new(old_id, new_id);
            let def = f.def();
            assert!(f.strategy(true).deploy_directory(&def).await.success);
            if dirty {
                std::fs::write(f.target.join("plugin.py"), "user changed\n").unwrap();
                std::fs::write(f.target.join("foreign"), "unknown\n").unwrap();
            }
            let marker = std::fs::read(f.marker()).unwrap();
            let body = std::fs::read(f.target.join("plugin.py")).unwrap();
            assert!(!f.strategy(false).deploy_directory(&def).await.success);
            assert_eq!(std::fs::read(f.marker()).unwrap(), marker);
            assert_eq!(std::fs::read(f.target.join("plugin.py")).unwrap(), body);
            if dirty {
                assert_eq!(
                    std::fs::read(f.target.join("foreign")).unwrap(),
                    b"unknown\n"
                );
            }
        })
        .await
        .expect("five-second negative control");
    }
}
#[tokio::test]
async fn proven_directory_relocation_activation_failure_rolls_back_all_old_bytes_and_marker() {
    tokio::time::timeout(Duration::from_secs(5),async{
        let f=RelocationFixture::new(Some("same"),Some("same"));let mut def=f.def();
        assert!(f.strategy(true).deploy_directory(&def).await.success);
        let marker=std::fs::read(f.marker()).unwrap();let body=std::fs::read(f.target.join("plugin.py")).unwrap();
        def.directory_plugin.as_mut().unwrap().activation=Some(serde_json::from_value(json!({"command":"private-activation-fixture",
            "probeArgs":["plugins","enable","--help"],"enableArgs":["plugins","enable","loongsuite-pilot"]})).unwrap());
        history_test_hooks::scope(Some(history_test_hooks::Mode::EnableFailure),false,async{
            let failed=f.strategy(false).deploy_directory(&def).await;
            assert!(!failed.success);
            assert!(failed.error.unwrap().contains("enable failed"));
            assert_eq!(history_test_hooks::calls().len(),2);
        }).await;
        assert_eq!(std::fs::read(f.marker()).unwrap(),marker);
        assert_eq!(std::fs::read(f.target.join("plugin.py")).unwrap(),body);
        assert!(!f.strategy(true).directory_needs_deploy(&f.def(),None).await);
    }).await.expect("original five-second rollback contract");
}

#[tokio::test]
async fn contradictory_or_invalid_legacy_identity_evidence_never_authorizes_relocation() {
    for mutation in [
        "other-config-id",
        "invalid-config",
        "bad-marker-id",
        "invalid-legacy-config",
    ] {
        tokio::time::timeout(Duration::from_secs(5), async {
            let f = RelocationFixture::new(Some("same"), Some("same"));
            let def = f.def();
            assert!(f.strategy(true).deploy_directory(&def).await.success);
            let mut marker: Value =
                serde_json::from_slice(&std::fs::read(f.marker()).unwrap()).unwrap();
            match mutation {
                "other-config-id" => std::fs::write(
                    f.old.join("config.json"),
                    json!({"installId":"foreign"}).to_string(),
                )
                .unwrap(),
                "invalid-config" => std::fs::write(f.old.join("config.json"), "{bad").unwrap(),
                "bad-marker-id" => marker["installId"] = json!("foreign"),
                _ => {
                    marker.as_object_mut().unwrap().remove("installId");
                    std::fs::write(f.old.join("config.json"), "[]").unwrap();
                }
            }
            std::fs::write(f.marker(), serde_json::to_vec(&marker).unwrap()).unwrap();
            let bytes = std::fs::read(f.marker()).unwrap();
            assert!(!f.strategy(false).deploy_directory(&def).await.success);
            assert_eq!(std::fs::read(f.marker()).unwrap(), bytes);
            assert_eq!(
                std::fs::read(f.target.join("plugin.py")).unwrap(),
                b"print('managed')\n"
            );
        })
        .await
        .expect("five-second identity refusal");
    }
}
#[tokio::test]
async fn modern_marker_identity_survives_removed_old_config_and_effective_identity_is_authoritative(
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let f = RelocationFixture::new(Some("same"), Some("same"));
        let def = f.def();
        assert!(f.strategy(true).deploy_directory(&def).await.success);
        std::fs::remove_file(f.old.join("config.json")).unwrap();
        let before = std::fs::read(f.marker()).unwrap();
        let refused = f
            .strategy(false)
            .with_installation_id(None)
            .deploy_directory(&def)
            .await;
        assert!(!refused.success);
        assert_eq!(std::fs::read(f.marker()).unwrap(), before);
        assert!(
            f.strategy(false)
                .with_installation_id(Some("same".into()))
                .deploy_directory(&def)
                .await
                .success
        );
    })
    .await
    .expect("five-second effective identity binding");
}

#[tokio::test]
async fn legacy_owned_unchanged_payload_relocates_without_any_install_id_or_old_config() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let f = RelocationFixture::new(None, None);
        let def = f.def();
        assert!(f.strategy(true).deploy_directory(&def).await.success);
        std::fs::remove_file(f.old.join("config.json")).unwrap();
        std::fs::remove_dir(&f.old).unwrap();
        std::fs::remove_file(f.new.join("config.json")).unwrap();
        std::fs::remove_dir(&f.new).unwrap();
        assert!(f.strategy(false).directory_needs_deploy(&def, None).await);
        let result = f.strategy(false).deploy_directory(&def).await;
        assert!(result.success, "{:?}", result.error);
        let marker: Value = serde_json::from_slice(&std::fs::read(f.marker()).unwrap()).unwrap();
        assert_eq!(marker["dataDir"], json!(f.new));
        assert!(!f.strategy(false).directory_needs_deploy(&def, None).await);
        assert!(f.target.join("plugin.py").is_file());
    })
    .await
    .expect("original five-second directory contract");
}

#[tokio::test]
async fn invalid_effective_custom_config_identity_never_falls_back_to_legacy_relocation() {
    for mutation in [
        "root-versus-nested",
        "effective-versus-disk",
        "invalid-json",
        "nonobject",
    ] {
        tokio::time::timeout(Duration::from_secs(5),async{
            let f=RelocationFixture::new(None,None); let def=f.def();
            assert!(f.strategy(true).deploy_directory(&def).await.success);
            let original_marker=std::fs::read(f.marker()).unwrap();
            let original_body=std::fs::read(f.target.join("plugin.py")).unwrap();
            let custom=f.new.join("custom-config.json");
            let env=std::collections::HashMap::new();
            let file=json!({"dataDir":f.new,"dashboard":{"enabled":false},"autoUpdate":{"enabled":false}});
            let mut config=crate::core::assemble_config(Some(&file),None,&crate::core::ConfigSources{
                env:&env,platform:crate::utils::Platform::current(),hostname:"custom-identity-fixture",
                config_path:custom.to_str().unwrap(),global_poll_ms:None}).unwrap();
            config.auto_update=Some(serde_json::from_value(json!({"enabled":false,"checkIntervalMs":60000,"installId":"effective-install"})).unwrap());
            config.source_config_path=Some(custom.to_string_lossy().into_owned());
            let raw=match mutation {
                "root-versus-nested"=>json!({"autoUpdate":{"installId":"effective-install"},"installId":"foreign-install"}).to_string(),
                "effective-versus-disk"=>json!({"autoUpdate":{"installId":"foreign-install"}}).to_string(),
                "invalid-json"=>"{invalid".into(),
                _=>"[]".into(),
            };
            std::fs::write(&custom,&raw).unwrap();
            let result=f.strategy(false).with_config_identity(&config).deploy_directory(&def).await;
            assert!(!result.success,"invalid identity became legacy authority: {mutation}");
            assert_eq!(std::fs::read(f.marker()).unwrap(),original_marker);
            assert_eq!(std::fs::read(f.target.join("plugin.py")).unwrap(),original_body);
            assert_eq!(std::fs::read_to_string(custom).unwrap(),raw);
        }).await.expect("original five-second invalid custom config contract");
    }
}
