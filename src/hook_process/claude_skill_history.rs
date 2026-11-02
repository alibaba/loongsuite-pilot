use super::*;
const NAME: &str = "e2e-build-push";
const BASE: &str = "/abs/workdir/.claude/skills/e2e-build-push";
const ROOT_SKILL: &str = "/abs/workdir/.claude/skills/e2e-build-push/SKILL.md";
fn body() -> String {
    format!("Base directory for this skill: {BASE}\n\n# Title\n\nskill body secret")
}
fn prompt(id: &str, text: &str, at: &str) -> Value {
    json!({"type":"user","promptId":id,"timestamp":at,"message":{"role":"user","content":[{"type":"text","text":text}]}})
}
fn slash(id: &str, skill: &str, args: &str, at: &str) -> Value {
    prompt(id,&format!("<command-message>{skill}</command-message>\n<command-name>/{skill}</command-name>\n<command-args>{args}</command-args>"),at)
}
fn skill_tool(at: &str) -> Value {
    json!({"type":"assistant","timestamp":at,"message":{"id":"msg_skill","model":"claude-opus-4-8","content":[{"type":"tool_use","id":"toolu_skill","name":"Skill","input":{"skill":NAME}}],"usage":{"input_tokens":2,"output_tokens":3},"stop_reason":"tool_use"}})
}
fn tool(id: &str, name: &str, input: Value, at: &str, message: &str) -> Value {
    json!({"type":"assistant","timestamp":at,"message":{"id":message,"model":"claude-opus-4-8","content":[{"type":"tool_use","id":id,"name":name,"input":input}],"usage":{"input_tokens":5,"output_tokens":3},"stop_reason":"tool_use"}})
}
fn result(id: &str, text: &str, at: &str, prompt: Option<&str>) -> Value {
    let mut v = json!({"type":"user","timestamp":at,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":text}]}});
    if let Some(prompt) = prompt {
        v["promptId"] = json!(prompt)
    }
    v
}
fn meta(prompt: Option<&str>, source: Option<&str>, at: &str, content: Option<Value>) -> Value {
    let mut v = json!({"type":"user","isMeta":true,"uuid":"meta-skill-stable-uuid","timestamp":at,"message":{"role":"user","content":content.unwrap_or_else(||json!([{"type":"text","text":body()}]))}});
    if let Some(prompt) = prompt {
        v["promptId"] = json!(prompt)
    }
    if let Some(source) = source {
        v["sourceToolUseID"] = json!(source)
    }
    v
}
fn answer(id: &str, text: &str, at: &str) -> Value {
    json!({"type":"assistant","timestamp":at,"message":{"id":id,"model":"claude-opus-4-8","content":[{"type":"text","text":text}],"usage":{"input_tokens":5,"output_tokens":3},"stop_reason":"end_turn"}})
}
fn write(path: &Path, rows: &[Value]) {
    fs::write(
        path,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap()
}
fn parse(rows: &[Value]) -> ParsedTranscript {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("transcript.jsonl");
    write(&file, rows);
    parse_claude_transcript(&file, 0).unwrap()
}
fn strings(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().flat_map(strings).collect(),
        Value::Object(o) => o.values().flat_map(strings).collect(),
        _ => Vec::new(),
    }
}
fn input(call: &LlmCall) -> String {
    strings(&Value::Array(call.input_messages.clone())).join("\n")
}
fn implicit(at: &str) -> Vec<Value> {
    vec![
        prompt("p1", "use the skill", &format!("2026-07-29T{at}:00.000Z")),
        skill_tool(&format!("2026-07-29T{at}:01.000Z")),
        result(
            "toolu_skill",
            &format!("Launching skill: {NAME}"),
            &format!("2026-07-29T{at}:02.000Z"),
            None,
        ),
        meta(
            None,
            Some("toolu_skill"),
            &format!("2026-07-29T{at}:02.500Z"),
            None,
        ),
        answer("msg_final", "done", &format!("2026-07-29T{at}:03.000Z")),
    ]
}
#[test]
fn l183_model_skill_meta_retains_link_identity_and_full_next_call_context() {
    let parsed = parse(&implicit("01:00"));
    assert_eq!(parsed.turns.len(), 1);
    let t = &parsed.turns[0];
    assert_eq!(t.skill_loads.len(), 1);
    let l = &t.skill_loads[0];
    assert_eq!(l.prompt_id.as_deref(), Some("p1"));
    assert_eq!(l.source_tool_use_id.as_deref(), Some("toolu_skill"));
    assert_eq!(l.name.as_deref(), Some(NAME));
    assert_eq!(l.id.as_deref(), Some(NAME));
    assert_eq!(l.root_path.as_deref(), Some(ROOT_SKILL));
    assert_eq!(l.meta_uuid.as_deref(), Some("meta-skill-stable-uuid"));
    assert!(input(&t.llm_calls[1]).contains(&format!("Launching skill: {NAME}")));
    assert!(input(&t.llm_calls[1]).contains(&body()));
}
#[test]
fn l211_direct_slash_retains_uncorrelated_load_and_full_first_call_meta() {
    let p = parse(&[
        slash("p1", NAME, "run it", "2026-07-29T01:00:00.000Z"),
        meta(Some("p1"), None, "2026-07-29T01:00:00.100Z", None),
        answer("msg_final", "done", "2026-07-29T01:00:01.000Z"),
    ]);
    let t = &p.turns[0];
    assert_eq!(t.skill_loads.len(), 1);
    let l = &t.skill_loads[0];
    assert!(l.source_tool_use_id.is_none());
    assert_eq!(l.name.as_deref(), Some(NAME));
    assert_eq!(l.root_path.as_deref(), Some(ROOT_SKILL));
    assert!(input(&t.llm_calls[0]).contains(&body()));
    assert!(input(&t.llm_calls[0]).contains(&format!("/{NAME}")));
}
#[test]
fn l228_prompt_ids_isolate_history_and_non_skill_meta_is_not_restored() {
    let mut caveat = prompt("clear-prompt", "local caveat", "2026-07-29T01:00:00.000Z");
    caveat["isMeta"] = json!(true);
    let p = parse(&[
        caveat,
        slash("clear-prompt", "clear", "", "2026-07-29T01:00:00.100Z"),
        slash("skill-prompt", NAME, "run it", "2026-07-29T01:00:01.000Z"),
        meta(Some("skill-prompt"), None, "2026-07-29T01:00:01.100Z", None),
        answer("msg_final", "done", "2026-07-29T01:00:02.000Z"),
    ]);
    let t = p
        .turns
        .iter()
        .find(|t| t.prompt_id.as_deref() == Some("skill-prompt"))
        .unwrap();
    let i = input(&t.llm_calls[0]);
    assert!(i.contains(&format!("/{NAME}")));
    assert!(i.contains(&body()));
    assert!(!i.contains("/clear"));
    assert!(!i.contains("local caveat"));
}
#[test]
fn l250_orphan_assistant_fallback_turn_never_pollutes_real_prompt_input() {
    let p = parse(&[
        answer("msg_orphan", "orphan answer", "2026-07-29T01:00:00.000Z"),
        prompt("p1", "real prompt", "2026-07-29T01:00:01.000Z"),
        answer("msg_real", "real answer", "2026-07-29T01:00:02.000Z"),
    ]);
    assert_eq!(p.turns.len(), 2);
    let real = p
        .turns
        .iter()
        .find(|t| t.prompt_id.as_deref() == Some("p1"))
        .unwrap();
    let fallback = p.turns.iter().find(|t| t.prompt_id.is_none()).unwrap();
    assert_eq!(
        real.llm_calls
            .iter()
            .map(|c| c.message_id.as_str())
            .collect::<Vec<_>>(),
        ["msg_real"]
    );
    assert_eq!(
        fallback
            .llm_calls
            .iter()
            .map(|c| c.message_id.as_str())
            .collect::<Vec<_>>(),
        ["msg_orphan"]
    );
    assert!(!input(&real.llm_calls[0]).contains("orphan answer"));
}
#[test]
fn l266_runtime_skill_meta_has_name_and_restored_body_without_a_tool_or_slash() {
    let p = parse(&[
        prompt("p1", "hello", "2026-07-29T01:00:00.000Z"),
        meta(Some("p1"), None, "2026-07-29T01:00:00.100Z", None),
        answer("msg_final", "done", "2026-07-29T01:00:01.000Z"),
    ]);
    let l = &p.turns[0].skill_loads[0];
    assert_eq!(l.name.as_deref(), Some(NAME));
    assert!(l.source_tool_use_id.is_none());
    assert!(input(&p.turns[0].llm_calls[0]).contains(&body()));
    assert!(!input(&p.turns[0].llm_calls[0]).contains("<command-name>"));
}
#[test]
fn l280_legacy_meta_without_root_is_restored_via_real_skill_tool_link() {
    let body = "# Legacy Skill\n\nComplete skill instructions";
    let p = parse(&[
        prompt("p1", "use skill", "2026-07-29T01:00:00.000Z"),
        skill_tool("2026-07-29T01:00:01.000Z"),
        meta(
            None,
            Some("toolu_skill"),
            "2026-07-29T01:00:02.000Z",
            Some(json!(body)),
        ),
        answer("msg_final", "done", "2026-07-29T01:00:03.000Z"),
    ]);
    let l = &p.turns[0].skill_loads[0];
    assert_eq!(l.source_tool_use_id.as_deref(), Some("toolu_skill"));
    assert_eq!(l.name.as_deref(), Some(NAME));
    assert_eq!(l.id.as_deref(), Some(NAME));
    assert!(l.root_path.is_none());
    assert!(input(&p.turns[0].llm_calls[1]).contains(body));
}
fn hook(session: &str, rows: &[Value], config: Option<Value>) -> Vec<Value> {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("transcript.jsonl");
    write(&file, rows);
    if let Some(config) = config {
        fs::write(root.path().join("config.json"), config.to_string()).unwrap()
    }
    let env = Env::from([
        (
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        ),
        ("HOME".into(), root.path().to_string_lossy().into_owned()),
    ]);
    let args = vec!["stop".into()];
    let stdin=json!({"session_id":session,"stop_reason":"end_turn","transcript_path":file,"cwd":"/abs/workdir"}).to_string();
    let mut stdout = Vec::new();
    assert_eq!(
        super::run(&mut HookRequest {
            args: &args,
            stdin: stdin.as_bytes(),
            env: &env,
            stdout: &mut stdout
        }),
        0
    );
    assert_eq!(String::from_utf8(stdout).unwrap().trim(), "{}");
    let logs = root.path().join("logs/claude-code");
    let mut records = Vec::new();
    for file in fs::read_dir(logs).unwrap() {
        let file = file.unwrap();
        if file.path().extension().and_then(|s| s.to_str()) == Some("jsonl") {
            records.extend(
                fs::read_to_string(file.path())
                    .unwrap()
                    .lines()
                    .map(|s| serde_json::from_str::<Value>(s).unwrap()),
            );
        }
    }
    records
}
fn events<'a>(records: &'a [Value], name: &str, tool: Option<&str>) -> Vec<&'a Value> {
    records
        .iter()
        .filter(|r| {
            r["event.name"] == name && tool.is_none_or(|tool| r["gen_ai.tool.name"] == tool)
        })
        .collect()
}
#[test]
fn l307_actual_hook_reuses_real_skill_tool_without_fabricated_read_or_load() {
    let rows = hook("implicit-hook", &implicit("02:00"), None);
    let calls = events(&rows, "tool.call", Some("Skill"));
    let results = events(&rows, "tool.result", Some("Skill"));
    assert_eq!(calls.len(), 1);
    assert_eq!(results.len(), 1);
    assert_eq!(calls[0]["gen_ai.tool.call.id"], "toolu_skill");
    for r in [calls[0], results[0]] {
        assert_eq!(r["gen_ai.skill.name"], NAME);
        assert_eq!(r["gen_ai.skill.id"], NAME)
    }
    assert!(events(&rows, "tool.call", Some("load_skill")).is_empty());
    assert!(events(&rows, "tool.call", Some("Read")).is_empty());
    assert!(strings(events(&rows, "llm.request", None)[1]).contains(&body()));
}
#[test]
fn l339_slash_load_is_deterministic_and_preserves_exact_s1_output_s2_delta() {
    let records = [
        slash("p1", NAME, "run it", "2026-07-29T02:00:00.000Z"),
        meta(Some("p1"), None, "2026-07-29T02:00:00.100Z", None),
        tool(
            "toolu_reference",
            "Read",
            json!({"file_path":format!("{BASE}/references/guide.md")}),
            "2026-07-29T02:00:01.000Z",
            "msg_read",
        ),
        result(
            "toolu_reference",
            "reference body",
            "2026-07-29T02:00:01.100Z",
            Some("p1"),
        ),
        answer("msg_final", "done", "2026-07-29T02:00:02.000Z"),
    ];
    let mut ids = Vec::new();
    for _ in 0..2 {
        let rows = hook("slash-hook", &records, None);
        let calls = events(&rows, "tool.call", Some("load_skill"));
        let results = events(&rows, "tool.result", Some("load_skill"));
        assert_eq!(calls.len(), 1);
        assert_eq!(results.len(), 1);
        let call = calls[0];
        let result = results[0];
        assert_eq!(call["gen_ai.tool.type"], "extension");
        assert_eq!(call["gen_ai.skill.name"], NAME);
        assert_eq!(call["gen_ai.skill.id"], NAME);
        assert_eq!(call["gen_ai.tool.call.arguments"], json!({"skill":NAME}));
        let id = call["gen_ai.tool.call.id"].as_str().unwrap();
        assert_eq!(result["gen_ai.tool.call.id"], id);
        assert!(
            result["time_unix_nano"]
                .as_str()
                .unwrap()
                .parse::<u128>()
                .unwrap()
                > call["time_unix_nano"]
                    .as_str()
                    .unwrap()
                    .parse::<u128>()
                    .unwrap()
        );
        let responses = events(&rows, "llm.response", None);
        assert_eq!(call["time_unix_nano"], responses[0]["time_unix_nano"]);
        assert_eq!(
            events(&rows, "tool.call", Some("Read"))
                .iter()
                .map(|r| r["gen_ai.tool.call.id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["toolu_reference"]
        );
        let parts = responses[0]["gen_ai.output.messages"][0]["parts"]
            .as_array()
            .unwrap();
        assert_eq!(
            parts
                .iter()
                .filter(|p| p["type"] == "tool_call")
                .map(|p| p["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["Read", "load_skill"]
        );
        assert_eq!(
            events(&rows, "llm.request", None)[1]["gen_ai.input.messages_delta"],
            json!([
                {"role":"assistant","parts":[{"type":"tool_call","id":"toolu_reference","name":"Read","arguments":{"file_path":format!("{BASE}/references/guide.md")}},{"type":"tool_call","id":id,"name":"load_skill","arguments":{"skill":NAME}}]},
                {"role":"tool","parts":[{"type":"tool_call_response","id":"toolu_reference","response":"reference body"}]},
                {"role":"tool","parts":[{"type":"tool_call_response","id":id,"response":{"success":true}}]}
            ])
        );
        ids.push(id.to_owned());
    }
    assert_eq!(ids[0], ids[1]);
    let suffix = ids[0].strip_prefix("toolu_skillload_").unwrap();
    assert_eq!(suffix.len(), 24);
    assert!(suffix
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
}
#[test]
fn l429_deprecated_false_capture_does_not_strip_skill_body_or_tool_payload() {
    let rows = hook(
        "private-skill",
        &[
            slash("p1", NAME, "run it", "2026-07-29T02:00:00.000Z"),
            meta(Some("p1"), None, "2026-07-29T02:00:00.100Z", None),
            answer("msg_final", "done", "2026-07-29T02:00:01.000Z"),
        ],
        Some(json!({"agents":{"claude-code":{"enabled":true,"captureMessageContent":false}}})),
    );
    let call = events(&rows, "tool.call", Some("load_skill"))[0];
    let result = events(&rows, "tool.result", Some("load_skill"))[0];
    assert_eq!(call["gen_ai.skill.name"], NAME);
    assert_eq!(call["gen_ai.skill.id"], NAME);
    assert!(call.get("gen_ai.tool.call.arguments").is_some());
    assert!(result.get("gen_ai.tool.call.result").is_some());
    assert!(rows
        .iter()
        .flat_map(strings)
        .any(|s| s.contains("skill body secret")));
}
#[test]
fn l450_two_ordinary_read_tools_remain_distinct_without_skill_events() {
    let rows = hook(
        "ordinary-read",
        &[
            prompt("p1", "read it twice", "2026-07-29T02:00:00.000Z"),
            tool(
                "read-a",
                "Read",
                json!({"file_path":"/tmp/a"}),
                "2026-07-29T02:00:01.000Z",
                "msg_a",
            ),
            result("read-a", "a", "2026-07-29T02:00:01.100Z", Some("p1")),
            tool(
                "read-b",
                "Read",
                json!({"file_path":"/tmp/a"}),
                "2026-07-29T02:00:02.000Z",
                "msg_b",
            ),
            result("read-b", "a", "2026-07-29T02:00:02.100Z", Some("p1")),
            answer("msg_final", "done", "2026-07-29T02:00:03.000Z"),
        ],
        None,
    );
    assert_eq!(
        events(&rows, "tool.call", Some("Read"))
            .iter()
            .map(|r| r["gen_ai.tool.call.id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["read-a", "read-b"]
    );
    assert!(events(&rows, "tool.call", Some("load_skill")).is_empty());
    assert!(events(&rows, "tool.call", Some("Skill")).is_empty());
}
