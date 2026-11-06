use super::*;
use crate::inputs::rest_support::entry_json;
use serde_json::json;

const FIXTURE: &str = include_str!("../../../tests/fixtures/dsh/dsh-probe-events-real.jsonl");
const FIXTURE_SID: &str = "session-d79193cc-deea-4e24-bc36-52dabbf8530f";

fn actual_fixture() -> (Vec<Value>, Vec<Value>) {
    let records = FIXTURE
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).expect("immutable historical fixture"))
        .collect::<Vec<_>>();
    let mut state = new_state();
    let entries = records
        .iter()
        .filter_map(|record| transform_dsh_record(record, ClientType::Dsh, &mut state))
        .map(|entry| entry_json(&entry))
        .collect();
    (records, entries)
}

fn named<'a>(entries: &'a [Value], name: &str) -> Vec<&'a Value> {
    entries
        .iter()
        .filter(|entry| entry["event.name"] == name)
        .collect()
}

#[test]
fn real_fixture_keeps_exact_react_steps_context_deltas_usage_tool_pairs_trace_and_native_timing() {
    let (records, entries) = actual_fixture();
    assert_eq!(records.len(), 155);
    assert!(!entries.is_empty());
    let responses = named(&entries, "llm.response");
    assert_eq!(responses.len(), 3);
    let mut steps = responses
        .iter()
        .map(|entry| entry["gen_ai.step.id"].as_str().expect("step"))
        .collect::<Vec<_>>();
    steps.sort_unstable();
    assert_eq!(
        steps,
        vec![
            format!("{FIXTURE_SID}:1:1"),
            format!("{FIXTURE_SID}:1:2"),
            format!("{FIXTURE_SID}:1:3")
        ]
    );
    let requests = named(&entries, "llm.request");
    assert_eq!(requests.len(), 3);
    for request in &requests {
        assert_eq!(request["gen_ai.request.model"], "deepseek-v4-flash");
        assert_eq!(request["gen_ai.provider.name"], "deepseek-official");
        let input = request["gen_ai.input.messages"]
            .as_array()
            .expect("nonfabricated real input");
        assert!(!input.is_empty());
        for message in input {
            assert!(
                ["user", "assistant", "tool"].contains(&message["role"].as_str().expect("role"))
            );
            assert!(message["parts"].is_array());
        }
    }
    let mut ordered = requests.clone();
    ordered.sort_by_key(|entry| entry["gen_ai.step.id"].as_str().expect("step"));
    let mut accumulated = Vec::new();
    for request in &ordered {
        accumulated.extend(
            request["gen_ai.input.messages_delta"]
                .as_array()
                .expect("actual delta")
                .iter()
                .cloned(),
        );
        assert_eq!(
            accumulated,
            *request["gen_ai.input.messages"]
                .as_array()
                .expect("actual accumulated input")
        );
    }
    let first = ordered[0]["gen_ai.input.messages"]
        .as_array()
        .expect("first input");
    let second = ordered[1]["gen_ai.input.messages"]
        .as_array()
        .expect("second input");
    let third = ordered[2]["gen_ai.input.messages"]
        .as_array()
        .expect("third input");
    assert!(!first.is_empty());
    assert_eq!(first[0]["role"], "user");
    assert!(second.len() > first.len());
    assert!(third.len() > second.len());
    let roles = second
        .iter()
        .map(|message| message["role"].as_str().expect("role"))
        .collect::<Vec<_>>();
    for role in ["user", "assistant", "tool"] {
        assert!(roles.contains(&role));
    }
    for response in &responses {
        assert!(!response["gen_ai.output.messages"]
            .as_array()
            .expect("actual output")
            .is_empty());
        let input = response["gen_ai.usage.input_tokens"]
            .as_f64()
            .expect("input usage");
        let output = response["gen_ai.usage.output_tokens"]
            .as_f64()
            .expect("output usage");
        assert!(input > 0.0);
        assert!(output > 0.0);
        if let Some(total) = response.get("gen_ai.usage.total_tokens") {
            assert_eq!(total.as_f64().expect("total usage"), input + output);
        }
    }
    let mut sorted_responses = responses.clone();
    sorted_responses.sort_by_key(|entry| entry["gen_ai.step.id"].as_str().expect("step"));
    assert_eq!(
        sorted_responses
            .iter()
            .map(|entry| (
                entry["gen_ai.usage.input_tokens"].as_f64().expect("input"),
                entry["gen_ai.usage.output_tokens"]
                    .as_f64()
                    .expect("output"),
                entry["gen_ai.usage.cache_read.input_tokens"]
                    .as_f64()
                    .expect("cache")
            ))
            .collect::<Vec<_>>(),
        vec![
            (7493.0, 105.0, 0.0),
            (7632.0, 46.0, 7552.0),
            (7723.0, 36.0, 7552.0)
        ]
    );
    let calls = named(&entries, "tool.call");
    let results = named(&entries, "tool.result");
    assert!(calls.len() >= 2);
    assert_eq!(results.len(), calls.len());
    let mut call_ids = calls
        .iter()
        .map(|entry| entry["gen_ai.tool.call.id"].as_str().expect("call id"))
        .collect::<Vec<_>>();
    let mut result_ids = results
        .iter()
        .map(|entry| entry["gen_ai.tool.call.id"].as_str().expect("result id"))
        .collect::<Vec<_>>();
    call_ids.sort_unstable();
    result_ids.sort_unstable();
    assert_eq!(result_ids, call_ids);
    assert_eq!(calls[0]["gen_ai.tool.name"], "write");
    assert_eq!(calls[1]["gen_ai.tool.name"], "read");
    assert_eq!(
        results
            .iter()
            .map(|entry| entry["gen_ai.tool.name"].as_str().expect("result name"))
            .collect::<Vec<_>>(),
        vec!["write", "read"]
    );
    let traces = entries
        .iter()
        .map(|entry| entry["trace_id"].as_str().expect("trace id"))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(traces.len(), 1);
    let trace = traces.first().expect("trace");
    assert_eq!(trace.len(), 32);
    assert!(trace
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert_eq!(
        records
            .iter()
            .filter(|record| record["type"] == "user/message")
            .map(|record| record["data"]["source"]["kind"]
                .as_str()
                .expect("source kind"))
            .collect::<Vec<_>>(),
        vec!["user", "plugin"]
    );
    let user = named(&entries, "other");
    assert_eq!(user.len(), 1);
    let delta = user[0]["gen_ai.input.messages_delta"]
        .as_array()
        .expect("human user delta");
    assert_eq!(delta[0]["role"], "user");
    assert!(!delta[0]["parts"]
        .as_array()
        .expect("human input parts")
        .is_empty());
    let human = user[0]["gen_ai.input.messages_delta"].to_string();
    assert!(human.contains("Create a hello.txt file"));
    assert!(!human.contains("Current runtime context"));
    let first_input = requests[0]["gen_ai.input.messages"].to_string();
    assert!(first_input.contains("Create a hello.txt file"));
    assert!(first_input.contains("Current runtime context"));
    assert_eq!(requests.len(), responses.len());
    for (request, response) in requests.iter().zip(&responses) {
        let start = request["time_unix_nano"]
            .as_str()
            .expect("request nanos")
            .parse::<i128>()
            .expect("exact request integer");
        let end = response["time_unix_nano"]
            .as_str()
            .expect("response nanos")
            .parse::<i128>()
            .expect("exact response integer");
        assert!(end > start);
    }
    assert_eq!(
        requests
            .iter()
            .map(|entry| entry["time_unix_nano"]
                .as_str()
                .expect("native request boundary"))
            .collect::<Vec<_>>(),
        vec![
            "1786643725829000000",
            "1786643727189000000",
            "1786643727920000000"
        ]
    );
    assert_eq!(
        responses
            .iter()
            .map(|entry| entry["gen_ai.response.time_to_first_token"]
                .as_f64()
                .expect("native ttft"))
            .collect::<Vec<_>>(),
        vec![671_000_000.0, 591_000_000.0, 943_000_000.0]
    );
    let reasons = responses
        .iter()
        .map(|entry| entry["gen_ai.response.finish_reasons"].clone())
        .collect::<Vec<_>>();
    assert!(reasons.contains(&json!(["tool_calls"])));
    assert!(reasons.contains(&json!(["stop"])));
    for entry in &entries {
        assert!([
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "other"
        ]
        .contains(&entry["event.name"].as_str().expect("leaf event")));
    }
}

fn single(record: &Value, state: &mut DshEventAggregatorState) -> Value {
    entry_json(
        &transform_dsh_record(record, ClientType::Dsh, state).expect("actual canonical event"),
    )
}
fn response(stream: Value) -> Value {
    json!({"type":"assistant/message","sid":"embedded-session","time":200,
        "data":{"turn":1,"step":1,"message":{"id":"response-1","content":[{"type":"text","text":"done"}]},
        "usage":{"inputTokens":10,"outputTokens":5},"stream":stream}})
}
fn begin(state: &mut DshEventAggregatorState, sid: &str, turn: i64) {
    for record in [
        json!({"type":"turn/start","sid":sid,"time":1,"data":{"turn":turn}}),
        json!({"type":"step/start","sid":sid,"time":2,"data":{"turn":turn,"step":1}}),
    ] {
        transform_dsh_record(&record, ClientType::Dsh, state);
    }
}
fn block(sid: &str, turn: i64, time: i64) -> Value {
    json!({"type":"assistant/chunk","sid":sid,"time":time,"data":{"turn":turn,"step":1,"chunk":{"type":"block-start"}}})
}
fn header(provider: &str, model: &str, system: &str) -> DshRequestHeader {
    DshRequestHeader {
        provider: Some(provider.into()),
        model: Some(model.into()),
        system: Some(system.into()),
        tools: None,
    }
}

#[test]
fn l340_absent_native_boundary_and_output_delta_do_not_fabricate_ttft() {
    let mut state = new_state();
    state.current_turn = Some(1.0);
    state.current_step = Some(1.0);
    state.current_turn_header = Some(DshRequestHeader {
        model: Some("m".into()),
        provider: Some("p".into()),
        ..DshRequestHeader::default()
    });
    transform_dsh_record(&block("s", 1, 1000), ClientType::Dsh, &mut state);
    let output = single(
        &json!({"type":"assistant/message","sid":"s","time":1100,
        "data":{"turn":1,"step":1,"message":{"id":"r","content":[{"type":"text","text":"done"}]}}}),
        &mut state,
    );
    assert!(output.get("gen_ai.response.time_to_first_token").is_none());
}

#[test]
fn l360_real_header_exposes_system_instructions_and_all_twenty_five_native_tool_definitions() {
    let (_, entries) = actual_fixture();
    let requests = named(&entries, "llm.request");
    assert_eq!(requests.len(), 3);
    for entry in requests {
        let system = entry["gen_ai.system_instructions"]
            .as_array()
            .expect("native system instructions");
        assert!(system.iter().any(|part| part["type"] == "text"));
        let tools = entry["gen_ai.tool.definitions"]
            .as_array()
            .expect("native tools");
        assert_eq!(tools.len(), 25);
        assert!(!tools[0]["name"]
            .as_str()
            .expect("native tool name")
            .is_empty());
    }
}

#[test]
fn l449_new_native_turn_header_replaces_prior_session_header_without_stale_fields() {
    let mut state = new_state();
    state.last_known_header = Some(header("old-provider", "old-model", "old-system"));
    begin(&mut state, "session-a", 2);
    transform_dsh_record(
        &json!({"type":"request/header","sid":"session-a","time":3,
        "data":{"header":{"config":{"provider":"new-provider","model":"new-model"},"system":"new-system"}}}),
        ClientType::Dsh,
        &mut state,
    );
    let request = single(&block("session-a", 2, 4), &mut state);
    assert_eq!(request["gen_ai.provider.name"], "new-provider");
    assert_eq!(request["gen_ai.request.model"], "new-model");
    assert_eq!(
        request["gen_ai.system_instructions"],
        json!([{"type":"text","content":"new-system"}])
    );
    let saved = state.last_known_header.expect("last header");
    assert_eq!(saved.provider.as_deref(), Some("new-provider"));
    assert_eq!(saved.model.as_deref(), Some("new-model"));
    assert_eq!(saved.system.as_deref(), Some("new-system"));
    assert!(saved.tools.is_none());
}

#[test]
fn l489_malformed_present_header_keeps_last_valid_header_and_current_request_identity() {
    let mut state = new_state();
    state.last_known_header = Some(header("valid-provider", "valid-model", "valid-system"));
    begin(&mut state, "session-a", 2);
    transform_dsh_record(
        &json!({"type":"request/header","sid":"session-a","time":3,"data":{"header":"malformed"}}),
        ClientType::Dsh,
        &mut state,
    );
    let request = single(&block("session-a", 2, 4), &mut state);
    let saved = state.last_known_header.expect("preserved header");
    assert_eq!(saved.provider.as_deref(), Some("valid-provider"));
    assert_eq!(saved.model.as_deref(), Some("valid-model"));
    assert_eq!(saved.system.as_deref(), Some("valid-system"));
    assert!(saved.tools.is_none());
    assert_eq!(request["gen_ai.provider.name"], "valid-provider");
    assert_eq!(request["gen_ai.request.model"], "valid-model");
}

#[test]
fn l519_headerless_native_request_exists_without_inventing_model_or_system() {
    let mut state = new_state();
    begin(&mut state, "session-a", 1);
    let request = single(&block("session-a", 1, 3), &mut state);
    assert_eq!(request["event.name"], "llm.request");
    assert!(request.get("gen_ai.request.model").is_none());
    assert!(request.get("gen_ai.system_instructions").is_none());
}

#[test]
fn l555_all_five_embedded_finish_kinds_keep_their_own_response_id_and_usage() {
    for (kind, expected) in [
        ("stop", "stop"),
        ("tool-calls", "tool_calls"),
        ("max-tokens", "length"),
        ("error", "error"),
        ("aborted", "cancelled"),
    ] {
        let entry = single(
            &response(json!([
                {"type":"text-chunks","time0":120,"index":0,"dt":[10],"texts":["do","ne"]},
                {"type":"chunk","time":190,"chunk":{"type":"finish","reason":{"kind":kind}}}
            ])),
            &mut new_state(),
        );
        assert_eq!(
            entry["gen_ai.response.finish_reasons"],
            json!([expected]),
            "{kind}"
        );
        assert_eq!(entry["gen_ai.response.id"], "response-1", "{kind}");
        assert_eq!(
            entry["gen_ai.usage.output_tokens"].as_f64(),
            Some(5.0),
            "{kind}"
        );
    }
}

#[test]
fn l568_unknown_embedded_finish_never_borrows_or_retains_prior_legacy_finish() {
    let mut state = new_state();
    transform_dsh_record(
        &json!({"type":"assistant/chunk","sid":"embedded-session","time":100,
        "data":{"turn":1,"step":1,"chunk":{"type":"finish","reason":{"kind":"stop"}}}}),
        ClientType::Dsh,
        &mut state,
    );
    let entry = single(
        &response(
            json!([{"type":"chunk","time":190,"chunk":{"type":"finish","reason":{"kind":"future-kind"}}}]),
        ),
        &mut state,
    );
    assert!(entry.get("gen_ai.response.finish_reasons").is_none());
    assert!(state.pending_finish.is_empty());
}

#[test]
fn l581_native_interrupted_marker_cancels_a_prefix_without_any_finish_chunk() {
    let mut record =
        response(json!([{"type":"text-chunks","time0":120,"index":0,"dt":[],"texts":["partial"]}]));
    record["data"]["interrupted"] = json!(true);
    let entry = single(&record, &mut new_state());
    assert_eq!(
        entry["gen_ai.response.finish_reasons"],
        json!(["cancelled"])
    );
}

#[test]
fn l588_empty_null_and_nonfinish_streams_keep_finish_information_absent() {
    for stream in [
        json!([]),
        Value::Null,
        json!([{"type":"chunk","time":190,"chunk":{"type":"usage"}}]),
    ] {
        let entry = single(&response(stream), &mut new_state());
        assert!(entry.get("gen_ai.response.finish_reasons").is_none());
    }
}

#[test]
fn l595_legacy_request_and_embedded_settled_message_do_not_duplicate_the_request() {
    let mut state = new_state();
    let request = transform_dsh_record_entries(
        &json!({"type":"assistant/chunk","sid":"embedded-session","time":100,
        "data":{"turn":1,"step":1,"chunk":{"type":"text-delta","text":"done"}}}),
        ClientType::Dsh,
        &mut state,
    );
    let settled = transform_dsh_record_entries(
        &response(
            json!([{"type":"chunk","time":190,"chunk":{"type":"finish","reason":{"kind":"tool-calls"}}}]),
        ),
        ClientType::Dsh,
        &mut state,
    );
    assert_eq!(
        request
            .iter()
            .map(|entry| entry.event_name.map(|name| name.as_str()).expect("event"))
            .collect::<Vec<_>>(),
        vec!["llm.request"]
    );
    assert_eq!(
        settled
            .iter()
            .map(|entry| entry.event_name.map(|name| name.as_str()).expect("event"))
            .collect::<Vec<_>>(),
        vec!["llm.response"]
    );
    assert_eq!(
        entry_json(&settled[0])["gen_ai.response.finish_reasons"],
        json!(["tool_calls"])
    );
}

#[test]
fn l609_legacy_chunks_keep_native_max_tokens_and_aborted_finish_kinds() {
    for (kind, expected) in [("max-tokens", "length"), ("aborted", "cancelled")] {
        let mut state = new_state();
        transform_dsh_record(
            &json!({"type":"assistant/chunk","sid":"embedded-session","time":100,
            "data":{"turn":1,"step":1,"chunk":{"type":"finish","reason":{"kind":kind}}}}),
            ClientType::Dsh,
            &mut state,
        );
        let mut record = response(json!([]));
        record["data"]
            .as_object_mut()
            .expect("data")
            .remove("stream");
        let entry = single(&record, &mut state);
        assert_eq!(
            entry["gen_ai.response.finish_reasons"],
            json!([expected]),
            "{kind}"
        );
    }
}

#[test]
fn l621_all_four_compact_stream_encodings_preserve_first_output_native_timing() {
    for kind in [
        "text-chunks",
        "reasoning-chunks",
        "tool-call-chunks",
        "chunk",
    ] {
        let mut state = new_state();
        transform_dsh_record(
            &json!({"type":"step/start","sid":"embedded-session","time":100,"data":{"turn":1,"step":1}}),
            ClientType::Dsh,
            &mut state,
        );
        let first = if kind == "chunk" {
            json!({"type":kind,"time":120,"chunk":{"type":"text-delta","text":"done"}})
        } else {
            json!({"type":kind,"time0":120,"index":0,"dt":[],"texts":["done"],"args":["{}"]})
        };
        let entries = transform_dsh_record_entries(
            &response(
                json!([first,{"type":"chunk","time":190,"chunk":{"type":"finish","reason":{"kind":"stop"}}}]),
            ),
            ClientType::Dsh,
            &mut state,
        );
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.event_name.map(|name| name.as_str()).expect("event"))
                .collect::<Vec<_>>(),
            vec!["llm.request", "llm.response"],
            "{kind}"
        );
        assert_eq!(
            entry_json(&entries[1])["gen_ai.response.time_to_first_token"].as_f64(),
            Some(20_000_000.0),
            "{kind}"
        );
    }
}

