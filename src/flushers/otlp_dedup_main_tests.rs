//! f84 Copilot reparse contracts through the actual public send/buffer path.
use super::*;
struct EmptyConverter;
impl EventLogConverter for EmptyConverter {
    fn convert(
        &self,
        _: &[AgentActivityEntry],
        _: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        Ok(ConvertResult::default())
    }
}
fn setup() -> (tempfile::TempDir, OtlpTraceFlusher) {
    let root = tempfile::tempdir().unwrap();
    let cfg = serde_json::from_value(
        serde_json::json!({"enabled":true,"serviceName":"test-pilot",
        "protocol":"http/protobuf","dataDir":root.path(),"turnIdleTimeoutMs":0,
        "endpoints":[{"name":"primary","endpoint":"http://unused:4318"}]}),
    )
    .unwrap();
    let f = OtlpTraceFlusher::with_parts(cfg, None, None, Some(Arc::new(EmptyConverter))).unwrap();
    (root, f)
}
fn row(id: &str, extra: Value) -> AgentActivityEntry {
    let mut map =
        serde_json::json!({"event.id":id,"event.name":"llm.response","gen_ai.turn.id":"turn-1",
        "gen_ai.session.id":"session-1","gen_ai.agent.type":"copilot",
        "gen_ai.response.finish_reasons":["tool_calls"]})
        .as_object()
        .unwrap()
        .clone();
    map.extend(extra.as_object().unwrap().clone());
    entry_from_map(map)
}
fn contents(f: &OtlpTraceFlusher) -> (Vec<Map<String, Value>>, HashMap<String, usize>) {
    let state = f.inner.state.lock().unwrap();
    assert_eq!(state.buffers.len(), 1);
    let buffer = state.buffers.values().next().unwrap();
    (
        buffer.records.iter().map(entry_to_object).collect(),
        buffer.record_index.clone(),
    )
}
#[tokio::test]
async fn main_l43_reparse_adds_permission_source_without_duplicate_record_or_index() {
    let (_root, f) = setup();
    f.send(
        row("evt-1", serde_json::json!({"gen_ai.tool.call.id":"call-A"})),
        None,
    )
    .await
    .unwrap();
    f.send(row("evt-1",serde_json::json!({"gen_ai.tool.call.id":"call-A","permission.decision_source":"unattended_fallback"})),None).await.unwrap();
    let (rows, index) = contents(&f);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["permission.decision_source"], "unattended_fallback");
    assert_eq!(index.get("evt-1"), Some(&0));
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l66_non_copilot_repeated_id_preserves_both_model_updates() {
    let (_root, f) = setup();
    for model in ["first", "corrected"] {
        f.send(
            row(
                "shared-id",
                serde_json::json!({"gen_ai.agent.type":"openclaw",
            "gen_ai.response.model":model}),
            ),
            None,
        )
        .await
        .unwrap();
    }
    let (rows, _) = contents(&f);
    assert_eq!(
        rows.iter()
            .map(|r| r["gen_ai.response.model"].clone())
            .collect::<Vec<_>>(),
        vec![Value::from("first"), Value::from("corrected")]
    );
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l76_three_distinct_ids_retain_three_records_and_index_entries() {
    let (_root, f) = setup();
    for id in ["evt-1", "evt-2", "evt-3"] {
        f.send(row(id, serde_json::json!({})), None).await.unwrap();
    }
    let (rows, index) = contents(&f);
    assert_eq!(rows.len(), 3);
    assert_eq!(index.len(), 3);
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l87_original_three_polls_of_two_events_keep_two_records_not_six() {
    let (_root, f) = setup();
    for _ in 0..3 {
        for id in ["evt-step-1", "evt-llm-1"] {
            f.send(row(id, serde_json::json!({})), None).await.unwrap();
        }
    }
    let (rows, index) = contents(&f);
    assert_eq!(rows.len(), 2);
    assert_eq!(index.len(), 2);
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l100_two_missing_ids_append_without_creating_a_dedup_index() {
    let (_root, f) = setup();
    for _ in 0..2 {
        let mut map = serde_json::json!({"event.name":"llm.response","gen_ai.turn.id":"turn-1",
            "gen_ai.agent.type":"copilot"})
        .as_object()
        .unwrap()
        .clone();
        map.remove("event.id");
        f.send(entry_from_map(map), None).await.unwrap();
    }
    let (rows, index) = contents(&f);
    assert_eq!(rows.len(), 2);
    assert!(index.is_empty());
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l115_later_missing_reasoning_preserves_original_reasoning_and_response_id() {
    let (_root, f) = setup();
    f.send(
        row(
            "evt-llm-1",
            serde_json::json!({"gen_ai.llm.reasoning.text":"thinking hard about the plan",
        "gen_ai.response.id":"resp-1"}),
        ),
        None,
    )
    .await
    .unwrap();
    f.send(
        row(
            "evt-llm-1",
            serde_json::json!({"gen_ai.response.id":"resp-1"}),
        ),
        None,
    )
    .await
    .unwrap();
    let (rows, _) = contents(&f);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["gen_ai.llm.reasoning.text"],
        "thinking hard about the plan"
    );
    assert_eq!(rows[0]["gen_ai.response.id"], "resp-1");
    f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l138_first_nonempty_reasoning_and_resolved_model_win_over_later_values() {
    let (_root, f) = setup();
    f.send(
        row(
            "evt-1",
            serde_json::json!({"gen_ai.llm.reasoning.text":"alpha-version-thinking",
        "gen_ai.session.resolved_model":"gpt-5.6-luna"}),
        ),
        None,
    )
    .await
    .unwrap();
    f.send(
        row(
            "evt-1",
            serde_json::json!({"gen_ai.llm.reasoning.text":"beta-version-thinking",
        "gen_ai.session.resolved_model":""}),
        ),
        None,
    )
    .await
    .unwrap();
    let (rows, _) = contents(&f);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["gen_ai.llm.reasoning.text"],
        "alpha-version-thinking"
    );
    assert_eq!(rows[0]["gen_ai.session.resolved_model"], "gpt-5.6-luna");
    f.shutdown().await.unwrap();
}
