use super::*;

async fn fresh(dir: &Path) -> (Arc<StateStore>, DshLogInput) {
    let store = Arc::new(StateStore::new(dir.join("input-state.json")));
    let input = make_input(dir, Arc::clone(&store)).await;
    (store, input)
}

fn key(path: &Path) -> String {
    format!("dsh-log:{}", path.to_string_lossy())
}

fn chunk(sid: &str, time: i64, turn: i64, step: i64) -> Value {
    json!({"type":"assistant/chunk","sid":sid,"time":time,
        "data":{"turn":turn,"step":step,"chunk":{"type":"block-start"}}})
}

fn embedded(step: i64, kind: &str, time: i64) -> Value {
    json!({"type":"assistant/message","sid":"session-a","time":time,
    "data":{"turn":1,"step":step,
        "message":{"id":format!("response-{step}"),"source":{"provider":"provider-a","model":"provider-a-model"},
            "content":[{"type":"text","text":format!("answer-{step}")}]},
        "usage":{"inputTokens":10,"outputTokens":5},
        "stream":[
            {"type":"chunk","time":time-4,"chunk":{"type":"block-start","index":0,"blockType":"text"}},
            {"type":"text-chunks","time0":time-3,"index":0,"dt":[1],"texts":["answer",format!("-{step}")]},
            {"type":"chunk","time":time-1,"chunk":{"type":"finish","reason":{"kind":kind}}}
        ]}})
}

fn events(entries: &[AgentActivityEntry]) -> Vec<&str> {
    entries
        .iter()
        .map(|entry| {
            entry
                .event_name
                .map(|name| name.as_str())
                .expect("event name")
        })
        .collect()
}

fn request(entries: &[AgentActivityEntry]) -> Value {
    entry_json(
        entries
            .iter()
            .find(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .expect("actual request"),
    )
}

fn prefix_system(sid: &str, provider: &str, prompt: &str, system: &str) -> Vec<Value> {
    let mut records = prefix(sid, provider, prompt);
    records[3]["data"]["header"]["system"] = json!(system);
    records
}

fn plain_response(sid: &str, turn: i64, time: i64, id: &str, text: &str) -> Value {
    json!({"type":"assistant/message","sid":sid,"time":time,
        "data":{"turn":turn,"step":1,"message":{"id":id,"content":[{"type":"text","text":text}],
            "source":{"provider":"provider-a","model":"provider-a-model"}}}})
}

#[tokio::test]
async fn l89_three_real_store_restarts_pair_each_embedded_step_and_restore_only_new_delta() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    append(&path, &prefix("session-a", "provider-a", "private-prompt"));
    let (store, first) = fresh(dir.path()).await;
    first.collect_entries().await.expect("first prefix");
    store.save().await.expect("prefix checkpoint");
    drop(first);
    drop(store);
    append(&path, &[embedded(1, "tool-calls", 11)]);
    let (store, second) = fresh(dir.path()).await;
    let entries = second.collect_entries().await.expect("recovered step one");
    assert_eq!(events(&entries), vec!["llm.request", "llm.response"]);
    assert_eq!(entry_json(&entries[0])["time_unix_nano"], "5000000");
    assert_eq!(
        entry_json(&entries[1])["gen_ai.response.time_to_first_token"],
        3_000_000
    );
    assert_eq!(
        entry_json(&entries[1])["gen_ai.response.finish_reasons"],
        json!(["tool_calls"])
    );
    let input = entry_json(&entries[0])["gen_ai.input.messages"].to_string();
    assert!(input.contains("private-prompt"));
    assert!(!input.contains("answer-1"));
    store.save().await.expect("step one checkpoint");
    drop(second);
    drop(store);
    append(
        &path,
        &[
            json!({"type":"step/start","sid":"session-a","time":12,"data":{"turn":1,"step":2}}),
            embedded(2, "stop", 20),
            json!({"type":"turn/end","sid":"session-a","time":21,"data":{"turn":1}}),
        ],
    );
    let (_store, third) = fresh(dir.path()).await;
    let later = third.collect_entries().await.expect("recovered step two");
    assert_eq!(events(&later), vec!["llm.request", "llm.response"]);
    assert_eq!(
        entry_json(&later[1])["gen_ai.response.finish_reasons"],
        json!(["stop"])
    );
    let delta = entry_json(&later[0])["gen_ai.input.messages_delta"].to_string();
    assert!(delta.contains("answer-1"));
    assert!(!delta.contains("private-prompt"));
    assert!(!entry_json(&later[0])["gen_ai.input.messages"]
        .to_string()
        .contains("answer-2"));
    assert!(third.collect_entries().await.expect("rescan").is_empty());
    assert!(
        !std::fs::read_to_string(dir.path().join("input-state.json"))
            .expect("checkpoint text")
            .contains("private-prompt")
    );
}

