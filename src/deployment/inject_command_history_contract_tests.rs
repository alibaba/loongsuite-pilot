//! Exact session-inject history, actual native implementation and synthetic temp HOME only.
use super::*;
use crate::types::AgentDefinition;
use serde_json::json;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    hook: AgentHookConfig,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/claude-code.json")).unwrap();
        let hook = def.hook.as_mut().unwrap();
        hook.hook_command = root
            .join("hooks/claude-code-loongsuite-pilot-hook.sh")
            .to_string_lossy()
            .into_owned();
        hook.settings_path = root
            .join("session/settings.json")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir(root.join("hooks")).unwrap();
        std::fs::write(&hook.hook_command, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&hook.hook_command, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        Self {
            _root: temp,
            root,
            hook: def.hook.unwrap(),
        }
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn data(&self) -> &str {
        self.root.to_str().unwrap()
    }
    async fn inject(&self, dir: &Path) -> Value {
        inject_claude_directory(dir.to_str().unwrap(), self.data(), &self.hook)
            .await
            .unwrap()
    }
}
fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).into()).collect()
}

#[test]
fn source_l52_both_option_spellings_and_all_four_invalid_argument_groups() {
    let parsed = parse_inject_command_args(&args(&[
        "--agents=claude-code",
        "--config-dir",
        "/tmp/a",
        "--json",
    ]))
    .unwrap();
    assert_eq!(parsed.config_dir.as_deref(), Some("/tmp/a"));
    assert!(parsed.json);
    let other =
        parse_inject_command_args(&args(&["--agents", "claude-code", "--config-dir=/tmp/b"]))
            .unwrap();
    assert_eq!(other.config_dir.as_deref(), Some("/tmp/b"));
    for input in [
        vec![],
        args(&["--agents=codex"]),
        args(&["--agents=claude-code", "--config-dir="]),
        args(&["--agents=claude-code", "--typo"]),
    ] {
        assert!(parse_inject_command_args(&input).is_err(), "{input:?}");
    }
}
#[test]
fn source_l56_manual_own_entries_are_adopted_but_mixed_user_group_and_original_value_survive() {
    let f = Fixture::new();
    let customer = json!({"permissions":{"allow":["Read"]},"env":{"CUSTOMER":"keep"},"hooks":{"Stop":[{
        "matcher":"*","hooks":[{"type":"command","command":"/old/hooks/claude-code-loongsuite-pilot-hook.sh stop"},
        {"type":"command","command":"echo claude-code-loongsuite-pilot-hook.sh"}]
    }]}});
    let before = customer.clone();
    let result = merge_claude_hooks(&customer, &f.hook, f.data()).unwrap();
    assert_eq!(result["permissions"], customer["permissions"]);
    assert_eq!(
        result["env"],
        json!({"CUSTOMER":"keep","LOONGSUITE_PILOT_DATA_DIR":f.data()})
    );
    assert_eq!(result["hooks"]["Stop"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["hooks"]["Stop"][0]["hooks"],
        json!([customer["hooks"]["Stop"][0]["hooks"][1]])
    );
    for event in &f.hook.events {
        assert!(result["hooks"].get(event).is_some());
    }
    assert_eq!(
        merge_claude_hooks(&result, &f.hook, f.data()).unwrap(),
        result
    );
    assert_eq!(customer, before);
}
#[tokio::test]
async fn source_l70_unchanged_injection_preserves_raw_bytes_mtime_and_mode() {
    let f = Fixture::new();
    let dir = f.dir("session");
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("settings.json");
    std::fs::write(&file, r#"{"env":{"CUSTOM":"value"}}"#).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(f.inject(&dir).await["status"], "updated");
    let before = std::fs::metadata(&file).unwrap();
    let bytes = std::fs::read(&file).unwrap();
    assert_eq!(f.inject(&dir).await["status"], "unchanged");
    let after = std::fs::metadata(&file).unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    assert_eq!(after.modified().unwrap(), before.modified().unwrap());
    assert_eq!(after.permissions().mode() & 0o777, 0o640);
}
#[tokio::test]
async fn source_l83_shell_sensitive_hook_path_runs_only_script_and_literal_stop() {
    let mut f = Fixture::new();
    let scripts = f.dir("space ' $(touch should-not-exist)");
    std::fs::create_dir(&scripts).unwrap();
    let script = scripts.join("claude-code-loongsuite-pilot-hook.sh");
    std::fs::write(&script, "#!/bin/sh\nprintf '%s' \"$1\"\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.hook.hook_command = script.to_string_lossy().into_owned();
    let result = merge_claude_hooks(&json!({}), &f.hook, f.data()).unwrap();
    let output = tokio::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(
            result["hooks"]["Stop"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap(),
        )
        .current_dir(&f.root)
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"stop");
    assert!(!f.root.join("should-not-exist").exists());
}
#[tokio::test]
async fn source_l93_different_directories_keep_their_independent_session_values() {
    let f = Fixture::new();
    let run = |name: &'static str| {
        let f = &f;
        async move {
            let dir = f.dir(name);
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(
                dir.join("settings.json"),
                json!({"env":{"SESSION":name}}).to_string(),
            )
            .unwrap();
            f.inject(&dir).await;
            assert_eq!(read(dir.join("settings.json"))["env"]["SESSION"], name);
        }
    };
    tokio::join!(run("a"), run("b"));
}
#[tokio::test]
async fn source_l101_twelve_callers_and_directory_aliases_have_one_updated_result_and_one_group_per_event(
) {
    let f = Fixture::new();
    let dir = f.dir("session");
    std::fs::create_dir(&dir).unwrap();
    let alias = f.dir("alias");
    symlink(&dir, &alias).unwrap();
    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..12 {
        let dir = if i % 2 == 0 {
            dir.clone()
        } else {
            alias.clone()
        };
        let hook = f.hook.clone();
        let data = f.data().to_string();
        tasks.spawn(async move {
            inject_claude_directory(dir.to_str().unwrap(), &data, &hook)
                .await
                .unwrap()
        });
    }
    let mut updated = 0;
    while let Some(result) = tasks.join_next().await {
        if result.unwrap()["status"] == "updated" {
            updated += 1;
        }
    }
    assert_eq!(updated, 1);
    let settings = read(dir.join("settings.json"));
    for event in &f.hook.events {
        assert_eq!(settings["hooks"][event].as_array().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn source_l110_bad_json_and_linked_settings_are_rejected_without_touching_any_bytes() {
    let f = Fixture::new();
    let dir = f.dir("session");
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("settings.json");
    std::fs::write(&file, "{broken").unwrap();
    assert!(
        inject_claude_directory(dir.to_str().unwrap(), f.data(), &f.hook)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&file).unwrap(), b"{broken");
    let original = f.dir("original");
    std::fs::rename(&file, &original).unwrap();
    symlink(&original, &file).unwrap();
    let error = inject_claude_directory(dir.to_str().unwrap(), f.data(), &f.hook)
        .await
        .unwrap_err();
    assert!(error.contains("non-linked"), "{error}");
    assert_eq!(std::fs::read(&original).unwrap(), b"{broken");
    assert!(std::fs::symlink_metadata(&file)
        .unwrap()
        .file_type()
        .is_symlink());
}
#[tokio::test]
async fn source_l120_explicit_short_timeout_preserves_live_lock_and_never_creates_settings() {
    let f = Fixture::new();
    let dir = f.dir("session");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join(".loongsuite-pilot-inject.lock");
    let result = crate::utils::acquire_single_instance_lock(path.to_str().unwrap(), None);
    let lock = result.lock.unwrap();
    let before = std::fs::read(&path).unwrap();
    let error =
        inject_claude_directory_with_lock_timeout(dir.to_str().unwrap(), f.data(), &f.hook, 30)
            .await
            .unwrap_err();
    assert!(error.contains("lock"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!dir.join("settings.json").exists());
    lock.release();
}
#[test]
fn source_l127_all_original_malformed_or_hook_disabling_policies_are_rejected() {
    let f = Fixture::new();
    for settings in [
        json!({"hooks":[]}),
        json!({"env":[]}),
        json!({"hooks":{"Stop":{}}}),
        json!({"disableAllHooks":true}),
    ] {
        assert!(
            merge_claude_hooks(&settings, &f.hook, f.data()).is_err(),
            "{settings}"
        );
    }
}
#[tokio::test]
async fn native_inject_history_worker() {
    let Ok(encoded) = std::env::var("PILOT_INJECT_HISTORY_WORKER") else {
        return;
    };
    let args: Value = serde_json::from_str(&encoded).unwrap();
    let hook: AgentHookConfig = serde_json::from_value(args["hook"].clone()).unwrap();
    let result = inject_claude_directory(
        args["dir"].as_str().unwrap(),
        args["data"].as_str().unwrap(),
        &hook,
    )
    .await
    .unwrap();
    println!("PILOT_INJECT_RESULT={result}");
}
#[tokio::test]
async fn source_l132_eight_independent_native_processes_merge_once_without_deployment_state() {
    let f = Fixture::new();
    let dir = f.dir("process-session");
    let encoded = json!({"dir":dir,"data":f.data(),"hook":f.hook}).to_string();
    let executable = std::env::current_exe().unwrap();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let mut command = tokio::process::Command::new(&executable);
        command
            .args([
                "--exact",
                "deployment::inject_command::history_contract_tests::native_inject_history_worker",
                "--nocapture",
            ])
            .env_clear()
            .env("HOME", &f.root)
            .env("USERPROFILE", &f.root)
            .env("PILOT_INJECT_HISTORY_WORKER", &encoded)
            .current_dir(&f.root)
            .kill_on_drop(true);
        tasks.spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
                .await
                .unwrap()
                .unwrap()
        });
    }
    let mut updated = 0;
    while let Some(output) = tasks.join_next().await {
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let out = String::from_utf8(output.stdout).unwrap();
        let value: Value = serde_json::from_str(
            out.lines()
                .find_map(|line| {
                    line.split_once("PILOT_INJECT_RESULT=")
                        .map(|(_, payload)| payload)
                })
                .unwrap(),
        )
        .unwrap();
        if value["status"] == "updated" {
            updated += 1;
        }
    }
    assert_eq!(updated, 1);
    let settings = read(dir.join("settings.json"));
    for event in &f.hook.events {
        assert_eq!(settings["hooks"][event].as_array().unwrap().len(), 1);
    }
    assert!(!f.root.join("deployed-agents.json").exists());
}
