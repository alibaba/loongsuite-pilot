//! 正式二进制的隔离预检；无 Agent 运行时、网络输出或系统服务。

use loongsuite_pilot::utils::runtime_paths::{
    build_edition, build_target, sha256_file, RuntimeManifest, RuntimeResource,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(binary: &Path, root: &Path, args: &[&str]) -> Output {
    invoke_with_resource_root(binary, root, args, None)
}

fn invoke_with_resource_root(
    binary: &Path,
    root: &Path,
    args: &[&str],
    resources: Option<&Path>,
) -> Output {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env("XDG_CONFIG_HOME", root.join("xdg-config"))
        .env("XDG_DATA_HOME", root.join("xdg-data"))
        .env("XDG_CACHE_HOME", root.join("xdg-cache"))
        .env("LOONGSUITE_PILOT_DATA_DIR", root.join("data"))
        .env("LOONGSUITE_PILOT_CACHE_DIR", root.join("cache"))
        .env("AGENT_DATA_COLLECTION_CONFIG", root.join("config.json"))
        .env("PATH", root.join("no-runtimes"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(resources) = resources {
        command.env("LOONGSUITE_PILOT_RESOURCE_ROOT", resources);
    }
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(loongsuite_pilot::utils::candidate_process::output(
            &mut tokio::process::Command::from(command),
            Duration::from_secs(20),
            1024 * 1024,
        ))
        .unwrap_or_else(|error| panic!("候选命令执行失败：{args:?}，{error}"))
}

fn executable() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot"))
}

fn snapshot(root: &Path) -> Vec<(PathBuf, String)> {
    let mut entries: Vec<_> = walkdir::WalkDir::new(root)
        .into_iter()
        .map(Result::unwrap)
        .map(|entry| {
            (
                entry.path().strip_prefix(root).unwrap().to_path_buf(),
                if entry.file_type().is_file() {
                    sha256_file(entry.path()).unwrap()
                } else {
                    String::new()
                },
            )
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

#[test]
fn help_version_and_argument_errors_do_not_touch_home_or_load_config() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "deliberately invalid JSON").unwrap();
    let before = snapshot(root.path());
    for args in [
        vec!["--help"],
        vec!["--version"],
        vec!["probe", "--build-edition"],
        vec!["hook", "--help"],
        vec!["dashboard", "shortcut", "--help"],
        vec!["worker", "connect", "--help"],
        vec!["start", "--help"],
        vec!["status", "--help"],
        vec!["restart-collector", "--help"],
    ] {
        let output = invoke(executable(), root.path(), &args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(before, snapshot(root.path()), "{args:?}");
    }
    let edition = invoke(executable(), root.path(), &["probe", "--build-edition"]);
    assert_eq!(
        String::from_utf8(edition.stdout).unwrap().trim(),
        build_edition()
    );
    for args in [
        vec!["typo"],
        vec!["dashboard", "shortcut"],
        vec!["dashboard", "shortcut", "open"],
        vec!["dashboard", "shortcut", "install", "--port", "9000"],
        vec!["run", "--typo"],
        vec!["run-updater", "unexpected"],
        vec!["hook-process"],
        vec!["hook", "install", "--agents"],
        vec!["interceptor", "unknown"],
        vec!["start", "--invalid"],
        vec!["restart-collector", "unexpected"],
    ] {
        let output = invoke(executable(), root.path(), &args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty());
        assert_eq!(before, snapshot(root.path()), "{args:?}");
    }
}

#[test]
fn check_rejects_missing_and_corrupt_configs_without_writes() {
    let root = tempfile::tempdir().unwrap();
    for config in [
        None,
        Some("{\"secret\":\"must-not-print\", broken}"),
        Some("[]"),
    ] {
        if let Some(config) = config {
            fs::write(root.path().join("config.json"), config).unwrap();
        }
        let before = snapshot(root.path());
        let output = invoke(executable(), root.path(), &["check", "--json"]);
        assert_eq!(output.status.code(), Some(1));
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["ok"], false);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("must-not-print"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("must-not-print"));
        assert_eq!(before, snapshot(root.path()));
    }
}

#[test]
fn check_accepts_optional_span_enrichers_without_loading_or_rewriting_plugins() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("preflight-must-not-load.mjs");
    fs::write(&plugin, "throw new Error('preflight-must-not-load');").unwrap();
    fs::write(
        root.path().join("config.json"),
        serde_json::to_vec(&serde_json::json!({
            "collectTrace":true,
            "otlpTrace":{"endpoint":"http://127.0.0.1:4318","spanEnrichers":[plugin]}
        }))
        .unwrap(),
    )
    .unwrap();
    let before = snapshot(root.path());
    // A custom isolated CARGO_TARGET_DIR need not be inside the source tree.
    // This fixture checks plugin/config preflight, not resource auto-discovery.
    let output = invoke_with_resource_root(
        executable(),
        root.path(),
        &["check", "--json"],
        Some(Path::new(env!("CARGO_MANIFEST_DIR"))),
    );
    assert!(output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ok"], true);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("preflight-must-not-load"));
    assert_eq!(snapshot(root.path()), before);
}

fn package(root: &Path) -> PathBuf {
    let package = root.join("候选包 空格🚀");
    for directory in ["bin", "agents.d", "assets/hooks"] {
        fs::create_dir_all(package.join(directory)).unwrap();
    }
    let binary_name = if cfg!(windows) {
        "bin/loongsuite-pilot.exe"
    } else {
        "bin/loongsuite-pilot"
    };
    let binary = package.join(binary_name);
    fs::copy(executable(), &binary).unwrap();
    let sdk = if cfg!(windows) {
        "loongsuite_pilot.dll"
    } else if cfg!(target_os = "macos") {
        "libloongsuite_pilot.dylib"
    } else {
        "libloongsuite_pilot.so"
    };
    let profile = executable().parent().unwrap().to_owned();
    let source = [profile.join(sdk), profile.join("deps").join(sdk)]
        .into_iter()
        .find(|p| p.is_file())
        .expect("SDK companion must be built");
    fs::copy(source, package.join("bin").join(sdk)).unwrap();
    fs::write(
        package.join("VERSION"),
        format!("version={}\n", env!("CARGO_PKG_VERSION")),
    )
    .unwrap();
    fs::write(package.join("LICENSE"), include_str!("../LICENSE")).unwrap();
    fs::write(
        package.join("agents.d/cursor.json"),
        include_str!("../agents.d/cursor.json"),
    )
    .unwrap();
    fs::write(
        package.join("assets/hooks/fixture.sh"),
        "#!/bin/sh\nexit 0\n",
    )
    .unwrap();
    let mut paths = vec![
        binary_name,
        "VERSION",
        "LICENSE",
        "agents.d/cursor.json",
        "assets/hooks/fixture.sh",
    ];
    let sdk_relative = format!("bin/{sdk}");
    paths.push(&sdk_relative);
    for relative in [
        "agents.d/opencode.json",
        "agents.d/mimo-code.json",
        "agents.d/pi-coding-agent.json",
        "agents.d/openclaw.json",
        "assets/plugins/openclaw/plugin.mjs",
        "assets/plugins/openclaw/package.json",
        "assets/plugins/openclaw/openclaw.plugin.json",
        "assets/plugins/openclaw/compatibility.mjs",
        "assets/plugins/openclaw/runtime-version.mjs",
        "assets/plugins/openclaw/legacy-adapter.mjs",
        "assets/plugins/openclaw/legacy-utils.mjs",
        "assets/plugins/openclaw/subagent-context.mjs",
        "assets/plugins/openclaw/interceptor.mjs",
        "assets/plugins/openclaw/first-token.mjs",
        "assets/plugins/opencode/plugin.mjs",
        "assets/plugins/opencode/index.js",
        "assets/plugins/opencode/package.json",
        "assets/plugins/opencode/v2.mjs",
        "assets/plugins/mimo-code/plugin.mjs",
        "assets/plugins/mimo-code/package.json",
        "assets/plugins/pi-coding-agent/index.mjs",
        "assets/plugins/shared/resource-context.mjs",
        "agents.d/cursor-cli.json",
        "agents.d/claude-code.json",
        "assets/hooks/claude-code-loongsuite-pilot-hook.sh",
        "assets/hooks/claude-code-loongsuite-pilot-hook.ps1",
        "agents.d/codex.json",
        "agents.d/kiro-cli.json",
        "assets/hooks/kiro-cli-loongsuite-pilot-hook.sh",
        "assets/hooks/kiro-cli-loongsuite-pilot-hook.ps1",
        "assets/hooks/codex-loongsuite-pilot-hook.sh",
        "assets/hooks/codex-loongsuite-pilot-hook.ps1",
        "assets/hooks/cursor-loongsuite-pilot-hook.sh",
        "assets/hooks/cursor-loongsuite-pilot-hook.ps1",
        "assets/hooks/shared/native.sh",
        "assets/hooks/shared/native.ps1",
    ] {
        let destination = package.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join(relative),
            destination,
        )
        .unwrap();
        paths.push(relative);
    }
    let manifest = RuntimeManifest {
        schema: 1,
        runtime: "rust".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        git_commit: "ef8953de1b5d2aa6d719cb0409cb5f48f2b99b42".into(),
        target: build_target().into(),
        edition: build_edition().into(),
        binary: binary_name.into(),
        resources: paths
            .iter()
            .map(|path| {
                let start = Instant::now();
                let file = package.join(path);
                let sha256 = sha256_file(&file).unwrap();
                eprintln!(
                    "资源摘要：{path}，{} 字节，{:?}",
                    fs::metadata(file).unwrap().len(),
                    start.elapsed()
                );
                RuntimeResource {
                    path: (*path).into(),
                    sha256,
                }
            })
            .collect(),
    };
    fs::write(
        package.join("runtime-manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    binary
}

#[test]
fn packaged_service_cli_preserves_arguments_environment_exit_status_and_manifest_boundary() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "deliberately invalid JSON").unwrap();
    fs::create_dir(root.path().join("data")).unwrap();
    let binary = package(root.path());
    let package = binary.parent().unwrap().parent().unwrap();
    let relative = if cfg!(windows) {
        "scripts/loongsuite-pilot.ps1"
    } else {
        "scripts/loongsuite-pilot.sh"
    };
    let script = package.join(relative);
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    // 仅替代系统服务操作层；执行的是正式原生 CLI 和完整清单校验。
    let body = if cfg!(windows) {
        "\u{feff}Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop\nImport-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop\n(@($args) + @($env:LOONGSUITE_PILOT_DATA_DIR, $env:LOONGSUITE_PILOT_CACHE_DIR, $env:AGENT_DATA_COLLECTION_CONFIG)) | Set-Content -LiteralPath (Join-Path $env:LOONGSUITE_PILOT_DATA_DIR 'service-env.txt') -Encoding UTF8\nWrite-Output 'platform-fixture'\nexit 23\n"
    } else {
        "#!/bin/bash\nprintf '%s\\n' \"$@\" \"$LOONGSUITE_PILOT_DATA_DIR\" \"$LOONGSUITE_PILOT_CACHE_DIR\" \"$AGENT_DATA_COLLECTION_CONFIG\" > \"$LOONGSUITE_PILOT_DATA_DIR/service-env.txt\"\nprintf 'platform-fixture\\n'\nexit 23\n"
    };
    fs::write(&script, body).unwrap();
    let manifest_path = package.join("runtime-manifest.json");
    let mut manifest: RuntimeManifest =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest.resources.push(RuntimeResource {
        path: relative.into(),
        sha256: sha256_file(&script).unwrap(),
    });
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    for args in [
        vec!["status"],
        vec!["restart-collector", "--defer-updater-restart"],
    ] {
        let output = invoke(&binary, root.path(), &args);
        assert_eq!(
            output.status.code(),
            Some(23),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "platform-fixture"
        );
        let report = fs::read_to_string(root.path().join("data/service-env.txt")).unwrap();
        let mut expected: Vec<String> = args.iter().map(|arg| (*arg).into()).collect();
        expected.extend(
            [
                root.path().join("data"),
                root.path().join("cache"),
                root.path().join("config.json"),
            ]
            .iter()
            .map(|path| path.to_string_lossy().into_owned()),
        );
        assert_eq!(
            report
                .trim_start_matches('\u{feff}')
                .lines()
                .collect::<Vec<_>>(),
            expected
        );
    }
    fs::write(&script, "tampered platform script").unwrap();
    let before = snapshot(root.path());
    let output = invoke(&binary, root.path(), &["status"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(snapshot(root.path()), before);
}

#[test]
fn packaged_deploy_reports_gate_results_and_never_publishes_hook_scope() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let data = root.path().join("data");
    let home = root.path().join(".cursor");
    fs::create_dir(&home).unwrap();
    fs::write(home.join("hooks.json"), r#"{"user":"保留","hooks":{}}"#).unwrap();
    let run = || {
        invoke(
            &binary,
            root.path(),
            &["deploy", "--require", "cursor", "--json"],
        )
    };
    let first = run();
    assert!(first.status.success(), "{first:?}");
    let report: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(report["dataDir"], data.to_str().unwrap());
    // The native CLI resolves its installation root. Windows may spell the
    // temporary base using an 8.3 alias while the report uses its long path.
    assert_eq!(
        fs::canonicalize(report["pilotDir"].as_str().unwrap()).unwrap(),
        fs::canonicalize(binary.parent().unwrap().parent().unwrap()).unwrap()
    );
    assert_eq!(report["required"], serde_json::json!(["cursor"]));
    assert_eq!(report["unmet"], serde_json::json!([]));
    assert_eq!(report["workerStopFailed"], false);
    let result = report["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["agentId"] == "cursor")
        .unwrap();
    assert_eq!(result["success"], true);
    let config: Value =
        serde_json::from_slice(&fs::read(home.join("hooks.json")).unwrap()).unwrap();
    assert_eq!(config["user"], "保留");
    assert_eq!(config["hooks"]["stop"].as_array().unwrap().len(), 1);
    let hook = if cfg!(windows) {
        "hooks/cursor-loongsuite-pilot-hook.ps1"
    } else {
        "hooks/cursor-loongsuite-pilot-hook.sh"
    };
    assert!(data.join(hook).is_file());
    let state: Value =
        serde_json::from_slice(&fs::read(data.join("deployed-agents.json")).unwrap()).unwrap();
    assert_eq!(state["cursor"]["installedBy"], "build");
    assert!(!data.join("last-hook-install.json").exists());
    assert!(!data.join("hook-install.signal").exists());
    let before = snapshot(&home);
    fs::write(data.join("last-hook-install.json"), "existing scope report").unwrap();
    fs::write(data.join("hook-install.signal"), "existing signal").unwrap();
    let second = run();
    assert!(second.status.success(), "{second:?}");
    let second: Value = serde_json::from_slice(&second.stdout).unwrap();
    let result = second["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["agentId"] == "cursor")
        .unwrap();
    assert_eq!(result["reason"], "up-to-date");
    assert_eq!(snapshot(&home), before);
    for (required, reason) in [("missing-agent", "unknown-id"), ("codex", "not-detected")] {
        let output = invoke(
            &binary,
            root.path(),
            &["deploy", "--require", required, "--json"],
        );
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            report["unmet"],
            serde_json::json!([{"agentId":required, "reason":reason}])
        );
    }
    fs::write(
        root.path().join("config.json"),
        r#"{"agents":{"cursor":{"enabled":false}}}"#,
    )
    .unwrap();
    let disabled = run();
    assert_eq!(disabled.status.code(), Some(1));
    let disabled: Value = serde_json::from_slice(&disabled.stdout).unwrap();
    assert_eq!(
        disabled["unmet"],
        serde_json::json!([{"agentId":"cursor", "reason":"disabled"}])
    );
    assert_eq!(
        fs::read_to_string(data.join("last-hook-install.json")).unwrap(),
        "existing scope report"
    );
    assert_eq!(
        fs::read_to_string(data.join("hook-install.signal")).unwrap(),
        "existing signal"
    );
}

#[test]
fn packaged_deploy_propagates_each_worker_stop_failure_without_starting_workers() {
    let root = tempfile::tempdir().unwrap();
    let binary = package(root.path());
    let data = root.path().join("data");
    let definitions = data.join("agents.d.local");
    fs::create_dir_all(&definitions).unwrap();
    fs::write(
        root.path().join("config.json"),
        r#"{"agents":{"worker-a":{"enabled":false},"worker-b":{"enabled":false}}}"#,
    )
    .unwrap();
    for id in ["worker-a", "worker-b"] {
        let bundle = root.path().join(id);
        fs::create_dir(&bundle).unwrap();
        fs::write(bundle.join("worker.manifest.json"), "invalid manifest").unwrap();
        fs::write(
            definitions.join(format!("{id}.json")),
            serde_json::to_vec(&serde_json::json!({
                "id": id, "displayName": id, "deployMode":"plugin-probe",
                "detection":{"paths":[], "commands":[]},
                "pluginProbe":{"source":{"type":"tar", "destDir":bundle}, "mountType":"wrapper"}
            }))
            .unwrap(),
        )
        .unwrap();
    }
    let output = invoke(&binary, root.path(), &["deploy", "--json"]);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["workerStopFailed"], true);
    assert_eq!(report["unmet"], serde_json::json!([]));
    assert!(report["results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["success"] == true));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("worker-a") && stderr.contains("worker-b"),
        "{stderr}"
    );
    for id in ["worker-a", "worker-b"] {
        let bundle = root.path().join(id);
        assert_eq!(fs::read_dir(&bundle).unwrap().count(), 1);
        assert_eq!(
            fs::read_to_string(bundle.join("worker.manifest.json")).unwrap(),
            "invalid manifest"
        );
        fs::write(
            bundle.join("worker.manifest.json"),
            r#"{"name":"isolated","command":["must-not-start"]}"#,
        )
        .unwrap();
    }
    let output = invoke(&binary, root.path(), &["deploy", "--json"]);
    assert!(output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["workerStopFailed"], false);
    for id in ["worker-a", "worker-b"] {
        assert_eq!(fs::read_dir(root.path().join(id)).unwrap().count(), 1);
    }
    assert!(!data.join("last-hook-install.json").exists());
    assert!(!data.join("hook-install.signal").exists());
}

#[test]
fn packaged_session_injection_keeps_deployment_scope_untouched() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let home = root.path().join(".claude");
    fs::create_dir(&home).unwrap();
    let deploy = invoke(
        &binary,
        root.path(),
        &["deploy", "--require", "claude-code", "--json"],
    );
    assert!(deploy.status.success(), "{deploy:?}");
    let data = root.path().join("data");
    assert!(!data.join("last-hook-install.json").exists());
    let session = root.path().join("临时会话 空格🚀");
    fs::create_dir(&session).unwrap();
    fs::write(
        session.join("settings.json"),
        r#"{"env":{"KEEP":"1"},"hooks":{}}"#,
    )
    .unwrap();
    let before = snapshot(&session);
    for repeat in [false, true] {
        if repeat {
            fs::write(data.join("last-hook-install.json"), "scope sentinel").unwrap();
            fs::write(data.join("hook-install.signal"), "signal sentinel").unwrap();
        }
        let data_before = snapshot(&data);
        let output = invoke(
            &binary,
            root.path(),
            &[
                "inject",
                "--agents=claude-code",
                "--config-dir",
                session.to_str().unwrap(),
                "--json",
            ],
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        if cfg!(windows) {
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(report["status"], "failed");
            assert!(report["error"]
                .as_str()
                .unwrap()
                .contains("Linux and macOS only"));
            assert_eq!(snapshot(&session), before);
        } else {
            assert!(output.status.success(), "{output:?}");
            assert_eq!(
                report["status"],
                if repeat { "unchanged" } else { "updated" }
            );
            let settings: Value =
                serde_json::from_slice(&fs::read(session.join("settings.json")).unwrap()).unwrap();
            assert_eq!(settings["env"]["KEEP"], "1");
            assert_eq!(
                settings["env"]["LOONGSUITE_PILOT_DATA_DIR"],
                data.to_str().unwrap()
            );
            assert_eq!(settings["hooks"].as_object().unwrap().len(), 5);
            for groups in settings["hooks"].as_object().unwrap().values() {
                assert_eq!(groups.as_array().unwrap().len(), 1);
                assert!(groups[0]["hooks"][0]["command"]
                    .as_str()
                    .unwrap()
                    .contains("claude-code-loongsuite-pilot-hook.sh"));
            }
        }
        assert_eq!(snapshot(&data), data_before);
    }
}

#[test]
fn packaged_cursor_alias_injects_real_resources_idempotently_and_status_is_read_only() {
    let root = tempfile::Builder::new()
        .prefix("安装 空格🚀")
        .tempdir()
        .unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let agent_home = root.path().join("Cursor 用户");
    fs::create_dir(&agent_home).unwrap();
    let settings = agent_home.join("hooks.json");
    fs::write(
        &settings,
        r#"{"userSetting":"保留🚀","hooks":{"stop":[{"command":"user-owned"}]}}"#,
    )
    .unwrap();
    let cli_home = format!("cursor-cli={}", agent_home.display());
    let cursor_home = format!("cursor={}", agent_home.display());
    let before = snapshot(root.path());
    let _ = invoke(
        &binary,
        root.path(),
        &[
            "hook",
            "status",
            "--agents",
            "cursor-cli",
            "--home",
            &cli_home,
            "--json",
        ],
    );
    assert_eq!(snapshot(root.path()), before);
    for (iteration, ids) in ["cursor-cli", "cursor,cursor-cli", "cursor-cli"]
        .into_iter()
        .enumerate()
    {
        let output = invoke(
            &binary,
            root.path(),
            &[
                "hook",
                "install",
                "--agents",
                ids,
                "--home",
                &cli_home,
                "--home",
                &cursor_home,
                "--json",
            ],
        );
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        let results = report["agents"].as_array().unwrap();
        assert_eq!(results.len(), ids.split(',').count());
        let expected_status = if iteration == 0 { "ok" } else { "up-to-date" };
        assert!(
            results
                .iter()
                .all(|agent| agent["status"] == expected_status),
            "{report}"
        );
        let state: Value = serde_json::from_slice(
            &fs::read(root.path().join("data/deployed-agents.json")).unwrap(),
        )
        .unwrap();
        for id in ids.split(',') {
            assert_eq!(state[id]["hookSettingsPath"], settings.to_str().unwrap());
            assert_eq!(state[id]["hookSettingsPaths"].as_array().unwrap().len(), 1);
        }
        let config: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert_eq!(config["userSetting"], "保留🚀");
        assert_eq!(config["version"], 1);
        let definition: Value =
            serde_json::from_str(include_str!("../agents.d/cursor.json")).unwrap();
        for event in definition["hook"]["events"].as_array().unwrap() {
            let hooks = config["hooks"][event.as_str().unwrap()].as_array().unwrap();
            assert_eq!(
                hooks
                    .iter()
                    .filter(|hook| hook["command"]
                        .as_str()
                        .is_some_and(|s| s.contains("cursor-loongsuite-pilot-hook")))
                    .count(),
                1
            );
        }
        assert!(config["hooks"]["stop"]
            .as_array()
            .unwrap()
            .iter()
            .any(|hook| hook["command"] == "user-owned"));
        let suffix = if cfg!(windows) { "ps1" } else { "sh" };
        for relative in [
            format!("hooks/cursor-loongsuite-pilot-hook.{suffix}"),
            format!("hooks/shared/native.{suffix}"),
            "hooks/pilot-bin".into(),
        ] {
            assert!(root.path().join("data").join(relative).is_file());
        }
    }
    let before = snapshot(root.path());
    let output = invoke(
        &binary,
        root.path(),
        &[
            "hook",
            "status",
            "--agents",
            "cursor-cli",
            "--home",
            &cli_home,
            "--json",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(snapshot(root.path()), before);
}

#[test]
fn packaged_codex_explicit_home_keeps_trust_and_hooks_together() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let default_home = root.path().join(".codex");
    fs::create_dir(&default_home).unwrap();
    fs::write(
        default_home.join("config.toml"),
        "# 不属于本次安装\nmodel = 'user-default'\n",
    )
    .unwrap();
    let default_before = snapshot(&default_home);
    let home = root.path().join("指定 Codex 用户🚀");
    fs::create_dir(&home).unwrap();
    let trust = home.join("config.toml");
    fs::write(&trust, "# 用户注释\nmodel = 'user-model'\n").unwrap();
    let settings = home.join("hooks.json");
    fs::write(&settings, r#"{"version":1,"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"user-hook"}]}]},"userField":"保留"}"#).unwrap();
    let home_arg = format!("codex={}", home.display());
    for (mode, explicit_home) in [
        ("install", true),
        ("install", true),
        ("status", true),
        ("status", false),
        ("install", false),
    ] {
        let before = (fs::read(&trust).unwrap(), fs::read(&settings).unwrap());
        let all_before = (mode == "status").then(|| snapshot(root.path()));
        let mut args = vec!["hook", mode, "--agents", "codex", "--json"];
        if explicit_home {
            args.extend(["--home", &home_arg]);
        }
        let output = invoke(&binary, root.path(), &args);
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["agents"].as_array().unwrap().len(), 1);
        assert_eq!(report["agents"][0]["id"], "codex");
        assert_eq!(
            report["agents"][0]["settingsPath"],
            settings.to_str().unwrap()
        );
        assert_eq!(
            snapshot(&default_home),
            default_before,
            "显式 --home 不得修改默认 Codex 配置"
        );
        let toml = fs::read_to_string(&trust).unwrap();
        let doc = toml.parse::<toml::Value>().unwrap();
        assert_eq!(doc["model"].as_str(), Some("user-model"));
        assert!(toml.contains("# 用户注释"));
        assert!(
            toml.contains("otel-codex-hook"),
            "trust 必须写入指定 home：{toml}"
        );
        let config: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert_eq!(config["userField"], "保留");
        assert!(config.get("version").is_none());
        let trust_entries = doc["hooks"]["state"].as_table().unwrap();
        assert_eq!(trust_entries.len(), 5);
        for (key, entry) in trust_entries {
            assert!(key.starts_with(settings.to_str().unwrap()));
            // 新 trust 仅记录摘要；enabled 是保留用户选择的可选字段。
            assert!(entry.get("enabled").is_none());
            assert!(entry["trusted_hash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:"));
        }
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "SubagentStart",
            "SubagentStop",
            "Stop",
        ] {
            let handlers: Vec<_> = config["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|group| group["hooks"].as_array().unwrap())
                .filter(|handler| {
                    handler["command"]
                        .as_str()
                        .unwrap()
                        .contains("codex-loongsuite-pilot-hook")
                })
                .collect();
            assert_eq!(handlers.len(), 1, "{event}");
        }
        assert!(config["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| group["hooks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|handler| handler["command"] == "user-hook")));
        if report["agents"][0]["status"] == "up-to-date" || mode == "status" {
            assert_eq!(
                before,
                (fs::read(&trust).unwrap(), fs::read(&settings).unwrap())
            );
        }
        if let Some(all_before) = all_before {
            assert_eq!(all_before, snapshot(root.path()));
        }
    }
}

#[test]
fn packaged_hook_rejects_corrupt_deployment_state_without_touching_agent() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let home = root.path().join("隔离 Cursor🚀");
    fs::create_dir(&home).unwrap();
    fs::write(home.join("hooks.json"), r#"{"hooks":{},"user":"保留"}"#).unwrap();
    let before = snapshot(&home);
    let home_arg = format!("cursor={}", home.display());
    let state = root.path().join("data/deployed-agents.json");
    fs::create_dir(state.parent().unwrap()).unwrap();
    for raw in ["", "[]", "{broken", r#"{"cursor":{"deployMode":"hook"}}"#] {
        fs::write(&state, raw).unwrap();
        for mode in ["install", "status"] {
            let all_before = (mode == "status").then(|| snapshot(root.path()));
            let output = invoke(
                &binary,
                root.path(),
                &[
                    "hook", mode, "--agents", "cursor", "--home", &home_arg, "--json",
                ],
            );
            assert_eq!(
                output.status.code(),
                Some(1),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["agents"][0]["id"], "cursor");
            assert_eq!(report["agents"][0]["status"], "failed");
            assert_eq!(report["agents"][0]["reason"], "invalid-deployment-state");
            assert_eq!(fs::read_to_string(&state).unwrap(), raw);
            assert_eq!(snapshot(&home), before);
            assert!(!root.path().join("data/hooks").exists());
            if let Some(all_before) = all_before {
                assert_eq!(snapshot(root.path()), all_before);
            }
        }
        let output = invoke(&binary, root.path(), &["hook", "status", "--json"]);
        assert_eq!(
            output.status.code(),
            Some(1),
            "自动发现也不能把损坏状态报告为空成功"
        );
    }
}

#[test]
fn packaged_hook_resource_integrity_blocks_install_and_status_without_agent_writes() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let package = binary.parent().unwrap().parent().unwrap();
    let manifest_path = package.join("runtime-manifest.json");
    let original_manifest = fs::read(&manifest_path).unwrap();
    let suffix = if cfg!(windows) { "ps1" } else { "sh" };
    let entry_name = format!("assets/hooks/cursor-loongsuite-pilot-hook.{suffix}");
    let shared_name = format!("assets/hooks/shared/native.{suffix}");
    let entry = package.join(&entry_name);
    let shared = package.join(&shared_name);
    let entry_bytes = fs::read(&entry).unwrap();
    let shared_bytes = fs::read(&shared).unwrap();
    let data = root.path().join("data");
    let home = root.path().join("Cursor 用户🚀");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&data).unwrap();
    fs::write(data.join("deployed-agents.json"), "{}\n").unwrap();
    fs::write(
        home.join("hooks.json"),
        "{\"user\":\"保留🚀\",\"hooks\":{}}\r\n",
    )
    .unwrap();
    let home_arg = format!("cursor={}", home.display());
    let run = |mode| {
        invoke(
            &binary,
            root.path(),
            &[
                "hook",
                mode,
                "--agents",
                "cursor",
                "--home",
                &home_arg,
                "--pilot-dir",
                package.to_str().unwrap(),
                "--json",
            ],
        )
    };
    for installed in [false, true] {
        if installed {
            let output = run("install");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
        let agent_before = snapshot(&home);
        let state_before = fs::read(data.join("deployed-agents.json")).unwrap();
        let resources_before = if installed {
            snapshot(&data.join("hooks"))
        } else {
            Vec::new()
        };
        for fault in [
            "entry-tampered",
            "shared-tampered",
            "entry-missing",
            "shared-missing",
            "unlisted",
            "duplicate",
            "case-duplicate",
            "manifest-missing",
            "manifest-invalid",
            "manifest-schema",
            "manifest-runtime",
            "manifest-target",
            "manifest-version",
            "manifest-edition",
        ] {
            let mut manifest: Value = serde_json::from_slice(&original_manifest).unwrap();
            match fault {
                "entry-tampered" => fs::write(&entry, "tampered entry").unwrap(),
                "shared-tampered" => fs::write(&shared, "tampered shared").unwrap(),
                "entry-missing" => fs::remove_file(&entry).unwrap(),
                "shared-missing" => fs::remove_file(&shared).unwrap(),
                "manifest-missing" => fs::remove_file(&manifest_path).unwrap(),
                "manifest-invalid" => fs::write(&manifest_path, "broken [").unwrap(),
                _ => {
                    match fault {
                        "unlisted" => manifest["resources"]
                            .as_array_mut()
                            .unwrap()
                            .retain(|item| item["path"] != shared_name),
                        "duplicate" | "case-duplicate" => {
                            let resources = manifest["resources"].as_array_mut().unwrap();
                            let mut extra = resources
                                .iter()
                                .find(|item| item["path"] == shared_name)
                                .unwrap()
                                .clone();
                            if fault == "case-duplicate" {
                                extra["path"] = shared_name.to_uppercase().into();
                            }
                            resources.push(extra);
                        }
                        "manifest-schema" => manifest["schema"] = 2.into(),
                        "manifest-runtime" => manifest["runtime"] = "node".into(),
                        "manifest-target" => manifest["target"] = "unsupported".into(),
                        "manifest-version" => manifest["version"] = "0.0.0".into(),
                        "manifest-edition" => manifest["edition"] = "invalid".into(),
                        _ => unreachable!(),
                    }
                    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
                }
            }
            for mode in ["install", "status"] {
                let before = snapshot(&data);
                let output = run(mode);
                assert_eq!(
                    output.status.code(),
                    Some(1),
                    "{installed} {fault} {mode}: {} {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                if fault != "manifest-missing" {
                    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
                    assert_eq!(report["agents"][0]["id"], "cursor");
                    assert_eq!(report["agents"][0]["status"], "failed", "{fault}");
                }
                assert_eq!(snapshot(&home), agent_before, "{fault} {mode}");
                assert_eq!(
                    fs::read(data.join("deployed-agents.json")).unwrap(),
                    state_before
                );
                assert!(!data.join(".hook-install/update-recovery.json").exists());
                if installed {
                    assert_eq!(snapshot(&data.join("hooks")), resources_before);
                } else {
                    assert!(!data.join("hooks").exists());
                }
                if mode == "status" {
                    assert_eq!(snapshot(&data), before, "状态检查不能修复或写报告：{fault}");
                }
            }
            fs::write(&entry, &entry_bytes).unwrap();
            fs::write(&shared, &shared_bytes).unwrap();
            fs::write(&manifest_path, &original_manifest).unwrap();
        }
        if installed {
            assert!(run("status").status.success());
            let output = run("install");
            assert!(output.status.success());
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["agents"][0]["status"], "up-to-date");
            assert_eq!(snapshot(&home), agent_before);
        }
    }
}

#[test]
fn packaged_hook_report_or_signal_failure_is_visible_and_retryable() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let home = root.path().join("Cursor 报告🚀");
    fs::create_dir(&home).unwrap();
    fs::write(home.join("hooks.json"), "{\"hooks\":{},\"user\":\"保留\"}").unwrap();
    let home_arg = format!("cursor={}", home.display());
    let run = |mode| {
        invoke(
            &binary,
            root.path(),
            &[
                "hook", mode, "--agents", "cursor", "--home", &home_arg, "--json",
            ],
        )
    };
    assert!(run("install").status.success());
    let data = root.path().join("data");
    let report_path = data.join("last-hook-install.json");
    let signal = data.join("hook-install.signal");
    let original_config = snapshot(&home);
    let resources = snapshot(&data.join("hooks"));
    let state = fs::read(data.join("deployed-agents.json")).unwrap();
    for path in [&report_path, &signal] {
        let previous_report = fs::read(&report_path).unwrap();
        let previous_signal = fs::read(&signal).unwrap();
        let writable = fs::metadata(path).unwrap().permissions();
        let mut readonly = writable.clone();
        readonly.set_readonly(true);
        fs::set_permissions(path, readonly).unwrap();
        let output = run("install");
        fs::set_permissions(path, writable).unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&output.stderr).contains("Hook 报告或信号保存失败"));
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["agents"][0]["status"], "failed");
        assert_eq!(report["agents"][0]["reason"], "runtime-unprepared");
        assert!(report["agents"][0]["hint"]
            .as_str()
            .unwrap()
            .contains("配置已提交"));
        assert_eq!(fs::read(&report_path).unwrap(), previous_report);
        assert_eq!(fs::read(&signal).unwrap(), previous_signal);
        assert!(!data.join(".hook-report/update-recovery.json").exists());
        assert_eq!(snapshot(&home), original_config);
        assert_eq!(snapshot(&data.join("hooks")), resources);
        assert_eq!(fs::read(data.join("deployed-agents.json")).unwrap(), state);
        let before = snapshot(&data);
        assert!(run("status").status.success());
        assert_eq!(snapshot(&data), before);
        let output = run("install");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["agents"][0]["status"], "up-to-date");
        assert_ne!(fs::read(&signal).unwrap(), previous_signal);
        let persisted: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
        assert_eq!(persisted["agents"], report["agents"]);
        assert!(report.get("alarmSent").is_none());
        assert_eq!(persisted["alarmSent"], true);
    }
    let assert_startup_rejected = |expected: &str| {
        let output = invoke(&binary, root.path(), &["run"]);
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        // collector 启用文件日志后不向非 TTY 输出；必须核对持久化原因，不能只看退出码。
        let crash: Value =
            serde_json::from_slice(&fs::read(data.join("logs/last-startup-crash.json")).unwrap())
                .unwrap();
        assert_eq!(crash["schema"], 1);
        assert_eq!(crash["phase"], "startup");
        assert_eq!(crash["error_message"], expected, "{crash}\n{output:?}");
        let logged = fs::read_dir(data.join("logs"))
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("loongsuite-pilot-service.")
            })
            .flat_map(|entry| {
                fs::read_to_string(entry.path())
                    .unwrap()
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .collect::<Vec<_>>()
            })
            .any(|entry| {
                entry["msg"] == "fatal startup error"
                    && entry["error"] == expected
                    && entry["pid"] == crash["pid"]
            });
        assert!(
            logged,
            "启动失败必须同时保留同进程的服务日志和 breadcrumb：{crash}"
        );
    };
    let previous_report = fs::read(&report_path).unwrap();
    let previous_signal = fs::read(&signal).unwrap();
    fs::write(&report_path, "broken report").unwrap();
    let output = run("install");
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Hook 报告或信号保存失败"));
    assert_eq!(fs::read(&report_path).unwrap(), b"broken report");
    assert_eq!(fs::read(&signal).unwrap(), previous_signal);
    assert_startup_rejected("Hook 报告 JSON 或 schema 无效，原文件保留");
    assert_eq!(snapshot(&home), original_config);
    assert_eq!(snapshot(&data.join("hooks")), resources);
    assert_eq!(fs::read(data.join("deployed-agents.json")).unwrap(), state);
    fs::write(&report_path, &previous_report).unwrap();
    assert!(run("install").status.success());

    // 固定磁盘 journal 夹具验证正式 CLI 恢复入口；真实进程退出另由主库测试覆盖。
    let state_of = |path: &Path| {
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        };
        #[cfg(not(unix))]
        let mode = 0o644;
        serde_json::json!({"hex": hex::encode(fs::read(path).unwrap()), "mode": mode})
    };
    let original_report = state_of(&report_path);
    let original_signal = state_of(&signal);
    let mut pending: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    pending["agents"][0]["id"] = serde_json::json!("uncommitted-agent");
    fs::write(&report_path, serde_json::to_vec(&pending).unwrap()).unwrap();
    let journal = data.join(".hook-report/update-recovery.json");
    // begin() freezes the canonical parent while preserving the file leaf.
    // Windows Temp may contain an 8.3 RUNNER~1 ancestor spelling.
    let bound_target = |path: &Path| {
        fs::canonicalize(path.parent().unwrap())
            .unwrap()
            .join(path.file_name().unwrap())
    };
    fs::write(
        &journal,
        serde_json::to_vec(&serde_json::json!({
            "schema": 2, "committed": false,
            "targets": {"report": bound_target(&report_path), "signal": bound_target(&signal)},
            "changes": {
                "report": {"original": original_report, "intended": state_of(&report_path)},
                "signal": {"original": original_signal, "intended": null}
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let before = snapshot(&data);
    assert!(run("status").status.success());
    assert_eq!(snapshot(&data), before);
    assert_startup_rejected("Hook 报告事务待恢复，保留现有部署范围");
    assert!(journal.exists());
    let output = run("install");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!journal.exists());
    let disk: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(disk["agents"].as_array().unwrap().len(), 1);
    assert_eq!(disk["agents"][0]["id"], "cursor");
    assert_eq!(snapshot(&home), original_config);
    assert_eq!(snapshot(&data.join("hooks")), resources);
    assert_eq!(fs::read(data.join("deployed-agents.json")).unwrap(), state);
}

#[test]
fn packaged_hook_install_rejects_bad_companion_configs_before_resource_writes() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    for (id, hook_file, companion) in [
        ("codex", "hooks.json", "config.toml"),
        ("kiro-cli", "agents/pilot-kiro.json", "settings/cli.json"),
    ] {
        let home = root.path().join(format!("{id} 用户🚀"));
        let path = home.join(companion);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "broken [").unwrap();
        let before = snapshot(&home);
        let home_arg = format!("{id}={}", home.display());
        let output = invoke(
            &binary,
            root.path(),
            &[
                "hook", "install", "--agents", id, "--home", &home_arg, "--json",
            ],
        );
        assert_eq!(
            output.status.code(),
            Some(1),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["agents"][0]["id"], id);
        assert_eq!(report["agents"][0]["status"], "failed");
        assert_eq!(snapshot(&home), before);
        assert!(!home.join(hook_file).exists());
        assert!(!root.path().join("data/hooks").exists());
        let before = snapshot(root.path());
        let output = invoke(
            &binary,
            root.path(),
            &[
                "hook", "status", "--agents", id, "--home", &home_arg, "--json",
            ],
        );
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(snapshot(root.path()), before);
    }
}

#[test]
fn packaged_hook_companion_write_failure_rolls_back_and_retries() {
    for (id, hook_file, companion, companion_raw) in [
        (
            "codex",
            "hooks.json",
            "config.toml",
            "# 用户配置\r\nmodel = \"keep\"\r\n",
        ),
        (
            "kiro-cli",
            "agents/pilot-kiro.json",
            "settings/cli.json",
            "{\"theme\":\"保留🚀\"}\r\n",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("config.json"), "{}").unwrap();
        let binary = package(root.path());
        let home = root.path().join(format!("{id} 用户🚀"));
        let settings = home.join(hook_file);
        let companion = home.join(companion);
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::create_dir_all(companion.parent().unwrap()).unwrap();
        let original = "\u{feff}{\"userField\":\"保留🚀\",\"hooks\":{}}\r\n";
        fs::write(&settings, original).unwrap();
        fs::write(&companion, companion_raw).unwrap();
        let writable = fs::metadata(&companion).unwrap().permissions();
        let mut readonly = writable.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&companion, readonly).unwrap();
        let home_arg = format!("{id}={}", home.display());
        let run = |mode| {
            invoke(
                &binary,
                root.path(),
                &["hook", mode, "--agents", id, "--home", &home_arg, "--json"],
            )
        };
        let failed = run("install");
        // 先恢复临时夹具权限，Windows 失败断言也不遗留只读文件。
        let stayed_readonly = fs::metadata(&companion).unwrap().permissions().readonly();
        fs::set_permissions(&companion, writable).unwrap();
        assert!(stayed_readonly, "{id}");
        assert_eq!(
            failed.status.code(),
            Some(1),
            "{id}: {} {}",
            String::from_utf8_lossy(&failed.stdout),
            String::from_utf8_lossy(&failed.stderr)
        );
        let report: Value = serde_json::from_slice(&failed.stdout).unwrap();
        assert_eq!(report["agents"][0]["id"], id);
        assert_eq!(report["agents"][0]["status"], "failed");
        assert_eq!(report["agents"][0]["reason"], "deploy-failed");
        assert_eq!(fs::read(&settings).unwrap(), original.as_bytes(), "{id}");
        assert_eq!(
            fs::read(&companion).unwrap(),
            companion_raw.as_bytes(),
            "{id}"
        );
        assert!(!PathBuf::from(format!("{}.loongsuite-pilot.bak", settings.display())).exists());
        let data = root.path().join("data");
        assert!(!data.join(".hook-install/update-recovery.json").exists());
        if data.join("hooks").exists() {
            assert!(
                !walkdir::WalkDir::new(data.join("hooks"))
                    .into_iter()
                    .map(Result::unwrap)
                    .any(|entry| entry.file_type().is_file()),
                "{id}"
            );
        }
        if data.join("deployed-agents.json").exists() {
            let state: Value =
                serde_json::from_slice(&fs::read(data.join("deployed-agents.json")).unwrap())
                    .unwrap();
            assert!(state.get(id).is_none(), "失败不能留下成功部署记录：{id}");
        }
        let before = snapshot(root.path());
        assert_eq!(run("status").status.code(), Some(1));
        assert_eq!(
            snapshot(root.path()),
            before,
            "失败后的状态检查必须只读：{id}"
        );
        let state_path = data.join("deployed-agents.json");
        fs::write(&state_path, "{}\n").unwrap();
        let state_writable = fs::metadata(&state_path).unwrap().permissions();
        let mut state_readonly = state_writable.clone();
        state_readonly.set_readonly(true);
        fs::set_permissions(&state_path, state_readonly).unwrap();
        let failed = run("install");
        fs::set_permissions(&state_path, state_writable).unwrap();
        assert_eq!(failed.status.code(), Some(1), "状态写入失败必须回滚：{id}");
        let report: Value = serde_json::from_slice(&failed.stdout).unwrap();
        assert_eq!(report["agents"][0]["status"], "failed");
        assert_eq!(fs::read_to_string(&state_path).unwrap(), "{}\n");
        assert_eq!(fs::read(&settings).unwrap(), original.as_bytes());
        assert_eq!(fs::read(&companion).unwrap(), companion_raw.as_bytes());
        assert!(!data.join("hooks/pilot-bin").exists());
        assert!(!data.join(".hook-install/update-recovery.json").exists());
        for (mode, expected) in [
            ("install", "ok"),
            ("install", "up-to-date"),
            ("status", "ok"),
        ] {
            let before = (expected == "up-to-date" || mode == "status")
                .then(|| (fs::read(&settings).unwrap(), fs::read(&companion).unwrap()));
            let all_before = (mode == "status").then(|| snapshot(root.path()));
            let output = run(mode);
            assert!(
                output.status.success(),
                "{id} {mode}: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["agents"][0]["id"], id);
            assert_eq!(report["agents"][0]["status"], expected);
            let settings_data = loongsuite_pilot::utils::parse_json_document(
                &fs::read_to_string(&settings).unwrap(),
                loongsuite_pilot::utils::JsonSyntax::Json,
            )
            .unwrap();
            assert_eq!(settings_data["userField"], "保留🚀");
            assert!(data.join("hooks/pilot-bin").is_file());
            if let Some(before) = before {
                assert_eq!(
                    (fs::read(&settings).unwrap(), fs::read(&companion).unwrap()),
                    before
                );
            }
            if let Some(before) = all_before {
                assert_eq!(snapshot(root.path()), before);
            }
        }
    }
}

#[test]
fn packaged_kiro_installs_in_custom_home_and_preserves_user_default() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let home = root.path().join("Kiro 用户 🚀");
    let path = home.join("agents/pilot-kiro.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"userField":"保留","hooks":{"stop":[{"command":"user-hook"}]}}"#,
    )
    .unwrap();
    let home_arg = format!("kiro-cli={}", home.display());
    let cli_settings = home.join("settings/cli.json");
    for (iteration, mode) in ["install", "install", "status"].into_iter().enumerate() {
        let before =
            (iteration != 0).then(|| (fs::read(&path).unwrap(), fs::read(&cli_settings).unwrap()));
        let output = invoke(
            &binary,
            root.path(),
            &[
                "hook", mode, "--agents", "kiro-cli", "--home", &home_arg, "--json",
            ],
        );
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            report["agents"][0]["status"],
            if iteration == 1 { "up-to-date" } else { "ok" }
        );
        let data: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(data["userField"], "保留");
        assert_eq!(data["name"], "pilot-kiro");
        for event in ["userPromptSubmit", "preToolUse", "postToolUse", "stop"] {
            let hooks = data["hooks"][event].as_array().unwrap();
            assert_eq!(
                hooks
                    .iter()
                    .filter(|hook| hook["command"]
                        .as_str()
                        .unwrap()
                        .contains("kiro-cli-loongsuite-pilot-hook"))
                    .count(),
                1
            );
        }
        assert!(data["hooks"]["stop"]
            .as_array()
            .unwrap()
            .iter()
            .any(|hook| hook["command"] == "user-hook"));
        let cli: Value = serde_json::from_slice(&fs::read(&cli_settings).unwrap()).unwrap();
        assert_eq!(
            cli["chat.defaultAgent"],
            if iteration == 0 {
                "pilot-kiro"
            } else {
                "user-agent"
            }
        );
        assert!(!root.path().join(".kiro").exists());
        if let Some(before) = before {
            assert_eq!(
                before,
                (fs::read(&path).unwrap(), fs::read(&cli_settings).unwrap())
            );
        } else {
            fs::write(
                &cli_settings,
                r#"{"chat.defaultAgent":"user-agent","theme":"keep"}"#,
            )
            .unwrap();
        }
    }
}

