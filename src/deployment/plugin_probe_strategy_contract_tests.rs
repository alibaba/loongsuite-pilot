//! Actual archive, policy, filesystem, script and worker contracts.
use super::*;
use crate::types::PluginSourceType;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Package {
    root: tempfile::TempDir,
    data: PathBuf,
    pilot: PathBuf,
    source: PathBuf,
    tarball: PathBuf,
    dest: PathBuf,
}
impl Package {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let pilot = root.path().join("pilot");
        let source = root.path().join("source");
        for path in [&data, &pilot, &source] {
            std::fs::create_dir_all(path).unwrap();
        }
        let tarball = root.path().join("plugin.tgz");
        let dest = root.path().join("dest");
        Self {
            root,
            data,
            pilot,
            source,
            tarball,
            dest,
        }
    }
    fn strategy(&self) -> PluginProbeStrategy {
        PluginProbeStrategy::new(
            self.data.to_string_lossy().into_owned(),
            self.pilot.to_string_lossy().into_owned(),
        )
    }
    fn def(&self) -> AgentDefinition {
        serde_json::from_value(json!({"id":"test-plugin","displayName":"Test Plugin","deployMode":"plugin-probe",
            "detection":{"paths":[self.dest],"commands":[]},"pluginProbe":{
                "source":{"type":"tar","tarball":self.tarball,"destDir":self.dest},"mountType":"wrapper"}})).unwrap()
    }
    fn write(&self, path: &str, body: impl AsRef<[u8]>) {
        let path = self.source.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }
    fn archive(&self) {
        let encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&self.tarball).unwrap(),
            flate2::Compression::default(),
        );
        let mut archive = tar::Builder::new(encoder);
        archive.append_dir_all(".", &self.source).unwrap();
        archive.into_inner().unwrap().finish().unwrap();
    }
    fn record(hash: Option<&str>, hours: Option<i64>) -> DeployedAgentRecord {
        let at = hours.map(|h| (chrono::Utc::now() - chrono::Duration::hours(h)).to_rfc3339());
        serde_json::from_value(json!({"deployMode":"plugin-probe","deployedAt":"2026-10-01T00:00:00Z","sourceHash":hash,"lastRemoteCheckedAt":at})).unwrap()
    }
    fn instance(&self) -> PluginProbeDeployOptions {
        PluginProbeDeployOptions {
            instance: Some(HashMap::from([
                ("id".into(), "lw_testinstance001".into()),
                (
                    "stateDir".into(),
                    self.root
                        .path()
                        .join("state")
                        .to_string_lossy()
                        .into_owned(),
                ),
                (
                    "logDir".into(),
                    self.root.path().join("logs").to_string_lossy().into_owned(),
                ),
            ])),
            runtime_options: None,
        }
    }
}
fn json_file(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
const SAME_HASH: &str = "sha256:cae1b3faaa5e4ac7c3306bd164b36dcfdff98294b8024c9c949639b4c480bf6b";
#[tokio::test]
async fn detects_real_declared_path_and_distinguishes_missing_agent() {
    let p = Package::new();
    let strategy = p.strategy();
    assert!(!strategy.detect(&p.def()).await);
    std::fs::create_dir(&p.dest).unwrap();
    assert!(strategy.detect(&p.def()).await);
}
#[tokio::test]
async fn needs_deploy_checks_record_config_destination_and_exact_content_digest() {
    let p = Package::new();
    let strategy = p.strategy();
    let def = p.def();
    assert!(strategy.needs_deploy(&def, None).await);
    let mut missing = def.clone();
    missing.plugin_probe = None;
    assert!(
        strategy
            .needs_deploy(&missing, Some(&Package::record(Some("old"), None)))
            .await
    );
    std::fs::write(&p.tarball, b"same-content").unwrap();
    assert_eq!(
        strategy
            .compute_source_hash(Some(p.tarball.to_str().unwrap()), None)
            .await
            .as_deref(),
        Some(SAME_HASH)
    );
    let same = Package::record(Some(SAME_HASH), None);
    assert!(strategy.needs_deploy(&def, Some(&same)).await);
    std::fs::create_dir(&p.dest).unwrap();
    assert!(!strategy.needs_deploy(&def, Some(&same)).await);
    assert!(
        strategy
            .needs_deploy(&def, Some(&Package::record(Some("old"), None)))
            .await
    );
    std::fs::remove_file(&p.tarball).unwrap();
    assert!(strategy.needs_deploy(&def, Some(&same)).await);
    assert!(strategy
        .compute_source_hash(Some(p.tarball.to_str().unwrap()), None)
        .await
        .is_none());
    assert!(strategy.compute_source_hash(None, None).await.is_none());
}
#[test]
fn remote_source_selection_and_four_hour_interval_have_independent_cases() {
    let p = Package::new();
    let strategy = p.strategy();
    for (tar, url, remote, want) in [
        (None, Some("url"), None, true),
        (None, None, Some("remote"), true),
        (Some("local"), Some("url"), None, false),
        (None, None, None, false),
    ] {
        let source = PluginSourceConfig {
            source_type: PluginSourceType::Tar,
            tarball: tar.map(str::to_owned),
            url: url.map(str::to_owned),
            remote_url: remote.map(str::to_owned),
            dest_dir: p.dest.to_string_lossy().into_owned(),
        };
        assert_eq!(strategy.is_remote_only(&source), want);
    }
    assert!(strategy.is_remote_check_due(&Package::record(None, None)));
    assert!(!strategy.is_remote_check_due(&Package::record(None, Some(2))));
    assert!(strategy.is_remote_check_due(&Package::record(None, Some(5))));
}
struct Remote {
    url: String,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Remote {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn remote() -> Remote {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/plugin", socket.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = socket.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes).await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nsame-content").await.unwrap();
        }
    });
    Remote { url, calls, task }
}
#[tokio::test]
async fn real_remote_guard_avoids_io_until_due_while_local_changes_are_never_skipped() {
    let p = Package::new();
    let strategy = p.strategy();
    std::fs::create_dir(&p.dest).unwrap();
    let server = remote().await;
    let mut def = p.def();
    let source = &mut def.plugin_probe.as_mut().unwrap().source;
    source.source_type = PluginSourceType::Oss;
    source.tarball = None;
    source.url = Some(server.url.clone());
    assert!(
        !strategy
            .needs_deploy(&def, Some(&Package::record(Some("old"), Some(1))))
            .await
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
    assert!(
        !strategy
            .needs_deploy(&def, Some(&Package::record(Some(SAME_HASH), Some(5))))
            .await
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    assert!(
        strategy
            .needs_deploy(&def, Some(&Package::record(Some("old"), Some(5))))
            .await
    );
    std::fs::write(&p.tarball, b"new-content").unwrap();
    assert!(
        strategy
            .needs_deploy(&p.def(), Some(&Package::record(Some(SAME_HASH), Some(0))))
            .await
    );
}
#[tokio::test]
async fn worker_manifest_health_precedes_matching_hash_and_remote_interval() {
    let p = Package::new();
    let strategy = p.strategy();
    std::fs::create_dir(&p.dest).unwrap();
    std::fs::write(&p.tarball, b"same-content").unwrap();
    let mut def = p.def();
    let bundle = p.dest.join("bundle");
    std::fs::create_dir(&bundle).unwrap();
    std::fs::write(bundle.join("worker.manifest.json"),json!({"name":"test","command":["missing"],"paths":{"pid":"worker.pid","status":"status.json","log":"worker.log"}}).to_string()).unwrap();
    assert!(
        strategy
            .needs_deploy(&def, Some(&Package::record(Some(SAME_HASH), None)))
            .await
    );
    std::fs::write(bundle.join("worker.pid"), std::process::id().to_string()).unwrap();
    assert!(
        !strategy
            .needs_deploy(&def, Some(&Package::record(Some(SAME_HASH), None)))
            .await
    );
    std::fs::write(bundle.join("worker.pid"), "999999999").unwrap();
    let source = &mut def.plugin_probe.as_mut().unwrap().source;
    source.source_type = PluginSourceType::Oss;
    source.tarball = None;
    source.url = Some("http://127.0.0.1:1/unrequested".into());
    assert!(
        strategy
            .needs_deploy(&def, Some(&Package::record(Some(SAME_HASH), Some(1))))
            .await
    );
}
#[tokio::test]
async fn missing_config_or_source_has_explicit_failure_and_no_uninstall_is_false() {
    let p = Package::new();
    let strategy = p.strategy();
    let mut def = p.def();
    def.plugin_probe = None;
    let result = strategy.deploy(&def).await;
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("missing pluginProbe config"));
    assert!(!strategy.deploy(&p.def()).await.success);
    assert!(!p.dest.exists());
    assert!(!strategy.undeploy(&def).await);
    std::fs::create_dir(&p.dest).unwrap();
    assert!(!strategy.undeploy(&p.def()).await);
}
#[cfg(unix)]
#[tokio::test]
async fn actual_tar_install_wrapper_precedence_and_script_failure_status_are_preserved() {
    for mode in ["convention", "wrapper", "no-script", "nonzero"] {
        let p = Package::new();
        p.write("data.txt", "test");
        if mode != "no-script" {
            p.write(
                "scripts/install.sh",
                if mode == "convention" {
                    "#!/bin/sh\nexit 0\n"
                } else {
                    "#!/bin/sh\nexit 9\n"
                },
            );
        }
        if mode == "wrapper" {
            let wrapper = p.pilot.join("scripts/plugin-install-test-plugin.sh");
            std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
            std::fs::write(wrapper, "#!/bin/sh\nexit 0\n").unwrap();
        }
        p.archive();
        let result = p.strategy().deploy(&p.def()).await;
        assert_eq!(result.agent_id, "test-plugin");
        assert_eq!(
            result.success,
            mode != "nonzero",
            "{mode}: {:?}",
            result.error
        );
        if mode == "nonzero" {
            assert_eq!(result.error.as_deref(), Some("install script failed"));
        }
        assert_eq!(
            std::fs::read_to_string(p.dest.join("data.txt")).unwrap(),
            "test"
        );
    }
}
#[cfg(unix)]
#[tokio::test]
async fn actual_install_environment_uses_native_pilot_without_inventing_node() {
    let p = Package::new();
    let capture = p.root.path().join("capture");
    p.write("scripts/install.sh",r#"#!/bin/sh
printf '%s\n' "$PILOT_DATA_DIR" "$PILOT_LOG_DIR" "$PILOT_BIN" "$PILOT_NODE_BIN" "$NODE_OPTIONS" > "@CAPTURE@"
"#.replace("@CAPTURE@",capture.to_str().unwrap()));
    p.archive();
    assert!(p.strategy().deploy(&p.def()).await.success);
    let text = std::fs::read_to_string(capture).unwrap();
    let values = text.lines().collect::<Vec<_>>();
    assert_eq!(values[0], p.data.to_str().unwrap());
    assert_eq!(values[1], p.data.join("logs/test-plugin").to_str().unwrap());
    assert_eq!(
        values[2],
        std::env::current_exe().unwrap().to_str().unwrap()
    );
    assert_eq!(
        values[3],
        std::env::var("PILOT_NODE_BIN").unwrap_or_default()
    );
    assert_eq!(values[4], "");
}
#[cfg(unix)]
#[tokio::test]
async fn uninstall_precedes_update_and_successful_replacement_removes_stale_files() {
    let p = Package::new();
    let marker = p.root.path().join("uninstalled");
    std::fs::create_dir_all(p.dest.join("scripts")).unwrap();
    std::fs::write(p.dest.join("old.txt"), "old").unwrap();
    std::fs::write(
        p.dest.join("scripts/uninstall.sh"),
        format!("#!/bin/sh\nprintf old > '{}'\n", marker.display()),
    )
    .unwrap();
    p.write("fresh.txt", "new");
    p.archive();
    assert!(p.strategy().deploy(&p.def()).await.success);
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "old");
    assert!(!p.dest.join("old.txt").exists());
    assert_eq!(
        std::fs::read_to_string(p.dest.join("fresh.txt")).unwrap(),
        "new"
    );
}
#[tokio::test]
async fn failed_final_publish_restores_old_package_and_never_publishes_new_files() {
    let p = Package::new();
    std::fs::create_dir(&p.dest).unwrap();
    std::fs::write(p.dest.join("old.txt"), "old").unwrap();
    p.write("fresh.txt", "new");
    p.archive();
    let strategy = p.strategy();
    strategy.fail_next_publish.store(true, Ordering::SeqCst);
    let result = strategy.deploy(&p.def()).await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("staged publication failure"));
    assert_eq!(
        std::fs::read_to_string(p.dest.join("old.txt")).unwrap(),
        "old"
    );
    assert!(!p.dest.join("fresh.txt").exists());
}
#[tokio::test]
async fn corrupt_local_manifest_stops_before_touching_the_old_bundle() {
    let p = Package::new();
    std::fs::create_dir(&p.dest).unwrap();
    std::fs::write(p.dest.join("old.txt"), "old").unwrap();
    std::fs::write(p.dest.join("worker.manifest.json"), "{invalid").unwrap();
    p.write("new.txt", "new");
    p.archive();
    let mut def = p.def();
    def.local_worker_runtime = Some("fake-runtime".into());
    let result = p.strategy().deploy_with(&def, &p.instance()).await;
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("local worker stop failed; bundle replacement aborted")
    );
    assert_eq!(
        std::fs::read_to_string(p.dest.join("old.txt")).unwrap(),
        "old"
    );
    assert!(!p.dest.join("new.txt").exists());
}
#[tokio::test]
async fn windows_local_bundle_skips_unix_scripts_and_shell_worker_start_is_rejected() {
    let p = Package::new();
    let marker = p.root.path().join("should-not-run");
    std::fs::create_dir_all(p.dest.join("scripts")).unwrap();
    std::fs::write(
        p.dest.join("scripts/uninstall.sh"),
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    p.write(
        "scripts/install.sh",
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    );
    p.write("runtime.txt", "windows");
    p.archive();
    let mut strategy = p.strategy();
    strategy.platform = "win32".into();
    strategy.workers = WorkerManifestSupervisor::with_platform("win32", "");
    let mut def = p.def();
    def.local_worker_runtime = Some("fake-runtime".into());
    assert!(strategy.deploy_with(&def, &p.instance()).await.success);
    assert!(!marker.exists());
    assert_eq!(
        std::fs::read_to_string(p.dest.join("runtime.txt")).unwrap(),
        "windows"
    );
    p.write("scripts/worker.sh", "#!/bin/sh\nexit 0\n");
    p.write(
        "worker.manifest.json",
        json!({"name":"test","command":["scripts/worker.sh"]}).to_string(),
    );
    p.archive();
    let result = strategy.deploy_with(&def, &p.instance()).await;
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("local worker manifest failed to start")
    );
    assert_eq!(
        json_file(p.dest.join(".agent-worker/status.json"))["reason"],
        "RuntimeBundlePlatformUnsupported"
    );
}
#[cfg(unix)]
#[tokio::test]
async fn local_runtime_templates_do_not_start_until_instance_and_generic_spawn_failure_is_best_effort(
) {
    for local in [true, false] {
        let p = Package::new();
        p.write(
            "bundle/worker.manifest.json",
            json!({"name":"test","command":["scripts/missing-worker.sh"],
                "paths":{"pid":"${instance:stateDir}/worker.pid","status":"${instance:stateDir}/status.json","log":"${instance:logDir}/worker.log"}}).to_string(),
        );
        let marker = p.root.path().join("install-ran");
        p.write(
            "bundle/scripts/install.sh",
            format!("#!/bin/sh\nprintf installed > '{}'\n", marker.display()),
        );
        if !local {
            p.write(
                "bundle/worker.manifest.json",
                json!({"name":"test","command":["scripts/missing-worker.sh"]}).to_string(),
            );
        }
        p.archive();
        let mut def = p.def();
        if local {
            def.local_worker_runtime = Some("claude-code".into());
        }
        let result = p.strategy().deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert!(p.dest.join("bundle/worker.manifest.json").exists());
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "installed");
        if local {
            assert!(!p.dest.join("bundle/.agent-worker/status.json").exists());
            assert!(!p.dest.join("bundle/worker.pid").exists());
            assert!(!p.root.path().join("state/worker.pid").exists());
            assert!(!p.root.path().join("logs/worker.log").exists());
            // The private container never has a global worker log; absent instance
            // placeholders must not accidentally choose a filesystem-root sink.
            assert!(!Path::new("/worker.log").exists());
        } else {
            let status = json_file(p.dest.join("bundle/.agent-worker/status.json"));
            assert_eq!(status["state"], "failed");
            assert!(!status["error"].as_str().unwrap().is_empty());
        }
    }
}
#[cfg(unix)]
#[tokio::test]
async fn strategy_stop_reaps_real_worker_descendants_and_removes_its_pid() {
    use crate::utils::candidate_process::tests::{fixture, ready, stopped};
    let p = Package::new();
    let child_root = p.root.path().join("child");
    std::fs::create_dir(&child_root).unwrap();
    let command = fixture(&child_root, "wait");
    let args = std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(|v| v.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let env = command
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| {
                (
                    k.to_string_lossy().into_owned(),
                    Value::String(v.to_string_lossy().into_owned()),
                )
            })
        })
        .collect::<serde_json::Map<_, _>>();
    p.write("worker.manifest.json",json!({"name":"tree","command":args,"env":env,"paths":{"pid":"worker.pid","status":"status.json","log":"worker.log"}}).to_string());
    p.archive();
    let strategy = p.strategy();
    let def = p.def();
    assert!(strategy.deploy(&def).await.success);
    let leaf = ready(&child_root).await;
    let pid = std::fs::read_to_string(p.dest.join("worker.pid"))
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    assert!(
        strategy
            .stop_worker(&def, &PluginProbeDeployOptions::default())
            .await
    );
    stopped(pid).await;
    stopped(leaf).await;
    assert_eq!(json_file(p.dest.join("status.json"))["state"], "stopped");
    assert!(!p.dest.join("worker.pid").exists());
}
#[cfg(unix)]
#[tokio::test]
async fn real_script_undeploy_returns_exit_status_and_no_uninstall_is_false() {
    for code in [0, 7] {
        let p = Package::new();
        let marker = p.root.path().join("uninstalled");
        std::fs::create_dir_all(p.dest.join("scripts")).unwrap();
        std::fs::write(
            p.dest.join("scripts/uninstall.sh"),
            format!(
                "#!/bin/sh\nprintf yes > '{}'\nexit {code}\n",
                marker.display()
            ),
        )
        .unwrap();
        assert_eq!(p.strategy().undeploy(&p.def()).await, code == 0);
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "yes");
    }
}

