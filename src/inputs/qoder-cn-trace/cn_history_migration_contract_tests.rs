//! Original CN trace contracts: actual input, SQL, segments, intercept and JSONL.
use super::*;
use crate::checkpoints::{InputState, StateStore};
use rusqlite::{params, Connection};
use serde_json::json;

tokio::task_local! {
    static EXPECTED_IDS: Arc<Mutex<Vec<Vec<String>>>>;
}

pub(super) fn observe_expected(ids: &[String]) {
    let _ = EXPECTED_IDS.try_with(|seen| seen.lock().unwrap().push(ids.to_vec()));
}

struct Env(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl Env {
    fn new(root: &Path) -> Self {
        let mut prior = Vec::new();
        for (key, path) in [
            ("HOME", root.to_path_buf()),
            ("USERPROFILE", root.to_path_buf()),
            ("APPDATA", root.join("AppData").join("Roaming")),
            ("LOCALAPPDATA", root.join("AppData").join("Local")),
            ("XDG_CONFIG_HOME", root.join(".config")),
        ] {
            prior.push((key, std::env::var_os(key)));
            unsafe { std::env::set_var(key, path) };
        }
        Self(prior)
    }
}
impl Drop for Env {
    fn drop(&mut self) {
        for (key, prior) in self.0.drain(..) {
            match prior {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
    }
}

struct Fixture {
    root: tempfile::TempDir,
    _env: Env,
    dir: std::path::PathBuf,
    db: std::path::PathBuf,
    store: Arc<StateStore>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let env = Env::new(root.path());
        let dir = root
            .path()
            .join(".loongsuite-pilot")
            .join("logs")
            .join("qoder-cn")
            .join("history");
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::inputs::base::app_support_root()
            .join("QoderCN")
            .join("SharedClientCache")
            .join("cache")
            .join("db")
            .join("local.db");
        Self::schema(&db);
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        let fixture = Self {
            root,
            _env: env,
            dir,
            db,
            store,
        };
        fixture.seed_zero();
        fixture
    }
    fn schema(db: &Path) {
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        Connection::open(db).unwrap().execute_batch("CREATE TABLE chat_message(
            id TEXT PRIMARY KEY,session_id TEXT,request_id TEXT,role TEXT,content TEXT,summary TEXT,
            summary_modified INTEGER,summary_trigger INTEGER DEFAULT0,tool_result TEXT,
            token_info TEXT,model_info TEXT,extra TEXT DEFAULT '',gmt_create INTEGER);
            CREATE TABLE chat_record(request_id TEXT PRIMARY KEY,session_id TEXT,extra TEXT DEFAULT '');".replace("DEFAULT0","DEFAULT 0").as_str()).unwrap();
    }
    fn seed_zero(&self) {
        self.store.set(
            "qoder-cn-trace",
            InputState::new()
                .with_last_file(self.file_name())
                .with_last_offset(0.0),
        );
    }
    fn file_name(&self) -> String {
        format!("qoder-cn-{}.jsonl", get_today_date_string())
    }
    fn file(&self) -> std::path::PathBuf {
        self.dir.join(self.file_name())
    }
    fn write(&self, rows: &[Value]) {
        std::fs::write(
            self.file(),
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
    }
    fn input(&self) -> QoderCnTraceInput {
        QoderCnTraceInput::new(QoderCnTraceOptions {
            state_store: Arc::clone(&self.store),
            log_dir: Some(self.dir.to_string_lossy().into_owned()),
            poll_interval_ms: Some(60000),
        })
    }
    fn row(&self, db: &Path, row: (&str, &str, &str, i64, i64, i64)) {
        Connection::open(db).unwrap().execute("INSERT INTO chat_message(id,session_id,request_id,role,token_info,gmt_create) VALUES(?1,?2,?3,'assistant',?4,?5)",
            params![row.0,row.1,row.2,json!({"prompt_tokens":row.3,"completion_tokens":row.4,"cached_tokens":0}).to_string(),row.5]).unwrap();
    }
    async fn run(&self) -> Vec<Value> {
        let input = self.input();
        let got = Arc::new(Mutex::new(Vec::new()));
        let copy = Arc::clone(&got);
        input.bind_collector(
            move |rows| {
                copy.lock()
                    .unwrap()
                    .extend(rows.iter().map(|row| serde_json::to_value(row).unwrap()))
            },
            |_| {},
        );
        input.start().await.unwrap();
        input.stop().await.unwrap();
        let rows = got.lock().unwrap().clone();
        rows
    }
    fn segments(&self, product: &str, session: &str, request: &str, start: i64, end: i64) {
        let dir = self
            .root
            .path()
            .join(product)
            .join("logs")
            .join("sessions")
            .join("Users-project")
            .join(session)
            .join("segments");
        std::fs::create_dir_all(&dir).unwrap();
        let rows = [
            json!({"type":"model.request.started","request_id":request,"loop_id":format!("loop-{request}"),"ts":start}),
            json!({"type":"model.response.completed","request_id":request,"loop_id":format!("loop-{request}"),"ts":end,"data":{"input_tokens":0,"output_tokens":0,"model":"qwen3-max"}}),
        ];
        std::fs::write(
            dir.join("segment-0.jsonl"),
            rows.iter().map(|r| format!("{r}\n")).collect::<String>(),
        )
        .unwrap();
    }
    fn intercept(&self, id: &str, input: i64, output: i64, cache: i64, now: i64) {
        let path = self
            .root
            .path()
            .join(".loongsuite-pilot")
            .join("logs")
            .join("qoderclicn-intercept.jsonl");
        std::fs::write(path,format!("{}\n",json!({"type":"token","id":id,"ts":now,"prompt_tokens":input,"completion_tokens":output,"cached_tokens":cache,"total_tokens":input+output}))).unwrap();
    }
}
fn entry(event: &str, turn: &str, step: &str, session: &str, ts: i64) -> Value {
    json!({"event.id":format!("{turn}-{event}-{step}"),"event.name":event,"gen_ai.session.id":session,"gen_ai.turn.id":turn,"gen_ai.step.id":step,"gen_ai.agent.type":"qoder-cn","gen_ai.provider.name":"qwen","gen_ai.request.model":"auto","gen_ai.response.model":"auto","time_unix_nano":format!("{ts}000000"),"observed_time_unix_nano":format!("{ts}000000")})
}
fn named<'a>(rows: &'a [Value], event: &str) -> &'a Value {
    rows.iter().find(|r| r["event.name"] == event).unwrap()
}
fn turn_response<'a>(rows: &'a [Value], turn: &str) -> &'a Value {
    rows.iter()
        .find(|r| r["event.name"] == "llm.response" && r["gen_ai.turn.id"] == turn)
        .unwrap()
}
fn duration(rows: &[Value]) -> i128 {
    (named(rows, "llm.response")["time_unix_nano"]
        .as_str()
        .unwrap()
        .parse::<i128>()
        .unwrap()
        - named(rows, "llm.request")["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<i128>()
            .unwrap())
        / 1_000_000
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
fn cli_rows(session: &str, request: &str, response: &str, ts: i64) -> Vec<Value> {
    let mut req = entry("llm.request", "cli-turn", "cli-turn:s1", session, ts);
    req["agent.client_request_id"] = json!(request);
    let mut resp = entry("llm.response", "cli-turn", "cli-turn:s1", session, ts);
    resp["agent.client_request_id"] = json!(request);
    resp["gen_ai.response.id"] = json!(response);
    vec![req, resp]
}

#[tokio::test]
async fn source_l54_missing_checkpoint_baselines_history_then_collects_new_tail() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    use std::io::Write;
    let f = Fixture::new();
    let mut old = vec![
        entry(
            "llm.response",
            "historical-turn-1",
            "historical-turn-1:s1",
            "",
            1780000000000,
        ),
        entry(
            "llm.response",
            "historical-turn-2",
            "historical-turn-2:s1",
            "",
            1780000001000,
        ),
    ];
    for row in &mut old {
        row["agent.transcript.cursor_mode"] = json!("incremental");
    }
    f.write(&old);
    f.store.delete("qoder-cn-trace");
    let input = f.input();
    let got = Arc::new(Mutex::new(Vec::<AgentActivityEntry>::new()));
    let copy = Arc::clone(&got);
    input.bind_collector(
        move |rows| copy.lock().unwrap().extend_from_slice(rows),
        |_| {},
    );
    input.start().await.unwrap();
    assert!(got.lock().unwrap().is_empty());
    let state = f.store.get("qoder-cn-trace");
    assert_eq!(state.last_file(), Some(f.file_name().as_str()));
    assert_eq!(
        state.last_offset().unwrap() as u64,
        std::fs::metadata(f.file()).unwrap().len()
    );
    assert_eq!(state.extra().unwrap()["hookHistoryInitialized"], true);
    let mut next = entry(
        "llm.response",
        "turn-after-baseline",
        "turn-after-baseline:s1",
        "",
        1780000002000,
    );
    next["agent.transcript.cursor_mode"] = json!("incremental");
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(f.file())
        .unwrap();
    writeln!(file, "{next}").unwrap();
    drop(file);
    let entries = input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap();
    input.stop().await.unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|r| r.turn_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["turn-after-baseline"]
    );
}

