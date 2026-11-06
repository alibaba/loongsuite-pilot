use super::*;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

fn synthetic_home() -> Option<tempfile::TempDir> {
    if !crate::utils::isolated_env_test() {
        return None;
    }
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("USERPROFILE", home.path());
    std::env::set_var("APPDATA", home.path().join("AppData").join("Roaming"));
    std::env::set_var("XDG_CONFIG_HOME", home.path().join(".config"));
    Some(home)
}
fn plugin(home: &Path) -> PathBuf {
    home.join(".qoder-cn")
        .join("shared_client")
        .join("cache")
        .join("db")
        .join("local.db")
}
fn app(home: &Path, name: &str) -> PathBuf {
    let root = if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else if cfg!(windows) {
        home.join("AppData").join("Roaming")
    } else {
        home.join(".config")
    };
    root.join(name)
        .join("SharedClientCache")
        .join("cache")
        .join("db")
        .join("local.db")
}
fn schema(db: &Path) {
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    Connection::open(db).unwrap().execute_batch("CREATE TABLE chat_message(id TEXT PRIMARY KEY,session_id TEXT,request_id TEXT,role TEXT,token_info TEXT,model_info TEXT,gmt_create INTEGER);CREATE TABLE chat_record(request_id TEXT PRIMARY KEY,session_id TEXT,extra TEXT);").unwrap();
}
fn insert(
    db: &Path,
    id: &str,
    session: &str,
    request: &str,
    tokens: &str,
    model: Option<&str>,
    created: i64,
) {
    Connection::open(db)
        .unwrap()
        .execute(
            "INSERT INTO chat_message VALUES(?1,?2,?3,'assistant',?4,?5,?6)",
            params![id, session, request, tokens, model, created],
        )
        .unwrap();
}
async fn read_cn(session: &str) -> SqliteTokenResult {
    // This is the exact reader+resolver pair called by QoderCnTraceBody.
    read_sqlite_tokens(session, &resolve_qoder_cn_db_paths()).await
}
const TOKENS: &str = r#"{"prompt_tokens":11,"completion_tokens":3,"cached_tokens":0}"#;

