//! Actual subprocess/file contracts. On Linux only the Darwin admission flag is
//! injected; process images, spawn, process groups, signals, locks and files are real.
//! These do not claim execution of AppKit or of a macOS binary.
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

fn helper_binary() -> &'static Path {
    static HELPER: OnceLock<tempfile::TempDir> = OnceLock::new();
    HELPER
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("child.rs");
            std::fs::write(
                &source,
                r#"
use std::{io::Read, path::PathBuf, time::Duration};
unsafe extern "C" { fn signal(number: i32, handler: usize) -> usize; fn getpgrp() -> i32; }
fn main() {
    let data = PathBuf::from(std::env::var_os("LOONGSUITE_PILOT_DATA_DIR").unwrap());
    if data.join("exit-immediately").exists() { return; }
    if data.join("ignore-term").exists() { unsafe { signal(15, 1); } }
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).unwrap();
    std::fs::write(data.join("observed-data-dir"), data.to_str().unwrap()).unwrap();
    std::fs::write(data.join("observed-process-group"), unsafe { getpgrp() }.to_string()).unwrap();
    std::fs::write(data.join("observed-stdin"), input).unwrap();
    println!("native-child-stdout"); eprintln!("native-child-stderr");
    std::fs::write(data.join("ready"), std::process::id().to_string()).unwrap();
    while !data.join("exit-requested").exists() { std::thread::sleep(Duration::from_millis(10)); }
}
"#,
            )
            .unwrap();
            let result = std::process::Command::new(
                std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()),
            )
            .args(["--edition", "2021"])
            .arg(source)
            .arg("-o")
            .arg(dir.path().join(BINARY_NAME))
            .output()
            .unwrap();
            assert!(
                result.status.success(),
                "isolated child fixture must compile"
            );
            dir
        })
        .path()
}

struct Children(Arc<Mutex<Vec<u32>>>, PathBuf);
impl Drop for Children {
    fn drop(&mut self) {
        let native = ProcessOps::native("");
        for pid in self.0.lock().unwrap().iter().copied() {
            if (native.read_command)(pid)
                .map(|image| Path::new(&image).starts_with(&self.1))
                .unwrap_or(false)
            {
                (native.signal)(pid, "SIGKILL");
            }
        }
    }
}

fn real_manager(root: &Path, version: &str) -> (StatusBarAppManager, Children) {
    // macOS temporary roots commonly pass through /var -> /private/var.
    // Compare the actual canonical executable image, as the original Mac fixture does.
    let canonical_root = std::fs::canonicalize(root).unwrap();
    let root = canonical_root.as_path();
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let executable = root
        .join("package/app/macos-status-bar/bin/darwin-universal")
        .join(BINARY_NAME);
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::copy(helper_binary().join(BINARY_NAME), &executable).unwrap();
    let mut ops = ProcessOps::native(data.to_str().unwrap());
    ops.platform_darwin = true;
    let children = Arc::new(Mutex::new(Vec::<u32>::new()));
    let selected = children.clone();
    ops.find_pids = Arc::new(move || selected.lock().unwrap().clone());
    let native_spawn = ops.spawn.clone();
    let spawned = children.clone();
    ops.spawn = Arc::new(move |exe, log| {
        let pid = native_spawn(exe, log)?;
        spawned.lock().unwrap().push(pid);
        Ok(pid)
    });
    let mut manager = StatusBarAppManager::new(data.to_string_lossy(), version, ops)
        .with_source_roots(vec![root.join("package").to_string_lossy().into_owned()]);
    manager.set_cache_dir(root.join("cache").to_string_lossy());
    (manager, Children(children, root.to_path_buf()))
}

