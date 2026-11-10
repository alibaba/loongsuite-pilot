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
        assert_eq!(
            crate::utils::source_access::read_dir(&events)
                .unwrap()
                .count(),
            1
        );
        f.append(&[progress("Stop", 400)]);
        f.wake("Stop", json!({}));
        assert_eq!(user_texts(&f.settle().await), ["prompt 0"]);
        let saved = f.state.clone();
        let before = crate::utils::source_access::read_dir(&events)
            .unwrap()
            .count();
        let blocked = f.source.read(Some(&saved), false).await.unwrap();
        assert_eq!(blocked.state, saved);
        assert!(!blocked.changed);
        assert!(blocked.records.is_empty());
        assert_eq!(blocked.metrics.bytes_read, 0);
        assert!(blocked.metrics.reads.is_empty());
        assert_eq!(
            crate::utils::source_access::read_dir(&events)
                .unwrap()
                .count(),
            before
        );
        f.collect().await;
        assert_eq!(
            crate::utils::source_access::read_dir(&events)
                .unwrap()
                .count(),
            0
        );
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

#[test]
fn source_shared_batch_payload_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<TranscriptBatch>();
    assert_send_sync::<Arc<TranscriptBatch>>();
}

#[tokio::test]
async fn source_shared_batch_concurrent_reads_share_the_actual_payload() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, true);
        rows.push(json!({"type":"last-prompt"}));
        f.write(&rows);
        f.wake("Stop", json!({}));
        let (a, b) = tokio::join!(
            f.source.read_shared(None, true),
            f.source.read_shared(None, true)
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert!(Arc::ptr_eq(&a, &b), "{agent}");
        assert_eq!(user_texts(&a.records), ["prompt 0"], "{agent}");
        assert_eq!(a.state, b.state, "{agent}");
        assert_eq!(a.metrics.bytes_read, b.metrics.bytes_read, "{agent}");
        assert_eq!(
            a.metrics.bytes_read,
            a.metrics.reads.iter().map(|read| read.bytes).sum::<u64>(),
            "{agent}"
        );
        assert_eq!(f.source.completed.load(Ordering::SeqCst), 1, "{agent}");
        f.source.stop();
    }
}

#[tokio::test]
async fn source_shared_batch_survives_stop_and_start_without_mutation() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, true);
        rows.push(json!({"type":"last-prompt"}));
        f.write(&rows);
        f.wake("Stop", json!({}));
        let held = f.source.read_shared(None, true).await.unwrap();
        assert!(!held.records.is_empty(), "{agent}");
        let original_records = held.records.clone();
        let original_state = held.state.clone();
        let original_bytes = held.metrics.bytes_read;
        let original_reads = held.metrics.reads.len();
        f.source.stop();
        assert!(f.source.inner.lock().await.last.is_none(), "{agent}");
        assert_eq!(held.records, original_records, "{agent}");
        assert_eq!(held.state, original_state, "{agent}");
        let stopped = f.source.read_shared(None, true).await.unwrap();
        assert!(stopped.records.is_empty(), "{agent}");
        assert_eq!(stopped.metrics.bytes_read, 0, "{agent}");
        assert!(!Arc::ptr_eq(&held, &stopped), "{agent}");
        f.source.start();
        let replay = f.source.read_shared(None, true).await.unwrap();
        assert!(!Arc::ptr_eq(&held, &replay), "{agent}");
        assert_eq!(
            held.records
                .iter()
                .map(|row| &row["event.id"])
                .collect::<Vec<_>>(),
            replay
                .records
                .iter()
                .map(|row| &row["event.id"])
                .collect::<Vec<_>>(),
            "{agent}"
        );
        assert_eq!(held.records, original_records, "{agent}");
        assert_eq!(held.state, original_state, "{agent}");
        assert_eq!(held.metrics.bytes_read, original_bytes, "{agent}");
        assert_eq!(held.metrics.reads.len(), original_reads, "{agent}");
        f.source.stop();
    }
}

