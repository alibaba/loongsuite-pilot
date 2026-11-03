//! Native ports of main #517 history boundary and deferred-evidence regressions.
//! All data is synthetic and all files belong to this test's temporary root.
use super::*;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::io::Write;

const BASE: i64 = 1_788_220_800_000; // 2026-09-01T00:00:00Z
struct Fixture {
    root: tempfile::TempDir,
    sessions: PathBuf,
    events: PathBuf,
    native: PathBuf,
    index: PathBuf,
    policy: PathBuf,
    store: Arc<StateStore>,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        let session = sessions.join("session-test");
        let otel = root.path().join("otel");
        tokio::fs::create_dir_all(&session).await.unwrap();
        tokio::fs::create_dir_all(&otel).await.unwrap();
        Self {
            events: session.join("events.jsonl"),
            native: otel.join("native.jsonl"),
            index: root.path().join("state/copilot/source-index.sqlite"),
            policy: root.path().join("state/copilot/collection-policy.json"),
            store: Arc::new(StateStore::new(root.path().join("state.json"))),
            root,
            sessions,
        }
    }
    fn input(&self, floor: Option<u64>) -> CopilotLogInput {
        CopilotLogInput::new(CopilotLogInputOptions {
            state_store: self.store.clone(),
            data_dir: self.root.path().to_owned(),
            session_dir: Some(self.sessions.clone()),
            otel_dir: Some(self.root.path().join("otel")),
            poll_interval_ms: Some(60_000),
            native_grace_ms: Some(30_000),
            history_start_time_ms: floor,
        })
    }
    fn db(&self) -> Connection {
        Connection::open(&self.index).unwrap()
    }
    fn count(&self, sql: &str) -> i64 {
        self.db().query_row(sql, [], |r| r.get(0)).unwrap()
    }
    fn strings(&self, sql: &str) -> Vec<String> {
        let db = self.db();
        let mut statement = db.prepare(sql).unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }
    async fn sources(&self, fixture: &Value) {
        tokio::fs::write(&self.events, lines(&fixture["events"]))
            .await
            .unwrap();
        tokio::fs::write(&self.native, lines(&fixture["spans"]))
            .await
            .unwrap();
    }
    fn append(&self, path: &Path, values: &[Value]) {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap()
            .write_all(lines(&json!(values)).as_bytes())
            .unwrap();
    }
    async fn mark_native(&self) {
        let directory = self.root.path().join("state/copilot/session-wakeups");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        tokio::fs::write(
            directory.join("session-test.json"),
            json!({
                "session_id":"session-test", "otel_file":self.native
            })
            .to_string(),
        )
        .await
        .unwrap();
    }
}
fn lines(values: &Value) -> String {
    values
        .as_array()
        .unwrap()
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
fn conversation(id: &str, shift_ms: i64) -> Value {
    let raw = include_str!("../../../tests/fixtures/copilot/conversation.json")
        .replace("interaction-a", id);
    let mut f: Value = serde_json::from_str(&raw).unwrap();
    for event in f["events"].as_array_mut().unwrap() {
        let stamp = chrono::DateTime::parse_from_rfc3339(event["timestamp"].as_str().unwrap())
            .unwrap()
            .timestamp_millis()
            + shift_ms;
        event["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(stamp)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    let trace = hex::encode(Sha256::digest(id.as_bytes()))[..32].to_owned();
    for span in f["spans"].as_array_mut().unwrap() {
        span["traceId"] = json!(trace);
        for key in ["startTime", "endTime"] {
            let a = span[key].as_array().unwrap();
            let nanos = i128::from(a[0].as_i64().unwrap()) * 1_000_000_000
                + i128::from(a[1].as_i64().unwrap())
                + i128::from(shift_ms) * 1_000_000;
            span[key] = json!([
                (nanos / 1_000_000_000) as i64,
                (nanos % 1_000_000_000) as i64
            ]);
        }
    }
    f
}
fn skew_native(f: &mut Value) {
    for span in f["spans"].as_array_mut().unwrap() {
        span["startTime"] = json!([BASE / 1000 + 1, 0]);
        span["endTime"] = json!([BASE / 1000 + 3, 0]);
    }
}
async fn collect(input: &CopilotLogInput) -> Vec<AgentActivityEntry> {
    input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
}
async fn queued(input: &CopilotLogInput) {
    input
        .inner
        .body
        .on_entries_queued(&input.inner.runtime)
        .await
        .unwrap();
}
async fn stop(input: &CopilotLogInput) {
    input
        .inner
        .body
        .on_stop(&input.inner.runtime)
        .await
        .unwrap();
}
fn response(batch: &[AgentActivityEntry]) -> bool {
    batch
        .iter()
        .any(|e| e.event_name == Some(crate::types::AgentEventName::LlmResponse))
}

#[tokio::test]
async fn adoption_rejects_old_work_then_collects_a_new_interaction_in_the_same_session() {
    let x = Fixture::new().await;
    x.sources(&conversation("interaction-a", 0)).await;
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM delivered"), 0);
    assert_eq!(x.count("SELECT count(*) FROM ignored_interactions"), 1);
    assert_eq!(
        x.count("SELECT count(*) FROM records WHERE kind='event'"),
        1
    );
    let policy: Value = serde_json::from_slice(&std::fs::read(&x.policy).unwrap()).unwrap();
    assert_eq!(policy["historyStartTimeMs"], BASE + 5000);
    assert_eq!(
        x.strings("SELECT id FROM ignored_interactions"),
        ["interaction-a"]
    );
    assert_eq!(
        x.strings("SELECT type FROM records WHERE kind='event'"),
        ["session.start"]
    );
    let next = conversation("interaction-b", 10000);
    x.append(&x.events, &next["events"].as_array().unwrap()[1..]);
    x.append(&x.native, next["spans"].as_array().unwrap());
    let batch = collect(&input).await;
    assert!(!batch.is_empty());
    assert!(batch
        .iter()
        .all(|e| e.get("gen_ai.copilot.interaction.id") == Some(&json!("interaction-b"))));
    queued(&input).await;
    assert!(collect(&input).await.is_empty());
    stop(&input).await;
}

#[tokio::test]
async fn upgrade_applies_adoption_to_indexed_pending_work_and_preserves_delivered_keys() {
    let x = Fixture::new().await;
    let old = conversation("interaction-a", 0);
    let next = conversation("interaction-b", 10000);
    x.sources(&old).await;
    x.append(&x.events, &next["events"].as_array().unwrap()[1..]);
    x.append(&x.native, next["spans"].as_array().unwrap());
    let legacy = CopilotSourceIndex::open(&x.index).unwrap();
    legacy.ingest(&x.native, "span").unwrap();
    legacy.ingest(&x.events, "event").unwrap();
    legacy
        .mark_delivered(&["copilot:previous-session:already-delivered".into()])
        .unwrap();
    drop(legacy);
    let input = x.input(Some((BASE + 5000) as u64));
    let batch = collect(&input).await;
    assert!(!batch.is_empty());
    assert!(batch
        .iter()
        .all(|e| e.get("gen_ai.copilot.interaction.id") == Some(&json!("interaction-b"))));
    assert_eq!(
        x.count(
            "SELECT count(*) FROM delivered WHERE key='copilot:previous-session:already-delivered'"
        ),
        1
    );
    assert_eq!(x.count("SELECT count(*) FROM ignored_interactions"), 1);
    assert_eq!(
        x.strings("SELECT key FROM delivered"),
        ["copilot:previous-session:already-delivered"]
    );
    assert_eq!(
        x.strings("SELECT id FROM ignored_interactions"),
        ["interaction-a"]
    );
    stop(&input).await;
}

#[tokio::test]
async fn restart_recovers_unqueued_work_and_never_moves_the_original_floor() {
    let x = Fixture::new().await;
    let first = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&first).await.is_empty());
    x.sources(&conversation("interaction-b", 10000)).await;
    let original = collect(&first).await;
    assert!(!original.is_empty());
    stop(&first).await;
    let next = x.input(Some((BASE + 60000) as u64));
    let restored = collect(&next).await;
    assert_eq!(
        restored.iter().map(|e| &e.event_id).collect::<Vec<_>>(),
        original.iter().map(|e| &e.event_id).collect::<Vec<_>>()
    );
    queued(&next).await;
    stop(&next).await;
    let third = x.input(Some(0));
    assert!(collect(&third).await.is_empty());
    stop(&third).await;
    let policy: Value =
        serde_json::from_str(&tokio::fs::read_to_string(&x.policy).await.unwrap()).unwrap();
    assert_eq!(policy["historyStartTimeMs"], BASE + 5000);
}

#[tokio::test]
async fn index_rebuild_and_missing_policy_restore_keep_the_original_floor() {
    let x = Fixture::new().await;
    x.sources(&conversation("interaction-a", 0)).await;
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    stop(&input).await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = tokio::fs::remove_file(format!("{}{}", x.index.display(), suffix)).await;
    }
    let rebuilt = x.input(Some((BASE + 60000) as u64));
    assert!(collect(&rebuilt).await.is_empty());
    stop(&rebuilt).await;
    tokio::fs::remove_file(&x.policy).await.unwrap();
    let restored = x.input(None);
    assert!(collect(&restored).await.is_empty());
    stop(&restored).await;
    let policy: Value =
        serde_json::from_str(&tokio::fs::read_to_string(&x.policy).await.unwrap()).unwrap();
    assert_eq!(policy["historyStartTimeMs"], BASE + 5000);
}