#[tokio::test]
async fn l140_actual_two_file_poll_cycles_keep_provider_and_prompt_state_isolated() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let a = dir.path().join("dsh-session-a.jsonl");
    let b = dir.path().join("dsh-session-b.jsonl");
    append(&a, &prefix("session-a", "provider-a", "prompt-a"));
    append(&b, &prefix("session-b", "provider-b", "prompt-b"));
    let (_store, input) = fresh(dir.path()).await;
    input.collect_entries().await.expect("both prefixes");
    append(&a, &[chunk("session-a", 10, 1, 1)]);
    append(&b, &[chunk("session-b", 10, 1, 1)]);
    let entries = input.collect_entries().await.expect("actual next poll");
    let requests = entries
        .iter()
        .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 2);
    for (sid, provider, prompt, other) in [
        ("session-a", "provider-a", "prompt-a", "prompt-b"),
        ("session-b", "provider-b", "prompt-b", "prompt-a"),
    ] {
        let entry = entry_json(
            requests
                .iter()
                .find(|entry| entry.session_id == sid)
                .expect("session request"),
        );
        assert_eq!(entry["gen_ai.provider.name"], provider);
        let content = entry["gen_ai.input.messages"].to_string();
        assert!(content.contains(prompt));
        assert!(!content.contains(other));
    }
}

#[tokio::test]
async fn l164_new_store_rehydrates_active_prompt_without_persisting_its_text() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    append(&path, &prefix("session-a", "provider-a", "private-prompt"));
    let (store, input) = fresh(dir.path()).await;
    input.collect_entries().await.expect("prefix");
    store.save().await.expect("checkpoint");
    assert!(
        !std::fs::read_to_string(dir.path().join("input-state.json"))
            .expect("checkpoint")
            .contains("private-prompt")
    );
    drop(input);
    drop(store);
    append(&path, &[chunk("session-a", 10, 1, 1)]);
    let (_store, restarted) = fresh(dir.path()).await;
    let entry = request(
        &restarted
            .collect_entries()
            .await
            .expect("recovered active turn"),
    );
    assert_eq!(entry["gen_ai.provider.name"], "provider-a");
    assert!(entry["gen_ai.input.messages"]
        .to_string()
        .contains("private-prompt"));
    assert!(entry["gen_ai.input.messages_delta"]
        .to_string()
        .contains("private-prompt"));
}

#[tokio::test]
async fn l183_restart_between_tool_steps_restores_assistant_tool_delta_cursor() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    let mut records = prefix("session-a", "provider-a", "private-prompt");
    records.extend([
        chunk("session-a",10,1,1),
        json!({"type":"assistant/message","sid":"session-a","time":11,"data":{"turn":1,"step":1,"message":{
            "id":"response-1","source":{"provider":"provider-a","model":"provider-a-model"},
            "content":[{"type":"tool-call","id":"call-1","name":"read","arguments":{"path":"README.md"}}]}}}),
        json!({"type":"tool/result","sid":"session-a","time":12,"data":{"turn":1,"step":1,
            "message":{"source":{"callId":"call-1"},"content":[{"type":"text","text":"# README"}]}}}),
        json!({"type":"step/start","sid":"session-a","time":13,"data":{"turn":1,"step":2}}),
        json!({"type":"request/context","sid":"session-a","time":14,"data":{"turn":1,"step":2}})
    ]);
    append(&path, &records);
    let (store, input) = fresh(dir.path()).await;
    let entries = input.collect_entries().await.expect("first tool step");
    store.save().await.expect("checkpoint");
    assert!(request(&entries)["gen_ai.input.messages_delta"]
        .to_string()
        .contains("private-prompt"));
    drop(input);
    drop(store);
    append(&path, &[chunk("session-a", 15, 1, 2)]);
    let (_store, restarted) = fresh(dir.path()).await;
    let entry = request(&restarted.collect_entries().await.expect("next step"));
    let delta = entry["gen_ai.input.messages_delta"]
        .as_array()
        .expect("actual delta");
    assert_eq!(
        delta
            .iter()
            .map(|message| message["role"].as_str().expect("role"))
            .collect::<Vec<_>>(),
        vec!["assistant", "tool"]
    );
    assert!(!entry["gen_ai.input.messages_delta"]
        .to_string()
        .contains("private-prompt"));
    assert!(entry["gen_ai.input.messages"]
        .to_string()
        .contains("private-prompt"));
}

