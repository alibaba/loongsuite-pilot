use super::*;
use crate::deployment::PluginInjectStrategy;
use crate::types::{AgentDefinition, DeployStrategy};
use serde_json::json;
use std::path::PathBuf;

const PLUGIN: &str = "loongsuite-pilot-openclaw";
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        Self { _temp: temp, root }
    }
    fn pkg(&self, relative: &str, version: &str) -> PathBuf {
        let dir = self.root.join(relative);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            json!({"name":"openclaw","version":version}).to_string(),
        )
        .unwrap();
        let entry = dir.join("openclaw.mjs");
        std::fs::write(&entry, "/* metadata test, never executed */").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        entry
    }
    fn link(&self, entry: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(entry, link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(entry, link).unwrap();
    }
    fn child(&self, mode: &str, pairs: &[(&str, String)], cwd: &Path) {
        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact","deployment::openclaw_version_resolver::strategy_history_contract_tests::native_isolated_strategy_contract_child","--nocapture"])
            .env("PILOT_OC_STRATEGY_ROOT",&self.root).env("PILOT_OC_STRATEGY_MODE",mode)
            .env("HOME",self.root.join("home")).env("USERPROFILE",self.root.join("home"))
            .env("XDG_CONFIG_HOME",self.root.join("xdg")).env("LOONGSUITE_PILOT_DATA_DIR",&self.root)
            .env("AGENT_DATA_COLLECTION_CONFIG",self.root.join("pilot.json"))
            .env("PATH","").current_dir(cwd);
        for key in [
            "OPENCLAW_CLI_PATH",
            "OPENCLAW_BUNDLE_ROOT",
            "OPENCLAW_CONFIG_PATH",
            "OPENCLAW_STATE_DIR",
            "OPENCLAW_SERVICE_VERSION",
            "OPENCLAW_BUNDLED_VERSION",
        ] {
            cmd.env_remove(key);
        }
        for (key, value) in pairs {
            cmd.env(key, value);
        }
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "mode={mode}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn definition(config: &Path) -> AgentDefinition {
    serde_json::from_value(json!({"id":"openclaw","displayName":"OpenClaw","deployMode":"plugin-inject","detection":{"paths":[],"commands":[]},
        "pluginInject":{"configPaths":[config],"configShape":"openclaw-nested","createIfMissing":true,
            "pluginId":PLUGIN,"pluginSpec":"file://$PILOT_DATA/plugins/openclaw"}})).unwrap()
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn flag(value: &Value) -> Option<Value> {
    value
        .pointer("/plugins/entries/loongsuite-pilot-openclaw/hooks/allowConversationAccess")
        .cloned()
}
fn pkg(root: &Path, version: &str) {
    std::fs::write(
        root.join("app/package.json"),
        json!({"name":"openclaw","version":version}).to_string(),
    )
    .unwrap();
    std::fs::write(
        root.join("app/openclaw.mjs"),
        "/* metadata test, never executed */",
    )
    .unwrap();
}
#[tokio::test]
async fn native_isolated_strategy_contract_child() {
    let Ok(mode) = std::env::var("PILOT_OC_STRATEGY_MODE") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("PILOT_OC_STRATEGY_ROOT").unwrap());
    let config = if mode == "repair" {
        root.join("openclaw.json")
    } else if mode.starts_with("container") {
        root.join("unused.json")
    } else {
        root.join("gateway.json")
    };
    let mut def = definition(&config);
    let strategy = PluginInjectStrategy::new(text(&root), env!("CARGO_MANIFEST_DIR").into());
    if mode.starts_with("auto") {
        let env = std::env::vars().collect();
        let host = resolve_openclaw_host(
            &env,
            std::env::current_dir().unwrap().to_str().unwrap(),
            None::<fn(String)>,
            OpenClawResolveMode::Runtime,
        )
        .await
        .unwrap();
        assert_eq!(host.version, "2026.6.10");
        assert!(is_openclaw_host_bound(Some(&host)));
        assert_eq!(host.binding.as_deref(), Some("auto-entry"));
        assert!(strategy.detect(&def).await);
        assert!(strategy.needs_deploy(&def, None).await);
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{result:?}");
        assert!(!strategy.needs_deploy(&def, None).await);
        assert_eq!(flag(&read(&config)), Some(json!(true)));
    } else if mode.starts_with("persist") {
        let access = std::env::var("PILOT_OC_EXPECT_ACCESS").unwrap() == "true";
        if mode == "persist-install" {
            let result = strategy.deploy(&def).await;
            assert!(result.success, "{result:?}");
            assert_eq!(
                flag(&read(&config)),
                if access { Some(json!(true)) } else { None }
            );
            assert!(!strategy.needs_deploy(&def, None).await);
        } else {
            let before = std::fs::read(&config).unwrap();
            if mode == "persist-check" {
                assert!(strategy.detect(&def).await);
                assert!(!strategy.needs_deploy(&def, None).await);
                assert!(strategy.deploy(&def).await.success);
                assert_eq!(
                    flag(&read(&config)),
                    if access { Some(json!(true)) } else { None }
                );
            } else {
                assert!(!strategy.detect(&def).await);
                assert!(strategy.needs_deploy(&def, None).await);
                assert!(!strategy.deploy(&def).await.success);
            }
            assert_eq!(std::fs::read(&config).unwrap(), before);
        }
    } else if mode == "ambiguous" {
        let before = std::fs::read(&config).unwrap();
        let mtime = std::fs::metadata(&config).unwrap().modified().unwrap();
        assert!(!strategy.detect(&def).await);
        assert!(!strategy.deploy(&def).await.success);
        assert_eq!(std::fs::read(&config).unwrap(), before);
        assert_eq!(
            std::fs::metadata(&config).unwrap().modified().unwrap(),
            mtime
        );
        std::fs::remove_file(&config).unwrap();
        assert!(!strategy.deploy(&def).await.success);
        assert!(!config.exists());
    } else if mode == "repair" {
        assert!(strategy.needs_deploy(&def, None).await);
        assert!(strategy.deploy(&def).await.success);
        assert_eq!(
            read(&config)["plugins"]["entries"][PLUGIN],
            json!({"enabled":true,"config":{"captureMessageContent":false}})
        );
        assert!(!strategy.needs_deploy(&def, None).await);
        pkg(&root, "2026.5.12");
        assert!(strategy.needs_deploy(&def, None).await);
        assert!(strategy.deploy(&def).await.success);
        assert_eq!(flag(&read(&config)), Some(json!(true)));
        pkg(&root, "2026.3.8");
        assert!(strategy.deploy(&def).await.success);
        assert!(read(&config)["plugins"]["entries"][PLUGIN]
            .get("hooks")
            .is_none());
        pkg(&root, "broken");
        let before = std::fs::read(&config).unwrap();
        assert!(!strategy.deploy(&def).await.success);
        assert_eq!(std::fs::read(&config).unwrap(), before);
        assert!(strategy.undeploy(&def).await);
        assert_eq!(
            read(&config)["plugins"]["entries"],
            json!({"thirdParty":{"enabled":true}})
        );
        std::fs::remove_file(&config).unwrap();
        assert!(!strategy.deploy(&def).await.success);
        assert!(!config.exists());
    } else if mode.starts_with("container") {
        let actual = root.join(if mode == "container-state" {
            "state/openclaw.json"
        } else {
            "profile/openclaw.json"
        });
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{result:?}");
        assert!(!strategy.needs_deploy(&def, None).await);
        assert!(strategy.undeploy(&def).await);
        assert_eq!(read(&actual)["plugins"]["entries"], json!({}));
        assert!(!config.exists());
    } else if mode.starts_with("ownership-") {
        std::fs::write(&config,json!({
            "outside":{"preserve":"user"},
            "plugins":{"entries":{"loongsuite-pilot-openclaw":{"enabled":true,"config":{"captureMessageContent":false}},
                "thirdParty":{"enabled":true,"config":{"keep":"foreign"}}}}
        }).to_string()).unwrap();
        assert!(strategy.deploy(&def).await.success);
        let mut installed = read(&config);
        let entry_before = installed["plugins"]["entries"][PLUGIN].clone();
        let third_before = installed["plugins"]["entries"]["thirdParty"].clone();
        let resource = root.join("plugins/openclaw/plugin.mjs");
        if mode == "ownership-modified-resource" {
            std::fs::write(&resource, "/* user changed official resource */\n").unwrap();
        } else if mode == "ownership-no-own-path" {
            installed["plugins"]["load"]["paths"] = json!([]);
        } else if mode == "ownership-unknown-remaining-path" {
            installed["plugins"]["load"]["paths"]
                .as_array_mut()
                .unwrap()
                .push(json!(root.join("foreign-plugin")));
        } else if mode == "ownership-unmanaged-spec" {
            def.plugin_inject.as_mut().unwrap().plugin_spec =
                format!("file://{}", root.join("user-plugin").display());
            installed["plugins"]["load"]["paths"] = json!([root.join("user-plugin")]);
        } else if mode == "ownership-legacy-alias-only" {
            def.plugin_inject.as_mut().unwrap().replace_specs =
                Some(vec!["loongsuite-pilot-openclaw-legacy".into()]);
            installed["plugins"]["load"]["paths"] = json!(["loongsuite-pilot-openclaw-legacy"]);
        } else {
            panic!("unknown ownership fixture mode");
        }
        std::fs::write(&config, serde_json::to_vec(&installed).unwrap()).unwrap();
        assert!(strategy.undeploy(&def).await);
        let after = read(&config);
        assert_eq!(after["plugins"]["entries"][PLUGIN], entry_before);
        assert_eq!(after["plugins"]["entries"]["thirdParty"], third_before);
        assert_eq!(after["outside"], json!({"preserve":"user"}));
        if mode == "ownership-modified-resource" {
            assert_eq!(
                std::fs::read_to_string(resource).unwrap(),
                "/* user changed official resource */\n"
            );
        }
        if mode == "ownership-unknown-remaining-path" {
            assert_eq!(
                after["plugins"]["load"]["paths"],
                json!([root.join("foreign-plugin")])
            );
        }
    } else {
        panic!("unknown strategy fixture mode");
    }
}
#[test]
fn source_l179_all_three_unique_unbound_installations_use_real_strategy_and_conversation_schema() {
    for source in ["path", "cwd", "bundle"] {
        let f = Fixture::new();
        let entry = f.pkg(
            if source == "bundle" {
                "bundle/openclaw/node_modules/openclaw"
            } else {
                "app"
            },
            "2026.6.10",
        );
        let link = entry.parent().unwrap().join("openclaw");
        f.link(&entry, &link);
        let pairs = if source == "path" {
            vec![("PATH", text(entry.parent().unwrap()))]
        } else if source == "bundle" {
            vec![("OPENCLAW_BUNDLE_ROOT", text(&f.root.join("bundle")))]
        } else {
            vec![]
        };
        let cwd = if source == "cwd" {
            entry.parent().unwrap()
        } else {
            f.root.as_path()
        };
        f.child(&format!("auto-{source}"), &pairs, cwd);
    }
}
#[test]
fn source_l201_both_gateway_versions_persist_across_fresh_strategy_processes_cwd_and_env_loss() {
    for (gateway_version, path_version, access) in [
        ("2026.3.8", "2026.6.10", false),
        ("2026.6.10", "2026.3.8", true),
    ] {
        let f = Fixture::new();
        let entry = f.pkg("app", gateway_version);
        let other = f.pkg("other-cli", path_version);
        f.link(&other, &other.parent().unwrap().join("openclaw"));
        let path = text(other.parent().unwrap());
        let access = access.to_string();
        f.child(
            "persist-install",
            &[
                ("OPENCLAW_CLI_PATH", text(&entry)),
                ("PATH", path.clone()),
                ("PILOT_OC_EXPECT_ACCESS", access.clone()),
            ],
            &f.root,
        );
        let before = std::fs::read(f.root.join("gateway.json")).unwrap();
        let pilot = f.root.join("pilot-config.json");
        std::fs::write(
            &pilot,
            json!({"agents":{"openclaw":{"cliPath":entry}}}).to_string(),
        )
        .unwrap();
        let cwd = f.root.join("changed-cwd");
        std::fs::create_dir(&cwd).unwrap();
        let next = [
            ("AGENT_DATA_COLLECTION_CONFIG", text(&pilot)),
            ("PATH", path),
            ("PILOT_OC_EXPECT_ACCESS", access),
        ];
        f.child("persist-check", &next, &cwd);
        assert_eq!(std::fs::read(f.root.join("gateway.json")).unwrap(), before);
        std::fs::remove_file(entry).unwrap();
        f.child("persist-missing", &next, &cwd);
        assert_eq!(std::fs::read(f.root.join("gateway.json")).unwrap(), before);
    }
}
#[test]
fn source_l308_ambiguous_auto_discovery_preserves_config_bytes_mtime_and_missing_file() {
    let f = Fixture::new();
    f.pkg("app", "2026.3.8");
    let other = f.pkg("cli", "2026.6.10");
    f.link(&other, &other.parent().unwrap().join("openclaw"));
    std::fs::write(
        f.root.join("gateway.json"),
        r#"{"plugins":{"entries":{"third-party":{"enabled":true}}}}"#,
    )
    .unwrap();
    f.child(
        "ambiguous",
        &[("PATH", text(other.parent().unwrap()))],
        &f.root.join("app"),
    );
}
#[test]
fn source_l386_actual_managed_install_repairs_upgrade_downgrade_unknown_and_own_uninstall() {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8");
    std::fs::write(f.root.join("openclaw.json"),json!({"plugins":{"entries":{
        "loongsuite-pilot-openclaw":{"enabled":true,"hooks":{"allowConversationAccess":true},"config":{"captureMessageContent":false}},
        "thirdParty":{"enabled":true}
    }}}).to_string()).unwrap();
    f.child("repair", &[("OPENCLAW_CLI_PATH", text(&entry))], &f.root);
}
#[test]
fn source_l422_official_container_config_path_controls_both_injection_and_cleanup() {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8");
    let actual = f.root.join("profile/openclaw.json");
    f.child(
        "container",
        &[
            ("OPENCLAW_CLI_PATH", text(&entry)),
            ("OPENCLAW_CONFIG_PATH", text(&actual)),
        ],
        &f.root,
    );
}

#[test]
fn native_verified_self_cleanup_retains_unknown_ownership_and_user_resources() {
    for mode in [
        "ownership-modified-resource",
        "ownership-no-own-path",
        "ownership-unknown-remaining-path",
        "ownership-unmanaged-spec",
        "ownership-legacy-alias-only",
    ] {
        let f = Fixture::new();
        let entry = f.pkg("app", "2026.3.8");
        f.child(mode, &[("OPENCLAW_CLI_PATH", text(&entry))], &f.root);
    }
}
#[test]
fn native_empty_config_hint_allows_official_state_directory_precedence() {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8");
    f.child(
        "container-state",
        &[
            ("OPENCLAW_CLI_PATH", text(&entry)),
            ("OPENCLAW_CONFIG_PATH", "".into()),
            ("OPENCLAW_STATE_DIR", text(&f.root.join("state"))),
        ],
        &f.root,
    );
}