#[tokio::test]
async fn explicit_replay_includes_the_exact_activation_boundary_and_persists_it() {
    let x = Fixture::new().await;
    x.sources(&conversation("interaction-a", 0)).await;
    let input = x.input(Some((BASE + 1000) as u64));
    assert!(!collect(&input).await.is_empty());
    queued(&input).await;
    stop(&input).await;
    let next = x.input(Some(0));
    assert!(collect(&next).await.is_empty());
    stop(&next).await;
    assert_eq!(
        x.count("SELECT start_ms FROM collection_policy"),
        BASE + 1000
    );
}

#[tokio::test]
async fn default_history_floor_is_captured_on_activation_after_input_construction() {
    let x = Fixture::new().await;
    let input = x.input(None);
    let constructed = chrono::Utc::now().timestamp_millis();
    tokio::time::timeout(Duration::from_secs(1), async {
        while chrono::Utc::now().timestamp_millis() <= constructed {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    x.sources(&conversation("interaction-a", 0)).await;
    let before = chrono::Utc::now().timestamp_millis();
    assert!(collect(&input).await.is_empty());
    let floor = x.count("SELECT start_ms FROM collection_policy");
    assert!(floor >= before && floor <= chrono::Utc::now().timestamp_millis());
    stop(&input).await;
}

#[tokio::test]
async fn authoritative_new_user_retains_original_skewed_native_clock_and_usage() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-b", 10000);
    skew_native(&mut f);
    x.sources(&f).await;
    let input = x.input(Some((BASE + 5000) as u64));
    let batch = collect(&input).await;
    assert!(response(&batch));
    let request = batch
        .iter()
        .find(|e| e.event_name == Some(crate::types::AgentEventName::LlmRequest))
        .unwrap();
    assert!(serde_json::to_string(&request.input_messages_delta)
        .unwrap()
        .contains("Read the sample."));
    assert_eq!(
        request.time_unix_nano,
        ((i128::from(BASE) + 1000) * 1_000_000).to_string()
    );
    assert_eq!(x.count("SELECT count(*) FROM ignored_interactions"), 0);
    stop(&input).await;
}

#[tokio::test]
async fn malformed_native_evidence_does_not_tombstone_user_and_corrected_span_recovers() {
    let x = Fixture::new().await;
    let f = conversation("interaction-b", 10000);
    let mut bad = f["spans"][0].clone();
    bad["startTime"] = json!([null, 0]);
    tokio::fs::write(&x.events, lines(&f["events"]))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&json!([bad, f["spans"][1].clone()])))
        .await
        .unwrap();
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM ignored_interactions"), 0);
    x.append(&x.native, &[f["spans"][0].clone()]);
    assert!(response(&collect(&input).await));
    stop(&input).await;
}