#[tokio::test]
async fn l234_completed_turn_checkpoint_restores_private_header_for_headerless_next_turn() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    let mut records = prefix_system("session-a", "provider-a", "first-prompt", "private-system");
    records.extend([
        chunk("session-a", 10, 1, 1),
        plain_response("session-a", 1, 11, "response-1", "first answer"),
        json!({"type":"turn/end","sid":"session-a","time":12,"data":{"turn":1}}),
    ]);
    append(&path, &records);
    let (store, input) = fresh(dir.path()).await;
    input.collect_entries().await.expect("completed turn");
    store.save().await.expect("save");
    let text = std::fs::read_to_string(dir.path().join("input-state.json")).expect("checkpoint");
    assert!(text.contains("dshLastHeaderOffset"));
    assert!(!text.contains("private-system"));
    assert!(!text.contains("first-prompt"));
    drop(input);
    drop(store);
    append(
        &path,
        &[
            json!({"type":"turn/start","sid":"session-a","time":20,"data":{"turn":2}}),
            json!({"type":"step/start","sid":"session-a","time":21,"data":{"turn":2,"step":1}}),
            json!({"type":"user/message","sid":"session-a","time":22,"data":{"turn":2,"content":[{"type":"text","text":"continue-session"}]}}),
            json!({"type":"request/context","sid":"session-a","time":23,"data":{"turn":2,"step":1}}),
            chunk("session-a", 24, 2, 1),
            plain_response("session-a", 2, 25, "response-2", "second answer"),
            json!({"type":"turn/end","sid":"session-a","time":26,"data":{"turn":2}}),
        ],
    );
    let (_store, restarted) = fresh(dir.path()).await;
    let entries = restarted
        .collect_entries()
        .await
        .expect("headerless next turn");
    assert_eq!(
        events(&entries),
        vec!["other", "llm.request", "llm.response"]
    );
    let entry = entry_json(&entries[1]);
    assert_eq!(entry["gen_ai.provider.name"], "provider-a");
    assert_eq!(entry["gen_ai.request.model"], "provider-a-model");
    assert_eq!(
        entry["gen_ai.system_instructions"],
        json!([{"type":"text","content":"private-system"}])
    );
    assert!(entry["gen_ai.input.messages"]
        .to_string()
        .contains("continue-session"));
}

#[tokio::test]
async fn l302_malformed_header_does_not_replace_last_valid_header_checkpoint() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    let mut records = prefix_system("session-a", "provider-a", "first-prompt", "valid-system");
    records.extend([
        json!({"type":"request/header","sid":"session-a","time":6,"data":{"header":null}}),
        chunk("session-a", 7, 1, 1),
        json!({"type":"turn/end","sid":"session-a","time":8,"data":{"turn":1}}),
    ]);
    append(&path, &records);
    let (store, input) = fresh(dir.path()).await;
    input
        .collect_entries()
        .await
        .expect("valid then invalid header");
    store.save().await.expect("save");
    drop(input);
    drop(store);
    append(
        &path,
        &[
            json!({"type":"turn/start","sid":"session-a","time":20,"data":{"turn":2}}),
            json!({"type":"step/start","sid":"session-a","time":21,"data":{"turn":2,"step":1}}),
            json!({"type":"user/message","sid":"session-a","time":22,"data":{"turn":2,"content":[{"type":"text","text":"continue"}]}}),
            chunk("session-a", 23, 2, 1),
        ],
    );
    let (_store, restarted) = fresh(dir.path()).await;
    let entry = request(
        &restarted
            .collect_entries()
            .await
            .expect("header restoration"),
    );
    assert_eq!(entry["gen_ai.provider.name"], "provider-a");
    assert_eq!(entry["gen_ai.request.model"], "provider-a-model");
    assert_eq!(
        entry["gen_ai.system_instructions"],
        json!([{"type":"text","content":"valid-system"}])
    );
}

