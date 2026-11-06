//! Native replacement for the old script's explicit direct-main dispatch contract.
use std::fs;
use std::process::{Command, Stdio};
use std::time::Duration;

fn invoke(args: &[&str]) -> std::process::Output {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
    cmd.args(args)
        .current_dir(root.path())
        .env_clear()
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", root.path().join("appdata"))
        .env("LOCALAPPDATA", root.path().join("localappdata"))
        .env("XDG_CONFIG_HOME", root.path().join("xdg-config"))
        .env("XDG_CACHE_HOME", root.path().join("xdg-cache"))
        .env("XDG_DATA_HOME", root.path().join("xdg-data"))
        .env("XDG_STATE_HOME", root.path().join("xdg-state"))
        .env("CODEX_HOME", root.path().join("codex"))
        .env("CLAUDE_CONFIG_DIR", root.path().join("claude"))
        .env("CURSOR_AGENT_HOME", root.path().join("cursor"))
        .env("QODER_USER_DATA_DIR", root.path().join("qoder"))
        .env("LOONGSUITE_PILOT_DATA_DIR", root.path().join("data"))
        .env("LOONGSUITE_PILOT_CACHE_DIR", root.path().join("cache"))
        .env(
            "AGENT_DATA_COLLECTION_CONFIG",
            root.path().join("config.json"),
        )
        .env("PATH", root.path().join("no-runtimes"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
            cmd.env(key, value);
        }
    }
    let output = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(loongsuite_pilot::utils::candidate_process::output(
            &mut tokio::process::Command::from(cmd),
            Duration::from_secs(15),
            1024 * 1024,
        ))
        .unwrap();
    assert!(output.status.success());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    output
}

#[test]
fn explicit_cursor_hook_command_with_empty_nonterminal_stdin_returns_only_empty_object() {
    let output = invoke(&["hook-process", "cursor"]);
    assert_eq!(output.stdout, b"{}\n");
    assert!(
        output.stderr.is_empty(),
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_startup_without_hook_command_has_no_hook_output_or_filesystem_side_effects() {
    let output = invoke(&["--version"]);
    assert_eq!(
        output.stdout,
        format!("loongsuite-pilot {}\n", env!("CARGO_PKG_VERSION")).as_bytes()
    );
    assert!(
        output.stderr.is_empty(),
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
}