#[tokio::test]
async fn native_locators_survive_restart_and_temporary_source_unavailability() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-b", 10000);
    skew_native(&mut f);
    tokio::fs::write(&x.events, lines(&json!([f["events"][0].clone()])))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&f["spans"]))
        .await
        .unwrap();
    x.mark_native().await;
    let first = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&first).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 2);
    stop(&first).await;
    let away = x.native.with_extension("away");
    tokio::fs::rename(&x.native, &away).await.unwrap();
    x.append(&x.events, &f["events"].as_array().unwrap()[1..]);
    let input = x.input(None);
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 2);
    tokio::fs::rename(away, &x.native).await.unwrap();
    assert!(response(&collect(&input).await));
    queued(&input).await;
    assert!(collect(&input).await.is_empty());
    stop(&input).await;
}

#[tokio::test]
async fn one_new_user_cannot_authorize_unrelated_historical_native_trace_bodies() {
    let x = Fixture::new().await;
    let old = conversation("interaction-a", 0);
    let next = conversation("interaction-b", 10000);
    let mut root = old["spans"][1].clone();
    root["attributes"]["private.historical.body"] = json!("OLD_NATIVE_BODY");
    let mut tool = root.clone();
    tool["spanId"] = json!("historical-tool");
    tool["attributes"]["gen_ai.operation.name"] = json!("execute_tool");
    let mut spans = vec![root.clone(), tool.clone()];
    spans.extend(next["spans"].as_array().unwrap().clone());
    tokio::fs::write(&x.events, lines(&next["events"]))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&json!(spans)))
        .await
        .unwrap();
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(!collect(&input).await.is_empty());
    assert_eq!(
        x.count("SELECT count(*) FROM records WHERE kind='span' AND body LIKE '%OLD_NATIVE_BODY%'"),
        0
    );
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 2);
    queued(&input).await;
    tokio::fs::rename(&x.native, x.native.with_extension("old"))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&json!(spans)))
        .await
        .unwrap();
    assert!(collect(&input).await.is_empty());
    assert_eq!(
        x.count("SELECT count(*) FROM records WHERE kind='span' AND body LIKE '%OLD_NATIVE_BODY%'"),
        0
    );
    stop(&input).await;
}

