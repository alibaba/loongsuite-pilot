//! Literal QoderCN SQLite input contracts through the actual HostedInput.
use loongsuite_pilot::checkpoints::{InputState, StateStore};
use loongsuite_pilot::inputs::qoder_cn_sqlite::{QoderCnSqliteInput, QoderCnSqliteOptions};
use loongsuite_pilot::types::AgentActivityEntry;
use loongsuite_pilot::utils::node_sqlite::SQLITE_SYNC_PAGE;
use rusqlite::{params, Connection};
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn schema(db: &Path) {
    Connection::open(db).unwrap().execute_batch("CREATE TABLE chat_message(id TEXT,session_id TEXT,request_id TEXT,role TEXT,token_info TEXT,gmt_create INTEGER);").unwrap();
}
fn insert(db: &Path, id: &str, tokens: &str, created: i64) {
    Connection::open(db)
        .unwrap()
        .execute(
            "INSERT INTO chat_message VALUES(?1,'sess',?2,'assistant',?3,?4)",
            params![id, format!("req-{id}"), tokens, created],
        )
        .unwrap();
}
fn input(
    db: &Path,
    store: Arc<StateStore>,
) -> (Arc<QoderCnSqliteInput>, Arc<Mutex<Vec<AgentActivityEntry>>>) {
    let input = Arc::new(QoderCnSqliteInput::new(QoderCnSqliteOptions {
        state_store: store,
        db_path: Some(db.to_string_lossy().into_owned()),
        data_root: Some(db.parent().unwrap().to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
    }));
    let captured = Arc::new(Mutex::new(vec![]));
    let copy = captured.clone();
    input.bind_collector(
        move |batch| copy.lock().unwrap().extend_from_slice(batch),
        |_| {},
    );
    (input, captured)
}
async fn once(db: &Path, store: Arc<StateStore>) -> Vec<AgentActivityEntry> {
    let (input, captured) = input(db, store.clone());
    input.start().await.unwrap();
    input.stop().await.unwrap();
    store.save().await.unwrap();
    let entries = captured.lock().unwrap().clone();
    entries
}
#[tokio::test]
async fn cn_source_l36_actual_initial_baseline_includes_malformed_last_row_without_emission() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("local.db");
    schema(&db);
    insert(
        &db,
        "valid",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        1,
    );
    insert(&db, "invalid", "not-json", 2);
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let entries = once(&db, store.clone()).await;
    assert!(entries.is_empty());
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 2.0);
    let fresh = StateStore::new(dir.path().join("state.json"));
    fresh.load().await;
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), 2.0);
}
#[tokio::test]
async fn cn_source_l46_actual_one_page_cursor_resumes_after_fresh_store_reload() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("local.db");
    schema(&db);
    let total = SQLITE_SYNC_PAGE + 1;
    let mut conn = Connection::open(&db).unwrap();
    let tx = conn.transaction().unwrap();
    {
        let mut statement=tx.prepare("INSERT INTO chat_message VALUES(?1,'sess',?2,'assistant','{\"prompt_tokens\":1,\"completion_tokens\":1}',?3)").unwrap();
        for i in 0..total {
            statement
                .execute(params![format!("m-{i}"), format!("req-{i}"), i as i64])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    drop(conn);
    let file = dir.path().join("state.json");
    let store = Arc::new(StateStore::new(&file));
    store.set_row_id("qoder-cn-sqlite", 0.0);
    store.set(
        "other-native",
        InputState::new()
            .with_last_offset(77.0)
            .with_extra(json!({"generation":9007199254740993u64})),
    );
    let first = once(&db, store.clone()).await;
    assert_eq!(first.len(), SQLITE_SYNC_PAGE);
    assert_eq!(first[0].event_id, "m-0");
    assert_eq!(
        first[SQLITE_SYNC_PAGE - 1].event_id,
        format!("m-{}", SQLITE_SYNC_PAGE - 1)
    );
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), SQLITE_SYNC_PAGE as f64);
    assert_eq!(store.get_offset("other-native"), 77.0);
    let fresh = Arc::new(StateStore::new(&file));
    fresh.load().await;
    assert_eq!(fresh.get("other-native"), store.get("other-native"));
    let second = once(&db, fresh.clone()).await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].event_id, format!("m-{}", total - 1));
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), total as f64);
    assert_eq!(fresh.get("other-native"), store.get("other-native"));
}
#[tokio::test]
async fn actual_busy_read_preserves_own_cursor_releases_other_input_save_and_retries() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("local.db");
    schema(&db);
    insert(
        &db,
        "fresh-1",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        1,
    );
    insert(
        &db,
        "fresh-2",
        r#"{"prompt_tokens":2,"completion_tokens":2}"#,
        2,
    );
    let file = dir.path().join("state.json");
    let store = Arc::new(StateStore::new(&file));
    store.set_row_id("qoder-cn-sqlite", 0.0);
    store.set("other-native", InputState::new().with_last_offset(50.0));
    store.save().await.unwrap();
    let lock = Connection::open(&db).unwrap();
    lock.execute_batch("PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE;")
        .unwrap();
    let probe = Connection::open(&db).unwrap();
    probe.busy_timeout(Duration::ZERO).unwrap();
    let error = probe.prepare("SELECT * FROM chat_message").unwrap_err();
    assert!(
        matches!(error,rusqlite::Error::SqliteFailure(ref e,_) if e.code==rusqlite::ErrorCode::DatabaseBusy || e.code==rusqlite::ErrorCode::DatabaseLocked)
    );
    drop(probe);
    let (input, captured) = input(&db, store.clone());
    let starting = tokio::spawn({
        let input = input.clone();
        async move { input.start().await }
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !store.waiting_for_output() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect(
        "real HostedInput collection must acquire checkpoint hold before the other input mutates",
    );
    store.set("other-native", InputState::new().with_last_offset(51.0));
    let saving = tokio::spawn({
        let store = store.clone();
        async move { store.save().await }
    });
    tokio::time::timeout(Duration::from_secs(8), starting)
        .await
        .expect("real SQLite busy timeout must finish")
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), saving)
        .await
        .expect("ordinary busy error without own progress must release shared save")
        .unwrap()
        .unwrap();
    assert!(captured.lock().unwrap().is_empty());
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 0.0);
    assert!(!store.save_failed());
    assert!(!store.waiting_for_output());
    let saved = StateStore::new(&file);
    saved.load().await;
    assert_eq!(saved.get_offset("other-native"), 51.0);
    assert_eq!(saved.get_row_id("qoder-cn-sqlite"), 0.0);
    lock.execute_batch("ROLLBACK").unwrap();
    drop(lock);
    input.stop().await.unwrap();
    let fresh = Arc::new(StateStore::new(&file));
    fresh.load().await;
    let entries = once(&db, fresh.clone()).await;
    assert_eq!(
        entries
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["fresh-1", "fresh-2"]
    );
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), 2.0);
    assert_eq!(fresh.get_offset("other-native"), 51.0);
}

