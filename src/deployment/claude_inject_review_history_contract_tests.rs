//! Exact fixed Claude inject review regressions using real Native writers and isolated lock seams.
use super::*;
use crate::deployment::HookStrategy;
use crate::hooks::claude_settings_history_test_hooks as lock_hooks;
use crate::utils::single_instance_lock::history_test_hooks as io_hooks;
use crate::{
    hooks::{with_claude_settings_lock, HookDefinition, HookManager},
    types::{AgentDefinition, DeployStrategy},
};
use serde_json::json;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    def: AgentDefinition,
}
impl Fixture {
    fn new(suffix: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let scripts = root.join(suffix);
        std::fs::create_dir(&scripts).unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/claude-code.json")).unwrap();
        let hook = def.hook.as_mut().unwrap();
        hook.hook_command = scripts
            .join("claude-code-loongsuite-pilot-hook.sh")
            .to_string_lossy()
            .into_owned();
        hook.settings_path = root
            .join("session/settings.json")
            .to_string_lossy()
            .into_owned();
        hook.env = Some(serde_json::from_value(json!({"DEPLOY_ENV":"kept"})).unwrap());
        std::fs::write(&hook.hook_command, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&hook.hook_command, std::fs::Permissions::from_mode(0o700))
            .unwrap();
        Self {
            _root: temp,
            root,
            def,
        }
    }
    fn hook(&self) -> &AgentHookConfig {
        self.def.hook.as_ref().unwrap()
    }
    fn dir(&self) -> PathBuf {
        self.root.join("session")
    }
    fn manager(&self) -> HookManager {
        HookManager::new(
            Some(self.root.to_string_lossy().into_owned()),
            Some(self.root.join("logs").to_string_lossy().into_owned()),
        )
    }
    fn strategy(&self) -> HookStrategy {
        HookStrategy::new(self.manager())
    }
    fn write(&self, value: Value) {
        std::fs::create_dir_all(self.dir()).unwrap();
        std::fs::write(&self.hook().settings_path, value.to_string()).unwrap();
    }
    fn read(&self) -> Value {
        serde_json::from_slice(&std::fs::read(&self.hook().settings_path).unwrap()).unwrap()
    }
    async fn inject(&self) -> Value {
        inject_claude_directory(
            self.dir().to_str().unwrap(),
            self.root.to_str().unwrap(),
            self.hook(),
        )
        .await
        .unwrap()
    }
    fn first_definition(&self) -> HookDefinition {
        let hook = self.hook();
        HookDefinition {
            agent_id: "claude-code".into(),
            settings_path: hook.settings_path.clone(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), "PreToolUse".into()],
            hook_command: format!(
                "{} pre-tool-use",
                crate::hooks::quote_claude_hook_path(&hook.hook_command)
            ),
            matcher: Some("Bash".into()),
            exec_args: None,
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: Some(true),
            shell: None,
            timeout: None,
            insert: None,
        }
    }
}
#[tokio::test]
async fn source_l34_all_three_sensitive_paths_share_injection_deploy_repair_and_customer_preserving_cleanup(
) {
    for suffix in ["中文", "with space", "with ' quote"] {
        let f = Fixture::new(suffix);
        let customer = json!({"type":"command","command":"echo customer"});
        let legacy = format!("{} stop", f.hook().hook_command);
        f.write(json!({"permissions":{"allow":["Read"]},"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":legacy},customer]}]}}));
        f.inject().await;
        let strategy = f.strategy();
        assert!(!strategy.needs_deploy(&f.def, None).await, "{suffix}");
        let mut settings = f.read();
        settings["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(json!({"hooks":[{"type":"command","command":legacy}]}));
        f.write(settings);
        assert!(strategy.needs_deploy(&f.def, None).await, "{suffix}");
        let result = strategy.deploy(&f.def).await;
        assert!(result.success, "{suffix}: {:?}", result.error);
        assert!(!strategy.needs_deploy(&f.def, None).await, "{suffix}");
        let fixed = f.read();
        assert_eq!(
            fixed["hooks"]["Stop"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g["hooks"].as_array().unwrap().len())
                .sum::<usize>(),
            2
        );
        assert_eq!(f.inject().await["status"], "unchanged", "{suffix}");
        assert!(strategy.undeploy(&f.def).await, "{suffix}");
        let removed = f.read();
        let handlers: Vec<_> = removed["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().iter())
            .cloned()
            .collect();
        assert_eq!(handlers, vec![customer]);
        assert_eq!(removed["permissions"], json!({"allow":["Read"]}));
    }
}
#[tokio::test]
async fn source_l64_actual_install_env_and_uninstall_writers_hold_alias_injection_until_released() {
    for operation in ["install", "env", "uninstall"] {
        let f = Fixture::new("scripts");
        std::fs::create_dir_all(f.dir()).unwrap();
        let alias = f.root.join("alias");
        symlink(f.dir(), &alias).unwrap();
        if operation == "uninstall" {
            f.inject().await;
        } else {
            f.write(json!({"customer":true}));
        }
        let reached = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let plan = lock_hooks::Plan::pause(
            f.dir().join(".loongsuite-pilot-inject.lock"),
            reached.clone(),
            release.clone(),
        );
        let manager = f.manager();
        let strategy = f.strategy();
        let definition = f.first_definition();
        let def = f.def.clone();
        let writer = tokio::spawn(lock_hooks::scope(plan, async move {
            match operation {
                "install" => manager.install_hook(&definition).await,
                "uninstall" => manager.uninstall_hook(&definition).await,
                _ => strategy.deploy(&def).await.success,
            }
        }));
        tokio::time::timeout(Duration::from_secs(2), reached.notified())
            .await
            .unwrap();
        let hook = f.hook().clone();
        let data = f.root.to_string_lossy().into_owned();
        let injection = tokio::spawn(async move {
            inject_claude_directory(alias.to_str().unwrap(), &data, &hook).await
        });
        tokio::time::sleep(Duration::from_millis(60)).await;
        let blocked = !injection.is_finished();
        release.notify_one();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), writer)
                .await
                .unwrap()
                .unwrap(),
            "{operation}"
        );
        tokio::time::timeout(Duration::from_secs(2), injection)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            blocked,
            "injection must wait behind the actual {operation} writer"
        );
        let result = f.read();
        for event in &f.hook().events {
            assert_eq!(
                result["hooks"][event].as_array().unwrap().len(),
                1,
                "{operation}/{event}"
            );
        }
        assert_eq!(
            Path::new(result["env"]["LOONGSUITE_PILOT_DATA_DIR"].as_str().unwrap()),
            f.root
        );
        if operation == "env" {
            assert_eq!(result["env"]["DEPLOY_ENV"], "kept");
        }
        if operation != "uninstall" {
            assert_eq!(result["customer"], true);
        }
    }
}
#[tokio::test]
async fn source_l96_all_three_real_io_error_values_are_preserved_without_polling_or_entering_writer(
) {
    for code in [libc::EACCES, libc::EROFS, libc::ENOSPC] {
        let f = Fixture::new("scripts");
        std::fs::create_dir_all(f.dir()).unwrap();
        let path = f.root.join("test.lock");
        let plan = io_hooks::Plan::new(path.clone(), code);
        let result = io_hooks::scope(plan.clone(), async {
            crate::utils::acquire_single_instance_lock(path.to_str().unwrap(), None)
        })
        .await;
        assert!(result.lock.is_none());
        assert_eq!(result.error.unwrap().raw_os_error(), Some(code));
        assert_eq!(plan.calls.load(Ordering::SeqCst), 1);
        let lock = f.dir().join(".loongsuite-pilot-inject.lock");
        let plan = io_hooks::Plan::new(lock, code);
        let writes = AtomicUsize::new(0);
        let result = io_hooks::scope(
            plan.clone(),
            crate::hooks::with_claude_settings_lock_checked(
                &f.hook().settings_path,
                || async {
                    writes.fetch_add(1, Ordering::SeqCst);
                },
                10_000,
            ),
        )
        .await;
        let error = result.unwrap_err();
        assert!(matches!(
            &error,
            crate::hooks::ClaudeSettingsLockError::Io(_)
        ));
        assert_eq!(error.raw_os_error(), Some(code));
        let cause = std::error::Error::source(&error)
            .unwrap()
            .downcast_ref::<std::io::Error>()
            .unwrap();
        assert_eq!(cause.raw_os_error(), Some(code));
        assert_eq!(
            error.to_string(),
            std::io::Error::from_raw_os_error(code).to_string()
        );
        assert_eq!(plan.calls.load(Ordering::SeqCst), 1);
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        let compatibility_plan =
            io_hooks::Plan::new(f.dir().join(".loongsuite-pilot-inject.lock"), code);
        let compatibility = io_hooks::scope(
            compatibility_plan.clone(),
            with_claude_settings_lock(&f.hook().settings_path, || async {}, 10_000),
        )
        .await
        .unwrap_err();
        assert_eq!(compatibility, error.to_string());
        assert_eq!(compatibility_plan.calls.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn source_l106_unowned_recovery_race_retries_then_acquires_real_lock_and_runs_once() {
    let f = Fixture::new("scripts");
    let plan = lock_hooks::Plan::retry_once();
    let entered = AtomicUsize::new(0);
    let result = lock_hooks::scope(
        plan.clone(),
        with_claude_settings_lock(
            &f.hook().settings_path,
            || async {
                entered.fetch_add(1, Ordering::SeqCst);
                assert!(f.dir().join(".loongsuite-pilot-inject.lock").is_file());
                "ok"
            },
            10_000,
        ),
    )
    .await
    .unwrap();
    assert_eq!(result, "ok");
    assert_eq!(plan.calls(), 2);
    assert_eq!(entered.load(Ordering::SeqCst), 1);
    assert!(!f.dir().join(".loongsuite-pilot-inject.lock").exists());
}

#[tokio::test]
async fn native_checked_lock_distinguishes_real_contention_and_compatibility_message() {
    let f = Fixture::new("scripts");
    std::fs::create_dir_all(f.dir()).unwrap();
    let path = f.dir().join(".loongsuite-pilot-inject.lock");
    let held = crate::utils::acquire_single_instance_lock(path.to_str().unwrap(), None)
        .lock
        .unwrap();
    let error =
        crate::hooks::with_claude_settings_lock_checked(&f.hook().settings_path, || async {}, 0)
            .await
            .unwrap_err();
    assert!(matches!(error, crate::hooks::ClaudeSettingsLockError::Busy));
    assert_eq!(error.raw_os_error(), None);
    assert!(std::error::Error::source(&error).is_none());
    assert_eq!(
        error.to_string(),
        "Cannot acquire configuration lock (busy)"
    );
    assert_eq!(
        with_claude_settings_lock(&f.hook().settings_path, || async {}, 0)
            .await
            .unwrap_err(),
        error.to_string()
    );
    held.release();
}

#[tokio::test]
async fn native_actual_abort_releases_owned_lock_for_both_checked_and_string_callbacks() {
    for checked in [true, false] {
        let f = Fixture::new("scripts");
        let reached = Arc::new(Notify::new());
        let notify = reached.clone();
        let settings = f.hook().settings_path.clone();
        let task = tokio::spawn(async move {
            let update = || async move {
                notify.notify_one();
                std::future::pending::<()>().await;
            };
            if checked {
                crate::hooks::with_claude_settings_lock_checked(&settings, update, 10_000)
                    .await
                    .map_err(|e| e.to_string())
            } else {
                with_claude_settings_lock(&settings, update, 10_000).await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), reached.notified())
            .await
            .unwrap();
        let path = f.dir().join(".loongsuite-pilot-inject.lock");
        assert!(path.is_file());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(
            !path.exists(),
            "aborted callback must release actual owned lock; checked={checked}"
        );
        let next = crate::utils::acquire_single_instance_lock(path.to_str().unwrap(), None)
            .lock
            .unwrap();
        next.release();
        assert!(!path.exists());
    }
}
#[tokio::test]
async fn native_aborting_a_waiter_never_releases_the_actual_live_holder_or_enters_callback() {
    let f = Fixture::new("scripts");
    std::fs::create_dir_all(f.dir()).unwrap();
    let path = f.dir().join(".loongsuite-pilot-inject.lock");
    let held = crate::utils::acquire_single_instance_lock(path.to_str().unwrap(), None)
        .lock
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    let entered = Arc::new(AtomicUsize::new(0));
    let callback = entered.clone();
    let settings = f.hook().settings_path.clone();
    let task = tokio::spawn(async move {
        crate::hooks::with_claude_settings_lock_checked(
            &settings,
            || async move {
                callback.fetch_add(1, Ordering::SeqCst);
            },
            10_000,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(entered.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(
        crate::utils::acquire_single_instance_lock(path.to_str().unwrap(), None)
            .lock
            .is_none()
    );
    held.release();
    assert!(!path.exists());
}
#[tokio::test]
async fn native_aborted_owner_never_unlinks_a_replaced_foreign_record_even_with_same_pid_and_birth()
{
    let f = Fixture::new("scripts");
    let reached = Arc::new(Notify::new());
    let notify = reached.clone();
    let settings = f.hook().settings_path.clone();
    let task = tokio::spawn(async move {
        crate::hooks::with_claude_settings_lock_checked(
            &settings,
            || async move {
                notify.notify_one();
                std::future::pending::<()>().await;
            },
            10_000,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), reached.notified())
        .await
        .unwrap();
    let path = f.dir().join(".loongsuite-pilot-inject.lock");
    let mut foreign: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(foreign["pid"], std::process::id());
    foreign["ownerId"] = Value::String(format!("foreign-{}", uuid::Uuid::new_v4()));
    let replacement = serde_json::to_vec(&foreign).unwrap();
    std::fs::write(&path, &replacement).unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(std::fs::read(&path).unwrap(), replacement);
    // Only the synthetic fixture owns cleanup of this deliberately foreign record.
    std::fs::remove_file(path).unwrap();
}
