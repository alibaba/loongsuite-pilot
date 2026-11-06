//! Exact pinned literal rows; assertions preserve old response/tool/clock contracts.
use super::*;
use std::sync::OnceLock;
fn variables(line: u64) -> &'static Value {
    static FIXTURES: OnceLock<Vec<Value>> = OnceLock::new();
    let fixtures = FIXTURES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/qoder-hook-retry-boundaries.json"
        ))
        .unwrap()
    });
    &fixtures
        .iter()
        .find(|f| f["source"]["id"] == format!("L{line}:C3"))
        .unwrap()["variables"]
}
fn rows(line: u64, key: &str) -> Vec<Value> {
    variables(line)[key].as_array().unwrap().clone()
}
fn project_progress(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .map(|event| {
            json!({
 "type":"progress","timestamp":event.get("ts"),"data":event})
        })
        .collect()
}
fn content_with_progress(content: &[Value], progress: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let mut all = content.to_vec();
    all.extend(project_progress(progress));
    let (_, content) = split_progress_content(&all);
    (content, all)
}
fn fixture_rows(line: u64) -> Vec<Value> {
    let values = variables(line);
    let content = values["rows"].as_array().unwrap().clone();
    let progress = values
        .get("progress")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    content_with_progress(&content, &progress).0
}
fn records(
    boundaries: &[Boundary],
    content: &[Value],
    all: &[Value],
    turn: &str,
    session: &str,
    cwd: Option<&str>,
    identity: Option<&UserIdentity>,
) -> Vec<Value> {
    let stamp = Stamp {
        span: Obj::new(),
        agent_name: None,
        resources: Obj::new(),
    };
    build_events_from_boundaries(
        boundaries,
        content,
        all,
        turn,
        BoundaryContext {
            session_id: session,
            agent_id: "qoder",
            runtime_user: "synthetic-user",
            identity,
            cwd,
            stamp: &stamp,
        },
    )
    .into_iter()
    .map(Value::Object)
    .collect()
}
fn emit(line: u64, turn: &str) -> Vec<Value> {
    let content = fixture_rows(line);
    records(
        &build_llm_boundaries(&content),
        &content,
        &content,
        turn,
        "session-1",
        None,
        None,
    )
}
fn named<'a>(records: &'a [Value], name: &str) -> Vec<&'a Value> {
    records.iter().filter(|r| r["event.name"] == name).collect()
}
fn steps(records: &[Value]) -> Vec<Value> {
    records
        .iter()
        .filter(|r| r["event.name"] == "llm.request" || r["event.name"] == "llm.response")
        .map(|r| json!([r["event.name"], r["gen_ai.step.id"]]))
        .collect()
}
fn expected_steps(turn: &str) -> Vec<Value> {
    vec![
        json!(["llm.request", format!("{turn}:s1")]),
        json!(["llm.response", format!("{turn}:s1")]),
        json!(["llm.request", format!("{turn}:s2")]),
        json!(["llm.response", format!("{turn}:s2")]),
    ]
}
fn nanos(record: &Value) -> i128 {
    record["time_unix_nano"].as_str().unwrap().parse().unwrap()
}
fn epoch_nanos(iso: &str) -> i128 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .timestamp_millis() as i128
        * 1_000_000
}
#[test]
fn boundary_l192_identity_on_every_turn_event() {
    let content = fixture_rows(192);
    let extra = json!({"user":{"name":" qoder-user ","email":" qoder-user@example.com ","uid":"not-exported"}});
    let identity = extract_user_identity(extra.as_object().unwrap()).unwrap();
    let records = records(
        &build_llm_boundaries(&content),
        &content,
        &content,
        "turn-identity",
        "session-identity",
        None,
        Some(&identity),
    );
    let actual = records
        .iter()
        .map(|r| r["event.name"].as_str().unwrap())
        .collect::<HashSet<_>>();
    assert_eq!(
        actual,
        HashSet::from([
            "other",
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result"
        ])
    );
    assert!(records
        .iter()
        .all(|r| r["user.name"] == "qoder-user" && r["user.email"] == "qoder-user@example.com"));
    assert!(!records.iter().any(|r| r.get("user.uid").is_some()));
}
#[test]
fn boundary_l245_no_usable_identity() {
    assert!(extract_user_identity(&Obj::new()).is_none());
    assert!(
        extract_user_identity(json!({"user":{"name":" ","email":42}}).as_object().unwrap())
            .is_none()
    );
}
#[test]
fn boundary_l250_thinking_text_parallel_tools_one_response() {
    assert_eq!(build_llm_boundaries(&fixture_rows(250)).len(), 1);
}

