use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
tokio::task_local! {static STOP_GRACE: Duration;}
pub(super) fn grace_for_history(actual: Duration) -> Duration {
    STOP_GRACE.try_with(|v| *v).unwrap_or(actual)
}
#[derive(Default)]
struct Processes {
    alive: Mutex<HashMap<u32, ProcessIdentity>>,
    queried: Mutex<Vec<u32>>,
    signals: Mutex<Vec<(u32, bool)>>,
    deny_signal: bool,
}
fn identity(pid: u32) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        creation_time: "2026-07-30T00:00:00.0000000Z".into(),
        executable_path: "C:\\Program Files\\nodejs\\node.exe".into(),
    }
}
impl ProcessOperations for Processes {
    fn identity(&self, pid: u32) -> std::io::Result<Option<ProcessIdentity>> {
        self.queried.lock().unwrap().push(pid);
        Ok(self.alive.lock().unwrap().get(&pid).cloned())
    }
    fn descendants(&self, root: &ProcessIdentity) -> std::io::Result<Vec<ProcessIdentity>> {
        Ok(self
            .alive
            .lock()
            .unwrap()
            .values()
            .filter(|p| p.pid != root.pid)
            .cloned()
            .collect())
    }
    fn signal(&self, expected: &ProcessIdentity, force: bool) -> std::io::Result<()> {
        self.signals.lock().unwrap().push((expected.pid, force));
        if self.deny_signal {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        if force {
            self.alive.lock().unwrap().remove(&expected.pid);
        }
        Ok(())
    }
}
fn tracked(root: &Path, pid: u32, stored: bool) -> WorkerManifestOptions {
    std::fs::write(root.join("worker.manifest.json"),json!({"name":"history","command":["must-not-start"],"paths":{"pid":"state/worker.pid","status":"state/status.json","log":"logs/worker.log"}}).to_string()).unwrap();
    std::fs::create_dir_all(root.join("state")).unwrap();
    std::fs::write(root.join("state/worker.pid"), format!("{pid}\n")).unwrap();
    if stored {
        std::fs::write(
            root.join("state/worker.pid.identity.json"),
            serde_json::to_vec(&identity(pid)).unwrap(),
        )
        .unwrap();
    }
    WorkerManifestOptions {
        instance: Some(HashMap::new()),
        ..Default::default()
    }
}
fn status(root: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(root.join("state/status.json")).unwrap()).unwrap()
}
#[tokio::test]
async fn worker_l275_live_pid_health_does_not_query_identity() {
    let dir = tempfile::tempdir().unwrap();
    let opts = tracked(dir.path(), std::process::id(), false);
    let ops = Arc::new(Processes::default());
    let mut supervisor = WorkerManifestSupervisor::with_platform("win32", "");
    supervisor.processes = ops.clone();
    assert!(
        supervisor
            .is_worker_running(dir.path().to_str().unwrap(), &opts)
            .await
    );
    assert!(ops.queried.lock().unwrap().is_empty());
    assert!(ops.signals.lock().unwrap().is_empty());
}
#[tokio::test]
async fn worker_l334_l361_l455_public_stop_distinguishes_gone_missing_and_reused_identity() {
    for case in ["gone", "missing", "reused"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let pid = 40001;
        let opts = tracked(root, pid, case == "reused");
        let ops = Arc::new(Processes::default());
        if case != "gone" {
            let mut value = identity(pid);
            if case == "reused" {
                value.creation_time = "2026-07-30T00:00:01.0000000Z".into();
            }
            ops.alive.lock().unwrap().insert(pid, value);
        }
        let mut supervisor = WorkerManifestSupervisor::with_platform("win32", "");
        supervisor.processes = ops.clone();
        assert_eq!(
            supervisor
                .stop_if_present("local-worker:test", root.to_str().unwrap(), &opts)
                .await,
            case != "missing"
        );
        assert!(ops.queried.lock().unwrap().contains(&pid));
        assert!(ops.signals.lock().unwrap().is_empty());
        let s = status(root);
        assert_eq!(s["pid"], json!(pid));
        let reason = match case {
            "gone" => "WorkerProcessNotFound",
            "missing" => "WorkerProcessIdentityMissing",
            _ => "WorkerPidIdentityMismatch",
        };
        assert_eq!(s["reason"], json!(reason));
        assert_eq!(
            s["state"],
            if case == "missing" {
                "failed"
            } else {
                "stopped"
            }
        );
        assert_eq!(root.join("state/worker.pid").exists(), case == "missing");
    }
}
#[tokio::test]
async fn worker_l387_l422_public_tree_stop_verifies_every_identity_and_failure_journal() {
    STOP_GRACE
        .scope(Duration::ZERO, async {
            for fail in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                let opts = tracked(root, 41001, true);
                let ops = Arc::new(Processes {
                    deny_signal: fail,
                    ..Default::default()
                });
                for pid in [41001, 41002] {
                    ops.alive.lock().unwrap().insert(pid, identity(pid));
                }
                let mut supervisor = WorkerManifestSupervisor::with_platform("win32", "");
                supervisor.processes = ops.clone();
                assert_eq!(
                    supervisor
                        .stop_if_present("local-worker:test", root.to_str().unwrap(), &opts)
                        .await,
                    !fail
                );
                let s = status(root);
                if fail {
                    assert_eq!(s["state"], "failed");
                    assert_eq!(s["reason"], "WorkerProcessTreeStopFailed");
                    let mut remaining: Vec<u32> =
                        serde_json::from_value(s["remainingPids"].clone()).unwrap();
                    remaining.sort();
                    assert_eq!(remaining, vec![41001, 41002]);
                    assert!(root.join("state/worker.pid").exists());
                    assert!(s["trackedProcesses"].as_array().unwrap().len() >= 2);
                } else {
                    assert_eq!(s["state"], "stopped");
                    assert_eq!(s["pid"], 41001);
                    assert!(ops.alive.lock().unwrap().is_empty());
                    let signals = ops.signals.lock().unwrap();
                    assert_eq!(
                        *signals,
                        [(41002, false), (41001, false), (41002, true), (41001, true)]
                    );
                    assert!(!root.join("state/worker.pid").exists());
                }
            }
        })
        .await;
}
#[test]
fn history_native_child_fixture() {
    let Ok(capture) = std::env::var("PILOT_HISTORY_WORKER_CAPTURE") else {
        return;
    };
    let hold = std::env::var("PILOT_HISTORY_WORKER_HOLD").as_deref() == Ok("1");
    std::fs::write(capture,json!({"execPath":std::env::current_exe().unwrap(),"value":std::env::args().next_back().unwrap(),"home":std::env::var("HOME").unwrap_or_default(),"pid":std::process::id()}).to_string()).unwrap();
    if hold {
        loop {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    std::thread::sleep(Duration::from_millis(100));
}
struct Cleanup(ProcessIdentity);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = NativeProcesses.signal(&self.0, true);
    }
}
struct PidObserver {
    path: String,
    calls: AtomicUsize,
}
impl ProcessOperations for PidObserver {
    fn identity(&self, pid: u32) -> std::io::Result<Option<ProcessIdentity>> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            assert_eq!(
                std::fs::read_to_string(&self.path).unwrap(),
                format!("{pid}\n")
            );
        }
        NativeProcesses.identity(pid)
    }
    fn descendants(&self, root: &ProcessIdentity) -> std::io::Result<Vec<ProcessIdentity>> {
        NativeProcesses.descendants(root)
    }
    fn signal(&self, expected: &ProcessIdentity, force: bool) -> std::io::Result<()> {
        NativeProcesses.signal(expected, force)
    }
}
fn native_manifest(root: &Path, hold: bool) -> HashMap<String, String> {
    std::fs::write(root.join("worker.manifest.json"),json!({"name":"history-native","version":"1.2.3",
        "command":[concat!("$","{pilot:binary}"),"--exact","deployment::worker_manifest_supervisor::history_contract_tests::history_native_child_fixture","--nocapture","--","保留 空格"],
        "paths":{"pid":"state/worker.pid","status":"state/status.json","log":"logs/worker.log"}}).to_string()).unwrap();
    let mut env = HashMap::from([
        (
            "PILOT_HISTORY_WORKER_CAPTURE".into(),
            root.join("capture.json").to_string_lossy().into_owned(),
        ),
        (
            "PILOT_HISTORY_WORKER_HOLD".into(),
            if hold { "1".into() } else { "0".into() },
        ),
        ("USERPROFILE".into(), "C:\\Users\\测试 用户".into()),
        (
            "PATH".into(),
            root.join("no-runtimes").to_string_lossy().into_owned(),
        ),
    ]);
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    env
}
async fn wait_capture(root: &Path) -> Value {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(bytes) = std::fs::read(root.join("capture.json")) {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    return value;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn worker_l177_l244_l291_native_child_home_noninstance_sidecar_and_pid_before_identity() {
    for managed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let env = native_manifest(root, true);
        let before = env.clone();
        let opts = WorkerManifestOptions {
            instance: managed.then(HashMap::new),
            ..Default::default()
        };
        let observer = Arc::new(PidObserver {
            path: root.join("state/worker.pid").to_string_lossy().into_owned(),
            calls: AtomicUsize::new(0),
        });
        let mut supervisor = WorkerManifestSupervisor::with_platform("win32", "");
        supervisor.processes = observer.clone();
        assert!(
            supervisor
                .start_if_present("local-worker:test", root.to_str().unwrap(), &env, &opts)
                .await
        );
        let pid = read_pid(root.join("state/worker.pid").to_str().unwrap())
            .await
            .unwrap();
        let identity = NativeProcesses.identity(pid).unwrap().unwrap();
        let _cleanup = Cleanup(identity);
        assert_eq!(observer.calls.load(Ordering::SeqCst), 1);
        let capture = wait_capture(root).await;
        assert_eq!(capture["execPath"], json!(std::env::current_exe().unwrap()));
        assert_eq!(capture["value"], "保留 空格");
        assert_eq!(
            capture["home"],
            if managed {
                "C:\\Users\\测试 用户"
            } else {
                ""
            }
        );
        assert_eq!(env, before);
        assert_eq!(
            root.join("state/worker.pid.identity.json").exists(),
            managed
        );
        let mut stopping = supervisor.clone();
        stopping.processes = Arc::new(NativeProcesses);
        assert!(
            stopping
                .stop_if_present("local-worker:test", root.to_str().unwrap(), &opts)
                .await
        );
    }
}
#[tokio::test]
async fn worker_l479_real_native_reused_pid_timestamp_is_never_signalled() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let env = native_manifest(root, true);
    let opts = WorkerManifestOptions {
        instance: Some(HashMap::new()),
        ..Default::default()
    };
    let supervisor = WorkerManifestSupervisor::with_platform("win32", "");
    assert!(
        supervisor
            .start_if_present("local-worker:test", root.to_str().unwrap(), &env, &opts)
            .await
    );
    let pid = read_pid(root.join("state/worker.pid").to_str().unwrap())
        .await
        .unwrap();
    let identity = NativeProcesses.identity(pid).unwrap().unwrap();
    let _cleanup = Cleanup(identity.clone());
    wait_capture(root).await;
    let mut wrong = identity;
    wrong.creation_time = "2000-01-01T00:00:00.0000000Z".into();
    std::fs::write(
        root.join("state/worker.pid.identity.json"),
        serde_json::to_vec(&wrong).unwrap(),
    )
    .unwrap();
    assert!(
        supervisor
            .stop_if_present("local-worker:test", root.to_str().unwrap(), &opts)
            .await
    );
    assert!(is_alive(pid));
    let s = status(root);
    assert_eq!(s["state"], "stopped");
    assert_eq!(s["reason"], "WorkerPidIdentityMismatch");
    assert_eq!(s["pid"], pid);
}

