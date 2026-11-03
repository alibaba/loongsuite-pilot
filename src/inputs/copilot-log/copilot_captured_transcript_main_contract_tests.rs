//! Retained behavior from the four immutable historical Copilot captures, through
//! the current production interaction parser. The obsolete session-wide wrapper,
//! full-context and trace-ownership assertions are tracked separately in the map.
use super::*;
use crate::normalization::entry_to_object;
use std::collections::{BTreeMap, HashSet};

fn captured(name: &str) -> Vec<Value> {
    let raw = match name {
        "denied" => {
            include_str!("../../../tests/fixtures/copilot/captured-main/events-permdeny.jsonl")
        }
        "script" => include_str!(
            "../../../tests/fixtures/copilot/captured-main/events-permdeny-scriptmode.jsonl"
        ),
        "multi" => {
            include_str!("../../../tests/fixtures/copilot/captured-main/events-scenarioA.jsonl")
        }
        _ => include_str!("../../../tests/fixtures/copilot/captured-main/events-session2.jsonl"),
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn parsed(events: &[Value]) -> Vec<Value> {
    parse_interactions(events, &[], false)
        .into_iter()
        .flat_map(|batch| batch.records)
        .map(|entry| Value::Object(entry_to_object(&entry)))
        .collect()
}
fn named<'a>(records: &'a [Value], name: &str) -> Vec<&'a Value> {
    records.iter().filter(|r| r["event.name"] == name).collect()
}
fn messages(record: &Value) -> Value {
    let value = &record["gen_ai.output.messages"];
    value
        .as_str()
        .map(|s| serde_json::from_str(s).unwrap())
        .unwrap_or_else(|| value.clone())
}
fn nanos(record: &Value) -> i128 {
    record["time_unix_nano"].as_str().unwrap().parse().unwrap()
}

