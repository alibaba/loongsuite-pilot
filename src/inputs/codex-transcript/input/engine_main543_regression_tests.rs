use super::*;
use crate::inputs::base::InputBody;
use std::time::Duration;

async fn source_budget(future: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("source case's original 15-second budget");
}
fn row(kind: &str, payload: Value, seconds: i64) -> String {
    json!({"timestamp":chrono::DateTime::from_timestamp_millis(1_767_225_600_000+seconds*1000).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"type":kind,"payload":payload}).to_string()+"\n"
}
fn owner_header() -> String {
    row(
        "session_meta",
        json!({"id":"session","model_provider":"openai"}),
        0,
    )
}
fn diagnostic() -> String {
    row(
        "event_msg",
        json!({"type":"unknown_fixture","padding":"x".repeat(64*1024)}),
        0,
    )
}
fn normal_turn(id: &str, header: bool) -> String {
    (if header {
        owner_header()
    } else {
        String::new()
    }) + &row(
        "turn_context",
        json!({"turn_id":id,"model":"synthetic-model"}),
        1,
    ) + &row("event_msg", json!({"type":"task_started","turn_id":id}), 2)
        + &row(
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"prompt"}]}),
            3,
        )
        + &row(
            "event_msg",
            json!({"type":"agent_message","message":"answer","phase":"final"}),
            4,
        )
        + &row(
            "event_msg",
            json!({"type":"task_complete","turn_id":id,"last_agent_message":"answer"}),
            5,
        )
}
fn raw_checkpoint(f: &Fixture, path: &str) -> Value {
    f.rt()
        .state_store
        .get(&f.engine().state_key(path))
        .extra()
        .unwrap()["codexTranscript"]
        .clone()
}
fn put_checkpoint(f: &Fixture, path: &str, checkpoint: Value) {
    let offset = checkpoint["scanOffset"].as_f64().unwrap_or(0.0);
    f.rt().state_store.update(
        &f.engine().state_key(path),
        InputStatePatch {
            last_offset: Some(offset),
            extra: Some(json!({"codexTranscript":checkpoint})),
            ..Default::default()
        },
    );
}
struct PendingFixture {
    f: Fixture,
    path: String,
    header: String,
    failed: String,
    end: i64,
}
async fn pending_fixture(size: usize) -> PendingFixture {
    let f = Fixture::new();
    let header = owner_header();
    let item = diagnostic();
    let failed = row(
        "event_msg",
        json!({"type":"task_started","turn_id":"old"}),
        1,
    ) + &item.repeat(size.div_ceil(item.len()));
    let end = (header.len() + failed.len()) as i64;
    let path = f
        .write(
            "rollout-session.jsonl",
            &(header.clone() + &failed + &normal_turn("later", false)),
        )
        .await;
    let (inode, _, _) = file_meta_snapshot(&path).await.unwrap();
    put_checkpoint(
        &f,
        &path,
        json!({"inode":inode,"scanOffset":end,"ownerSessionMetaOffset":0,
        "activeTurn":{"turnId":"old","startOffset":header.len(),"startedAtMs":1_767_225_601_000_u64},
        "pendingTerminal":{"turnId":"old","terminalEndOffset":end},"pendingFusion":null,"pendingSubagent":null}),
    );
    PendingFixture {
        f,
        path,
        header,
        failed,
        end,
    }
}
#[tokio::test]
async fn main543_regression_missing_owner_does_not_repeat_real_body_reads() {
    source_budget(async {
        let f = Fixture::new();
        let path = f
            .write("rollout-session.jsonl", &diagnostic().repeat(32))
            .await;
        f.process(&path).await;
        f.rt().reset_read_accumulator_for_test();
        f.process(&path).await;
        assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
    })
    .await;
}
#[tokio::test]
async fn main543_regression_failed_legacy_range_does_not_block_later_work() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        case.f.process(&case.path).await;
        assert_eq!(responses_for(&case.f.records(), "later").len(), 1);
        let cp = raw_checkpoint(&case.f, &case.path);
        assert!(cp["pendingTerminal"].is_null());
        assert_eq!(cp["deferredTerminals"].as_array().unwrap().len(), 1);
    })
    .await;
}
#[tokio::test]
async fn main543_regression_invalid_saved_cursor_is_rejected_without_losing_later_work() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let mut cp = raw_checkpoint(&case.f, &case.path);
        cp["scanOffset"] = json!(-1);
        put_checkpoint(&case.f, &case.path, cp);
        assert!(case
            .f
            .engine()
            .read_checkpoint(case.f.rt(), &case.f.engine().state_key(&case.path))
            .is_none());
        case.f.process(&case.path).await;
        assert_eq!(responses_for(&case.f.records(), "later").len(), 1);
    })
    .await;
}

