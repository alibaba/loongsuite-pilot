//! Original #533 persisted receipts and legacy backlog, both real native clients.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::{InputState, InputStatePatch, StateStore};
use loongsuite_pilot::inputs::qoder_cn_trace::{
    QoderCnTraceInput, QoderCnTraceOptions, QoderCnTraceReaders,
};
use loongsuite_pilot::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver;
use loongsuite_pilot::inputs::qoder_trace::transcript_scanner;
use loongsuite_pilot::inputs::qoder_trace::transcript_source::QoderTranscriptSource;
use loongsuite_pilot::inputs::qoder_trace::{
    InterceptData, QoderTraceInput, QoderTraceOptions, QoderTraceReaders, SegmentTokenData,
    SqliteTokenResult,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct IsolatedReaders;
#[async_trait]
impl QoderTraceReaders for IsolatedReaders {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        vec![]
    }
    async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
        SqliteTokenResult {
            rows: vec![],
            matched_db_path: None,
        }
    }
    async fn read_ide_images(
        &self,
        _: &[String],
    ) -> Result<
        std::collections::HashMap<
            String,
            loongsuite_pilot::inputs::qoder_trace::AttachedImageLookup,
        >,
        String,
    > {
        Ok(Default::default())
    }
}
#[async_trait]
impl QoderCnTraceReaders for IsolatedReaders {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        vec![]
    }
    async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
        SqliteTokenResult {
            rows: vec![],
            matched_db_path: None,
        }
    }
}
enum NativeInput {
    Qoder(Arc<QoderTraceInput>),
    Cn(Arc<QoderCnTraceInput>),
}
impl NativeInput {
    fn create(
        root: &Path,
        agent: &str,
        store: Arc<StateStore>,
        capture: Arc<Mutex<Vec<AgentActivityEntry>>>,
    ) -> Self {
        let resolver = Arc::new(NativeQoderPromptOwnershipResolver::with_paths(Vec::new()));
        let on_entries = move |entries: &[AgentActivityEntry]| {
            capture.lock().unwrap().extend_from_slice(entries)
        };
        if agent == "qoder" {
            let input = Arc::new(QoderTraceInput::new_with_sources(
                QoderTraceOptions {
                    state_store: store,
                    log_dir: Some(root.join("history").to_string_lossy().into_owned()),
                    poll_interval_ms: Some(10),
                    multimodal_enabled: false,
                    upload_mode: None,
                    allowed_root_paths: vec![],
                },
                root.to_path_buf(),
                Arc::new(IsolatedReaders),
                resolver,
            ));
            input.bind_collector(on_entries, |_| {});
            Self::Qoder(input)
        } else {
            let input = Arc::new(QoderCnTraceInput::new_with_sources(
                QoderCnTraceOptions {
                    state_store: store,
                    log_dir: Some(root.join("history").to_string_lossy().into_owned()),
                    poll_interval_ms: Some(10),
                },
                root.to_path_buf(),
                Arc::new(IsolatedReaders),
                resolver,
            ));
            input.bind_collector(on_entries, |_| {});
            Self::Cn(input)
        }
    }
    async fn start(&self) {
        match self {
            Self::Qoder(input) => input.start().await.unwrap(),
            Self::Cn(input) => input.start().await.unwrap(),
        }
    }
    async fn stop(&self) {
        match self {
            Self::Qoder(input) => input.stop().await.unwrap(),
            Self::Cn(input) => input.stop().await.unwrap(),
        }
    }
}
fn canonical_event(agent: &str, id: &str, text: &str) -> Value {
    json!({"event.id":id,"event.name":"llm.response","time_unix_nano":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos().to_string(),
        "gen_ai.agent.type":agent,"gen_ai.session.id":"synthetic-session","gen_ai.turn.id":format!("turn-{id}"),
        "gen_ai.usage.input_tokens":11,"gen_ai.usage.output_tokens":7,
        "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":text}]}]})
}
async fn eventually(condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual native input did not deliver within fixture deadline");
}
#[tokio::test]
async fn source_l14_actual_both_inputs_drain_legal_large_line_successor_and_restarted_utf8_once() {
    for agent in ["qoder", "qoder-cn"] {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::create_dir(root.join("history")).unwrap();
        let name = format!(
            "{agent}-{}.jsonl",
            loongsuite_pilot::utils::get_today_date_string()
        );
        let file = root.join("history").join(&name);
        let source = format!(
            "{}\n{}\n",
            canonical_event(agent, "large", &"x".repeat(16 * 1024 * 1024)),
            canonical_event(agent, "small", "trailing answer")
        );
        std::fs::write(&file, &source).unwrap();
        let store = Arc::new(StateStore::new(root.join("state.json")));
        let id = format!("{agent}-trace");
        store.set(
            &id,
            InputState::new()
                .with_last_file(&name)
                .with_last_offset(0.0),
        );
        let capture = Arc::new(Mutex::new(Vec::<AgentActivityEntry>::new()));
        let input = NativeInput::create(&root, agent, store.clone(), capture.clone());
        input.start().await;
        eventually(|| capture.lock().unwrap().len() >= 2).await;
        assert_eq!(
            capture
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.event_id.clone())
                .collect::<Vec<_>>(),
            ["large", "small"]
        );
        assert_eq!(
            capture
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.input_tokens)
                .collect::<Vec<_>>(),
            [Some(11), Some(11)]
        );
        assert_eq!(store.get(&id).last_offset(), Some(source.len() as f64));
        let saved = store.get(&id).last_offset();
        let tail = serde_json::to_vec(&canonical_event(agent, "partial", "中文🙂")).unwrap();
        let split = tail
            .windows("中文".len())
            .position(|p| p == "中文".as_bytes())
            .unwrap()
            + 1;
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        writer.write_all(&tail[..split]).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(store.get(&id).last_offset(), saved);
        assert_eq!(capture.lock().unwrap().len(), 2);
        input.stop().await;
        let next = NativeInput::create(&root, agent, store.clone(), capture.clone());
        writer.write_all(&tail[split..]).unwrap();
        writer.write_all(b"\n").unwrap();
        drop(writer);
        next.start().await;
        eventually(|| capture.lock().unwrap().len() >= 3).await;
        assert_eq!(
            capture
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.event_id.clone())
                .collect::<Vec<_>>(),
            ["large", "small", "partial"]
        );
        assert!(
            serde_json::to_string(&capture.lock().unwrap().last().unwrap())
                .unwrap()
                .contains("中文🙂")
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(capture.lock().unwrap().len(), 3);
        next.stop().await;
    }
}
struct NativeSourceFixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    key: String,
    agent: String,
    nonce: u64,
}
impl NativeSourceFixture {
    fn new(agent: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let file = root.join("native.jsonl");
        std::fs::write(&file, []).unwrap();
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!(["synthetic-session", file])).unwrap(),
        ));
        Self {
            _temp: temp,
            root,
            file,
            key,
            agent: agent.into(),
            nonce: 0,
        }
    }
    fn append(&self, index: usize) {
        let now = chrono::Utc::now().timestamp_millis();
        let stamp = |delta| {
            chrono::DateTime::from_timestamp_millis(now + delta)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.file)
            .unwrap();
        for row in [
            json!({"type":"user","timestamp":stamp(-1000),"message":{"role":"user","content":format!("prompt {index}")}}),
            json!({"type":"assistant","timestamp":stamp(-500),"message":{"id":format!("response-{index}"),"role":"assistant","model":"synthetic-model","content":[{"type":"text","text":format!("answer {index}")}],"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt"}),
        ] {
            serde_json::to_writer(&mut writer, &row).unwrap();
            writer.write_all(b"\n").unwrap();
        }
    }
    fn wake(&mut self) {
        self.nonce += 1;
        let dir = self
            .root
            .join("state/qoder-transcripts")
            .join(&self.agent)
            .join("sources")
            .join(&self.key);
        let events = dir.join("events");
        std::fs::create_dir_all(&events).unwrap();
        let stat =
            transcript_scanner::version(&transcript_scanner::open_regular(&self.file).unwrap())
                .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let value = json!({"schema":1,"key":self.key,"agentId":self.agent,"sessionId":"synthetic-session","transcriptPath":self.file,
            "observedSize":stat.size,"observedAt":now,"event":"Stop","inode":stat.ino,"cwd":self.root,
            "observationId":format!("fixture-{}",self.nonce),"userIdentity":{"name":"synthetic-owner"}});
        loongsuite_pilot::hook_process::with_qoder_wakeup_lock(&dir, 25, || {
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
    fn create(&self) -> QoderTranscriptSource {
        QoderTranscriptSource::new(
            self.root.clone(),
            self.agent.clone(),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(Vec::new())),
        )
    }
    fn notices(&self) -> usize {
        let dir = self
            .root
            .join("state/qoder-transcripts")
            .join(&self.agent)
            .join("sources")
            .join(&self.key)
            .join("events");
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|s| s == "json"))
            .count()
    }
}
#[tokio::test]
async fn source_l19_both_sources_pause_after_real_save_failure_then_resume_fresh_tail_once() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = NativeSourceFixture::new(agent);
        let path = f.root.join("state.json");
        let id = format!("{agent}-trace");
        let store = StateStore::new(&path);
        store.load().await;
        store.set(&id, InputState::new());
        store.save().await.unwrap();
        let source = f.create();
        f.append(0);
        f.wake();
        let first = source.read(None, true).await.unwrap();
        assert_eq!(first.records.len(), 3);
        store.update(
            &id,
            InputStatePatch {
                extra: Some(json!({"qoderTranscripts":first.state})),
                ..Default::default()
            },
        );
        let optimistic = store.get(&id).extra().unwrap()["qoderTranscripts"].clone();
        let old = path.with_extension("old");
        std::fs::rename(&path, &old).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(store.save().await.is_err());
        assert!(!store.save_failed());
        assert!(!store.is_persisted(&id, None));
        assert_eq!(f.notices(), 1);
        f.append(1);
        f.wake();
        let blocked = source
            .read(Some(&optimistic), store.is_persisted(&id, None))
            .await
            .unwrap();
        assert!(blocked.records.is_empty());
        assert_eq!(blocked.metrics.bytes_read, 0);
        assert_eq!(blocked.state, optimistic);
        assert_eq!(f.notices(), 2);
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&old, &path).unwrap();
        store.save().await.unwrap();
        let recovered = source
            .read(Some(&optimistic), store.is_persisted(&id, None))
            .await
            .unwrap();
        assert_eq!(recovered.records.len(), 3);
        assert!(serde_json::to_string(&recovered.records)
            .unwrap()
            .contains("prompt 1"));
        assert!(recovered
            .records
            .iter()
            .all(|r| r["user.name"] == "synthetic-owner"));
        store.update(
            &id,
            InputStatePatch {
                extra: Some(json!({"qoderTranscripts":recovered.state})),
                ..Default::default()
            },
        );
        store.save().await.unwrap();
        source.stop();
        let fresh = f.create();
        let extra = store.get(&id).extra().unwrap();
        assert!(fresh
            .read(extra.get("qoderTranscripts"), store.is_persisted(&id, None))
            .await
            .unwrap()
            .records
            .is_empty());
        assert_eq!(f.notices(), 0);
        let loaded = StateStore::new(&path);
        loaded.load().await;
        assert!(loaded.is_persisted(&id, None));
        let extra = loaded.get(&id).extra().unwrap();
        assert!(fresh
            .read(
                extra.get("qoderTranscripts"),
                loaded.is_persisted(&id, None)
            )
            .await
            .unwrap()
            .records
            .is_empty());
        fresh.stop();
    }
}
