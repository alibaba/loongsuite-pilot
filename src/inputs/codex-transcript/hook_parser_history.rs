//! Legacy hook parser responsibilities now owned by the native scanner/extractor.
use super::super::scan::{scan_json_lines, ScanStats};
use super::*;
use serde_json::json;

const THREE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/hooks/codex/fixtures/transcript-three-turns.jsonl"
));
const SINGLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/hooks/codex/fixtures/transcript-single-turn.jsonl"
));
const MULTI: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/hooks/codex/fixtures/transcript-multi-step.jsonl"
));
const TURNS: [&str; 3] = [
    "019e5e3f-9984-7663-8637-0940a4bbeb4f",
    "019e5e46-0d03-7b91-9084-cde6caab321c",
    "019e5e46-333e-7d41-b168-89e806098d9c",
];

struct Scanned {
    _root: tempfile::TempDir,
    path: String,
    size: i64,
    stats: ScanStats,
    records: Vec<CodexTranscriptSourceRecord>,
}
impl Scanned {
    async fn new(contents: &str) -> Self {
        let root = tempfile::tempdir().expect("synthetic source root");
        let path = root.path().join("rollout-native-parser.jsonl");
        tokio::fs::write(&path, contents)
            .await
            .expect("immutable fixture copy");
        let path = path.to_string_lossy().into_owned();
        let mut records = Vec::new();
        let stats = scan_json_lines(&path, 0, contents.len() as i64, None, |line| {
            records.push(CodexTranscriptSourceRecord {
                start_offset: line.start_offset,
                end_offset: line.end_offset,
                record: line.record,
            });
            true
        })
        .await
        .expect("production scanner");
        Self {
            _root: root,
            path,
            size: contents.len() as i64,
            stats,
            records,
        }
    }
    fn extract(
        &self,
        turn: &str,
        previous_cumulative: Option<f64>,
    ) -> CodexExtractedTranscriptTurn {
        let meta = self
            .records
            .iter()
            .find_map(|source| extract_codex_transcript_meta(&source.record));
        let options = ExtractOptions {
            require_terminal: true,
            last_cumulative_token_total: previous_cumulative,
            ..ExtractOptions::default()
        };
        extract_codex_partial_turn_with_boundaries(
            &self.records,
            meta.as_ref(),
            "native-parser-session",
            turn,
            &options,
        )
        .expect("native terminal extraction")
        .turn
    }
}
fn three_turns(read: &Scanned) -> Vec<CodexExtractedTranscriptTurn> {
    // These are the exact prior cumulative totals from the immutable source.
    // Native typed extraction receives the incremental usage cursor in options,
    // replacing the old parseTranscript(initialLastUsage) container argument.
    [None, Some(18_629.0), Some(37_522.0)]
        .into_iter()
        .zip(TURNS)
        .map(|(previous, turn)| read.extract(turn, previous))
        .collect()
}
#[tokio::test]
async fn parser_l19_full_native_scan_reports_the_exact_original_fixture_eof() {
    let read = Scanned::new(THREE).await;
    assert_eq!(read.stats.next_offset, read.size);
    assert_eq!(read.stats.parse_success_records, 16);
    assert_eq!(read.stats.parse_failed_records, 0);
}
#[tokio::test]
async fn parser_l25_l33_l41_l64_typed_turn_usage_preserves_exact_values_order_and_global_heartbeat_cursor(
) {
    let read = Scanned::new(THREE).await;
    let turns = three_turns(&read);
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.transcript_turn_id.as_str())
            .collect::<Vec<_>>(),
        TURNS
    );
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.unmatched_token_usages.len())
            .collect::<Vec<_>>(),
        vec![1, 1, 1]
    );
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.unmatched_token_usages[0].input_tokens)
            .collect::<Vec<_>>(),
        vec![18391.0, 18640.0, 18904.0]
    );
    assert_eq!(
        turns
            .iter()
            .flat_map(|turn| turn.unmatched_token_usages.iter())
            .count(),
        3
    );
    assert_eq!(
        turns
            .last()
            .expect("last")
            .unmatched_token_usages
            .last()
            .expect("last usage")
            .input_tokens,
        18904.0
    );
    assert!(turns
        .iter()
        .all(|turn| turn.status == CodexTerminalStatus::Completed));
    assert!(
        turns
            .iter()
            .all(|turn| turn.steps.iter().all(|step| !step.has_response_evidence)),
        "token-only fixture must not invent a model response"
    );
    let source_counts = read
        .records
        .iter()
        .filter(|source| {
            source
                .record
                .get("payload")
                .and_then(|p| p.get("type"))
                .and_then(Value::as_str)
                == Some("token_count")
        })
        .count();
    assert_eq!(
        source_counts, 6,
        "source contains one null-info event plus five usage events"
    );
}
#[tokio::test]
async fn parser_l51_l58_actual_incremental_scan_at_or_beyond_eof_returns_no_records_or_replay() {
    let read = Scanned::new(THREE).await;
    for offset in [read.stats.next_offset, read.size + 1] {
        let mut count = 0;
        let result = scan_json_lines(&read.path, offset, read.size, None, |_| {
            count += 1;
            true
        })
        .await
        .expect("actual incremental scan");
        assert_eq!(count, 0);
        assert_eq!(result.records, 0);
        assert_eq!(result.next_offset, offset);
    }
    assert_eq!(read.stats.next_offset, read.size);
}
#[tokio::test]
async fn parser_l75_native_typed_metadata_preserves_both_base_and_developer_instructions() {
    let read = Scanned::new(THREE).await;
    let first = read.extract(TURNS[0], None);
    assert_eq!(
        first.base_instructions.as_deref(),
        Some("[REDACTED system prompt]")
    );
    assert_eq!(first.developer_instructions.as_deref(), Some("[REDACTED]"));
}
#[tokio::test]
async fn parser_l84_single_turn_original_fixture_is_parsed_with_usage_model_and_tools() {
    let read = Scanned::new(SINGLE).await;
    assert_eq!(read.stats.next_offset, read.size);
    let turn = read.extract("single-turn-id", None);
    assert_eq!(turn.status, CodexTerminalStatus::Completed);
    assert_eq!(turn.model, "gpt-5.5");
    assert_eq!(turn.unmatched_token_usages.len(), 1);
    assert_eq!(turn.unmatched_token_usages[0].input_tokens, 100.0);
    assert_eq!(turn.base_instructions.as_deref(), Some("system prompt"));
    assert_eq!(
        turn.developer_instructions.as_deref(),
        Some("developer prompt")
    );
    assert_eq!(
        turn.tool_definitions,
        Some(
            json!([{"namespace":"automation","name":"update","description":"manage automations","inputSchema":{}}])
        )
    );
}
#[tokio::test]
async fn parser_l90_multistep_original_fixture_preserves_both_unmatched_usage_records() {
    let read = Scanned::new(MULTI).await;
    assert_eq!(read.stats.next_offset, read.size);
    let turn = read.extract("multistep-turn", None);
    assert_eq!(turn.status, CodexTerminalStatus::Completed);
    assert_eq!(
        turn.unmatched_token_usages
            .iter()
            .map(|usage| usage.input_tokens)
            .collect::<Vec<_>>(),
        vec![200.0, 300.0]
    );
}
#[tokio::test]
async fn parser_l186_native_terminal_representation_preserves_the_exact_aborted_turn_id() {
    let records=[
        json!({"timestamp":"2026-05-27T10:00:00Z","type":"turn_context","payload":{"turn_id":"turn-aborted","model":"gpt-5.5"}}),
        json!({"timestamp":"2026-05-27T10:00:01Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-aborted","reason":"interrupted"}})
    ].iter().map(|record|record.to_string()+"\n").collect::<String>();
    let read = Scanned::new(&records).await;
    let turn = read.extract("turn-aborted", None);
    assert_eq!(turn.transcript_turn_id, "turn-aborted");
    assert_eq!(turn.status, CodexTerminalStatus::Interrupted);
    assert_eq!(turn.terminal_at_ms, 1_779_876_001_000.0);
}
#[tokio::test]
async fn parser_l97_native_extraction_retains_all_tool_variants_raw_payloads_results_and_parent_ids(
) {
    let patch = "*** Begin Patch\n*** End Patch";
    let rows = [
        json!({"timestamp":"2026-05-27T10:00:00Z","type":"turn_context","payload":{"turn_id":"turn-1","model":"gpt-5.5"}}),
        json!({"timestamp":"2026-05-27T10:00:01Z","type":"response_item","payload":{"type":"function_call","name":"write_stdin","call_id":"call-fn","arguments":json!({"session_id":1,"chars":"q"}).to_string()}}),
        json!({"timestamp":"2026-05-27T10:00:02Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-fn","output":json!({"ok":true}).to_string()}}),
        json!({"timestamp":"2026-05-27T10:00:03Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"call-patch","input":patch}}),
        json!({"timestamp":"2026-05-27T10:00:04Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-patch","output":"ok"}}),
        json!({"timestamp":"2026-05-27T10:00:05Z","type":"response_item","payload":{"type":"web_search_call","status":"completed","action":{"type":"search","query":"codex hooks","queries":["codex hooks"]}}}),
        json!({"timestamp":"2026-05-27T10:00:06Z","type":"response_item","payload":{"type":"tool_search_call","call_id":"call-search","status":"completed","execution":"client","arguments":{"query":"browser mcp","limit":10}}}),
        json!({"timestamp":"2026-05-27T10:00:07Z","type":"response_item","payload":{"type":"tool_search_output","call_id":"call-search","status":"completed","execution":"client","tools":[{"name":"browser.open"}]}}),
    ];
    let read = Scanned::new(
        &rows
            .iter()
            .map(|record| record.to_string() + "\n")
            .collect::<String>(),
    )
    .await;
    let extraction = extract_codex_partial_turn_with_boundaries(
        &read.records,
        None,
        "native-parser-session",
        "turn-1",
        &ExtractOptions::default(),
    )
    .expect("actual partial tool extraction");
    let tools = extraction
        .turn
        .steps
        .iter()
        .flat_map(|step| step.tools.iter())
        .collect::<Vec<_>>();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["write_stdin", "apply_patch", "web_search", "tool_search"]
    );
    let find = |id: &str| {
        *tools
            .iter()
            .find(|tool| tool.call_id == id)
            .expect("tool ID")
    };
    assert_eq!(
        find("call-fn").input,
        Some(json!({"session_id":1,"chars":"q"}))
    );
    // Typed native normalization wraps the exact patch body under command;
    // the retired hook parser previously returned that same body as a string.
    assert_eq!(find("call-patch").input, Some(json!({"command":patch})));
    let web = tools
        .iter()
        .find(|tool| tool.name == "web_search")
        .expect("web_search");
    assert_eq!(
        web.input,
        Some(json!({"type":"search","query":"codex hooks","queries":["codex hooks"]}))
    );
    assert_eq!(
        find("call-search").input,
        Some(json!({"query":"browser mcp","limit":10}))
    );
    assert_eq!(find("call-patch").output, Some(json!("ok")));
    assert_eq!(
        web.output,
        Some(
            json!({"status":"completed","action":{"type":"search","query":"codex hooks","queries":["codex hooks"]}})
        )
    );
    let output = find("call-search")
        .output
        .as_ref()
        .expect("tool search response");
    assert_eq!(output["status"], "completed");
    assert_eq!(output["execution"], "client");
    assert_eq!(output["tools"], json!([{"name":"browser.open"}]));
    assert!(tools.iter().any(|tool| tool.call_id == "call-patch"));
    assert!(tools
        .iter()
        .any(|tool| tool.call_id.starts_with("web_search:")));
}

