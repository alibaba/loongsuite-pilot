//! Historical Hook transport/cursor contracts through actual native OS processes.
//! Only synthetic installed layouts, HOME and configuration are used.
use loongsuite_pilot::utils::candidate_process::CandidateChild;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct Fixture {
    root: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    hooks: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("isolated home");
        let data = root.path().join("installed data 中文 space");
        let hooks = data.join("hooks");
        fs::create_dir_all(hooks.join("shared")).unwrap();
        fs::create_dir_all(&home).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/hooks");
        for file in [
            "workbuddy-loongsuite-pilot-hook.sh",
            "workbuddy-loongsuite-pilot-hook.ps1",
            "qwenworkcn-loongsuite-pilot-hook.sh",
            "qwenworkcn-loongsuite-pilot-hook.ps1",
            "shared/native.sh",
            "shared/native.ps1",
        ] {
            fs::copy(source.join(file), hooks.join(file)).unwrap();
        }
        fs::write(
            hooks.join("pilot-bin"),
            format!("{}\n", env!("CARGO_BIN_EXE_loongsuite-pilot")),
        )
        .unwrap();
        // Retired core Node pins cannot redirect the native binding.
        fs::write(data.join("node-bin"), "missing-retired-node").unwrap();
        Self {
            root,
            home,
            data,
            hooks,
        }
    }
    fn command(&self, mut command: Command, explicit_data: bool, input: Value) -> Command {
        command
            .env_clear()
            .current_dir(self.root.path())
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("APPDATA", self.home.join("appdata"))
            .env("LOCALAPPDATA", self.home.join("localappdata"))
            .env("XDG_CONFIG_HOME", self.home.join("config"))
            .env("XDG_DATA_HOME", self.home.join("data"))
            .env("PATH", self.root.path().join("no-runtimes"))
            .env(
                "LOONGSUITE_PILOT_CACHE_DIR",
                self.root.path().join("separate cache"),
            )
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.root.path().join("config.json"),
            );
        if explicit_data {
            command.env("LOONGSUITE_PILOT_DATA_DIR", &self.data);
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
        #[cfg(windows)]
        {
            let system = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot"));
            command.env(
                "PATH",
                std::env::join_paths([
                    system.join("System32"),
                    system.join("System32/WindowsPowerShell/v1.0"),
                ])
                .unwrap(),
            );
            if let Some(parent) = Path::new(command.get_program()).parent() {
                let modules = parent.join("Modules");
                if modules.is_dir() {
                    command.env("PSModulePath", modules);
                }
            }
        }
        let input_file = self
            .root
            .path()
            .join(format!("input-{}.json", uuid::Uuid::new_v4()));
        fs::write(&input_file, input.to_string()).unwrap();
        command
            .stdin(fs::File::open(input_file).unwrap())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    fn native(&self, agent: &str, event: Option<&str>, input: Value) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        cmd.args(["hook-process", agent]);
        if let Some(event) = event {
            cmd.arg(event);
        }
        if agent == "qoder-work" {
            cmd.args(["--agent-id", "qoder-work", "--log-prefix", "qoder-work"]);
        }
        self.command(cmd, true, input)
    }
    fn work_records(&self) -> Vec<Value> {
        let root = self.data.join("state/workbuddy/hook-events");
        if !root.exists() {
            return Vec::new();
        }
        let mut records = Vec::new();
        for session in fs::read_dir(root).unwrap() {
            let session = session.unwrap().path();
            if !session.is_dir() {
                continue;
            }
            for entry in fs::read_dir(session).unwrap() {
                let file = entry.unwrap().path();
                if file.extension().is_some_and(|value| value == "json") {
                    records.push(serde_json::from_slice(&fs::read(file).unwrap()).unwrap());
                }
            }
        }
        records
    }
    fn assert_no_default_data(&self) {
        assert!(!self.home.join(".loongsuite-pilot").exists());
    }
}
struct Child {
    child: CandidateChild,
    out: std::thread::JoinHandle<Vec<u8>>,
    err: std::thread::JoinHandle<Vec<u8>>,
}
impl Child {
    fn spawn(mut cmd: Command) -> Self {
        let mut child = CandidateChild::spawn(&mut cmd).unwrap();
        let out = child.take_stdout().unwrap();
        let err = child.take_stderr().unwrap();
        let read = |stream: Box<dyn Read + Send>| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                stream
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .unwrap();
                assert!(bytes.len() <= 1024 * 1024);
                bytes
            })
        };
        Self {
            child,
            out: read(Box::new(out)),
            err: read(Box::new(err)),
        }
    }
    fn finish(mut self, deadline: Instant) {
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "original Hook process budget exceeded"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        let out = self.out.join().unwrap();
        let err = self.err.join().unwrap();
        assert!(status.success(), "{}", String::from_utf8_lossy(&err));
        assert_eq!(out, b"{}\n", "stderr={}", String::from_utf8_lossy(&err));
    }
}
fn work_payload(session: &str, call: &str) -> Value {
    json!({"session_id":session,"transcript_path":"/tmp/safe/session.jsonl","cwd":"/tmp/safe","hook_event_name":"PreToolUse","tool_name":"Bash","call_id":call,"prompt":"DO_NOT_PERSIST_PROMPT","tool_input":{"command":"DO_NOT_PERSIST_ARGUMENTS"},"tool_response":"DO_NOT_PERSIST_RESULT"})
}
fn assert_safe(record: &Value, session: &str, call: &str) {
    assert_eq!(record["session_id"], session);
    assert_eq!(record["tool_call_id"], call);
    assert_eq!(record["hook_event_name"], "PreToolUse");
    assert_eq!(record["tool_name"], "Bash");
    assert!(!record.to_string().contains("DO_NOT_PERSIST"));
}
#[test]
fn workbuddy_real_native_writer_persists_only_structural_fields_and_fails_open() {
    let f = Fixture::new();
    Child::spawn(f.native(
        "workbuddy",
        Some("pre-tool-use"),
        work_payload("safe-session", "safe-call"),
    ))
    .finish(Instant::now() + Duration::from_secs(5));
    let records = f.work_records();
    assert_eq!(records.len(), 1);
    assert_safe(&records[0], "safe-session", "safe-call");
    // A syntactically invalid payload must leave the established record intact.
    let mut command = f.native("workbuddy", Some("stop"), Value::Null);
    let bad = f.root.path().join("bad-json");
    fs::write(&bad, "{bad-json").unwrap();
    command.stdin(fs::File::open(bad).unwrap());
    Child::spawn(command).finish(Instant::now() + Duration::from_secs(5));
    assert_eq!(f.work_records(), records);
    f.assert_no_default_data();
}
#[test]
fn workbuddy_twenty_four_real_native_processes_publish_unique_immutable_events() {
    let f = Fixture::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let children = (0..24)
        .map(|index| {
            Child::spawn(f.native(
                "workbuddy",
                Some("pre-tool-use"),
                work_payload("parallel-session", &format!("call-{index}")),
            ))
        })
        .collect::<Vec<_>>();
    for child in children {
        child.finish(deadline);
    }
    let records = f.work_records();
    assert_eq!(records.len(), 24);
    let calls = records
        .iter()
        .map(|record| record["tool_call_id"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        calls,
        (0..24).map(|index| format!("call-{index}")).collect()
    );
    assert!(records
        .iter()
        .all(|record| !record.to_string().contains("DO_NOT_PERSIST")));
    f.assert_no_default_data();
}
#[test]
fn line_records_four_real_native_processes_keep_session_files_and_rollback_shadow_independent() {
    let f = Fixture::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut expected = Vec::new();
    let mut children = Vec::new();
    for index in 0..4 {
        let session = format!("session-{index}");
        let transcript = f.root.path().join(format!("transcript-{index}.jsonl"));
        let end = 100 + index;
        fs::write(&transcript, "\n".repeat(end)).unwrap();
        let input = json!({"session_id":session,"transcript_path":transcript,"hook_event_name":"Stop","cwd":f.root.path()});
        children.push(Child::spawn(f.native("qoder-work", None, input)));
        expected.push((session, transcript, end));
    }
    for child in children {
        child.finish(deadline);
    }
    let state = f.data.join("state/hooks/qoder-work-line-records");
    let records = fs::read_dir(state)
        .unwrap()
        .filter_map(|entry| {
            let file = entry.unwrap().path();
            (file.extension().is_some_and(|value| value == "json"))
                .then(|| serde_json::from_slice::<Value>(&fs::read(file).unwrap()).unwrap())
        })
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 4);
    for (session, transcript, end) in expected {
        assert!(records.iter().any(|record| record["session_id"] == session
            && record["transcript_path"] == transcript.to_string_lossy().as_ref()
            && record["last_line_count"] == end));
    }
    let shadow = f.data.join("state/hooks/qoder-work-line-records.json");
    let aggregate: Value = serde_json::from_slice(&fs::read(&shadow).unwrap()).unwrap();
    assert_eq!(aggregate.as_object().unwrap().len(), 4);
    assert!(!PathBuf::from(format!("{}.lock", shadow.display())).exists());
    f.assert_no_default_data();
}
fn qwen_payload(f: &Fixture) -> Value {
    let file = f.root.path().join("qwen-transcript.jsonl");
    let rows = [
        json!({"type":"user","uuid":"prompt-1","sessionId":"qwen-installed","promptId":"qwen-turn","timestamp":"2026-08-06T03:44:58.934Z","message":{"role":"user","content":"installed prompt"}}),
        json!({"type":"assistant","uuid":"response-1","parentUuid":"prompt-1","sessionId":"qwen-installed","timestamp":"2026-08-06T03:45:03.994Z","message":{"role":"assistant","id":"response-1","model":"qwork-advanced","content":[{"type":"text","text":"installed answer"}],"stop_reason":"end_turn"}}),
    ];
    fs::write(
        &file,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    json!({"session_id":"qwen-installed","transcript_path":file,"hook_event_name":"Stop","cwd":"/workspace"})
}
fn assert_qwen_custom_root(f: &Fixture) {
    let history = f.data.join("logs/qwen-work-cn/history");
    let mut records = Vec::new();
    for entry in fs::read_dir(history).unwrap() {
        let file = entry.unwrap().path();
        if file.extension().is_some_and(|value| value == "jsonl") {
            records.extend(
                fs::read_to_string(file)
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).unwrap()),
            );
        }
    }
    assert!(records
        .iter()
        .any(|record| record["event.name"] == "llm.request"));
    assert!(records
        .iter()
        .all(|record| record["gen_ai.agent.type"] == "qwen-work-cn"));
    assert!(f
        .data
        .join("state/hooks/qwen-work-cn-line-records")
        .is_dir());
    f.assert_no_default_data();
}
#[cfg(unix)]
#[test]
fn installed_shell_workbuddy_resolves_data_and_native_pin_without_any_runtime_on_path() {
    let f = Fixture::new();
    let mut command = Command::new("/bin/bash");
    command
        .arg(f.hooks.join("workbuddy-loongsuite-pilot-hook.sh"))
        .arg("pre-tool-use");
    let command = f.command(
        command,
        false,
        work_payload("installed-session", "installed-call"),
    );
    Child::spawn(command).finish(Instant::now() + Duration::from_secs(5));
    let records = f.work_records();
    assert_eq!(records.len(), 1);
    assert_safe(&records[0], "installed-session", "installed-call");
    f.assert_no_default_data();
}
#[cfg(unix)]
#[test]
fn installed_shell_qwen_resolves_data_and_native_pin_without_any_runtime_on_path() {
    let f = Fixture::new();
    let mut command = Command::new("/bin/bash");
    command.arg(f.hooks.join("qwenworkcn-loongsuite-pilot-hook.sh"));
    let command = f.command(command, false, qwen_payload(&f));
    Child::spawn(command).finish(Instant::now() + Duration::from_secs(5));
    assert_qwen_custom_root(&f);
}
#[cfg(windows)]
fn powershell_command(f: &Fixture, script: &str) -> Command {
    let root = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot"));
    let mut command = Command::new(root.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(f.hooks.join(script));
    command
}
#[cfg(windows)]
#[test]
fn installed_powershell_workbuddy_native_pin_keeps_immediate_wakeup_without_node_under_original_budget(
) {
    let f = Fixture::new();
    let mut command = powershell_command(&f, "workbuddy-loongsuite-pilot-hook.ps1");
    command.arg("pre-tool-use");
    let command = f.command(
        command,
        false,
        work_payload("windows-pinned-node-session", "call-from-hook"),
    );
    let started = Instant::now();
    Child::spawn(command).finish(started + Duration::from_secs(15));
    assert!(started.elapsed() < Duration::from_secs(5));
    let records = f.work_records();
    assert_eq!(records.len(), 1);
    assert_safe(&records[0], "windows-pinned-node-session", "call-from-hook");
    f.assert_no_default_data();
}
#[cfg(windows)]
#[test]
fn installed_powershell_qwen_resolves_data_and_native_pin_without_node() {
    let f = Fixture::new();
    let command = powershell_command(&f, "qwenworkcn-loongsuite-pilot-hook.ps1");
    let command = f.command(command, false, qwen_payload(&f));
    Child::spawn(command).finish(Instant::now() + Duration::from_secs(15));
    assert_qwen_custom_root(&f);
}
