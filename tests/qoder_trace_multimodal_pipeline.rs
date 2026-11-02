//! Real hook JSONL -> Qoder hosted input -> manager -> JSONL image contracts.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::{InputState, StateStore};
use loongsuite_pilot::core::{InputManager, LiveInput};
use loongsuite_pilot::flushers::{BaseFlusher, JsonlFlusher};
use loongsuite_pilot::inputs::qoder_trace::{
    read_attached_image_paths, AttachedImageLookup, InterceptData, QoderTraceInput,
    QoderTraceOptions, QoderTraceReaders, SegmentTokenData, SqliteTokenResult,
};
use loongsuite_pilot::multimodal::types::{UploadItem, UploadOptions, Uploader};
use loongsuite_pilot::multimodal::MultimodalProcessor;
use loongsuite_pilot::types::{JsonlFlusherConfig, MultimodalUploadMode};
use loongsuite_pilot::utils::get_today_date_string;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct MemoryUploader(Mutex<Vec<UploadItem>>);
#[async_trait]
impl Uploader for MemoryUploader {
    async fn upload(&self, item: UploadItem, _: UploadOptions) -> bool {
        self.0.lock().unwrap().push(item);
        true
    }
    async fn shutdown(&self) {}
}
fn tool(id: &str, variant: &str, path: &Path) -> Value {
    json!({"event.id":id,"event.name":"tool.result","gen_ai.agent.type":variant,
 "gen_ai.session.id":format!("{id}-session"),"gen_ai.turn.id":format!("{id}-turn"),
 "gen_ai.tool.call.result":format!("Image file: {}",path.display()),
 "multica.issue.id":format!("{variant}-992"),"agentcore.task_id":format!("task-{variant}-runtime"),
 "time_unix_nano":"1780000000000000000"})
}
#[derive(Default)]
struct IsolatedReaders {
    databases: Vec<String>,
}
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
        ids: &[String],
    ) -> Result<std::collections::HashMap<String, AttachedImageLookup>, String> {
        Ok(read_attached_image_paths(ids, &self.databases).await)
    }
}
struct Pipeline {
    input: Arc<QoderTraceInput>,
    manager: Arc<InputManager>,
    uploader: Arc<MemoryUploader>,
    processor: Arc<MultimodalProcessor>,
    file: PathBuf,
    out: PathBuf,
}
impl Pipeline {
    async fn new(root: &Path, records: &[Value]) -> Self {
        Self::with_databases(root, records, vec![]).await
    }
    async fn with_databases(root: &Path, records: &[Value], databases: Vec<String>) -> Self {
        let logs = root.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let name = format!("qoder-{}.jsonl", get_today_date_string());
        let file = logs.join(&name);
        std::fs::write(
            &file,
            records.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
        let store = Arc::new(StateStore::new(root.join("state.json")));
        store.set(
            "qoder-trace",
            InputState::new()
                .with_last_file(name)
                .with_last_offset(0.0)
                .with_extra(json!({"hookHistoryInitialized":true})),
        );
        let input = Arc::new(QoderTraceInput::with_readers(
            QoderTraceOptions {
                state_store: store.clone(),
                log_dir: Some(logs.to_string_lossy().into_owned()),
                poll_interval_ms: Some(60000),
                multimodal_enabled: true,
                upload_mode: Some(MultimodalUploadMode::Input),
                allowed_root_paths: vec![root.to_string_lossy().into_owned()],
            },
            Arc::new(IsolatedReaders { databases }),
        ));
        let uploader = Arc::new(MemoryUploader::default());
        let processor =
            MultimodalProcessor::new(Some("oss://bucket/pilot-mm"), uploader.clone(), None)
                .unwrap();
        input.set_multimodal_processor(processor.clone());
        let out = root.join("output");
        let flusher = Arc::new(JsonlFlusher::new(
            serde_json::from_value::<JsonlFlusherConfig>(
                json!({"enabled":true,"outputDir":out,"rotateDaily":false,"maxFileSizeMb":1}),
            )
            .unwrap(),
        ));
        flusher.start().await.unwrap();
        let manager = Arc::new(InputManager::new());
        manager.set_state_store(store);
        manager.set_flusher(flusher);
        manager.set_user_id("synthetic-user");
        let (a, b, c) = (input.clone(), input.clone(), input.clone());
        manager.register_input(LiveInput::new(
            "qoder-trace",
            "qoder",
            "hook-jsonl",
            move || a.collector_running(),
            move || {
                let i = b.clone();
                Box::pin(async move { i.start().await })
            },
            move || {
                let i = c.clone();
                Box::pin(async move {
                    i.stop().await.unwrap();
                })
            },
        ));
        let weak = Arc::downgrade(&manager);
        input.bind_collector(
            move |entries| {
                if let Some(m) = weak.upgrade() {
                    m.bind_entries("qoder-trace", entries.to_vec());
                }
            },
            |_| {},
        );
        Self {
            input,
            manager,
            uploader,
            processor,
            file,
            out,
        }
    }
    async fn settle(&self) -> Vec<Value> {
        self.manager.stop_all().await;
        self.processor.shutdown(1000).await;
        let mut output = vec![];
        if let Ok(files) = std::fs::read_dir(&self.out) {
            for f in files.flatten() {
                for line in std::fs::read_to_string(f.path()).unwrap().lines() {
                    output.push(serde_json::from_str(line).unwrap());
                }
            }
        }
        output
    }
}
fn png(path: &Path) {
    use base64::Engine;
    std::fs::write(path,base64::engine::general_purpose::STANDARD.decode(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1cAAAAASUVORK5CYII=").unwrap()).unwrap();
}
#[tokio::test]
async fn collect_l2613_ide_cli_image_and_invocation_reach_jsonl() {
    let dir = tempfile::tempdir().unwrap();
    let image = dir.path().join("shot.png");
    png(&image);
    let p = Pipeline::new(
        dir.path(),
        &[
            tool("ide-tool", "qoder", &image),
            tool("cli-tool", "qoder-cli", &image),
        ],
    )
    .await;
    p.input.start().await.unwrap();
    let output = p.settle().await;
    assert_eq!(output.len(), 2);
    for variant in ["qoder", "qoder-cli"] {
        let e = output
            .iter()
            .find(|e| e["gen_ai.agent.type"] == variant)
            .unwrap();
        assert!(
            e["gen_ai.tool.call.result"].is_array(),
            "actual final JSONL did not contain enriched image: {e}"
        );
        assert_eq!(e["multica.issue.id"], format!("{variant}-992"));
        assert_eq!(e["agentcore.task_id"], format!("task-{variant}-runtime"));
        let uri = &e["gen_ai.tool.call.result"][1]["uri"];
        assert!(uri.as_str().unwrap().starts_with("oss://bucket/pilot-mm/"));
        assert_eq!(e["gen_ai.input.multimodal_metadata"][0]["uri"], *uri);
    }
    let uploads = p.uploader.0.lock().unwrap();
    assert!(!uploads.is_empty());
    assert!(uploads
        .iter()
        .all(|u| u.content_type == "image/png" && !u.data.as_ref().unwrap().is_empty()));
}

#[tokio::test]
async fn collect_l2586_excluded_ide_never_converts_or_emits() {
    let d = tempfile::tempdir().unwrap();
    let image = d.path().join("secret.png");
    png(&image);
    let mut record = tool("private-response", "qoder", &image);
    record["event.name"] = json!("llm.response");
    record["gen_ai.request.id"] = json!("private-req");
    record["agent.qoder.cwd"] = json!(d.path());
    record["gen_ai.output.messages"] = json!([]);
    let database = d.path().join("private.sqlite");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TABLE chat_record (request_id TEXT, extra TEXT); CREATE TABLE chat_message (request_id TEXT, role TEXT, gmt_create INTEGER);").unwrap();
    connection
        .execute(
            "INSERT INTO chat_record VALUES (?1,?2)",
            rusqlite::params![
                "private-req",
                json!({"attachedImagePaths":[image]}).to_string()
            ],
        )
        .unwrap();
    drop(connection);
    let databases = vec![database.to_string_lossy().into_owned()];
    // Positive control: the reader really has a secret attachment. The policy,
    // rather than an empty lookup fixture, must prevent conversion.
    assert_eq!(
        read_attached_image_paths(&["private-req".into()], &databases).await["private-req"].paths,
        vec![image.to_string_lossy().into_owned()]
    );
    let p = Pipeline::with_databases(d.path(), &[record], databases).await;
    p.input.inner.runtime.set_workspace_policy(
        loongsuite_pilot::inputs::base::WorkspacePolicy::new(
            vec![d.path().to_string_lossy().into_owned()],
            None,
        ),
    );
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let captured = calls.clone();
    p.input.set_multimodal_handler(Arc::new(move |_, _| {
        captured.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { panic!("excluded workspace attempted image conversion") })
    }));
    p.input.start().await.unwrap();
    let output = p.settle().await;
    assert!(output.is_empty());
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(p.uploader.0.lock().unwrap().is_empty());
}
#[tokio::test]
async fn collect_l2757_jetbrains_skipped_desktop_enriched() {
    let d = tempfile::tempdir().unwrap();
    let image = d.path().join("shot.png");
    png(&image);
    let p = Pipeline::new(
        d.path(),
        &[
            tool("idea-tool", "qoder-idea", &image),
            tool("ide-tool", "qoder", &image),
        ],
    )
    .await;
    p.input.start().await.unwrap();
    let output = p.settle().await;
    assert_eq!(
        output
            .iter()
            .find(|v| v["event.id"] == "idea-tool")
            .unwrap()["gen_ai.tool.call.result"],
        format!("Image file: {}", image.display())
    );
    assert!(output.iter().find(|v| v["event.id"] == "ide-tool").unwrap()
        ["gen_ai.tool.call.result"]
        .is_array());
}
#[tokio::test]
async fn collect_l2816_timed_out_adapter_preserves_text() {
    let d = tempfile::tempdir().unwrap();
    let image = d.path().join("shot.png");
    png(&image);
    let mut record = tool("cli-tool", "qoder-cli", &image);
    let text = format!("Read image: {} (1KB)", image.display());
    record["gen_ai.tool.call.result"] = json!(text);
    let p = Pipeline::new(d.path(), &[record]).await;
    p.input.set_multimodal_handler(Arc::new(|_, _| {
        Box::pin(async {
            let result = tokio::time::timeout(
                std::time::Duration::from_millis(40),
                std::future::pending::<()>(),
            )
            .await;
            assert!(result.is_err());
            Ok(None)
        })
    }));
    let start = std::time::Instant::now();
    p.input.start().await.unwrap();
    assert!(start.elapsed().as_millis() < 500);
    let output = p.settle().await;
    assert_eq!(
        output.iter().find(|v| v["event.id"] == "cli-tool").unwrap()["gen_ai.tool.call.result"],
        text
    );
}
#[tokio::test]
async fn collect_l2864_stop_then_start_resumes_images() {
    let d = tempfile::tempdir().unwrap();
    let image = d.path().join("shot.png");
    png(&image);
    let p = Pipeline::new(d.path(), &[tool("cli-tool-1", "qoder-cli", &image)]).await;
    p.input.start().await.unwrap();
    p.input.stop().await.unwrap();
    use std::io::Write;
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&p.file)
            .unwrap(),
        "{}",
        tool("cli-tool-2", "qoder-cli", &image)
    )
    .unwrap();
    p.input.start().await.unwrap();
    let output = p.settle().await;
    for id in ["cli-tool-1", "cli-tool-2"] {
        assert!(
            output.iter().find(|v| v["event.id"] == id).unwrap()["gen_ai.tool.call.result"]
                .is_array()
        );
    }
}
#[tokio::test]
async fn collect_l2918_stop_releases_pending_path_adapter() {
    let d = tempfile::tempdir().unwrap();
    let image = d.path().join("shot.png");
    png(&image);
    let p = Pipeline::new(d.path(), &[tool("cli-tool", "qoder-cli", &image)]).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let notify = entered.clone();
    p.input.set_multimodal_handler(Arc::new(move |_, _| {
        let notify = notify.clone();
        Box::pin(async move {
            notify.notify_one();
            std::future::pending().await
        })
    }));
    let input = p.input.clone();
    let starting = tokio::spawn(async move { input.start().await });
    tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    let started = std::time::Instant::now();
    tokio::time::timeout(std::time::Duration::from_millis(500), p.input.stop())
        .await
        .unwrap()
        .unwrap();
    assert!(started.elapsed().as_millis() < 500);
    starting.await.unwrap().unwrap();
    p.settle().await;
}
#[tokio::test]
async fn collect_l2970_attachment_carrier_stripped_off_and_on() {
    let d = tempfile::tempdir().unwrap();
    let image = d.path().join("shot.png");
    png(&image);
    let make = |id: &str| {
        json!({"event.id":id,"event.name":"llm.request","gen_ai.agent.type":"qoder-cli",
  "gen_ai.session.id":"cli-sess","gen_ai.turn.id":id,"agent.qoder.attachments":[{"type":"image_file","filename":image}],
  "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"look"}]}],
  "time_unix_nano":"1780000000000000000"})
    };
    // The default input has neither a processor nor enabled multimodal configuration.
    let offroot = d.path().join("off");
    std::fs::create_dir_all(&offroot).unwrap();
    let off = Pipeline::new(&offroot, &[make("cli-off")]).await;
    // Clearing a processor adapter is not exposed; use the default, disabled input
    // against the same isolated hook stream and collector callback.
    let store = Arc::new(StateStore::new(offroot.join("off-state.json")));
    store.set(
        "qoder-trace",
        InputState::new()
            .with_last_file(off.file.file_name().unwrap().to_str().unwrap())
            .with_last_offset(0.0)
            .with_extra(json!({"hookHistoryInitialized":true})),
    );
    let input = QoderTraceInput::with_readers(
        QoderTraceOptions {
            state_store: store,
            log_dir: Some(offroot.join("logs").to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
            multimodal_enabled: false,
            upload_mode: None,
            allowed_root_paths: vec![],
        },
        Arc::new(IsolatedReaders::default()),
    );
    let emitted = Arc::new(Mutex::new(vec![]));
    let got = emitted.clone();
    input.bind_collector(
        move |batch| got.lock().unwrap().extend_from_slice(batch),
        |_| {},
    );
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert!(!emitted.lock().unwrap()[0]
        .extra
        .contains_key("agent.qoder.attachments"));
    off.processor.shutdown(1000).await;
    let on = Pipeline::new(d.path(), &[make("cli-on")]).await;
    on.input.start().await.unwrap();
    let output = on.settle().await;
    let cli = output.iter().find(|v| v["event.id"] == "cli-on").unwrap();
    assert!(cli.get("agent.qoder.attachments").is_none());
    let uploads = on.uploader.0.lock().unwrap();
    assert_eq!(uploads.len(), 1);
    let expected_uri = format!("oss://bucket/pilot-mm/{}", uploads[0].target_path);
    assert!(cli["gen_ai.input.messages_delta"][0]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == expected_uri));
}

