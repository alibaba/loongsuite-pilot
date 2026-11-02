//! Historical Agent watchdog contracts through real temporary deployment strategies.
use super::*;
use crate::deployment::DshRuntimeLocator;
use crate::types::AgentDefinition;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

struct Fixture {
    data: PathBuf,
    pilot: PathBuf,
    manager: Arc<DeploymentManager>,
}
impl Fixture {
    async fn new(root: &Path, definitions: Vec<Value>) -> Self {
        let data = root.join("data");
        let pilot = root.join("pilot");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(pilot.join("agents.d")).unwrap();
        std::fs::create_dir_all(pilot.join("src")).unwrap();
        std::fs::create_dir_all(pilot.join("assets/hooks")).unwrap();
        std::fs::write(pilot.join("Cargo.toml"), "").unwrap();
        std::fs::write(pilot.join("src/main.rs"), "").unwrap();
        for def in definitions {
            std::fs::write(
                pilot
                    .join("agents.d")
                    .join(format!("{}.json", def["id"].as_str().unwrap())),
                serde_json::to_vec(&def).unwrap(),
            )
            .unwrap();
        }
        let empty_proc = root.join("empty-proc");
        std::fs::create_dir_all(&empty_proc).unwrap();
        let home = std::env::var("HOME").unwrap();
        let manager = Arc::new(
            DeploymentManager::new(crate::deployment::DeploymentManagerOptions {
                data_dir: data.to_string_lossy().into_owned(),
                pilot_dir: pilot.to_string_lossy().into_owned(),
                builtin_agents_dir: None,
                installed_by: None,
            })
            .with_test_dsh_locator(DshRuntimeLocator {
                proc_root: empty_proc.to_string_lossy().into_owned(),
                platform: if cfg!(windows) { "win32" } else { "linux" }.into(),
                env: HashMap::from([("HOME".into(), home.clone()), ("USERPROFILE".into(), home)]),
                cwd: root.to_string_lossy().into_owned(),
                uid: None,
            }),
        );
        manager.load_definitions().await;
        Self {
            data,
            pilot,
            manager,
        }
    }

    fn orchestrator(&self, agent: &str, enabled: Option<bool>) -> Orchestrator {
        let env = HashMap::new();
        let mut file = json!({"dataDir":self.data,"autoUpdate":{"enabled":false},
            "dashboard":{"enabled":false},"jsonl":{"enabled":false}});
        if let Some(enabled) = enabled {
            file["agents"] = json!({(agent):{"enabled":enabled}});
        }
        let config = super::super::config_loader::assemble_config(
            Some(&file),
            None,
            &super::super::config_loader::ConfigSources {
                env: &env,
                platform: crate::utils::Platform::current(),
                hostname: "watchdog-fixture",
                config_path: "not-read.json",
                global_poll_ms: None,
            },
        )
        .unwrap();
        let orchestrator = Orchestrator::new(config);
        *orchestrator.deployment.lock().unwrap() = Some(self.manager.clone());
        orchestrator
    }