async fn wait_for(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "actual subprocess did not reach its stage"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn native_spawn_is_detached_records_data_and_restarts_without_duplicates() {
    let root = tempfile::tempdir().unwrap();
    let (manager, children) = real_manager(root.path(), "2.0.0");
    let first = manager.start().await.unwrap().unwrap();
    let data = Path::new(&manager.data_dir);
    wait_for(|| data.join("ready").exists()).await;
    assert_eq!(first.status, "started");
    // Discovery is real too; only the manager action candidate set is scoped
    // to owned fixture PIDs so tests never signal an unrelated installation.
    assert!((ProcessOps::native(&manager.data_dir).find_pids)().contains(&first.pid));
    assert_eq!(
        std::fs::read_to_string(data.join("observed-data-dir")).unwrap(),
        manager.data_dir
    );
    assert_eq!(
        std::fs::read_to_string(data.join("observed-process-group")).unwrap(),
        first.pid.to_string()
    );
    assert!(std::fs::read(data.join("observed-stdin"))
        .unwrap()
        .is_empty());
    let log = manager.prepare_log_path().await;
    wait_for(|| {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .contains("native-child-stderr")
    })
    .await;
    let log = std::fs::read_to_string(log).unwrap();
    assert!(log.contains("native-child-stdout"));
    let record = manager.read_runtime().await.unwrap();
    assert_eq!(record.pid, Some(first.pid));
    assert_eq!(record.package_version, "2.0.0");
    assert_eq!(record.executable_fingerprint.as_ref().unwrap().len(), 64);
    assert_eq!(manager.start().await.unwrap().unwrap().pid, first.pid);
    assert_eq!(children.0.lock().unwrap().len(), 1);
    std::fs::write(data.join("exit-requested"), []).unwrap();
    wait_for(|| !(manager.ops.alive)(first.pid)).await;
    std::fs::remove_file(data.join("exit-requested")).unwrap();
    let next = manager.start().await.unwrap().unwrap();
    assert_ne!(next.pid, first.pid);
    assert_eq!(children.0.lock().unwrap().len(), 2);
    assert_eq!(manager.stop("test").await.unwrap().pids, [next.pid]);
    assert_eq!(
        manager.stop("again").await.unwrap().status,
        "already-stopped"
    );
    assert!(!Path::new(&manager.runtime_record_path()).exists());
}

#[tokio::test]
async fn native_orphans_are_adopted_then_upgraded_and_foreign_images_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let (manager, children) = real_manager(root.path(), "old");
    let first = manager.start().await.unwrap().unwrap();
    std::fs::remove_file(manager.runtime_record_path()).unwrap();
    assert_eq!(manager.start().await.unwrap().unwrap().pid, first.pid);
    assert_eq!(children.0.lock().unwrap().len(), 1);

    let mut upgraded = StatusBarAppManager::new(&manager.data_dir, "new", manager.ops.clone())
        .with_source_roots(manager.source_roots.clone());
    upgraded.set_cache_dir(&manager.cache_dir);
    let replacement = upgraded.start().await.unwrap().unwrap();
    assert_ne!(replacement.pid, first.pid);
    assert!(!(manager.ops.alive)(first.pid));
    assert_eq!(
        upgraded.read_runtime().await.unwrap().package_version,
        "new"
    );
    upgraded.stop("test").await.unwrap();

    let foreign_root = tempfile::tempdir().unwrap();
    let (foreign, _foreign_children) = real_manager(foreign_root.path(), "foreign");
    let outsider = foreign.start().await.unwrap().unwrap();
    children.0.lock().unwrap().push(outsider.pid);
    let error = upgraded.start().await.unwrap_err();
    assert!(error.contains("outside this Pilot installation"));
    assert!(error.contains(&outsider.pid.to_string()));
    assert_eq!(children.0.lock().unwrap().len(), 3);
    assert_eq!(
        upgraded.stop("test").await.unwrap().status,
        "already-stopped"
    );
    assert!((foreign.ops.alive)(outsider.pid));
    foreign.stop("own installation only").await.unwrap();
}

#[tokio::test]
async fn native_retained_version_orphans_are_stopped_before_replacement() {
    let root = tempfile::tempdir().unwrap();
    let (manager, _children) = real_manager(root.path(), "2.0.0");
    let old = Path::new(&manager.cache_dir)
        .join("versions/1.0.0/app/macos-status-bar/bin/darwin-arm64")
        .join(BINARY_NAME);
    std::fs::create_dir_all(old.parent().unwrap()).unwrap();
    std::fs::copy(helper_binary().join(BINARY_NAME), &old).unwrap();
    let old_pid =
        (manager.ops.spawn)(old.to_str().unwrap(), &manager.prepare_log_path().await).unwrap();
    wait_for(|| (manager.ops.read_command)(old_pid).as_deref() == old.to_str()).await;
    assert!(!Path::new(&manager.runtime_record_path()).exists());
    let started = manager.start().await.unwrap().unwrap();
    assert_ne!(started.pid, old_pid);
    assert!(!(manager.ops.alive)(old_pid));
    assert_eq!(manager.stop("test").await.unwrap().pids, [started.pid]);
    assert!(!Path::new(&manager.lock_path()).exists());
}

#[tokio::test]
async fn native_pid_record_reuse_never_signals_an_unrelated_executable() {
    let root = tempfile::tempdir().unwrap();
    let (manager, children) = real_manager(root.path(), "2.0.0");
    let foreign_root = tempfile::tempdir().unwrap();
    let (foreign, _foreign_children) = real_manager(foreign_root.path(), "foreign");
    let other = foreign.start().await.unwrap().unwrap();
    children.0.lock().unwrap().push(other.pid);
    let expected = manager.resolve_executable().unwrap();
    manager.record_process(&expected, other.pid).await.unwrap();
    assert_eq!(
        manager.stop("stale pid").await.unwrap().status,
        "already-stopped"
    );
    assert!((foreign.ops.alive)(other.pid));
    assert!(!Path::new(&manager.runtime_record_path()).exists());
    foreign.stop("fixture cleanup").await.unwrap();
}