#[test]
fn captured_l63_parallel_tools_keep_unique_ids_names_and_nonzero_exact_pairs() {
    let raw = captured("routine");
    let records = parsed(&raw);
    let calls = named(&records, "tool.call");
    let results = named(&records, "tool.result");
    assert_eq!(calls.len(), 3);
    assert_eq!(results.len(), 3);
    let parallel: Vec<_> = calls
        .iter()
        .filter(|r| r["gen_ai.step.id"] == "1")
        .collect();
    assert_eq!(parallel.len(), 2);
    let ids: HashSet<_> = parallel
        .iter()
        .map(|r| r["gen_ai.tool.call.id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2);
    for call in calls {
        let result = results
            .iter()
            .find(|r| r["gen_ai.tool.call.id"] == call["gen_ai.tool.call.id"])
            .unwrap();
        assert_eq!(result["gen_ai.tool.name"], call["gen_ai.tool.name"]);
        assert_eq!(call["gen_ai.provider.name"], "openai");
        assert_eq!(result["gen_ai.provider.name"], "openai");
        assert_eq!(result["gen_ai.step.id"], call["gen_ai.step.id"]);
        assert_eq!(result["gen_ai.turn.id"], call["gen_ai.turn.id"]);
        assert!(nanos(result) > nanos(call));
    }
}

#[test]
fn captured_l73_hook_opaque_checkpoint_and_model_change_rows_never_become_spans() {
    let raw = captured("routine");
    assert_eq!(raw.iter().filter(|e| e["type"] == "hook.start").count(), 7);
    assert_eq!(raw.iter().filter(|e| e["type"] == "hook.end").count(), 7);
    let records = parsed(&raw);
    let encoded = serde_json::to_string(&records).unwrap();
    for forbidden in [
        "hookInvocationId",
        "hook.start",
        "hook.end",
        "reasoningOpaque",
        "usage_checkpoint",
    ] {
        assert!(
            !encoded.contains(forbidden),
            "unapproved raw protocol field leaked"
        );
    }
    assert!(records
        .iter()
        .filter(|r| r["gen_ai.copilot.session_summary"] != true)
        .all(|r| !serde_json::to_string(r).unwrap().contains("totalNanoAiu")));
    let responses = named(&records, "llm.response");
    assert_eq!(responses.len(), 3);
    for response in responses {
        assert_eq!(response["gen_ai.request.model"], "gpt-5.6-luna");
        assert!(response.get("gen_ai.usage.input_tokens").is_none());
        assert!(response.get("gen_ai.usage.output_tokens").is_none());
        assert!(messages(response).as_array().is_some_and(|v| !v.is_empty()));
    }
}

#[test]
fn captured_l132_reasoning_text_projection_matches_output_parts_without_opaque_bytes() {
    for name in ["routine", "multi"] {
        let raw = captured(name);
        let records = parsed(&raw);
        for response in named(&records, "llm.response") {
            let step = response["gen_ai.step.id"].as_str().unwrap();
            let chunks: Vec<_> = raw
                .iter()
                .filter(|e| {
                    e["type"] == "assistant.message" && e["data"]["turnId"].as_str() == Some(step)
                })
                .filter_map(|e| e["data"]["reasoningText"].as_str())
                .filter(|s| !s.is_empty())
                .collect();
            if chunks.is_empty() {
                continue;
            }
            let expected = chunks.join("\n\n");
            assert!(
                response["gen_ai.llm.reasoning.text"].as_str() == Some(expected.as_str()),
                "exact reasoning text projection must be retained"
            );
            let output = messages(response);
            let parts = output[0]["parts"].as_array().unwrap();
            for chunk in chunks {
                assert!(
                    parts
                        .iter()
                        .any(|p| p["type"] == "reasoning" && p["content"].as_str() == Some(chunk)),
                    "every observed reasoning chunk must remain in output"
                );
            }
        }
    }
}

#[test]
fn captured_l147_declared_tool_parts_and_multi_message_api_calls_stay_complete() {
    for (name, total_calls) in [("routine", 3), ("multi", 11)] {
        let raw = captured(name);
        let records = parsed(&raw);
        let calls = named(&records, "tool.call");
        assert_eq!(calls.len(), total_calls);
        for response in named(&records, "llm.response") {
            let output = messages(response);
            let parts = output[0]["parts"].as_array().unwrap();
            let tools: Vec<_> = parts.iter().filter(|p| p["type"] == "tool_call").collect();
            if !tools.is_empty() {
                assert_eq!(
                    response["gen_ai.response.finish_reasons"],
                    json!(["tool_calls"])
                );
            }
            for tool in tools {
                let call = calls
                    .iter()
                    .find(|c| c["gen_ai.tool.call.id"] == tool["id"])
                    .unwrap();
                assert_eq!(call["gen_ai.tool.name"], tool["name"]);
            }
        }
        if name == "multi" {
            let responses: Vec<_> = records
                .iter()
                .filter(|r| r["event.name"] == "llm.response" && r["gen_ai.step.id"] == "5")
                .collect();
            assert_eq!(responses.len(), 1);
            let output = messages(responses[0]);
            let parts = output[0]["parts"].as_array().unwrap();
            assert_eq!(parts.iter().filter(|p| p["type"] == "tool_call").count(), 3);
            assert!(parts.iter().any(|p| p["type"] == "reasoning"
                && p["content"].as_str().is_some_and(|s| !s.is_empty())));
        }
    }
}

#[test]
fn captured_l421_denial_permission_decisions_and_error_classification_are_preserved() {
    for name in ["denied", "script"] {
        let records = parsed(&captured(name));
        let calls = named(&records, "tool.call");
        let results = named(&records, "tool.result");
        assert_eq!(calls.len(), 2);
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(result["gen_ai.tool.success"], false);
            assert_eq!(result["error.code"], "denied");
            assert_eq!(result["error.type"], "denied");
            assert_eq!(
                result["permission.result.kind"],
                "denied-no-approval-rule-and-could-not-request-from-user"
            );
            assert_eq!(result["permission.decision_source"], "unattended_fallback");
            assert!(calls.iter().any(|c| c["gen_ai.tool.call.id"]
                == result["gen_ai.tool.call.id"]
                && c["gen_ai.step.id"] == result["gen_ai.step.id"]));
        }
    }
}

#[test]
fn captured_l370_step_endpoints_cover_children_and_each_tool_identity_occurs_once() {
    for name in ["routine", "multi", "denied", "script"] {
        let records = parsed(&captured(name));
        let steps = named(&records, "react.step");
        assert!(!steps.is_empty());
        for step in steps {
            assert!(step.get("gen_ai.turn.start").is_none());
            for child in records.iter().filter(|r| {
                r.get("gen_ai.step.id") == step.get("gen_ai.step.id")
                    && r["event.name"] != "react.step"
            }) {
                assert!(
                    nanos(step) >= nanos(child),
                    "step endpoint must cover all child event clocks"
                );
            }
        }
        let mut tools: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
        for record in &records {
            if let Some(id) = record["gen_ai.tool.call.id"].as_str() {
                tools.entry(id.into()).or_default().push(record);
            }
        }
        for entries in tools.values() {
            assert_eq!(entries.len(), 2);
            let calls = entries
                .iter()
                .filter(|r| r["event.name"] == "tool.call")
                .count();
            assert_eq!(calls, 1);
            assert_eq!(
                entries
                    .iter()
                    .filter(|r| r["event.name"] == "tool.result")
                    .count(),
                1
            );
            assert!(entries
                .iter()
                .find(|r| r["event.name"] == "tool.call")
                .unwrap()
                .get("gen_ai.tool.call.arguments")
                .is_some());
        }
    }
}

#[test]
fn captured_l398_partial_sessions_emit_closed_work_without_unobserved_summary_or_empty_steps() {
    let mut raw = captured("routine");
    raw.retain(|e| e["type"] != "session.shutdown");
    let records = parsed(&raw);
    assert!(!named(&records, "react.step").is_empty());
    assert!(!named(&records, "llm.response").is_empty());
    assert!(records
        .iter()
        .all(|r| r["gen_ai.copilot.session_summary"] != true));
    let records = parsed(&captured("denied"));
    assert!(records.iter().all(|r| r["gen_ai.step.id"] != "2"));
    assert!(records.iter().all(|r| nanos(r) >= 0));
}

#[test]
fn captured_l529_session_identity_gates_output_and_real_shutdown_preserves_every_model() {
    for name in ["routine", "script", "multi"] {
        let raw = captured(name);
        let records = parsed(&raw);
        let shutdown = raw
            .iter()
            .find(|e| e["type"] == "session.shutdown")
            .unwrap();
        let summaries: Vec<_> = records
            .iter()
            .filter(|r| r["gen_ai.copilot.session_summary"] == true)
            .collect();
        assert_eq!(summaries.len(), 1);
        assert!(summaries[0]["gen_ai.session.model_metrics"] == shutdown["data"]["modelMetrics"]);
        assert_eq!(
            summaries[0]["gen_ai.session.total_api_duration_ms"],
            shutdown["data"]["totalApiDurationMs"]
        );
        assert!(summaries[0].get("trace_id").is_none());
        assert!(summaries[0].get("gen_ai.turn.id").is_none());
        assert!(records.iter().all(|r| r["gen_ai.session.id"]
            .as_str()
            .is_some_and(|s| !s.is_empty())));
        let no_start: Vec<_> = raw
            .iter()
            .filter(|e| e["type"] != "session.start")
            .cloned()
            .collect();
        assert!(parsed(&no_start).is_empty());
        let mut no_id = raw;
        no_id
            .iter_mut()
            .find(|e| e["type"] == "session.start")
            .unwrap()["data"]["sessionId"] = json!("");
        assert!(parsed(&no_id).is_empty());
    }
}

#[test]
fn captured_current_main_provider_defaults_apply_to_real_requests_responses_and_tools() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/copilot/tool-conversation.json"
    ))
    .unwrap();
    for (model, provider) in [
        ("", "unknown"),
        ("qwen-coder", "alibaba"),
        ("claude-test", "anthropic"),
        ("gpt-test", "openai"),
        ("custom-local", "openai"),
        ("anthropic.test", "anthropic"),
        ("gemini-1", "google"),
    ] {
        let mut events = fixture["events"].as_array().unwrap().clone();
        for event in events
            .iter_mut()
            .filter(|e| e["type"] == "assistant.message")
        {
            event["data"]["model"] = json!(model);
        }
        let records = parsed(&events);
        for name in ["llm.request", "llm.response", "tool.call", "tool.result"] {
            let matched = named(&records, name);
            assert!(!matched.is_empty());
            for record in matched {
                assert_eq!(record["gen_ai.provider.name"], provider);
            }
        }
    }
}

#[test]
fn captured_l184_incremental_requests_preserve_observed_context_without_repeating_it() {
    let records = parsed(&captured("routine"));
    let requests = named(&records, "llm.request");
    assert_eq!(requests.len(), 3);
    let mut roles: BTreeMap<String, usize> = BTreeMap::new();
    for request in &requests {
        assert!(request.get("gen_ai.input.messages").is_none());
        if let Some(delta) = request["gen_ai.input.messages_delta"].as_array() {
            for message in delta {
                *roles
                    .entry(message["role"].as_str().unwrap().into())
                    .or_default() += 1;
            }
        }
    }
    assert_eq!(
        roles,
        BTreeMap::from([
            ("user".into(), 1),
            ("system".into(), 1),
            ("assistant".into(), 2),
            ("tool".into(), 3)
        ])
    );
    for request in requests.iter().skip(1) {
        assert!(request["gen_ai.input.messages_delta"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["role"] != "user" && m["role"] != "system"));
    }
}
