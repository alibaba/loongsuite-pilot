//! Historical Qoder gate contracts at the actual SQLite/publication boundary.
//! The scheduling callback exists only in this libtest build, inside the real gate.
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

type NoticeCallback = Box<dyn Fn(&Path)>;
thread_local! {
    static NOTICE_COMMIT: RefCell<Option<NoticeCallback>> = const { RefCell::new(None) };
}
pub(super) fn before_notice_commit(destination: &Path) {
    NOTICE_COMMIT.with(|slot| {
        if let Some(callback) = slot.borrow().as_ref() {
            callback(destination);
        }
    });
}
fn wait_for(file: &Path, deadline: Instant) {
    while !file.exists() {
        assert!(
            Instant::now() < deadline,
            "private process barrier timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
struct OwnedChildren(Vec<Child>);
impl Drop for OwnedChildren {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn spawn_fixture(root: &Path, mode: &str, index: usize) -> Child {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "hook_process::qoder_wakeup::history_contract_tests::private_process_fixture",
            "--nocapture",
        ])
        .env("PILOT_QODER_GATE_FIXTURE_ROOT", root)
        .env("PILOT_QODER_GATE_FIXTURE_MODE", mode)
        .env("PILOT_QODER_GATE_FIXTURE_INDEX", index.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.spawn().unwrap()
}
fn finish(child: &mut Child, deadline: Instant) -> std::process::ExitStatus {
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "owned child exceeded original budget"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn payload(root: &Path, context: &str) -> serde_json::Value {
    json!({
        "session_id":"session", "transcript_path":root.join("transcript.jsonl"),
        "hook_event_name":"Stop", "cwd":context
    })
}
fn source_directory(root: &Path) -> PathBuf {
    std::fs::read_dir(root.join("data/state/qoder-transcripts/qoder/sources"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
}
#[test]
fn private_process_fixture() {
    let Some(root) = std::env::var_os("PILOT_QODER_GATE_FIXTURE_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let mode = std::env::var("PILOT_QODER_GATE_FIXTURE_MODE").unwrap();
    if mode == "killed-holder" {
        struct Finally(PathBuf);
        impl Drop for Finally {
            fn drop(&mut self) {
                std::fs::write(&self.0, b"finally-ran").unwrap();
            }
        }
        let result: anyhow::Result<Option<()>> =
            with_qoder_wakeup_lock(&root.join("gate"), 25, || {
                let _finally = Finally(root.join("finally"));
                std::fs::write(root.join("owned"), b"held").unwrap();
                #[cfg(unix)]
                unsafe {
                    libc::kill(libc::getpid(), libc::SIGKILL);
                }
                #[cfg(windows)]
                unsafe {
                    use windows_sys::Win32::System::Threading::{
                        GetCurrentProcess, TerminateProcess,
                    };
                    TerminateProcess(GetCurrentProcess(), 99);
                }
                panic!("termination returned");
            });
        panic!("holder was not terminated: {result:?}");
    }
    if mode == "warning" {
        assert_eq!(
            with_qoder_wakeup_lock(&root.join("gate"), 25, || {
                eprintln!("QODER_SYNTHETIC_WARNING");
                Ok(19)
            })
            .unwrap(),
            Some(19)
        );
        return;
    }
    assert_eq!(mode, "publisher");
    let index = std::env::var("PILOT_QODER_GATE_FIXTURE_INDEX").unwrap();
    std::fs::write(root.join(format!("ready-{index}")), b"ready").unwrap();
    wait_for(&root.join("start"), Instant::now() + Duration::from_secs(3));
    let control = root.clone();
    NOTICE_COMMIT.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |_| {
            std::fs::write(control.join("publishing"), b"inside-real-gate").unwrap();
            wait_for(
                &control.join("release"),
                Instant::now() + Duration::from_secs(4),
            );
        }))
    });
    let attrs = serde_json::Map::new();
    let accepted = publish_qoder_wakeup(
        &payload(&root, &format!("writer-{index}")),
        &root.join("data"),
        "qoder",
        None,
        &attrs,
        &attrs,
    );
    std::fs::write(
        root.join(format!("result-{index}")),
        if accepted { b"1" } else { b"0" },
    )
    .unwrap();
}
#[test]
fn old_metadata_never_steals_a_live_sqlite_gate() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("gate");
    let value = with_qoder_wakeup_lock(&directory, 25, || {
        let old = std::time::SystemTime::now() - Duration::from_secs(120);
        for entry in std::fs::read_dir(&directory)? {
            std::fs::OpenOptions::new()
                .write(true)
                .open(entry?.path())?
                .set_times(
                    std::fs::FileTimes::new()
                        .set_accessed(old)
                        .set_modified(old),
                )?;
        }
        assert_eq!(
            with_qoder_wakeup_lock(&directory, 0, || Ok("stolen"))?,
            None
        );
        Ok("outer")
    })
    .unwrap();
    assert_eq!(value, Some("outer"));
    assert_eq!(
        with_qoder_wakeup_lock(&directory, 0, || Ok("after release")).unwrap(),
        Some("after release")
    );
}
#[test]
fn killed_holder_releases_the_real_gate_without_finally_or_stale_file_removal() {
    let root = tempfile::tempdir().unwrap();
    let mut children = OwnedChildren(vec![spawn_fixture(root.path(), "killed-holder", 0)]);
    let status = finish(&mut children.0[0], Instant::now() + Duration::from_secs(3));
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }
    #[cfg(windows)]
    assert_eq!(status.code(), Some(99));
    assert_eq!(std::fs::read(root.path().join("owned")).unwrap(), b"held");
    assert!(!root.path().join("finally").exists());
    let gate = root.path().join("gate/.wakeup-gate.sqlite");
    assert!(
        gate.is_file(),
        "recovery must preserve the shared lock domain"
    );
    assert_eq!(
        with_qoder_wakeup_lock(&root.path().join("gate"), 0, || Ok("recovered")).unwrap(),
        Some("recovered")
    );
    assert!(gate.is_file());
}
#[test]
fn a_real_gate_callback_keeps_unrelated_stderr_visible() {
    use std::io::Read;
    let root = tempfile::tempdir().unwrap();
    let mut children = OwnedChildren(vec![spawn_fixture(root.path(), "warning", 0)]);
    let status = finish(&mut children.0[0], Instant::now() + Duration::from_secs(3));
    assert!(status.success());
    let mut stderr = String::new();
    children.0[0]
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(stderr.contains("QODER_SYNTHETIC_WARNING"));
    assert!(!stderr.contains("SQLite is an experimental feature"));
    // Product stdout is independently verified through the shipped Native CLI.
}
#[test]
fn four_real_ready_processes_cannot_overbook_the_last_context_slot() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("transcript.jsonl"), b"eight123").unwrap();
    let attrs = serde_json::Map::new();
    for index in 0..MAX_WAKEUPS_PER_SOURCE - 1 {
        assert!(publish_qoder_wakeup(
            &payload(root.path(), &format!("seed-{index}")),
            &root.path().join("data"),
            "qoder",
            None,
            &attrs,
            &attrs
        ));
    }
    let mut children = OwnedChildren(
        (0..4)
            .map(|index| spawn_fixture(root.path(), "publisher", index))
            .collect(),
    );
    let ready_deadline = Instant::now() + Duration::from_secs(3);
    for index in 0..4 {
        wait_for(&root.path().join(format!("ready-{index}")), ready_deadline);
    }
    let competition_deadline = Instant::now() + Duration::from_secs(4);
    std::fs::write(root.path().join("start"), b"go").unwrap();
    wait_for(&root.path().join("publishing"), competition_deadline);
    // Keep the original 150ms publication window, after every process is ready.
    std::thread::sleep(Duration::from_millis(150));
    std::fs::write(root.path().join("release"), b"release").unwrap();
    for child in &mut children.0 {
        assert!(finish(child, competition_deadline).success());
    }
    let accepted = (0..4)
        .filter(|index| std::fs::read(root.path().join(format!("result-{index}"))).unwrap() == b"1")
        .count();
    assert_eq!(accepted, 1);
    let directory = source_directory(root.path());
    assert!(directory.join("source.json").is_file());
    assert_eq!(
        std::fs::read_dir(directory.join("events")).unwrap().count(),
        MAX_WAKEUPS_PER_SOURCE
    );
    assert!(std::fs::read_dir(&directory).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".lock")));
}