    fn definition(&self, id: &str) -> AgentDefinition {
        self.manager
            .get_definitions()
            .into_iter()
            .find(|def| def.id == id)
            .unwrap()
    }
}
fn declaration(id: &str, mode: &str, detected: &Path) -> Value {
    json!({"id":id,"displayName":id,"deployMode":mode,
        "detection":{"paths":[detected],"commands":[]}})
}
fn hook_declaration(root: &Path, id: &str, trust: bool) -> Value {
    // Trust and hook settings must share the detected Codex home so persisted
    // deployment paths can reconstruct both associated files safely.
    let detected = if trust {
        root.join(".codex")
    } else {
        root.join(format!("detected-{id}"))
    };
    std::fs::create_dir_all(&detected).unwrap();
    let mut def = declaration(id, "hook", &detected);
    def["hook"] = json!({"settingsPath":root.join(id).join("hooks.json"),
        "events":["Stop"],"hookCommand":root.join(format!("{id}-hook.sh")),
        "format":"nested"});
    std::fs::write(
        root.join(format!("{id}-hook.sh")),
        "fixture hook, never executed\n",
    )
    .unwrap();
    if trust {
        def["hook"]["settingsPath"] = json!(detected.join("hooks.json"));
        def["hook"]["trustToml"] = json!({"configPath":detected.join("config.toml"),
            "trustAlgo":"v1","marker":"otel-codex-hook"});
    }
    def
}
async fn isolated_case(name: &str) {
    const CHILD: &str = "PILOT_WATCHDOG_NATIVE_CONTRACT_CHILD";
    if let Ok(child) = std::env::var(CHILD) {
        assert_eq!(child, name);
        let root = PathBuf::from(std::env::var("HOME").unwrap());
        assert!(root.starts_with(std::env::temp_dir()));
        match name {
            "codex_trust_watchdog_uses_real_change_and_repair_callbacks" => {
                codex_contract(&root).await
            }
            "directory_targets_require_complete_config_and_repair_real_plugin_state" => {
                directory_contract(&root).await
            }
            "dsh_targets_recheck_detection_propagate_failures_and_preserve_foreign_yaml" => {
                dsh_contract(&root).await
            }
            "grok_target_checks_every_asset_repairs_settings_and_scopes_cleanup" => {
                grok_contract(&root).await
            }
            #[cfg(unix)]
            "copilot_plugin_watchdog_repairs_real_registration_and_cleans_disabled_owned_state" => {
                copilot_contract(&root).await
            }
            _ => panic!("unexpected fixture case"),
        }
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let filter = format!("core::orchestrator::watchdog_contract_tests::{name}");
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", &filter, "--nocapture"])
        .env_clear()
        .env(CHILD, name)
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("LOCALAPPDATA", root.path().join("local"))
        .env("APPDATA", root.path().join("roaming"))
        .env("PATH", root.path().join("no-agent-runtimes"))
        .env("HERMES_CLI", "fixture-hermes-not-executed")
        .env("TMPDIR", std::env::temp_dir())
        .env("TMP", std::env::temp_dir())
        .env("TEMP", std::env::temp_dir())
        .env("LOONGSUITE_PILOT_CACHE_DIR", root.path().join("cache"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!("watchdog contract {name} timed out: {output:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{name}: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn codex_trust_watchdog_uses_real_change_and_repair_callbacks() {
    isolated_case("codex_trust_watchdog_uses_real_change_and_repair_callbacks").await;
}
async fn codex_contract(root: &Path) {
    let fixture = Fixture::new(
        root,
        vec![
            hook_declaration(root, "codex", true),
            hook_declaration(root, "claude-code", false),
        ],
    )
    .await;
    let orchestrator = fixture.orchestrator("codex", None);
    let targets = orchestrator.hook_watchdog_targets(&fixture.manager);
    assert_eq!(targets.len(), 2);
    let codex = targets
        .iter()
        .find(|target| target.agent_id == "codex")
        .unwrap();
    let claude = targets
        .iter()
        .find(|target| target.agent_id == "claude-code")
        .unwrap();
    assert_eq!(
        Path::new(codex.change_watch_path.as_deref().unwrap()),
        root.join(".codex/config.toml")
    );
    assert!(codex.needs_repair_on_change.is_some());
    assert!(claude.change_watch_path.is_none());
    assert!(claude.needs_repair_on_change.is_none());
    assert!(codex.needs_repair_on_change.as_ref().unwrap()().await);
    assert!(codex.repair_fn.as_ref().unwrap()().await);
    let settings: Value =
        serde_json::from_slice(&std::fs::read(root.join(".codex/hooks.json")).unwrap()).unwrap();
    assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
    assert!(std::fs::read_to_string(root.join(".codex/config.toml"))
        .unwrap()
        .contains("otel-codex-hook"));
    assert!(fixture.manager.has_record("codex"));
    assert!(!fixture.manager.has_record("claude-code"));
    assert!(!root.join("claude-code/hooks.json").exists());
    let recorded = fixture
        .manager
        .recorded_definition(&fixture.definition("codex"))
        .unwrap();
    let hook = recorded.hook.unwrap();
    assert_eq!(
        Path::new(&hook.settings_path),
        root.join(".codex/hooks.json")
    );
    assert_eq!(
        Path::new(&hook.trust_toml.unwrap().config_path),
        root.join(".codex/config.toml")
    );
    assert!(!codex.needs_repair_on_change.as_ref().unwrap()().await);
}

#[tokio::test]
async fn directory_targets_require_complete_config_and_repair_real_plugin_state() {
    isolated_case("directory_targets_require_complete_config_and_repair_real_plugin_state").await;
}
async fn directory_contract(root: &Path) {
    let source = root.join("source");
    let detected = root.join("detected-hermes");
    let target = root.join("hermes/plugins/pilot");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("plugin.py"), "fixture plugin bytes\n").unwrap();
    std::fs::create_dir(&detected).unwrap();
    let mut complete = declaration("hermes-agent", "directory-plugin", &detected);
    complete["directoryPlugin"] = json!({"sourceDir":source,"targetDir":target});
    let fixture = Fixture::new(
        root,
        vec![
            complete,
            declaration("missing-config", "directory-plugin", &detected),
            declaration("hook-agent", "hook", &detected),
        ],
    )
    .await;
    assert!(fixture
        .manager
        .get_definitions()
        .iter()
        .any(|def| def.id == "missing-config"));
    let orchestrator = fixture.orchestrator("hermes-agent", None);
    let targets = orchestrator.directory_plugin_intercepts(&fixture.manager);
    assert_eq!(
        targets.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["directory-plugin:hermes-agent"]
    );
    let watchdog = &targets[0];
    assert!((watchdog.enabled)());
    let disabled = fixture.orchestrator("hermes-agent", Some(false));
    let disabled_targets = disabled.directory_plugin_intercepts(&fixture.manager);
    assert!(!(disabled_targets[0].enabled)());
    assert!((watchdog.precondition)().await);
    assert!(!(watchdog.check)().await);
    (watchdog.repair)().await.unwrap();
    assert_eq!(
        std::fs::read(target.join("plugin.py")).unwrap(),
        b"fixture plugin bytes\n"
    );
    assert!(fixture.manager.has_record("hermes-agent"));
    assert!((watchdog.check)().await);
    std::fs::remove_dir(&detected).unwrap();
    assert!(!(watchdog.precondition)().await);
    std::fs::create_dir(&detected).unwrap();
    std::fs::rename(&source, root.join("source-away")).unwrap();
    assert!(!(watchdog.precondition)().await);
    assert!(target.join("plugin.py").exists());
}

#[tokio::test]
async fn dsh_targets_recheck_detection_propagate_failures_and_preserve_foreign_yaml() {
    isolated_case("dsh_targets_recheck_detection_propagate_failures_and_preserve_foreign_yaml")
        .await;
}
fn dsh_declaration(root: &Path, id: &str, configured: bool) -> Value {
    let mut def = declaration(id, "dsh-yaml-patch", &root.join(format!("detected-{id}")));
    def["dshYamlPatch"] = json!({"pluginSource":root.join("plugin.mjs"),
        "entryId":"loongsuite-pilot-observability","marker":"PILOT"});
    if configured {
        def["dshYamlPatch"]["patchPath"] = json!(root.join("runtime/cordis.patch.yml"));
    }
    def
}
async fn dsh_contract(root: &Path) {
    std::fs::write(
        root.join("plugin.mjs"),
        "native plugin fixture, never executed\n",
    )
    .unwrap();
    let fixture = Fixture::new(
        root,
        vec![
            dsh_declaration(root, "dsh", true),
            declaration("missing-dsh-config", "dsh-yaml-patch", &root.join("absent")),
            declaration("other", "detection-only", &root.join("absent")),
        ],
    )
    .await;
    // Unlike the old mock, the native loader rejects incomplete DSH declarations earlier.
    assert!(!fixture
        .manager
        .get_definitions()
        .iter()
        .any(|def| def.id == "missing-dsh-config"));
    let orchestrator = fixture.orchestrator("dsh", Some(true));
    let targets = orchestrator.dsh_intercepts(&fixture.manager);
    assert_eq!(
        targets.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["dsh-yaml-patch:dsh"]
    );
    let target = &targets[0];
    assert!((target.enabled)());
    assert!((target.precondition)().await);
    assert!(!(target.check)().await);
    (target.repair)().await.unwrap();
    assert!(fixture.manager.has_record("dsh"));
    assert!((target.check)().await);
    let patch = root.join("runtime/cordis.patch.yml");
    assert!(std::fs::read_to_string(&patch)
        .unwrap()
        .contains("# entryId=loongsuite-pilot-observability"));
    assert!(root.join(".collection-enabled").is_file());
    target.cleanup.as_ref().unwrap()().await.unwrap();
    assert!(!patch.exists());
    assert!(!root.join(".collection-enabled").exists());
    assert!(!fixture.manager.has_record("dsh"));
    let disabled = fixture.orchestrator("dsh", Some(false));
    assert!(!(disabled.dsh_intercepts(&fixture.manager)[0].enabled)());

    // Real conflicting user YAML produces failure in both actual manager operations.
    let conflict="# BEGIN PILOT\n# entryId=someone-else\n# pluginSource=file:///not-pilot\n# pluginHash=not-pilot\n- keep: user-data\n# END PILOT\n";
    std::fs::write(&patch, conflict).unwrap();
    let expected = fixture
        .manager
        .deploy_single(&fixture.definition("dsh"))
        .await;
    assert!(!expected.success);
    let error = (target.repair)().await.unwrap_err();
    assert_eq!(error, expected.error.unwrap());
    assert!(error.contains("conflict"));
    assert_eq!(
        target.cleanup.as_ref().unwrap()().await.unwrap_err(),
        "failed to remove DSH YAML patch"
    );
    assert_eq!(std::fs::read_to_string(&patch).unwrap(), conflict);

    let late = root.join("late");
    std::fs::create_dir(&late).unwrap();
    std::fs::write(late.join("plugin.mjs"), "late plugin").unwrap();
    let late_fixture = Fixture::new(&late, vec![dsh_declaration(&late, "dsh", false)]).await;
    let late_orchestrator = late_fixture.orchestrator("dsh", None);
    let late_targets = late_orchestrator.dsh_intercepts(&late_fixture.manager);
    let late_target = &late_targets[0];
    assert!(!(late_target.precondition)().await);
    assert_eq!(
        (late_target.repair)().await.unwrap_err(),
        "DSH disappeared before YAML patch repair"
    );
    std::fs::create_dir(late.join("detected-dsh")).unwrap();
    assert!(
        (late_target.precondition)().await,
        "the same target must re-run real strategy-aware detection"
    );
}

#[tokio::test]
async fn grok_target_checks_every_asset_repairs_settings_and_scopes_cleanup() {
    isolated_case("grok_target_checks_every_asset_repairs_settings_and_scopes_cleanup").await;
}
async fn grok_contract(root: &Path) {
    let detected = root.join("detected-grok");
    std::fs::create_dir(&detected).unwrap();
    let settings = root.join("grok/hooks/pilot.json");
    let mut grok = declaration("grok-build", "hook", &detected);
    grok["hook"] = json!({"settingsPath":settings,"events":["stop","stop_failure","user_prompt_submit","session_end"],
        "hookCommand":"$PILOT_DATA/hooks/grok-build-loongsuite-pilot-hook.sh","format":"nested",
        "matcher":"","eventSubcommand":"as-is"});
    let fixture = Fixture::new(
        root,
        vec![grok, hook_declaration(root, "unrelated-agent", false)],
    )
    .await;
    for asset in crate::deployment::GROK_BUILD_HOOK_ASSETS {
        let path = fixture.pilot.join("assets/hooks").join(asset);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("native asset fixture:{asset}\n")).unwrap();
    }
    let unrelated = fixture.definition("unrelated-agent");
    assert!(fixture.manager.deploy_single(&unrelated).await.success);
    let other_path = root.join("unrelated-agent/hooks.json");
    let other_bytes = std::fs::read(&other_path).unwrap();
    let orchestrator = fixture.orchestrator("grok-build", None);
    let targets = orchestrator.grok_intercepts(&fixture.manager);
    assert_eq!(targets.len(), 1);
    let target = &targets[0];
    assert_eq!(target.id, "hook:grok-build");
    assert!((target.enabled)());
    assert!((target.precondition)().await);
    assert!(!settings.parent().unwrap().exists());
    assert!(!(target.check)().await);
    (target.repair)().await.unwrap();
    let saved = std::fs::read(&settings).unwrap();
    let document: Value = serde_json::from_slice(&saved).unwrap();
    for event in ["stop", "stop_failure", "user_prompt_submit", "session_end"] {
        assert_eq!(
            document["hooks"][event].as_array().unwrap().len(),
            1,
            "event {event}"
        );
    }
    assert!((target.check)().await);
    assert!(fixture.manager.has_record("grok-build"));
    for asset in crate::deployment::GROK_BUILD_HOOK_ASSETS {
        let target_asset = fixture.data.join("hooks").join(asset);
        assert_eq!(
            std::fs::read(&target_asset).unwrap(),
            std::fs::read(fixture.pilot.join("assets/hooks").join(asset)).unwrap()
        );
        std::fs::remove_file(&target_asset).unwrap();
        assert!(
            !(target.check)().await,
            "missing runtime asset must make the target unhealthy: {asset}"
        );
        (target.repair)().await.unwrap();
        assert!((target.check)().await);
    }
    std::fs::write(&settings, r#"{"hooks":[]}"#).unwrap();
    assert_eq!(
        (target.repair)().await.unwrap_err(),
        "invalid JSON settings: hooks 必须为对象"
    );
    assert_eq!(
        std::fs::read_to_string(&settings).unwrap(),
        r#"{"hooks":[]}"#
    );
    std::fs::write(&settings, &saved).unwrap();
    target.cleanup.as_ref().unwrap()().await.unwrap();
    assert!(!fixture.manager.has_record("grok-build"));
    assert!(fixture.manager.has_record("unrelated-agent"));
    assert_eq!(std::fs::read(&other_path).unwrap(), other_bytes);
    let document: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    for event in ["stop", "stop_failure", "user_prompt_submit", "session_end"] {
        assert!(document
            .get("hooks")
            .and_then(|hooks| hooks.get(event))
            .is_none_or(|rows| rows.as_array().is_some_and(Vec::is_empty)));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn copilot_plugin_watchdog_repairs_real_registration_and_cleans_disabled_owned_state() {
    isolated_case(
        "copilot_plugin_watchdog_repairs_real_registration_and_cleans_disabled_owned_state",
    )
    .await;
}
#[cfg(unix)]
async fn copilot_contract(root: &Path) {
    let detected = root.join(".copilot");
    let plugin = detected.join("installed-plugins/loongsuite-pilot/loongsuite-pilot");
    let settings = detected.join("settings.json");
    let config = detected.join("config.json");
    std::fs::create_dir_all(&detected).unwrap();
    let settings_before = "{\n // user settings\n \"theme\":\"dark\", \"enabledPlugins\":{\"foreign@market\":true}\n}\n";
    let config_before = "{\"custom\":42,\"installedPlugins\":[{\"name\":\"foreign\",\"marketplace\":\"market\"}]}\n";
    std::fs::write(&settings, settings_before).unwrap();
    std::fs::write(&config, config_before).unwrap();
    std::fs::write(root.join(".bashrc"), "export USER_CUSTOM=value\n").unwrap();
    let mut def = declaration("copilot", "copilot-plugin", &detected);
    def["hook"] = json!({"settingsPath":settings,"events":["sessionStart","preToolUse","agentStop"],
        "hookCommand":"$PILOT_DATA/hooks/copilot-loongsuite-pilot-hook.sh","format":"nested","eventSubcommand":"kebab-case"});
    def["copilotPlugin"] = json!({"pluginRoot":plugin,"pluginId":"loongsuite-pilot","settingsPath":settings,
        "configPath":config,"events":["sessionStart","preToolUse","agentStop"],
        "hookCommand":"$PILOT_DATA/hooks/copilot-loongsuite-pilot-hook.sh",
        "format":"nested","eventSubcommand":"kebab-case","timeoutSec":5});
    let incomplete = declaration("copilot-incomplete", "copilot-plugin", &detected);
    let fixture = Fixture::new(root, vec![def, incomplete]).await;
    std::fs::create_dir_all(fixture.pilot.join("assets/hooks/shared")).unwrap();
    std::fs::write(
        fixture
            .pilot
            .join("assets/hooks/copilot-loongsuite-pilot-hook.sh"),
        include_bytes!("../../assets/hooks/copilot-loongsuite-pilot-hook.sh"),
    )
    .unwrap();
    std::fs::write(
        fixture.pilot.join("assets/hooks/shared/native.sh"),
        include_bytes!("../../assets/hooks/shared/native.sh"),
    )
    .unwrap();
    let orchestrator = fixture.orchestrator("copilot", Some(true));
    assert!(!fixture.manager.has_record("copilot"));
    let first = orchestrator
        .build_watchdog(&fixture.manager)
        .run_check()
        .await;
    assert!(
        plugin.join("plugin.json").is_file(),
        "actual Orchestrator-built watchdog must install missing Copilot plugin; summary={first:?}"
    );
    assert!(fixture.manager.has_record("copilot"));
    assert_eq!(first.repaired, 1);
    let hooks = plugin.join("hooks/hooks.json");
    let original_hooks = std::fs::read(&hooks).unwrap();
    let targets = orchestrator.mode_intercepts(
        &fixture.manager,
        DeployMode::CopilotPlugin,
        "copilot-plugin",
        true,
    );
    assert_eq!(
        targets.len(),
        1,
        "incomplete Copilot declarations must not become repair targets"
    );
    let target = &targets[0];
    assert_eq!(target.id, "copilot-plugin:copilot");
    assert!((target.enabled)());
    assert!((target.precondition)().await);
    assert!((target.check)().await);

    std::fs::write(&hooks, "{}\n").unwrap();
    assert!(!(target.check)().await);
    let repaired = orchestrator
        .build_watchdog(&fixture.manager)
        .run_check()
        .await;
    assert_eq!(repaired.repaired, 1);
    assert_eq!(std::fs::read(&hooks).unwrap(), original_hooks);
    assert!((target.check)().await);
    // A skipped deployment cannot be reported as a successful repair.
    assert!((target.repair)().await.is_err());

    orchestrator
        .bits
        .lock()
        .unwrap()
        .modes
        .insert("copilot".into(), crate::types::AgentControlMode::Off);
    assert!(!(target.enabled)());
    orchestrator
        .build_watchdog(&fixture.manager)
        .run_check()
        .await;
    assert!(!fixture.manager.has_record("copilot"));
    assert!(!plugin.exists());
    let read = |p: &Path| {
        crate::utils::parse_json_document(&std::fs::read_to_string(p).unwrap(), JsonSyntax::Jsonc)
            .unwrap()
    };
    assert_eq!(read(&settings)["theme"], "dark");
    assert_eq!(read(&settings)["enabledPlugins"]["foreign@market"], true);
    assert!(read(&settings)["enabledPlugins"]
        .get("loongsuite-pilot@loongsuite-pilot")
        .is_none());
    assert_eq!(read(&config)["custom"], 42);
    assert_eq!(
        read(&config)["installedPlugins"],
        json!([{"name":"foreign","marketplace":"market"}])
    );
    assert_eq!(
        std::fs::read_to_string(root.join(".bashrc")).unwrap(),
        "export USER_CUSTOM=value\n"
    );

    // No record means no ownership: even an unmanaged directory at the same
    // target must be left alone, and cleanup itself must succeed as a no-op.
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("foreign.txt"), "not owned by pilot\n").unwrap();
    let saved_settings = std::fs::read(&settings).unwrap();
    target.cleanup.as_ref().unwrap()().await.unwrap();
    assert_eq!(std::fs::read(&settings).unwrap(), saved_settings);
    assert_eq!(
        std::fs::read_to_string(plugin.join("foreign.txt")).unwrap(),
        "not owned by pilot\n"
    );
    std::fs::remove_dir_all(&plugin).unwrap();

    let away = root.join(".copilot-away");
    std::fs::rename(&detected, &away).unwrap();
    assert!(!(target.precondition)().await);
    assert!((target.repair)().await.is_err());
    assert!(!detected.exists());
    std::fs::rename(&away, &detected).unwrap();
    orchestrator
        .bits
        .lock()
        .unwrap()
        .modes
        .insert("copilot".into(), crate::types::AgentControlMode::On);
    orchestrator
        .build_watchdog(&fixture.manager)
        .run_check()
        .await;
    assert!(fixture.manager.has_record("copilot"));
    let valid_settings = std::fs::read(&settings).unwrap();
    std::fs::write(&settings, "{\"enabledPlugins\":[]}").unwrap();
    assert!(target.cleanup.as_ref().unwrap()().await.is_err());
    assert!(
        fixture.manager.has_record("copilot"),
        "failed cleanup must preserve ownership for retry"
    );
    assert_eq!(
        std::fs::read_to_string(&settings).unwrap(),
        "{\"enabledPlugins\":[]}"
    );
    std::fs::write(&settings, valid_settings).unwrap();
    target.cleanup.as_ref().unwrap()().await.unwrap();
    assert!(!fixture.manager.has_record("copilot"));
    assert!(!plugin.exists());
}

#[cfg(windows)]
#[tokio::test]
async fn copilot_plugin_watchdog_is_absent_on_windows() {
    let root = tempfile::tempdir().unwrap();
    let detected = root.path().join(".copilot");
    std::fs::create_dir_all(&detected).unwrap();
    let mut def = declaration("copilot", "copilot-plugin", &detected);
    def["copilotPlugin"] = json!({"pluginRoot":detected.join("plugins/pilot"),
        "pluginId":"loongsuite-pilot","settingsPath":detected.join("settings.json"),
        "configPath":detected.join("config.json"),"events":["sessionStart"],
        "hookCommand":root.path().join("never-run.sh"),"format":"nested"});
    let fixture = Fixture::new(root.path(), vec![def]).await;
    let orchestrator = fixture.orchestrator("copilot", Some(true));
    assert!(orchestrator.copilot_intercepts(&fixture.manager).is_empty());
    assert!(!fixture.manager.has_record("copilot"));
    assert!(!detected.join("plugins").exists());
}
