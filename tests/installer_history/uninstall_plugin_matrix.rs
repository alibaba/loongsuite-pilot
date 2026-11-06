use super::*;
use loongsuite_pilot::pi_sdk::{build_pi_sdk_agent_definition, PiSdkAgentRegistrationRequest};

fn document(path: &Path) -> Value {
    loongsuite_pilot::utils::parse_json_document(
        &fs::read_to_string(path).unwrap(),
        loongsuite_pilot::utils::JsonSyntax::Jsonc,
    )
    .unwrap()
}
fn cleanup(f: &Fixture) -> Output {
    let mut command = f.command(&f.binary);
    command
        .args(["installer-helper", "cleanup-agents", "--input-env"])
        .env(
            "LOONGSUITE_PILOT_INSTALL_INPUT",
            json!({"dataDir":f.data,"pilotDir":f.candidate}).to_string(),
        );
    bounded_for(command, Duration::from_secs(15))
}
fn hook(f: &Fixture, id: &str) -> (PathBuf, String) {
    let path = f.data.join("hooks").join(format!(
        "{id}-loongsuite-pilot-hook.{}",
        if cfg!(windows) { "ps1" } else { "sh" }
    ));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"retain until the whole uninstall succeeds\n").unwrap();
    let command = if cfg!(windows) {
        format!(
            "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
            path.display()
        )
    } else {
        loongsuite_pilot::hooks::quote_claude_hook_path(&path.to_string_lossy())
    };
    (path, command)
}
#[test]
fn cleanup_l548_codex_failure_continues_other_owned_agents_and_legacy_cleanup_but_preserves_retry_assets(
) {
    let f = Fixture::new();
    f.package_with(&[
        (
            "agents.d/codex.json",
            include_str!("../../agents.d/codex.json"),
        ),
        (
            "agents.d/cursor.json",
            include_str!("../../agents.d/cursor.json"),
        ),
    ]);
    let (codex_asset, codex_command) = hook(&f, "codex");
    let (cursor_asset, cursor_command) = hook(&f, "cursor");
    let codex = f.root.path().join(".codex/hooks.json");
    let cursor = f.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(codex.parent().unwrap()).unwrap();
    fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    let original_codex = json!({"hooks":{"SessionStart":[{"hooks":[{
        "type":"command","command":format!("{codex_command} --unrecognized-argument")
    }]}]}})
    .to_string();
    fs::write(&codex, &original_codex).unwrap();
    fs::write(
        &cursor,
        json!({"private":"keep","hooks":{"afterAgentResponse":[
            {"command":cursor_command},{"command":"keep-user-hook"}
        ]}})
        .to_string(),
    )
    .unwrap();
    let codex_record = json!({"deployMode":"hook","deployedAt":"old","hookSettingsPath":codex});
    fs::write(f.data.join("deployed-agents.json"),format!("\u{feff}{}",json!({
        "codex":codex_record,"cursor":{"deployMode":"hook","deployedAt":"old","hookSettingsPath":cursor}
    }))).unwrap();
    let bashrc = f.root.path().join(".bashrc");
    fs::write(&bashrc,"export KEEP=1\n# BEGIN otel-claude-hook\nalias claude='private-old-wrapper'\n# END otel-claude-hook\nexport AFTER=2\n").unwrap();
    let before_config = fs::read(f.data.join("config.json")).unwrap();
    let output = cleanup(&f);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Native cleanup failed for Agent codex")
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("continuing external cleanup"));
    assert_eq!(fs::read_to_string(&codex).unwrap(), original_codex);
    assert_eq!(
        document(&cursor),
        json!({"private":"keep","hooks":{"afterAgentResponse":[{"command":"keep-user-hook"}]}})
    );
    let state_bytes = fs::read(f.data.join("deployed-agents.json")).unwrap();
    let state: Value = serde_json::from_slice(
        state_bytes
            .strip_prefix(b"\xef\xbb\xbf")
            .unwrap_or(&state_bytes),
    )
    .unwrap();
    assert_eq!(state["codex"], codex_record);
    assert!(state.get("cursor").is_none());
    assert_eq!(
        fs::read_to_string(&bashrc).unwrap(),
        "export KEEP=1\nexport AFTER=2\n"
    );
    assert_eq!(fs::read(f.data.join("config.json")).unwrap(), before_config);
    for file in [codex_asset, cursor_asset] {
        assert_eq!(
            fs::read(file).unwrap(),
            b"retain until the whole uninstall succeeds\n"
        );
    }
}

