//! 正式原生 Trace CLI 回归；隔离 HOME/PATH，禁止依赖 Node/Python 校验。
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const TRACE_ID: &str = "1234567890abcdef1234567890abcdef";
const BASE: u128 = 1_800_000_000_000_000_001;

fn invoke(root: &Path, args: &[&str]) -> Output {
    let capture = tempfile::tempdir().unwrap();
    let stdout = capture.path().join("stdout");
    let stderr = capture.path().join("stderr");
    let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
    command
        .arg("validate-trace")
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
        if start.elapsed() >= Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Trace 校验器超时");
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
fn rules() -> Value {
    let mut kinds = json!({});
    for (kind, pattern, operation) in [
        ("ENTRY", "enter_ai_application_system", "enter"),
        ("AGENT", "invoke_agent {name}", "invoke_agent"),
        ("STEP", "react step", "react"),
        ("LLM", "chat {model}", "chat"),
        ("TOOL", "execute_tool {name}", "execute_tool"),
    ] {
        kinds[kind] = json!({"namePattern":pattern,"attributes":{
            "must":[{"key":"gen_ai.operation.name","expectedValue":operation}],
            "should":[{"key":"gen_ai.input.messages","requiresMessageContent":true}]}});
    }
    json!({"version":"1.0","commonAttributes":{"must":[{"key":"gen_ai.span.kind"},{"key":"gen_ai.session.id"}],"should":[]},
        "spanKinds":kinds,"resourceAttributes":{"must":[{"key":"service.name"}],"should":[]},
        "operationKindMapping":{"enter":"ENTRY","invoke_agent":"AGENT","react":"STEP","chat":"LLM","execute_tool":"TOOL"},
        "timeRules":[{"id":"time.reasonable_duration","maxMs":600000}]})
}
fn input() -> Value {
    json!([{"role":"user","parts":[{"type":"text","content":"SYNTHETIC_PRIVATE_PROMPT"}]}])
}
fn output() -> Value {
    json!([{"role":"assistant","finish_reason":"stop","parts":[{"type":"text","content":"SYNTHETIC_PRIVATE_ANSWER"}]}])
}
fn graph() -> Vec<Value> {
    let mut spans = Vec::new();
    for (i, (kind, parent, start, end, operation, name)) in [
        (
            "ENTRY",
            None,
            0,
            100,
            "enter",
            "enter_ai_application_system",
        ),
        (
            "AGENT",
            Some(1),
            1,
            99,
            "invoke_agent",
            "invoke_agent synthetic",
        ),
        ("STEP", Some(2), 2, 40, "react", "react step 1"),
        ("LLM", Some(3), 3, 20, "chat", "chat synthetic"),
        ("TOOL", Some(3), 21, 30, "execute_tool", "execute_tool Read"),
        ("STEP", Some(2), 41, 98, "react", "react step 2"),
        ("LLM", Some(6), 42, 97, "chat", "chat synthetic"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut span = json!({"traceId":TRACE_ID,"spanId":format!("{:016x}",i+1),"name":name,
            "startTimeUnixNano":(BASE + start).to_string(),"endTimeUnixNano":(BASE + end).to_string(),
            "attributes":{"gen_ai.span.kind":kind,"gen_ai.operation.name":operation,
                "gen_ai.session.id":"synthetic-session","gen_ai.user.id":"synthetic-user","gen_ai.agent.name":"synthetic",
                "gen_ai.input.messages":input()},"resource":{"service.name":"synthetic"}});
        if let Some(parent) = parent {
            span["parentSpanId"] = json!(format!("{parent:016x}"));
        }
        spans.push(span);
    }
    for i in [0, 6] {
        spans[i]["attributes"]["gen_ai.output.messages"] = output();
    }
    spans[3]["attributes"]["gen_ai.output.messages"] = json!([{"role":"assistant","finish_reason":"tool_call","parts":[{"type":"tool_call","id":"call-1","name":"Read"}]}]);
    spans[4]["attributes"]["gen_ai.tool.name"] = json!("Read");
    spans[4]["attributes"]["gen_ai.tool.call.id"] = json!("call-1");
    spans[4]["attributes"]["gen_ai.tool.call.arguments"] = json!({"path":"SYNTHETIC_PRIVATE_PATH"});
    spans[6]["attributes"]["gen_ai.input.messages"] = json!([{"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":{"text":"SYNTHETIC_PRIVATE_RESULT"}}]}]);
    for (i, round) in [(2, 1), (5, 2)] {
        spans[i]["attributes"]["gen_ai.react.round"] = json!(round);
    }
    for (i, multiplier) in [(1, 2), (3, 1), (6, 1)] {
        for (key, value) in [
            ("input_tokens", 3),
            ("output_tokens", 2),
            ("total_tokens", 5),
        ] {
            spans[i]["attributes"][format!("gen_ai.usage.{key}")] = json!(value * multiplier);
        }
    }
    spans
}
fn write(root: &Path, spans: &[Value]) {
    fs::write(
        root.join("input.jsonl"),
        spans
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    fs::write(
        root.join("rules.json"),
        serde_json::to_vec(&rules()).unwrap(),
    )
    .unwrap();
}
fn validate(root: &Path, code: i32) -> Value {
    let result = invoke(
        root,
        &["-i", "input.jsonl", "-r", "rules.json", "-f", "json"],
    );
    assert_eq!(
        result.status.code(),
        Some(code),
        "{}\n{}",
        String::from_utf8_lossy(&result.stderr),
        String::from_utf8_lossy(&result.stdout)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
fn has(report: &Value, id: &str, status: &str) -> bool {
    report["traces"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["checks"].as_array().unwrap())
        .any(|check| check["id"] == id && check["status"] == status)
}

#[test]
fn native_trace_preserves_report_schema_nanoseconds_formats_and_input_bytes() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &graph());
    let before = fs::read(root.path().join("input.jsonl")).unwrap();
    let report = validate(root.path(), 0);
    assert_eq!(report["meta"]["tool"], "validate-trace");
    assert_eq!(report["meta"]["captureMessageContent"], true);
    assert_eq!(report["summary"]["verdict"], "PASS");
    assert_eq!(report["summary"]["spans"], 7);
    assert_eq!(report["summary"]["checks"]["error"], 0);
    assert_eq!(report["summary"]["checks"]["warn"], 0);
    assert_eq!(
        report["traces"][0]["structure"],
        json!({"entry":1,"agent":1,"steps":2,"llms":2,"tools":1,"other":0})
    );
    for id in [
        "time.non_zero_duration",
        "time.parent_contains_children",
        "semantic.agent_token_sum",
        "semantic.tool_matches_llm_output",
        "semantic.entry_output_matches",
    ] {
        assert!(has(&report, id, "pass"), "{id}");
    }
    let rendered = serde_json::to_string(&report).unwrap();
    for secret in [
        "SYNTHETIC_PRIVATE_PROMPT",
        "SYNTHETIC_PRIVATE_ANSWER",
        "SYNTHETIC_PRIVATE_PATH",
        "SYNTHETIC_PRIVATE_RESULT",
    ] {
        assert!(!rendered.contains(secret));
    }
    for (format, expected) in [
        ("text", "GenAI Trace 校验报告"),
        ("summary", "1 traces, 7 spans, 0 errors"),
    ] {
        let result = invoke(
            root.path(),
            &["-i", "input.jsonl", "-r", "rules.json", "-f", format],
        );
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).contains(expected));
    }
    assert_eq!(before, fs::read(root.path().join("input.jsonl")).unwrap());
}

