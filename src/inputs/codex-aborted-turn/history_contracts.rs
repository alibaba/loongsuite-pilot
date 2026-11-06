use super::*;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/inputs/codex-aborted-turn/fixtures/aborted-turn.jsonl"
));
const INTERLEAVED: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/inputs/codex-aborted-turn/fixtures/interleaved-web-search.jsonl"
));
const MULTI_WAVE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/unit/inputs/codex-aborted-turn/fixtures/multi-wave-aborted-turn.jsonl"
));

struct Fixture {
    root: Arc<tempfile::TempDir>,
    store: Arc<StateStore>,
    input: CodexAbortedTurnInput,
    entries: Arc<Mutex<Vec<AgentActivityEntry>>>,
}
impl Fixture {
    async fn new(grace: f64) -> Self {
        let root = Arc::new(
            tempfile::tempdir_in(
                std::fs::canonicalize(std::env::temp_dir()).expect("canonical synthetic temp base"),
            )
            .expect("synthetic root"),
        );
        Self::with_root(root, grace).await
    }
    async fn with_root(root: Arc<tempfile::TempDir>, grace: f64) -> Self {
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        store.load().await;
        let input = CodexAbortedTurnInput::new(CodexAbortedTurnInputOptions {
            state_store: Arc::clone(&store),
            session_dir: Some(root.path().join("sessions").to_string_lossy().into_owned()),
            hook_state_dir: Some(
                root.path()
                    .join("hook-state")
                    .to_string_lossy()
                    .into_owned(),
            ),
            diagnostic_dir: Some(
                root.path()
                    .join("diagnostics")
                    .to_string_lossy()
                    .into_owned(),
            ),
            hook_gap_grace_ms: Some(grace),
            poll_interval_ms: Some(10),
        });
        let entries = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&entries);
        input.on_entries(move |batch| slot.lock().expect("capture").extend_from_slice(batch));
        Self {
            root,
            store,
            input,
            entries,
        }
    }
    async fn start(&self) {
        self.input.start().await.expect("real start");
    }
    async fn stop(&self) {
        tokio::time::timeout(Duration::from_secs(2), self.input.stop())
            .await
            .expect("bounded stop")
            .expect("real stop");
    }
    async fn write(&self, name: &str, contents: &str) -> String {
        let bucket = self
            .root
            .path()
            .join("sessions")
            .join("2026")
            .join("06")
            .join("22");
        tokio::fs::create_dir_all(&bucket)
            .await
            .expect("dated bucket");
        let path = bucket.join(name);
        tokio::fs::write(&path, contents)
            .await
            .expect("native synthetic transcript");
        path.to_string_lossy().into_owned()
    }
    async fn append(&self, path: &str, contents: &str) {
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .await
            .expect("open append");
        file.write_all(contents.as_bytes())
            .await
            .expect("actual appended bytes");
        file.flush().await.expect("flush visibility");
    }
    fn records(&self) -> Vec<Value> {
        self.entries
            .lock()
            .expect("capture")
            .iter()
            .map(|entry| serde_json::to_value(entry).expect("actual output JSON"))
            .collect()
    }
    async fn wait(&self, stage: &str, mut ready: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !ready() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("actual poll did not reach {stage}"));
    }
    async fn offset(&self, path: &str, len: usize) {
        self.wait("exact source offset", || {
            self.store.get_offset(&state_key(path)) == len as f64
        })
        .await;
    }
    async fn cancelled(&self) {
        self.wait("cancelled native response", || {
            self.records().iter().any(is_cancelled)
        })
        .await;
    }
    fn diagnostics(&self, prefix: &str) -> Vec<Value> {
        let Ok(files) = std::fs::read_dir(self.root.path().join("diagnostics")) else {
            return Vec::new();
        };
        files
            .filter_map(Result::ok)
            .filter(|file| file.file_name().to_string_lossy().starts_with(prefix))
            .flat_map(|file| {
                std::fs::read_to_string(file.path())
                    .expect("diagnostic")
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).expect("diagnostic JSONL"))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
}
fn is_cancelled(entry: &Value) -> bool {
    entry["gen_ai.response.finish_reasons"]
        .as_array()
        .is_some_and(|reasons| reasons.iter().any(|reason| reason == "cancelled"))
}
fn events(records: &[Value], kind: &str) -> Vec<Value> {
    records
        .iter()
        .filter(|entry| entry["event.name"] == kind)
        .cloned()
        .collect()
}
fn record(time: &str, kind: &str, payload: Value) -> String {
    json!({"timestamp":time,"type":kind,"payload":payload}).to_string()
}
fn normal_transcript(sid: &str, turn: &str) -> String {
    [
        record(
            "2026-06-23T04:00:00.000Z",
            "session_meta",
            json!({"id":sid,"model_provider":"openai"}),
        ),
        record(
            "2026-06-23T04:00:01.000Z",
            "event_msg",
            json!({"type":"task_started","turn_id":turn}),
        ),
        record(
            "2026-06-23T04:00:01.010Z",
            "turn_context",
            json!({"turn_id":turn,"model":"gpt-5.4-mini"}),
        ),
        record(
            "2026-06-23T04:00:02.000Z",
            "event_msg",
            json!({"type":"agent_message","message":"The task is complete."}),
        ),
        record(
            "2026-06-23T04:00:03.000Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":turn}),
        ),
    ]
    .join("\n")
        + "\n"
}
#[tokio::test]
async fn l57_same_turn_task_started_keeps_the_preceding_turn_context_fields() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let mut lines = FIXTURE.trim_end().lines().collect::<Vec<_>>();
    lines.swap(1, 2);
    f.write("rollout-context-first.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.cancelled().await;
    f.stop().await;
    let final_response = f
        .records()
        .into_iter()
        .find(is_cancelled)
        .expect("cancelled response");
    assert_eq!(final_response["gen_ai.response.model"], "gpt-5.4-mini");
    assert_eq!(final_response["agent.codex.cwd"], "/tmp/project");
    assert_eq!(final_response["agent.codex.turn_status"], "interrupted");
    assert_eq!(
        final_response["gen_ai.response.finish_reasons"],
        json!(["cancelled"])
    );
    assert_eq!(final_response["gen_ai.turn.end"], true);
}
#[tokio::test]
async fn l85_malformed_abort_writes_exact_recovery_failure_diagnostic_instead_of_silent_loss() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let malformed = FIXTURE.replace(
        "\"timestamp\":\"2026-06-22T08:57:54.000Z\"",
        "\"timestamp\":\"not-a-timestamp\"",
    );
    let path = f.write("rollout-malformed-abort.jsonl", &malformed).await;
    f.wait("recovery failure diagnostic", || {
        !f.diagnostics("codex-aborted-turn-recovery-failed-")
            .is_empty()
    })
    .await;
    f.offset(&path, malformed.len()).await;
    f.stop().await;
    assert!(f.records().is_empty());
    let rows = f.diagnostics("codex-aborted-turn-recovery-failed-");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["type"], "codex_aborted_turn_recovery_failed");
    assert_eq!(rows[0]["transcript_turn_id"], "turn-aborted");
    assert_eq!(rows[0]["reason"], "missing_or_invalid_abort_timestamp");
}
#[tokio::test]
async fn l152_completed_web_search_and_cancelled_followup_keep_exact_messages_in_separate_steps() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    f.write("rollout-interleaved.jsonl", INTERLEAVED).await;
    f.cancelled().await;
    f.stop().await;
    let responses = events(&f.records(), "llm.response");
    let first = responses
        .iter()
        .find(|entry| {
            entry["gen_ai.step.id"]
                .as_str()
                .expect("step")
                .ends_with(":s1")
        })
        .expect("first");
    assert_eq!(
        first["gen_ai.output.messages"],
        json!([{"role":"assistant","parts":[
        {"type":"reasoning","content":"I will research the problem first."},
        {"type":"tool_call","id":"web-search-1","name":"web_search","arguments":{"type":"search","query":"problem"}}
    ],"finish_reason":"tool_call"}])
    );
    let final_response = responses
        .iter()
        .find(|entry| is_cancelled(entry))
        .expect("cancelled");
    assert!(final_response["gen_ai.step.id"]
        .as_str()
        .expect("step")
        .ends_with(":s2"));
    assert_eq!(
        final_response["gen_ai.output.messages"],
        json!([{"role":"assistant","parts":[
        {"type":"reasoning","content":"The search confirms the problem name."}],"finish_reason":"cancelled"}])
    );
}
#[tokio::test]
async fn l189_each_completed_tool_wave_and_the_cancelled_tail_have_exact_distinct_steps() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    f.write("rollout-multi-wave.jsonl", MULTI_WAVE).await;
    f.cancelled().await;
    f.stop().await;
    let actual=events(&f.records(),"llm.response").iter().map(|entry|{
        let step=entry["gen_ai.step.id"].as_str().expect("step");
        json!({"step":&step[step.len()-2..],"finish":entry["gen_ai.response.finish_reasons"],"messages":entry["gen_ai.output.messages"]})
    }).collect::<Vec<_>>();
    assert_eq!(actual,json!([
        {"step":"s1","finish":["tool_call"],"messages":[{"role":"assistant","parts":[{"type":"reasoning","content":"I will inspect the files first."},{"type":"tool_call","id":"call-first","name":"exec_command","arguments":{"cmd":"pwd"}}],"finish_reason":"tool_call"}]},
        {"step":"s2","finish":["tool_call"],"messages":[{"role":"assistant","parts":[{"type":"reasoning","content":"Now I will inspect the project files."},{"type":"tool_call","id":"call-second","name":"exec_command","arguments":{"cmd":"ls"}}],"finish_reason":"tool_call"}]},
        {"step":"s3","finish":["cancelled"],"messages":[{"role":"assistant","parts":[{"type":"reasoning","content":"I found the project structure."}],"finish_reason":"cancelled"}]}
    ]).as_array().expect("expected").clone());
}
#[tokio::test]
async fn l243_normally_completed_transcript_advances_checkpoint_without_recovery_entries() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let text = normal_transcript("session-normal", "turn-normal");
    let path = f.write("rollout-normal.jsonl", &text).await;
    f.offset(&path, text.len()).await;
    f.stop().await;
    assert!(f.records().is_empty());
}
#[tokio::test]
async fn l263_missing_hook_state_writes_one_exact_gap_diagnostic_without_recovery_entries() {
    let f = Fixture::new(0.0).await;
    f.start().await;
    let text = normal_transcript("session-hook-gap", "turn-hook-gap");
    let path = f.write("rollout-hook-gap.jsonl", &text).await;
    f.wait("hook gap diagnostic", || {
        !f.diagnostics("codex-hook-gap-").is_empty()
    })
    .await;
    f.offset(&path, text.len()).await;
    f.stop().await;
    assert!(f.records().is_empty());
    let rows = f.diagnostics("codex-hook-gap-");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["type"], "codex_hook_missing");
    assert_eq!(rows[0]["session_id"], "session-hook-gap");
    assert_eq!(rows[0]["transcript_turn_id"], "turn-hook-gap");
    // The persisted ledger must suppress the same notification after restart.
    f.store.save().await.expect("durable state");
    let restarted = Fixture::with_root(Arc::clone(&f.root), 0.0).await;
    restarted.start().await;
    restarted.stop().await;
    assert_eq!(restarted.diagnostics("codex-hook-gap-").len(), 1);
}
#[tokio::test]
async fn l308_actual_codex_hook_and_recovery_inputs_share_a_store_without_interference() {
    use crate::inputs::codex_log::CodexLogInput;
    use crate::inputs::rest_support::HookInputOptions;

    let f = Fixture::new(0.0).await;
    tokio::fs::create_dir_all(f.root.path().join("hook-state"))
        .await
        .expect("hook state");
    tokio::fs::write(
        f.root
            .path()
            .join("hook-state")
            .join("session-normal-shared.json"),
        "{}",
    )
    .await
    .expect("actual hook witness");
    let hook_logs = f.root.path().join("hook-logs");
    tokio::fs::create_dir_all(&hook_logs)
        .await
        .expect("hook logs");
    let normal = CodexLogInput::new(HookInputOptions {
        state_store: Arc::clone(&f.store),
        log_dir: Some(hook_logs.to_string_lossy().into_owned()),
        log_prefix: None,
        poll_interval_ms: Some(10),
    });
    let normal_entries = Arc::new(Mutex::new(Vec::new()));
    let slot = Arc::clone(&normal_entries);
    normal.on_entries(move |entries| {
        slot.lock()
            .expect("hook capture")
            .extend_from_slice(entries)
    });
    f.start().await;
    normal.start().await;
    let text = normal_transcript("session-normal-shared", "turn-normal-shared");
    let path = f.write("rollout-normal-shared.jsonl", &text).await;
    let hook=json!({"time_unix_nano":"1782190800000000000","event.id":"normal-hook-event","event.name":"other",
        "gen_ai.session.id":"session-normal-shared","gen_ai.turn.id":"session-normal-shared:t1","gen_ai.agent.type":"codex","gen_ai.provider.name":"openai"}).to_string()+"\n";
    let today = crate::utils::fs_utils::get_today_date_string();
    tokio::fs::write(hook_logs.join(format!("codex-{today}.jsonl")), hook)
        .await
        .expect("real hook JSONL");
    f.wait("actual hook event", || {
        normal_entries.lock().expect("hook capture").len() == 1
    })
    .await;
    f.offset(&path, text.len()).await;
    f.stop().await;
    normal.stop().await;
    let output = normal_entries.lock().expect("hook capture");
    assert_eq!(output.len(), 1);
    assert_eq!(
        serde_json::to_value(&output[0]).expect("hook JSON")["event.id"],
        "normal-hook-event"
    );
    assert!(f.records().is_empty());
    assert!(f.store.get_offset("codex-log") > 0.0);
    assert!(!f.root.path().join("diagnostics").exists());
}
#[tokio::test]
async fn l362_cancelled_turn_preserves_completed_and_pending_tool_fields_without_fabricated_final_usage(
) {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    f.write("rollout-tools.jsonl", FIXTURE).await;
    f.cancelled().await;
    f.stop().await;
    let records = f.records();
    let final_response = records
        .iter()
        .find(|entry| entry["event.name"] == "llm.response" && is_cancelled(entry))
        .expect("cancelled response");
    assert_eq!(final_response["gen_ai.agent.type"], "codex");
    assert_eq!(
        final_response["gen_ai.response.finish_reasons"],
        json!(["cancelled"])
    );
    assert_eq!(final_response["agent.codex.turn_status"], "interrupted");
    for field in [
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "error.type",
        "gen_ai.output.messages",
    ] {
        assert!(final_response.get(field).is_none(), "fabricated {field}");
    }
    let first = records
        .iter()
        .find(|entry| {
            entry["event.name"] == "llm.response"
                && entry["gen_ai.step.id"]
                    .as_str()
                    .is_some_and(|step| step.ends_with(":s1"))
        })
        .expect("first wave");
    assert_eq!(
        first["gen_ai.output.messages"],
        json!([{"role":"assistant","parts":[
        {"type":"reasoning","content":"I will inspect the project first."},
        {"type":"tool_call","id":"call-bash","name":"exec_command","arguments":{"command":"pwd","workdir":"/tmp/project"}}
    ],"finish_reason":"tool_call"}])
    );
    let second = records
        .iter()
        .find(|entry| {
            entry["event.name"] == "llm.response"
                && entry["gen_ai.step.id"]
                    .as_str()
                    .is_some_and(|step| step.ends_with(":s2"))
        })
        .expect("second wave");
    assert_eq!(second["gen_ai.usage.input_tokens"], 120);
    assert_eq!(second["gen_ai.usage.output_tokens"], 12);
    assert_eq!(second["gen_ai.usage.total_tokens"], 132);
    let completed = records
        .iter()
        .find(|entry| {
            entry["event.name"] == "tool.result" && entry["gen_ai.tool.call.id"] == "call-bash"
        })
        .expect("completed tool");
    assert_eq!(completed["tool.result.status"], "success");
    assert_eq!(
        completed["gen_ai.tool.call.result"],
        json!({"stdout":"/tmp/project"})
    );
    assert_eq!(
        completed["gen_ai.tool.call.duration"].as_f64(),
        Some(1000.0)
    );
    let pending = records
        .iter()
        .find(|entry| {
            entry["event.name"] == "tool.result" && entry["gen_ai.tool.call.id"] == "call-pending"
        })
        .expect("pending tool");
    assert_eq!(pending["tool.result.status"], "cancelled");
    assert!(pending.get("gen_ai.tool.call.result").is_none());
    assert!(pending.get("gen_ai.tool.call.duration").is_none());
}
#[tokio::test]
async fn l439_completed_tool_with_matching_timestamps_keeps_zero_duration() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let text = FIXTURE.replace(
        "\"timestamp\":\"2026-06-22T08:57:51.000Z\"",
        "\"timestamp\":\"2026-06-22T08:57:50.000Z\"",
    );
    f.write("rollout-zero-duration.jsonl", &text).await;
    f.cancelled().await;
    f.stop().await;
    let result = f
        .records()
        .into_iter()
        .find(|entry| {
            entry["event.name"] == "tool.result" && entry["gen_ai.tool.call.id"] == "call-bash"
        })
        .expect("tool");
    assert_eq!(result["gen_ai.tool.call.duration"].as_f64(), Some(0.0));
}
#[tokio::test]
async fn l461_actual_start_baselines_preexisting_aborted_history_without_exporting_it() {
    let f = Fixture::new(60_000.0).await;
    let path = f.write("rollout-baseline.jsonl", FIXTURE).await;
    f.start().await;
    f.offset(&path, FIXTURE.len()).await;
    f.stop().await;
    assert!(f.records().is_empty());
    let checkpoint = read_checkpoint(&f.input.inner.runtime, &state_key(&path)).expect("baseline");
    assert!(checkpoint.active_turn.is_none());
    assert!(checkpoint.emitted_aborted_turn_ids.is_empty());
}
#[tokio::test]
async fn l476_incomplete_abort_is_not_consumed_until_newline_then_is_emitted_once() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let text = FIXTURE.trim_end();
    let path = f.write("rollout-partial.jsonl", text).await;
    let prefix_end = text.rfind('\n').expect("last complete boundary") + 1;
    f.offset(&path, prefix_end).await;
    assert!(f.records().is_empty());
    assert_eq!(
        read_checkpoint(&f.input.inner.runtime, &state_key(&path))
            .expect("pending")
            .active_turn
            .expect("active")
            .turn_id,
        "turn-aborted"
    );
    f.append(&path, "\n").await;
    f.cancelled().await;
    f.offset(&path, text.len() + 1).await;
    f.stop().await;
    assert_eq!(
        f.records()
            .iter()
            .filter(|entry| is_cancelled(entry))
            .count(),
        1
    );
}
#[tokio::test]
async fn l494_cancel_without_tool_calls_retains_the_actual_agent_reasoning_message() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let text = FIXTURE
        .lines()
        .filter(|line| {
            let value: Value = serde_json::from_str(line).expect("fixture");
            value["type"] != "response_item" || value["payload"]["type"] == "message"
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    f.write("rollout-without-tools.jsonl", &text).await;
    f.cancelled().await;
    f.stop().await;
    let final_response = f
        .records()
        .into_iter()
        .find(is_cancelled)
        .expect("cancelled");
    assert_eq!(
        final_response["gen_ai.output.messages"],
        json!([{"role":"assistant","parts":[{"type":"reasoning","content":"I will inspect the project first."}],"finish_reason":"cancelled"}])
    );
}
#[tokio::test]
async fn l521_all_user_transcript_messages_merge_in_native_order_into_the_recovered_prompt() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let environment = record(
        "2026-06-22T08:57:48.025Z",
        "response_item",
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd=/tmp/project</environment_context>"}]}),
    );
    let mut lines = FIXTURE.lines().map(str::to_owned).collect::<Vec<_>>();
    lines.insert(3, environment);
    f.write("rollout-merged-prompt.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.cancelled().await;
    f.stop().await;
    let prompt = f
        .records()
        .into_iter()
        .find(|entry| entry["event.name"] == "other")
        .expect("prompt");
    assert_eq!(
        prompt["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"<environment_context>cwd=/tmp/project</environment_context>\n\nsolve the task"}]}])
    );
}
#[tokio::test]
async fn l553_actual_stop_and_new_store_start_resume_a_pending_post_baseline_turn() {
    let first = Fixture::new(60_000.0).await;
    first.start().await;
    let mut lines = FIXTURE.trim_end().lines().collect::<Vec<_>>();
    let abort = lines.pop().expect("terminal").to_owned();
    let prefix = lines.join("\n") + "\n";
    let path = first.write("rollout-restart.jsonl", &prefix).await;
    first.offset(&path, prefix.len()).await;
    first.stop().await;
    assert!(first.records().is_empty());
    first.store.save().await.expect("durable save");
    let checkpoint =
        read_checkpoint(&first.input.inner.runtime, &state_key(&path)).expect("active checkpoint");
    assert_eq!(
        checkpoint.active_turn.as_ref().expect("active").turn_id,
        "turn-aborted"
    );
    let second = Fixture::with_root(Arc::clone(&first.root), 60_000.0).await;
    assert_eq!(
        read_checkpoint(&second.input.inner.runtime, &state_key(&path)),
        Some(checkpoint)
    );
    second.start().await;
    second.append(&path, &(abort + "\n")).await;
    second.cancelled().await;
    second.stop().await;
    assert_eq!(
        second
            .records()
            .iter()
            .filter(|entry| is_cancelled(entry))
            .count(),
        1
    );
    second.store.save().await.expect("durable completed state");
    let third = Fixture::with_root(Arc::clone(&first.root), 60_000.0).await;
    third.start().await;
    third.stop().await;
    assert!(
        third.records().is_empty(),
        "restart repeated acknowledged recovery input"
    );
}
#[tokio::test]
async fn l578_latest_preceding_session_meta_supplies_updated_system_instructions() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let updated = record(
        "2026-06-22T08:57:47.000Z",
        "session_meta",
        json!({"id":"session-aborted","model_provider":"openai","base_instructions":{"text":"Updated system instructions"}}),
    );
    let mut lines = FIXTURE.lines().map(str::to_owned).collect::<Vec<_>>();
    lines.insert(1, updated);
    f.write("rollout-updated-meta.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.cancelled().await;
    f.stop().await;
    let final_response = f
        .records()
        .into_iter()
        .find(is_cancelled)
        .expect("cancelled");
    assert!(final_response["gen_ai.system_instructions"]
        .as_array()
        .expect("instructions")
        .contains(&json!({"type":"text","content":"Updated system instructions"})));
}
#[tokio::test]
async fn l611_actual_101_turn_poll_keeps_only_the_latest_100_persisted_recovery_ids() {
    let f = Fixture::new(60_000.0).await;
    f.start().await;
    let mut records = vec![record(
        "2026-06-22T09:00:00.000Z",
        "session_meta",
        json!({"id":"ledger-session","model_provider":"openai"}),
    )];
    for index in 1..=101 {
        let turn = format!("turn-{index}");
        records.extend([
            record(
                &format!("2026-06-22T09:00:{:02}.000Z", index % 60),
                "event_msg",
                json!({"type":"task_started","turn_id":turn}),
            ),
            record(
                &format!("2026-06-22T09:01:{:02}.000Z", index % 60),
                "turn_context",
                json!({"turn_id":turn,"model":"gpt-5.4-mini"}),
            ),
            record(
                &format!("2026-06-22T09:02:{:02}.000Z", index % 60),
                "event_msg",
                json!({"type":"turn_aborted","turn_id":turn,"reason":"interrupted"}),
            ),
        ]);
    }
    let text = records.join("\n") + "\n";
    let path = f.write("rollout-ledger.jsonl", &text).await;
    f.wait("all101 cancelled turns", || {
        f.records()
            .iter()
            .filter(|entry| is_cancelled(entry))
            .count()
            == 101
    })
    .await;
    f.offset(&path, text.len()).await;
    f.stop().await;
    let checkpoint =
        read_checkpoint(&f.input.inner.runtime, &state_key(&path)).expect("actual ledger");
    assert_eq!(checkpoint.emitted_aborted_turn_ids.len(), 100);
    assert!(checkpoint
        .emitted_aborted_turn_ids
        .iter()
        .any(|id| id == "turn-101"));
    assert!(!checkpoint
        .emitted_aborted_turn_ids
        .iter()
        .any(|id| id == "turn-1"));
    f.store.save().await.expect("durable ledger");
    let loaded = Arc::new(StateStore::new(f.root.path().join("state.json")));
    loaded.load().await;
    assert_eq!(
        loaded.get(&state_key(&path)).extra(),
        f.store.get(&state_key(&path)).extra()
    );
}

thread_local! {
    // Mirrors the legacy Buffer.alloc spy without a process-wide allocator or
    // cross-test global state. Values are the production buffers after allocation.
    static READ_ALLOCATIONS: std::cell::RefCell<Option<Arc<Mutex<Vec<usize>>>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn record_read_allocation(size: usize) {
    READ_ALLOCATIONS.with(|slot| {
        if let Some(output) = slot.borrow().as_ref() {
            output.lock().expect("allocation observations").push(size);
        }
    });
}
struct AllocationCapture(Arc<Mutex<Vec<usize>>>);
impl AllocationCapture {
    fn start() -> Self {
        let sizes = Arc::new(Mutex::new(Vec::new()));
        READ_ALLOCATIONS.with(|slot| {
            assert!(slot.borrow().is_none(), "nested allocator observation");
            *slot.borrow_mut() = Some(Arc::clone(&sizes));
        });
        Self(sizes)
    }
    fn sizes(&self) -> Vec<usize> {
        self.0.lock().expect("actual allocations").clone()
    }
}
impl Drop for AllocationCapture {
    fn drop(&mut self) {
        READ_ALLOCATIONS.with(|slot| *slot.borrow_mut() = None);
    }
}
#[tokio::test]
async fn l118_late_abort_recovers_preceding_meta_without_allocating_the_full_historical_tail() {
    let f = Fixture::new(60_000.0).await;
    let history = [
        record(
            "2026-06-23T06:00:00.000Z",
            "session_meta",
            json!({"id":"session-large","model_provider":"openai"}),
        ),
        record(
            "2026-06-23T06:00:00.001Z",
            "event_msg",
            json!({"type":"ignored","message":"x".repeat(128*1024)}),
        ),
    ]
    .join("\n")
        + "\n";
    let path = f.write("rollout-large-history.jsonl", &history).await;
    f.start().await;
    f.offset(&path, history.len()).await;
    let capture = AllocationCapture::start();
    let tail = [
        record(
            "2026-06-23T06:00:01.000Z",
            "turn_context",
            json!({"turn_id":"turn-large","model":"gpt-5.4-mini"}),
        ),
        record(
            "2026-06-23T06:00:01.010Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"turn-large"}),
        ),
        record(
            "2026-06-23T06:00:02.000Z",
            "event_msg",
            json!({"type":"turn_aborted","turn_id":"turn-large","reason":"interrupted"}),
        ),
    ]
    .join("\n")
        + "\n";
    f.append(&path, &tail).await;
    f.cancelled().await;
    f.stop().await;
    let sizes = capture.sizes();
    drop(capture);
    assert!(
        !sizes.is_empty(),
        "actual late recovery performed no observed reads"
    );
    assert!(
        sizes.iter().all(|size| *size <= 64 * 1024),
        "allocated full transcript tail: {sizes:?}"
    );
    let response = f
        .records()
        .into_iter()
        .find(is_cancelled)
        .expect("actual cancellation");
    assert_eq!(response["gen_ai.session.id"], "session-large");
    assert_eq!(response["gen_ai.provider.name"], "openai");
    assert_eq!(response["gen_ai.response.model"], "gpt-5.4-mini");
}
