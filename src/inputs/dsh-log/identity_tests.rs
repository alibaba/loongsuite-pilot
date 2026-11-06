use super::*;

fn turn(tag: &str) -> Vec<Value> {
    let mut records = prefix("synthetic-session", "synthetic-provider", tag);
    records.push(json!({
        "type":"assistant/message","sid":"synthetic-session","time":11,
        "data":{"turn":1,"step":1,
            "message":{"id":format!("response-{tag}"),"source":{"provider":"synthetic-provider","model":"synthetic-provider-model"},
                "content":[{"type":"text","text":format!("answer-{tag}")}]},
            "usage":{"inputTokens":10,"outputTokens":5},
            "stream":[
                {"type":"chunk","time":7,"chunk":{"type":"block-start","index":0,"blockType":"text"}},
                {"type":"text-chunks","time0":8,"index":0,"dt":[1],"texts":["synthetic","-answer"]},
                {"type":"chunk","time":10,"chunk":{"type":"finish","reason":{"kind":"stop"}}}
            ]}}));
    records.push(json!({"type":"turn/end","sid":"synthetic-session","time":12,"data":{"turn":1}}));
    records
}

fn assert_turn(entries: &[AgentActivityEntry], tag: &str, user_event: bool) {
    let expected = if user_event {
        vec!["other", "llm.request", "llm.response"]
    } else {
        vec!["llm.request", "llm.response"]
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry
                .event_name
                .map(|name| name.as_str())
                .expect("event name"))
            .collect::<Vec<_>>(),
        expected
    );
    let request = &entries[usize::from(user_event)];
    assert!(
        entry_json(request)["gen_ai.input.messages"]
            .to_string()
            .contains(tag),
        "actual restored request content: {}",
        entry_json(request)
    );
}

#[tokio::test]
async fn actual_dsh_equal_length_replacement_resets_cached_turn_and_restart_preserves_appends() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-synthetic.jsonl");
    let state_path = dir.path().join("state.json");
    append(&path, &turn("synthetic-old"));
    let store = Arc::new(StateStore::new(&state_path));
    let input = make_input(dir.path(), Arc::clone(&store)).await;
    let first = input
        .collect_entries()
        .await
        .expect("old actual collection");
    assert_turn(&first, "synthetic-old", true);
    let key = format!("dsh-log:{}", path.to_string_lossy());
    let original = store.get(&key).extra().expect("old identity");
    let metadata = std::fs::metadata(&path).expect("metadata");
    let modified = metadata.modified().expect("mtime");
    let replacement = path.with_extension("replacement");
    append(&replacement, &turn("synthetic-new"));
    assert_eq!(
        std::fs::metadata(&replacement)
            .expect("replacement metadata")
            .len(),
        metadata.len()
    );
    std::fs::OpenOptions::new()
        .write(true)
        .open(&replacement)
        .expect("handle")
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .expect("same mtime");
    std::fs::rename(&replacement, &path).expect("atomic replacement");
    assert_eq!(
        std::fs::metadata(&path)
            .expect("metadata")
            .modified()
            .expect("mtime"),
        modified
    );
    assert_turn(
        &input
            .collect_entries()
            .await
            .expect("new actual collection"),
        "synthetic-new",
        true,
    );
    let identity = store.get(&key).extra().expect("new identity");
    assert_ne!(identity["inode"], original["inode"]);
    assert!(identity["dev"].is_u64());
    assert!(input.collect_entries().await.expect("dedup").is_empty());
    store.save().await.expect("save");
    drop(input);
    drop(store);
    let loaded = Arc::new(StateStore::new(&state_path));
    let restarted = make_input(dir.path(), Arc::clone(&loaded)).await;
    assert_eq!(
        loaded.get(&key).extra().expect("loaded")["inode"],
        identity["inode"]
    );
    append(&path, &turn("synthetic-appended"));
    assert_turn(
        &restarted
            .collect_entries()
            .await
            .expect("actual appended turn"),
        "synthetic-appended",
        true,
    );
    let after = loaded.get(&key).extra().expect("append identity");
    assert_eq!(after["inode"], identity["inode"]);
    assert_eq!(after["dev"], identity["dev"]);
    assert_eq!(
        loaded.get_offset(&key),
        std::fs::metadata(&path).expect("metadata").len() as f64
    );
    assert!(restarted
        .collect_entries()
        .await
        .expect("append dedup")
        .is_empty());
}

#[tokio::test]
async fn actual_dsh_header_replay_and_new_bytes_use_the_same_opened_file_after_path_replacement() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-synthetic.jsonl");
    let state_path = dir.path().join("state.json");
    let records = turn("synthetic-old");
    append(&path, &records[..5]);
    let store = Arc::new(StateStore::new(&state_path));
    let input = make_input(dir.path(), Arc::clone(&store)).await;
    let prefix_events = input
        .collect_entries()
        .await
        .expect("checkpoint active prefix");
    assert_eq!(prefix_events.len(), 1);
    assert_eq!(
        prefix_events[0].event_name.map(|name| name.as_str()),
        Some("other")
    );
    store.save().await.expect("save active prefix");
    drop(input);
    drop(store);
    append(&path, &records[5..]);
    let loaded = Arc::new(StateStore::new(&state_path));
    let restarted = make_input(dir.path(), Arc::clone(&loaded)).await;
    let runtime = restarted.runtime();
    let mut held = File::open(&path).expect("source handle");
    let identity =
        crate::utils::file_identity::identity_from_open(&held).expect("same-handle identity");
    let replacement = path.with_extension("replacement");
    append(&replacement, &turn("synthetic-new"));
    std::fs::rename(&replacement, &path).expect("atomic replacement after open");
    let entries = runtime
        .process_opened_dsh_file(
            &path.to_string_lossy(),
            &mut held,
            &identity,
            &mut InputRuntimeAccumulator::new(),
        )
        .await
        .expect("actual replay and read");
    assert_turn(&entries, "synthetic-old", false);
    let key = format!("dsh-log:{}", path.to_string_lossy());
    assert_eq!(
        loaded.get(&key).extra().expect("checkpoint")["inode"],
        identity.ino
    );
    drop(held);
    assert_turn(
        &restarted
            .collect_entries()
            .await
            .expect("next scan replaces source"),
        "synthetic-new",
        true,
    );
}