#[test]
fn native_trace_validates_real_converter_and_production_json_serializer() {
    use loongsuite_pilot::flushers::{
        create_readable_span_to_otlp_span_json_array, ConvertOptions, EventLogConverter,
        GenAiEventLogConverter,
    };
    use loongsuite_pilot::types::AgentActivityEntry;
    let root = tempfile::tempdir().unwrap();
    let spans = graph();
    let mut records = Vec::new();
    for (index, event, time, step) in [
        (3, "llm.request", 3, "s1"),
        (3, "llm.response", 20, "s1"),
        (4, "tool.call", 21, "s1"),
        (4, "tool.result", 30, "s1"),
        (6, "llm.request", 42, "s2"),
        (6, "llm.response", 97, "s2"),
    ] {
        let mut record = spans[index]["attributes"].clone();
        let attrs = record.as_object_mut().unwrap();
        attrs.remove("gen_ai.span.kind");
        attrs.remove("gen_ai.operation.name");
        attrs.insert("event.name".into(), json!(event));
        attrs.insert("event.id".into(), json!(format!("event-{time}")));
        attrs.insert("time_unix_nano".into(), json!((BASE + time).to_string()));
        attrs.insert("trace_id".into(), json!(TRACE_ID));
        attrs.insert("gen_ai.agent.type".into(), json!("workbuddy"));
        attrs.insert("gen_ai.turn.id".into(), json!("turn-1"));
        attrs.insert("gen_ai.step.id".into(), json!(step));
        if event == "llm.request" {
            attrs.remove("gen_ai.output.messages");
        }
        if event == "llm.response" {
            attrs.insert(
                "gen_ai.response.finish_reasons".into(),
                json!([if step == "s1" { "tool_call" } else { "stop" }]),
            );
        }
        records.push(serde_json::from_value::<AgentActivityEntry>(record).unwrap());
    }
    let mut result = GenAiEventLogConverter
        .convert(&records, &ConvertOptions::default())
        .unwrap();
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(result.spans.len(), 7);
    // resource 由 flusher 注入；这里提供隔离测试资源，Span 内容全部来自正式转换器。
    for span in &mut result.spans {
        span.resource_attributes = Some(
            json!({"service.name":"synthetic"})
                .as_object()
                .unwrap()
                .clone(),
        );
    }
    fs::write(
        root.path().join("input.jsonl"),
        create_readable_span_to_otlp_span_json_array(&result.spans).join("\n"),
    )
    .unwrap();
    let mut policy = rules();
    for kind in ["STEP", "TOOL"] {
        policy["spanKinds"][kind]["attributes"]["should"] = json!([]);
    }
    fs::write(
        root.path().join("rules.json"),
        serde_json::to_vec(&policy).unwrap(),
    )
    .unwrap();
    let report = validate(root.path(), 0);
    assert_eq!(report["summary"]["checks"]["warn"], 0, "{report}");
    assert!(has(&report, "semantic.tool_matches_llm_output", "pass"));
}

