use super::*;
use serde_json::json;
use std::io::Write;

fn wave(request: &str, tokens: u64) -> String {
    [
        json!({"type":"model.request.started","ts":1000,"request_id":request}),
        json!({"type":"model.response.completed","ts":2000,"request_id":request,
            "data":{"input_tokens":tokens,"output_tokens":2,"model":"synthetic"}}),
    ]
    .iter()
    .map(|record| format!("{record}\n"))
    .collect()
}

fn cached_identity(root: &str) -> (u64, u64, u64) {
    let state = sessions().lock().expect("sessions");
    let session = state
        .get(&format!("{root}::synthetic-session"))
        .expect("session");
    assert_eq!(session.files.len(), 1);
    let file = session.files.values().next().expect("file");
    (file.dev, file.ino, file.cursor.committed_offset)
}

#[tokio::test]
async fn actual_segment_cache_replaces_same_length_file_preserves_appends_and_clears_empty_replacement(
) {
    let root = tempfile::tempdir().expect("synthetic root");
    let segments = root
        .path()
        .join("synthetic-project/synthetic-session/segments");
    std::fs::create_dir_all(&segments).expect("synthetic directories");
    let source = segments.join("synthetic.jsonl");
    let old = wave("synthetic-old", 11);
    let new = wave("synthetic-new", 22);
    assert_eq!(old.len(), new.len());
    std::fs::write(&source, &old).expect("original");
    let root_text = root.path().to_string_lossy().into_owned();
    let first = read_segment_tokens_for_session("synthetic-session", &[], &root_text).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].request_id, "synthetic-old");
    assert_eq!(first[0].input_tokens, 11);
    let original_identity = cached_identity(&root_text);
    let modified = std::fs::metadata(&source)
        .expect("metadata")
        .modified()
        .expect("mtime");
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
        old.len() as u64
    );
    assert_eq!(
        std::fs::metadata(&source)
            .expect("metadata")
            .modified()
            .expect("mtime"),
        modified
    );
    let second = read_segment_tokens_for_session("synthetic-session", &[], &root_text).await;
    assert_eq!(
        second.len(),
        1,
        "old file token history must be invalidated"
    );
    assert_eq!(second[0].request_id, "synthetic-new");
    assert_eq!(second[0].input_tokens, 22);
    let new_identity = cached_identity(&root_text);
    assert_ne!(
        (original_identity.0, original_identity.1),
        (new_identity.0, new_identity.1)
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .expect("append")
        .write_all(wave("synthetic-appended", 33).as_bytes())
        .expect("append wave");
    let third = read_segment_tokens_for_session("synthetic-session", &[], &root_text).await;
    assert_eq!(
        third
            .iter()
            .map(|row| (row.request_id.as_str(), row.input_tokens))
            .collect::<Vec<_>>(),
        vec![("synthetic-new", 22), ("synthetic-appended", 33)]
    );
    let append_identity = cached_identity(&root_text);
    assert_eq!(
        (append_identity.0, append_identity.1),
        (new_identity.0, new_identity.1)
    );
    assert_eq!(
        append_identity.2,
        std::fs::metadata(&source).expect("metadata").len()
    );
    assert_eq!(
        read_segment_tokens_for_session("synthetic-session", &[], &root_text).await,
        third
    );
    std::fs::write(&replacement, "").expect("empty replacement");
    std::fs::rename(&replacement, &source).expect("atomic empty replacement");
    assert!(
        read_segment_tokens_for_session("synthetic-session", &[], &root_text)
            .await
            .is_empty(),
        "empty replacement must invalidate the old file's cached token history"
    );
}

#[tokio::test]
async fn actual_segment_range_uses_the_handle_that_produced_dev_inode_and_size() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let source = dir.path().join("synthetic.jsonl");
    let old = wave("synthetic-old", 11);
    std::fs::write(&source, &old).expect("original");
    let mut opened = open_segment_file(source.to_string_lossy().into_owned())
        .await
        .expect("production opener");
    let replacement = source.with_extension("replacement");
    std::fs::write(&replacement, wave("synthetic-new", 22)).expect("replacement");
    std::fs::rename(&replacement, &source).expect("atomic replacement");
    let mut cursor = FileCursor::default();
    let read = read_appended(&mut opened, &mut cursor, "synthetic-session").await;
    assert!(!read.stable_failure, "production incremental reader");
    let events = read.events;
    assert_eq!(events.len(), 2);
    assert!(events
        .iter()
        .all(|event| event.request_id.as_deref() == Some("synthetic-old")));
    assert_eq!(cursor.committed_offset, old.len() as u64);
}
