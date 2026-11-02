//! 由正式 Rust CLI 验证历史 JSONL 校验合同；受控 PATH 不提供 Node/Python。

use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(root: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let capture = tempfile::tempdir().unwrap();
    let stdout = capture.path().join("stdout");
    let stderr = capture.path().join("stderr");
    let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
    command
        .arg("validate-jsonl")
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
    command.envs(env.iter().copied());
    let mut child = command.spawn().unwrap();
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if start.elapsed() >= Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("JSONL 校验器超时");
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
        assert!(bytes.len() <= 1024 * 1024);
        bytes
    };
    Output {
        status,
        stdout: read(stdout),
        stderr: read(stderr),
    }
}
fn entry(id: &str, event: &str) -> Value {
    json!({
        "time_unix_nano": (i128::from(chrono::Utc::now().timestamp_millis()) * 1_000_000).to_string(),
        "event.id":id, "event.name":event, "user.id":"synthetic-user",
        "gen_ai.session.id":"session-1", "gen_ai.agent.type":"workbuddy", "gen_ai.provider.name":"workbuddy"
    })
}
fn graph() -> Vec<Value> {
    let mut rows: Vec<_> = [
        "llm.request",
        "llm.response",
        "tool.call",
        "tool.call",
        "tool.result",
        "tool.result",
        "llm.request",
        "llm.response",
    ]
    .iter()
    .enumerate()
    .map(|(i, event)| entry(&format!("evt-{i}"), event))
    .collect();
    for (index, row) in rows.iter_mut().enumerate() {
        row["gen_ai.turn.id"] = json!("turn-1");
        row["gen_ai.step.id"] = json!(if index < 6 { "step-1" } else { "step-2" });
    }
    rows[0]["gen_ai.turn.start"] = json!(true);
    rows[0]["gen_ai.request.id"] = json!("request-1");
    rows[0]["gen_ai.request.model"] = json!("model-synthetic");
    rows[0]["gen_ai.input.messages_delta"] =
        json!([{"role":"user","parts":[{"type":"text","content":"SYNTHETIC_INPUT"}]}]);
    rows[1]["gen_ai.response.finish_reasons"] = json!(["tool_calls"]);
    rows[1]["gen_ai.output.messages"] =
        json!([{"role":"assistant","parts":[{"type":"tool_call","id":"call-a"}]}]);
    for (index, row) in rows.iter_mut().enumerate().take(6).skip(2) {
        row["gen_ai.tool.name"] = json!("SyntheticRead");
        row["gen_ai.tool.call.id"] = json!(if index % 2 == 0 { "call-a" } else { "call-b" });
        if index < 4 {
            row["gen_ai.tool.call.arguments"] = json!({"path":"/workspace/synthetic.txt"});
        } else {
            row["gen_ai.tool.call.result"] = json!({"ok":true});
            row["gen_ai.tool.call.duration"] = json!(100);
            row["tool.result.status"] = json!("success");
        }
    }
    rows[6]["gen_ai.input.messages_delta"] = json!([
        {"role":"tool","parts":[{"type":"tool_call_response","id":"call-a","response":{"ok":true}}]},
        {"role":"tool","parts":[{"type":"tool_call_response","id":"call-b","response":{"ok":true}}]}
    ]);
    rows[7]["gen_ai.turn.end"] = json!(true);
    rows[7]["gen_ai.response.finish_reasons"] = json!(["stop"]);
    rows[7]["gen_ai.output.messages"] =
        json!([{"role":"assistant","parts":[{"type":"text","content":"SYNTHETIC_OUTPUT"}]}]);
    for index in [1, 7] {
        rows[index]["gen_ai.response.id"] = json!(format!("response-{index}"));
        rows[index]["gen_ai.response.model"] = json!("model-synthetic");
        rows[index]["gen_ai.usage.input_tokens"] = json!(10);
        rows[index]["gen_ai.usage.output_tokens"] = json!(2);
        rows[index]["gen_ai.usage.total_tokens"] = json!(12);
    }
    rows
}
fn write(root: &Path, name: &str, rows: &[Value]) -> std::path::PathBuf {
    let directory = root.join(".loongsuite-pilot/logs/output");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{name}-2026-05-11.jsonl"));
    fs::write(
        &path,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\r\n")
            + "\n",
    )
    .unwrap();
    path
}
fn report(root: &Path) -> (Output, Value) {
    let output = invoke(
        root,
        &["--strict", "--agent-filter", "all", "--format", "json"],
        &[],
    );
    let parsed = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&output.stderr)));
    (output, parsed)
}