#[tokio::test]
async fn source_l101_same_session_multiple_turns_join_actual_sql_rows() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    f.row(
        &f.db,
        ("msg-1", "sess-abc", "req-1", 100, 10, 1780000001000),
    );
    f.row(
        &f.db,
        ("msg-2", "sess-abc", "req-2", 200, 20, 1780000002000),
    );
    f.write(&[
        entry(
            "llm.request",
            "turn-A",
            "turn-A:s1",
            "sess-abc",
            1780000000000,
        ),
        entry(
            "llm.response",
            "turn-A",
            "turn-A:s1",
            "sess-abc",
            1780000001000,
        ),
        entry(
            "llm.request",
            "turn-B",
            "turn-B:s1",
            "sess-abc",
            1780000001500,
        ),
        entry(
            "llm.response",
            "turn-B",
            "turn-B:s1",
            "sess-abc",
            1780000002000,
        ),
    ]);
    for _ in 0..16 {
        f.seed_zero();
        let rows = f.run().await;
        assert_eq!(
            rows.iter()
                .filter(|r| r["event.name"] == "llm.response")
                .count(),
            2
        );
        for (turn, id, input, output) in
            [("turn-A", "msg-1", 100, 10), ("turn-B", "msg-2", 200, 20)]
        {
            let row = turn_response(&rows, turn);
            assert_eq!(row["gen_ai.usage.input_tokens"], input);
            assert_eq!(row["gen_ai.usage.output_tokens"], output);
            assert_eq!(row["gen_ai.response.id"], id);
        }
    }
}

