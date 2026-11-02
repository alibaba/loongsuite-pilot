use super::history_test_hooks::{calls, scope, Call, Mode};
use super::*;
use crate::types::DeployStrategy;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    source: PathBuf,
    target: PathBuf,
    data: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let source = root.join("source");
        let target = root.join("plugins/loongsuite-pilot");
        let data = root.join("pilot-data");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("plugin.yaml"), "name: loongsuite-pilot\n").unwrap();
        std::fs::write(source.join("nested/plugin.py"), "VERSION = 1\n").unwrap();
        Self {
            _temp: temp,
            root,
            source,
            target,
            data,
        }
    }
    fn def(&self) -> AgentDefinition {
        serde_json::from_value(
            json!({"id":"hermes-agent","displayName":"Hermes Agent","deployMode":"directory-plugin",
            "detection":{"paths":[self.root.join("missing-agent")],"commands":[]},
            "directoryPlugin":{"sourceDir":self.source,"targetDir":self.target}}),
        )
        .unwrap()
    }
    fn strategy(&self) -> DirectoryPluginStrategy {
        DirectoryPluginStrategy::new(Some(self.data.to_string_lossy().into_owned()))
    }
    fn marker(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.target.join(DEFAULT_MARKER_FILE)).unwrap())
            .unwrap()
    }
    fn activated(&self) -> AgentDefinition {
        let mut def = self.def();
        def.directory_plugin.as_mut().unwrap().activation = Some(DirectoryPluginActivationConfig {
            command: "/opt/hermes/bin/hermes".into(),
            probe_args: Some(vec!["plugins".into(), "enable".into(), "--help".into()]),
            enable_args: vec!["plugins".into(), "enable".into(), "loongsuite-pilot".into()],
            disable_args: Some(vec![
                "plugins".into(),
                "disable".into(),
                "loongsuite-pilot".into(),
            ]),
            optional_enable_args: None,
            timeout_ms: None,
        });
        def
    }
}
fn digest(value: &Value) {
    assert!(regex::Regex::new(r"^sha256:[0-9a-f]{64}$")
        .unwrap()
        .is_match(value.as_str().unwrap()));
}
fn args(calls: &[Call]) -> Vec<Vec<String>> {
    calls.iter().map(|c| c.args.clone()).collect()
}
#[tokio::test]
async fn source_l79_actual_absent_detection_returns_false_and_present_path_is_delegated() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(!strategy.detect(&def).await);
    std::fs::create_dir(f.root.join("missing-agent")).unwrap();
    assert!(strategy.detect(&def).await);
}
#[tokio::test]
async fn source_l87_real_directory_copy_has_exact_files_and_complete_ownership_marker() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.needs_deploy(&def, None).await);
    let result = strategy.deploy(&def).await;
    assert!(result.success);
    assert_eq!(result.agent_id, "hermes-agent");
    assert_eq!(result.deploy_mode, DeployMode::DirectoryPlugin);
    assert_eq!(
        std::fs::read_to_string(f.target.join("plugin.yaml")).unwrap(),
        "name: loongsuite-pilot\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.target.join("nested/plugin.py")).unwrap(),
        "VERSION = 1\n"
    );
    let marker = f.marker();
    assert_eq!(marker["schemaVersion"], 1);
    assert_eq!(marker["owner"], "loongsuite-pilot");
    assert_eq!(marker["agentId"], "hermes-agent");
    digest(&marker["sourceHash"]);
    let path = |s: &str| s.replace('\\', "/").trim_start_matches("//?/").to_owned();
    assert_eq!(
        path(marker["dataDir"].as_str().unwrap()),
        path(f.data.to_str().unwrap())
    );
}
#[tokio::test]
async fn source_l110_supported_activation_records_probe_enable_hash_health_and_disable_order() {
    let f = Fixture::new();
    let def = f.activated();
    let strategy = DirectoryPluginStrategy::new(None);
    scope(Some(Mode::Success("")), false, async {
        assert!(strategy.deploy(&def).await.success);
        assert_eq!(
            args(&calls()),
            vec![
                vec!["plugins", "enable", "--help"],
                vec!["plugins", "enable", "loongsuite-pilot"]
            ]
        );
        digest(&f.marker()["activationHash"]);
        assert!(!strategy.needs_deploy(&def, None).await);
        assert!(strategy.undeploy(&def).await);
        let log = calls();
        assert_eq!(
            args(&log[log.len() - 2..]),
            vec![
                vec!["plugins", "enable", "--help"],
                vec!["plugins", "disable", "loongsuite-pilot"]
            ]
        );
    })
    .await;
}
#[tokio::test]
async fn source_l141_optional_argument_only_appended_when_help_advertises_it() {
    let f = Fixture::new();
    let mut def = f.activated();
    def.directory_plugin
        .as_mut()
        .unwrap()
        .activation
        .as_mut()
        .unwrap()
        .optional_enable_args = Some(vec!["--no-allow-tool-override".into()]);
    for (help, expected) in [
        (
            "usage: hermes plugins enable [--no-allow-tool-override] name",
            vec![
                "plugins",
                "enable",
                "loongsuite-pilot",
                "--no-allow-tool-override",
            ],
        ),
        (
            "usage: hermes plugins enable [-h] name",
            vec!["plugins", "enable", "loongsuite-pilot"],
        ),
    ] {
        scope(Some(Mode::Success(help)), false, async {
            assert!(
                DirectoryPluginStrategy::new(None)
                    .deploy(&def)
                    .await
                    .success
            );
            assert_eq!(calls().last().unwrap().args, expected);
        })
        .await;
    }
}
#[tokio::test]
async fn source_l176_unsupported_activation_records_hash_status_and_health_without_enable() {
    let f = Fixture::new();
    let def = f.activated();
    let strategy = DirectoryPluginStrategy::new(None);
    scope(Some(Mode::Unsupported), false, async {
        assert!(strategy.deploy(&def).await.success);
        assert_eq!(args(&calls()), vec![vec!["plugins", "enable", "--help"]]);
        let marker = f.marker();
        digest(&marker["activationHash"]);
        assert_eq!(marker["activationStatus"], "unsupported");
        assert!(!strategy.needs_deploy(&def, None).await);
    })
    .await;
}
#[tokio::test]
async fn source_l224_configured_45000_timeout_reaches_both_probe_and_enable() {
    let f = Fixture::new();
    let mut def = f.activated();
    def.directory_plugin
        .as_mut()
        .unwrap()
        .activation
        .as_mut()
        .unwrap()
        .timeout_ms = Some(45000);
    scope(Some(Mode::Success("")), false, async {
        assert!(
            DirectoryPluginStrategy::new(None)
                .deploy(&def)
                .await
                .success
        );
        assert_eq!(
            calls(),
            vec![
                Call {
                    command: "/opt/hermes/bin/hermes".into(),
                    args: vec!["plugins".into(), "enable".into(), "--help".into()],
                    timeout_ms: 45000
                },
                Call {
                    command: "/opt/hermes/bin/hermes".into(),
                    args: vec!["plugins".into(), "enable".into(), "loongsuite-pilot".into()],
                    timeout_ms: 45000
                }
            ]
        );
    })
    .await;
}
#[tokio::test]
async fn source_l267_repeated_unchanged_managed_deployment_preserves_exact_marker() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    let first = f.marker();
    assert!(!strategy.needs_deploy(&def, None).await);
    assert!(strategy.deploy(&def).await.success);
    assert!(!strategy.needs_deploy(&def, None).await);
    assert_eq!(f.marker(), first);
}
#[tokio::test]
async fn source_l291_python_runtime_bytecode_added_to_target_is_not_source_tampering() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    std::fs::create_dir_all(f.target.join("nested/__pycache__")).unwrap();
    for (path, bytes) in [
        ("nested/__pycache__/plugin.cpython-312.pyc", "bytecode\n"),
        ("legacy.pyc", "legacy bytecode\n"),
        ("optimized.pyo", "optimized bytecode\n"),
    ] {
        std::fs::write(f.target.join(path), bytes).unwrap();
    }
    assert!(!strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn source_l304_ordinary_file_inside_runtime_cache_directory_remains_tampering() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    std::fs::create_dir_all(f.target.join("nested/__pycache__")).unwrap();
    std::fs::write(
        f.target.join("nested/__pycache__/unexpected.txt"),
        "unexpected\n",
    )
    .unwrap();
    assert!(strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn source_l315_source_managed_bytecode_is_not_exempt_from_tampering_checks() {
    let f = Fixture::new();
    std::fs::write(f.source.join("managed.pyc"), "managed bytecode\n").unwrap();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    std::fs::write(f.target.join("managed.pyc"), "tampered bytecode\n").unwrap();
    assert!(strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn source_l325_new_source_version_replaces_exact_files_and_changes_source_hash() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    let old = f.marker()["sourceHash"].clone();
    std::fs::write(f.source.join("nested/plugin.py"), "VERSION = 2\n").unwrap();
    std::fs::write(f.source.join("new-module.py"), "ENABLED = True\n").unwrap();
    assert!(strategy.needs_deploy(&def, None).await);
    assert!(strategy.deploy(&def).await.success);
    assert_eq!(
        std::fs::read_to_string(f.target.join("nested/plugin.py")).unwrap(),
        "VERSION = 2\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.target.join("new-module.py")).unwrap(),
        "ENABLED = True\n"
    );
    assert_ne!(f.marker()["sourceHash"], old);
    assert!(!strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn source_l343_owned_content_tampering_and_unexpected_files_are_repaired_from_source() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    std::fs::write(f.target.join("nested/plugin.py"), "TAMPERED = True\n").unwrap();
    std::fs::write(f.target.join("unexpected.py"), "unexpected\n").unwrap();
    assert!(strategy.needs_deploy(&def, None).await);
    assert!(strategy.deploy(&def).await.success);
    assert_eq!(
        std::fs::read_to_string(f.target.join("nested/plugin.py")).unwrap(),
        "VERSION = 1\n"
    );
    assert!(!f.target.join("unexpected.py").exists());
    assert!(!strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn source_l360_unmanaged_nonempty_target_is_never_overwritten() {
    let f = Fixture::new();
    let def = f.def();
    std::fs::create_dir_all(&f.target).unwrap();
    std::fs::write(f.target.join("user-plugin.py"), "keep me\n").unwrap();
    let strategy = f.strategy();
    assert!(strategy.needs_deploy(&def, None).await);
    let result = strategy.deploy(&def).await;
    assert!(!result.success);
    assert_eq!(result.agent_id, "hermes-agent");
    assert_eq!(result.deploy_mode, DeployMode::DirectoryPlugin);
    assert!(result
        .error
        .unwrap()
        .contains("refusing to overwrite unmanaged non-empty directory"));
    assert_eq!(
        std::fs::read_to_string(f.target.join("user-plugin.py")).unwrap(),
        "keep me\n"
    );
}
#[tokio::test]
async fn source_l377_uninstall_requires_same_agent_marker_and_is_idempotent_when_missing() {
    let f = Fixture::new();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    let mut other = def.clone();
    other.id = "other-agent".into();
    assert!(!strategy.undeploy(&other).await);
    assert!(f.target.exists());
    assert!(strategy.undeploy(&def).await);
    assert!(!f.target.exists());
    assert!(strategy.undeploy(&def).await);
}
#[tokio::test]
async fn source_l390_invalid_schema_marker_is_unmanaged_and_user_file_stays_unchanged() {
    let f = Fixture::new();
    let def = f.def();
    std::fs::create_dir_all(&f.target).unwrap();
    std::fs::write(f.target.join("user-plugin.py"), "keep me\n").unwrap();
    std::fs::write(f.target.join(DEFAULT_MARKER_FILE),json!({"schemaVersion":99,"owner":"loongsuite-pilot","agentId":"hermes-agent","sourceHash":format!("sha256:{}","0".repeat(64))}).to_string()).unwrap();
    let strategy = f.strategy();
    assert!(strategy.needs_deploy(&def, None).await);
    assert!(!strategy.deploy(&def).await.success);
    assert!(!strategy.undeploy(&def).await);
    assert_eq!(
        std::fs::read_to_string(f.target.join("user-plugin.py")).unwrap(),
        "keep me\n"
    );
}
#[tokio::test]
async fn source_l408_existing_empty_target_accepts_first_deploy_and_becomes_healthy() {
    let f = Fixture::new();
    std::fs::create_dir_all(&f.target).unwrap();
    let def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    assert!(!strategy.needs_deploy(&def, None).await);
}
#[tokio::test]
async fn source_l416_copy_failure_removes_all_temporary_staging_directories() {
    let f = Fixture::new();
    let def = f.def();
    scope(None, true, async {
        let result = DirectoryPluginStrategy::new(None).deploy(&def).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("copy failed"));
        assert!(std::fs::read_dir(f.target.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".loongsuite-pilot.loongsuite-pilot-")));
    })
    .await;
}

#[tokio::test]
async fn source_l205_probe_timeout_keeps_a_pending_marker_without_activation_hash() {
    let f = Fixture::new();
    let def = f.activated();
    let strategy = DirectoryPluginStrategy::new(None);
    scope(Some(Mode::Timeout), false, async {
        let result = strategy.deploy(&def).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("probe timed out"));
        assert!(strategy.needs_deploy(&def, None).await);
        assert!(
            f.target.join(DEFAULT_MARKER_FILE).is_file(),
            "original pending-marker contract is absent after timeout"
        );
        assert!(f.marker().get("activationHash").is_none());
    })
    .await;
}
#[tokio::test]
async fn source_l247_supported_enable_failure_keeps_a_pending_marker_without_activation_hash() {
    let f = Fixture::new();
    let def = f.activated();
    let strategy = DirectoryPluginStrategy::new(None);
    scope(Some(Mode::EnableFailure), false, async {
        let result = strategy.deploy(&def).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("enable failed"));
        assert!(strategy.needs_deploy(&def, None).await);
        assert!(
            f.target.join(DEFAULT_MARKER_FILE).is_file(),
            "original pending-marker contract is absent after rejected enablement"
        );
        assert!(f.marker().get("activationHash").is_none());
    })
    .await;
}

use super::history_test_hooks::{paused_scope, Pause};
use std::sync::Arc;
struct ReleaseOnDrop(Arc<Pause>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}
fn assert_initial_sdk_state(f: &Fixture, initial: &str) {
    if initial == "missing" {
        assert!(!f.target.exists());
    } else {
        assert_eq!(std::fs::read_dir(&f.target).unwrap().count(), 0);
    }
}
fn no_pending_stages(f: &Fixture) -> bool {
    std::fs::read_dir(f.target.parent().unwrap())
        .unwrap()
        .all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".loongsuite-pilot.loongsuite-pilot-pending-")
        })
}
#[tokio::test]
async fn native_initial_failures_publish_only_valid_pending_metadata_and_retry_actual_sdk_install()
{
    for initial in ["missing", "empty"] {
        for mode in [Mode::Timeout, Mode::EnableFailure] {
            let f = Fixture::new();
            if initial == "empty" {
                std::fs::create_dir_all(&f.target).unwrap();
            }
            let def = f.activated();
            let strategy = f.strategy();
            scope(Some(mode), false, async {
                assert!(!strategy.deploy(&def).await.success);
                let names = std::fs::read_dir(&f.target)
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                assert_eq!(names, vec![DEFAULT_MARKER_FILE]);
                let marker = f.marker();
                assert_eq!(marker["schemaVersion"], 1);
                assert_eq!(marker["owner"], "loongsuite-pilot");
                assert_eq!(marker["agentId"], "hermes-agent");
                digest(&marker["sourceHash"]);
                assert!(marker.get("activationHash").is_none());
                assert!(marker.get("activationStatus").is_none());
                assert!(strategy.needs_deploy(&def, None).await);
                assert!(no_pending_stages(&f));
            })
            .await;
            scope(Some(Mode::Success("")), false, async {
                assert!(strategy.deploy(&def).await.success);
                assert!(!strategy.needs_deploy(&def, None).await);
                assert_eq!(
                    std::fs::read_to_string(f.target.join("plugin.yaml")).unwrap(),
                    "name: loongsuite-pilot\n"
                );
                assert_eq!(
                    std::fs::read_to_string(f.target.join("nested/plugin.py")).unwrap(),
                    "VERSION = 1\n"
                );
                digest(&f.marker()["activationHash"]);
            })
            .await;
        }
    }
}
#[tokio::test]
async fn native_managed_activation_failure_restores_original_marker_sdk_and_user_additions_exactly()
{
    let f = Fixture::new();
    let mut def = f.def();
    let strategy = f.strategy();
    assert!(strategy.deploy(&def).await.success);
    std::fs::write(
        f.target.join("user-added.txt"),
        "keep existing managed addition\n",
    )
    .unwrap();
    let marker = std::fs::read(f.target.join(DEFAULT_MARKER_FILE)).unwrap();
    std::fs::write(f.source.join("nested/plugin.py"), "VERSION = 2\n").unwrap();
    def.directory_plugin.as_mut().unwrap().activation =
        f.activated().directory_plugin.unwrap().activation;
    scope(Some(Mode::Timeout), false, async {
        assert!(!strategy.deploy(&def).await.success);
        assert_eq!(
            std::fs::read(f.target.join(DEFAULT_MARKER_FILE)).unwrap(),
            marker
        );
        assert_eq!(
            std::fs::read_to_string(f.target.join("nested/plugin.py")).unwrap(),
            "VERSION = 1\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.target.join("user-added.txt")).unwrap(),
            "keep existing managed addition\n"
        );
        assert!(no_pending_stages(&f));
    })
    .await;
}
#[tokio::test]
async fn native_pending_publication_cancellation_restores_initial_target_before_and_after_install()
{
    for initial in ["missing", "empty"] {
        for phase in ["prepared", "installed"] {
            let f = Fixture::new();
            if initial == "empty" {
                std::fs::create_dir_all(&f.target).unwrap();
            }
            let def = f.activated();
            let strategy = f.strategy();
            let pause = Pause::new(phase);
            let release = ReleaseOnDrop(pause.clone());
            let worker_pause = pause.clone();
            let task = tokio::spawn(async move {
                paused_scope(Mode::Timeout, worker_pause, strategy.deploy(&def)).await
            });
            pause.reached().await;
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert_initial_sdk_state(&f, initial);
            assert!(no_pending_stages(&f));
            drop(release);
        }
    }
}
#[tokio::test]
async fn native_cancelled_blocking_metadata_writer_never_late_publishes_over_a_new_successful_install(
) {
    let f = Fixture::new();
    let def = f.activated();
    let retry_def = def.clone();
    let strategy = f.strategy();
    let pause = Pause::new("worker");
    let release = ReleaseOnDrop(pause.clone());
    let worker_pause = pause.clone();
    let task = tokio::spawn(async move {
        paused_scope(Mode::Timeout, worker_pause, strategy.deploy(&def)).await
    });
    pause.reached().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(!f.target.exists());
    scope(Some(Mode::Success("")), false, async {
        assert!(f.strategy().deploy(&retry_def).await.success);
    })
    .await;
    let marker = std::fs::read(f.target.join(DEFAULT_MARKER_FILE)).unwrap();
    pause.release();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !no_pending_stages(&f) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(f.target.join(DEFAULT_MARKER_FILE)).unwrap(),
        marker
    );
    assert_eq!(
        std::fs::read_to_string(f.target.join("nested/plugin.py")).unwrap(),
        "VERSION = 1\n"
    );
    drop(release);
}
#[tokio::test]
async fn native_unknown_target_appearing_after_rollback_is_never_adopted_by_pending_publication() {
    for initial in ["missing", "empty"] {
        let f = Fixture::new();
        if initial == "empty" {
            std::fs::create_dir_all(&f.target).unwrap();
        }
        let def = f.activated();
        let strategy = f.strategy();
        let pause = Pause::new("prepared");
        let release = ReleaseOnDrop(pause.clone());
        let worker_pause = pause.clone();
        let task = tokio::spawn(async move {
            paused_scope(Mode::Timeout, worker_pause, strategy.deploy(&def)).await
        });
        pause.reached().await;
        std::fs::create_dir_all(&f.target).unwrap();
        std::fs::write(f.target.join("foreign.txt"), "foreign after rollback\n").unwrap();
        pause.release();
        let result = task.await.unwrap();
        assert!(!result.success);
        assert!(result
            .error
            .unwrap()
            .contains("target directory changed before pending marker publication"));
        assert_eq!(
            std::fs::read_to_string(f.target.join("foreign.txt")).unwrap(),
            "foreign after rollback\n"
        );
        assert!(!f.target.join(DEFAULT_MARKER_FILE).exists());
        assert!(no_pending_stages(&f));
        drop(release);
    }
}