#[tokio::test]
async fn source_shared_batch_public_read_retains_independent_owned_fields() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, true);
        rows.push(json!({"type":"last-prompt"}));
        f.write(&rows);
        f.wake("Stop", json!({}));
        let (owned, shared) =
            tokio::join!(f.source.read(None, true), f.source.read_shared(None, true));
        let (mut owned, shared) = (owned.unwrap(), shared.unwrap());
        assert_eq!(f.source.completed.load(Ordering::SeqCst), 1, "{agent}");
        assert!(!owned.records.is_empty(), "{agent}");
        assert_eq!(owned.records, shared.records, "{agent}");
        assert_eq!(owned.state, shared.state, "{agent}");
        let records_before = shared.records.clone();
        let state_before = shared.state.clone();
        let bytes_before = shared.metrics.bytes_read;
        let reads_before = shared.metrics.reads.len();
        owned.records[0]["owned-only-marker"] = json!(true);
        owned.state["owned-only-marker"] = json!(true);
        owned.metrics.bytes_read = u64::MAX;
        owned.metrics.reads.clear();
        assert_eq!(shared.records, records_before, "{agent}");
        assert_eq!(shared.state, state_before, "{agent}");
        assert_eq!(shared.metrics.bytes_read, bytes_before, "{agent}");
        assert_eq!(shared.metrics.reads.len(), reads_before, "{agent}");
        let TranscriptBatch { records, state, .. } = owned;
        assert_eq!(records[0]["owned-only-marker"], true, "{agent}");
        assert_eq!(state["owned-only-marker"], true, "{agent}");
        let collector = f.source.inner.lock().await;
        let cached = collector.last.as_ref().unwrap().2.as_ref().unwrap();
        assert!(Arc::ptr_eq(cached, &shared), "{agent}");
        assert_eq!(cached.records, records_before, "{agent}");
        drop(collector);
        f.source.stop();
    }
}

#[tokio::test]
async fn source_shared_batch_sequential_same_cursor_is_not_a_memoized_read() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut rows = turn(0, false);
        rows.push(json!({"type":"last-prompt"}));
        f.write(&rows);
        f.wake("Stop", json!({}));
        let first = f.source.read_shared(None, true).await.unwrap();
        let count_after_first = f.source.completed.load(Ordering::SeqCst);
        let second = f.source.read_shared(None, true).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second), "{agent}");
        assert_eq!(
            f.source.completed.load(Ordering::SeqCst),
            count_after_first + 1,
            "{agent}"
        );
        assert!(!second.records.is_empty(), "{agent}");
        assert_eq!(
            first
                .records
                .iter()
                .map(|row| &row["event.id"])
                .collect::<Vec<_>>(),
            second
                .records
                .iter()
                .map(|row| &row["event.id"])
                .collect::<Vec<_>>(),
            "{agent}"
        );
        f.source.stop();
    }
}

#[tokio::test]
async fn source_shared_batch_different_cursor_or_persistence_cannot_coalesce() {
    for agent in ["qoder", "qoder-cn"] {
        for only_state_differs in [true, false] {
            let mut f = Fixture::new(agent).await;
            let mut rows = turn(0, false);
            rows.push(json!({"type":"last-prompt"}));
            f.write(&rows);
            f.wake("Stop", json!({}));
            let unpersisted = json!({"unpersisted-marker": true});
            let next_state = only_state_differs.then_some(&unpersisted);
            let (first, second) = tokio::join!(
                f.source.read_shared(None, !only_state_differs),
                f.source.read_shared(next_state, false)
            );
            let (first, second) = (first.unwrap(), second.unwrap());
            assert!(!Arc::ptr_eq(&first, &second), "{agent}");
            assert!(!first.records.is_empty(), "{agent}");
            if only_state_differs {
                assert!(second.records.is_empty(), "{agent}");
                assert_eq!(second.state, unpersisted, "{agent}");
                assert!(!second.changed, "{agent}");
                assert_eq!(second.metrics.bytes_read, 0, "{agent}");
            } else {
                assert!(!second.records.is_empty(), "{agent}");
            }
            assert_eq!(f.source.completed.load(Ordering::SeqCst), 2, "{agent}");
            f.source.stop();
        }
    }
}

#[tokio::test]
async fn source_cycle_identity_empty_actual_collect_and_clear_discard_old_cache() {
    for agent in ["qoder", "qoder-cn"] {
        let f = Fixture::new(agent).await;
        let marker = "__pilot_identity_cache_must_not_survive_empty_collect__";
        f.source.inner.lock().await.cycle_runtime_user = Some(marker.to_owned());
        let empty = f.source.read_shared(None, true).await.unwrap();
        assert!(empty.records.is_empty(), "{agent}");
        assert!(
            f.source.inner.lock().await.cycle_runtime_user.is_none(),
            "empty actual collect must reset the old identity without resolving a new one: {agent}"
        );
        f.source.inner.lock().await.cycle_runtime_user = Some(marker.to_owned());
        f.source.stop();
        assert!(
            f.source.inner.lock().await.cycle_runtime_user.is_none(),
            "clear must discard the cached identity: {agent}"
        );
    }
}

