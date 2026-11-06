//! Actual Qoder Input admission, native transcript and token-enrichment route.
//! Every file/notice/state belongs to one canonical synthetic temp data root.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::inputs::qoder_trace::{
    InterceptData, QoderTraceInput, QoderTraceOptions, QoderTraceReaders, SegmentTokenData,
    SqliteTokenData, SqliteTokenResult,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
struct Readers {
    at: i64,
}
#[async_trait]
impl QoderTraceReaders for Readers {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        Vec::new()
    }
    async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
        SqliteTokenResult {
            rows: vec![SqliteTokenData {
                session_id: "session".into(),
                request_id: "request-native".into(),
                message_id: "response-native".into(),
                gmt_create: self.at,
                input_tokens: 17,
                output_tokens: 5,
                cache_read_tokens: 2,
                model: Some("synthetic-model".into()),
            }],
            matched_db_path: None,
        }
    }
}
#[tokio::test]
async fn actual_qoder_input_collects_notice_only_native_transcript_enriches_and_saves_its_cursor() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let file = root.join("native.jsonl");
    let at = chrono::Utc::now().timestamp_millis();
    let iso = |delta| {
        chrono::DateTime::from_timestamp_millis(at + delta)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let rows = [
        json!({"type":"user","uuid":"user-native","timestamp":iso(0),"message":{"role":"user","content":"native input fixture"}}),
        json!({"type":"assistant","timestamp":iso(300),"message":{"id":"response-native","role":"assistant","model":"synthetic-model","content":[{"type":"text","text":"native answer"}],"stop_reason":"end_turn"}}),
        json!({"type":"last-prompt"}),
    ];
    let body = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&file, &body).unwrap();
    let key = hex::encode(Sha256::digest(
        serde_json::to_vec(&json!(["session", file])).unwrap(),
    ));
    let dir = root
        .join("state/qoder-transcripts/qoder/sources")
        .join(&key);
    std::fs::create_dir_all(dir.join("events")).unwrap();
    let notice = json!({"schema":1,"key":key,"agentId":"qoder","sessionId":"session","transcriptPath":file,"observedSize":body.len(),"observedAt":at,"event":"Stop","cwd":root,"observationId":"native-route"});
    std::fs::write(dir.join("source.json"), notice.to_string()).unwrap();
    std::fs::write(
        dir.join("events")
            .join(format!("{at}-Stop-000000000000000000000001.json")),
        notice.to_string(),
    )
    .unwrap();
    let store = Arc::new(StateStore::new(root.join("input-state.json")));
    let input = QoderTraceInput::with_readers(
        QoderTraceOptions {
            state_store: Arc::clone(&store),
            log_dir: Some(
                root.join("logs/qoder/history")
                    .to_string_lossy()
                    .into_owned(),
            ),
            poll_interval_ms: Some(60000),
            multimodal_enabled: false,
            upload_mode: None,
            allowed_root_paths: Vec::new(),
        },
        Arc::new(Readers { at: at + 300 }),
    );
    let entries = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&entries);
    input.bind_collector(
        move |batch| captured.lock().unwrap().extend_from_slice(batch),
        |_| {},
    );
    input.start().await.unwrap();
    input.inner.run_cycle().await;
    input.stop().await.unwrap();
    let rows = entries.lock().unwrap();
    let responses = rows
        .iter()
        .filter(|e| e.event_name.is_some_and(|n| n.as_str() == "llm.response"))
        .collect::<Vec<_>>();
    assert_eq!(
        responses.len(),
        1,
        "real Input must consume the native source even when legacy Hook JSONL is absent"
    );
    assert_eq!(responses[0].input_tokens, Some(17));
    assert_eq!(responses[0].output_tokens, Some(5));
    let saved = store.get("qoder-trace").extra().unwrap();
    assert_eq!(
        saved["qoderTranscripts"][&key]["committedOffset"],
        body.len()
    );
    assert!(root.join("input-state.json").exists());
}
