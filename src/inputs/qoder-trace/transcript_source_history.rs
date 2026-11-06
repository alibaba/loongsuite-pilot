use super::super::prompt_ownership::NativeQoderPromptOwnershipResolver;
use super::*;
use std::io::Write;
use std::sync::atomic::AtomicI64;
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    key: String,
    agent: String,
    source: QoderTranscriptSource,
    state: Value,
    clock: Arc<AtomicI64>,
    nonce: u64,
}
fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(1793404800000 + ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn progress(name: &str, ms: i64) -> Value {
    json!({"type":"progress","timestamp":iso(ms),"data":{"hookEvent":name}})
}
fn turn(i: i64, tool: bool) -> Vec<Value> {
    let at = i * 10000;
    let mut rows = vec![
        progress("UserPromptSubmit", at),
        json!({"type":"user","uuid":format!("user-{i}"),"timestamp":iso(at+10),"message":{"role":"user","content":format!("prompt {i}")}}),
    ];
    if tool {
        rows.extend([json!({"type":"assistant","timestamp":iso(at+100),"message":{"id":format!("call-{i}"),"role":"assistant","model":"synthetic-model","content":[{"type":"tool_use","id":format!("tool-{i}"),"name":"Read","input":{"path":"test.txt"}}],"stop_reason":"tool_use"}}),progress("PreToolUse",at+120),json!({"type":"user","timestamp":iso(at+200),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("tool-{i}"),"content":"ok"}]}}),progress("PostToolUse",at+220)]);
    }
    rows.push(json!({"type":"assistant","uuid":format!("answer-{i}"),"timestamp":iso(at+300),"message":{"id":format!("response-{i}"),"role":"assistant","model":"synthetic-model","content":[{"type":"text","text":format!("answer {i}")}],"stop_reason":"end_turn"}}));
    rows.push(progress("Stop", at + 400));
    rows
}
fn jsonl(rows: &[Value]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for r in rows {
        serde_json::to_writer(&mut bytes, r).unwrap();
        bytes.push(b'\n')
    }
    bytes
}
fn count(rows: &[Value], name: &str) -> usize {
    rows.iter().filter(|r| r["event.name"] == name).count()
}
fn user_texts(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter(|r| r["event.name"] == "other")
        .flat_map(|r| {
            r.get("gen_ai.input.messages_delta")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .flat_map(|m| {
            m.get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|p| p.get("content").and_then(Value::as_str).map(str::to_owned))
        .collect()
}
fn unique(rows: &[Value]) {
    let ids = rows
        .iter()
        .map(|r| r["event.id"].as_str().unwrap())
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), rows.len());
}
// Use the same canonical Windows namespace as real wakeup descriptors.
fn fixture_native_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_str().expect("fixture UTF-8 path");
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path
}
impl Fixture {
    async fn new(agent: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = fixture_native_path(std::fs::canonicalize(dir.path()).unwrap());
        let file = root.join("native.jsonl");
        std::fs::write(&file, []).unwrap();
        let key = digest(&json!(["session", file.to_str().unwrap()]));
        let clock = Arc::new(AtomicI64::new(now()));
        let source = QoderTranscriptSource::new(
            root.clone(),
            agent.into(),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(Vec::new())),
        );
        let clone = Arc::clone(&clock);
        source.inner.lock().await.clock = Arc::new(move || clone.load(Ordering::SeqCst));
        Self {
            _dir: dir,
            root,
            file,
            key,
            agent: agent.into(),
            source,
            state: json!({}),
            clock,
            nonce: 0,
        }
    }
    fn write(&self, rows: &[Value]) {
        std::fs::write(&self.file, jsonl(rows)).unwrap()
    }
    fn append(&self, rows: &[Value]) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&self.file)
            .unwrap()
            .write_all(&jsonl(rows))
            .unwrap();
    }
    fn append_bytes(&self, bytes: &[u8]) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&self.file)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
    fn wake(&mut self, event: &str, extra: Value) {
        self.nonce += 1;
        let source_dir = self
            .root
            .join("state/qoder-transcripts")
            .join(&self.agent)
            .join("sources")
            .join(&self.key);
        let events = source_dir.join("events");
        std::fs::create_dir_all(&events).unwrap();
        let stat = scanner::version(&scanner::open_regular(&self.file).unwrap()).unwrap();
        let time = self.clock.load(Ordering::SeqCst);
        let mut value = json!({"schema":1,"key":self.key,"agentId":self.agent,"sessionId":"session","transcriptPath":self.file,"observedSize":stat.size,"observedAt":time,"event":event,"inode":stat.ino,"cwd":self.root,"observationId":format!("fixture-{}",self.nonce)});
        if let Some(extra) = extra.as_object() {
            value.as_object_mut().unwrap().extend(extra.clone())
        }
        let name = format!("{time}-{event}-{:024x}.json", self.nonce);
        with_qoder_wakeup_lock(&source_dir, 25, || {
            if !source_dir.join("source.json").exists() {
                std::fs::write(source_dir.join("source.json"), serde_json::to_vec(&value)?)?;
            }
            std::fs::write(events.join(name), serde_json::to_vec(&value)?)?;
            Ok(())
        })
        .unwrap()
        .unwrap();
    }
    async fn collect(&mut self) -> TranscriptBatch {
        let out = self.source.read(Some(&self.state), true).await.unwrap();
        self.state = out.state.clone();
        out
    }
    async fn settle(&mut self) -> Vec<Value> {
        let mut rows = self.collect().await.records;
        self.clock.fetch_add(6000, Ordering::SeqCst);
        rows.extend(self.collect().await.records);
        rows
    }
    async fn restart(&mut self) {
        self.source.stop();
        self.source = QoderTranscriptSource::new(
            self.root.clone(),
            self.agent.clone(),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(Vec::new())),
        );
        let c = Arc::clone(&self.clock);
        self.source.inner.lock().await.clock = Arc::new(move || c.load(Ordering::SeqCst));
        self.state = serde_json::from_slice(&serde_json::to_vec(&self.state).unwrap()).unwrap();
    }
}
#[tokio::test]
async fn source_l61_bootstrap_keeps_hook_anchored_and_all_later_queued_turns() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&[turn(0, false), turn(1, false)].concat());
        f.wake("Stop", json!({}));
        f.append(&[turn(2, true), turn(3, false)].concat());
        f.wake("Stop", json!({}));
        let rows = f.settle().await;
        assert_eq!(user_texts(&rows), ["prompt 1", "prompt 2", "prompt 3"]);
        unique(&rows);
        assert_eq!(
            rows.iter()
                .map(|r| r["gen_ai.turn.id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            3
        );
        assert_eq!(count(&rows, "tool.call"), 1);
        assert_eq!(count(&rows, "tool.result"), 1);
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn source_l75_l104_l162_late_progress_idle_and_restart() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, true);
        rows.insert(5, progress("UserPromptSubmit", 250));
        f.write(&rows);
        f.wake("Stop", json!({}));
        let first = f.settle().await;
        assert_eq!(user_texts(&first), ["prompt 0"]);
        assert_eq!(count(&first, "tool.call"), 1);
        assert_eq!(count(&first, "tool.result"), 1);
        assert!(first
            .iter()
            .map(|r| &r["gen_ai.turn.id"])
            .collect::<Vec<_>>()
            .windows(2)
            .all(|p| p[0] == p[1]));
        f.wake("Stop", json!({}));
        let idle = f.collect().await;
        assert!(idle.records.is_empty());
        // Legacy L104:C3 required 0B even after a fresh Stop. That projection
        // is superseded: an unresolved Stop must retry the bounded witness so
        // a same-version rewrite arriving after the notice cannot be lost.
        assert_eq!(idle.metrics.bytes_read, 256);
        f.restart().await;
        f.append(&turn(1, true));
        f.wake("Stop", json!({}));
        let next = f.settle().await;
        assert_eq!(user_texts(&next), ["prompt 1"]);
        assert_eq!(count(&next, "tool.call"), 1);
        assert_eq!(count(&next, "tool.result"), 1);
    }
}
#[tokio::test]
async fn source_l86_prompt_hook_before_new_row_does_not_replay_prior_turn() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        f.wake("UserPromptSubmit", json!({}));
        assert!(f.collect().await.records.is_empty());
        f.append(&turn(1, true));
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 1"]);
    }
}
#[tokio::test]
async fn source_l93_streams_across_late_progress_without_splitting_tools() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let rows = turn(0, true);
        f.write(&rows[..1]);
        f.wake("UserPromptSubmit", json!({}));
        f.append(&rows[1..5]);
        assert!(f.collect().await.records.is_empty());
        f.append(&[vec![progress("UserPromptSubmit", 210)], rows[5..].to_vec()].concat());
        f.wake("Stop", json!({}));
        let records = f.settle().await;
        assert_eq!(user_texts(&records), ["prompt 0"]);
        assert_eq!(count(&records, "llm.response"), 2);
        assert_eq!(count(&records, "tool.result"), 1);
    }
}
#[tokio::test]
async fn source_l113_l133_l152_cli_controls_do_not_create_turns_and_real_prompt_is_retained() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let control = "<command-message>exit</command-message>\n<command-name>/exit</command-name>";
        let exit = json!({"type":"user","entrypoint":"cli","timestamp":iso(250),"message":{"role":"user","content":control}});
        let mut rows = turn(0, true);
        rows.insert(rows.len() - 2, exit.clone());
        f.write(&rows);
        f.wake("Stop", json!({}));
        let first = f.settle().await;
        assert!(!serde_json::to_string(&first)
            .unwrap()
            .contains("command-name"));
        assert_eq!(count(&first, "llm.response"), 2);
        assert_eq!(user_texts(&first), ["prompt 0"]);
        assert_eq!(
            first
                .iter()
                .map(|r| r["gen_ai.turn.id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert_eq!(count(&first, "tool.call"), 1);
        assert_eq!(count(&first, "tool.result"), 1);
        f.append(&[exit.clone(), progress("SessionEnd", 600)]);
        f.wake("SessionEnd", json!({}));
        assert!(f.settle().await.is_empty());
        assert_eq!(
            number(&f.state[&f.key], "offset"),
            std::fs::metadata(&f.file).unwrap().len()
        );
        assert_eq!(f.collect().await.metrics.bytes_read, 0);
        f.restart().await;
        assert!(f.settle().await.is_empty());
        let mut next = turn(1, false);
        next[1]["entrypoint"] = json!("cli");
        next[1]["promptId"] = json!("real-submitted-prompt");
        next[1]["message"]["content"] = json!(control);
        f.append(&next);
        f.wake("Stop", json!({}));
        let records = f.settle().await;
        assert_eq!(user_texts(&records), [control]);
        assert_eq!(count(&records, "llm.response"), 1);
        let mut only = Fixture::new(agent).await;
        only.write(&[exit, progress("SessionEnd", 10)]);
        only.wake("SessionEnd", json!({}));
        assert!(only.settle().await.is_empty());
        only.append(&turn(1, false));
        only.wake("Stop", json!({}));
        assert_eq!(user_texts(&only.settle().await), ["prompt 1"]);
    }
}
#[tokio::test]
async fn source_l175_partial_final_record_retains_offset_then_recovers_suffix() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let rows = turn(0, false);
        f.write(&rows[..rows.len() - 2]);
        let last = rows[rows.len() - 2].to_string();
        f.append_bytes(&last.as_bytes()[..50]);
        f.wake("Stop", json!({}));
        assert!(f.collect().await.records.is_empty());
        assert!(number(&f.state[&f.key], "offset") < std::fs::metadata(&f.file).unwrap().len());
        f.append_bytes(&last.as_bytes()[50..]);
        f.append_bytes(b"\n");
        f.append(&rows[rows.len() - 1..]);
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 0"]);
    }
}
#[tokio::test]
async fn source_l188_late_model_output_after_stop_keeps_both_responses_and_tool() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let rows = turn(0, true);
        f.write(&rows[..rows.len() - 2]);
        f.append(&rows[rows.len() - 1..]);
        f.wake("Stop", json!({}));
        assert!(f.collect().await.records.is_empty());
        f.clock.fetch_add(1000, Ordering::SeqCst);
        f.append(&rows[rows.len() - 2..rows.len() - 1]);
        assert!(f.collect().await.records.is_empty());
        f.clock.fetch_add(6000, Ordering::SeqCst);
        let records = f.collect().await.records;
        assert_eq!(count(&records, "tool.call"), 1);
        assert_eq!(count(&records, "tool.result"), 1);
        assert_eq!(count(&records, "llm.response"), 2);
    }
}
#[tokio::test]
async fn source_l202_discarded_stage_replays_the_same_event_ids() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, false);
        rows.push(json!({"type":"last-prompt"}));
        f.write(&rows);
        f.wake("Stop", json!({}));
        let first = f.source.read(None, true).await.unwrap();
        let next = f.source.read(None, true).await.unwrap();
        assert!(!first.records.is_empty());
        assert_eq!(
            first
                .records
                .iter()
                .map(|r| &r["event.id"])
                .collect::<Vec<_>>(),
            next.records
                .iter()
                .map(|r| &r["event.id"])
                .collect::<Vec<_>>()
        );
    }
}
#[tokio::test]
async fn source_l239_complete_final_json_without_lf_is_recovered_once_after_stability() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let rows = turn(0, false);
        f.write(&rows[..rows.len() - 2]);
        f.append_bytes(rows[rows.len() - 2].to_string().as_bytes());
        f.wake("Stop", json!({}));
        assert!(f.collect().await.records.is_empty());
        f.clock.fetch_add(6000, Ordering::SeqCst);
        let records = f.settle().await;
        assert_eq!(user_texts(&records), ["prompt 0"]);
        assert_eq!(count(&records, "llm.response"), 1);
        let size = std::fs::metadata(&f.file).unwrap().len();
        assert_eq!(number(&f.state[&f.key], "committedOffset"), size);
        assert_eq!(number(&f.state[&f.key], "offset"), size);
        assert!(f.collect().await.records.is_empty());
    }
}