#[tokio::test]
async fn collect_l2680_real_sqlite_synthetic_clock_order_jsonl_and_llm_duration() {
    use loongsuite_pilot::flushers::{
        hr_time_to_nano, ConvertOptions, EventLogConverter, GenAiEventLogConverter,
    };
    use loongsuite_pilot::inputs::qoder_trace::multimodal::derive_synthetic_ide_request_event_id;
    use loongsuite_pilot::types::AgentActivityEntry;
    let d = tempfile::tempdir().unwrap();
    let image = d.path().join("solo.png");
    png(&image);
    let database = d.path().join("native.sqlite");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TABLE chat_record (request_id TEXT, extra TEXT); CREATE TABLE chat_message (request_id TEXT, role TEXT, gmt_create INTEGER);").unwrap();
    connection
        .execute(
            "INSERT INTO chat_record VALUES (?1,?2)",
            rusqlite::params![
                "req-solo",
                json!({"attachedImagePaths":[image]}).to_string()
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO chat_message VALUES (?1,'user',?2)",
            rusqlite::params!["req-solo", 1779999995000i64],
        )
        .unwrap();
    drop(connection);
    let record = json!({"event.id":"resp-solo","event.name":"llm.response","gen_ai.agent.type":"qoder",
 "gen_ai.session.id":"ide-sess","gen_ai.turn.id":"ide-turn","gen_ai.request.id":"req-solo",
 "gen_ai.turn.start":true,"gen_ai.turn.end":true,
 "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"ok"}]}],
 "time_unix_nano":"1780000000000000000"});
    let p = Pipeline::with_databases(
        d.path(),
        &[record],
        vec![database.to_string_lossy().into_owned()],
    )
    .await;
    p.input.start().await.unwrap();
    let output = p.settle().await;
    let events = output
        .iter()
        .filter(|v| v["event.name"] != "agent.input")
        .collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .map(|e| e["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["llm.request", "llm.response"]
    );
    assert_eq!(
        events[0]["event.id"],
        derive_synthetic_ide_request_event_id("resp-solo", "req-solo")
    );
    assert_eq!(events[0]["gen_ai.turn.start"], true);
    assert!(events[1].get("gen_ai.turn.start").is_none());
    assert_eq!(events[1]["event.id"], "resp-solo");
    assert_eq!(events[1]["gen_ai.turn.end"], true);
    assert_eq!(events[0]["trace_id"], events[1]["trace_id"]);
    assert!(!events[0]["trace_id"].as_str().unwrap().is_empty());
    assert_eq!(events[0]["time_unix_nano"], "1779999995000000000");
    assert_eq!(events[1]["time_unix_nano"], "1780000000000000000");
    assert!(events[0]["gen_ai.input.messages_delta"][0]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri"));
    let entries = events
        .into_iter()
        .map(|v| serde_json::from_value::<AgentActivityEntry>(v.clone()).unwrap())
        .collect::<Vec<_>>();
    let result = GenAiEventLogConverter
        .convert(
            &entries,
            &ConvertOptions {
                strict: false,
                ..Default::default()
            },
        )
        .unwrap();
    let llm = result
        .spans
        .iter()
        .find(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
        .unwrap();
    assert_eq!(hr_time_to_nano(llm.duration), "5000000000");
    assert!(!p.uploader.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cli_source_l228_l279_l307_l543_real_carriers_processor_and_jsonl_preserve_image_ownership()
{
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let clip = dir.path().join("clip.png");
    let at = dir.path().join("at.png");
    let read = dir.path().join("read.png");
    png(&clip);
    std::fs::write(&at,base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC").unwrap()).unwrap();
    std::fs::write(&read,base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC").unwrap()).unwrap();
    let make = |id: &str, event: &str, turn: &str, text: &str| {
        json!({
            "event.id":id,"event.name":event,"gen_ai.agent.type":"qoder-cli","gen_ai.session.id":"cli-source-session","gen_ai.turn.id":turn,
            "agent.qoder.cwd":dir.path(),"time_unix_nano":"1780000000000000000",
            "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":text}]}]
        })
    };
    let clip_text = format!("[Image #0]看图 [Image: source: {}]", clip.display());
    let read_text = "Read image: read.png (31KB)";
    let records = vec![
        make("cli-source-other", "other", "cli-source-turn", &clip_text),
        make(
            "cli-source-first",
            "llm.request",
            "cli-source-turn",
            &clip_text,
        ),
        make(
            "cli-source-follow",
            "llm.request",
            "cli-source-turn",
            "tool follow-up without image",
        ),
        make(
            "cli-source-at",
            "llm.request",
            "cli-source-at-turn",
            "@at.png 这是什么",
        ),
        json!({"event.id":"cli-source-read","event.name":"tool.result","gen_ai.agent.type":"qoder-cli","gen_ai.session.id":"cli-source-session","gen_ai.turn.id":"cli-source-read-turn","gen_ai.tool.name":"Read","gen_ai.tool.call.result":read_text,"agent.qoder.cwd":dir.path(),"time_unix_nano":"1780000000000000000"}),
    ];
    let p = Pipeline::new(dir.path(), &records).await;
    p.input.start().await.unwrap();
    let output = p.settle().await;
    let event = |id: &str| output.iter().find(|e| e["event.id"] == id).unwrap();
    let input_uris = |entry: &Value| {
        entry["gen_ai.input.messages_delta"][0]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|part| part.get("uri").and_then(Value::as_str))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let uploads = p.uploader.0.lock().unwrap();
    assert_eq!(
        uploads.len(),
        3,
        "same carrier image deduplicates; distinct files still upload"
    );
    let image_uri = |file: &Path| {
        let bytes = std::fs::read(file).unwrap();
        let upload = uploads
            .iter()
            .find(|u| u.data.as_deref() == Some(bytes.as_slice()))
            .expect("actual correct image body must reach uploader");
        assert_eq!(upload.content_type, "image/png");
        let digest = format!("{:x}", Sha256::digest(&bytes));
        assert!(upload.target_path.ends_with(&format!("/{digest}.png")));
        format!("oss://bucket/pilot-mm/{}", upload.target_path)
    };
    let clip_uri = image_uri(&clip);
    let at_uri = image_uri(&at);
    let read_uri = image_uri(&read);
    assert_eq!(
        input_uris(event("cli-source-other")),
        vec![clip_uri.clone()]
    );
    assert_eq!(
        input_uris(event("cli-source-first")),
        vec![clip_uri.clone()]
    );
    assert!(input_uris(event("cli-source-follow")).is_empty());
    assert_eq!(input_uris(event("cli-source-at")), vec![at_uri.clone()]);
    for (id, expected) in [
        ("cli-source-other", &clip_uri),
        ("cli-source-first", &clip_uri),
        ("cli-source-at", &at_uri),
    ] {
        assert_eq!(
            event(id)["gen_ai.input.multimodal_metadata"],
            json!([{"uri":expected,"mime_type":"image/png","modality":"image"}])
        );
    }
    assert!(event("cli-source-follow")
        .get("gen_ai.input.multimodal_metadata")
        .is_none());
    assert_eq!(
        event("cli-source-read")["gen_ai.tool.call.result"][0],
        json!({"type":"text","content":read_text})
    );
    assert_eq!(
        event("cli-source-read")["gen_ai.tool.call.result"][1]["uri"],
        read_uri
    );
    assert_eq!(
        event("cli-source-read")["gen_ai.input.multimodal_metadata"],
        json!([{"uri":read_uri,"mime_type":"image/png","modality":"image"}])
    );
}