#[tokio::test]
async fn source_l139_plugin_sql_layout_preserves_cn_identity() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    std::fs::remove_dir_all(f.db.parent().unwrap()).unwrap();
    let db = f
        .root
        .path()
        .join(".qoder-cn/shared_client/cache/db/local.db");
    Fixture::schema(&db);
    f.row(
        &db,
        (
            "msg-plugin",
            "sess-plugin-layout",
            "req-plugin",
            300,
            30,
            1780000021000,
        ),
    );
    f.write(&[
        entry(
            "llm.request",
            "turn-P",
            "turn-P:s1",
            "sess-plugin-layout",
            1780000020000,
        ),
        entry(
            "llm.response",
            "turn-P",
            "turn-P:s1",
            "sess-plugin-layout",
            1780000021000,
        ),
    ]);
    let rows = f.run().await;
    let row = named(&rows, "llm.response");
    assert_eq!(row["gen_ai.usage.input_tokens"], 300);
    assert_eq!(row["gen_ai.usage.output_tokens"], 30);
    assert_eq!(row["gen_ai.response.id"], "msg-plugin");
    assert!(rows.iter().all(|r| r["gen_ai.agent.type"] == "qoder-cn"));
}

#[tokio::test]
async fn source_l170_shared_session_has_distinct_turn_trace_ids() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    f.row(&f.db, ("msg-x", "sess-trace", "req-x", 5, 5, 1780000010000));
    f.row(&f.db, ("msg-y", "sess-trace", "req-y", 6, 6, 1780000011000));
    f.write(&[
        entry(
            "llm.response",
            "turn-1",
            "turn-1:s1",
            "sess-trace",
            1780000010000,
        ),
        entry(
            "llm.response",
            "turn-2",
            "turn-2:s1",
            "sess-trace",
            1780000011000,
        ),
    ]);
    let rows = f.run().await;
    let first = turn_response(&rows, "turn-1")["trace_id"].as_str().unwrap();
    let second = turn_response(&rows, "turn-2")["trace_id"].as_str().unwrap();
    assert!(!first.is_empty());
    assert!(!second.is_empty());
    assert_ne!(first, second);
}