#[test]
fn native_trace_rejects_structure_schema_time_and_attribute_faults() {
    let root = tempfile::tempdir().unwrap();
    let cases = [
        (
            0,
            "attributes",
            "gen_ai.span.kind",
            json!("AGENT"),
            "structure.single_entry",
        ),
        (
            4,
            "",
            "parentSpanId",
            json!("ffffffffffffffff"),
            "structure.no_orphan_spans",
        ),
        (
            2,
            "",
            "parentSpanId",
            json!("0000000000000006"),
            "structure.step_under_agent",
        ),
        (
            3,
            "",
            "endTimeUnixNano",
            json!((BASE + 3).to_string()),
            "time.non_zero_duration",
        ),
        (
            4,
            "",
            "startTimeUnixNano",
            json!((BASE + 2).to_string()),
            "structure.llm_before_tools",
        ),
        (
            4,
            "",
            "endTimeUnixNano",
            json!((BASE + 41).to_string()),
            "time.parent_contains_children",
        ),
        (
            5,
            "",
            "startTimeUnixNano",
            json!((BASE + 39).to_string()),
            "time.no_step_overlap",
        ),
        (
            3,
            "",
            "startTimeUnixNano",
            json!("-1"),
            "schema.timestamp_format",
        ),
        (
            3,
            "",
            "endTimeUnixNano",
            json!("340282366920938463463374607431768211456"),
            "schema.timestamp_format",
        ),
        (
            3,
            "",
            "spanId",
            json!("0000000000000000"),
            "schema.span_id_format",
        ),
        (
            4,
            "",
            "spanId",
            json!("0000000000000004"),
            "schema.duplicate_span_id",
        ),
        (
            4,
            "attributes",
            "gen_ai.span.kind",
            json!("WRONG"),
            "schema.span_kind_enum",
        ),
        (
            3,
            "attributes",
            "gen_ai.usage.input_tokens",
            json!(-1),
            "schema.tokens_positive",
        ),
        (
            3,
            "attributes",
            "gen_ai.usage.total_tokens",
            json!(9),
            "schema.tokens_sum",
        ),
        (
            3,
            "attributes",
            "gen_ai.session.id",
            Value::Null,
            "attr.common.must.gen_ai.session.id",
        ),
        (
            3,
            "attributes",
            "gen_ai.operation.name",
            json!("react"),
            "attr.LLM.must.name",
        ),
        (
            3,
            "resource",
            "service.name",
            Value::Null,
            "attr.resource.must.name",
        ),
    ];
    for (index, object, key, value, expected) in cases {
        let mut spans = graph();
        if object.is_empty() {
            spans[index][key] = value;
        } else {
            spans[index][object][key] = value;
        }
        write(root.path(), &spans);
        let report = validate(root.path(), 1);
        assert!(has(&report, expected, "error"), "{expected}: {report}");
    }
    let mut spans = graph();
    for span in &mut spans {
        span["traceId"] = json!("bad");
    }
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "schema.trace_id_format",
        "error"
    ));
}