#[test]
fn native_jsonl_graph_coverage_and_inputs_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let path = write(root.path(), "workbuddy", &graph());
    let before = fs::read(&path).unwrap();
    let output = invoke(
        root.path(),
        &["--strict", "--agent-filter", "workbuddy"],
        &[],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    for expected in [
        "OK workbuddy-2026-05-11.jsonl",
        "missing_required=0",
        "tool.call count=2",
        "gen_ai.tool.call.id=2 (100.0%)",
    ] {
        assert!(text.contains(expected), "{expected}: {text}");
    }
    assert_eq!(fs::read(path).unwrap(), before);
    let (output, report) = report(root.path());
    assert!(output.status.success());
    assert_eq!(report["hardIssues"], 0);
    assert_eq!(report["coverage"]["tool.result"]["count"], 2);
}

#[test]
fn native_jsonl_rejects_each_historical_graph_error_without_payload_leaks() {
    for (case, category, count) in [
        ("required", "missing_required", 1),
        ("duplicate", "duplicate_event_id", 1),
        ("types", "type_error", 2),
        ("model", "model_pair_error", 1),
        ("tool", "tool_pair_error", 1),
        ("end", "turn_boundary_error", 1),
        ("both", "turn_boundary_error", 1),
        ("enum", "bad_event_name", 1),
        ("error", "missing_required", 1),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut rows = graph();
        match case {
            "required" => {
                rows[0].as_object_mut().unwrap().remove("user.id");
            }
            "duplicate" => rows[7]["event.id"] = rows[0]["event.id"].clone(),
            "types" => {
                rows[2]["gen_ai.tool.call.arguments"] = json!("{\"secret\":\"SENSITIVE_MARKER_MUST_NOT_APPEAR\",\"path\":\"/Users/private/person\"}");
                rows[4]["gen_ai.tool.call.duration"] = json!(0);
            }
            "model" => {
                rows.remove(1);
            }
            "tool" => rows[4]["gen_ai.tool.name"] = json!("DifferentSyntheticTool"),
            "end" => {
                rows[7].as_object_mut().unwrap().remove("gen_ai.turn.end");
            }
            "both" => {
                rows[0].as_object_mut().unwrap().remove("gen_ai.turn.start");
                rows[7].as_object_mut().unwrap().remove("gen_ai.turn.end");
            }
            "enum" => rows[0]["event.name"] = json!("unknown.invalid.event"),
            "error" => rows[4]["tool.result.status"] = json!("failure"),
            _ => unreachable!(),
        }
        write(root.path(), "workbuddy", &rows);
        let (output, result) = report(root.path());
        assert_eq!(output.status.code(), Some(1), "{case}: {result}");
        assert_eq!(result["issueCounts"][category], count, "{case}: {result}");
        let text = String::from_utf8(output.stdout).unwrap();
        for secret in [
            "SENSITIVE_MARKER_MUST_NOT_APPEAR",
            "/Users/private/person",
            "SYNTHETIC_INPUT",
            "SYNTHETIC_OUTPUT",
        ] {
            assert!(!text.contains(secret), "{case}: 输出包含用户内容");
        }
    }
}

