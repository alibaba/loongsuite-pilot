//! 原生 Hook 的本地协议测试，不代表真实 Agent 会话或跨平台注入验收。

use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn workspace() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn execute(mut command: Command, root: &Path, input: &[u8]) -> Output {
    command
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env("LOONGSUITE_PILOT_CACHE_DIR", root.join("other-cache"))
        .env("CODEX_HOME", root.join("codex 中文🚀"))
        .env("PATH", root.join("no-runtimes"))
        // Set fixture output after env_clear; caller-provided env is discarded.
        .env("PILOT_ARGV_PROBE_OUTPUT", root.join("argv-probe.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        let modules = Path::new(command.get_program())
            .parent()
            .unwrap()
            .join("Modules");
        assert!(
            modules.is_dir(),
            "PowerShell built-in module directory missing"
        );
        command.env("PSModulePath", modules);
    }
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
    let label = format!("{command:?}");
    let mut child =
        loongsuite_pilot::utils::candidate_process::CandidateChild::spawn(&mut command).unwrap();
    let stdout = child.take_stdout().unwrap();
    let stderr = child.take_stderr().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    });
    child.take_stdin().unwrap().write_all(input).unwrap();
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if start.elapsed() > Duration::from_secs(20) {
            // The scoped process group/Job kills the native grandchild too,
            // so readers cannot stay blocked after PowerShell is terminated.
            drop(child);
            let stdout = out.join().unwrap();
            let stderr = err.join().unwrap();
            panic!(
                "Hook 未在限定时间内退出：{label}，stdout={}，stderr={}",
                String::from_utf8_lossy(&stdout[..stdout.len().min(2048)]),
                String::from_utf8_lossy(&stderr[..stderr.len().min(2048)])
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = out.join().unwrap();
    let stderr = err.join().unwrap();
    assert!(
        stdout.len() <= 1024 * 1024 && stderr.len() <= 1024 * 1024,
        "Hook 输出超限"
    );
    Output {
        status,
        stdout,
        stderr,
    }
}

fn fixture(root: &Path) -> PathBuf {
    let hooks = root.join("data with spaces 中文🚀/hooks");
    fs::create_dir_all(hooks.join("shared")).unwrap();
    for file in [
        "codex-loongsuite-pilot-hook.sh",
        "codex-loongsuite-pilot-hook.ps1",
        "shared/native.sh",
        "shared/native.ps1",
    ] {
        fs::copy(
            workspace().join("assets/hooks").join(file),
            hooks.join(file),
        )
        .unwrap();
    }
    let bin = root.join(if cfg!(windows) {
        "原生 程序🚀.exe"
    } else {
        "原生 程序🚀"
    });
    fs::copy(env!("CARGO_BIN_EXE_loongsuite-pilot"), &bin).unwrap();
    fs::write(hooks.join("pilot-bin"), format!("{}\n", bin.display())).unwrap();
    fs::create_dir(root.join("other-cache")).unwrap();
    fs::write(root.join("other-cache/current"), "../../unrelated").unwrap();
    hooks
}

#[cfg(windows)]
fn assert_codex_roundtrip(command: Command, root: &Path, hooks: &Path, script: &Path) {
    assert_codex_roundtrip_event(command, root, hooks, script, "stop");
}

fn assert_codex_roundtrip_event(
    mut command: Command,
    root: &Path,
    hooks: &Path,
    script: &Path,
    event: &str,
) {
    command.arg(script).arg(event);
    let marker = hooks
        .parent()
        .unwrap()
        .join("state/codex/transcript-wakeups/native-hook.json");
    if marker.exists() {
        fs::remove_file(&marker).unwrap();
    }
    let mut payload = vec![0xef, 0xbb, 0xbf];
    payload.extend(serde_json::to_vec(&json!({
        "session_id":"native-hook", "turn_id":"轮次 🚀", "transcript_path":"C:/用户 文件/记录🚀.jsonl"
    })).unwrap());
    let output = execute(command, root, &payload);
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
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "{}");
    let marker = hooks
        .parent()
        .unwrap()
        .join("state/codex/transcript-wakeups/native-hook.json");
    let value: Value = serde_json::from_slice(&fs::read(marker).unwrap()).unwrap();
    assert_eq!(value["session_id"], "native-hook");
    assert_eq!(
        value["session_dir"],
        root.join("codex 中文🚀")
            .join("sessions")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(value["turn_id"], "轮次 🚀");
    assert_eq!(value["transcript_path"], "C:/用户 文件/记录🚀.jsonl");
    assert_eq!(
        value["codex_home"],
        root.join("codex 中文🚀").to_string_lossy().as_ref()
    );
    assert!(!root.join(".loongsuite-pilot").exists());
    let spool = hooks
        .parent()
        .unwrap()
        .join("state")
        .join("hook-metrics")
        .join("codex.jsonl");
    let timings = fs::read_to_string(spool).unwrap();
    let latest: Value = serde_json::from_str(timings.lines().last().unwrap()).unwrap();
    assert_eq!(latest["hook_event"], event);
    assert!(latest["duration_ms"]
        .as_f64()
        .is_some_and(|duration| duration.is_finite() && duration >= 0.0));
}

#[cfg(unix)]
#[test]
fn shell_preserves_raw_bom_unicode_and_bound_install_without_runtimes() {
    let root = tempfile::tempdir().unwrap();
    let hooks = fixture(root.path());
    for event in ["stop", "session-start"] {
        assert_codex_roundtrip_event(
            Command::new("/bin/bash"),
            root.path(),
            &hooks,
            &hooks.join("codex-loongsuite-pilot-hook.sh"),
            event,
        );
    }
}

#[cfg(unix)]
#[test]
fn shell_rejects_bad_pointer_and_missing_binary_without_protocol_noise() {
    let root = tempfile::tempdir().unwrap();
    let hooks = fixture(root.path());
    fs::write(hooks.join("pilot-bin"), "/missing/native-binary\n").unwrap();
    let mut command = Command::new("/bin/bash");
    command.arg(hooks.join("codex-loongsuite-pilot-hook.sh"));
    let output = execute(command, root.path(), b"{}");
    assert!(output.status.success());
    assert_eq!(output.stdout, b"{}\n");
    assert!(!output.stderr.is_empty());
    assert!(!hooks.parent().unwrap().join("state").exists());
    fs::remove_file(hooks.join("pilot-bin")).unwrap();
    let mut command = Command::new("/bin/bash");
    command.arg(hooks.join("codex-loongsuite-pilot-hook.sh"));
    let output = execute(command, root.path(), b"{}");
    assert_eq!(output.stdout, b"{}\n");
    assert!(!output.stderr.is_empty());
}

#[cfg(unix)]
#[test]
fn every_shell_entry_has_valid_syntax_and_no_legacy_runtime_fallback() {
    let mut count = 0;
    for entry in fs::read_dir(workspace().join("assets/hooks")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|s| s.to_str()) != Some("sh") {
            continue;
        }
        let status = Command::new("/bin/bash")
            .arg("-n")
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success(), "{}", path.display());
        // 此入口在 Agent 进程内加载 preload，属于批准保留的宿主桥接。
        if path
            .file_name()
            .is_some_and(|name| name == "qodercli-runtime-wrapper.sh")
        {
            continue;
        }
        let body = fs::read_to_string(&path).unwrap();
        for forbidden in [
            "python",
            "node-bin",
            "node.exe",
            "hook-processor.mjs",
            "command -v loongsuite-pilot",
        ] {
            assert!(!body.contains(forbidden), "{}: {forbidden}", path.display());
        }
        count += 1;
    }
    assert_eq!(count, 15, "including the native Copilot CLI launch bridge");
}

