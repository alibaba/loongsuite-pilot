//! Historical deployment contracts exercised with actual configuration documents.
use super::*;
use serde_json::json;
struct Fixture {
    root: tempfile::TempDir,
    settings: PathBuf,
    strategy: HookStrategy,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let settings = root.path().join(name);
        let strategy = HookStrategy::new(HookManager::new(
            Some(root.path().join("hooks").to_string_lossy().into_owned()),
            Some(root.path().join("logs").to_string_lossy().into_owned()),
        ));
        Self {
            root,
            settings,
            strategy,
        }
    }
    fn def(&self, id: &str) -> AgentDefinition {
        serde_json::from_value(json!({"id":id,"displayName":id,"deployMode":"hook",
            "detection":{"paths":[self.settings],"commands":[]},"hook":{
            "settingsPath":self.settings,"events":["Stop","PostToolUse"],"hookCommand":self.root.path().join("pilot-hook"),
            "format":"flat"}})).unwrap()
    }
    fn write(&self, value: &Value) {
        std::fs::create_dir_all(self.settings.parent().unwrap()).unwrap();
        std::fs::write(&self.settings, value.to_string()).unwrap();
    }
    fn data(&self) -> Value {
        serde_json::from_slice(&std::fs::read(&self.settings).unwrap()).unwrap()
    }
    fn trust_def(&self, events: &[&str]) -> AgentDefinition {
        let mut value = serde_json::to_value(self.def("codex")).unwrap();
        value["hook"]["events"] = json!(events);
        value["hook"]["format"] = json!("nested");
        value["hook"]["eventSubcommand"] = json!("kebab-case");
        value["hook"]["matcher"] = json!("*");
        value["hook"]["trustToml"] = json!({"configPath":self.root.path().join("config.toml"),"trustAlgo":"v1","marker":"otel-codex-hook"});
        serde_json::from_value(value).unwrap()
    }
}
#[tokio::test]
async fn discovery_and_each_installed_event_control_real_deployment_health() {
    let f = Fixture::new("hooks.json");
    let def = f.def("test-hook-agent");
    assert!(!f.strategy.detect(&def).await);
    assert!(f.strategy.needs_deploy(&def, None).await);
    f.write(&json!({"user":"preserved"}));
    assert!(f.strategy.detect(&def).await);
    assert!(f.strategy.deploy(&def).await.success);
    assert!(!f.strategy.needs_deploy(&def, None).await);
    let installed = std::fs::read(&f.settings).unwrap();
    assert!(f.strategy.deploy(&def).await.success);
    assert_eq!(std::fs::read(&f.settings).unwrap(), installed);
    let mut data = f.data();
    data["hooks"].as_object_mut().unwrap().remove("PostToolUse");
    f.write(&data);
    assert!(f.strategy.needs_deploy(&def, None).await);
    assert!(f.strategy.deploy(&def).await.success);
    assert_eq!(f.data()["user"], "preserved");
    assert_eq!(f.data()["hooks"]["Stop"].as_array().unwrap().len(), 1);
    assert_eq!(
        f.data()["hooks"]["PostToolUse"].as_array().unwrap().len(),
        1
    );
}
#[tokio::test]
async fn cursor_and_codex_version_rules_hold_for_missing_empty_and_existing_documents() {
    for (id, initial, expected) in [
        ("cursor", None, Some(1)),
        ("cursor", Some("{}"), Some(1)),
        ("cursor-cli", Some("{\"version\":2}"), Some(2)),
        ("codex", None, None),
        ("codex", Some("{}"), None),
        ("codex", Some("{\"version\":1}"), None),
        ("test", None, None),
    ] {
        let f = Fixture::new("hooks.json");
        if let Some(raw) = initial {
            std::fs::write(&f.settings, raw).unwrap();
        }
        let def = f.def(id);
        if id == "codex" && initial == Some("{\"version\":1}") {
            assert!(f.strategy.needs_deploy(&def, None).await);
        }
        assert!(f.strategy.deploy(&def).await.success, "{id}");
        assert_eq!(f.data().get("version").and_then(Value::as_i64), expected);
        assert_eq!(f.data()["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(!f.strategy.needs_deploy(&def, None).await);
    }
}
#[tokio::test]
async fn non_hooks_settings_are_created_once_without_cursor_version_and_whitespace_is_safe() {
    let f = Fixture::new("settings.json");
    let def = f.def("cursor");
    assert!(f.strategy.deploy(&def).await.success);
    assert!(f.data().get("version").is_none());
    let f = Fixture::new("hooks.json");
    std::fs::write(&f.settings, " \n\t ").unwrap();
    assert!(f.strategy.deploy(&f.def("cursor")).await.success);
    assert_eq!(f.data()["version"], 1);
    assert!(f.data()["hooks"]["Stop"].is_array());
}
#[test]
fn generated_definitions_preserve_event_shape_replacements_matchers_and_jsonc_syntax() {
    let f = Fixture::new("settings.json");
    let mut def = f.def("test-hook-agent");
    let first = f.strategy.build_hook_definitions(&def);
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].agent_id, "test-hook-agent");
    assert_eq!(first[0].settings_path, f.settings.to_string_lossy());
    assert_eq!(first[0].hook_json_path, ["hooks", "Stop"]);
    assert_eq!(first[1].hook_json_path, ["hooks", "PostToolUse"]);
    assert_eq!(
        first[0].hook_command,
        def.hook.as_ref().unwrap().hook_command
    );
    assert_eq!(first[0].use_nested_format, Some(false));
    let h = def.hook.as_mut().unwrap();
    h.format = crate::types::HookFormat::Nested;
    h.replace_hook_commands = Some(vec!["/old/hook".into()]);
    h.events = vec!["SessionStart".into(), "PreToolUse".into()];
    h.event_matchers = Some(Map::from_iter([("PreToolUse".into(), json!(".*"))]));
    h.settings_syntax = Some(SettingsSyntax::Jsonc);
    let got = f.strategy.build_hook_definitions(&def);
    assert_eq!(got[0].matcher, None);
    assert_eq!(got[1].matcher.as_deref(), Some(".*"));
    assert_eq!(got[0].settings_syntax, Some(SettingsSyntax::Jsonc));
    assert_eq!(got[0].use_nested_format, Some(true));
    assert!(got[0]
        .replace_hook_commands
        .as_ref()
        .unwrap()
        .contains(&"/old/hook".into()));
}
#[tokio::test]
async fn configured_replacement_removes_only_owned_legacy_hook_and_preserves_user_handler() {
    let f = Fixture::new("settings.json");
    let mut def = f.def("test");
    let h = def.hook.as_mut().unwrap();
    h.events = vec!["Stop".into()];
    h.replace_hook_commands = Some(vec!["/old/hook".into()]);
    f.write(&json!({"hooks":{"Stop":[{"command":"/old/hook"},{"command":"user-hook"}]}}));
    assert!(f.strategy.deploy(&def).await.success);
    let text = std::fs::read_to_string(&f.settings).unwrap();
    assert!(!text.contains("/old/hook"));
    assert_eq!(text.matches("user-hook").count(), 1);
    assert_eq!(f.data()["hooks"]["Stop"].as_array().unwrap().len(), 2);
}
#[test]
fn platform_shell_policy_never_invents_a_codex_shell_or_leaks_windows_shell_on_unix() {
    let f = Fixture::new("settings.json");
    let mut def = f.def("qoder");
    def.hook.as_mut().unwrap().win_shell = Some("powershell".into());
    let got = f.strategy.build_hook_definitions(&def);
    assert_eq!(
        got[0].shell.as_deref(),
        if cfg!(windows) {
            Some("powershell")
        } else {
            None
        }
    );
    def.id = "codex".into();
    def.hook.as_mut().unwrap().win_shell = None;
    assert_eq!(f.strategy.build_hook_definitions(&def)[0].shell, None);
}
#[test]
fn explicit_windows_serialization_quotes_paths_and_preserves_grok_event_spelling() {
    let path = "C:/Users/Test User/pilot data/hooks/grok-build.ps1";
    let wrapped = wrap_ps1_for_platform(path, true);
    assert_eq!(wrapped,"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:/Users/Test User/pilot data/hooks/grok-build.ps1\"");
    assert_eq!(
        append_event_subcommand(&wrapped, "stop_failure", Some(EventSubcommand::AsIs)),
        format!("{wrapped} stop_failure")
    );
    assert_eq!(append_event_subcommand(&wrap_ps1_for_platform("C:/Users/Test User/hooks/codex.ps1",true),"Stop",Some(EventSubcommand::KebabCase)),"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:/Users/Test User/hooks/codex.ps1\" stop");
}
#[cfg(windows)]
#[tokio::test]
async fn actual_windows_deployment_replaces_legacy_alias_and_keeps_declared_shell() {
    let f = Fixture::new("settings.json");
    let mut def = f.def("qoder");
    let h = def.hook.as_mut().unwrap();
    h.hook_command = "C:/Users/Test User/hooks/qoder.ps1".into();
    h.events = vec!["Stop".into()];
    h.format = crate::types::HookFormat::Nested;
    h.event_subcommand = Some(EventSubcommand::KebabCase);
    h.win_shell = Some("powershell".into());
    let legacy="powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/Test User/hooks/qoder.ps1 stop";
    f.write(&json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":legacy}]},{"hooks":[{"type":"command","command":"user-hook"}]}]}}));
    let deployed = f.strategy.deploy(&def).await;
    assert!(deployed.success, "{:?}", deployed.error);
    let text = std::fs::read_to_string(&f.settings).unwrap();
    assert!(!text.contains(legacy));
    assert_eq!(text.matches("qoder.ps1").count(), 1);
    assert_eq!(text.matches("user-hook").count(), 1);
    let data = f.data();
    let handlers: Vec<_> = data["hooks"]["Stop"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .collect();
    let installed = handlers
        .iter()
        .find(|handler| {
            handler
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| command.contains("qoder.ps1"))
        })
        .unwrap();
    assert_eq!(installed["shell"], "powershell");

    assert_eq!(
        f.strategy.build_hook_definitions(&def)[0].shell.as_deref(),
        Some("powershell")
    );
}
#[tokio::test]
async fn jsonc_hook_deployment_keeps_comments_and_user_fields_and_reports_installed_health() {
    let f = Fixture::new("settings.json");
    let mut def = f.def("qwen-code-cli");
    def.hook.as_mut().unwrap().settings_syntax = Some(SettingsSyntax::Jsonc);
    std::fs::write(
        &f.settings,
        "// 用户注释\n{\n \"theme\": \"dark\", // keep\n}\n",
    )
    .unwrap();
    assert!(f.strategy.deploy(&def).await.success);
    let raw = std::fs::read_to_string(&f.settings).unwrap();
    assert!(raw.contains("// 用户注释"));
    assert!(raw.contains("// keep"));
    assert!(raw.contains("\"dark\""));
    assert!(!f.strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn trust_health_uses_actual_nonzero_installed_indices_matcher_and_handler_fields() {
    let f = Fixture::new("hooks.json");
    let def = f.trust_def(&["SubagentStart"]);
    let command = f.strategy.build_hook_definitions(&def)[0]
        .hook_command
        .clone();
    f.write(&json!({"hooks":{"SubagentStart":[{"matcher":"*","hooks":[{"type":"command","command":"third-party"}]},{"matcher":"*","hooks":[{"type":"command","command":"another-handler"},{"type":"command","command":command,"timeout":12,"async":true,"statusMessage":"starting"}]}]}}));
    assert!(f.strategy.needs_deploy(&def, None).await);
    let locations = f
        .strategy
        .resolve_installed_codex_hooks(&def, &["SubagentStart".into()], false)
        .await
        .unwrap();
    let loc = &locations["SubagentStart"];
    assert_eq!(loc.group_index, 1);
    assert_eq!(loc.handler_index, 1);
    assert_eq!(loc.matcher.as_deref(), Some("*"));
    assert_eq!(loc.handler.timeout, Some(12.0));
    assert_eq!(loc.handler.r#async, Some(true));
    assert_eq!(loc.handler.status_message.as_deref(), Some("starting"));
    let opts = TrustOpts::Installed(InstalledTrustOpts {
        config_path: f
            .root
            .path()
            .join("config.toml")
            .to_string_lossy()
            .into_owned(),
        hooks_json_abs_path: node_resolve(&f.settings.to_string_lossy()),
        locations,
        retired_keys: vec![],
        marker: "otel-codex-hook".into(),
    });
    let content = plan_trusted_hashes(&opts, None).unwrap().unwrap();
    std::fs::write(f.root.path().join("config.toml"), content).unwrap();
    assert!(!f.strategy.needs_deploy(&def, None).await);
    let mut changed = f.data();
    changed["hooks"]["SubagentStart"][1]["hooks"][1]["timeout"] = json!(13);
    f.write(&changed);
    assert!(f.strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn duplicate_owned_commands_are_not_silently_trusted_or_removed_during_deploy() {
    let f = Fixture::new("hooks.json");
    let def = f.trust_def(&["Stop"]);
    let command = f.strategy.build_hook_definitions(&def)[0]
        .hook_command
        .clone();
    f.write(&json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":command},{"type":"command","command":command}]}]}}));
    let before = std::fs::read(&f.settings).unwrap();
    assert!(f.strategy.needs_deploy(&def, None).await);
    let result = f.strategy.deploy(&def).await;
    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("expected exactly one installed Pilot handler"));
    assert_eq!(std::fs::read(&f.settings).unwrap(), before);
    assert!(!f.root.path().join("config.toml").exists());
}
#[tokio::test]
async fn trust_self_check_rejects_actual_corrupt_planned_content_before_any_publication() {
    let f = Fixture::new("hooks.json");
    let def = f.trust_def(&["Stop"]);
    f.write(&json!({"user":"keep"}));
    let before = std::fs::read(&f.settings).unwrap();
    f.strategy
        .corrupt_next_planned_trust
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let result = f.strategy.deploy(&def).await;
    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("codex trust hash verification failed"));
    assert_eq!(std::fs::read(&f.settings).unwrap(), before);
    assert!(!f.root.path().join("config.toml").exists());
    assert!(f.strategy.deploy(&def).await.success);
    assert!(!f.strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn retired_events_are_removed_without_removing_third_party_handlers_and_uninstall_covers_all_current_events(
) {
    let f = Fixture::new("settings.json");
    let mut def = f.def("test");
    let h = def.hook.as_mut().unwrap();
    h.events = vec!["Stop".into()];
    h.retired_events = Some(vec!["SessionStart".into(), "PreToolUse".into()]);
    h.event_subcommand = Some(EventSubcommand::KebabCase);
    h.replace_hook_commands = Some(vec!["/old/hook".into()]);
    let retired = f.strategy.build_retired_hook_definitions(&def);
    assert_eq!(retired.len(), 2);
    assert_eq!(retired[0].hook_json_path, ["hooks", "SessionStart"]);
    assert!(retired[0].hook_command.ends_with(" session-start"));
    assert!(retired[0]
        .replace_hook_commands
        .as_ref()
        .unwrap()
        .contains(&"/old/hook".into()));
    f.write(&json!({"hooks":{"SessionStart":[{"command":retired[0].hook_command},{"command":"user-start"}],"PreToolUse":[{"command":"/old/hook"}]},"user":"keep"}));
    assert!(f.strategy.deploy(&def).await.success);
    assert_eq!(
        f.data()["hooks"]["SessionStart"],
        json!([{"command":"user-start"}])
    );
    assert!(f.data()["hooks"].get("PreToolUse").is_none());
    assert!(f.strategy.undeploy(&def).await);
    assert!(f.data()["hooks"].get("Stop").is_none());
    assert_eq!(f.data()["user"], "keep");
    assert_eq!(
        f.data()["hooks"]["SessionStart"],
        json!([{"command":"user-start"}])
    );
    let mut missing = def.clone();
    missing.hook = None;
    assert!(!f.strategy.undeploy(&missing).await);
}
#[tokio::test]
async fn uninstall_removes_only_the_exact_preinstalled_nonzero_codex_trust_key() {
    let f = Fixture::new("hooks.json");
    let def = f.trust_def(&["Stop"]);
    let command = f.strategy.build_hook_definitions(&def)[0]
        .hook_command
        .clone();
    f.write(&json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":"third-party"}]},{"hooks":[{"type":"command","command":command}]}]}}));
    let own = format!("{}:stop:1:0", node_resolve(&f.settings.to_string_lossy()));
    let foreign = format!("{}:stop:0:0", node_resolve(&f.settings.to_string_lossy()));
    let content=format!("# user setting\nmodel = \"kept\"\n[hooks.state.{}]\ntrusted_hash = \"owned\"\n[hooks.state.{}]\ntrusted_hash = \"foreign\"\n",serde_json::to_string(&own).unwrap(),serde_json::to_string(&foreign).unwrap());
    std::fs::write(f.root.path().join("config.toml"), content).unwrap();
    assert!(f.strategy.undeploy(&def).await);
    let after = std::fs::read_to_string(f.root.path().join("config.toml")).unwrap();
    let parsed = toml::from_str::<toml::Value>(&after).unwrap();
    let state = parsed["hooks"]["state"].as_table().unwrap();
    assert!(!state.contains_key(&own));
    assert_eq!(state[&foreign]["trusted_hash"].as_str(), Some("foreign"));
    assert!(after.contains("model = \"kept\""));
    assert_eq!(
        f.data()["hooks"]["Stop"],
        json!([{"hooks":[{"type":"command","command":"third-party"}]}])
    );
}
#[tokio::test]
async fn missing_hook_corrupt_document_and_os_read_failure_are_explicit_and_preserve_input() {
    let f = Fixture::new("hooks.json");
    let mut missing = f.def("test");
    missing.hook = None;
    let result = f.strategy.deploy(&missing).await;
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("missing hook config"));
    for bad in ["{\"hooks\":", "[]", "{\"hooks\":{\"Stop\":false}}"] {
        std::fs::write(&f.settings, bad).unwrap();
        let result = f.strategy.deploy(&f.def("test")).await;
        assert!(!result.success);
        assert!(!result.error.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(&f.settings).unwrap(), bad);
    }
    std::fs::remove_file(&f.settings).unwrap();
    std::fs::create_dir(&f.settings).unwrap();
    let result = f.strategy.deploy(&f.def("test")).await;
    assert!(!result.success);
    assert!(f.settings.is_dir());
    assert!(!f.strategy.undeploy(&f.def("test")).await);
}
#[tokio::test]
async fn env_merge_preserves_exact_tokens_unrelated_settings_and_idempotent_bytes() {
    for (initial, wanted, expected) in [
        (
            json!({"theme":"dark"}),
            json!({"BUN_OPTIONS":"--preload=/pilot/intercept.mjs"}),
            json!({"BUN_OPTIONS":"--preload=/pilot/intercept.mjs"}),
        ),
        (
            json!({"env":{"BUN_OPTIONS":"--preload=/pilot/intercept.mjs"}}),
            json!({"BUN_OPTIONS":"--preload=/pilot/intercept.mjs"}),
            json!({"BUN_OPTIONS":"--preload=/pilot/intercept.mjs"}),
        ),
        (
            json!({"env":{"BUN_OPTIONS":"--preload=/pilot/intercept.mjs-extra"}}),
            json!({"BUN_OPTIONS":"--preload=/pilot/intercept.mjs"}),
            json!({"BUN_OPTIONS":"--preload=/pilot/intercept.mjs-extra --preload=/pilot/intercept.mjs"}),
        ),
        (
            json!({"env":{"BUN_OPTIONS":"--preload=/user.mjs","KEEP":"yes"},"theme":"dark"}),
            json!({"BUN_OPTIONS":"--preload=/pilot/intercept.mjs"}),
            json!({"BUN_OPTIONS":"--preload=/user.mjs --preload=/pilot/intercept.mjs","KEEP":"yes"}),
        ),
        (
            json!({"env":{"PILOT_KEY":"old","KEEP":"yes"},"theme":"dark"}),
            json!({"PILOT_KEY":"new"}),
            json!({"PILOT_KEY":"new","KEEP":"yes"}),
        ),
        (
            json!({"env":{"PILOT_KEY":"new"}}),
            json!({"PILOT_KEY":"new"}),
            json!({"PILOT_KEY":"new"}),
        ),
    ] {
        let f = Fixture::new("settings.json");
        f.write(&initial);
        let mut def = f.def("test");
        def.hook.as_mut().unwrap().env = Some(wanted.as_object().unwrap().clone());
        assert!(f.strategy.deploy(&def).await.success);
        assert_eq!(f.data()["env"], expected);
        if initial.get("theme").is_some() {
            assert_eq!(f.data()["theme"], "dark");
        }
        let before = std::fs::read(&f.settings).unwrap();
        assert!(f.strategy.deploy(&def).await.success);
        assert_eq!(std::fs::read(&f.settings).unwrap(), before);
    }
    let f = Fixture::new("settings.json");
    f.write(&json!({"env":{"USER":"yes"}}));
    assert!(f.strategy.deploy(&f.def("test")).await.success);
    assert_eq!(f.data()["env"], json!({"USER":"yes"}));
}
#[tokio::test]
async fn approved_env_failure_contract_rejects_deploy_and_keeps_previous_hooks_and_user_configuration(
) {
    let f = Fixture::new("settings.json");
    let mut def = f.def("test");
    f.write(&json!({"env":"bad-shape","hooks":{"Stop":[{"command":"user-hook"}]},"theme":"dark"}));
    def.hook.as_mut().unwrap().env = Some(Map::from_iter([("PILOT_KEY".into(), json!("new"))]));
    let before = std::fs::read(&f.settings).unwrap();
    let result = f.strategy.deploy(&def).await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("env"));
    assert_eq!(std::fs::read(&f.settings).unwrap(), before);
}
fn interceptor_def(f: &Fixture, id: &str) -> AgentDefinition {
    let mut data = serde_json::to_value(f.def(id)).unwrap();
    data["hook"]["format"] = json!("nested");
    data["hook"]["events"] = json!(["Stop"]);
    data["hook"]["matcher"] = json!("*");
    data["hook"]["interceptor"] = json!({"events":["UserPromptSubmit","PreToolUse","PostToolUse"],"hookCommand":f.root.path().join("interceptor"),"matcher":"*","timeout":{"UserPromptSubmit":15,"PreToolUse":10,"PostToolUse":10},"insert":"head"});
    serde_json::from_value(data).unwrap()
}
#[tokio::test]
async fn qoder_and_qwen_interceptors_are_independent_head_hooks_and_health_requires_their_order() {
    for id in ["qoder", "qwen-work-cn"] {
        let f = Fixture::new("settings.json");
        let def = interceptor_def(&f, id);
        let defs = f.strategy.build_interceptor_definitions(&def);
        assert_eq!(defs.len(), 3);
        assert_eq!(
            defs.iter()
                .map(|v| v.hook_json_path[1].as_str())
                .collect::<Vec<_>>(),
            ["UserPromptSubmit", "PreToolUse", "PostToolUse"]
        );
        for (index, d) in defs.iter().enumerate() {
            assert_eq!(d.agent_id, id);
            assert_eq!(d.timeout, Some(if index == 0 { 15.0 } else { 10.0 }));
            assert_eq!(d.insert, Some(HookInsert::Head));
            assert_eq!(d.use_nested_format, Some(true));
        }
        f.write(&json!({"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"user-tool"}]}]}}));
        assert!(f.strategy.needs_deploy(&def, None).await);
        assert!(f.strategy.deploy(&def).await.success);
        assert!(!f.strategy.needs_deploy(&def, None).await);
        let data = f.data();
        assert_eq!(
            data["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            defs[1].hook_command
        );
        assert_eq!(
            data["hooks"]["Stop"][0]["hooks"][0]["command"],
            f.strategy.build_hook_definitions(&def)[0].hook_command
        );
        let mut data = data.clone();
        let hooks = data["hooks"]["PreToolUse"].as_array_mut().unwrap();
        // HookManager may place interceptor and user handler in separate groups.
        if hooks.len() > 1 {
            hooks.swap(0, 1);
        } else {
            hooks[0]["hooks"].as_array_mut().unwrap().swap(0, 1);
        }
        f.write(&data);
        assert!(f.strategy.needs_deploy(&def, None).await);
        assert!(f.strategy.deploy(&def).await.success);
        assert!(!f.strategy.needs_deploy(&def, None).await);
        let mut data = f.data();
        data["hooks"]
            .as_object_mut()
            .unwrap()
            .remove("UserPromptSubmit");
        f.write(&data);
        assert!(f.strategy.needs_deploy(&def, None).await);
    }
}

#[tokio::test]
async fn readonly_trust_publication_keeps_current_and_retired_hooks_and_original_toml() {
    let f = Fixture::new("hooks.json");
    let mut def = f.trust_def(&["Stop"]);
    def.hook.as_mut().unwrap().retired_events = Some(vec!["PreToolUse".into()]);
    let current = f.strategy.build_hook_definitions(&def)[0]
        .hook_command
        .clone();
    let retired = f.strategy.build_retired_hook_definitions(&def)[0]
        .hook_command
        .clone();
    f.write(&json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":current}]}],"PreToolUse":[{"hooks":[{"type":"command","command":retired}]}]},"user":"kept"}));
    let trust = f.root.path().join("config.toml");
    std::fs::write(&trust, "# user trust setting\nmodel = \"kept\"\n").unwrap();
    let before = std::fs::read(&f.settings).unwrap();
    let oldtrust = std::fs::read(&trust).unwrap();
    let permissions = std::fs::metadata(&trust).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&trust, readonly).unwrap();
    let result = f.strategy.deploy(&def).await;
    std::fs::set_permissions(&trust, permissions).unwrap();
    assert!(!result.success);
    assert!(!result.error.unwrap().is_empty());
    assert_eq!(std::fs::read(&f.settings).unwrap(), before);
    assert_eq!(std::fs::read(&trust).unwrap(), oldtrust);
    assert!(f.strategy.deploy(&def).await.success);
    assert!(f.data()["hooks"].get("PreToolUse").is_none());
    assert!(!f.strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn env_write_io_failure_cannot_report_success_or_publish_partial_hook_configuration() {
    let f = Fixture::new("settings.json");
    let mut def = f.def("test");
    f.write(
        &json!({"env":{"KEEP":"user"},"hooks":{"Stop":[{"command":"user-hook"}]},"theme":"dark"}),
    );
    def.hook.as_mut().unwrap().env = Some(Map::from_iter([("PILOT_KEY".into(), json!("new"))]));
    let before = std::fs::read(&f.settings).unwrap();
    let permissions = std::fs::metadata(&f.settings).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&f.settings, readonly).unwrap();
    let result = f.strategy.deploy(&def).await;
    std::fs::set_permissions(&f.settings, permissions).unwrap();
    assert!(!result.success);
    assert!(!result.error.unwrap().is_empty());
    assert_eq!(std::fs::read(&f.settings).unwrap(), before);
    assert!(f.strategy.deploy(&def).await.success);
    assert_eq!(f.data()["env"]["PILOT_KEY"], "new");
    assert_eq!(f.data()["env"]["KEEP"], "user");
    assert_eq!(f.data()["theme"], "dark");
}