#[tokio::test]
async fn native_shared_lock_serializes_launch_stop_and_releases_on_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let (manager, children) = real_manager(root.path(), "2.0.0");
    let manager = Arc::new(manager);
    let pid = manager.start().await.unwrap().unwrap().pid;
    let (entered, ready) = tokio::sync::oneshot::channel();
    let worker = manager.clone();
    let held = tokio::spawn(async move {
        worker
            .with_lock(0, || async {
                entered.send(()).unwrap();
                std::future::pending::<Result<(), String>>().await
            })
            .await
    });
    ready.await.unwrap();
    assert!(Path::new(&manager.lock_path()).exists());
    assert!(manager.start().await.unwrap_err().contains("control lock"));
    assert_eq!(children.0.lock().unwrap().len(), 1);
    let worker = manager.clone();
    let stopping = tokio::spawn(async move { worker.sync_desired_state(false).await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(!stopping.is_finished());
    assert!((manager.ops.alive)(pid));
    held.abort();
    assert!(held.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_millis(STOP_LOCK_WAIT_MS), stopping)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!(manager.ops.alive)(pid));
    assert!(!Path::new(&manager.runtime_record_path()).exists());
    assert!(!Path::new(&manager.lock_path()).exists());
}

#[tokio::test]
async fn native_term_ignoring_child_is_force_stopped_at_the_original_deadline() {
    let root = tempfile::tempdir().unwrap();
    let (mut manager, _children) = real_manager(root.path(), "2.0.0");
    std::fs::write(Path::new(&manager.data_dir).join("ignore-term"), []).unwrap();
    let sent = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed = sent.clone();
    let signal = manager.ops.signal.clone();
    manager.ops.signal = Arc::new(move |pid, name| {
        observed.lock().unwrap().push(name.to_owned());
        signal(pid, name);
    });
    let pid = manager.start().await.unwrap().unwrap().pid;
    wait_for(|| Path::new(&manager.data_dir).join("ready").exists()).await;
    let before = Instant::now();
    assert_eq!(manager.stop("force").await.unwrap().pids, [pid]);
    assert!(before.elapsed() >= Duration::from_millis(STOP_TIMEOUT_MS));
    assert_eq!(*sent.lock().unwrap(), ["SIGTERM", "SIGKILL"]);
    assert!(!(manager.ops.alive)(pid));
    assert!(!Path::new(&manager.runtime_record_path()).exists());
}

#[tokio::test]
async fn native_rejected_signals_keep_the_live_process_record_for_retry() {
    let root = tempfile::tempdir().unwrap();
    let (mut manager, _children) = real_manager(root.path(), "2.0.0");
    let pid = manager.start().await.unwrap().unwrap().pid;
    let signals = Arc::new(Mutex::new(Vec::<String>::new()));
    let sent = signals.clone();
    let native_signal = manager.ops.signal.clone();
    manager.ops.signal = Arc::new(move |_, signal| sent.lock().unwrap().push(signal.to_owned()));
    let before = Instant::now();
    assert!(manager
        .stop("rejected signals")
        .await
        .unwrap_err()
        .contains("did not stop"));
    assert!(before.elapsed() >= Duration::from_millis(STOP_TIMEOUT_MS + FORCE_STOP_TIMEOUT_MS));
    assert_eq!(*signals.lock().unwrap(), ["SIGTERM", "SIGKILL"]);
    assert!((manager.ops.alive)(pid));
    assert_eq!(manager.read_runtime().await.unwrap().pid, Some(pid));
    assert!(!Path::new(&manager.lock_path()).exists());
    manager.ops.signal = native_signal;
    manager.stop("retry").await.unwrap();
}

#[tokio::test]
async fn native_exec_errors_and_immediate_exit_do_not_leave_runtime_or_lock() {
    for immediate_exit in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (manager, _children) = real_manager(root.path(), "2.0.0");
        if immediate_exit {
            std::fs::write(Path::new(&manager.data_dir).join("exit-immediately"), []).unwrap();
            assert!(manager.start().await.unwrap().is_none());
        } else {
            let executable = manager.resolve_executable().unwrap();
            std::fs::write(&executable, b"not an executable").unwrap();
            // Darwin may successfully spawn a shell for executable plain text.
            // A missing execute permission is a real kernel spawn failure on
            // every supported Unix host, separate from the immediate-exit case.
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(manager.start().await.is_err());
        }
        assert!(!Path::new(&manager.runtime_record_path()).exists());
        assert!(!Path::new(&manager.lock_path()).exists());
    }
}