#[test]
fn packaged_flat_plugins_deploy_real_assets_and_status_never_repairs() {
    use loongsuite_pilot::utils::{parse_json_document, JsonSyntax};
    let root = tempfile::Builder::new()
        .prefix("插件 安装🚀")
        .tempdir()
        .unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let candidate = binary.parent().unwrap().parent().unwrap();
    for (id, filename, key, entry) in [
        (
            "opencode",
            "opencode.jsonc",
            "plugin",
            "opencode/plugin.mjs",
        ),
        (
            "mimo-code",
            "mimocode.jsonc",
            "plugin",
            "mimo-code/plugin.mjs",
        ),
        (
            "pi-coding-agent",
            "settings.json",
            "extensions",
            "pi-coding-agent/index.mjs",
        ),
    ] {
        let home = root.path().join(format!("{id} 用户🚀"));
        fs::create_dir(&home).unwrap();
        let settings = home.join(filename);
        let raw = if filename.ends_with(".jsonc") {
            format!("{{\r\n  // 保留用户配置🚀\r\n  \"theme\": \"用户🚀\",\r\n  \"{key}\": [\"user-plugin\",],\r\n}}\r\n")
        } else {
            format!("{{\r\n  \"theme\": \"用户🚀\",\r\n  \"{key}\": [\"user-plugin\"]\r\n}}\r\n")
        };
        fs::write(&settings, &raw).unwrap();
        let home_arg = format!("{id}={}", home.display());
        let deployed = root.path().join("data/plugins").join(entry);
        let mut previous = None;
        for (index, mode) in ["install", "install", "status"].into_iter().enumerate() {
            let before = (mode == "status").then(|| snapshot(root.path()));
            let output = invoke(
                &binary,
                root.path(),
                &["hook", mode, "--agents", id, "--home", &home_arg, "--json"],
            );
            assert!(
                output.status.success(),
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["agents"][0]["id"], id);
            assert_eq!(
                report["agents"][0]["status"],
                if index == 1 { "up-to-date" } else { "ok" }
            );
            let content = fs::read_to_string(&settings).unwrap();
            let syntax = if filename.ends_with(".jsonc") {
                assert!(content.contains("// 保留用户配置🚀\r\n"));
                JsonSyntax::Jsonc
            } else {
                JsonSyntax::Json
            };
            let json = parse_json_document(&content, syntax).unwrap();
            assert_eq!(json["theme"], "用户🚀");
            let plugins = json[key].as_array().unwrap();
            assert_eq!(plugins.len(), 2);
            assert_eq!(plugins[0], "user-plugin");
            let spec = plugins[1].as_str().unwrap();
            let referenced = if spec.starts_with("file://") {
                reqwest::Url::parse(spec).unwrap().to_file_path().unwrap()
            } else {
                PathBuf::from(spec)
            };
            assert_eq!(
                referenced,
                if id == "opencode" {
                    deployed.parent().unwrap().to_path_buf()
                } else {
                    deployed.clone()
                }
            );
            assert_eq!(
                fs::read(&deployed).unwrap(),
                fs::read(candidate.join("assets/plugins").join(entry)).unwrap()
            );
            assert_eq!(
                fs::read(root.path().join("data/plugins/shared/resource-context.mjs")).unwrap(),
                fs::read(candidate.join("assets/plugins/shared/resource-context.mjs")).unwrap()
            );
            if let Some(previous) = previous {
                assert_eq!(content, previous);
            }
            previous = Some(content);
            if let Some(before) = before {
                assert_eq!(snapshot(root.path()), before);
            }
        }
        fs::write(&deployed, "damaged-resource").unwrap();
        let before = snapshot(root.path());
        let output = invoke(
            &binary,
            root.path(),
            &[
                "hook", "status", "--agents", id, "--home", &home_arg, "--json",
            ],
        );
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(snapshot(root.path()), before);
        let output = invoke(
            &binary,
            root.path(),
            &[
                "hook", "install", "--agents", id, "--home", &home_arg, "--json",
            ],
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(
            fs::read(&deployed).unwrap(),
            fs::read(candidate.join("assets/plugins").join(entry)).unwrap()
        );
        assert_eq!(fs::read_to_string(&settings).unwrap(), previous.unwrap());
    }
}

#[test]
fn packaged_plugin_reports_selected_config_and_never_drifts_from_recorded_home() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let home = root.path().join("指定 OpenCode🚀");
    fs::create_dir(&home).unwrap();
    let selected = home.join("opencode.json");
    fs::write(&selected, r#"{"plugin":["user-plugin"]}"#).unwrap();
    let home_arg = format!("opencode={}", home.display());
    let output = invoke(
        &binary,
        root.path(),
        &[
            "hook", "install", "--agents", "opencode", "--home", &home_arg, "--json",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["agents"][0]["settingsPath"],
        selected.to_str().unwrap()
    );
    assert!(!home.join("opencode.jsonc").exists());
    let state: Value =
        serde_json::from_slice(&fs::read(root.path().join("data/deployed-agents.json")).unwrap())
            .unwrap();
    assert_eq!(
        state["opencode"]["pluginInjectConfigPath"],
        selected.to_str().unwrap()
    );
    let new_candidate = home.join("opencode.jsonc");
    let default_home = root.path().join(".config/opencode");
    fs::create_dir_all(&default_home).unwrap();
    let untouched = "{ /* 不属于本安装 */ \"plugin\": [\"unrelated-plugin\"] }\n";
    for path in [&new_candidate, &default_home.join("opencode.jsonc")] {
        fs::write(path, untouched).unwrap();
    }
    let before = snapshot(root.path());
    let output = invoke(
        &binary,
        root.path(),
        &["hook", "status", "--agents", "opencode", "--json"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(snapshot(root.path()), before);
    let other_home = format!("opencode={}", default_home.display());
    let output = invoke(
        &binary,
        root.path(),
        &[
            "hook",
            "status",
            "--agents",
            "opencode",
            "--home",
            &other_home,
            "--json",
        ],
    );
    assert_eq!(
        output.status.code(),
        Some(1),
        "显式 home 不能检查旧安装的配置"
    );
    assert_eq!(snapshot(root.path()), before);
    fs::remove_file(&selected).unwrap();
    let before = snapshot(root.path());
    let output = invoke(
        &binary,
        root.path(),
        &["hook", "status", "--agents", "opencode", "--json"],
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(snapshot(root.path()), before);
    let output = invoke(
        &binary,
        root.path(),
        &["hook", "install", "--agents", "opencode", "--json"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(selected.is_file());
    assert_eq!(fs::read_to_string(new_candidate).unwrap(), untouched);
    assert_eq!(
        fs::read_to_string(default_home.join("opencode.jsonc")).unwrap(),
        untouched
    );
}

#[test]
fn packaged_plugin_missing_or_tampered_shared_asset_leaves_config_untouched() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let shared = binary
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("assets/plugins/shared/resource-context.mjs");
    let home = root.path().join("OpenCode 用户");
    fs::create_dir(&home).unwrap();
    let settings = home.join("opencode.jsonc");
    let raw = "{ /* 用户字段 */ \"plugin\": [\"user-plugin\"] }\n";
    fs::write(&settings, raw).unwrap();
    let home_arg = format!("opencode={}", home.display());
    for tampered in [true, false] {
        if tampered {
            fs::write(&shared, "bad-digest").unwrap();
        } else {
            fs::remove_file(&shared).unwrap();
        }
        let output = invoke(
            &binary,
            root.path(),
            &[
                "hook", "install", "--agents", "opencode", "--home", &home_arg, "--json",
            ],
        );
        assert_eq!(
            output.status.code(),
            Some(1),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["agents"][0]["status"], "failed");
        assert_eq!(fs::read_to_string(&settings).unwrap(), raw);
        assert!(!settings.with_extension("jsonc.bak").exists());
        assert!(!root.path().join("data/plugins").exists());
    }
}

fn plugin_hook_report(
    binary: &Path,
    root: &Path,
    id: &str,
    home: &Path,
    mode: &str,
    ok: bool,
) -> Value {
    let home_arg = format!("{id}={}", home.display());
    let before = (mode == "status").then(|| snapshot(root));
    let output = invoke(
        binary,
        root,
        &["hook", mode, "--agents", id, "--home", &home_arg, "--json"],
    );
    assert_eq!(
        output.status.code(),
        Some(if ok { 0 } else { 1 }),
        "{id} {mode}: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if let Some(before) = before {
        assert_eq!(snapshot(root), before, "status 必须只读");
    }
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["agents"].as_array().unwrap().len(), 1);
    assert_eq!(report["agents"][0]["id"], id);
    report["agents"][0].clone()
}

#[test]
fn packaged_plugin_status_rejects_duplicates_and_legacy_references() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let home = root.path().join("OpenCode 配置🚀");
    fs::create_dir(&home).unwrap();
    let settings = home.join("opencode.jsonc");
    fs::write(&settings, r#"{"plugin":["user-plugin"]}"#).unwrap();
    plugin_hook_report(&binary, root.path(), "opencode", &home, "install", true);
    let healthy: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    let owned = healthy["plugin"][1].clone();
    for extra in [owned, serde_json::json!("loongsuite-pilot-opencode@0.1.0")] {
        let mut broken = healthy.clone();
        broken["plugin"].as_array_mut().unwrap().push(extra);
        fs::write(&settings, serde_json::to_vec(&broken).unwrap()).unwrap();
        plugin_hook_report(&binary, root.path(), "opencode", &home, "status", false);
        let repaired = plugin_hook_report(&binary, root.path(), "opencode", &home, "install", true);
        assert_eq!(repaired["status"], "ok", "不能误报 up-to-date");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&settings).unwrap()).unwrap(),
            healthy
        );
        plugin_hook_report(&binary, root.path(), "opencode", &home, "status", true);
        assert_eq!(
            plugin_hook_report(&binary, root.path(), "opencode", &home, "install", true)["status"],
            "up-to-date"
        );
    }
}

#[test]
fn packaged_openclaw_reconciles_versioned_config_and_stale_paths_without_runtime() {
    use loongsuite_pilot::utils::{parse_json_document, JsonSyntax};
    let root = tempfile::Builder::new()
        .prefix("OpenClaw %23#🚀")
        .tempdir()
        .unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let host = root.path().join("openclaw");
    fs::create_dir(&host).unwrap();
    // 仅提供宿主元数据供正式发现逻辑读取；被测 PATH 中没有任何 JS 运行时。
    let entry = "throw new Error('注入验证不得启动宿主');\n";
    fs::write(host.join("openclaw.mjs"), entry).unwrap();
    let home = root.path().join("指定 Agent 配置🚀");
    fs::create_dir(&home).unwrap();
    let settings = home.join("openclaw.json");
    let raw = r#"{
  // 保留用户配置
  "theme": "用户🚀",
  "plugins": {
    "allow": ["user-plugin"],
    "load": {"paths": ["/vendor/plugins/openclaw/plugin.mjs"]},
    "entries": {
      "user-plugin": {"enabled": true},
      "loongsuite-pilot-openclaw": {"config": { /* 用户选项 */ "custom": true }, "hooks": {"custom": "keep"}}
    }
  }
}
"#;
    fs::write(&settings, raw).unwrap();
    let expected_path = root
        .path()
        .join("data/plugins/openclaw")
        .to_string_lossy()
        .replace('\\', "/");
    for (version, access) in [
        ("2026.5.12", true),
        ("2026.3.8", false),
        ("2026.4.24", true),
    ] {
        fs::write(
            host.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "name": "openclaw", "version": version
            }))
            .unwrap(),
        )
        .unwrap();
        let installed =
            plugin_hook_report(&binary, root.path(), "openclaw", &home, "install", true);
        assert_eq!(installed["status"], "ok");
        assert_eq!(installed["settingsPath"], settings.to_str().unwrap());
        let written = fs::read_to_string(&settings).unwrap();
        assert!(written.contains("// 保留用户配置"));
        assert!(written.contains("/* 用户选项 */"));
        let config = parse_json_document(&written, JsonSyntax::Jsonc).unwrap();
        assert_eq!(config["theme"], "用户🚀");
        assert_eq!(
            config["plugins"]["load"]["paths"],
            serde_json::json!(["/vendor/plugins/openclaw/plugin.mjs", expected_path])
        );
        assert_eq!(
            config["plugins"]["allow"],
            serde_json::json!(["user-plugin", "loongsuite-pilot-openclaw"])
        );
        let pilot = &config["plugins"]["entries"]["loongsuite-pilot-openclaw"];
        assert_eq!(pilot["enabled"], true);
        assert_eq!(pilot["config"]["custom"], true);
        assert_eq!(pilot["hooks"]["custom"], "keep");
        assert_eq!(
            pilot["hooks"].get("allowConversationAccess"),
            access.then_some(&Value::Bool(true))
        );
        assert_eq!(
            config["plugins"]["entries"]["user-plugin"],
            serde_json::json!({"enabled": true})
        );
        plugin_hook_report(&binary, root.path(), "openclaw", &home, "status", true);
        assert_eq!(
            plugin_hook_report(&binary, root.path(), "openclaw", &home, "install", true)["status"],
            "up-to-date"
        );
        assert_eq!(fs::read_to_string(&settings).unwrap(), written);
    }
    let candidate = binary.parent().unwrap().parent().unwrap();
    let manifest: RuntimeManifest =
        serde_json::from_slice(&fs::read(candidate.join("runtime-manifest.json")).unwrap())
            .unwrap();
    for resource in manifest.resources.iter().filter(|resource| {
        resource.path.starts_with("assets/plugins/openclaw/")
            || resource.path == "assets/plugins/shared/resource-context.mjs"
    }) {
        assert_eq!(
            fs::read(
                root.path()
                    .join("data")
                    .join(resource.path.strip_prefix("assets/").unwrap())
            )
            .unwrap(),
            fs::read(candidate.join(&resource.path)).unwrap()
        );
    }
    let healthy =
        parse_json_document(&fs::read_to_string(&settings).unwrap(), JsonSyntax::Jsonc).unwrap();
    for extra in [
        expected_path.clone(),
        format!("{expected_path}/plugin.mjs"),
        "loongsuite-pilot-openclaw@0.1.0".into(),
    ] {
        let mut broken = healthy.clone();
        broken["plugins"]["load"]["paths"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(extra));
        fs::write(&settings, serde_json::to_vec(&broken).unwrap()).unwrap();
        plugin_hook_report(&binary, root.path(), "openclaw", &home, "status", false);
        assert_eq!(
            plugin_hook_report(&binary, root.path(), "openclaw", &home, "install", true)["status"],
            "ok"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&settings).unwrap()).unwrap(),
            healthy
        );
        plugin_hook_report(&binary, root.path(), "openclaw", &home, "status", true);
    }
    assert_eq!(
        fs::read_to_string(settings.with_extension("json.bak")).unwrap(),
        raw
    );
    assert_eq!(
        fs::read_to_string(host.join("openclaw.mjs")).unwrap(),
        entry
    );
    assert!(!root.path().join(".openclaw").exists());
}

