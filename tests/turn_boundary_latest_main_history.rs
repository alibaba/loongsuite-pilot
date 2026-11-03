//! Exact changed/new Codex normalization contracts from main.
use loongsuite_pilot::normalization::{
    build_agent_activity_entry, is_terminal_turn_entry, TurnBoundaryProcessor,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
fn entry(id: &str, event: &str, extra: Value) -> AgentActivityEntry {
    let mut row = json!({
        "event.id":id,"event.name":event,"gen_ai.agent.type":"codex",
        "gen_ai.session.id":"parent-session","gen_ai.turn.id":"turn-1"
    });
    row.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    build_agent_activity_entry(&row)
}
#[test]
fn main_codex_turn_end_only_uses_an_explicit_native_marker() {
    let mut processor = TurnBoundaryProcessor::new();
    let mut response = [entry(
        "response",
        "llm.response",
        json!({"gen_ai.response.finish_reasons":["stop"]}),
    )];
    let mut terminal = [entry(
        "terminal",
        "other",
        json!({"agent.codex.turn_status":"completed","gen_ai.turn.end":true}),
    )];
    processor.enrich(&mut response);
    processor.enrich(&mut terminal);
    assert_eq!(response[0].turn_start, None);
    assert_eq!(response[0].turn_end, None);
    assert_eq!(terminal[0].turn_start, None);
    assert_eq!(terminal[0].turn_end, Some(true));
}
#[test]
fn main_codex_status_completed_or_interrupted_never_infers_root_or_child_end() {
    for status in ["completed", "interrupted"] {
        for scope in ["root", "subagent"] {
            let mut row = entry(
                "status-only",
                "llm.response",
                json!({
                    "gen_ai.agent.scope":scope,"agent.codex.turn_status":status,
                    "gen_ai.response.finish_reasons":["stop"]
                }),
            );
            TurnBoundaryProcessor::new().enrich(std::slice::from_mut(&mut row));
            assert_eq!(row.turn_start, None);
            assert_eq!(row.turn_end, None);
            assert!(!is_terminal_turn_entry(&row));
        }
    }
}
#[test]
fn main_codex_child_explicit_boundaries_remain_independent_after_parent_end() {
    let mut processor = TurnBoundaryProcessor::new();
    let mut child = [entry(
        "child-response",
        "llm.response",
        json!({
            "gen_ai.session.id":"child-session","gen_ai.turn.id":"child-session:turn",
            "gen_ai.agent.scope":"subagent","gen_ai.response.finish_reasons":["stop"]
        }),
    )];
    let mut parent = [entry(
        "root-terminal",
        "other",
        json!({"agent.codex.turn_status":"completed","gen_ai.turn.end":true}),
    )];
    processor.enrich(&mut child);
    processor.enrich(&mut parent);
    assert_eq!(child[0].turn_start, None);
    assert_eq!(child[0].turn_end, None);
    assert_eq!(parent[0].turn_start, None);
    assert_eq!(parent[0].turn_end, Some(true));
    let mut end = entry(
        "child-terminal",
        "other",
        json!({
            "gen_ai.agent.scope":"subagent","gen_ai.session.id":"child-session",
            "gen_ai.turn.id":"child-session:turn","agent.codex.turn_status":"completed",
            "gen_ai.turn.end":true
        }),
    );
    processor.enrich(std::slice::from_mut(&mut end));
    assert_eq!(end.turn_start, None);
    assert_eq!(end.turn_end, Some(true));
    assert!(is_terminal_turn_entry(&end));
}
#[test]
fn main_codex_native_start_is_not_repeated_on_a_fresh_process_suffix() {
    let mut first = [entry(
        "native-prompt",
        "other",
        json!({"gen_ai.turn.start":true}),
    )];
    TurnBoundaryProcessor::new().enrich(&mut first);
    let mut suffix = [
        entry("restored-request", "llm.request", json!({})),
        entry(
            "native-terminal",
            "other",
            json!({"agent.codex.turn_status":"completed","gen_ai.turn.end":true}),
        ),
    ];
    TurnBoundaryProcessor::new().enrich(&mut suffix);
    assert_eq!(first[0].turn_start, Some(true));
    assert_eq!(suffix[0].turn_start, None);
    assert_eq!(suffix[1].turn_start, None);
    assert_eq!(suffix[1].turn_end, Some(true));
}