#[tokio::test]
async fn failed_initial_baseline_retries_without_emitting_history_and_then_collects_new_tail() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("local.db");
    std::fs::write(&db, "not a sqlite database").unwrap();
    let path = dir.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.set("other-native", InputState::new().with_last_offset(50.0));
    store.save().await.unwrap();
    let (input, captured) = input(&db, store.clone());
    input.start().await.unwrap();
    assert!(store.get("qoder-cn-sqlite").last_row_id().is_none());
    assert!(captured.lock().unwrap().is_empty());
    store.set("other-native", InputState::new().with_last_offset(51.0));
    store.save().await.unwrap();
    assert!(!store.save_failed());
    std::fs::remove_file(&db).unwrap();
    schema(&db);
    insert(
        &db,
        "historic-1",
        r#"{"prompt_tokens":10,"completion_tokens":1}"#,
        1,
    );
    insert(
        &db,
        "historic-2",
        r#"{"prompt_tokens":20,"completion_tokens":2}"#,
        2,
    );
    input.inner.run_cycle().await;
    assert!(
        captured.lock().unwrap().is_empty(),
        "first accessible snapshot after failed baseline is historical, never emitted"
    );
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 2.0);
    insert(
        &db,
        "fresh-tail",
        r#"{"prompt_tokens":30,"completion_tokens":3}"#,
        3,
    );
    input.inner.run_cycle().await;
    assert_eq!(
        captured
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["fresh-tail"]
    );
    input.stop().await.unwrap();
    store.save().await.unwrap();
    let fresh = StateStore::new(&path);
    fresh.load().await;
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), 3.0);
    assert_eq!(fresh.get_offset("other-native"), 51.0);
    assert!(!fresh.save_failed());
}

#[tokio::test]
async fn healthy_empty_database_establishes_explicit_zero_and_collects_its_first_new_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("local.db");
    schema(&db);
    let path = dir.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let (input, captured) = input(&db, store.clone());
    input.start().await.unwrap();
    assert_eq!(
        store.get("qoder-cn-sqlite").last_row_id(),
        Some(0.0),
        "successful empty MAX is initialized, distinct from query failure"
    );
    assert!(captured.lock().unwrap().is_empty());
    insert(
        &db,
        "first-new-row",
        r#"{"prompt_tokens":7,"completion_tokens":3}"#,
        1,
    );
    input.inner.run_cycle().await;
    assert_eq!(
        captured
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["first-new-row"]
    );
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 1.0);
    input.stop().await.unwrap();
    store.save().await.unwrap();
    let fresh = StateStore::new(&path);
    fresh.load().await;
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), 1.0);
}