#[test]
fn packaged_openclaw_rejects_unsupported_host_and_corrupt_config_without_resource_writes() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "{}").unwrap();
    let binary = package(root.path());
    let host = root.path().join("openclaw");
    fs::create_dir(&host).unwrap();
    fs::write(host.join("openclaw.mjs"), "禁止执行宿主").unwrap();
    let home = root.path().join("OpenClaw 配置");
    fs::create_dir(&home).unwrap();
    let settings = home.join("openclaw.json");
    for (version, raw) in [("2026.3.7", "{ /* 用户 */ }"), ("2026.5.12", "{broken")] {
        fs::write(
            host.join("package.json"),
            serde_json::to_vec(&serde_json::json!({"name":"openclaw", "version":version})).unwrap(),
        )
        .unwrap();
        fs::write(&settings, raw).unwrap();
        assert_eq!(
            plugin_hook_report(&binary, root.path(), "openclaw", &home, "install", false)["status"],
            "failed"
        );
        plugin_hook_report(&binary, root.path(), "openclaw", &home, "status", false);
        assert_eq!(fs::read_to_string(&settings).unwrap(), raw);
        assert!(!settings.with_extension("json.bak").exists());
        assert!(!root.path().join("data/plugins").exists());
    }
}

#[test]
fn check_rejects_script_even_with_matching_manifest_digest() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), r#"{"enabled":false}"#).unwrap();
    let binary = package(root.path());
    let package_root = binary.parent().unwrap().parent().unwrap();
    fs::write(&binary, b"#!/bin/sh\nnode dist/index.js\n").unwrap();
    let path = package_root.join("runtime-manifest.json");
    let mut manifest: RuntimeManifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let resource = manifest
        .resources
        .iter_mut()
        .find(|item| item.path == manifest.binary)
        .unwrap();
    resource.sha256 = sha256_file(&binary).unwrap();
    fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let before = snapshot(root.path());
    let output = invoke(
        executable(),
        root.path(),
        &[
            "check",
            "--json",
            "--resource-root",
            package_root.to_str().unwrap(),
        ],
    );
    assert_eq!(output.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ok"], false);
    assert!(String::from_utf8_lossy(&output.stdout).contains("二进制格式或架构不匹配"));
    assert_eq!(snapshot(root.path()), before);
}