#[cfg(windows)]
#[test]
fn powershell_51_and_pwsh_preserve_native_stdin_in_both_language_modes() {
    let root = tempfile::tempdir().unwrap();
    let hooks = fixture(root.path());
    for shell in ["powershell.exe", "pwsh.exe"] {
        let executable = which::which(shell).unwrap_or_else(|_| panic!("Windows 验收缺少 {shell}"));
        for constrained in [false, true] {
            let harness = hooks.join(format!(
                "runner-{shell}-{}.ps1",
                if constrained { "constrained" } else { "full" }
            ));
            let mode = if constrained {
                "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n"
            } else {
                ""
            };
            fs::write(
                &harness,
                format!("{mode}& ($PSScriptRoot + '\\codex-loongsuite-pilot-hook.ps1') stop\n"),
            )
            .unwrap();
            let mut command = Command::new(&executable);
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]);
            assert_codex_roundtrip(command, root.path(), &hooks, &harness);
        }
    }
}

#[cfg(unix)]
#[test]
fn qodercn_bootstraps_bash_from_sh_or_posix_mode_without_losing_stdin_or_agent_id() {
    for program in ["/bin/sh", "/bin/bash"] {
        let root = tempfile::tempdir().unwrap();
        let hooks = fixture(root.path());
        let script = hooks.join("qodercn-loongsuite-pilot-hook.sh");
        fs::copy(
            workspace().join("assets/hooks/qodercn-loongsuite-pilot-hook.sh"),
            &script,
        )
        .unwrap();
        fs::create_dir(root.path().join("no-runtimes")).unwrap();
        std::os::unix::fs::symlink("/bin/bash", root.path().join("no-runtimes/bash")).unwrap();
        let transcript = root.path().join("CN transcript 中文🚀.jsonl");
        let rows = [
            json!({"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"你好 🚀"}}),
            json!({"type":"assistant","timestamp":"2026-10-01T10:00:01Z","message":{
                "model":"cn-test","content":[{"type":"text","text":"hello back"}],"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt","lastPrompt":"你好 🚀"}),
        ];
        fs::write(
            &transcript,
            rows.iter()
                .map(|row| row.to_string() + "\n")
                .collect::<String>(),
        )
        .unwrap();
        let mut payload = vec![0xef, 0xbb, 0xbf];
        payload.extend(
            serde_json::to_vec(
                &json!({"session_id":"cn-through-sh","transcript_path":transcript,
            "extra":{"user":{"name":"CN 用户"},"email":"cn@example.com"}}),
            )
            .unwrap(),
        );
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "POSIXLY_CORRECT=1 exec \"$@\"",
            "pilot-posix-launch",
            program,
        ]);
        if program == "/bin/bash" {
            command.arg("--posix");
        }
        command.arg(&script).arg("qoder-cn");
        let result = execute(command, root.path(), &payload);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.stdout, b"{}\n");
        let history = hooks.parent().unwrap().join("logs/qoder-cn/history");
        let records: Vec<Value> = fs::read_dir(history)
            .unwrap()
            .flat_map(|entry| {
                fs::read_to_string(entry.unwrap().path())
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).unwrap())
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(!records.is_empty());
        assert!(records
            .iter()
            .all(|row| row["gen_ai.agent.type"] == "qoder-cn"
                && row["user.name"] == "CN 用户"
                && row["user.email"] == "cn@example.com"));
        assert!(records
            .iter()
            .any(|row| row.to_string().contains("你好 🚀")));
    }
}

