use super::*;
use crate::deployment::DshYamlPatchStrategy;
use crate::types::DeployStrategy;
use serde_json::json;
use std::path::PathBuf;

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
    fn locator(&self, env: HashMap<String, String>, platform: &str) -> DshRuntimeLocator {
        #[cfg(unix)]
        let uid = {
            use std::os::unix::fs::MetadataExt;
            Some(std::fs::metadata(&self.proc).unwrap().uid())
        };
        #[cfg(not(unix))]
        let uid = None;
        DshRuntimeLocator {
            proc_root: self.proc.to_string_lossy().into_owned(),
            platform: platform.into(),
            env,
            cwd: self.root.to_string_lossy().into_owned(),
            uid,
        }
    }
    fn process(
        &self,
        pid: u32,
        home: Option<&str>,
        cwd: Option<&Path>,
        dsh: bool,
        node_args: &[&str],
    ) {
        let dir = self.proc.join(pid.to_string());
        std::fs::create_dir(&dir).unwrap();
        let mut args = vec!["node"];
        args.extend_from_slice(node_args);
        args.extend([
            if dsh {
                "/code/node_modules/@deepseek-ai/dsh/lib/bin.js"
            } else {
                "/code/node_modules/some-other-package/lib/bin.js"
            },
            "web",
            "--port",
            "13080",
            "",
        ]);
        std::fs::write(dir.join("cmdline"), args.join("\0")).unwrap();
        let mut fields = vec!["PATH=/usr/bin".to_owned()];
        if let Some(home) = home {
            fields.push(format!("DSH_HOME={home}"));
        }
        fields.push("DEEPSEEK_API_KEY=must-not-be-read-or-logged".into());
        fields.push(String::new());
        std::fs::write(dir.join("environ"), fields.join("\0")).unwrap();
        #[cfg(unix)]
        if let Some(cwd) = cwd {
            std::os::unix::fs::symlink(cwd, dir.join("cwd")).unwrap();
        }
        #[cfg(not(unix))]
        let _ = cwd;
    }
}
fn def(patch: Option<&Path>) -> AgentDefinition {
    let mut value = json!({"id":"dsh","displayName":"DeepSeek Harness","deployMode":"dsh-yaml-patch",
        "detection":{"paths":[],"commands":[]},"dshYamlPatch":{"pluginSource":"/synthetic/plugin.mjs",
        "entryId":"loongsuite-pilot-observability","marker":"PILOT-OBSERVABILITY-MANAGED"}});
    if let Some(patch) = patch {
        value["dshYamlPatch"]["patchPath"] = json!(patch);
    }
    serde_json::from_value(value).unwrap()
}
fn env(home: &Path) -> HashMap<String, String> {
    HashMap::from([("DSH_HOME".into(), home.to_string_lossy().into_owned())])
}
fn assert_target(
    target: DshRuntimeTarget,
    home: &Path,
    source: DshRuntimeTargetSource,
    pid: Option<u32>,
) {
    assert_eq!(PathBuf::from(&target.home), home);
    assert_eq!(
        PathBuf::from(&target.patch_path),
        home.join("cordis.patch.yml")
    );
    assert_eq!(target.source, source);
    assert_eq!(target.pid, pid);
    assert!(!format!("{target:?}").contains("DEEPSEEK_API_KEY"));
    assert!(!format!("{target:?}").contains("must-not-be-read-or-logged"));
}
#[tokio::test]
async fn source_blank_env_still_discovers_the_real_process_home() {
    let f = Fixture::new();
    let home = f.root.join("runtime-home");
    f.process(324, Some(home.to_str().unwrap()), None, true, &[]);
    let locator = f.locator(HashMap::from([("DSH_HOME".into(), "   ".into())]), "linux");
    assert_target(
        locator.locate(&def(None), None).await.unwrap().unwrap(),
        &home,
        DshRuntimeTargetSource::RunningProcess,
        Some(324),
    );
}
#[tokio::test]
async fn source_explicit_service_env_does_not_need_path_or_existing_default_home() {
    let f = Fixture::new();
    let home = f.root.join("custom-home");
    assert_target(
        f.locator(env(&home), "linux")
            .locate(&def(None), None)
            .await
            .unwrap()
            .unwrap(),
        &home,
        DshRuntimeTargetSource::PilotEnv,
        None,
    );
}
#[tokio::test]
async fn source_process_environment_preserves_home_source_pid_without_exposing_secrets() {
    let f = Fixture::new();
    let home = f.root.join("runtime-home");
    f.process(321, Some(home.to_str().unwrap()), None, true, &[]);
    assert_target(
        f.locator(HashMap::new(), "linux")
            .locate(&def(None), None)
            .await
            .unwrap()
            .unwrap(),
        &home,
        DshRuntimeTargetSource::RunningProcess,
        Some(321),
    );
}
#[tokio::test]
async fn source_all_five_real_node_option_layouts_discover_the_entry() {
    for args in [
        vec!["--max-old-space-size=4096"],
        vec!["--enable-source-maps"],
        vec!["--inspect"],
        vec!["-r", "/code/preload.cjs"],
        vec!["--require", "/code/preload.cjs"],
    ] {
        let f = Fixture::new();
        let home = f.root.join("runtime-home");
        f.process(322, Some(home.to_str().unwrap()), None, true, &args);
        assert_target(
            f.locator(HashMap::new(), "linux")
                .locate(&def(None), None)
                .await
                .unwrap()
                .unwrap(),
            &home,
            DshRuntimeTargetSource::RunningProcess,
            Some(322),
        );
    }
}
#[tokio::test]
async fn source_actual_strategy_writes_managed_patch_and_exact_enabled_marker_in_discovered_home() {
    let f = Fixture::new();
    let home = f.root.join("runtime-home");
    let data = f.root.join("pilot-data");
    let plugin = data.join("plugins/dsh/plugin.mjs");
    std::fs::create_dir_all(plugin.parent().unwrap()).unwrap();
    std::fs::write(&plugin, "export default function apply() {}\n").unwrap();
    f.process(323, Some(home.to_str().unwrap()), None, true, &[]);
    let mut definition = def(None);
    definition.dsh_yaml_patch.as_mut().unwrap().plugin_source =
        plugin.to_string_lossy().into_owned();
    let strategy = DshYamlPatchStrategy::with_locator(
        data.to_string_lossy().into_owned(),
        f.locator(HashMap::new(), "linux"),
    );
    let result = strategy.deploy(&definition).await;
    assert!(result.success, "{result:?}");
    assert!(std::fs::read_to_string(home.join("cordis.patch.yml"))
        .unwrap()
        .contains("PILOT-OBSERVABILITY-MANAGED"));
    assert_eq!(
        std::fs::read_to_string(plugin.parent().unwrap().join(".collection-enabled")).unwrap(),
        "enabled\n"
    );
}
#[cfg(unix)]
#[tokio::test]
async fn source_relative_process_home_resolves_against_that_process_cwd() {
    let f = Fixture::new();
    let cwd = f.root.join("dsh-cwd");
    std::fs::create_dir(&cwd).unwrap();
    f.process(322, Some(".state/dsh"), Some(&cwd), true, &[]);
    let target = f
        .locator(HashMap::new(), "linux")
        .locate(&def(None), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(target.home), cwd.join(".state/dsh"));
}
#[tokio::test]
async fn source_same_home_processes_choose_the_lowest_real_pid() {
    let f = Fixture::new();
    let home = f.root.join("shared-home");
    f.process(402, Some(home.to_str().unwrap()), None, true, &[]);
    f.process(401, Some(home.to_str().unwrap()), None, true, &[]);
    let target = f
        .locator(HashMap::new(), "linux")
        .locate(&def(None), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(target.home), home);
    assert_eq!(target.pid, Some(401));
}
#[tokio::test]
async fn source_distinct_homes_are_an_explicit_ambiguous_error() {
    let f = Fixture::new();
    f.process(
        501,
        Some(f.root.join("home-a").to_str().unwrap()),
        None,
        true,
        &[],
    );
    f.process(
        502,
        Some(f.root.join("home-b").to_str().unwrap()),
        None,
        true,
        &[],
    );
    let error = f
        .locator(HashMap::new(), "linux")
        .locate(&def(None), None)
        .await
        .unwrap_err();
    assert!(error.contains("ambiguous DSH runtime homes"));
}
#[tokio::test]
async fn source_unrelated_node_process_cannot_override_real_standard_detection() {
    let f = Fixture::new();
    f.process(
        601,
        Some(f.root.join("unrelated-home").to_str().unwrap()),
        None,
        false,
        &[],
    );
    let mut definition = def(None);
    // Real successful detection substitutes for the old mocked detectAgent(true).
    let present = f.root.join("standard-present");
    std::fs::write(&present, []).unwrap();
    definition.detection.paths = vec![present.to_string_lossy().into_owned()];
    let target = f
        .locator(HashMap::new(), "linux")
        .locate(&definition, None)
        .await
        .unwrap()
        .unwrap();
    let expected = PathBuf::from(resolve_home("~/.dsh"));
    assert_target(
        target,
        &expected,
        DshRuntimeTargetSource::StandardDetection,
        None,
    );
}
#[tokio::test]
async fn source_persisted_patch_remains_owner_despite_new_config_env_and_running_process() {
    let f = Fixture::new();
    let owned = f.root.join("owned-home/cordis.patch.yml");
    f.process(
        701,
        Some(f.root.join("other-home").to_str().unwrap()),
        None,
        true,
        &[],
    );
    let record: DeployedAgentRecord = serde_json::from_value(
        json!({"deployMode":"dsh-yaml-patch","deployedAt":"synthetic","dshPatchPath":owned}),
    )
    .unwrap();
    let target = f
        .locator(env(&f.root.join("pilot-home")), "linux")
        .locate(
            &def(Some(&f.root.join("configured/cordis.patch.yml"))),
            Some(&record),
        )
        .await
        .unwrap()
        .unwrap();
    assert_target(
        target,
        owned.parent().unwrap(),
        DshRuntimeTargetSource::Persisted,
        None,
    );
}
#[tokio::test]
async fn source_explicit_patch_precedes_env_and_running_process() {
    let f = Fixture::new();
    let configured = f.root.join("configured-home/cordis.patch.yml");
    f.process(
        801,
        Some(f.root.join("runtime-home").to_str().unwrap()),
        None,
        true,
        &[],
    );
    let target = f
        .locator(env(&f.root.join("pilot-home")), "linux")
        .locate(&def(Some(&configured)), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(PathBuf::from(target.patch_path), configured);
    assert_eq!(target.source, DshRuntimeTargetSource::ConfiguredPatch);
}
#[tokio::test]
async fn source_non_linux_does_not_use_matching_proc_and_still_checks_standard_detection() {
    let f = Fixture::new();
    f.process(
        901,
        Some(f.root.join("runtime-home").to_str().unwrap()),
        None,
        true,
        &[],
    );
    let locator = f.locator(HashMap::new(), "darwin");
    let mut definition = def(None);
    assert!(locator.locate(&definition, None).await.unwrap().is_none());
    let standard = f.root.join("standard-present");
    std::fs::write(&standard, []).unwrap();
    definition.detection.paths = vec![standard.to_string_lossy().into_owned()];
    let target = locator.locate(&definition, None).await.unwrap().unwrap();
    assert_eq!(target.source, DshRuntimeTargetSource::StandardDetection);
}
#[test]
fn native_default_platform_matches_the_actual_target_os() {
    let expected = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    assert_eq!(DshRuntimeLocator::new().platform, expected);
}
