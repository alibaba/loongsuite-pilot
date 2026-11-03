//! Historical Windows Codex cleanup through genuine producers and Native CLI.
//! GNU covers its own path; Windows acceptance requires actual Windows CI.
use super::*;
use loongsuite_pilot::deployment::{AgentDefLoader, AgentDefLoaderOptions, HookStrategy};
use loongsuite_pilot::hooks::HookManager;
use std::collections::HashMap;

struct Codex {
    f: Fixture,
    definition: loongsuite_pilot::types::AgentDefinition,
    settings: PathBuf,
    trust: PathBuf,
    script: PathBuf,
}
impl Codex {
    async fn new(bom: bool) -> Self {
        let f = Fixture::new();
        let mut source: Value =
            serde_json::from_str(include_str!("../../agents.d/codex.json")).unwrap();
        source["hook"]["settingsPath"] = json!(f.root.path().join(".codex/hooks.json"));
        source["hook"]["trustToml"]["configPath"] = json!(f.root.path().join(".codex/config.toml"));
        let resource = source.to_string();
        f.package_with(&[("agents.d/codex.json", &resource)]);
        let loader = AgentDefLoader::new(AgentDefLoaderOptions {
            builtin_dir: f.candidate.join("agents.d").to_string_lossy().into_owned(),
            local_dir: f.data.join("agents.d.local").to_string_lossy().into_owned(),
            pilot_dir: f.candidate.to_string_lossy().into_owned(),
            data_dir: f.data.to_string_lossy().into_owned(),
        })
        .with_env(HashMap::from([
            ("HOME".into(), f.root.path().to_string_lossy().into_owned()),
            (
                "USERPROFILE".into(),
                f.root.path().to_string_lossy().into_owned(),
            ),
        ]));
        let mut def = loader
            .load()
            .await
            .into_iter()
            .find(|d| d.id == "codex")
            .unwrap();
        // Trust paths are resolved by HookStrategy against process HOME.
        // Supply this fixture's already-expanded absolute path to the genuine
        // producer; never change process HOME or write another test's home.
        let trust = f.root.path().join(".codex/config.toml");
        def.hook
            .as_mut()
            .unwrap()
            .trust_toml
            .as_mut()
            .unwrap()
            .config_path = trust.to_string_lossy().into_owned();
        let hook = def.hook.as_ref().unwrap();
        let settings = PathBuf::from(&hook.settings_path);
        let script = PathBuf::from(&hook.hook_command);
        assert!(
            settings.starts_with(f.root.path()),
            "settings escaped fixture: {settings:?}"
        );
        assert!(
            script.starts_with(&f.data),
            "script escaped fixture: {script:?}"
        );
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(&script, "private real producer script asset\n").unwrap();
        let raw = json!({"private":"keep-private-config","hooks":{}}).to_string();
        fs::write(&settings, if bom { format!("\u{feff}{raw}") } else { raw }).unwrap();
        fs::write(&trust, "model = \"keep-user-model\"\n# otel-codex-hook unrelated third-party marker\n[hooks.state.\"unrelated-user-entry\"]\ntrusted_hash = \"keep-user-trust\"\n").unwrap();
        let strategy = HookStrategy::new(HookManager::new(
            Some(f.data.join("hooks").to_string_lossy().into_owned()),
            Some(f.data.join("logs").to_string_lossy().into_owned()),
        ));
        let deployed = tokio::time::timeout(Duration::from_secs(15), strategy.deploy_hooks(&def))
            .await
            .unwrap();
        assert!(
            deployed.success,
            "genuine Codex producer failed: {:?}",
            deployed.error
        );
        Self {
            f,
            definition: def,
            settings,
            trust,
            script,
        }
    }
    fn cleanup(&self, check: bool) -> Output {
        let mut command = self.f.command(&self.f.binary);
        command
            .args(["installer-helper", "cleanup-agents", "--input-env"])
            .env(
                "LOONGSUITE_PILOT_INSTALL_INPUT",
                json!({"dataDir":self.f.data,"pilotDir":self.f.candidate,"checkOnly":check})
                    .to_string(),
            );
        bounded_for(command, Duration::from_secs(15))
    }
}
#[tokio::test]
async fn cleanup_l490_l504_l512_l517_actual_codex_uninstall_keeps_mixed_third_party_handlers_and_unrelated_trust(
) {
    let c = Codex::new(false).await;
    let mut value: Value = serde_json::from_slice(&fs::read(&c.settings).unwrap()).unwrap();
    let pilot = value["hooks"]["Stop"][0]["hooks"][0].clone();
    assert!(pilot["command"]
        .as_str()
        .unwrap()
        .contains("codex-loongsuite-pilot-hook"));
    let cached =
        c.f.root
            .path()
            .join(".cache/opentelemetry.instrumentation.codex/hook-entry.sh");
    let unrelated = c.f.data.join("third-party.sh");
    let agenttrack = json!({"type":"command","command":"otel-codex-hook stop","timeout":17});
    let cachehandler = json!({"type":"command","command":format!("bash {} stop",cached.display())});
    let other = json!({"type":"command","command":unrelated.to_string_lossy()});
    let expected =
        json!([{"matcher":"*","hooks":[agenttrack,cachehandler,other]},null,{"hooks":[]}]);
    value["hooks"]["Stop"] = json!([{"matcher":"*","hooks":[agenttrack,pilot.clone(),cachehandler,other]},pilot,null,{"hooks":[]}]);
    fs::write(&c.settings, value.to_string()).unwrap();
    // Produce trust entries for both current exact-owned locations with the
    // real writer, preserving the old slot now occupied by a foreign handler.
    let hook_path = c
        .settings
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned();
    let stale_stop_key =
        loongsuite_pilot::deployment::hook_state_key(&hook_path, "Stop", 0, 0).unwrap();
    let mut newly_owned = Vec::new();
    for (group_index, handler_index, matcher) in [(0, 1, Some("*".to_owned())), (1, 0, None)] {
        let location = loongsuite_pilot::deployment::InstalledCodexHookLocation {
            event_name: "Stop".into(),
            event_key: "stop".into(),
            group_index,
            handler_index,
            matcher,
            handler: loongsuite_pilot::deployment::InstalledCodexCommandHandler {
                command: pilot["command"].as_str().unwrap().into(),
                command_windows: pilot
                    .get("commandWindows")
                    .or_else(|| pilot.get("command_windows"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                timeout: pilot.get("timeout").and_then(Value::as_f64),
                r#async: pilot.get("async").and_then(Value::as_bool),
                status_message: pilot
                    .get("statusMessage")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                additional_context_limit: pilot
                    .get("additionalContextLimit")
                    .and_then(Value::as_f64),
            },
        };
        newly_owned.push(loongsuite_pilot::deployment::installed_hook_state_key(
            &hook_path, &location,
        ));
        let opts = loongsuite_pilot::deployment::InstalledTrustOpts {
            config_path: c.trust.to_string_lossy().into_owned(),
            hooks_json_abs_path: hook_path.clone(),
            locations: HashMap::from([("Stop".into(), location)]),
            retired_keys: vec![],
            marker: "otel-codex-hook".into(),
        };
        assert!(loongsuite_pilot::deployment::write_trusted_hashes(
            &loongsuite_pilot::deployment::TrustOpts::Installed(opts)
        )
        .await
        .unwrap());
    }
    let mut expected_trust: toml::Value =
        toml::from_str(&fs::read_to_string(&c.trust).unwrap()).unwrap();
    let states = expected_trust["hooks"]["state"].as_table_mut().unwrap();
    assert!(states.contains_key(&stale_stop_key));
    for key in &newly_owned {
        assert!(states.contains_key(key));
    }
    states.retain(|key, _| key == "unrelated-user-entry" || key == stale_stop_key);
    let strategy = HookStrategy::new(HookManager::new(
        Some(c.f.data.join("hooks").to_string_lossy().into_owned()),
        Some(c.f.data.join("logs").to_string_lossy().into_owned()),
    ));
    let deploy_before = fs::read(&c.settings).unwrap();
    let deploy_trust_before = fs::read(&c.trust).unwrap();
    let deploy = tokio::time::timeout(
        Duration::from_secs(15),
        strategy.deploy_hooks(&c.definition),
    )
    .await
    .unwrap();
    assert!(
        !deploy.success,
        "normal deployment must still reject duplicate owned handlers"
    );
    assert!(deploy
        .error
        .as_deref()
        .unwrap()
        .contains("expected exactly one installed Pilot handler"));
    assert_eq!(fs::read(&c.settings).unwrap(), deploy_before);
    assert_eq!(fs::read(&c.trust).unwrap(), deploy_trust_before);

    let retained = [
        c.f.root
            .path()
            .join(".cache/opentelemetry.instrumentation.codex/sessions/trace.jsonl"),
        c.f.root.path().join(".codex/otel-config.json"),
        unrelated,
    ];
    for path in &retained {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "third-party exact bytes").unwrap();
    }
    let before = fs::read(&c.settings).unwrap();
    let trust_before = fs::read(&c.trust).unwrap();
    success(&c.cleanup(true));
    assert_eq!(fs::read(&c.settings).unwrap(), before);
    assert_eq!(fs::read(&c.trust).unwrap(), trust_before);
    for _ in 0..2 {
        let output = c.cleanup(false);
        success(&output);
        let actual: Value = serde_json::from_slice(&fs::read(&c.settings).unwrap()).unwrap();
        assert_eq!(
            actual,
            json!({"private":"keep-private-config","hooks":{"Stop":expected}})
        );
        let trust = fs::read_to_string(&c.trust).unwrap();
        assert_eq!(
            toml::from_str::<toml::Value>(&trust).unwrap(),
            expected_trust,
            "only current exact-owned trust keys may disappear"
        );
        for text in [
            "# otel-codex-hook unrelated third-party marker",
            "[hooks.state.\"unrelated-user-entry\"]",
            "trusted_hash = \"keep-user-trust\"",
            "model = \"keep-user-model\"",
        ] {
            assert!(trust.contains(text));
        }
        assert_eq!(
            fs::read(&c.script).unwrap(),
            b"private real producer script asset\n"
        );
        for path in &retained {
            assert_eq!(fs::read(path).unwrap(), b"third-party exact bytes");
        }
        for stream in [&output.stdout, &output.stderr] {
            assert!(!String::from_utf8_lossy(stream).contains("keep-private-config"));
        }
    }
}
#[tokio::test]
async fn cleanup_l523_actual_codex_native_rewrite_emits_utf8_without_initial_bom() {
    let c = Codex::new(true).await;
    let raw = fs::read_to_string(&c.settings).unwrap();
    let mut before = loongsuite_pilot::utils::parse_json_document(
        &raw,
        loongsuite_pilot::utils::JsonSyntax::Json,
    )
    .unwrap();
    before["internalBom"] = json!("a\u{feff}b");
    fs::write(&c.settings, format!("\u{feff}{before}")).unwrap();
    success(&c.cleanup(false));
    let bytes = fs::read(&c.settings).unwrap();
    assert!(
        !bytes.starts_with(b"\xef\xbb\xbf"),
        "Codex hook rewrite must retain the original BOM-free writer capability"
    );
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["private"], "keep-private-config");
    assert_eq!(value["internalBom"], "a\u{feff}b");
    assert!(value.get("hooks").is_none());
}

