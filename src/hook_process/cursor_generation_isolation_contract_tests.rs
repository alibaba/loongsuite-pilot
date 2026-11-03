//! The original skipped generation-isolation fixture through the shipped Rust
//! hook entry, physical journal and JSONL history. No alternate assembler copy.
use super::*;
use serde_json::json;

fn original_fixture() -> Vec<Value> {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/cursor-react-history-literal-inputs.json"
    ))
    .unwrap();
    fixtures
        .into_iter()
        .find(|f| f["id"] == "L1372:C3")
        .unwrap()["events"]
        .as_array()
        .unwrap()
        .clone()
}
fn seed(root: &Path, events: &[Value]) {
    fs::write(
        root.join("config.json"),
        json!({"userId":"generation-fixture-user"}).to_string(),
    )
    .unwrap();
    let journal = Journal::open(root);
    for event in events {
        journal.append(event.as_object().unwrap()).unwrap();
    }
}
fn invoke(root: &Path, event: &Value) {
    invoke_with_platform(root, event, None);
}
fn invoke_with_platform(root: &Path, event: &Value, platform: Option<&str>) {
    let mut payload = event.as_object().unwrap().clone();
    payload.insert("hook_event_name".into(), payload["hook_event"].clone());
    let stdin = serde_json::to_vec(&payload).unwrap();
    let mut env = Env::from([
        (
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        ),
        (
            "AGENT_DATA_COLLECTION_CONFIG".into(),
            root.join("config.json").to_string_lossy().into_owned(),
        ),
        ("HOME".into(), root.to_string_lossy().into_owned()),
    ]);
    if let Some(platform) = platform {
        env.insert("OS".into(), platform.into());
    }
    let mut stdout = Vec::new();
    let mut request = HookRequest {
        args: &[],
        stdin: &stdin,
        env: &env,
        stdout: &mut stdout,
    };
    assert_eq!(run(&mut request), 0);
    assert_eq!(String::from_utf8(stdout).unwrap().trim(), "{}");
}
fn history(root: &Path) -> Vec<Value> {
    let dir = root.join("logs/cursor/history");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .flat_map(|e| parse_journal(&fs::read_to_string(e.path()).unwrap()))
        .collect()
}
fn journal(root: &Path) -> Vec<Value> {
    Journal::open(root).read_all().unwrap()
}

#[test]
fn legacy_l1372_actual_hook_isolates_stopping_generation_and_only_reclaims_owned_rows() {
    let root = tempfile::tempdir().unwrap();
    let events = original_fixture();
    seed(root.path(), &events[..events.len() - 1]);
    invoke(root.path(), events.last().unwrap());
    let records = history(root.path());
    let prompt = records.iter().find(|r| r["event.name"] == "other").unwrap();
    assert!(
        prompt["gen_ai.input.messages_delta"][0]["parts"][0]["content"] == "do the task (composer)",
        "the stopping generation must supply its own prompt"
    );
    assert_eq!(prompt["gen_ai.turn.id"], "gen-b");
    assert!(!records.is_empty());
    assert!(records.iter().all(|r| r["gen_ai.turn.id"] == "gen-b"));
    let calls: Vec<_> = records
        .iter()
        .filter(|r| r["event.name"] == "tool.call")
        .collect();
    let results: Vec<_> = records
        .iter()
        .filter(|r| r["event.name"] == "tool.result")
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(results.len(), 1);
    assert_eq!(calls[0]["gen_ai.tool.call.id"], "call-b-write");
    assert_eq!(results[0]["gen_ai.tool.call.id"], "call-b-write");
    let remaining = journal(root.path());
    let expected: Vec<_> = events
        .iter()
        .filter(|r| r["generation_id"] == "gen-a")
        .cloned()
        .collect();
    assert!(
        remaining == expected,
        "all non-target generation rows must stay unchanged"
    );
    assert!(!remaining.iter().any(|r| r["generation_id"] == "gen-b"));
    assert!(remaining
        .iter()
        .any(|r| r["conversation_id"] == "conv-shared"));
    let before = records;
    invoke(root.path(), events.last().unwrap());
    assert_eq!(history(root.path()), before);
    assert!(
        journal(root.path())
            .iter()
            .filter(|r| r["generation_id"] == "gen-a")
            .cloned()
            .collect::<Vec<_>>()
            == expected
    );
}

#[test]
fn generation_cli_stop_and_deferred_response_use_matching_generation_guards_and_resources() {
    let root = tempfile::tempdir().unwrap();
    let mut events = original_fixture();
    events.retain(|e| e["generation_id"] == "gen-a" || e["hook_event"] == "beforeSubmitPrompt");
    for event in &mut events {
        event["cursor_version"] = json!("2026.07.31");
        if event["hook_event"] == "beforeSubmitPrompt" {
            event["resource_attributes"] = json!({"agentteams.worker.name":if event["generation_id"]=="gen-a"{"worker-a"}else{"worker-b"}});
        }
    }
    events.push(json!({"_journal_ts":"2026-06-08T10:00:00.070Z","hook_event":"afterAgentResponse",
        "conversation_id":"conv-shared","generation_id":"gen-a","model":"gpt-5.4","text":"unrelated old response",
        "cursor_version":"2026.07.31"}));
    seed(root.path(), &events);
    let stop = json!({"hook_event":"stop","conversation_id":"conv-shared","generation_id":"gen-b",
        "status":"completed","cursor_version":"2026.07.31"});
    invoke(root.path(), &stop);
    assert!(
        history(root.path()).is_empty(),
        "a different generation's response must not satisfy CLI completion"
    );
    let response = json!({"hook_event":"afterAgentResponse","conversation_id":"conv-shared",
        "generation_id":"gen-b","model":"composer-2.5-fast","text":"completed matching response",
        "cursor_version":"2026.07.31"});
    invoke(root.path(), &response);
    let records = history(root.path());
    assert!(!records.is_empty());
    assert!(records.iter().all(|r| r["gen_ai.turn.id"] == "gen-b"));
    assert!(records.iter().all(|r| r["gen_ai.agent.name"] == "worker-b"));
    assert!(!serde_json::to_string(&records)
        .unwrap()
        .contains("unrelated old response"));
    let expected: Vec<_> = events
        .iter()
        .filter(|r| r["generation_id"] == "gen-a")
        .cloned()
        .collect();
    assert!(
        journal(root.path()) == expected,
        "the older pending generation must retain its entire real journal"
    );
}

