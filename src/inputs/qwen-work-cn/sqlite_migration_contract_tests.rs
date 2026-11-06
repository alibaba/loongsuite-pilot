//! QwenWorkCN-specific real SQLite and HostedInput contracts; no Qoder input is constructed.
use super::*;
use crate::checkpoints::{InputState, StateStore};
use rusqlite::{params, Connection};
use std::sync::Mutex;
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    db: PathBuf,
    store: Arc<StateStore>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let db = root.join("agents.db");
        Connection::open(&db).unwrap().execute_batch("CREATE TABLE sub_chats(id TEXT PRIMARY KEY,session_id TEXT,model_level TEXT);CREATE TABLE messages(id TEXT PRIMARY KEY,sub_chat_id TEXT,sequence INTEGER,role TEXT,parts TEXT,updated_at INTEGER);INSERT INTO sub_chats VALUES('sc-1','sess-1','qwen3-coder');").unwrap();
        let store = Arc::new(StateStore::new(root.join("state.json")));
        store.set(
            "qwen-work-cn-sqlite",
            InputState::new().with_extra(json!({"lastUpdatedAt":0})),
        );
        store.set(
            "qoder-work-sqlite",
            InputState::new()
                .with_last_offset(987.0)
                .with_extra(json!({"unrelated":9007199254740993u64})),
        );
        Self {
            _temp: temp,
            root,
            db,
            store,
        }
    }
    fn message(&self, id: &str, sequence: i64, role: &str, parts: Value, stamp: i64) {
        Connection::open(&self.db)
            .unwrap()
            .execute(
                "INSERT INTO messages VALUES(?1,'sc-1',?2,?3,?4,?5)",
                params![id, sequence, role, parts.to_string(), stamp],
            )
            .unwrap();
    }
    fn input(&self) -> (QwenWorkCnSqliteInput, Arc<Mutex<Vec<Value>>>) {
        let input = QwenWorkCnSqliteInput::new(QwenWorkCnSqliteOptions {
            state_store: self.store.clone(),
            db_path: Some(self.db.to_string_lossy().into_owned()),
            data_root: Some(self.root.to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let copy = events.clone();
        input.bind_collector(
            move |batch| {
                copy.lock()
                    .unwrap()
                    .extend(batch.iter().map(|e| serde_json::to_value(e).unwrap()))
            },
            |_| {},
        );
        (input, events)
    }
}
fn user(text: &str) -> Value {
    json!([{"type":"text","text":text}])
}
#[tokio::test]
async fn source_l33_real_qwen_user_and_tool_mapping_is_independent_of_qoder_work() {
    let f = Fixture::new();
    f.message("m-user", 0, "user", user("implement it"), 1770000001);
    f.message(
        "m-tool",
        1,
        "assistant",
        json!([{"type":"tool-Read","toolCallId":"call-1","toolName":"Read","output":{"ok":true}}]),
        1770000002,
    );
    let (input, events) = f.input();
    assert_eq!(input.inner.id(), "qwen-work-cn-sqlite");
    assert_eq!(
        input.inner.body.collection_method(),
        CollectionMethod::SqlitePolling
    );
    input.start().await.unwrap();
    input.stop().await.unwrap();
    f.store.save().await.unwrap();
    let e = events.lock().unwrap();
    assert_eq!(
        e.iter()
            .map(|e| e["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["llm.request", "tool.result"]
    );
    assert!(e.iter().all(|e| e["gen_ai.agent.type"] == "qwen-work-cn"));
    assert_eq!(
        e[0]["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"implement it"}]}])
    );
    assert_eq!(e[1]["gen_ai.tool.name"], "Read");
    assert_eq!(e[1]["gen_ai.tool.call.result"], json!({"ok":true}));
    assert!(e.iter().all(|e| e["agent.source"] == "qwen-work-cn-sqlite"));
    assert_eq!(f.store.get("qoder-work-sqlite").last_offset(), Some(987.0));
    assert_eq!(
        f.store.get("qoder-work-sqlite").extra().unwrap(),
        json!({"unrelated":9007199254740993u64})
    );
}
#[tokio::test]
async fn source_l54_actual_equal_timestamp_1001_rows_cross_the_page_without_loss_or_duplicates() {
    let f = Fixture::new();
    let mut connection = Connection::open(&f.db).unwrap();
    let tx = connection.transaction().unwrap();
    {
        let mut statement = tx
            .prepare("INSERT INTO messages VALUES(?1,'sc-1',?2,'user',?3,1770000001)")
            .unwrap();
        for n in 0..1001 {
            statement
                .execute(params![
                    format!("m-{n}"),
                    n,
                    user(&format!("prompt {n}")).to_string()
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    drop(connection);
    let (input, events) = f.input();
    input.start().await.unwrap();
    assert_eq!(events.lock().unwrap().len(), 1000);
    assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "m-0");
    assert_eq!(events.lock().unwrap()[999]["agent.message_id"], "m-999");
    assert_eq!(
        f.store.get("qwen-work-cn-sqlite").extra().unwrap()["lastUpdatedRowId"],
        json!(1000.0)
    );
    events.lock().unwrap().clear();
    input.inner.run_cycle().await;
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "m-1000");
    events.lock().unwrap().clear();
    input.inner.run_cycle().await;
    assert!(events.lock().unwrap().is_empty());
    input.stop().await.unwrap();
    f.store.save().await.unwrap();
    let fresh = StateStore::new(f.root.join("state.json"));
    fresh.load().await;
    assert_eq!(
        fresh.get("qwen-work-cn-sqlite").extra().unwrap()["lastUpdatedRowId"],
        json!(1001.0)
    );
    assert_eq!(fresh.get("qoder-work-sqlite").last_offset(), Some(987.0));
}
#[tokio::test]
async fn source_l67_real_later_row_at_same_timestamp_is_collected_once() {
    let f = Fixture::new();
    f.message("m-1", 0, "user", user("first"), 1770000001);
    let (input, events) = f.input();
    input.start().await.unwrap();
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["agent.message_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["m-1"]
    );
    events.lock().unwrap().clear();
    f.message("m-2", 1, "user", user("second"), 1770000001);
    input.inner.run_cycle().await;
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["agent.message_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["m-2"]
    );
    events.lock().unwrap().clear();
    input.inner.run_cycle().await;
    assert!(events.lock().unwrap().is_empty());
    input.stop().await.unwrap();
}

#[tokio::test]
async fn reliability_failed_baseline_repairs_without_replaying_history_or_freezing_other_namespace()
{
    let f = Fixture::new();
    f.store.delete("qwen-work-cn-sqlite");
    f.message("history", 0, "user", user("historic prompt"), 100);
    let parked = f.root.join("parked.db");
    std::fs::rename(&f.db, &parked).unwrap();
    std::fs::write(&f.db, b"not sqlite").unwrap();
    let (input, events) = f.input();
    input.start().await.unwrap();
    assert!(events.lock().unwrap().is_empty());
    assert!(f
        .store
        .get("qwen-work-cn-sqlite")
        .extra()
        .and_then(|e| e.get("lastUpdatedAt").cloned())
        .is_none());
    input.inner.run_cycle().await;
    assert!(events.lock().unwrap().is_empty());
    f.store.set_row_id("other-agent", 77.0);
    f.store.save().await.unwrap();
    let reloaded = StateStore::new(f.root.join("state.json"));
    reloaded.load().await;
    assert_eq!(reloaded.get_row_id("other-agent"), 77.0);
    std::fs::remove_file(&f.db).unwrap();
    std::fs::rename(&parked, &f.db).unwrap();
    input.inner.run_cycle().await;
    assert!(
        events.lock().unwrap().is_empty(),
        "first successful retry establishes a history boundary"
    );
    assert_eq!(
        f.store.get("qwen-work-cn-sqlite").extra().unwrap()["lastUpdatedAt"].as_f64(),
        Some(100.0)
    );
    f.message("fresh", 1, "user", user("fresh prompt"), 101);
    input.inner.run_cycle().await;
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "fresh");
    input.stop().await.unwrap();
    assert_eq!(f.store.get_row_id("other-agent"), 77.0);
}
#[tokio::test]
async fn reliability_healthy_empty_baseline_collects_first_later_row() {
    let f = Fixture::new();
    f.store.delete("qwen-work-cn-sqlite");
    let (input, events) = f.input();
    input.start().await.unwrap();
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(
        f.store.get("qwen-work-cn-sqlite").extra().unwrap()["lastUpdatedAt"].as_f64(),
        Some(0.0)
    );
    f.message("fresh", 1, "user", user("fresh prompt"), 101);
    input.inner.run_cycle().await;
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "fresh");
    input.stop().await.unwrap();
}
