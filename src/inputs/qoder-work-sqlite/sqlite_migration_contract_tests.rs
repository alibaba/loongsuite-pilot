//! Exact legacy SQLite input contracts, backed by the real native runtime and schema.
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
        Connection::open(&db).unwrap().execute_batch("CREATE TABLE sub_chats(id TEXT PRIMARY KEY,session_id TEXT,model_level TEXT);CREATE TABLE messages(id TEXT PRIMARY KEY,sub_chat_id TEXT NOT NULL,sequence INTEGER NOT NULL,role TEXT NOT NULL,parts TEXT,updated_at INTEGER);").unwrap();
        let store = Arc::new(StateStore::new(root.join("state.json")));
        Self {
            _temp: temp,
            root,
            db,
            store,
        }
    }
    fn owned(&self, kind: ClientType) {
        self.store.set(
            &format!("{kind}-sqlite"),
            InputState::new().with_extra(json!({"lastUpdatedAt":0})),
        );
    }
    fn chat(&self, id: &str, session: &str, model: Option<&str>) {
        Connection::open(&self.db)
            .unwrap()
            .execute(
                "INSERT INTO sub_chats VALUES(?1,?2,?3)",
                params![id, session, model],
            )
            .unwrap();
    }
    fn message(&self, id: &str, sc: &str, sequence: i64, role: &str, parts: Value, stamp: i64) {
        self.raw(id, sc, sequence, role, &parts.to_string(), stamp)
    }
    fn raw(&self, id: &str, sc: &str, sequence: i64, role: &str, parts: &str, stamp: i64) {
        Connection::open(&self.db)
            .unwrap()
            .execute(
                "INSERT INTO messages VALUES(?1,?2,?3,?4,?5,?6)",
                params![id, sc, sequence, role, parts, stamp],
            )
            .unwrap();
    }
    fn input(&self, kind: ClientType) -> QoderWorkSqliteInput {
        QoderWorkSqliteInput::new(QoderWorkSqliteOptions {
            state_store: self.store.clone(),
            db_path: Some(self.db.to_string_lossy().into_owned()),
            data_root: Some(self.root.to_string_lossy().into_owned()),
            agent_type: Some(kind),
            poll_interval_ms: Some(60000),
        })
    }
    async fn once(&self, kind: ClientType) -> Vec<Value> {
        let input = self.input(kind);
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
        input.start().await.unwrap();
        input.stop().await.unwrap();
        self.store.save().await.unwrap();
        let result = events.lock().unwrap().clone();
        result
    }
    fn stamp(&self, id: &str) -> f64 {
        self.store.get(id).extra().unwrap()["lastUpdatedAt"]
            .as_f64()
            .unwrap()
    }
}
fn user(text: &str) -> Value {
    json!([{"type":"text","text":text}])
}
fn tool(call: &str, name: &str, output: Value) -> Value {
    json!({"type":format!("tool-{name}"),"toolCallId":call,"toolName":name,"output":output})
}
#[tokio::test]
async fn source_l34_real_work_identity_and_collection_method() {
    let f = Fixture::new();
    let input = f.input(ClientType::QoderWork);
    assert_eq!(input.id(), "qoder-work-sqlite");
    assert_eq!(input.inner.body.agent_type(), ClientType::QoderWork);
    assert_eq!(
        input.inner.body.collection_method(),
        CollectionMethod::SqlitePolling
    );
}
#[tokio::test]
async fn source_l41_initial_history_is_excluded_and_boundary_persists() {
    let f = Fixture::new();
    f.chat("sc-existing", "sess-existing", None);
    f.message(
        "m-existing",
        "sc-existing",
        0,
        "user",
        user("baseline prompt"),
        1777000000,
    );
    assert!(f.once(ClientType::QoderWork).await.is_empty());
    assert_eq!(f.stamp("qoder-work-sqlite"), 1777000000.0);
    let fresh = StateStore::new(f.root.join("state.json"));
    fresh.load().await;
    assert_eq!(
        fresh.get("qoder-work-sqlite").extra().unwrap()["lastUpdatedAt"],
        json!(1777000000.0)
    );
}
#[tokio::test]
async fn source_l59_user_prompt_model_session_parts_and_nanosecond_time() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-1", "sess-1", Some("qwork-ultimate"));
    f.message(
        "m-user-1",
        "sc-1",
        0,
        "user",
        user("hello world"),
        1777000001,
    );
    let entries = f.once(ClientType::QoderWork).await;
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e["event.name"], "llm.request");
    assert_eq!(e["gen_ai.session.id"], "sess-1");
    assert_eq!(e["gen_ai.agent.type"], "qoder-work");
    assert_eq!(e["gen_ai.request.model"], "qwork-ultimate");
    assert_eq!(
        e["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"hello world"}]}])
    );
    assert_eq!(e["time_unix_nano"], "1777000001000000000");
}
#[tokio::test]
async fn source_l86_null_model_uses_unknown() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-no-model", "sess-no-model", None);
    f.message(
        "m-no-model",
        "sc-no-model",
        0,
        "user",
        user("no model"),
        1777000010,
    );
    let e = f.once(ClientType::QoderWork).await;
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["gen_ai.request.model"], "unknown");
}
#[tokio::test]
async fn source_l104_tool_result_inherits_subchat_model() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-tool-model", "sess-tool-model", Some("qwork-auto"));
    f.message(
        "m-tool-model",
        "sc-tool-model",
        1,
        "assistant",
        json!([tool("call-x", "Bash", json!("ok"))]),
        1777000011,
    );
    let e = f.once(ClientType::QoderWork).await;
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event.name"], "tool.result");
    assert_eq!(e[0]["gen_ai.request.model"], "qwork-auto");
}
#[tokio::test]
async fn source_l125_thinking_is_excluded_and_real_tool_payload_is_kept() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-tool", "sess-tool", None);
    f.message(
        "m-asst-1",
        "sc-tool",
        1,
        "assistant",
        json!([
            tool("thinking-1", "Thinking", json!({"completed":true})),
            tool("call-abc", "Read", json!({"content":"file contents"}))
        ]),
        1777000002,
    );
    let e = f.once(ClientType::QoderWork).await;
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event.name"], "tool.result");
    assert_eq!(e[0]["gen_ai.tool.name"], "Read");
    assert_eq!(e[0]["gen_ai.tool.call.id"], "call-abc");
    assert_eq!(
        e[0]["gen_ai.tool.call.result"],
        json!({"content":"file contents"})
    );
}
#[tokio::test]
async fn source_l156_fresh_input_and_fresh_store_resume_without_duplicates() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-dup", "sess-dup", None);
    f.message(
        "m-dup",
        "sc-dup",
        0,
        "user",
        user("first prompt"),
        1777000003,
    );
    assert_eq!(f.once(ClientType::QoderWork).await.len(), 1);
    assert_eq!(f.stamp("qoder-work-sqlite"), 1777000003.0);
    let fresh = Arc::new(StateStore::new(f.root.join("state.json")));
    fresh.load().await;
    let restarted = QoderWorkSqliteInput::new(QoderWorkSqliteOptions {
        state_store: fresh,
        db_path: Some(f.db.to_string_lossy().into_owned()),
        data_root: Some(f.root.to_string_lossy().into_owned()),
        agent_type: None,
        poll_interval_ms: Some(60000),
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let copy = events.clone();
    restarted.bind_collector(
        move |batch| copy.lock().unwrap().extend_from_slice(batch),
        |_| {},
    );
    restarted.start().await.unwrap();
    restarted.stop().await.unwrap();
    assert!(events.lock().unwrap().is_empty());
}
#[tokio::test]
async fn source_l177_updated_assistant_does_not_repeat_persisted_tool_result() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-tool-update", "sess-tool-update", None);
    f.message(
        "m-tool-update",
        "sc-tool-update",
        1,
        "assistant",
        json!([tool("call-repeat", "Bash", json!("ok"))]),
        1777000020,
    );
    let first = f.once(ClientType::QoderWork).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["event.name"], "tool.result");
    Connection::open(&f.db)
        .unwrap()
        .execute(
            "UPDATE messages SET updated_at=?1 WHERE id=?2",
            params![1777000021i64, "m-tool-update"],
        )
        .unwrap();
    assert!(f.once(ClientType::QoderWork).await.is_empty());
    assert_eq!(f.stamp("qoder-work-sqlite"), 1777000021.0);
}
#[tokio::test]
async fn source_l203_grown_assistant_emits_only_new_tool_part() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-tool-grow", "sess-tool-grow", None);
    f.message(
        "m-tool-grow",
        "sc-tool-grow",
        1,
        "assistant",
        json!([tool("call-old", "Bash", json!("old"))]),
        1777000022,
    );
    let first = f.once(ClientType::QoderWork).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["gen_ai.tool.call.id"], "call-old");
    let parts = json!([
        tool("call-old", "Bash", json!("old")),
        tool("call-new", "Read", json!("new"))
    ]);
    Connection::open(&f.db)
        .unwrap()
        .execute(
            "UPDATE messages SET parts=?1,updated_at=?2 WHERE id=?3",
            params![parts.to_string(), 1777000023i64, "m-tool-grow"],
        )
        .unwrap();
    let second = f.once(ClientType::QoderWork).await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0]["gen_ai.tool.call.id"], "call-new");
    assert_eq!(second[0]["gen_ai.tool.call.result"], "new");
}
#[tokio::test]
async fn source_l241_multiple_message_rows_preserve_user_and_tool_events() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-mixed", "sess-mixed", None);
    f.message(
        "m-mix-user",
        "sc-mixed",
        0,
        "user",
        user("do it"),
        1777000004,
    );
    f.message(
        "m-mix-asst",
        "sc-mixed",
        1,
        "assistant",
        json!([tool("call-bash-1", "Bash", json!("ok"))]),
        1777000005,
    );
    let e = f.once(ClientType::QoderWork).await;
    assert_eq!(e.len(), 2);
    assert_eq!(
        e.iter()
            .filter(|e| e["event.name"] == "llm.request")
            .count(),
        1
    );
    let tools = e
        .iter()
        .filter(|e| e["event.name"] == "tool.result")
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["gen_ai.tool.call.id"], "call-bash-1");
    assert_eq!(tools[0]["gen_ai.tool.call.result"], "ok");
}
#[tokio::test]
async fn source_l280_malformed_parts_do_not_emit_but_advance_cursor() {
    let f = Fixture::new();
    f.owned(ClientType::QoderWork);
    f.chat("sc-bad", "sess-bad", None);
    f.raw("m-bad", "sc-bad", 0, "user", "not-a-json", 1777000006);
    assert!(f.once(ClientType::QoderWork).await.is_empty());
    assert_eq!(f.stamp("qoder-work-sqlite"), 1777000006.0);
}
#[tokio::test]
async fn source_l307_real_cn_variant_has_distinct_identity_and_sqlite_method() {
    let f = Fixture::new();
    let input = f.input(ClientType::QoderWorkCN);
    assert_eq!(input.id(), "qoder-work-cn-sqlite");
    assert_eq!(input.inner.body.agent_type(), ClientType::QoderWorkCN);
    assert_eq!(
        input.inner.body.collection_method(),
        CollectionMethod::SqlitePolling
    );
}
#[tokio::test]
async fn source_l319_live_cn_variant_baselines_then_collects_only_new_prompt() {
    let f = Fixture::new();
    f.chat("sc-cn-0", "sess-cn-0", None);
    f.message(
        "mcn-baseline",
        "sc-cn-0",
        0,
        "user",
        user("baseline"),
        1777000000,
    );
    let input = f.input(ClientType::QoderWorkCN);
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
    input.start().await.unwrap();
    assert!(events.lock().unwrap().is_empty());
    f.chat("sc-cn-1", "sess-cn-1", Some("qwork-ultimate"));
    f.message(
        "mcn-1",
        "sc-cn-1",
        0,
        "user",
        user("cn user prompt"),
        1777000100,
    );
    input.inner.run_cycle().await;
    input.stop().await.unwrap();
    let e = events.lock().unwrap();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["gen_ai.agent.type"], "qoder-work-cn");
    assert_eq!(e[0]["event.name"], "llm.request");
}