#[tokio::test]
async fn source_replacement_and_confirmed_session_deletion_clear_native_locators() {
    let x = Fixture::new().await;
    let a = conversation("interaction-a", 0);
    let b = conversation("interaction-b", 0);
    tokio::fs::write(&x.events, lines(&json!([a["events"][0].clone()])))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&a["spans"]))
        .await
        .unwrap();
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 2);
    tokio::fs::write(&x.native, lines(&b["spans"]))
        .await
        .unwrap();
    assert!(collect(&input).await.is_empty());
    assert_eq!(
        x.count("SELECT count(*) FROM deferred_spans WHERE id LIKE 'interaction-b-%'"),
        2
    );
    assert_eq!(
        x.strings("SELECT id FROM deferred_spans ORDER BY id"),
        ["interaction-b-chat", "interaction-b-root"]
    );
    tokio::fs::remove_dir_all(x.sessions.join("session-test"))
        .await
        .unwrap();
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 0);
    stop(&input).await;
}

#[tokio::test]
async fn unavailable_deferred_traces_cannot_starve_the_ninth_restorable_interaction() {
    let x = Fixture::new().await;
    let mut events = Vec::new();
    let mut spans = Vec::new();
    for n in 0..9 {
        let mut f = conversation(&format!("new-{n}"), 10000 + n * 10000);
        skew_native(&mut f);
        if n == 0 {
            tokio::fs::write(&x.events, lines(&json!([f["events"][0].clone()])))
                .await
                .unwrap();
        }
        events.extend(f["events"].as_array().unwrap()[1..].to_vec());
        spans.extend(f["spans"].as_array().unwrap().clone());
    }
    let available_trace = spans[16]["traceId"].as_str().unwrap().to_owned();
    tokio::fs::write(&x.native, lines(&json!(spans)))
        .await
        .unwrap();
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    x.db()
        .execute(
            "UPDATE deferred_spans SET path=? WHERE trace<>?",
            params![
                x.root.path().join("missing.jsonl").to_string_lossy(),
                available_trace
            ],
        )
        .unwrap();
    x.append(&x.events, &events);
    assert!(collect(&input).await.is_empty());
    let batch = collect(&input).await;
    assert!(!batch.is_empty());
    assert!(batch
        .iter()
        .all(|e| e.get("gen_ai.copilot.interaction.id") == Some(&json!("new-8"))));
    stop(&input).await;
}

