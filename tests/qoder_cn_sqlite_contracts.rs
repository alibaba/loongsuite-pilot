//! Literal QoderCN SQLite input contracts through the actual HostedInput.
use loongsuite_pilot::checkpoints::{InputState, StateStore};
use loongsuite_pilot::inputs::qoder_cn_sqlite::{QoderCnSqliteInput, QoderCnSqliteOptions};
use loongsuite_pilot::types::AgentActivityEntry;
use loongsuite_pilot::utils::node_sqlite::SQLITE_SYNC_PAGE;
use rusqlite::{params, Connection};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct TempRoot {
    _directory: tempfile::TempDir,
    canonical: PathBuf,
}
impl TempRoot {
    fn path(&self) -> &Path {
        &self.canonical
    }
}
fn temp_root() -> TempRoot {
    let directory = tempfile::tempdir().unwrap();
    let canonical = std::fs::canonicalize(directory.path()).unwrap();
    TempRoot {
        _directory: directory,
        canonical,
    }
}

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
    let dir = temp_root();
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
    let dir = temp_root();
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
    let dir = temp_root();
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
    let dir = temp_root();
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
    let dir = temp_root();
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

fn head(root: &Path) -> PathBuf {
    fn walk(path: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().is_some_and(|n| n == "active.json") {
                    out.push(p);
                }
            }
        }
    }
    let mut found = vec![];
    walk(&root.join(".pilot-source-ownership"), &mut found);
    assert_eq!(
        found.len(),
        1,
        "exactly one bounded active-source record, not an unbounded per-source cursor ledger"
    );
    found.pop().unwrap()
}
fn body_free_head(root: &Path) {
    let bytes = std::fs::read(head(root)).unwrap();
    assert!(bytes.len() <= 4096);
    let text = std::str::from_utf8(&bytes).unwrap();
    for forbidden in [
        "prompt_tokens",
        "completion_tokens",
        "historic",
        "fresh-tail",
        "local.db",
        "lastRowId",
        "lastOffset",
        "cursor",
    ] {
        assert!(
            !text.contains(forbidden),
            "metadata must not contain body/path/ACK cursor: {forbidden}"
        );
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 4);
}
#[tokio::test]
async fn sqlite_source_rotation_resets_to_new_history_floor_and_old_database_return_never_replays()
{
    let dir = temp_root();
    let db = dir.path().join("local.db");
    schema(&db);
    for i in 1..=10 {
        insert(
            &db,
            &format!("old-{i}"),
            r#"{"prompt_tokens":1,"completion_tokens":1}"#,
            i,
        );
    }
    let path = dir.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    store.set(
        "qoder-cn-sqlite",
        InputState::new()
            .with_last_row_id(0.0)
            .with_extra(json!(42)),
    );
    store.set("other-native", InputState::new().with_last_offset(77.0));
    let (input, captured) = input(&db, store.clone());
    input.start().await.unwrap();
    assert_eq!(captured.lock().unwrap().len(), 10);
    captured.lock().unwrap().clear();
    let parked = db.with_extension("old");
    std::fs::rename(&db, &parked).unwrap();
    schema(&db);
    insert(
        &db,
        "copied-history-1",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        1,
    );
    insert(
        &db,
        "copied-history-2",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        2,
    );
    input.inner.run_cycle().await;
    assert_eq!(
        store.get_row_id("qoder-cn-sqlite"),
        2.0,
        "a replacement source must not inherit old rowid10"
    );
    assert!(
        captured.lock().unwrap().is_empty(),
        "replacement's existing data is history, not replay"
    );
    insert(
        &db,
        "new-source-tail",
        r#"{"prompt_tokens":3,"completion_tokens":1}"#,
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
        vec!["new-source-tail"]
    );
    input.stop().await.unwrap();
    store.save().await.unwrap();
    assert_eq!(store.get("qoder-cn-sqlite").extra(), Some(json!(42)));
    assert_eq!(store.get_offset("other-native"), 77.0);
    let replaced = db.with_extension("new");
    std::fs::rename(&db, &replaced).unwrap();
    std::fs::rename(&parked, &db).unwrap();
    let fresh = Arc::new(StateStore::new(&path));
    fresh.load().await;
    let (input, captured) = self::input(&db, fresh.clone());
    input.start().await.unwrap();
    assert!(
        captured.lock().unwrap().is_empty(),
        "putting old physical DB back starts a new exclusion epoch, never replays original rows"
    );
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), 10.0);
    insert(
        &db,
        "restored-source-tail",
        r#"{"prompt_tokens":4,"completion_tokens":1}"#,
        11,
    );
    input.inner.run_cycle().await;
    assert_eq!(
        captured
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["restored-source-tail"]
    );
    input.stop().await.unwrap();
    body_free_head(dir.path());
}
#[tokio::test]
async fn sqlite_source_floor_survives_cancelled_save_with_no_disk_key_and_fresh_store_tail_recovers(
) {
    let dir = temp_root();
    let db = dir.path().join("local.db");
    schema(&db);
    insert(
        &db,
        "historic-1",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        1,
    );
    insert(
        &db,
        "historic-2",
        r#"{"prompt_tokens":2,"completion_tokens":1}"#,
        2,
    );
    let path = dir.path().join("state.json");
    let store = Arc::new(StateStore::new(&path));
    let cancelled = store.begin_output();
    let (input, captured) = input(&db, store.clone());
    input.start().await.unwrap();
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 2.0);
    assert!(!path.exists());
    assert!(captured.lock().unwrap().is_empty());
    insert(
        &db,
        "fresh-tail",
        r#"{"prompt_tokens":3,"completion_tokens":1}"#,
        3,
    );
    drop(cancelled);
    input.stop().await.unwrap();
    assert!(
        !path.exists(),
        "cancelled output hold cannot leave a delivered cursor"
    );
    let fresh = Arc::new(StateStore::new(&path));
    fresh.load().await;
    let (input, captured) = self::input(&db, fresh.clone());
    input.start().await.unwrap();
    input.inner.run_cycle().await;
    assert_eq!(
        captured
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["fresh-tail"],
        "durable exclusion floor must not advance to fresh tail on restart"
    );
    input.stop().await.unwrap();
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), 3.0);
    body_free_head(dir.path());
}
#[tokio::test]
async fn sqlite_source_floor_survives_actual_checkpoint_write_failure_before_first_tail() {
    let dir = temp_root();
    let db = dir.path().join("local.db");
    schema(&db);
    insert(
        &db,
        "historic-1",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        1,
    );
    insert(
        &db,
        "historic-2",
        r#"{"prompt_tokens":2,"completion_tokens":1}"#,
        2,
    );
    let path = dir.path().join("state.json");
    std::fs::create_dir(&path).unwrap();
    let store = Arc::new(StateStore::new(&path));
    let (input, captured) = input(&db, store.clone());
    input.start().await.unwrap();
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 2.0);
    assert!(captured.lock().unwrap().is_empty());
    assert!(store.save().await.is_err());
    insert(
        &db,
        "fresh-tail",
        r#"{"prompt_tokens":3,"completion_tokens":1}"#,
        3,
    );
    // The first baseline never reached disk. Actually collect its new tail,
    // then cancel the real shared output hold before any cursor can persist.
    let cancelled = store.begin_output();
    let hosted = input.inner.clone();
    let cycle = tokio::spawn(async move {
        hosted.run_cycle().await;
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if captured.lock().unwrap().len() == 1 && store.waiting_for_output() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 3.0);
    assert_eq!(captured.lock().unwrap()[0].event_id, "fresh-tail");
    drop(cancelled);
    tokio::time::timeout(Duration::from_secs(2), cycle)
        .await
        .unwrap()
        .unwrap();
    input.stop().await.unwrap();
    std::fs::remove_dir(&path).unwrap();
    let fresh = Arc::new(StateStore::new(&path));
    fresh.load().await;
    let (input, captured) = self::input(&db, fresh.clone());
    input.start().await.unwrap();
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
    assert_eq!(fresh.get_row_id("qoder-cn-sqlite"), 3.0);
    body_free_head(dir.path());
}
#[tokio::test]
async fn sqlite_source_legacy_known_cursor_adoption_preserves_scalar_null_array_and_unknown_fields()
{
    for extra in [
        json!(42),
        serde_json::Value::Null,
        json!(["legacy-array", 1]),
    ] {
        let dir = temp_root();
        let db = dir.path().join("local.db");
        schema(&db);
        for i in 1..=3 {
            insert(
                &db,
                &format!("owned-{i}"),
                r#"{"prompt_tokens":1,"completion_tokens":1}"#,
                i,
            );
        }
        let path = dir.path().join("state.json");
        std::fs::write(&path,json!({"qoder-cn-sqlite":{"lastRowId":1,"extra":extra,"customUnknown":{"keep":[1,2]}},"other-native":{"lastOffset":55}}).to_string()).unwrap();
        let store = Arc::new(StateStore::new(&path));
        store.load().await;
        let prior = store.get("qoder-cn-sqlite");
        let (input, captured) = input(&db, store.clone());
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert_eq!(
            captured
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["owned-2", "owned-3"],
            "legacy known1 is adopted, not rebased to EOF3"
        );
        let after = store.get("qoder-cn-sqlite");
        assert_eq!(after.extra(),prior.extra(),"source binding preserves the established array-normalization contract and every legal extra value");
        assert_eq!(
            after.get_field("customUnknown"),
            prior.get_field("customUnknown")
        );
        assert_eq!(store.get_offset("other-native"), 55.0);
        assert!(
            after.get_field("qoderCnSqliteSource").is_some(),
            "native source binding belongs in a separate checkpoint extension, never inside extra"
        );
        let fresh = StateStore::new(&path);
        fresh.load().await;
        assert_eq!(fresh.get("qoder-cn-sqlite").extra(), prior.extra());
        assert_eq!(
            fresh.get("qoder-cn-sqlite").get_field("customUnknown"),
            prior.get_field("customUnknown")
        );
        body_free_head(dir.path());
    }
}
#[tokio::test]
async fn sqlite_source_metadata_write_failure_has_no_owned_cursor_and_does_not_freeze_other_input()
{
    let dir = temp_root();
    let db = dir.path().join("local.db");
    schema(&db);
    insert(
        &db,
        "historic-1",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        1,
    );
    insert(
        &db,
        "historic-2",
        r#"{"prompt_tokens":2,"completion_tokens":1}"#,
        2,
    );
    let path = dir.path().join("state.json");
    let blocked = dir.path().join(".pilot-source-ownership");
    std::fs::write(&blocked, "foreign-preserved").unwrap();
    let store = Arc::new(StateStore::new(&path));
    store.set("other-native", InputState::new().with_last_offset(50.0));
    store.save().await.unwrap();
    let (input, captured) = input(&db, store.clone());
    input.start().await.unwrap();
    assert!(
        store.get("qoder-cn-sqlite").last_row_id().is_none(),
        "exclude floor must be durable before any checkpoint adoption"
    );
    assert!(captured.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(&blocked).unwrap(),
        "foreign-preserved"
    );
    store.set("other-native", InputState::new().with_last_offset(51.0));
    store.save().await.unwrap();
    assert!(!store.save_failed());
    std::fs::remove_file(&blocked).unwrap();
    input.inner.run_cycle().await;
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 2.0);
    assert!(captured.lock().unwrap().is_empty());
    insert(
        &db,
        "fresh-tail",
        r#"{"prompt_tokens":3,"completion_tokens":1}"#,
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
    assert_eq!(store.get_offset("other-native"), 51.0);
    body_free_head(dir.path());
}
#[tokio::test]
async fn sqlite_source_corrupt_head_is_not_silently_rebased_and_repair_resumes_pending_tail() {
    let dir = temp_root();
    let db = dir.path().join("local.db");
    schema(&db);
    insert(
        &db,
        "owned-1",
        r#"{"prompt_tokens":1,"completion_tokens":1}"#,
        1,
    );
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    store.set_row_id("qoder-cn-sqlite", 0.0);
    let (input, captured) = input(&db, store.clone());
    input.start().await.unwrap();
    assert_eq!(captured.lock().unwrap().len(), 1);
    captured.lock().unwrap().clear();
    let record = head(dir.path());
    let original = std::fs::read(&record).unwrap();
    std::fs::write(&record, "{broken-json").unwrap();
    insert(
        &db,
        "fresh-tail",
        r#"{"prompt_tokens":2,"completion_tokens":1}"#,
        2,
    );
    input.inner.run_cycle().await;
    assert!(captured.lock().unwrap().is_empty());
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 1.0);
    assert_eq!(std::fs::read_to_string(&record).unwrap(), "{broken-json");
    store.set("other-native", InputState::new().with_last_offset(80.0));
    store.save().await.unwrap();
    assert!(!store.save_failed());
    std::fs::write(&record, original).unwrap();
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
    body_free_head(dir.path());
}

