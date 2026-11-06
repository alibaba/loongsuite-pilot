//! Fixed ef8953 token/segment contracts: literal fixtures and assertions are
//! statically extracted from the historical test AST; no TypeScript executes.
use loongsuite_pilot::inputs::qoder_trace::{
    enrich_cli_from_segments, enrich_cli_primary, enrich_cli_turn, needs_cli_segment_fallback,
    InterceptTokenData, SegmentTokenData,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::sync::OnceLock;

fn fixtures() -> &'static Vec<Value> {
    static DATA: OnceLock<Vec<Value>> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/qoder-trace-cli-history.json")).unwrap()
    })
}
fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}
fn string(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").into()
}
fn segments(value: Option<&Value>) -> Vec<SegmentTokenData> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| SegmentTokenData {
            request_id: string(v, "requestId"),
            input_tokens: number(v, "inputTokens"),
            output_tokens: number(v, "outputTokens"),
            cache_read_tokens: number(v, "cacheReadTokens"),
            cache_creation_tokens: number(v, "cacheCreationTokens"),
            request_start_ts: number(v, "requestStartTs"),
            response_end_ts: number(v, "responseEndTs"),
            tool_finished_ts: number(v, "toolFinishedTs"),
            stop_reason: string(v, "stopReason"),
            model: string(v, "model"),
        })
        .collect()
}
fn intercepts(value: Option<&Value>) -> Vec<InterceptTokenData> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| InterceptTokenData {
            id: string(v, "id"),
            ts: number(v, "ts"),
            prompt_tokens: number(v, "promptTokens"),
            completion_tokens: number(v, "completionTokens"),
            cached_tokens: number(v, "cachedTokens"),
            reasoning_tokens: number(v, "reasoningTokens"),
            total_tokens: number(v, "totalTokens"),
        })
        .collect()
}
fn run(line: u64) {
    let key = format!("L{line}:C5");
    let fixture = fixtures()
        .iter()
        .find(|v| v["source"]["id"] == key)
        .unwrap();
    // Multiple fresh maps expose nondeterministic exact-key consumption instead
    // of letting one lucky randomized HashMap order hide the source contract.
    for _ in 0..if line == 672 { 64 } else { 1 } {
        let mut entries: Vec<AgentActivityEntry> =
            serde_json::from_value(fixture["entries"].clone()).unwrap();
        let args = fixture["arguments"].as_array().unwrap();
        match fixture["operation"].as_str().unwrap() {
            "enrichCliTurn" => enrich_cli_turn(
                &mut entries,
                &segments(args.first()),
                args.get(1).and_then(Value::as_str),
                &intercepts(args.get(2)),
            ),
            "enrichCliPrimary" => enrich_cli_primary(
                &mut entries,
                args.first().and_then(Value::as_str),
                &intercepts(args.get(1)),
            ),
            "enrichCliFromSegments" => {
                enrich_cli_from_segments(&mut entries, &segments(args.first()))
            }
            "none" => {}
            other => panic!("unrecognized historical operation: {other}"),
        }
        let serialized = serde_json::to_value(&entries).unwrap();
        for assertion in fixture["assertions"].as_array().unwrap() {
            let path = assertion["path"].as_array().unwrap();
            let derived;
            let actual = if path.first().and_then(Value::as_str) == Some("@needs_fallback") {
                derived = json!(needs_cli_segment_fallback(&entries));
                Some(&derived)
            } else {
                let mut current = Some(&serialized);
                for part in path {
                    current = if let Some(index) = part.as_u64() {
                        current.and_then(|v| v.get(index as usize))
                    } else {
                        current.and_then(|v| v.get(part.as_str().unwrap()))
                    };
                }
                current
            };
            if assertion["matcher"] == "toBeUndefined" {
                let index = path[0].as_u64().unwrap() as usize;
                let absent = match path.last().and_then(Value::as_str).unwrap() {
                    // Rust uses an empty required String for an absent raw clock.
                    "time_unix_nano" => entries[index].time_unix_nano.is_empty(),
                    "gen_ai.usage.input_tokens" => entries[index].input_tokens.is_none(),
                    "gen_ai.tool.call.duration" => entries[index].tool_call_duration.is_none(),
                    other => panic!("undefined-field contract needs a typed assertion: {other}"),
                };
                assert!(
                    absent,
                    "{key}: expected absent field {path:?}, got {actual:?}"
                );
            } else if assertion["value"].is_number() {
                // JS toBe compares Number values, not serde_json's i64/f64 variants.
                assert_eq!(
                    actual.and_then(Value::as_f64),
                    assertion["value"].as_f64(),
                    "{key}: {path:?}"
                );
            } else {
                assert_eq!(actual, Some(&assertion["value"]), "{key}: {path:?}");
            }
        }
    }
}

#[test]
fn cli_l112() {
    run(112);
}

#[test]
fn cli_l142() {
    run(142);
}

#[test]
fn cli_l176() {
    run(176);
}

#[test]
fn cli_l202() {
    run(202);
}

#[test]
fn cli_l228() {
    run(228);
}

#[test]
fn cli_l250() {
    run(250);
}

#[test]
fn cli_l260() {
    run(260);
}

#[test]
fn cli_l285() {
    run(285);
}

#[test]
fn cli_l316() {
    run(316);
}

#[test]
fn cli_l346() {
    run(346);
}

#[test]
fn cli_l362() {
    run(362);
}

#[test]
fn cli_l456() {
    run(456);
}

#[test]
fn cli_l483() {
    run(483);
}

#[test]
fn cli_l515() {
    run(515);
}

#[test]
fn cli_l544() {
    run(544);
}

#[test]
fn cli_l578() {
    run(578);
}

#[test]
fn cli_l603() {
    run(603);
}

#[test]
fn cli_l642() {
    run(642);
}

#[test]
fn cli_l672() {
    run(672);
}

#[test]
fn cli_l698() {
    run(698);
}

#[test]
fn cli_l726() {
    run(726);
}

#[test]
fn cli_l738() {
    run(738);
}

#[test]
fn cli_l756() {
    run(756);
}

#[test]
fn cli_l796() {
    run(796);
}

#[test]
fn cli_l835() {
    run(835);
}
