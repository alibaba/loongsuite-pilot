//! Fixed ef8953 structural/timing contracts plus independent public helpers.
use loongsuite_pilot::inputs::qoder_trace::{
    enrich_cli_turn, enrich_ide_turn, inject_trace_id, qoder_default_allowed_root_paths,
    resolve_qoder_allowed_root_paths, SegmentTokenData, SqliteTokenData,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;

fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}
fn string(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").into()
}
fn at<'a>(serialized: &'a Value, path: &[Value]) -> Option<&'a Value> {
    let mut current = Some(serialized);
    for key in path {
        current = if let Some(i) = key.as_u64() {
            current.and_then(|v| v.get(i as usize))
        } else {
            current.and_then(|v| v.get(key.as_str().unwrap()))
        };
    }
    current
}
fn run(line: u64) {
    static DATA: OnceLock<Vec<Value>> = OnceLock::new();
    let fixtures = DATA.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/qoder-trace-ide-history.json")).unwrap()
    });
    let key = format!("L{line}:C5");
    let fixture = fixtures.iter().find(|v| v["source"]["id"] == key).unwrap();
    let mut entries: Vec<AgentActivityEntry> =
        serde_json::from_value(fixture["entries"].clone()).unwrap();
    let rows = fixture["arguments"][0]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| SqliteTokenData {
            session_id: string(v, "sessionId"),
            request_id: string(v, "requestId"),
            message_id: string(v, "messageId"),
            gmt_create: number(v, "gmtCreate"),
            input_tokens: number(v, "inputTokens"),
            output_tokens: number(v, "outputTokens"),
            cache_read_tokens: number(v, "cacheReadTokens"),
            model: v.get("model").and_then(Value::as_str).map(str::to_owned),
        })
        .collect::<Vec<_>>();
    enrich_ide_turn(&mut entries, &rows);
    let serialized = serde_json::to_value(&entries).unwrap();
    for assertion in fixture["assertions"].as_array().unwrap() {
        let path = assertion["path"].as_array().unwrap();
        let actual = at(&serialized, path);
        match assertion["matcher"].as_str().unwrap() {
            "toBeUndefined" => {
                let index = path[0].as_u64().unwrap() as usize;
                assert_eq!(path[1], "gen_ai.usage.input_tokens");
                assert!(
                    entries[index].input_tokens.is_none(),
                    "{key}: absent token field"
                );
            }
            "toBeLessThan" => {
                let other = at(&serialized, assertion["otherPath"].as_array().unwrap()).unwrap();
                let a = actual.unwrap().as_str().unwrap().parse::<i128>().unwrap();
                let b = other.as_str().unwrap().parse::<i128>().unwrap();
                assert!(a < b, "{key}: exact BigInt ordering {a} < {b}");
            }
            "toBe" | "toEqual" => {
                if assertion["value"].is_number() {
                    assert_eq!(
                        actual.and_then(Value::as_f64),
                        assertion["value"].as_f64(),
                        "{key}: {path:?}"
                    );
                } else {
                    assert_eq!(actual, Some(&assertion["value"]), "{key}: {path:?}");
                }
            }
            other => panic!("unhandled historical matcher {other}"),
        }
    }
}
fn entry(overrides: Value) -> AgentActivityEntry {
    let mut base =
        json!({"event.id":"e-1","event.name":"llm.response","gen_ai.session.id":"sess-1",
        "gen_ai.turn.id":"turn-1","gen_ai.step.id":"turn-1:s1","gen_ai.agent.type":"qoder-cli",
        "time_unix_nano":"1780000001000000000"})
        .as_object()
        .unwrap()
        .clone();
    base.extend(overrides.as_object().unwrap().clone());
    serde_json::from_value(Value::Object(base)).unwrap()
}
fn segment(reason: &str) -> SegmentTokenData {
    SegmentTokenData {
        request_id: "req-A".into(),
        request_start_ts: 1780000000000,
        response_end_ts: 1780000001000,
        stop_reason: reason.into(),
        ..Default::default()
    }
}
#[test]
fn token_l410_vendor_finish_spellings() {
    for (raw, expected) in [
        ("tool_use", "tool_call"),
        ("stop_sequence", "stop"),
        ("refusal", "stop"),
        ("model_context_window_exceeded", "length"),
    ] {
        let mut rows = vec![entry(json!({"gen_ai.response.id":"req-A"}))];
        enrich_cli_turn(&mut rows, &[segment(raw)], None, &[]);
        assert_eq!(rows[0].finish_reasons.as_ref().unwrap(), &[expected]);
    }
}
#[test]
fn token_l430_unknown_and_mid_turn_reasons_remain_absent() {
    for raw in ["pause_turn", "some_future_reason"] {
        let mut rows = vec![entry(json!({"gen_ai.response.id":"req-A"}))];
        enrich_cli_turn(&mut rows, &[segment(raw)], None, &[]);
        assert!(rows[0].finish_reasons.is_none());
    }
}
#[test]
fn token_l440_enriched_finish_reason_belongs_to_frozen_validator_enum() {
    let allowed = [
        "stop",
        "length",
        "content_filter",
        "tool_call",
        "tool_calls",
        "error",
        "end_turn",
        "max_tokens",
        "cancelled",
    ];
    let mut rows = vec![entry(json!({"gen_ai.response.id":"req-A"}))];
    enrich_cli_turn(&mut rows, &[segment("tool_use")], None, &[]);
    let reasons = rows[0].finish_reasons.as_ref().unwrap();
    assert!(!reasons.is_empty());
    for reason in reasons {
        assert!(allowed.contains(&reason.as_str()));
        assert!(loongsuite_pilot::normalization::VALID_FINISH_REASONS.contains(&reason.as_str()));
    }
}
#[test]
fn token_l1376_system_prompt_targets_first_stepped_request_only() {
    let mut rows = vec![
        entry(json!({"event.name":"other","gen_ai.step.id":null})),
        entry(json!({"event.name":"llm.request","gen_ai.response.id":"req-A"})),
        entry(json!({"gen_ai.response.id":"req-A"})),
    ];
    let s = SegmentTokenData {
        request_id: "req-A".into(),
        input_tokens: 5000,
        output_tokens: 200,
        ..Default::default()
    };
    enrich_cli_turn(&mut rows, &[s], Some("You are a helpful assistant."), &[]);
    assert_eq!(
        rows[1].system_instructions,
        Some(json!([{"type":"text","content":"You are a helpful assistant."}]))
    );
    assert!(rows[0].system_instructions.is_none());
}
#[test]
fn token_l1402_absent_system_prompt_does_not_inject() {
    let mut rows = vec![
        entry(json!({"event.name":"llm.request","gen_ai.step.id":null})),
        entry(json!({"gen_ai.response.id":"req-A"})),
    ];
    let s = SegmentTokenData {
        request_id: "req-A".into(),
        input_tokens: 100,
        output_tokens: 10,
        ..Default::default()
    };
    enrich_cli_turn(&mut rows, &[s], None, &[]);
    assert!(rows[0].system_instructions.is_none());
}
#[test]
fn token_l1427_one_turn_has_one_valid_trace_id() {
    let mut rows = vec![
        entry(json!({"event.id":"e-1"})),
        entry(json!({"event.id":"e-2"})),
        entry(json!({"event.id":"e-3"})),
    ];
    inject_trace_id(&mut rows);
    let id = rows[0].trace_id.as_ref().unwrap();
    assert_eq!(id.len(), 32);
    assert!(id
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(rows[1].trace_id.as_ref(), Some(id));
    assert_eq!(rows[2].trace_id.as_ref(), Some(id));
}
#[test]
fn token_l1442_distinct_turns_have_distinct_trace_ids() {
    let mut a = vec![entry(json!({}))];
    let mut b = vec![entry(json!({}))];
    inject_trace_id(&mut a);
    inject_trace_id(&mut b);
    assert!(a[0].trace_id.is_some() && b[0].trace_id.is_some());
    assert_ne!(a[0].trace_id, b[0].trace_id);
}
#[test]
fn token_l1454_empty_trace_injection_is_a_noop() {
    let mut rows = Vec::new();
    inject_trace_id(&mut rows);
    assert!(rows.is_empty());
}
#[test]
fn roots_l1629_default_paths_include_tmp_vibe_and_ide_images() {
    let roots: Vec<PathBuf> = qoder_default_allowed_root_paths()
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let home = PathBuf::from(loongsuite_pilot::utils::resolve_home("~"));
    for tail in [".qoder/tmp", ".qoder/vibe_images"] {
        assert!(roots.contains(&home.join(tail)));
    }
    let app = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Qoder")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Qoder")
    } else {
        home.join(".config/Qoder")
    };
    assert!(roots.contains(&app.join("SharedClientCache").join("cache").join("images")));
}
#[test]
fn roots_l1641_custom_roots_are_canonicalized_together_with_defaults() {
    use loongsuite_pilot::multimodal::resolve::canonicalize_root_path;
    let merged = resolve_qoder_allowed_root_paths(&["~/Documents".into()]);
    let default = loongsuite_pilot::utils::resolve_home("~/.qoder/tmp");
    assert!(merged.contains(&canonicalize_root_path(&default)));
    assert!(merged.contains(&canonicalize_root_path("~/Documents")));
}

#[test]
fn ide_l866() {
    run(866);
}

#[test]
fn ide_l948() {
    run(948);
}

#[test]
fn ide_l1005() {
    run(1005);
}

#[test]
fn ide_l1094() {
    run(1094);
}

#[test]
fn ide_l1157() {
    run(1157);
}

#[test]
fn ide_l1208() {
    run(1208);
}

#[test]
fn ide_l1263() {
    run(1263);
}

#[test]
fn ide_l1286() {
    run(1286);
}

#[test]
fn ide_l1320() {
    run(1320);
}

#[test]
fn ide_l1342() {
    run(1342);
}

#[test]
fn ide_l1363() {
    run(1363);
}
