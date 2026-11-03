use crate::deployment::{DeploymentManager, DeploymentManagerOptions};
use crate::utils::candidate_process::CandidateChild;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

#[path = "../../xtask/src/test_environment.rs"]
mod actual_baseline_environment;

const CHILD_ROOT: &str = "PILOT_TEST_ISOLATION_CHILD_ROOT";
const EXPECTED_HOME: &str = "PILOT_TEST_ISOLATION_EXPECTED_HOME";
const UNTRUSTED: &str = "PILOT_TEST_ISOLATION_UNTRUSTED";
const PREFIX: &str = "local_workers::deployment_isolation_history_contract_tests::";
const HOME_PROBE: &str =
    "local_workers::deployment_isolation_history_contract_tests::native_home_preworker_probe_fixture";
const BOUNDARY_PROBE: &str =
    "local_workers::deployment_isolation_history_contract_tests::actual_default_home_deployment_fixture";
const CORPORA: [&str; 6] = [
    "deployment::inject_command::",
    "deployment::deployment_manager::",
    "deployment::eager_injection::",
    "core::orchestrator::tests::",
    "core::orchestrator::watchdog_contract_tests::plugin_inject_history_contract_tests::",
    "deployment::agent_def_loader::isolated_home_history_contract_tests::",
];

