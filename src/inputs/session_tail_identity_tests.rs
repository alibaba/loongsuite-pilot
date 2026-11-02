use super::*;
use serde_json::json;
use std::io::Write;

fn tail(dir: &Path, store: Arc<StateStore>) -> SessionTail {
    SessionTail {
        id: "synthetic-session-identity",
        session_dir: dir.to_string_lossy().into_owned(),
        file_pattern: "*.jsonl".into(),
        state_store: store,
        logger: create_logger("SyntheticSessionIdentity"),
        warned: Mutex::new(VecDeque::new()),
    }
}

fn records() -> (LineFn, Arc<Mutex<Vec<Value>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&seen);
    let reader: LineFn = Arc::new(move |record, _| {
        let captured = Arc::clone(&captured);
        Box::pin(async move {
            captured
                .lock()
                .expect("captured records")
                .push(Value::Object(record));
            Ok(None)
        })
    });
    (reader, seen)
}

#[tokio::test]
async fn actual_session_tail_detects_equal_length_replacement_and_preserves_append_identity_after_restart(
) {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    store.load().await;
    let source = dir.path().join("session.jsonl");
    let old = "{\"id\":\"synthetic-old\"}\n";
    let new = "{\"id\":\"synthetic-new\"}\n";
    assert_eq!(old.len(), new.len());
    std::fs::write(&source, old).expect("old source");
    let input = tail(dir.path(), Arc::clone(&store));
    let (on_line, seen) = records();
    let path = source.to_string_lossy().into_owned();
    let key = format!("{}:{path}", input.id);
    input
        .read_new_lines(&path, &on_line)
        .await
        .expect("first actual tail");
    assert_eq!(
        *seen.lock().expect("seen"),
        vec![json!({"id":"synthetic-old"})]
    );
    let old_identity = store.get(&key).extra().expect("old identity");
    let modified = std::fs::metadata(&source)
        .expect("metadata")
        .modified()
        .expect("modified");
    let replacement = source.with_extension("replacement");
    std::fs::write(&replacement, new).expect("replacement");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&replacement)
        .expect("replacement handle")
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .expect("same mtime");
    std::fs::rename(&replacement, &source).expect("atomic equal-length replacement");
    assert_eq!(
        std::fs::metadata(&source)
            .expect("metadata")
            .modified()
            .expect("mtime"),
        modified
    );
    assert_eq!(
        std::fs::metadata(&source).expect("metadata").len(),
        old.len() as u64
    );
    input
        .read_new_lines(&path, &on_line)
        .await
        .expect("replacement actual tail");
    assert_eq!(
        *seen.lock().expect("seen"),
        vec![json!({"id":"synthetic-old"}), json!({"id":"synthetic-new"})]
    );
    let replacement_identity = store.get(&key).extra().expect("replacement identity");
    assert_ne!(replacement_identity["inode"], old_identity["inode"]);
    assert!(replacement_identity["dev"].is_u64());
    input.read_new_lines(&path, &on_line).await.expect("rescan");
    assert_eq!(seen.lock().expect("seen").len(), 2);
    store.save().await.expect("save");
    drop(input);
    drop(store);
    let loaded = Arc::new(StateStore::new(dir.path().join("state.json")));
    loaded.load().await;
    let restarted = tail(dir.path(), Arc::clone(&loaded));
    assert_eq!(loaded.get(&key).extra(), Some(replacement_identity.clone()));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .expect("append")
        .write_all(b"{\"id\":\"synthetic-appended\"}\n")
        .expect("append record");
    restarted
        .read_new_lines(&path, &on_line)
        .await
        .expect("actual postrestart append");
    assert_eq!(
        *seen.lock().expect("seen"),
        vec![
            json!({"id":"synthetic-old"}),
            json!({"id":"synthetic-new"}),
            json!({"id":"synthetic-appended"})
        ]
    );
    assert_eq!(loaded.get(&key).extra(), Some(replacement_identity));
    assert_eq!(
        loaded.get_offset(&key),
        std::fs::metadata(&source).expect("size").len() as f64
    );
    restarted
        .read_new_lines(&path, &on_line)
        .await
        .expect("dedup");
    assert_eq!(seen.lock().expect("seen").len(), 3);
}

#[tokio::test]
async fn actual_session_tail_reads_the_opened_identity_when_path_is_replaced_before_reading() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let store = Arc::new(StateStore::new(dir.path().join("state.json")));
    let input = tail(dir.path(), Arc::clone(&store));
    let source = dir.path().join("session.jsonl");
    std::fs::write(&source, "{\"id\":\"synthetic-old\"}\n").expect("original");
    let path = source.to_string_lossy().into_owned();
    let (opened, identity) = open_session_file(&path)
        .await
        .expect("real production opener");
    let expected_inode = identity.ino;
    let expected_dev = identity.dev;
    let replacement = source.with_extension("replacement");
    std::fs::write(&replacement, "{\"id\":\"synthetic-new\"}\n").expect("replacement");
    std::fs::rename(&replacement, &source).expect("atomic replace");
    let (on_line, seen) = records();
    input
        .read_opened_lines(&path, &on_line, opened, identity)
        .await
        .expect("real production range reader");
    assert_eq!(
        *seen.lock().expect("seen"),
        vec![json!({"id":"synthetic-old"})]
    );
    let extra = store
        .get(&format!("{}:{path}", input.id))
        .extra()
        .expect("checkpoint");
    assert_eq!(extra["inode"], expected_inode);
    assert_eq!(extra["dev"], expected_dev);
    input
        .read_new_lines(&path, &on_line)
        .await
        .expect("next actual read detects replacement");
    assert_eq!(
        *seen.lock().expect("seen"),
        vec![json!({"id":"synthetic-old"}), json!({"id":"synthetic-new"})]
    );
}