#[test]
fn native_jsonl_accepts_incomplete_compatibility_and_agent_specific_turns() {
    for case in [
        "incomplete",
        "compatibility",
        "codex",
        "openclaw",
        "subagent",
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut row = entry("evt-other", "other");
        row["gen_ai.turn.id"] = json!("turn");
        row["gen_ai.turn.start"] = json!(true);
        let mut rows = vec![row];
        match case {
            "compatibility" => {
                let mut input = rows[0].clone();
                input["event.id"] = json!("evt-input");
                input["event.name"] = json!("agent.input");
                input.as_object_mut().unwrap().remove("gen_ai.turn.start");
                rows.push(input);
            }
            "codex" => {
                rows[0]["gen_ai.agent.type"] = json!("Codex");
                rows[0]["agent.codex.turn_status"] = json!("interrupted");
                rows[0]["gen_ai.turn.end"] = json!(true);
            }
            "openclaw" => {
                rows[0]["gen_ai.agent.type"] = json!("OpenClaw");
                rows[0]["agent.openclaw.hook"] = json!("llm_output");
                rows[0]["gen_ai.turn.end"] = json!(true);
            }
            "subagent" => {
                rows[0]["gen_ai.agent.scope"] = json!("subagent");
                rows[0].as_object_mut().unwrap().remove("gen_ai.turn.start");
            }
            _ => {}
        }
        write(root.path(), "workbuddy", &rows);
        let (output, result) = report(root.path());
        assert!(output.status.success(), "{case}: {result}");
        if matches!(case, "codex" | "openclaw") {
            rows[0].as_object_mut().unwrap().remove("gen_ai.turn.end");
            write(root.path(), "workbuddy", &rows);
            let (output, result) = report(root.path());
            if case == "codex" {
                // f84 replaces the old status-implies-terminal assumption.
                assert!(output.status.success(), "{result}");
                assert_eq!(
                    result["issueCounts"]["turn_boundary_error"]
                        .as_u64()
                        .unwrap_or(0),
                    0
                );
            } else {
                assert_eq!(output.status.code(), Some(1));
                assert_eq!(result["issueCounts"]["turn_boundary_error"], 1);
            }
        }
    }
}

#[test]
fn native_jsonl_accepts_projected_workbuddy_without_unreliable_tool_names() {
    use loongsuite_pilot::inputs::workbuddy::{build_work_buddy_events, WorkBuddyBuildOptions};
    use loongsuite_pilot::normalization::{project_log_entry, SerialiseLogEntryOptions};
    let records: Vec<Value> = include_str!("../../tests/fixtures/workbuddy/multi-tool-wave.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut value: Value = serde_json::from_str(line).unwrap();
            if matches!(
                value["type"].as_str(),
                Some("function_call" | "function_call_result")
            ) {
                value.as_object_mut().unwrap().remove("name");
            }
            value
        })
        .collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let built = runtime
        .block_on(build_work_buddy_events(
            &records,
            &WorkBuddyBuildOptions::new("session-synthetic-1"),
        ))
        .unwrap();
    assert!(!built.is_empty());
    let projected: Vec<Value> = built
        .into_iter()
        .map(|mut entry| {
            entry.user_id = "synthetic-user".into();
            Value::Object(project_log_entry(
                &entry,
                &SerialiseLogEntryOptions {
                    drop_agent_scoped_fields: true,
                },
            ))
        })
        .collect();
    assert!(!projected.iter().any(|entry| matches!(
        entry["event.name"].as_str(),
        Some("tool.call" | "tool.result")
    )));
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "workbuddy", &projected);
    let (output, result) = report(root.path());
    assert!(output.status.success(), "{result}");
    assert_eq!(result["issueCounts"]["missing_required"], 0);
    assert_eq!(result["issueCounts"]["tool_pair_error"], 0);
}

