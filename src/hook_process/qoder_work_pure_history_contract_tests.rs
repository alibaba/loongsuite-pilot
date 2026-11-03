use super::*;
use crate::flushers::{ConvertOptions, ConvertResult, EventLogConverter, GenAiEventLogConverter};
use crate::types::AgentActivityEntry;
fn rows(key: &str) -> Vec<Value> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/qoder-work-hook-history-inputs.json"
    ))
    .unwrap();
    serde_json::from_value(fixture["literalRows"][key].clone()).unwrap()
}
fn text_row(value: Value) -> Value {
    json!({"message":{"content":value}})
}
fn events(key: &str) -> Vec<Value> {
    process_transcript(
        &rows(key),
        "session-1",
        "qoder-work",
        "user-1",
        Some("/workspace"),
        "incremental",
        &Env::new(),
    )
    .into_iter()
    .map(Value::Object)
    .collect()
}
fn record<'a>(events: &'a [Value], name: &str, step: &str) -> &'a Value {
    events
        .iter()
        .find(|e| e["event.name"] == name && e["gen_ai.step.id"] == step)
        .unwrap()
}
fn convert(events: &[Value]) -> ConvertResult {
    let records = events
        .iter()
        .cloned()
        .map(|v| serde_json::from_value::<AgentActivityEntry>(v).unwrap())
        .collect::<Vec<_>>();
    GenAiEventLogConverter
        .convert(&records, &ConvertOptions::default())
        .unwrap()
}
fn inputs(result: &ConvertResult) -> Vec<Value> {
    let mut spans = result
        .spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
        .collect::<Vec<_>>();
    spans.sort_by_key(|s| s.start_time);
    spans
        .iter()
        .map(|s| match &s.attributes["gen_ai.input.messages"] {
            Value::String(v) => serde_json::from_str(v).unwrap(),
            v => v.clone(),
        })
        .collect()
}
#[test]
fn pure_l13_l17_l21_l26_l39_l44_actual_text_extraction_shapes() {
    for (row, expected) in [
        (text_row(json!("hello")), "hello"),
        (json!({}), ""),
        (
            text_row(json!([{"type":"text","text":"user query"}])),
            "user query",
        ),
        (
            text_row(
                json!([{"type":"text","text":"first"},{"type":"tool_use","id":"t1","name":"shell","input":{}},{"type":"text","text":"second"}]),
            ),
            "first\nsecond",
        ),
        (text_row(json!(["plain string"])), "plain string"),
        (
            text_row(json!([{"type":"text","text":""},{"type":"text","text":"actual"}])),
            "actual",
        ),
    ] {
        assert_eq!(extract_text(&row), expected);
    }
}
#[test]
fn pure_l58_l63_l68_l73_l78_l98_actual_injection_and_mixed_prompt() {
    for text in [
        "<command-message>do something</command-message>",
        "<command-name>run</command-name>",
        "[Request interrupted by user for new message]",
        "  [Request interrupted by user]",
    ] {
        assert!(is_system_injection(&text_row(
            json!([{"type":"text","text":text}])
        )));
    }
    let system = text_row(
        json!([{"type":"text","text":"<system-reminder>runtime context</system-reminder>"}]),
    );
    let mixed = text_row(
        json!([{"type":"text","text":"<system-reminder>runtime context</system-reminder>"},{"type":"text","text":"implement the requested change"}]),
    );
    assert!(is_system_injection(&system));
    assert!(!is_system_injection(&mixed));
    assert_eq!(
        extract_text(&mixed),
        "<system-reminder>runtime context</system-reminder>\nimplement the requested change"
    );
    assert!(!is_system_injection(&text_row(
        json!([{"type":"text","text":"how do I build a multi-turn scenario?"}])
    )));
}
#[test]
fn pure_l105_turn_identity_selects_the_actual_prompt() {
    let system = json!({"type":"user","uuid":"system-row-id","message":{"content":[{"type":"text","text":"<system-reminder>runtime context</system-reminder>"}]}});
    let prompt = json!({"type":"user","uuid":"prompt-row-id","promptId":"real-prompt-id","message":{"content":[{"type":"text","text":"implement the requested change"}]}});
    assert_eq!(get_turn_id(&[&system, &prompt]), "real-prompt-id");
}
#[test]
fn pure_l123_l128_only_tool_result_content_matches() {
    assert!(is_tool_result(&text_row(
        json!([{"type":"tool_result","tool_use_id":"t1","content":"ok"}])
    )));
    assert!(!is_tool_result(&text_row(
        json!([{"type":"text","text":"hello"}])
    )));
}
#[test]
fn pure_l135_tool_results_and_injections_remain_in_the_same_turn() {
    assert_eq!(
        split_into_turns(&rows("pure_l135")),
        vec![vec![0, 1, 2, 3], vec![4, 5]]
    );
}
#[test]
fn pure_l152_real_processor_default_converter_keeps_final_stop_and_tool_history() {
    let events = events("pure_l152");
    let responses = events
        .iter()
        .filter(|e| e["event.name"] == "llm.response")
        .collect::<Vec<_>>();
    assert_eq!(
        responses
            .iter()
            .map(|e| e["gen_ai.response.finish_reasons"].clone())
            .collect::<Vec<_>>(),
        vec![json!(["tool_calls"]), json!(["stop"])]
    );
    assert_eq!(
        responses[1]["gen_ai.output.messages"][0]["finish_reason"],
        "stop"
    );
    let first = record(&events, "llm.request", "turn-1:s1");
    let second = record(&events, "llm.request", "turn-1:s2");
    assert!(first.get("gen_ai.input.messages").is_none());
    assert!(second.get("gen_ai.input.messages").is_none());
    assert_eq!(
        second["gen_ai.input.messages_delta"],
        json!([
            {"role":"assistant","parts":[{"type":"tool_call","id":"call-1","name":"Read","arguments":{"file_path":"a.txt"}}]},
            {"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":"file contents"}]}
        ])
    );
    let result = convert(&events);
    assert_eq!(result.warnings, Vec::<String>::new());
    let inputs = inputs(&result);
    assert_eq!(inputs.len(), 2);
    assert_eq!(
        inputs[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["user", "assistant", "tool"]
    );
    assert_eq!(
        inputs[1][1]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["tool_call"]
    );
    assert_eq!(
        inputs[1][2]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["tool_call_response"]
    );
    assert_eq!(inputs[1][1]["parts"][0]["id"], "call-1");
    assert_eq!(inputs[1][2]["parts"][0]["id"], "call-1");
}
#[test]
fn pure_l261_real_processor_default_converter_preserves_reasoning_and_parallel_results() {
    let events = events("pure_l261");
    let first = record(&events, "llm.response", "turn-1:s1");
    let second = record(&events, "llm.request", "turn-1:s2");
    assert_eq!(
        first["gen_ai.output.messages"],
        json!([{"role":"assistant","parts":[
        {"type":"reasoning","content":"I need both results."},
        {"type":"tool_call","id":"call-1","name":"Read","arguments":{"file_path":"a.txt"}},
        {"type":"tool_call","id":"call-2","name":"Read","arguments":{"file_path":"b.txt"}}
    ],"finish_reason":"tool_calls"}])
    );
    assert_eq!(
        second["gen_ai.input.messages_delta"],
        json!([
            {"role":"assistant","parts":first["gen_ai.output.messages"][0]["parts"]},
            {"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":"a contents"}]},
            {"role":"tool","parts":[{"type":"tool_call_response","id":"call-2","response":"b contents"}]}
        ])
    );
    assert!(second.get("gen_ai.input.messages").is_none());
    let result = convert(&events);
    assert_eq!(result.warnings, Vec::<String>::new());
    let inputs = inputs(&result);
    assert_eq!(inputs.len(), 2);
    assert_eq!(
        inputs[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["user", "assistant", "tool", "tool"]
    );
    assert_eq!(
        inputs[1][1]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["reasoning", "tool_call", "tool_call"]
    );
    assert_eq!(
        inputs[1].as_array().unwrap()[2..]
            .iter()
            .map(|m| m["parts"][0]["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["call-1", "call-2"]
    );
}
#[test]
fn pure_l398_real_processor_default_converter_excludes_unmatched_tool_from_next_history() {
    let events = events("pure_l398");
    let second = record(&events, "llm.request", "turn-1:s2");
    assert_eq!(
        second["gen_ai.input.messages_delta"],
        json!([
            {"role":"assistant","parts":[{"type":"reasoning","content":"I will inspect both files."},{"type":"text","content":"Reading both files."},{"type":"tool_call","id":"call-1","name":"Read","arguments":{"file_path":"a.txt"}}]},
            {"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":"a contents"}]}
        ])
    );
    let result = convert(&events);
    assert_eq!(
        result.warnings,
        vec!["Orphan tool.call (tool.call.id=call-2): no matching tool.result in step"]
    );
    let inputs = inputs(&result);
    assert_eq!(inputs.len(), 2);
    assert_eq!(
        inputs[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["user", "assistant", "tool"]
    );
    assert_eq!(
        inputs[1][1]["parts"],
        second["gen_ai.input.messages_delta"][0]["parts"]
    );
    assert_eq!(inputs[1][2]["parts"][0]["id"], "call-1");
}

fn fixture_value(section: &str, key: &str) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/qoder-work-hook-history-inputs.json"
    ))
    .unwrap();
    fixture[section][key].clone()
}
fn base_rows(content: Value) -> Vec<Value> {
    vec![
        json!({"type":"user","uuid":"user-1","timestamp":"2026-06-18T01:35:54.477Z","message":{"role":"user","content":content},"sessionId":"sess-1","userType":"external","isSidechain":false}),
        json!({"type":"assistant","uuid":"assistant-1","parentUuid":"user-1","timestamp":"2026-06-18T01:35:56.477Z","message":{"role":"assistant","id":"msg-1","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"},"sessionId":"sess-1","isSidechain":false}),
    ]
}
struct NativeFixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
}
impl NativeFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let file = root.join("transcript.jsonl");
        Self {
            _dir: dir,
            root,
            file,
        }
    }
    fn run(&self, session: &str, rows: &[Value]) -> Vec<Value> {
        let mut body = Vec::new();
        for row in rows {
            serde_json::to_writer(&mut body, row).unwrap();
            body.push(b'\n');
        }
        fs::write(&self.file, body).unwrap();
        let mut env = Env::new();
        for key in ["HOME", "USERPROFILE", "LOONGSUITE_PILOT_DATA_DIR"] {
            env.insert(key.into(), self.root.to_string_lossy().into_owned());
        }
        let args = vec![
            "--agent-id".into(),
            "qoder-work-test".into(),
            "--log-prefix".into(),
            "qoder-work".into(),
        ];
        let stdin = serde_json::to_vec(
            &json!({"session_id":session,"transcript_path":self.file,"cwd":"/tmp/qoderwork-test"}),
        )
        .unwrap();
        let mut stdout = Vec::new();
        let mut request = HookRequest {
            args: &args,
            stdin: &stdin,
            env: &env,
            stdout: &mut stdout,
        };
        assert_eq!(run(&mut request), 0);
        assert_eq!(stdout, b"{}\n");
        let dir = self.root.join("logs/qoder-work-test/history");
        if !dir.exists() {
            return Vec::new();
        }
        let mut files = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
            .collect::<Vec<_>>();
        files.sort();
        files
            .into_iter()
            .flat_map(|p| {
                fs::read_to_string(p)
                    .unwrap()
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| serde_json::from_str(l).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect()
    }
}
fn prompt_contents(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|e| e["event.name"] == "llm.request")
        .flat_map(|e| {
            e.get("gen_ai.input.messages")
                .or_else(|| e.get("gen_ai.input.messages_delta"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .flat_map(|m| m["parts"].as_array().unwrap())
        .filter(|p| p["type"] == "text")
        .map(|p| p["content"].clone())
        .collect()
}
#[test]
fn hook_l180_actual_native_history_keeps_runtime_version_agent_scoped() {
    let f = NativeFixture::new();
    let mut rows = base_rows(fixture_value("promptContent", "hook_l180"));
    for row in &mut rows {
        row["version"] = json!("1.1.26");
    }
    let events = f.run("sess-no-runtime-version", &rows);
    assert!(!events.is_empty());
    assert!(events
        .iter()
        .all(|e| e.get("version").is_none() && e["agent.qoderwork.version"] == "1.1.26"));
}
#[test]
fn hook_l195_actual_native_history_and_default_converter_accumulate_exact_step_deltas() {
    let f = NativeFixture::new();
    let events = f.run("sess-step-deltas", &rows("hook_l195"));
    let requests = events
        .iter()
        .filter(|e| e["event.name"] == "llm.request")
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|e| e.get("gen_ai.input.messages").is_none()));
    let prompt = json!([{"role":"user","parts":[{"type":"text","content":"solve it"}]}]);
    let history = json!([
        {"role":"assistant","parts":[{"type":"tool_call","id":"tool-1","name":"shell","arguments":{"command":"pwd"}}]},
        {"role":"tool","parts":[{"type":"tool_call_response","id":"tool-1","response":"/tmp/project"}]}
    ]);
    assert_eq!(requests[0]["gen_ai.input.messages_delta"], prompt);
    assert_eq!(requests[1]["gen_ai.input.messages_delta"], history);
    let result = convert(&events);
    let inputs = inputs(&result);
    let full = prompt
        .as_array()
        .unwrap()
        .iter()
        .chain(history.as_array().unwrap())
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(inputs, vec![prompt, json!(full)]);
}
#[test]
fn hook_l300_actual_native_history_preserves_prompt_turn_step_and_scoped_ids() {
    let f = NativeFixture::new();
    let mut rows = base_rows(fixture_value("promptContent", "hook_l300"));
    rows[0]["promptId"] = json!("prompt-turn-565");
    let events = f.run("sess-prompt-id", &rows);
    assert!(!events.is_empty());
    assert!(events
        .iter()
        .all(|e| e["gen_ai.turn.id"] == "prompt-turn-565"
            && e["agent.qoderwork.promptId"] == "prompt-turn-565"));
    let steps = events
        .iter()
        .filter_map(|e| e.get("gen_ai.step.id"))
        .collect::<Vec<_>>();
    assert!(!steps.is_empty());
    assert!(steps.iter().all(|id| **id == json!("prompt-turn-565:s1")));
}
#[test]
fn hook_l317_l333_l346_l359_l372_actual_native_history_preserves_original_prompt_boundaries() {
    for key in [
        "hook_l317",
        "hook_l333",
        "hook_l346",
        "hook_l359",
        "hook_l372",
    ] {
        let f = NativeFixture::new();
        let events = f.run(key, &base_rows(fixture_value("promptContent", key)));
        let expected = fixture_value("promptExpected", key);
        assert_eq!(json!(prompt_contents(&events)), expected, "{key}");
    }
}
#[test]
fn hook_l385_l399_actual_native_history_uses_message_id_then_parent_uuid() {
    for (key, present, expected) in [
        ("hook_l385", true, "chatcmpl-resp-1"),
        ("hook_l399", false, "user-1"),
    ] {
        let f = NativeFixture::new();
        let mut rows = base_rows(fixture_value("promptContent", key));
        if present {
            rows[1]["message"]["id"] = json!(expected);
        } else {
            rows[1]["message"].as_object_mut().unwrap().remove("id");
        }
        let events = f.run(key, &rows);
        let response = events
            .iter()
            .find(|e| e["event.name"] == "llm.response")
            .unwrap();
        assert_eq!(response["gen_ai.response.id"], expected);
    }
}