#[tokio::test]
async fn source_l196_last_duplicate_keeps_exact_request_boundary_and_all_step_events() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    let t = 1780000200000;
    f.row(&f.db, ("msg-d1", "sess-dedupe", "req-d", 10, 2, t));
    f.row(&f.db, ("msg-d2", "sess-dedupe", "req-d2", 15, 3, t + 100));
    f.write(&[
        entry("llm.request", "turn-d", "turn-d:s1", "sess-dedupe", t),
        entry("llm.response", "turn-d", "turn-d:s1", "sess-dedupe", t),
        entry("tool.call", "turn-d", "turn-d:s1", "sess-dedupe", t),
        entry("llm.request", "turn-d", "turn-d:s1", "sess-dedupe", t + 1),
        entry("llm.response", "turn-d", "turn-d:s1", "sess-dedupe", t + 1),
        entry("tool.call", "turn-d", "turn-d:s1", "sess-dedupe", t + 1),
        entry("tool.result", "turn-d", "turn-d:s1", "sess-dedupe", t + 2),
        entry(
            "llm.response",
            "turn-d",
            "turn-d:s2",
            "sess-dedupe",
            t + 100,
        ),
        entry("llm.request", "turn-d", "turn-d:s2", "sess-dedupe", t + 99),
    ]);
    let rows = f.run().await;
    for (step, event) in [
        ("turn-d:s1", "llm.request"),
        ("turn-d:s1", "llm.response"),
        ("turn-d:s1", "tool.call"),
        ("turn-d:s1", "tool.result"),
        ("turn-d:s2", "llm.request"),
        ("turn-d:s2", "llm.response"),
    ] {
        let matched = rows
            .iter()
            .filter(|r| r["event.name"] == event && r["gen_ai.step.id"] == step)
            .collect::<Vec<_>>();
        assert_eq!(matched.len(), 1);
        if step == "turn-d:s1" && event == "llm.request" {
            assert_eq!(
                matched[0]["time_unix_nano"],
                (i128::from(t) * 1_000_000 + 1).to_string()
            );
        }
    }
}

