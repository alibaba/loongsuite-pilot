use super::*;
use crate::types::AgentDetectionConfig;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    proc: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let proc = root.join("proc");
        std::fs::create_dir(&proc).unwrap();
        Self {
            _temp: temp,
            root,
            proc,
        }
    }
    fn locator(&self) -> DshRuntimeLocator {
        #[cfg(unix)]
        let uid = {
            use std::os::unix::fs::MetadataExt;
            Some(std::fs::metadata(&self.proc).unwrap().uid())
        };
        #[cfg(not(unix))]
        let uid = None;
        DshRuntimeLocator {
            proc_root: self.proc.to_string_lossy().into_owned(),
            platform: "linux".into(),
            env: HashMap::new(),
            cwd: self.root.to_string_lossy().into_owned(),
            uid,
        }
    }
    fn process(&self, pid: u32, home: &Path) {
        let dir = self.proc.join(pid.to_string());
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("cmdline"),
            b"node\0/code/node_modules/@deepseek-ai/dsh/lib/bin.js\0web\0",
        )
        .unwrap();
        std::fs::write(dir.join("environ"),format!("PATH=/usr/bin\0DSH_HOME={}\0DEEPSEEK_API_KEY=must-not-appear-in-the-probe-result\0",home.display())).unwrap();
    }
}
fn generic() -> AgentDefinition {
    serde_json::from_value(
        json!({"id":"generic-cli","displayName":"Generic CLI","deployMode":"detection-only",
        "detection":{"paths":[],"commands":["generic-cli"]}}),
    )
    .unwrap()
}
fn dsh() -> AgentDefinition {
    serde_json::from_value(json!({"id":"dsh","displayName":"DeepSeek Harness","deployMode":"dsh-yaml-patch",
        "detection":{"paths":["~/.dsh"],"commands":["dsh"]},"dshYamlPatch":{"pluginSource":"/synthetic/plugin.mjs",
        "entryId":"loongsuite-pilot-observability","marker":"PILOT-OBSERVABILITY-MANAGED"}})).unwrap()
}
#[derive(Default)]
struct CountingDetector(AtomicUsize);
#[async_trait::async_trait]
impl GenericProbeDetector for CountingDetector {
    async fn detect(&self, _: &AgentDetectionConfig) -> Result<bool, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(false)
    }
}
struct FailingDetector;
#[async_trait::async_trait]
impl GenericProbeDetector for FailingDetector {
    async fn detect(&self, _: &AgentDetectionConfig) -> Result<bool, String> {
        Err("generic detector failed".into())
    }
}
fn result_shape(result: &CliProbeResult, expected: serde_json::Value) {
    assert_eq!(serde_json::to_value(result).unwrap(), expected);
}
fn child(mode: &str) {
    let f = Fixture::new();
    let mut paths = vec![f.root.join("bin")];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let result=std::process::Command::new(std::env::current_exe().unwrap())
        .env("PATH",std::env::join_paths(paths).unwrap())
        .args(["--exact","deployment::cli_probe_detector::history_contract_tests::native_isolated_probe_contract_child","--nocapture"])
        .env("PILOT_PROBE_CONTRACT_MODE",mode).env("PILOT_PROBE_CONTRACT_ROOT",&f.root)
        .env("HOME",&f.root).env("USERPROFILE",&f.root).env("XDG_CONFIG_HOME",f.root.join("xdg"))
        .env("LOONGSUITE_PILOT_DATA_DIR",f.root.join("pilot-data"))
        .env("AGENT_DATA_COLLECTION_CONFIG",f.root.join("pilot.json"))
        .env_remove("OPENCLAW_CLI_PATH").env_remove("OPENCLAW_BUNDLE_ROOT")
        .current_dir(&f.root).output().unwrap();
    assert!(
        result.status.success(),
        "mode={mode}\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
#[tokio::test]
async fn native_isolated_probe_contract_child() {
    let Ok(mode) = std::env::var("PILOT_PROBE_CONTRACT_MODE") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("PILOT_PROBE_CONTRACT_ROOT").unwrap());
    let detector = CountingDetector::default();
    if mode == "ambiguous-list" {
        let f = Fixture::new();
        f.process(401, &f.root.join("home-a"));
        f.process(402, &f.root.join("home-b"));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let executable = bin.join(if cfg!(windows) {
            "generic-cli.cmd"
        } else {
            "generic-cli"
        });
        std::fs::write(
            &executable,
            if cfg!(windows) {
                "@exit /b 73\r\n"
            } else {
                "#!/bin/sh\nexit 73\n"
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(unix)]
        {
            // The fixed glibc2.34 image intentionally has no distro which.
            // This real executable supplies the original mocked lookup result,
            // records argv and never executes the discovered CLI.
            let which = bin.join("which");
            std::fs::write(
                &which,
                format!(
                    "#!/bin/sh\nprintf '%s' \"$1\" > '{}'\ncommand -v \"$1\" >/dev/null\n",
                    root.join("which-argv").display()
                ),
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(which, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let results = try_probe_agent_definitions(
            &[dsh(), generic()],
            &CliProbeOptions {
                dsh_runtime_locator: Some(f.locator()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        result_shape(
            &results[0],
            json!({"id":"dsh","displayName":"DeepSeek Harness","detected":false,"reason":""}),
        );
        result_shape(
            &results[1],
            json!({"id":"generic-cli","displayName":"Generic CLI","detected":true,"reason":"command: generic-cli"}),
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_to_string(root.join("which-argv")).unwrap(),
            "generic-cli"
        );
        let mut successful = generic();
        successful.detection.commands.push("later\0invalid".into());
        let still_present = try_probe_agent_definition(&successful, &CliProbeOptions::default())
            .await
            .unwrap();
        assert!(still_present.detected);
        assert_eq!(still_present.reason, "command: generic-cli");
        return;
    }
    let package = if mode == "replacement-child" {
        root.join("openclaw")
    } else {
        root.clone()
    };
    std::fs::create_dir_all(&package).unwrap();
    let entry = if mode == "path" {
        root.join(if cfg!(windows) {
            "openclaw.cmd"
        } else {
            "openclaw"
        })
    } else {
        package.join("openclaw.mjs")
    };
    std::fs::write(&entry, "/* never executed */").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let version = if mode == "path" {
        "2026.6.10"
    } else {
        "2026.3.8"
    };
    std::fs::write(
        package.join("package.json"),
        json!({"name":"openclaw","version":version}).to_string(),
    )
    .unwrap();
    if mode == "replacement-child" {
        std::fs::write(root.join("package.json"), "{").unwrap();
    }
    let mut definition = generic();
    definition.id = "openclaw".into();
    definition.display_name = "OpenClaw".into();
    // Any generic fallback would detect this path, so a strict missing binding
    // cannot pass by taking the unrelated generic detector route.
    definition.detection.paths = vec![root.to_string_lossy().into_owned()];
    if mode.starts_with("replacement") {
        let old = root.join("old/openclaw.mjs");
        let config = root.join("pilot.json");
        let bytes = json!({"agents":{"openclaw":{"cliPath":old}}}).to_string();
        std::fs::write(&config, &bytes).unwrap();
        let strict = probe_agent_definition_with_detector(
            &definition,
            &CliProbeOptions::default(),
            &detector,
        )
        .await
        .unwrap();
        assert!(!strict.detected);
        assert!(strict.reason.contains(old.to_str().unwrap()));
        let install = probe_agent_definition_with_detector(
            &definition,
            &CliProbeOptions {
                installer: true,
                ..Default::default()
            },
            &detector,
        )
        .await
        .unwrap();
        assert!(install.detected);
        assert_eq!(PathBuf::from(install.openclaw_cli_path.unwrap()), entry);
        assert!(install.reason.contains("replacing missing entry"));
        assert_eq!(std::fs::read_to_string(&config).unwrap(), bytes);
    } else {
        let result = probe_agent_definition_with_detector(
            &definition,
            &CliProbeOptions::default(),
            &detector,
        )
        .await
        .unwrap();
        assert!(result.detected);
        assert!(result.reason.contains(version));
        if mode == "path" {
            assert_eq!(PathBuf::from(result.openclaw_cli_path.unwrap()), entry);
        }
    }
    assert_eq!(detector.0.load(Ordering::SeqCst), 0);
}
#[test]
fn source_openclaw_explicit_metadata_hint_never_executes_or_uses_generic_detection() {
    let f = Fixture::new();
    let entry = f.root.join("openclaw.mjs");
    std::fs::write(&entry, "/* never executed */").unwrap();
    std::fs::write(
        f.root.join("package.json"),
        json!({"name":"openclaw","version":"2026.3.8"}).to_string(),
    )
    .unwrap();
    let output=std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact","deployment::cli_probe_detector::history_contract_tests::native_isolated_probe_contract_child","--nocapture"])
        .env("PILOT_PROBE_CONTRACT_MODE","explicit").env("PILOT_PROBE_CONTRACT_ROOT",&f.root)
        .env("OPENCLAW_CLI_PATH",&entry).env_remove("OPENCLAW_BUNDLE_ROOT")
        .env("AGENT_DATA_COLLECTION_CONFIG",f.root.join("pilot.json"))
        .env("HOME",&f.root).env("USERPROFILE",&f.root).current_dir(&f.root).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}
#[test]
fn source_only_installer_replaces_missing_pinned_entry_in_both_package_layouts_without_config_write(
) {
    for mode in ["replacement-package", "replacement-child"] {
        child(mode);
    }
}
#[test]
fn source_unique_path_candidate_persists_its_actual_entry_without_generic_detection() {
    // Child PATH is scoped by Command rather than unsafe process-global mutation.
    let f = Fixture::new();
    let unrelated = f.root.join("unrelated-cwd");
    std::fs::create_dir(&unrelated).unwrap();
    let result=std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact","deployment::cli_probe_detector::history_contract_tests::native_isolated_probe_contract_child","--nocapture"])
        .env("PILOT_PROBE_CONTRACT_MODE","path").env("PILOT_PROBE_CONTRACT_ROOT",&f.root)
        .env("PATH",&f.root).env("HOME",&f.root).env("USERPROFILE",&f.root)
        .env("AGENT_DATA_COLLECTION_CONFIG",f.root.join("pilot.json"))
        .env_remove("OPENCLAW_CLI_PATH").env_remove("OPENCLAW_BUNDLE_ROOT").current_dir(&unrelated).output().unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
#[tokio::test]
async fn source_dsh_procfs_reason_has_exact_home_pid_without_generic_detector_or_secret() {
    let f = Fixture::new();
    let home = f.root.join("runtime-home");
    f.process(321, &home);
    let detector = CountingDetector::default();
    let result = probe_agent_definition_with_detector(
        &dsh(),
        &CliProbeOptions {
            dsh_runtime_locator: Some(f.locator()),
            ..Default::default()
        },
        &detector,
    )
    .await
    .unwrap();
    result_shape(
        &result,
        json!({"id":"dsh","displayName":"DeepSeek Harness","detected":true,"reason":format!("running process: DSH_HOME={} (pid 321)",home.display())}),
    );
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("DEEPSEEK_API_KEY"));
    assert_eq!(detector.0.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn source_missing_dsh_runtime_is_a_normal_empty_reason_miss() {
    let f = Fixture::new();
    let mut definition = dsh();
    definition.detection = AgentDetectionConfig::default();
    let result = try_probe_agent_definition(
        &definition,
        &CliProbeOptions {
            dsh_runtime_locator: Some(f.locator()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    result_shape(
        &result,
        json!({"id":"dsh","displayName":"DeepSeek Harness","detected":false,"reason":""}),
    );
}
#[test]
fn source_ambiguous_dsh_does_not_destroy_other_agents_detection_results() {
    child("ambiguous-list");
}
#[tokio::test]
async fn source_generic_detector_error_is_preserved_by_fallible_native_probe() {
    let error = probe_agent_definition_with_detector(
        &generic(),
        &CliProbeOptions::default(),
        &FailingDetector,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "generic detector failed");
    let mut definition = generic();
    definition.detection.commands = vec!["invalid\0command".into()];
    let error = try_probe_agent_definition(&definition, &CliProbeOptions::default())
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "generic detector failed: detection command contains an embedded NUL"
    );
    assert!(
        try_probe_agent_definitions(&[definition], &CliProbeOptions::default())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn source_list_only_returns_metadata_without_runtime_or_generic_detection() {
    let f = Fixture::new();
    let mut locator = f.locator();
    locator.env.insert(
        "DSH_HOME".into(),
        f.root.join("would-detect").to_string_lossy().into_owned(),
    );
    let options = CliProbeOptions {
        list_only: true,
        dsh_runtime_locator: Some(locator),
        ..Default::default()
    };
    let detector = CountingDetector::default();
    let result = probe_agent_definition_with_detector(&dsh(), &options, &detector)
        .await
        .unwrap();
    result_shape(
        &result,
        json!({"id":"dsh","displayName":"DeepSeek Harness","detected":false,"reason":""}),
    );
    assert_eq!(detector.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn native_existing_path_short_circuits_a_later_invalid_command() {
    let f = Fixture::new();
    let present = f.root.join("present");
    std::fs::write(&present, []).unwrap();
    let mut definition = generic();
    definition.detection.paths = vec![present.to_string_lossy().into_owned()];
    definition.detection.commands = vec!["unreached\0command".into()];
    let result = try_probe_agent_definition(&definition, &CliProbeOptions::default())
        .await
        .unwrap();
    assert!(result.detected);
    assert_eq!(result.reason, present.to_string_lossy());
}
