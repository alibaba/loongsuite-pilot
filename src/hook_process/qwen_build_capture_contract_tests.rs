use super::*;
use serde_json::json;
fn call(uuid: &str, second: &str, parts: Value) -> LlmCall {
    let usage = json!({"promptTokenCount":100,"candidatesTokenCount":20,"cachedContentTokenCount":0,"totalTokenCount":120,"thoughtsTokenCount":0});
    let ts = format!("2026-06-17T08:00:{second}.000Z");
    LlmCall {
        assistant_uuid: Some(uuid.into()),
        timestamp: Some(ts.clone()),
        request_start: Some("2026-06-17T08:00:00.000Z".into()),
        model: "qwen3.6-plus".into(),
        usage_metadata: Some(usage.clone()),
        assistant_record: json!({"uuid":uuid,"parentUuid":"u-prev","sessionId":"sess-1","timestamp":ts,"type":"assistant","cwd":"/work","version":"0.14.4","model":"qwen3.6-plus","message":{"role":"model","parts":parts},"usageMetadata":usage}),
        api_response: None,
        declared_tools: vec![],
        input_delta: vec![],
    }
}
fn plain() -> LlmCall {
    call("a1", "10", json!([{"text":"done"}]))
}
fn turn(calls: Vec<LlmCall>) -> Turn {
    Turn {
        prompt: "do it".into(),
        prompt_timestamp: Some("2026-06-17T08:00:00.000Z".into()),
        git_branch: None,
        llm_calls: calls,
        positional_fallbacks: 0,
    }
}
fn custom(
    t: &Turn,
    index: u64,
    stop: &str,
    cwd: Option<&str>,
    resources: &Obj,
    spans: &Obj,
) -> Vec<Value> {
    build_turn_records(
        t,
        &RecordContext {
            turn_index: index,
            session_id: "sess-1",
            user_id: "u-1",
            cwd,
            resources,
            spans,
        },
        INITIAL_HASH,
        stop,
        &TurnOptions::parent(),
    )
    .records
    .into_iter()
    .map(Value::Object)
    .collect()
}
fn build(t: &Turn) -> Vec<Value> {
    custom(t, 0, "end_turn", None, &Obj::new(), &Obj::new())
}
fn named<'a>(records: &'a [Value], name: &str) -> Vec<&'a Value> {
    records.iter().filter(|r| r["event.name"] == name).collect()
}
fn one(records: &[Value], name: &str) -> Value {
    named(records, name)[0].clone()
}
fn api() -> ApiResponse {
    ApiResponse {
        event_name: None,
        response_id: None,
        status_code: None,
        input_tokens: None,
        output_tokens: None,
        cached_tokens: None,
        auth_type: None,
        error_message: None,
        error_type: None,
        duration_ms: None,
    }
}
fn tool(name: &str, id: Option<&str>, args: Value, result: Option<ToolResult>) -> DeclaredTool {
    DeclaredTool {
        call_id: id.map(str::to_owned),
        native_call_id: id.map(str::to_owned),
        name: name.into(),
        args,
        part_index: 0,
        result,
        timestamp: None,
    }
}
fn result(response: Value) -> ToolResult {
    ToolResult {
        timestamp: Some("2026-06-17T08:00:13.000Z".into()),
        response: Some(response),
        duration_ms: None,
        status: "success".into(),
        error: None,
    }
}
#[test]
fn build_l55_basic_prompt_and_text_reply_have_exact_three_event_names() {
    let rows = custom(
        &turn(vec![call("a1", "10", json!([{"text":"hi"}]))]),
        0,
        "end_turn",
        Some("/work"),
        &Obj::new(),
        &Obj::new(),
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["other", "llm.request", "llm.response"]
    );
}
#[test]
fn build_l64_every_record_shares_one_valid_trace_id() {
    let rows = build(&turn(vec![
        plain(),
        call("a2", "20", json!([{"text":"done"}])),
    ]));
    let ids = rows
        .iter()
        .map(|r| r["trace_id"].as_str().unwrap())
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), 1);
    let id = ids.iter().next().unwrap();
    assert_eq!(id.len(), 32);
    assert!(id
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
}
#[test]
fn build_l73_no_invocation_resource_does_not_add_agent_name_or_resource_container() {
    let rows = build(&turn(vec![plain()]));
    assert!(!rows.is_empty());
    for row in rows {
        assert!(row.get("gen_ai.agent.name").is_none());
        assert!(row.get("resourceAttributes").is_none());
    }
}
#[test]
fn build_l82_invocation_resource_context_is_stamped_on_every_record() {
    let resources =
        json!({"agentteams.worker.name":"planner","agentteams.instance.id":"qwen-instance-01"})
            .as_object()
            .unwrap()
            .clone();
    let rows = custom(
        &turn(vec![plain()]),
        0,
        "end_turn",
        Some("/work"),
        &resources,
        &Obj::new(),
    );
    assert!(!rows.is_empty());
    for row in rows {
        assert_eq!(row["gen_ai.agent.name"], "planner");
        assert_eq!(row["resourceAttributes"], json!(resources));
        assert_eq!(row["gen_ai.agent.id"], "sess-1");
    }
}
#[test]
fn build_l105_invocation_span_attributes_do_not_override_generated_structure() {
    let attrs=json!({"multica.issue.id":"AGE-277","multica.user.id":"staff-1","trace_id":"caller-trace-id"}).as_object().unwrap().clone();
    let rows = custom(
        &turn(vec![plain()]),
        0,
        "end_turn",
        Some("/work"),
        &Obj::new(),
        &attrs,
    );
    assert!(!rows.is_empty());
    for row in rows {
        assert_eq!(row["multica.issue.id"], "AGE-277");
        assert_eq!(row["multica.user.id"], "staff-1");
        let trace = row["trace_id"].as_str().unwrap();
        assert_ne!(trace, "caller-trace-id");
        assert_eq!(trace.len(), 32);
        assert!(trace
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }
}
#[test]
fn build_l131_turn_index_two_is_session_turn_three() {
    let rows = custom(
        &turn(vec![plain()]),
        2,
        "end_turn",
        None,
        &Obj::new(),
        &Obj::new(),
    );
    assert_eq!(rows[0]["gen_ai.turn.id"], "sess-1:t3");
}
#[test]
fn build_l137_every_event_has_original_required_identity_and_timing_fields() {
    let rows = build(&turn(vec![plain()]));
    assert!(!rows.is_empty());
    for r in rows {
        for key in ["time_unix_nano", "event.id", "event.name", "trace_id"] {
            assert!(!r[key].as_str().unwrap().is_empty(), "{key}");
        }
        assert_eq!(r["user.id"], "u-1");
        assert_eq!(r["gen_ai.session.id"], "sess-1");
        assert_eq!(r["gen_ai.turn.id"], "sess-1:t1");
    }
}
#[test]
fn build_l151_prompt_only_is_other_delta_without_fake_llm_fields() {
    let mut t = turn(vec![]);
    t.prompt = "hello world".into();
    let rows = build(&t);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["event.name"], "other");
    assert_eq!(
        rows[0]["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"hello world"}]}])
    );
    assert!(rows[0].get("gen_ai.step.id").is_none());
    assert!(rows[0].get("gen_ai.request.model").is_none());
}
#[test]
fn build_l164_no_prompt_or_llm_activity_emits_no_records() {
    let mut t = turn(vec![]);
    t.prompt.clear();
    assert!(build(&t).is_empty());
}
#[test]
fn build_l172_three_llm_calls_have_three_distinct_ordered_step_ids() {
    let rows = build(&turn(vec![
        call("a1", "05", json!([{"text":"done"}])),
        call("a2", "10", json!([{"text":"done"}])),
        call("a3", "15", json!([{"text":"done"}])),
    ]));
    let responses = named(&rows, "llm.response");
    assert_eq!(responses.len(), 3);
    let ids = responses
        .iter()
        .map(|r| r["gen_ai.step.id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 3);
    assert_eq!(ids, ["sess-1:t1:s1", "sess-1:t1:s2", "sess-1:t1:s3"]);
}
#[test]
fn build_l188_request_and_response_share_real_response_id() {
    let rows = build(&turn(vec![plain()]));
    let req = one(&rows, "llm.request");
    let resp = one(&rows, "llm.response");
    assert_eq!(req["gen_ai.response.id"], resp["gen_ai.response.id"]);
    assert!(req["gen_ai.response.id"].is_string());
}
#[test]
fn build_l196_request_start_precedes_response_completion() {
    let rows = build(&turn(vec![plain()]));
    let req = one(&rows, "llm.request");
    let resp = one(&rows, "llm.response");
    assert!(
        req["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
            < resp["time_unix_nano"]
                .as_str()
                .unwrap()
                .parse::<u128>()
                .unwrap()
    );
}
#[test]
fn build_l209_function_call_parts_set_singular_tool_call_finish() {
    let rows = build(&turn(vec![call(
        "a1",
        "10",
        json!([{"text":"I will run"},{"functionCall":{"name":"Bash","args":{},"id":"c1"}}]),
    )]));
    assert_eq!(
        one(&rows, "llm.response")["gen_ai.response.finish_reasons"],
        json!(["tool_call"])
    );
}
#[test]
fn build_l220_plain_text_finishes_stop() {
    assert_eq!(
        one(&build(&turn(vec![plain()])), "llm.response")["gen_ai.response.finish_reasons"],
        json!(["stop"])
    );
}
#[test]
fn build_l227_turn_stop_reason_overrides_only_last_llm_response() {
    let rows = custom(
        &turn(vec![
            call("a1", "05", json!([{"text":"done"}])),
            call("a2", "10", json!([{"text":"done"}])),
        ]),
        0,
        "content_filter",
        None,
        &Obj::new(),
        &Obj::new(),
    );
    let r = named(&rows, "llm.response");
    assert_eq!(r[0]["gen_ai.response.finish_reasons"], json!(["stop"]));
    assert_eq!(
        r[1]["gen_ai.response.finish_reasons"],
        json!(["content_filter"])
    );
}
#[test]
fn build_l242_reasoning_text_and_tool_call_stay_in_one_assistant_output_message() {
    let rows = build(&turn(vec![call(
        "a1",
        "10",
        json!([{"text":"thinking step","thought":true},{"text":"visible reply"},{"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"c1"}}]),
    )]));
    let r = one(&rows, "llm.response");
    let messages = r["gen_ai.output.messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "assistant");
    assert_eq!(
        messages[0]["parts"],
        json!([{"type":"reasoning","content":"thinking step"},{"type":"text","content":"visible reply"},{"type":"tool_call","id":"c1","name":"Bash","arguments":{"cmd":"ls"}}])
    );
    assert_eq!(messages[0]["finish_reason"], "tool_call");
}
fn call_with_tool(
    name: &str,
    id: Option<&str>,
    args: Value,
    response: Option<ToolResult>,
) -> LlmCall {
    let mut function = json!({"name":name,"args":args});
    if let Some(id) = id {
        function["id"] = json!(id);
    }
    let mut c = call("a1", "10", json!([{"functionCall":function}]));
    c.declared_tools.push(tool(name, id, args, response));
    c
}
#[test]
fn build_l267_tool_call_result_pair_preserves_ids_names_typed_values_and_status() {
    let rows = build(&turn(vec![call_with_tool(
        "Bash",
        Some("c1"),
        json!({"cmd":"ls"}),
        Some(result(json!({"stdout":"file1"}))),
    )]));
    let c = one(&rows, "tool.call");
    let r = one(&rows, "tool.result");
    for row in [&c, &r] {
        assert_eq!(row["gen_ai.tool.call.id"], "c1");
        assert_eq!(row["gen_ai.tool.name"], "Bash");
    }
    assert_eq!(c["gen_ai.tool.call.arguments"], json!({"cmd":"ls"}));
    assert_eq!(r["gen_ai.tool.call.result"], json!({"stdout":"file1"}));
    assert_eq!(r["tool.result.status"], "success");
}
#[test]
fn build_l292_tool_pair_has_one_real_span_id() {
    let rows = build(&turn(vec![call_with_tool(
        "X",
        Some("c1"),
        json!({}),
        Some(result(json!("r"))),
    )]));
    let c = one(&rows, "tool.call");
    let r = one(&rows, "tool.result");
    assert!(c["span_id"].is_string());
    assert_eq!(c["span_id"], r["span_id"]);
}
#[test]
fn build_l308_missing_native_tool_id_uses_exact_step_and_part_prefix() {
    let rows = build(&turn(vec![call_with_tool("X", None, json!({}), None)]));
    assert_eq!(
        one(&rows, "tool.call")["gen_ai.tool.call.id"],
        "sess-1:t1:s1:t0"
    );
}
#[test]
fn build_l321_orphan_tool_call_never_invents_a_tool_result() {
    let rows = build(&turn(vec![call_with_tool(
        "X",
        Some("pending"),
        json!({}),
        None,
    )]));
    assert_eq!(named(&rows, "tool.call").len(), 1);
    assert!(named(&rows, "tool.result").is_empty());
}
#[test]
fn build_l335_tool_error_keeps_status_type_and_original_message() {
    let mut r = result(Value::Null);
    r.status = "error".into();
    r.error = Some(json!("permission denied"));
    let rows = build(&turn(vec![call_with_tool(
        "X",
        Some("c1"),
        json!({}),
        Some(r),
    )]));
    let r = one(&rows, "tool.result");
    assert_eq!(r["tool.result.status"], "error");
    assert_eq!(r["error.type"], "ToolError");
    assert_eq!(r["error.message"], "permission denied");
}
#[test]
fn build_l354_assistant_usage_is_canonical_and_totals_are_conserved() {
    let mut c = plain();
    let usage = json!({"promptTokenCount":1000,"candidatesTokenCount":50,"cachedContentTokenCount":100,"totalTokenCount":1050,"thoughtsTokenCount":0});
    c.assistant_record["usageMetadata"] = usage.clone();
    c.usage_metadata = Some(usage);
    let r = one(&build(&turn(vec![c])), "llm.response");
    assert_eq!(r["gen_ai.usage.input_tokens"], 1000);
    assert_eq!(r["gen_ai.usage.output_tokens"], 50);
    assert_eq!(r["gen_ai.usage.cache_read.input_tokens"], 100);
    assert_eq!(r["gen_ai.usage.total_tokens"], 1050);
}
#[test]
fn build_l366_api_response_usage_fills_missing_assistant_usage() {
    let mut c = plain();
    c.usage_metadata = None;
    let mut a = api();
    a.event_name = Some("qwen-code.api_response".into());
    a.response_id = Some("r1".into());
    a.duration_ms = Some(1000.0);
    a.input_tokens = Some(json!(555));
    a.output_tokens = Some(json!(33));
    a.cached_tokens = Some(json!(10));
    a.auth_type = Some("openai".into());
    c.api_response = Some(a);
    let r = one(&build(&turn(vec![c])), "llm.response");
    assert_eq!(r["gen_ai.usage.input_tokens"], 555);
    assert_eq!(r["gen_ai.usage.output_tokens"], 33);
    assert_eq!(r["gen_ai.usage.cache_read.input_tokens"], 10);
}
#[test]
fn build_l382_api_response_id_replaces_assistant_uuid_fallback() {
    let mut c = call("asst-uuid", "10", json!([{"text":"done"}]));
    let mut a = api();
    a.event_name = Some("qwen-code.api_response".into());
    a.response_id = Some("chatcmpl-abc".into());
    a.duration_ms = Some(0.0);
    a.input_tokens = Some(json!(0));
    a.output_tokens = Some(json!(0));
    a.cached_tokens = Some(json!(0));
    c.api_response = Some(a);
    assert_eq!(
        one(&build(&turn(vec![c])), "llm.response")["gen_ai.response.id"],
        "chatcmpl-abc"
    );
}
#[test]
fn build_l396_default_qwen_model_has_qwen_provider() {
    assert_eq!(
        one(&build(&turn(vec![plain()])), "llm.response")["gen_ai.provider.name"],
        "qwen"
    );
}
#[test]
fn build_l402_claude_model_has_anthropic_provider() {
    let mut c = plain();
    c.model = "claude-3-5-sonnet".into();
    c.assistant_record["model"] = json!("claude-3-5-sonnet");
    assert_eq!(
        one(&build(&turn(vec![c])), "llm.response")["gen_ai.provider.name"],
        "anthropic"
    );
}
#[test]
fn build_l413_api_error_preserves_type_message_status_and_error_finish() {
    let mut c = plain();
    let mut a = api();
    a.event_name = Some("qwen-code.api_error".into());
    a.error_type = Some("RateLimitError".into());
    a.error_message = Some("Too many requests".into());
    a.status_code = Some(json!(429));
    a.response_id = Some("err-1".into());
    a.duration_ms = Some(100.0);
    a.auth_type = Some("openai".into());
    c.api_response = Some(a);
    let r = one(&build(&turn(vec![c])), "llm.response");
    assert_eq!(r["error.type"], "RateLimitError");
    assert_eq!(r["error.message"], "Too many requests");
    assert_eq!(r["http.status_code"], 429);
    assert_eq!(r["gen_ai.response.finish_reasons"], json!(["error"]));
}
#[test]
fn build_l434_prompt_llms_and_tool_events_are_sorted_by_exact_nanosecond_time() {
    let mut first = call_with_tool("X", Some("c1"), json!({}), Some(result(json!("r"))));
    first.request_start = Some("2026-06-17T08:00:01.000Z".into());
    let mut second = call("a2", "20", json!([{"text":"done"}]));
    second.request_start = Some("2026-06-17T08:00:13.000Z".into());
    let rows = build(&turn(vec![first, second]));
    let times = rows
        .iter()
        .map(|r| {
            r["time_unix_nano"]
                .as_str()
                .unwrap()
                .parse::<u128>()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert!(times.windows(2).all(|w| w[0] <= w[1]));
}
#[test]
fn build_l462_explicit_cwd_is_stamped_on_every_event() {
    let rows = custom(
        &turn(vec![plain()]),
        0,
        "end_turn",
        Some("/my/dir"),
        &Obj::new(),
        &Obj::new(),
    );
    assert!(!rows.is_empty());
    for r in rows {
        assert_eq!(r["agent.qwen-code-cli.cwd"], "/my/dir");
    }
}
#[test]
fn build_l470_missing_cwd_keeps_cwd_attribute_absent() {
    let rows = build(&turn(vec![plain()]));
    assert!(!rows.is_empty());
    for r in rows {
        assert!(r.get("agent.qwen-code-cli.cwd").is_none());
    }
}
#[test]
fn build_l478_turn_git_branch_is_stamped_on_every_event() {
    let mut t = turn(vec![plain()]);
    t.git_branch = Some("main".into());
    let rows = build(&t);
    assert!(!rows.is_empty());
    for r in rows {
        assert_eq!(r["git.branch"], "main");
    }
}
fn capture_fixture(capture: Option<bool>, session: &str) -> Vec<Value> {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    if let Some(capture) = capture {
        std::fs::write(
            root.join("config.json"),
            json!({"agents":{"qwen-code-cli":{"enabled":true,"captureMessageContent":capture}}})
                .to_string(),
        )
        .unwrap();
    }
    let file = root.join(format!("{session}.jsonl"));
    let rows = [
        json!({"uuid":"u1","parentUuid":null,"sessionId":session,"timestamp":"2026-06-18T08:00:00.000Z","type":"user","cwd":"/work","version":"0.14.4","message":{"role":"user","parts":[{"text":"SECRET_PROMPT_CONTENT"}]}}),
        json!({"uuid":"a1","parentUuid":"u1","sessionId":session,"timestamp":"2026-06-18T08:00:10.000Z","type":"assistant","cwd":"/work","version":"0.14.4","model":"qwen3.6-plus","message":{"role":"model","parts":[{"text":"SECRET_ASSISTANT_REASONING","thought":true},{"text":"SECRET_ASSISTANT_TEXT"},{"functionCall":{"name":"Bash","args":{"cmd":"SECRET_TOOL_ARG"},"id":"c1"}}]},"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"cachedContentTokenCount":0,"totalTokenCount":120,"thoughtsTokenCount":5},"contextWindowSize":131072}),
        json!({"uuid":"tr1","parentUuid":"a1","sessionId":session,"timestamp":"2026-06-18T08:00:13.000Z","type":"tool_result","cwd":"/work","version":"0.14.4","message":{"role":"user","parts":[{"functionResponse":{"name":"Bash","response":{"stdout":"SECRET_TOOL_OUTPUT"}}}]},"toolCallResult":{"callId":"c1","status":"success"}}),
        json!({"uuid":"a2","parentUuid":"tr1","sessionId":session,"timestamp":"2026-06-18T08:00:15.000Z","type":"assistant","cwd":"/work","version":"0.14.4","model":"qwen3.6-plus","message":{"role":"model","parts":[{"text":"SECRET_FINAL_REPLY"}]},"usageMetadata":{"promptTokenCount":200,"candidatesTokenCount":10,"cachedContentTokenCount":0,"totalTokenCount":210,"thoughtsTokenCount":0}}),
    ];
    std::fs::write(
        &file,
        rows.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    let mut env = Env::new();
    for key in ["LOONGSUITE_PILOT_DATA_DIR", "HOME", "USERPROFILE"] {
        env.insert(key.into(), root.to_string_lossy().into_owned());
    }
    let args = vec!["stop".to_owned()];
    let stdin=serde_json::to_vec(&json!({"session_id":session,"transcript_path":file,"cwd":"/work","stop_reason":"end_turn"})).unwrap();
    let mut stdout = Vec::new();
    let mut req = super::super::common::HookRequest {
        args: &args,
        stdin: &stdin,
        env: &env,
        stdout: &mut stdout,
    };
    assert_eq!(run(&mut req), 0);
    assert_eq!(stdout, b"{}\n");
    let output = root.join("logs/qwen-code-cli");
    let mut files = std::fs::read_dir(output)
        .unwrap()
        .map(|f| f.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect::<Vec<_>>();
    files.sort();
    let records = files
        .into_iter()
        .flat_map(|p| {
            std::fs::read_to_string(p)
                .unwrap()
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| serde_json::from_str(l).unwrap())
                .collect::<Vec<Value>>()
        })
        .collect::<Vec<_>>();
    assert!(!records.is_empty());
    records
}
#[test]
fn capture_l136_legacy_false_retains_all_six_content_fields_and_observability() {
    let records = capture_fixture(Some(false), "sess-policy-off");
    let text = serde_json::to_string(&records).unwrap();
    for field in [
        "SECRET_PROMPT_CONTENT",
        "SECRET_ASSISTANT_TEXT",
        "SECRET_ASSISTANT_REASONING",
        "SECRET_TOOL_ARG",
        "SECRET_TOOL_OUTPUT",
        "SECRET_FINAL_REPLY",
    ] {
        assert!(text.contains(field), "{field}");
    }
    let r = one(&records, "llm.response");
    assert_eq!(r["gen_ai.usage.input_tokens"], 100);
    assert_eq!(r["gen_ai.usage.output_tokens"], 20);
    assert_eq!(r["gen_ai.response.finish_reasons"], json!(["tool_call"]));
    assert_eq!(r["gen_ai.request.model"], "qwen3.6-plus");
    assert_eq!(r["gen_ai.provider.name"], "qwen");
    let trace = r["trace_id"].as_str().unwrap();
    assert_eq!(trace.len(), 32);
    assert!(trace
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(r["gen_ai.session.id"], "sess-policy-off");
    let c = one(&records, "tool.call");
    assert_eq!(c["gen_ai.tool.name"], "Bash");
    assert_eq!(c["gen_ai.tool.call.id"], "c1");
    let r = one(&records, "tool.result");
    assert_eq!(r["tool.result.status"], "success");
    assert_eq!(r["gen_ai.tool.call.id"], "c1");
}
#[test]
fn capture_l174_legacy_true_keeps_output_messages_and_tool_values() {
    let records = capture_fixture(Some(true), "sess-policy-on");
    assert!(one(&records, "llm.response")
        .get("gen_ai.output.messages")
        .is_some());
    let text = serde_json::to_string(&records).unwrap();
    for field in [
        "SECRET_ASSISTANT_TEXT",
        "SECRET_TOOL_ARG",
        "SECRET_TOOL_OUTPUT",
    ] {
        assert!(text.contains(field), "{field}");
    }
}
#[test]
fn capture_l191_no_legacy_config_still_captures_user_prompt() {
    let records = capture_fixture(None, "sess-no-config");
    assert!(serde_json::to_string(&records)
        .unwrap()
        .contains("SECRET_PROMPT_CONTENT"));
}