#[test]
fn native_span_attributes_preserve_types_strings_and_never_launch_a_runtime() {
    let root = tempfile::Builder::new()
        .prefix("属性 CLI🚀")
        .tempdir()
        .unwrap();
    let before = snapshot(root.path());
    let list = invoke(executable(), root.path(), &["span-attr", "list"]);
    assert!(
        list.status.success(),
        "{}",
        String::from_utf8_lossy(&list.stderr)
    );
    assert_eq!(snapshot(root.path()), before);
    for args in [
        vec!["span-attr", "set", "gen_ai.name", "forbidden"],
        vec!["span-attr", "set", "team"],
        vec!["span-attr", "clear", "extra"],
    ] {
        assert!(!invoke(executable(), root.path(), &args).status.success());
        assert_eq!(snapshot(root.path()), before);
    }
    for (key, value) in [
        ("team", "研发 🚀"),
        ("empty", ""),
        ("number", "123"),
        ("quote", "a\"b\\c"),
    ] {
        let result = invoke(executable(), root.path(), &["span-attr", "set", key, value]);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let file = root.path().join("data/span-attributes.json");
    let data: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        data,
        serde_json::json!({"team":"研发 🚀", "empty":"", "number":"123", "quote":"a\"b\\c"})
    );
    let before = snapshot(root.path());
    assert!(invoke(executable(), root.path(), &["span-attr", "list"])
        .status
        .success());
    assert_eq!(snapshot(root.path()), before);
    assert!(
        invoke(executable(), root.path(), &["span-attr", "unset", "team"])
            .status
            .success()
    );
    let mut legacy = serde_json::json!({
        "team": "研发\u{feff}🚀",
        "count": 7,
        "enabled": true,
        "labels": ["中文", "O'Brien"]
    });
    fs::write(&file, format!("\u{feff}{legacy}")).unwrap();
    let bom_bytes = fs::read(&file).unwrap();
    let listed = invoke(executable(), root.path(), &["span-attr", "list"]);
    assert!(listed.status.success());
    assert!(String::from_utf8_lossy(&listed.stdout).contains("研发\u{feff}🚀"));
    assert_eq!(fs::read(&file).unwrap(), bom_bytes);
    assert!(invoke(
        executable(),
        root.path(),
        &["span-attr", "set", "new", "值\\\"🚀"]
    )
    .status
    .success());
    legacy["new"] = serde_json::json!("值\\\"🚀");
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap(),
        legacy
    );
    fs::write(&file, "broken").unwrap();
    assert!(!invoke(
        executable(),
        root.path(),
        &["span-attr", "set", "team", "x"]
    )
    .status
    .success());
    assert_eq!(fs::read_to_string(&file).unwrap(), "broken");
    assert!(invoke(executable(), root.path(), &["span-attr", "clear"])
        .status
        .success());
    assert!(!file.exists());
    assert!(!root.path().join("cache").exists());
}

