//! Real native stdin/stdout/stderr boundary under isolated timing producer faults.
use serde_json::{json, Value};
use std::fs;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn f84_native_timing_faults_preserve_stderr_free_response_wakeup_context_and_existing_spool()
{
    for failure in ["full", "held-lock", "blocked-directory"] {
        let root = tempfile::tempdir().unwrap();
        let metrics = root.path().join("state").join("hook-metrics");
        let spool = metrics.join("codex.jsonl");
        let lock = metrics.join("codex.jsonl.lock");
        fs::create_dir_all(&metrics).unwrap();
        let full = format!("{}\n", "x".repeat(1024 * 1024 - 1));
        match failure {
            "full" => fs::write(&spool, &full).unwrap(),
            "held-lock" => fs::write(&lock, "holder").unwrap(),
            _ => {
                fs::remove_dir(&metrics).unwrap();
                fs::write(&metrics, "not-a-directory").unwrap();
            }
        }
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        command
            .args(["hook-process", "codex", "stop"])
            .env_clear()
            .env("HOME", root.path().join("home"))
            .env("USERPROFILE", root.path().join("home"))
            .env("APPDATA", root.path().join("appdata"))
            .env("LOCALAPPDATA", root.path().join("localappdata"))
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .env("CODEX_HOME", root.path().join("isolated-codex"))
            .env("LOONGSUITE_PILOT_DATA_DIR", root.path())
            .env(
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "multica.issue.id=timing-issue",
            )
            .env("PATH", root.path().join("no-runtimes"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "ComSpec",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command.spawn().unwrap();
        let input = json!({"session_id":"native-timing-session","turn_id":"native-timing-turn"})
            .to_string();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(input.as_bytes()).await.unwrap();
        drop(stdin);
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .expect("bounded native hook")
            .unwrap();
        assert!(
            output.status.success(),
            "{failure}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"{}\n", "{failure}");
        assert!(
            output.stderr.is_empty(),
            "{failure}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let state = root.path().join("state").join("codex");
        let marker: Value = serde_json::from_slice(
            &fs::read(
                state
                    .join("transcript-wakeups")
                    .join("native-timing-session.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(marker["turn_id"], "native-timing-turn");
        assert_eq!(marker["hook_event"], "stop");
        assert_eq!(
            marker["codex_home"],
            root.path()
                .join("isolated-codex")
                .to_string_lossy()
                .as_ref()
        );
        let context: Value = serde_json::from_slice(
            &fs::read(
                state
                    .join("transcript-span-contexts")
                    .join("native-timing-session--native-timing-turn.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            context["spanAttributes"],
            json!({"multica.issue.id":"timing-issue"})
        );
        match failure {
            "full" => assert_eq!(fs::read_to_string(&spool).unwrap(), full),
            "held-lock" => {
                assert!(!spool.exists());
                assert_eq!(fs::read_to_string(&lock).unwrap(), "holder");
            }
            _ => assert!(!spool.exists()),
        }
    }
}
