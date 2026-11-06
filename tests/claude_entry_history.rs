//! Immutable historical entry allowlist contract, exercised through real entry scripts.
//! The bridge is a controlled argv recorder: no agent/runtime/service is started.
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn declared() -> Vec<String> {
    let def: Value = serde_json::from_str(include_str!("../agents.d/claude-code.json")).unwrap();
    assert_eq!(def["hook"]["eventSubcommand"], "kebab-case");
    def["hook"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            let mut out = String::new();
            let mut previous = None;
            for c in v.as_str().unwrap().chars() {
                if c.is_ascii_uppercase()
                    && previous.is_some_and(|p: char| p.is_ascii_lowercase() || p.is_ascii_digit())
                {
                    out.push('-');
                }
                out.push(c.to_ascii_lowercase());
                previous = Some(c);
            }
            out
        })
        .collect()
}
#[test]
fn claude_definition_keeps_kebab_case_stop_failure_in_declared_events() {
    assert!(declared().contains(&"stop-failure".into()));
}

#[cfg(any(unix, windows))]
fn run_entry(root: &Path, program: &Path, script: &Path, event: &str) -> std::process::ExitStatus {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    cmd.arg(script)
        .arg(event)
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env("CODEX_HOME", root.join("codex"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude"))
        .env("LOONGSUITE_PILOT_DATA_DIR", root.join("data"))
        .env("PATH", root.join("no-runtimes"))
        .env("PILOT_ARGV_PROBE_OUTPUT", root.join("entry-argv.txt"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
    #[cfg(windows)]
    cmd.env("PSModulePath", program.parent().unwrap().join("Modules"));
    let mut child =
        loongsuite_pilot::utils::candidate_process::CandidateChild::spawn(&mut cmd).unwrap();
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "isolated entry did not terminate"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(any(unix, windows))]
fn entry_fixture(extension: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let hooks = dir.path().join("hooks with spaces 中文");
    fs::create_dir_all(hooks.join("shared")).unwrap();
    let name = format!("claude-code-loongsuite-pilot-hook.{extension}");
    let script = hooks.join(&name);
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets/hooks")
            .join(name),
        &script,
    )
    .unwrap();
    (dir, script)
}

#[cfg(any(unix, windows))]
fn check_every_event(root: &Path, program: &Path, script: &Path) {
    let output = root.join("entry-argv.txt");
    for event in declared() {
        if output.exists() {
            fs::remove_file(&output).unwrap();
        }
        assert!(run_entry(root, program, script, &event).success());
        let text = fs::read_to_string(&output)
            .unwrap_or_else(|_| panic!("entry rejected declared event {event}"));
        let text = text.trim_start_matches('\u{feff}');
        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            ["hook-process", "claude-code", event.as_str()]
        );
    }
    fs::remove_file(&output).unwrap();
    assert!(run_entry(root, program, script, "unknown-event").success());
    assert!(!output.exists(), "unknown event reached native bridge");
}

#[cfg(unix)]
#[test]
fn shell_entry_routes_every_declared_event_to_bridge_and_rejects_unknown_event() {
    let (dir, script) = entry_fixture("sh");
    fs::write(
        script.parent().unwrap().join("shared/native.sh"),
        r#"pilot_invoke_native() {
    shift
    shift
    printf '%s\n' "$@" > "$PILOT_ARGV_PROBE_OUTPUT"
    printf '{}\n'
}
"#,
    )
    .unwrap();
    check_every_event(dir.path(), Path::new("/bin/bash"), &script);
}

#[cfg(windows)]
#[test]
fn powershell_51_entry_routes_every_declared_event_to_bridge_and_rejects_unknown_event() {
    let (dir, script) = entry_fixture("ps1");
    fs::write(
        script.parent().unwrap().join("shared/native.ps1"),
        r#"function Invoke-PilotNative {
    param($HookDir, $Arguments, $EmptyResult)
    Set-Content -LiteralPath $env:PILOT_ARGV_PROBE_OUTPUT -Value @($Arguments) -Encoding UTF8
    Write-Output '{}'
}
"#,
    )
    .unwrap();
    let program = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot"))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    assert!(program.is_file());
    check_every_event(dir.path(), &program, &script);
}
