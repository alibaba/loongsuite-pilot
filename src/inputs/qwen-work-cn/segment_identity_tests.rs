use super::*;
use std::io::Write;
use std::sync::Arc;

fn wave(tag: &str, tokens: i64) -> String {
    [
        json!({"type":"model.request.started","ts":"2026-01-01T00:00:01Z","request_id":tag,"turn_id":tag,"data":{"model":"synthetic"}}),
        json!({"type":"model.response.completed","ts":"2026-01-01T00:00:02Z","request_id":tag,"turn_id":tag,
            "data":{"input_tokens":tokens,"output_tokens":2,"model":"synthetic"}}),
    ].iter().map(|record|format!("{record}\n")).collect()
}

async fn make_identity_input(
    root: &Path,
) -> (Arc<crate::checkpoints::StateStore>, QwenWorkCnTraceInput) {
    let store = Arc::new(crate::checkpoints::StateStore::new(root.join("state.json")));
    store.load().await;
    let input = QwenWorkCnTraceInput::new(QwenWorkCnTraceOptions {
        state_store: Arc::clone(&store),
        log_dir: Some(root.join("hooks").to_string_lossy().into_owned()),
        segments_root: Some(root.join("segments").to_string_lossy().into_owned()),
        poll_interval_ms: Some(60_000),
    });
    (store, input)
}

fn pairs(input: &QwenWorkCnTraceInput) -> Vec<(String, Option<i64>)> {
    input
        .inner
        .body
        .segment_pairs
        .lock()
        .expect("pairs")
        .get("synthetic-session")
        .map(|pairs| {
            pairs
                .iter()
                .map(|pair| (pair.turn_id.clone(), pair.usage.input_tokens))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn actual_qwen_segment_reader_detects_equal_length_replacement_and_resumes_append_after_restart(
) {
    let dir = tempfile::tempdir().expect("synthetic root");
    let source = dir.path().join("synthetic.jsonl");
    let (store, input) = make_identity_input(dir.path()).await;
    let old = wave("synthetic-old", 11);
    let new = wave("synthetic-new", 22);
    assert_eq!(old.len(), new.len());
    std::fs::write(&source, &old).expect("old source");
    let path = source.to_string_lossy().into_owned();
    let key = format!("{}:segment:{path}", input.inner.id());
    input
        .inner
        .body
        .read_segment_file(&input.inner.runtime, "synthetic-session", &path)
        .await;
    assert_eq!(pairs(&input), vec![("synthetic-old".into(), Some(11))]);
    let first = store.get(&key).extra().expect("first identity");
    let metadata = std::fs::metadata(&source).expect("metadata");
    let modified = metadata.modified().expect("mtime");
    let replacement = source.with_extension("replacement");
    std::fs::write(&replacement, &new).expect("replacement");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&replacement)
        .expect("handle")
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .expect("same mtime");
    std::fs::rename(&replacement, &source).expect("atomic replacement");
    assert_eq!(
        std::fs::metadata(&source).expect("metadata").len(),
        metadata.len()
    );
    assert_eq!(
        std::fs::metadata(&source)
            .expect("metadata")
            .modified()
            .expect("mtime"),
        modified
    );
    input
        .inner
        .body
        .read_segment_file(&input.inner.runtime, "synthetic-session", &path)
        .await;
    assert_eq!(
        pairs(&input),
        vec![
            ("synthetic-old".into(), Some(11)),
            ("synthetic-new".into(), Some(22))
        ]
    );
    let identity = store.get(&key).extra().expect("replacement identity");
    assert_ne!(first["inode"], identity["inode"]);
    assert!(identity["dev"].is_u64());
    input
        .inner
        .body
        .read_segment_file(&input.inner.runtime, "synthetic-session", &path)
        .await;
    assert_eq!(
        pairs(&input).len(),
        2,
        "same byte range must not be replayed"
    );
    store.save().await.expect("durable offset");
    drop(input);
    drop(store);
    let (loaded, restarted) = make_identity_input(dir.path()).await;
    assert_eq!(loaded.get(&key).extra(), Some(identity.clone()));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .expect("append")
        .write_all(wave("synthetic-appended", 33).as_bytes())
        .expect("appended wave");
    restarted
        .inner
        .body
        .read_segment_file(&restarted.inner.runtime, "synthetic-session", &path)
        .await;
    assert_eq!(
        pairs(&restarted),
        vec![("synthetic-appended".into(), Some(33))],
        "fresh runtime must read only bytes after durable offset"
    );
    assert_eq!(loaded.get(&key).extra(), Some(identity));
    assert_eq!(
        loaded.get_offset(&key),
        std::fs::metadata(&source).expect("metadata").len() as f64
    );
}

#[tokio::test]
async fn actual_qwen_segment_reader_keeps_identity_and_bytes_on_one_handle_during_replacement() {
    let dir = tempfile::tempdir().expect("synthetic root");
    let source = dir.path().join("synthetic.jsonl");
    let (store, input) = make_identity_input(dir.path()).await;
    std::fs::write(&source, wave("synthetic-old", 11)).expect("original");
    let path = source.to_string_lossy().into_owned();
    let (opened, identity) = open_segment_file(&path).await.expect("production opener");
    let expected_inode = identity.ino;
    let replacement = source.with_extension("replacement");
    std::fs::write(&replacement, wave("synthetic-new", 22)).expect("replacement");
    std::fs::rename(&replacement, &source).expect("atomic replacement");
    input
        .inner
        .body
        .read_opened_segment(
            &input.inner.runtime,
            "synthetic-session",
            &path,
            opened,
            identity,
        )
        .await;
    assert_eq!(pairs(&input), vec![("synthetic-old".into(), Some(11))]);
    let key = format!("{}:segment:{path}", input.inner.id());
    assert_eq!(
        store.get(&key).extra().expect("checkpoint")["inode"],
        expected_inode
    );
    input
        .inner
        .body
        .read_segment_file(&input.inner.runtime, "synthetic-session", &path)
        .await;
    assert_eq!(
        pairs(&input),
        vec![
            ("synthetic-old".into(), Some(11)),
            ("synthetic-new".into(), Some(22))
        ]
    );
}