#[cfg(windows)]
#[test]
fn native_argument_probe_fixture() {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "pilot-argument-values") {
        return;
    }
    let output =
        PathBuf::from(std::env::var_os("PILOT_ARGV_PROBE_OUTPUT").expect("isolated probe output"));
    let started = output.with_extension("descendant-started");
    let done = output.with_extension("descendant-done");
    if args.iter().any(|arg| arg == "pilot-descendant") {
        fs::write(&started, "started").unwrap();
        std::thread::sleep(Duration::from_secs(4));
        fs::write(done, "done").unwrap();
        return;
    }
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).unwrap();
    fs::write(
        &output,
        serde_json::to_vec(&json!({"args":args,"input":input})).unwrap(),
    )
    .unwrap();
    if args.iter().any(|arg| arg == "pilot-detached") {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{
            CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
        };
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_argument_probe_fixture",
                "--nocapture",
                "--",
                "pilot-argument-values",
                "pilot-descendant",
            ])
            .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | DETACHED_PROCESS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // Wait for actual startup evidence, not a delay that hides a fast-exit
        // handle race. The descendant remains alive for four seconds afterwards.
        let deadline = Instant::now() + Duration::from_secs(3);
        while !started.is_file() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(started.is_file(), "detached fixture never started");
    }
    let mut stdout = std::io::stdout();
    stdout.write_all(b"PILOT_NATIVE_STDOUT:").unwrap();
    stdout.write_all(&input).unwrap();
    stdout.write_all(b"\n").unwrap();
    stdout.flush().unwrap();
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "pilot-stderr-0" | "pilot-exit-17"))
    {
        let mut stderr = std::io::stderr();
        stderr.write_all(b"PILOT_NATIVE_STDERR\n").unwrap();
        stderr.flush().unwrap();
    }
    if args.iter().any(|arg| arg == "pilot-exit-17") {
        std::process::exit(17);
    }
}