#[tokio::test]
async fn source_l255_tool_result_keeps_one_millisecond_gap() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    let t = 1780000050000;
    f.row(&f.db, ("msg-t", "sess-tool-dur", "req-t", 10, 2, t));
    f.write(&[
        entry("llm.response", "turn-t", "turn-t:s1", "sess-tool-dur", t),
        entry("tool.call", "turn-t", "turn-t:s1", "sess-tool-dur", t),
        entry("tool.result", "turn-t", "turn-t:s1", "sess-tool-dur", t + 1),
    ]);
    let rows = f.run().await;
    let call = named(&rows, "tool.call")["time_unix_nano"]
        .as_str()
        .unwrap()
        .parse::<i128>()
        .unwrap()
        / 1_000_000;
    let result = named(&rows, "tool.result")["time_unix_nano"]
        .as_str()
        .unwrap()
        .parse::<i128>()
        .unwrap()
        / 1_000_000;
    assert!(result - call >= 1);
}

#[tokio::test]
async fn source_l280_no_session_still_gets_trace_without_sql_tokens() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    f.write(&[entry(
        "llm.response",
        "orphan-turn",
        "orphan:s1",
        "",
        1780000020000,
    )]);
    let rows = f.run().await;
    assert_eq!(rows.len(), 1);
    assert!(!rows[0]["trace_id"].as_str().unwrap().is_empty());
    assert!(rows[0].get("gen_ai.usage.input_tokens").is_none());
}

#[tokio::test]
async fn source_l292_safe_invocation_fields_survive_but_token_is_blocked() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    let mut row = entry(
        "llm.response",
        "custom-attribute-turn",
        "custom-attribute-turn:s1",
        "",
        1780000021000,
    );
    for (k, v) in [
        ("multica.issue.id", "AGE-992"),
        ("multica.user.id", "staff-1"),
        ("multica.api_token", "blocked"),
        ("agentcore.task_id", "task-managed-runtime"),
        ("agentcore.subtask_id", "subtask-managed-runtime"),
    ] {
        row[k] = json!(v);
    }
    f.write(&[row]);
    let rows = f.run().await;
    assert_eq!(rows.len(), 1);
    for (k, v) in [
        ("multica.issue.id", "AGE-992"),
        ("multica.user.id", "staff-1"),
        ("agentcore.task_id", "task-managed-runtime"),
        ("agentcore.subtask_id", "subtask-managed-runtime"),
    ] {
        assert_eq!(rows[0][k], v);
    }
    assert!(rows[0].get("multica.api_token").is_none());
}

#[tokio::test]
async fn source_l318_cn_segments_and_cn_intercept_join_actual_input() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    let t = now();
    f.write(&cli_rows("cli-sess-join", "creq-join-1", "resp-join-1", t));
    f.segments(
        ".qoder-cn",
        "cli-sess-join",
        "creq-join-1",
        t - 4000,
        t - 1000,
    );
    f.intercept("resp-join-1", 1234, 56, 1000, t);
    let rows = f.run().await;
    let resp = named(&rows, "llm.response");
    assert_eq!(resp["gen_ai.usage.input_tokens"], 1234);
    assert_eq!(resp["gen_ai.usage.output_tokens"], 56);
    assert_eq!(resp["gen_ai.usage.cache_read.input_tokens"], 1000);
    assert_eq!(duration(&rows), 3000);
    assert_eq!(resp["gen_ai.response.model"], "qwen3-max");
}

#[tokio::test]
async fn source_l361_late_segments_still_allow_exact_intercept_usage() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    let t = now();
    f.write(&cli_rows(
        "cli-sess-no-segments",
        "creq-no-segments",
        "resp-no-segments",
        t,
    ));
    f.intercept("resp-no-segments", 700, 42, 0, t);
    let rows = f.run().await;
    let resp = named(&rows, "llm.response");
    assert_eq!(resp["gen_ai.usage.input_tokens"], 700);
    assert_eq!(resp["gen_ai.usage.output_tokens"], 42);
    assert_eq!(duration(&rows), 0);
}