#[test]
fn cleanup_l194_l210_all_opencode_and_mimo_config_names_remove_exact_owned_vectors_from_both_keys()
{
    for (id, source, relative) in [
        (
            "opencode",
            include_str!("../../agents.d/opencode.json"),
            "plugins/opencode",
        ),
        (
            "mimo-code",
            include_str!("../../agents.d/mimo-code.json"),
            "plugins/mimo-code",
        ),
    ] {
        let f = Fixture::new();
        let names: &[&str] = if id == "opencode" {
            &["opencode.jsonc", "opencode.json", "config.json"]
        } else {
            &["mimocode.jsonc", "mimocode.json"]
        };
        let home = f.root.path().join(".config").join(if id == "opencode" {
            "opencode"
        } else {
            "mimocode"
        });
        let configs: Vec<_> = names.iter().map(|name| home.join(name)).collect();
        fs::create_dir_all(configs[0].parent().unwrap()).unwrap();
        // Exercise the shipped default paths, not a replacement definition.
        let def: Value = serde_json::from_str(source).unwrap();
        let plugin_id = def["pluginInject"]["pluginId"].as_str().unwrap().to_owned();
        let filename = format!("agents.d/{id}.json");
        f.package_with(&[(&filename, source)]);
        let managed = f.data.join(relative);
        let raw = managed.to_string_lossy().replace('\\', "/");
        let url = reqwest::Url::from_file_path(&managed).unwrap().to_string();
        let foreign = f.root.path().join("other install").join(relative);
        let foreign_url = reqwest::Url::from_file_path(&foreign).unwrap().to_string();
        let mut third = json!([
            foreign.to_string_lossy(),foreign_url,
            format!("{raw}-extra"),format!("{url}/child-plugin.mjs"),
            "third-party",format!("{plugin_id}-extra"),
            {"package":"/third-party/plugins/opencode"},
            ["file:///third-party/plugins/opencode/plugin.mjs",{}]
        ]);
        // Only OpenCode declares legacy directory-root specs. MiMo's declared
        // file and package IDs remain removable; unknown directory specs stay.
        if id == "mimo-code" {
            let mut kept = vec![json!(raw), json!(format!("{url}/")), json!({"package":url})];
            kept.extend(third.as_array().unwrap().clone());
            third = json!(kept);
        }
        let mut owned = vec![
            json!(raw),
            json!(format!("{url}/")),
            json!([format!("{url}/plugin.mjs"), {}]),
            json!({"package":url}),
            json!(plugin_id),
            json!(format!("{plugin_id}@1.0.0")),
        ];
        owned.push(json!(format!("{raw}/plugin.mjs")));
        owned.push(json!(format!("{url}/plugin.mjs")));
        let foreign_start = if id == "mimo-code" { 3 } else { 0 };
        owned.extend(third.as_array().unwrap()[foreign_start..].iter().cloned());
        let original = format!(
            "// exact original backup\n{}\n",
            json!({"private":"keep","plugin":owned,"plugins":owned})
        );
        for file in &configs {
            fs::write(file, &original).unwrap();
        }
        success(&cleanup(&f));
        for file in &configs {
            let value = document(file);
            assert_eq!(value["plugin"], third, "{id} {file:?}");
            assert_eq!(value["plugins"], third, "{id} {file:?}");
            assert_eq!(value["private"], "keep");
            assert_eq!(
                fs::read_to_string(format!("{}.bak", file.display())).unwrap(),
                original
            );
        }
    }
}

