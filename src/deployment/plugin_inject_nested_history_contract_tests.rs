use super::*;
use serde_json::json;
use std::{collections::HashMap, path::PathBuf};
tokio::task_local! {static HOST: OpenClawHost;}
pub(super) fn host_for_history() -> Option<OpenClawHost> {
    HOST.try_with(Clone::clone).ok()
}
struct World {
    _temp: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
    config: PathBuf,
    host: OpenClawHost,
}
impl World {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let package = root.join("openclaw-host");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"openclaw","version":"2026.5.12"}"#,
        )
        .unwrap();
        let executable = package.join("openclaw.mjs");
        std::fs::write(&executable, "// metadata fixture; never executed\n").unwrap();
        let env = HashMap::from([(
            "OPENCLAW_CLI_PATH".into(),
            executable.to_string_lossy().into_owned(),
        )]);
        let host = resolve_openclaw_host(
            &env,
            root.to_str().unwrap(),
            None::<fn(String)>,
            OpenClawResolveMode::Runtime,
        )
        .await
        .unwrap();
        assert!(is_openclaw_host_bound(Some(&host)));
        assert_eq!(host.version, "2026.5.12");
        assert!(host.conversation_access);
        assert_eq!(host.binding.as_deref(), Some("explicit-entry"));
        Self {
            _temp: temp,
            data: root.join("pilot-data"),
            config: root.join(".openclaw/openclaw.json"),
            root,
            host,
        }
    }
    fn strategy(&self) -> PluginInjectStrategy {
        PluginInjectStrategy::new(
            self.data.to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        )
    }
    fn def(&self) -> AgentDefinition {
        serde_json::from_value(json!({
            "id":"openclaw", "displayName":"OpenClaw", "deployMode":"plugin-inject",
            "detection":{"paths":[],"commands":[]},
            "pluginInject":{"configPaths":[self.config], "pluginSpec":"file://$PILOT_DATA/plugins/openclaw",
                "pluginId":"loongsuite-pilot-openclaw", "replaceSpecs":["loongsuite-pilot-openclaw","loongsuite-pilot-openclaw-smoke","$PILOT_DATA/plugins/openclaw/plugin.mjs"],
                "configShape":"openclaw-nested","createIfMissing":true}
        })).unwrap()
    }
    fn write(&self, value: Value) {
        std::fs::create_dir_all(self.config.parent().unwrap()).unwrap();
        std::fs::write(&self.config, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn read(&self) -> Value {
        serde_json::from_slice(&std::fs::read(&self.config).unwrap()).unwrap()
    }
    fn path(&self) -> String {
        self.data
            .join("plugins/openclaw")
            .to_string_lossy()
            .replace('\\', "/")
    }
    fn old(&self) -> String {
        format!("{}/plugin.mjs", self.path())
    }
    async fn deploy(&self, def: &AgentDefinition) {
        let result = self.strategy().deploy(def).await;
        assert!(result.success, "{result:?}");
    }
    async fn healthy(&self, def: &AgentDefinition) {
        assert!(!self.strategy().needs_deploy(def, None).await);
    }
    fn entry() -> Value {
        json!({"enabled":true,"hooks":{"allowConversationAccess":true}})
    }
    fn paths(&self) -> Vec<Value> {
        self.read()["plugins"]["load"]["paths"]
            .as_array()
            .unwrap()
            .clone()
    }
}
#[tokio::test]
async fn nested_l228_l290_l349_l446_real_bound_host_writes_nested_shape_health_idempotency_and_removal(
) {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let def = f.def();
        f.deploy(&def).await;
        let value = f.read();
        assert_eq!(value["plugins"]["load"]["paths"], json!([f.path()]));
        assert_eq!(
            value["plugins"]["entries"]["loongsuite-pilot-openclaw"],
            World::entry()
        );
        assert!(!value.get("plugin").is_some_and(Value::is_array));
        assert!(!value["plugins"].is_array());
        assert!(!f.paths().contains(&json!(format!("file://{}", f.path()))));
        f.healthy(&def).await;
        let before = std::fs::read(&f.config).unwrap();
        f.deploy(&def).await;
        assert_eq!(f.read(), value);
        assert_eq!(std::fs::read(&f.config).unwrap(), before);
        assert!(f.strategy().undeploy(&def).await);
        assert!(!f.paths().contains(&json!(f.path())));
        assert!(f.read()["plugins"]["entries"]
            .get("loongsuite-pilot-openclaw")
            .is_none());
    })
    .await;
}
#[tokio::test]
async fn nested_l244_l267_l274_health_repairs_each_independently_missing_requirement() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let def = f.def();
        f.deploy(&def).await; // Native health also validates actual bundle bytes.
        for value in [
            json!({"plugins":{"load":{"paths":[format!("file://{}", f.path())]},"entries":{}}}),
            json!({"plugins":{"load":{"paths":[]},"entries":{"loongsuite-pilot-openclaw":World::entry()}}}),
            json!({"plugins":{"load":{"paths":[f.path()]},"entries":{"loongsuite-pilot-openclaw":{"enabled":true,"hooks":{"allowConversationAccess":false}}}}}),
        ] {
            f.write(value);
            let before = std::fs::read(&f.config).unwrap();
            assert!(f.strategy().needs_deploy(&def, None).await);
            assert_eq!(std::fs::read(&f.config).unwrap(), before);
            f.deploy(&def).await;
            f.healthy(&def).await;
            assert_eq!(
                f.read()["plugins"]["entries"]["loongsuite-pilot-openclaw"],
                World::entry()
            );
        }
    }).await;
}
#[tokio::test]
async fn nested_l251_allowlist_adds_only_pilot_and_repeated_deploy_is_identical() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let def = f.def();
        f.deploy(&def).await;
        let mut value = f.read();
        value["plugins"]["allow"] = json!(["openclaw-security-sdk", "another-plugin"]);
        f.write(value);
        assert!(f.strategy().needs_deploy(&def, None).await);
        f.deploy(&def).await;
        assert_eq!(
            f.read()["plugins"]["allow"],
            json!([
                "openclaw-security-sdk",
                "another-plugin",
                "loongsuite-pilot-openclaw"
            ])
        );
        f.healthy(&def).await;
        let before = f.read();
        f.deploy(&def).await;
        assert_eq!(f.read(), before);
    })
    .await;
}
#[tokio::test]
async fn nested_l295_supplied_entry_config_is_a_required_deep_subset() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let mut def = f.def();
        f.deploy(&def).await;
        let desired = json!({"enabled":true,"hooks":{"allowConversationAccess":true},"config":{"captureMessageContent":false}});
        def.plugin_inject.as_mut().unwrap().entry_config =
            Some(desired.as_object().unwrap().clone());
        assert!(f.strategy().needs_deploy(&def, None).await);
        f.deploy(&def).await;
        f.healthy(&def).await;
        assert_eq!(
            f.read()["plugins"]["entries"]["loongsuite-pilot-openclaw"],
            desired
        );
    }).await;
}
#[tokio::test]
async fn nested_l311_l325_deep_merge_preserves_unrelated_paths_entries_and_settings() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let def = f.def();
        f.write(
            json!({"plugins":{"load":{"paths":["file:///other/plugin.mjs",f.path()]},"entries":{
        "other-plugin":{"enabled":true},"loongsuite-pilot-openclaw":{"enabled":true,
        "hooks":{"allowConversationAccess":false,"customHookSetting":"keep-me"},
        "config":{"captureMessageContent":false}}}}}),
        );
        f.deploy(&def).await;
        assert!(f.paths().contains(&json!("file:///other/plugin.mjs")));
        assert_eq!(
            f.read()["plugins"]["entries"]["other-plugin"],
            json!({"enabled":true})
        );
        assert_eq!(
            f.read()["plugins"]["entries"]["loongsuite-pilot-openclaw"],
            json!({"enabled":true,"hooks":{"allowConversationAccess":true,"customHookSetting":"keep-me"},"config":{"captureMessageContent":false}})
        );
        f.healthy(&def).await;
    }).await;
}
#[tokio::test]
async fn nested_l358_undeploy_removes_exact_owned_legacy_aliases_and_keeps_foreign_suffix() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let def = f.def();
        let old = f.old();
        let foreign = "/opt/vendor/plugins/openclaw/plugin.mjs";
        f.write(
            json!({"plugins":{"load":{"paths":[old,format!("file://{}",old),foreign]},
        "entries":{"loongsuite-pilot-openclaw":World::entry()}}}),
        );
        assert!(f.strategy().undeploy(&def).await);
        assert_eq!(f.paths(), vec![json!(foreign)]);
        // A foreign copy still consumes this shared plugin entry.
        assert_eq!(
            f.read()["plugins"]["entries"]["loongsuite-pilot-openclaw"],
            World::entry()
        );
        // With only owned legacy references, both path and entry are removable.
        f.write(
            json!({"plugins":{"load":{"paths":[old,format!("file://{}",old)]},
            "entries":{"loongsuite-pilot-openclaw":World::entry()}}}),
        );
        assert!(f.strategy().undeploy(&def).await);
        assert!(f.paths().is_empty());
        assert!(f.read()["plugins"]["entries"]
            .get("loongsuite-pilot-openclaw")
            .is_none());
    })
    .await;
}
#[tokio::test]
async fn nested_l403_l427_migrates_owned_single_file_and_preserves_unrelated_same_suffix() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let def = f.def();
        let old = f.old();
        let foreign = "/opt/vendor/plugins/openclaw/plugin.mjs";
        f.write(
            json!({"plugins":{"load":{"paths":[old,"/other/plugin.mjs",foreign]},
        "entries":{"loongsuite-pilot-openclaw":World::entry()}}}),
        );
        assert!(f.strategy().needs_deploy(&def, None).await);
        f.deploy(&def).await;
        assert!(!f.paths().contains(&json!(old)));
        for p in [f.path(), "/other/plugin.mjs".into(), foreign.into()] {
            assert!(f.paths().contains(&json!(p)));
        }
        f.healthy(&def).await;
    })
    .await;
}
#[tokio::test]
async fn nested_l383_foreign_named_suffix_requires_explicit_full_path_ownership() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let foreign = "file:///old/loongsuite-pilot-openclaw-smoke/plugin.mjs";
        let mut def = f.def();
        def.plugin_inject.as_mut().unwrap().replace_specs =
            Some(vec!["loongsuite-pilot-openclaw-smoke".into()]);
        f.write(json!({"plugins":{"load":{"paths":[foreign,"file:///other/plugin.mjs"]},"entries":{"other-plugin":{"enabled":true}}}}));
        f.deploy(&def).await;
        // A package name alone is not ownership of an arbitrary absolute path.
        assert!(f.paths().contains(&json!(foreign)));
        assert!(f.paths().contains(&json!("file:///other/plugin.mjs")));
        assert_eq!(
            f.read()["plugins"]["entries"]["other-plugin"],
            json!({"enabled":true})
        );
        // Explicit legacy path supplied by a trusted definition is sufficient.
        def.plugin_inject.as_mut().unwrap().replace_specs = Some(vec![foreign.into()]);
        f.deploy(&def).await;
        assert!(!f.paths().contains(&json!(foreign)));
        assert!(f.paths().contains(&json!("file:///other/plugin.mjs")));
        assert!(f.paths().contains(&json!(f.path())));
    }).await;
}
#[tokio::test]
async fn nested_l454_migrates_legacy_arrays_preserves_foreign_and_creates_private_exact_backup() {
    let f = World::new().await;
    HOST.scope(f.host.clone(), async {
        let def = f.def();
        let foreign = "file:///old/loongsuite-pilot-openclaw/plugin.mjs";
        let original = json!({"plugin":[foreign],"plugins":["file:///legacy/plugin.mjs"]});
        f.write(original.clone());
        assert!(f.strategy().needs_deploy(&def, None).await);
        f.deploy(&def).await;
        let cfg = f.read();
        assert!(!cfg.get("plugin").is_some_and(Value::is_array));
        assert!(!cfg["plugins"].is_array());
        for p in [
            f.path(),
            "/legacy/plugin.mjs".into(),
            "/old/loongsuite-pilot-openclaw/plugin.mjs".into(),
        ] {
            assert!(f.paths().contains(&json!(p)));
        }
        assert_eq!(
            cfg["plugins"]["entries"]["loongsuite-pilot-openclaw"],
            World::entry()
        );
        let backup = PathBuf::from(format!("{}.bak", f.config.to_string_lossy()));
        let value: Value = serde_json::from_slice(&std::fs::read(&backup).unwrap()).unwrap();
        assert_eq!(value, original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        f.healthy(&def).await;
        assert!(f.root.is_dir());
    })
    .await;
}
