//! Exact uninstall assertions still active after the Native migration.
//! Real private CLI/file boundaries; no installed services or external Agent are touched.
use super::*;
#[cfg(unix)]
use loongsuite_pilot::deployment::DirectoryPluginStrategy;
#[cfg(unix)]
use loongsuite_pilot::types::AgentDefinition;

fn cleanup_extra(fixture: &Fixture, vars: &[(&str, &Path)]) -> Output {
    let mut command = fixture.command(&fixture.binary);
    command
        .args(["installer-helper", "cleanup-agents", "--input-env"])
        .env(
            "LOONGSUITE_PILOT_INSTALL_INPUT",
            json!({"dataDir":fixture.data,"pilotDir":fixture.candidate}).to_string(),
        );
    for (name, value) in vars {
        command.env(name, value);
    }
    // Retain the existing 5s Native CLI boundary; never spend service timeouts.
    bounded_for(command, Duration::from_secs(5))
}

#[cfg(unix)]
fn quote_shell_extra(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_l753_l766_shipped_hermes_disable_runs_before_recorded_target_removal_and_refuses_foreign_markers(
) {
    use std::os::unix::fs::PermissionsExt;
    let shipped: Value =
        serde_json::from_str(include_str!("../../agents.d/hermes-agent.json")).unwrap();
    assert_eq!(
        shipped["directoryPlugin"]["activation"]["disableArgs"],
        json!(["plugins", "disable", "loongsuite-pilot"])
    );
    for mode in ["owned", "wrong-owner", "wrong-agent", "refuse-disable"] {
        let hermes_scenario_started = Instant::now();
        let f = Fixture::new();
        let recorded_home = f.root.path().join("recorded Hermes O'Brien 🚀");
        let recorded = recorded_home.join("plugins/loongsuite-pilot");
        let active_home = f.root.path().join("currently configured Hermes");
        let fallback = active_home.join("plugins/loongsuite-pilot");
        let source_relative = "assets/plugins/hermes-agent/loongsuite-pilot/__init__.py";
        f.package_with(&[
            (
                "agents.d/hermes-agent.json",
                include_str!("../../agents.d/hermes-agent.json"),
            ),
            (
                source_relative,
                include_str!("../../assets/plugins/hermes-agent/loongsuite-pilot/__init__.py"),
            ),
        ]);
        let source = f.candidate.join(source_relative);
        let log = f.root.path().join("hermes-cli-argv-and-presence");
        let refuse = f.root.path().join("refuse-hermes-disable");
        let hermes = f.root.path().join("private Hermes executable");
        let script = format!(
            r#"#!/bin/bash
set -euo pipefail
if test "$#" -eq 3 && test "$1" = plugins && test "$2" = enable && test "$3" = --help; then
    printf '%s\n' --no-allow-tool-override
    exit 0
fi
if test "$#" -ge 3 && test "$1" = plugins && test "$2" = enable && test "$3" = loongsuite-pilot; then
    exit 0
fi
if test "$#" -eq 3 && test "$1" = plugins && test "$2" = disable && test "$3" = loongsuite-pilot; then
    printf '%s\n' "$@" > {log}
    test -f {plugin} || exit 91
    printf 'target-present\n' >> {log}
    test -f {marker} || exit 92
    printf 'marker-present\n' >> {log}
    test -f {source} || exit 93
    printf 'source-present\n' >> {log}
    if test -f {refuse}; then exit 23; fi
    exit 0
fi
printf 'unexpected private Hermes command\n' >&2
exit 94
"#,
            log = quote_shell_extra(&log),
            plugin = quote_shell_extra(&recorded.join("__init__.py")),
            marker = quote_shell_extra(&recorded.join(".loongsuite-pilot-managed.json")),
            source = quote_shell_extra(&source),
            refuse = quote_shell_extra(&refuse),
        );
        fs::write(&hermes, script).unwrap();
        fs::set_permissions(&hermes, fs::Permissions::from_mode(0o755)).unwrap();

        let strategy = DirectoryPluginStrategy::new(Some(f.data.to_string_lossy().into_owned()));
        for target in [&recorded, &fallback] {
            let mut resolved = shipped.clone();
            resolved["directoryPlugin"]["sourceDir"] = json!(source.parent().unwrap());
            resolved["directoryPlugin"]["targetDir"] = json!(target);
            resolved["directoryPlugin"]["activation"]["command"] = json!(hermes);
            let definition: AgentDefinition = serde_json::from_value(resolved).unwrap();
            let deployed = tokio::time::timeout(
                Duration::from_secs(5),
                strategy.deploy_directory(&definition),
            )
            .await
            .unwrap();
            assert!(deployed.success, "{mode}: {:?}", deployed.error);
            let value: Value = serde_json::from_slice(
                &fs::read(target.join(".loongsuite-pilot-managed.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(value["activationStatus"], "activated");
            assert_eq!(value["owner"], "loongsuite-pilot");
            assert_eq!(value["agentId"], "hermes-agent");
        }
        let marker = recorded.join(".loongsuite-pilot-managed.json");
        if mode == "wrong-owner" || mode == "wrong-agent" {
            let mut value: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
            value[if mode == "wrong-owner" {
                "owner"
            } else {
                "agentId"
            }] = json!("foreign");
            fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        if mode == "refuse-disable" {
            fs::write(&refuse, "refuse").unwrap();
        }
        let state = json!({
            "hermes-agent":{
                "deployMode":"directory-plugin",
                "deployedAt":"2026-11-03T00:00:00.000Z",
                "targetDir":recorded
            }
        })
        .to_string();
        fs::write(f.data.join("deployed-agents.json"), &state).unwrap();
        let recorded_marker = fs::read(&marker).unwrap();
        let recorded_plugin = fs::read(recorded.join("__init__.py")).unwrap();
        let fallback_marker = fs::read(fallback.join(".loongsuite-pilot-managed.json")).unwrap();
        let fallback_plugin = fs::read(fallback.join("__init__.py")).unwrap();
        let source_before = fs::read(&source).unwrap();
        let output = cleanup_extra(
            &f,
            &[("HERMES_HOME", &active_home), ("HERMES_CLI", &hermes)],
        );
        assert_eq!(
            output.status.success(),
            mode == "owned",
            "{mode}: {output:?}"
        );
        if mode == "owned" {
            assert!(!recorded.exists(), "recorded custom target was not removed");
            let current: Value =
                serde_json::from_slice(&fs::read(f.data.join("deployed-agents.json")).unwrap())
                    .unwrap();
            assert!(current.get("hermes-agent").is_none());
        } else {
            assert_eq!(fs::read(&marker).unwrap(), recorded_marker, "{mode}");
            assert_eq!(
                fs::read(recorded.join("__init__.py")).unwrap(),
                recorded_plugin,
                "{mode}"
            );
            assert_eq!(
                fs::read_to_string(f.data.join("deployed-agents.json")).unwrap(),
                state,
                "{mode}"
            );
            assert!(f.binary.is_file(), "{mode}: retry runtime disappeared");
        }
        if mode == "owned" || mode == "refuse-disable" {
            assert_eq!(
                fs::read_to_string(&log).unwrap(),
                "plugins\ndisable\nloongsuite-pilot\ntarget-present\nmarker-present\nsource-present\n",
                "{mode}: shipped argv and pre-delete boundary",
            );
        } else {
            assert!(!log.exists(), "{mode}: foreign marker reached Hermes CLI");
        }
        assert_eq!(
            fs::read(fallback.join(".loongsuite-pilot-managed.json")).unwrap(),
            fallback_marker,
            "{mode}: current-env fallback marker changed"
        );
        assert_eq!(
            fs::read(fallback.join("__init__.py")).unwrap(),
            fallback_plugin,
            "{mode}: current-env fallback plugin changed"
        );
        assert_eq!(
            fs::read(&source).unwrap(),
            source_before,
            "{mode}: shipped asset changed"
        );

        assert!(
            hermes_scenario_started.elapsed() <= Duration::from_secs(15),
            "original source scenario15s budget exceeded"
        );
    }
}

#[cfg(unix)]
#[test]
fn cleanup_l561_legacy_codex_sh_and_mjs_mixed_handlers_keep_foreign_groups_and_all_otel_assets() {
    for extension in ["sh", "mjs"] {
        let codex_source_case_started = Instant::now();
        for valid_toml in [true, false] {
            let codex_scenario_started = Instant::now();
            let mut f = Fixture::new();
            // Exact historical layout/command shape; path quoting is tested separately.
            f.data = f.root.path().join(".loongsuite-pilot");
            f.package_with(&[(
                "agents.d/codex.json",
                include_str!("../../agents.d/codex.json"),
            )]);
            let codex = f.root.path().join(".codex");
            let cache = f
                .root
                .path()
                .join(".cache/opentelemetry.instrumentation.codex");
            fs::create_dir_all(cache.join("sessions")).unwrap();
            fs::create_dir_all(&codex).unwrap();
            let hook = f
                .data
                .join(format!("hooks/codex-loongsuite-pilot-hook.{extension}"));
            fs::create_dir_all(hook.parent().unwrap()).unwrap();
            fs::write(&hook, b"retained legacy Pilot asset").unwrap();
            let own = json!({"type":"command","command":format!("bash {} stop",hook.display())});
            let tracked = json!({"type":"command","command":"otel-codex-hook stop","timeout":17});
            let cached = json!({"type":"command","command":format!("bash {} stop",quote_shell_extra(&cache.join("hook-entry.sh")))});
            let unrelated = json!({"type":"command","command":quote_shell_extra(&f.data.join("third-party.sh"))});
            let config = codex.join("hooks.json");
            let original = json!({
                "extra":"keep",
                "hooks":{
                    "Stop":[{"matcher":"*","hooks":[tracked,cached,unrelated,own]},own,null,{"hooks":[]}],
                    "SessionStart":[{"hooks":[own]}]
                }
            }).to_string();
            fs::write(&config, &original).unwrap();
            let protected = [
                cache.join("sessions/trace.jsonl"),
                codex.join("config.toml"),
                codex.join("otel-config.json"),
            ];
            for file in &protected {
                fs::write(file, b"agenttrack-original").unwrap();
            }
            if valid_toml {
                fs::write(
                    &protected[1],
                    b"# external OTel trust bytes\n[external]\nowner = 'agenttrack-original'\n",
                )
                .unwrap();
            }
            let before: Vec<_> = protected.iter().map(|p| fs::read(p).unwrap()).collect();
            let expected = json!({
                "extra":"keep",
                "hooks":{"Stop":[{"matcher":"*","hooks":[tracked,cached,unrelated]},null,{"hooks":[]}]}
            });
            for _ in 0..2 {
                let output = cleanup_extra(&f, &[]);
                if valid_toml {
                    success(&output);
                    let actual: Value =
                        serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
                    assert_eq!(actual, expected, "{extension}");
                } else {
                    assert_eq!(
                        output.status.code(),
                        Some(1),
                        "{extension}: invalid foreign TOML must fail closed"
                    );
                    assert_eq!(
                        fs::read_to_string(&config).unwrap(),
                        original,
                        "{extension}"
                    );
                    assert!(
                        f.binary.is_file(),
                        "invalid trust must preserve retry runtime"
                    );
                }
                for (file, bytes) in protected.iter().zip(&before) {
                    assert_eq!(fs::read(file).unwrap(), *bytes, "{extension} {file:?}");
                }
                assert_eq!(fs::read(&hook).unwrap(), b"retained legacy Pilot asset");
            }

            assert!(
                codex_scenario_started.elapsed() <= Duration::from_secs(15),
                "original source scenario15s budget exceeded"
            );
        }

        assert!(
            codex_source_case_started.elapsed() <= Duration::from_secs(15),
            "original source scenario15s budget exceeded"
        );
    }
}

#[test]
fn cleanup_l594_l601_native_legacy_cleanup_is_claude_only_and_preserves_raw_codex_assets() {
    let legacy_source_case_started = Instant::now();
    let f = Fixture::new();
    f.package();
    let claude = f.root.path().join(".claude");
    let codex = f.root.path().join(".codex");
    let claude_cache = f
        .root
        .path()
        .join(".cache/opentelemetry.instrumentation.claude");
    let codex_cache = f
        .root
        .path()
        .join(".cache/opentelemetry.instrumentation.codex");
    fs::create_dir_all(&claude).unwrap();
    fs::create_dir_all(&codex).unwrap();
    fs::create_dir_all(claude_cache.join("sessions")).unwrap();
    fs::create_dir_all(codex_cache.join("sessions")).unwrap();
    fs::write(claude_cache.join("intercept.js"), b"legacy preload").unwrap();
    fs::write(
        claude_cache.join("sessions/keep.jsonl"),
        b"keep Claude history",
    )
    .unwrap();
    fs::write(
        claude.join("settings.json"),
        json!({"private":"keep","hooks":{"Stop":[{"command":"otel-claude-hook stop"},{"command":"user-hook"}]}}).to_string(),
    ).unwrap();
    fs::write(
        claude.join("otel-config.json"),
        r#"{"log_enabled":true,"user":17}"#,
    )
    .unwrap();
    let preserved = [
        codex_cache.join("sessions/trace.jsonl"),
        codex_cache.join("hook-entry.sh"),
        codex.join("config.toml"),
        codex.join("otel-config.json"),
        codex.join("hooks.json"),
    ];
    for file in &preserved {
        // Preserve the old opaque sentinel even when it is invalid as TOML/JSON:
        // the legacy Claude-only stage has no authority to inspect Codex files.
        fs::write(file, b"agenttrack-original").unwrap();
    }
    for _ in 0..2 {
        success(&cleanup_extra(&f, &[]));
        for file in &preserved {
            assert_eq!(fs::read(file).unwrap(), b"agenttrack-original", "{file:?}");
        }
        let settings: Value =
            serde_json::from_slice(&fs::read(claude.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["private"], "keep");
        assert_eq!(settings["hooks"]["Stop"], json!([{"command":"user-hook"}]));
        let otel: Value =
            serde_json::from_slice(&fs::read(claude.join("otel-config.json")).unwrap()).unwrap();
        assert_eq!(otel, json!({"user":17}));
        assert!(!claude_cache.join("intercept.js").exists());
        assert_eq!(
            fs::read(claude_cache.join("sessions/keep.jsonl")).unwrap(),
            b"keep Claude history"
        );
        assert!(f.binary.is_file());
    }

    assert!(
        legacy_source_case_started.elapsed() <= Duration::from_secs(15),
        "original source scenario15s budget exceeded"
    );
}

#[cfg(unix)]
#[test]
fn legacy_codex_cleanup_keeps_foreign_same_names_and_refuses_unrecognized_shell_or_arguments() {
    for extension in ["sh", "mjs"] {
        for mode in ["foreign", "extra-arg", "shell-wrapper"] {
            let negative_scenario_started = Instant::now();
            let mut f = Fixture::new();
            f.data = f.root.path().join(".loongsuite-pilot");
            f.package_with(&[(
                "agents.d/codex.json",
                include_str!("../../agents.d/codex.json"),
            )]);
            let codex = f.root.path().join(".codex");
            fs::create_dir_all(&codex).unwrap();
            let own = f
                .data
                .join(format!("hooks/codex-loongsuite-pilot-hook.{extension}"));
            let foreign = f.root.path().join(format!(
                "another install/hooks/codex-loongsuite-pilot-hook.{extension}"
            ));
            let command = match mode {
                "foreign" => format!("bash {} stop", quote_shell_extra(&foreign)),
                "extra-arg" => format!("bash {} stop --unknown-argument", own.display()),
                _ => format!("sh -c 'bash {} stop'", own.display()),
            };
            let config = codex.join("hooks.json");
            let original =
                json!({"private":"keep","hooks":{"Stop":[{"command":command}]}}).to_string();
            fs::write(&config, &original).unwrap();
            fs::write(
                codex.join("config.toml"),
                "# foreign trust bytes\n[external]\nkeep = true\n",
            )
            .unwrap();
            let before = fs::read(codex.join("config.toml")).unwrap();
            let output = cleanup_extra(&f, &[]);
            assert_eq!(
                output.status.success(),
                mode == "foreign",
                "{extension} {mode}: {output:?}"
            );
            assert_eq!(fs::read_to_string(&config).unwrap(), original, "{mode}");
            assert_eq!(
                fs::read(codex.join("config.toml")).unwrap(),
                before,
                "{mode}"
            );
            assert!(f.binary.is_file(), "{mode}: retry runtime removed");

            assert!(
                negative_scenario_started.elapsed() <= Duration::from_secs(15),
                "original source scenario15s budget exceeded"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn legacy_codex_known_current_install_quotes_do_not_authorize_foreign_same_names() {
    for extension in ["sh", "mjs"] {
        for spelling in ["double", "canonical", "posix-single"] {
            let scenario_started = Instant::now();
            let f = Fixture::new();
            f.package_with(&[(
                "agents.d/codex.json",
                include_str!("../../agents.d/codex.json"),
            )]);
            let codex = f.root.path().join(".codex");
            fs::create_dir_all(&codex).unwrap();
            let own = f
                .data
                .join(format!("hooks/codex-loongsuite-pilot-hook.{extension}"));
            let quoted = match spelling {
                "double" => format!("\"{}\"", own.display()),
                "canonical" => {
                    loongsuite_pilot::hooks::quote_claude_hook_path(&own.to_string_lossy())
                }
                _ => quote_shell_extra(&own),
            };
            let foreign = f.root.path().join(format!(
                "other install/hooks/codex-loongsuite-pilot-hook.{extension}"
            ));
            let foreign_command = format!("bash {} stop", quote_shell_extra(&foreign));
            let config = codex.join("hooks.json");
            fs::write(&config,json!({"private":"keep","hooks":{"Stop":[{"matcher":"*","hooks":[{"command":format!("bash {quoted} stop")},{"command":foreign_command}]}]}}).to_string()).unwrap();
            let trust = b"# foreign settings remain exact\n[external]\nkeep = true\n";
            fs::write(codex.join("config.toml"), trust).unwrap();
            success(&cleanup_extra(&f, &[]));
            let actual: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
            assert_eq!(
                actual,
                json!({"private":"keep","hooks":{"Stop":[{"matcher":"*","hooks":[{"command":foreign_command}]}]}}),
                "{extension} {spelling}"
            );
            assert_eq!(fs::read(codex.join("config.toml")).unwrap(), trust);
            assert!(
                scenario_started.elapsed() <= Duration::from_secs(15),
                "{extension} {spelling}: original scenario budget exceeded"
            );
        }
    }
}