#[test]
fn native_jsonl_filters_environment_and_diagnostic_exit_codes_match() {
    let root = tempfile::tempdir().unwrap();
    for agent in [
        "claude-code",
        "codex",
        "qoder-cli",
        "cursor-cli",
        "qwen-code-cli",
        "opencode",
        "qoder",
        "cursor",
    ] {
        let mut row = entry(agent, "llm.request");
        if agent == "cursor" {
            row["event.name"] = json!("invalid");
        }
        write(root.path(), agent, &[row]);
    }
    let default = invoke(root.path(), &["--strict", "--format", "json"], &[]);
    assert!(default.status.success());
    let result: Value = serde_json::from_slice(&default.stdout).unwrap();
    assert_eq!(result["files"].as_array().unwrap().len(), 6);
    let filtered = invoke(
        root.path(),
        &["--format", "json"],
        &[
            ("E2E_JSONL_AGENT_FILTER", "cursor"),
            ("E2E_JSONL_STRICT", "1"),
        ],
    );
    assert_eq!(filtered.status.code(), Some(1));
    let result: Value = serde_json::from_slice(&filtered.stdout).unwrap();
    // 历史过滤规则是文件名前缀；cursor 同时匹配 cursor-cli。
    assert_eq!(result["files"].as_array().unwrap().len(), 2);
    let diagnostic = invoke(root.path(), &[], &[("E2E_JSONL_AGENT_FILTER", "all")]);
    assert!(diagnostic.status.success());
    assert!(String::from_utf8(diagnostic.stdout)
        .unwrap()
        .contains("bad_event_name=1"));
    let all = invoke(
        root.path(),
        &[],
        &[("E2E_JSONL_AGENT_FILTER", "*"), ("E2E_JSONL_STRICT", "1")],
    );
    assert_eq!(all.status.code(), Some(1));
}

#[test]
fn native_jsonl_strict_never_accepts_empty_malformed_or_out_of_window_inputs() {
    let root = tempfile::tempdir().unwrap();
    let (output, result) = report(root.path());
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(result["issueCounts"]["no_files"], 1);
    assert!(invoke(root.path(), &[], &[]).status.success());
    let path = write(root.path(), "workbuddy", &[]);
    for (raw, category) in [
        (" \r\n", "empty_input"),
        ("{broken\n", "parse_error"),
        ("null\n[]\n42\n", "type_error"),
    ] {
        fs::write(&path, raw).unwrap();
        let (output, result) = report(root.path());
        assert_eq!(output.status.code(), Some(1));
        assert!(result["issueCounts"][category].as_u64().unwrap() > 0);
    }
    let mut old = entry("old", "other");
    old["time_unix_nano"] = json!("1");
    write(root.path(), "workbuddy", &[old]);
    let output = invoke(
        root.path(),
        &[
            "--strict",
            "--agent-filter",
            "workbuddy",
            "--since-seconds",
            "1",
            "--format",
            "json",
        ],
        &[],
    );
    assert_eq!(output.status.code(), Some(1));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["windowed"], 0);
    assert_eq!(result["issueCounts"]["empty_window"], 1);
    let mut malformed = entry("bad", "other");
    malformed["time_unix_nano"] = json!("not-a-time");
    write(root.path(), "workbuddy", &[malformed]);
    let output = invoke(
        root.path(),
        &[
            "--strict",
            "--agent-filter",
            "workbuddy",
            "--since-seconds",
            "1",
            "--format",
            "json",
        ],
        &[],
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(result["issueCounts"]["type_error"], 1);
}