#[test]
fn boundary_l261_early_result_does_not_split_parallel_tools() {
    assert_eq!(build_llm_boundaries(&fixture_rows(261)).len(), 1);
}

#[test]
fn boundary_l272_completed_tools_start_next_response() {
    assert_eq!(build_llm_boundaries(&fixture_rows(272)).len(), 2);
}

#[test]
fn boundary_l282_completed_cycle_ignores_single_progress_window() {
    assert_eq!(build_llm_boundaries(&fixture_rows(282)).len(), 2);
}

#[test]
fn boundary_l299_completed_tool_result_sets_next_request_clock() {
    let content = fixture_rows(299);
    let bounds = build_llm_boundaries(&content);
    assert_eq!(
        bounds
            .iter()
            .map(|b| b.start_ts.as_str())
            .collect::<Vec<_>>(),
        vec!["2026-08-03T09:22:25.555446Z", "2026-08-03T09:22:26.999890Z"]
    );
    let records = records(
        &bounds,
        &content,
        &content,
        "turn-microseconds",
        "session-1",
        None,
        None,
    );
    assert_eq!(steps(&records), expected_steps("turn-microseconds"));
    let expected = [
        epoch_nanos("2026-08-03T09:22:25.100Z") + 1,
        epoch_nanos("2026-08-03T09:22:26.668Z") + 419001,
    ];
    assert_eq!(
        named(&records, "llm.request")
            .iter()
            .map(|r| nanos(r))
            .collect::<Vec<_>>(),
        expected
    );
}
#[test]
fn boundary_l350_failed_tool_result_completes_next_step() {
    let content = fixture_rows(350);
    let bounds = build_llm_boundaries(&content);
    assert_eq!(
        bounds
            .iter()
            .map(|b| b.start_ts.as_str())
            .collect::<Vec<_>>(),
        vec!["2026-07-30T01:00:00.000Z", "2026-07-30T01:00:02.000Z"]
    );
    let records = records(
        &bounds,
        &content,
        &content,
        "turn-1",
        "session-1",
        None,
        None,
    );
    assert_eq!(steps(&records), expected_steps("turn-1"));
}
#[test]
fn boundary_l405_terminal_response_survives_missing_tool_result() {
    let content = fixture_rows(405);
    let bounds = build_llm_boundaries(&content);
    assert_eq!(bounds.len(), 2);
    let records = records(
        &bounds,
        &content,
        &content,
        "turn-missing-result",
        "session-1",
        None,
        None,
    );
    assert_eq!(steps(&records), expected_steps("turn-missing-result"));
    assert_eq!(named(&records, "tool.call").len(), 1);
    assert!(named(&records, "tool.result").is_empty());
    assert!(named(&records, "llm.response")[0]
        .get("gen_ai.turn.end")
        .is_none());
    let summaries=named(&records,"llm.response").iter().map(|r|json!({
  "parts":r["gen_ai.output.messages"][0]["parts"].as_array().unwrap().iter().map(|p|p["type"].clone()).collect::<Vec<_>>(),
  "finishReasons":r["gen_ai.response.finish_reasons"],"turnEnd":r.get("gen_ai.turn.end")})).collect::<Vec<_>>();
    assert_eq!(
        summaries,
        vec![
            json!({"parts":["tool_call"],"finishReasons":["tool_call"],"turnEnd":null}),
            json!({"parts":["reasoning","text"],"finishReasons":["end_turn"],"turnEnd":true})
        ]
    );
}
#[test]
fn boundary_l456_missing_result_and_reason_merge() {
    assert_eq!(build_llm_boundaries(&fixture_rows(456)).len(), 1);
}

