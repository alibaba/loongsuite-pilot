//! Exact current-main interaction contracts through the real production parser.
//! Fixtures are synthetic protocol samples from pinned main, not personal data.
use super::*;
use crate::normalization::entry_to_object;
use std::collections::HashSet;

fn fixture(name: &str) -> Value {
    match name {
        "tools" => serde_json::from_str(include_str!(
            "../../../tests/fixtures/copilot/tool-conversation.json"
        ))
        .unwrap(),
        "second" | "cancelled" => {
            let variants: Value = serde_json::from_str(include_str!(
                "../../../tests/fixtures/copilot/main-interaction-variants.json"
            ))
            .unwrap();
            variants[name].clone()
        }
        _ => serde_json::from_str(include_str!(
            "../../../tests/fixtures/copilot/conversation.json"
        ))
        .unwrap(),
    }
}
fn parse(f: &Value, native: bool) -> Vec<Vec<Value>> {
    parse_interactions(
        f["events"].as_array().unwrap(),
        f["spans"].as_array().unwrap(),
        native,
    )
    .iter()
    .map(|b| {
        b.records
            .iter()
            .map(|r| Value::Object(entry_to_object(r)))
            .collect()
    })
    .collect()
}
fn named<'a>(records: &'a [Value], name: &str) -> Vec<&'a Value> {
    records.iter().filter(|r| r["event.name"] == name).collect()
}
fn two(mut second: Value) -> Value {
    let mut a = fixture("conversation");
    a["events"]
        .as_array_mut()
        .unwrap()
        .extend(second["events"].as_array_mut().unwrap().drain(1..));
    a["spans"]
        .as_array_mut()
        .unwrap()
        .append(second["spans"].as_array_mut().unwrap());
    a
}

#[test]
fn main_l5_new_fragments_are_request_only_and_keep_the_tool_response() {
    let batches = parse(&fixture("tools"), true);
    let records = &batches[0];
    let requests = named(records, "llm.request");
    assert_eq!(requests.len(), 2);
    let roles = |r: &Value| {
        r["gen_ai.input.messages_delta"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(roles(requests[0]), ["user"]);
    assert_eq!(roles(requests[1]), ["assistant", "tool"]);
    assert_eq!(
        requests[1]["gen_ai.input.messages_delta"][1]["parts"][0]["response"],
        json!({"content":"sample file contents"})
    );
    for r in records.iter().filter(|r| {
        r["event.name"]
            .as_str()
            .is_some_and(|n| n.starts_with("llm."))
    }) {
        assert!(r.get("gen_ai.input.messages").is_none());
        if r["event.name"] == "llm.response" {
            assert!(r.get("gen_ai.input.messages_delta").is_none());
        }
    }
}

#[test]
fn main_l18_later_interaction_request_never_repeats_earlier_input() {
    let mut second = fixture("second");
    second["events"][1]["data"]["content"] = json!("Next prompt.");
    let batches = parse(&two(second), true);
    assert_eq!(batches.len(), 2);
    let request = named(&batches[1], "llm.request")[0];
    assert_eq!(
        request["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"Next prompt."}]}])
    );
}

#[test]
fn main_l24_repeated_turn_zero_uses_separate_traces_and_exact_native_usage() {
    let batches = parse(&two(fixture("second")), true);
    assert_eq!(batches.len(), 2);
    let traces: HashSet<_> = batches
        .iter()
        .map(|b| b[0]["trace_id"].as_str().unwrap())
        .collect();
    assert_eq!(traces.len(), 2);
    for b in batches {
        let llm = named(&b, "llm.response")[0];
        assert_eq!(llm["gen_ai.usage.input_tokens"], 100);
        assert_eq!(llm["gen_ai.usage.total_tokens"], 110);
        assert_eq!(llm["gen_ai.session.id"], "session-test");
        assert_eq!(b.iter().filter(|r| r["gen_ai.turn.end"] == true).count(), 1);
    }
}

#[test]
fn main_l31_root_message_and_usage_must_correlate_in_either_arrival_order() {
    let f = fixture("conversation");
    let events = f["events"].as_array().unwrap();
    let spans = f["spans"].as_array().unwrap();
    assert!(parse_interactions(events, &spans[..1], true).is_empty());
    let missing: Vec<_> = events
        .iter()
        .filter(|e| e["type"] != "assistant.message")
        .cloned()
        .collect();
    assert!(parse_interactions(&missing, spans, true).is_empty());
    assert!(parse_interactions(events, &spans[1..], true).is_empty());
    assert_eq!(parse_interactions(events, spans, true).len(), 1);
    let reversed: Vec<_> = spans.iter().rev().cloned().collect();
    assert_eq!(parse_interactions(events, &reversed, true).len(), 1);
}

#[test]
fn main_l38_missing_native_usage_is_never_fabricated() {
    let mut f = fixture("conversation");
    f["spans"] = json!([]);
    let batches = parse(&f, false);
    let response = named(&batches[0], "llm.response")[0];
    assert!(response.get("gen_ai.usage.input_tokens").is_none());
    assert!(response.get("gen_ai.usage.output_tokens").is_none());
    assert!(response.get("gen_ai.usage.total_tokens").is_none());
}

#[test]
fn main_l41_all_model_metrics_stay_in_an_independent_untraced_shutdown_summary() {
    let mut f = fixture("conversation");
    let models = json!({"one":{"usage":{"inputTokens":1}},"two":{"usage":{"inputTokens":2}}});
    f["events"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"session.shutdown","id":"shutdown-1",
        "timestamp":"2026-09-01T00:00:09Z","data":{"modelMetrics":models}}));
    let batches = parse(&f, true);
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[1][0]["gen_ai.session.model_metrics"], models);
    assert!(batches[1][0].get("trace_id").is_none());
    assert!(batches[0]
        .iter()
        .all(|r| r.get("gen_ai.session.model_metrics").is_none()));
}