#[cfg(unix)]
fn executable(p: &Package, relative: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    p.write(relative, body);
    std::fs::set_permissions(
        p.source.join(relative),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
}
#[cfg(unix)]
async fn status_until(path: &Path, accept: impl Fn(&Value) -> bool) -> Value {
    let observed = std::sync::Mutex::new(None);
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(bytes) = tokio::fs::read(path).await {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    *observed.lock().unwrap() = Some(value.clone());
                    if accept(&value) {
                        break value;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    result.unwrap_or_else(|_| {
        panic!(
            "worker status did not satisfy its real lifecycle contract: path={path:?} last={:?}",
            observed.into_inner().unwrap()
        )
    })
}
#[cfg(unix)]
#[tokio::test]
async fn installed_worker_receives_instance_arguments_environment_and_native_status() {
    let p = Package::new();
    let capture = p.root.path().join("capture");
    let marker = p.root.path().join("installed");
    executable(
        &p,
        "bundle/scripts/install.sh",
        &format!("#!/bin/bash\nprintf yes > '{}'\n", marker.display()),
    );
    executable(&p, "bundle/scripts/worker.sh", &format!(
        "#!/bin/bash\nprintf 'PLUGIN=%s\\n' \"$SAMPLE_PLUGIN_DIR\"\nprintf '%s\\n' \"$SAMPLE_PLUGIN_DIR\" \"$SAMPLE_STATE_DIR\" \"$(cat \"$2\")\" \"$4\" \"$6\" \"$8\" \"${{10}}\" > '{}'\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n", capture.display()));
    p.write("bundle/worker.manifest.json", json!({
        "name":"instance","command":["scripts/worker.sh","--bootstrap-token-file","${instance:bootstrapTokenFile}","--work-dir","${instance:workDir}","--instance-id","${instance:id}","--plugin-install-scope","${instance:pluginInstallScope}","--model-config-mode","${instance:modelConfigMode}"],"cwd":".",
        "env":{"SAMPLE_PLUGIN_DIR":"${destDir}/sample-plugin","SAMPLE_STATE_DIR":"${instance:stateDir}"},
        "paths":{"pid":"${instance:stateDir}/worker.pid","status":"${instance:stateDir}/status.json","log":"${instance:logDir}/worker.log"},
        "restartPolicy":{"type":"on-failure","maxRestarts":1,"backoffSeconds":1}
    }).to_string());
    p.archive();
    let mut options = p.instance();
    let token = p.root.path().join("bootstrap-token");
    std::fs::write(&token, "bootstrap-token-1\n").unwrap();
    let work = p.root.path().join("工作 空间");
    let instance = options.instance.as_mut().unwrap();
    instance.insert(
        "bootstrapTokenFile".into(),
        token.to_string_lossy().into_owned(),
    );
    instance.insert("workDir".into(), work.to_string_lossy().into_owned());
    options.runtime_options = Some(HashMap::from([
        ("plugin-install-scope".into(), json!("local")),
        ("model-config-mode".into(), json!("managed-runtime")),
    ]));
    let strategy = p.strategy();
    let def = p.def();
    let result = strategy.deploy_with(&def, &options).await;
    assert!(result.success, "{:?}", result.error);
    let status_path = p.root.path().join("state/status.json");
    let status = status_until(&status_path, |v| v["state"] == "running").await;
    let pid = status["pid"].as_u64().unwrap();
    assert!(pid > 0);
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "yes");
    let expected = [
        p.dest
            .join("bundle/sample-plugin")
            .to_string_lossy()
            .into_owned(),
        p.root.path().join("state").to_string_lossy().into_owned(),
        "bootstrap-token-1".into(),
        work.to_string_lossy().into_owned(),
        "lw_testinstance001".into(),
        "local".into(),
        "managed-runtime".into(),
    ];
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(text) = tokio::fs::read_to_string(&capture).await {
                if text.lines().collect::<Vec<_>>()
                    == expected.iter().map(String::as_str).collect::<Vec<_>>()
                {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual worker arguments/environment mismatch");
    assert_eq!(
        std::fs::read_to_string(p.root.path().join("state/worker.pid"))
            .unwrap()
            .trim()
            .parse::<u64>()
            .unwrap(),
        pid
    );
    let log = std::fs::read_to_string(p.root.path().join("logs/worker.log")).unwrap();
    assert!(log.contains(&format!(
        "PLUGIN={}",
        p.dest.join("bundle/sample-plugin").display()
    )));
    assert!(strategy.stop_worker(&def, &options).await);
    assert_eq!(json_file(status_path)["state"], "stopped");
    assert!(!p.root.path().join("state/worker.pid").exists());
}
#[cfg(unix)]
#[tokio::test]
async fn early_worker_exit_is_not_overwritten_by_late_initial_pid_or_status_publication() {
    let p = Package::new();
    executable(&p, "scripts/worker.sh", "#!/bin/sh\nexit 7\n");
    p.write("worker.manifest.json", json!({"name":"early","command":["scripts/worker.sh"],"paths":{"pid":"worker.pid","status":"status.json","log":"worker.log"},"restartPolicy":{"type":"on-failure","maxRestarts":0,"backoffSeconds":0}}).to_string());
    p.archive();
    let strategy = p.strategy();
    let def = p.def();
    assert!(strategy.deploy(&def).await.success);
    let value = status_until(&p.dest.join("status.json"), |v| {
        v["state"] == "exited" && v["exitCode"] == 7
    })
    .await;
    assert_eq!(value["exitCode"], 7);
    assert!(!p.dest.join("worker.pid").exists());
    assert!(
        strategy
            .stop_worker(&def, &PluginProbeDeployOptions::default())
            .await
    );
}
#[cfg(unix)]
#[tokio::test]
async fn unexpected_signal_restarts_the_strategy_worker_once_with_a_new_pid() {
    let p = Package::new();
    executable(
        &p,
        "scripts/worker.sh",
        "#!/bin/sh\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n",
    );
    p.write("worker.manifest.json", json!({"name":"restart","command":["scripts/worker.sh"],"paths":{"pid":"worker.pid","status":"status.json","log":"worker.log"},"restartPolicy":{"type":"on-failure","maxRestarts":1,"backoffSeconds":0}}).to_string());
    p.archive();
    let strategy = p.strategy();
    let def = p.def();
    assert!(strategy.deploy(&def).await.success);
    let first = status_until(&p.dest.join("status.json"), |v| v["state"] == "running").await;
    let pid = first["pid"].as_i64().unwrap() as i32;
    assert!(pid > 1);
    // This process group was created by the supervisor in this private test container.
    assert_eq!(unsafe { libc::kill(-pid, libc::SIGKILL) }, 0);
    let next = status_until(&p.dest.join("status.json"), |v| {
        v["state"] == "running" && v["restartCount"] == 1 && v["pid"] != first["pid"]
    })
    .await;
    assert_ne!(next["pid"], first["pid"]);
    assert_eq!(next["restartCount"], 1);
    assert!(
        strategy
            .stop_worker(&def, &PluginProbeDeployOptions::default())
            .await
    );
    assert_eq!(json_file(p.dest.join("status.json"))["state"], "stopped");
    assert!(!p.dest.join("worker.pid").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn strategy_stop_escalates_for_a_real_child_that_ignores_termination() {
    use crate::deployment::worker_process::{NativeProcesses, ProcessOperations};
    use crate::utils::candidate_process::tests::stopped;
    let p = Package::new();
    let child_pid = p.root.path().join("stubborn-child.pid");
    let ready = p.root.path().join("stubborn-child-ready");
    executable(&p,"scripts/worker.sh",&format!(
        "#!/bin/sh\nsh -c 'trap \"\" TERM; printf ready > \"$1\"; while true; do sleep 1; done' sh '{}'\x26\nprintf '%s' \"$!\" > '{}'\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n",ready.display(),child_pid.display()));
    p.write("worker.manifest.json",json!({"name":"stubborn","command":["scripts/worker.sh"],"paths":{"pid":"worker.pid","status":"status.json","log":"worker.log"}}).to_string());
    p.archive();
    let strategy = p.strategy();
    let def = p.def();
    assert!(strategy.deploy(&def).await.success);
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !ready.is_file() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let child = std::fs::read_to_string(child_pid)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let parent = std::fs::read_to_string(p.dest.join("worker.pid"))
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    assert!(NativeProcesses.identity(child).unwrap().is_some());
    // Demonstrate this is the legacy stubborn-child case before invoking stop.
    assert_eq!(unsafe { libc::kill(child as i32, libc::SIGTERM) }, 0);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(NativeProcesses.identity(child).unwrap().is_some());
    assert!(tokio::time::timeout(
        std::time::Duration::from_secs(20),
        strategy.stop_worker(&def, &PluginProbeDeployOptions::default())
    )
    .await
    .unwrap());
    stopped(parent).await;
    stopped(child).await;
    assert!(!p.dest.join("worker.pid").exists());
    assert_eq!(json_file(p.dest.join("status.json"))["state"], "stopped");
}