#[tokio::test]
async fn cn_source_l65_l262_missing_candidates_return_empty_without_creating_database() {
    let Some(home) = synthetic_home() else {
        return;
    };
    assert!(resolve_qoder_cn_db_paths().is_empty());
    let result = read_cn("sess-none").await;
    assert!(result.rows.is_empty());
    assert!(result.matched_db_path.is_none());
    for p in [
        plugin(home.path()),
        app(home.path(), "QoderCN"),
        app(home.path(), "Qoder CN"),
    ] {
        assert!(!p.exists());
    }
}
#[tokio::test]
async fn cn_source_l72_actual_sqlite_row_maps_all_token_message_model_and_clock_fields() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "msg-1",
        "sess-1",
        "req-1",
        r#"{"prompt_tokens":100,"completion_tokens":20,"cached_tokens":80}"#,
        Some(r#"{"model_key":"qwen-plus"}"#),
        1_780_000_000_000,
    );
    let result = read_cn("sess-1").await;
    assert_eq!(
        result.rows,
        vec![SqliteTokenData {
            session_id: "sess-1".into(),
            message_id: "msg-1".into(),
            request_id: "req-1".into(),
            gmt_create: 1_780_000_000_000,
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 80,
            model: Some("qwen-plus".into())
        }]
    );
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
}
#[tokio::test]
async fn cn_source_l94_record_model_config_fills_missing_model_key() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO chat_record VALUES('req-2','sess-2',?1)",
            [r#"{"modelConfig":{"key":"auto"}}"#],
        )
        .unwrap();
    insert(
        &db,
        "msg-2",
        "sess-2",
        "req-2",
        r#"{"prompt_tokens":1,"completion_tokens":2,"cached_tokens":0}"#,
        Some(r#"{"foo":"bar"}"#),
        1_780_000_001_000,
    );
    let result = read_cn("sess-2").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].model.as_deref(), Some("auto"));
}
#[tokio::test]
async fn cn_source_l111_zero_prompt_and_completion_do_not_claim_a_candidate() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "msg-3",
        "sess-3",
        "req-3",
        r#"{"prompt_tokens":0,"completion_tokens":0,"cached_tokens":0}"#,
        None,
        1_780_000_002_000,
    );
    let result = read_cn("sess-3").await;
    assert!(result.rows.is_empty());
    assert!(result.matched_db_path.is_none());
}
#[tokio::test]
async fn cn_source_l122_nonassistant_rows_do_not_enter_token_results() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "msg-4",
        "sess-4",
        "req-4",
        r#"{"prompt_tokens":5,"completion_tokens":5,"cached_tokens":0}"#,
        None,
        1_780_000_003_000,
    );
    Connection::open(&db)
        .unwrap()
        .execute("UPDATE chat_message SET role='user'", [])
        .unwrap();
    assert!(read_cn("sess-4").await.rows.is_empty());
}
#[tokio::test]
async fn cn_source_l131_real_query_orders_clock_ascending_not_insertion_order() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "msg-5a",
        "sess-5",
        "req-5a",
        r#"{"prompt_tokens":10,"completion_tokens":1,"cached_tokens":0}"#,
        None,
        1_780_000_005_000,
    );
    insert(
        &db,
        "msg-5b",
        "sess-5",
        "req-5b",
        r#"{"prompt_tokens":20,"completion_tokens":2,"cached_tokens":0}"#,
        None,
        1_780_000_004_000,
    );
    let result = read_cn("sess-5").await;
    assert_eq!(
        result
            .rows
            .iter()
            .map(|r| r.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["msg-5b", "msg-5a"]
    );
}
#[tokio::test]
async fn cn_source_l149_plugin_only_layout_is_actually_queried() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = plugin(home.path());
    schema(&db);
    insert(
        &db,
        "msg-p",
        "sess-plugin",
        "req-p",
        TOKENS,
        None,
        1_780_000_010_000,
    );
    assert_eq!(
        resolve_qoder_cn_db_paths(),
        vec![db.to_string_lossy().into_owned()]
    );
    let result = read_cn("sess-plugin").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].input_tokens, 11);
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
}
#[tokio::test]
async fn cn_source_l164_standalone_only_layout_is_actually_queried() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "msg-s",
        "sess-standalone",
        "req-s",
        r#"{"prompt_tokens":22,"completion_tokens":4,"cached_tokens":0}"#,
        None,
        1_780_000_011_000,
    );
    let result = read_cn("sess-standalone").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].input_tokens, 22);
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
}
#[tokio::test]
async fn cn_source_l177_spaced_app_support_layout_is_actually_queried() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "Qoder CN");
    schema(&db);
    insert(
        &db,
        "msg-sp",
        "sess-spaced",
        "req-sp",
        r#"{"prompt_tokens":66,"completion_tokens":8,"cached_tokens":0}"#,
        None,
        1_780_000_016_000,
    );
    let result = read_cn("sess-spaced").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
}
#[tokio::test]
async fn cn_source_l191_unrelated_plugin_session_does_not_hide_matching_standalone_session() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let first = plugin(home.path());
    let db = app(home.path(), "QoderCN");
    schema(&first);
    schema(&db);
    insert(
        &first,
        "msg-other",
        "sess-unrelated",
        "req-other",
        r#"{"prompt_tokens":99,"completion_tokens":9,"cached_tokens":0}"#,
        None,
        1_780_000_013_000,
    );
    insert(
        &db,
        "msg-only",
        "sess-only-standalone",
        "req-only",
        r#"{"prompt_tokens":33,"completion_tokens":5,"cached_tokens":0}"#,
        None,
        1_780_000_012_000,
    );
    let result = read_cn("sess-only-standalone").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].input_tokens, 33);
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
}
#[tokio::test]
async fn cn_source_l212_empty_readable_plugin_does_not_hide_matching_standalone_session() {
    let Some(home) = synthetic_home() else {
        return;
    };
    schema(&plugin(home.path()));
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "msg-z",
        "sess-zero",
        "req-z",
        r#"{"prompt_tokens":44,"completion_tokens":6,"cached_tokens":0}"#,
        None,
        1_780_000_014_000,
    );
    let result = read_cn("sess-zero").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
}
#[tokio::test]
async fn cn_source_l226_corrupt_plugin_query_falls_through_to_real_standalone_database() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let first = plugin(home.path());
    std::fs::create_dir_all(first.parent().unwrap()).unwrap();
    std::fs::write(&first, "not a sqlite database").unwrap();
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "msg-b",
        "sess-broken",
        "req-b",
        r#"{"prompt_tokens":55,"completion_tokens":7,"cached_tokens":0}"#,
        None,
        1_780_000_015_000,
    );
    let result = read_cn("sess-broken").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].input_tokens, 55);
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
    assert_eq!(
        std::fs::read_to_string(first).unwrap(),
        "not a sqlite database",
        "reader must not repair or replace user database"
    );
}
#[tokio::test]
async fn cn_source_l243_real_session_pages_same_clock_ties_beyond_one_thousand_rows() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    let total = crate::utils::node_sqlite::SQLITE_SYNC_PAGE + 1;
    let mut conn = Connection::open(&db).unwrap();
    let txn = conn.transaction().unwrap();
    {
        let mut stmt=txn.prepare("INSERT INTO chat_message VALUES(?1,'sess-page',?2,'assistant','{\"prompt_tokens\":1,\"completion_tokens\":1}',NULL,100)").unwrap();
        for i in 0..total {
            stmt.execute(params![format!("m-{i:04}"), format!("req-{i}")])
                .unwrap();
        }
    }
    txn.commit().unwrap();
    drop(conn);
    let result = read_cn("sess-page").await;
    assert_eq!(result.rows.len(), total);
    assert_eq!(result.rows[0].message_id, "m-0000");
    assert_eq!(
        result.rows[total - 1].message_id,
        format!("m-{:04}", total - 1)
    );
    assert_eq!(
        result
            .rows
            .iter()
            .map(|r| r.message_id.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        total
    );
}
#[tokio::test]
async fn actual_busy_plugin_falls_back_without_poisoning_future_primary_reads() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let first = plugin(home.path());
    let db = app(home.path(), "QoderCN");
    schema(&first);
    schema(&db);
    insert(
        &first,
        "locked",
        "busy-session",
        "req-locked",
        r#"{"prompt_tokens":99,"completion_tokens":1}"#,
        None,
        100,
    );
    insert(
        &db,
        "fallback",
        "busy-session",
        "req-fallback",
        r#"{"prompt_tokens":55,"completion_tokens":1}"#,
        None,
        101,
    );
    let lock = Connection::open(&first).unwrap();
    lock.execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;")
        .unwrap();
    let result = read_cn("busy-session").await;
    assert_eq!(result.matched_db_path.as_deref(), db.to_str());
    assert_eq!(result.rows[0].message_id, "fallback");
    lock.execute_batch("ROLLBACK").unwrap();
    drop(lock);
    let result = read_cn("busy-session").await;
    assert_eq!(result.matched_db_path.as_deref(), first.to_str());
    assert_eq!(result.rows[0].message_id, "locked");
}
#[tokio::test]
async fn actual_wal_snapshot_does_not_expose_uncommitted_rows_and_next_read_sees_commit() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(
        &db,
        "committed",
        "wal-session",
        "req-old",
        TOKENS,
        None,
        100,
    );
    let writer = Connection::open(&db).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO chat_message VALUES('pending','wal-session','req-new','assistant','{\"prompt_tokens\":1,\"completion_tokens\":1}',NULL,101);").unwrap();
    let result = read_cn("wal-session").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].message_id, "committed");
    writer.execute_batch("COMMIT").unwrap();
    let result = read_cn("wal-session").await;
    assert_eq!(
        result
            .rows
            .iter()
            .map(|r| r.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["committed", "pending"]
    );
}
#[tokio::test]
async fn actual_database_file_replacement_is_read_fresh_without_cached_connection() {
    let Some(home) = synthetic_home() else {
        return;
    };
    let db = app(home.path(), "QoderCN");
    schema(&db);
    insert(&db, "old", "rotation-session", "req-old", TOKENS, None, 100);
    assert_eq!(read_cn("rotation-session").await.rows[0].message_id, "old");
    let parked = db.with_extension("parked");
    std::fs::rename(&db, &parked).unwrap();
    schema(&db);
    insert(&db, "new", "rotation-session", "req-new", TOKENS, None, 101);
    let result = read_cn("rotation-session").await;
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].message_id, "new");
    assert!(parked.exists());
}