#[tokio::test]
async fn worker_l118_l136_l152_l166_public_preflight_writes_exact_failure_metadata_without_spawn() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let entry = root.join("worker-entrypoint.mjs");
    std::fs::write(&entry, "// not executed").unwrap();
    for (command, node) in [
        (vec![concat!("$", "{pilot:other}").into()], ""),
        (vec![concat!("prefix-$", "{pilot:node}").into()], ""),
        (
            vec![
                concat!("$", "{pilot:node}").into(),
                entry.to_string_lossy().into_owned(),
            ],
            "relative-node",
        ),
    ] {
        std::fs::write(
            root.join("worker.manifest.json"),
            json!({"name":"history","version":"1.2.3","command":command}).to_string(),
        )
        .unwrap();
        let supervisor = WorkerManifestSupervisor::with_platform("win32", node);
        assert!(
            !supervisor
                .start_if_present(
                    "local-worker:test",
                    root.to_str().unwrap(),
                    &HashMap::new(),
                    &WorkerManifestOptions::default()
                )
                .await
        );
        let s = read_status(root.join(".agent-worker/status.json").to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(s["state"], "failed");
        assert_eq!(s["reason"], "WorkerManifestPlaceholderInvalid");
        assert!(!root.join(".agent-worker/worker.pid").exists());
    }
    for filename in ["worker-entrypoint.sh", "worker-entrypoint"] {
        let entry = root.join(filename);
        std::fs::write(&entry, "#!/usr/bin/env bash\nexit 0\n").unwrap();
        std::fs::write(
            root.join("worker.manifest.json"),
            json!({"name":"history","version":"1.2.3","command":[entry]}).to_string(),
        )
        .unwrap();
        let supervisor = WorkerManifestSupervisor::with_platform("win32", "");
        assert!(
            !supervisor
                .start_if_present(
                    "local-worker:test",
                    root.to_str().unwrap(),
                    &HashMap::new(),
                    &WorkerManifestOptions::default()
                )
                .await
        );
        let s = read_status(root.join(".agent-worker/status.json").to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(s["state"], "failed");
        assert_eq!(s["reason"], "RuntimeBundlePlatformUnsupported");
        assert_eq!(s["platform"], "win32");
        assert_eq!(s["bundleVersion"], "1.2.3");
        assert_eq!(s["entryType"], "unix-shell");
        assert!(!root.join(".agent-worker/worker.pid").exists());
    }
}
