//! 从编译后的 Rust 工具执行字段质量验收；不调用 Node，不读取真实用户数据。

use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(root: &Path, args: &[&str]) -> Output {
    let capture = tempfile::tempdir().unwrap();
    let stdout = capture.path().join("stdout");
    let stderr = capture.path().join("stderr");
    let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
    command
        .arg("field-coverage")
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("PATH", root.join("no-runtimes"))
        .stdin(Stdio::null())
        .stdout(File::create(&stdout).unwrap())
        .stderr(File::create(&stderr).unwrap());
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().unwrap();
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if start.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Rust 字段工具执行超时：{args:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let read = |path| {
        let mut bytes = Vec::new();
        File::open(path)
            .unwrap()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(bytes.len() <= 1024 * 1024, "工具输出超限");
        bytes
    };
    Output {
        status,
        stdout: read(stdout),
        stderr: read(stderr),
    }
}

fn input(root: &Path, name: &str, contents: &str) {
    let directory = root.join(".loongsuite-pilot/logs/output");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(format!("{name}-2026-01-02.jsonl")), contents).unwrap();
}

fn response() -> String {
    json!({
        "event.name": "llm.response", "event.id": "event", "user.id": "用户🚀",
        "gen_ai.agent.type": "actual-agent", "gen_ai.session.id": "session",
        "gen_ai.step.id": "step", "gen_ai.response.id": "response",
        "gen_ai.response.model": "model", "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 1,
        "gen_ai.output.messages": [{"role":"assistant", "parts":[]}]
    })
    .to_string()
}

#[test]
fn native_field_cli_preserves_report_exit_codes_and_input_bytes_without_runtimes() {
    let root = tempfile::Builder::new()
        .prefix("字段 空格🚀")
        .tempdir()
        .unwrap();
    let contents = format!("\r\n{}\r\n", response());
    input(root.path(), "cursor", &contents);
    let output = invoke(
        root.path(),
        &[
            "-a",
            "cursor",
            "-d",
            "2026-01-02",
            "-t",
            "100",
            "-f",
            "json",
            "--strict",
        ],
    );
    assert!(output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["threshold"], 100.0);
    assert_eq!(report["tables"].as_array().unwrap().len(), 6);
    assert_eq!(report["tables"][1]["eventName"], "llm.response");
    let row = &report["tables"][1]["rows"][0];
    assert_eq!(row["agentType"], "actual-agent");
    assert_eq!(row["total"], 1);
    assert_eq!(row["avg"], 100.0);
    assert!(row["fields"]
        .as_array()
        .unwrap()
        .iter()
        .all(|field| field["pass"] == true));
    assert_eq!(
        fs::read_to_string(
            root.path()
                .join(".loongsuite-pilot/logs/output/cursor-2026-01-02.jsonl")
        )
        .unwrap(),
        contents
    );
    input(root.path(), "cursor", "{\"event.name\":\"tool.result\"}");
    let output = invoke(
        root.path(),
        &["-a", "cursor", "-d", "2026-01-02", "--strict"],
    );
    assert_eq!(output.status.code(), Some(1));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("unknown / tool.result: event.id(0.0%)"));
    assert!(text.contains("❌"));
}

#[test]
fn strict_cli_rejects_incomplete_inputs_and_preserves_previous_report_on_error() {
    let root = tempfile::tempdir().unwrap();
    input(root.path(), "cursor", &response());
    let output_path = root.path().join("报告🚀.json");
    fs::write(&output_path, "previous-report").unwrap();
    for other in [
        None,
        Some(""),
        Some("{\"secret\":broken}"),
        Some("[]"),
        Some("{\"event.name\":\"session.start\"}"),
    ] {
        if let Some(other) = other {
            input(root.path(), "codex", other);
        }
        let output = invoke(
            root.path(),
            &[
                "--agents",
                "cursor,codex",
                "--date",
                "2026-01-02",
                "--strict",
                "--output",
                output_path.to_str().unwrap(),
            ],
        );
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("secret"));
        assert_eq!(fs::read_to_string(&output_path).unwrap(), "previous-report");
    }
    let file = root
        .path()
        .join(".loongsuite-pilot/logs/output/cursor-2026-01-02.jsonl");
    let output = invoke(
        root.path(),
        &[
            "-a",
            "cursor",
            "-d",
            "2026-01-02",
            "-o",
            file.to_str().unwrap(),
        ],
    );
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(fs::read_to_string(file).unwrap(), response());
}

#[test]
fn compatibility_mode_remains_advisory_and_explicit_input_directory_is_supported() {
    let root = tempfile::tempdir().unwrap();
    input(
        root.path(),
        "cursor",
        "broken\n{\"event.name\":\"session.start\"}\n",
    );
    let directory = root.path().join(".loongsuite-pilot/logs/output");
    let report_path = root.path().join("result.json");
    let output = invoke(
        root.path(),
        &[
            "-a",
            "cursor,codex",
            "-d",
            "2026-01-02",
            "--input-dir",
            directory.to_str().unwrap(),
            "-f",
            "json",
            "-o",
            report_path.to_str().unwrap(),
        ],
    );
    assert!(output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty());
    let report: Value = serde_json::from_slice(&fs::read(report_path).unwrap()).unwrap();
    assert!(report["tables"]
        .as_array()
        .unwrap()
        .iter()
        .all(|table| table["rows"].as_array().unwrap().is_empty()));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("warning:"));
    assert!(stderr.contains("--strict"));
}