#[tokio::test]
async fn l331_legacy_checkpoint_missing_header_offset_locates_last_header_and_persists_migration() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    let mut records = prefix("session-a", "provider-a", "first-prompt");
    records.extend([
        chunk("session-a", 10, 1, 1),
        json!({"type":"turn/end","sid":"session-a","time":12,"data":{"turn":1}}),
    ]);
    append(&path, &records);
    let (store, input) = fresh(dir.path()).await;
    input.collect_entries().await.expect("completed history");
    store.save().await.expect("save");
    drop(input);
    drop(store);
    let state_path = dir.path().join("input-state.json");
    let mut persisted: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("saved bytes"))
            .expect("saved state");
    persisted[&key(&path)]["extra"]
        .as_object_mut()
        .expect("extra")
        .remove("dshLastHeaderOffset");
    std::fs::write(
        &state_path,
        serde_json::to_vec(&persisted).expect("legacy serialization"),
    )
    .expect("legacy checkpoint");
    append(
        &path,
        &[
            json!({"type":"turn/start","sid":"session-a","time":20,"data":{"turn":2}}),
            json!({"type":"step/start","sid":"session-a","time":21,"data":{"turn":2,"step":1}}),
            chunk("session-a", 22, 2, 1),
        ],
    );
    let (store, restarted) = fresh(dir.path()).await;
    let entry = request(&restarted.collect_entries().await.expect("legacy recovery"));
    assert_eq!(entry["gen_ai.request.model"], "provider-a-model");
    store.save().await.expect("save migration");
    assert!(std::fs::read_to_string(&state_path)
        .expect("migrated state")
        .contains("dshLastHeaderOffset"));
    assert!(store.get(&key(&path)).extra().expect("extra")["dshLastHeaderOffset"].is_number());
}

fn read_state(dir: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("input-state.json")).expect("saved state bytes"))
        .expect("state JSON")
}

fn write_state(dir: &Path, state: &Value) {
    std::fs::write(
        dir.join("input-state.json"),
        serde_json::to_vec(state).expect("state serialization"),
    )
    .expect("updated state bytes");
}

#[tokio::test]
async fn l363_legacy_header_scan_without_match_persists_null_offset() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    append(
        &path,
        &[
            json!({"type":"turn/start","sid":"session-a","time":1,"data":{"turn":1}}),
            json!({"type":"step/start","sid":"session-a","time":2,"data":{"turn":1,"step":1}}),
            chunk("session-a", 3, 1, 1),
            json!({"type":"turn/end","sid":"session-a","time":4,"data":{"turn":1}}),
        ],
    );
    let (store, input) = fresh(dir.path()).await;
    input.collect_entries().await.expect("first turn");
    store.save().await.expect("save");
    drop(input);
    drop(store);
    let mut state = read_state(dir.path());
    state[&key(&path)]["extra"]
        .as_object_mut()
        .expect("extra")
        .remove("dshLastHeaderOffset");
    write_state(dir.path(), &state);
    let (store, restarted) = fresh(dir.path()).await;
    assert!(restarted
        .collect_entries()
        .await
        .expect("legacy no new lines")
        .is_empty());
    store.save().await.expect("save migration");
    assert!(read_state(dir.path())[&key(&path)]["extra"]["dshLastHeaderOffset"].is_null());
    assert!(read_state(dir.path())[&key(&path)]["extra"]
        .as_object()
        .expect("extra")
        .contains_key("dshLastHeaderOffset"));
}

