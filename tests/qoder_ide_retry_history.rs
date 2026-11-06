use async_trait::async_trait;
use loongsuite_pilot::checkpoints::{InputState, StateStore};
use loongsuite_pilot::inputs::base::InputBody;
use loongsuite_pilot::inputs::qoder_trace::{
    enrich_ide_turn, InterceptData, QoderTraceInput, QoderTraceOptions, QoderTraceReaders,
    SegmentTokenData, SqliteTokenData, SqliteTokenResult,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::time::{Duration, Instant};
const BASE: i64 = 1780000000000;
fn source(session: &str, count: usize, agent: &str) -> Vec<Value> {
    (0..count).flat_map(|i|{let common=json!({"gen_ai.agent.type":agent,"gen_ai.session.id":session,"gen_ai.turn.id":format!("{session}:turn"),"gen_ai.step.id":format!("{session}:turn:s{}",i+1),"gen_ai.request.model":"auto","time_unix_nano":((BASE+i as i64*10000+200)as i128*1000000).to_string()});let mut req=common.clone();req["event.id"]=json!(format!("{session}:request-{}",i+1));req["event.name"]=json!("llm.request");let mut resp=common;resp["event.id"]=json!(format!("{session}:response-{}",i+1));resp["event.name"]=json!("llm.response");resp["gen_ai.response.model"]=json!("auto");resp["agent.qoder.match_ts"]=json!(BASE+i as i64*10000+200);[req,resp]}).collect()
}
fn empty() -> SqliteTokenResult {
    SqliteTokenResult {
        rows: vec![],
        matched_db_path: None,
    }
}
fn snapshot(session: &str, count: usize) -> SqliteTokenResult {
    SqliteTokenResult {
        matched_db_path: Some("/test/.qoder/shared_client/cache/db/local.db".into()),
        rows: (0..count)
            .map(|i| SqliteTokenData {
                session_id: session.into(),
                request_id: format!("{session}:request"),
                message_id: format!("{session}:message-{}", i + 1),
                gmt_create: BASE + i as i64 * 10000,
                input_tokens: 100 * (i as i64 + 1),
                output_tokens: 10 * (i as i64 + 1),
                cache_read_tokens: 50 * (i as i64 + 1),
                model: Some("ultimate".into()),
            })
            .collect(),
    }
}
struct Readers {
    snapshots: HashMap<String, Vec<SqliteTokenResult>>,
    calls: Mutex<Vec<(String, Instant)>>,
}
impl Readers {
    fn count(&self, session: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| s == session)
            .count()
    }
    fn counts(&self) -> Vec<(String, usize)> {
        let mut out = Vec::new();
        for (s, _) in self.calls.lock().unwrap().iter() {
            if let Some((_, n)) = out.iter_mut().find(|(name, _)| name == s) {
                *n += 1
            } else {
                out.push((s.clone(), 1))
            }
        }
        out
    }
}
#[async_trait]
impl QoderTraceReaders for Readers {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        vec![]
    }
    async fn read_ide_tokens(&self, s: &str) -> SqliteTokenResult {
        let count = self.count(s);
        self.calls.lock().unwrap().push((s.into(), Instant::now()));
        let values = &self.snapshots[s];
        values[count.min(values.len() - 1)].clone()
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    input: Arc<QoderTraceInput>,
    readers: Arc<Readers>,
}
fn fixture(entries: &[Value], snapshots: Vec<(&str, Vec<SqliteTokenResult>)>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let file = format!(
        "qoder-{}.jsonl",
        loongsuite_pilot::utils::get_today_date_string()
    );
    std::fs::write(
        root.join(&file),
        entries.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    let store = Arc::new(StateStore::new(root.join("state.json")));
    store.set(
        "qoder-trace",
        InputState::new()
            .with_last_file(file)
            .with_last_offset(0.0)
            .with_extra(json!({"hookHistoryInitialized":true})),
    );
    let readers = Arc::new(Readers {
        snapshots: snapshots.into_iter().map(|(s, v)| (s.into(), v)).collect(),
        calls: Mutex::new(vec![]),
    });
    let input = Arc::new(QoderTraceInput::with_readers(
        QoderTraceOptions {
            state_store: store,
            log_dir: Some(root.to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
            multimodal_enabled: false,
            upload_mode: None,
            allowed_root_paths: vec![],
        },
        readers.clone(),
    ));
    Fixture {
        _dir: dir,
        input,
        readers,
    }
}
fn collect(f: &Fixture) -> tokio::task::JoinHandle<Vec<AgentActivityEntry>> {
    let input = f.input.clone();
    tokio::spawn(async move {
        input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .unwrap()
    })
}
async fn first_reads(f: &Fixture, sessions: usize) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if f.readers.counts().len() == sessions {
            break;
        }
        assert!(
            std::time::Instant::now() < until,
            "all session initial snapshots must precede shared delay: {:?}",
            f.readers.counts()
        );
        tokio::task::yield_now().await;
    }
    tokio::task::yield_now().await;
}
fn responses(rows: &[AgentActivityEntry]) -> Vec<&AgentActivityEntry> {
    rows.iter()
        .filter(|r| r.event_name.is_some_and(|n| n.as_str() == "llm.response"))
        .collect()
}
#[tokio::test(start_paused = true)]
async fn retry_l121_complete_batch_uses_one_read_without_a_delay() {
    let f = fixture(
        &source("ready", 2, "qoder-idea"),
        vec![("ready", vec![snapshot("ready", 2)])],
    );
    let started = Instant::now();
    let rows = collect(&f).await.unwrap();
    assert_eq!(f.readers.count("ready"), 1);
    assert_eq!(Instant::now() - started, Duration::ZERO);
    assert_eq!(
        responses(&rows)
            .iter()
            .map(|r| r.response_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["ready:message-1", "ready:message-2"]
    );
}
#[tokio::test(start_paused = true)]
async fn retry_l130_partial_snapshot_waits_exactly_one_second_and_applies_final_snapshot_once() {
    let original = source("partial", 2, "qoder-idea");
    let full = snapshot("partial", 2);
    let f = fixture(
        &original,
        vec![("partial", vec![snapshot("partial", 1), full.clone()])],
    );
    let task = collect(&f);
    first_reads(&f, 1).await;
    let started = Instant::now();
    tokio::time::advance(Duration::from_millis(999)).await;
    assert_eq!(f.readers.count("partial"), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    let rows = task.await.unwrap();
    assert_eq!(Instant::now() - started, Duration::from_secs(1));
    assert_eq!(f.readers.count("partial"), 2);
    let mut expected = original
        .into_iter()
        .map(|v| serde_json::from_value::<AgentActivityEntry>(v).unwrap())
        .collect::<Vec<_>>();
    enrich_ide_turn(&mut expected, &full.rows);
    for (actual, expected) in rows.iter().zip(expected) {
        let actual = serde_json::to_value(actual).unwrap();
        for (k, v) in serde_json::to_value(expected).unwrap().as_object().unwrap() {
            // Typed Rust required fields serialize empty defaults that were
            // absent from the original JS object matched by toMatchObject.
            if v.as_str() != Some("") {
                assert_eq!(actual[k], *v, "{k}");
            }
        }
    }
    assert_eq!(
        responses(&rows)
            .iter()
            .map(|r| r.total_tokens.unwrap())
            .collect::<Vec<_>>(),
        [110, 220]
    );
}
#[tokio::test(start_paused = true)]
async fn retry_l150_empty_snapshot_recovers_qoder_and_idea_identity() {
    for agent in ["qoder", "qoder-idea"] {
        let f = fixture(
            &source("empty", 1, agent),
            vec![("empty", vec![empty(), snapshot("empty", 1)])],
        );
        let task = collect(&f);
        first_reads(&f, 1).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let rows = task.await.unwrap();
        assert_eq!(f.readers.count("empty"), 2);
        let resp = responses(&rows)[0];
        assert_eq!(resp.response_id.as_deref(), Some("empty:message-1"));
        assert_eq!(resp.total_tokens, Some(110));
        assert_eq!(resp.agent_type, "qoder-idea");
    }
}
#[tokio::test(start_paused = true)]
async fn retry_l164_missing_snapshot_retries_once_emits_once_and_consumes_real_hook_checkpoint() {
    let f = fixture(
        &source("missing", 2, "qoder-idea"),
        vec![("missing", vec![empty(), empty()])],
    );
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let copy = emitted.clone();
    f.input
        .bind_collector(move |rows| copy.lock().unwrap().push(rows.to_vec()), |_| {});
    let input = f.input.clone();
    let started = tokio::spawn(async move { input.start().await.unwrap() });
    first_reads(&f, 1).await;
    assert!(emitted.lock().unwrap().is_empty());
    tokio::time::advance(Duration::from_secs(1)).await;
    started.await.unwrap();
    assert_eq!(f.readers.count("missing"), 2);
    assert_eq!(emitted.lock().unwrap().len(), 1);
    assert_eq!(responses(&emitted.lock().unwrap()[0]).len(), 2);
    assert!(collect(&f).await.unwrap().is_empty());
    tokio::time::advance(Duration::from_secs(10)).await;
    assert_eq!(f.readers.count("missing"), 2);
    assert_eq!(emitted.lock().unwrap().len(), 1);
    f.input.stop().await.unwrap();
}
#[tokio::test(start_paused = true)]
async fn retry_l183_failed_reread_preserves_first_partial_usage_and_idea_identity() {
    let f = fixture(
        &source("regressed", 2, "qoder"),
        vec![("regressed", vec![snapshot("regressed", 1), empty()])],
    );
    let task = collect(&f);
    first_reads(&f, 1).await;
    tokio::time::advance(Duration::from_secs(1)).await;
    let rows = task.await.unwrap();
    let r = responses(&rows);
    assert_eq!(r[0].response_id.as_deref(), Some("regressed:message-1"));
    assert_eq!(r[0].total_tokens, Some(110));
    assert_eq!(r[0].agent_type, "qoder-idea");
    assert!(r[1].response_id.is_none());
    assert_eq!(r[1].agent_type, "qoder-idea");
}
#[tokio::test(start_paused = true)]
async fn retry_l198_three_sessions_share_one_wait_and_reread_only_gaps_in_source_order() {
    let entries = [
        source("a", 2, "qoder-idea"),
        source("b", 2, "qoder-idea"),
        source("ready", 2, "qoder-idea"),
    ]
    .concat();
    let f = fixture(
        &entries,
        vec![
            ("a", vec![empty(), snapshot("a", 2)]),
            ("b", vec![snapshot("b", 1), snapshot("b", 2)]),
            ("ready", vec![snapshot("ready", 2)]),
        ],
    );
    let task = collect(&f);
    first_reads(&f, 3).await;
    let started = Instant::now();
    tokio::time::advance(Duration::from_secs(1)).await;
    let rows = task.await.unwrap();
    assert_eq!(Instant::now() - started, Duration::from_secs(1));
    assert_eq!(
        f.readers.counts(),
        [("a".into(), 2), ("b".into(), 2), ("ready".into(), 1)]
    );
    assert!(responses(&rows).iter().all(|r| r.response_id.is_some()));
}
#[tokio::test(start_paused = true)]
async fn retry_l214_stop_during_delay_prevents_sqlite_reread() {
    let f = fixture(
        &source("stopped", 2, "qoder-idea"),
        vec![("stopped", vec![empty(), snapshot("stopped", 2)])],
    );
    let task = collect(&f);
    first_reads(&f, 1).await;
    f.input.stop().await.unwrap();
    tokio::time::advance(Duration::from_secs(1)).await;
    task.await.unwrap();
    assert_eq!(f.readers.count("stopped"), 1);
}