#[test]
fn l642_plugin_and_future_sources_remain_llm_context_without_top_level_human_input() {
    for kind in ["plugin", "future-injected-source"] {
        let mut state = new_state();
        state.current_turn = Some(1.0);
        state.current_step = Some(1.0);
        let injected = transform_dsh_record(
            &json!({"type":"user/message","sid":"session-a","time":1,
            "data":{"turn":1,"source":{"kind":kind},"content":[{"type":"text","text":"injected context"}]}}),
            ClientType::Dsh,
            &mut state,
        );
        assert!(injected.is_none(), "{kind}");
        let request = single(&block("session-a", 1, 2), &mut state);
        assert!(
            request["gen_ai.input.messages"]
                .to_string()
                .contains("injected context"),
            "{kind}"
        );
        assert!(
            request["gen_ai.input.messages_delta"]
                .to_string()
                .contains("injected context"),
            "{kind}"
        );
    }
}

#[test]
fn l672_legacy_message_without_source_preserves_its_top_level_user_projection() {
    let entry = single(
        &json!({"type":"user/message","sid":"legacy-session","time":1,
        "data":{"content":[{"type":"text","text":"legacy prompt"}]}}),
        &mut new_state(),
    );
    assert_eq!(entry["event.name"], "other");
    assert!(entry["gen_ai.input.messages_delta"]
        .to_string()
        .contains("legacy prompt"));
}