#[tokio::test]
async fn l389_invalid_header_offsets_outside_range_wrong_type_and_other_session_fail_closed() {
    for variant in ["out-of-range", "wrong-record-type", "session-mismatch"] {
        let dir = tempfile::tempdir().expect("synthetic directory");
        let path = dir.path().join("dsh-session-a.jsonl");
        let mut records = prefix("session-a", "provider-a", "first-prompt");
        records.extend([
            chunk("session-a", 10, 1, 1),
            json!({"type":"turn/end","sid":"session-a","time":12,"data":{"turn":1}}),
        ]);
        let mismatch_offset = records
            .iter()
            .map(|record| record.to_string().len() + 1)
            .sum::<usize>();
        if variant == "session-mismatch" {
            records.push(json!({"type":"request/header","sid":"session-b","time":13,"data":{
                "header":{"config":{"provider":"provider-b","model":"provider-b-model"},"system":"provider-b-system"}}}));
        }
        append(&path, &records);
        let (store, input) = fresh(dir.path()).await;
        input.collect_entries().await.expect("completed history");
        store.save().await.expect("save");
        drop(input);
        drop(store);
        let mut state = read_state(dir.path());
        let invalid = match variant {
            "out-of-range" => state[&key(&path)]["lastOffset"].as_f64().expect("offset") as u64 + 1,
            "wrong-record-type" => 0,
            _ => mismatch_offset as u64,
        };
        state[&key(&path)]["extra"]["dshLastHeaderOffset"] = json!(invalid);
        write_state(dir.path(), &state);
        append(
            &path,
            &[
                json!({"type":"turn/start","sid":"session-a","time":20,"data":{"turn":2}}),
                json!({"type":"step/start","sid":"session-a","time":21,"data":{"turn":2,"step":1}}),
                chunk("session-a", 22, 2, 1),
                json!({"type":"turn/end","sid":"session-a","time":23,"data":{"turn":2}}),
            ],
        );
        let (store, restarted) = fresh(dir.path()).await;
        let entry = request(
            &restarted
                .collect_entries()
                .await
                .expect("invalid checkpoint recovery"),
        );
        assert!(entry.get("gen_ai.request.model").is_none(), "{variant}");
        assert!(
            entry.get("gen_ai.system_instructions").is_none(),
            "{variant}"
        );
        store.save().await.expect("save recovered state");
        let state = read_state(dir.path());
        assert!(
            state[&key(&path)]["extra"]["dshLastHeaderOffset"].is_null(),
            "{variant}"
        );
    }
}

#[tokio::test]
async fn l434_truncate_or_replace_discards_old_session_header_and_rebinds_new_session() {
    for variant in ["truncated", "replaced"] {
        let dir = tempfile::tempdir().expect("synthetic directory");
        let path = dir.path().join("dsh-session-a.jsonl");
        let mut records = prefix("session-old", "old-provider", &"x".repeat(10_000));
        records.extend([
            chunk("session-old", 10, 1, 1),
            json!({"type":"turn/end","sid":"session-old","time":12,"data":{"turn":1}}),
        ]);
        append(&path, &records);
        let (store, input) = fresh(dir.path()).await;
        input.collect_entries().await.expect("old session");
        store.save().await.expect("save");
        drop(input);
        drop(store);
        let replacement = [
            json!({"type":"turn/start","sid":"session-new","time":20,"data":{"turn":1}}),
            json!({"type":"step/start","sid":"session-new","time":21,"data":{"turn":1,"step":1}}),
            chunk("session-new", 22, 1, 1),
            json!({"type":"turn/end","sid":"session-new","time":23,"data":{"turn":1}}),
        ]
        .iter()
        .map(|record| format!("{record}\n"))
        .collect::<String>();
        if variant == "truncated" {
            std::fs::write(&path, &replacement).expect("truncate source");
        } else {
            let other = dir.path().join("replacement.jsonl");
            std::fs::write(&other, &replacement).expect("new file");
            std::fs::rename(&other, &path).expect("replace source");
        }
        let (store, restarted) = fresh(dir.path()).await;
        let entry = request(
            &restarted
                .collect_entries()
                .await
                .expect("new session collection"),
        );
        assert_eq!(entry["gen_ai.session.id"], "session-new", "{variant}");
        assert!(entry.get("gen_ai.request.model").is_none(), "{variant}");
        assert!(
            entry.get("gen_ai.system_instructions").is_none(),
            "{variant}"
        );
        store.save().await.expect("save rebinding");
        let state = read_state(dir.path());
        assert_eq!(
            state[&key(&path)]["extra"]["dshBoundSessionId"],
            "session-new",
            "{variant}"
        );
        assert!(
            state[&key(&path)]["extra"]["dshLastHeaderOffset"].is_null(),
            "{variant}"
        );
    }
}

#[tokio::test]
async fn l482_active_turn_replay_does_not_duplicate_already_emitted_request() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    let mut records = prefix("session-a", "provider-a", "prompt-a");
    records.push(chunk("session-a", 10, 1, 1));
    append(&path, &records);
    let (store, input) = fresh(dir.path()).await;
    let entries = input.collect_entries().await.expect("first request");
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .count(),
        1
    );
    store.save().await.expect("save active turn");
    drop(input);
    drop(store);
    append(&path, &[chunk("session-a", 11, 1, 1)]);
    let (_store, restarted) = fresh(dir.path()).await;
    let entries = restarted
        .collect_entries()
        .await
        .expect("replayed active turn");
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .count(),
        0
    );
}