#[test]
fn dashboard_probe_cli_is_read_only_and_checks_real_instance_headers() {
    use loongsuite_pilot::dashboard::{DashboardServer, DashboardServerOptions};
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    let server = DashboardServer::new(DashboardServerOptions {
        data_dir: data.to_str().unwrap().into(),
        asset_path: String::new(),
        host: None,
        port: Some(0),
    });
    server.start().unwrap();
    let port = reqwest::Url::parse(&server.address().unwrap())
        .unwrap()
        .port()
        .unwrap();
    fs::write(
        root.path().join("config.json"),
        format!("{{\"dashboard\":{{\"port\":{port}}}}}"),
    )
    .unwrap();
    let before = snapshot(root.path());
    for option in ["--port", "--data-dir", "--available"] {
        // start() binds before its HTTP worker is scheduled. Wait for actual
        // readiness under runner load while retaining the read-only contract.
        let started = Instant::now();
        let result = loop {
            let result = invoke(executable(), root.path(), &["dashboard", "probe", option]);
            assert_eq!(snapshot(root.path()), before);
            if result.status.success() || started.elapsed() >= Duration::from_secs(2) {
                break result;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(result.status.success(), "option={option} output={result:?}");
        if option == "--port" {
            assert_eq!(
                String::from_utf8(result.stdout).unwrap().trim(),
                port.to_string()
            );
        }
        assert_eq!(snapshot(root.path()), before);
    }
    server.stop();
    assert_eq!(
        invoke(
            executable(),
            root.path(),
            &["dashboard", "probe", "--available"]
        )
        .status
        .code(),
        Some(1)
    );
    assert_eq!(snapshot(root.path()), before);
}

#[test]
fn installed_check_uses_own_manifest_and_detects_tampered_resources() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), r#"{"enabled":false}"#).unwrap();
    let binary = package(root.path());
    // 故意损坏另一安装的指针，候选预检不应读取它或向其写入。
    fs::create_dir(root.path().join("cache")).unwrap();
    fs::write(root.path().join("cache/current"), "../../unrelated").unwrap();
    let output = invoke(&binary, root.path(), &["check", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["check"]["details"]["mode"], "installed");
    assert!(!root.path().join("data").exists());
    assert!(!root.path().join(".cursor").exists());
    let package = binary.parent().unwrap().parent().unwrap();
    fs::write(package.join("assets/hooks/fixture.sh"), "tampered").unwrap();
    let output = invoke(&binary, root.path(), &["check", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("摘要不匹配"));
    assert_eq!(
        fs::read_to_string(root.path().join("cache/current")).unwrap(),
        "../../unrelated"
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn dashboard_shortcut_rejects_other_platforms_without_loading_config_or_runtimes() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("config.json"), "private-invalid-config").unwrap();
    let before = snapshot(root.path());
    for action in ["install", "status", "uninstall"] {
        let output = invoke(
            executable(),
            root.path(),
            &["dashboard", "shortcut", action],
        );
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("macOS"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-invalid"));
        assert_eq!(before, snapshot(root.path()));
    }
}
