//! Cross-version artifacts use the dedicated native installer; an old Node
//! package is retained as data, never accepted as a native updater candidate.
use super::*;

fn legacy_tree(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let files = [
        (
            "package.json",
            br#"{"name":"loongsuite-pilot","version":"1.0.9"}"#.to_vec(),
        ),
        (
            "dist/index.js",
            b"throw new Error('legacy collector must not execute');\n".to_vec(),
        ),
        (
            "dist/updater/index.js",
            b"throw new Error('legacy updater must not execute');\n".to_vec(),
        ),
        (
            "node_modules/sqlite3/lib/sqlite3.js",
            b"module.exports = {};\n".to_vec(),
        ),
        (".npmrc", b"install-links=true\n".to_vec()),
        ("VERSION", b"version=1.0.9\ngit_commit=legacy-v1\n".to_vec()),
        (
            "scripts/collector-daemon.js",
            b"legacy bootstrap sentinel\n".to_vec(),
        ),
    ];
    files
        .into_iter()
        .map(|(name, bytes)| {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, &bytes).unwrap();
            (path, bytes)
        })
        .collect()
}
fn assert_legacy_untouched(files: &[(PathBuf, Vec<u8>)]) {
    for (path, bytes) in files {
        assert_eq!(&fs::read(path).unwrap(), bytes, "{}", path.display());
    }
}
fn no_node_runtime(fixture: &Fixture) -> PathBuf {
    let directory = fixture.root.path().join("no-runtimes");
    fs::create_dir_all(&directory).unwrap();
    let marker = fixture.root.path().join("unexpected-node-or-npm");
    #[cfg(unix)]
    for name in ["node", "npm"] {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join(name);
        let quoted = marker.to_str().unwrap().replace('\'', "'\"'\"'");
        fs::write(
            &path,
            format!("#!/bin/sh\nprintf called > '{quoted}'\nexit 77\n"),
        )
        .unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    marker
}
#[test]
fn v1_layouts_migrate_via_real_native_installer_without_node_or_mutating_config_and_legacy_artifacts(
) {
    for versioned in [false, true] {
        let fixture = Fixture::new();
        fixture.package();
        let marker = no_node_runtime(&fixture);
        let cache = fixture.root.path().join("cache");
        let legacy = if versioned {
            cache.join("versions/1.0.9_legacy")
        } else {
            cache.join("package")
        };
        let files = legacy_tree(&legacy);
        fs::write(cache.join("node-bin"), b"user-owned managed runtime path\n").unwrap();
        if versioned {
            fs::write(cache.join("current"), b"\xef\xbb\xbf1.0.9_legacy\r\n").unwrap();
        }
        let config = b"\xef\xbb\xbf{\r\n  \"userId\":\"v1-user\", \"custom\":{\"preserve\":true}, \"excludeWorkspaces\":[\"/private-old\"]\r\n}\r\n";
        fs::write(fixture.data.join("config.json"), config).unwrap();
        let stage = fixture.helper(
            "stage-package",
            &fixture.runtime_options(&fixture.candidate),
            true,
        );
        success(&stage);
        assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), config);
        if versioned {
            assert_eq!(
                fs::read(cache.join("current")).unwrap(),
                b"\xef\xbb\xbf1.0.9_legacy\r\n"
            );
        } else {
            assert!(!cache.join("current").exists());
        }
        let name = String::from_utf8(stage.stdout).unwrap().trim().to_owned();
        let installed = cache.join("versions").join(&name);
        let manifest: Value =
            serde_json::from_slice(&fs::read(installed.join("runtime-manifest.json")).unwrap())
                .unwrap();
        for resource in manifest["resources"].as_array().unwrap() {
            let path = installed.join(resource["path"].as_str().unwrap());
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
        }
        assert!(!installed.join("node_modules").exists());
        assert!(!installed.join("package.json").exists());
        success(&fixture.helper(
            "publish-package",
            &fixture.runtime_options(&installed),
            false,
        ));
        assert_eq!(
            fs::read_to_string(cache.join("current")).unwrap(),
            format!("{name}\n")
        );
        if versioned {
            assert_eq!(fs::read(cache.join("previous")).unwrap(), b"1.0.9_legacy\n");
        } else {
            assert!(!cache.join("previous").exists());
        }
        assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), config);
        assert_eq!(
            fs::read(cache.join("node-bin")).unwrap(),
            b"user-owned managed runtime path\n"
        );
        assert_legacy_untouched(&files);
        assert!(!marker.exists());
        let binary = installed.join(if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        });
        let output = bounded({
            let mut command = fixture.command(&binary);
            command.arg("--version");
            command
        });
        success(&output);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            concat!("loongsuite-pilot ", env!("CARGO_PKG_VERSION"))
        );
    }
}
#[test]
fn legacy_node_candidate_and_missing_native_resource_are_rejected_before_install_writes() {
    for mode in ["node-artifact", "missing-resource"] {
        let fixture = Fixture::new();
        fixture.package();
        let marker = no_node_runtime(&fixture);
        let legacy = fixture.root.path().join("legacy-candidate");
        let files = legacy_tree(&legacy);
        let source = if mode == "node-artifact" {
            legacy.as_path()
        } else {
            fs::remove_file(fixture.candidate.join("assets/fixture")).unwrap();
            fixture.candidate.as_path()
        };
        let config = fs::read(fixture.data.join("config.json")).unwrap();
        let output = fixture.helper("stage-package", &fixture.runtime_options(source), true);
        assert_eq!(output.status.code(), Some(1));
        assert!(!fixture.root.path().join("cache").exists());
        assert!(!fixture.root.path().join(".local").exists());
        assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), config);
        assert_legacy_untouched(&files);
        assert!(!marker.exists());
    }
}
#[test]
fn rollback_rejects_legacy_corrupt_and_outside_targets_without_pointer_or_service_byte_changes() {
    for mode in [
        "legacy-node",
        "corrupt-native-resource",
        "outside-versions",
        "readonly-service",
        "target-helper-bypass",
    ] {
        let fixture = Fixture::new();
        fixture.package();
        let cache = fixture.root.path().join("cache");
        let stage = fixture.helper(
            "stage-package",
            &fixture.runtime_options(&fixture.candidate),
            true,
        );
        success(&stage);
        let current = String::from_utf8(stage.stdout).unwrap().trim().to_owned();
        let current_root = cache.join("versions").join(&current);
        success(&fixture.helper(
            "publish-package",
            &fixture.runtime_options(&current_root),
            true,
        ));
        let previous = if mode == "outside-versions" {
            "../outside-native"
        } else {
            "previous-v1-or-native"
        };
        let target = cache.join("versions").join(previous);
        if mode == "legacy-node" {
            legacy_tree(&target);
        } else {
            fs::create_dir_all(&target).unwrap();
            for entry in walkdir::WalkDir::new(&fixture.candidate) {
                let entry = entry.unwrap();
                let relative = entry.path().strip_prefix(&fixture.candidate).unwrap();
                if relative.as_os_str().is_empty() {
                    continue;
                }
                let destination = target.join(relative);
                if entry.file_type().is_dir() {
                    fs::create_dir_all(destination).unwrap();
                } else {
                    fs::copy(entry.path(), destination).unwrap();
                }
            }
            if mode == "corrupt-native-resource" {
                fs::write(target.join("assets/fixture"), b"modified").unwrap();
            }
            if mode == "target-helper-bypass" {
                let binary_relative = if cfg!(windows) {
                    "bin/loongsuite-pilot.exe"
                } else {
                    "bin/loongsuite-pilot"
                };
                let bad = format!(
                    "#!/bin/sh\nprintf called > '{}'\nexit 0\n",
                    fixture
                        .root
                        .path()
                        .join("target-executed")
                        .to_str()
                        .unwrap()
                        .replace('\'', "'\"'\"'")
                );
                fs::write(target.join(binary_relative), bad).unwrap();
                let manifest_path = target.join("runtime-manifest.json");
                let mut manifest: Value =
                    serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
                let resource = manifest["resources"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|resource| resource["path"] == binary_relative)
                    .unwrap();
                resource["sha256"] = json!(loongsuite_pilot::utils::runtime_paths::sha256_file(
                    &target.join(binary_relative)
                )
                .unwrap());
                fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            }
        }
        // These exact user-owned pointer encodings must survive rejection.
        let current_bytes = format!("{current}\r\n").into_bytes();
        let previous_bytes = format!("{previous}\r\n").into_bytes();
        fs::write(cache.join("current"), &current_bytes).unwrap();
        fs::write(cache.join("previous"), &previous_bytes).unwrap();
        let service = fixture.root.path().join(if cfg!(windows) {
            ".local/bin/loongsuite-pilot-service.ps1"
        } else {
            ".local/bin/loongsuite-pilot"
        });
        let service_bytes = b"#!/bin/bash\n# user customized installed service\n";
        fs::write(&service, service_bytes).unwrap();
        let original_mode = fs::metadata(&service).unwrap().permissions();
        if mode == "readonly-service" {
            let mut permissions = original_mode.clone();
            permissions.set_readonly(true);
            fs::set_permissions(&service, permissions).unwrap();
        }
        let layout = service.with_file_name("loongsuite-pilot-layout.json");
        let layout_bytes = fs::read(&layout).unwrap();
        let config = fs::read(fixture.data.join("config.json")).unwrap();
        let restarted = fixture.root.path().join("unexpected-restart");
        let command = rollback_command(&fixture, &restarted);
        let output = bounded(command);
        if mode == "readonly-service" {
            fs::set_permissions(&service, original_mode).unwrap();
        }
        assert_eq!(
            output.status.code(),
            Some(1),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(cache.join("current")).unwrap(),
            current_bytes,
            "{mode}: current"
        );
        assert_eq!(
            fs::read(cache.join("previous")).unwrap(),
            previous_bytes,
            "{mode}: previous"
        );
        assert_eq!(
            fs::read(&service).unwrap(),
            service_bytes,
            "{mode}: service"
        );
        assert_eq!(fs::read(&layout).unwrap(), layout_bytes, "{mode}: layout");
        assert_eq!(
            fs::read(fixture.data.join("config.json")).unwrap(),
            config,
            "{mode}: config"
        );
        assert!(
            !restarted.exists(),
            "{mode}: rejection cannot restart services"
        );
        assert!(
            !fixture.root.path().join("target-executed").exists(),
            "{mode}: current trusted validator runs before target code"
        );
    }
}

