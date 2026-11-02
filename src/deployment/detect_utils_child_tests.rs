//! A real isolated lookup process must die when the production 2s probe expires.
use super::*;
use std::path::{Path, PathBuf};

const ROOT: &str = "PILOT_LOOKUP_PROCESS_CONTRACT_ROOT";
const CONTRACT: &str =
    "deployment::detect_utils::child_contract_tests::lookup_timeout_reaps_real_native_child";
const FIXTURE: &str = "lookup_timeout_child_fixture";

#[test]
fn lookup_timeout_child_fixture() {
    let Some(root) = std::env::var_os(ROOT) else {
        return;
    };
    let root = PathBuf::from(root);
    assert_eq!(std::env::args().skip(1).collect::<Vec<_>>(), [FIXTURE]);
    std::fs::write(root.join("lookup-pid"), std::process::id().to_string()).unwrap();
    while !root.join("release").exists() {
        std::thread::sleep(Duration::from_millis(10));
    }
}
struct ReleaseOnDrop(PathBuf);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::write(self.0.join("release"), "isolated fixture cleanup");
    }
}
fn alive(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    system
        .process(pid)
        .is_some_and(|p| p.status() != sysinfo::ProcessStatus::Zombie)
}
async fn wait_exited(pid: u32) -> bool {
    tokio::time::timeout(Duration::from_secs(5), async {
        while alive(pid) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}
async fn inner(root: &Path) {
    let _cleanup = ReleaseOnDrop(root.into());
    assert_eq!(COMMAND_EXISTS_TIMEOUT_MS, 2000);
    let started = std::time::Instant::now();
    assert!(!command_exists(FIXTURE).await);
    assert!(
        started.elapsed() >= Duration::from_millis(2000),
        "production lookup budget was shortened"
    );
    let pid: u32 = std::fs::read_to_string(root.join("lookup-pid"))
        .expect("native lookup never started")
        .parse()
        .unwrap();
    let expired = wait_exited(pid).await;
    if !expired {
        // Preserve evidence before releasing an unfixed orphan, so a red test
        // does not leave our deliberately hung fixture behind in CI.
        std::fs::write(
            root.join("release"),
            "release orphan after failed assertion",
        )
        .unwrap();
        assert!(wait_exited(pid).await, "fixture could not be cleaned up");
    }
    assert!(
        expired,
        "lookup child {pid} survived the real production 2s timeout"
    );
}
#[tokio::test]
async fn lookup_timeout_reaps_real_native_child() {
    if let Some(root) = std::env::var_os(ROOT) {
        inner(Path::new(&root)).await;
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let locator = bin.join(if cfg!(windows) { "where.exe" } else { "which" });
    std::fs::copy(std::env::current_exe().unwrap(), &locator).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locator, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", CONTRACT, "--nocapture"])
        .env_clear()
        .env(ROOT, root.path())
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("PATH", &bin)
        .env("TEMP", root.path())
        .env("TMP", root.path())
        .env("TMPDIR", root.path())
        .current_dir(root.path())
        .kill_on_drop(true);
    for key in ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = tokio::time::timeout(Duration::from_secs(25), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "lookup contract failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