#[tokio::test]
async fn unavailable_first_locator_page_cannot_starve_later_chat_and_root_in_same_trace() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-b", 10000);
    skew_native(&mut f);
    let mut spans = Vec::new();
    for n in 0..256 {
        let mut tool = f["spans"][1].clone();
        tool["spanId"] = json!(format!("deferred-tool-{n}"));
        tool["attributes"]["gen_ai.operation.name"] = json!("execute_tool");
        spans.push(tool);
    }
    spans.extend(f["spans"].as_array().unwrap().clone());
    tokio::fs::write(&x.events, lines(&json!([f["events"][0].clone()])))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&json!(spans)))
        .await
        .unwrap();
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 258);
    x.db()
        .execute(
            "UPDATE deferred_spans SET path=? WHERE id LIKE 'deferred-tool-%'",
            [x.root.path().join("000-missing.jsonl").to_string_lossy()],
        )
        .unwrap();
    x.append(&x.events, &f["events"].as_array().unwrap()[1..]);
    assert!(collect(&input).await.is_empty());
    assert!(response(&collect(&input).await));
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 256);
    stop(&input).await;
}

#[tokio::test]
async fn provisional_legacy_native_exclusion_is_reconsidered_after_authoritative_user_arrives() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-b", 10000);
    skew_native(&mut f);
    tokio::fs::write(&x.native, lines(&f["spans"]))
        .await
        .unwrap();
    let legacy = CopilotSourceIndex::open(&x.index).unwrap();
    legacy.ingest(&x.native, "span").unwrap();
    drop(legacy);
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM records WHERE kind='span'"), 0);
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 2);
    tokio::fs::write(&x.events, lines(&f["events"]))
        .await
        .unwrap();
    assert!(response(&collect(&input).await));
    assert_eq!(x.count("SELECT count(*) FROM ignored_interactions"), 0);
    stop(&input).await;
}

#[tokio::test]
async fn corrupt_policy_cannot_silently_enable_replay() {
    let x = Fixture::new().await;
    tokio::fs::create_dir_all(x.policy.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&x.policy, "{broken").await.unwrap();
    let input = x.input(Some(0));
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .is_err());
    assert_eq!(
        tokio::fs::read_to_string(&x.policy).await.unwrap(),
        "{broken"
    );
    stop(&input).await;
}

#[tokio::test]
async fn invalid_user_timestamp_never_authorizes_an_interaction() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-a", 0);
    f["events"][1]["timestamp"] = json!("invalid-date");
    x.sources(&f).await;
    let input = x.input(Some(0));
    assert!(collect(&input).await.is_empty());
    assert_eq!(
        x.count("SELECT count(*) FROM ignored_interactions WHERE reason='invalid-event-time'"),
        1
    );
    assert_eq!(
        x.strings("SELECT reason FROM ignored_interactions"),
        ["invalid-event-time"]
    );
    stop(&input).await;
}

#[tokio::test]
async fn shutdown_time_authorizes_summary_without_reopening_historical_interactions() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-a", 0);
    f["events"].as_array_mut().unwrap().extend([
        json!({"type":"session.shutdown","id":"shutdown-old","timestamp":"2026-09-01T00:00:04Z","data":{}}),
        json!({"type":"session.shutdown","id":"shutdown-new","timestamp":"2026-09-01T00:00:06Z","data":{}})
    ]);
    x.sources(&f).await;
    let input = x.input(Some((BASE + 5000) as u64));
    let batch = collect(&input).await;
    assert_eq!(batch.len(), 1);
    assert_eq!(
        batch[0].get("gen_ai.copilot.session_summary"),
        Some(&json!(true))
    );
    queued(&input).await;
    assert!(collect(&input).await.is_empty());
    stop(&input).await;
}