fn rollback_command(fixture: &Fixture, marker: &Path) -> Command {
    #[cfg(unix)]
    let mut command = {
        let mut command = fixture.command(Path::new("/bin/bash"));
        command.args(["-c", r#"source "$1"; cmd_restart(){ printf restart > "$PILOT_RESTART_MARKER"; }; cmd_rollback"#, "test"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/loongsuite-pilot.sh"))
            .env("PATH", "/usr/bin:/bin");
        command
    };
    #[cfg(windows)]
    let mut command = {
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let script = fixture.root.path().join("rollback-fixture.ps1");
        fs::write(&script, "\u{feff}. $env:PILOT_TEST_SERVICE_SCRIPT\nfunction Cmd-Restart { Set-Content -LiteralPath $env:PILOT_RESTART_MARKER -Value restart }\nCmd-Rollback\n").unwrap();
        let mut command = fixture.command(&shell);
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .env(
                "PILOT_TEST_SERVICE_SCRIPT",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/loongsuite-pilot.ps1"),
            );
        command
    };
    command
        .env(
            "AGENT_DATA_COLLECTION_CONFIG",
            fixture.data.join("config.json"),
        )
        .env("PILOT_RESTART_MARKER", marker);
    command
}
#[test]
fn successful_native_rollback_uses_the_same_publication_transaction_and_preserves_v1_config_and_runtime(
) {
    let fixture = Fixture::new();
    fixture.package();
    let cache = fixture.root.path().join("cache");
    let stage = fixture.helper(
        "stage-package",
        &fixture.runtime_options(&fixture.candidate),
        true,
    );
    success(&stage);
    let current = String::from_utf8(stage.stdout).unwrap().trim().to_owned();
    success(&fixture.helper(
        "publish-package",
        &fixture.runtime_options(&cache.join("versions").join(&current)),
        true,
    ));
    let old_config =
        b"\xef\xbb\xbf{\"userId\":\"v1-owned\",\"custom\":{\"retain\":\"exact bytes\"}}\r\n";
    fs::write(fixture.data.join("config.json"), old_config).unwrap();
    let previous = "older-native";
    let target = cache.join("versions").join(previous);
    for entry in walkdir::WalkDir::new(&fixture.candidate) {
        let entry = entry.unwrap();
        let relative = entry.path().strip_prefix(&fixture.candidate).unwrap();
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(destination).unwrap();
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
    let service_relative = if cfg!(windows) {
        "scripts/loongsuite-pilot.ps1"
    } else {
        "scripts/loongsuite-pilot.sh"
    };
    let service_text = if cfg!(windows) {
        "# older-native service marker\n"
    } else {
        "#!/bin/bash\n# older-native service marker\n"
    };
    fs::write(target.join(service_relative), service_text).unwrap();
    let manifest_path = target.join("runtime-manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let changed = manifest["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["path"] == service_relative)
        .unwrap();
    changed["sha256"] = json!(loongsuite_pilot::utils::runtime_paths::sha256_file(
        &target.join(service_relative)
    )
    .unwrap());
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    fs::write(cache.join("previous"), format!("{previous}\r\n")).unwrap();
    let old_node = legacy_tree(&cache.join("versions/1.0.9_legacy"));
    let marker = fixture.root.path().join("restart-called");
    let output = bounded(rollback_command(&fixture, &marker));
    success(&output);
    assert!(
        marker.is_file(),
        "restart occurs after committed native publication"
    );
    assert_eq!(
        fs::read_to_string(cache.join("current")).unwrap(),
        format!("{previous}\n")
    );
    assert_eq!(
        fs::read_to_string(cache.join("previous")).unwrap(),
        format!("{current}\n")
    );
    assert_eq!(
        fs::read(fixture.data.join("config.json")).unwrap(),
        old_config
    );
    assert!(!cache.join("update-recovery.json").exists());
    let service = fixture.root.path().join(if cfg!(windows) {
        ".local/bin/loongsuite-pilot-service.ps1"
    } else {
        ".local/bin/loongsuite-pilot"
    });
    assert!(fs::read_to_string(service)
        .unwrap()
        .contains("older-native service marker"));
    assert_legacy_untouched(&old_node);
}

#[test]
fn current_rollback_helper_rejects_unbound_source_and_configuration_mutation_before_any_writes() {
    let fixture = Fixture::new();
    fixture.package();
    let cache = fixture.root.path().join("cache");
    let stage = fixture.helper(
        "stage-package",
        &fixture.runtime_options(&fixture.candidate),
        true,
    );
    success(&stage);
    let name = String::from_utf8(stage.stdout).unwrap().trim().to_owned();
    let root = cache.join("versions").join(name);
    success(&fixture.helper("publish-package", &fixture.runtime_options(&root), true));
    fs::write(cache.join("previous"), b"another-native\r\n").unwrap();
    let current = fs::read(cache.join("current")).unwrap();
    let previous = fs::read(cache.join("previous")).unwrap();
    let config = fs::read(fixture.data.join("config.json")).unwrap();
    for mutation in [false, true] {
        let mut options = fixture.runtime_options(&root);
        if mutation {
            options["configOptions"] = json!({"userId":"must-not-write"});
        }
        let output = fixture.helper("rollback-package", &options, true);
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(fs::read(cache.join("current")).unwrap(), current);
        assert_eq!(fs::read(cache.join("previous")).unwrap(), previous);
        assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), config);
        assert!(!cache.join("update-recovery.json").exists());
    }
}