#[derive(Debug, PartialEq)]
struct EventFingerprint {
    name: Option<Value>,
    step: Option<Value>,
    tool_id: Option<Value>,
    parts: Option<Vec<Value>>,
    time: Option<Value>,
}
fn fingerprint(records: &[Value]) -> Vec<EventFingerprint> {
    records
        .iter()
        .map(|r| EventFingerprint {
            name: r.get("event.name").cloned(),
            step: r.get("gen_ai.step.id").cloned(),
            tool_id: r.get("gen_ai.tool.call.id").cloned(),
            parts: r
                .get("gen_ai.output.messages")
                .and_then(|m| m.get(0))
                .and_then(|m| m.get("parts"))
                .and_then(Value::as_array)
                .map(|parts| parts.iter().map(|p| p["type"].clone()).collect()),
            time: r.get("time_unix_nano").cloned(),
        })
        .collect()
}
#[test]
fn boundary_l469_third_party_progress_preserves_structure_and_content() {
    let content = rows(469, "rows");
    let with = rows(469, "qoderSecProgress");
    let without = with
        .iter()
        .filter(|p| p["hookEvent"] != "PostToolUse")
        .cloned()
        .collect::<Vec<_>>();
    let (with_content, with_all) = content_with_progress(&content, &with);
    let (without_content, without_all) = content_with_progress(&content, &without);
    let a = build_llm_boundaries(&with_content);
    let b = build_llm_boundaries(&without_content);
    let shape = |bs: &[Boundary]| {
        bs.iter()
            .map(|b| json!([b.start_ts, b.end_ts, b.content_start, b.content_end]))
            .collect::<Vec<_>>()
    };
    assert_eq!(shape(&a), shape(&b));
    assert_eq!(
        a.iter()
            .map(|b| [b.content_start, b.content_end])
            .collect::<Vec<_>>(),
        vec![[1, 3], [3, 5], [5, 6]]
    );
    let a = records(
        &a,
        &with_content,
        &with_all,
        "turn-qodersec",
        "session-1",
        None,
        None,
    );
    let b = records(
        &b,
        &without_content,
        &without_all,
        "turn-qodersec",
        "session-1",
        None,
        None,
    );
    assert_eq!(fingerprint(&a), fingerprint(&b));
}
#[test]
fn boundary_l515_equal_assistant_timestamps_preserve_event_order() {
    let content = fixture_rows(515);
    let bounds = build_llm_boundaries(&content);
    assert_eq!(
        bounds
            .iter()
            .map(|b| [b.content_start, b.content_end])
            .collect::<Vec<_>>(),
        vec![[1, 3], [3, 4]]
    );
    let records = records(
        &bounds,
        &content,
        &content,
        "turn-same-ts",
        "session-1",
        None,
        None,
    );
    let responses = named(&records, "llm.response");
    assert_eq!(responses.len(), 2);
    let second = named(&records, "llm.request")
        .into_iter()
        .find(|r| r["gen_ai.step.id"] == "turn-same-ts:s2")
        .unwrap();
    let tool = named(&records, "tool.result")[0];
    assert!(nanos(responses[0]) < nanos(second));
    assert!(nanos(tool) < nanos(second));
    assert!(nanos(second) < nanos(responses[1]));
}
#[test]
fn boundary_l550_sub_millisecond_emitted_order() {
    let records = emit(550, "turn-microsecond-order");
    let first = named(&records, "llm.response")
        .into_iter()
        .find(|r| r["gen_ai.step.id"] == "turn-microsecond-order:s1")
        .unwrap();
    let tool = named(&records, "tool.result")[0];
    let second_request = named(&records, "llm.request")
        .into_iter()
        .find(|r| r["gen_ai.step.id"] == "turn-microsecond-order:s2")
        .unwrap();
    let second_response = named(&records, "llm.response")
        .into_iter()
        .find(|r| r["gen_ai.step.id"] == "turn-microsecond-order:s2")
        .unwrap();
    let second = epoch_nanos("2026-09-05T02:36:00Z");
    assert_eq!(nanos(first), second + 100000);
    assert_eq!(nanos(tool), second + 300000);
    assert_eq!(nanos(second_request), second + 300001);
    assert_eq!(nanos(second_response), second + 900000);
}
#[test]
fn boundary_l591_last_assistant_clock_without_sqlite() {
    let records = emit(591, "turn-no-sqlite");
    assert_eq!(
        nanos(named(&records, "llm.response")[0]),
        epoch_nanos("2026-09-05T02:36:02.345Z")
    );
}
#[test]
fn boundary_l623_all_declared_parallel_tools_must_resolve() {
    assert_eq!(build_llm_boundaries(&fixture_rows(623)).len(), 1);
}

#[test]
fn boundary_l643_no_invented_cycle_boundary() {
    assert_eq!(build_llm_boundaries(&fixture_rows(643)).len(), 1);
}

