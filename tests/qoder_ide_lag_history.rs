use loongsuite_pilot::inputs::qoder_trace::{enrich_ide_turn, SqliteTokenData};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::json;
const B: i64 = 1783308010000;
fn turn(times: &[i64], matches: &[Option<i64>]) -> Vec<AgentActivityEntry> {
    times.iter().enumerate().map(|(i,t)|{let mut v=json!({"event.id":format!("resp-{i}"),"event.name":"llm.response","gen_ai.session.id":"sess-1","gen_ai.turn.id":"turn-1","gen_ai.step.id":format!("turn-1:s{}",i+1),"gen_ai.agent.type":"qoder","gen_ai.request.model":"auto","gen_ai.response.model":"auto","time_unix_nano":(*t as i128*1000000).to_string()});if let Some(Some(t))=matches.get(i){v["agent.qoder.match_ts"]=json!(t);}serde_json::from_value(v).unwrap()}).collect()
}
fn rows(specs: &[(i64, &str, i64, i64)]) -> Vec<SqliteTokenData> {
    specs
        .iter()
        .map(|(at, id, input, output)| SqliteTokenData {
            session_id: "sess-1".into(),
            request_id: "req-1".into(),
            message_id: (*id).into(),
            gmt_create: *at,
            input_tokens: *input,
            output_tokens: *output,
            cache_read_tokens: 0,
            model: Some("ultimate".into()),
        })
        .collect()
}
fn pair() -> Vec<AgentActivityEntry> {
    let response = turn(&[1783308010437], &[]).remove(0);
    let mut request = serde_json::to_value(&response).unwrap();
    request["event.id"] = json!("req-1");
    request["event.name"] = json!("llm.request");
    request
        .as_object_mut()
        .unwrap()
        .remove("gen_ai.response.model");
    vec![serde_json::from_value(request).unwrap(), response]
}
#[test]
fn lag_l41_empty_sqlite_leaves_response_id_model_and_usage_uninvented() {
    let mut entries = pair();
    enrich_ide_turn(&mut entries, &[]);
    let r = &entries[1];
    assert!(r.response_id.is_none());
    assert_eq!(r.response_model.as_deref(), Some("auto"));
    assert!(r.total_tokens.is_none());
}
#[test]
fn lag_l52_partial_sqlite_does_not_misattribute_unmatched_late_response() {
    let mut entries = turn(&[1783308010400, 1783308055000], &[]);
    enrich_ide_turn(&mut entries, &rows(&[(1783308010200, "msg-1", 100, 20)]));
    let r = &entries[1];
    assert!(r.response_id.is_none());
    assert_eq!(r.response_model.as_deref(), Some("auto"));
    assert_eq!(r.total_tokens, Some(0));
}
#[test]
fn lag_l86_aligned_sqlite_supplies_real_response_model_id_and_conserved_usage() {
    let mut entries = pair();
    let mut row = rows(&[(1783308010189, "msg-good", 34824, 1272)]);
    row[0].request_id = "req-good".into();
    row[0].cache_read_tokens = 30000;
    enrich_ide_turn(&mut entries, &row);
    assert_eq!(entries[1].response_id.as_deref(), Some("msg-good"));
    assert_eq!(entries[1].response_model.as_deref(), Some("ultimate"));
    assert_eq!(entries[1].total_tokens, Some(34824 + 1272));
}
#[test]
fn lag_l151_extra_sqlite_rows_aggregate_tail_into_last_real_response() {
    let mut entries = turn(&[B + 200, B + 10200, B + 20200], &[]);
    enrich_ide_turn(
        &mut entries,
        &rows(&[
            (B, "m1", 100, 10),
            (B + 10000, "m2", 100, 10),
            (B + 20000, "m3", 100, 10),
            (B + 30000, "m4", 100, 10),
        ]),
    );
    assert_eq!(entries[0].response_id.as_deref(), Some("m1"));
    assert_eq!(entries[1].response_id.as_deref(), Some("m2"));
    assert_eq!(entries[2].response_id.as_deref(), Some("m4"));
    assert_eq!(entries[2].total_tokens, Some(220));
    assert_eq!(
        entries[2].extra["agent.qoder.usage_match_mode"],
        "aggregated_tail"
    );
    assert_eq!(entries[2].extra["agent.qoder.sqlite_row_count"], 2);
    assert!(entries
        .iter()
        .all(|r| r.response_model.as_deref() == Some("ultimate")));
}
#[test]
fn lag_l171_missing_latest_sqlite_row_leaves_last_response_zero_with_no_id() {
    let mut entries = turn(&[B + 200, B + 10200, B + 20200, B + 30200], &[]);
    enrich_ide_turn(
        &mut entries,
        &rows(&[
            (B, "m1", 100, 10),
            (B + 10000, "m2", 100, 10),
            (B + 20000, "m3", 100, 10),
        ]),
    );
    assert_eq!(entries[0].response_id.as_deref(), Some("m1"));
    assert_eq!(entries[2].response_id.as_deref(), Some("m3"));
    assert!(entries[3].response_id.is_none());
    assert_eq!(entries[3].response_model.as_deref(), Some("auto"));
    assert_eq!(entries[3].total_tokens, Some(0));
}
#[test]
fn lag_l189_short_sqlite_prefix_applies_by_order_without_timestamp_guessing() {
    let mut entries = turn(&[B + 200, B + 10200, B + 20200], &[]);
    enrich_ide_turn(
        &mut entries,
        &rows(&[(B, "m1", 100, 10), (B + 20000, "m3", 100, 10)]),
    );
    assert_eq!(entries[0].response_id.as_deref(), Some("m1"));
    assert_eq!(entries[1].response_id.as_deref(), Some("m3"));
    assert!(entries[2].response_id.is_none());
}
#[test]
fn lag_l203_ordered_match_ignores_response_drift_with_and_without_hook_match_timestamp() {
    let mut matched = turn(&[B + 6000, B + 60000], &[Some(B), None]);
    enrich_ide_turn(&mut matched, &rows(&[(B, "m1", 100, 10)]));
    assert_eq!(matched[0].response_id.as_deref(), Some("m1"));
    assert_eq!(matched[0].total_tokens, Some(110));
    let mut plain = turn(&[B + 6000, B + 60000], &[]);
    enrich_ide_turn(&mut plain, &rows(&[(B, "m1", 100, 10)]));
    assert_eq!(plain[0].response_id.as_deref(), Some("m1"));
}
#[test]
fn lag_l214_accurate_current_hook_timestamp_rejects_stale_prior_turn_usage() {
    let mut entries = turn(&[B + 60000], &[Some(B + 60000)]);
    enrich_ide_turn(&mut entries, &rows(&[(B, "old-turn-row", 999, 99)]));
    assert!(entries[0].response_id.is_none());
    assert_eq!(entries[0].total_tokens, Some(0));
}