#[test]
fn arguments_l9_native_missing_and_null_patch_inputs_never_become_command_null() {
    assert_eq!(
        normalize_tool_input("apply_patch", &Value::Null),
        Some(Value::Null)
    );
    for payload in [
        json!({"name":"apply_patch","call_id":"patch-null","input":null}),
        json!({"name":"apply_patch","call_id":"patch-missing"}),
    ] {
        let tool = transcript_tool_call(
            Some("custom_tool_call"),
            payload.as_object().expect("payload"),
            1.0,
        )
        .expect("actual tool parser");
        assert_eq!(
            tool.input,
            Some(Value::Null),
            "the authoritative transcript has no arguments; never invent a command object"
        );
    }
}
#[test]
fn arguments_l15_native_single_source_bash_normalization_keeps_exact_command_and_workdir() {
    let raw = json!({"cmd":"pwd","workdir":"/tmp/project","yield_time_ms":1000});
    let expected = json!({"command":"pwd","workdir":"/tmp/project"});
    assert_eq!(
        normalize_tool_input("exec_command", &raw),
        Some(expected.clone())
    );
    let payload = json!({"name":"exec_command","call_id":"exec","arguments":raw.to_string()});
    let tool = transcript_tool_call(
        Some("function_call"),
        payload.as_object().expect("payload"),
        1.0,
    )
    .expect("actual parser");
    assert_eq!(tool.input, Some(expected));
}
#[test]
fn arguments_l26_native_authoritative_transcript_keeps_the_full_non_bash_json() {
    let payload = json!({"name":"write_stdin","call_id":"write","arguments":json!({"session_id":1,"chars":"q"}).to_string()});
    let tool = transcript_tool_call(
        Some("function_call"),
        payload.as_object().expect("payload"),
        1.0,
    )
    .expect("actual transcript parser");
    assert_eq!(tool.input, Some(json!({"session_id":1,"chars":"q"})));
}