#[test]
fn boundary_l943_parallel_results_match_ids_and_original_durations() {
    let content = rows(943, "content");
    let bounds = vec![Boundary {
        start_ts: "2026-07-30T01:00:00.000Z".into(),
        end_ts: "2026-07-30T01:00:03.000Z".into(),
        content_start: 1,
        content_end: content.len(),
    }];
    let records = records(
        &bounds,
        &content,
        &content,
        "turn-1",
        "session-1",
        None,
        None,
    );
    let results = named(&records, "tool.result");
    let calls = named(&records, "tool.call");
    assert_eq!(
        results
            .iter()
            .map(|r| json!([
                r["gen_ai.tool.call.id"],
                r["gen_ai.tool.call.result"],
                r["tool.result.status"]
            ]))
            .collect::<Vec<_>>(),
        vec![
            json!(["problems", "file not found", "error"]),
            json!(["read", "read-result", "success"]),
            json!(["grep", "grep-result", "success"])
        ]
    );
    let expected = epoch_nanos("2026-07-30T01:00:01.000Z");
    assert_eq!(
        calls.iter().map(|r| nanos(r)).collect::<Vec<_>>(),
        vec![expected, expected, expected]
    );
    assert_eq!(
        results
            .iter()
            .map(|r| r["gen_ai.tool.call.duration"].as_f64().unwrap())
            .collect::<Vec<_>>(),
        vec![4002.0, 1001.0, 1000.0]
    );
}
#[test]
fn cli_l1020_primary_prompt_then_meta_image_source() {
    let content = fixture_rows(1020);
    let records = records(
        &build_llm_boundaries(&content),
        &content,
        &content,
        "turn-cli",
        "session-cli",
        Some("/Users/me/workspace"),
        None,
    );
    assert!(records
        .iter()
        .all(|r| r["gen_ai.agent.type"] == "qoder-cli"));
    let request = named(&records, "llm.request")[0];
    let parts = request["gen_ai.input.messages_delta"][0]["parts"]
        .as_array()
        .unwrap();
    assert_eq!(
        parts[0],
        json!({"type":"text","content":"[Image #0]这个图像在讲什么？"})
    );
    assert!(parts
        .iter()
        .any(|p| p["type"] == "text" && p["content"] == "[Image: source: /tmp/clip.png.png]"));
}
#[test]
fn cli_l1072_ide_omits_meta_image_source() {
    let content = fixture_rows(1072);
    let records = records(
        &build_llm_boundaries(&content),
        &content,
        &content,
        "turn-ide",
        "session-ide",
        Some("/Users/me/workspace"),
        None,
    );
    assert_eq!(records[0]["gen_ai.agent.type"], "qoder");
    assert_eq!(
        named(&records, "llm.request")[0]["gen_ai.input.messages_delta"][0]["parts"],
        json!([{"type":"text","content":"解释这张图片"}])
    );
}
#[test]
fn cli_l1110_meta_rows_do_not_split_or_replace_primary_prompt() {
    let v = variables(1110);
    let prompt = v["prompt"].clone();
    let meta = v["meta"].clone();
    let assistant = v["assistant"].clone();
    let turns = split_turns(&[prompt.clone(), meta.clone(), assistant.clone()]);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0][0], prompt);
    assert!(turns[0].contains(&meta));
    let content = vec![meta, prompt, assistant];
    let records = records(
        &build_llm_boundaries(&content),
        &content,
        &content,
        "turn-meta-first",
        "session-cli",
        Some("/tmp"),
        None,
    );
    let parts = named(&records, "llm.request")[0]["gen_ai.input.messages_delta"][0]["parts"]
        .as_array()
        .unwrap();
    assert_eq!(
        parts[0],
        json!({"type":"text","content":"[Image #0]这个图像在讲什么？"})
    );
    assert!(
        parts
            .iter()
            .any(|p| p["type"] == "text"
                && p["content"].as_str().unwrap().contains("[Image: source:"))
    );
}
#[test]
fn cli_l1167_attachment_filename_and_parent_only() {
    let content = rows(1167, "contentEvents");
    let all = rows(1167, "allParsed");
    let records = records(
        &build_llm_boundaries(&content),
        &content,
        &all,
        "turn-filename",
        "session-filename",
        Some("/Users/me/other"),
        None,
    );
    let request = named(&records, "llm.request")[0];
    assert_eq!(
        request["gen_ai.input.messages_delta"][0]["parts"],
        json!([{"type":"text","content":"@picture/pipeline.jpg 用一句话说明这张图"}])
    );
    assert_eq!(
        request["agent.qoder.attachments"],
        json!([{"type":"image_file","filename":"/Users/me/workspace/loongsuite-pilot/picture/pipeline.jpg","displayPath":"picture/pipeline.jpg"}])
    );
    let serialized = request["agent.qoder.attachments"].to_string();
    assert!(!serialized.contains("/Users/me/workspace/other.jpg"));
    assert!(!serialized.contains("/tmp/orphan.jpg"));
    let serialized = request.to_string();
    assert!(!serialized.contains("ignore me"));
    assert!(!serialized.contains("example.invalid"));
}
