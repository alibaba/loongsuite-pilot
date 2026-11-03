//! Real Windows junction fixture with one fixed cmd template and scoped paths.
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn command_path(path: &Path) -> String {
    let value = path.to_str().expect("fixture UTF-8 path");
    let ordinary = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
    };
    ordinary.replace('/', r"\")
}

pub(crate) fn create(target: &Path, alias: &Path, timeout: Duration) {
    assert!(!timeout.is_zero());
    assert!(target.is_absolute() && alias.is_absolute());
    assert!(target.is_dir() && !alias.exists());
    let shell = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot"))
        .join("System32/cmd.exe");
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    let mut command = Command::new(shell);
    // cmd has its own command-line grammar. Keep the template literal and
    // scoped paths in environment variables instead of CRT-quoting a command.
    command
        .args(["/d", "/v:off", "/c"])
        .raw_arg(r#"mklink /J "%PILOT_TEST_JUNCTION_ALIAS%" "%PILOT_TEST_JUNCTION_TARGET%""#)
        .env("PILOT_TEST_JUNCTION_ALIAS", command_path(alias))
        .env("PILOT_TEST_JUNCTION_TARGET", command_path(target))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout.try_clone().unwrap()))
        .stderr(Stdio::from(stderr.try_clone().unwrap()));
    let mut child = super::candidate_process::CandidateChild::spawn(&mut command).unwrap();
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    drop(child);
    stdout.seek(SeekFrom::Start(0)).unwrap();
    stderr.seek(SeekFrom::Start(0)).unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    stdout.take(1024 * 1024 + 1).read_to_end(&mut out).unwrap();
    stderr.take(1024 * 1024 + 1).read_to_end(&mut err).unwrap();
    assert!(out.len() <= 1024 * 1024 && err.len() <= 1024 * 1024);
    assert!(
        status.is_some_and(|status| status.success()),
        "junction failed status={status:?} alias={alias:?} target={target:?}: stdout={} stderr={}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    assert_eq!(
        std::fs::canonicalize(alias).unwrap(),
        std::fs::canonicalize(target).unwrap()
    );
}