#[tokio::test]
async fn source_cycle_identity_multi_turn_and_next_actual_collect_resolve_fresh_identity() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let mut first_rows = turn(0, false);
        first_rows.push(json!({"type":"last-prompt"}));
        f.write(&first_rows);
        f.wake("Stop", json!({}));
        assert!(!f.collect().await.records.is_empty(), "{agent}");

        let mut next_rows = [turn(1, false), turn(2, true)].concat();
        next_rows.push(json!({"type":"last-prompt"}));
        f.append(&next_rows);
        f.wake("Stop", json!({}));
        f.source.inner.lock().await.cycle_runtime_user =
            Some("__pilot_identity_cache_must_not_survive_multi_turn_collect__".to_owned());
        let expected = resolve_collected_qoder_user_id(&f.root);
        let batch = f.source.read_shared(Some(&f.state), true).await.unwrap();
        assert_eq!(
            user_texts(&batch.records),
            ["prompt 1", "prompt 2"],
            "{agent}"
        );
        assert!(
            batch
                .records
                .iter()
                .all(|record| record["user.id"].as_str() == Some(expected.as_str())),
            "all emitted turns must use the existing resolver's identity: {agent}"
        );
        assert_eq!(
            f.source.inner.lock().await.cycle_runtime_user.as_deref(),
            Some(expected.as_str()),
            "{agent}"
        );
        f.state = batch.state.clone();

        let mut final_rows = turn(3, false);
        final_rows.push(json!({"type":"last-prompt"}));
        f.append(&final_rows);
        f.wake("Stop", json!({}));
        f.source.inner.lock().await.cycle_runtime_user =
            Some("__pilot_identity_cache_must_not_survive_next_collect__".to_owned());
        let next_expected = resolve_collected_qoder_user_id(&f.root);
        let next = f.source.read_shared(Some(&f.state), true).await.unwrap();
        assert_eq!(user_texts(&next.records), ["prompt 3"], "{agent}");
        assert!(
            next.records
                .iter()
                .all(|record| record["user.id"].as_str() == Some(next_expected.as_str())),
            "the next actual collect must not reuse the injected old identity: {agent}"
        );
        assert_eq!(
            f.source.inner.lock().await.cycle_runtime_user.as_deref(),
            Some(next_expected.as_str()),
            "{agent}"
        );
        f.source.stop();
    }
}

// SCRATCH ONLY: append inside the existing transcript_source_history module.
// Uses its Fixture; no new dependency or production freshness/cache path.
// Not compiled or executed locally. Parent owns actual remote gates.

fn arc_metadata_json(source: &Arc<Value>, contexts: &[Arc<Value>]) -> Vec<u8> {
    let references = contexts.iter().map(Arc::as_ref).collect::<Vec<_>>();
    serde_json::to_vec(&(source.as_ref(), references)).unwrap()
}

#[tokio::test]
async fn source_metadata_arc_hit_preserves_pointer_identity_and_unknown_json() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, true));
        let unknown = json!({"nested":{"unicode":"云壳😀", "escaped":"quote\"\\\n", "array":[null,false,18446744073709551615u64]}});
        f.wake("Stop", json!({"unknown_extension":unknown}));
        let directory = f
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources")
            .join(&f.key);
        let mut inner = f.source.inner.lock().await;
        let (first_source, first_contexts) = inner.metadata_for(&directory).unwrap();
        let (second_source, second_contexts) = inner.metadata_for(&directory).unwrap();
        assert!(Arc::ptr_eq(&first_source, &second_source), "{agent}");
        assert_eq!(first_contexts.len(), 2, "source and one notice: {agent}");
        assert_eq!(first_contexts.len(), second_contexts.len(), "{agent}");
        let cache = inner
            .metadata
            .get(&directory)
            .expect("small entry remains cached");
        assert!(Arc::ptr_eq(&first_source, &cache.source), "{agent}");
        for ((first, second), cached) in first_contexts
            .iter()
            .zip(&second_contexts)
            .zip(&cache.contexts)
        {
            assert!(
                Arc::ptr_eq(first, second) && Arc::ptr_eq(first, cached),
                "{agent}"
            );
            assert_eq!(first["unknown_extension"], unknown, "{agent}");
        }
        assert!(
            first_contexts.iter().any(|v| Arc::ptr_eq(v, &first_source)),
            "source Value must be shared, not copied: {agent}"
        );
        // The old Value-based serialization oracle includes source twice and the
        // normalized notice receipt, preserving all unknown nested fields.
        let values = first_contexts
            .iter()
            .map(|v| v.as_ref().clone())
            .collect::<Vec<_>>();
        let oracle = serde_json::to_vec(&(first_source.as_ref().clone(), values)).unwrap();
        assert_eq!(
            arc_metadata_json(&first_source, &first_contexts),
            oracle,
            "{agent}"
        );
        assert_eq!(
            arc_metadata_json(&second_source, &second_contexts),
            oracle,
            "{agent}"
        );
    }
}