#[tokio::test]
async fn source_l278_unobserved_later_turn_does_not_inherit_invocation_identity() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        f.wake(
            "Stop",
            json!({"spanAttributes":{"gen_ai.session.id":"old-invocation"}}),
        );
        let first = f.settle().await;
        assert!(serde_json::to_string(&first)
            .unwrap()
            .contains("old-invocation"));
        f.collect().await;
        f.append(&turn(1, false));
        let next = f.settle().await;
        assert_eq!(user_texts(&next), ["prompt 1"]);
        assert!(!serde_json::to_string(&next)
            .unwrap()
            .contains("old-invocation"));
    }
}
#[tokio::test]
async fn source_l343_stop_prevents_reads_and_start_resumes_preserved_state() {
    let mut f = Fixture::new("qoder").await;
    f.write(&turn(0, false));
    f.wake("Stop", json!({}));
    let first = f.settle().await;
    assert_eq!(user_texts(&first), ["prompt 0"]);
    f.source.stop();
    f.append(&turn(1, false));
    f.wake("Stop", json!({}));
    let stopped = f.collect().await;
    assert!(stopped.records.is_empty());
    assert_eq!(stopped.metrics.bytes_read, 0);
    f.source.start();
    assert_eq!(user_texts(&f.settle().await), ["prompt 1"]);
}
#[tokio::test]
async fn source_l289_only_saved_completed_ranges_reclaim_notices_and_unsaved_state_does_not_read() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, false);
        rows.pop();
        rows.last_mut().unwrap()["message"]
            .as_object_mut()
            .unwrap()
            .remove("stop_reason");
        f.write(&rows);
        f.wake("PreToolUse", json!({}));
        assert!(f.collect().await.records.is_empty());
        f.collect().await;
        let events = f
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources")
            .join(&f.key)
            .join("events");
        assert_eq!(std::fs::read_dir(&events).unwrap().count(), 1);
        f.append(&[progress("Stop", 400)]);
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 0"]);
        let saved = f.state.clone();
        let before = std::fs::read_dir(&events).unwrap().count();
        let blocked = f.source.read(Some(&saved), false).await.unwrap();
        assert_eq!(blocked.state, saved);
        assert!(!blocked.changed);
        assert!(blocked.records.is_empty());
        assert_eq!(blocked.metrics.bytes_read, 0);
        assert!(blocked.metrics.reads.is_empty());
        assert_eq!(std::fs::read_dir(&events).unwrap().count(), before);
        f.collect().await;
        assert_eq!(std::fs::read_dir(&events).unwrap().count(), 0);
        assert!(events.parent().unwrap().join("source.json").exists());
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn source_l343_concurrent_calls_share_one_actual_collection_and_io_observations() {
    let mut f = Fixture::new("qoder").await;
    let mut rows = turn(0, true);
    rows.push(json!({"type":"last-prompt"}));
    f.write(&rows);
    f.wake("Stop", json!({}));
    let (a, b) = tokio::join!(f.source.read(None, true), f.source.read(None, true));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(user_texts(&a.records), ["prompt 0"]);
    assert_eq!(a.records, b.records);
    assert_eq!(f.source.completed.load(Ordering::SeqCst), 1);
    assert_eq!(
        a.metrics.bytes_read,
        a.metrics.reads.iter().map(|r| r.bytes).sum::<u64>()
    );
    assert!(a
        .metrics
        .reads
        .iter()
        .all(|r| r.duration_ms.is_finite() && r.duration_ms >= 0.0));
    assert_eq!(a.metrics.bytes_read, b.metrics.bytes_read);
    f.source.stop();
    let stopped = f.source.read(None, true).await.unwrap();
    assert!(stopped.records.is_empty());
    assert_eq!(stopped.metrics.bytes_read, 0);
    f.source.start();
    assert_eq!(
        user_texts(&f.source.read(None, true).await.unwrap().records),
        ["prompt 0"]
    );
}
#[cfg(unix)]
#[tokio::test]
async fn cli_identity_real_native_hook_status_cache_and_context_negative_controls() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new("qoder").await;
    let home = f.root.join("synthetic-home");
    let auth = home.join(".qoder/.auth/user");
    let cli = home.join(".qoder/bin/qodercli");
    std::fs::create_dir_all(auth.parent().unwrap()).unwrap();
    std::fs::create_dir_all(&cli).unwrap();
    std::fs::write(&auth, b"synthetic metadata only").unwrap();
    let exe = cli.join("qodercli-1.0.0");
    std::fs::write(
        &exe,
        br##"#!/bin/sh
printf x >> "$QODER_TEST_MARKER"
printf '%s' '{"logged_in":true,"username":"fixture-cli-user","email":"fixture-cli@example.invalid"}'
"##,
    )
    .unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
    let marker = f.root.join("status-called");
    let mut env = std::collections::HashMap::from([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
        (
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            f.root.to_string_lossy().into_owned(),
        ),
        (
            "QODER_TEST_MARKER".into(),
            marker.to_string_lossy().into_owned(),
        ),
    ]);
    let cli_turn = |index| {
        let mut rows = turn(index, false);
        rows[1]["entrypoint"] = json!("cli");
        rows.push(json!({"type":"last-prompt"}));
        rows
    };
    let publish = |file: &Path, env: &std::collections::HashMap<String, String>| {
        let input = serde_json::to_vec(&json!({
            "session_id":"session","transcript_path":file,"hook_event_name":"Stop",
            "parent_business_info":{"product":"cli","version":"1.0.0"}
        }))
        .unwrap();
        let args = vec![
            "--wakeup-only".into(),
            "--agent-id".into(),
            "qoder".into(),
            "--log-prefix".into(),
            "qoder".into(),
        ];
        let mut out = Vec::new();
        assert_eq!(
            crate::hook_process::dispatch(
                "qoder",
                false,
                &input,
                &args,
                env,
                &mut out,
                std::time::Instant::now()
            ),
            0
        );
        assert_eq!(out, b"{}\n");
    };
    f.write(&cli_turn(0));
    publish(&f.file, &env);
    let first = f.collect().await.records;
    assert!(!first.is_empty());
    assert!(first.iter().all(|r| r["user.name"] == "fixture-cli-user"
        && r["user.email"] == "fixture-cli@example.invalid"));
    assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    f.append(&cli_turn(1));
    publish(&f.file, &env);
    let cached = f.collect().await.records;
    assert!(!cached.is_empty());
    assert!(cached.iter().all(|r| r["user.name"] == "fixture-cli-user"));
    assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    for extra in [
        json!({"desktop":true}),
        json!({"userIdentity":{"name":"published-name"}}),
        json!({"userIdentity":{}}),
    ] {
        let mut negative = Fixture::new("qoder").await;
        negative.write(&cli_turn(0));
        negative.wake("Stop", extra.clone());
        let records = negative.collect().await.records;
        assert!(!records.is_empty());
        assert!(records.iter().all(|r| r["user.email"] == ""));
        let name = if extra.pointer("/userIdentity/name").is_some() {
            "published-name"
        } else {
            ""
        };
        assert!(records.iter().all(|r| r["user.name"] == name));
        assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    }
    let mut plain = Fixture::new("qoder").await;
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        plain.root.to_string_lossy().into_owned(),
    );
    let mut rows = turn(0, false);
    rows.push(json!({"type":"last-prompt"}));
    plain.write(&rows);
    plain.wake("Stop", json!({}));
    assert!(plain
        .collect()
        .await
        .records
        .iter()
        .all(|r| r["user.name"] == ""));
    assert_eq!(std::fs::read(&marker).unwrap(), b"x");
}

