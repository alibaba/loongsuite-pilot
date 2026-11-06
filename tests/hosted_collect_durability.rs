//! Native BaseSession/BaseSqlite readers exercise collect-time durability gates.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::inputs::base::{
    hosted_session, hosted_sqlite, HostedInput, InputRuntime, SessionAdapter, SessionBody,
    SessionPaths, SqliteAdapter, SqliteBody,
};
use loongsuite_pilot::types::{AgentActivityEntry, ClientType};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, Notify};
struct Gate {
    entered: Notify,
    release: Notify,
    enabled: AtomicBool,
}
impl Gate {
    fn new(enabled: bool) -> Arc<Self> {
        Arc::new(Self {
            entered: Notify::new(),
            release: Notify::new(),
            enabled: AtomicBool::new(enabled),
        })
    }
    async fn pause(&self) {
        if self.enabled.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
    }
}
struct SessionProbe {
    paths: SessionPaths,
    files: Arc<Mutex<Vec<String>>>,
    line_gate: Arc<Gate>,
    discovery_gate: Arc<Gate>,
}
#[async_trait]
impl SessionBody for SessionProbe {
    fn id(&self) -> &str {
        "native-session-probe"
    }
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().into()])
    }
    fn agent_type(&self) -> ClientType {
        ClientType::Cursor
    }
    fn paths(&self) -> &SessionPaths {
        &self.paths
    }
    async fn discover_session_files(&self, _: &InputRuntime) -> anyhow::Result<Vec<String>> {
        self.discovery_gate.pause().await;
        Ok(self.files.lock().unwrap().clone())
    }
    async fn process_session_line(
        &self,
        _: &InputRuntime,
        record: &Map<String, Value>,
        _: &str,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        self.line_gate.pause().await;
        Ok(Some(serde_json::from_value(Value::Object(record.clone()))?))
    }
}
fn session(
    root: &Path,
    store: Arc<StateStore>,
    files: Arc<Mutex<Vec<String>>>,
    line: Arc<Gate>,
    discovery: Arc<Gate>,
) -> Arc<HostedInput<SessionAdapter<SessionProbe>>> {
    hosted_session(
        SessionProbe {
            paths: SessionPaths {
                session_dir: root.to_string_lossy().into_owned(),
                file_pattern: "*.jsonl".into(),
            },
            files,
            line_gate: line,
            discovery_gate: discovery,
        },
        "CollectScopeSession",
        store,
        Some(60000),
    )
}
async fn file(root: &Path) -> PathBuf {
    let path = root.join("session.jsonl");
    tokio::fs::write(&path,format!("{}\n",json!({"time_unix_nano":"1792897200000000000","event.id":"fresh-source-event","event.name":"other","user.id":"synthetic","gen_ai.session.id":"synthetic-session","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"REAL_FRESH_TAIL"}]}]}))).await.unwrap();
    path
}
async fn assert_pending(task: &tokio::task::JoinHandle<anyhow::Result<()>>) {
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !task.is_finished(),
        "another input persisted collection progress before emit/acceptance"
    );
}
async fn wait_gate(gate: &Gate) {
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
}
async fn disk_offset(path: &Path, key: &str) -> f64 {
    let disk: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    disk[key]["lastOffset"].as_f64().unwrap_or(0.0)
}
#[tokio::test]
async fn native_session_child_progress_then_real_second_file_error_cannot_be_saved_and_rebuild_replays_tail(
) {
    let root = tempfile::tempdir().unwrap();
    let source = file(root.path()).await;
    // The OS rejects this synthetic discovery result on every platform, after the real first file progressed.
    let bad = PathBuf::from(format!("{}\\invalid\0source", root.path().display()));
    let state_path = root.path().join("state.json");
    let key = format!("native-session-probe:{}", source.to_string_lossy());
    let store = Arc::new(StateStore::new(&state_path));
    store.set_offset(&key, 0.0);
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    let files = Arc::new(Mutex::new(vec![
        source.to_string_lossy().into_owned(),
        bad.to_string_lossy().into_owned(),
    ]));
    let gate = Gate::new(true);
    let host = session(
        root.path(),
        store.clone(),
        files,
        gate.clone(),
        Gate::new(false),
    );
    let errored = Arc::new(AtomicBool::new(false));
    {
        let errored = errored.clone();
        host.on_collect_error(move |_| {
            errored.store(true, Ordering::SeqCst);
        });
    }
    let emitted = Arc::new(Mutex::new(Vec::new()));
    {
        let emitted = emitted.clone();
        host.on_entries(move |batch| emitted.lock().unwrap().extend_from_slice(batch));
    }
    let collect = {
        let host = host.clone();
        tokio::spawn(async move { host.run_cycle().await })
    };
    wait_gate(&gate).await;
    assert!(store.get_offset(&key) > 0.0);
    store.set_offset("unrelated-source", 9.0);
    let saving = {
        let store = store.clone();
        tokio::spawn(async move { store.save().await })
    };
    assert_pending(&saving).await;
    assert_eq!(disk_offset(&state_path, &key).await, 0.0);
    gate.release.notify_one();
    collect.await.unwrap();
    assert!(saving.await.unwrap().is_err());
    assert!(errored.load(Ordering::SeqCst));
    assert!(emitted.lock().unwrap().is_empty());
    assert!(store.save_failed());
    assert_eq!(disk_offset(&state_path, &key).await, 0.0);
    let fresh = Arc::new(StateStore::new(&state_path));
    fresh.load().await;
    assert_eq!(fresh.get_offset("unrelated-source"), 7.0);
    let replay = session(
        root.path(),
        fresh.clone(),
        Arc::new(Mutex::new(vec![source.to_string_lossy().into_owned()])),
        Gate::new(false),
        Gate::new(false),
    );
    let accepted = Arc::new(Mutex::new(Vec::new()));
    {
        let accepted = accepted.clone();
        replay.on_entries(move |batch| accepted.lock().unwrap().extend_from_slice(batch));
    }
    replay.run_cycle().await;
    fresh.save().await.unwrap();
    assert_eq!(accepted.lock().unwrap().len(), 1);
    assert!(serde_json::to_string(&*accepted.lock().unwrap())
        .unwrap()
        .contains("REAL_FRESH_TAIL"));
    assert_eq!(
        disk_offset(&state_path, &key).await,
        tokio::fs::metadata(&source).await.unwrap().len() as f64
    );
    replay.run_cycle().await;
    assert_eq!(accepted.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn native_session_no_owned_progress_error_retries_and_other_input_save_is_not_frozen() {
    let root = tempfile::tempdir().unwrap();
    let source = file(root.path()).await;
    let bad = PathBuf::from(format!("{}\\invalid\0source", root.path().display()));
    let state_path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&state_path));
    store.set_offset("unrelated-source", 7.0);
    store.save().await.unwrap();
    let files = Arc::new(Mutex::new(vec![bad.to_string_lossy().into_owned()]));
    let gate = Gate::new(true);
    let host = session(
        root.path(),
        store.clone(),
        files.clone(),
        Gate::new(false),
        gate.clone(),
    );
    let errored = Arc::new(AtomicBool::new(false));
    {
        let errored = errored.clone();
        host.on_collect_error(move |_| {
            errored.store(true, Ordering::SeqCst);
        });
    }
    let collect = {
        let host = host.clone();
        tokio::spawn(async move { host.run_cycle().await })
    };
    wait_gate(&gate).await;
    store.set_offset("unrelated-source", 11.0);
    let saving = {
        let store = store.clone();
        tokio::spawn(async move { store.save().await })
    };
    assert_pending(&saving).await;
    gate.release.notify_one();
    collect.await.unwrap();
    saving.await.unwrap().unwrap();
    assert!(errored.load(Ordering::SeqCst));
    assert!(!store.save_failed());
    assert_eq!(disk_offset(&state_path, "unrelated-source").await, 11.0);
    *files.lock().unwrap() = vec![source.to_string_lossy().into_owned()];
    let output = Arc::new(Mutex::new(Vec::new()));
    {
        let output = output.clone();
        host.on_entries(move |batch| output.lock().unwrap().extend_from_slice(batch));
    }
    host.run_cycle().await;
    assert_eq!(output.lock().unwrap().len(), 1);
    assert!(!store.save_failed());
}
#[tokio::test]
async fn native_session_cancel_after_child_progress_keeps_disk_old_and_fresh_store_replays() {
    let root = tempfile::tempdir().unwrap();
    let source = file(root.path()).await;
    let state_path = root.path().join("state.json");
    let key = format!("native-session-probe:{}", source.to_string_lossy());
    let store = Arc::new(StateStore::new(&state_path));
    store.set_offset(&key, 0.0);
    store.save().await.unwrap();
    let gate = Gate::new(true);
    let host = session(
        root.path(),
        store.clone(),
        Arc::new(Mutex::new(vec![source.to_string_lossy().into_owned()])),
        gate.clone(),
        Gate::new(false),
    );
    let collect = {
        let host = host.clone();
        tokio::spawn(async move { host.run_cycle().await })
    };
    wait_gate(&gate).await;
    assert!(store.get_offset(&key) > 0.0);
    let saving = {
        let store = store.clone();
        tokio::spawn(async move { store.save().await })
    };
    assert_pending(&saving).await;
    collect.abort();
    assert!(collect.await.unwrap_err().is_cancelled());
    assert!(saving.await.unwrap().is_err());
    assert!(store.save_failed());
    assert_eq!(disk_offset(&state_path, &key).await, 0.0);
    let fresh = Arc::new(StateStore::new(state_path));
    fresh.load().await;
    let replay = session(
        root.path(),
        fresh.clone(),
        Arc::new(Mutex::new(vec![source.to_string_lossy().into_owned()])),
        Gate::new(false),
        Gate::new(false),
    );
    let output = Arc::new(Mutex::new(Vec::new()));
    {
        let output = output.clone();
        replay.on_entries(move |batch| output.lock().unwrap().extend_from_slice(batch));
    }
    replay.run_cycle().await;
    assert_eq!(output.lock().unwrap().len(), 1);
    assert!(!fresh.save_failed());
}
#[tokio::test]
async fn native_session_success_transfers_save_gating_to_output_acceptance_after_collect() {
    let root = tempfile::tempdir().unwrap();
    let source = file(root.path()).await;
    let state_path = root.path().join("state.json");
    let key = format!("native-session-probe:{}", source.to_string_lossy());
    let store = Arc::new(StateStore::new(&state_path));
    store.set_offset(&key, 0.0);
    store.save().await.unwrap();
    let gate = Gate::new(true);
    let host = session(
        root.path(),
        store.clone(),
        Arc::new(Mutex::new(vec![source.to_string_lossy().into_owned()])),
        gate.clone(),
        Gate::new(false),
    );
    let (tx, rx) = oneshot::channel::<()>();
    let rx = Arc::new(Mutex::new(Some(rx)));
    {
        let store = store.clone();
        let rx = rx.clone();
        host.on_entries(move |batch| {
            assert_eq!(batch.len(), 1);
            let rx = rx.lock().unwrap().take().unwrap();
            store.hold_save_until(async move {
                rx.await.map_err(|e| e.to_string())?;
                Ok(())
            });
        });
    }
    let collect = {
        let host = host.clone();
        tokio::spawn(async move { host.run_cycle().await })
    };
    wait_gate(&gate).await;
    let saving = {
        let store = store.clone();
        tokio::spawn(async move { store.save().await })
    };
    assert_pending(&saving).await;
    gate.release.notify_one();
    collect.await.unwrap();
    assert_pending(&saving).await;
    assert_eq!(disk_offset(&state_path, &key).await, 0.0);
    tx.send(()).unwrap();
    saving.await.unwrap().unwrap();
    assert_eq!(
        disk_offset(&state_path, &key).await,
        tokio::fs::metadata(source).await.unwrap().len() as f64
    );
    assert!(!store.save_failed());
}
struct SqliteProbe {
    path: String,
    gate: Arc<Gate>,
    busy: Arc<AtomicBool>,
}
#[async_trait]
impl SqliteBody for SqliteProbe {
    fn id(&self) -> &str {
        "known-sqlite-probe"
    }
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().into()])
    }
    fn agent_type(&self) -> ClientType {
        ClientType::Cursor
    }
    fn db_path(&self) -> &str {
        &self.path
    }
    async fn read_new_rows(
        &self,
        _: &InputRuntime,
        last: f64,
    ) -> anyhow::Result<Vec<Map<String, Value>>> {
        self.gate.pause().await;
        let conn = rusqlite::Connection::open_with_flags(
            &self.path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.busy_timeout(Duration::ZERO)?;
        let result = (|| -> rusqlite::Result<Vec<Map<String, Value>>> {
            let mut statement =
                conn.prepare("SELECT rowid, value FROM events WHERE rowid > ? ORDER BY rowid")?;
            let rows = statement.query_map([last], |row| {
                Ok(
                    json!({"rowid":row.get::<_,i64>(0)?,"value":row.get::<_,String>(1)?})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
            })?;
            rows.collect()
        })();
        match result {
            Ok(rows) => Ok(rows),
            Err(error) => {
                if let rusqlite::Error::SqliteFailure(detail, _) = &error {
                    if detail.code == rusqlite::ErrorCode::DatabaseBusy {
                        self.busy.store(true, Ordering::SeqCst);
                    }
                }
                Err(error.into())
            }
        }
    }
    async fn transform_row(
        &self,
        _: &InputRuntime,
        row: &Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        Ok(Some(serde_json::from_value(
            json!({"time_unix_nano":"1792897200000000000","event.id":"sqlite-fresh","event.name":"other","user.id":"synthetic","gen_ai.session.id":"sqlite-session","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":row["value"]}]}]}),
        )?))
    }
}
#[tokio::test]
async fn actual_sqlite_busy_without_owned_progress_does_not_freeze_other_input_and_recovers_next_cycle(
) {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("events.sqlite");
    let writer = rusqlite::Connection::open(&db).unwrap();
    writer.execute_batch("CREATE TABLE events(value TEXT);INSERT INTO events VALUES('FRESH_SQLITE_ROW');BEGIN EXCLUSIVE;").unwrap();
    let state_path = root.path().join("state.json");
    let store = Arc::new(StateStore::new(&state_path));
    store.set_offset("other-input", 1.0);
    store.save().await.unwrap();
    let gate = Gate::new(true);
    let busy = Arc::new(AtomicBool::new(false));
    let host: Arc<HostedInput<SqliteAdapter<SqliteProbe>>> = hosted_sqlite(
        SqliteProbe {
            path: db.to_string_lossy().into_owned(),
            gate: gate.clone(),
            busy: busy.clone(),
        },
        "ScopedSqliteBusy",
        store.clone(),
        Some(60000),
    );
    let output = Arc::new(Mutex::new(Vec::new()));
    {
        let output = output.clone();
        host.on_entries(move |entries| output.lock().unwrap().extend_from_slice(entries));
    }
    let cycle = {
        let host = host.clone();
        tokio::spawn(async move { host.run_cycle().await })
    };
    wait_gate(&gate).await;
    store.set_offset("other-input", 8.0);
    let saving = {
        let store = store.clone();
        tokio::spawn(async move { store.save().await })
    };
    assert_pending(&saving).await;
    gate.release.notify_one();
    cycle.await.unwrap();
    saving.await.unwrap().unwrap();
    assert!(busy.load(Ordering::SeqCst));
    assert!(!store.save_failed());
    assert_eq!(store.get_row_id("known-sqlite-probe"), 0.0);
    assert!(output.lock().unwrap().is_empty());
    assert_eq!(disk_offset(&state_path, "other-input").await, 8.0);
    writer.execute_batch("ROLLBACK").unwrap();
    host.run_cycle().await;
    store.save().await.unwrap();
    assert_eq!(output.lock().unwrap().len(), 1);
    assert_eq!(store.get_row_id("known-sqlite-probe"), 1.0);
    assert!(serde_json::to_string(&*output.lock().unwrap())
        .unwrap()
        .contains("FRESH_SQLITE_ROW"));
    assert!(!store.save_failed());
}