#[tokio::test]
async fn cleanup_codex_noop_keeps_initial_bom_and_unknown_owned_reference_keeps_every_retry_byte() {
    let c = Codex::new(true).await;
    success(&c.cleanup(false));
    let clean = fs::read(&c.settings).unwrap();
    let mut original = b"\xef\xbb\xbf".to_vec();
    original.extend(clean);
    fs::write(&c.settings, &original).unwrap();
    let trust = fs::read(&c.trust).unwrap();
    success(&c.cleanup(false));
    assert_eq!(
        fs::read(&c.settings).unwrap(),
        original,
        "Codex no-op must not rewrite encoding"
    );
    assert_eq!(fs::read(&c.trust).unwrap(), trust);

    let c = Codex::new(false).await;
    let mut value: Value = serde_json::from_slice(&fs::read(&c.settings).unwrap()).unwrap();
    let command = format!(
        "{} unexpected-user-argument",
        value["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
    );
    value["hooks"]["Stop"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"command","command":command}));
    let original = value.to_string();
    fs::write(&c.settings, &original).unwrap();
    let trust = fs::read(&c.trust).unwrap();
    let out = c.cleanup(false);
    assert!(
        !out.status.success(),
        "unknown owned-looking handler must still refuse cleanup"
    );
    assert!(String::from_utf8_lossy(&out.stderr)
        .contains("installation files were preserved for retry"));
    assert_eq!(fs::read_to_string(&c.settings).unwrap(), original);
    assert_eq!(fs::read(&c.trust).unwrap(), trust);
    assert_eq!(
        fs::read(&c.script).unwrap(),
        b"private real producer script asset\n"
    );
    assert!(c.f.binary.is_file());
}
#[tokio::test]
async fn cleanup_other_agents_keep_initial_bom_during_real_native_hook_cleanup() {
    let f = Fixture::new();
    let settings = f.root.path().join(".cursor/hooks.json");
    let mut source: Value =
        serde_json::from_str(include_str!("../../agents.d/cursor.json")).unwrap();
    source["hook"]["settingsPath"] = json!(settings);
    let resource = source.to_string();
    f.package_with(&[("agents.d/cursor.json", &resource)]);
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        builtin_dir: f.candidate.join("agents.d").to_string_lossy().into_owned(),
        local_dir: f.data.join("agents.d.local").to_string_lossy().into_owned(),
        pilot_dir: f.candidate.to_string_lossy().into_owned(),
        data_dir: f.data.to_string_lossy().into_owned(),
    })
    .with_env(HashMap::from([
        ("HOME".into(), f.root.path().to_string_lossy().into_owned()),
        (
            "USERPROFILE".into(),
            f.root.path().to_string_lossy().into_owned(),
        ),
    ]));
    let def = loader
        .load()
        .await
        .into_iter()
        .find(|d| d.id == "cursor")
        .unwrap();
    assert_eq!(
        Path::new(&def.hook.as_ref().unwrap().settings_path),
        settings
    );
    let script = PathBuf::from(&def.hook.as_ref().unwrap().hook_command);
    assert!(script.starts_with(&f.data));
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(&script, "keep Cursor runtime").unwrap();
    fs::write(
        &settings,
        "\u{feff}{\"private\":\"preserve-cursor\",\"hooks\":{}}",
    )
    .unwrap();
    let strategy = HookStrategy::new(HookManager::new(
        Some(f.data.join("hooks").to_string_lossy().into_owned()),
        Some(f.data.join("logs").to_string_lossy().into_owned()),
    ));
    assert!(
        tokio::time::timeout(Duration::from_secs(15), strategy.deploy_hooks(&def))
            .await
            .unwrap()
            .success
    );
    let mut cmd = f.command(&f.binary);
    cmd.args(["installer-helper", "cleanup-agents", "--input-env"])
        .env(
            "LOONGSUITE_PILOT_INSTALL_INPUT",
            json!({"dataDir":f.data,"pilotDir":f.candidate}).to_string(),
        );
    success(&bounded_for(cmd, Duration::from_secs(15)));
    let bytes = fs::read(&settings).unwrap();
    assert!(
        bytes.starts_with(b"\xef\xbb\xbf"),
        "non-Codex edit must preserve original BOM"
    );
    let value = loongsuite_pilot::utils::parse_json_document(
        std::str::from_utf8(&bytes).unwrap(),
        loongsuite_pilot::utils::JsonSyntax::Jsonc,
    )
    .unwrap();
    assert_eq!(value["private"], "preserve-cursor");
    assert!(value.get("hooks").is_none());
}
