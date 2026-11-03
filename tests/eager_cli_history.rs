//! Real startup CLI acceptance, with no Node/Python/PATH tools or live user data.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
struct World {
    _temp: tempfile::TempDir,
    root: PathBuf,
    pilot: PathBuf,
    data: PathBuf,
    home: PathBuf,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let pilot = root.join("pilot");
        let data = root.join("data");
        let home = root.join("agent");
        for p in [
            pilot.join("src"),
            pilot.join("agents.d"),
            pilot.join("assets/hooks/shared"),
            home.clone(),
        ] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(pilot.join("Cargo.toml"), "[package]\nname = 'fixture'\n").unwrap();
        std::fs::write(pilot.join("src/main.rs"), "fn main() {}\n").unwrap();
        for suffix in ["sh", "ps1"] {
            for relative in [
                format!("test-agent-hook.{suffix}"),
                format!("shared/native.{suffix}"),
            ] {
                std::fs::write(pilot.join("assets/hooks").join(relative), "fixture hook").unwrap();
            }
        }
        let def = json!({"id":"test-agent","displayName":"Test","deployMode":"hook","detection":{"paths":[home],"commands":[]},"hook":{"settingsPath":home.join("settings.json"),"events":["Stop"],"hookCommand":"$PILOT_DATA/hooks/test-agent-hook.sh","format":"nested","matcher":"*"}});
        std::fs::write(
            pilot.join("agents.d/test-agent.json"),
            serde_json::to_vec(&def).unwrap(),
        )
        .unwrap();
        Self {
            _temp: temp,
            root,
            pilot,
            data,
            home,
        }
    }
    async fn run(&self, more: &[&str]) -> std::process::Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        command
            .env_clear()
            .current_dir(&self.root)
            .env("HOME", self.root.join("empty-home"))
            .env("USERPROFILE", self.root.join("empty-home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("LOCALAPPDATA", self.root.join("localappdata"))
            .env("XDG_CONFIG_HOME", self.root.join("xdg-config"))
            .env("XDG_DATA_HOME", self.root.join("xdg-data"))
            .env("XDG_CACHE_HOME", self.root.join("xdg-cache"))
            .env("PATH", self.root.join("no-external-runtimes"))
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.root.join("never-written-config.json"),
            )
            .arg("inject-hooks")
            .arg(format!("--pilot-dir={}", self.pilot.display()))
            .arg(format!("--data-dir={}", self.data.display()))
            .args(more)
            .stdin(Stdio::null());
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        loongsuite_pilot::utils::candidate_process::output(
            &mut tokio::process::Command::from(command),
            Duration::from_secs(5),
            1024 * 1024,
        )
        .await
        .unwrap()
    }
}
fn assert_no_collector_side_effects(root: &Path, data: &Path) {
    for name in [
        "collector.pid",
        "updater.pid",
        "last-hook-install.json",
        "hook-install.signal",
    ] {
        assert!(!data.join(name).exists(), "{name}");
    }
    assert!(!root.join("never-written-config.json").exists());
    assert!(!root.join("empty-home/.loongsuite-pilot").exists());
}
#[tokio::test]
async fn actual_eager_cli_tolerates_unknown_flags_without_echoing_values_and_only_writes_deploy_state(
) {
    let f = World::new();
    let out = f
        .run(&[
            "--agents=typo,test-agent",
            "--unrecognized=synthetic-private-value",
        ])
        .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stdout.is_empty());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("ignoring unrecognized option --unrecognized"));
    assert!(!err.contains("synthetic-private-value"));
    assert!(err.contains("typo"));
    let settings: Value =
        serde_json::from_slice(&std::fs::read(f.home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
    let state: Value =
        serde_json::from_slice(&std::fs::read(f.data.join("deployed-agents.json")).unwrap())
            .unwrap();
    assert_eq!(state["test-agent"]["deployMode"], "hook");
    assert_no_collector_side_effects(&f.root, &f.data);
}
#[tokio::test]
async fn actual_eager_cli_unknown_or_undetected_agents_are_nonfatal_and_do_not_start_a_collector() {
    for absent in [false, true] {
        let f = World::new();
        if absent {
            std::fs::remove_dir_all(&f.home).unwrap();
        }
        let args = if absent {
            vec!["--agents=test-agent"]
        } else {
            vec!["--agents=typo"]
        };
        let out = f.run(&args).await;
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stdout.is_empty());
        assert!(!f.home.join("settings.json").exists());
        assert_no_collector_side_effects(&f.root, &f.data);
    }
}
#[tokio::test]
async fn actual_eager_cli_known_detected_failure_returns_one_without_rewriting_settings() {
    let f = World::new();
    std::fs::write(f.home.join("settings.json"), "broken [").unwrap();
    let out = f.run(&["--agents=test-agent"]).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        std::fs::read_to_string(f.home.join("settings.json")).unwrap(),
        "broken ["
    );
    assert_no_collector_side_effects(&f.root, &f.data);
}
#[tokio::test]
async fn actual_eager_cli_help_is_readonly_before_loading_configuration_or_resources() {
    let f = World::new();
    std::fs::remove_dir_all(&f.pilot).unwrap();
    let out = f.run(&["--help"]).await;
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("inject-hooks"));
    assert!(!f.data.exists());
    assert_no_collector_side_effects(&f.root, &f.data);
}