#[tokio::test]
async fn reliability_failed_baseline_repairs_without_replaying_history_or_freezing_other_namespace()
{
    let f = Fixture::new();
    f.chat("sc-1", "sess-1", None);
    f.message("history", "sc-1", 0, "user", user("historic prompt"), 100);
    let parked = f.root.join("parked.db");
    std::fs::rename(&f.db, &parked).unwrap();
    std::fs::write(&f.db, b"not sqlite").unwrap();
    let input = f.input(ClientType::QoderWork);
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
    input.start().await.unwrap();
    assert!(events.lock().unwrap().is_empty());
    assert!(f
        .store
        .get("qoder-work-sqlite")
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
        f.store.get("qoder-work-sqlite").extra().unwrap()["lastUpdatedAt"].as_f64(),
        Some(100.0)
    );
    f.message("fresh", "sc-1", 1, "user", user("fresh prompt"), 101);
    input.inner.run_cycle().await;
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "fresh");
    input.stop().await.unwrap();
    assert_eq!(f.store.get_row_id("other-agent"), 77.0);
}
#[tokio::test]
async fn reliability_healthy_empty_baseline_collects_first_later_row() {
    let f = Fixture::new();
    f.chat("sc-1", "sess-1", None);
    let input = f.input(ClientType::QoderWork);
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
    input.start().await.unwrap();
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(
        f.store.get("qoder-work-sqlite").extra().unwrap()["lastUpdatedAt"].as_f64(),
        Some(0.0)
    );
    f.message("fresh", "sc-1", 1, "user", user("fresh prompt"), 101);
    input.inner.run_cycle().await;
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "fresh");
    input.stop().await.unwrap();
}