#[cfg(windows)]
#[test]
fn powershell_bridge_preserves_raw_bytes_and_native_argument_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let hooks = fixture(root.path());
    let probe = root.path().join("argv probe 中文🚀.exe");
    fs::copy(std::env::current_exe().unwrap(), &probe).unwrap();
    fs::write(hooks.join("pilot-bin"), format!("{}\n", probe.display())).unwrap();
    let values = [
        "pilot-argument-values",
        "",
        "space argument",
        r#"quote"inside"#,
        r#"trailing space \"#,
        "中文🚀",
        r#"C:\space dir\quote"and-slash\"#,
        "literal %PATH%",
        "literal $() ; & | ^ < >",
    ];
    let mut args = vec![
        "--exact",
        "native_argument_probe_fixture",
        "--nocapture",
        "--",
    ];
    args.extend(values);
    let literal = |arg: &str| format!("'{}'", arg.replace(char::from(39), "''"));
    let mut input = vec![0xef, 0xbb, 0xbf];
    input.extend(serde_json::to_vec(&json!({"probe":"中文🚀"})).unwrap());
    input.extend_from_slice(b"\r\n\0after-nul\n");
    for shell in ["powershell.exe", "pwsh.exe"] {
        let executable = which::which(shell).unwrap_or_else(|_| panic!("Windows 验收缺少 {shell}"));
        for constrained in [false, true] {
            for scenario in [
                "exit-0",
                "pilot-stderr-0",
                "pilot-exit-17",
                "pilot-detached",
            ] {
                let output_path = root.path().join("argv-probe.json");
                let shell_result = root.path().join("argv-probe.json.shell.json");
                let started = output_path.with_extension("descendant-started");
                let done = output_path.with_extension("descendant-done");
                for path in [&output_path, &shell_result, &started, &done] {
                    if path.exists() {
                        fs::remove_file(path).unwrap();
                    }
                }
                let mut probe_args = args.clone();
                if scenario != "exit-0" {
                    probe_args.push(scenario);
                }
                let array = probe_args
                    .iter()
                    .map(|arg| literal(arg))
                    .collect::<Vec<_>>()
                    .join(",");
                let script = hooks.join(format!("argv-{shell}-{constrained}-{scenario}.ps1"));
                let mode = if constrained {
                    "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n"
                } else {
                    ""
                };
                let body = format!(
                    "$ErrorActionPreference = 'Stop'\n\
                    {mode}. ($PSScriptRoot + '\\shared\\native.ps1')\n\
                    Invoke-PilotNative -HookDir $PSScriptRoot -Arguments @({array}) -EmptyResult ''\n\
                    @{{ exitCode=$global:LASTEXITCODE; language=[string]$ExecutionContext.SessionState.LanguageMode; errorActionPreference=[string]$ErrorActionPreference }} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($env:PILOT_ARGV_PROBE_OUTPUT + '.shell.json') -Encoding UTF8\n"
                );
                // Windows PowerShell 5.1 needs a BOM for literal Unicode in scripts.
                let mut source = vec![0xef, 0xbb, 0xbf];
                source.extend(body.as_bytes());
                fs::write(&script, source).unwrap();
                let mut command = Command::new(&executable);
                command
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                    ])
                    .arg(&script);
                let output = execute(command, root.path(), &input);
                assert!(
                    output.status.success(),
                    "{shell} constrained={constrained} scenario={scenario}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let stderr = String::from_utf8_lossy(&output.stderr);
                if matches!(scenario, "pilot-stderr-0" | "pilot-exit-17") {
                    assert!(
                        stderr.contains("PILOT_NATIVE_STDERR"),
                        "{shell} constrained={constrained} scenario={scenario}: native stderr lost: {stderr}"
                    );
                    assert_eq!(
                        stderr.contains("native hook unavailable"),
                        scenario == "pilot-exit-17",
                        "stderr must not change native success/failure: {stderr}"
                    );
                } else {
                    assert!(
                        output.stderr.is_empty(),
                        "{shell} constrained={constrained} scenario={scenario}: {stderr}"
                    );
                }
                let mut expected_stdout = b"PILOT_NATIVE_STDOUT:".to_vec();
                expected_stdout.extend_from_slice(&input);
                expected_stdout.push(b'\n');
                assert!(output
                    .stdout
                    .windows(expected_stdout.len())
                    .any(|bytes| bytes == expected_stdout.as_slice()));
                let observed: Value =
                    serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
                let actual: Vec<String> = serde_json::from_value(observed["args"].clone()).unwrap();
                let expected: Vec<String> = probe_args.iter().map(|arg| arg.to_string()).collect();
                assert_eq!(&actual[1..], expected.as_slice());
                assert_eq!(observed["input"], json!(input));
                let shell_bytes = fs::read(&shell_result).unwrap();
                let result: Value = serde_json::from_slice(
                    shell_bytes
                        .strip_prefix(&[0xef, 0xbb, 0xbf])
                        .unwrap_or(&shell_bytes),
                )
                .unwrap();
                assert_eq!(
                    result["exitCode"],
                    if scenario == "pilot-exit-17" { 17 } else { 0 }
                );
                assert_eq!(
                    result["language"],
                    if constrained {
                        "ConstrainedLanguage"
                    } else {
                        "FullLanguage"
                    }
                );
                assert_eq!(result["errorActionPreference"], "Stop");
                if scenario == "pilot-detached" {
                    assert!(
                        started.is_file(),
                        "detached child must actually have started"
                    );
                    assert!(!done.exists(), "Hook waited for its detached descendant");
                }
            }
        }
    }
}

#[cfg(windows)]
#[test]
fn powershell_native_binding_ignores_legacy_node_pins_and_keeps_shared_home_timing() {
    let root = tempfile::tempdir().unwrap();
    let hooks = fixture(root.path());
    let node_pin = hooks.parent().unwrap().join("node-bin");
    for legacy_pin in [None, Some(""), Some("/c/Program Files/obsolete-node")] {
        if node_pin.exists() {
            fs::remove_file(&node_pin).unwrap();
        }
        if let Some(pin) = legacy_pin {
            fs::write(&node_pin, pin).unwrap();
        }
        for shell in ["powershell.exe", "pwsh.exe"] {
            let executable = which::which(shell)
                .unwrap_or_else(|_| panic!("Windows acceptance requires {shell}"));
            for event in ["stop", "session-start"] {
                let mut command = Command::new(&executable);
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ]);
                assert_codex_roundtrip_event(
                    command,
                    root.path(),
                    &hooks,
                    &hooks.join("codex-loongsuite-pilot-hook.ps1"),
                    event,
                );
            }
        }
    }
}
