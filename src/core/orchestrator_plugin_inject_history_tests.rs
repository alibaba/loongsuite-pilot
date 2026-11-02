//! Original plugin watchdog assertions through real Orchestrator target closures.
use super::*;

fn plugin(root: &Path, id: &str, spec: &str) -> Value {
    let mut def = declaration(id, "plugin-inject", &root.join("detected"));
    def["pluginInject"] = json!({
        "configPaths":[root.join(id).join("settings.json")],
        "pluginSpec":spec,"pluginId":format!("loongsuite-pilot-{id}")
    });
    def
}
fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}
async fn fixture(root: &Path, definition: Value) -> Fixture {
    std::fs::create_dir_all(root.join("detected")).unwrap();
    Fixture::new(root, vec![definition]).await
}
fn one(orchestrator: &Orchestrator, fixture: &Fixture) -> InterceptCheckTarget {
    let mut targets = orchestrator.plugin_inject_intercepts(&fixture.manager);
    assert_eq!(targets.len(), 1);
    targets.remove(0)
}

#[tokio::test]
async fn source_l113_only_plugin_inject_definitions_become_exact_named_targets() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = Fixture::new(
        r,
        vec![
            declaration("claude-code", "hook", &r.join("detected")),
            plugin(r, "opencode", "loongsuite-pilot-opencode"),
            plugin(r, "qwen-code-cli", "loongsuite-pilot-qwen-code-cli"),
        ],
    )
    .await;
    let orch = fixture.orchestrator("opencode", None);
    let targets = orch.plugin_inject_intercepts(&fixture.manager);
    assert_eq!(
        targets.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["plugin-inject:opencode", "plugin-inject:qwen-code-cli"]
    );
}
#[tokio::test]
async fn source_l124_missing_plugin_inject_configuration_never_builds_a_target() {
    let root = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(
        root.path(),
        vec![declaration(
            "broken",
            "plugin-inject",
            &root.path().join("detected"),
        )],
    )
    .await;
    // Loader currently retains this historical incomplete declaration.
    assert_eq!(fixture.manager.get_definitions().len(), 1);
    let orch = fixture.orchestrator("broken", None);
    assert!(orch.plugin_inject_intercepts(&fixture.manager).is_empty());
}
#[tokio::test]
async fn source_l133_missing_local_asset_short_circuits_real_manager_detection() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(
        r,
        plugin(
            r,
            "opencode",
            "file://$PILOT_DATA/plugins/opencode/plugin.mjs",
        ),
    )
    .await;
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    assert_eq!(fixture.manager.test_detection_calls(), 0);
    assert!(!(target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 0);
}
#[tokio::test]
async fn source_l144_existing_asset_cannot_replace_actual_agent_detection() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(
        r,
        plugin(
            r,
            "opencode",
            "file://$PILOT_DATA/plugins/opencode/plugin.mjs",
        ),
    )
    .await;
    write(
        &fixture.data.join("plugins/opencode/plugin.mjs"),
        "plugin bytes",
    );
    std::fs::remove_dir(r.join("detected")).unwrap();
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    assert!(!(target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 1);
}
#[tokio::test]
async fn source_l153_both_resolved_pilot_data_asset_and_detected_agent_are_required() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(
        r,
        plugin(
            r,
            "opencode",
            "file://$PILOT_DATA/plugins/opencode/plugin.mjs",
        ),
    )
    .await;
    let asset = fixture.data.join("plugins/opencode/plugin.mjs");
    write(&asset, "plugin bytes");
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    assert!((target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 1);
    std::fs::rename(&asset, r.join("asset-away")).unwrap();
    assert!(!(target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 1);
}
#[tokio::test]
async fn source_l187_npm_spec_needs_no_local_asset_but_still_detects_agent() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "opencode", "loongsuite-pilot-opencode")).await;
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    assert!(!fixture.data.join("plugins").exists());
    assert!((target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 1);
    assert!(!fixture.data.join("plugins").exists());
}
#[tokio::test]
async fn source_l204_pi_absolute_extension_path_is_checked_before_agent_detection() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let extension = r.join("pi-extension/index.mjs");
    let fixture = fixture(
        r,
        plugin(r, "pi-coding-agent", &extension.to_string_lossy()),
    )
    .await;
    let orch = fixture.orchestrator("pi-coding-agent", None);
    let target = one(&orch, &fixture);
    assert!(!(target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 0);
    write(&extension, "pi extension bytes");
    assert!((target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 1);
}
#[tokio::test]
async fn source_l226_existing_exact_spec_is_healthy_via_actual_needs_redeploy() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "opencode", "loongsuite-pilot-opencode")).await;
    write(
        &r.join("opencode/settings.json"),
        r#"{"plugin":["loongsuite-pilot-opencode"]}"#,
    );
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    assert!(
        !fixture
            .manager
            .needs_redeploy(&fixture.definition("opencode"), None)
            .await
    );
    assert!((target.check)().await);
}
#[tokio::test]
async fn source_l235_missing_spec_is_unhealthy_via_actual_needs_redeploy() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "opencode", "loongsuite-pilot-opencode")).await;
    write(
        &r.join("opencode/settings.json"),
        r#"{"plugin":["foreign"]}"#,
    );
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    assert!(
        fixture
            .manager
            .needs_redeploy(&fixture.definition("opencode"), None)
            .await
    );
    assert!(!(target.check)().await);
}
#[tokio::test]
async fn source_l269_repair_really_deploys_injection_and_records_exact_agent() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "opencode", "loongsuite-pilot-opencode")).await;
    let settings = r.join("opencode/settings.json");
    write(&settings, r#"{"theme":"dark","plugin":["foreign"]}"#);
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    (target.repair)().await.unwrap();
    assert!(fixture.manager.has_record("opencode"));
    assert!(!fixture.manager.has_record("other"));
    let json: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    assert_eq!(
        json["plugin"],
        json!(["foreign", "loongsuite-pilot-opencode"])
    );
    assert_eq!(json["theme"], "dark");
    assert!((target.check)().await);
}
#[tokio::test]
async fn source_l278_actual_deployment_failure_propagates_to_target_and_watchdog() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "opencode", "loongsuite-pilot-opencode")).await;
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    let expected = fixture
        .manager
        .deploy_single(&fixture.definition("opencode"))
        .await;
    assert!(!expected.success);
    let error = (target.repair)().await.unwrap_err();
    assert_eq!(error, expected.error.unwrap());
    assert!(error.contains("no config file"));
    let summary = HookWatchdog::new(
        crate::types::HookWatchdogConfig {
            enabled: true,
            interval_ms: 1000,
            repair_cooldown_ms: 0,
        },
        vec![],
        vec![target],
    )
    .run_check()
    .await;
    assert_eq!(summary.repaired, 0);
    assert!(!fixture.manager.has_record("opencode"));
}
#[tokio::test]
async fn source_l288_cleanup_really_undeploys_only_its_injected_spec() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "opencode", "loongsuite-pilot-opencode")).await;
    let settings = r.join("opencode/settings.json");
    write(&settings, r#"{"theme":"dark","plugin":["foreign"]}"#);
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    (target.repair)().await.unwrap();
    let undeploy_calls = fixture.manager.test_undeploy_calls();
    target.cleanup.as_ref().unwrap()().await.unwrap();
    assert_eq!(fixture.manager.test_undeploy_calls(), undeploy_calls + 1);
    let json: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    assert_eq!(json["plugin"], json!(["foreign"]));
    assert_eq!(json["theme"], "dark");
    assert!(!fixture.manager.has_record("opencode"));
}
#[tokio::test]
async fn source_l298_cleanup_failure_is_reported_and_ownership_remains_for_retry() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "opencode", "loongsuite-pilot-opencode")).await;
    let settings = r.join("opencode/settings.json");
    write(&settings, r#"{"plugin":["foreign"]}"#);
    let orch = fixture.orchestrator("opencode", None);
    let target = one(&orch, &fixture);
    (target.repair)().await.unwrap();
    write(&settings, r#"{"plugin":42}"#);
    assert!(
        !fixture
            .manager
            .undeploy_agent(&fixture.definition("opencode"))
            .await
    );
    let error = target.cleanup.as_ref().unwrap()().await.unwrap_err();
    assert!(error.contains("failed to remove injected plugin"));
    assert!(fixture.manager.has_record("opencode"));
    assert_eq!(
        std::fs::read_to_string(&settings).unwrap(),
        r#"{"plugin":42}"#
    );
}

// Each metadata/whole-input test runs in an isolated process with synthetic HOME.
// The explicit host entry is a temp file paired with temp package metadata.
async fn isolated_plugin_case(name: &str) -> Option<PathBuf> {
    const CHILD: &str = "PILOT_PLUGIN_WATCHDOG_HISTORY_CHILD";
    if let Ok(child) = std::env::var(CHILD) {
        assert_eq!(child, name);
        let root = PathBuf::from(std::env::var("HOME").unwrap());
        assert!(root.starts_with(std::env::temp_dir()));
        return Some(root);
    }
    let root = tempfile::tempdir().unwrap();
    let filter = format!(
        "core::orchestrator::watchdog_contract_tests::plugin_inject_history_contract_tests::{name}"
    );
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
        .env(
            "OPENCLAW_CLI_PATH",
            root.path().join("openclaw/openclaw.mjs"),
        )
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
            panic!("isolated plugin case {name} timed out: {output:?}");
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
    None
}
fn openclaw(root: &Path, managed: bool) -> Value {
    let spec = if managed {
        "file://$PILOT_DATA/plugins/openclaw".into()
    } else {
        format!("file://{}", root.join("external-plugin").to_string_lossy())
    };
    let mut def = plugin(root, "openclaw", &spec);
    def["pluginInject"]["configShape"] = json!("openclaw-nested");
    def
}
const OPENCLAW_METADATA: &str = r#"{"name":"openclaw","version":"2026.4.7"}"#;
fn bind_openclaw(root: &Path) {
    write(
        &root.join("openclaw/openclaw.mjs"),
        "temporary locator, never executed\n",
    );
    write(&root.join("openclaw/package.json"), OPENCLAW_METADATA);
}
#[tokio::test]
async fn source_l164_existing_openclaw_directory_passes_asset_and_real_host_detection() {
    let Some(r) = isolated_plugin_case(
        "source_l164_existing_openclaw_directory_passes_asset_and_real_host_detection",
    )
    .await
    else {
        return;
    };
    bind_openclaw(&r);
    let fixture = fixture(&r, openclaw(&r, true)).await;
    let asset = fixture.data.join("plugins/openclaw");
    std::fs::create_dir_all(&asset).unwrap();
    assert!(asset.is_dir() && !asset.is_file());
    let orch = fixture.orchestrator("openclaw", None);
    let target = one(&orch, &fixture);
    assert!((target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 1);
    std::fs::remove_dir(&asset).unwrap();
    assert!(!(target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 1);
}
#[tokio::test]
async fn source_l259_generic_presence_waits_for_actual_openclaw_metadata_and_rechecks() {
    let Some(r) = isolated_plugin_case(
        "source_l259_generic_presence_waits_for_actual_openclaw_metadata_and_rechecks",
    )
    .await
    else {
        return;
    };
    let fixture = fixture(&r, openclaw(&r, true)).await;
    std::fs::create_dir_all(fixture.data.join("plugins/openclaw")).unwrap();
    let def = fixture.definition("openclaw");
    assert!(
        detect_agent(&def.detection).await,
        "generic presence is already true"
    );
    let orch = fixture.orchestrator("openclaw", None);
    let target = one(&orch, &fixture);
    assert!(!(target.precondition)().await);
    bind_openclaw(&r);
    assert!((target.precondition)().await);
    assert_eq!(fixture.manager.test_detection_calls(), 2);
}
#[tokio::test]
async fn source_l245_four_actual_disappearance_races_do_not_spend_daily_repair_budget() {
    let Some(r) = isolated_plugin_case(
        "source_l245_four_actual_disappearance_races_do_not_spend_daily_repair_budget",
    )
    .await
    else {
        return;
    };
    bind_openclaw(&r);
    std::fs::create_dir_all(r.join("external-plugin")).unwrap();
    let fixture = fixture(&r, openclaw(&r, false)).await;
    write(&r.join("openclaw/settings.json"), "{}\n");
    let orch = fixture.orchestrator("openclaw", None);
    let mut target = one(&orch, &fixture);
    let precondition = Arc::clone(&target.precondition);
    let cycles = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let metadata = r.join("openclaw/package.json");
    target.precondition = Arc::new({
        let cycles = Arc::clone(&cycles);
        move || {
            let cycles = Arc::clone(&cycles);
            let metadata = metadata.clone();
            let precondition = Arc::clone(&precondition);
            Box::pin(async move {
                std::fs::write(&metadata, OPENCLAW_METADATA).unwrap();
                let result = precondition().await;
                assert!(result);
                if cycles.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 4 {
                    std::fs::remove_file(&metadata).unwrap();
                }
                result
            })
        }
    });
    let repair = Arc::clone(&target.repair);
    let repairs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    target.repair = Arc::new({
        let repairs = Arc::clone(&repairs);
        move || {
            let repair = Arc::clone(&repair);
            let repairs = Arc::clone(&repairs);
            Box::pin(async move {
                repairs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                repair().await
            })
        }
    });
    let watchdog = HookWatchdog::new(
        crate::types::HookWatchdogConfig {
            enabled: true,
            interval_ms: 1000,
            repair_cooldown_ms: 0,
        },
        vec![],
        vec![target],
    );
    for _ in 0..4 {
        assert_eq!(watchdog.run_check().await.repaired, 0);
        assert!(!fixture.manager.has_record("openclaw"));
    }
    assert_eq!(watchdog.run_check().await.repaired, 1);
    assert_eq!(repairs.load(std::sync::atomic::Ordering::SeqCst), 5);
    assert!(fixture.manager.has_record("openclaw"));
    let settings: Value =
        serde_json::from_slice(&std::fs::read(r.join("openclaw/settings.json")).unwrap()).unwrap();
    assert!(settings.get("plugins").is_some());
}
async fn register_sdk(
    fixture: &Fixture,
    root: &Path,
) -> crate::pi_sdk::PiSdkAgentRegistrationResult {
    for (relative, bytes) in [
        (
            "plugins/pi-coding-agent/index.mjs",
            include_bytes!("../../assets/plugins/pi-coding-agent/index.mjs").as_slice(),
        ),
        (
            "plugins/shared/resource-context.mjs",
            include_bytes!("../../assets/plugins/shared/resource-context.mjs").as_slice(),
        ),
    ] {
        let path = fixture.data.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    crate::pi_sdk::register_pi_sdk_agent(crate::pi_sdk::PiSdkAgentRegistrationRequest {
        data_dir: fixture.data.to_string_lossy().into_owned(),
        id: "acme-code".into(),
        name: "Acme Code Agent".into(),
        agent_dir: root.join("acme/pi").to_string_lossy().into_owned(),
        detection_paths: vec![root.join("detected").to_string_lossy().into_owned()],
        detection_commands: vec![],
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn source_l309_registered_sdk_keeps_the_actual_shared_pi_discovery_entry_enabled() {
    let Some(r) = isolated_plugin_case(
        "source_l309_registered_sdk_keeps_the_actual_shared_pi_discovery_entry_enabled",
    )
    .await
    else {
        return;
    };
    let fixture = fixture(&r, plugin(&r, "pi-coding-agent", "external-pi-extension")).await;
    register_sdk(&fixture, &r).await;
    fixture.manager.load_definitions().await;
    assert!(fixture
        .manager
        .get_definitions()
        .iter()
        .any(|d| d.id == "acme-code" && d.pi_sdk.is_some()));
    let mut config = fixture
        .orchestrator("pi-coding-agent", Some(false))
        .config
        .clone();
    let mut sdk = config.agents.get("pi-coding-agent").unwrap().clone();
    sdk.enabled = Some(true);
    config.agents.insert("acme-code".into(), sdk);
    let orch = Arc::new(Orchestrator::new(config));
    *orch.deployment.lock().unwrap() = Some(Arc::clone(&fixture.manager));
    let store = Arc::new(StateStore::new(r.join("state.json")));
    let entries = orch.register_all_inputs(&store).await;
    let pi = entries
        .iter()
        .find(|e| e.id() == "pi-coding-agent-log")
        .unwrap();
    assert!(
        pi.enabled(),
        "built-in disabled must not stop enabled registered SDK input"
    );
    {
        let mut bits = orch.bits.lock().unwrap();
        bits.scope = DeploymentScopeMode::Recorded;
        bits.recorded.clear();
    }
    assert!(
        !pi.enabled(),
        "unrecorded SDK cannot bypass deployment scope"
    );
    orch.bits
        .lock()
        .unwrap()
        .recorded
        .insert("acme-code".into());
    assert!(pi.enabled());
    orch.bits.lock().unwrap().modes.insert(
        "pi-coding-agent-log".into(),
        crate::types::AgentControlMode::Off,
    );
    assert!(
        !pi.enabled(),
        "shared listener off must still override enabled SDK"
    );
    orch.inputs.stop_all().await;
}
#[tokio::test]
async fn source_l344_actual_missing_sdk_wrapper_is_restored_without_degraded_alarm() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "pi-coding-agent", "external-pi-extension")).await;
    let registered = register_sdk(&fixture, r).await;
    let original = std::fs::read(&registered.wrapper_path).unwrap();
    std::fs::remove_file(&registered.wrapper_path).unwrap();
    let orch = fixture.orchestrator("pi-coding-agent", None);
    let alarm = AlarmManager::new("127.0.0.1", "test", "test-user");
    orch.restore_pi_sdk(&alarm).await;
    assert_eq!(std::fs::read(&registered.wrapper_path).unwrap(), original);
    assert!(alarm.serialize().is_empty());
}
#[tokio::test]
async fn source_l352_real_bounded_busy_restore_records_degradation_and_returns() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "pi-coding-agent", "external-pi-extension")).await;
    let lock = fixture.data.join(crate::pi_sdk::PI_SDK_REGISTRY_LOCK_FILE);
    let blocker = crate::utils::acquire_single_instance_lock(lock.to_str().unwrap(), None)
        .lock
        .unwrap();
    let orch = fixture.orchestrator("pi-coding-agent", None);
    let alarm = AlarmManager::new("127.0.0.1", "test", "test-user");
    let started = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(5), orch.restore_pi_sdk(&alarm))
        .await
        .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(400));
    let rows = alarm.serialize();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].alarm_type, "DEGRADED_STARTUP_ALARM");
    assert_eq!(rows[0].alarm_level, "2");
    assert_eq!(rows[0].input_name.as_deref(), Some("pi-coding-agent-log"));
    assert!(rows[0]
        .alarm_message
        .contains("remained busy after bounded retries"));
    blocker.release();
}
#[tokio::test]
async fn source_l365_actual_non_busy_restore_failure_has_only_sanitized_alarm_text() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let fixture = fixture(r, plugin(r, "pi-coding-agent", "external-pi-extension")).await;
    let registered = register_sdk(&fixture, r).await;
    std::fs::remove_file(&registered.wrapper_path).unwrap();
    std::fs::remove_file(fixture.data.join("plugins/pi-coding-agent/index.mjs")).unwrap();
    let orch = fixture.orchestrator("pi-coding-agent", None);
    let alarm = AlarmManager::new("127.0.0.1", "test", "test-user");
    tokio::time::timeout(Duration::from_secs(5), orch.restore_pi_sdk(&alarm))
        .await
        .unwrap();
    let rows = alarm.serialize();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].alarm_type, "DEGRADED_STARTUP_ALARM");
    assert_eq!(rows[0].alarm_level, "2");
    assert_eq!(rows[0].input_name.as_deref(), Some("pi-coding-agent-log"));
    assert!(rows[0].alarm_message.contains("run agent doctor"));
    assert!(!rows[0]
        .alarm_message
        .contains(&r.to_string_lossy().to_string()));
    assert!(!Path::new(&registered.wrapper_path).exists());
}