#[test]
fn unknown_generation_stop_never_steals_another_generations_prompt_or_history() {
    let root = tempfile::tempdir().unwrap();
    let events: Vec<_> = original_fixture()
        .into_iter()
        .filter(|e| e["generation_id"] == "gen-a")
        .collect();
    seed(root.path(), &events);
    invoke(
        root.path(),
        &json!({"hook_event":"stop","conversation_id":"conv-shared",
        "generation_id":"gen-missing","status":"completed"}),
    );
    assert!(history(root.path()).is_empty());
    assert!(events
        .iter()
        .all(|event| journal(root.path()).contains(event)));
}

#[test]
fn deferred_response_never_borrows_another_generations_stop() {
    let root = tempfile::tempdir().unwrap();
    let mut events = original_fixture();
    for event in &mut events {
        event["cursor_version"] = json!("2026.07.31");
    }
    seed(root.path(), &events[..6]);
    invoke(root.path(), &events[6]);
    assert!(
        history(root.path()).is_empty(),
        "only the matching generation stop can complete deferred assembly"
    );
    invoke(root.path(), events.last().unwrap());
    let rows = history(root.path());
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|r| r["gen_ai.turn.id"] == "gen-b"));
    assert!(journal(root.path())
        .iter()
        .all(|e| e["generation_id"] == "gen-a"));
}

#[test]
fn untagged_legacy_prompts_and_suffixed_thoughts_keep_their_supported_fallbacks() {
    let root = tempfile::tempdir().unwrap();
    let mut events: Vec<_> = original_fixture()
        .into_iter()
        .filter(|e| e["generation_id"] == "gen-b")
        .collect();
    for event in &mut events {
        event.as_object_mut().unwrap().remove("generation_id");
    }
    seed(root.path(), &events[..events.len() - 1]);
    let mut stop = events.last().unwrap().clone();
    stop["generation_id"] = json!("newer-terminal-marker");
    invoke(root.path(), &stop);
    let rows = history(root.path());
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|r| r["gen_ai.turn.id"] == "conv-shared"));
    assert!(journal(root.path()).is_empty());

    let root = tempfile::tempdir().unwrap();
    let mut events: Vec<_> = original_fixture()
        .into_iter()
        .filter(|e| e["generation_id"] == "gen-b")
        .collect();
    for event in &mut events {
        if event["hook_event"] == "afterAgentThought" {
            event["generation_id"] = json!("gen-b-1-abcd");
        }
    }
    seed(root.path(), &events[..events.len() - 1]);
    invoke(root.path(), events.last().unwrap());
    let rows = history(root.path());
    assert!(serde_json::to_string(&rows)
        .unwrap()
        .contains("composer thinking"));
    assert!(rows.iter().all(|r| r["gen_ai.turn.id"] == "gen-b"));
    assert!(journal(root.path()).is_empty());
}

#[test]
fn mixed_generations_do_not_borrow_an_unowned_transcript_or_consume_unclaimed_child_rows() {
    let root = tempfile::tempdir().unwrap();
    let mut events = original_fixture();
    let child = json!({"_journal_ts":"2026-06-08T10:00:00.100Z","hook_event":"afterAgentResponse",
        "conversation_id":"child-unclaimed","generation_id":"child-generation-a",
        "model":"gpt-5.4","text":"unclaimed child answer"});
    let transcript = root.path().join("unowned-transcript.jsonl");
    let raw = [
        json!({"role":"user","message":{"content":[{"type":"text","text":"unowned transcript prompt"}]}}),
        json!({"role":"assistant","message":{"content":[{"type":"text","text":"unowned transcript answer"}]}}),
        json!({"type":"turn_ended"}),
    ];
    fs::write(
        &transcript,
        raw.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
    let transcript_rows = assemble::build_cursor_records_from_transcript(
        transcript.to_str().unwrap(),
        &events,
        "conv-shared",
        "cursor",
        "fixture-user",
    )
    .unwrap();
    assert!(
        serde_json::to_string(&transcript_rows)
            .unwrap()
            .contains("unowned transcript answer"),
        "positive control must be a real parseable transcript"
    );
    let stop = events.pop().unwrap();
    events.push(child.clone());
    seed(root.path(), &events);
    let mut stop = stop;
    stop["transcript_path"] = json!(transcript);
    // Existing supported platform injection exercises the real transcript
    // branch on Linux too; it is explicitly not physical Windows execution.
    invoke_with_platform(root.path(), &stop, Some("Windows_NT"));
    let rows = history(root.path());
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|r| r["gen_ai.turn.id"] == "gen-b"));
    let body = serde_json::to_string(&rows).unwrap();
    assert!(!body.contains("unowned transcript"));
    assert!(!body.contains("unclaimed child answer"));
    let remaining = journal(root.path());
    assert!(remaining.contains(&child));
    assert!(remaining.iter().any(|e| e["generation_id"] == "gen-a"));
    assert!(!remaining.iter().any(|e| e["generation_id"] == "gen-b"));
}
