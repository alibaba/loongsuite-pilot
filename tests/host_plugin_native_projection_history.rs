//! Agent-host plugins remain JavaScript; their Collector projection is native.
//! Inputs were tapped, without edits, at the five original tests' converter
//! boundary while every original assertion still executed and passed.
use loongsuite_pilot::flushers::{
    ConvertOptions, ConvertResult, EventLogConverter, GenAiEventLogConverter, ReadableSpan,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn fixture_records(title: &str) -> Vec<AgentActivityEntry> {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/host-plugin-native-projections.json")).unwrap();
    let fixture = fixtures
        .iter()
        .find(|v| v["name"].as_str().unwrap().ends_with(title))
        .unwrap();
    // Do not let a stale projection fixture silently bless changed host assets.
    for asset in fixture["assets"].as_array().unwrap() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(asset["path"].as_str().unwrap());
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(path).unwrap())),
            asset["sha256"].as_str().unwrap(),
            "regenerate via the real host tests after asset changes"
        );
    }
    let records: Vec<AgentActivityEntry> =
        serde_json::from_value(fixture["records"].clone()).unwrap();
    assert!(!records.is_empty());
    records
}
fn project(title: &str) -> ConvertResult {
    GenAiEventLogConverter
        .convert(&fixture_records(title), &ConvertOptions::default())
        .unwrap()
}
fn kind<'a>(result: &'a ConvertResult, name: &str) -> Vec<&'a ReadableSpan> {
    result
        .spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!(name)))
        .collect()
}
fn input(span: &ReadableSpan) -> Value {
    serde_json::from_str(span.attributes["gen_ai.input.messages"].as_str().unwrap()).unwrap()
}
fn duration(span: &ReadableSpan) -> i128 {
    let nano = |t: [i64; 2]| i128::from(t[0]) * 1_000_000_000 + i128::from(t[1]);
    nano(span.end_time) - nano(span.start_time)
}
#[test]
fn mimo_l233_real_plugin_later_llm_spans_keep_first_user_message() {
    let r = project("preserves the first user message in later converted LLM spans");
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let mut llm = kind(&r, "LLM");
    llm.sort_by_key(|s| s.start_time);
    assert_eq!(llm.len(), 5);
    let messages = input(llm[1]);
    let user = messages
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "user")
        .unwrap();
    assert!(user["parts"][0]["content"]
        .as_str()
        .unwrap()
        .contains("List py files"));
}
#[test]
fn pi_l278_real_plugin_turn_delta_populates_native_entry_and_agent() {
    let r = project("emits one turn-level input delta that populates ENTRY and AGENT spans");
    let expected = json!([{"role":"user","parts":[{"type":"text","content":"Inspect the repository"}]},{"role":"user","parts":[{"type":"text","content":"Injected context"}]}]);
    for k in ["ENTRY", "AGENT"] {
        let spans = kind(&r, k);
        assert_eq!(spans.len(), 1);
        assert_eq!(input(spans[0]), expected);
    }
}
#[test]
fn pi_l531_real_plugin_same_millisecond_llm_has_positive_native_duration() {
    let r = project("keeps an LLM response strictly later than a request in the same millisecond");
    let llm = kind(&r, "LLM");
    assert_eq!(llm.len(), 1);
    assert!(duration(llm[0]) >= 1_000_000);
}
#[test]
fn pi_l593_real_plugin_fallback_response_has_request_and_no_orphan_warning() {
    let r = project("emits a fallback LLM request when a response arrives without context");
    let llm = kind(&r, "LLM");
    assert_eq!(llm.len(), 1);
    assert!(duration(llm[0]) >= 1_000_000);
    assert!(
        r.warnings
            .iter()
            .all(|w| !w.to_lowercase().contains("orphan")),
        "{:?}",
        r.warnings
    );
}
#[test]
fn pi_l682_real_plugin_same_millisecond_tool_has_positive_native_duration() {
    let r = project("keeps a tool result strictly later than a call in the same millisecond");
    let tool = kind(&r, "TOOL");
    assert_eq!(tool.len(), 1);
    assert!(duration(tool[0]) >= 1_000_000);
}

#[test]
fn pi_turn_declaration_does_not_truncate_native_llm_full_context() {
    let r = project("emits one turn-level input delta that populates ENTRY and AGENT spans");
    let llm = kind(&r, "LLM");
    assert_eq!(llm.len(), 1);
    assert_eq!(
        input(llm[0]),
        json!([
            {"role":"user","parts":[{"type":"text","content":"old prompt"}]},
            {"role":"assistant","parts":[{"type":"text","content":"old response"}]},
            {"role":"user","parts":[{"type":"text","content":"Inspect the repository"}]},
            {"role":"user","parts":[{"type":"text","content":"Injected context"}]}
        ])
    );
}
#[test]
fn registered_pi_sdk_identity_uses_its_own_explicit_turn_input() {
    let records =
        fixture_records("emits one turn-level input delta that populates ENTRY and AGENT spans")
            .into_iter()
            .map(|r| {
                let mut v = serde_json::to_value(r).unwrap();
                v["gen_ai.agent.type"] = json!("acme-code");
                v["gen_ai.agent.id"] = json!("acme-code");
                serde_json::from_value(v).unwrap()
            })
            .collect::<Vec<AgentActivityEntry>>();
    let r = GenAiEventLogConverter
        .convert(&records, &ConvertOptions::default())
        .unwrap();
    let expected = json!([{"role":"user","parts":[{"type":"text","content":"Inspect the repository"}]},{"role":"user","parts":[{"type":"text","content":"Injected context"}]}]);
    for k in ["ENTRY", "AGENT"] {
        let spans = kind(&r, k);
        assert_eq!(spans.len(), 1);
        assert_eq!(input(spans[0]), expected);
    }
    assert_eq!(input(kind(&r, "LLM")[0]).as_array().unwrap().len(), 4);
}
