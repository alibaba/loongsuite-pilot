//! Historical cold-start contracts through actual native Hook processes and Input.
use async_trait::async_trait;
use loongsuite_pilot::checkpoints::StateStore;
use loongsuite_pilot::inputs::qoder_trace::{
    InterceptData, QoderTraceInput, QoderTraceOptions, QoderTraceReaders, SegmentTokenData,
    SqliteTokenResult,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
struct Readers;
#[async_trait]
impl QoderTraceReaders for Readers {
    async fn read_cli_intercept(&self) -> InterceptData {
        InterceptData::default()
    }
    async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
        Vec::new()
    }
    async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
        SqliteTokenResult {
            rows: Vec::new(),
            matched_db_path: None,
        }
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    store: Arc<StateStore>,
    input: QoderTraceInput,
    captured: Arc<Mutex<Vec<loongsuite_pilot::types::AgentActivityEntry>>>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let file = root.join("transcript.jsonl");
        let store = Arc::new(StateStore::new(root.join("input-state.json")));
        let captured = Arc::new(Mutex::new(Vec::new()));
        let input = Self::build_input(&root, &store, &captured);
        Self {
            _root: temp,
            root,
            file,
            store,
            input,
            captured,
        }
    }
    fn build_input(
        root: &std::path::Path,
        store: &Arc<StateStore>,
        captured: &Arc<Mutex<Vec<loongsuite_pilot::types::AgentActivityEntry>>>,
    ) -> QoderTraceInput {
        let input = QoderTraceInput::with_readers(
            QoderTraceOptions {
                state_store: Arc::clone(store),
                log_dir: Some(
                    root.join("logs/qoder/history")
                        .to_string_lossy()
                        .into_owned(),
                ),
                poll_interval_ms: Some(60000),
                multimodal_enabled: false,
                upload_mode: None,
                allowed_root_paths: Vec::new(),
            },
            Arc::new(Readers),
        );
        let copy = Arc::clone(captured);
        input.bind_collector(
            move |batch| copy.lock().unwrap().extend_from_slice(batch),
            |_| {},
        );
        input
    }
    async fn restart(&mut self) {
        self.input.stop().await.unwrap();
        self.store = Arc::new(StateStore::new(self.root.join("input-state.json")));
        self.store.load().await;
        self.input = Self::build_input(&self.root, &self.store, &self.captured);
        self.input.start().await.unwrap();
    }
    fn write(&self, rows: &[Value], append: bool) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&self.file)
            .unwrap();
        for r in rows {
            writeln!(f, "{r}").unwrap();
        }
    }
    fn command(
        &self,
        session: &str,
        extra: &[(&str, &str)],
        retry: Option<usize>,
        identity: Option<Value>,
    ) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        command
            .env_clear()
            .current_dir(&self.root)
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("APPDATA", self.root.join("appdata"))
            .env("LOCALAPPDATA", self.root.join("localappdata"))
            .env("XDG_CONFIG_HOME", self.root.join("xdg/config"))
            .env("XDG_DATA_HOME", self.root.join("xdg/data"))
            .env("XDG_CACHE_HOME", self.root.join("xdg/cache"))
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.root)
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.root.join("config.json"),
            )
            .env("PATH", self.root.join("no-external-runtimes"))
            .args([
                "hook-process",
                "qoder",
                "--wakeup-only",
                "--agent-id",
                "qoder",
                "--log-prefix",
                "qoder",
            ]);
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "ComSpec",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        for (key, value) in extra {
            command.env(key, value);
        }
        let bytes = if let Some(end) = retry {
            command
                .args(["--retry", "--transcript"])
                .arg(&self.file)
                .args([
                    "--session",
                    session,
                    "--trigger-end-line",
                    &end.to_string(),
                    "--cwd",
                ])
                .arg(&self.root);
            serde_json::to_vec(&identity.unwrap_or(Value::Null)).unwrap()
        } else {
            serde_json::to_vec(&json!({"session_id":session,"transcript_path":self.file,"hook_event_name":"Stop","cwd":self.root})).unwrap()
        };
        let input = self
            .root
            .join(format!("stdin-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&input, bytes).unwrap();
        command
            .stdin(std::fs::File::open(input).unwrap())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    async fn collect(&self) -> Vec<Value> {
        self.collect_prompts(0).await
    }
    async fn collect_prompts(&self, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut records = Vec::new();
        loop {
            self.input.inner.run_cycle().await;
            records.extend(
                self.captured
                    .lock()
                    .unwrap()
                    .drain(..)
                    .map(|entry| serde_json::to_value(entry).unwrap()),
            );
            if !records.is_empty() && prompts(&records).len() >= count {
                return records;
            }
            assert!(
                Instant::now() < deadline,
                "actual Input did not collect the closed turn(s)"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    fn checkpoints(&self) -> Value {
        self.store.get("qoder-trace").extra().unwrap()["qoderTranscripts"].clone()
    }
}
fn invoke(mut command: Command) {
    let mut child =
        loongsuite_pilot::utils::candidate_process::CandidateChild::spawn(&mut command).unwrap();
    let stdout = child.take_stdout().unwrap();
    let stderr = child.take_stderr().unwrap();
    let out = std::thread::spawn(move || {
        let mut b = Vec::new();
        stdout.take(1024 * 1024 + 1).read_to_end(&mut b).unwrap();
        b
    });
    let err = std::thread::spawn(move || {
        let mut b = Vec::new();
        stderr.take(1024 * 1024 + 1).read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "native Hook exceeded original30s process budget"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    let output = out.join().unwrap();
    let error = err.join().unwrap();
    assert!(output.len() <= 1024 * 1024 && error.len() <= 1024 * 1024);
    assert!(status.success(), "{}", String::from_utf8_lossy(&error));
    assert_eq!(output, b"{}\n");
}
fn turn(index: usize, prompt: &str) -> Vec<Value> {
    let second = 10 + index * 2;
    vec![
        json!({"type":"user","uuid":format!("user-{index}"),"timestamp":format!("2026-07-20T10:00:{second:02}.000Z"),"sessionId":"session-old","entrypoint":"cli","message":{"role":"user","content":prompt}}),
        json!({"type":"assistant","uuid":format!("assistant-{index}"),"timestamp":format!("2026-07-20T10:00:{second:02}.500Z"),"sessionId":"session-old","message":{"role":"assistant","id":format!("message-{index}"),"content":[{"type":"text","text":format!("answer {index}")}],"stop_reason":"end_turn"}}),
    ]
}
fn last(index: usize) -> Value {
    json!({"type":"last-prompt","sessionId":"session-old","lastPrompt":format!("prompt {index}")})
}
fn progress(event: &str) -> Value {
    json!({"type":"progress","timestamp":"2026-08-05T04:00:20.000Z","data":{"hookEvent":event,"hookName":event}})
}
fn prompts(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter(|r| r["event.name"] == "other" && r["agent.qoder.raw_type"] == "user")
        .map(|r| {
            r["gen_ai.input.messages_delta"][0]["parts"][0]["content"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}
#[tokio::test]
async fn cold_l203_l225_actual_hook_transport_keeps_invocation_ids_and_safe_attributes() {
    for (session, prompt, attrs, invocation) in [
        (
            "session-old",
            "identity prompt",
            "gen_ai.session.id=env-session,gen_ai.user.id=env-user,gen_ai.agent.name=blocked",
            true,
        ),
        (
            "session-custom-attributes",
            "custom attribute prompt",
            "multica.issue.id=AGE-992,multica.user.id=staff-1,multica.api_token=blocked",
            false,
        ),
    ] {
        let f = Fixture::new();
        let mut rows = turn(1, prompt);
        rows.push(last(1));
        f.write(&rows, false);
        invoke(f.command(
            session,
            &[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES", attrs)],
            None,
            None,
        ));
        f.input.start().await.unwrap();
        let records = f.collect().await;
        f.input.stop().await.unwrap();
        assert!(!records.is_empty());
        for record in records {
            if invocation {
                assert_eq!(record["agent.pilot.invocation.session.id"], "env-session");
                assert_eq!(record["agent.pilot.invocation.user.id"], "env-user");
                assert_eq!(record["gen_ai.session.id"], "session-old");
                assert_ne!(record["gen_ai.agent.name"], "blocked");
            } else {
                assert_eq!(record["multica.issue.id"], "AGE-992");
                assert_eq!(record["multica.user.id"], "staff-1");
                assert!(record.get("multica.api_token").is_none());
            }
        }
    }
}
#[tokio::test]
async fn cold_l246_actual_native_input_bootstraps_each_old_session_and_resumes_with_durable_offsets(
) {
    let mut f = Fixture::new();
    let mut rows = turn(1, "historical prompt 1");
    rows.extend(turn(2, "historical prompt 2"));
    rows.push(last(2));
    f.write(&rows, false);
    invoke(f.command("session-old", &[], None, None));
    f.input.start().await.unwrap();
    let first = f.collect().await;
    assert_eq!(prompts(&first), ["historical prompt 2"]);
    assert!(first
        .iter()
        .all(|r| r["agent.transcript.cursor_mode"] == "bootstrap"
            && r["agent.transcript.cursor_reason"] == "missing-cursor"));
    assert_eq!(f.checkpoints().as_object().unwrap().len(), 1);
    assert!(f.root.join("input-state.json").is_file());
    f.restart().await;
    let mut next = turn(3, "new prompt 3");
    next.push(last(3));
    f.write(&next, true);
    invoke(f.command("session-old", &[], None, None));
    let next = f.collect().await;
    assert_eq!(prompts(&next), ["new prompt 3"]);
    assert!(next
        .iter()
        .all(|r| r["agent.transcript.cursor_mode"] == "incremental"));
    f.restart().await;
    f.file = f.root.join("second-old-transcript.jsonl");
    let mut rows = turn(4, "second session historical prompt 4");
    rows.extend(turn(5, "second session historical prompt 5"));
    rows.push(last(5));
    f.write(&rows, false);
    invoke(f.command("session-second-old", &[], None, None));
    let second = f.collect().await;
    assert_eq!(prompts(&second), ["second session historical prompt 5"]);
    assert!(second
        .iter()
        .all(|r| r["agent.transcript.cursor_mode"] == "bootstrap"
            && r["agent.transcript.cursor_reason"] == "missing-cursor"));
    assert_eq!(f.checkpoints().as_object().unwrap().len(), 2);
    assert!(second
        .iter()
        .all(|record| record["gen_ai.session.id"] == "session-second-old"));
    let mut persisted_ids = std::fs::read_dir(f.root.join("state/qoder-transcripts/qoder/sources"))
        .unwrap()
        .map(|entry| {
            let source: Value = serde_json::from_slice(
                &std::fs::read(entry.unwrap().path().join("source.json")).unwrap(),
            )
            .unwrap();
            source["sessionId"].as_str().unwrap().to_owned()
        })
        .collect::<Vec<_>>();
    persisted_ids.sort();
    assert_eq!(persisted_ids, ["session-old", "session-second-old"]);
    f.input.stop().await.unwrap();
}
#[tokio::test]
async fn cold_l373_actual_ide_stop_at_stable_eof_preserves_stop_time_account() {
    let f = Fixture::new();
    let rows = [
        json!({"type":"session_meta","sessionId":"ide-session","data":{"meta_type":"session_info","content":{"mode":"agent","session_type":"assistant"}}}),
        progress("SessionStart"),
        json!({"type":"user","uuid":"ide-user","timestamp":"2026-08-05T04:00:16.005147Z","sessionId":"ide-session","message":{"role":"user","content":"IDE prompt"}}),
        json!({"type":"assistant","uuid":"ide-thinking","timestamp":"2026-08-05T04:00:19.821317Z","sessionId":"ide-session","message":{"role":"assistant","content":[{"type":"thinking","thinking":"reasoning"}]}}),
        json!({"type":"assistant","uuid":"ide-text","timestamp":"2026-08-05T04:00:19.821627Z","sessionId":"ide-session","message":{"role":"assistant","content":[{"type":"text","text":"IDE answer"}]}}),
        progress("Stop"),
    ];
    f.write(&rows, false);
    invoke(f.command(
        "ide-session",
        &[],
        Some(rows.len() - 1),
        Some(json!({"name":"qoder-user","email":"qoder-user@example.com"})),
    ));
    f.input.start().await.unwrap();
    let records = f.collect().await;
    f.input.stop().await.unwrap();
    assert_eq!(prompts(&records), ["IDE prompt"]);
    assert!(records.iter().any(|r| r["event.name"] == "llm.response"));
    assert!(records
        .iter()
        .all(|r| r["user.name"] == "qoder-user" && r["user.email"] == "qoder-user@example.com"));
}
#[tokio::test]
async fn cold_l430_two_real_native_hook_processes_publish_one_stop_window_once() {
    let f = Fixture::new();
    let rows = [
        json!({"type":"session_meta","sessionId":"ide-session"}),
        progress("SessionStart"),
        json!({"type":"user","timestamp":"2026-08-05T04:00:16.000Z","sessionId":"ide-session","message":{"role":"user","content":"one prompt"}}),
        json!({"type":"assistant","timestamp":"2026-08-05T04:00:19.000Z","sessionId":"ide-session","message":{"role":"assistant","content":[{"type":"text","text":"one answer"}]}}),
        progress("Stop"),
    ];
    f.write(&rows, false);
    let a = f.command("ide-session", &[], Some(rows.len() - 1), None);
    let b = f.command("ide-session", &[], Some(rows.len() - 1), None);
    let a = std::thread::spawn(move || invoke(a));
    let b = std::thread::spawn(move || invoke(b));
    a.join().unwrap();
    b.join().unwrap();
    f.input.start().await.unwrap();
    let records = f.collect().await;
    f.input.inner.run_cycle().await;
    f.input.stop().await.unwrap();
    assert_eq!(prompts(&records), ["one prompt"]);
    assert_eq!(
        records
            .iter()
            .filter(|r| r["event.name"] == "llm.response")
            .count(),
        1
    );
    assert!(f.captured.lock().unwrap().is_empty());
}
#[tokio::test]
async fn cold_l465_two_real_adjacent_stop_publishers_collect_both_turns_exactly_once() {
    let f = Fixture::new();
    let rows = [
        json!({"type":"session_meta","sessionId":"ide-session"}),
        progress("UserPromptSubmit"),
        json!({"type":"user","timestamp":"2026-08-05T04:00:16.000Z","sessionId":"ide-session","message":{"role":"user","content":"first prompt"}}),
        json!({"type":"assistant","timestamp":"2026-08-05T04:00:19.000Z","sessionId":"ide-session","message":{"role":"assistant","content":[{"type":"text","text":"first answer"}]}}),
        progress("Stop"),
        progress("UserPromptSubmit"),
        json!({"type":"user","timestamp":"2026-08-05T04:00:21.000Z","sessionId":"ide-session","message":{"role":"user","content":"second prompt"}}),
        json!({"type":"assistant","timestamp":"2026-08-05T04:00:24.000Z","sessionId":"ide-session","message":{"role":"assistant","content":[{"type":"text","text":"second answer"}]}}),
        progress("Stop"),
    ];
    f.write(&rows, false);
    let a = f.command("ide-session", &[], Some(4), None);
    let b = f.command("ide-session", &[], Some(8), None);
    let a = std::thread::spawn(move || invoke(a));
    let b = std::thread::spawn(move || invoke(b));
    a.join().unwrap();
    b.join().unwrap();
    f.input.start().await.unwrap();
    let records = f.collect_prompts(2).await;
    f.input.inner.run_cycle().await;
    f.input.stop().await.unwrap();
    assert_eq!(prompts(&records), ["first prompt", "second prompt"]);
    assert_eq!(
        records
            .iter()
            .filter(|r| r["event.name"] == "llm.response")
            .count(),
        2
    );
    assert!(f.captured.lock().unwrap().is_empty());
    let state = f.checkpoints();
    assert!(state
        .as_object()
        .unwrap()
        .values()
        .any(|c| c["committedOffset"] == std::fs::metadata(&f.file).unwrap().len()));
}

#[tokio::test]
async fn cold_l311_real_anchored_retry_keeps_queued_prompt_unread_until_its_stop() {
    let f = Fixture::new();
    let boundary = |event: &str| json!({"type":"progress","timestamp":"2026-07-31T04:33:41.000Z","data":{"hookEvent":event,"hookName":event}});
    let mut target = vec![boundary("UserPromptSubmit")];
    target.extend(turn(2, "target prompt"));
    let trigger = 2 + target.len();
    let mut initial = turn(1, "historical prompt");
    initial.extend(target);
    initial.extend([
        boundary("Stop"), boundary("Stop"),
        json!({"type":"session_meta","sessionId":"session-old"}),
        boundary("UserPromptSubmit"),
        json!({"type":"user","uuid":"queued-user","timestamp":"2026-07-31T04:33:46.000Z","sessionId":"session-old","message":{"role":"user","content":"queued prompt"}}),
    ]);
    f.write(&initial, false);
    invoke(f.command("session-old", &[], Some(trigger), None));
    f.input.start().await.unwrap();
    let first = f.collect().await;
    assert_eq!(prompts(&first), ["target prompt"]);
    let committed_bytes: usize = initial[..initial.len() - 1]
        .iter()
        .map(|row| serde_json::to_vec(row).unwrap().len() + 1)
        .sum();
    let cursors = f.checkpoints();
    let cursor = cursors.as_object().unwrap().values().next().unwrap();
    assert_eq!(cursor["committedOffset"], committed_bytes);
    assert_eq!(cursor["activeStart"], committed_bytes);
    let second = [
        json!({"type":"assistant","uuid":"queued-assistant","timestamp":"2026-07-31T04:33:49.000Z","sessionId":"session-old","message":{"role":"assistant","content":[{"type":"text","text":"queued answer"}],"stop_reason":"end_turn"}}),
        boundary("Stop"),
    ];
    f.write(&second, true);
    invoke(f.command("session-old", &[], Some(initial.len() + 1), None));
    let mut all = first;
    all.extend(f.collect().await);
    assert_eq!(prompts(&all), ["target prompt", "queued prompt"]);
    f.input.stop().await.unwrap();
}

#[tokio::test]
async fn cold_l521_real_native_input_keeps_repeated_post_tool_use_in_distinct_tool_cycles() {
    use loongsuite_pilot::normalization::VALID_FINISH_REASONS;
    let f = Fixture::new();
    let progress = |event: &str, second: &str, name: &str| json!({"type":"progress","timestamp":format!("2026-07-30T11:48:{second}"),"data":{"hookEvent":event,"hookName":name}});
    let assistant = |second: &str, content: Value| json!({"type":"assistant","timestamp":format!("2026-07-30T11:48:{second}"),"message":{"role":"assistant","content":content}});
    let result = |second: &str, id: &str| json!({"type":"user","timestamp":format!("2026-07-30T11:48:{second}"),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":format!("result-{id}")}]}});
    let rows = [
        progress("UserPromptSubmit", "01.000Z", "UserPromptSubmit"),
        json!({"type":"user","timestamp":"2026-07-30T11:48:01.001Z","message":{"role":"user","content":"run dependent tools"}}),
        assistant(
            "04.000Z",
            json!([{"type":"thinking","thinking":"step one"}]),
        ),
        assistant(
            "04.001Z",
            json!([{"type":"tool_use","id":"read-1","name":"Read","input":{}}]),
        ),
        result("04.002Z", "read-1"),
        progress("PostToolUse", "04.100Z", "PostToolUse:Read"),
        progress("PostToolUse", "04.101Z", "PostToolUse:Read"),
        assistant(
            "13.000Z",
            json!([{"type":"thinking","thinking":"step two"}]),
        ),
        assistant(
            "13.001Z",
            json!([{"type":"tool_use","id":"grep-1","name":"Grep","input":{}}]),
        ),
        result("13.002Z", "grep-1"),
        progress("PostToolUse", "13.100Z", "PostToolUse:Grep"),
        progress("PostToolUse", "13.101Z", "PostToolUse:Grep"),
        assistant("49.000Z", json!([{"type":"thinking","thinking":"final"}])),
        assistant("49.001Z", json!([{"type":"text","text":"done"}])),
        progress("Stop", "50.000Z", "Stop"),
        last(1),
    ];
    f.write(&rows, false);
    invoke(f.command("session-old", &[], None, None));
    f.input.start().await.unwrap();
    let records = f.collect().await;
    f.input.stop().await.unwrap();
    let responses = records
        .iter()
        .filter(|r| r["event.name"] == "llm.response")
        .collect::<Vec<_>>();
    assert_eq!(
        responses
            .iter()
            .map(|r| r["gen_ai.step.id"]
                .as_str()
                .unwrap()
                .rsplit(':')
                .next()
                .unwrap())
            .collect::<Vec<_>>(),
        ["s1", "s2", "s3"]
    );
    assert_eq!(
        responses
            .iter()
            .map(|r| r["gen_ai.response.finish_reasons"].clone())
            .collect::<Vec<_>>(),
        [
            json!(["tool_call"]),
            json!(["tool_call"]),
            json!(["end_turn"])
        ]
    );
    for response in responses {
        for reason in response["gen_ai.response.finish_reasons"]
            .as_array()
            .unwrap()
        {
            assert!(VALID_FINISH_REASONS.contains(&reason.as_str().unwrap()));
        }
        for message in response["gen_ai.output.messages"].as_array().unwrap() {
            assert!(VALID_FINISH_REASONS.contains(&message["finish_reason"].as_str().unwrap()));
        }
    }
}
