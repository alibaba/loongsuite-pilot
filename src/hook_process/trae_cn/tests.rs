use super::*;
use std::collections::BTreeSet;

const PROMPT: &str =
    include_str!("../../../tests/unit/hooks/trae-cn/fixtures/user-prompt-submit.json");
const PRE: &str = include_str!("../../../tests/unit/hooks/trae-cn/fixtures/pre-tool-use.json");
const POST: &str = include_str!("../../../tests/unit/hooks/trae-cn/fixtures/post-tool-use.json");
const STOP: &str = include_str!("../../../tests/unit/hooks/trae-cn/fixtures/stop.json");

fn read_rows(root: &Path) -> Vec<Value> {
    let file = fs::read_dir(root.join("logs/trae-cn/history"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|entry| entry.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("daily TRAE history file");
    fs::read_to_string(file)
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect()
}

fn env(root: &Path) -> Env {
    Env::from([
        (
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        ),
        ("HOME".into(), root.to_string_lossy().into_owned()),
        (
            "LOONGSUITE_PILOT_USER_ID".into(),
            "isolated-test-user".into(),
        ),
    ])
}

#[test]
fn trae_native_hook_keeps_one_turn_and_tool_pair_across_processes() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let env = env(&root);
    for (event, data) in [
        ("user-prompt-submit", PROMPT),
        ("pre-tool-use", PRE),
        ("post-tool-use", POST),
        ("stop", STOP),
        ("stop", STOP),
    ] {
        collect(event, data.as_bytes(), &env).unwrap();
    }
    let rows = read_rows(&root);
    let events: Vec<_> = rows
        .iter()
        .filter(|row| row["event.name"] != "other")
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|row| row["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["llm.request", "tool.call", "tool.result", "llm.response"]
    );
    assert_eq!(
        events
            .iter()
            .map(|row| row["gen_ai.turn.id"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        1
    );
    assert_eq!(events[1]["span_id"], events[2]["span_id"]);
    assert_eq!(
        events[1]["gen_ai.tool.call.id"],
        events[2]["gen_ai.tool.call.id"]
    );
    assert_eq!(
        events[0]["gen_ai.response.id"],
        events[3]["gen_ai.response.id"]
    );
    assert_eq!(
        events[3]["gen_ai.output.messages"][0]["parts"][0]["type"],
        "tool_call"
    );
    assert_eq!(
        events[3]["gen_ai.output.messages"][1]["parts"][0]["type"],
        "text"
    );
    assert_eq!(
        rows.iter()
            .map(|row| row["event.id"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        rows.len()
    );
    let mut next: Value = serde_json::from_str(PROMPT).unwrap();
    next["timestamp"] = json!("2026-08-18T01:01:12.000Z");
    collect("user-prompt-submit", next.to_string().as_bytes(), &env).unwrap();
    assert!(read_rows(&root).last().unwrap()["gen_ai.turn.id"]
        .as_str()
        .unwrap()
        .ends_with(":t2"));
}

#[test]
fn trae_native_hook_reads_model_readonly_and_keeps_private_state_content_free() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let mut env = env(&root);
    let database = root.join("state.vscdb");
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute(
        "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO ItemTable VALUES (?1, ?2)",
        ["AI.agent.model.model_list_map", r#"{"solo_agent":[{"name":"Doubao-Seed-Code","display_name":"Seed","is_default":true}]}"#],
    ).unwrap();
    drop(conn);
    let bytes = fs::read(&database).unwrap();
    env.insert(
        "TRAES_USER_DATA_DIR".into(),
        root.to_string_lossy().into_owned(),
    );
    fs::write(
        root.join("config.json"),
        r#"{"agents":{"trae-cn":{"captureMessageContent":false}}}"#,
    )
    .unwrap();
    let mut prompt: Value = serde_json::from_str(PROMPT).unwrap();
    prompt["agent_type"] = json!("SoloAgent");
    prompt["prompt"] = json!("fixture content should not persist");
    collect("user-prompt-submit", prompt.to_string().as_bytes(), &env).unwrap();
    let mut stop: Value = serde_json::from_str(STOP).unwrap();
    stop["usage"] = json!({"prompt_tokens":0,"completion_tokens":9,"cache_read_input_tokens":0});
    collect("stop", stop.to_string().as_bytes(), &env).unwrap();
    let rows = read_rows(&root);
    let response = rows.last().unwrap();
    assert_eq!(response["gen_ai.request.model"], "Doubao-Seed-Code");
    assert_eq!(response["gen_ai.response.model"], "Seed");
    assert_eq!(response["gen_ai.provider.name"], "doubao");
    assert_eq!(response["gen_ai.usage.input_tokens"], 0);
    assert_eq!(response["gen_ai.usage.total_tokens"], 9);
    assert!(response.get("gen_ai.output.messages").is_none());
    assert!(rows
        .iter()
        .all(|r| r.get("gen_ai.input.messages").is_none()));
    let file = fs::read_dir(root.join("state/trae-cn/turns"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(!fs::read_to_string(file)
        .unwrap()
        .contains("fixture content should not persist"));
    assert_eq!(fs::read(database).unwrap(), bytes);
}

#[test]
fn trae_midstream_and_parallel_hooks_do_not_mix_session_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let env = env(&root);
    let fixture = |name: &str| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/unit/hooks/trae-cn/fixtures")
            .join(format!("{name}.json"))
    };
    let collect_file = |event, name| {
        collect(event, &fs::read(fixture(name)).unwrap(), &env).unwrap();
    };
    collect_file("user-prompt-submit", "user-prompt-submit");
    collect_file("notification", "notification-idle");
    collect_file("user-prompt-submit", "parallel-user-prompt-submit");
    std::thread::scope(|scope| {
        for name in [
            "parallel-pre-tool-use-a",
            "parallel-pre-tool-use-b",
            "midstream-pre-tool-use",
        ] {
            scope.spawn(move || collect_file("pre-tool-use", name));
        }
    });
    let all = read_rows(&root);
    let tool_ids = |session| {
        all.iter()
            .filter(|row| row["gen_ai.session.id"] == session && row["event.name"] == "tool.call")
            .filter_map(|row| row["gen_ai.tool.call.id"].as_str())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(
        tool_ids("trae-cn-parallel-session"),
        BTreeSet::from(["toolu_parallel_a", "toolu_parallel_b"])
    );
    assert_eq!(
        tool_ids("trae-cn-midstream-session"),
        BTreeSet::from(["toolu_midstream_01"])
    );
    assert!(all.iter().any(
        |row| row["gen_ai.session.id"] == "trae-cn-midstream-session"
            && row["agent.trae.turn_synthesized"] == true
    ));
    assert_eq!(
        all.iter()
            .filter(|row| row["gen_ai.session.id"] == "trae-cn-smoke-session"
                && row["event.name"] == "llm.response")
            .count(),
        1
    );
}
