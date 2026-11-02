//! Main #533 native CN entry, actual metadata gate/SQLite/checkpoint recovery.
use super::*;
use crate::checkpoints::{InputState, StateStore};
use crate::inputs::qoder_trace::transcript_scanner;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

struct SqliteReaders {
    path: String,
    calls: AtomicUsize,
}
#[async_trait]
impl QoderCnTraceReaders for SqliteReaders {
    async fn read_ide_tokens(
        &self,
        session: &str,
    ) -> crate::inputs::qoder_trace::SqliteTokenResult {
        self.calls.fetch_add(1, Ordering::SeqCst);
        read_sqlite_tokens(session, std::slice::from_ref(&self.path)).await
    }
}
struct F {
    _root: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    state: PathBuf,
    key: String,
    at: i64,
    readers: Arc<SqliteReaders>,
    nonce: u64,
}
impl F {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let file = root.join("native.jsonl");
        std::fs::write(&file, []).unwrap();
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!(["native-session", file])).unwrap(),
        ));
        let state = root.join("state.json");
        let db = root.join("temporary-token-database.db");
        let at = chrono::Utc::now().timestamp_millis() - 1000;
        let sql = rusqlite::Connection::open(&db).unwrap();
        sql.execute_batch("CREATE TABLE chat_message(id TEXT,session_id TEXT,request_id TEXT,role TEXT,gmt_create INTEGER,token_info TEXT,model_info TEXT);CREATE TABLE chat_record(request_id TEXT,extra TEXT)").unwrap();
        for i in 0..2 {
            sql.execute(
                "INSERT INTO chat_message VALUES (?1,'native-session',?2,'assistant',?3,?4,?5)",
                rusqlite::params![
                    format!("response-{i}"),
                    format!("request-{i}"),
                    at + i * 10000 + 100,
                    json!({"prompt_tokens":100+i*10,"completion_tokens":10+i,"cached_tokens":50})
                        .to_string(),
                    json!({"model_key":"synthetic-model"}).to_string()
                ],
            )
            .unwrap();
        }
        drop(sql);
        Self {
            _root: dir,
            root,
            file,
            state,
            key,
            at,
            readers: Arc::new(SqliteReaders {
                path: db.to_string_lossy().into_owned(),
                calls: AtomicUsize::new(0),
            }),
            nonce: 0,
        }
    }
    fn turn(&self, index: i64) -> Vec<u8> {
        let timestamp = |delta| {
            chrono::DateTime::from_timestamp_millis(self.at + index * 10000 + delta)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let rows = [
            json!({"type":"user","timestamp":timestamp(10),"message":{"role":"user","content":format!("NATIVE-ONLY-prompt-{index}")}}),
            json!({"type":"assistant","timestamp":timestamp(100),"message":{"id":format!("response-{index}"),"role":"assistant","model":"synthetic-model","content":[{"type":"text","text":format!("NATIVE-ONLY-answer-{index}")}],"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt"}),
        ];
        let mut bytes = Vec::new();
        for row in rows {
            serde_json::to_writer(&mut bytes, &row).unwrap();
            bytes.push(b'\n');
        }
        bytes
    }
    fn append(&self, index: i64) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&self.file)
            .unwrap()
            .write_all(&self.turn(index))
            .unwrap();
    }
    fn wake(&mut self) {
        self.nonce += 1;
        let dir = self
            .root
            .join("state/qoder-transcripts/qoder-cn/sources")
            .join(&self.key);
        let events = dir.join("events");
        std::fs::create_dir_all(&events).unwrap();
        let version =
            transcript_scanner::version(&transcript_scanner::open_regular(&self.file).unwrap())
                .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let value = json!({"schema":1,"key":self.key,"agentId":"qoder-cn","sessionId":"native-session",
            "transcriptPath":self.file,"observedSize":version.size,"observedAt":now,"event":"Stop","inode":version.ino,
            "cwd":self.root,"observationId":format!("fixture-{}",self.nonce),
            "userIdentity":{"name":"synthetic-owner","email":"synthetic@invalid.test"}});
        crate::hook_process::with_qoder_wakeup_lock(&dir, 25, || {
            if !dir.join("source.json").exists() {
                std::fs::write(dir.join("source.json"), serde_json::to_vec(&value)?)?;
            }
            std::fs::write(
                events.join(format!("{now}-Stop-{:024x}.json", self.nonce)),
                serde_json::to_vec(&value)?,
            )?;
            Ok(())
        })
        .unwrap()
        .unwrap();
    }
    fn notices(&self) -> usize {
        let dir = self
            .root
            .join("state/qoder-transcripts/qoder-cn/sources")
            .join(&self.key)
            .join("events");
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|s| s == "json"))
            .count()
    }
    fn input(&self, store: Arc<StateStore>) -> QoderCnTraceInput {
        QoderCnTraceInput::new_with_sources(
            QoderCnTraceOptions {
                state_store: store,
                log_dir: Some(
                    self.root
                        .join("logs/qoder-cn/history")
                        .to_string_lossy()
                        .into_owned(),
                ),
                poll_interval_ms: Some(60_000),
            },
            self.root.clone(),
            self.readers.clone(),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(Vec::new())),
        )
    }
}
async fn collect(input: &QoderCnTraceInput) -> Vec<AgentActivityEntry> {
    input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
}
#[tokio::test]
async fn native_cn_entry_reads_real_native_source_then_preserves_identity_and_exact_sqlite_usage() {
    let mut f = F::new();
    f.append(0);
    f.wake();
    let store = Arc::new(StateStore::new(&f.state));
    let input = f.input(Arc::clone(&store));
    let entries = collect(&input).await;
    assert_eq!(entries.len(), 3);
    assert!(entries.iter().all(|e| e.agent_type == "qoder-cn"));
    assert!(entries
        .iter()
        .all(|e| e.user_name.as_deref() == Some("synthetic-owner")));
    assert!(entries
        .iter()
        .all(|e| e.user_email.as_deref() == Some("synthetic@invalid.test")));
    let responses = entries
        .iter()
        .filter(|e| e.event_name == Some(crate::types::AgentEventName::LlmResponse))
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].input_tokens, Some(100));
    assert_eq!(responses[0].output_tokens, Some(10));
    assert_eq!(f.readers.calls.load(Ordering::SeqCst), 1);
    assert!(serde_json::to_string(&entries)
        .unwrap()
        .contains("NATIVE-ONLY-prompt-0"));
    let native = store.get("qoder-cn-trace").extra().unwrap()["qoderTranscripts"].clone();
    assert!(native.is_object() && !native.as_object().unwrap().is_empty());
    assert!(!serde_json::to_string(&native)
        .unwrap()
        .contains("NATIVE-ONLY"));
    assert!(!store.is_persisted("qoder-cn-trace", Some("qoderTranscripts")));
    assert_eq!(f.notices(), 1);
    store.save().await.unwrap();
    assert!(collect(&input).await.is_empty());
    assert_eq!(f.notices(), 0);
    input.stop().await.unwrap();
}
#[tokio::test]
async fn source_l19_cn_real_input_disk_failure_keeps_receipts_pauses_tail_and_restarts_after_repair(
) {
    let mut f = F::new();
    let store = Arc::new(StateStore::new(&f.state));
    store.load().await;
    store.set("qoder-cn-trace", InputState::new());
    store.save().await.unwrap();
    f.append(0);
    f.wake();
    let input = f.input(Arc::clone(&store));
    assert_eq!(collect(&input).await.len(), 3);
    let optimistic = store.get("qoder-cn-trace").extra().unwrap()["qoderTranscripts"].clone();
    let old = f.state.with_extension("old");
    std::fs::rename(&f.state, &old).unwrap();
    std::fs::create_dir(&f.state).unwrap();
    assert!(store.save().await.is_err());
    assert!(!store.save_failed());
    assert!(!store.is_persisted("qoder-cn-trace", Some("qoderTranscripts")));
    assert_eq!(f.notices(), 1);
    f.append(1);
    f.wake();
    assert!(collect(&input).await.is_empty());
    assert_eq!(
        store.get("qoder-cn-trace").extra().unwrap()["qoderTranscripts"],
        optimistic
    );
    assert_eq!(f.notices(), 2);
    assert_eq!(f.readers.calls.load(Ordering::SeqCst), 1);
    std::fs::remove_dir(&f.state).unwrap();
    std::fs::rename(&old, &f.state).unwrap();
    store.save().await.unwrap();
    let recovered = collect(&input).await;
    assert_eq!(recovered.len(), 3);
    assert!(serde_json::to_string(&recovered)
        .unwrap()
        .contains("NATIVE-ONLY-prompt-1"));
    assert!(!serde_json::to_string(&recovered)
        .unwrap()
        .contains("NATIVE-ONLY-prompt-0"));
    assert!(recovered
        .iter()
        .all(|e| e.user_name.as_deref() == Some("synthetic-owner")));
    store.save().await.unwrap();
    input.stop().await.unwrap();
    let loaded = Arc::new(StateStore::new(&f.state));
    loaded.load().await;
    assert!(loaded.is_persisted("qoder-cn-trace", Some("qoderTranscripts")));
    let fresh = f.input(Arc::clone(&loaded));
    assert!(collect(&fresh).await.is_empty());
    assert_eq!(f.notices(), 0);
    fresh.stop().await.unwrap();
}