#[tokio::test]
async fn source_l405_international_segments_never_supply_cn_clock_or_model() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    let t = now();
    f.write(&cli_rows("cli-sess-wrong-root", "creq-wrong-root", "", t));
    f.segments(
        ".qoder",
        "cli-sess-wrong-root",
        "creq-wrong-root",
        t - 4000,
        t - 1000,
    );
    let rows = f.run().await;
    assert_eq!(duration(&rows), 0);
    assert_eq!(
        named(&rows, "llm.response")["gen_ai.response.model"],
        "auto"
    );
}

#[tokio::test]
async fn source_l434_actual_segment_reader_receives_ordered_batch_request_ids() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let f = Fixture::new();
    let t = now();
    let mut records = Vec::new();
    for (i, id) in ["creq-a", "creq-b"].iter().enumerate() {
        let turn = format!("cli-turn-ids-{i}");
        let step = format!("{turn}:s1");
        let mut rows = cli_rows(
            "cli-sess-expected-ids",
            id,
            &format!("resp-{id}"),
            t + i as i64,
        );
        for row in &mut rows {
            row["gen_ai.turn.id"] = json!(turn);
            row["gen_ai.step.id"] = json!(step);
        }
        records.extend(rows);
    }
    f.write(&records);
    for _ in 0..16 {
        f.seed_zero();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let input = f.input();
        EXPECTED_IDS
            .scope(Arc::clone(&observed), async {
                input
                    .inner
                    .body
                    .collect(&input.inner.runtime)
                    .await
                    .unwrap();
            })
            .await;
        assert_eq!(
            observed.lock().unwrap().as_slice(),
            [vec!["creq-a".to_string(), "creq-b".to_string()]]
        );
    }
}

#[tokio::test]
async fn source_l479_partial_tail_is_committed_only_after_newline() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    use std::io::Write;
    let f = Fixture::new();
    let complete = [
        entry(
            "llm.request",
            "turn-complete",
            "turn-complete:s1",
            "sess-partial",
            1780000030000,
        ),
        entry(
            "llm.response",
            "turn-complete",
            "turn-complete:s1",
            "sess-partial",
            1780000031000,
        ),
    ];
    let text = complete
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    let late = entry(
        "llm.response",
        "turn-late",
        "turn-late:s1",
        "sess-partial",
        1780000032000,
    )
    .to_string();
    let split = late.len() / 2;
    std::fs::write(f.file(), format!("{}{}", text, &late[..split])).unwrap();
    let input = f.input();
    let first = input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap();
    assert_eq!(first.len(), 2);
    assert!(first
        .iter()
        .all(|r| r.turn_id.as_deref() == Some("turn-complete")));
    assert_eq!(
        f.store.get("qoder-cn-trace").last_file(),
        Some(f.file_name().as_str())
    );
    assert_eq!(
        f.store.get("qoder-cn-trace").last_offset(),
        Some(text.len() as f64)
    );
    let mut append = std::fs::OpenOptions::new()
        .append(true)
        .open(f.file())
        .unwrap();
    writeln!(append, "{}", &late[split..]).unwrap();
    drop(append);
    let second = input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap();
    assert_eq!(
        second
            .iter()
            .map(|r| r.turn_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["turn-late"]
    );
}

#[tokio::test]
async fn source_l526_entirely_partial_record_holds_zero_until_completed() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    use std::io::Write;
    let f = Fixture::new();
    let text = entry(
        "llm.response",
        "turn-only-partial",
        "turn-only-partial:s1",
        "sess-only-partial",
        1780000033000,
    )
    .to_string();
    std::fs::write(f.file(), &text[..20]).unwrap();
    let input = f.input();
    assert!(input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(f.store.get("qoder-cn-trace").last_offset(), Some(0.0));
    let mut append = std::fs::OpenOptions::new()
        .append(true)
        .open(f.file())
        .unwrap();
    writeln!(append, "{}", &text[20..]).unwrap();
    drop(append);
    let next = input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap();
    assert_eq!(
        next.iter()
            .map(|r| r.turn_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["turn-only-partial"]
    );
}