#[test]
fn native_jsonl_checks_types_cross_file_graphs_limits_and_explicit_paths() {
    let root = tempfile::tempdir().unwrap();
    let rows = graph();
    write(root.path(), "workbuddy-a", &rows[..4]);
    write(root.path(), "workbuddy-b", &rows[4..]);
    assert!(report(root.path()).0.status.success());
    let input = tempfile::tempdir().unwrap();
    let directory = input.path().join("日志 空格🚀");
    fs::create_dir(&directory).unwrap();
    for (field, value) in [
        ("trace_id", json!("00000000000000000000000000000000")),
        ("parent_span_id", json!("short")),
        ("gen_ai.usage.input_tokens", json!(-1)),
        ("gen_ai.usage.output_tokens", json!("2")),
        ("gen_ai.input.messages", json!("[]")),
        ("gen_ai.turn.start", json!("true")),
        ("observed_time_unix_nano", json!(3)),
    ] {
        let mut row = entry("type", "other");
        row[field] = value;
        fs::write(directory.join("workbuddy.jsonl"), row.to_string()).unwrap();
        let output = invoke(
            root.path(),
            &[
                "--strict",
                "--agent-filter",
                "all",
                "--input-dir",
                directory.to_str().unwrap(),
                "--format",
                "json",
            ],
            &[],
        );
        assert_eq!(output.status.code(), Some(1), "{field}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["issueCounts"]["type_error"], 1, "{field}");
    }
    fs::write(
        directory.join("workbuddy.jsonl"),
        entry("valid", "other").to_string(),
    )
    .unwrap();
    let env = [
        ("_JV_LOG_DIR", directory.to_str().unwrap()),
        ("E2E_JSONL_AGENT_FILTER", "all"),
        ("E2E_JSONL_STRICT", "1"),
    ];
    assert!(invoke(root.path(), &[], &env).status.success());
    let file = File::create(directory.join("oversize.jsonl")).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    assert_eq!(invoke(root.path(), &[], &env).status.code(), Some(2));
    for args in [
        vec!["--since-seconds", "-1"],
        vec!["--max-samples", "1001"],
        vec!["--agent-filter", ","],
    ] {
        assert_eq!(invoke(root.path(), &args, &[]).status.code(), Some(2));
    }
    assert_eq!(
        invoke(root.path(), &[], &[("E2E_JSONL_STRICT", "yes")])
            .status
            .code(),
        Some(2)
    );
}

#[test]
fn native_jsonl_accepts_standard_names_and_audits_but_rejects_duplicate_alias_facts() {
    let root = tempfile::tempdir().unwrap();
    let mut rows = graph();
    for row in &mut rows {
        row["event.name"] = json!(match row["event.name"].as_str().unwrap() {
            "llm.request" => "gen_ai.model.request",
            "llm.response" => "gen_ai.model.response",
            "tool.call" => "gen_ai.tool.call",
            "tool.result" => "gen_ai.tool.result",
            name => name,
        });
    }
    for (i, event) in ["gen_ai.agent.invoke", "gen_ai.agent.result"]
        .iter()
        .enumerate()
    {
        let mut audit = entry(&format!("audit-{i}"), event);
        audit["gen_ai.agent.invocation.id"] = json!("invocation-1");
        rows.push(audit);
    }
    let path = write(root.path(), "workbuddy", &rows);
    let before = fs::read(&path).unwrap();
    let (output, parsed) = report(root.path());
    assert!(output.status.success(), "{parsed}");
    assert_eq!(fs::read(&path).unwrap(), before);
    let mut duplicate = rows[0].clone();
    duplicate["event.id"] = json!("duplicate-alias-fact");
    duplicate["event.name"] = json!("llm.request");
    rows.push(duplicate);
    write(root.path(), "workbuddy", &rows);
    let (output, parsed) = report(root.path());
    assert!(!output.status.success());
    assert!(parsed.to_string().contains("model_pair_error"));
    rows.pop();
    rows.last_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("gen_ai.agent.invocation.id");
    write(root.path(), "workbuddy", &rows);
    let (output, parsed) = report(root.path());
    assert!(!output.status.success());
    assert!(parsed.to_string().contains("gen_ai.agent.invocation.id"));
}

#[test]
fn native_jsonl_f84_mixed_standard_aliases_and_audit_coverage() {
    let root = tempfile::tempdir().unwrap();
    let mut rows = graph();
    for (index, row) in rows.iter_mut().enumerate() {
        if [4, 6].contains(&index) {
            continue;
        }
        row["event.name"] = json!(match row["event.name"].as_str().unwrap() {
            "llm.request" => "gen_ai.model.request",
            "llm.response" => "gen_ai.model.response",
            "tool.call" => "gen_ai.tool.call",
            "tool.result" => "gen_ai.tool.result",
            name => name,
        });
    }
    for (index, name) in ["gen_ai.agent.invoke", "gen_ai.agent.result"]
        .into_iter()
        .enumerate()
    {
        let mut row = entry(&format!("delegation-{index}"), name);
        row["gen_ai.turn.id"] = json!("turn-1");
        row["gen_ai.agent.invocation.id"] = json!("invocation-1");
        row["gen_ai.tool.call.id"] = json!("call-a");
        rows.push(row);
    }
    write(root.path(), "workbuddy", &rows);
    let (output, result) = report(root.path());
    assert!(output.status.success(), "{result}");
    for category in ["bad_event_name", "model_pair_error", "tool_pair_error"] {
        assert_eq!(
            result["issueCounts"][category].as_u64().unwrap_or(0),
            0,
            "{category}: {result}"
        );
    }
    assert_eq!(result["coverage"]["gen_ai.agent.invoke"]["count"], 1);
    assert_eq!(result["coverage"]["gen_ai.agent.result"]["count"], 1);
    let mut duplicates = graph();
    let mut duplicate = duplicates[0].clone();
    duplicate["event.id"] = json!("duplicate-standard-request");
    duplicate["event.name"] = json!("gen_ai.model.request");
    duplicate
        .as_object_mut()
        .unwrap()
        .remove("gen_ai.turn.start");
    duplicates.push(duplicate);
    write(root.path(), "workbuddy", &duplicates);
    let (output, result) = report(root.path());
    assert_eq!(output.status.code(), Some(1), "{result}");
    assert_eq!(
        result["issueCounts"]["bad_event_name"]
            .as_u64()
            .unwrap_or(0),
        0
    );
    assert_eq!(result["issueCounts"]["model_pair_error"], 1);
}

#[test]
fn native_jsonl_f84_standard_tool_fields_and_both_invocation_ids_are_required() {
    let root = tempfile::tempdir().unwrap();
    let mut rows = graph();
    rows[2]["event.name"] = json!("gen_ai.tool.call");
    rows[2].as_object_mut().unwrap().remove("gen_ai.tool.name");
    write(root.path(), "workbuddy", &rows);
    let (output, result) = report(root.path());
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(result["issueCounts"]["missing_required"], 1);
    for event in ["gen_ai.agent.invoke", "gen_ai.agent.result"] {
        let mut row = entry("audit", event);
        row["gen_ai.agent.type"] = json!("codex");
        write(root.path(), "workbuddy", &[row.clone()]);
        let (output, result) = report(root.path());
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(result["issueCounts"]["missing_required"], 1);
        assert!(result.to_string().contains("gen_ai.agent.invocation.id"));
        row["gen_ai.agent.invocation.id"] = json!("invocation-1");
        write(root.path(), "workbuddy", &[row]);
        assert!(report(root.path()).0.status.success());
    }
}

#[test]
fn native_jsonl_f84_codex_scope_and_status_wait_for_native_turn_end() {
    for scope in [None, Some("subagent")] {
        for status in [None, Some("interrupted"), Some("completed")] {
            let root = tempfile::tempdir().unwrap();
            let mut row = entry("running", "llm.request");
            row["gen_ai.agent.type"] = json!("codex");
            row["gen_ai.turn.id"] = json!("turn-1");
            row["gen_ai.turn.start"] = json!(true);
            if let Some(scope) = scope {
                row["gen_ai.agent.scope"] = json!(scope);
            }
            if let Some(status) = status {
                row["agent.codex.turn_status"] = json!(status);
            }
            write(root.path(), "workbuddy", &[row.clone()]);
            let (output, result) = report(root.path());
            assert!(
                output.status.success(),
                "scope={scope:?} status={status:?}: {result}"
            );
            assert_eq!(
                result["issueCounts"]["turn_boundary_error"]
                    .as_u64()
                    .unwrap_or(0),
                0
            );
            row["event.id"] = json!("native-end");
            row.as_object_mut().unwrap().remove("gen_ai.turn.start");
            row["gen_ai.turn.end"] = json!(true);
            let mut start = row.clone();
            start["event.id"] = json!("running");
            start["gen_ai.turn.start"] = json!(true);
            start.as_object_mut().unwrap().remove("gen_ai.turn.end");
            write(root.path(), "workbuddy", &[start, row]);
            assert!(report(root.path()).0.status.success());
        }
    }
}

#[test]
fn native_jsonl_f84_rejects_missing_and_duplicate_codex_child_boundaries() {
    for flags in [
        vec![(false, true)],
        vec![(true, false), (true, false)],
        vec![(true, true), (false, true)],
    ] {
        let root = tempfile::tempdir().unwrap();
        let rows = flags
            .into_iter()
            .enumerate()
            .map(|(index, (start, end))| {
                let mut row = entry(&format!("child-{index}"), "other");
                row["gen_ai.agent.type"] = json!("codex");
                row["gen_ai.agent.scope"] = json!("subagent");
                row["gen_ai.turn.id"] = json!("child-turn");
                if start {
                    row["gen_ai.turn.start"] = json!(true);
                }
                if end {
                    row["gen_ai.turn.end"] = json!(true);
                }
                row
            })
            .collect::<Vec<_>>();
        write(root.path(), "workbuddy", &rows);
        let (output, result) = report(root.path());
        assert_eq!(output.status.code(), Some(1), "{result}");
        assert_eq!(result["issueCounts"]["turn_boundary_error"], 1, "{result}");
    }
}

#[test]
fn native_jsonl_f84_non_codex_children_and_terminal_signals_keep_their_contracts() {
    let root = tempfile::tempdir().unwrap();
    let rows = (0..2)
        .map(|index| {
            let mut row = entry(&format!("child-{index}"), "other");
            row["gen_ai.agent.type"] = json!("claude-code");
            row["gen_ai.agent.scope"] = json!("subagent");
            row["gen_ai.turn.id"] = json!("child-turn");
            row["gen_ai.turn.start"] = json!(true);
            row["gen_ai.turn.end"] = json!(true);
            row
        })
        .collect::<Vec<_>>();
    write(root.path(), "workbuddy", &rows);
    assert!(report(root.path()).0.status.success());
    for (agent, key, value) in [
        (
            "claude-code",
            "gen_ai.response.finish_reasons",
            json!(["stop"]),
        ),
        ("openclaw", "agent.openclaw.hook", json!("llm_output")),
    ] {
        let mut row = entry("terminal", "other");
        row["gen_ai.agent.type"] = json!(agent);
        row["gen_ai.turn.id"] = json!("turn-1");
        row["gen_ai.turn.start"] = json!(true);
        row[key] = value;
        write(root.path(), "workbuddy", &[row.clone()]);
        let (output, result) = report(root.path());
        assert_eq!(output.status.code(), Some(1), "{result}");
        assert_eq!(result["issueCounts"]["turn_boundary_error"], 1);
        row["gen_ai.turn.end"] = json!(true);
        write(root.path(), "workbuddy", &[row]);
        assert!(report(root.path()).0.status.success());
    }
}

#[test]
fn native_jsonl_f84_codex_delegation_audits_do_not_create_a_turn() {
    let root = tempfile::tempdir().unwrap();
    let rows = ["gen_ai.agent.invoke", "gen_ai.agent.result"]
        .into_iter()
        .enumerate()
        .map(|(index, event)| {
            let mut row = entry(&format!("delegation-{index}"), event);
            row["gen_ai.agent.type"] = json!("codex");
            row["gen_ai.turn.id"] = json!("parent-turn");
            row["gen_ai.agent.invocation.id"] = json!("invocation-1");
            row
        })
        .collect::<Vec<_>>();
    write(root.path(), "workbuddy", &rows);
    let (output, result) = report(root.path());
    assert!(output.status.success(), "{result}");
    assert_eq!(
        result["issueCounts"]["turn_boundary_error"]
            .as_u64()
            .unwrap_or(0),
        0
    );
}

#[test]
fn native_jsonl_baseline_exact_text_hints_prefixes_and_private_value_redaction() {
    let empty = tempfile::tempdir().unwrap();
    let output = invoke(empty.path(), &[], &[]);
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("no .jsonl files"));

    let missing = tempfile::tempdir().unwrap();
    let good = entry("evt-1", "llm.request");
    let mut bad = good.clone();
    bad.as_object_mut().unwrap().remove("user.id");
    write(missing.path(), "codex", &[good, bad]);
    let output = invoke(missing.path(), &["--strict"], &[]);
    let text = String::from_utf8(output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(text.contains("FAIL codex-2026-05-11.jsonl"), "{text}");
    assert!(text.contains("missing_required=1"), "{text}");
    assert!(
        text.contains("category=missing_required fields=[user.id]"),
        "{text}"
    );

    let filtered = tempfile::tempdir().unwrap();
    write(filtered.path(), "claude", &[entry("claude", "llm.request")]);
    let mut bad = entry("codex", "llm.request");
    bad.as_object_mut().unwrap().remove("event.name");
    write(filtered.path(), "codex", &[bad]);
    let output = invoke(
        filtered.path(),
        &[],
        &[
            ("E2E_JSONL_AGENT_FILTER", "claude"),
            ("E2E_JSONL_STRICT", "1"),
        ],
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "{text}");
    assert!(text.contains("claude-2026-05-11.jsonl"));
    assert!(!text.contains("codex-2026-05-11.jsonl"));

    let invalid = tempfile::tempdir().unwrap();
    // f84 explicitly replaces the former standard-name negative fixture.
    write(
        invalid.path(),
        "claude-code",
        &[entry("bad", "invalid.event.name")],
    );
    for strict in [false, true] {
        let output = invoke(
            invalid.path(),
            if strict { &["--strict"] } else { &[] },
            &[],
        );
        assert_eq!(output.status.code(), Some(if strict { 1 } else { 0 }));
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("bad_event_name=1"));
    }

    let input = tempfile::tempdir().unwrap();
    write(
        input.path(),
        "claude-code",
        &[entry("input", "agent.input")],
    );
    let output = invoke(input.path(), &["--strict"], &[]);
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("bad_event_name=0"));

    let all = tempfile::tempdir().unwrap();
    write(all.path(), "cursor", &[entry("cursor", "llm.request")]);
    let output = invoke(
        all.path(),
        &[],
        &[("E2E_JSONL_AGENT_FILTER", "all"), ("E2E_JSONL_STRICT", "1")],
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "{text}");
    assert!(text.contains("cursor-2026-05-11.jsonl"));

    let privacy = tempfile::tempdir().unwrap();
    let mut rows = graph();
    rows[2]["gen_ai.tool.call.arguments"] = json!(
        "{\"secret\":\"SENSITIVE_MARKER_MUST_NOT_APPEAR\",\"path\":\"/Users/private/person\"}"
    );
    write(privacy.path(), "workbuddy", &rows);
    let output = invoke(
        privacy.path(),
        &["--strict", "--agent-filter", "workbuddy"],
        &[],
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(text.contains("type_error=1"), "{text}");
    assert!(!text.contains("SENSITIVE_MARKER_MUST_NOT_APPEAR"));
    assert!(!text.contains("/Users/private/person"));

    let defaults = tempfile::tempdir().unwrap();
    for agent in [
        "claude-code",
        "codex",
        "qoder-cli",
        "cursor-cli",
        "qwen-code-cli",
        "opencode",
        "qoder",
    ] {
        write(defaults.path(), agent, &[entry(agent, "llm.request")]);
    }
    let output = invoke(defaults.path(), &["--strict"], &[]);
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "{text}");
    for agent in [
        "claude-code",
        "codex",
        "qoder-cli",
        "cursor-cli",
        "qwen-code-cli",
        "opencode",
    ] {
        assert!(
            text.contains(&format!("{agent}-2026-05-11.jsonl")),
            "{agent}: {text}"
        );
    }
    assert!(!text.contains("qoder-2026-05-11.jsonl"));
}
