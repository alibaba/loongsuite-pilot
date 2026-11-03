use super::*;
use crate::checkpoints::StateStore;
use rusqlite::{params, Connection};
use std::sync::Mutex;

fn fill(path: &Path, count: i64) {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch("CREATE TABLE chat_message(id TEXT,session_id TEXT,request_id TEXT,role TEXT,token_info TEXT,gmt_create INTEGER);").unwrap();
    for n in 1..=count {
        connection.execute("INSERT INTO chat_message VALUES(?1,'session','request','assistant','{\"prompt_tokens\":1,\"completion_tokens\":2}',?2)",params![format!("row-{n}"),n]).unwrap();
    }
}
fn append(path: &Path, id: &str) {
    Connection::open(path).unwrap().execute("INSERT INTO chat_message VALUES(?1,'session','request','assistant','{\"prompt_tokens\":1,\"completion_tokens\":2}',99)",params![id]).unwrap();
}
#[tokio::test]
async fn physical_database_replacement_during_actual_query_discards_rows_before_progress_or_emission(
) {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let database = root.join("local.db");
    fill(&database, 10);
    let store = Arc::new(StateStore::new(root.join("state.json")));
    store.set_row_id("qoder-cn-sqlite", 10.0);
    let input = QoderCnSqliteInput::new(QoderCnSqliteOptions {
        state_store: store.clone(),
        db_path: Some(database.to_string_lossy().into_owned()),
        data_root: Some(root.to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
    });
    let entries = Arc::new(Mutex::new(Vec::new()));
    let copy = entries.clone();
    input.bind_collector(
        move |batch| copy.lock().unwrap().extend_from_slice(batch),
        |_| {},
    );
    input.start().await.unwrap();
    // The race hook is task-local to the explicit query below. Settle the
    // initial worker first; startup itself no longer waits for checkpoint IO.
    input.inner.await_current_cycle_for_test().await;
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 10.0);
    assert!(entries.lock().unwrap().is_empty());
    let selected = database.clone();
    let parked = root.join("parked.db");
    BEFORE_QUERY
        .scope(
            Mutex::new(Some(Box::new(move || {
                std::fs::rename(&selected, &parked).unwrap();
                fill(&selected, 11);
            }))),
            input.inner.run_cycle(),
        )
        .await;
    assert!(
        entries.lock().unwrap().is_empty(),
        "replacement rows were queried but must not escape their source epoch"
    );
    assert_eq!(
        store.get_row_id("qoder-cn-sqlite"),
        10.0,
        "discarded rows cannot advance progress"
    );
    input.inner.run_cycle().await;
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 11.0);
    assert!(
        entries.lock().unwrap().is_empty(),
        "replacement existing rows are history"
    );
    append(&database, "fresh-tail");
    input.inner.run_cycle().await;
    assert_eq!(entries.lock().unwrap().len(), 1);
    assert_eq!(entries.lock().unwrap()[0].event_id, "fresh-tail");
    assert_eq!(store.get_row_id("qoder-cn-sqlite"), 12.0);
    input.stop().await.unwrap();
}