#[test]
fn native_trace_checks_semantics_and_missing_all_tools_without_payload_leaks() {
    let root = tempfile::tempdir().unwrap();
    for (index, key, value, expected) in [
        (
            3,
            "gen_ai.session.id",
            json!("SYNTHETIC_PRIVATE_SESSION"),
            "semantic.consistent_session_id",
        ),
        (
            3,
            "gen_ai.user.id",
            json!("SYNTHETIC_PRIVATE_USER"),
            "semantic.consistent_user_id",
        ),
        (
            3,
            "gen_ai.operation.name",
            json!("react"),
            "semantic.operation_kind_mapping",
        ),
        (
            1,
            "gen_ai.usage.input_tokens",
            json!(7),
            "semantic.agent_token_sum",
        ),
        (
            4,
            "gen_ai.tool.call.arguments",
            Value::Null,
            "semantic.tool_has_arguments",
        ),
        (
            3,
            "gen_ai.output.messages",
            output(),
            "semantic.tool_matches_llm_output",
        ),
        (
            6,
            "gen_ai.input.messages",
            json!([{"role":"user","parts":[{"type":"tool_call_response","response":null}]}]),
            "semantic.tool_response_role",
        ),
        (
            6,
            "gen_ai.output.messages",
            json!([{"role":"assistant","finish_reason":"tool_call","parts":[{"type":"tool_call","id":"missing","name":"Read"}]}]),
            "semantic.last_step_no_tool_call",
        ),
    ] {
        let mut spans = graph();
        spans[index]["attributes"][key] = value;
        write(root.path(), &spans);
        let report = validate(root.path(), 1);
        assert!(has(&report, expected, "error"), "{expected}: {report}");
        assert!(!report.to_string().contains("SYNTHETIC_PRIVATE_"));
    }
    let mut spans = graph();
    spans[3]["attributes"]
        .as_object_mut()
        .unwrap()
        .remove("gen_ai.input.messages");
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "semantic.llm_has_input_output",
        "error"
    ));
    let mut spans = graph();
    spans.remove(4);
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "semantic.tool_matches_llm_output",
        "error"
    ));
    spans[3]["attributes"]["gen_ai.output.messages"][0]["parts"][0]["name"] = json!("Agent");
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 0),
        "semantic.tool_matches_llm_output",
        "warn"
    ));
}

#[test]
fn native_trace_runtime_skills_and_observed_content_keep_compatibility() {
    let root = tempfile::tempdir().unwrap();
    let mut spans = graph();
    spans[4]["attributes"]["gen_ai.tool.type"] = json!("extension");
    spans[4]["attributes"]["gen_ai.skill.name"] = json!("synthetic");
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "semantic.tool_matches_llm_output",
        "error"
    ));
    spans[3]["attributes"]["gen_ai.output.messages"] = output();
    write(root.path(), &spans);
    validate(root.path(), 0);
    spans[4]["attributes"]
        .as_object_mut()
        .unwrap()
        .remove("gen_ai.skill.name");
    write(root.path(), &spans);
    validate(root.path(), 1);
    let mut spans = graph();
    for span in &mut spans {
        let attrs = span["attributes"].as_object_mut().unwrap();
        attrs.remove("gen_ai.input.messages");
        attrs.remove("gen_ai.output.messages");
    }
    write(root.path(), &spans);
    let report = validate(root.path(), 0);
    assert_eq!(report["meta"]["captureMessageContent"], false);
    for id in [
        "schema.input_messages",
        "schema.output_messages",
        "semantic.tool_matches_llm_output",
        "semantic.entry_input_exists",
        "semantic.entry_output_matches",
        "semantic.llm_has_input_output",
        "semantic.tool_response_role",
        "semantic.last_step_no_tool_call",
        "attr.LLM.should.messages",
    ] {
        assert!(has(&report, id, "skipped"), "{id}");
    }
    spans[4]["attributes"]
        .as_object_mut()
        .unwrap()
        .remove("gen_ai.tool.call.arguments");
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "semantic.tool_has_arguments",
        "error"
    ));
}

