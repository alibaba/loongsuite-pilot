//! Frozen file-pipeline11 contracts through the real manager-facing handle.
use super::*;
use crate::pipeline::sls_transport::RecordingSink;
use crate::pipeline::types::{
    FileInputConfig, PipelineConfig, PipelineInputConfig, PipelineSlsFlusherConfig,
};
use crate::pipeline::workspace_policy::WorkspacePolicy;

struct Fixture {
    root: tempfile::TempDir,
    logs: std::path::PathBuf,
    sink: Arc<RecordingSink>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        std::fs::create_dir(&logs).unwrap();
        Self {
            root,
            logs,
            sink: Arc::new(RecordingSink::default()),
        }
    }
    fn options(&self) -> FilePipelineOptions {
        FilePipelineOptions {
            workspace_policy: None,
            config: PipelineConfig {
                config_name: "test-pipeline".into(),
                inputs: vec![PipelineInputConfig::File(FileInputConfig {
                    file_paths: vec![self.logs.join("*.log").to_string_lossy().into_owned()],
                    file_encoding: Some("utf8".into()),
                    max_dir_search_depth: Some(0),
                    allowing_included_by_multi_configs: None,
                })],
                flushers: vec![PipelineSlsFlusherConfig {
                    endpoint: "unused.invalid".into(),
                    project: "test-project".into(),
                    logstore: "test-logstore".into(),
                    region: None,
                    aliuid: None,
                    telemetry_type: None,
                }],
                raw: Value::Null,
            },
            state_dir: self
                .root
                .path()
                .join("state")
                .to_string_lossy()
                .into_owned(),
            failed_log_dir: self
                .root
                .path()
                .join("failed")
                .to_string_lossy()
                .into_owned(),
            data_dir: self.root.path().join("data").to_string_lossy().into_owned(),
            sink: Some(self.sink.clone()),
        }
    }
    fn state(&self) -> Value {
        serde_json::from_slice(
            &std::fs::read(self.root.path().join("state/test-pipeline.json")).unwrap(),
        )
        .unwrap()
    }
    fn rows(&self) -> Vec<HashMap<String, String>> {
        self.sink
            .posts
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, rows, _)| rows.clone())
            .collect()
    }
}
#[test]
fn source_l66_l70_l74_l78_actual_exported_checkpoint_parser() {
    assert_eq!(
        parse_checkpoint_key("/tmp/file_test/data.log*16777229*425807574").as_deref(),
        Some("/tmp/file_test/data.log")
    );
    assert_eq!(
        parse_checkpoint_key("/tmp/my app/data.log*1*2").as_deref(),
        Some("/tmp/my app/data.log")
    );
    assert_eq!(
        parse_checkpoint_key("/tmp/file_test/data.log").as_deref(),
        Some("/tmp/file_test/data.log")
    );
    assert_eq!(parse_checkpoint_key("/tmp/data.log*123"), None);
}
#[tokio::test]
async fn source_l84_marker_write_failure_keeps_public_rows_deliverable() {
    let f = Fixture::new();
    let marker = f.root.path().join("marker-blocker");
    let private = f.root.path().join("private-project");
    std::fs::write(&marker, "not a directory").unwrap();
    std::fs::write(
        f.logs.join("mixed.log"),
        [
            json!({"session_id":"private","cwd":private,"content":"secret"}).to_string(),
            json!({"session_id":"public","cwd":"/public-project","content":"retained-public"})
                .to_string(),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    let mut opts = f.options();
    opts.workspace_policy = Some(Arc::new(std::sync::Mutex::new(
        WorkspacePolicy::new(
            &[private.to_string_lossy().into_owned()],
            Some(marker.to_string_lossy().into_owned()),
        )
        .unwrap(),
    )));
    let pipeline = FilePipelineHandle::new(opts).unwrap();
    pipeline.start().await;
    pipeline.stop().await;
    let rows = serde_json::to_string(&f.rows()).unwrap();
    assert!(rows.contains("retained-public"));
    assert!(!rows.contains("secret"));
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "not a directory");
}
#[tokio::test]
async fn source_l99_filters_before_independent_delivery_and_advances_full_offset() {
    let f = Fixture::new();
    let file = f.logs.join("privacy.log");
    let private = f.root.path().join("private-project");
    std::fs::write(
        &file,
        [
            json!({"session_id":"blocked","content":"early secret"}).to_string(),
            json!({"session_id":"blocked","cwd":private,"content":"secret"}).to_string(),
            json!({"session_id":"unknown","content":"allowed"}).to_string(),
            "plain unknown workspace".into(),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    let mut opts = f.options();
    opts.workspace_policy = Some(Arc::new(std::sync::Mutex::new(
        WorkspacePolicy::new(&[private.to_string_lossy().into_owned()], None).unwrap(),
    )));
    let pipeline = FilePipelineHandle::new(opts).unwrap();
    pipeline.start().await;
    pipeline.stop().await;
    let rows = serde_json::to_string(&f.rows()).unwrap();
    assert!(rows.contains("allowed"));
    assert!(rows.contains("plain unknown workspace"));
    assert!(!rows.contains("secret"));
    let size = std::fs::metadata(file).unwrap().len();
    assert!(f
        .state()
        .as_object()
        .unwrap()
        .values()
        .any(|v| v["lastOffset"].as_f64() == Some(size as f64)));
}
#[tokio::test]
async fn source_l121_starts_and_stops_the_actual_handle() {
    let f = Fixture::new();
    let pipeline = FilePipelineHandle::new(f.options()).unwrap();
    pipeline.start().await;
    assert!(pipeline
        .inner
        .running
        .load(std::sync::atomic::Ordering::SeqCst));
    assert!(pipeline.inner.task.lock().unwrap().is_some());
    pipeline.stop().await;
    assert!(!pipeline
        .inner
        .running
        .load(std::sync::atomic::Ordering::SeqCst));
    assert!(pipeline.inner.task.lock().unwrap().is_none());
}
#[tokio::test]
async fn source_l132_actual_poll_and_sender_keep_original_three_second_wait() {
    let f = Fixture::new();
    std::fs::write(f.logs.join("app.log"), "hello\nworld\n").unwrap();
    let pipeline = FilePipelineHandle::new(f.options()).unwrap();
    pipeline.start().await;
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
    pipeline.stop().await;
    let posts = f.sink.posts.lock().unwrap();
    let first = &posts.first().unwrap().1;
    assert!(first.contains(&HashMap::from([("content".into(), "hello".into())])));
    assert!(first.contains(&HashMap::from([("content".into(), "world".into())])));
}
#[tokio::test]
async fn source_l155_persisted_keys_are_actual_path_dev_inode_after_two_seconds() {
    let f = Fixture::new();
    let file = f.logs.join("app.log");
    std::fs::write(&file, "line1\n").unwrap();
    let pipeline = FilePipelineHandle::new(f.options()).unwrap();
    pipeline.start().await;
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    pipeline.stop().await;
    let state = f.state();
    let states = state.as_object().unwrap();
    assert!(!states.is_empty());
    for key in states.keys() {
        let parts: Vec<_> = key.split('*').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], file.to_str().unwrap());
        assert!(parts[1].parse::<u64>().is_ok());
        assert!(parts[2].parse::<u64>().unwrap() > 0);
    }
}
#[tokio::test]
async fn source_l183_wake_preserves_checkpoint_and_delivers_new_data_after_original_waits() {
    use std::io::Write;
    let f = Fixture::new();
    let file = f.logs.join("app.log");
    std::fs::write(&file, "before-sleep\n").unwrap();
    let pipeline = FilePipelineHandle::new(f.options()).unwrap();
    pipeline.start().await;
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    let state = f.state();
    let before = state.as_object().unwrap().values().next().unwrap()["lastOffset"]
        .as_f64()
        .unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(b"after-wake\n")
        .unwrap();
    pipeline
        .handle_wake(WakeEvent {
            sleep_duration_ms: 60000,
        })
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    pipeline.stop().await;
    let after = f.state().as_object().unwrap().values().next().unwrap()["lastOffset"]
        .as_f64()
        .unwrap();
    assert!(after > before);
    assert!(f
        .rows()
        .contains(&HashMap::from([("content".into(), "after-wake".into())])));
}
#[tokio::test]
async fn source_l220_wake_after_stop_is_safe_and_does_not_restart_the_task() {
    let f = Fixture::new();
    let pipeline = FilePipelineHandle::new(f.options()).unwrap();
    pipeline.start().await;
    pipeline.stop().await;
    pipeline
        .handle_wake(WakeEvent {
            sleep_duration_ms: 60000,
        })
        .await;
    assert!(!pipeline
        .inner
        .running
        .load(std::sync::atomic::Ordering::SeqCst));
    assert!(pipeline.inner.task.lock().unwrap().is_none());
}
#[tokio::test]
async fn actual_file_encoding_reaches_final_independent_sender_rows_and_checkpoint_bytes() {
    // Buffer.toString encodings already accepted by the fixed main constructor;
    // no new transport or encoding dependency is introduced.
    let unicode16 = || {
        "世界\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    let cases = [
        (
            Some("latin1"),
            vec![b'c', b'a', b'f', 0xe9, b'\n'],
            Some("café"),
            "",
        ),
        (
            Some("binary"),
            vec![b'c', b'a', b'f', 0xe9, b'\n'],
            Some("café"),
            "",
        ),
        (
            Some("ascii"),
            vec![b'c', b'a', b'f', 0xe9, b'\n'],
            Some("cafi"),
            "",
        ),
        (Some("utf16le"), unicode16(), Some("世界"), ""),
        (Some("utf-16le"), unicode16(), Some("世界"), ""),
        (Some("ucs2"), unicode16(), Some("世界"), ""),
        (Some("ucs-2"), unicode16(), Some("世界"), ""),
        (
            Some("UTF-8"),
            "你好\n".as_bytes().to_vec(),
            Some("你好"),
            "",
        ),
        (Some("utf8"), "你好\n".as_bytes().to_vec(), Some("你好"), ""),
        (Some(""), b"hello\n".to_vec(), Some("hello"), ""),
        (None, b"hello\n".to_vec(), Some("hello"), ""),
        (Some("hex"), b"hello\n".to_vec(), None, "68656c6c6f0a"),
        (Some("base64"), b"hello\n".to_vec(), None, "aGVsbG8K"),
        (Some("base64url"), vec![0xfb, 0xff, b'\n'], None, "-_8K"),
    ];
    for (encoding, bytes, expected, cache) in cases {
        let f = Fixture::new();
        std::fs::write(f.logs.join("app.log"), &bytes).unwrap();
        let mut opts = f.options();
        let PipelineInputConfig::File(input) = &mut opts.config.inputs[0] else {
            unreachable!()
        };
        input.file_encoding = encoding.map(str::to_string);
        let pipeline = FilePipelineHandle::new(opts).unwrap();
        pipeline.start().await;
        pipeline.stop().await;
        let rows = f.rows();
        if let Some(expected) = expected {
            assert_eq!(
                rows,
                [HashMap::from([("content".into(), expected.to_string())])],
                "encoding={encoding:?}"
            );
        } else {
            assert!(rows.is_empty(), "encoding={encoding:?}");
        }
        let state = f.state();
        let checkpoint = state.as_object().unwrap().values().next().unwrap();
        assert_eq!(checkpoint["lastOffset"].as_f64(), Some(bytes.len() as f64));
        assert_eq!(
            checkpoint["extra"]["cache"].as_str(),
            Some(cache),
            "encoding={encoding:?}"
        );
    }
}

#[tokio::test]
async fn actual_file_encoding_uses_source_encoded_byte_cache_budget() {
    for (encoding, bytes, expected_cache) in [
        ("latin1", vec![0xe9; 600_000], "é".repeat(600_000)),
        ("utf16le", [b'a', 0].repeat(600_000), String::new()),
    ] {
        let f = Fixture::new();
        std::fs::write(f.logs.join("app.log"), &bytes).unwrap();
        let mut opts = f.options();
        let PipelineInputConfig::File(input) = &mut opts.config.inputs[0] else {
            unreachable!()
        };
        input.file_encoding = Some(encoding.into());
        let pipeline = FilePipelineHandle::new(opts).unwrap();
        pipeline.start().await;
        pipeline.stop().await;
        assert!(f.rows().is_empty());
        let state = f.state();
        let cp = state.as_object().unwrap().values().next().unwrap();
        assert_eq!(cp["lastOffset"].as_f64(), Some(bytes.len() as f64));
        assert_eq!(
            cp["extra"]["cache"].as_str(),
            Some(expected_cache.as_str()),
            "encoding={encoding}"
        );
    }
}
