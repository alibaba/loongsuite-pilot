//! Independent f84 JavaScript fixture, exercised through the actual native validators.
use super::*;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/trace-delegated-history.json"
    ))
    .unwrap()
}
fn checks(value: &Value) -> Vec<Check> {
    let spans: Vec<Span> = serde_json::from_value(value.clone()).unwrap();
    let rules: Rules =
        serde_json::from_str(include_str!("../../../docs/trace-validation-rules.json")).unwrap();
    let trace = Trace::new(spans.iter().collect());
    let mut checks = structure(&trace);
    checks.extend(timing(&trace, &rules));
    checks.extend(semantics::validate(&trace, &rules));
    checks
}
fn has(checks: &[Check], id: &str, status: &str) -> bool {
    checks.iter().any(|c| c.id == id && c.status == status)
}
fn no_errors(checks: &[Check]) {
    assert!(
        checks.iter().all(|c| c.status != "error"),
        "{}",
        serde_json::to_string(checks).unwrap()
    );
}

#[test]
fn history_independent_child_turns_overlap_and_finish_after_the_parent() {
    let result = checks(&fixtures()["base"]);
    no_errors(&result);
    for id in [
        "time.chronological_steps",
        "semantic.entry_output_matches",
        "semantic.consistent_agent_name",
    ] {
        assert!(!has(&result, id, "warn"), "{id}");
    }
}
#[test]
fn history_nested_delegation_excludes_descendant_usage_and_keeps_real_containment() {
    let f = fixtures();
    // The frozen upstream positive shortened STEP to30 but left its LLM at150.
    // Both actual upstream JS and native validators correctly reject that input.
    let original = checks(&f["nested_invalid_original"]);
    assert!(has(&original, "time.parent_contains_children", "error"));
    no_errors(&checks(&f["nested_repaired"]));
}
#[test]
fn history_external_fragment_requires_context_and_reports_the_boundary() {
    let f = fixtures();
    let valid = checks(&f["external_valid"]);
    no_errors(&valid);
    assert!(has(&valid, "structure.external_parent_context", "warn"));
    assert!(has(
        &checks(&f["external_missing_context"]),
        "structure.agent_under_entry",
        "error"
    ));
}
#[test]
fn history_zero_external_parent_cannot_establish_delegation() {
    let result = checks(&fixtures()["external_zero"]);
    for id in ["structure.single_entry", "structure.agent_under_entry"] {
        assert!(has(&result, id, "error"), "{id}");
    }
    assert!(!result
        .iter()
        .any(|c| c.id == "structure.external_parent_context"));
}
#[test]
fn history_both_child_identity_corruptions_point_at_its_own_agent() {
    let f = fixtures();
    for (key, id) in [
        ("gen_ai.session.id", "semantic.consistent_session_id"),
        ("gen_ai.turn.id", "semantic.consistent_turn_id"),
    ] {
        let variant = &f["corrupt"][key];
        let result = checks(&variant["spans"]);
        assert!(
            result.iter().any(|c| c.id == id
                && c.status == "error"
                && c.span_id.as_deref() == variant["agentId"].as_str()),
            "{id}"
        );
    }
}
#[test]
fn history_within_execution_overlap_tokens_and_unfinished_final_tool_still_fail() {
    let result = checks(&fixtures()["invalid_execution"]);
    for id in [
        "time.no_step_overlap",
        "semantic.agent_token_sum",
        "semantic.last_step_no_tool_call",
    ] {
        assert!(has(&result, id, "error"), "{id}");
    }
    assert!(has(&result, "time.chronological_steps", "warn"));
}
#[test]
fn history_ordinary_containment_and_delegated_causal_start_both_remain_required() {
    let f = fixtures();
    let variant = &f["invalid_containment"];
    let result = checks(&variant["spans"]);
    let ids: Vec<_> = result
        .iter()
        .filter(|c| c.id == "time.parent_contains_children" && c.status == "error")
        .filter_map(|c| c.span_id.as_deref())
        .collect();
    for expected in variant["expected"].as_array().unwrap() {
        assert!(ids.contains(&expected.as_str().unwrap()));
    }
}
#[test]
fn history_agent_under_step_and_duplicate_entry_roots_are_still_invalid() {
    let result = checks(&fixtures()["invalid_structure"]);
    for id in ["structure.agent_under_entry", "structure.single_agent"] {
        assert!(has(&result, id, "error"), "{id}");
    }
}
