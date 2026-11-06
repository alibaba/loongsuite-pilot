use super::*;
use loongsuite_pilot::deployment::{resolve_openclaw_host, OpenClawResolveMode};
use std::collections::HashMap;
#[derive(Debug)]
enum Writer {
    #[cfg(unix)]
    Bash,
    #[cfg(windows)]
    PowerShell { shell: PathBuf, constrained: bool },
}
fn writers() -> Vec<Writer> {
    #[cfg(unix)]
    {
        vec![Writer::Bash]
    }
    #[cfg(windows)]
    {
        windows_shells()
            .into_iter()
            .flat_map(|shell| {
                [false, true].map(|constrained| Writer::PowerShell {
                    shell: shell.clone(),
                    constrained,
                })
            })
            .collect()
    }
}
fn package(f: &Fixture) {
    let mut def: Value =
        serde_json::from_str(include_str!("../../agents.d/openclaw.json")).unwrap();
    def["pluginInject"]["configPaths"] = json!([f.root.path().join("gateway.json")]);
    let def = def.to_string();
    f.package_with(&[
        ("agents.d/openclaw.json", &def),
        (
            "agents.d/codex.json",
            include_str!("../../agents.d/codex.json"),
        ),
        (
            "assets/plugins/openclaw/plugin.mjs",
            include_str!("../../assets/plugins/openclaw/plugin.mjs"),
        ),
        (
            "assets/plugins/openclaw/package.json",
            include_str!("../../assets/plugins/openclaw/package.json"),
        ),
        (
            "assets/plugins/openclaw/openclaw.plugin.json",
            include_str!("../../assets/plugins/openclaw/openclaw.plugin.json"),
        ),
        (
            "assets/plugins/openclaw/compatibility.mjs",
            include_str!("../../assets/plugins/openclaw/compatibility.mjs"),
        ),
        (
            "assets/plugins/openclaw/compatibility.d.mts",
            include_str!("../../assets/plugins/openclaw/compatibility.d.mts"),
        ),
        (
            "assets/plugins/openclaw/runtime-version.mjs",
            include_str!("../../assets/plugins/openclaw/runtime-version.mjs"),
        ),
        (
            "assets/plugins/openclaw/legacy-adapter.mjs",
            include_str!("../../assets/plugins/openclaw/legacy-adapter.mjs"),
        ),
        (
            "assets/plugins/openclaw/legacy-utils.mjs",
            include_str!("../../assets/plugins/openclaw/legacy-utils.mjs"),
        ),
        (
            "assets/plugins/openclaw/subagent-context.mjs",
            include_str!("../../assets/plugins/openclaw/subagent-context.mjs"),
        ),
        (
            "assets/plugins/openclaw/interceptor.mjs",
            include_str!("../../assets/plugins/openclaw/interceptor.mjs"),
        ),
        (
            "assets/plugins/openclaw/first-token.mjs",
            include_str!("../../assets/plugins/openclaw/first-token.mjs"),
        ),
        (
            "assets/plugins/shared/resource-context.mjs",
            include_str!("../../assets/plugins/shared/resource-context.mjs"),
        ),
    ]);
}
fn app(f: &Fixture, version: &str, child: bool) -> (PathBuf, PathBuf) {
    let parent = f.root.path().join("OpenClaw 应用 O'Brien 🚀");
    let app = if child {
        parent.join("openclaw")
    } else {
        parent.clone()
    };
    fs::create_dir_all(&app).unwrap();
    let entry = app.join("openclaw.mjs");
    fs::write(
        &entry,
        "/* private discovery fixture: never execute this entry */",
    )
    .unwrap();
    fs::write(
        app.join("package.json"),
        json!({"name":"openclaw","version":version}).to_string(),
    )
    .unwrap();
    if child {
        fs::write(parent.join("package.json"), "{").unwrap();
    }
    (parent, entry)
}
fn probes(detected: bool, entry: Option<&str>) -> Value {
    let mut openclaw = json!({"id":"openclaw","detected":detected});
    if let Some(entry) = entry {
        openclaw["openclawCliPath"] = json!(entry);
    }
    json!([openclaw,{"id":"codex","detected":true}])
}
fn store(f: &Fixture, value: Value) {
    fs::write(f.data.join("config.json"), value.to_string()).unwrap();
}
fn resolve(
    f: &Fixture,
    cwd: &Path,
    mode: OpenClawResolveMode,
) -> Option<loongsuite_pilot::deployment::OpenClawHost> {
    let env = HashMap::from([
        ("HOME".into(), f.root.path().to_string_lossy().into_owned()),
        (
            "USERPROFILE".into(),
            f.root.path().to_string_lossy().into_owned(),
        ),
        ("PATH".into(), String::new()),
        (
            "AGENT_DATA_COLLECTION_CONFIG".into(),
            f.data.join("config.json").to_string_lossy().into_owned(),
        ),
    ]);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(resolve_openclaw_host(
            &env,
            &cwd.to_string_lossy(),
            None::<fn(String)>,
            mode,
        ))
}
struct WriterResult {
    probe: Value,
    stdout: String,
}
fn write(
    f: &Fixture,
    writer: &Writer,
    cwd: &Path,
    probe: Option<Value>,
    selected: &str,
    explicit: bool,
    all: bool,
) -> WriterResult {
    let output_path = f.root.path().join("actual-probe-result.json");
    let is_probe = probe.is_none();
    let probe = probe.unwrap_or_else(|| json!([])).to_string();
    let mut command = match writer {
        #[cfg(unix)]
        Writer::Bash => {
            let source = include_str!("../../deploy/installer-opensource.sh");
            let mut script = "set -euo pipefail\n".to_owned();
            for name in [
                "native_installer_helper",
                "installer_config_operation",
                "probe_agents",
                "write_config",
            ] {
                script.push_str(&function(source, &format!("{name}() {{")));
            }
            script.push_str(r#"
msg() { :; }
for name in SLS_ENDPOINT SLS_PROJECT SLS_LOGSTORE SLS_AK_ID SLS_AK_SECRET SLS_API_KEY LOG_LEVEL USER_ID COLLECT_LOG COLLECT_TRACE CMS_LICENSE_KEY CMS_ENDPOINT CMS_WORKSPACE SERVICE_NAME_PREFIX SELECTED_AGENTS ALL_AGENTS AGENT_SELECTION_EXPLICIT MULTIMODAL_MODE MULTIMODAL_SUPPORTED_AGENTS DASHBOARD_PORT ENABLE_STATUS_BAR_APP MASK_MODE MASK_TYPES MASK_REPLACEMENT_MODE INTERCEPTOR_MODE INTERCEPTOR_TYPES; do
    printf -v "$name" '%s' ''
done
EXCLUDE_WORKSPACES=()
INSTALL_SRC="$TEST_CANDIDATE"
DATA_DIR="$TEST_DATA"
SELECTED_AGENTS="$TEST_SELECTED"
ALL_AGENTS="$TEST_ALL"
AGENT_SELECTION_EXPLICIT="$TEST_EXPLICIT"
PROBE_RESULT="$TEST_PROBE"
if [ "$TEST_REAL_PROBE" = 1 ]; then probe_agents; fi
printf '%s' "$PROBE_RESULT" > "$TEST_PROBE_RESULT"
write_config
"#);
            let path = f.root.path().join("actual-openclaw-writer.sh");
            fs::write(&path, script).unwrap();
            let mut command = f.command(Path::new("/bin/bash"));
            command.arg(path);
            command
        }
        #[cfg(windows)]
        Writer::PowerShell { shell, constrained } => {
            let mut script = windows_script(
                *constrained,
                &[
                    "Invoke-InstallerHelper",
                    "Get-InstallConfigJson",
                    "Probe-Agents",
                    "Write-Config",
                ],
            );
            script.push_str(
                r#"
function Msg { param($Chinese,$English) }
$script:INSTALL_SRC=$env:TEST_CANDIDATE
$DataDir=$env:TEST_DATA
$script:SELECTED_AGENTS=$env:TEST_SELECTED
$script:AGENT_SELECTION_EXPLICIT=$env:TEST_EXPLICIT
$AllAgents=($env:TEST_ALL -eq '1')
$script:PROBE_RESULT=$env:TEST_PROBE
$ExcludeWorkspace=@()
"#,
            );
            // Use both real public initializers: FullLanguage sets UTF8;
            // CLM preserves the actual try/catch boundary. Test-only encoding
            // changes would hide a production difference.
            for prefix in [
                "try { [Console]::OutputEncoding",
                "$env:AGENT_DATA_COLLECTION_CONFIG = Join-Path $DataDir",
            ] {
                let initializer = include_str!("../../deploy/installer-opensource.ps1")
                    .lines()
                    .find(|line| line.trim_start().starts_with(prefix))
                    .expect("public installer initializer must exist");
                script.push_str(initializer);
                script.push('\n');
            }
            script.push_str(r#"
if ($env:TEST_REAL_PROBE -eq '1') { Probe-Agents }
Set-Content -LiteralPath $env:TEST_PROBE_RESULT -Value $script:PROBE_RESULT -Encoding UTF8
Write-Config
if ($env:LOONGSUITE_PILOT_INSTALL_INPUT -ne 'prior-input 研发') {throw 'writer leaked helper input environment'}
"#);
            windows_command(f, shell, &script)
        }
    };
    command
        .current_dir(cwd)
        .env("TEST_CANDIDATE", &f.candidate)
        .env("TEST_DATA", &f.data)
        .env("TEST_SELECTED", selected)
        .env("TEST_ALL", if all { "1" } else { "" })
        .env("TEST_EXPLICIT", if explicit { "1" } else { "0" })
        .env("TEST_PROBE", probe)
        .env("TEST_REAL_PROBE", if is_probe { "1" } else { "0" })
        .env("TEST_PROBE_RESULT", &output_path)
        .env("LOONGSUITE_PILOT_INSTALL_INPUT", "prior-input 研发")
        .env("TEMP", f.root.path())
        .env("TMP", f.root.path());
    let out = bounded_for(command, Duration::from_secs(30));
    success(&out);
    WriterResult {
        probe: serde_json::from_str(
            fs::read_to_string(output_path)
                .unwrap()
                .trim_start_matches('\u{feff}'),
        )
        .unwrap(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
    }
}
fn detected_probe(result: &WriterResult) -> &Value {
    result
        .probe
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "openclaw")
        .unwrap()
}
fn assert_entry(actual: &Value, entry: &Path) {
    let raw = actual
        .as_str()
        .expect("private probe entry must be a JSON string");
    let found=fs::canonicalize(raw).unwrap_or_else(|error| {
        let points=raw.chars().take(256).map(|ch|format!("U+{:04X}",u32::from(ch))).collect::<Vec<_>>().join(" ");
        panic!("private OpenClaw fixture path cannot resolve: actual={raw:?} expected={entry:?} codepoints={points}; {error}")
    });
    assert_eq!(
        found,
        fs::canonicalize(entry).unwrap(),
        "private OpenClaw fixture bound the wrong entry"
    );
}

fn fresh_deployment(f: &Fixture, expect_healthy: bool) -> Value {
    let output = f.root.path().join("fresh-service-result.json");
    let mut command = f.command(&std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "installer_openclaw_entry_history::fresh_service_child",
            "--nocapture",
        ])
        .env("PILOT_OPENCLAW_SERVICE_CHILD", "private-native-history")
        .env("PILOT_OPENCLAW_OUTPUT", &output)
        .env("PILOT_OPENCLAW_PACKAGE", &f.candidate)
        .env(
            "PILOT_EXPECT_HEALTHY",
            if expect_healthy { "1" } else { "0" },
        )
        .env("AGENT_DATA_COLLECTION_CONFIG", f.data.join("config.json"));
    success(&bounded_for(command, Duration::from_secs(20)));
    serde_json::from_slice(&fs::read(output).unwrap()).unwrap()
}
#[test]
fn fresh_service_child() {
    if std::env::var("PILOT_OPENCLAW_SERVICE_CHILD").as_deref() != Ok("private-native-history") {
        return;
    }
    let data = PathBuf::from(std::env::var_os("LOONGSUITE_PILOT_DATA_DIR").unwrap());
    let package = PathBuf::from(std::env::var_os("PILOT_OPENCLAW_PACKAGE").unwrap());
    let output = PathBuf::from(std::env::var_os("PILOT_OPENCLAW_OUTPUT").unwrap());
    let config = PathBuf::from(std::env::var_os("AGENT_DATA_COLLECTION_CONFIG").unwrap());
    assert_eq!(config, data.join("config.json"));
    assert!(!std::env::var_os("PATH")
        .unwrap()
        .to_string_lossy()
        .contains("node"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let env = std::env::vars().collect::<HashMap<_, _>>();
        let host = resolve_openclaw_host(
            &env,
            &std::env::current_dir().unwrap().to_string_lossy(),
            None::<fn(String)>,
            OpenClawResolveMode::Runtime,
        )
        .await
        .unwrap();
        assert_eq!(host.binding.as_deref(), Some("persisted-entry"));
        let def: loongsuite_pilot::types::AgentDefinition =
            serde_json::from_slice(&fs::read(package.join("agents.d/openclaw.json")).unwrap())
                .unwrap();
        let mut strategy = loongsuite_pilot::deployment::PluginInjectStrategy::new(
            data.to_string_lossy().into_owned(),
            package.to_string_lossy().into_owned(),
        );
        let needed = strategy.needs_deploy_with(&def, None).await;
        assert_eq!(
            needed,
            std::env::var("PILOT_EXPECT_HEALTHY").unwrap() != "1"
        );
        let result = strategy.deploy_with(&def).await;
        assert!(result.success, "native injection failed: {result:?}");
        fs::write(
            output,
            json!({"version":host.version,"binding":host.binding,"entry":host.executable,
            "conversationAccess":host.conversation_access,"needed":needed})
            .to_string(),
        )
        .unwrap();
    });
}
#[test]
fn auto_discovery_writer_fresh_native_service_and_idempotent_injection_for_both_host_generations() {
    for writer in writers() {
        for version in ["2026.3.8", "2026.6.10"] {
            let f = Fixture::new();
            package(&f);
            let (cwd, entry) = app(&f, version, false);
            let discovered = resolve(&f, &cwd, OpenClawResolveMode::Runtime).unwrap();
            assert_eq!(discovered.binding.as_deref(), Some("auto-entry"));
            let written = write(&f, &writer, &cwd, None, "openclaw,codex", false, false);
            assert_eq!(detected_probe(&written)["detected"], true);
            assert_entry(&detected_probe(&written)["openclawCliPath"], &entry);
            assert_eq!(f.config()["agents"]["openclaw"]["enabled"], true);
            assert_entry(&f.config()["agents"]["openclaw"]["cliPath"], &entry);
            let first = fresh_deployment(&f, false);
            assert_eq!(first["version"], version);
            assert_entry(&first["entry"], &entry);
            let gateway = f.root.path().join("gateway.json");
            let bytes = fs::read(&gateway).unwrap();
            let modified = fs::metadata(&gateway).unwrap().modified().unwrap();
            let got: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                got["plugins"]["entries"]["loongsuite-pilot-openclaw"]["hooks"]
                    ["allowConversationAccess"],
                if version == "2026.3.8" {
                    Value::Null
                } else {
                    json!(true)
                }
            );
            write(&f, &writer, &cwd, None, "openclaw,codex", false, false);
            fresh_deployment(&f, true);
            assert_eq!(fs::read(&gateway).unwrap(), bytes);
            assert_eq!(fs::metadata(gateway).unwrap().modified().unwrap(), modified);
        }
    }
}
#[test]
fn automatic_miss_preserves_each_previous_enabled_shape_and_entry() {
    for writer in writers() {
        for enabled in [Some(true), Some(false), None] {
            let f = Fixture::new();
            package(&f);
            let mut previous =
                json!({"cliPath":"/missing/openclaw.mjs","captureMessageContent":false});
            if let Some(value) = enabled {
                previous["enabled"] = json!(value);
            }
            store(&f, json!({"agents":{"openclaw":previous}}));
            write(
                &f,
                &writer,
                f.root.path(),
                Some(probes(false, None)),
                "codex",
                false,
                false,
            );
            assert_eq!(f.config()["agents"]["openclaw"], previous);
            assert_eq!(f.config()["agents"]["codex"]["enabled"], true);
        }
    }
}
#[test]
fn explicit_selection_still_disables_an_existing_openclaw() {
    for writer in writers() {
        let f = Fixture::new();
        package(&f);
        store(&f, json!({"agents":{"openclaw":{"enabled":true}}}));
        write(
            &f,
            &writer,
            f.root.path(),
            Some(probes(false, None)),
            "codex",
            true,
            false,
        );
        assert_eq!(f.config()["agents"]["openclaw"]["enabled"], false);
    }
}
#[test]
fn installer_recovery_persists_entry_and_fresh_runtime_metadata_for_each_selection_mode() {
    for writer in writers() {
        for explicit in [false, true] {
            let f = Fixture::new();
            package(&f);
            let (cwd, entry) = app(&f, "2026.3.8", false);
            let old = f.root.path().join("removed/openclaw.mjs");
            store(
                &f,
                json!({"agents":{"openclaw":{"enabled":true,"cliPath":old,"captureMessageContent":false}}}),
            );
            let before = fs::read(f.data.join("config.json")).unwrap();
            assert!(resolve(&f, &cwd, OpenClawResolveMode::Runtime).is_none());
            let candidate = resolve(&f, &cwd, OpenClawResolveMode::Installer).unwrap();
            assert_eq!(candidate.recovered_from.as_deref(), old.to_str());
            assert_eq!(fs::read(f.data.join("config.json")).unwrap(), before);
            let result = write(&f, &writer, &cwd, None, "openclaw,codex", explicit, false);
            assert_eq!(f.config()["agents"]["openclaw"]["enabled"], true);
            assert_eq!(
                f.config()["agents"]["openclaw"]["captureMessageContent"],
                false
            );
            assert_entry(&f.config()["agents"]["openclaw"]["cliPath"], &entry);
            let fresh = fresh_deployment(&f, false);
            assert_entry(&fresh["entry"], &entry);
            // Native config diffs intentionally redact paths. The original AST's
            // writer old->new notice remains a documented partial assertion; the
            // actual probe separately describes the replaced missing entry.
            assert!(detected_probe(&result)["reason"]
                .as_str()
                .unwrap()
                .contains(&serde_json::to_string(&old).unwrap()));
            assert!(!result.stdout.contains(old.to_str().unwrap()));
            assert!(!result.stdout.contains(entry.to_str().unwrap()));
        }
    }
}
#[test]
fn public_installer_probe_binding_allows_recovery_without_enabling_runtime_recovery() {
    for writer in writers() {
        let f = Fixture::new();
        package(&f);
        let (cwd, entry) = app(&f, "2026.3.8", false);
        let old = f.root.path().join("removed/openclaw.mjs");
        store(
            &f,
            json!({"agents":{"openclaw":{"enabled":true,"cliPath":old}}}),
        );
        let before = fs::read(f.data.join("config.json")).unwrap();
        let mut runtime = f.command(&f.binary);
        runtime
            .arg("probe")
            .current_dir(&cwd)
            .env("AGENT_DATA_COLLECTION_CONFIG", f.data.join("config.json"));
        let runtime = bounded(runtime);
        success(&runtime);
        let runtime: Value = serde_json::from_slice(&runtime.stdout).unwrap();
        assert_eq!(
            runtime
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == "openclaw")
                .unwrap()["detected"],
            false
        );
        assert_eq!(fs::read(f.data.join("config.json")).unwrap(), before);
        let result = write(&f, &writer, &cwd, None, "openclaw,codex", false, false);
        assert_eq!(detected_probe(&result)["detected"], true);
        assert_entry(&detected_probe(&result)["openclawCliPath"], &entry);
        assert_entry(&fresh_deployment(&f, false)["entry"], &entry);
    }
}
#[test]
fn broken_parent_metadata_keeps_fixed_child_discovery_readonly_until_the_writer() {
    for writer in writers() {
        for recover in [false, true] {
            let f = Fixture::new();
            package(&f);
            let (cwd, entry) = app(&f, "2026.3.8", true);
            let old = f.root.path().join("removed/openclaw.mjs");
            if recover {
                store(
                    &f,
                    json!({"agents":{"openclaw":{"enabled":true,"cliPath":old,"captureMessageContent":false}}}),
                );
            } else {
                fs::remove_file(f.data.join("config.json")).unwrap();
            }
            let before = fs::read(f.data.join("config.json")).ok();
            if recover {
                assert!(resolve(&f, &cwd, OpenClawResolveMode::Runtime).is_none());
            }
            let candidate = resolve(&f, &cwd, OpenClawResolveMode::Installer).unwrap();
            assert_eq!(candidate.binding.as_deref(), Some("auto-entry"));
            assert_eq!(
                candidate.recovered_from.as_deref(),
                if recover { old.to_str() } else { None }
            );
            assert_eq!(fs::read(f.data.join("config.json")).ok(), before);
            write(&f, &writer, &cwd, None, "openclaw,codex", false, false);
            assert_entry(&f.config()["agents"]["openclaw"]["cliPath"], &entry);
            if recover {
                assert_eq!(
                    f.config()["agents"]["openclaw"]["captureMessageContent"],
                    false
                );
            }
            let fresh = fresh_deployment(&f, false);
            assert_entry(&fresh["entry"], &entry);
            assert_eq!(fresh["conversationAccess"], false);
        }
    }
}
#[test]
fn first_install_miss_keeps_openclaw_disabled() {
    for writer in writers() {
        let f = Fixture::new();
        package(&f);
        write(
            &f,
            &writer,
            f.root.path(),
            Some(probes(false, None)),
            "codex",
            false,
            false,
        );
        assert_eq!(f.config()["agents"]["openclaw"]["enabled"], false);
    }
}
#[test]
fn writer_roundtrips_quote_dollar_backtick_unicode_entry_as_data() {
    for writer in writers() {
        let f = Fixture::new();
        package(&f);
        let entry =
            format!("/opt/test 空格/quote'\"$ {}/openclaw.mjs", char::from(96)).replace("$ ", "$");
        write(
            &f,
            &writer,
            f.root.path(),
            Some(probes(true, Some(&entry))),
            "openclaw,codex",
            false,
            false,
        );
        assert_eq!(f.config()["agents"]["openclaw"]["cliPath"], entry);
        assert!(!f.root.path().join("must-not-exist").exists());
    }
}
#[test]
fn explicit_and_all_agent_selection_keep_detected_entry_and_their_gate_semantics() {
    for writer in writers() {
        for all in [false, true] {
            let f = Fixture::new();
            package(&f);
            let entry = "/app/openclaw.mjs";
            write(
                &f,
                &writer,
                f.root.path(),
                Some(probes(true, Some(entry))),
                if all { "" } else { "openclaw" },
                true,
                all,
            );
            assert_eq!(f.config()["agents"]["openclaw"]["cliPath"], entry);
            assert_eq!(
                f.config()["agents"]["openclaw"]["enabled"],
                if all { Value::Null } else { json!(true) }
            );
            if !all {
                assert_eq!(f.config()["agents"]["codex"]["enabled"], false);
            }
        }
    }
}
#[test]
fn all_agent_miss_removes_only_enable_gates_and_preserves_future_agent_metadata() {
    for writer in writers() {
        let f = Fixture::new();
        package(&f);
        store(
            &f,
            json!({"agents":{"openclaw":{"enabled":false,"cliPath":"/keep/openclaw.mjs"},"codex":{"enabled":false,"captureMessageContent":false},"future":{"enabled":false,"custom":"keep"}}}),
        );
        write(&f, &writer, f.root.path(), Some(json!([])), "", false, true);
        assert_eq!(
            f.config()["agents"],
            json!({"openclaw":{"cliPath":"/keep/openclaw.mjs"},"codex":{"captureMessageContent":false},"future":{"custom":"keep"}})
        );
    }
}
