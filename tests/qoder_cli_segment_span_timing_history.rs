//! Historical two-case integration contract: real segment files -> native
//! token reader -> enrichment -> production event-to-span converter.
use loongsuite_pilot::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
use loongsuite_pilot::inputs::qoder_trace::{
    enrich_cli_turn, read_segment_tokens_for_session, SegmentTokenData,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
const SESSION: &str = "session-span-timing";
const BASE: i64 = 1_780_000_000_000;

fn ns(ms: i64) -> String {
    (i128::from(ms) * 1_000_000).to_string()
}
fn step(id: &str, request: &str, hook_ms: i64) -> Vec<AgentActivityEntry> {
    ["llm.request", "llm.response"]
        .into_iter()
        .map(|event| {
            let mut row = json!({
                "event.name":event,"time_unix_nano":ns(hook_ms),
                "trace_id":"1234567890abcdef1234567890abcdef",
                "gen_ai.session.id":SESSION,"gen_ai.turn.id":format!("{SESSION}:turn-1"),
                "gen_ai.agent.type":"qoder-cli","gen_ai.agent.id":SESSION,
                "gen_ai.provider.name":"anthropic","gen_ai.request.model":"auto",
                "gen_ai.step.id":id
            });
            if event == "llm.response" {
                row["agent.client_request_id"] = json!(request);
                row["gen_ai.response.finish_reasons"] = json!(["stop"]);
            }
            serde_json::from_value(row).unwrap()
        })
        .collect()
}
async fn segments(root: &Path, rows: &[Value]) -> Vec<SegmentTokenData> {
    let source = root.join(".qoder/logs/sessions");
    let dir = source
        .join("Users-someone-project")
        .join(SESSION)
        .join("segments");
    fs::create_dir_all(&dir).unwrap();
    let mut text = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    text.push('\n');
    fs::write(dir.join("segment-0.jsonl"), text).unwrap();
    read_segment_tokens_for_session(SESSION, &[], source.to_str().unwrap()).await
}
fn ms(hr: [i64; 2]) -> i64 {
    hr[0] * 1000 + (hr[1] + 500_000) / 1_000_000
}

#[tokio::test]
async fn segment_l87_real_reader_enrichment_and_converter_keep_exact_measured_llm_widths() {
    let temp = tempfile::tempdir().unwrap();
    let got=segments(temp.path(),&[
        json!({"type":"loop.iteration.started","loop_id":"turn-1:1","ts":BASE}),
        json!({"type":"model.request.started","request_id":"req-1","loop_id":"turn-1:1","ts":BASE+4}),
        json!({"type":"model.response.completed","request_id":"req-1","loop_id":"turn-1:1","ts":BASE+9000,
            "data":{"input_tokens":100,"output_tokens":20,"model":"claude-sonnet-4"}}),
        json!({"type":"loop.iteration.started","loop_id":"turn-1:2","ts":BASE+20000}),
        json!({"type":"model.request.started","request_id":"req-2a","loop_id":"turn-1:2","ts":BASE+20002}),
        json!({"type":"model.request.attempt_failed","request_id":"req-2a","loop_id":"turn-1:2","ts":BASE+80028}),
        json!({"type":"model.response.completed","request_id":"req-2b","loop_id":"turn-1:2","ts":BASE+88127,
            "data":{"input_tokens":300,"output_tokens":40,"model":"claude-sonnet-4"}}),
    ]).await;
    assert_eq!(
        got.iter()
            .map(|r| r.request_id.as_str())
            .collect::<Vec<_>>(),
        ["req-1", "req-2b"]
    );
    let mut rows = step(&format!("{SESSION}:turn-1:s1"), "req-1", BASE + 9000);
    rows.extend(step(
        &format!("{SESSION}:turn-1:s2"),
        "req-2b",
        BASE + 88127,
    ));
    enrich_cli_turn(&mut rows, &got, None, &[]);
    let options = ConvertOptions {
        strict: false,
        passthrough_keys: vec!["gen_ai.agent.id".into(), "agent.client_request_id".into()],
    };
    let converted = GenAiEventLogConverter.convert(&rows, &options).unwrap();
    let spans = converted
        .spans
        .iter()
        // Native STEP spans also retain step.id. Select the actual LLM
        // leaves, then keep the historical exact width assertion unchanged.
        .filter(|s| s.attributes.get("gen_ai.span.kind").and_then(Value::as_str) == Some("LLM"))
        .collect::<Vec<_>>();
    assert_eq!(spans.len(), 2);
    for span in &spans {
        assert_eq!(span.attributes["gen_ai.operation.name"], "chat");
        assert!(span.attributes.contains_key("gen_ai.step.id"));
    }
    let mut durations = spans
        .iter()
        .map(|s| ms(s.end_time) - ms(s.start_time))
        .collect::<Vec<_>>();
    durations.sort();
    assert_eq!(durations, [8099, 8996]);
    assert!(durations.iter().all(|d| *d > 0));
}
#[tokio::test]
async fn segment_l131_orphan_completion_enriches_usage_and_keeps_original_hook_clock() {
    let temp = tempfile::tempdir().unwrap();
    let got = segments(
        temp.path(),
        &[
            json!({"type":"model.response.completed","request_id":"req-orphan","ts":BASE+5000,
            "data":{"input_tokens":100,"output_tokens":20,"model":"claude-sonnet-4"}}),
        ],
    )
    .await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].request_start_ts, 0);
    let mut rows = step(&format!("{SESSION}:turn-1:s1"), "req-orphan", BASE + 1234);
    enrich_cli_turn(&mut rows, &got, None, &[]);
    assert_eq!(rows[1].input_tokens, Some(100));
    assert_eq!(
        serde_json::to_value(&rows[1]).unwrap()["gen_ai.usage.input_tokens"],
        100
    );
    for row in &rows {
        assert_eq!(row.time_unix_nano, ns(BASE + 1234));
    }
}