#[test]
fn invalid_cli_parameters_and_missing_inputs_return_two_without_writes() {
    let root = tempfile::tempdir().unwrap();
    for args in [
        vec![],
        vec!["-a", "../escape"],
        vec!["-a", "cursor,cursor"],
        vec!["-a", "cursor", "-t", "NaN"],
        vec!["-a", "cursor", "-t", "101"],
        vec!["-a", "cursor", "-f", "xml"],
        vec!["-a", "cursor", "-d", "2026-02-30"],
        vec!["-a", "cursor", "-d", "2026-1-2"],
        vec!["-a", "cursor", "--unknown"],
        vec!["-a", "cursor", "-d", "2026-01-02"],
    ] {
        let output = invoke(root.path(), &args);
        assert_eq!(output.status.code(), Some(2), "{args:?} {output:?}");
        assert!(output.stdout.is_empty());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
    let output = invoke(root.path(), &["--help"]);
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("--strict"));
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn native_field_cli_groups_aliases_and_reports_invocation_coverage_without_rewriting_inputs() {
    let root = tempfile::tempdir().unwrap();
    let response: Value = serde_json::from_str(&response()).unwrap();
    let mut alias = response.clone();
    alias["event.name"] = json!("gen_ai.model.response");
    let audit = json!({"event.name":"gen_ai.agent.invoke", "event.id":"audit", "user.id":"user",
        "gen_ai.agent.type":"actual-agent", "gen_ai.session.id":"session", "gen_ai.turn.id":"turn",
        "gen_ai.agent.invocation.id":"invocation"});
    let contents = format!("{}\n{}\n{}\n", response, alias, audit);
    input(root.path(), "codex", &contents);
    let result = invoke(
        root.path(),
        &[
            "-a",
            "codex",
            "-d",
            "2026-01-02",
            "-t",
            "100",
            "-f",
            "json",
            "--strict",
        ],
    );
    assert!(result.status.success(), "{result:?}");
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["tables"][1]["rows"][0]["total"], 2);
    assert_eq!(report["tables"][4]["rows"][0]["total"], 1);
    assert_eq!(report["tables"][4]["rows"][0]["avg"], 100.0);
    assert_eq!(
        fs::read_to_string(
            root.path()
                .join(".loongsuite-pilot/logs/output/codex-2026-01-02.jsonl")
        )
        .unwrap(),
        contents
    );
}

/// Exact main/standard-event-validators contract: exercise the compiled CLI on all ten
/// historical/standard names, including both invocation audit events.
#[test]
fn main_standard_event_l19_all_six_families_count_each_alias_once_and_leave_source_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let names = [
        "llm.request",
        "llm.response",
        "tool.call",
        "tool.result",
        "gen_ai.model.request",
        "gen_ai.model.response",
        "gen_ai.tool.call",
        "gen_ai.tool.result",
        "gen_ai.agent.invoke",
        "gen_ai.agent.result",
    ];
    let mut original = String::new();
    for (index, name) in names.into_iter().enumerate() {
        let event = json!({
            "event.id": format!("event-{index}"), "event.name": name, "user.id": "test-user",
            "gen_ai.agent.type": "codex", "gen_ai.session.id": "child-session",
            "gen_ai.turn.id": "child-turn", "gen_ai.step.id": "child-step",
            "gen_ai.provider.name": "openai", "gen_ai.request.model": "test-model",
            "gen_ai.input.messages_delta": [{"role": "user", "parts": []}],
            "gen_ai.response.id": "response", "gen_ai.response.model": "test-model",
            "gen_ai.response.finish_reasons": ["stop"],
            "gen_ai.output.messages": [{"role": "assistant", "parts": [{"type": "text", "content": "test"}]}],
            "gen_ai.usage.input_tokens": 1, "gen_ai.usage.output_tokens": 1,
            "gen_ai.tool.name": "test-tool", "gen_ai.tool.call.id": "call",
            "gen_ai.tool.call.arguments": {}, "gen_ai.tool.call.duration": 1,
            "gen_ai.agent.invocation.id": "outgoing", "gen_ai.agent.parent.invocation.id": "incoming",
        });
        original.push_str(&event.to_string());
        original.push('\n');
    }
    let directory = root.path().join(".loongsuite-pilot/logs/output");
    fs::create_dir_all(&directory).unwrap();
    let source = directory.join("codex-2026-10-16.jsonl");
    fs::write(&source, &original).unwrap();
    let output = invoke(
        root.path(),
        &[
            "--agents",
            "codex",
            "--date",
            "2026-10-16",
            "--format",
            "json",
        ],
    );
    assert!(output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let tables = report["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 6);
    let counts: std::collections::BTreeMap<_, _> = tables
        .iter()
        .map(|table| {
            (
                table["eventName"].as_str().unwrap(),
                table["rows"][0]["total"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        counts,
        [
            ("llm.request", 2),
            ("llm.response", 2),
            ("tool.call", 2),
            ("tool.result", 2),
            ("gen_ai.agent.invoke", 1),
            ("gen_ai.agent.result", 1),
        ]
        .into()
    );
    assert_eq!(fs::read(&source).unwrap(), original.as_bytes());
}
