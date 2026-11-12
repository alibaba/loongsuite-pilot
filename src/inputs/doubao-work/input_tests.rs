use super::*;
use chrono::{Datelike, TimeZone};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
struct Fixture {
    root: tempfile::TempDir,
    logs: String,
    file: PathBuf,
    store: Arc<StateStore>,
    input: DoubaoWorkInput,
    epoch: i64,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        tokio::fs::create_dir(&logs).await.unwrap();
        let epoch = now_ms() + 1000;
        let date = chrono::Local.timestamp_millis_opt(epoch).single().unwrap();
        let file = logs.join(format!(
            "saman_frontend_{}.{:02}{:02}.0.log",
            date.year(),
            date.month(),
            date.day()
        ));
        tokio::fs::write(&file, "").await.unwrap();
        let store = Arc::new(StateStore::new(root.path().join("state.json")));
        let logs = logs.to_string_lossy().into_owned();
        let input = Self::make(&root, &logs, store.clone(), None);
        let f = Self {
            root,
            logs,
            file,
            store,
            input,
            epoch,
        };
        assert!(f.poll().await.is_empty());
        f
    }
    fn make(
        root: &tempfile::TempDir,
        logs: &str,
        store: Arc<StateStore>,
        budget: Option<DoubaoWorkBudgetOptions>,
    ) -> DoubaoWorkInput {
        DoubaoWorkInput::new(DoubaoWorkInputOptions {
            log_dir: Some(logs.into()),
            sessions_root: Some(root.path().join("native").to_string_lossy().into_owned()),
            snapshot_root: Some(root.path().join("snapshots").to_string_lossy().into_owned()),
            native_scan_interval_ms: Some(0),
            work_budget: budget.or(Some(DoubaoWorkBudgetOptions {
                // Main #565: these cases test correlation, not host preemption.
                // The original byte/record limits remain active.
                milliseconds: u64::MAX,
                ..Default::default()
            })),
            ..DoubaoWorkInputOptions::new(store)
        })
    }
    async fn poll(&self) -> Vec<AgentActivityEntry> {
        self.input
            .inner
            .body
            .collect(&self.input.inner.runtime)
            .await
            .unwrap()
    }
    async fn append(&self, body: &str) {
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&self.file)
            .await
            .unwrap();
        file.write_all(body.as_bytes()).await.unwrap();
        file.flush().await.unwrap();
    }
    fn line(&self, name: &str, meta: Value, offset: i64) -> String {
        let at = chrono::Local
            .timestamp_millis_opt(self.epoch + offset)
            .single()
            .unwrap();
        let mut base = json!({"chat_session_id":"synthetic-turn","query_send_timestamp":self.epoch,"conversation_id":"12345678","send_local_message_id":"00000000-0000-4000-8000-000000000002","session_success":"1","receive_success":"1"});
        base.as_object_mut()
            .unwrap()
            .extend(meta.as_object().unwrap().clone());
        let payload =
            json!({"version":1,"type":"event","level":"info","eventName":name,"meta":base});
        format!("[100:200:{}:INFO:FRONTEND(0)] [neotix] [office-api-logger] \"[webview][unknown][flow-web][logifier-report]: {}\", source: (0)\n",at.format("%m%d/%H%M%S.%3f").to_string()+"123",js_encode(&payload))
    }
    fn tool(&self, data: Value, offset: i64) -> String {
        let at = chrono::Local
            .timestamp_millis_opt(self.epoch + offset)
            .single()
            .unwrap();
        let mut base = json!({"name":"Read","sandbox_id":"synthetic-sandbox","status":"received","tcid":"synthetic-call","agent_id":"synthetic-turn"});
        base.as_object_mut()
            .unwrap()
            .extend(data.as_object().unwrap().clone());
        format!("[100:200:{}:INFO:FRONTEND(0)] [neotix] [agent-task] \"{}\", source: local-file-local-tools-sse-wiring.ts (0)\n",at.format("%m%d/%H%M%S.%3f").to_string()+"123",js_encode(&json!({"event":"toolcall","data":base})))
    }
    fn command(&self, actor: &str, offset: i64) -> String {
        self.tool(json!({"name":"sandbox","agent_id":actor,"sand_box_id":"synthetic-sandbox","command_id":format!("command-{actor}")}),offset).replace("\"event\":\"toolcall\"","\"event\":\"command\"")
    }
    fn first(&self, meta: Value, offset: i64) -> String {
        let mut base = json!({"task_session_id":"synthetic-turn","metric_scene":"sse","ev_name":"cot_first_token","ev_type":"query_duration","event_instance_id":"synthetic-turn:sync:6:1","task_stage":"sync","is_recovery":false,"occurrence_index":1,"duration":1000,"answer_id":"synthetic-answer","message_id":"synthetic-query"});
        base.as_object_mut()
            .unwrap()
            .extend(meta.as_object().unwrap().clone());
        self.line("flow_message_time", base, offset)
    }
    async fn checkpoint(&self) -> Checkpoint {
        serde_json::from_value(self.store.get("doubao-work").extra().unwrap()["doubaoWork"].clone())
            .unwrap()
    }
    fn replace_checkpoint(&self, checkpoint: &Checkpoint) {
        self.store.update(
            "doubao-work",
            crate::checkpoints::InputStatePatch {
                extra: Some(json!({"doubaoWork":checkpoint})),
                ..Default::default()
            },
        );
    }
    async fn fresh(&self) -> DoubaoWorkInput {
        self.store.save().await.unwrap();
        let store = Arc::new(StateStore::new(self.root.path().join("state.json")));
        store.load().await;
        Self::make(&self.root, &self.logs, store, None)
    }
    async fn native_actor(&self, actor: &str, rows: &[Value], assignment: Option<&str>) {
        let folder = self
            .root
            .path()
            .join("native/12345678/agents")
            .join(actor)
            .join("system");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        tokio::fs::write(
            folder.join("trajectory.jsonl"),
            rows.iter().map(js_encode).collect::<Vec<_>>().join("\n") + "\n",
        )
        .await
        .unwrap();
        if let Some(body) = assignment {
            let time = chrono::Utc
                .timestamp_millis_opt(self.epoch + 10)
                .single()
                .unwrap();
            tokio::fs::write(
                folder.join("assignment.md"),
                format!("## [{}] 需求\n{body}\n", time.to_rfc3339()),
            )
            .await
            .unwrap();
        }
    }
    async fn native_ancestry(&self) {
        self.native_actor("m_nativeMain",&[
   json!({"role":"assistant","tool_calls":[{"id":"root-create","function":{"name":"create_agent","arguments":{"subtask":"SYNTHETIC_PRIVATE"}}}]}),
   json!({"role":"tool","tool_call_id":"root-create","content":"create_agent ok\nagent_id: o_nativeOrg\nparent_id: main_agent\nthread_id: 101\nagent_type: organizer\nsubtask: SYNTHETIC_PRIVATE"}),
  ],None).await;
        self.native_actor("o_nativeOrg",&[
   json!({"role":"assistant","tool_calls":[{"id":"child-create","function":{"name":"create_agent","arguments":{"subtask":"SYNTHETIC_PRIVATE"}}}]}),
   json!({"role":"tool","tool_call_id":"child-create","content":"create_agent ok\nagent_id: s_nativeLeaf\nparent_id: o_nativeOrg\nthread_id: 102\nagent_type: sub_agent\nsubtask: SYNTHETIC_PRIVATE"}),
  ],None).await;
    }
    async fn execution(&self, background: bool) -> NativeExecution {
        let execution = NativeExecution {
            execution_key: "00000000-0000-4000-8000-000000000001".into(),
            conversation_id: "12345678".into(),
            query_message_id: "00000000-0000-4000-8000-000000000002".into(),
            agent_id: "s_nativeLeaf".into(),
            agent_type: "sub_agent".into(),
            sandbox_id: "synthetic-sandbox".into(),
            started_at_ms: self.epoch + if background { 12_000 } else { 3000 },
            ended_at_ms: self.epoch + if background { 13_000 } else { 4000 },
        };
        let folder = self
            .root
            .path()
            .join("snapshots/123/12345678")
            .join(&execution.execution_key);
        tokio::fs::create_dir_all(&folder).await.unwrap();
        tokio::fs::write(
            folder.join("s_nativeLeaf.json"),
            js_encode(&json!({"execution":execution,"fileContents":"SYNTHETIC_PRIVATE_CONTENT"})),
        )
        .await
        .unwrap();
        execution
    }
    async fn parent_fixture(&self, background: bool) -> NativeExecution {
        self.native_ancestry().await;
        let execution = self.execution(background).await;
        self.append(&(self.line("on_message_session_start",json!({}),10)+&self.command("synthetic-turn",50)+&self.command("o_nativeOrg",100)+&self.command("s_nativeLeaf",200)+&self.tool(json!({"agent_id":"o_nativeOrg","name":"Write","tcid":"successful-noop-write"}),1000)+&self.tool(json!({"name":"Write","toolCallID":"successful-noop-write","phase":"execution_settled","status":"success"}),2000)+&self.line("on_message_session_end",json!({}),10_000))).await;
        execution
    }
}
fn wire(entries: &[AgentActivityEntry]) -> Value {
    serde_json::to_value(entries).unwrap()
}
async fn poll(input: &DoubaoWorkInput) -> Vec<AgentActivityEntry> {
    input
        .inner
        .body
        .collect(&input.inner.runtime)
        .await
        .unwrap()
}
#[tokio::test]
async fn discovers_only_source_files_and_baselines_existing_history_before_new_windows_turn() {
    let f = Fixture::new().await;
    let false_dir = f.root.path().join("unrelated");
    tokio::fs::create_dir(&false_dir).await.unwrap();
    tokio::fs::write(false_dir.join("saman_repair_2026.1025.0.log"), "")
        .await
        .unwrap();
    assert!(!DoubaoWorkInput::check_availability(false_dir.to_str()).await);
    assert!(DoubaoWorkInput::check_availability(Some(&f.logs)).await);
    let name = f
        .file
        .file_name()
        .unwrap()
        .to_string_lossy()
        .replace("saman_frontend_", "saman_");
    let file = Path::new(&f.logs).join(name);
    let windows = |source: String| {
        static RE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(\.\d{3})\d{3}:INFO:FRONTEND\(0\)").unwrap());
        RE.replace_all(&source, "$1:INFO:CONSOLE(0)").into_owned()
    };
    // A rotation created after installation must start at zero, including on Windows.
    tokio::fs::write(
        &file,
        windows(f.line("on_message_session_start", json!({}), 10)),
    )
    .await
    .unwrap();
    assert!(f.poll().await.is_empty());
    let resumed = f.fresh().await;
    let mut handle = tokio::fs::OpenOptions::new()
        .append(true)
        .open(file)
        .await
        .unwrap();
    handle
        .write_all(windows(f.line("on_message_session_end", json!({}), 3000)).as_bytes())
        .await
        .unwrap();
    let entries = poll(&resumed).await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].time_unix_nano, ms_nanos(f.epoch));
    assert_eq!(entries[1].time_unix_nano, ms_nanos(f.epoch + 3000));
    assert!(poll(&resumed).await.is_empty());
}
#[tokio::test]
async fn first_install_excludes_an_existing_complete_turn_but_keeps_later_turn() {
    let f = Fixture::new().await;
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    let store = Arc::new(StateStore::new(f.root.path().join("new-install.json")));
    let fresh = Fixture::make(&f.root, &f.logs, store, None);
    assert!(poll(&fresh).await.is_empty());
    assert!(poll(&fresh).await.is_empty());
    f.append(
        &(f.line(
            "on_message_session_start",
            json!({"chat_session_id":"new"}),
            4000,
        ) + &f.line(
            "on_message_session_end",
            json!({"chat_session_id":"new"}),
            5000,
        )),
    )
    .await;
    let entries = poll(&fresh).await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].turn_id.as_deref(), Some("new"));
}
#[tokio::test]
async fn trailing_half_line_retains_offset_and_recovers_once_after_restart() {
    let f = Fixture::new().await;
    let start = f.line("on_message_session_start", json!({}), 10);
    let terminal = f.line("on_message_session_end", json!({}), 3000);
    let split = terminal.len() / 2;
    f.append(&(start.clone() + &terminal[..split])).await;
    assert!(f.poll().await.is_empty());
    assert_eq!(
        f.checkpoint().await.files[f.file.file_name().unwrap().to_str().unwrap()].offset,
        start.len() as u64
    );
    let resumed = f.fresh().await;
    f.append(&terminal[split..]).await;
    assert_eq!(poll(&resumed).await.len(), 2);
    assert!(poll(&resumed).await.is_empty());
}
#[tokio::test]
async fn truncate_and_regrow_same_inode_rechecks_raw_anchor_without_inventing_old_terminal() {
    let f = Fixture::new().await;
    let old = f.line(
        "on_message_session_start",
        json!({"chat_session_id":"old","anchor_marker":"old"}),
        10,
    );
    f.append(&old).await;
    assert!(f.poll().await.is_empty());
    let mut replacement = f.line(
        "on_message_session_start",
        json!({"chat_session_id":"new","anchor_marker":"new"}),
        10,
    );
    assert_eq!(old.len(), replacement.len());
    replacement += &f.line(
        "on_message_session_end",
        json!({"chat_session_id":"new","anchor_marker":"new"}),
        3000,
    );
    tokio::fs::write(&f.file, replacement).await.unwrap();
    let entries = f.poll().await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].turn_id.as_deref(), Some("new"));
    assert!(f
        .checkpoint()
        .await
        .pending
        .keys()
        .any(|k| k.starts_with("old:")));
    assert!(f.poll().await.is_empty());
}
#[tokio::test]
async fn out_of_order_rotated_tools_are_joined_before_terminal_finalization() {
    let f = Fixture::new().await;
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    let rotated = f.file.with_file_name(
        f.file
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(".0.log", ".1.log"),
    );
    tokio::fs::write(rotated,f.tool(json!({}),100)+&f.tool(json!({"toolCallID":"synthetic-call","phase":"execution_settled","status":"success"}),200)).await.unwrap();
    let events = wire(&f.poll().await);
    assert_eq!(events.as_array().unwrap().len(), 4);
    assert_eq!(events[1]["event.name"], "tool.call");
    assert_eq!(events[2]["event.name"], "tool.result");
    assert!(f.poll().await.is_empty());
}
#[tokio::test]
async fn unique_first_output_survives_disk_restart_without_prompt_or_llm_inference() {
    let f = Fixture::new().await;
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.first(json!({"prompt":"SYNTHETIC_PRIVATE"}), 1002)),
    )
    .await;
    assert!(f.poll().await.is_empty());
    let restored = f.fresh().await;
    f.append(&(f.first(json!({}), 1100) + &f.line("on_message_session_end", json!({}), 3000)))
        .await;
    let events = wire(&poll(&restored).await);
    let outputs: Vec<_> = events
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["loongsuite.doubao_work.observation_scope"] == "native_first_model_output")
        .collect();
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0]["time_unix_nano"], ms_nanos(f.epoch + 1000));
    let serialized = js_encode(&events);
    for forbidden in [
        "SYNTHETIC_PRIVATE",
        "gen_ai.request.model",
        "gen_ai.usage",
        "finish_reason",
        "llm.",
    ] {
        assert!(!serialized.contains(forbidden), "{forbidden}");
    }
    assert!(poll(&restored).await.is_empty());
}
#[tokio::test]
async fn conflicting_ambiguous_unstarted_late_and_other_task_first_output_never_becomes_llm() {
    for mode in [
        "conflict",
        "ambiguous",
        "no-start",
        "future-receipt",
        "after-terminal",
        "different-task",
    ] {
        let f = Fixture::new().await;
        let start = if mode == "no-start" {
            String::new()
        } else {
            f.line("on_message_session_start", json!({}), 10)
        };
        let extra = if mode == "ambiguous" {
            f.line(
                "on_message_session_start",
                json!({"query_send_timestamp":f.epoch+20}),
                30,
            )
        } else {
            String::new()
        };
        let meta = match mode {
            "different-task" => {
                json!({"task_session_id":"other","event_instance_id":"other:sync:6:1"})
            }
            "future-receipt" => json!({"duration":2000}),
            "after-terminal" => json!({"duration":3500}),
            _ => json!({}),
        };
        let first = f.first(meta, if mode == "after-terminal" { 3600 } else { 1002 });
        let conflict = if mode == "conflict" {
            f.first(json!({"duration":1001}), 1100)
        } else {
            String::new()
        };
        f.append(
            &(start
                + &extra
                + &first
                + &conflict
                + &f.line("on_message_session_end", json!({}), 3000)),
        )
        .await;
        let events = wire(&f.poll().await);
        let encoded = js_encode(&events);
        assert!(!encoded.contains("\"event.name\":\"llm."), "{mode}");
        assert!(!encoded.contains("native_first_model_output"), "{mode}");
    }
}
#[tokio::test]
async fn unsupported_schema_is_preserved_without_any_state_mutation() {
    let f = Fixture::new().await;
    let saved = json!({"schema":999,"secretFree":"future-owned-marker"});
    f.store.update(
        "doubao-work",
        crate::checkpoints::InputStatePatch {
            extra: Some(json!({"doubaoWork":saved})),
            ..Default::default()
        },
    );
    let revision = f.store.revision();
    assert!(f.poll().await.is_empty());
    assert_eq!(f.store.revision(), revision);
    assert_eq!(
        f.store.get("doubao-work").extra().unwrap()["doubaoWork"],
        saved
    );
}
#[tokio::test]
async fn terminal_without_start_and_ambiguous_tool_receipts_stay_unexported() {
    let f = Fixture::new().await;
    f.append(&f.line("on_message_session_end", json!({}), 3000))
        .await;
    assert!(f.poll().await.is_empty());
    assert_eq!(f.checkpoint().await.pending.len(), 1);
    let f = Fixture::new().await;
    f.append(&(f.line("on_message_session_start",json!({}),10)+&f.tool(json!({}),100)+&f.tool(json!({"name":"Write"}),110)+&f.tool(json!({"toolCallID":"synthetic-call","phase":"execution_settled","status":"success"}),200)+&f.line("on_message_session_end",json!({}),3000))).await;
    let events = f.poll().await;
    assert_eq!(events.len(), 2);
    assert!(!js_encode(&wire(&events)).contains("tool.call"));
    assert!(f.checkpoint().await.tools.values().next().unwrap().conflict);
}
#[tokio::test]
async fn missing_parent_write_wait_is_durable_and_bounded_then_emitted_once() {
    let f = Fixture::new().await;
    let execution = f.parent_fixture(false).await;
    // A cycle exhausted before observing the child must not start its grace.
    let exhausted = Fixture::make(
        &f.root,
        &f.logs,
        f.store.clone(),
        Some(DoubaoWorkBudgetOptions {
            bytes: 0,
            milliseconds: u64::MAX,
            ..Default::default()
        }),
    );
    assert!(poll(&exhausted).await.is_empty());
    assert!(f
        .checkpoint()
        .await
        .execution_first_seen
        .get(&execution.execution_key)
        .is_none());
    let first = wire(&f.poll().await);
    assert!(!js_encode(&first).contains("local_execution_phase"));
    let mut checkpoint = f.checkpoint().await;
    checkpoint
        .execution_first_seen
        .set(execution.execution_key.clone(), now_ms() - 90_000);
    f.replace_checkpoint(&checkpoint);
    let resumed = f.fresh().await;
    assert!(poll(&resumed).await.is_empty());
    let mut checkpoint: Checkpoint = serde_json::from_value(
        resumed.inner.runtime.state().extra().unwrap()["doubaoWork"].clone(),
    )
    .unwrap();
    checkpoint
        .execution_first_seen
        .set(execution.execution_key.clone(), now_ms() - 120_001);
    resumed
        .inner
        .runtime
        .set_state_fields(None, None, Some(json!({"doubaoWork":checkpoint})));
    let entries = wire(&poll(&resumed).await);
    assert_eq!(entries.as_array().unwrap().len(), 2);
    assert_eq!(
        entries[0]["loongsuite.doubao_work.native_execution_id"],
        execution.execution_key
    );
    assert_eq!(
        entries[0]["loongsuite.doubao_work.parent_resolution"],
        "root_request_ancestor"
    );
    assert!(entries[0].get("parent_span_id").is_none());
    assert_eq!(
        entries[1]["time_unix_nano"],
        ms_nanos(execution.ended_at_ms)
    );
    assert!(poll(&resumed).await.is_empty());
    let checkpoint = js_encode(&resumed.inner.runtime.state().extra().unwrap());
    for text in [
        "SYNTHETIC_PRIVATE",
        "fileContents",
        "subtask",
        "transcripts",
        "task_input",
        "task_output",
    ] {
        assert!(!checkpoint.contains(text), "{text}");
    }
}
#[tokio::test]
async fn stale_or_legacy_mutation_witness_cannot_extend_the_30s_parent_grace() {
    for mode in ["legacy", "previous-query"] {
        let f = Fixture::new().await;
        let execution = f.parent_fixture(false).await;
        f.poll().await;
        let mut checkpoint = f.checkpoint().await;
        let key = encode(&json!(["synthetic-sandbox", "o_nativeOrg"]));
        let mut witness = checkpoint.native_mutation_actors[&key].clone();
        witness.time_nano = if mode == "legacy" {
            None
        } else {
            Some(ms_nanos(f.epoch - 1000))
        };
        checkpoint.native_mutation_actors.set(key, witness);
        checkpoint
            .execution_first_seen
            .set(execution.execution_key.clone(), now_ms() - 30_001);
        f.replace_checkpoint(&checkpoint);
        let events = wire(&f.poll().await);
        assert_eq!(events.as_array().unwrap().len(), 2, "{mode}");
        assert_eq!(
            events[0]["loongsuite.doubao_work.native_execution_id"],
            execution.execution_key
        );
    }
}
#[tokio::test]
async fn independent_background_execution_does_not_wait_for_missing_parent() {
    let f = Fixture::new().await;
    let execution = f.parent_fixture(true).await;
    let entries = wire(&f.poll().await);
    let tasks: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| {
            e.get("loongsuite.doubao_work.local_execution_phase")
                .is_some()
        })
        .collect();
    assert_eq!(tasks.len(), 2);
    assert_eq!(
        tasks[0]["loongsuite.doubao_work.native_execution_id"],
        execution.execution_key
    );
    assert!(f.poll().await.is_empty());
}
#[tokio::test]
async fn other_input_revision_invalidates_checkpoint_cache_without_reparsing_native_source() {
    let f = Fixture::new().await;
    f.native_actor(
        "m_current",
        &[json!({"role":"assistant","content":"FINAL"})],
        Some("CURRENT"),
    )
    .await;
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    assert_eq!(f.poll().await.len(), 2);
    let before = f.input.inner.body.state.lock().await.reader.stats();
    let revision = f.store.revision();
    assert!(f.poll().await.is_empty());
    assert_eq!(f.store.revision(), revision);
    f.store.set(
        "independent-input",
        crate::checkpoints::InputState::new().with_last_offset(10.0),
    );
    let revision = f.store.revision();
    assert!(f.poll().await.is_empty());
    assert_eq!(f.store.revision(), revision);
    let after = f.input.inner.body.state.lock().await.reader.stats();
    assert_eq!(after.body_read_bytes, before.body_read_bytes);
    assert_eq!(after.parsed_rows, before.parsed_rows);
}
#[tokio::test]
async fn bounded_record_cycles_resume_whole_window_and_finalize_ready_turn_after_restart() {
    let f = Fixture::new().await;
    let mut text = String::new();
    for i in 0..4 {
        text += &f.line(
            "on_message_session_start",
            json!({"chat_session_id":format!("pending-{i}"),"conversation_id":""}),
            10 + i,
        );
    }
    text += &f.line(
        "on_message_session_start",
        json!({"chat_session_id":"ready"}),
        200,
    );
    text += &f.line(
        "on_message_session_end",
        json!({"chat_session_id":"ready"}),
        300,
    );
    f.append(&text).await;
    let bounded = Fixture::make(
        &f.root,
        &f.logs,
        f.store.clone(),
        Some(DoubaoWorkBudgetOptions {
            records: 1,
            milliseconds: 1000,
            ..Default::default()
        }),
    );
    let mut entries = Vec::new();
    for _ in 0..30 {
        entries.extend(poll(&bounded).await);
        if entries.len() == 2 {
            break;
        }
    }
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .all(|e| e.turn_id.as_deref() == Some("ready")));
    let cp: Checkpoint =
        serde_json::from_value(f.store.get("doubao-work").extra().unwrap()["doubaoWork"].clone())
            .unwrap();
    assert_eq!(cp.pending.len(), 4);
    f.store.save().await.unwrap();
    let restored = f.fresh().await;
    assert!(poll(&restored).await.is_empty());
}
#[tokio::test]
async fn oversized_line_is_skipped_through_its_newline_then_valid_turn_is_recovered() {
    let f = Fixture::new().await;
    f.append(&"x".repeat(READ_BYTES + 100)).await;
    assert!(f.poll().await.is_empty());
    let cp = f.checkpoint().await;
    assert!(cp.files.values().next().unwrap().skipping_line);
    f.append(
        &("\n{bad json}\n".to_owned()
            + &f.line("on_message_session_start", json!({}), 10)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    assert_eq!(f.poll().await.len(), 2);
    assert!(f.poll().await.is_empty());
}
#[tokio::test]
async fn stopping_discards_watchers_and_memory_jobs_without_leaking_collection_after_restart() {
    let f = Fixture::new().await;
    f.input
        .inner
        .body
        .on_start(&f.input.inner.runtime)
        .await
        .unwrap();
    f.input.inner.body.schedule_wakeup();
    f.input.inner.body.before_stop();
    f.input
        .inner
        .body
        .on_stop(&f.input.inner.runtime)
        .await
        .unwrap();
    assert!(f.input.inner.body.watcher.lock().unwrap().is_none());
    assert!(f.input.inner.body.wakeup.lock().unwrap().is_none());
    assert!(f.input.inner.body.state.lock().await.jobs.is_empty());
    assert!(f.poll().await.is_empty());
}

#[tokio::test]
async fn temporary_native_io_failure_keeps_ended_request_durable_then_recovers_full_content_after_restart(
) {
    let f = Fixture::new().await;
    f.native_actor(
        "m_current",
        &[json!({"role":"assistant","content":"FINAL"})],
        Some("CURRENT"),
    )
    .await;
    f.input
        .inner
        .body
        .state
        .lock()
        .await
        .reader
        .fail_next_stat(std::io::ErrorKind::PermissionDenied);
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    assert!(f.poll().await.is_empty());
    let checkpoint = f.checkpoint().await;
    assert_eq!(checkpoint.pending.len(), 1);
    assert!(checkpoint.completed.is_empty());
    let restored = f.fresh().await;
    let entries = wire(&poll(&restored).await);
    assert_eq!(entries.as_array().unwrap().len(), 2);
    assert_eq!(
        entries[0]["agent.doubao_work.assistant_rounds"]["rounds"][0]["outputMessages"][0]["parts"]
            [0]["content"],
        "FINAL"
    );
    assert!(poll(&restored).await.is_empty());
}
#[tokio::test]
async fn native_and_log_share_128k_read_budget_and_restart_recovers_exact_long_history_rounds_once()
{
    let max_bytes = 128 * 1024;
    let f = Fixture::new().await;
    let mut rows:Vec<_>=(0..220).map(|i|json!({"role":if i%2==1{"assistant"}else{"user"},"content":format!("{i}{}", "x".repeat(16_000))})).collect();
    rows.extend([
  json!({"role":"user","content":"CURRENT"}),
  json!({"role":"assistant","content":"parallel","tool_calls":[{"id":"one","function":{"name":"Read","arguments":{"file_path":"one"}}},{"id":"two","function":{"name":"Read","arguments":{"file_path":"two"}}}]}),
  json!({"role":"tool","tool_call_id":"two","content":"second"}),json!({"role":"tool","tool_call_id":"one","content":"first"}),json!({"role":"assistant","content":"FINAL"})
 ]);
    f.native_actor("m_current", &rows, Some("CURRENT")).await;
    let system = f
        .root
        .path()
        .join("native/12345678/agents/m_current/system");
    let old_time = chrono::Utc
        .timestamp_millis_opt(f.epoch - 1000)
        .single()
        .unwrap();
    let current_time = chrono::Utc
        .timestamp_millis_opt(f.epoch + 1)
        .single()
        .unwrap();
    let assignments = format!(
        "## [{}] 需求\nOLD\n\n## [{}] 需求\nCURRENT\n",
        old_time.to_rfc3339(),
        current_time.to_rfc3339()
    );
    tokio::fs::write(system.join("assignment.md"), &assignments)
        .await
        .unwrap();
    let raw = rows.iter().map(js_encode).collect::<Vec<_>>().join("\n") + "\n";
    assert!(raw.len() > 2 * 1024 * 1024);
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.tool(json!({"tcid":"one"}), 100)
            + &f.tool(json!({"tcid":"two"}), 110)
            + &f.tool(
                json!({"toolCallID":"two","phase":"execution_settled","status":"success"}),
                200,
            )
            + &f.tool(
                json!({"toolCallID":"one","phase":"execution_settled","status":"success"}),
                210,
            )
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    let limits = Some(DoubaoWorkBudgetOptions {
        bytes: max_bytes,
        records: 512,
        milliseconds: 1000,
    });
    let input = Fixture::make(&f.root, &f.logs, f.store.clone(), limits);
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::new(Mutex::new(Vec::new()));
    {
        let deltas = deltas.clone();
        let captured = captured.clone();
        input.bind_collector(
            move |events| captured.lock().unwrap().extend_from_slice(events),
            move |delta| deltas.lock().unwrap().push(delta.clone()),
        );
    }
    input.run_cycle().await;
    assert!(captured.lock().unwrap().is_empty());
    assert!(deltas
        .lock()
        .unwrap()
        .iter()
        .all(|d| d.raw_read_bytes <= max_bytes));
    assert_eq!(f.checkpoint().await.pending.len(), 1);
    input
        .inner
        .body
        .on_stop(&input.inner.runtime)
        .await
        .unwrap();
    let store = Arc::new(StateStore::new(f.root.path().join("state.json")));
    store.load().await;
    let resumed = Fixture::make(&f.root, &f.logs, store.clone(), limits);
    {
        let deltas = deltas.clone();
        let captured = captured.clone();
        resumed.bind_collector(
            move |events| captured.lock().unwrap().extend_from_slice(events),
            move |delta| deltas.lock().unwrap().push(delta.clone()),
        );
    }
    let mut cycles = 0;
    while cycles < 60 && captured.lock().unwrap().is_empty() {
        resumed.run_cycle().await;
        cycles += 1;
    }
    assert!(cycles > 2);
    let entries = captured.lock().unwrap().clone();
    assert_eq!(entries.len(), 6);
    assert!(deltas
        .lock()
        .unwrap()
        .iter()
        .all(|d| d.raw_read_bytes <= max_bytes));
    let full = super::super::content::parse_native_content(
        &IndexMap::from([("m_current".into(), raw)]),
        &IndexMap::from([("m_current".into(), assignments)]),
    )
    .unwrap()
    .unwrap();
    let expected = super::super::rounds::reconstruct_native_rounds(
        Some(&full),
        "m_current",
        f.epoch,
        &entries.last().unwrap().time_unix_nano,
        &["one".into(), "two".into()],
        "client_request",
    )
    .unwrap();
    let wire = wire(&entries);
    assert_eq!(
        wire[0]["agent.doubao_work.assistant_rounds"],
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(
        wire[0]["agent.doubao_work.assistant_rounds"]["rounds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        entries
            .iter()
            .map(|e| e.event_id.clone())
            .collect::<HashSet<_>>()
            .len(),
        6
    );
    resumed.run_cycle().await;
    assert_eq!(captured.lock().unwrap().len(), 6);
    let cp: Checkpoint =
        serde_json::from_value(store.get("doubao-work").extra().unwrap()["doubaoWork"].clone())
            .unwrap();
    assert!(cp.pending.is_empty());
}
#[tokio::test]
async fn reconstruction_pauses_at_record_budget_while_retaining_validated_immutable_native_snapshot(
) {
    let f = Fixture::new().await;
    let mut rows: Vec<_> = (0..8000)
        .map(|i| json!({"role":"assistant","content":format!("current-{i}")}))
        .collect();
    rows.push(json!({"role":"assistant","content":"FINAL"}));
    f.native_actor("m_current", &rows, Some("CURRENT")).await;
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    let input = Fixture::make(
        &f.root,
        &f.logs,
        f.store.clone(),
        Some(DoubaoWorkBudgetOptions {
            records: 512,
            milliseconds: 1000,
            ..Default::default()
        }),
    );
    let captured = Arc::new(Mutex::new(Vec::new()));
    let deltas = Arc::new(Mutex::new(Vec::new()));
    {
        let captured = captured.clone();
        let deltas = deltas.clone();
        input.bind_collector(
            move |events| captured.lock().unwrap().extend_from_slice(events),
            move |delta| deltas.lock().unwrap().push(delta.clone()),
        );
    }
    let (mut reconstruction_cycles, mut prior_read) = (0, 0);
    for _ in 0..80 {
        input.run_cycle().await;
        let state = input.inner.body.state.lock().await;
        if !state.jobs.is_empty() {
            reconstruction_cycles += 1;
            if reconstruction_cycles > 1 {
                assert!(deltas.lock().unwrap().last().unwrap().raw_read_bytes <= 64);
            }
            prior_read = state.reader.stats().body_read_bytes;
        }
        if !captured.lock().unwrap().is_empty() {
            break;
        }
    }
    let entries = captured.lock().unwrap().clone();
    assert_eq!(entries.len(), 2);
    assert!(reconstruction_cycles > 2);
    let actual = wire(&entries);
    assert_eq!(
        actual[0]["agent.doubao_work.assistant_rounds"]["rounds"][0]["sourceIndex"],
        0
    );
    assert!(
        actual[0]["agent.doubao_work.assistant_rounds"]["omittedRounds"]
            .as_u64()
            .unwrap()
            > 7900
    );
    let state = input.inner.body.state.lock().await;
    assert_eq!(state.reader.stats().body_read_bytes, prior_read);
    assert!(state.jobs.is_empty());
    drop(state);
    assert!(f.checkpoint().await.pending.is_empty());
    let raw = rows.iter().map(js_encode).collect::<Vec<_>>().join("\n") + "\n";
    let tasks = tokio::fs::read_to_string(
        f.root
            .path()
            .join("native/12345678/agents/m_current/system/assignment.md"),
    )
    .await
    .unwrap();
    let content = super::super::content::parse_native_content(
        &IndexMap::from([("m_current".into(), raw)]),
        &IndexMap::from([("m_current".into(), tasks)]),
    )
    .unwrap()
    .unwrap();
    let expected = super::super::rounds::reconstruct_native_rounds(
        Some(&content),
        "m_current",
        f.epoch,
        &entries[1].time_unix_nano,
        &[],
        "client_request",
    )
    .unwrap();
    assert_eq!(
        actual[0]["agent.doubao_work.assistant_rounds"],
        serde_json::to_value(expected).unwrap()
    );
}

#[tokio::test]
async fn platform_owned_native_roots_do_not_move_with_shallow_relative_or_unicode_log_override() {
    for target in ["darwin", "win32"] {
        let paths = super::super::paths::resolve_doubao_work_paths_with(
            target,
            "/synthetic home",
            Some(r"D:\Synthetic Local"),
        );
        for log in ["/logs", "/tmp/doubao-logs", "../logs", "relative 中文"] {
            let root = tempfile::tempdir().unwrap();
            let options = DoubaoWorkInputOptions {
                log_dir: Some(log.into()),
                ..DoubaoWorkInputOptions::new(Arc::new(StateStore::new(
                    root.path().join("never-used.json"),
                )))
            };
            let input = DoubaoWorkInput::new_with_paths(options, paths.clone());
            let state = input.inner.body.state.lock().await;
            let (sessions, user, snapshot) = state.reader.configured_roots();
            assert!(sessions.is_none());
            assert_eq!(user, paths.user_data_root.as_deref());
            assert_eq!(snapshot, paths.snapshot_root.as_deref());
            assert_ne!(input.inner.body.log_dir.as_deref(), user);
        }
    }
}
#[tokio::test]
async fn explicitly_supplied_session_and_snapshot_roots_are_kept_independent_of_log_override() {
    for target in ["darwin", "win32"] {
        let root = tempfile::tempdir().unwrap();
        let options = DoubaoWorkInputOptions {
            log_dir: Some("/logs".into()),
            sessions_root: Some("isolated sessions".into()),
            snapshot_root: Some("isolated snapshots".into()),
            ..DoubaoWorkInputOptions::new(Arc::new(StateStore::new(
                root.path().join("unused.json"),
            )))
        };
        let paths =
            super::super::paths::resolve_doubao_work_paths_with(target, "/synthetic home", None);
        let input = DoubaoWorkInput::new_with_paths(options, paths.clone());
        let state = input.inner.body.state.lock().await;
        let (sessions, user, snapshot) = state.reader.configured_roots();
        assert_eq!(sessions, Some("isolated sessions"));
        assert_eq!(snapshot, Some("isolated snapshots"));
        assert_eq!(user, paths.user_data_root.as_deref());
    }
}
#[tokio::test]
async fn linux_log_override_does_not_guess_native_or_snapshot_roots() {
    let root = tempfile::tempdir().unwrap();
    let options = DoubaoWorkInputOptions {
        log_dir: Some("/logs".into()),
        ..DoubaoWorkInputOptions::new(Arc::new(StateStore::new(root.path().join("unused.json"))))
    };
    let input = DoubaoWorkInput::new_with_paths(
        options,
        super::super::paths::resolve_doubao_work_paths_with("linux", "/synthetic", None),
    );
    let state = input.inner.body.state.lock().await;
    assert_eq!(state.reader.configured_roots(), (None, None, None));
    assert!(!input.inner.body.has_native);
    assert!(!input.inner.body.has_snapshots);
}

#[tokio::test]
async fn final_row_settle_waits_only_for_native_content_and_preserves_original_boundaries() {
    for arrives in [true, false] {
        let f = Fixture::new().await;
        f.native_actor("m_current", &[], Some("CURRENT_REQUEST"))
            .await;
        f.append(
            &(f.line("on_message_session_start", json!({}), 10)
                + &f.line("on_message_session_end", json!({}), 3000)),
        )
        .await;
        assert!(f.poll().await.is_empty());
        if arrives {
            tokio::fs::write(
                f.root
                    .path()
                    .join("native/12345678/agents/m_current/system/trajectory.jsonl"),
                js_encode(&json!({"role":"assistant","content":"CURRENT_FINAL"})) + "\n",
            )
            .await
            .unwrap();
        } else {
            let mut cp = f.checkpoint().await;
            let key = cp.pending.keys().next().unwrap().clone();
            let mut p = cp.pending[&key].clone();
            p.updated_ms = now_ms() - 2001;
            cp.pending.set(key, p);
            f.replace_checkpoint(&cp);
        }
        let entries = wire(&f.poll().await);
        assert_eq!(entries.as_array().unwrap().len(), 2);
        assert_eq!(entries[0]["time_unix_nano"], ms_nanos(f.epoch));
        assert_eq!(
            entries[1]["time_unix_nano"],
            (i128::from(f.epoch + 3000) * 1_000_000 + 123_000).to_string()
        );
        assert_eq!(entries[1].get("gen_ai.output.messages").is_some(), arrives);
        assert!(f.poll().await.is_empty());
    }
}
#[tokio::test]
async fn restored_presentation_helper_is_removed_while_real_bash_is_exported() {
    let f = Fixture::new().await;
    let call = f.tool(json!({"name":"Bash","tcid":"real-bash"}), 100);
    let end=f.tool(json!({"name":"Bash","toolCallID":"real-bash","status":"success","phase":"execution_settled"}),300);
    f.append(&(f.line("on_message_session_start", json!({}), 10) + &call))
        .await;
    assert!(f.poll().await.is_empty());
    let helper = "present-files-path-inspection-11111111-2222-4333-8444-555555555555";
    let mut cp = f.checkpoint().await;
    let mut start = parse_doubao_log_line(
        call.trim_end(),
        f.file.file_name().unwrap().to_str().unwrap(),
    )
    .unwrap();
    let mut settled = parse_doubao_log_line(
        end.trim_end(),
        f.file.file_name().unwrap().to_str().unwrap(),
    )
    .unwrap();
    start.tool.as_mut().unwrap().id = helper.into();
    settled.tool.as_mut().unwrap().id = helper.into();
    cp.tools.set(
        encode(&json!(["synthetic-sandbox", helper])),
        PendingTool {
            start: Some(start),
            end: Some(settled),
            updated_ms: now_ms(),
            ..Default::default()
        },
    );
    f.replace_checkpoint(&cp);
    let restored = f.fresh().await;
    f.append(&(end + &f.line("on_message_session_end", json!({}), 3000)))
        .await;
    let entries = wire(&poll(&restored).await);
    let calls: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event.name"] == "tool.call")
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["gen_ai.tool.call.id"], "real-bash");
    assert!(!js_encode(&restored.inner.runtime.state().extra().unwrap()).contains(helper));
    assert!(poll(&restored).await.is_empty());
}
#[tokio::test]
async fn parallel_tool_ids_statuses_durations_and_selected_skills_remain_request_scoped() {
    let f = Fixture::new().await;
    f.append(&(f.line("on_message_sending_start",json!({"mention_skill_list":"[\"synthetic-analysis\"]"}),10)+&f.tool(json!({"tcid":"call-a","arguments":"PRIVATE_ARGUMENT"}),100)+&f.tool(json!({"tcid":"call-b","name":"Write"}),110)+&f.tool(json!({"toolCallID":"call-b","name":"Write","status":"success","phase":"execution_settled","result":"PRIVATE_RESULT"}),120)+&f.tool(json!({"toolCallID":"call-a","status":"failed","phase":"execution_settled","error":"PRIVATE_ERROR"}),150)+&f.line("on_message_session_end",json!({}),3000))).await;
    let events = wire(&f.poll().await);
    assert_eq!(events.as_array().unwrap().len(), 6);
    assert_eq!(
        events
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "other",
            "tool.call",
            "tool.call",
            "tool.result",
            "tool.result",
            "other"
        ]
    );
    assert!(events
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["loongsuite.doubao_work.selected_skills"][0] == "synthetic-analysis"));
    assert_eq!(events[3]["gen_ai.tool.call.id"], "call-b");
    assert_eq!(events[3]["tool.result.status"], "success");
    assert_eq!(events[3]["gen_ai.tool.call.duration"].as_f64(), Some(10.0));
    assert_eq!(events[4]["gen_ai.tool.call.id"], "call-a");
    assert_eq!(events[4]["tool.result.status"], "error");
    assert_eq!(events[4]["gen_ai.tool.call.duration"].as_f64(), Some(50.0));
    assert_eq!(events[4]["error.type"], "doubao.local_tool_failed");
    let encoded = js_encode(&events);
    assert!(!encoded.contains("PRIVATE_"));
    assert!(!encoded.contains("gen_ai.tool.call.arguments"));
    assert!(!encoded.contains("gen_ai.tool.call.result"));
    f.append(
        &(f.line(
            "on_message_sending_start",
            json!({"chat_session_id":"next-turn"}),
            4000,
        ) + &f.line(
            "on_message_session_end",
            json!({"chat_session_id":"next-turn"}),
            5000,
        )),
    )
    .await;
    let next = wire(&f.poll().await);
    assert_eq!(next.as_array().unwrap().len(), 2);
    assert!(next
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e.get("loongsuite.doubao_work.selected_skills").is_none()));
}
#[tokio::test]
async fn half_settled_tool_record_restores_original_call_without_duplicate_replay() {
    let f = Fixture::new().await;
    f.append(&(f.line("on_message_sending_start", json!({}), 10) + &f.tool(json!({}), 100)))
        .await;
    assert!(f.poll().await.is_empty());
    let result = f.tool(
        json!({"toolCallID":"synthetic-call","status":"success","phase":"execution_settled"}),
        101,
    );
    let result = Regex::new(r"(\.\d{3})123:")
        .unwrap()
        .replace(&result, "${1}456:")
        .into_owned();
    f.append(&result[..80]).await;
    assert!(f.poll().await.is_empty());
    let restored = f.fresh().await;
    f.append(&(result[80..].to_owned() + &f.line("on_message_session_end", json!({}), 3000)))
        .await;
    let events = wire(&poll(&restored).await);
    assert_eq!(events.as_array().unwrap().len(), 4);
    assert_eq!(events[2]["gen_ai.tool.call.duration"], 1.333);
    f.append(
        &(f.tool(json!({}), 100) + &result + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    assert!(poll(&restored).await.is_empty());
}
#[tokio::test]
async fn orphan_conflicting_actor_and_post_terminal_background_tools_do_not_gain_a_root_owner() {
    let f = Fixture::new().await;
    f.append(&(f.line("on_message_sending_start",json!({}),10)+&f.tool(json!({}),100)+&f.tool(json!({"agent_id":"different-turn"}),101)+&f.tool(json!({"toolCallID":"synthetic-call","status":"success","phase":"execution_settled"}),200)+&f.tool(json!({"toolCallID":"orphan","status":"success","phase":"execution_settled"}),200)+&f.tool(json!({"tcid":"background"}),200)+&f.line("on_message_session_end",json!({}),3000)+&f.tool(json!({"toolCallID":"background","status":"success","phase":"execution_settled"}),4000))).await;
    let entries = wire(&f.poll().await);
    assert_eq!(entries.as_array().unwrap().len(), 2);
    assert!(entries
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["event.name"] == "other"));
}
#[tokio::test]
async fn result_from_an_earlier_scan_can_join_only_its_exact_later_dispatch() {
    let f = Fixture::new().await;
    f.append(&f.tool(
        json!({"toolCallID":"synthetic-call","status":"success","phase":"execution_settled"}),
        200,
    ))
    .await;
    assert!(f.poll().await.is_empty());
    f.append(
        &(f.line("on_message_sending_start", json!({}), 10)
            + &f.tool(json!({}), 100)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    let entries = wire(&f.poll().await);
    assert_eq!(entries.as_array().unwrap().len(), 4);
    assert_eq!(entries[1]["gen_ai.tool.call.id"], "synthetic-call");
}
#[tokio::test]
async fn server_mapping_is_required_and_joined_by_exact_local_message_without_private_payloads() {
    let f = Fixture::new().await;
    f.append(&(f.line("on_message_sending_start",json!({"conversation_id":null}),10)+&f.line("on_message_session_end",json!({"conversation_id":null,"prompt":"SYNTHETIC_PRIVATE_PROMPT","model_name":"自动","error_message":"SYNTHETIC_PRIVATE_ERROR"}),3000))).await;
    assert!(f.poll().await.is_empty());
    f.append(&f.line("general_agent_message_id_mapping",json!({"conversation_id":null,"conversationId":"12345678","send_local_message_id":null,"localMessageId":"unrelated-message"}),3050)).await;
    assert!(f.poll().await.is_empty());
    f.append(&f.line("general_agent_message_id_mapping",json!({"conversation_id":null,"conversationId":"12345678","send_local_message_id":null,"localMessageId":"00000000-0000-4000-8000-000000000002"}),3100)).await;
    let entries = wire(&f.poll().await);
    assert_eq!(entries.as_array().unwrap().len(), 2);
    assert!(entries
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["gen_ai.session.id"] == "12345678"
            && e["loongsuite.doubao_work.business_outcome"] == "unknown"));
    assert_eq!(entries[0]["gen_ai.turn.start"], true);
    assert_eq!(entries[1]["gen_ai.turn.end"], true);
    let encoded = js_encode(&entries);
    for forbidden in [
        "SYNTHETIC_PRIVATE",
        "自动",
        "gen_ai.request.model",
        "gen_ai.usage",
    ] {
        assert!(!encoded.contains(forbidden), "{forbidden}");
    }
    assert!(f.poll().await.is_empty());
}
#[tokio::test]
async fn log_directory_unavailability_preserves_cursor_and_pending_then_resumes() {
    let f = Fixture::new().await;
    f.append(&f.line("on_message_session_start", json!({}), 10))
        .await;
    assert!(f.poll().await.is_empty());
    let checkpoint = f.store.get("doubao-work");
    let revision = f.store.revision();
    let away = format!("{}-away", f.logs);
    tokio::fs::rename(&f.logs, &away).await.unwrap();
    assert!(f.poll().await.is_empty());
    assert_eq!(f.store.get("doubao-work"), checkpoint);
    assert_eq!(f.store.revision(), revision);
    tokio::fs::rename(away, &f.logs).await.unwrap();
    f.append(&f.line("on_message_session_end", json!({}), 3000))
        .await;
    assert_eq!(f.poll().await.len(), 2);
}
#[tokio::test]
async fn file_replacement_and_duplicate_rotations_keep_completed_event_identity() {
    let f = Fixture::new().await;
    let turn = f.line("on_message_session_start", json!({}), 10)
        + &f.line("on_message_session_end", json!({}), 3000);
    f.append(&turn).await;
    let first = f.poll().await;
    assert_eq!(first.len(), 2);
    let rotated = f.file.with_file_name(
        f.file
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(".0.log", ".1.log"),
    );
    tokio::fs::rename(&f.file, rotated).await.unwrap();
    tokio::fs::write(&f.file, &turn).await.unwrap();
    assert!(f.poll().await.is_empty());
    tokio::fs::write(
        &f.file,
        f.line(
            "on_message_session_start",
            json!({"chat_session_id":"synthetic-turn-2"}),
            10,
        ) + &f.line(
            "on_message_session_end",
            json!({"chat_session_id":"synthetic-turn-2"}),
            3000,
        ),
    )
    .await
    .unwrap();
    let second = f.poll().await;
    assert_eq!(second.len(), 2);
    assert_ne!(second[0].event_id, first[0].event_id);
}
#[tokio::test]
async fn terminal_before_start_and_concurrent_turns_keep_independent_source_session_owners() {
    let f = Fixture::new().await;
    f.append(&f.line("on_message_session_end", json!({}), 3000))
        .await;
    assert!(f.poll().await.is_empty());
    f.append(&f.line("on_message_session_start", json!({}), 10))
        .await;
    assert_eq!(f.poll().await.len(), 2);
    let second = json!({"chat_session_id":"second","conversation_id":"conversation-2"});
    let third = json!({"chat_session_id":"third","conversation_id":"conversation-3"});
    f.append(
        &(f.line("on_message_session_start", second.clone(), 20)
            + &f.line("on_message_session_start", third.clone(), 30)
            + &f.line("on_message_session_end", third, 1000)
            + &f.line("on_message_session_end", second, 2000)),
    )
    .await;
    let entries = f.poll().await;
    assert_eq!(entries.len(), 4);
    assert_eq!(
        entries
            .iter()
            .map(|e| e.trace_id.clone())
            .collect::<HashSet<_>>()
            .len(),
        2
    );
    assert!(entries
        .iter()
        .filter(|e| e.turn_id.as_deref() == Some("second"))
        .all(|e| e.session_id == "conversation-2"));
}
#[tokio::test]
async fn repair_logs_do_not_create_a_missing_source_directory() {
    let f = Fixture::new().await;
    tokio::fs::remove_file(&f.file).await.unwrap();
    tokio::fs::write(
        Path::new(&f.logs).join("saman_repair_2026.1025.0.log"),
        "repair",
    )
    .await
    .unwrap();
    assert!(!DoubaoWorkInput::check_availability(Some(&f.logs)).await);
    tokio::fs::remove_dir_all(&f.logs).await.unwrap();
    assert!(f.poll().await.is_empty());
    assert!(!Path::new(&f.logs).exists());
    assert!(!DoubaoWorkInput::check_availability(Some(&f.logs)).await);
}
#[tokio::test]
async fn numeric_rotation_capacity_evicts_oldest_suffix_and_bounded_sweep_eventually_closes_ready_turn(
) {
    let f = Fixture::new().await;
    let name = |i| {
        f.file
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(".0.log", &format!(".{i}.log"))
    };
    for i in 1..130 {
        tokio::fs::write(
            Path::new(&f.logs).join(name(i)),
            if i == 129 {
                f.line("on_message_session_start", json!({}), 10)
                    + &f.line("on_message_session_end", json!({}), 3000)
            } else {
                String::new()
            },
        )
        .await
        .unwrap();
    }
    let input = Fixture::make(
        &f.root,
        &f.logs,
        f.store.clone(),
        Some(DoubaoWorkBudgetOptions {
            milliseconds: 2,
            ..Default::default()
        }),
    );
    let mut entries = Vec::new();
    for _ in 0..512 {
        entries.extend(poll(&input).await);
        if !entries.is_empty() {
            break;
        }
    }
    assert_eq!(entries.len(), 2);
    let cp = f.checkpoint().await;
    assert_eq!(cp.files.len(), 128);
    assert!(!cp.files.contains_key(&name(1)));
    assert!(cp.files[&name(129)].offset > 0);
    for _ in 0..8 {
        assert!(poll(&input).await.is_empty());
    }
    tokio::fs::write(Path::new(&f.logs).join(name(130)), "")
        .await
        .unwrap();
    for _ in 0..512 {
        assert!(poll(&input).await.is_empty());
        if f.checkpoint().await.files.contains_key(&name(130)) {
            break;
        }
    }
    let cp = f.checkpoint().await;
    assert_eq!(cp.files.len(), 128);
    assert!(!cp.files.contains_key(&name(2)));
    assert!(cp.files.contains_key(&name(130)));
}

#[tokio::test]
async fn late_nested_tools_require_native_ancestry_survive_restart_and_reuse_distinct_trace() {
    let f = Fixture::new().await;
    f.append(
        &(f.line("on_message_sending_start", json!({}), 10)
            + &f.command("synthetic-turn", 50)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    assert_eq!(f.poll().await.len(), 2);
    f.append(
        &(f.command("s_nativeLeaf", 4000)
            + &f.command("o_nativeOrg", 4050)
            + &f.tool(json!({"agent_id":"s_nativeLeaf","tcid":"late-child"}), 5000)),
    )
    .await;
    assert!(f.poll().await.is_empty());
    let restored = f.fresh().await;
    let end = f.tool(
        json!({"toolCallID":"late-child","phase":"execution_settled","status":"success"}),
        6000,
    );
    f.append(&end).await;
    assert!(poll(&restored).await.is_empty());
    f.native_ancestry().await;
    let first = wire(&poll(&restored).await);
    assert_eq!(first.as_array().unwrap().len(), 2);
    assert_eq!(first[0]["event.name"], "tool.call");
    assert_eq!(first[1]["event.name"], "tool.result");
    assert!(first
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["loongsuite.doubao_work.trace_role"] == "log_only"
            && e.get("gen_ai.turn.start").is_none()
            && e.get("gen_ai.turn.end").is_none()));
    assert_eq!(first[0]["gen_ai.agent.id"], "s_nativeLeaf");
    assert_eq!(
        first[0]["loongsuite.doubao_work.native_creator_agent_id"],
        "o_nativeOrg"
    );
    assert_eq!(
        first[1]["time_unix_nano"],
        (i128::from(f.epoch + 6000) * 1_000_000 + 123_000).to_string()
    );
    f.append(&(f.tool(json!({"agent_id":"s_nativeLeaf","tcid":"late-child"}), 5000) + &end))
        .await;
    assert!(poll(&restored).await.is_empty());
    let command = |actor: &str, offset| {
        f.command(actor, offset)
            .replace("synthetic-sandbox", "reuse-sandbox")
    };
    f.append(&(f.line("on_message_sending_start",json!({"chat_session_id":"reuse-root"}),7000)+&command("reuse-root",7050)+&f.line("on_message_session_end",json!({"chat_session_id":"reuse-root"}),8000)+&command("s_nativeLeaf",9000)+&command("o_nativeOrg",9050)+&f.tool(json!({"agent_id":"s_nativeLeaf","sandbox_id":"reuse-sandbox","tcid":"reuse-tool"}),9100)+&f.tool(json!({"sandbox_id":"reuse-sandbox","toolCallID":"reuse-tool","phase":"execution_settled","status":"success"}),9200))).await;
    let reused = wire(&poll(&restored).await);
    assert_eq!(reused.as_array().unwrap().len(), 4);
    let child = reused
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["loongsuite.doubao_work.trace_role"] == "log_only")
        .unwrap();
    assert_eq!(child["gen_ai.agent.id"], first[0]["gen_ai.agent.id"]);
    assert_ne!(child["trace_id"], first[0]["trace_id"]);
    assert_ne!(
        child["loongsuite.doubao_work.root_turn_id"],
        first[0]["loongsuite.doubao_work.root_turn_id"]
    );
}
#[tokio::test]
async fn sandbox_with_two_root_actors_never_assigns_child_tools_or_executions() {
    let f = Fixture::new().await;
    f.native_ancestry().await;
    f.execution(false).await;
    f.append(&(f.line("on_message_sending_start",json!({}),10)+&f.command("synthetic-turn",50)+&f.command("unidentified-root",60)+&f.command("s_nativeLeaf",70)+&f.tool(json!({"agent_id":"s_nativeLeaf"}),100)+&f.tool(json!({"toolCallID":"synthetic-call","phase":"execution_settled","status":"success"}),200)+&f.line("on_message_session_end",json!({}),10_000))).await;
    let events = wire(&f.poll().await);
    assert_eq!(events.as_array().unwrap().len(), 2);
    assert!(!js_encode(&events).contains("local_execution_phase"));
    assert!(!js_encode(&events).contains("\"gen_ai.agent.scope\":\"subagent\""));
}
#[tokio::test]
async fn unavailable_conversation_does_not_starve_different_valid_child_at_one_scan_per_cycle() {
    let f = Fixture::new().await;
    f.native_ancestry().await;
    tokio::fs::rename(
        f.root.path().join("native/12345678"),
        f.root.path().join("native/valid-conversation"),
    )
    .await
    .unwrap();
    let mut source = String::new();
    for (index, conversation) in ["missing-conversation", "valid-conversation"]
        .iter()
        .enumerate()
    {
        let actor = format!("root-{index}");
        let sandbox = format!("box-{index}");
        let command = |who: &str, offset| {
            f.command(who, offset)
                .replace("synthetic-sandbox", &sandbox)
        };
        let meta = json!({"chat_session_id":actor,"conversation_id":conversation});
        source+=&(f.line("on_message_sending_start",meta.clone(),10+index as i64)+&command(&actor,20+index as i64)+&command("o_nativeOrg",30+index as i64)+&command("s_nativeLeaf",40+index as i64)+&f.line("on_message_session_end",meta,3000)+&f.tool(json!({"agent_id":"s_nativeLeaf","sandbox_id":sandbox,"tcid":format!("tool-{index}")}),4000)+&f.tool(json!({"sandbox_id":sandbox,"toolCallID":format!("tool-{index}"),"phase":"execution_settled","status":"success"}),5000));
    }
    f.append(&source).await;
    assert_eq!(f.poll().await.len(), 4);
    let child = wire(&f.poll().await);
    assert_eq!(child.as_array().unwrap().len(), 2);
    assert!(child
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["loongsuite.doubao_work.trace_role"] == "log_only"
            && e["gen_ai.session.id"] == "valid-conversation"));
}
#[tokio::test]
async fn parent_write_status_controls_restart_grace_and_late_parent_links_exact_native_lifetime() {
    for status in ["success", "error", "cancelled"] {
        let f = Fixture::new().await;
        f.native_ancestry().await;
        let child = f.execution(false).await;
        f.append(&(f.line("on_message_session_start",json!({}),10)+&f.command("synthetic-turn",50)+&f.command("o_nativeOrg",100)+&f.command("s_nativeLeaf",200)+&f.tool(json!({"agent_id":"o_nativeOrg","name":"Write","tcid":"parent-mutation"}),1000)+&f.tool(json!({"name":"Write","toolCallID":"parent-mutation","phase":"execution_settled","status":status}),2000)+&f.line("on_message_session_end",json!({}),10_000))).await;
        assert!(!js_encode(&wire(&f.poll().await)).contains("local_execution_phase"));
        let mut checkpoint = f.checkpoint().await;
        checkpoint
            .execution_first_seen
            .set(child.execution_key.clone(), now_ms() - 90_000);
        f.replace_checkpoint(&checkpoint);
        let resumed = f.fresh().await;
        let after = wire(&poll(&resumed).await);
        if status != "success" {
            assert_eq!(after.as_array().unwrap().len(), 2);
            assert_eq!(
                after[0]["loongsuite.doubao_work.parent_resolution"],
                "root_request_ancestor"
            );
            assert!(after[0]
                .get("loongsuite.doubao_work.native_parent_execution_id")
                .is_none());
            continue;
        }
        assert!(after.as_array().unwrap().is_empty());
        let mut parent = child.clone();
        parent.execution_key = "00000000-0000-4000-8000-000000000003".into();
        parent.agent_id = "o_nativeOrg".into();
        parent.agent_type = "organizer".into();
        parent.started_at_ms = f.epoch + 900;
        parent.ended_at_ms = f.epoch + 5000;
        let folder = f
            .root
            .path()
            .join("snapshots/123/12345678")
            .join(&parent.execution_key);
        tokio::fs::create_dir_all(&folder).await.unwrap();
        tokio::fs::write(
            folder.join("o_nativeOrg.json"),
            js_encode(&json!({"execution":parent})),
        )
        .await
        .unwrap();
        let events = wire(&poll(&resumed).await);
        assert_eq!(events.as_array().unwrap().len(), 4);
        let find = |actor: &str| {
            events
                .as_array()
                .unwrap()
                .iter()
                .find(|e| {
                    e["gen_ai.agent.id"] == actor
                        && e["loongsuite.doubao_work.local_execution_phase"] == "start"
                })
                .unwrap()
        };
        let child_start = find("s_nativeLeaf");
        let parent_start = find("o_nativeOrg");
        assert_eq!(
            child_start["parent_span_id"],
            parent_start["loongsuite.doubao_work.local_execution_span_id"]
        );
        assert_eq!(
            child_start["loongsuite.doubao_work.native_parent_execution_id"],
            parent.execution_key
        );
        assert_eq!(child_start["time_unix_nano"], ms_nanos(child.started_at_ms));
        assert!(poll(&resumed).await.is_empty());
    }
}
#[tokio::test]
async fn late_complete_snapshot_recovers_after_restart_and_conflicting_rewrite_never_reexports() {
    let f = Fixture::new().await;
    f.native_ancestry().await;
    let execution = f.execution(false).await;
    let metadata = f
        .root
        .path()
        .join("snapshots/123/12345678")
        .join(&execution.execution_key)
        .join("s_nativeLeaf.json");
    tokio::fs::write(&metadata, "{half").await.unwrap();
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.command("synthetic-turn", 50)
            + &f.command("s_nativeLeaf", 200)
            + &f.line("on_message_session_end", json!({}), 10_000)),
    )
    .await;
    assert_eq!(f.poll().await.len(), 2);
    let resumed = f.fresh().await;
    let mut incomplete = serde_json::to_value(&execution).unwrap();
    incomplete.as_object_mut().unwrap().remove("endedAtMs");
    tokio::fs::write(&metadata, js_encode(&json!({"execution":incomplete})))
        .await
        .unwrap();
    assert!(poll(&resumed).await.is_empty());
    tokio::fs::write(
        &metadata,
        js_encode(&json!({"execution":execution,"fileContents":"SYNTHETIC_PRIVATE"})),
    )
    .await
    .unwrap();
    assert!(poll(&resumed).await.is_empty());
    let mut cp: Checkpoint = serde_json::from_value(
        resumed.inner.runtime.state().extra().unwrap()["doubaoWork"].clone(),
    )
    .unwrap();
    cp.execution_first_seen
        .set(execution.execution_key.clone(), now_ms() - 30_001);
    resumed
        .inner
        .runtime
        .set_state_fields(None, None, Some(json!({"doubaoWork":cp})));
    let events = wire(&poll(&resumed).await);
    assert_eq!(events.as_array().unwrap().len(), 2);
    assert_eq!(
        events[0]["time_unix_nano"],
        ms_nanos(execution.started_at_ms)
    );
    assert_eq!(events[1]["time_unix_nano"], ms_nanos(execution.ended_at_ms));
    assert!(!js_encode(&events).contains("SYNTHETIC_PRIVATE"));
    assert!(poll(&resumed).await.is_empty());
    resumed.inner.runtime.state_store.save().await.unwrap();
    let fresh_store = Arc::new(StateStore::new(f.root.path().join("state.json")));
    fresh_store.load().await;
    let restarted = Fixture::make(&f.root, &f.logs, fresh_store, None);
    assert!(poll(&restarted).await.is_empty());
    let mut changed = execution;
    changed.ended_at_ms += 1;
    tokio::fs::write(&metadata, js_encode(&json!({"execution":changed})))
        .await
        .unwrap();
    assert!(poll(&resumed).await.is_empty());
    let install = Fixture::make(
        &f.root,
        &f.logs,
        Arc::new(StateStore::new(f.root.path().join("fresh-install.json"))),
        None,
    );
    assert!(poll(&install).await.is_empty());
    assert!(poll(&install).await.is_empty());
}
#[tokio::test]
async fn invalid_terminal_completion_cursor_survives_restart_without_starving_fifth_ready_turn() {
    for invalid_terminal in [true, false] {
        let f = Fixture::new().await;
        let mut source = String::new();
        for i in 0..4 {
            let meta = json!({"chat_session_id":format!("pending-{i}"),"conversation_id":"","send_local_message_id":format!("pending-message-{i}")});
            source += &f.line("on_message_session_start", meta.clone(), 10 + i);
            if invalid_terminal {
                source += &f.line("on_message_session_end", meta, 100 + i)
            }
        }
        source += &f.line(
            "on_message_session_start",
            json!({"chat_session_id":"ready"}),
            200,
        );
        source += &f.line(
            "on_message_session_end",
            json!({"chat_session_id":"ready"}),
            300,
        );
        f.append(&source).await;
        let mut entries = f.poll().await;
        let restored = f.fresh().await;
        entries.extend(poll(&restored).await);
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .all(|e| e.turn_id.as_deref() == Some("ready")));
        let cp: Checkpoint = serde_json::from_value(
            restored.inner.runtime.state().extra().unwrap()["doubaoWork"].clone(),
        )
        .unwrap();
        assert_eq!(cp.pending.len(), 4);
        assert!(poll(&restored).await.is_empty());
    }
}
#[tokio::test]
async fn large_unchanged_checkpoint_does_not_clone_branches_rewrite_disk_or_mutate_retained_expiry_snapshot(
) {
    let f = Fixture::new().await;
    let now = now_ms();
    let mut cp = f.checkpoint().await;
    for i in 0..4096 {
        let key = format!("{i:064x}");
        cp.completed.set(key.clone(), now);
        cp.native_completed.set(key.clone(), now);
        cp.executions_completed.set(
            key.clone(),
            CompletedExecution {
                digest: key,
                updated_ms: now,
            },
        );
    }
    f.replace_checkpoint(&cp);
    assert!(f.poll().await.is_empty());
    f.store.save().await.unwrap();
    let state_file = f.root.path().join("state.json");
    let before = tokio::fs::read(&state_file).await.unwrap();
    let metadata = tokio::fs::metadata(&state_file).await.unwrap();
    let modified = metadata.modified().unwrap();
    let revision = f.store.revision();
    let saved = f
        .input
        .inner
        .body
        .state
        .lock()
        .await
        .committed
        .as_ref()
        .unwrap()
        .clone();
    for _ in 0..10 {
        assert!(f.poll().await.is_empty());
        f.store.save().await.unwrap();
    }
    assert_eq!(f.store.revision(), revision);
    assert_eq!(tokio::fs::read(&state_file).await.unwrap(), before);
    assert_eq!(
        tokio::fs::metadata(&state_file)
            .await
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert!(f
        .input
        .inner
        .body
        .state
        .lock()
        .await
        .committed
        .as_ref()
        .unwrap()
        .unchanged(&saved));
    let mut expired = cp.clone();
    for i in 0..4096 {
        let key = format!("{i:064x}");
        expired.completed.set(key.clone(), now - 8 * 86_400_000);
        expired
            .native_completed
            .set(key.clone(), now - 8 * 86_400_000);
        expired.executions_completed.set(
            key.clone(),
            CompletedExecution {
                digest: key,
                updated_ms: now - 8 * 86_400_000,
            },
        );
    }
    f.replace_checkpoint(&expired);
    f.input.inner.body.state.lock().await.next_compaction = 0;
    assert!(f.poll().await.is_empty());
    let cleaned = f.checkpoint().await;
    assert!(cleaned.completed.is_empty());
    assert!(cleaned.native_completed.is_empty());
    assert!(cleaned.executions_completed.is_empty());
    assert_eq!(cp.completed.len(), 4096);
    assert_eq!(saved.executions_completed.len(), 4096);
}

#[tokio::test]
async fn native_metadata_interval_caps_scans_independently_of_repeated_log_polls() {
    let f = Fixture::new().await;
    let input = DoubaoWorkInput::new(DoubaoWorkInputOptions {
        log_dir: Some(f.logs.clone()),
        sessions_root: Some(f.root.path().join("native").to_string_lossy().into_owned()),
        snapshot_root: Some(
            f.root
                .path()
                .join("snapshots")
                .to_string_lossy()
                .into_owned(),
        ),
        native_scan_interval_ms: Some(10_000),
        work_budget: Some(DoubaoWorkBudgetOptions {
            milliseconds: 1000,
            ..Default::default()
        }),
        ..DoubaoWorkInputOptions::new(f.store.clone())
    });
    f.append(
        &(f.line("on_message_session_start", json!({}), 10)
            + &f.line("on_message_session_end", json!({}), 3000)),
    )
    .await;
    assert_eq!(poll(&input).await.len(), 2);
    assert_eq!(
        input
            .inner
            .body
            .state
            .lock()
            .await
            .reader
            .execution_scan_count(),
        1
    );
    for _ in 0..20 {
        assert!(poll(&input).await.is_empty());
    }
    assert_eq!(
        input
            .inner
            .body
            .state
            .lock()
            .await
            .reader
            .execution_scan_count(),
        1
    );
    input.inner.body.state.lock().await.next_native_scan = Some(Instant::now());
    assert!(poll(&input).await.is_empty());
    assert_eq!(
        input
            .inner
            .body
            .state
            .lock()
            .await
            .reader
            .execution_scan_count(),
        2
    );
}
#[tokio::test]
async fn valid_read_buffer_is_not_oversized_when_deadline_expires_during_the_read() {
    let f = Fixture::new().await;
    let start = f.line("on_message_session_start", json!({}), 10);
    let source = start.clone()
        + &"unrelated diagnostic row\n".repeat(50_000)
        + &f.line("on_message_session_end", json!({}), 3000);
    f.append(&source).await;
    f.input.inner.body.state.lock().await.expire_log_read = Some(READ_BYTES);
    assert!(f.poll().await.is_empty());
    let cp = f.checkpoint().await;
    let cursor = cp.files.values().next().unwrap();
    assert_eq!(cursor.offset, start.len() as u64);
    assert!(!cursor.skipping_line);
    let mut events = Vec::new();
    for _ in 0..5 {
        events.extend(f.poll().await);
        if !events.is_empty() {
            break;
        }
    }
    assert_eq!(events.len(), 2);
    assert_eq!(
        f.checkpoint().await.files.values().next().unwrap().offset,
        source.len() as u64
    );
}

#[tokio::test]
async fn tiny_initial_budget_resumes_the_same_historical_floor_snapshot_then_collects_only_new_tail(
) {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    tokio::fs::create_dir(&logs).await.unwrap();
    let store = Arc::new(StateStore::new(root.path().join("state.json")));
    let epoch = now_ms() + 1000;
    let date = chrono::Local.timestamp_millis_opt(epoch).single().unwrap();
    let name = |i| {
        format!(
            "saman_frontend_{}.{:02}{:02}.{i}.log",
            date.year(),
            date.month(),
            date.day()
        )
    };
    let file = logs.join(name(129));
    let log_text = logs.to_string_lossy().into_owned();
    let input = Fixture::make(
        &root,
        &log_text,
        store.clone(),
        Some(DoubaoWorkBudgetOptions {
            milliseconds: 2,
            ..Default::default()
        }),
    );
    let mut fixture = Fixture {
        root,
        logs: log_text,
        file,
        store,
        input,
        epoch,
    };
    let history = fixture.line(
        "on_message_session_start",
        json!({"chat_session_id":"historical"}),
        10,
    ) + &fixture.line(
        "on_message_session_end",
        json!({"chat_session_id":"historical"}),
        3000,
    );
    for i in 0..130 {
        tokio::fs::write(Path::new(&fixture.logs).join(name(i)), &history)
            .await
            .unwrap();
    }
    for _ in 0..512 {
        assert!(fixture.poll().await.is_empty());
        if fixture.store.get("doubao-work").extra().is_some() {
            break;
        }
    }
    let cp = fixture.checkpoint().await;
    assert_eq!(cp.files.len(), 128);
    assert!(cp
        .files
        .values()
        .all(|cursor| cursor.offset == history.len() as u64));
    fixture.epoch = now_ms() + 1000;
    let fresh = fixture.line(
        "on_message_session_start",
        json!({"chat_session_id":"new-tail"}),
        4000,
    ) + &fixture.line(
        "on_message_session_end",
        json!({"chat_session_id":"new-tail"}),
        7000,
    );
    fixture.append(&fresh).await;
    let mut entries = Vec::new();
    for _ in 0..512 {
        entries.extend(fixture.poll().await);
        if !entries.is_empty() {
            break;
        }
    }
    assert_eq!(
        entries.len(),
        2,
        "since={} query={} pending={} offset={} expected={}",
        fixture.checkpoint().await.since_ms,
        fixture.epoch,
        fixture.checkpoint().await.pending.len(),
        fixture
            .checkpoint()
            .await
            .files
            .values()
            .map(|c| c.offset)
            .max()
            .unwrap_or(0),
        history.len() + fresh.len()
    );
    assert!(entries
        .iter()
        .all(|e| e.turn_id.as_deref() == Some("new-tail")));
    assert!(fixture
        .checkpoint()
        .await
        .files
        .values()
        .any(|cursor| cursor.offset == (history.len() + fresh.len()) as u64));
}

#[tokio::test]
async fn doubao_app_pairs_windows_dispatcher_and_recovers_without_replay_on_switch_back() {
    let f = Fixture::new().await;
    let make = |client, store| {
        DoubaoWorkInput::new(DoubaoWorkInputOptions {
            client,
            log_dir: Some(f.logs.clone()),
            work_budget: Some(DoubaoWorkBudgetOptions {
                milliseconds: u64::MAX,
                ..Default::default()
            }),
            ..DoubaoWorkInputOptions::new(store)
        })
    };
    let start = |id| json!({"chat_session_id":id});
    // Existing Work state (including legacy state without a client tag) may
    // share a log override with the App. Its pending request must not migrate.
    f.append(&f.line("on_message_session_start", start("old-work"), 10))
        .await;
    assert!(f.poll().await.is_empty());
    let mut legacy = serde_json::to_value(f.checkpoint().await).unwrap();
    legacy.as_object_mut().unwrap().remove("client");
    f.store.update(
        "doubao-work",
        crate::checkpoints::InputStatePatch {
            extra: Some(json!({"doubaoWork":legacy})),
            ..Default::default()
        },
    );
    let app = make(DoubaoClient::App, f.store.clone());
    assert!(poll(&app).await.is_empty());
    assert!(f.checkpoint().await.pending.is_empty());
    assert_eq!(f.checkpoint().await.client, DoubaoClient::App);

    let windows = |s: String| {
        Regex::new(r"(\.\d{3})\d{3}:INFO:FRONTEND")
            .unwrap()
            .replace_all(&s, "$1:INFO:FRONTEND")
            .into_owned()
    };
    let header = chrono::Local.timestamp_millis_opt(f.epoch + 100).unwrap();
    let dispatcher = |status| {
        format!(
            r#"[100:200:{}:INFO:FRONTEND(0)] [neotix] "Event: agent_sandbox_toolcall_exec {}", source:  (0)"#,
            header.format("%m%d/%H%M%S.%3f"),
            json!({"agentId":"synthetic-turn","sandboxId":"synthetic-sandbox","toolCallID":"synthetic-call",
            "toolName":"Read","conversationId":"12345678","status":status,"delivery":"dispatcher",
            "isNewSse":true,"arguments":"synthetic-private-argument"})
        )
    };
    let file_name = f.file.file_name().unwrap().to_str().unwrap();
    assert!(parse_doubao_log_line(&dispatcher("success"), file_name).is_none());
    let event = parse_doubao_log_line(&dispatcher("start"), file_name).unwrap();
    assert!(!serde_json::to_string(&event)
        .unwrap()
        .contains("synthetic-private-argument"));
    assert_eq!(event.time_nano, ms_nanos(f.epoch + 100));
    f.append(
        &(windows(f.line("on_message_sending_start", json!({}), 20))
            + &dispatcher("start")
            + "\n"
            + &dispatcher("start")
            + "\n"
            + &dispatcher("success")
            + "\n"),
    )
    .await;
    assert!(poll(&app).await.is_empty());
    assert_eq!(
        f.checkpoint().await.sandboxes["synthetic-sandbox"].actors,
        ["synthetic-turn"]
    );
    f.store.save().await.unwrap();
    let reopened = Arc::new(StateStore::new(f.root.path().join("state.json")));
    reopened.load().await;
    let resumed = make(DoubaoClient::App, reopened.clone());
    f.append(&windows(
        f.tool(
            json!({"phase":"execution_settled","status":"success","toolCallID":"synthetic-call"}),
            125,
        ) + &f.line("on_message_session_end", json!({}), 3000),
    ))
    .await;
    let entries = wire(&poll(&resumed).await);
    let rows = entries.as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["event.name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["other", "tool.call", "tool.result", "other"]
    );
    assert!(rows
        .iter()
        .all(|row| row["loongsuite.doubao_work.client"] == "doubao"));
    assert_eq!(rows[2]["gen_ai.tool.call.duration"].as_f64(), Some(25.0));
    assert!(poll(&resumed).await.is_empty());
    let work = make(DoubaoClient::Work, reopened);
    assert!(poll(&work).await.is_empty());
    assert!(poll(&work).await.is_empty());
    // Same physical log and former Work ownership proof. Only this new turn
    // should be collected; the App request must not be replayed as Work.
    let next = json!({"chat_session_id":"new-work","query_send_timestamp":f.epoch+5000});
    f.append(
        &(f.line("on_message_session_start", next.clone(), 5010)
            + &f.line("on_message_session_end", next, 6000)),
    )
    .await;
    let entries = wire(&poll(&work).await);
    let rows = entries.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r["gen_ai.turn.id"] == "new-work"
        && r["loongsuite.doubao_work.client"] == "doubao-work"));
}