#[path = "transcript_source_tail_resource_history.rs"]
mod tail_resource_contracts;

#[path = "transcript_source_collector_remaining_history.rs"]
mod collector_remaining_contracts;

#[path = "transcript_source_migration_history.rs"]
mod migration_contracts;

#[path = "transcript_source_recovery_history.rs"]
mod review_recovery_contracts;

#[tokio::test]
async fn real_publisher_and_fixture_share_the_exact_canonical_checkpoint_key() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        let empty = Map::new();
        assert!(crate::hook_process::publish_qoder_wakeup(
            &json!({"session_id":"session","transcript_path":f.file,"hook_event_name":"Stop"}),
            &f.root,
            agent,
            None,
            &empty,
            &empty
        ));
        let descriptor = f
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources")
            .join(&f.key)
            .join("source.json");
        let source: Value = serde_json::from_slice(&std::fs::read(&descriptor).unwrap()).unwrap();
        assert_eq!(source["key"], f.key);
        assert_eq!(source["transcriptPath"], f.file.to_str().unwrap());
        assert_eq!(user_texts(&f.settle().await), ["prompt 0"]);
        assert!(f.state.get(&f.key).is_some());
        f.restart().await;
        assert!(f.collect().await.records.is_empty());
    }
}

#[path = "transcript_source_windows_history.rs"]
mod native_windows_generation_contracts;