#[derive(Debug, PartialEq, Eq)]
enum Snapshot {
    Directory,
    File {
        bytes: Vec<u8>,
        modified: SystemTime,
        readonly: bool,
        mode: Option<u32>,
    },
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Snapshot> {
    fn visit(root: &Path, relative: &Path, output: &mut BTreeMap<PathBuf, Snapshot>) {
        for entry in fs::read_dir(root.join(relative)).unwrap() {
            let entry = entry.unwrap();
            let path = relative.join(entry.file_name());
            let metadata = fs::symlink_metadata(entry.path()).unwrap();
            assert!(!metadata.file_type().is_symlink());
            if metadata.is_dir() {
                output.insert(path.clone(), Snapshot::Directory);
                visit(root, &path, output);
            } else {
                assert!(metadata.is_file());
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::MetadataExt;
                    Some(metadata.mode())
                };
                #[cfg(not(unix))]
                let mode = None;
                output.insert(
                    path,
                    Snapshot::File {
                        bytes: fs::read(entry.path()).unwrap(),
                        modified: metadata.modified().unwrap(),
                        readonly: metadata.permissions().readonly(),
                        mode,
                    },
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, Path::new(""), &mut result);
    result
}
fn legacy_launching_home(home: &Path) {
    let fixtures = [
        (
            ".claude/settings.json",
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"/legacy/otel-claude-hook stop"}]}]},"customer":"keep"}"#,
        ),
        (".claude/otel-config.json", "{}"),
        (
            ".codex/hooks.json",
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"/legacy/otel-codex-hook stop"}]}]}}"#,
        ),
        (".codex/config.toml", "[features]\ncodex_hooks = true\n"),
        (".codex/otel-config.json", "{}"),
        (
            ".cache/opentelemetry.instrumentation.claude/fixture.txt",
            "keep",
        ),
        (
            ".cache/opentelemetry.instrumentation.codex/fixture.txt",
            "keep",
        ),
        (".cursor/hooks.json", "{}"),
        (".grok/hooks/loongsuite-pilot.json", "{}"),
        (
            ".config/opencode/opencode.json",
            r#"{"plugin":["customer-plugin"]}"#,
        ),
        (
            ".pi/agent/settings.json",
            r#"{"extensions":["customer-extension"]}"#,
        ),
        (
            ".hermes/plugins/loongsuite-pilot/.loongsuite-pilot-managed.json",
            "{}",
        ),
        (
            ".bashrc",
            "# BEGIN otel-claude-hook\nexport LEGACY_FIXTURE=yes\n# END otel-claude-hook\n",
        ),
        (
            ".zshrc",
            "# BEGIN otel-claude-hook\nexport LEGACY_FIXTURE=yes\n# END otel-claude-hook\n",
        ),
        (
            ".bash_profile",
            "# BEGIN otel-claude-hook\nexport LEGACY_FIXTURE=yes\n# END otel-claude-hook\n",
        ),
    ];
    for (relative, bytes) in fixtures {
        let file = home.join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, bytes).unwrap();
    }
}
fn suite_home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("pilot-test-suite-home-")
        .tempdir()
        .unwrap()
}
fn command(home: &Path, root: &Path, filters: &[&str]) -> Command {
    fs::create_dir_all(root).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(filters)
        .args(["--nocapture", "--test-threads=1"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("HOME", root.join("launching-user"))
        .env("USERPROFILE", root.join("launching-user"))
        .env(UNTRUSTED, "must-not-reach-child");
    actual_baseline_environment::prepare_isolated_environment(&mut command, home).unwrap();
    let temp = root.join("tmp");
    fs::create_dir_all(&temp).unwrap();
    command
        .env(CHILD_ROOT, root)
        .env(EXPECTED_HOME, home)
        .env("TMPDIR", &temp)
        .env("TMP", &temp)
        .env("TEMP", &temp)
        .stdin(Stdio::null());
    command
}
fn run(mut command: Command, root: &Path, deadline: Instant) -> String {
    let log = root.join("child.log");
    let stdout = fs::File::create(&log).unwrap();
    command.stdout(stdout.try_clone().unwrap()).stderr(stdout);
    let mut child = CandidateChild::spawn(&mut command).unwrap();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "original child deadline exceeded:\n{}",
            fs::read_to_string(&log).unwrap()
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    let text = fs::read_to_string(log).unwrap();
    assert!(status.success(), "child failed:\n{text}");
    assert!(text.contains("test result: ok."), "{text}");
    text
}
#[allow(deprecated)]
fn native_home() -> PathBuf {
    std::env::home_dir().expect("native user-home lookup must be available")
}
#[test]
fn native_home_preworker_probe_fixture() {
    let Some(root) = std::env::var_os(CHILD_ROOT) else {
        return;
    };
    let expected = PathBuf::from(std::env::var_os(EXPECTED_HOME).unwrap());
    let actual = native_home();
    assert_eq!(actual, expected);
    assert!(actual
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("pilot-test-suite-home-"));
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    assert_eq!(PathBuf::from(std::env::var_os(key).unwrap()), actual);
    assert!(std::env::var_os(UNTRUSTED).is_none());
    let threads: Vec<_> = (0..3).map(|_| std::thread::spawn(native_home)).collect();
    let homes: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(homes.iter().all(|home| home == &expected));
    fs::write(
        Path::new(&root).join("native-home-report.json"),
        serde_json::to_vec(&json!({"home":expected,"workerHomes":homes})).unwrap(),
    )
    .unwrap();
}
#[tokio::test]
async fn actual_default_home_deployment_fixture() {
    let Some(root) = std::env::var_os(CHILD_ROOT) else {
        return;
    };
    let root = Path::new(&root);
    let home = native_home();
    assert_eq!(
        home,
        PathBuf::from(std::env::var_os(EXPECTED_HOME).unwrap())
    );
    let definitions = root.join("definitions");
    fs::create_dir_all(&definitions).unwrap();
    fs::write(
        definitions.join("cursor.json"),
        include_str!("../../agents.d/cursor.json"),
    )
    .unwrap();
    fs::create_dir_all(home.join(".cursor")).unwrap();
    let data = root.join("deployment-data");
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: data.to_string_lossy().into_owned(),
        pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
        builtin_agents_dir: Some(definitions.to_string_lossy().into_owned()),
        installed_by: None,
    });
    // This real public call also runs default-home legacy plugin migration.
    let results = manager.deploy_all(None).await;
    assert_eq!(results.len(), 1);
    assert!(results[0].success, "{:?}", results[0]);
    assert_ne!(results[0].skipped, Some(true), "{:?}", results[0]);
    let settings = home.join(".cursor/hooks.json");
    let bytes = fs::read_to_string(&settings).unwrap();
    assert!(bytes.contains("cursor-loongsuite-pilot-hook"), "{bytes}");
    assert!(data.join("deployed-agents.json").is_file());
    fs::write(
        root.join("deployment-report.json"),
        serde_json::to_vec(&json!({"home":home,"settings":settings})).unwrap(),
    )
    .unwrap();
}
#[test]
fn isolation_l35_actual_baseline_bootstrap_sets_native_home_before_libtest_workers_start() {
    let root = tempfile::tempdir().unwrap();
    let home = suite_home();
    let deadline = Instant::now() + Duration::from_secs(5);
    let output = run(
        command(home.path(), root.path(), &[HOME_PROBE]),
        root.path(),
        deadline,
    );
    assert!(output.contains(HOME_PROBE), "{output}");
    let report: Value =
        serde_json::from_slice(&fs::read(root.path().join("native-home-report.json")).unwrap())
            .unwrap();
    assert_eq!(report["home"], home.path().to_string_lossy().as_ref());
    assert_eq!(report["workerHomes"].as_array().unwrap().len(), 3);
    assert!(Instant::now() < deadline);
}
#[test]
fn isolation_l41_six_real_native_corpora_preserve_every_launching_home_legacy_byte_mode_and_mtime()
{
    let start = Instant::now();
    let outer_deadline = start + Duration::from_secs(45);
    let root = tempfile::tempdir().unwrap();
    let launching = root.path().join("launching-user");
    legacy_launching_home(&launching);
    let before = snapshot(&launching);

    // Pointing the same real production flow at a separate fake user is a
    // negative control: migration and Cursor installation really mutate it.
    let counterfactual = root.path().join("counterfactual-user");
    legacy_launching_home(&counterfactual);
    let negative_root = root.path().join("negative-execution");
    let negative_command = command(&counterfactual, &negative_root, &[BOUNDARY_PROBE]);
    let negative_before = snapshot(&counterfactual);
    run(
        negative_command,
        &negative_root,
        (Instant::now() + Duration::from_secs(5)).min(outer_deadline),
    );
    assert_ne!(snapshot(&counterfactual), negative_before);
    assert!(!counterfactual.join(".claude/otel-config.json").exists());
    assert!(
        fs::read_to_string(counterfactual.join(".cursor/hooks.json"))
            .unwrap()
            .contains("cursor-loongsuite-pilot-hook")
    );

    let home = suite_home();
    let child_root = root.path().join("positive-execution");
    let mut filters = CORPORA.to_vec();
    filters.extend([HOME_PROBE, BOUNDARY_PROBE]);
    assert!(filters.iter().all(|filter| {
        !filter.starts_with(PREFIX) || *filter == HOME_PROBE || *filter == BOUNDARY_PROBE
    }));
    let output = run(
        command(home.path(), &child_root, &filters),
        &child_root,
        (Instant::now() + Duration::from_secs(40)).min(outer_deadline),
    );
    for corpus in CORPORA {
        assert!(
            output.contains(&format!("test {corpus}")),
            "selected real corpus did not execute: {corpus}\n{output}"
        );
    }
    eprintln!(
        "source L41 six real corpora executed: {:?}; launching snapshot entries={}; {}",
        CORPORA
            .iter()
            .map(|corpus| (corpus, output.matches(&format!("test {corpus}")).count()))
            .collect::<Vec<_>>(),
        before.len(),
        output
            .lines()
            .find(|line| line.starts_with("test result: ok."))
            .unwrap()
    );
    assert_eq!(snapshot(&launching), before, "{output}");
    assert!(child_root.join("deployment-report.json").is_file());
    assert!(child_root.join("native-home-report.json").is_file());
    assert!(Instant::now() < outer_deadline);
}
