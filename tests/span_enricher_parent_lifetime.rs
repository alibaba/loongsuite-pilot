//! Real native worker lifetime when the parent cannot run Drop or its 5s timer.
#![cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};

const FIXTURE_ENV: &str = "PILOT_TEST_ENRICHER_PARENT_FIXTURE";
fn alive(system: &mut System, pid: u32) -> bool {
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system
        .process(pid)
        .is_some_and(|p| !matches!(p.status(), ProcessStatus::Zombie | ProcessStatus::Dead))
}
struct OwnedParent(Child);
impl Drop for OwnedParent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct OwnedOrphan {
    pid: u32,
    start: String,
}
impl Drop for OwnedOrphan {
    fn drop(&mut self) {
        if !self.start.is_empty()
            && loongsuite_pilot::utils::pid_utils::read_process_start_token(self.pid) == self.start
        {
            unsafe {
                libc::kill(self.pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}
fn wait_for_file(path: &Path, timeout: Duration) {
    let start = Instant::now();
    while !path.exists() {
        assert!(
            start.elapsed() < timeout,
            "fixture did not reach {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}
#[test]
fn hard_parent_death_reaps_a_busy_native_worker_without_drop_or_callback_timeout() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("busy.mjs"),
        "export default{enrich(){while(true){}}};",
    )
    .unwrap();
    let mut parent = OwnedParent(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_worker_parent_fixture", "--nocapture"])
            .env(FIXTURE_ENV, root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let pid_file = root.path().join("worker.json");
    wait_for_file(&pid_file, Duration::from_secs(10));
    let record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&pid_file).unwrap()).unwrap();
    let worker = OwnedOrphan {
        pid: record["pid"].as_u64().unwrap() as u32,
        start: record["start"].as_str().unwrap().into(),
    };
    assert!(!worker.start.is_empty());
    wait_for_file(&root.path().join("request-sent"), Duration::from_secs(10));
    let mut system = System::new();
    assert!(alive(&mut system, worker.pid));
    let start = Instant::now();
    // Actual CPU progress proves JS is busy, rather than an idle stdin EOF case.
    loop {
        std::thread::sleep(Duration::from_millis(250));
        assert!(
            alive(&mut system, worker.pid),
            "worker exited before parent hard kill"
        );
        if system
            .process(Pid::from_u32(worker.pid))
            .unwrap()
            .cpu_usage()
            > 5.0
        {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "busy worker did not consume CPU"
        );
    }
    parent.0.kill().unwrap();
    parent.0.wait().unwrap();
    let start = Instant::now();
    while alive(&mut system, worker.pid) {
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "orphaned busy JS survived parent SIGKILL"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}
#[test]
fn native_worker_parent_fixture() {
    let Some(root) = std::env::var_os(FIXTURE_ENV).map(std::path::PathBuf::from) else {
        return;
    };
    // Deliberately plain std::Child: no CandidateChild Drop, no 5s client timer.
    let mut worker = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"))
        .arg("internal-span-enricher")
        .arg(root.join("busy.mjs"))
        .arg(std::process::id().to_string())
        .env("TOKIO_WORKER_THREADS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = loongsuite_pilot::utils::pid_utils::read_process_start_token(worker.id());
    let record = serde_json::json!({"pid":worker.id(),"start":start});
    std::fs::write(
        root.join("worker.tmp"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    std::fs::rename(root.join("worker.tmp"), root.join("worker.json")).unwrap();
    let mut output = BufReader::new(worker.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&ready).unwrap()["ok"],
        true
    );
    let mut input = worker.stdin.take().unwrap();
    writeln!(input,"{}",serde_json::json!({"span":{"name":"busy","traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","attributes":{}},"context":{"agentType":"synthetic","serviceName":"parent-lifetime"}})).unwrap();
    input.flush().unwrap();
    std::fs::write(root.join("request-sent"), "ready").unwrap();
    let _ = worker.wait();
    drop(input);
    drop(output);
}
#[test]
fn worker_rejects_a_stale_explicit_parent_before_loading_the_module() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("never-load.mjs");
    std::fs::write(
        &plugin,
        "while(true){};export default{enrich(){return {};}};",
    )
    .unwrap();
    let different_parent = if std::process::id() == 1 { 2 } else { 1 };
    let mut worker = OwnedParent(
        Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"))
            .arg("internal-span-enricher")
            .arg(&plugin)
            .arg(different_parent.to_string())
            .env("TOKIO_WORKER_THREADS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let started = Instant::now();
    loop {
        if let Some(status) = worker.0.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "stale parent loaded a looping module"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}