#[test]
fn native_trace_message_schemas_finish_reasons_and_warning_filter_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    for (key, value, rule) in [
        (
            "gen_ai.input.messages",
            json!("not json"),
            "schema.input_messages",
        ),
        (
            "gen_ai.input.messages",
            json!([{"role":"tool","parts":[{"type":"tool_call_response","result":null}]}]),
            "schema.input_messages",
        ),
        (
            "gen_ai.input.messages",
            json!([null]),
            "schema.input_messages",
        ),
        (
            "gen_ai.output.messages",
            json!([{"role":"assistant","finish_reason":"wrong","parts":[]}]),
            "schema.output_messages",
        ),
        (
            "gen_ai.output.messages",
            json!([{"role":"assistant","finish_reason":"stop","parts":[null]}]),
            "schema.output_messages",
        ),
    ] {
        let mut spans = graph();
        spans[6]["attributes"][key] = value;
        write(root.path(), &spans);
        assert!(has(&validate(root.path(), 1), rule, "error"));
    }
    let mut spans = graph();
    spans[6]["attributes"]["gen_ai.output.messages"][0]["finish_reason"] = json!("cancelled");
    spans[0]["attributes"]["gen_ai.output.messages"] =
        spans[6]["attributes"]["gen_ai.output.messages"].clone();
    spans[6]["attributes"]["gen_ai.input.messages"] =
        json!([{"role":"user","parts":[{"type":"image"}]}]);
    spans[6]["attributes"]["gen_ai.response.finish_reasons"] = json!(123);
    write(root.path(), &spans);
    let report = validate(root.path(), 0);
    assert!(has(&report, "schema.input_messages", "warn"));
    assert!(has(&report, "schema.finish_reasons", "warn"));
    let result = invoke(
        root.path(),
        &[
            "-i",
            "input.jsonl",
            "-r",
            "rules.json",
            "-f",
            "json",
            "--severity",
            "error",
        ],
    );
    assert!(result.status.success());
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["summary"]["checks"]["warn"], 0);
    assert!(has(&report, "semantic.agent_token_sum", "pass"));
}

#[test]
fn native_trace_invalid_falsy_message_fields_cannot_skip_schema_validation() {
    let root = tempfile::tempdir().unwrap();
    for invalid in [json!(false), json!(0), json!("")] {
        let mut spans = graph();
        for span in &mut spans {
            span["attributes"]
                .as_object_mut()
                .unwrap()
                .remove("gen_ai.input.messages");
            span["attributes"]
                .as_object_mut()
                .unwrap()
                .remove("gen_ai.output.messages");
        }
        spans[6]["attributes"]["gen_ai.input.messages"] = invalid;
        write(root.path(), &spans);
        let report = validate(root.path(), 1);
        assert_eq!(report["meta"]["captureMessageContent"], true);
        assert!(has(&report, "schema.input_messages", "error"));
        assert!(!has(&report, "schema.input_messages", "skipped"));
    }
}

