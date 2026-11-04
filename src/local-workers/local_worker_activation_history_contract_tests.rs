use super::*;
#[cfg(unix)]
use crate::local_workers::log_dir;
use crate::local_workers::{
    bootstrap_token_path, bundle_dir, connect_local_worker, state_dir, ConnectLocalWorkerOptions,
    LocalWorkerInstance,
};
use serde_json::{json, Value};
use std::path::PathBuf;
type Service = LocalWorkerActivationService<ProbeSupervisor>;
async fn within_source_budget(future: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("the original project configuration gives this case a fifteen-second total budget");
}

struct Running(Option<Arc<Service>>);
impl Running {
    fn service(&self) -> &Service {
        self.0.as_ref().unwrap()
    }
    async fn finish(&mut self) {
        if let Some(service) = self.0.take() {
            service.stop().await;
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(service) = self.0.take() {
            let _ = std::thread::spawn(move || {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(service.stop());
                }
            })
            .join();
        }
    }
}
struct World {
    _temp: tempfile::TempDir,
    root: PathBuf,
    data: String,
    pilot: String,
    tarball: PathBuf,
    capture: PathBuf,
    installed: PathBuf,
}
fn variable(name: &str) -> String {
    ["$", "{", name, "}"].concat()
}
fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}
fn token() -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(r#"{"workerUuid":"550e8400-e29b-41d4-a716-446655440000","matrixUrl":"https://matrix.example.com","controllerUrl":"https://controller.example.com","modelGatewayUrl":"https://model.example.com"}"#)
}
impl World {
    fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("pilot-local-worker-history-")
            .tempdir()
            .unwrap();
        let root = temp.path().to_owned();
        let data = root.join("data").to_string_lossy().into_owned();
        let pilot = root.join("pilot").to_string_lossy().into_owned();
        std::fs::create_dir_all(&pilot).unwrap();
        Self {
            _temp: temp,
            tarball: root.join("sample-local-runtime-0.0.1.tar.gz"),
            capture: root.join("worker-capture.txt"),
            installed: root.join("install-ran"),
            root,
            data,
            pilot,
        }
    }
    fn bundle(&self, script: Option<&str>, policy: Value, custom_pid: bool) {
        let source = self.root.join("bundle-src/sample-local-runtime-0.1.0");
        if source.exists() {
            std::fs::remove_dir_all(&source).unwrap();
        }
        std::fs::create_dir_all(source.join("scripts")).unwrap();
        std::fs::create_dir_all(source.join("sample-plugin")).unwrap();
        if let Some(script) = script {
            std::fs::write(
                source.join("scripts/install.sh"),
                format!("#!/bin/bash\ntouch {}\nexit 0\n", quote(&self.installed)),
            )
            .unwrap();
            std::fs::write(source.join("scripts/uninstall.sh"), "#!/bin/bash\nexit 0\n").unwrap();
            let entry = source.join("scripts/worker-entrypoint.sh");
            std::fs::write(&entry, script).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(entry, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let mut command = if script.is_some() {
            vec!["scripts/worker-entrypoint.sh".to_owned()]
        } else {
            vec![
                variable("pilot:binary"),
                "--exact".into(),
                "core::orchestrator::local_worker_history_contract_tests::native_worker_fixture"
                    .into(),
                "--nocapture".into(),
                "--".into(),
            ]
        };
        command.extend([
            "--bootstrap-token-file".into(),
            variable("instance:bootstrapTokenFile"),
            "--work-dir".into(),
            variable("instance:workDir"),
            "--instance-id".into(),
            variable("instance:id"),
            "--plugin-install-scope".into(),
            variable("instance:pluginInstallScope"),
            "--model-config-mode".into(),
            variable("instance:modelConfigMode"),
        ]);
        let manifest = json!({"name":"sample-local-worker","command":command,"cwd":".",
            "env":{"SAMPLE_PLUGIN_DIR":format!("{}/sample-plugin",variable("destDir")),"SAMPLE_STATE_DIR":variable("instance:stateDir"),
                "PILOT_LOCAL_NATIVE_CAPTURE":self.capture},
            "paths":{"pid":if custom_pid {".agent-worker/custom/worker.pid".into()}else{format!("{}/worker.pid",variable("instance:stateDir"))},
                "status":format!("{}/supervisor-status.json",variable("instance:stateDir")),"log":format!("{}/worker.log",variable("instance:logDir"))},
            "restartPolicy":policy});
        std::fs::write(
            source.join("worker.manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&self.tarball).unwrap(),
            flate2::Compression::fast(),
        );
        let mut archive = tar::Builder::new(encoder);
        archive
            .append_dir_all("sample-local-runtime-0.1.0", &source)
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap();
    }
    async fn connect(&self, configured: bool) -> LocalWorkerInstance {
        let mut opts = RuntimeOptions::new();
        if configured {
            opts.insert(
                "plugin-install-scope".into(),
                RuntimeOptionValue::Text("global".into()),
            );
            opts.insert(
                "model-config-mode".into(),
                RuntimeOptionValue::Text("managed-global".into()),
            );
        }
        connect_local_worker(ConnectLocalWorkerOptions {
            data_dir: &self.data,
            runtime: "claude-code",
            bootstrap_token: &token(),
            work_dir: Some(self.root.join("project").to_str().unwrap()),
            runtime_options: Some(opts),
        })
        .await
        .unwrap()
    }
    fn service(&self) -> Running {
        let template:AgentDefinition=serde_json::from_value(json!({"id":"sample-local-runtime-template","displayName":"Sample Local Runtime",
            "deployMode":"plugin-probe","localWorkerRuntime":"claude-code","detection":{"paths":[],"commands":[]},
            "pluginProbe":{"source":{"type":"tar","tarball":self.tarball,"destDir":self.root.join("unused-template-cache")},"mountType":"wrapper"}})).unwrap();
        Running(Some(Arc::new(LocalWorkerActivationService::new(
            self.data.clone(),
            self.pilot.clone(),
            vec![template],
            ProbeSupervisor {
                probe: PluginProbeStrategy::new(self.data.clone(), self.pilot.clone()),
            },
        ))))
    }
    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(&self.capture)
            .unwrap_or_default()
            .trim()
            .lines()
            .map(str::to_owned)
            .collect()
    }
    fn status(&self, i: &LocalWorkerInstance) -> Value {
        std::fs::read(Path::new(&state_dir(&self.data, &i.id)).join("supervisor-status.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or(Value::Null)
    }
    async fn wait(&self, seconds: u64, predicate: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(seconds), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("worker condition timed out; capture={:?}", self.lines()));
    }
    #[cfg(unix)]
    fn long_script(&self, body: &str) -> String {
        format!("#!/bin/bash\n{body}\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n")
    }
}
#[cfg(unix)]
#[tokio::test]
async fn activation_l107_real_production_adapter_extracts_installs_and_hot_starts_the_exact_unix_runtime(
) {
    within_source_budget(async {
        let f = World::new();
        let ten = ["$", "{10}"].concat();
        let script=f.long_script(&format!(r#"printf '%s\n' "$PWD" "$2" "$(cat "$2")" "$4" "$6" "$8" "{ten}" "$SAMPLE_STATE_DIR" "$SAMPLE_PLUGIN_DIR" > {}"#,quote(&f.capture)));
        f.bundle(
            Some(&script),
            json!({"type":"on-failure","maxRestarts":1,"backoffSeconds":0}),
            false,
        );
        let i = f.connect(true).await;
        let mut run = f.service();
        run.service().start().await;
        let bundle = PathBuf::from(bundle_dir(&f.data, &i.id)).join("sample-local-runtime-0.1.0");
        let expected = vec![
            std::fs::canonicalize(&bundle)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            bootstrap_token_path(&f.data, &i),
            token(),
            f.root.join("project").to_string_lossy().into_owned(),
            i.id.clone(),
            "global".into(),
            "managed-global".into(),
            state_dir(&f.data, &i.id),
            bundle.join("sample-plugin").to_string_lossy().into_owned(),
        ];
        f.wait(1, || f.lines() == expected).await;
        assert!(f.installed.is_file());
        let status = f.status(&i);
        assert_eq!(status["state"], "running");
        assert!(status["pid"].as_u64().unwrap() > 0);
        assert!(Path::new(&log_dir(&f.data, &i.id))
            .join("worker.log")
            .is_file());
        run.finish().await;
    })
    .await;
}
#[cfg(unix)]
#[tokio::test]
async fn activation_l170_actual_archive_byte_change_restarts_with_new_code_and_same_instance_and_token(
) {
    within_source_budget(async {
        let f = World::new();
        let make = |version: &str| {
            f.long_script(&format!(
                r#"printf '%s\n' '{version}' "$2" "$(cat "$2")" "$6" > {}"#,
                quote(&f.capture)
            ))
        };
        f.bundle(
            Some(&make("v1")),
            json!({"type":"on-failure","maxRestarts":1,"backoffSeconds":0}),
            false,
        );
        let i = f.connect(false).await;
        let mut run = f.service();
        run.service().start().await;
        let expected = |version: &str| {
            vec![
                version.into(),
                bootstrap_token_path(&f.data, &i),
                token(),
                i.id.clone(),
            ]
        };
        f.wait(1, || f.lines() == expected("v1")).await;
        f.bundle(
            Some(&make("v2")),
            json!({"type":"on-failure","maxRestarts":1,"backoffSeconds":0}),
            false,
        );
        run.service().refresh("bundle-change").await;
        f.wait(1, || f.lines() == expected("v2")).await;
        run.finish().await;
    })
    .await;
}
#[cfg(unix)]
#[tokio::test]
async fn activation_l231_token_file_rotation_alone_does_not_reinstall_or_restart_the_real_worker() {
    within_source_budget(async {
        let f = World::new();
        let script = f.long_script(&format!(
            r#"printf '%s\n' "$(cat "$2")" >> {}"#,
            quote(&f.capture)
        ));
        f.bundle(
            Some(&script),
            json!({"type":"on-failure","maxRestarts":1,"backoffSeconds":0}),
            false,
        );
        let i = f.connect(false).await;
        let mut run = f.service();
        run.service().start().await;
        f.wait(1, || f.lines() == vec![token()]).await;
        std::fs::write(
            bootstrap_token_path(&f.data, &i),
            "rotated-opaque-worker-token\n",
        )
        .unwrap();
        let before = std::fs::metadata(&f.installed).unwrap().modified().unwrap();
        run.service().refresh("token-rotation").await;
        assert_eq!(f.lines(), vec![token()]);
        assert_eq!(
            std::fs::metadata(&f.installed).unwrap().modified().unwrap(),
            before
        );
        run.finish().await;
    })
    .await;
}
#[cfg(unix)]
#[tokio::test]
async fn activation_l286_same_fingerprint_respects_the_manifest_custom_pid_location() {
    within_source_budget(async {
        let f = World::new();
        let script = f.long_script(&format!(r#"printf 'run\n' >> {}"#, quote(&f.capture)));
        f.bundle(
            Some(&script),
            json!({"type":"on-failure","maxRestarts":1,"backoffSeconds":0}),
            true,
        );
        let i = f.connect(false).await;
        let mut run = f.service();
        run.service().start().await;
        f.wait(1, || f.lines() == vec!["run"]).await;
        let bundle = PathBuf::from(bundle_dir(&f.data, &i.id)).join("sample-local-runtime-0.1.0");
        assert!(bundle.join(".agent-worker/custom/worker.pid").is_file());
        assert!(!Path::new(&state_dir(&f.data, &i.id))
            .join("worker.pid")
            .exists());
        run.service().refresh("same-fingerprint").await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(f.lines(), vec!["run"]);
        run.finish().await;
    })
    .await;
}
#[cfg(unix)]
#[tokio::test]
async fn activation_l347_same_fingerprint_never_redeploys_during_backoff_or_after_exact_restart_exhaustion(
) {
    within_source_budget(async {
        let f = World::new();
        let script = format!(
            "#!/bin/bash\nprintf 'run\\n' >> {}\nexit 7\n",
            quote(&f.capture)
        );
        f.bundle(
            Some(&script),
            json!({"type":"on-failure","maxRestarts":1,"backoffSeconds":1}),
            false,
        );
        let i = f.connect(false).await;
        let mut run = f.service();
        run.service().refresh("test").await;
        f.wait(1, || {
            f.lines().len() == 1 && f.status(&i)["state"] == "restarting"
        })
        .await;
        for _ in 0..2 {
            run.service().refresh("poll").await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(f.lines(), vec!["run"]);
        f.wait(3, || {
            f.lines().len() == 2 && f.status(&i)["state"] == "exited"
        })
        .await;
        for _ in 0..2 {
            run.service().refresh("poll").await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(f.lines(), vec!["run", "run"]);
        run.finish().await;
    })
    .await;
}
#[test]
fn native_worker_fixture() {
    let Ok(capture) = std::env::var("PILOT_LOCAL_NATIVE_CAPTURE") else {
        return;
    };
    let args: Vec<_> = std::env::args().collect();
    let get = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_default()
    };
    let token_file = get("--bootstrap-token-file");
    let values = vec![
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        token_file.clone(),
        std::fs::read_to_string(&token_file).unwrap(),
        get("--work-dir"),
        get("--instance-id"),
        get("--plugin-install-scope"),
        get("--model-config-mode"),
        std::env::var("SAMPLE_STATE_DIR").unwrap(),
        std::env::var("SAMPLE_PLUGIN_DIR").unwrap(),
    ];
    std::fs::write(capture, serde_json::to_vec(&values).unwrap()).unwrap();
    loop {
        // Windows has no POSIX SIGTERM for this headless test child. Cooperate
        // with the actual supervisor stop transition without shortening its
        // production five-second grace or the historical total test budget.
        #[cfg(windows)]
        {
            let status = PathBuf::from(std::env::var("SAMPLE_STATE_DIR").unwrap())
                .join("supervisor-status.json");
            if std::fs::read(status)
                .ok()
                .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
                .is_some_and(|row| {
                    row["state"] == "stopping"
                        && row["pid"].as_u64() == Some(u64::from(std::process::id()))
                })
            {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[tokio::test]
async fn actual_native_manifest_worker_uses_the_same_real_adapter_without_node_or_unix_shell_entry()
{
    let started = std::time::Instant::now();
    let stage = |label| {
        eprintln!(
            "native-worker history stage={label} elapsed_ms={}",
            started.elapsed().as_millis()
        )
    };
    within_source_budget(async {
        stage("fixture");
        let f = World::new();
        f.bundle(
            None,
            json!({"type":"on-failure","maxRestarts":1,"backoffSeconds":0}),
            false,
        );
        stage("bundle-ready");
        let i = f.connect(true).await;
        stage("connected");
        let mut run = f.service();
        run.service().start().await;
        stage("started");
        let bundle = PathBuf::from(bundle_dir(&f.data, &i.id)).join("sample-local-runtime-0.1.0");
        let expected = vec![
            std::fs::canonicalize(&bundle)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            bootstrap_token_path(&f.data, &i),
            token(),
            f.root.join("project").to_string_lossy().into_owned(),
            i.id.clone(),
            "global".into(),
            "managed-global".into(),
            state_dir(&f.data, &i.id),
            format!("{}/sample-plugin", bundle.to_string_lossy()),
        ];
        f.wait(1, || {
            std::fs::read(&f.capture)
                .ok()
                .and_then(|raw| serde_json::from_slice::<Vec<String>>(&raw).ok())
                .is_some_and(|mut observed| {
                    if observed.len() != expected.len() {
                        return false;
                    }
                    let Ok(cwd) = std::fs::canonicalize(&observed[0]) else {
                        return false;
                    };
                    observed[0] = cwd.to_string_lossy().into_owned();
                    observed == expected
                })
        })
        .await;
        stage("capture-verified");
        assert_eq!(f.status(&i)["state"], "running");
        assert!(!f.installed.exists());
        stage("stop");
        run.finish().await;
        stage("stopped");
        let stopped = f.status(&i);
        assert_eq!(
            stopped["state"], "stopped",
            "complete stop status: {stopped}"
        );
    })
    .await;
}
