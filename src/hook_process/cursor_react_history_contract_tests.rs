//! Exact frozen Cursor react assertions; fixtures contain statically extracted literals only.
use super::*;
use crate::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
use crate::types::AgentActivityEntry;
struct Case {
    _root: tempfile::TempDir,
    fixture: Value,
    rows: Vec<Value>,
}
fn replace_root(value: &mut Value, root: &str) {
    match value {
        Value::String(text) => *text = text.replace("__TRANSCRIPT_ROOT__", root),
        Value::Array(items) => items.iter_mut().for_each(|v| replace_root(v, root)),
        Value::Object(items) => items.values_mut().for_each(|v| replace_root(v, root)),
        _ => {}
    }
}
fn run(line: u32) -> Case {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/cursor-react-history-literal-inputs.json"
    ))
    .unwrap();
    let mut fixture = fixtures
        .into_iter()
        .find(|f| f["id"].as_str().unwrap().starts_with(&format!("L{line}:")))
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    replace_root(&mut fixture, root.path().to_str().unwrap());
    for file in fixture["files"].as_array().unwrap() {
        let path = Path::new(file["path"].as_str().unwrap());
        assert!(path.starts_with(root.path()));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, file["content"].as_str().unwrap()).unwrap();
    }
    let options = &fixture["options"];
    let (rows, _) = assemble_parent_turn(
        fixture["events"].as_array().unwrap(),
        TurnOptions {
            user_id: "history-fixture-user",
            variant: options["variant"].as_str().unwrap_or("cursor"),
            stop_conversation_id: options["stopConversationId"].as_str().unwrap(),
            transcript_path: options["transcriptPath"].as_str(),
            windows: cfg!(windows),
        },
    );
    Case {
        _root: root,
        fixture,
        rows: rows.into_iter().map(Value::Object).collect(),
    }
}
impl Case {
    fn expected(&self, target: &str) -> Value {
        self.fixture["expected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["target"] == format!("expect({target})"))
            .unwrap()["args"][0]
            .clone()
    }
    fn events(&self, event: &str) -> Vec<&Value> {
        self.rows
            .iter()
            .filter(|r| r["event.name"] == event)
            .collect()
    }
    fn event(&self, event: &str, suffix: &str) -> &Value {
        let prompt = self.fixture["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| {
                row["hook_event"] == "beforeSubmitPrompt"
                    && row["conversation_id"] == self.fixture["options"]["stopConversationId"]
            })
            .unwrap();
        let turn = prompt["generation_id"]
            .as_str()
            .unwrap_or_else(|| prompt["conversation_id"].as_str().unwrap());
        let step = format!("{turn}{suffix}");
        self.rows
            .iter()
            .find(|row| row["event.name"] == event && row["gen_ai.step.id"] == step)
            .unwrap()
    }
    fn matched(&self, actual: &Value, target: &str) {
        subset(actual, &self.expected(target));
    }
}
fn subset(actual: &Value, expected: &Value) {
    match expected {
        Value::Object(object) => {
            for (key, value) in object {
                assert!(
                    actual.get(key).is_some(),
                    "missing original field {key}: {actual}"
                );
                subset(&actual[key], value);
            }
        }
        Value::Array(items) => {
            let actual = actual.as_array().expect("original array expected");
            assert_eq!(actual.len(), items.len());
            for (a, e) in actual.iter().zip(items) {
                subset(a, e);
            }
        }
        _ => assert_eq!(actual, expected),
    }
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn roles(value: &Value) -> Value {
    json!(array(value)
        .iter()
        .map(|m| m["role"].clone())
        .collect::<Vec<_>>())
}
fn parts_of_kind(value: &Value, kind: &str) -> Vec<Value> {
    array(value)
        .iter()
        .flat_map(|m| array(&m["parts"]))
        .filter(|p| p["type"] == kind)
        .cloned()
        .collect()
}
fn reasoning(record: &Value) -> Value {
    json!(
        parts_of_kind(&record["gen_ai.output.messages"], "reasoning")
            .iter()
            .map(|p| p["content"].clone())
            .collect::<Vec<_>>()
    )
}
fn check_exchange(case: &Case, step: &str, id: &str, name: &str, response: &str, prompt: &str) {
    let request = case.event("llm.request", step);
    let delta = &request["gen_ai.input.messages_delta"];
    assert_eq!(array(delta).len(), 2);
    assert_eq!(roles(delta), json!(["assistant", "tool"]));
    let calls = parts_of_kind(delta, "tool_call");
    assert_eq!(calls.len(), 1);
    subset(&calls[0], &json!({"type":"tool_call","id":id,"name":name}));
    assert_eq!(array(&delta[1]["parts"]).len(), 1);
    subset(
        &delta[1]["parts"][0],
        &json!({"type":"tool_call_response","id":id,"response":response}),
    );
    let full = &request["gen_ai.input.messages"];
    assert_eq!(array(full).len(), 3);
    subset(
        &full[0],
        &json!({"role":"user","parts":[{"type":"text","content":prompt}]}),
    );
    assert_eq!(full[1]["role"], "assistant");
    assert_eq!(full[2]["role"], "tool");
}
#[test]
fn cursor_react_l17_cli_workspace_roots_reach_every_parent_record() {
    let c = run(17);
    assert!(!c.rows.is_empty());
    assert!(c
        .rows
        .iter()
        .all(|r| r["gen_ai.agent.type"] == "cursor-cli"));
    assert!(c
        .rows
        .iter()
        .all(|r| r["agent.cursor-cli.cwd"] == "C:\\Users\\alice\\project"));
}
#[test]
fn cursor_react_l49_hook_capture_and_duration_produce_exact_original_timestamps_and_provenance() {
    let c = run(49);
    c.matched(c.event("llm.request", ":s1"), "firstStepRequest");
    c.matched(c.event("llm.response", ":s1"), "firstStepResponse");
    for (event, id, label) in [
        ("tool.call", "call-read", "readCall"),
        ("tool.result", "call-read", "readResult"),
        ("tool.call", "call-grep", "grepCall"),
        ("tool.result", "call-grep", "grepResult"),
    ] {
        let r = c
            .rows
            .iter()
            .find(|r| r["event.name"] == event && r["gen_ai.tool.call.id"] == id)
            .unwrap();
        c.matched(r, label);
    }
}
#[test]
fn cursor_react_l195_exact_base_suffixed_thought_pairs_deduplicate_without_window() {
    let c = run(195);
    assert_eq!(c.events("llm.request").len(), 2);
    let responses = c.events("llm.response");
    let parts = parts_of_kind(
        &responses.last().unwrap()["gen_ai.output.messages"],
        "reasoning",
    );
    assert_eq!(json!(parts), c.expected("reasoningParts"));
}
#[test]
fn cursor_react_l283_identical_unsuffixed_thoughts_are_not_deduplicated() {
    let c = run(283);
    let response = c.events("llm.response");
    assert_eq!(
        parts_of_kind(&response[0]["gen_ai.output.messages"], "reasoning").len(),
        2
    );
}
#[test]
fn cursor_react_l327_synchronous_tool_keeps_original_reasoning_in_current_step() {
    let c = run(327);
    assert_eq!(c.events("llm.request").len(), 2);
    assert_eq!(
        reasoning(c.event("llm.response", ":s1")),
        c.expected("firstReasoning")
    );
    assert_eq!(
        roles(&c.event("llm.request", ":s2")["gen_ai.input.messages_delta"]),
        json!(["assistant", "tool"])
    );
    assert!(
        c.event("llm.request", ":s2")["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<i128>()
            .unwrap()
            >= 1_780_912_800_500_000_000
    );
}
#[test]
fn cursor_react_l423_missing_synchronous_completion_recovers_without_fabricated_tool_history() {
    let c = run(423);
    assert_eq!(c.events("llm.request").len(), 3);
    assert_eq!(c.events("llm.response").len(), 3);
    assert!(c
        .event("llm.request", ":s2")
        .get("gen_ai.input.messages_delta")
        .is_none());
    let delta = &c.event("llm.request", ":s3")["gen_ai.input.messages_delta"];
    assert_eq!(roles(delta), json!(["assistant", "tool"]));
    let calls = parts_of_kind(delta, "tool_call");
    subset(
        &calls[0],
        &json!({"type":"tool_call","id":"call-normal-shell","name":"Shell"}),
    );
    assert_eq!(
        delta[1]["parts"],
        json!([{"type":"tool_call_response","id":"call-normal-shell","response":"ok"}])
    );
}
#[test]
fn cursor_react_l533_failure_drains_active_sync_tool_and_preserves_error_response() {
    let c = run(533);
    assert_eq!(c.events("llm.request").len(), 2);
    let delta = &c.event("llm.request", ":s2")["gen_ai.input.messages_delta"];
    assert_eq!(roles(delta), json!(["assistant", "tool"]));
    subset(
        &parts_of_kind(delta, "tool_call")[0],
        &json!({"type":"tool_call","id":"call-failing-read"}),
    );
    assert_eq!(
        delta[1]["parts"],
        json!([{"type":"tool_call_response","id":"call-failing-read","response":"File not found"}])
    );
}
#[test]
fn cursor_react_l614_completion_without_id_uses_tool_name_and_opens_the_next_step() {
    let c = run(614);
    assert_eq!(c.events("llm.request").len(), 2);
}
#[test]
fn cursor_react_l672_tool_pairing_keeps_nonempty_and_missing_identifiers_separate() {
    let c = run(672);
    let response = c.event("llm.request", ":s2");
    let parts = array(&response["gen_ai.input.messages_delta"])
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["parts"][0].clone())
        .collect::<Vec<_>>();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0].get("id"), Some(&json!("call-grep")));
    assert!(parts[1].get("id").is_none());
    assert!(parts[2].get("id").is_none());
    assert_eq!(
        json!(parts
            .iter()
            .map(|p| p.get("id").cloned().unwrap_or(Value::Null))
            .collect::<Vec<_>>()),
        json!(["call-grep", null, null])
    );
    assert_eq!(
        json!(parts
            .iter()
            .map(|p| p["response"].clone())
            .collect::<Vec<_>>()),
        json!(["grep with id", "read without id", "shell without id"])
    );
}
#[test]
fn cursor_react_l704_request_starts_before_earliest_buffered_tool_and_keeps_provenance() {
    let c = run(704);
    c.matched(c.event("llm.request", ":s1"), "firstStepRequest");
    c.matched(c.event("llm.response", ":s1"), "firstStepResponse");
}
#[test]
fn cursor_react_l772_terminal_tool_step_uses_stop_on_response_and_output_message() {
    let c = run(772);
    let responses = c.events("llm.response");
    let last = responses.last().unwrap();
    assert_eq!(last["gen_ai.response.finish_reasons"], json!(["stop"]));
    assert_eq!(last["gen_ai.output.messages"][0]["finish_reason"], "stop");
}
#[test]
fn cursor_react_l828_synthesized_child_result_wins_once_and_preserves_complete_history() {
    let c = run(828);
    let result = c
        .rows
        .iter()
        .filter(|r| {
            r["event.name"] == "tool.result"
                && r["gen_ai.tool.call.id"] == "call-subagent"
                && r["gen_ai.agent.scope"] != "subagent"
        })
        .collect::<Vec<_>>();
    assert_eq!(result.len(), 1);
    c.matched(result[0], "parentSubagentResults[0]");
    check_exchange(
        &c,
        ":s2",
        "call-subagent",
        "Subagent",
        "child final result",
        "delegate this",
    );
}
#[test]
fn cursor_react_l954_child_end_time_gates_consumption_and_clamps_next_request() {
    let c = run(954);
    let parent = c
        .events("llm.request")
        .into_iter()
        .filter(|r| r.get("gen_ai.agent.scope").is_none())
        .collect::<Vec<_>>();
    assert_eq!(parent.len(), 2);
    assert_eq!(
        reasoning(c.event("llm.response", ":s1")),
        c.expected("firstReasoning")
    );
    c.matched(c.event("llm.request", ":s2"), "secondRequest");
    let delta = &c.event("llm.request", ":s2")["gen_ai.input.messages_delta"];
    assert_eq!(roles(delta), json!(["assistant", "tool"]));
    subset(
        &delta[1]["parts"][0],
        &json!({"type":"tool_call_response","id":"call-subagent-causality","response":"child final result"}),
    );
}
#[test]
fn cursor_react_l1085_parallel_task_calls_share_step_and_keep_one_assistant_then_two_results() {
    let c = run(1085);
    let parent = c
        .events("llm.request")
        .into_iter()
        .filter(|r| r.get("gen_ai.agent.scope").is_none())
        .collect::<Vec<_>>();
    assert_eq!(parent.len(), 3);
    assert_eq!(
        c.rows
            .iter()
            .filter(|r| r["event.name"] == "tool.call"
                && r["gen_ai.step.id"] == "turn-parallel:s1"
                && r["gen_ai.tool.name"] == "Task")
            .count(),
        2
    );
    let delta = &c.event("llm.request", ":s2")["gen_ai.input.messages_delta"];
    assert_eq!(roles(delta), json!(["assistant", "tool", "tool"]));
    assert_eq!(parts_of_kind(delta, "tool_call").len(), 2);
    assert!(array(delta)
        .iter()
        .skip(1)
        .all(|m| array(&m["parts"]).len() == 1));
    assert!(
        c.event("llm.request", ":s2")["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<i128>()
            .unwrap()
            >= 1_780_912_800_600_000_000
    );
}

#[test]
fn cursor_react_l1275_no_child_result_falls_back_to_cursor_completion_with_full_history() {
    let c = run(1275);
    let result = c
        .rows
        .iter()
        .filter(|r| {
            r["event.name"] == "tool.result" && r["gen_ai.tool.call.id"] == "call-subagent-fallback"
        })
        .collect::<Vec<_>>();
    assert_eq!(result.len(), 1);
    c.matched(result[0], "parentSubagentResults[0]");
    check_exchange(
        &c,
        ":s2",
        "call-subagent-fallback",
        "Subagent",
        "cursor fallback result",
        "delegate without child transcript",
    );
}
#[test]
fn cursor_react_l1483_existing_legacy_skipped_composer_split_has_exact_latest_tool_end_start() {
    let c = run(1483);
    let first = c.event("llm.request", ":s1")["time_unix_nano"]
        .as_str()
        .unwrap()
        .parse::<i128>()
        .unwrap();
    let second = c.event("llm.request", ":s2")["time_unix_nano"]
        .as_str()
        .unwrap()
        .parse::<i128>()
        .unwrap();
    assert!(first <= 1_780_912_800_100_000_000);
    assert!(second >= 1_780_912_800_450_000_000);
    assert_eq!(
        c.event("llm.response", ":s2")["time_unix_nano"],
        c.expected("s2Response?.time_unix_nano")
    );
}

#[test]
fn cursor_react_l1582_raw_and_real_native_llm_inputs_keep_call_then_result_and_independent_history()
{
    let mut c = run(1582);
    assert_eq!(c.events("llm.request").len(), 2);
    let s1 = c.event("llm.request", ":s1");
    let s2 = c.event("llm.request", ":s2");
    let first = json!([{"role":"user","parts":[{"type":"text","content":"list files"}]}]);
    assert_eq!(s1["gen_ai.input.messages_delta"], first);
    assert_eq!(s1["gen_ai.input.messages"], first);
    let delta = &s2["gen_ai.input.messages_delta"];
    assert_eq!(roles(delta), json!(["assistant", "tool"]));
    subset(
        &parts_of_kind(delta, "tool_call")[0],
        &json!({"type":"tool_call","id":"call-1","name":"ls","arguments":{"path":"."}}),
    );
    subset(
        &delta[1]["parts"][0],
        &json!({"type":"tool_call_response","id":"call-1","response":"a.txt b.txt"}),
    );
    let full = &s2["gen_ai.input.messages"];
    assert_eq!(roles(full), json!(["user", "assistant", "tool"]));
    subset(&full[0], &first[0]);
    subset(
        &full[2]["parts"][0],
        &json!({"type":"tool_call_response","id":"call-1","response":"a.txt b.txt"}),
    );
    let entries = c
        .rows
        .iter()
        .map(|r| serde_json::from_value::<AgentActivityEntry>(r.clone()).unwrap())
        .collect::<Vec<_>>();
    let converted = GenAiEventLogConverter
        .convert(&entries, &ConvertOptions::default())
        .unwrap();
    assert!(converted.warnings.is_empty());
    let span = converted
        .spans
        .iter()
        .filter(|s| s.attributes["gen_ai.span.kind"] == "LLM")
        .nth(1)
        .unwrap();
    let raw = &span.attributes["gen_ai.input.messages"];
    let input = if let Some(raw) = raw.as_str() {
        serde_json::from_str::<Value>(raw).unwrap()
    } else {
        raw.clone()
    };
    assert_eq!(roles(&input), json!(["user", "assistant", "tool"]));
    subset(
        &parts_of_kind(&input, "tool_call")[0],
        &json!({"type":"tool_call","id":"call-1"}),
    );
    subset(
        &input[2]["parts"][0],
        &json!({"type":"tool_call_response","id":"call-1"}),
    );
    c.rows
        .iter_mut()
        .filter(|r| r["event.name"] == "llm.request")
        .nth(1)
        .unwrap()["gen_ai.input.messages"][0]["role"] = json!("mutated");
    assert_eq!(
        c.event("llm.request", ":s1")["gen_ai.input.messages"],
        first
    );
}
#[test]
fn cursor_react_l1714_final_response_without_thought_opens_second_step_and_retains_both_tools() {
    let c = run(1714);
    let s1 = c.event("llm.request", ":s1");
    let s2 = c.event("llm.request", ":s2");
    let r1 = c.event("llm.response", ":s1");
    let r2 = c.event("llm.response", ":s2");
    let first = json!([{"role":"user","parts":[{"type":"text","content":"solve leetcode 1"}]}]);
    assert_eq!(s1["gen_ai.input.messages_delta"], first);
    assert_eq!(s1["gen_ai.input.messages"], first);
    let tools = parts_of_kind(&r1["gen_ai.output.messages"], "tool_call");
    assert_eq!(tools.len(), 2);
    subset(
        &tools[0],
        &json!({"type":"tool_call","id":"tool-aaa","name":"Read"}),
    );
    subset(
        &tools[1],
        &json!({"type":"tool_call","id":"tool-bbb","name":"Write"}),
    );
    for kind in ["tool.call", "tool.result"] {
        assert_eq!(
            c.rows
                .iter()
                .filter(|r| r["event.name"] == kind && r["gen_ai.step.id"] == "turn-fast:s1")
                .count(),
            2
        );
    }
    let delta = &s2["gen_ai.input.messages_delta"];
    assert_eq!(roles(delta), json!(["assistant", "tool", "tool"]));
    assert_eq!(
        json!(parts_of_kind(delta, "tool_call")
            .iter()
            .map(|p| p["id"].clone())
            .collect::<Vec<_>>()),
        json!(["tool-aaa", "tool-bbb"])
    );
    assert_eq!(
        json!(array(delta)
            .iter()
            .skip(1)
            .map(|p| p["parts"][0]["id"].clone())
            .collect::<Vec<_>>()),
        json!(["tool-aaa", "tool-bbb"])
    );
    assert_eq!(
        roles(&s2["gen_ai.input.messages"]),
        json!(["user", "assistant", "tool", "tool"])
    );
    subset(
        &r2["gen_ai.output.messages"][0]["parts"][0],
        &json!({"type":"text","content":"Done, both files updated."}),
    );
    assert!(parts_of_kind(&r2["gen_ai.output.messages"], "tool_call").is_empty());
}
