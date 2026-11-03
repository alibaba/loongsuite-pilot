//! Frozen session-inject public CLI contracts, with synthetic config/home/hooks.
#![cfg(unix)]
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::{
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::Duration,
};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let data = root.join("data");
        std::fs::create_dir_all(data.join("hooks")).unwrap();
        std::fs::write(
            data.join("hooks/claude-code-loongsuite-pilot-hook.sh"),
            "#!/bin/sh\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(
            data.join("hooks/claude-code-loongsuite-pilot-hook.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let f = Self {
            _temp: temp,
            root,
            data,
        };
        f.config(true);
        f
    }
    fn config(&self, enabled: bool) {
        std::fs::write(
            self.root.join("config.json"),
            json!({"enabled":enabled,"dataDir":self.data}).to_string(),
        )
        .unwrap();
    }
    fn invoke(&self, target: Option<&Path>, env_dir: Option<&str>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        command.args(["inject", "--agents=claude-code", "--json"]);
        if let Some(dir) = target {
            command.arg("--config-dir").arg(dir);
        }
        command
            .env_clear()
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("XDG_CONFIG_HOME", self.root.join("xdg-config"))
            .env("XDG_CACHE_HOME", self.root.join("xdg-cache"))
            .env("XDG_DATA_HOME", self.root.join("xdg-data"))
            .env("PATH", self.root.join("no-agent-runtime"))
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.root.join("config.json"),
            )
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", self.root.join("cache"))
            .env("LOONGSUITE_PILOT_RESOURCE_ROOT", env!("CARGO_MANIFEST_DIR"))
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(value) = env_dir {
            command.env("CLAUDE_CONFIG_DIR", value);
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
            .unwrap()
    }
}
fn report(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "{e}; stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}
#[test]
fn source_l141_public_cli_prioritizes_explicit_environment_then_empty_environment_default_target() {
    let f = Fixture::new();
    let explicit = f.root.join("explicit");
    let environment = f.root.join("env-session");
    let out = f.invoke(Some(&explicit), Some(environment.to_str().unwrap()));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        Path::new(report(&out)["settingsPath"].as_str().unwrap()),
        explicit.join("settings.json")
    );
    assert!(!environment.exists());
    let out = f.invoke(None, Some(environment.to_str().unwrap()));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        Path::new(report(&out)["settingsPath"].as_str().unwrap()),
        environment.join("settings.json")
    );
    let out = f.invoke(None, Some(""));
    assert!(
        out.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let default = f.root.join(".claude/settings.json");
    assert_eq!(
        Path::new(report(&out)["settingsPath"].as_str().unwrap()),
        default
    );
    let settings: Value = serde_json::from_slice(&std::fs::read(default).unwrap()).unwrap();
    assert_eq!(
        Path::new(
            settings["env"]["LOONGSUITE_PILOT_DATA_DIR"]
                .as_str()
                .unwrap()
        ),
        f.data
    );
}
#[test]
fn source_l154_public_cli_reports_disabled_and_missing_hook_without_creating_target() {
    let f = Fixture::new();
    let missing = f.root.join("missing");
    f.config(false);
    let out = f.invoke(Some(&missing), None);
    assert_eq!(out.status.code(), Some(1));
    assert!(report(&out)["error"].as_str().unwrap().contains("disabled"));
    assert_eq!(report(&out)["status"], "failed");
    assert!(!missing.exists());
    f.config(true);
    std::fs::remove_file(f.data.join("hooks/claude-code-loongsuite-pilot-hook.sh")).unwrap();
    let out = f.invoke(Some(&missing), None);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(report(&out)["status"], "failed");
    assert!(!missing.exists());
}

#[test]
fn source_review_l111_native_wrapper_missing_binary_pointer_and_entry_have_parseable_json_and_stderr(
) {
    for failure in ["binary", "version", "entry"] {
        let f = Fixture::new();
        let scripts = f.root.join("scripts");
        std::fs::create_dir(&scripts).unwrap();
        let script = scripts.join("loongsuite-pilot.sh");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/loongsuite-pilot.sh"),
            &script,
        )
        .unwrap();
        let cache = f.root.join("cache");
        std::fs::create_dir(&cache).unwrap();
        if failure != "binary" {
            std::fs::write(cache.join("current"), "1.2.3\n").unwrap();
            if failure == "entry" {
                let version = cache.join("versions/1.2.3");
                std::fs::create_dir_all(&version).unwrap();
                std::fs::write(
                    version.join("runtime-manifest.json"),
                    r#"{"schema":1,"runtime":"rust"}"#,
                )
                .unwrap();
            }
        }
        for json in [true, false] {
            let mut command = Command::new("/bin/bash");
            command
                .arg(&script)
                .args(["inject", "--agents=claude-code"]);
            if json {
                command.arg("--json");
            }
            command
                .env_clear()
                .env("HOME", &f.root)
                .env("USERPROFILE", &f.root)
                .env("PATH", "/usr/bin:/bin")
                .env("LOONGSUITE_PILOT_DATA_DIR", &f.data)
                .env("LOONGSUITE_PILOT_CACHE_DIR", &cache)
                .env("AGENT_DATA_COLLECTION_CONFIG", f.root.join("config.json"))
                .current_dir(&f.root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let output = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(loongsuite_pilot::utils::candidate_process::output(
                    &mut tokio::process::Command::from(command),
                    Duration::from_secs(10),
                    1024 * 1024,
                ))
                .unwrap();
            assert_eq!(output.status.code(), Some(1), "{failure}/{json}");
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("loongsuite-pilot inject:"),
                "{failure}/{json}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            if json {
                let result = report(&output);
                assert_eq!(result["status"], "failed");
                assert!(result["error"].as_str().is_some_and(|e| !e.is_empty()));
            } else {
                assert!(
                    output.stdout.is_empty(),
                    "{failure}: {}",
                    String::from_utf8_lossy(&output.stdout)
                );
            }
        }
    }
}
