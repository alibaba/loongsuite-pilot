use super::*;
use crate::inputs::rest_support::entry_json;
use std::io::Write;
use std::sync::Arc;

fn line(kind: &str, payload: Value) -> String {
    format!(
        "[2026-01-01T00:00:01Z] [INFO] [SDK] [QueryHandler] Received message: {kind} {payload}\n"
    )
}

fn wave(tag: &str, tokens: i64) -> String {
    [
        line("system",json!({"subtype":"init","session_id":"synthetic-session","cwd":"/synthetic/workspace","model":"synthetic"})),
        line("stream_event",json!({"session_id":"synthetic-session","event":{"type":"message_start","message":{"id":tag}}})),
        line("stream_event",json!({"session_id":"synthetic-session","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":tokens,"output_tokens":2}}})),
        line("stream_event",json!({"session_id":"synthetic-session","event":{"type":"message_stop"}})),
        line("result",json!({"session_id":"synthetic-session","uuid":format!("result-{tag}"),"subtype":"success","num_turns":1}))
    ].concat()
}

async fn make_input(
    root: &std::path::Path,
) -> (Arc<crate::checkpoints::StateStore>, QoderWorkLogInput) {
    std::fs::create_dir_all(root.join("logs/synthetic")).expect("synthetic logs");
    let store = Arc::new(crate::checkpoints::StateStore::new(root.join("state.json")));
    store.load().await;
    let input = QoderWorkLogInput::new(QoderWorkLogOptions {
        state_store: Arc::clone(&store),
        data_root: Some(root.to_string_lossy().into_owned()),
        agent_type: Some(ClientType::QoderWork),
        poll_interval_ms: Some(60_000),
    });
    (store, input)
}

fn assert_wave(entries: &[AgentActivityEntry], tag: &str, tokens: i64) {
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.event_name.map(|name| name.as_str()).expect("event"))
            .collect::<Vec<_>>(),
        vec!["llm.response", "other"]
    );
    assert_eq!(entry_json(&entries[0])["gen_ai.response.id"], tag);
    assert_eq!(entry_json(&entries[0])["gen_ai.usage.input_tokens"], tokens);
    assert_eq!(entry_json(&entries[1])["event.id"], format!("result-{tag}"));
}

#[tokio::test]
async fn actual_qoder_work_log_same_length_replacement_and_restart_append_keep_correct_identity() {
    let root = tempfile::tempdir().expect("synthetic root");
    let (store, input) = make_input(root.path()).await;
    let source = root.path().join("logs").join("synthetic").join("main.log");
    let path = source.to_string_lossy().into_owned();
    let key = format!("{}:{path}", input.inner.id());
    let old = wave("synthetic-old", 11);
    let new = wave("synthetic-new", 22);
    assert_eq!(old.len(), new.len());
    std::fs::write(&source, &old).expect("original");
    assert_wave(
        &input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .expect("actual original"),
        "synthetic-old",
        11,
    );
    let original = store.get(&key).extra().expect("identity");
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
    std::fs::rename(&replacement, &source).expect("atomic replace");
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
    assert_wave(
        &input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .expect("replacement collection"),
        "synthetic-new",
        22,
    );
    let identity = store.get(&key).extra().expect("replacement identity");
    assert_ne!(original["inode"], identity["inode"]);
    assert!(identity["dev"].is_u64());
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .expect("dedup")
        .is_empty());
    store.save().await.expect("save");
    drop(input);
    drop(store);
    let (loaded, restarted) = make_input(root.path()).await;
    assert_eq!(loaded.get(&key).extra(), Some(identity.clone()));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .expect("append")
        .write_all(wave("synthetic-appended", 33).as_bytes())
        .expect("append wave");
    assert_wave(
        &restarted
            .inner
            .body
            .collect(&restarted.inner.runtime)
            .await
            .expect("postrestart append"),
        "synthetic-appended",
        33,
    );
    assert_eq!(loaded.get(&key).extra(), Some(identity));
    assert_eq!(
        loaded.get_offset(&key),
        std::fs::metadata(&source).expect("metadata").len() as f64
    );
    assert!(restarted
        .inner
        .body
        .collect(&restarted.inner.runtime)
        .await
        .expect("append dedup")
        .is_empty());
}

#[tokio::test]
async fn actual_qoder_work_log_startup_baselines_last_result_and_reads_new_turns() {
    let root = tempfile::tempdir().expect("synthetic root");
    let (store, input) = make_input(root.path()).await;
    let source = root.path().join("logs").join("synthetic").join("main.log");
    let old = wave("synthetic-old", 11);
    std::fs::write(&source, &old).expect("historical completed turn");
    input
        .inner
        .body
        .on_start(&input.inner.runtime)
        .await
        .expect("actual startup baseline");
    let key = format!("{}:{}", input.inner.id(), source.to_string_lossy());
    assert_eq!(store.get_offset(&key), old.len() as f64);
    let identity = store.get(&key).extra().expect("baseline identity");
    assert!(identity["dev"].is_u64());
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .expect("historical dedup")
        .is_empty());
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .expect("append")
        .write_all(wave("synthetic-new", 22).as_bytes())
        .expect("new turn");
    assert_wave(
        &input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .expect("new actual turn"),
        "synthetic-new",
        22,
    );
    assert_eq!(store.get(&key).extra(), Some(identity));
}

#[tokio::test]
async fn actual_qoder_work_log_baseline_and_range_read_remain_on_opened_file_during_replacement() {
    let root = tempfile::tempdir().expect("synthetic root");
    let (store, input) = make_input(root.path()).await;
    let source = root.path().join("logs").join("synthetic").join("main.log");
    let old = wave("synthetic-old", 11);
    std::fs::write(&source, &old).expect("original");
    let path = source.to_string_lossy().into_owned();
    let (mut opened, identity) = open_log_file(&path).await.expect("production opener");
    let expected = identity.ino;
    let replacement = source.with_extension("replacement");
    std::fs::write(&replacement, wave("synthetic-new", 22)).expect("replacement");
    std::fs::rename(&replacement, &source).expect("atomic replace");
    assert_eq!(
        find_last_result_boundary(&mut opened, identity.size).await,
        old.len() as f64
    );
    assert_wave(
        &input
            .inner
            .body
            .process_opened_log_file(&input.inner.runtime, &path, opened, identity)
            .await
            .expect("actual bounded reader"),
        "synthetic-old",
        11,
    );
    let key = format!("{}:{path}", input.inner.id());
    assert_eq!(
        store.get(&key).extra().expect("checkpoint")["inode"],
        expected
    );
    assert_wave(
        &input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .expect("next scan detects replacement"),
        "synthetic-new",
        22,
    );
}

#[tokio::test]
async fn main_555_sdk_log_does_not_consume_partial_final_record_and_idle_is_clean() {
    let root = tempfile::tempdir().unwrap();
    let (store, input) = make_input(root.path()).await;
    let path = root.path().join("logs/synthetic/main.log");
    let key = format!("{}:{}", input.inner.id(), path.display());
    let text = wave("split-record", 51);
    let split = 31;
    std::fs::write(&path, &text[..split]).unwrap();
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(store.get_offset(&key), 0.0);
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&text.as_bytes()[split..])
        .unwrap();
    assert_wave(
        &input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .unwrap(),
        "split-record",
        51,
    );
    let revision = store.revision();
    for _ in 0..2 {
        assert!(input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .unwrap()
            .is_empty());
    }
    assert_eq!(store.revision(), revision);
}