#[test]
fn l684_malformed_present_source_is_not_reclassified_as_human_input() {
    let entry = transform_dsh_record(
        &json!({"type":"user/message","sid":"session-a","time":1,
        "data":{"source":{},"content":[{"type":"text","text":"unclassified context"}]}}),
        ClientType::Dsh,
        &mut new_state(),
    );
    assert!(entry.is_none());
}

#[test]
fn l700_native_turn_and_step_identifiers_and_trace_ids_are_scoped_by_session() {
    let run = |sid: &str| {
        let mut state = new_state();
        begin(&mut state, sid, 1);
        transform_dsh_record(
            &json!({"type":"request/header","sid":sid,"time":3,
            "data":{"header":{"config":{"provider":"p","model":"m"}}}}),
            ClientType::Dsh,
            &mut state,
        );
        single(&block(sid, 1, 4), &mut state)
    };
    let a = run("session-a");
    let b = run("session-b");
    assert_eq!(a["gen_ai.turn.id"], "session-a:1");
    assert_eq!(b["gen_ai.turn.id"], "session-b:1");
    assert_eq!(a["gen_ai.step.id"], "session-a:1:1");
    assert_eq!(b["gen_ai.step.id"], "session-b:1:1");
    assert_ne!(a["gen_ai.turn.id"], b["gen_ai.turn.id"]);
    assert_ne!(a["trace_id"], b["trace_id"]);
}