#[tokio::test]
async fn l497_restart_restores_first_native_output_boundary_for_ttft_without_new_request() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    let mut records = prefix("session-a", "provider-a", "prompt-a");
    records.push(json!({"type":"assistant/chunk","sid":"session-a","time":15,"data":{"turn":1,"step":1,"chunk":{"type":"reasoning-delta","text":"thinking"}}}));
    append(&path, &records);
    let (store, input) = fresh(dir.path()).await;
    let entries = input.collect_entries().await.expect("first output");
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .count(),
        1
    );
    store.save().await.expect("save");
    drop(input);
    drop(store);
    append(
        &path,
        &[
            json!({"type":"assistant/message","sid":"session-a","time":20,"data":{"turn":1,"step":1,
        "message":{"id":"response-a","content":[{"type":"reasoning","text":"thinking"}],"source":{"provider":"provider-a","model":"provider-a-model"}}}}),
        ],
    );
    let (_store, restarted) = fresh(dir.path()).await;
    let entries = restarted.collect_entries().await.expect("terminal message");
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .count(),
        0
    );
    let response = entries
        .iter()
        .find(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmResponse))
        .expect("response");
    assert_eq!(
        entry_json(response)["gen_ai.response.time_to_first_token"],
        10_000_000
    );
}

#[tokio::test]
async fn l530_restart_replays_tool_call_names_for_later_native_result() {
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    let mut records = prefix("session-a", "provider-a", "prompt-a");
    records.extend([chunk("session-a",10,1,1),
        json!({"type":"assistant/message","sid":"session-a","time":12,"data":{"turn":1,"step":1,"message":{"content":[{"type":"tool-call","id":"call-a","name":"read","arguments":"{}"}]}}}),
        json!({"type":"tool/call","sid":"session-a","time":13,"data":{"turn":1,"step":1,"callId":"call-a","name":"read","arguments":"{}"}})
    ]);
    append(&path, &records);
    let (store, input) = fresh(dir.path()).await;
    input.collect_entries().await.expect("tool call");
    store.save().await.expect("save tool prefix");
    drop(input);
    drop(store);
    append(
        &path,
        &[
            json!({"type":"tool/result","sid":"session-a","time":14,"data":{"turn":1,"step":1,
        "message":{"source":{"callId":"call-a"},"content":[{"type":"text","text":"done"}]}}}),
        ],
    );
    let (_store, restarted) = fresh(dir.path()).await;
    let entries = restarted.collect_entries().await.expect("tool result");
    let result = entry_json(
        entries
            .iter()
            .find(|entry| entry.event_name == Some(crate::types::AgentEventName::ToolResult))
            .expect("actual tool result"),
    );
    assert_eq!(result["gen_ai.tool.call.id"], "call-a");
    assert_eq!(result["gen_ai.tool.name"], "read");
}

#[tokio::test]
async fn l568_new_store_preserves_complete_prefix_offset_until_split_final_json_record_is_finished()
{
    let dir = tempfile::tempdir().expect("synthetic directory");
    let path = dir.path().join("dsh-session-a.jsonl");
    append(&path, &prefix("session-a", "provider-a", "prompt-a"));
    let prefix_size = std::fs::metadata(&path).expect("prefix metadata").len();
    let partial = chunk("session-a", 10, 1, 1).to_string();
    let split = partial.len() / 2;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append")
        .write_all(&partial.as_bytes()[..split])
        .expect("partial prefix");
    let (store, input) = fresh(dir.path()).await;
    let entries = input.collect_entries().await.expect("incomplete JSON");
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .count(),
        0
    );
    store.save().await.expect("save complete prefix");
    assert_eq!(store.get_offset(&key(&path)), prefix_size as f64);
    drop(input);
    drop(store);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append tail");
    file.write_all(&partial.as_bytes()[split..])
        .expect("complete JSON");
    file.write_all(b"\n").expect("complete record");
    drop(file);
    let (store, restarted) = fresh(dir.path()).await;
    let entries = restarted
        .collect_entries()
        .await
        .expect("complete final record");
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmRequest))
            .count(),
        1
    );
    assert_eq!(
        store.get_offset(&key(&path)),
        std::fs::metadata(&path).expect("metadata").len() as f64
    );
}