#[tokio::test]
async fn timestamp_progress_actual_1001_same_second_rows_resume_across_page_for_work_and_cn() {
    for kind in [ClientType::QoderWork, ClientType::QoderWorkCN] {
        let f = Fixture::new();
        f.owned(kind);
        f.chat("sc-1", "sess-1", Some("work-model"));
        let mut connection = Connection::open(&f.db).unwrap();
        let tx = connection.transaction().unwrap();
        {
            let mut statement = tx
                .prepare("INSERT INTO messages VALUES(?1,'sc-1',?2,'user',?3,100)")
                .unwrap();
            for n in 0..1001 {
                statement
                    .execute(params![
                        format!("m-{n}"),
                        n,
                        user(&format!("prompt-{n}")).to_string()
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
        drop(connection);
        let input = f.input(kind);
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
        input.start().await.unwrap();
        assert_eq!(events.lock().unwrap().len(), 1000);
        events.lock().unwrap().clear();
        input.inner.run_cycle().await;
        assert_eq!(
            events.lock().unwrap().len(),
            1,
            "scalar timestamp must not skip row1001"
        );
        assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "m-1000");
        events.lock().unwrap().clear();
        input.inner.run_cycle().await;
        assert!(events.lock().unwrap().is_empty());
        input.stop().await.unwrap();
        f.store.save().await.unwrap();
        let fresh = StateStore::new(f.root.join("state.json"));
        fresh.load().await;
        assert_eq!(
            fresh.get(&format!("{kind}-sqlite")).extra().unwrap()["lastUpdatedRowId"].as_f64(),
            Some(1001.0)
        );
    }
}
#[tokio::test]
async fn timestamp_progress_later_same_second_insert_with_lower_sequence_is_not_lost() {
    for kind in [ClientType::QoderWork, ClientType::QoderWorkCN] {
        let f = Fixture::new();
        f.owned(kind);
        f.chat("sc-1", "sess-1", None);
        f.message("first", "sc-1", 10, "user", user("first"), 100);
        let input = f.input(kind);
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
        input.start().await.unwrap();
        assert_eq!(events.lock().unwrap().len(), 1);
        events.lock().unwrap().clear();
        f.message("fresh", "sc-1", 0, "user", user("later same second"), 100);
        input.inner.run_cycle().await;
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "fresh");
        assert_eq!(events.lock().unwrap()[0]["agent.sequence"], json!(0.0));
        events.lock().unwrap().clear();
        input.inner.run_cycle().await;
        assert!(events.lock().unwrap().is_empty());
        input.stop().await.unwrap();
    }
}
#[tokio::test]
async fn timestamp_progress_legacy_timestamp_adoption_excludes_old_boundary_and_keeps_extensions() {
    for kind in [ClientType::QoderWork, ClientType::QoderWorkCN] {
        let f = Fixture::new();
        let key = format!("{kind}-sqlite");
        f.store.set(&key,InputState::new().with_extra(json!({"lastUpdatedAt":100,"emittedToolResultIds":["legacy-id"],"foreign":{"keep":9007199254740993u64}})));
        f.store.set_row_id("other-agent", 77.0);
        f.chat("sc-1", "sess-1", None);
        f.message("old-earlier", "sc-1", 0, "user", user("history"), 99);
        f.message(
            "old-boundary",
            "sc-1",
            1,
            "user",
            user("history at legacy timestamp"),
            100,
        );
        let input = f.input(kind);
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
        input.start().await.unwrap();
        assert!(
            events.lock().unwrap().is_empty(),
            "legacy strict timestamp exclusion must remain"
        );
        assert_eq!(
            f.store.get(&key).extra().unwrap()["lastUpdatedRowId"].as_f64(),
            Some(2.0)
        );
        f.message(
            "fresh",
            "sc-1",
            0,
            "user",
            user("fresh same timestamp"),
            100,
        );
        input.inner.run_cycle().await;
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(events.lock().unwrap()[0]["agent.message_id"], "fresh");
        input.stop().await.unwrap();
        f.store.save().await.unwrap();
        let fresh = StateStore::new(f.root.join("state.json"));
        fresh.load().await;
        let extra = fresh.get(&key).extra().unwrap();
        assert_eq!(extra["foreign"], json!({"keep":9007199254740993u64}));
        assert_eq!(extra["emittedToolResultIds"], json!(["legacy-id"]));
        assert_eq!(fresh.get_row_id("other-agent"), 77.0);
    }
}
