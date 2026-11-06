//! Shipped Native CLI contracts replacing the historical thin Node producer.
use loongsuite_pilot::utils::candidate_process::CandidateChild;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn execute(mut command: Command, input: &[u8]) -> Output {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = CandidateChild::spawn(&mut command).unwrap();
    let mut stdout = child.take_stdout().unwrap();
    let mut stderr = child.take_stderr().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .by_ref()
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .by_ref()
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    });
    child.take_stdin().unwrap().write_all(input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "thin Hook exceeded original 3000ms budget"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    let stdout = out.join().unwrap();
    let stderr = err.join().unwrap();
    assert!(stdout.len() <= 64 * 1024 && stderr.len() <= 64 * 1024);
    Output {
        status,
        stdout,
        stderr,
    }
}
fn command(root: &Path, binary: &Path, agent: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("PATH", root.join("no-runtimes"))
        .env("LOONGSUITE_PILOT_DATA_DIR", root)
        .args([
            "hook-process",
            "qoder",
            "--wakeup-only",
            "--agent-id",
            agent,
        ]);
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}
fn assert_quiet(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(std::str::from_utf8(&output.stdout).unwrap().trim(), "{}");
}
fn source(root: &Path, agent: &str) -> PathBuf {
    let entries = std::fs::read_dir(
        root.join("state/qoder-transcripts")
            .join(agent)
            .join("sources"),
    )
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);
    entries[0].clone()
}
#[cfg(unix)]
fn deny_transcript_body_and_drop_root(command: &mut Command, transcript: &Path) {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    std::fs::set_permissions(transcript, std::fs::Permissions::from_mode(0o0)).unwrap();
    if unsafe { libc::geteuid() } == 0 {
        command.uid(65534).gid(65534);
    }
}
#[test]
fn shipped_thin_cli_publishes_all_four_events_from_a_128mib_unreadable_transcript_without_runtimes()
{
    let temporary = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temporary.path()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let binary = root.join(if cfg!(windows) {
        "native.exe"
    } else {
        "native"
    });
    std::fs::copy(env!("CARGO_BIN_EXE_loongsuite-pilot"), &binary).unwrap();
    for agent in ["qoder", "qoder-cn"] {
        let data = root.join(agent);
        std::fs::create_dir(&data).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o777)).unwrap();
        }
        let transcript = data.join("huge-transcript.jsonl");
        std::fs::File::create(&transcript)
            .unwrap()
            .set_len(128 * 1024 * 1024)
            .unwrap();
        #[cfg(unix)]
        {
            let mut denied = Command::new("/bin/sh");
            denied
                .args(["-c", "exec 3<\"$1\"", "private-permission-control"])
                .arg(&transcript);
            deny_transcript_body_and_drop_root(&mut denied, &transcript);
            let result = execute(denied, b"");
            assert!(
                !result.status.success(),
                "permission negative control must really deny a body read"
            );
        }
        for event in ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] {
            let payload = json!({"session_id":"session/../safe","transcript_path":transcript,
                "hook_event_name":event,"cwd":data,"prompt":"private-prompt-must-not-copy",
                "tool_input":{"secret":"private-tool-must-not-copy"}});
            let mut cmd = command(&data, &binary, agent);
            #[cfg(unix)]
            deny_transcript_body_and_drop_root(&mut cmd, &transcript);
            assert_quiet(execute(cmd, payload.to_string().as_bytes()));
        }
        let directory = source(&data, agent);
        let descriptor: Value =
            serde_json::from_slice(&std::fs::read(directory.join("source.json")).unwrap()).unwrap();
        assert_eq!(descriptor["sessionId"], "session/../safe");
        assert_eq!(descriptor["observedSize"], 128 * 1024 * 1024);
        assert_eq!(descriptor["agentId"], agent);
        let notices = std::fs::read_dir(directory.join("events"))
            .unwrap()
            .map(|entry| {
                serde_json::from_slice::<Value>(&std::fs::read(entry.unwrap().path()).unwrap())
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(notices.len(), 4);
        for event in ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] {
            assert!(
                notices.iter().any(|notice| notice["event"] == event),
                "missing {event}: {notices:?}"
            );
        }
        for notice in &notices {
            assert_eq!(notice["sessionId"], "session/../safe");
            assert_eq!(notice["observedSize"], 128 * 1024 * 1024);
            let serialized = notice.to_string();
            assert!(!serialized.contains("private-prompt-must-not-copy"));
            assert!(!serialized.contains("private-tool-must-not-copy"));
        }
        assert!(
            !data.join("hooks").exists(),
            "thin path cannot spawn inline/retry transcript workers or create their history"
        );
        assert_eq!(
            std::fs::metadata(&transcript).unwrap().len(),
            128 * 1024 * 1024
        );
    }
}
#[test]
fn shipped_thin_cli_coalesces_duplicate_eight_byte_watermark_notices() {
    let root = tempfile::tempdir().unwrap();
    let transcript = root.path().join("transcript.jsonl");
    std::fs::write(&transcript, b"eight123").unwrap();
    let payload =
        json!({"session_id":"session","transcript_path":transcript,"hook_event_name":"Stop"});
    for _ in 0..2 {
        assert_quiet(execute(
            command(
                root.path(),
                Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot")),
                "qoder-cn",
            ),
            payload.to_string().as_bytes(),
        ));
    }
    let directory = source(root.path(), "qoder-cn");
    let events = std::fs::read_dir(directory.join("events"))
        .unwrap()
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 1);
    let event: Value =
        serde_json::from_slice(&std::fs::read(events[0].as_ref().unwrap().path()).unwrap())
            .unwrap();
    assert_eq!(event["observedSize"], 8);
    assert!(!root.path().join("hooks").exists());
}
