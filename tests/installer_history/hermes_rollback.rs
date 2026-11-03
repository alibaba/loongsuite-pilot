use super::*;
use loongsuite_pilot::types::AgentDefinition;

fn copy_package(source: &Path, destination: &Path) {
    for entry in walkdir::WalkDir::new(source) {
        let entry = entry.unwrap();
        let relative = entry.path().strip_prefix(source).unwrap();
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target).unwrap();
        } else if relative.starts_with("bin") {
            if fs::hard_link(entry.path(), &target).is_err() {
                fs::copy(entry.path(), target).unwrap();
            }
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
fn manifest(root: &Path) {
    use loongsuite_pilot::utils::runtime_paths::sha256_file;
    let path = root.join("runtime-manifest.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["resources"] = json!(walkdir::WalkDir::new(root).into_iter()
        .map(Result::unwrap).filter(|entry| entry.file_type().is_file() && entry.path() != path)
        .map(|entry| json!({"path":entry.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\',"/"),"sha256":sha256_file(entry.path()).unwrap()})).collect::<Vec<_>>());
    fs::write(path, value.to_string()).unwrap();
}
struct Hermes {
    fixture: Fixture,
    outgoing: PathBuf,
    target_version: PathBuf,
    plugin: PathBuf,
    definition: AgentDefinition,
}
impl Hermes {
    async fn new(supports: bool, owner: &str) -> Self {
        let fixture = Fixture::new();
        let source = fixture.root.path().join("插件 source O'Brien 🚀");
        let plugin = fixture
            .root
            .path()
            .join("Hermes O'Brien 🚀/plugins/loongsuite-pilot");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("__init__.py"), "fixture = True\n").unwrap();
        let mut definition: Value =
            serde_json::from_str(include_str!("../../agents.d/hermes-agent.json")).unwrap();
        definition["directoryPlugin"]["sourceDir"] = json!(source);
        definition["directoryPlugin"]["targetDir"] = json!(plugin);
        definition["directoryPlugin"]["activation"] = Value::Null;
        let text = definition.to_string();
        fixture.package_with(&[("agents.d/hermes-agent.json", &text)]);
        let outgoing = fixture.root.path().join("cache/versions/outgoing");
        let target_version = fixture.root.path().join("cache/versions/rollback-target");
        copy_package(&fixture.candidate, &outgoing);
        copy_package(&fixture.candidate, &target_version);
        if !supports {
            fs::remove_file(target_version.join("agents.d/hermes-agent.json")).unwrap();
            manifest(&target_version);
        }
        fs::write(
            fixture.root.path().join("cache/current"),
            "rollback-target\n",
        )
        .unwrap();
        fs::write(fixture.root.path().join("cache/previous"), "outgoing\n").unwrap();
        let definition: AgentDefinition = serde_json::from_value(definition).unwrap();
        fs::create_dir_all(&fixture.data).unwrap();
        if owner != "missing" {
            let data = if owner == "foreign" {
                fixture.root.path().join("other-install")
            } else {
                fixture.data.clone()
            };
            let strategy = loongsuite_pilot::deployment::DirectoryPluginStrategy::new(Some(
                data.to_string_lossy().into_owned(),
            ));
            assert!(strategy.deploy_directory(&definition).await.success);
            if owner == "unknown" {
                fs::write(
                    plugin.join(".loongsuite-pilot-managed.json"),
                    r#"{"owner":"loongsuite-pilot","agentId":"hermes-agent"}"#,
                )
                .unwrap();
            }
        }
        fs::write(fixture.data.join("deployed-agents.json"), json!({
            "hermes-agent":{"deployMode":"directory-plugin","deployedAt":"2026-11-03T00:00:00.000Z","targetDir":plugin},
            "cursor-cli":{"deployMode":"hook","deployedAt":"2026-11-03T00:00:00.000Z"}
        }).to_string()).unwrap();
        Self {
            fixture,
            outgoing,
            target_version,
            plugin,
            definition,
        }
    }
    fn options(&self) -> Value {
        json!({"dataDir":self.fixture.data,"cacheDir":self.fixture.root.path().join("cache"),
            "targetVersionDir":self.target_version,"pilotDir":self.outgoing})
    }
    fn run(&self, options: &Value) -> Output {
        let binary = self.outgoing.join(if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        });
        let mut command = self.fixture.command(&binary);
        command
            .args(["installer-helper", "cleanup-rollback-hermes", "--input-env"])
            .env("LOONGSUITE_PILOT_INSTALL_INPUT", options.to_string());
        bounded_for(command, Duration::from_secs(5))
    }
}
#[tokio::test]
async fn hermes_l711_real_native_rollback_removes_only_current_owned_and_preserves_other_agent_state(
) {
    let h = Hermes::new(false, "current").await;
    let output = h.run(&h.options());
    success(&output);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        h.plugin.to_string_lossy()
    );
    assert!(!h.plugin.exists());
    let state: Value =
        serde_json::from_slice(&fs::read(h.fixture.data.join("deployed-agents.json")).unwrap())
            .unwrap();
    assert!(state.get("hermes-agent").is_none());
    assert_eq!(state["cursor-cli"]["deployMode"], "hook");
    assert_eq!(
        fs::read(h.fixture.root.path().join("cache/current")).unwrap(),
        b"rollback-target\n"
    );
    assert_eq!(
        fs::read(h.fixture.root.path().join("cache/previous")).unwrap(),
        b"outgoing\n"
    );
    let output = h.run(&h.options());
    success(&output);
    assert!(output.stdout.is_empty());
    assert!(
        Path::new(&h.definition.directory_plugin.as_ref().unwrap().source_dir)
            .join("__init__.py")
            .is_file()
    );
}
#[tokio::test]
async fn hermes_l711_supported_target_unknown_and_foreign_ownership_are_true_noops() {
    for (supports, owner) in [
        (true, "current"),
        (false, "foreign"),
        (false, "unknown"),
        (false, "missing"),
    ] {
        let h = Hermes::new(supports, owner).await;
        let state = fs::read(h.fixture.data.join("deployed-agents.json")).unwrap();
        let before = fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).ok();
        let output = h.run(&h.options());
        success(&output);
        assert!(
            output.stdout.is_empty(),
            "{supports}/{owner}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        if let Some(before) = before {
            assert_eq!(
                fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap(),
                before
            );
            assert_eq!(
                fs::read(h.plugin.join("__init__.py")).unwrap(),
                b"fixture = True\n"
            );
        }
        assert_eq!(
            fs::read(h.fixture.data.join("deployed-agents.json")).unwrap(),
            state
        );
    }
}
#[tokio::test]
async fn hermes_modified_current_owned_plugin_and_invalid_binding_preserve_all_state_and_bytes() {
    for scenario in [
        "modified",
        "wrong-current",
        "wrong-source",
        "tampered-package",
        "unlisted-support-definition",
        "bad-state",
    ] {
        let h = Hermes::new(false, "current").await;
        let mut options = h.options();
        let plugin_file = h.plugin.join("__init__.py");
        match scenario {
            "modified" => fs::write(&plugin_file, "user = 'keep'\n").unwrap(),
            "wrong-current" => options["targetVersionDir"] = json!(h.outgoing),
            "wrong-source" => options["pilotDir"] = json!(h.target_version),
            "tampered-package" => {
                fs::write(h.target_version.join("assets/fixture"), "tampered").unwrap()
            }
            "unlisted-support-definition" => {
                fs::copy(
                    h.outgoing.join("agents.d/hermes-agent.json"),
                    h.target_version.join("agents.d/hermes-agent.json"),
                )
                .unwrap();
                use loongsuite_pilot::utils::runtime_paths::{
                    build_edition, build_target, validate_runtime,
                };
                assert!(validate_runtime(
                    &h.target_version,
                    env!("CARGO_PKG_VERSION"),
                    build_target(),
                    build_edition(),
                )
                .is_err());
            }
            _ => fs::write(
                h.fixture.data.join("deployed-agents.json"),
                "invalid private state",
            )
            .unwrap(),
        }
        let state = fs::read(h.fixture.data.join("deployed-agents.json")).unwrap();
        let original = fs::read(&plugin_file).unwrap();
        let marker = fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap();
        let output = h.run(&options);
        assert!(!output.status.success(), "{scenario}");
        assert!(
            output.stdout.is_empty(),
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(fs::read(&plugin_file).unwrap(), original);
        assert_eq!(
            fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap(),
            marker
        );
        assert_eq!(
            fs::read(h.fixture.data.join("deployed-agents.json")).unwrap(),
            state
        );
    }
}
#[cfg(unix)]
#[tokio::test]
async fn actual_shell_bridge_calls_real_native_cleanup_without_node_and_captures_outgoing_before_publish(
) {
    let h = Hermes::new(false, "current").await;
    let source = include_str!("../../scripts/loongsuite-pilot.sh");
    let block = function(source, "cleanup_hermes_for_rollback() {");
    assert!(!block.contains("resolve_node") && !block.contains("node -e"));
    let rollback = function(source, "cmd_rollback() {");
    assert!(
        rollback
            .find("hermes_cleanup_helper=$(resolve_pilot_bin)")
            .unwrap()
            < rollback.find("publish_rollback_version").unwrap()
    );
    assert!(
        rollback.contains("cleanup_hermes_for_rollback \"$prev_path\" \"$hermes_cleanup_helper\"")
    );
    let script = h.fixture.root.path().join("cleanup.sh");
    fs::write(&script,format!("set -euo pipefail\n{block}\ncleanup_hermes_for_rollback \"$TARGET_DIR\" \"$HELPER_BIN\"\n")).unwrap();
    let mut command = h.fixture.command(Path::new("/bin/bash"));
    command
        .arg(script)
        .env("DATA_DIR", &h.fixture.data)
        .env("CACHE_DIR", h.fixture.root.path().join("cache"))
        .env("TARGET_DIR", &h.target_version)
        .env("HELPER_BIN", h.outgoing.join("bin/loongsuite-pilot"))
        .env("PATH", "/usr/bin:/bin");
    let output = bounded_for(command, Duration::from_secs(5));
    success(&output);
    assert!(!h.plugin.exists());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Removed Hermes plugin"));
}

async fn recorded_custom(h: &Hermes, owner: &str) -> PathBuf {
    let custom = h
        .fixture
        .root
        .path()
        .join("recorded O'Brien [隔离] 🚀/plugins/loongsuite-pilot");
    if owner != "missing" {
        let mut def = h.definition.clone();
        def.directory_plugin.as_mut().unwrap().target_dir = custom.to_string_lossy().into_owned();
        let data = if owner == "foreign" {
            h.fixture.root.path().join("other-install")
        } else {
            h.fixture.data.clone()
        };
        let strategy = loongsuite_pilot::deployment::DirectoryPluginStrategy::new(Some(
            data.to_string_lossy().into_owned(),
        ));
        assert!(strategy.deploy_directory(&def).await.success);
    }
    let state = h.fixture.data.join("deployed-agents.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
    value["hermes-agent"]["targetDir"] = json!(custom);
    fs::write(state, value.to_string()).unwrap();
    custom
}
#[tokio::test]
async fn hermes_real_recorded_custom_target_is_removed_while_the_owned_definition_fallback_survives(
) {
    let h = Hermes::new(false, "current").await;
    let custom = recorded_custom(&h, "current").await;
    let fallback_marker = fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap();
    let fallback_sdk = fs::read(h.plugin.join("__init__.py")).unwrap();
    let output = h.run(&h.options());
    success(&output);
    assert!(
        !custom.exists(),
        "real recorded custom Hermes target survived cleanup"
    );
    assert_eq!(
        fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap(),
        fallback_marker,
        "unrelated same-install fallback was removed"
    );
    assert_eq!(
        fs::read(h.plugin.join("__init__.py")).unwrap(),
        fallback_sdk
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        custom.to_string_lossy()
    );
    let state: Value =
        serde_json::from_slice(&fs::read(h.fixture.data.join("deployed-agents.json")).unwrap())
            .unwrap();
    assert!(state.get("hermes-agent").is_none());
    assert_eq!(state["cursor-cli"]["deployMode"], "hook");
}
#[tokio::test]
async fn hermes_recorded_foreign_dirty_missing_and_relative_targets_never_fall_back_to_an_owned_default(
) {
    for scenario in ["foreign", "unknown", "dirty", "missing", "relative"] {
        let h = Hermes::new(false, "current").await;
        let custom = recorded_custom(
            &h,
            if scenario == "dirty" || scenario == "relative" || scenario == "unknown" {
                "current"
            } else {
                scenario
            },
        )
        .await;
        if scenario == "unknown" {
            fs::write(
                custom.join(".loongsuite-pilot-managed.json"),
                r#"{"owner":"loongsuite-pilot","agentId":"hermes-agent"}"#,
            )
            .unwrap();
        }
        if scenario == "dirty" {
            fs::write(custom.join("__init__.py"), "customer = 'keep'\n").unwrap();
        }
        if scenario == "relative" {
            let state = h.fixture.data.join("deployed-agents.json");
            let mut value: Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
            value["hermes-agent"]["targetDir"] = json!("relative/plugins/loongsuite-pilot");
            fs::write(state, value.to_string()).unwrap();
        }
        let state = fs::read(h.fixture.data.join("deployed-agents.json")).unwrap();
        let fallback_marker = fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap();
        let fallback_sdk = fs::read(h.plugin.join("__init__.py")).unwrap();
        let custom_marker = fs::read(custom.join(".loongsuite-pilot-managed.json")).ok();
        let custom_sdk = fs::read(custom.join("__init__.py")).ok();
        let output = h.run(&h.options());
        assert_eq!(
            output.status.success(),
            scenario == "foreign" || scenario == "unknown" || scenario == "missing",
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty(), "{scenario}");
        assert_eq!(
            fs::read(h.fixture.data.join("deployed-agents.json")).unwrap(),
            state,
            "{scenario}"
        );
        assert_eq!(
            fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap(),
            fallback_marker,
            "{scenario}"
        );
        assert_eq!(
            fs::read(h.plugin.join("__init__.py")).unwrap(),
            fallback_sdk,
            "{scenario}"
        );
        assert_eq!(
            fs::read(custom.join(".loongsuite-pilot-managed.json")).ok(),
            custom_marker,
            "{scenario}"
        );
        assert_eq!(
            fs::read(custom.join("__init__.py")).ok(),
            custom_sdk,
            "{scenario}"
        );
    }
}

#[tokio::test]
async fn whole_native_uninstall_uses_the_recorded_directory_target_without_deleting_the_owned_fallback(
) {
    let h = Hermes::new(false, "current").await;
    let custom = recorded_custom(&h, "current").await;
    let state_path = h.fixture.data.join("deployed-agents.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    state.as_object_mut().unwrap().remove("cursor-cli");
    fs::write(state_path, state.to_string()).unwrap();
    let fallback_marker = fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap();
    let fallback_sdk = fs::read(h.plugin.join("__init__.py")).unwrap();
    success(&h.fixture.helper(
        "cleanup-agents",
        &json!({
            "dataDir":h.fixture.data,"pilotDir":h.fixture.candidate
        }),
        true,
    ));
    assert!(!custom.exists());
    assert_eq!(
        fs::read(h.plugin.join(".loongsuite-pilot-managed.json")).unwrap(),
        fallback_marker
    );
    assert_eq!(
        fs::read(h.plugin.join("__init__.py")).unwrap(),
        fallback_sdk
    );
}