#[test]
fn l725_parallel_results_use_exact_call_ids_and_orphan_result_is_dropped() {
    let mut state = new_state();
    transform_dsh_record(
        &json!({"type":"assistant/message","sid":"session-a","time":10,"data":{"turn":1,"step":1,
        "message":{"content":[{"type":"tool-call","id":"call-a","name":"read","arguments":"{}"},
            {"type":"tool-call","id":"call-b","name":"write","arguments":"{}"}]}}}),
        ClientType::Dsh,
        &mut state,
    );
    let result = |id: &str, state: &mut DshEventAggregatorState| {
        transform_dsh_record(
            &json!({"type":"tool/result","sid":"session-a","time":10,
        "data":{"turn":1,"step":1,"message":{"source":{"callId":id},"content":[{"type":"text","text":"ok"}]}}}),
            ClientType::Dsh,
            state,
        )
    };
    assert_eq!(
        entry_json(&result("call-b", &mut state).expect("call-b"))["gen_ai.tool.name"],
        "write"
    );
    assert_eq!(
        entry_json(&result("call-a", &mut state).expect("call-a"))["gen_ai.tool.name"],
        "read"
    );
    assert!(result("orphan", &mut state).is_none());
}

#[test]
fn l756_turn_end_clears_unfinished_correlations_but_retains_last_valid_session_header() {
    let mut state = new_state();
    state.current_turn = Some(1.0);
    state.current_step = Some(1.0);
    state.current_turn_header = Some(DshRequestHeader {
        model: Some("old-model".into()),
        provider: Some("old-provider".into()),
        ..DshRequestHeader::default()
    });
    state.last_known_header = state.current_turn_header.clone();
    state.input_messages.push(json!({"role":"user","parts":[]}));
    state.last_request_input_message_count = 1;
    state.tool_names.insert("call".into(), "read".into());
    state
        .request_start_times
        .insert("session-a:1:1".into(), 1.0);
    state.first_output_times.insert("session-a:1:1".into(), 2.0);
    transform_dsh_record(
        &json!({"type":"turn/end","sid":"session-a","time":2,"data":{"turn":1}}),
        ClientType::Dsh,
        &mut state,
    );
    assert!(state.current_turn.is_none());
    assert!(state.current_step.is_none());
    assert!(state.current_turn_header.is_none());
    let last = state.last_known_header.expect("last header");
    assert_eq!(last.model.as_deref(), Some("old-model"));
    assert_eq!(last.provider.as_deref(), Some("old-provider"));
    assert!(last.system.is_none());
    assert!(last.tools.is_none());
    assert!(state.input_messages.is_empty());
    assert_eq!(state.last_request_input_message_count, 0);
    assert!(state.tool_names.is_empty());
    assert!(state.request_start_times.is_empty());
    assert!(state.first_output_times.is_empty());
}

