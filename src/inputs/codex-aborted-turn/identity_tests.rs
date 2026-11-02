use super::*;
use std::io::Write;

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/inputs/codex-aborted-turn/fixtures/aborted-turn.jsonl"
));

async fn make_input(root: &Path) -> (Arc<StateStore>, CodexAbortedTurnInput) {
    std::fs::create_dir_all(root.join("sessions")).expect("synthetic sessions");
    let store = Arc::new(StateStore::new(root.join("state.json")));
    store.load().await;
    let input = CodexAbortedTurnInput::new(CodexAbortedTurnInputOptions {
        state_store: Arc::clone(&store),
        session_dir: Some(root.join("sessions").to_string_lossy().into_owned()),
        hook_state_dir: Some(root.join("hooks").to_string_lossy().into_owned()),
        diagnostic_dir: Some(root.join("diagnostics").to_string_lossy().into_owned()),
        hook_gap_grace_ms: Some(60_000.0),
        poll_interval_ms: Some(60_000),
    });
    (store, input)
}

fn assert_recovered(entries: &[AgentActivityEntry], session: &str) {
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.event_name.map(|name| name.as_str()).expect("event"))
            .collect::<Vec<_>>(),
        vec![
            "other",
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "llm.request",
            "llm.response"
        ]
    );
    assert!(entries.iter().all(|entry| entry.session_id == session));
    let results = entries
        .iter()
        .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::ToolResult))
        .map(|entry| {
            (
                entry.tool_call_id.as_deref(),
                entry.tool_result_status.as_deref(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        results,
        vec![
            (Some("call-bash"), Some("success")),
            (Some("call-pending"), Some("cancelled"))
        ]
    );
    assert_eq!(
        entries.last().expect("terminal").finish_reasons,
        Some(vec!["cancelled".into()])
    );
    assert_eq!(entries.last().expect("terminal").turn_end, Some(true));
}

#[tokio::test]
async fn actual_aborted_turn_equal_length_rotation_baselines_new_file_and_restart_reads_only_appended_turn(
) {
    let root = tempfile::tempdir().expect("synthetic root");
    let (store, input) = make_input(root.path()).await;
    let source = root.path().join("sessions").join("rollout-synthetic.jsonl");
    let path = source.to_string_lossy().into_owned();
    std::fs::write(&source, FIXTURE).expect("new original source");
    assert_recovered(
        &input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .expect("actual original recovery"),
        "session-aborted",
    );
    let key = state_key(&path);
    let first = read_checkpoint(&input.inner.runtime, &key).expect("original checkpoint");
    assert_eq!(first.emitted_aborted_turn_ids, vec!["turn-aborted"]);
    let metadata = std::fs::metadata(&source).expect("metadata");
    let modified = metadata.modified().expect("mtime");
    let replacement = source.with_extension("replacement");
    let rotated = FIXTURE
        .replace("session-aborted", "session-rotated")
        .replace("turn-aborted", "turn-rotated");
    assert_eq!(rotated.len(), FIXTURE.len());
    std::fs::write(&replacement, &rotated).expect("replacement");
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
    assert!(
        input
            .inner
            .body
            .collect(&input.inner.runtime)
            .await
            .expect("rotation baseline")
            .is_empty(),
        "historical replacement file is baselined rather than replayed"
    );
    let identity = read_checkpoint(&input.inner.runtime, &key).expect("new baseline");
    assert_ne!(identity.inode, first.inode);
    assert!(identity.dev.is_some());
    assert_eq!(identity.scan_offset, rotated.len() as i64);
    assert_eq!(identity.latest_session_meta_offset, Some(0));
    assert!(identity.active_turn.is_none());
    assert!(
        identity.emitted_aborted_turn_ids.is_empty(),
        "new identity must not inherit old dedup state"
    );
    store.save().await.expect("save baseline");
    drop(input);
    drop(store);
    let (loaded, restarted) = make_input(root.path()).await;
    assert_eq!(
        read_checkpoint(&restarted.inner.runtime, &key),
        Some(identity.clone())
    );
    // Legacy checkpoints had inode but no device. Adopt the device without
    // discarding valid unseen appended bytes on the same file.
    let mut legacy = loaded.get(&key).extra().expect("legacy extra");
    legacy["codexAbortedTurn"]
        .as_object_mut()
        .expect("checkpoint object")
        .remove("dev");
    loaded.update(
        &key,
        InputStatePatch {
            extra: Some(legacy),
            ..InputStatePatch::default()
        },
    );
    assert_eq!(
        read_checkpoint(&restarted.inner.runtime, &key)
            .expect("legacy")
            .dev,
        None
    );
    let appended = rotated.replace("turn-rotated", "turn-appended");
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .expect("append")
        .write_all(appended.as_bytes())
        .expect("append real synthetic aborted turn");
    assert_recovered(
        &restarted
            .inner
            .body
            .collect(&restarted.inner.runtime)
            .await
            .expect("postrestart appended recovery"),
        "session-rotated",
    );
    let after = read_checkpoint(&restarted.inner.runtime, &key).expect("append checkpoint");
    assert_eq!((after.dev, after.inode), (identity.dev, identity.inode));
    assert_eq!(
        after.scan_offset,
        std::fs::metadata(&source).expect("metadata").len() as i64
    );
    assert_eq!(after.emitted_aborted_turn_ids, vec!["turn-appended"]);
    assert!(restarted
        .inner
        .body
        .collect(&restarted.inner.runtime)
        .await
        .expect("append dedup")
        .is_empty());
}

#[tokio::test]
async fn actual_aborted_turn_restart_metadata_and_turn_recovery_use_one_handle_during_path_replacement(
) {
    let root = tempfile::tempdir().expect("synthetic root");
    let (store, input) = make_input(root.path()).await;
    let source = root.path().join("sessions").join("rollout-synthetic.jsonl");
    let path = source.to_string_lossy().into_owned();
    let split = FIXTURE
        .rfind("{\"timestamp\"")
        .expect("last complete record");
    std::fs::write(&source, &FIXTURE[..split]).expect("pending aborted-turn prefix");
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .expect("save pending prefix")
        .is_empty());
    let key = state_key(&path);
    assert_eq!(
        read_checkpoint(&input.inner.runtime, &key)
            .expect("pending")
            .active_turn
            .as_ref()
            .map(|turn| turn.turn_id.as_str()),
        Some("turn-aborted")
    );
    store.save().await.expect("durable prefix");
    drop(input);
    drop(store);
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .expect("append")
        .write_all(&FIXTURE.as_bytes()[split..])
        .expect("new abort boundary");
    let (loaded, restarted) = make_input(root.path()).await;
    let (mut held, identity) = open_rollout_file(&path)
        .await
        .expect("production source opener");
    let replacement = source.with_extension("replacement");
    std::fs::write(
        &replacement,
        FIXTURE
            .replace("session-aborted", "session-rotated")
            .replace("turn-aborted", "turn-rotated"),
    )
    .expect("replacement");
    std::fs::rename(&replacement, &source).expect("atomic replace after open");
    let recovered = restarted
        .inner
        .body
        .process_opened_file(&restarted.inner.runtime, &path, &mut held, &identity)
        .await
        .expect("actual metadata and turn recovery");
    assert_recovered(&recovered, "session-aborted");
    let checkpoint = read_checkpoint(&restarted.inner.runtime, &key).expect("checkpoint");
    assert_eq!(checkpoint.inode, identity.ino);
    assert_eq!(checkpoint.dev, Some(identity.dev));
    assert_eq!(loaded.get_offset(&key), FIXTURE.len() as f64);
    drop(held);
    assert!(restarted
        .inner
        .body
        .collect(&restarted.inner.runtime)
        .await
        .expect("next source rotation baseline")
        .is_empty());
    assert!(read_checkpoint(&restarted.inner.runtime, &key)
        .expect("new baseline")
        .emitted_aborted_turn_ids
        .is_empty());
}
