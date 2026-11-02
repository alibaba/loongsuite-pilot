use super::*;
use crate::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
use crate::normalization::{
    apply_invocation_identity, INVOCATION_SESSION_ID_FIELD, INVOCATION_USER_ID_FIELD,
    VALID_FINISH_REASONS,
};
use serde_json::json;
#[test]
fn finish_l11_all_vendor_spellings_map_to_exact_otel_values() {
    for (input, expected) in [
        ("tool_use", "tool_call"),
        ("stop_sequence", "stop"),
        ("refusal", "stop"),
        ("model_context_window_exceeded", "length"),
    ] {
        assert_eq!(normalize_finish_reason(input), Some(expected));
    }
}
#[test]
fn finish_l18_original_canonical_spellings_pass_through() {
    for reason in [
        "stop",
        "end_turn",
        "max_tokens",
        "tool_call",
        "cancelled",
        "error",
    ] {
        assert_eq!(normalize_finish_reason(reason), Some(reason));
    }
}
#[test]
fn finish_l24_unknown_future_or_empty_reasons_are_dropped() {
    for reason in ["pause_turn", "some_future_reason", ""] {
        assert_eq!(normalize_finish_reason(reason), None);
    }
}
#[test]
fn finish_l33_vendor_normalization_never_emits_a_value_outside_validator_contract() {
    for reason in [
        "tool_use",
        "stop_sequence",
        "refusal",
        "model_context_window_exceeded",
        "pause_turn",
        "end_turn",
        "max_tokens",
        "stop",
        "cancelled",
        "error",
        "unexpected",
    ] {
        if let Some(normalized) = normalize_finish_reason(reason) {
            assert!(VALID_FINISH_REASONS.contains(&normalized), "{reason}");
        }
    }
}
#[test]
fn finish_l47_hook_accepts_every_value_of_shared_producer_validator_enum() {
    for reason in VALID_FINISH_REASONS {
        assert_eq!(normalize_finish_reason(reason), Some(*reason));
    }
}
fn progress(second: &str, event: &str) -> Value {
    json!({"type":"progress","timestamp":format!("2026-07-20T10:00:{second}.000Z"),"data":{"hookEvent":event,"hookName":"loongsuite-pilot"}})
}
fn rows(cli: bool) -> Vec<Value> {
    let mut user = json!({"type":"user","uuid":"user-1","timestamp":"2026-07-20T10:00:01.000Z","sessionId":"session-ide","message":{"role":"user","content":"list the files"}});
    if cli {
        user["entrypoint"] = json!("cli");
    }
    vec![
        progress("00", "UserPromptSubmit"),
        user,
        json!({"type":"assistant","uuid":"assistant-1","timestamp":"2026-07-20T10:00:02.000Z","sessionId":"session-ide","message":{"role":"assistant","id":"message-1","model":"qwen-max","content":[{"type":"tool_use","id":"call-1","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use"}}),
        progress("03", "PreToolUse"),
        progress("04", "PostToolUse"),
        json!({"type":"user","uuid":"user-2","timestamp":"2026-07-20T10:00:05.000Z","sessionId":"session-ide","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"a.txt"}]}}),
        json!({"type":"assistant","uuid":"assistant-2","timestamp":"2026-07-20T10:00:06.000Z","sessionId":"session-ide","message":{"role":"assistant","id":"message-2","model":"qwen-max","content":[{"type":"text","text":"there is a.txt"}],"stop_reason":"end_turn"}}),
        progress("07", "Stop"),
        json!({"type":"last-prompt","sessionId":"session-ide","lastPrompt":"list the files"}),
    ]
}
fn invoke(agent: &str, cli: bool, extra: &[(&str, &str)]) -> Vec<Value> {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let file = root.join("transcript.jsonl");
    tests::write_transcript(&file, &rows(cli));
    let (code, stdout) = tests::invoke(
        &root,
        &["--agent-id", agent, "--log-prefix", agent],
        &json!({"session_id":"session-ide","transcript_path":file,"cwd":"/tmp/qoder-project"})
            .to_string(),
        extra,
    );
    assert_eq!(code, 0);
    assert_eq!(stdout, "{}\n");
    let records = tests::read_history(&root, agent);
    assert!(!records.is_empty());
    records
}
fn boundaries(records: &[Value]) {
    let starts = records
        .iter()
        .enumerate()
        .filter(|(_, r)| r["gen_ai.turn.start"] == true)
        .collect::<Vec<_>>();
    let ends = records
        .iter()
        .enumerate()
        .filter(|(_, r)| r["gen_ai.turn.end"] == true)
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 1);
    assert_eq!(ends.len(), 1);
    assert_eq!(starts[0].0, 0);
    assert_eq!(ends[0].0, records.len() - 1);
    assert_eq!(starts[0].1["event.name"], "other");
    assert_eq!(ends[0].1["event.name"], "llm.response");
    assert_eq!(starts[0].1["gen_ai.turn.id"], ends[0].1["gen_ai.turn.id"]);
    for record in &records[1..records.len() - 1] {
        assert!(record.get("gen_ai.turn.start").is_none());
        assert!(record.get("gen_ai.turn.end").is_none());
    }
}
fn entries(records: &[Value]) -> Vec<crate::types::AgentActivityEntry> {
    records
        .iter()
        .map(|r| serde_json::from_value(r.clone()).unwrap())
        .collect()
}
fn parsed(value: &Value) -> Value {
    match value {
        Value::String(s) => serde_json::from_str(s).unwrap(),
        v => v.clone(),
    }
}
#[test]
fn boundary_l120_unflagged_native_hook_keeps_markers_tool_history_and_real_genai_conversion() {
    let records = invoke("qoder", false, &[]);
    assert!(records.iter().all(|r| r["gen_ai.agent.type"] == "qoder"));
    boundaries(&records);
    assert_eq!(
        records[0]["gen_ai.input.messages_delta"][0]["parts"][0]["content"],
        "list the files"
    );
    assert_eq!(
        records.last().unwrap()["gen_ai.response.finish_reasons"],
        json!(["end_turn"])
    );
    let requests = records
        .iter()
        .filter(|r| r["event.name"] == "llm.request")
        .collect::<Vec<_>>();
    assert_eq!(
        requests[1]["gen_ai.input.messages_delta"],
        json!([{"role":"assistant","parts":[{"type":"tool_call","id":"call-1","name":"Bash","arguments":{"command":"ls"}}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":"a.txt"}]}])
    );
    let converted = GenAiEventLogConverter
        .convert(&entries(&records), &ConvertOptions::default())
        .unwrap();
    let mut llms = converted
        .spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
        .collect::<Vec<_>>();
    llms.sort_by_key(|s| s.start_time);
    assert_eq!(llms.len(), 2);
    let input = parsed(&llms[1].attributes["gen_ai.input.messages"]);
    assert_eq!(
        input
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["user", "assistant", "tool"]
    );
    assert_eq!(input[1]["parts"][0]["type"], "tool_call");
    assert_eq!(input[1]["parts"][0]["id"], "call-1");
    assert_eq!(input[2]["parts"][0]["type"], "tool_call_response");
    assert_eq!(input[2]["parts"][0]["id"], "call-1");
}
#[test]
fn boundary_l187_cn_invocation_identity_reaches_every_native_genai_span_and_internal_keys_are_consumed(
) {
    let records = invoke(
        "qoder-cn",
        false,
        &[(
            "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
            "gen_ai.session.id=env-session,gen_ai.user.id=env-user",
        )],
    );
    assert!(records.iter().all(|r| r["gen_ai.agent.type"] == "qoder-cn"));
    assert!(records
        .iter()
        .all(|r| r[INVOCATION_SESSION_ID_FIELD] == "env-session"
            && r[INVOCATION_USER_ID_FIELD] == "env-user"));
    boundaries(&records);
    let mut entries = entries(&records);
    for entry in &mut entries {
        apply_invocation_identity(entry, "configured-user", "fallback-user");
        assert_eq!(entry.session_id, "env-session");
        assert_eq!(entry.user_id, "env-user");
        assert!(entry.extra.get(INVOCATION_SESSION_ID_FIELD).is_none());
        assert!(entry.extra.get(INVOCATION_USER_ID_FIELD).is_none());
    }
    let converted = GenAiEventLogConverter
        .convert(&entries, &ConvertOptions::default())
        .unwrap();
    assert!(!converted.spans.is_empty());
    assert!(converted
        .spans
        .iter()
        .all(
            |s| s.attributes.get("gen_ai.session.id") == Some(&json!("env-session"))
                && s.attributes.get("gen_ai.user.id") == Some(&json!("env-user"))
        ));
}
#[test]
fn boundary_l238_cli_native_compatibility_turns_have_no_ide_boundary_markers() {
    let records = invoke("qoder", true, &[]);
    assert!(records
        .iter()
        .all(|r| r["gen_ai.agent.type"] == "qoder-cli"));
    assert!(records
        .iter()
        .all(|r| r.get("gen_ai.turn.start").is_none() && r.get("gen_ai.turn.end").is_none()));
}