fn set_recovery_clock(f: &Fixture, clock: Arc<std::sync::atomic::AtomicI64>) {
    f.input.inner.body.with_shared(|shared| {
        shared.main543_clock = Some(Arc::new(move || {
            clock.load(std::sync::atomic::Ordering::SeqCst) as f64
        }));
    });
}
fn capture_failures(f: &Fixture) -> Arc<Mutex<Vec<Value>>> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let out = events.clone();
    f.input.inner.body.with_shared(|shared| {
        shared.main543_failure_observer = Some(Arc::new(move |message, meta| {
            out.lock()
                .unwrap()
                .push(json!({"message":message,"meta":meta}));
        }));
    });
    events
}
async fn source_version_for(path: &str) -> String {
    source_version(&scan::file_version_snapshot(path).await.unwrap())
}
async fn probe_owner(f: &Fixture, path: &str, end: Option<i64>) -> Option<i64> {
    let version = scan::file_version_snapshot(path).await.unwrap();
    f.engine()
        .find_owner_offset(f.rt(), path, &version, end)
        .await
        .unwrap()
}
fn set_probe_after_read(f: &Fixture, hook: impl Fn(&str) + Send + Sync + 'static) {
    f.input
        .inner
        .body
        .with_shared(|shared| shared.main543_probe_after_read = Some(Arc::new(hook)));
}
fn owner_probe_call_count(f: &Fixture) -> usize {
    f.input
        .inner
        .body
        .with_shared(|shared| shared.main543_owner_probe_calls)
}

#[path = "engine_main543_owner_probe_tests.rs"]
mod owner_probe_contracts;

fn capture_recovery_ends(f: &Fixture) -> Arc<Mutex<Vec<i64>>> {
    let entries = Arc::new(Mutex::new(Vec::new()));
    let out = entries.clone();
    f.input.inner.body.with_shared(|shared| {
        shared.main543_recovery_end_observer =
            Some(Arc::new(move |end| out.lock().unwrap().push(end)))
    });
    entries
}
fn capture_legacy_releases(f: &Fixture) -> Arc<Mutex<Vec<String>>> {
    let entries = Arc::new(Mutex::new(Vec::new()));
    let out = entries.clone();
    f.input.inner.body.with_shared(|shared| {
        shared.main543_legacy_release_observer = Some(Arc::new(move |method| {
            out.lock().unwrap().push(method.to_owned())
        }))
    });
    entries
}
fn pending_results(f: &Fixture) -> Vec<(bool, usize)> {
    f.input
        .inner
        .body
        .with_shared(|shared| shared.main543_pending_results.clone())
}

#[path = "engine_main543_checkpoint_tests.rs"]
mod checkpoint_contracts;

#[path = "engine_main543_recovery_engine_tests.rs"]
mod recovery_engine_contracts;

#[tokio::test]
async fn main543_generated_missing_and_bad_timestamp_context_survives_durable_restart() {
    for timestamp in [None, Some("invalid-date")] {
        source_budget(async {
            let f = Fixture::new();
            let lines = normal_turn("untimed", true)
                .lines()
                .map(|line| {
                    let mut value: Value = serde_json::from_str(line).unwrap();
                    match timestamp {
                        Some(at) => value["timestamp"] = json!(at),
                        None => {
                            value.as_object_mut().unwrap().remove("timestamp");
                        }
                    }
                    value.to_string() + "\n"
                })
                .collect::<Vec<_>>();
            let path = f.write("rollout-session.jsonl", &lines[..4].concat()).await;
            f.process(&path).await;
            let cp = f.checkpoint(&path);
            let active = cp
                .active_turn
                .as_ref()
                .expect("real incomplete turn context");
            assert_eq!(active.started_at_ms.fract(), 0.0);
            let saved = raw_checkpoint(&f, &path);
            let restarted = f.restart().await;
            assert_eq!(raw_checkpoint(&restarted, &path), saved);
            assert!(restarted.checkpoint(&path).active_turn.is_some());
            restarted.append(&path, &lines[4..].concat()).await;
            restarted.process(&path).await;
            assert_eq!(responses_for(&restarted.records(), "untimed").len(), 1);
            assert!(restarted.checkpoint(&path).pending_terminal.is_none());
            restarted.process(&path).await;
            assert_eq!(responses_for(&restarted.records(), "untimed").len(), 1);
        })
        .await;
    }
}
