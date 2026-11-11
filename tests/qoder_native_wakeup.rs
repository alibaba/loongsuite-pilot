//! Real native hook binary -> bounded wakeup metadata -> actual collector input.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::inputs::qoder_cn_trace::{
    QoderCnTraceInput, QoderCnTraceOptions, QoderCnTraceReaders,
};
use loongsuite_pilot::inputs::qoder_trace::{
    InterceptData, QoderTraceInput, QoderTraceOptions, QoderTraceReaders, SegmentTokenData,
    SqliteTokenData, SqliteTokenResult,
};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn command(root: &Path, agent: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
    command.env_clear();
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("LOONGSUITE_PILOT_DATA_DIR", root)
        .args([
            "hook-process",
            "qoder",
            "--wakeup-only",
            "--agent-id",
            agent,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
struct Readers(i64);
impl Readers {
    fn tokens(&self) -> SqliteTokenResult {
        SqliteTokenResult {
            rows: vec![SqliteTokenData {
                session_id: "native-session".into(),
                request_id: "native-request".into(),
                message_id: "native-response".into(),
                gmt_create: self.0,
                input_tokens: 17,
                output_tokens: 5,
                cache_read_tokens: 2,
                model: Some("synthetic-model".into()),
            }],
            matched_db_path: None,
        }
    }
}
#[async_trait]
impl QoderTraceReaders for Readers {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        vec![]
    }
    async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
        self.tokens()
    }
}
#[async_trait]
impl QoderCnTraceReaders for Readers {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        vec![]
    }
    async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
        self.tokens()
    }
}

#[tokio::test]
async fn actual_native_hook_notice_reaches_both_real_inputs_without_legacy_jsonl() {
    for agent in ["qoder", "qoder-cn"] {
        let temporary = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temporary.path()).unwrap();
        let file = root.join("native.jsonl");
        let at = chrono::Utc::now().timestamp_millis();
        let stamp = |delta| {
            chrono::DateTime::from_timestamp_millis(at + delta)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let rows = [
            json!({"type":"user","uuid":"native-user","timestamp":stamp(0),"message":{"role":"user","content":"synthetic native hook fixture"}}),
            json!({"type":"assistant","timestamp":stamp(300),"message":{"id":"native-response","role":"assistant","model":"synthetic-model","content":[{"type":"text","text":"synthetic answer"}],"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt"}),
        ];
        let content = rows
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(&file, &content).unwrap();
        let payload = json!({"session_id":"native-session","transcript_path":file,"hook_event_name":"Stop","cwd":root,
            "parent_business_info":{"product":"app"}});
        let mut hook = command(&root, agent);
        if agent == "qoder" {
            hook.env("LOONGSUITE_PILOT_DATA_DIR", root.join("wrong-data-root"))
                .arg("--data-dir")
                .arg(&root);
        }
        let mut child = hook.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({})
        );
        assert!(
            !root.join("logs").join(agent).join("history").exists(),
            "thin hook must not produce legacy transcript JSONL"
        );
        let sources = root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources");
        let directories = std::fs::read_dir(&sources)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(directories.len(), 1);
        let notice: Value =
            serde_json::from_slice(&std::fs::read(directories[0].join("source.json")).unwrap())
                .unwrap();
        assert_eq!(notice["observedSize"], content.len());
        assert_eq!(notice["agentId"], agent);
        assert_eq!(
            std::fs::canonicalize(notice["transcriptPath"].as_str().unwrap()).unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        assert!(!notice.to_string().contains("synthetic answer"));
        let store = Arc::new(StateStore::new(root.join("input-state.json")));
        let entries = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&entries);
        let log_dir = Some(
            root.join("logs")
                .join(agent)
                .join("history")
                .to_string_lossy()
                .into_owned(),
        );
        // The default resolver sees a desktop terminal turn; readers stay entirely synthetic.
        let resolver=Arc::new(loongsuite_pilot::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver::with_paths(vec![]));
        let qoder;
        let cn;
        if agent == "qoder" {
            qoder = Some(QoderTraceInput::new_with_sources(
                QoderTraceOptions {
                    state_store: Arc::clone(&store),
                    log_dir,
                    poll_interval_ms: Some(10),
                    multimodal_enabled: false,
                    upload_mode: None,
                    allowed_root_paths: vec![],
                },
                root.clone(),
                Arc::new(Readers(at + 300)),
                resolver,
            ));
            cn = None;
            qoder.as_ref().unwrap().bind_collector(
                move |batch| captured.lock().unwrap().extend_from_slice(batch),
                |_| {},
            );
            qoder.as_ref().unwrap().start().await.unwrap();
        } else {
            cn = Some(QoderCnTraceInput::new_with_sources(
                QoderCnTraceOptions {
                    state_store: Arc::clone(&store),
                    log_dir,
                    poll_interval_ms: Some(10),
                },
                root.clone(),
                Arc::new(Readers(at + 300)),
                resolver,
            ));
            qoder = None;
            cn.as_ref().unwrap().bind_collector(
                move |batch| captured.lock().unwrap().extend_from_slice(batch),
                |_| {},
            );
            cn.as_ref().unwrap().start().await.unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !entries.lock().unwrap().iter().any(
            |row: &loongsuite_pilot::types::AgentActivityEntry| {
                row.event_name
                    .is_some_and(|name| name.as_str() == "llm.response")
            },
        ) {
            assert!(
                Instant::now() < deadline,
                "{agent}: hook metadata did not reach actual input"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if let Some(input) = qoder {
            input.stop().await.unwrap();
        }
        if let Some(input) = cn {
            input.stop().await.unwrap();
        }
        let captured = entries.lock().unwrap();
        let responses = captured
            .iter()
            .filter(|row| {
                row.event_name
                    .is_some_and(|name| name.as_str() == "llm.response")
            })
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 1, "{agent}");
        assert_eq!(responses[0].input_tokens, Some(17));
        assert_eq!(responses[0].output_tokens, Some(5));
        assert!(root.join("input-state.json").exists());
        let state = store.get(&format!("{agent}-trace")).extra().unwrap();
        let saved = state["qoderTranscripts"].as_object().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            saved.values().next().unwrap()["committedOffset"],
            content.len()
        );
    }
}

#[test]
fn native_hook_bounds_oversized_and_unclosed_stdin_without_publishing_a_notice() {
    for agent in ["qoder", "qoder-cn"] {
        let temporary = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temporary.path()).unwrap();
        let mut oversized = command(&root, agent).spawn().unwrap();
        oversized
            .stdin
            .take()
            .unwrap()
            .write_all(&vec![b'x'; 1024 * 1024 + 1])
            .unwrap();
        let output = oversized.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({})
        );
        assert!(!root.join("state/qoder-transcripts").exists());
        let started = Instant::now();
        let mut stalled = command(&root, agent).spawn().unwrap();
        // Keep this handle alive until the process exits: dropping it would fake EOF.
        let mut stdin = stalled.stdin.take().unwrap();
        stdin.write_all(b"{").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while stalled.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = stalled.kill();
                panic!("native hook waited forever for EOF");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = stalled.wait_with_output().unwrap();
        drop(stdin);
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({})
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!root.join("state/qoder-transcripts").exists());
    }
}