#[cfg(unix)]
#[tokio::test]
async fn sqlite_source_explicit_database_symlink_retarget_excludes_new_target_history_and_collects_tail(
) {
    use std::os::unix::fs::symlink;
    let dir = temp_root();
    let a = dir.path().join("a.db");
    let b = dir.path().join("b.db");
    let selected = dir.path().join("selected.db");
    schema(&a);
    schema(&b);
    insert(
        &a,
        "a-owned",
        r#"{"prompt_tokens":1,"completion_tokens":2}"#,
        1,
    );
    for n in 1..=2 {
        insert(
            &b,
            &format!("b-history-{n}"),
            r#"{"prompt_tokens":1,"completion_tokens":2}"#,
            n,
        );
    }
    symlink(&a, &selected).unwrap();
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    store.set_row_id("qoder-cn-sqlite", 0.0);
    let (input, entries) = input(&selected, store.clone());
    input.start().await.unwrap();
    assert_eq!(
        entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a-owned"]
    );
    entries.lock().unwrap().clear();
    std::fs::remove_file(&selected).unwrap();
    symlink(&b, &selected).unwrap();
    input.inner.run_cycle().await;
    assert!(entries.lock().unwrap().is_empty());
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 2.0);
    insert(
        &b,
        "fresh-tail",
        r#"{"prompt_tokens":1,"completion_tokens":2}"#,
        3,
    );
    input.inner.run_cycle().await;
    assert_eq!(
        entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["fresh-tail"]
    );
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 3.0);
    input.stop().await.unwrap();
    body_free_head(dir.path());
}