#[test]
fn cleanup_l382_l892_recorded_pi_and_grok_custom_homes_do_not_need_current_environment_overrides() {
    for id in ["pi-coding-agent", "grok-build"] {
        let f = Fixture::new();
        let is_pi = id == "pi-coding-agent";
        let source = if is_pi {
            include_str!("../../agents.d/pi-coding-agent.json")
        } else {
            include_str!("../../agents.d/grok-build.json")
        };
        let filename = format!("agents.d/{id}.json");
        f.package_with(&[(&filename, source)]);
        let settings = f
            .root
            .path()
            .join("persisted custom home")
            .join("settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let expected;
        let record;
        if is_pi {
            let own = f.data.join("plugins/pi-coding-agent/index.mjs");
            fs::write(
                &settings,
                json!({"extensions":[own,"/third-party.mjs"],"url":"https://example.test//keep"})
                    .to_string(),
            )
            .unwrap();
            expected =
                json!({"extensions":["/third-party.mjs"],"url":"https://example.test//keep"});
            record = json!({"deployMode":"plugin-inject","deployedAt":"old","pluginInjectConfigPath":settings});
        } else {
            let (_, own) = hook(&f, "grok-build");
            let own = format!("{own} stop");
            fs::write(
                &settings,
                json!({"private":"keep","hooks":{"stop":[
                    {"command":own},{"command":"third-party-direct"},
                    {"matcher":"keep","hooks":[{"command":own},{"command":"third-party-nested"}]}
                ]}})
                .to_string(),
            )
            .unwrap();
            expected = json!({"private":"keep","hooks":{"stop":[{"command":"third-party-direct"},{"matcher":"keep","hooks":[{"command":"third-party-nested"}]}]}});
            record = json!({"deployMode":"hook","deployedAt":"old","hookSettingsPath":settings});
        }
        fs::write(
            f.data.join("deployed-agents.json"),
            json!({id:record}).to_string(),
        )
        .unwrap();
        success(&cleanup(&f));
        assert_eq!(document(&settings), expected, "{id}");
    }
}

#[test]
fn cleanup_l366_real_registered_sdk_definition_keeps_jsonc_user_fields_and_original_backup() {
    let f = Fixture::new();
    f.package();
    let agent = f.root.path().join("registered SDK home");
    fs::create_dir_all(&agent).unwrap();
    let def = build_pi_sdk_agent_definition(&PiSdkAgentRegistrationRequest {
        data_dir: f.data.to_string_lossy().into_owned(),
        id: "good-code".into(),
        name: "Good Code".into(),
        agent_dir: agent.to_string_lossy().into_owned(),
        detection_paths: vec![agent.to_string_lossy().into_owned()],
        detection_commands: vec![],
    })
    .unwrap();
    let settings = agent.join("settings.json");
    // The registered definition is declarative; installed settings contain
    // its physical dataDir expansion, as emitted by the real registry writer.
    let spec = f.data.join("plugins/pi-coding-agent/agents/good-code.mjs");
    let original = format!(
        "// keep exact backup comment\n{}\n",
        json!({"url":"https://example.test/path//segment","extensions":[spec,"/third-party.mjs"]})
    );
    fs::write(&settings, &original).unwrap();
    let definitions = f.data.join("agents.d.local");
    fs::create_dir_all(&definitions).unwrap();
    fs::write(
        definitions.join("good-code.json"),
        serde_json::to_vec(&def).unwrap(),
    )
    .unwrap();
    success(&cleanup(&f));
    assert_eq!(
        document(&settings),
        json!({"url":"https://example.test/path//segment","extensions":["/third-party.mjs"]})
    );
    assert_eq!(
        fs::read_to_string(format!("{}.bak", settings.display())).unwrap(),
        original
    );
}

#[test]
fn cleanup_l375_damaged_registered_target_does_not_block_good_jsonc_cleanup_and_keeps_failed_runtime(
) {
    let f = Fixture::new();
    f.package_with(&[(
        "agents.d/pi-coding-agent.json",
        include_str!("../../agents.d/pi-coding-agent.json"),
    )]);
    let definitions = f.data.join("agents.d.local");
    fs::create_dir_all(&definitions).unwrap();
    let mut good = None;
    let mut bad = None;
    for id in ["bad-code", "good-code"] {
        let agent = f.root.path().join(id);
        fs::create_dir_all(&agent).unwrap();
        let def = build_pi_sdk_agent_definition(&PiSdkAgentRegistrationRequest {
            data_dir: f.data.to_string_lossy().into_owned(),
            id: id.into(),
            name: id.into(),
            agent_dir: agent.to_string_lossy().into_owned(),
            detection_paths: vec![agent.to_string_lossy().into_owned()],
            detection_commands: vec![],
        })
        .unwrap();
        fs::write(
            definitions.join(format!("{id}.json")),
            serde_json::to_vec(&def).unwrap(),
        )
        .unwrap();
        let settings = agent.join("settings.json");
        if id == "bad-code" {
            fs::write(&settings, "{ broken custom config").unwrap();
            bad = Some(settings);
        } else {
            let original = format!(
                "// exact retained backup\n{}\n",
                json!({
                    "url":"https://example.test/path//segment",
                    "extensions":[f.data.join(format!("plugins/pi-coding-agent/agents/{id}.mjs")),"/third-party.mjs"]
                })
            );
            fs::write(&settings, &original).unwrap();
            good = Some((settings, original));
        }
    }
    let default_pi = f.root.path().join(".pi/agent/settings.json");
    fs::create_dir_all(default_pi.parent().unwrap()).unwrap();
    fs::write(&default_pi, "{ broken default Pi config").unwrap();
    let runtime = f.data.join("plugins/pi-coding-agent/agents/bad-code.mjs");
    fs::create_dir_all(runtime.parent().unwrap()).unwrap();
    fs::write(&runtime, b"needed for retry").unwrap();
    let output = cleanup(&f);
    // Native reports incomplete cleanup and keeps the runtime instead of
    // printing the legacy private Node helper's successful "partial" response.
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let (good, original) = good.unwrap();
    assert_eq!(
        document(&good),
        json!({"url":"https://example.test/path//segment","extensions":["/third-party.mjs"]})
    );
    assert_eq!(
        fs::read_to_string(format!("{}.bak", good.display())).unwrap(),
        original
    );
    assert_eq!(
        fs::read_to_string(bad.unwrap()).unwrap(),
        "{ broken custom config"
    );
    assert_eq!(
        fs::read_to_string(default_pi).unwrap(),
        "{ broken default Pi config"
    );
    assert_eq!(fs::read(runtime).unwrap(), b"needed for retry");
    assert!(f.binary.is_file() && f.data.join("config.json").is_file());
}

#[test]
fn cleanup_l660_l686_openclaw_no_foreign_control_removes_owned_entry_and_preserves_other_values() {
    let f = Fixture::new();
    let settings = f.root.path().join("OpenClaw home/openclaw.jsonc");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let mut def: Value =
        serde_json::from_str(include_str!("../../agents.d/openclaw.json")).unwrap();
    def["pluginInject"]["configPaths"] = json!([settings]);
    let text = def.to_string();
    f.package_with(&[("agents.d/openclaw.json", &text)]);
    let managed = f.data.join("plugins/openclaw");
    let url = reqwest::Url::from_file_path(&managed).unwrap().to_string();
    let original = format!(
        "// preserve OpenClaw backup\n{}\n",
        json!({
            "private":{"keep":true},
            "plugin":["loongsuite-pilot-openclaw","other-plugin"],
            "plugins":{"load":{"paths":[managed,format!("{url}/plugin.mjs"),"/third-party/other-plugin"]},
                "entries":{"loongsuite-pilot-openclaw":{"enabled":true},"other":{"enabled":false,"custom":19}},
                "allow":["loongsuite-pilot-openclaw","other"],"deny":["user-denied"]}
        })
    );
    fs::write(&settings, &original).unwrap();
    success(&cleanup(&f));
    let actual = document(&settings);
    assert_eq!(actual["private"], json!({"keep":true}));
    assert_eq!(actual["plugin"], json!(["other-plugin"]));
    assert_eq!(
        actual["plugins"]["load"]["paths"],
        json!(["/third-party/other-plugin"])
    );
    assert!(actual["plugins"]["entries"]
        .get("loongsuite-pilot-openclaw")
        .is_none());
    assert_eq!(
        actual["plugins"]["entries"]["other"],
        json!({"enabled":false,"custom":19})
    );
    // The historical helper preserves user allow/deny policy independently
    // of removing Pilot's managed load paths and generated entry.
    assert_eq!(
        actual["plugins"]["allow"],
        json!(["loongsuite-pilot-openclaw", "other"])
    );
    assert_eq!(actual["plugins"]["deny"], json!(["user-denied"]));
    assert_eq!(
        fs::read_to_string(format!("{}.bak", settings.display())).unwrap(),
        original
    );
}

#[test]
fn openclaw_legacy_array_keys_remove_only_current_install_and_declared_aliases() {
    for config_name in ["openclaw.json", "config.json"] {
        for key in ["plugin", "plugins"] {
            let f = Fixture::new();
            let settings = f.root.path().join(".openclaw").join(config_name);
            fs::create_dir_all(settings.parent().unwrap()).unwrap();
            f.package_with(&[(
                "agents.d/openclaw.json",
                include_str!("../../agents.d/openclaw.json"),
            )]);
            let managed = f.data.join("plugins/openclaw");
            let current_url = reqwest::Url::from_file_path(&managed).unwrap().to_string();
            let foreign = f
                .root
                .path()
                .join("foreign-install/plugins/openclaw/plugin.mjs");
            let foreign = foreign.to_string_lossy().into_owned();
            let mut config = json!({"private":{"keep":true}});
            config[key] = json!([
                managed,
                format!("{current_url}/plugin.mjs"),
                "loongsuite-pilot-openclaw",
                "loongsuite-pilot-openclaw-smoke@1.2.3",
                foreign,
                "/unrelated/legacy.mjs",
                "loongsuite-pilot-openclaw-other"
            ]);
            fs::write(&settings, config.to_string()).unwrap();
            success(&cleanup(&f));
            assert_eq!(
                document(&settings),
                json!({"private":{"keep":true},
            key:[foreign, "/unrelated/legacy.mjs", "loongsuite-pilot-openclaw-other"]})
            );
        }
    }
}

#[test]
fn openclaw_foreign_legacy_reference_keeps_shared_generated_entry_and_user_policy() {
    for foreign_package in [
        "openclaw",
        "loongsuite-pilot-openclaw",
        "loongsuite-pilot-openclaw-smoke",
        "OPENCLAW",
        "LOONGSUITE-PILOT-OPENCLAW",
        "LOONGSUITE-PILOT-OPENCLAW-SMOKE",
    ] {
        let f = Fixture::new();
        let settings = f.root.path().join(".openclaw/openclaw.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        f.package_with(&[(
            "agents.d/openclaw.json",
            include_str!("../../agents.d/openclaw.json"),
        )]);
        let managed = f.data.join("plugins/openclaw");
        let foreign = f.root.path().join(format!(
            "other-install/plugins/{foreign_package}/plugin.mjs"
        ));
        let foreign_url = reqwest::Url::from_file_path(&foreign).unwrap().to_string();
        let foreign_spec = json!([foreign_url, {"userOption":true}]);
        fs::write(
            &settings,
            json!({"plugin":[managed, foreign_spec],
        "plugins":{"load":{"paths":[managed]},
            "entries":{"loongsuite-pilot-openclaw":{"enabled":true}},
            "allow":["loongsuite-pilot-openclaw","other"],
            "deny":["user-denied"]}})
            .to_string(),
        )
        .unwrap();
        success(&cleanup(&f));
        let actual = document(&settings);
        assert_eq!(actual["plugin"], json!([foreign_spec]));
        assert_eq!(actual["plugins"]["load"]["paths"], json!([]));
        assert_eq!(
            actual["plugins"]["entries"]["loongsuite-pilot-openclaw"],
            json!({"enabled":true})
        );
        assert_eq!(
            actual["plugins"]["allow"],
            json!(["loongsuite-pilot-openclaw", "other"])
        );
        assert_eq!(actual["plugins"]["deny"], json!(["user-denied"]));
    }
}