#[test]
fn main_l45_cancelled_tool_keeps_its_native_endpoint_without_fabricating_result() {
    let mut f = fixture("cancelled");
    f["events"].as_array_mut().unwrap().insert(
        4,
        json!({"type":"tool.execution_start","id":"tool-start",
        "timestamp":"2026-09-01T00:00:03Z","data":{"interactionId":"interaction-a","turnId":"0",
        "toolCallId":"tool-a","toolName":"bash","arguments":{"command":"sleep 5"}}}),
    );
    let start = f["spans"][0]["endTime"].clone();
    let end = f["spans"][1]["endTime"].clone();
    let trace = f["spans"][0]["traceId"].clone();
    f["spans"].as_array_mut().unwrap().push(
        json!({"type":"span","traceId":trace,"spanId":"tool-span",
        "startTime":start,"endTime":end,"status":{"code":2},"attributes":{
        "gen_ai.operation.name":"execute_tool","gen_ai.conversation.id":"session-test",
        "gen_ai.tool.call.id":"tool-a","error.type":"cancelled"}}),
    );
    let batches = parse(&f, true);
    let result = named(&batches[0], "tool.result")[0];
    assert_eq!(result["gen_ai.tool.success"], false);
    assert_eq!(result["error.type"], "cancelled");
    assert!(result.get("gen_ai.tool.call.result").is_none());
}

#[test]
fn main_l50_provider_failure_without_assistant_has_no_output_or_fake_usage() {
    let mut f = fixture("conversation");
    f["spans"][0]["status"] = json!({"code":2});
    f["spans"][0]["attributes"]["error.type"] = json!("provider_error");
    f["spans"][0]["attributes"]
        .as_object_mut()
        .unwrap()
        .retain(|k, _| !k.starts_with("gen_ai.usage."));
    f["spans"][1]["status"] = json!({"code":2});
    f["spans"][1]["attributes"]["error.type"] = json!("provider_error");
    f["events"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["type"] != "assistant.message");
    let batches = parse(&f, true);
    assert_eq!(batches.len(), 1);
    let response = named(&batches[0], "llm.response")[0];
    assert_eq!(response["error.type"], "provider_error");
    assert!(response.get("gen_ai.usage.input_tokens").is_none());
    assert!(response.get("gen_ai.output.messages").is_none());
}

#[test]
fn main_l62_transcript_order_survives_skewed_native_clocks_without_retiming_spans() {
    let mut f = fixture("tools");
    for span in f["spans"].as_array_mut().unwrap() {
        span["startTime"] = json!([1788220800, 0]);
    }
    let batches = parse(&f, true);
    let requests = named(&batches[0], "llm.request");
    assert_eq!(requests.len(), 2);
    let roles = |r: &Value| {
        r["gen_ai.input.messages_delta"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(roles(requests[0]), ["user"]);
    assert_eq!(roles(requests[1]), ["assistant", "tool"]);
    for request in requests {
        assert_eq!(request["time_unix_nano"], "1788220800000000000");
    }
}