#[tokio::test]
async fn source_metadata_arc_survives_drop_stop_and_same_name_notice_generation() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        f.wake("Stop", json!({"unknown_extension":{"generation":"old"}}));
        let directory = f
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources")
            .join(&f.key);
        let (held_source, held_contexts) = f
            .source
            .inner
            .lock()
            .await
            .metadata_for(&directory)
            .unwrap();
        let held_bytes = arc_metadata_json(&held_source, &held_contexts);
        {
            let mut inner = f.source.inner.lock().await;
            inner.drop_metadata(&directory);
            assert!(!inner.metadata.contains_key(&directory));
            assert_eq!(inner.metadata_bytes, 0);
        }
        assert_eq!(
            arc_metadata_json(&held_source, &held_contexts),
            held_bytes,
            "{agent}"
        );
        // Refill, then retain this cached snapshot while the real stop path clears.
        let (before_stop_source, before_stop_contexts) = f
            .source
            .inner
            .lock()
            .await
            .metadata_for(&directory)
            .unwrap();
        let before_stop_bytes = arc_metadata_json(&before_stop_source, &before_stop_contexts);
        f.source.stop();
        {
            let inner = f.source.inner.lock().await;
            assert!(inner.metadata.is_empty());
            assert_eq!(inner.metadata_bytes, 0);
        }
        assert_eq!(
            arc_metadata_json(&held_source, &held_contexts),
            held_bytes,
            "{agent}"
        );
        assert_eq!(
            arc_metadata_json(&before_stop_source, &before_stop_contexts),
            before_stop_bytes,
            "{agent}"
        );
        f.source.start();
        let (cached_source, cached_contexts) = f
            .source
            .inner
            .lock()
            .await
            .metadata_for(&directory)
            .unwrap();
        let cached_bytes = arc_metadata_json(&cached_source, &cached_contexts);
        let notice = std::fs::read_dir(directory.join("events"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let original_name = notice.file_name().unwrap().to_owned();
        let mut changed: Value = serde_json::from_slice(&std::fs::read(&notice).unwrap()).unwrap();
        // Existing DirectoryVersion notices must observe this same-name rewrite.
        // Different serialized length makes it deterministic without sleeps/mtime tricks.
        changed["unknown_extension"] =
            json!({"generation":"new-and-longer", "keep":["extra",{"nested":true}]});
        changed["observationId"] = json!("fixture-same-name-new-generation");
        std::fs::write(&notice, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert_eq!(notice.file_name().unwrap(), original_name.as_os_str());
        let (new_source, new_contexts) = f
            .source
            .inner
            .lock()
            .await
            .metadata_for(&directory)
            .unwrap();
        let new_notice = new_contexts
            .iter()
            .find(|v| v.get("receipt").is_some())
            .unwrap();
        let old_notice = cached_contexts
            .iter()
            .find(|v| v.get("receipt").is_some())
            .unwrap();
        assert_eq!(
            new_notice["unknown_extension"], changed["unknown_extension"],
            "{agent}"
        );
        assert_ne!(
            new_notice["receipt"]["version"], old_notice["receipt"]["version"],
            "{agent}"
        );
        assert!(
            !Arc::ptr_eq(new_notice, old_notice),
            "new notice generation must not reuse old Value: {agent}"
        );
        assert!(
            Arc::ptr_eq(&new_source, &cached_source),
            "unchanged source descriptor remains shared: {agent}"
        );
        assert_eq!(
            arc_metadata_json(&cached_source, &cached_contexts),
            cached_bytes,
            "{agent}"
        );
        assert_eq!(
            arc_metadata_json(&held_source, &held_contexts),
            held_bytes,
            "{agent}"
        );
        assert_eq!(
            arc_metadata_json(&before_stop_source, &before_stop_contexts),
            before_stop_bytes,
            "{agent}"
        );
        assert_ne!(
            arc_metadata_json(&new_source, &new_contexts),
            cached_bytes,
            "{agent}"
        );
        f.source.stop();
    }
}
// Parsed-notice reuse must preserve physical reads, generations, and scope checks.
fn notice_sha_context(contexts: &[Arc<Value>], name: &str) -> Arc<Value> {
    Arc::clone(
        contexts
            .iter()
            .find(|v| text(&v["receipt"], "name") == name)
            .unwrap(),
    )
}

#[tokio::test]
async fn source_notice_refresh_reuses_unchanged_arc_after_actual_read_and_charges_digest_slots() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, true));
        let unknown = json!({"nested":[null,false,{"unicode":"云壳😀"}],"keep":"payload"});
        f.wake("Stop", json!({"unknown_extension":unknown}));
        let dir = f
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources")
            .join(&f.key);
        let file = std::fs::read_dir(dir.join("events"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let name = file.file_name().unwrap().to_str().unwrap().to_owned();
        let first = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
        let retained = notice_sha_context(&first, &name);
        let before = serde_json::to_vec(&retained).unwrap();
        f.wake(
            "Stop",
            json!({"unknown_extension":{"generation":"new notice"}}),
        );
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&reads);
        let expected_file = file.clone();
        let _guard = inject_metadata_read_fault(move |path| {
            if path == expected_file {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        let mut inner = f.source.inner.lock().await;
        let second = inner.metadata_for(&dir).unwrap().1;
        let current = notice_sha_context(&second, &name);
        assert!(
            reads.load(Ordering::SeqCst) > 0,
            "refresh must still complete physical snapshot read"
        );
        assert!(
            Arc::ptr_eq(&retained, &current),
            "same SHA/generation reuses payload: {agent}"
        );
        assert_eq!(current["unknown_extension"], unknown);
        assert_eq!(serde_json::to_vec(&retained).unwrap(), before);
        let added = second
            .iter()
            .find(|value| value.get("receipt").is_some() && text(&value["receipt"], "name") != name)
            .expect("new inventory notice was parsed");
        assert_eq!(added["unknown_extension"]["generation"], "new notice");
        assert!(!Arc::ptr_eq(added, &retained));
        let metadata = inner.metadata.get(&dir).unwrap();
        assert_eq!(metadata.contexts.len(), metadata.context_digests.len());
        let digest_charge = metadata.context_digests.capacity()
            * std::mem::size_of::<Option<[u8; 32]>>()
            + std::mem::size_of::<Vec<Option<[u8; 32]>>>();
        let refs = metadata
            .contexts
            .iter()
            .map(Arc::as_ref)
            .collect::<Vec<_>>();
        let payload =
            crate::utils::json_size::serialized_json_size(&(&*metadata.source, refs)).unwrap();
        assert!(
            metadata.bytes >= payload + digest_charge,
            "digest capacity must be charged"
        );
        assert_eq!(
            inner.metadata_bytes,
            inner.metadata.values().map(|m| m.bytes).sum::<usize>()
        );
        assert!(inner.metadata_bytes <= MAX_METADATA_BYTES);
    }
}

#[tokio::test]
async fn source_notice_same_name_same_size_same_mtime_changed_payload_and_whitespace_reparse() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        f.write(&turn(0, false));
        f.wake("Stop", json!({"unknown_extension":{"generation":"old"}}));
        let dir = f
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources")
            .join(&f.key);
        let file = std::fs::read_dir(dir.join("events"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let name = file.file_name().unwrap().to_str().unwrap().to_owned();
        let first = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
        let old = notice_sha_context(&first, &name);
        let before = std::fs::read(&file).unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        let mut value: Value = serde_json::from_slice(&before).unwrap();
        value["unknown_extension"]["generation"] = json!("new");
        let changed = serde_json::to_vec(&value).unwrap();
        assert_eq!(changed.len(), before.len());
        std::fs::write(&file, &changed).unwrap();
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().modified().unwrap(),
            modified
        );
        // Force an inventory generation change independently of filesystem
        // timestamp precision, so this actually exercises per-notice reuse.
        f.wake("Stop", json!({}));
        let second = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
        let new = notice_sha_context(&second, &name);
        assert_eq!(
            old["receipt"]["version"], new["receipt"]["version"],
            "observationId unchanged"
        );
        assert!(
            !Arc::ptr_eq(&old, &new),
            "same receipt generation cannot hide changed content SHA"
        );
        assert_eq!(new["unknown_extension"]["generation"], "new");
        assert_eq!(old["unknown_extension"]["generation"], "old");
        // Equal JSON but changed physical bytes is conservative: parse again.
        std::fs::write(&file, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        f.wake("Stop", json!({}));
        let third = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
        let whitespace = notice_sha_context(&third, &name);
        assert_eq!(&*whitespace, &*new);
        assert!(
            !Arc::ptr_eq(&whitespace, &new),
            "digest identity is not semantic JSON equality"
        );
        // A publication immediately after the read retains the snapshot just
        // read, then must be observed at the next forced inventory refresh.
        let mut late = value.clone();
        late["unknown_extension"]["after_read"] = json!(true);
        let late_bytes = serde_json::to_vec(&late).unwrap();
        let expected_file = file.clone();
        let mut replaced = false;
        let fault = inject_metadata_read_fault(move |path| {
            if path == expected_file && !replaced {
                std::fs::write(path, &late_bytes).unwrap();
                replaced = true;
            }
        });
        f.wake("Stop", json!({}));
        let during = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
        assert_eq!(&*notice_sha_context(&during, &name), &*whitespace);
        drop(fault);
        f.wake("Stop", json!({}));
        let after = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
        let published = notice_sha_context(&after, &name);
        assert_eq!(published["unknown_extension"]["after_read"], true);
        assert!(whitespace["unknown_extension"].get("after_read").is_none());
        assert!(!Arc::ptr_eq(&published, &whitespace));
    }
}

#[tokio::test]
async fn source_notice_same_bytes_new_stat_generation_cannot_reuse_old_receipt() {
    let mut f = Fixture::new("qoder").await;
    f.write(&turn(0, false));
    f.wake("Stop", json!({}));
    let dir = f
        .root
        .join("state/qoder-transcripts/qoder/sources")
        .join(&f.key);
    let file = std::fs::read_dir(dir.join("events"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let name = file.file_name().unwrap().to_str().unwrap().to_owned();
    let mut value: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("observationId");
    std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    let first = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
    let old = notice_sha_context(&first, &name);
    let bytes = std::fs::read(&file).unwrap();
    let modified =
        std::fs::metadata(&file).unwrap().modified().unwrap() + std::time::Duration::from_secs(1);
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&file)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    f.wake("Stop", json!({}));
    let second = f.source.inner.lock().await.metadata_for(&dir).unwrap().1;
    let new = notice_sha_context(&second, &name);
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    assert_ne!(old["receipt"]["version"], new["receipt"]["version"]);
    assert!(
        !Arc::ptr_eq(&old, &new),
        "same SHA cannot reuse a different stat receipt generation"
    );
    #[cfg(unix)]
    notice_sha_scope_guard_case().await;
}

#[cfg(unix)]
async fn notice_sha_scope_guard_case() {
    use crate::utils::source_access::{current, install, SourceScope};
    struct Restore(Option<Arc<SourceScope>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            install(self.0.take());
        }
    }
    let mut f = Fixture::new("qoder").await;
    f.write(&turn(0, false));
    f.wake("Stop", json!({}));
    let dir = f
        .root
        .join("state/qoder-transcripts/qoder/sources")
        .join(&f.key);
    let file = std::fs::read_dir(dir.join("events"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    f.source.inner.lock().await.metadata_for(&dir).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("same.json");
    std::fs::write(&target, std::fs::read(&file).unwrap()).unwrap();
    f.wake("Stop", json!({}));
    let expected = file.clone();
    let _open_fault = scanner::inject_open_fault(move |path| {
        if path == expected
            && !std::fs::symlink_metadata(path)
                .unwrap()
                .file_type()
                .is_symlink()
        {
            std::fs::remove_file(path).unwrap();
            std::os::unix::fs::symlink(&target, path).unwrap();
        }
    });
    let mut inner = f.source.inner.lock().await;
    let _restore = Restore(current());
    install(Some(SourceScope::new(
        vec![f.root.clone()],
        1024,
        1024 * 1024,
    )));
    assert!(
        inner.metadata_for(&dir).is_err(),
        "cached digest must not bypass authorized-root/reparse verification"
    );
}
