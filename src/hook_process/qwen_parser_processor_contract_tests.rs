use super::*;
use serde_json::json;
use std::io::Write;
const COMMITTED_FIXTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/hooks/qwen-code-cli/fixtures/real-multi-step-tool-calls.jsonl"
));
const FIXTURE_SESSION: &str = "3821eeeb-f45b-4a91-b921-6949b9893e88";
fn user(uuid: &str, text: &str, second: &str) -> Value {
    json!({"uuid":uuid,"parentUuid":null,"sessionId":"sess-1","timestamp":format!("2026-06-17T08:{second}.000Z"),"type":"user","cwd":"/work","version":"0.14.4","message":{"role":"user","parts":[{"text":text}]}})
}
fn assistant(uuid: &str, parts: Value, time: &str, input: i64, output: i64) -> Value {
    json!({"uuid":uuid,"parentUuid":"u-prev","sessionId":"sess-1","timestamp":format!("2026-06-17T08:{time}.000Z"),"type":"assistant","cwd":"/work","version":"0.14.4","model":"qwen3.6-plus","message":{"role":"model","parts":parts},"usageMetadata":{"promptTokenCount":input,"candidatesTokenCount":output,"thoughtsTokenCount":0,"totalTokenCount":input+output,"cachedContentTokenCount":0},"contextWindowSize":131072})
}
fn result(uuid: &str, id: &str, response: Value, time: &str) -> Value {
    json!({"uuid":uuid,"parentUuid":"a-prev","sessionId":"sess-1","timestamp":format!("2026-06-17T08:{time}.000Z"),"type":"tool_result","cwd":"/work","version":"0.14.4","message":{"role":"user","parts":[{"functionResponse":{"name":"Bash","response":response}}]},"toolCallResult":{"callId":id,"status":"success"}})
}
fn api(uuid: &str, prompt: &str, duration: i64) -> Value {
    json!({"uuid":uuid,"parentUuid":"x","sessionId":"sess-1","timestamp":"2026-06-17T08:00:09.000Z","type":"system","subtype":"ui_telemetry","cwd":"/work","version":"0.14.4","systemPayload":{"uiEvent":{"event.name":"qwen-code.api_response","event.timestamp":"2026-06-17T08:00:09.000Z","response_id":format!("resp_{uuid}"),"model":"qwen3.6-plus","status_code":200,"duration_ms":duration,"input_token_count":100,"output_token_count":10,"cached_content_token_count":0,"thoughts_token_count":0,"total_token_count":110,"prompt_id":prompt,"auth_type":"openai"}}})
}
fn basic() -> Vec<Value> {
    vec![
        user("u1", "q1", "00:00"),
        assistant("a1", json!([{"text":"a1"}]), "00:10", 100, 20),
    ]
}
fn tool_rows() -> Vec<Value> {
    vec![
        user("u1", "do it", "00:00"),
        assistant(
            "a1",
            json!([{"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"call_1"}}]),
            "00:10",
            100,
            10,
        ),
        result("tr1", "call_1", json!({"stdout":"file1"}), "00:12"),
        assistant("a2", json!([{"text":"done"}]), "00:15", 200, 5),
    ]
}
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    path: PathBuf,
    session: String,
}
impl Fixture {
    fn new(rows: &[Value]) -> Self {
        Self::new_for_session(rows, "sess-1")
    }
    fn new_for_session(rows: &[Value], session: &str) -> Self {
        let rows = rows
            .iter()
            .cloned()
            .map(|mut row| {
                row["sessionId"] = json!(session);
                row
            })
            .collect::<Vec<_>>();
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let path = root.join("native.jsonl");
        std::fs::write(
            &path,
            rows.iter().map(|r| format!("{r}\n")).collect::<String>(),
        )
        .unwrap();
        Self {
            _dir: dir,
            root,
            path,
            session: session.into(),
        }
    }
    fn parse(&self, offset: u64) -> Parsed {
        parse_qwen_transcript(&self.path, offset, Some("sess-1")).unwrap()
    }
    fn append(&self, rows: &[Value]) {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.path)
            .unwrap();
        for row in rows {
            let mut row = row.clone();
            row["sessionId"] = json!(self.session);
            writeln!(file, "{row}").unwrap();
        }
    }
    fn invoke(&self, sub: &str, payload: &Value, extra: &[(&str, &str)]) {
        let mut env = Env::new();
        for key in ["LOONGSUITE_PILOT_DATA_DIR", "HOME", "USERPROFILE"] {
            env.insert(key.into(), self.root.to_string_lossy().into_owned());
        }
        for (key, value) in extra {
            env.insert((*key).into(), (*value).into());
        }
        let args = vec![sub.to_owned()];
        let stdin = serde_json::to_vec(payload).unwrap();
        let mut output = Vec::new();
        let mut req = super::super::common::HookRequest {
            args: &args,
            stdin: &stdin,
            env: &env,
            stdout: &mut output,
        };
        assert_eq!(run(&mut req), 0);
        assert_eq!(output, b"{}\n");
    }
    fn stop(&self, session: &str, extra: &[(&str, &str)]) {
        self.invoke("stop",&json!({"session_id":session,"transcript_path":self.path,"cwd":"/work","stop_reason":"end_turn"}),extra)
    }
    fn records(&self) -> Vec<Value> {
        let dir = self.root.join("logs/qwen-code-cli");
        let Ok(entries) = std::fs::read_dir(dir) else {
            return vec![];
        };
        let mut files = entries
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
            .collect::<Vec<_>>();
        files.sort();
        files
            .into_iter()
            .flat_map(|p| {
                std::fs::read_to_string(p)
                    .unwrap()
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| serde_json::from_str(l).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect()
    }
}
fn named<'a>(records: &'a [Value], name: &str) -> Vec<&'a Value> {
    records.iter().filter(|r| r["event.name"] == name).collect()
}
fn trace_count(records: &[Value]) -> usize {
    records
        .iter()
        .map(|r| r["trace_id"].as_str().unwrap())
        .collect::<HashSet<_>>()
        .len()
}
#[test]
fn parser_l97_one_plain_user_opens_one_turn_with_one_assistant() {
    let turns = split_into_turns(&basic());
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].user["uuid"], "u1");
    assert_eq!(turns[0].records.len(), 1);
}
#[test]
fn parser_l108_two_plain_users_open_two_distinct_turns() {
    let mut records = basic();
    records.extend([
        user("u2", "q2", "00:00"),
        assistant("a2", json!([{"text":"a2"}]), "00:10", 100, 20),
    ]);
    let turns = split_into_turns(&records);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].records.len(), 1);
    assert_eq!(turns[1].records.len(), 1);
}
#[test]
fn parser_l121_mid_turn_user_remains_in_existing_turn() {
    let mut middle = user("u1b", "extra", "00:05");
    middle["subtype"] = json!("mid_turn_user_message");
    let turns = split_into_turns(&[
        user("u1", "q1", "00:00"),
        middle,
        assistant("a1", json!([{"text":"a1"}]), "00:10", 100, 20),
    ]);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].records.len(), 2);
}
#[test]
fn parser_l133_orphan_records_before_first_real_user_are_dropped() {
    let mut records = vec![assistant(
        "orphan-a",
        json!([{"text":"orphan"}]),
        "00:10",
        100,
        20,
    )];
    records.extend(basic());
    let turns = split_into_turns(&records);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].records.len(), 1);
    assert_eq!(turns[0].records[0]["uuid"], "a1");
}
#[test]
fn parser_l147_real_file_parse_returns_exact_offset_prompt_model_and_usage() {
    let f = Fixture::new(&[
        user("u1", "hello", "00:00"),
        assistant("a1", json!([{"text":"hi"}]), "00:10", 50, 5),
    ]);
    let parsed = f.parse(0);
    assert_eq!(
        parsed.next_offset,
        std::fs::metadata(&f.path).unwrap().len()
    );
    assert_eq!(parsed.turns.len(), 1);
    let t = &parsed.turns[0];
    assert_eq!(t.prompt, "hello");
    assert_eq!(
        t.prompt_timestamp.as_deref(),
        Some("2026-06-17T08:00:00.000Z")
    );
    assert_eq!(t.llm_calls.len(), 1);
    assert_eq!(t.llm_calls[0].model, "qwen3.6-plus");
    assert_eq!(
        t.llm_calls[0].usage_metadata.as_ref().unwrap()["promptTokenCount"],
        50
    );
}
#[test]
fn parser_l163_saved_physical_offset_reads_no_new_turns() {
    let f = Fixture::new(&basic());
    let first = f.parse(0);
    assert_eq!(first.turns.len(), 1);
    let second = f.parse(first.next_offset);
    assert!(second.turns.is_empty());
    assert_eq!(second.next_offset, first.next_offset);
}
#[test]
fn parser_l176_actual_file_two_users_have_two_ordered_prompts() {
    let f = Fixture::new(&[
        user("u1", "q1", "00:00"),
        assistant("a1", json!([{"text":"a1"}]), "00:05", 100, 20),
        user("u2", "q2", "00:10"),
        assistant("a2", json!([{"text":"a2"}]), "00:15", 100, 20),
    ]);
    let p = f.parse(0);
    assert_eq!(p.turns.len(), 2);
    assert_eq!(p.turns[0].prompt, "q1");
    assert_eq!(p.turns[1].prompt, "q2");
}
#[test]
fn parser_l190_two_steps_preserve_declared_tool_result_and_final_reply() {
    let p = Fixture::new(&tool_rows()).parse(0);
    assert_eq!(p.turns.len(), 1);
    let calls = &p.turns[0].llm_calls;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].declared_tools.len(), 1);
    let t = &calls[0].declared_tools[0];
    assert_eq!(t.call_id.as_deref(), Some("call_1"));
    assert_eq!(t.name, "Bash");
    let r = t.result.as_ref().unwrap();
    assert_eq!(r.response, Some(json!({"stdout":"file1"})));
    assert_eq!(r.status, "success");
    assert!(calls[1].declared_tools.is_empty());
}
#[test]
fn parser_l216_three_parallel_calls_match_results_by_id_despite_arrival_order() {
    let f = Fixture::new(&[
        user("u1", "run 3 commands", "00:00"),
        assistant(
            "a1",
            json!([{"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"c1"}},{"functionCall":{"name":"Bash","args":{"cmd":"pwd"},"id":"c2"}},{"functionCall":{"name":"Bash","args":{"cmd":"date"},"id":"c3"}}]),
            "00:10",
            100,
            20,
        ),
        result("tr2", "c2", json!("pwd-out"), "00:13"),
        result("tr1", "c1", json!("ls-out"), "00:14"),
        result("tr3", "c3", json!("date-out"), "00:15"),
        assistant("a2", json!([{"text":"done"}]), "00:20", 100, 20),
    ]);
    let p = f.parse(0);
    let tools = &p.turns[0].llm_calls[0].declared_tools;
    assert_eq!(tools.len(), 3);
    assert_eq!(
        tools
            .iter()
            .map(|t| t
                .result
                .as_ref()
                .unwrap()
                .response
                .as_ref()
                .unwrap()
                .as_str()
                .unwrap())
            .collect::<Vec<_>>(),
        ["ls-out", "pwd-out", "date-out"]
    );
}
#[test]
fn parser_l239_missing_call_ids_use_positional_results_and_backfill_wire_ids() {
    let p=Fixture::new(&[user("u1","q","00:00"),assistant("a1",json!([{"functionCall":{"name":"X","args":{}}},{"functionCall":{"name":"Y","args":{}}}]),"00:10",100,20),result("tr1","wire_id_1",json!("r1"),"00:12"),result("tr2","wire_id_2",json!("r2"),"00:13")]).parse(0);
    let tools = &p.turns[0].llm_calls[0].declared_tools;
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].call_id.as_deref(), Some("wire_id_1"));
    assert_eq!(
        tools[0].result.as_ref().unwrap().response,
        Some(json!("r1"))
    );
    assert_eq!(tools[1].call_id.as_deref(), Some("wire_id_2"));
    assert_eq!(
        tools[1].result.as_ref().unwrap().response,
        Some(json!("r2"))
    );
}
#[test]
fn parser_l261_unfinished_tool_call_keeps_result_absent() {
    let p = Fixture::new(&[
        user("u1", "q", "00:00"),
        assistant(
            "a1",
            json!([{"functionCall":{"name":"X","args":{},"id":"pending"}}]),
            "00:10",
            100,
            20,
        ),
    ])
    .parse(0);
    let t = &p.turns[0].llm_calls[0].declared_tools[0];
    assert_eq!(t.call_id.as_deref(), Some("pending"));
    assert!(t.result.is_none());
}
#[test]
fn parser_l276_error_result_preserves_status_and_original_error() {
    let mut r = result("tr1", "c1", Value::Null, "00:12");
    r["toolCallResult"]["status"] = json!("error");
    r["toolCallResult"]["error"] = json!("permission denied");
    let p = Fixture::new(&[
        user("u1", "q", "00:00"),
        assistant(
            "a1",
            json!([{"functionCall":{"name":"Bash","args":{},"id":"c1"}}]),
            "00:10",
            100,
            20,
        ),
        r,
    ])
    .parse(0);
    let r = p.turns[0].llm_calls[0].declared_tools[0]
        .result
        .as_ref()
        .unwrap();
    assert_eq!(r.status, "error");
    assert_eq!(r.error, Some(json!("permission denied")));
}
#[test]
fn parser_l293_matching_prompt_prefix_attaches_api_response_id_and_duration() {
    let p = Fixture::new(&[
        user("u1", "q", "00:00"),
        api("api1", "sess-1########0", 9000),
        assistant("a1", json!([{"text":"done"}]), "00:10", 100, 10),
    ])
    .parse(0);
    let api = p.turns[0].llm_calls[0].api_response.as_ref().unwrap();
    assert_eq!(api.response_id.as_deref(), Some("resp_api1"));
    assert_eq!(api.duration_ms, Some(9000.0));
}
#[test]
fn parser_l307_foreign_subagent_prompt_id_is_not_attached_to_main() {
    let p = Fixture::new(&[
        user("u1", "q", "00:00"),
        api("api-sub", "subagent-xxx-yyy#0", 1000),
        assistant("a1", json!([{"text":"done"}]), "00:10", 100, 20),
    ])
    .parse(0);
    assert!(p.turns[0].llm_calls[0].api_response.is_none());
}
#[test]
fn parser_l319_sidechain_assistant_is_filtered_from_main() {
    let mut side = assistant("a-side", json!([{"text":"sub"}]), "00:10", 100, 20);
    side["isSidechain"] = json!(true);
    side["agentId"] = json!("sub-1");
    let p = Fixture::new(&[
        user("u1", "q", "00:00"),
        side,
        assistant("a-main", json!([{"text":"main"}]), "00:10", 100, 20),
    ])
    .parse(0);
    assert_eq!(p.turns[0].llm_calls.len(), 1);
    assert_eq!(
        p.turns[0].llm_calls[0].assistant_uuid.as_deref(),
        Some("a-main")
    );
}
#[test]
fn parser_l334_each_step_input_delta_keeps_only_intervening_source_records() {
    let p = Fixture::new(&tool_rows()).parse(0);
    let calls = &p.turns[0].llm_calls;
    assert_eq!(calls[0].input_delta.len(), 1);
    assert_eq!(calls[0].input_delta[0]["type"], "user");
    assert_eq!(calls[1].input_delta.len(), 2);
    assert_eq!(
        calls[1]
            .input_delta
            .iter()
            .map(|r| r["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["assistant", "tool_result"]
    );
}
#[test]
fn parser_l351_request_start_uses_user_then_latest_tool_result_time() {
    let mut rows = tool_rows();
    rows[2]["timestamp"] = json!("2026-06-17T08:00:13.000Z");
    let p = Fixture::new(&rows).parse(0);
    assert_eq!(
        p.turns[0].llm_calls[0].request_start.as_deref(),
        Some("2026-06-17T08:00:00.000Z")
    );
    assert_eq!(
        p.turns[0].llm_calls[1].request_start.as_deref(),
        Some("2026-06-17T08:00:13.000Z")
    );
}
#[test]
fn parser_l364_missing_file_is_empty_without_touching_live_paths() {
    let f = Fixture::new(&[]);
    assert!(
        parse_qwen_transcript(&f.root.join("nonexistent/path.jsonl"), 0, Some("sess-1"))
            .unwrap()
            .turns
            .is_empty()
    );
}
#[test]
fn parser_l369_offset_after_physical_eof_returns_no_turns() {
    let f = Fixture::new(&[user("u1", "q", "00:00")]);
    assert!(f.parse(99999).turns.is_empty());
}
fn pairing_call(ids: &[Option<&str>]) -> LlmCall {
    LlmCall {
        assistant_uuid: None,
        timestamp: None,
        request_start: None,
        model: String::new(),
        usage_metadata: None,
        assistant_record: Value::Null,
        api_response: None,
        declared_tools: ids
            .iter()
            .enumerate()
            .map(|(i, id)| DeclaredTool {
                call_id: id.map(str::to_owned),
                native_call_id: id.map(str::to_owned),
                name: if i == 0 { "A".into() } else { "B".into() },
                args: json!({}),
                part_index: i,
                result: None,
                timestamp: None,
            })
            .collect(),
        input_delta: vec![],
    }
}
#[test]
fn parser_l378_exact_call_id_matching_precedes_positional_fallback_and_counts_once() {
    let mut calls = vec![pairing_call(&[Some("good"), None])];
    let records = [
        result("tr-unmatched", "orphan", json!("or"), "00:11"),
        result("tr-good", "good", json!("gr"), "00:12"),
    ];
    let used = pair_tool_calls_with_results(&mut calls, &records, false);
    let tools = &calls[0].declared_tools;
    assert_eq!(
        tools[0].result.as_ref().unwrap().response,
        Some(json!("gr"))
    );
    assert_eq!(
        tools[1].result.as_ref().unwrap().response,
        Some(json!("or"))
    );
    assert_eq!(tools[1].call_id.as_deref(), Some("orphan"));
    assert_eq!(used, 1);
}
#[test]
fn parser_l398_all_native_call_ids_require_zero_positional_fallbacks() {
    let mut calls = vec![pairing_call(&[Some("c1"), Some("c2")])];
    let rows = [
        result("tr1", "c1", json!("r1"), "00:11"),
        result("tr2", "c2", json!("r2"), "00:12"),
    ];
    assert_eq!(pair_tool_calls_with_results(&mut calls, &rows, false), 0);
}
#[test]
fn parser_l417_checked_in_session_fixture_keeps_two_steps_three_parallel_tools_usage_and_metadata()
{
    let f = Fixture::new(&[]);
    std::fs::write(&f.path, COMMITTED_FIXTURE).unwrap();
    let parsed = parse_qwen_transcript(&f.path, 0, Some(FIXTURE_SESSION)).unwrap();
    assert_eq!(parsed.turns.len(), 1);
    let t = &parsed.turns[0];
    assert!(t.prompt.contains("subagent"));
    assert_eq!(t.llm_calls.len(), 2);
    let first = &t.llm_calls[0];
    assert_eq!(first.declared_tools.len(), 3);
    assert!(first.declared_tools.iter().all(|t| t.name == "agent"
        && t.call_id.is_some()
        && t.result.as_ref().is_some_and(|r| r.status == "success")));
    assert_eq!(
        first.usage_metadata.as_ref().unwrap()["promptTokenCount"],
        14484
    );
    assert_eq!(
        first.usage_metadata.as_ref().unwrap()["candidatesTokenCount"],
        287
    );
    assert_eq!(
        first.api_response.as_ref().unwrap().duration_ms,
        Some(6983.0)
    );
    assert!(t.llm_calls[1].declared_tools.is_empty());
    let parts = first.assistant_record["message"]["parts"]
        .as_array()
        .unwrap();
    assert!(parts
        .iter()
        .any(|p| p["thought"] == true && p["text"].as_str().is_some_and(|s| !s.is_empty())));
    assert!(parts
        .iter()
        .any(|p| p["thought"] != true && p["text"].as_str().is_some_and(|s| !s.is_empty())));
}
#[test]
fn processor_l100_stop_writes_real_event_types_two_steps_single_trace_and_tool_pair() {
    let mut rows = tool_rows();
    rows[1] = assistant(
        "a1",
        json!([{"text":"I will run ls.","thought":true},{"text":"Sure."},{"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"c1"}}]),
        "00:10",
        100,
        15,
    );
    rows[2] = result("tr1", "c1", json!({"stdout":"file1"}), "00:13");
    let f = Fixture::new_for_session(&rows, "sess-end2end-1");
    f.stop("sess-end2end-1", &[]);
    let records = f.records();
    assert!(!records.is_empty());
    for name in [
        "other",
        "llm.request",
        "llm.response",
        "tool.call",
        "tool.result",
    ] {
        assert!(!named(&records, name).is_empty(), "{name}");
    }
    let responses = named(&records, "llm.response");
    assert_eq!(responses.len(), 2);
    assert_eq!(
        responses
            .iter()
            .map(|r| r["gen_ai.step.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        2
    );
    assert_eq!(trace_count(&records), 1);
    assert_eq!(records[0]["gen_ai.turn.id"], "sess-end2end-1:t1");
    assert_eq!(
        named(&records, "tool.call")[0]["gen_ai.tool.call.id"],
        named(&records, "tool.result")[0]["gen_ai.tool.call.id"]
    );
    assert_eq!(named(&records, "tool.call")[0]["gen_ai.tool.call.id"], "c1");
}
#[test]
fn processor_l152_second_stop_reopens_persisted_state_without_replaying_output() {
    let f = Fixture::new_for_session(&basic(), "sess-state-1");
    f.stop("sess-state-1", &[]);
    let count = f.records().len();
    assert!(count > 0);
    f.stop("sess-state-1", &[]);
    assert_eq!(f.records().len(), count);
}
#[test]
fn processor_l169_appended_second_turn_has_fresh_trace_and_turn_two_id() {
    let f = Fixture::new_for_session(&basic(), "sess-incr-1");
    f.stop("sess-incr-1", &[]);
    assert_eq!(trace_count(&f.records()), 1);
    f.append(&[
        user("u2", "q2", "01:00"),
        assistant("a2", json!([{"text":"a2"}]), "01:10", 200, 8),
    ]);
    f.stop("sess-incr-1", &[]);
    let rows = f.records();
    assert_eq!(trace_count(&rows), 2);
    assert!(rows
        .iter()
        .any(|r| r["gen_ai.turn.id"] == "sess-incr-1:t2" && r["event.name"] == "llm.response"));
}
#[test]
fn processor_l199_resumed_turn_gets_current_worker_resource_without_token_leak() {
    let f = Fixture::new_for_session(&basic(), "sess-worker-resume-1");
    f.stop(
        "sess-worker-resume-1",
        &[
            ("AGENTTEAMS_WORKER_NAME", "planner"),
            ("AGENTTEAMS_INSTANCE_ID", "qwen-instance-01"),
            ("AGENTTEAMS_TOKEN", "must-not-leak"),
        ],
    );
    f.append(&[
        user("u2", "q2", "01:00"),
        assistant("a2", json!([{"text":"a2"}]), "01:10", 100, 20),
    ]);
    f.stop(
        "sess-worker-resume-1",
        &[
            ("AGENTTEAMS_WORKER_NAME", "reviewer"),
            ("AGENTTEAMS_INSTANCE_ID", "qwen-instance-02"),
        ],
    );
    let rows = f.records();
    let a = rows
        .iter()
        .filter(|r| r["gen_ai.turn.id"] == "sess-worker-resume-1:t1")
        .collect::<Vec<_>>();
    let b = rows
        .iter()
        .filter(|r| r["gen_ai.turn.id"] == "sess-worker-resume-1:t2")
        .collect::<Vec<_>>();
    assert!(!a.is_empty() && !b.is_empty());
    assert!(a.iter().all(|r| r["gen_ai.agent.name"] == "planner"));
    assert!(b.iter().all(|r| r["gen_ai.agent.name"] == "reviewer"));
    assert_eq!(
        a[0]["resourceAttributes"]["agentteams.instance.id"],
        "qwen-instance-01"
    );
    assert_eq!(
        b[0]["resourceAttributes"]["agentteams.instance.id"],
        "qwen-instance-02"
    );
    assert!(!serde_json::to_string(&rows)
        .unwrap()
        .contains("must-not-leak"));
}
#[test]
fn processor_l240_resumed_span_attributes_refresh_and_disappear_without_stale_or_secret_values() {
    let f = Fixture::new_for_session(&basic(), "sess-span-attrs-resume-1");
    let sid = "sess-span-attrs-resume-1";
    f.stop(sid,&[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES","multica.issue.id=issue-1,multica.user.id=staff-1,gen_ai.agent.name=must-not-overwrite,multica.api_token=must-not-leak")]);
    f.append(&[
        user("u2", "q2", "01:00"),
        assistant("a2", json!([{"text":"a2"}]), "01:10", 100, 20),
    ]);
    f.stop(
        sid,
        &[(
            "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
            "multica.issue.id=issue-2,multica.user.id=staff-2",
        )],
    );
    f.append(&[
        user("u3", "q3", "02:00"),
        assistant("a3", json!([{"text":"a3"}]), "02:10", 100, 20),
    ]);
    f.stop(sid, &[]);
    let rows = f.records();
    for (index, issue, staff) in [
        (1, Some("issue-1"), Some("staff-1")),
        (2, Some("issue-2"), Some("staff-2")),
        (3, None, None),
    ] {
        let id = format!("{sid}:t{index}");
        let turn = rows
            .iter()
            .filter(|r| r["gen_ai.turn.id"] == id)
            .collect::<Vec<_>>();
        assert!(!turn.is_empty());
        for row in turn {
            assert_eq!(row.get("multica.issue.id").and_then(Value::as_str), issue);
            assert_eq!(row.get("multica.user.id").and_then(Value::as_str), staff);
        }
    }
    assert!(rows
        .iter()
        .all(|r| r["gen_ai.agent.name"] != "must-not-overwrite"));
    assert!(!serde_json::to_string(&rows)
        .unwrap()
        .contains("must-not-leak"));
}
#[test]
fn processor_l293_first_run_six_turn_history_emits_only_last_prompt() {
    let mut rows = Vec::new();
    for i in 1..=6 {
        rows.extend([
            user(&format!("u{i}"), &format!("q{i}"), &format!("0{i}:00")),
            assistant(
                &format!("a{i}"),
                json!([{"text":format!("a{i}")}]),
                &format!("0{i}:10"),
                100,
                20,
            ),
        ]);
    }
    let f = Fixture::new_for_session(&rows, "sess-firstrun-1");
    f.stop("sess-firstrun-1", &[]);
    let records = f.records();
    assert_eq!(trace_count(&records), 1);
    assert_eq!(
        named(&records, "other")[0]["gen_ai.input.messages_delta"][0]["parts"][0]["content"],
        "q6"
    );
}
#[test]
fn processor_l313_missing_transcript_path_is_fail_open_with_no_output() {
    let f = Fixture::new(&[]);
    f.invoke(
        "stop",
        &json!({"session_id":"sess-missing","cwd":"/work","stop_reason":"end_turn"}),
        &[],
    );
    assert!(f.records().is_empty());
}
#[test]
fn processor_l319_missing_session_id_is_fail_open_with_no_output() {
    let f = Fixture::new(&[user("u1", "q", "00:00")]);
    f.invoke(
        "stop",
        &json!({"transcript_path":f.path,"cwd":"/work","stop_reason":"end_turn"}),
        &[],
    );
    assert!(f.records().is_empty());
}
#[test]
fn processor_l328_child_start_and_stop_acknowledge_without_touching_parent_state_bytes() {
    for event in ["subagent-start", "subagent-stop"] {
        let f = Fixture::new(&[]);
        let dir = f.root.join("state/qwen-code-cli/sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sess-sa-1.json");
        let original = b"{\"transcript_offset\":12345,\"turn_count\":2}";
        std::fs::write(&file, original).unwrap();
        f.invoke(
            event,
            &json!({"session_id":"sess-sa-1","agent_id":"child","agent_type":"Explore"}),
            &[],
        );
        assert!(f.records().is_empty());
        assert_eq!(std::fs::read(file).unwrap(), original);
    }
}
#[test]
fn processor_l345_checked_in_session_fixture_reaches_real_jsonl_with_all_original_usage_and_field_contracts(
) {
    let f = Fixture::new(&[]);
    std::fs::write(&f.path, COMMITTED_FIXTURE).unwrap();
    f.stop(FIXTURE_SESSION, &[]);
    let rows = f.records();
    assert!(!rows.is_empty());
    assert_eq!(trace_count(&rows), 1);
    let llms = named(&rows, "llm.response");
    assert_eq!(llms.len(), 2);
    assert_eq!(
        llms.iter()
            .map(|r| r["gen_ai.step.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        2
    );
    let calls = named(&rows, "tool.call");
    let results = named(&rows, "tool.result");
    assert_eq!(calls.len(), 3);
    assert_eq!(results.len(), 3);
    for call in &calls {
        assert!(results
            .iter()
            .any(|r| r["gen_ai.tool.call.id"] == call["gen_ai.tool.call.id"]));
        assert_eq!(call["gen_ai.tool.name"], "agent");
    }
    let first = llms[0];
    assert_eq!(first["gen_ai.usage.input_tokens"], 14484);
    assert_eq!(first["gen_ai.usage.output_tokens"], 287);
    let parts = first["gen_ai.output.messages"][0]["parts"]
        .as_array()
        .unwrap();
    assert!(parts.iter().any(|p| p["type"] == "reasoning"));
    assert!(parts.iter().any(|p| p["type"] == "text"));
    assert_eq!(parts.iter().filter(|p| p["type"] == "tool_call").count(), 3);
    assert_eq!(first["gen_ai.provider.name"], "qwen");
    assert_eq!(first["gen_ai.request.model"], "qwen3.6-plus");
    for r in &rows {
        for key in [
            "time_unix_nano",
            "event.id",
            "event.name",
            "user.id",
            "trace_id",
        ] {
            assert!(!r[key].as_str().unwrap().is_empty(), "{key}");
        }
        assert_eq!(r["gen_ai.session.id"], FIXTURE_SESSION);
        assert_eq!(r["gen_ai.turn.id"], format!("{FIXTURE_SESSION}:t1"));
    }
}