#[test]
fn native_trace_latest_filter_unicode_and_atomic_output_preserve_sources() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &graph());
    let debug = root.path().join(".loongsuite-pilot/logs/otlp-debug");
    fs::create_dir_all(&debug).unwrap();
    fs::write(debug.join("old.jsonl"), "invalid").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(debug.join("old.jsonl"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
        .unwrap();
    fs::copy(
        root.path().join("input.jsonl"),
        debug.join("最新 中文😀.jsonl"),
    )
    .unwrap();
    let result = invoke(
        root.path(),
        &[
            "--latest",
            "-r",
            "rules.json",
            "-f",
            "json",
            "--trace-id",
            TRACE_ID,
            "-o",
            "报告 中文😀.json",
        ],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(result.stdout.is_empty());
    let report: Value =
        serde_json::from_slice(&fs::read(root.path().join("报告 中文😀.json")).unwrap()).unwrap();
    assert_eq!(report["meta"]["input"], "最新 中文😀.jsonl");
    let input = fs::read(root.path().join("input.jsonl")).unwrap();
    let rules = fs::read(root.path().join("rules.json")).unwrap();
    for path in ["input.jsonl", "rules.json", "."] {
        assert_eq!(
            invoke(
                root.path(),
                &["-i", "input.jsonl", "-r", "rules.json", "-o", path]
            )
            .status
            .code(),
            Some(2)
        );
    }
    assert_eq!(input, fs::read(root.path().join("input.jsonl")).unwrap());
    assert_eq!(rules, fs::read(root.path().join("rules.json")).unwrap());
    fs::write(root.path().join("prior-report"), "prior").unwrap();
    assert_eq!(
        invoke(
            root.path(),
            &[
                "-i",
                "input.jsonl",
                "-r",
                "rules.json",
                "--trace-id",
                "missing",
                "-o",
                "prior-report"
            ]
        )
        .status
        .code(),
        Some(2)
    );
    assert_eq!(
        fs::read_to_string(root.path().join("prior-report")).unwrap(),
        "prior"
    );
}

#[test]
fn native_trace_bad_inputs_rules_and_limits_never_become_success() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &graph());
    for text in [
        "",
        "\n \n",
        "{bad-json SYNTHETIC_PRIVATE_PAYLOAD",
        "null",
        "[]",
        "7",
        "{\"_error\":true}",
        "{\"attributes\":[]}",
        "{\"resource\":7}",
    ] {
        fs::write(root.path().join("input.jsonl"), text).unwrap();
        let result = invoke(root.path(), &["-i", "input.jsonl", "-r", "rules.json"]);
        assert_eq!(result.status.code(), Some(2), "{text}");
        assert!(result.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("SYNTHETIC_PRIVATE_PAYLOAD"));
    }
    write(root.path(), &graph());
    let mut content = fs::read(root.path().join("input.jsonl")).unwrap();
    content.extend_from_slice(b"\ninvalid\n");
    fs::write(root.path().join("input.jsonl"), content).unwrap();
    assert_eq!(
        invoke(root.path(), &["-i", "input.jsonl", "-r", "rules.json"])
            .status
            .code(),
        Some(2)
    );
    fs::write(
        root.path().join("input.jsonl"),
        vec![b' '; 16 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert_eq!(
        invoke(root.path(), &["-i", "input.jsonl", "-r", "rules.json"])
            .status
            .code(),
        Some(2)
    );
    write(root.path(), &graph());
    for text in ["not json", "{}", "{\"version\":\"\"}"] {
        fs::write(root.path().join("rules.json"), text).unwrap();
        assert_eq!(
            invoke(root.path(), &["-i", "input.jsonl", "-r", "rules.json"])
                .status
                .code(),
            Some(2)
        );
    }
    for args in [
        vec![],
        vec!["--latest", "-i", "input.jsonl"],
        vec!["-i", "input.jsonl", "--format", "bad"],
        vec!["-i", "input.jsonl", "--severity", "bad"],
        vec!["-i", "input.jsonl", "-r", "missing"],
        vec!["--latest", "-r", "rules.json"],
    ] {
        assert_eq!(invoke(root.path(), &args).status.code(), Some(2));
    }
}

#[test]
#[cfg(unix)]
fn native_trace_rejects_input_rules_and_output_symlinks() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &graph());
    symlink("input.jsonl", root.path().join("input-link")).unwrap();
    symlink("rules.json", root.path().join("rules-link")).unwrap();
    symlink("missing", root.path().join("output-link")).unwrap();
    for args in [
        vec!["-i", "input-link", "-r", "rules.json"],
        vec!["-i", "input.jsonl", "-r", "rules-link"],
        vec!["-i", "input.jsonl", "-r", "rules.json", "-o", "output-link"],
    ] {
        assert_eq!(invoke(root.path(), &args).status.code(), Some(2));
    }
    assert!(fs::symlink_metadata(root.path().join("output-link"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!root.path().join("missing").exists());
}

fn delegated_graph(external: bool) -> Vec<Value> {
    let mut spans = graph();
    let mut child = vec![spans[1].clone(), spans[5].clone(), spans[6].clone()];
    for (offset, span) in child.iter_mut().enumerate() {
        span["spanId"] = json!(format!("{:016x}", offset + 101));
        span["parentSpanId"] = json!(match offset {
            0 if external => "ffffffffffffffff".to_owned(),
            0 => "0000000000000005".to_owned(),
            1 => "0000000000000065".to_owned(),
            _ => "0000000000000066".to_owned(),
        });
        span["startTimeUnixNano"] = (BASE + 22 + offset as u128).to_string().into();
        span["endTimeUnixNano"] = (BASE + 95 - offset as u128).to_string().into();
        span["attributes"]["gen_ai.session.id"] = json!("child-session");
        span["attributes"]["gen_ai.turn.id"] = json!("child-turn");
        span["attributes"]["gen_ai.agent.name"] = json!("child-agent");
    }
    child[0]["attributes"]["gen_ai.agent.parent.invocation.id"] = json!("invocation-1");
    child[1]["attributes"]["gen_ai.react.round"] = json!(1);
    for key in ["input_tokens", "output_tokens", "total_tokens"] {
        child[0]["attributes"][format!("gen_ai.usage.{key}")] =
            child[2]["attributes"][format!("gen_ai.usage.{key}")].clone();
    }
    if external {
        child
    } else {
        spans.append(&mut child);
        spans
    }
}

#[test]
fn native_trace_delegated_executions_keep_own_identity_usage_and_parallel_steps() {
    let root = tempfile::tempdir().unwrap();
    let mut spans = delegated_graph(false);
    write(root.path(), &spans);
    let report = validate(root.path(), 0);
    assert_eq!(report["summary"]["checks"]["warn"], 0);
    for id in [
        "structure.single_agent",
        "time.parent_contains_children",
        "time.no_step_overlap",
        "semantic.consistent_session_id",
        "semantic.consistent_turn_id",
        "semantic.agent_token_sum",
        "semantic.entry_output_matches",
        "semantic.last_step_no_tool_call",
    ] {
        assert!(has(&report, id, "pass"), "{id}");
        assert!(!has(&report, id, "error"), "{id}");
    }
    // Root's final answer remains valid even when a child's later output differs.
    let child_llm = spans.last_mut().unwrap();
    child_llm["attributes"]["gen_ai.output.messages"][0]["parts"][0]["content"] =
        json!("child answer");
    write(root.path(), &spans);
    assert!(!has(
        &validate(root.path(), 0),
        "semantic.entry_output_matches",
        "warn"
    ));
    spans.last_mut().unwrap()["attributes"]["gen_ai.session.id"] = json!("wrong-child-session");
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "semantic.consistent_session_id",
        "error"
    ));
}