#[cfg(unix)]
fn whole_shell(f: &Fixture, id: &str, seconds: u64) -> Output {
    use std::os::unix::fs::symlink;
    let bin = f.root.path().join("private-bin");
    fs::create_dir_all(&bin).unwrap();
    for name in [
        "uname", "id", "date", "mkdir", "cat", "dirname", "basename", "readlink", "grep", "sed",
        "awk", "find", "tr", "head", "tail", "cut", "wc", "stat", "chmod", "mv", "cp", "xargs",
        "which", "sleep", "getconf", "sort", "tee", "mktemp", "touch", "locale", "ls", "ln", "env",
        "df", "du", "bash", "sh",
    ] {
        let source = [
            Path::new("/usr/bin").join(name),
            Path::new("/bin").join(name),
        ]
        .into_iter()
        .find(|p| p.is_file());
        if let Some(source) = source {
            symlink(source, bin.join(name)).unwrap();
        }
    }
    let rm = r#"#!/bin/bash
args=()
files=0
for item in "$@"; do
    case "$item" in
        -*) args+=("$item") ;;
        "$HOME"/*) args+=("$item"); files=1 ;;
        /usr/local/bin/loongsuite-pilot|/usr/bin/loongsuite-pilot) ;;
        *) printf 'refused non-private deletion\n' >&2; exit 88 ;;
    esac
done
if test "$files" -eq 0; then exit 0; fi
exec /bin/rm "${args[@]}"
"#;
    fs::write(bin.join("rm"), rm).unwrap();
    fs::write(bin.join("loongsuite-pilot"),"#!/bin/bash\nif test \"$1\" != stop; then exit 88; fi\nprintf 'stopped' > \"$HOME/stop-marker\"\n").unwrap();
    fs::write(bin.join("ps"), "#!/bin/bash\nexit 0\n").unwrap();
    for name in ["rm", "loongsuite-pilot", "ps"] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let cache = f.root.path().join("cache");
    let installed = cache.join("versions/1.2.0_test");
    fs::create_dir_all(installed.parent().unwrap()).unwrap();
    fs::rename(&f.candidate, &installed).unwrap();
    fs::write(cache.join("current"), "1.2.0_test\n").unwrap();
    let foreign = f
        .root
        .path()
        .join(".loongsuite-pilot/versions/foreign-install");
    fs::create_dir_all(foreign.parent().unwrap()).unwrap();
    fs::write(&foreign, b"keep another install").unwrap();
    let mut command = f.command(Path::new("/bin/bash"));
    command
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/installer-opensource.sh"))
        .args(["uninstall", "--data-dir"])
        .arg(&f.data)
        .args(["--lang", "en"])
        .env("PATH", &bin);
    let result = bounded_for(command, Duration::from_secs(seconds));
    success(&result);
    assert!(!installed.exists(), "{id}: version assets not removed");
    assert_eq!(fs::read(foreign).unwrap(), b"keep another install");
    assert!(
        f.root.path().join("stop-marker").is_file(),
        "{id}: actual public stop branch skipped"
    );
    result
}

#[cfg(unix)]
fn public_shell_case(id: &str, seconds: u64) {
    let f = Fixture::new();
    let source = match id {
        "opencode" => include_str!("../../agents.d/opencode.json"),
        "pi-coding-agent" => include_str!("../../agents.d/pi-coding-agent.json"),
        _ => include_str!("../../agents.d/grok-build.json"),
    };
    f.package_with(&[(&format!("agents.d/{id}.json"), source)]);
    let settings = if id == "opencode" {
        f.root.path().join(".config/opencode/opencode.json")
    } else {
        f.root.path().join("persisted separate home/settings.json")
    };
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let expected = if id == "opencode" {
        fs::write(
            &settings,
            json!({"plugin":[f.data.join("plugins/opencode"),"/third-party/plugins/opencode"]})
                .to_string(),
        )
        .unwrap();
        json!({"plugin":["/third-party/plugins/opencode"]})
    } else if id == "pi-coding-agent" {
        fs::write(&settings,json!({"extensions":[f.data.join("plugins/pi-coding-agent/index.mjs"),"/third-party.mjs"]}).to_string()).unwrap();
        fs::write(f.data.join("deployed-agents.json"),json!({id:{"deployMode":"plugin-inject","deployedAt":"old","pluginInjectConfigPath":settings}}).to_string()).unwrap();
        json!({"extensions":["/third-party.mjs"]})
    } else {
        let (_, owned) = hook(&f, id);
        let owned = format!("{owned} stop");
        fs::write(&settings,json!({"hooks":{"stop":[{"command":owned},{"command":"user-direct"},{"matcher":"","hooks":[{"command":owned},{"command":"user-nested"}]}]}}).to_string()).unwrap();
        fs::write(
            f.data.join("deployed-agents.json"),
            json!({id:{"deployMode":"hook","deployedAt":"old","hookSettingsPath":settings}})
                .to_string(),
        )
        .unwrap();
        json!({"hooks":{"stop":[{"command":"user-direct"},{"matcher":"","hooks":[{"command":"user-nested"}]}]}})
    };
    let _output = whole_shell(&f, id, seconds);
    assert_eq!(document(&settings), expected);
}
#[cfg(unix)]
#[test]
fn cleanup_l241_whole_public_shell_uninstall_uses_custom_data_and_preserves_foreign_opencode() {
    public_shell_case("opencode", 15);
}
#[cfg(unix)]
#[test]
fn cleanup_l382_whole_public_shell_uninstall_uses_recorded_pi_home_without_environment_override() {
    public_shell_case("pi-coding-agent", 20);
}
#[cfg(unix)]
#[test]
fn cleanup_l825_l892_whole_public_shell_uninstall_cleans_direct_nested_grok_in_recorded_home() {
    public_shell_case("grok-build", 20);
}