#[tokio::test]
async fn legacy_native_body_reclamation_is_bounded_resumable_and_preserves_delivered_keys() {
    let x = Fixture::new().await;
    let f = conversation("interaction-a", 0);
    let mut spans = f["spans"].as_array().unwrap().clone();
    for n in 0..40 {
        let mut tool = f["spans"][1].clone();
        tool["spanId"] = json!(format!("old-tool-{n}"));
        tool["attributes"] = json!({"gen_ai.conversation.id":"session-test","gen_ai.operation.name":"execute_tool","private.test.body":"x".repeat(128*1024)});
        spans.push(tool);
    }
    tokio::fs::write(&x.native, lines(&json!(spans)))
        .await
        .unwrap();
    let size = tokio::fs::metadata(&x.native).await.unwrap().len() as i64;
    let mut legacy = CopilotSourceIndex::open(&x.index).unwrap();
    legacy.ingest(&x.native, "span").unwrap();
    legacy.ingest(&x.native, "span").unwrap();
    assert!(x.count("SELECT SUM(length(body)) FROM records WHERE kind='span'") > 5 * 1024 * 1024);
    x.db()
        .execute("INSERT INTO collection_policy VALUES(?)", [BASE + 5000])
        .unwrap();
    x.db()
        .execute(
            "INSERT INTO ignored_interactions VALUES(?,?,?)",
            params!["session-test", "interaction-a", "native-before-activation"],
        )
        .unwrap();
    legacy
        .mark_delivered(&["copilot:previous:delivered".into()])
        .unwrap();
    legacy.apply_history_policy(BASE + 5000).unwrap();
    assert_eq!(x.count("SELECT count(*) FROM records WHERE kind='span'"), 0);
    assert!(x.count("PRAGMA freelist_count") > 0);
    legacy.ingest(&x.native, "span").unwrap();
    let offset = x.count("SELECT offset FROM sources WHERE kind='span'");
    assert!(offset > 0 && offset < size);
    drop(legacy);
    let mut next = CopilotSourceIndex::open(&x.index).unwrap();
    next.apply_history_policy(BASE + 5000).unwrap();
    assert_eq!(
        x.count("SELECT offset FROM sources WHERE kind='span'"),
        offset
    );
    next.ingest(&x.native, "span").unwrap();
    assert_eq!(x.count("SELECT count(*) FROM records WHERE kind='span'"), 0);
    assert_eq!(
        x.count("SELECT count(*) FROM deferred_spans"),
        spans.len() as i64
    );
    assert_eq!(
        x.count("SELECT offset FROM sources WHERE kind='span'"),
        size
    );
    assert_eq!(
        x.count("SELECT count(*) FROM delivered WHERE key='copilot:previous:delivered'"),
        1
    );
    assert!(next.pending().unwrap().is_empty());
}

#[tokio::test]
async fn skewed_native_before_user_is_restored_from_byte_locators_without_rewinding_source() {
    let x = Fixture::new().await;
    let mut f = conversation("interaction-b", 10000);
    skew_native(&mut f);
    tokio::fs::write(&x.events, lines(&json!([f["events"][0].clone()])))
        .await
        .unwrap();
    tokio::fs::write(&x.native, lines(&f["spans"]))
        .await
        .unwrap();
    x.mark_native().await;
    let input = x.input(Some((BASE + 5000) as u64));
    assert!(collect(&input).await.is_empty());
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 2);
    assert_eq!(x.count("SELECT count(*) FROM records WHERE kind='span'"), 0);
    let offset = x.count("SELECT offset FROM sources WHERE kind='span'");
    assert_eq!(
        offset as u64,
        tokio::fs::metadata(&x.native).await.unwrap().len()
    );
    x.append(&x.events, &f["events"].as_array().unwrap()[1..]);
    let batch = collect(&input).await;
    assert!(batch.iter().any(
        |e| e.event_name == Some(crate::types::AgentEventName::LlmResponse)
            && e.input_tokens == Some(100)
    ));
    assert_eq!(x.count("SELECT count(*) FROM deferred_spans"), 0);
    assert_eq!(
        x.count("SELECT offset FROM sources WHERE kind='span'"),
        offset
    );
    stop(&input).await;
}

#[path = "collector_history_contract_tests.rs"]
mod collector_history_contract_tests;