#[test]
fn native_trace_external_fragment_requires_explicit_valid_delegation_and_reachability() {
    let root = tempfile::tempdir().unwrap();
    let mut spans = delegated_graph(true);
    write(root.path(), &spans);
    let report = validate(root.path(), 0);
    assert!(has(&report, "structure.external_parent_context", "warn"));
    assert!(has(&report, "structure.no_orphan_spans", "pass"));
    spans[0]["attributes"]
        .as_object_mut()
        .unwrap()
        .remove("gen_ai.agent.parent.invocation.id");
    write(root.path(), &spans);
    let report = validate(root.path(), 1);
    assert!(has(&report, "structure.single_entry", "error"));
    spans[0]["attributes"]["gen_ai.subagent.parent_tool_call.id"] = json!("call");
    for parent in ["0000000000000000", "FFFFFFFFFFFFFFFF", "bad"] {
        spans[0]["parentSpanId"] = json!(parent);
        write(root.path(), &spans);
        assert!(has(
            &validate(root.path(), 1),
            "structure.agent_under_entry",
            "error"
        ));
    }
    spans[0]["parentSpanId"] = json!("ffffffffffffffff");
    let mut orphan = spans[2].clone();
    orphan["spanId"] = json!("eeeeeeeeeeeeeeee");
    orphan["parentSpanId"] = json!("dddddddddddddddd");
    spans.push(orphan);
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "structure.no_orphan_spans",
        "error"
    ));
}

#[test]
fn native_trace_delegation_keeps_causal_start_and_each_executions_final_tool_rule() {
    let root = tempfile::tempdir().unwrap();
    let mut spans = delegated_graph(false);
    spans[7]["startTimeUnixNano"] = (BASE + 20).to_string().into();
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "time.parent_contains_children",
        "error"
    ));
    spans[7]["startTimeUnixNano"] = (BASE + 22).to_string().into();
    spans[6]["attributes"]["gen_ai.output.messages"] = json!([{"role":"assistant",
        "finish_reason":"tool_calls","parts":[{"type":"tool_call","id":"unfinished","name":"Read","arguments":{}}]}]);
    write(root.path(), &spans);
    assert!(has(
        &validate(root.path(), 1),
        "semantic.last_step_no_tool_call",
        "error"
    ));
}
