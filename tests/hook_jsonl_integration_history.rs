use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::inputs::kiro_cli_log::KiroCliLogInput;
use loongsuite_pilot::inputs::qoder_trace::{QoderTraceInput, QoderTraceOptions};
use loongsuite_pilot::inputs::rest_support::HookInputOptions;
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn history(dir: &Path, prefix: &str) -> PathBuf {
    dir.join(format!(
        "{prefix}-{}.jsonl",
        loongsuite_pilot::utils::get_today_date_string()
    ))
}
fn append(file: &Path, rows: &[Value]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .unwrap();
    for row in rows {
        writeln!(f, "{row}").unwrap()
    }
    f.flush().unwrap();
}
fn canonical(event: &str, id: &str, turn: &str, agent: &str) -> Value {
    json!({"event.name":event,"event.id":id,"gen_ai.turn.id":turn,"gen_ai.step.id":format!("{turn}:s1"),"gen_ai.session.id":"integ-sess-1",
        "gen_ai.agent.type":agent,"gen_ai.tool.name":"create_file","gen_ai.tool.call.id":"call-1","user.id":"integ-user",
        "agent.source":"qoder-transcript-hook","time_unix_nano":"1780000000000000000","observed_time_unix_nano":"1780000000000000000",
        "git.repo":"synthetic/repo","git.branch":"fixture"})
}
async fn collect_qoder(logs: &Path, store: Arc<StateStore>) -> Vec<AgentActivityEntry> {
    let input = QoderTraceInput::new(QoderTraceOptions {
        state_store: store,
        log_dir: Some(logs.to_string_lossy().into_owned()),
        poll_interval_ms: Some(60000),
        multimodal_enabled: false,
        upload_mode: None,
        allowed_root_paths: Vec::new(),
    });
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input
        .inner
        .on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let result = rows.lock().unwrap().clone();
    result
}
fn schema(entry: &AgentActivityEntry) {
    let v = serde_json::to_value(entry).unwrap();
    for k in ["time_unix_nano", "observed_time_unix_nano"] {
        assert!(
            v[k].as_str()
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())),
            "{v}"
        )
    }
    for k in ["event.id", "gen_ai.agent.type", "gen_ai.provider.name"] {
        assert!(v[k].as_str().is_some_and(|s| !s.is_empty()), "{v}")
    }
    assert!(v["user.id"].is_string());
    assert!(v["gen_ai.session.id"].is_string());
    assert!(entry.event_name.is_some());
}
#[tokio::test]
async fn l76_l161_real_qoder_hook_read_normalize_schema_persist_no_replay_and_incremental_appends()
{
    let root = root();
    let logs = root.path().join("logs");
    std::fs::create_dir(&logs).unwrap();
    let file = history(&logs, "qoder");
    std::fs::write(&file, "").unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    store.load().await;
    assert!(collect_qoder(&logs, store.clone()).await.is_empty());
    let mut call = canonical("tool.call", "integ-call-1", "integ-turn-1", "qoder-cli");
    call["gen_ai.tool.call.arguments"] = json!("{\"file_path\":\"/proj/new.ts\"}");
    let mut result = canonical("tool.result", "integ-result-1", "integ-turn-1", "qoder-cli");
    result["gen_ai.tool.call.result"] = json!("wrote /proj/new.ts");
    result["gen_ai.tool.call.duration"] = json!(42);
    result["tool.result.status"] = json!("success");
    append(&file, &[call, result]);
    let rows = collect_qoder(&logs, store.clone()).await;
    assert_eq!(rows.len(), 2);
    for (row, event) in rows.iter().zip(["tool.call", "tool.result"]) {
        let v = serde_json::to_value(row).unwrap();
        assert_eq!(v["event.name"], event);
        assert_eq!(row.agent_type, "qoder-cli");
        assert_eq!(row.session_id, "integ-sess-1");
        assert_eq!(v["gen_ai.tool.name"], "create_file");
        schema(row);
    }
    assert_eq!(
        serde_json::to_value(&rows[1]).unwrap()["tool.result.status"],
        "success"
    );
    store.save().await.unwrap();
    assert_eq!(
        store.get_offset("qoder-trace"),
        std::fs::metadata(&file).unwrap().len() as f64
    );
    assert_eq!(
        store.get("qoder-trace").last_file(),
        file.file_name().unwrap().to_str()
    );
    assert!(collect_qoder(&logs, store.clone()).await.is_empty());
    for wave in [1, 2] {
        let mut row = canonical(
            "tool.result",
            &format!("e-turn-batch{wave}"),
            &format!("turn-batch{wave}"),
            "qoder-cli",
        );
        row["gen_ai.tool.name"] = json!("write_to_file");
        append(&file, &[row]);
        let rows = collect_qoder(&logs, store.clone()).await;
        assert_eq!(rows.len(), 1);
        let v = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(v["event.name"], "tool.result");
        assert_eq!(rows[0].agent_type, "qoder-cli");
        assert_eq!(v["gen_ai.tool.name"], "write_to_file");
        assert_eq!(rows[0].event_id, format!("e-turn-batch{wave}"));
        store.save().await.unwrap();
    }
}
#[tokio::test]
async fn l514_missing_qoder_checkpoint_baselines_all_three_historical_turns_then_reads_new_pair() {
    let root = root();
    let file = history(root.path(), "qoder");
    let turns = [
        ("turn-old-1", "old prompt 1"),
        ("turn-old-2", "old prompt 2"),
        ("turn-latest", "latest prompt"),
    ];
    let old = turns
        .into_iter()
        .enumerate()
        .flat_map(|(n, (turn, prompt))| {
            let mut user = canonical("other", &format!("e-{}", 2 * n + 1), turn, "qoder-cli");
            user.as_object_mut().unwrap().remove("gen_ai.step.id");
            user["gen_ai.input.messages_delta"] =
                json!([{"role":"user","parts":[{"type":"text","content":prompt}]}]);
            let mut response = canonical(
                "llm.response",
                &format!("e-{}", 2 * n + 2),
                turn,
                "qoder-cli",
            );
            for (row, offset) in [(&mut user, 0), (&mut response, 1)] {
                let at = format!("17800000{:02}000000000", n * 10 + offset);
                row["time_unix_nano"] = json!(at);
                row["observed_time_unix_nano"] = json!(at);
            }
            [user, response]
        })
        .collect::<Vec<_>>();
    append(&file, &old);
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    store.load().await;
    assert!(collect_qoder(root.path(), store.clone()).await.is_empty());
    store.save().await.unwrap();
    assert_eq!(
        store.get_offset("qoder-trace"),
        std::fs::metadata(&file).unwrap().len() as f64
    );
    assert_eq!(
        store.get("qoder-trace").last_file(),
        file.file_name().unwrap().to_str()
    );
    append(
        &file,
        &[
            canonical(
                "llm.request",
                "e-new-request",
                "turn-after-baseline",
                "qoder-cli",
            ),
            canonical(
                "llm.response",
                "e-new-response",
                "turn-after-baseline",
                "qoder-cli",
            ),
        ],
    );
    let rows = collect_qoder(root.path(), store).await;
    assert_eq!(
        rows.iter().map(|e| e.event_id.as_str()).collect::<Vec<_>>(),
        ["e-new-request", "e-new-response"]
    );
}
#[tokio::test]
async fn l656_real_kiro_cold_start_keeps_only_last_turn_and_advances_complete_byte_offset() {
    let root = root();
    let file = history(root.path(), "kiro-cli");
    append(
        &file,
        &(0..3)
            .flat_map(|n| {
                [
                    canonical(
                        "llm.request",
                        &format!("ke-{}", 2 * n + 1),
                        ["kiro-turn-1", "kiro-turn-2", "kiro-latest"][n],
                        "kiro-cli",
                    ),
                    canonical(
                        "llm.response",
                        &format!("ke-{}", 2 * n + 2),
                        ["kiro-turn-1", "kiro-turn-2", "kiro-latest"][n],
                        "kiro-cli",
                    ),
                ]
            })
            .collect::<Vec<_>>(),
    );
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    for expected in [2, 0] {
        let input = KiroCliLogInput::new(HookInputOptions {
            state_store: store.clone(),
            log_dir: Some(root.path().to_string_lossy().into_owned()),
            log_prefix: None,
            poll_interval_ms: Some(60000),
        });
        let rows = Arc::new(Mutex::new(Vec::new()));
        let observed = rows.clone();
        input.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
        input.start().await;
        input.stop().await;
        let rows = rows.lock().unwrap().clone();
        assert_eq!(rows.len(), expected);
        assert!(rows
            .iter()
            .all(|e| e.turn_id.as_deref() == Some("kiro-latest")));
        store.save().await.unwrap();
        assert_eq!(
            store.get_offset("kiro-cli-log"),
            std::fs::metadata(&file).unwrap().len() as f64
        );
        assert_eq!(
            store.get("kiro-cli-log").last_file(),
            file.file_name().unwrap().to_str()
        );
    }
}
#[cfg(unix)]
fn original(line: u64) -> Vec<Vec<Value>> {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "fixtures/integration-hook-native-history.json"
    ))
    .unwrap();
    rows.iter().find(|r| r["line"] == line).unwrap()["writes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["records"].as_array().unwrap().clone())
        .collect()
}
#[cfg(unix)]
fn binding(root: &Path) -> PathBuf {
    let hooks = root.join("hooks");
    std::fs::create_dir_all(hooks.join("shared")).unwrap();
    for name in [
        "qoder-loongsuite-pilot-hook.sh",
        "cursor-loongsuite-pilot-hook.sh",
        "shared/native.sh",
    ] {
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("assets/hooks")
                .join(name),
            hooks.join(name),
        )
        .unwrap();
    }
    std::fs::write(
        hooks.join("pilot-bin"),
        format!("{}\n", env!("CARGO_BIN_EXE_loongsuite-pilot")),
    )
    .unwrap();
    hooks
}
#[cfg(unix)]
async fn invoke(
    root: &Path,
    hooks: &Path,
    agent: &str,
    data: &Path,
    payload: &str,
    worker: bool,
) -> std::process::Output {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut c = tokio::process::Command::new("/bin/bash");
    c.arg(hooks.join(format!("{agent}-loongsuite-pilot-hook.sh")))
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", root.join("xdg-data"))
        .env("LOONGSUITE_PILOT_DATA_DIR", data)
        .env("LOONGSUITE_PILOT_CACHE_DIR", root.join("pilot-cache"))
        .env("CODEX_HOME", root.join("codex"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude"))
        .env("GIT_CONFIG_GLOBAL", root.join("no-git"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("PATH", root.join("no-runtimes"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if worker {
        c.env("AGENTTEAMS_WORKER_NAME", "qoder-worker")
            .env("AGENTTEAMS_INSTANCE_ID", "lw-qoder")
            .env("AGENTTEAMS_TOKEN", "should-not-leak");
    }
    let mut child = c.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(payload.as_bytes()).await.unwrap();
    drop(stdin);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}
#[cfg(unix)]
fn disk_rows(logs: &Path, prefix: &str) -> Vec<Value> {
    std::fs::read_to_string(history(logs, prefix))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
#[cfg(unix)]
#[tokio::test]
async fn l211_bound_qoder_shell_default_agent_native_processor_real_input_preserves_worker_resource(
) {
    let root = root();
    let hooks = binding(root.path());
    let data = root.path().join("data");
    let logs = data.join("logs/qoder/history");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(history(&logs, "qoder"), "").unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    assert!(collect_qoder(&logs, store.clone()).await.is_empty());
    let transcript = root.path().join("transcript.jsonl");
    append(&transcript, &original(211)[0]);
    let out = invoke(
        root.path(),
        &hooks,
        "qoder",
        &data,
        &json!({"hook_event_name":"Stop","transcript_path":transcript,"session_id":"sess-hook"})
            .to_string(),
        true,
    )
    .await;
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "{}");
    let raw = disk_rows(&logs, "qoder");
    assert!(!raw.is_empty());
    let first = &raw[0];
    for key in [
        "type",
        "uuid",
        "sessionId",
        "agentteams.worker.name",
        "agentteams.instance.id",
        "agentteams.token",
    ] {
        assert!(first.get(key).is_none(), "unexpected {key}: {first}")
    }
    assert_eq!(first["event.name"], "other");
    assert_eq!(first["gen_ai.agent.name"], "qoder-worker");
    assert_eq!(
        first["resourceAttributes"],
        json!({"agentteams.worker.name":"qoder-worker","agentteams.instance.id":"lw-qoder"})
    );
    assert!(!serde_json::to_string(&raw)
        .unwrap()
        .contains("should-not-leak"));
    let rows = collect_qoder(&logs, store).await;
    let user = rows
        .iter()
        .find(|e| serde_json::to_value(e).unwrap()["event.name"] == "other" && e.step_id.is_none())
        .unwrap();
    let user = serde_json::to_value(user).unwrap();
    assert_eq!(user["gen_ai.agent.type"], "qoder-cli");
    assert_eq!(user["gen_ai.session.id"], "sess-hook");
    assert_eq!(user["gen_ai.agent.name"], "qoder-worker");
    assert_eq!(
        user["resourceAttributes"],
        json!({"agentteams.worker.name":"qoder-worker","agentteams.instance.id":"lw-qoder"})
    );
}
#[cfg(unix)]
#[tokio::test]
async fn l344_bound_qoder_shell_retains_delayed_ide_tool_step_and_native_user_identity() {
    use std::collections::BTreeSet;
    let root = root();
    let hooks = binding(root.path());
    let data = root.path().join("data");
    let transcript = root.path().join("delayed.jsonl");
    append(&transcript, &original(344)[0]);
    invoke(root.path(),&hooks,"qoder",&data,&json!({"hook_event_name":"Stop","transcript_path":transcript,"session_id":"sess-delayed-ide","extra":{"email":"git-user@example.com","user":{"name":"qoder-user","email":"qoder-user@example.com","uid":"qoder-native-user-id"}}}).to_string(),false).await;
    let rows = disk_rows(&data.join("logs/qoder/history"), "qoder");
    assert!(rows
        .iter()
        .all(|r| r["user.name"] == "qoder-user" && r["user.email"] == "qoder-user@example.com"));
    assert!(!rows
        .iter()
        .any(|r| r["user.email"] == "git-user@example.com" || r.get("user.uid").is_some()));
    let req = rows
        .iter()
        .filter(|r| r["event.name"] == "llm.request")
        .collect::<Vec<_>>();
    let resp = rows
        .iter()
        .filter(|r| r["event.name"] == "llm.response")
        .collect::<Vec<_>>();
    assert_eq!(req.len(), 3);
    assert_eq!(resp.len(), 3);
    assert_eq!(
        req.iter()
            .map(|r| r["gen_ai.step.id"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        resp.iter()
            .map(|r| r["gen_ai.step.id"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
    );
    let tools = rows
        .iter()
        .filter(|r| r["event.name"] == "tool.call")
        .map(|r| (r["gen_ai.step.id"].clone(), r["gen_ai.tool.name"].clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        tools,
        [
            (req[0]["gen_ai.step.id"].clone(), json!("Write")),
            (req[1]["gen_ai.step.id"].clone(), json!("Bash"))
        ]
    );
}
#[cfg(unix)]
#[tokio::test]
async fn l713_bound_qoder_shell_real_transcript_cursor_preserves_two_distinct_human_turns() {
    use std::collections::BTreeSet;
    let root = root();
    let hooks = binding(root.path());
    let data = root.path().join("data");
    let transcript = root.path().join("multi.jsonl");
    for wave in original(713) {
        append(&transcript, &wave);
        invoke(root.path(),&hooks,"qoder",&data,&json!({"hook_event_name":"Stop","transcript_path":transcript,"session_id":"sess-multi"}).to_string(),false).await;
    }
    let mut rows = disk_rows(&data.join("logs/qoder/history"), "qoder")
        .into_iter()
        .filter(|r| r["event.name"] == "other")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows.iter()
            .map(|r| r["gen_ai.turn.id"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        2
    );
    rows.sort_by_key(|r| {
        r["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
    });
    assert_eq!(
        rows[0]["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"hello"}]}])
    );
    assert_eq!(
        rows[1]["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"完成力扣第143题"}]}])
    );
}
#[cfg(unix)]
#[tokio::test]
async fn l856_bound_cursor_shell_bad_json_failopens_with_hashed_parse_diagnostic() {
    let root = root();
    let hooks = binding(root.path());
    let data = root.path().join("data");
    let out = invoke(root.path(), &hooks, "cursor", &data, "not-json", false).await;
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "{}");
    assert!(!history(&data.join("logs/cursor/history"), "cursor").exists());
    let rows = disk_rows(&data.join("logs/cursor/errors"), "cursor-error");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["stage"], "parse");
    assert_eq!(rows[0]["error.type"], "invalid_json");
    assert!(rows[0]["input_bytes"].as_u64().unwrap() > 0);
    let hash = rows[0]["input_sha256"].as_str().unwrap();
    assert_eq!(hash.len(), 64);
    assert!(hash
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
}
#[cfg(unix)]
#[tokio::test]
async fn l874_bound_cursor_shell_unwritable_data_path_retains_json_failopen_protocol() {
    let root = root();
    let hooks = binding(root.path());
    let bad = root.path().join("not-a-dir");
    std::fs::write(&bad, "x").unwrap();
    let out = invoke(
        root.path(),
        &hooks,
        "cursor",
        &bad,
        &json!({"hook_event_name":"postToolUse","text":"hello"}).to_string(),
        false,
    )
    .await;
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "{}");
}