fn user_message() -> Value {
    json!({"type":"user/message","sid":"s","time":1,"data":{"content":[{"type":"text","text":"hi"}],"id":"m1"}})
}

#[test]
fn l784_filtered_source_event_does_not_fabricate_credential_fields() {
    let entry = single(&user_message(), &mut new_state());
    assert!(
        !regex::Regex::new("(?i)API_KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL")
            .expect("source privacy pattern")
            .is_match(&entry.to_string())
    );
}

#[test]
fn l807_worker_name_and_instance_are_trimmed_and_allowlisted_without_worker_token() {
    let mut source = user_message();
    source["resourceAttributes"] = json!({"agentteams.worker.name":" planner ","agentteams.instance.id":"task-42-worker-1","agentteams.token":"must-not-leak"});
    let entry = single(&source, &mut new_state());
    assert_eq!(entry["gen_ai.agent.name"], "planner");
    assert_eq!(
        entry["resourceAttributes"],
        json!({"agentteams.worker.name":"planner","agentteams.instance.id":"task-42-worker-1"})
    );
    assert!(!entry.to_string().contains("must-not-leak"));
}

#[test]
fn l825_source_without_worker_context_has_no_worker_identity_or_resource_attributes() {
    let entry = single(&user_message(), &mut new_state());
    assert!(entry.get("gen_ai.agent.name").is_none());
    assert!(entry.get("resourceAttributes").is_none());
}

#[test]
fn l831_blank_and_oversized_worker_names_do_not_create_resource_identity() {
    for name in ["   ".to_owned(), "x".repeat(513)] {
        let mut source = user_message();
        source["resourceAttributes"] = json!({"agentteams.worker.name":name});
        let entry = single(&source, &mut new_state());
        assert!(entry.get("gen_ai.agent.name").is_none());
        assert!(entry.get("resourceAttributes").is_none());
    }
}
