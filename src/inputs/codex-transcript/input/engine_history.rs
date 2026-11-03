use super::*;
use crate::inputs::codex_transcript::{CodexTranscriptInput, CodexTranscriptInputOptions};
use std::sync::{Arc, Mutex};

fn isolated_fixture_root() -> Arc<tempfile::TempDir> {
    let canonical_temp =
        std::fs::canonicalize(std::env::temp_dir()).expect("canonical synthetic temp base");
    Arc::new(tempfile::tempdir_in(canonical_temp).expect("isolated native tempdir"))
}

struct Fixture {
    root: Arc<tempfile::TempDir>,
    input: CodexTranscriptInput,
    entries: Arc<Mutex<Vec<AgentActivityEntry>>>,
    batches: Arc<Mutex<Vec<usize>>>,
}
impl Fixture {
    fn new() -> Self {
        Self::with_root(isolated_fixture_root())
    }
    fn with_root(root: Arc<tempfile::TempDir>) -> Self {
        Self::with_root_options(root, None)
    }
    fn with_root_options(
        root: Arc<tempfile::TempDir>,
        multimodal: Option<crate::inputs::codex_transcript::CodexMultimodalOptions>,
    ) -> Self {
        let input = CodexTranscriptInput::new(CodexTranscriptInputOptions {
            state_store: Arc::new(crate::checkpoints::StateStore::new(
                root.path().join("state.json"),
            )),
            session_dir: Some(root.path().join("sessions").to_string_lossy().into_owned()),
            wakeup_dir: Some(root.path().join("wakeups").to_string_lossy().into_owned()),
            span_context_dir: Some(root.path().join("spans").to_string_lossy().into_owned()),
            poll_interval_ms: Some(60_000),
            multimodal,
        });
        let entries = Arc::new(Mutex::new(Vec::new()));
        let batches = Arc::new(Mutex::new(Vec::new()));
        let out = entries.clone();
        let sizes = batches.clone();
        input.on_entries(move |batch| {
            out.lock().expect("entries").extend_from_slice(batch);
            sizes.lock().expect("batches").push(batch.len());
        });
        Self {
            root,
            input,
            entries,
            batches,
        }
    }
    async fn append(&self, path: &str, text: &str) {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .await
            .expect("append open");
        file.write_all(text.as_bytes()).await.expect("append bytes");
        file.flush().await.expect("append durable visibility");
    }
    async fn restart(&self) -> Self {
        self.rt().state_store.save().await.expect("durable save");
        let next = Self::with_root(self.root.clone());
        next.rt().state_store.load().await;
        next
    }
    fn checkpoint(&self, path: &str) -> CodexTranscriptCheckpoint {
        self.engine()
            .read_checkpoint(self.rt(), &self.engine().state_key(path))
            .expect("native checkpoint")
    }
    fn engine(&self) -> CodexTranscriptEngine<'_> {
        CodexTranscriptEngine {
            body: &self.input.inner.body,
        }
    }
    fn rt(&self) -> &InputRuntime {
        &self.input.inner.runtime
    }
    async fn write(&self, name: &str, text: &str) -> String {
        // Node path.join in the source fixtures normalizes embedded separators
        // and parent components. Keep one native spelling for scans and state keys.
        let native_name: std::path::PathBuf = std::path::Path::new(name).components().collect();
        let joined = self.root.path().join("sessions").join(native_name);
        let p = std::path::PathBuf::from(
            crate::inputs::codex_transcript::discovery::lexical_absolute(&joined.to_string_lossy()),
        );
        tokio::fs::create_dir_all(p.parent().expect("parent"))
            .await
            .expect("dir");
        tokio::fs::write(&p, text).await.expect("fixture");
        p.to_string_lossy().into_owned()
    }
    async fn process(&self, path: &str) -> usize {
        self.engine()
            .process_file(self.rt(), path)
            .await
            .expect("production process")
    }
    fn records(&self) -> Vec<Value> {
        self.entries
            .lock()
            .expect("entries")
            .iter()
            .map(|e| serde_json::to_value(e).expect("entry"))
            .collect()
    }
    async fn marker(&self, folder: &str, name: &str, payload: Value) {
        let dir = self.root.path().join(folder);
        tokio::fs::create_dir_all(&dir).await.expect("marker dir");
        tokio::fs::write(dir.join(name), payload.to_string())
            .await
            .expect("marker");
    }
}
fn record(at: &str, kind: &str, payload: Value) -> String {
    json!({"timestamp":at,"type":kind,"payload":payload}).to_string()
}
fn header() -> Vec<String> {
    vec![
        record(
            "2026-06-24T06:00:00.000Z",
            "session_meta",
            json!({"id":"session-1","model_provider":"openai"}),
        ),
        record(
            "2026-06-24T06:00:01.000Z",
            "turn_context",
            json!({"turn_id":"turn-1","model":"gpt-5.5","cwd":"/tmp/project"}),
        ),
        record(
            "2026-06-24T06:00:02.000Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"turn-1"}),
        ),
        record(
            "2026-06-24T06:00:03.000Z",
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"fix it"}]}),
        ),
    ]
}
fn usage(input: u64, output: u64) -> Value {
    json!({"type":"token_count","info":{"last_token_usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":0,"reasoning_output_tokens":output-1,"total_tokens":input+output}}})
}
fn completed() -> String {
    let mut lines = header();
    lines.extend([
 record("2026-06-24T06:00:04.000Z","event_msg",json!({"type":"agent_message","message":"inspect the script first","phase":"commentary"})),
 record("2026-06-24T06:00:05.000Z","response_item",json!({"type":"function_call","id":"fc-1","call_id":"call-1","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"})),
 record("2026-06-24T06:00:06.000Z","response_item",json!({"type":"function_call_output","call_id":"call-1","output":"\"/tmp/project\""})),
 record("2026-06-24T06:00:06.000Z","event_msg",usage(100,10)),
 record("2026-06-24T06:00:07.000Z","event_msg",json!({"type":"agent_message","message":"apply the focused patch","phase":"commentary"})),
 record("2026-06-24T06:00:08.000Z","response_item",json!({"type":"custom_tool_call","call_id":"call-2","name":"apply_patch","input":"*** Begin Patch\n*** End Patch"})),
 record("2026-06-24T06:00:09.000Z","response_item",json!({"type":"custom_tool_call_output","call_id":"call-2","output":"Done"})),
 record("2026-06-24T06:00:09.000Z","event_msg",usage(120,12)),
 record("2026-06-24T06:00:10.000Z","event_msg",json!({"type":"agent_message","message":"fixed","phase":"final"})),
 record("2026-06-24T06:00:10.000Z","event_msg",usage(130,13)),
 record("2026-06-24T06:00:11.000Z","event_msg",json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"fixed"})),
 ]);
    lines.join("\n") + "\n"
}
fn events(records: &[Value], name: &str) -> Vec<Value> {
    records
        .iter()
        .filter(|e| e["event.name"] == name)
        .cloned()
        .collect()
}
fn timestamp(entry: &Value) -> u64 {
    entry["time_unix_nano"]
        .as_str()
        .expect("nanos")
        .parse::<u64>()
        .expect("nanos")
        / 1_000_000
}
fn meta(id: &str) -> CodexTranscriptMeta {
    let r = json!({"type":"session_meta","timestamp":"2026-06-24T06:00:00.000Z","payload":{"id":id,"model_provider":"openai"}});
    extract_codex_transcript_meta(r.as_object().expect("record")).expect("metadata")
}

#[tokio::test]
async fn wakeup_marker_makes_absent_default_available_and_preserves_both_watch_paths() {
    let f = Fixture::new();
    let home = f.root.path().join("home");
    let isolated = home.join("u/fixture/sessions");
    tokio::fs::create_dir_all(&isolated)
        .await
        .expect("isolated");
    let wakeup = f.input.inner.body.wakeup_dir.as_str();
    let sessions = f.input.inner.body.session_dir.as_str();
    assert!(!CodexTranscriptInput::check_availability(Some(wakeup), Some(sessions)).await);
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","session_dir":isolated,"received_at":chrono::Utc::now().to_rfc3339()})).await;
    assert!(CodexTranscriptInput::check_availability(Some(wakeup), Some(sessions)).await);
    assert_eq!(
        CodexTranscriptInput::watch_paths(Some(wakeup), Some(sessions)),
        vec![sessions, wakeup]
    );
}
#[tokio::test]
async fn invalid_dynamic_wakeup_markers_never_activate_real_input() {
    for kind in [
        "expired",
        "malformed",
        "missing-timestamp",
        "unsupported-layout",
        "missing-root",
    ] {
        let f = Fixture::new();
        let home = f.root.path().join("home");
        let isolated = home.join(if kind == "unsupported-layout" {
            "other/fixture/sessions"
        } else {
            "u/fixture/sessions"
        });
        if kind != "missing-root" {
            tokio::fs::create_dir_all(&isolated)
                .await
                .expect("isolated");
        }
        let mut payload = json!({"codex_home":home,"session_dir":isolated,"received_at":chrono::Utc::now().to_rfc3339()});
        if kind == "expired" {
            payload["received_at"] =
                json!((chrono::Utc::now() - chrono::Duration::hours(49)).to_rfc3339());
        }
        if kind == "missing-timestamp" {
            payload
                .as_object_mut()
                .expect("object")
                .remove("received_at");
        }
        f.marker("wakeups", "invalid.json", payload).await;
        if kind == "malformed" {
            tokio::fs::write(f.root.path().join("wakeups/invalid.json"), "{")
                .await
                .expect("malformed");
        }
        assert!(
            !CodexTranscriptInput::check_availability(
                Some(&f.input.inner.body.wakeup_dir),
                Some(&f.input.inner.body.session_dir)
            )
            .await,
            "{kind}"
        );
        assert!(!f.input.collector_running());
        assert!(f
            .input
            .inner
            .body
            .watcher_stop
            .lock()
            .expect("watcher")
            .is_none());
    }
}
#[tokio::test]
async fn absent_metadata_survives_discovery_until_exact_absence_ttl_then_reclaims_bytes() {
    let f = Fixture::new();
    let path = f
        .write(
            "rollout-absence.jsonl",
            &(record(
                "2026-06-24T06:00:00.000Z",
                "session_meta",
                json!({"id":"absence-session","model_provider":"openai"}),
            ) + "\n"),
        )
        .await;
    let (ino, size, _) = file_meta_snapshot(&path).await.expect("native snapshot");
    f.engine()
        .register_subagent_owner_meta(f.rt(), &path, ino, size, Some(0), true)
        .await
        .expect("register");
    let seen = f
        .input
        .inner
        .body
        .with_shared(|s| s.meta_cache[&path].last_seen_at_ms);
    tokio::fs::remove_file(&path).await.expect("unlink");
    f.engine()
        .index_discovered_transcript_owners(f.rt(), &[], None)
        .await
        .expect("discovery");
    f.engine().prune_absent_meta_cache(
        &HashSet::new(),
        seen + CACHED_TRANSCRIPT_META_ABSENCE_TTL_MS - 1,
    );
    assert!(f
        .input
        .inner
        .body
        .with_shared(|s| s.meta_cache.contains_key(&path)));
    f.engine().prune_absent_meta_cache(
        &HashSet::new(),
        seen + CACHED_TRANSCRIPT_META_ABSENCE_TTL_MS + 1,
    );
    assert!(f
        .input
        .inner
        .body
        .with_shared(|s| s.meta_cache.is_empty() && s.meta_cache_bytes == 0));
}
#[tokio::test]
async fn discovery_cache_hits_do_not_refresh_or_evict_the_active_metadata_working_set() {
    let f = Fixture::new();
    let cold = f
        .write(
            "rollout-cold.jsonl",
            &(record(
                "2026-06-24T06:00:00.000Z",
                "session_meta",
                json!({"id":"cold","model_provider":"openai"}),
            ) + "\n"),
        )
        .await;
    let (ino, size, _) = file_meta_snapshot(&cold).await.expect("native snapshot");
    f.engine()
        .register_subagent_owner_meta(f.rt(), &cold, ino, size, Some(0), true)
        .await
        .expect("cold");
    for n in 1..MAX_LINK_DESCRIPTORS {
        f.engine().remember_transcript_owner_meta(
            &format!("synthetic-hot-{n}"),
            n as u64,
            100,
            0,
            meta(&format!("hot-{n}")),
            true,
        );
    }
    let before = f
        .input
        .inner
        .body
        .with_shared(|s| s.meta_cache.keys().cloned().collect::<Vec<_>>());
    let result = f
        .engine()
        .load_transcript_owner_meta(f.rt(), &cold, ino, size, 0, false)
        .await
        .expect("discovery hit")
        .expect("meta");
    assert_eq!(result.thread_id, "cold");
    let candidate = f
        .write(
            "rollout-cache-candidate.jsonl",
            &(record(
                "2026-06-24T06:00:00.000Z",
                "session_meta",
                json!({"id":"candidate","model_provider":"openai"}),
            ) + "\n"),
        )
        .await;
    f.engine()
        .index_discovered_transcript_owners(
            f.rt(),
            &[
                DiscoveredSessionFile {
                    file_path: cold.clone(),
                    baseline_on_start: true,
                },
                DiscoveredSessionFile {
                    file_path: candidate.clone(),
                    baseline_on_start: true,
                },
            ],
            None,
        )
        .await
        .expect("real discovery");
    assert!(
        !f.input
            .inner
            .body
            .with_shared(|s| s.meta_cache.contains_key(&candidate)),
        "discovery cache misses cannot evict active metadata"
    );
    assert!(
        f.input
            .inner
            .body
            .with_shared(|s| s.meta_cache.keys().cloned().collect::<Vec<_>>())
            == before,
        "discovery must not refresh active LRU order"
    );
    f.engine()
        .remember_transcript_owner_meta("new-active", 999, 100, 0, meta("new-active"), true);
    assert!(
        !f.input
            .inner
            .body
            .with_shared(|s| s.meta_cache.contains_key(&cold)),
        "discovery must not promote cold metadata over active working set"
    );
    assert!(f
        .input
        .inner
        .body
        .with_shared(|s| s.meta_cache.contains_key("synthetic-hot-1")
            && s.meta_cache.contains_key("new-active")));
}
#[test]
fn real_cache_estimated_byte_budget_evicts_oldest_and_rejects_oversized_metadata() {
    let f = Fixture::new();
    let mut big = meta("first");
    big.base_instructions = Some("x".repeat(MAX_CACHED_TRANSCRIPT_META_BYTES / 2));
    f.engine()
        .remember_transcript_owner_meta("first", 1, 100, 0, big.clone(), true);
    big.thread_id = "second".into();
    f.engine()
        .remember_transcript_owner_meta("second", 2, 100, 0, big, true);
    f.input.inner.body.with_shared(|s| {
        assert!(!s.meta_cache.contains_key("first"));
        assert!(s.meta_cache.contains_key("second"));
        assert!(s.meta_cache_bytes <= MAX_CACHED_TRANSCRIPT_META_BYTES);
    });
    let mut enormous = meta("oversized");
    enormous.base_instructions = Some("y".repeat(MAX_CACHED_TRANSCRIPT_META_BYTES + 1));
    f.engine()
        .remember_transcript_owner_meta("oversized", 3, 100, 0, enormous, true);
    assert!(!f
        .input
        .inner
        .body
        .with_shared(|s| s.meta_cache.contains_key("oversized")));
}
#[tokio::test]
async fn recovery_watermark_is_actual_file_size_so_same_inode_shrink_reloads_owner() {
    let f = Fixture::new();
    let turn = completed();
    let original = format!(
        "{}{}\n",
        turn,
        record(
            "2026-06-24T06:01:00.000Z",
            "event_msg",
            json!({"type":"diagnostic","padding":"x".repeat(32768)})
        )
    );
    let path = f.write("rollout-watermark.jsonl", &original).await;
    let (ino, size, _) = file_meta_snapshot(&path).await.expect("native snapshot");
    let mut cp = empty_checkpoint(ino);
    cp.owner_session_meta_offset = Some(0);
    cp.scan_offset = turn.len() as i64;
    cp.active_turn = Some(create_active_turn(
        "turn-1".into(),
        (turn.lines().next().expect("line").len() + 1) as i64,
        1_782_280_801_000.0,
        false,
    ));
    f.engine()
        .recover_turn_segment(
            f.rt(),
            &path,
            &mut cp,
            RecoveryBoundary {
                end_offset: turn.len() as i64,
                terminal: true,
                inferred: None,
                next_turn_started_at_ms: None,
            },
            None,
        )
        .await
        .expect("recover");
    assert_eq!(
        f.input
            .inner
            .body
            .with_shared(|s| s.meta_cache[&path].file_size),
        size
    );
    let changed = turn.replacen("\"id\":\"session-1\"", "\"id\":\"replacement-session\"", 1);
    let rewritten = format!(
        "{}{}\n",
        changed,
        record(
            "2026-06-24T06:00:12.000Z",
            "event_msg",
            json!({"type":"diagnostic","padding":"y".repeat(8192)})
        )
    );
    tokio::fs::write(&path, &rewritten).await.expect("rewrite");
    let (ino2, size2, _) = file_meta_snapshot(&path).await.expect("native snapshot");
    assert_eq!(ino2, ino);
    assert!(size2 < size && size2 >= turn.len() as i64);
    let replacement = f
        .engine()
        .load_transcript_owner_meta(f.rt(), &path, ino2, size2, 0, true)
        .await
        .expect("reload")
        .expect("meta");
    assert_eq!(replacement.thread_id, "replacement-session");
}
#[tokio::test]
async fn empty_completed_turn_emits_one_terminal_zero_usage_llm_pair() {
    let f = Fixture::new();
    let mut lines = header();
    lines.push(record(
        "2026-06-24T06:00:04.000Z",
        "event_msg",
        json!({"type":"task_complete","turn_id":"turn-1"}),
    ));
    let p = f
        .write("rollout-empty.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(events(&all, "llm.request").len(), 1);
    let r = events(&all, "llm.response");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.response.finish_reasons"], json!(["stop"]));
    for key in [
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "gen_ai.usage.cache_read.input_tokens",
        "gen_ai.usage.cache_creation.input_tokens",
        "gen_ai.usage.total_tokens",
    ] {
        assert_eq!(r[0][key], json!(0), "{key}");
    }
}
#[tokio::test]
async fn completed_three_waves_preserve_exact_tokens_reasoning_messages_ids_and_step_links() {
    let f = Fixture::new();
    let p = f.write("rollout-waves.jsonl", &completed()).await;
    f.process(&p).await;
    let all = f.records();
    let r = events(&all, "llm.response");
    assert_eq!(r.len(), 3);
    assert_eq!(
        r.iter()
            .map(|e| e["gen_ai.usage.total_tokens"].clone())
            .collect::<Vec<_>>(),
        vec![json!(110), json!(132), json!(143)]
    );
    assert_eq!(
        r.iter()
            .map(|e| e["gen_ai.response.finish_reasons"].clone())
            .collect::<Vec<_>>(),
        vec![json!(["tool_call"]), json!(["tool_call"]), json!(["stop"])]
    );
    assert_eq!(timestamp(&r[0]), 1_782_280_805_000);
    assert_eq!(timestamp(&r[1]), 1_782_280_808_000);
    assert_eq!(r[0]["gen_ai.response.id"], "fc-1");
    assert!(r[0]["gen_ai.output.messages"][0]["parts"]
        .as_array()
        .expect("parts")
        .contains(&json!({"type":"reasoning","content":"inspect the script first"})));
    assert!(r[1]["gen_ai.output.messages"][0]["parts"]
        .as_array()
        .expect("parts")
        .contains(&json!({"type":"reasoning","content":"apply the focused patch"})));
    assert_eq!(
        r[2]["gen_ai.output.messages"],
        json!([{"role":"assistant","parts":[{"type":"text","content":"fixed"}],"finish_reason":"stop"}])
    );
    let requests = events(&all, "llm.request");
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["gen_ai.response.id"], "fc-1");
    let mut expected = json!([{"role":"user","parts":[{"type":"text","content":"fix it"}]},{"role":"assistant","parts":[{"type":"tool_call","id":"call-1","name":"exec_command","arguments":{"command":"pwd"}}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":"/tmp/project"}]}]);
    assert_eq!(requests[1]["gen_ai.input.messages"], expected);
    expected.as_array_mut().expect("messages").extend([json!({"role":"assistant","parts":[{"type":"tool_call","id":"call-2","name":"apply_patch","arguments":{"command":"*** Begin Patch\n*** End Patch"}}]}),json!({"role":"tool","parts":[{"type":"tool_call_response","id":"call-2","response":"Done"}]})]);
    assert_eq!(requests[2]["gen_ai.input.messages"], expected);
    assert!(requests
        .iter()
        .all(|e| e["gen_ai.input.messages_hash"].is_string()));
    assert_ne!(
        requests[0]["gen_ai.input.messages_hash"],
        requests[1]["gen_ai.input.messages_hash"]
    );
    assert_eq!(
        events(&all, "tool.call")
            .iter()
            .map(|e| e["gen_ai.step.id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("session-1:turn-1:s1"), json!("session-1:turn-1:s2")]
    );
    let before = all.len();
    assert_eq!(f.process(&p).await, 0);
    assert_eq!(f.records().len(), before);
}
async fn web_search(with_reasoning: bool) -> Vec<Value> {
    let f = Fixture::new();
    let mut lines = header();
    if with_reasoning {
        lines.push(record(
            "2026-06-24T06:00:04.000Z",
            "response_item",
            json!({"type":"reasoning","id":"reasoning-1"}),
        ));
    }
    lines.extend([
 record("2026-06-24T06:00:08.000Z","event_msg",json!({"type":"web_search_end","call_id":"ws-1","action":{"type":"search","query":"test"}})),
 record("2026-06-24T06:00:08.010Z","response_item",json!({"type":"web_search_call","id":"ws-1","status":"completed","action":{"type":"search","query":"test"}})),
 record("2026-06-24T06:00:09.000Z","event_msg",json!({"type":"agent_message","message":"found it","phase":"final"})),
 record("2026-06-24T06:00:09.000Z","event_msg",usage(100,10)),
 record("2026-06-24T06:00:10.000Z","event_msg",json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"found it"}))]);
    let p = f
        .write("rollout-web.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    f.records()
}
#[tokio::test]
async fn web_search_uses_activity_start_and_end_event_for_nonzero_tool_and_llm_timing() {
    let all = web_search(true).await;
    let q = events(&all, "llm.request");
    let r = events(&all, "llm.response");
    let c = events(&all, "tool.call");
    let t = events(&all, "tool.result");
    assert_eq!(timestamp(&q[0]), 1_782_280_803_000);
    assert_eq!(timestamp(&r[0]), 1_782_280_804_000);
    assert_eq!(timestamp(&c[0]), 1_782_280_804_000);
    assert_eq!(timestamp(&t[0]), 1_782_280_808_000);
    assert_eq!(t[0]["gen_ai.tool.call.duration"].as_f64(), Some(4000.0));
}
#[tokio::test]
async fn web_search_end_closes_llm_when_pretool_reasoning_is_absent() {
    let all = web_search(false).await;
    assert_eq!(
        timestamp(&events(&all, "llm.request")[0]),
        1_782_280_803_000
    );
    assert_eq!(
        timestamp(&events(&all, "llm.response")[0]),
        1_782_280_808_000
    );
}
#[tokio::test]
async fn provider_response_id_wins_over_reasoning_message_and_function_item_ids() {
    let f = Fixture::new();
    let mut lines = header();
    lines.extend([
 record("2026-06-24T06:00:04.000Z","response_item",json!({"type":"reasoning","id":"rs-provider-item","summary":[],"content":null,"encrypted_content":null})),
 record("2026-06-24T06:00:05.000Z","response_item",json!({"type":"message","id":"msg-provider-item","role":"assistant","content":[{"type":"output_text","text":"done"}]})),
 record("2026-06-24T06:00:06.000Z","token_usage_record",json!({"thread_id":"session-1","turn_id":"turn-1","session_id":"session-1","response_id":"resp-provider-response","usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}})),
 record("2026-06-24T06:00:07.000Z","event_msg",usage(100,10)),
 record("2026-06-24T06:00:08.000Z","event_msg",json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"done"}))]);
    let p = f
        .write("rollout-response.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(
        events(&all, "llm.request")[0]["gen_ai.response.id"],
        "resp-provider-response"
    );
    assert_eq!(
        events(&all, "llm.response")[0]["gen_ai.response.id"],
        "resp-provider-response"
    );
}
#[tokio::test]
async fn malformed_terminal_timestamp_never_produces_unix_epoch_records() {
    let f = Fixture::new();
    let mut lines = header();
    lines.push(record(
        "not-a-date",
        "event_msg",
        json!({"type":"task_complete","turn_id":"turn-1"}),
    ));
    let p = f
        .write("rollout-time.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let all = f.records();
    assert!(!events(&all, "llm.response").is_empty());
    assert!(all.iter().all(|e| timestamp(e) > 1_767_225_600_000));
}
#[tokio::test]
async fn multiple_user_messages_form_one_entry_prompt_but_keep_raw_llm_input_parts() {
    let f = Fixture::new();
    let mut lines: Vec<String> = completed().lines().map(str::to_owned).collect();
    lines.insert(4,record("2026-06-24T06:00:03.500Z","response_item",json!({"type":"message","role":"user","content":[{"type":"input_text","text":"and run the tests"}]})));
    let p = f
        .write("rollout-prompt.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(
        events(&all, "other")[0]["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"fix it\nand run the tests"}]}])
    );
    assert_eq!(
        events(&all, "llm.request")[0]["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":"fix it"}]},{"role":"user","parts":[{"type":"text","content":"and run the tests"}]}])
    );
}
#[tokio::test]
async fn every_record_receives_trimmed_allowed_wakeup_resource_context_without_sensitive_keys() {
    let f = Fixture::new();
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","resourceAttributes":{"agentteams.worker.name":" codex-worker ","agentteams.instance.id":" lw-codex ","agentteams.token":"should-not-leak","custom.key":"ignored"}})).await;
    let p = f.write("rollout-resource.jsonl", &completed()).await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(events(&all, "llm.response").len(), 3);
    for e in &all {
        assert_eq!(e["gen_ai.agent.name"], "codex-worker");
        assert_eq!(
            e["resourceAttributes"],
            json!({"agentteams.worker.name":"codex-worker","agentteams.instance.id":"lw-codex"})
        );
        assert!(e.get("agentteams.worker.name").is_none());
        assert!(e.get("agentteams.instance.id").is_none());
    }
    let encoded = serde_json::to_string(&all).expect("json");
    assert!(!encoded.contains("should-not-leak") && !encoded.contains("ignored"));
}
#[tokio::test]
async fn overlong_wakeup_worker_names_are_never_attached_or_promoted_to_agent_name() {
    let f = Fixture::new();
    let long = "x".repeat(513);
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","resourceAttributes":{"agentteams.worker.name":long,"agentteams.instance.id":"lw-codex"}})).await;
    let p = f.write("rollout-long-resource.jsonl", &completed()).await;
    f.process(&p).await;
    let all = f.records();
    assert!(!all.is_empty());
    for e in &all {
        assert!(e.get("gen_ai.agent.name").is_none());
        assert_eq!(
            e["resourceAttributes"],
            json!({"agentteams.instance.id":"lw-codex"})
        );
    }
    assert!(!serde_json::to_string(&all).expect("json").contains(&long));
}
#[tokio::test]
async fn invocation_attributes_reach_all_five_event_types_and_filter_reserved_sensitive_long_nonstring(
) {
    let f = Fixture::new();
    let long = "x".repeat(513);
    f.marker("spans","session-1--turn-1.json",json!({"session_id":"session-1","turn_id":"turn-1","spanAttributes":{"multica.issue.id":" issue-1 ","multica.agent.name":"codex-agent","multica.runtime.name":"codex","gen_ai.agent.name":"must-not-overwrite","multica.api_token":"must-not-leak","multica.long":long,"multica.number":42},"received_at":chrono::Utc::now().to_rfc3339()})).await;
    let p = f.write("rollout-span.jsonl", &completed()).await;
    f.process(&p).await;
    let all = f.records();
    let kinds: std::collections::BTreeSet<String> = all
        .iter()
        .map(|e| e["event.name"].as_str().expect("event").into())
        .collect();
    assert_eq!(
        kinds,
        [
            "other",
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result"
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    for e in &all {
        assert_eq!(e["multica.issue.id"], "issue-1");
        assert_eq!(e["multica.agent.name"], "codex-agent");
        assert_eq!(e["multica.runtime.name"], "codex");
        assert_ne!(e["gen_ai.agent.name"], "must-not-overwrite");
        assert!(
            e.get("multica.api_token").is_none()
                && e.get("multica.long").is_none()
                && e.get("multica.number").is_none()
        );
    }
    let encoded = serde_json::to_string(&all).expect("json");
    assert!(!encoded.contains("must-not-leak") && !encoded.contains(&long));
}
#[tokio::test]
async fn mismatched_span_context_payload_identifiers_do_not_attribute_any_record() {
    let f = Fixture::new();
    f.marker("spans","session-1--turn-1.json",json!({"session_id":"different-session","turn_id":"turn-1","spanAttributes":{"multica.issue.id":"wrong-issue"},"received_at":chrono::Utc::now().to_rfc3339()})).await;
    let p = f.write("rollout-mismatch.jsonl", &completed()).await;
    f.process(&p).await;
    let all = f.records();
    assert!(!all.is_empty());
    assert!(all.iter().all(|e| e.get("multica.issue.id").is_none()));
}
#[tokio::test]
async fn expired_span_contexts_are_removed_by_production_cleanup_while_fresh_context_survives() {
    let f = Fixture::new();
    f.marker("spans","session-1--turn-1.json",json!({"session_id":"session-1","turn_id":"turn-1","spanAttributes":{"multica.issue.id":"expired"},"received_at":(chrono::Utc::now()-chrono::Duration::hours(49)).to_rfc3339()})).await;
    f.marker("spans","session-1--turn-2.json",json!({"session_id":"session-1","turn_id":"turn-2","spanAttributes":{"multica.issue.id":"fresh"},"received_at":chrono::Utc::now().to_rfc3339()})).await;
    f.engine()
        .cleanup_expired_span_contexts(f.rt(), now_ms() as i64)
        .await;
    assert!(!f.root.path().join("spans/session-1--turn-1.json").exists());
    assert!(f.root.path().join("spans/session-1--turn-2.json").exists());
}
#[tokio::test]
async fn invocation_context_isolation_is_per_turn_within_one_native_rollout() {
    let f = Fixture::new();
    for n in [1, 2] {
        f.marker("spans",&format!("session-1--turn-{n}.json"),json!({"session_id":"session-1","turn_id":format!("turn-{n}"),"spanAttributes":{"multica.issue.id":format!("issue-{n}")},"received_at":chrono::Utc::now().to_rfc3339()})).await;
    }
    let text = completed()
        + &completed()
            .replace("turn-1", "turn-2")
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
        + "\n";
    let p = f.write("rollout-isolation.jsonl", &text).await;
    f.process(&p).await;
    let all = f.records();
    for n in [1, 2] {
        let t: Vec<_> = all
            .iter()
            .filter(|e| e["agent.codex.transcript_turn_id"] == format!("turn-{n}"))
            .collect();
        assert!(!t.is_empty());
        assert!(t
            .iter()
            .all(|e| e["multica.issue.id"] == format!("issue-{n}")));
    }
}
#[tokio::test]
async fn long_native_turns_emit_bounded_batches_without_dropping_observed_tool_results() {
    let f = Fixture::new();
    let mut lines = header();
    let at = chrono::DateTime::parse_from_rfc3339("2026-06-24T06:00:00Z").expect("time");
    for n in 0..80 {
        let ts = |s: i64| (at + chrono::Duration::seconds(s)).to_rfc3339();
        lines.extend([
 record(&ts(4+n*3),"event_msg",json!({"type":"agent_message","message":format!("checking {n}"),"phase":"commentary"})),
 record(&ts(5+n*3),"response_item",json!({"type":"function_call","id":format!("fc-{n}"),"call_id":format!("call-{n}"),"name":"exec_command","arguments":json!({"cmd":format!("echo {n}")}).to_string()})),
 record(&ts(6+n*3),"response_item",json!({"type":"function_call_output","call_id":format!("call-{n}"),"output":json!(n.to_string()).to_string()})),
 record(&(at+chrono::Duration::milliseconds((6+n*3)*1000+100)).to_rfc3339(),"event_msg",usage((100+n) as u64,10))]);
    }
    lines.extend([
        record(
            "2026-06-24T06:10:00.000Z",
            "event_msg",
            json!({"type":"agent_message","message":"done","phase":"final"}),
        ),
        record(
            "2026-06-24T06:10:01.000Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"done"}),
        ),
    ]);
    let p = f
        .write("rollout-many.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(events(&all, "tool.result").len(), 80);
    assert!(all.len() > 256);
    let batches = f.batches.lock().expect("batches");
    assert!(batches.len() > 1);
    assert!(batches.iter().all(|n| *n <= 256));
}
#[tokio::test]
async fn waves_emit_before_terminal_but_stop_finish_and_end_marker_wait_for_task_complete() {
    let f = Fixture::new();
    let mut lines: Vec<_> = completed().lines().map(str::to_owned).collect();
    let terminal = lines.pop().expect("terminal");
    let p = f
        .write("rollout-before-terminal.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let before = f.records();
    assert!(!events(&before, "tool.result").is_empty());
    assert!(!before
        .iter()
        .any(|e| e["gen_ai.response.finish_reasons"] == json!(["stop"])
            || e["gen_ai.turn.end"] == true));
    f.append(&p, &(terminal + "\n")).await;
    f.process(&p).await;
    let all = f.records();
    assert!(all
        .iter()
        .any(|e| e["gen_ai.response.finish_reasons"] == json!(["stop"])));
    assert_eq!(
        all.iter().filter(|e| e["gen_ai.turn.end"] == true).count(),
        1
    );
}
#[tokio::test]
async fn equal_token_counts_in_distinct_waves_remain_independent_steps_across_native_cycles() {
    let f = Fixture::new();
    let mut lines = header();
    lines.extend([
        record(
            "2026-06-24T06:00:04.000Z",
            "event_msg",
            json!({"type":"agent_message","message":"A","phase":"commentary"}),
        ),
        record("2026-06-24T06:00:05.000Z", "event_msg", usage(10, 2)),
    ]);
    let text = lines.join("\n") + "\n";
    let p = f.write("rollout-distinct-waves.jsonl", &text).await;
    f.process(&p).await;
    assert!(events(&f.records(), "llm.response").is_empty());
    assert!(f.checkpoint(&p).active_turn.expect("active").start_offset < text.len() as i64);
    let second = [
        record(
            "2026-06-24T06:00:06.000Z",
            "event_msg",
            json!({"type":"agent_message","message":"B","phase":"commentary"}),
        ),
        record(
            "2026-06-24T06:00:07.000Z",
            "response_item",
            json!({"type":"function_call","id":"fc-1","call_id":"call-1","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}),
        ),
        record(
            "2026-06-24T06:00:08.000Z",
            "response_item",
            json!({"type":"function_call_output","call_id":"call-1","output":"\"/tmp\""}),
        ),
        record("2026-06-24T06:00:09.000Z", "event_msg", usage(10, 2)),
    ];
    f.append(&p, &(second.join("\n") + "\n")).await;
    f.process(&p).await;
    let all = f.records();
    let responses = events(&all, "llm.response");
    assert_eq!(responses.len(), 2);
    for (n, r) in responses.iter().enumerate() {
        assert_eq!(r["gen_ai.step.id"], format!("session-1:turn-1:s{}", n + 1));
        assert_eq!(r["gen_ai.usage.total_tokens"], 12);
    }
    assert_eq!(
        responses[0]["gen_ai.response.finish_reasons"],
        json!(["stop"])
    );
    assert_eq!(
        responses[1]["gen_ai.response.finish_reasons"],
        json!(["tool_call"])
    );
    assert_eq!(events(&all, "tool.call").len(), 1);
    assert_eq!(events(&all, "tool.result").len(), 1);
    f.append(
        &p,
        &([
            record(
                "2026-06-24T06:00:10.000Z",
                "event_msg",
                json!({"type":"agent_message","message":"C","phase":"final"}),
            ),
            record("2026-06-24T06:00:11.000Z", "event_msg", usage(20, 3)),
        ]
        .join("\n")
            + "\n"),
    )
    .await;
    f.process(&p).await;
    assert_eq!(events(&f.records(), "llm.response").len(), 2);
    f.append(
        &p,
        &(record(
            "2026-06-24T06:00:12.000Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"C"}),
        ) + "\n"),
    )
    .await;
    f.process(&p).await;
    let all = f.records();
    let responses = events(&all, "llm.response");
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[2]["gen_ai.step.id"], "session-1:turn-1:s3");
    assert_eq!(responses[2]["gen_ai.usage.total_tokens"], 23);
    assert_eq!(
        responses[2]["gen_ai.output.messages"],
        json!([{"role":"assistant","parts":[{"type":"text","content":"C"}],"finish_reason":"stop"}])
    );
    assert!(responses[0].get("agent.codex.turn_status").is_none());
    assert_eq!(
        all.iter()
            .filter(|e| e["gen_ai.turn.end"] == true && e["agent.codex.turn_status"] == "completed")
            .count(),
        1
    );
    let q = events(&all, "llm.request");
    let delta = json!([{"role":"assistant","parts":[{"type":"tool_call","id":"call-1","name":"exec_command","arguments":{"command":"pwd"}}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":"/tmp"}]}]);
    assert_eq!(q[2]["gen_ai.input.messages_delta"], delta);
    let mut full = json!([{"role":"user","parts":[{"type":"text","content":"fix it"}]}]);
    full.as_array_mut()
        .expect("messages")
        .extend(delta.as_array().expect("delta").clone());
    assert_eq!(q[2]["gen_ai.input.messages"], full);
}
fn cumulative(input: u64, output: u64, total: u64) -> Value {
    let mut u = usage(input, output);
    u["info"]["total_token_usage"] = json!({"total_tokens":total});
    u
}
fn repeated_snapshot_head() -> String {
    let mut lines = header();
    lines.extend([
        record(
            "2026-06-24T06:00:04.000Z",
            "event_msg",
            json!({"type":"agent_message","message":"A","phase":"commentary"}),
        ),
        record(
            "2026-06-24T06:00:05.000Z",
            "event_msg",
            cumulative(10, 2, 1000),
        ),
        record(
            "2026-06-24T06:00:06.000Z",
            "event_msg",
            json!({"type":"agent_message","message":"B","phase":"final"}),
        ),
        record(
            "2026-06-24T06:00:07.000Z",
            "event_msg",
            cumulative(10, 2, 1000),
        ),
    ]);
    lines.join("\n") + "\n"
}
fn fresh_snapshot_tail() -> String {
    [
        record(
            "2026-06-24T06:00:10.000Z",
            "event_msg",
            cumulative(20, 2, 1100),
        ),
        record(
            "2026-06-24T06:00:11.000Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"B"}),
        ),
    ]
    .join("\n")
        + "\n"
}
fn assert_two_snapshot_steps(all: &[Value]) {
    let r = events(all, "llm.response");
    assert_eq!(r.len(), 2);
    assert_eq!(
        r.iter()
            .map(|e| e["gen_ai.step.id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("session-1:turn-1:s1"), json!("session-1:turn-1:s2")]
    );
    assert_eq!(
        r.iter()
            .map(|e| e["gen_ai.usage.total_tokens"].clone())
            .collect::<Vec<_>>(),
        vec![json!(12), json!(22)]
    );
}
#[tokio::test]
async fn fresh_accounting_after_repeated_snapshot_closes_the_still_open_wave() {
    let f = Fixture::new();
    let p = f
        .write(
            "rollout-stale-fresh.jsonl",
            &(repeated_snapshot_head() + &fresh_snapshot_tail()),
        )
        .await;
    f.process(&p).await;
    assert_two_snapshot_steps(&f.records());
}
#[tokio::test]
async fn repeated_snapshot_keeps_next_wave_collectable_after_durable_checkpoint_reload() {
    let first = Fixture::new();
    let p = first
        .write("rollout-snapshot-restart.jsonl", &repeated_snapshot_head())
        .await;
    first.process(&p).await;
    assert_eq!(events(&first.records(), "llm.response").len(), 1);
    assert_eq!(
        first
            .checkpoint(&p)
            .active_turn
            .expect("active")
            .last_cumulative_token_total,
        Some(1000.0)
    );
    let second = first.restart().await;
    second.append(&p, &fresh_snapshot_tail()).await;
    second.process(&p).await;
    let mut all = first.records();
    all.extend(second.records());
    assert_two_snapshot_steps(&all);
    assert_eq!(second.process(&p).await, 0);
}
#[tokio::test]
async fn token_count_before_tool_output_never_commits_an_unfinished_tool_wave() {
    let f = Fixture::new();
    let mut lines = header();
    lines.extend([record("2026-06-24T06:00:04.000Z","response_item",json!({"type":"function_call","id":"fc-1","call_id":"call-1","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"})),record("2026-06-24T06:00:05.000Z","event_msg",usage(30,4))]);
    let p = f
        .write("rollout-late-output.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let before = f.records();
    assert!(events(&before, "llm.response").is_empty() && events(&before, "tool.call").is_empty());
    f.append(
        &p,
        &(record(
            "2026-06-24T06:00:06.000Z",
            "response_item",
            json!({"type":"function_call_output","call_id":"call-1","output":"\"/tmp\""}),
        ) + "\n"),
    )
    .await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(events(&all, "llm.response").len(), 1);
    assert_eq!(events(&all, "tool.call").len(), 1);
    let r = events(&all, "tool.result");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.tool.call.id"], "call-1");
    assert_eq!(r[0]["gen_ai.tool.call.result"], "/tmp");
}
#[tokio::test]

async fn independent_transcript_files_with_equal_session_turn_ids_are_both_collected() {
    let f = Fixture::new();
    f.input.start().await.expect("native start");
    f.input.run_cycle().await;
    let first = simple_turn("turn-1", 100, 10, 0).join("\n") + "\n";
    let second = simple_turn("turn-1", 100, 10, 600).join("\n")
        + "\n"
        + &simple_turn("turn-2", 120, 12, 660)
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
        + "\n";
    let one = f.write("rollout-independent-one.jsonl", &first).await;
    f.input.run_cycle().await;
    assert_eq!(responses_for(&f.records(), "turn-1").len(), 1);
    let two = f.write("rollout-independent-two.jsonl", &second).await;
    f.input.run_cycle().await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("native stop");
    let all = f.records();
    let repeated = responses_for(&all, "turn-1");
    let fresh = responses_for(&all, "turn-2");
    assert_eq!(repeated.len(), 2);
    assert_eq!(fresh.len(), 1);
    assert_eq!(repeated[0]["gen_ai.usage.total_tokens"], 110);
    assert_eq!(fresh[0]["gen_ai.usage.total_tokens"], 132);
    assert_eq!(f.checkpoint(&one).scan_offset, first.len() as i64);
    assert_eq!(f.checkpoint(&two).scan_offset, second.len() as i64);
}
#[tokio::test]

async fn durable_reload_does_not_restore_cross_transcript_turn_id_suppression() {
    assert_cross_transcript_restore().await;
}
async fn assert_cross_transcript_restore() {
    let first = Fixture::new();
    first.input.start().await.expect("native first start");
    first.input.run_cycle().await;
    let original = simple_turn("turn-1", 100, 10, 0).join("\n") + "\n";
    let one = first.write("rollout-before-restart.jsonl", &original).await;
    first.input.run_cycle().await;
    assert_eq!(responses_for(&first.records(), "turn-1").len(), 1);
    first.input.stop().await.expect("native first stop");
    let second = first.restart().await;
    second.input.start().await.expect("native restarted start");
    second.input.run_cycle().await;
    let fresh = simple_turn("turn-1", 100, 10, 600).join("\n")
        + "\n"
        + &simple_turn("turn-2", 120, 12, 660)
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
        + "\n";
    let two = second.write("rollout-after-restart.jsonl", &fresh).await;
    second.input.run_cycle().await;
    second.input.run_cycle().await;
    second.input.stop().await.expect("native restarted stop");
    assert_eq!(second.checkpoint(&two).scan_offset, fresh.len() as i64);
    let all = second.records();
    assert_eq!(responses_for(&all, "turn-1").len(), 1);
    let later = responses_for(&all, "turn-2");
    assert_eq!(later.len(), 1);
    assert_eq!(later[0]["gen_ai.usage.total_tokens"], 132);
    assert_eq!(second.process(&one).await, 0);
}
#[tokio::test]
async fn prompt_waits_for_submitted_user_text_instead_of_emitting_environment_only_prompt() {
    let f = Fixture::new();
    let environment = "<environment_context>\n  <cwd>C:\\project</cwd>\n</environment_context>";
    let lines = [
        record(
            "2026-06-24T06:00:00.000Z",
            "session_meta",
            json!({"id":"session-1","model_provider":"openai"}),
        ),
        record(
            "2026-06-24T06:00:01.000Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"turn-1"}),
        ),
        record(
            "2026-06-24T06:00:01.100Z",
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":environment}]}),
        ),
        record(
            "2026-06-24T06:00:01.200Z",
            "turn_context",
            json!({"turn_id":"turn-1","model":"gpt-5.5","cwd":"C:\\project"}),
        ),
    ];
    let p = f
        .write("rollout-prompt-ready.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    assert!(f.records().is_empty());
    assert!(!f.checkpoint(&p).active_turn.expect("active").emitted_prompt);
    f.append(&p,&([record("2026-06-24T06:00:01.700Z","response_item",json!({"type":"message","role":"user","content":[{"type":"input_text","text":"修复 Windows 采集"}]})),record("2026-06-24T06:00:01.710Z","event_msg",json!({"type":"user_message","message":"修复 Windows 采集"}))].join("\n")+"\n")).await;
    f.process(&p).await;
    f.process(&p).await;
    let prompts = events(&f.records(), "other");
    assert_eq!(prompts.len(), 1);
    assert_eq!(
        prompts[0]["gen_ai.input.messages_delta"],
        json!([{"role":"user","parts":[{"type":"text","content":format!("{environment}\n修复 Windows 采集")}]}])
    );
    assert!(f.checkpoint(&p).active_turn.expect("active").emitted_prompt);
}
fn media_records(content: Value, tool_output: Option<Value>) -> Vec<Map<String, Value>> {
    let mut lines = header();
    lines.truncate(3);
    lines.push(record(
        "2026-06-24T06:00:03.000Z",
        "response_item",
        json!({"type":"message","role":"user","content":content}),
    ));
    if let Some(output) = tool_output {
        lines.extend([
            record(
                "2026-06-24T06:00:04.000Z",
                "response_item",
                json!({"type":"function_call","call_id":"c1","name":"ReadImage","arguments":"{}"}),
            ),
            record(
                "2026-06-24T06:00:05.000Z",
                "response_item",
                json!({"type":"function_call_output","call_id":"c1","output":output}),
            ),
        ]);
    }
    lines.extend([
        record(
            "2026-06-24T06:00:06.000Z",
            "event_msg",
            json!({"type":"user_message","message":"look"}),
        ),
        record(
            "2026-06-24T06:00:07.000Z",
            "event_msg",
            json!({"type":"agent_message","message":"ok","phase":"final"}),
        ),
        record("2026-06-24T06:00:08.000Z", "event_msg", usage(1, 1)),
        record(
            "2026-06-24T06:00:09.000Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"ok"}),
        ),
    ]);
    lines
        .into_iter()
        .map(|s| {
            serde_json::from_str::<Value>(&s)
                .expect("record")
                .as_object()
                .expect("map")
                .clone()
        })
        .collect()
}
fn fake_blob(params: &BlobToUriParams) -> Option<UriResult> {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(params.content.as_bytes()));
    Some(UriResult {
        uri: format!("oss://test/{digest}"),
        mime_type: params
            .mime_type
            .clone()
            .unwrap_or_else(|| "image/png".into()),
        modality: Some("image".into()),
        size: params.content.len(),
        sha256: digest,
    })
}
type TestBlobResolver<'a> = dyn Fn(&BlobToUriParams) -> Option<UriResult> + 'a;
fn extract_media(
    records: &[Map<String, Value>],
    blob: Option<&TestBlobResolver<'_>>,
    mode: crate::types::MultimodalUploadMode,
) -> super::super::super::types::CodexExtractedTranscriptTurn {
    extract_codex_partial_turn(
        records,
        Some(&meta("session-1")),
        "session-1",
        "turn-1",
        &ExtractOptions {
            blob_to_uri: blob,
            upload_mode: Some(mode),
            ..Default::default()
        },
    )
    .expect("extract media")
}
fn expected_image_part(content: &str, mime: &str) -> Value {
    let uri = fake_blob(&BlobToUriParams {
        content: content.into(),
        mime_type: Some(mime.into()),
        modality: Some("image".into()),
        time_unix_ms: None,
        reuse_key: None,
    })
    .expect("expected callback URI");
    json!({"type":"uri","mime_type":mime,"modality":"image","uri":uri.uri})
}

fn user_parts(turn: &super::super::super::types::CodexExtractedTranscriptTurn) -> Vec<Value> {
    turn.input_messages[0]["parts"]
        .as_array()
        .expect("parts")
        .clone()
}
#[test]
fn image_data_url_converts_to_uri_collapses_wrappers_and_survives_real_entry_building() {
    let text="\n# Files mentioned by the user:\n\n## pipeline.jpg: /tmp/pipeline.jpg\n\n## My request for Codex:\n这个图像是什么意思？\n";
    let records = media_records(
        json!([{"type":"input_text","text":text},{"type":"input_text","text":"<image name=[Image #1] path=\"/tmp/pipeline.jpg\">"},{"type":"input_image","image_url":"data:image/png;base64,ZmFrZS1wbmc=","detail":"high"},{"type":"input_text","text":"</image>"}]),
        None,
    );
    let turn = extract_media(
        &records,
        Some(&fake_blob),
        crate::types::MultimodalUploadMode::All,
    );
    assert!(
        turn.prompt
            .as_deref()
            .expect("prompt")
            .contains("这个图像是什么意思？")
            && turn
                .prompt
                .as_deref()
                .expect("prompt")
                .contains("/tmp/pipeline.jpg")
    );
    assert!(
        !turn
            .prompt
            .as_deref()
            .expect("prompt")
            .contains("ZmFrZS1wbmc=")
            && !turn
                .prompt
                .as_deref()
                .expect("prompt")
                .contains("data:image")
    );
    let parts = user_parts(&turn);
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0], json!({"type":"text","content":text}));
    assert_eq!(parts[1]["type"], "uri");
    assert_eq!(parts[1]["mime_type"], "image/png");
    assert_eq!(parts[1]["modality"], "image");
    assert!(parts[1]["uri"]
        .as_str()
        .expect("uri")
        .starts_with("oss://test/"));
    let out = serde_json::to_string(&parts).expect("parts");
    assert!(!out.contains("ZmFrZS1wbmc=") && !out.contains("<image") && !out.contains("</image>"));
    let built = build_codex_transcript_segment(&turn, &CodexTranscriptBuildOptions::default());
    let values: Vec<Value> = built
        .entries
        .iter()
        .map(|e| serde_json::to_value(e).expect("entry"))
        .collect();
    let q = events(&values, "llm.request");
    assert!(!q.is_empty());
    let msgs = &q[0]["gen_ai.input.messages"];
    assert!(serde_json::to_string(msgs)
        .expect("messages")
        .contains("\"type\":\"uri\""));
    assert!(!serde_json::to_string(msgs)
        .expect("messages")
        .contains("\"type\":\"blob\""));
}
#[test]
fn multiple_image_wrappers_collapse_only_around_converted_uris_and_keep_adjacent_text() {
    let files = "\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n";
    let records = media_records(
        json!([{"type":"input_text","text":files},{"type":"input_text","text":"<image name=[Image #1] path=\"/tmp/a.png\">"},{"type":"input_image","image_url":"data:image/png;base64,ZmFrZS1wbmctMQ=="},{"type":"input_text","text":"</image>"},{"type":"input_text","text":"<image name=[Image #2] path=\"/tmp/b.png\">"},{"type":"input_image","image_url":"data:image/png;base64,ZmFrZS1wbmctMg=="},{"type":"input_text","text":"</image>"},{"type":"input_text","text":"compare these"}]),
        None,
    );
    let turn = extract_media(
        &records,
        Some(&fake_blob),
        crate::types::MultimodalUploadMode::All,
    );
    let parts = user_parts(&turn);
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[0], json!({"type":"text","content":files}));
    assert_eq!(parts[1]["type"], "uri");
    assert_eq!(parts[2]["type"], "uri");
    assert_ne!(parts[1]["uri"], parts[2]["uri"]);
    assert_eq!(parts[3], json!({"type":"text","content":"compare these"}));
    assert_eq!(
        parts,
        vec![
            json!({"type":"text","content":files}),
            expected_image_part("ZmFrZS1wbmctMQ==", "image/png"),
            expected_image_part("ZmFrZS1wbmctMg==", "image/png"),
            json!({"type":"text","content":"compare these"}),
        ]
    );
}
#[test]
fn image_tags_with_unconvertible_path_only_image_remain_literal_text() {
    let records = media_records(
        json!([{"type":"input_text","text":"look"},{"type":"input_text","text":"<image name=[Image #1] path=\"/tmp/a.png\">"},{"type":"input_image","image_url":"/tmp/a.png"},{"type":"input_text","text":"</image>"}]),
        None,
    );
    let turn = extract_media(
        &records,
        Some(&fake_blob),
        crate::types::MultimodalUploadMode::All,
    );
    assert_eq!(
        user_parts(&turn),
        vec![
            json!({"type":"text","content":"look"}),
            json!({"type":"text","content":"<image name=[Image #1] path=\"/tmp/a.png\">"}),
            json!({"type":"text","content":"</image>"})
        ]
    );
}
#[test]
fn function_output_image_array_converts_to_uri_using_the_actual_extractor() {
    let records = media_records(
        json!([{"type":"input_text","text":"/tmp/a.jpg what is this?"}]),
        Some(
            json!([{"type":"input_image","image_url":"data:image/jpeg;base64,ZmFrZS1qcGVn","detail":"high"}]),
        ),
    );
    let turn = extract_media(
        &records,
        Some(&fake_blob),
        crate::types::MultimodalUploadMode::All,
    );
    let tools: Vec<_> = turn.steps.iter().flat_map(|s| s.tools.iter()).collect();
    let tool = tools.iter().find(|t| t.call_id == "c1").expect("tool");
    let output = tool
        .output
        .as_ref()
        .expect("output")
        .as_array()
        .expect("parts");
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["type"], "uri");
    assert_eq!(output[0]["mime_type"], "image/jpeg");
    assert_eq!(output[0]["modality"], "image");
    assert_eq!(
        output.as_slice(),
        &[expected_image_part("ZmFrZS1qcGVn", "image/jpeg")]
    );

    assert!(output[0]["uri"]
        .as_str()
        .expect("uri")
        .starts_with("oss://test/"));
}
#[test]
fn upload_modes_gate_user_and_tool_result_images_as_input_without_base64_leaks() {
    let records = media_records(
        json!([{"type":"input_text","text":"look"},{"type":"input_image","image_url":"data:image/png;base64,ZmFrZS1wbmctbW9kZQ=="}]),
        Some(
            json!([{"type":"input_image","image_url":"data:image/png;base64,ZmFrZS1wbmctbW9kZQ=="}]),
        ),
    );
    use crate::types::MultimodalUploadMode::{All, Input, None, Output};
    for mode in [None, Input, Output, All] {
        let turn = extract_media(&records, Some(&fake_blob), mode);
        let enabled = matches!(mode, Input | All);
        let parts = user_parts(&turn);
        let mut expected = vec![json!({"type":"text","content":"look"})];
        if enabled {
            expected.push(expected_image_part("ZmFrZS1wbmctbW9kZQ==", "image/png"));
        }
        assert_eq!(
            parts, expected,
            "exact user parts and URI position for {mode:?}"
        );
        assert_eq!(
            parts.iter().any(|p| p["type"] == "uri"),
            enabled,
            "{mode:?}"
        );
        let tool = turn
            .steps
            .iter()
            .flat_map(|s| s.tools.iter())
            .find(|t| t.call_id == "c1")
            .expect("tool");
        let encoded = serde_json::to_string(&tool.output).expect("tool");
        if matches!(mode, Output) {
            assert!(tool
                .output
                .as_ref()
                .expect("output")
                .as_array()
                .expect("output parts")
                .iter()
                .all(|p| p["type"] != "uri"));
        }
        if enabled {
            assert_eq!(
                tool.output.as_ref().expect("output"),
                &json!([expected_image_part("ZmFrZS1wbmctbW9kZQ==", "image/png")])
            );
        }
        assert_eq!(encoded.contains("\"type\":\"uri\""), enabled, "{mode:?}");
        assert!(!format!("{turn:?}").contains("ZmFrZS1wbmctbW9kZQ=="));
    }
}
#[test]
fn absent_blob_resolver_drops_embedded_image_payload_instead_of_attaching_raw_media() {
    let records = media_records(
        json!([{"type":"input_text","text":"look"},{"type":"input_image","image_url":"data:image/png;base64,ZmFrZS1wbmc="}]),
        None,
    );
    let turn = extract_media(&records, None, crate::types::MultimodalUploadMode::All);
    assert_eq!(
        user_parts(&turn),
        vec![json!({"type":"text","content":"look"})]
    );
    assert!(!serde_json::to_string(&turn.input_messages)
        .expect("messages")
        .contains("ZmFrZS1wbmc="));
}
#[test]
fn converted_input_images_stop_at_real_multimodal_part_limit_and_keep_prompt_text() {
    use crate::multimodal::types::MAX_MULTIMODAL_PARTS;
    let mut content = vec![json!({"type":"input_text","text":"many"})];
    for n in 0..MAX_MULTIMODAL_PARTS + 2 {
        use base64::Engine;
        content.push(json!({"type":"input_image","image_url":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(format!("img-{n}")))}));
    }
    let turn = extract_media(
        &media_records(json!(content), None),
        Some(&fake_blob),
        crate::types::MultimodalUploadMode::All,
    );
    let parts = user_parts(&turn);
    assert_eq!(
        parts.iter().filter(|p| p["type"] == "uri").count(),
        MAX_MULTIMODAL_PARTS
    );
    assert!(parts.contains(&json!({"type":"text","content":"many"})));
}
#[test]
fn path_only_input_image_does_not_invoke_blob_resolver_or_leak_path_into_input_messages() {
    let called = std::cell::Cell::new(0);
    let resolver = |p: &BlobToUriParams| {
        called.set(called.get() + 1);
        fake_blob(p)
    };
    let records = media_records(
        json!([{"type":"input_text","text":"look"},{"type":"input_image","image_url":"/tmp/pipeline.jpg"}]),
        None,
    );
    let turn = extract_media(
        &records,
        Some(&resolver),
        crate::types::MultimodalUploadMode::All,
    );
    assert_eq!(called.get(), 0);
    assert_eq!(
        user_parts(&turn),
        vec![json!({"type":"text","content":"look"})]
    );
    assert!(!serde_json::to_string(&turn.input_messages)
        .expect("messages")
        .contains("/tmp/pipeline.jpg"));
}
#[test]
fn stable_blob_reuse_key_prevents_repeat_decode_across_partial_extractor_replay() {
    let records = media_records(
        json!([{"type":"input_text","text":"look"},{"type":"input_image","image_url":"data:image/png;base64,ZmFrZS1wbmctcmV1c2U="}]),
        None,
    );
    let cache = std::cell::RefCell::new(HashMap::new());
    let decoded = std::cell::Cell::new(0);
    let resolver = |p: &BlobToUriParams| {
        let key = p.reuse_key.as_ref().expect("reuse key").clone();
        if let Some(hit) = cache.borrow().get(&key).cloned() {
            return Some(hit);
        }
        decoded.set(decoded.get() + 1);
        let out = fake_blob(p).expect("uri");
        cache.borrow_mut().insert(key, out.clone());
        Some(out)
    };
    let first = extract_media(
        &records,
        Some(&resolver),
        crate::types::MultimodalUploadMode::All,
    );
    let second = extract_media(
        &records,
        Some(&resolver),
        crate::types::MultimodalUploadMode::All,
    );
    assert_eq!(user_parts(&first)[1]["type"], "uri");
    assert_eq!(user_parts(&first)[1], user_parts(&second)[1]);
    assert_eq!(decoded.get(), 1);
    let cache = cache.borrow();
    assert_eq!(cache.len(), 1);
    let key = cache.keys().next().expect("key");
    assert_eq!(key.split(':').count(), 2);
    assert!(key
        .split(':')
        .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())));
}
fn child_record() -> Value {
    json!({"timestamp":"2026-08-07T02:00:04.100Z","type":"session_meta","payload":{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-08-07T02:00:04.100Z","cwd":"/tmp/codex-subagent-fixture","originator":"Codex Desktop","source":{"subagent":{"thread_spawn":{"parent_thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","depth":1,"agent_path":"/root/fixture_child","agent_nickname":"FixtureChild","agent_role":null}}},"thread_source":"subagent","model_provider":"openai","multi_agent_version":"v2"}})
}
#[test]
fn owning_session_metadata_preserves_every_single_level_subagent_relationship_field() {
    let record = child_record();
    let child = extract_codex_transcript_meta(record.as_object().expect("record")).expect("meta");
    let got = serde_json::to_value(child).expect("metadata");
    for (key, value) in [
        ("threadId", json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
        (
            "rootSessionId",
            json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
        ("threadSource", json!("subagent")),
        (
            "parentThreadId",
            json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
        ("depth", json!(1)),
        ("createdAtMs", json!(1_786_068_004_100.0)),
        ("agentPath", json!("/root/fixture_child")),
        ("agentNickname", json!("FixtureChild")),
        ("provider", json!("openai")),
    ] {
        assert_eq!(got[key], value, "{key}");
    }
}
#[tokio::test]
async fn cached_owner_metadata_reregisters_child_after_linker_eviction_without_reading_transcript()
{
    let f = Fixture::new();
    let p = f
        .write(
            "rollout-child-cache.jsonl",
            &(child_record().to_string() + "\n"),
        )
        .await;
    let (ino, size, _) = file_meta_snapshot(&p).await.expect("native snapshot");
    f.engine()
        .register_subagent_owner_meta(f.rt(), &p, ino, size, Some(0), true)
        .await
        .expect("first registration");
    assert_eq!(f.input.subagent_link_snapshot().detected_children, 1);
    f.input
        .inner
        .body
        .with_shared(|s| s.linker = crate::inputs::codex_transcript::CodexSubagentLinker::new());
    assert_eq!(f.input.subagent_link_snapshot().detected_children, 0);
    // If cache lookup regresses to physical I/O this fails rather than merely
    // comparing an instrumentation counter written by the same test.
    tokio::fs::remove_file(&p)
        .await
        .expect("remove physical source");
    f.engine()
        .register_subagent_owner_meta(f.rt(), &p, ino, size, Some(0), true)
        .await
        .expect("cached registration");
    assert_eq!(f.input.subagent_link_snapshot().detected_children, 1);
}
#[test]
fn reported_child_fingerprints_evict_oldest_at_the_real_bounded_cap() {
    let f = Fixture::new();
    f.input.inner.body.with_shared(|s| {
        for n in 0..MAX_LINK_DESCRIPTORS {
            s.reported
                .insert(format!("old-child-{n}"), "orphan::parent_not_found".into());
        }
        let mut child = meta("new-child");
        child.thread_source = CodexThreadSource::Subagent;
        child.parent_thread_id = Some("parent-thread".into());
        child.root_session_id = "parent-thread".into();
        child.depth = 1;
        s.linker.register_child(&child);
    });
    f.engine().report_subagent_links(f.rt());
    f.input.inner.body.with_shared(|s| {
        assert_eq!(s.reported.len(), MAX_LINK_DESCRIPTORS);
        assert!(!s.reported.contains_key("old-child-0"));
        assert!(s.reported.contains_key("new-child"));
    });
}
async fn run_real_lifecycle(f: &Fixture) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        f.input.start().await.expect("native start");
        f.input.run_cycle().await;
        f.input.stop().await.expect("native stop");
    })
    .await
    .expect("bounded native lifecycle");
}
#[tokio::test]
async fn task_codex_home_is_discovered_before_stop_hook_and_aborted_work_is_ingested() {
    let f = Fixture::new();
    let text = completed().replace("\"type\":\"task_complete\"", "\"type\":\"turn_aborted\"");
    let p = f
        .write("../task/home/sessions/2026/06/24/rollout-task.jsonl", &text)
        .await;
    let home = f.root.path().join("task/home");
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","turn_id":"turn-1","codex_home":home,"received_at":chrono::Utc::now().to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    let all = f.records();
    assert!(!events(&all, "tool.result").is_empty());
    assert!(!events(&all, "llm.response").is_empty());
    assert!(all
        .iter()
        .any(|e| e["agent.codex.transcript_turn_id"] == "turn-1"));
    let canonical = tokio::fs::canonicalize(&p)
        .await
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    assert_eq!(f.checkpoint(&canonical).scan_offset, text.len() as i64);
}
#[tokio::test]
async fn transcript_path_discovers_user_isolated_home_even_when_marker_has_legacy_root() {
    let f = Fixture::new();
    let p = f
        .write(
            "../home/u/fixture-user/sessions/2026/06/24/rollout-isolated.jsonl",
            &completed(),
        )
        .await;
    let home = f.root.path().join("home");
    let canonical = tokio::fs::canonicalize(&p)
        .await
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","turn_id":"turn-1","codex_home":home,"session_dir":home.join("sessions"),"transcript_path":canonical,"received_at":chrono::Utc::now().to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    let all = f.records();
    assert!(all.iter().any(|e| e["gen_ai.session.id"] == "session-1"));
    assert_eq!(
        f.checkpoint(&canonical).scan_offset,
        completed().len() as i64
    );
}
#[tokio::test]
async fn sixty_four_default_rollouts_do_not_consume_dynamic_session_file_budget() {
    let f = Fixture::new();
    for n in 0..64 {
        f.write(&format!("2026/06/24/rollout-default-{n}.jsonl"), "")
            .await;
    }
    let p = f
        .write(
            "../home/sessions/2026/06/24/rollout-dynamic.jsonl",
            &completed(),
        )
        .await;
    let home = f.root.path().join("home");
    f.marker("wakeups","zzzz-default.json",json!({"session_id":"default-session","session_dir":f.input.inner.body.session_dir,"received_at":chrono::Utc::now().to_rfc3339()})).await;
    f.marker("wakeups","aaaa-dynamic.json",json!({"session_id":"session-1","codex_home":home,"session_dir":home.join("sessions"),"received_at":chrono::Utc::now().to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    assert!(f
        .records()
        .iter()
        .any(|e| e["gen_ai.session.id"] == "session-1"));
    let p = tokio::fs::canonicalize(&p).await.expect("canonical");
    assert_eq!(
        f.checkpoint(p.to_str().expect("path")).scan_offset,
        completed().len() as i64
    );
}
#[tokio::test]
async fn bounded_dynamic_discovery_ignores_rollout_beneath_unrelated_deep_tree() {
    let f = Fixture::new();
    let p = f
        .write(
            "../home/sessions/unrelated/deep/tree/rollout-outside-layout.jsonl",
            &completed(),
        )
        .await;
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","session_dir":f.root.path().join("home/sessions"),"received_at":chrono::Utc::now().to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    assert!(f
        .rt()
        .state_store
        .get(&f.engine().state_key(&p))
        .last_offset()
        .is_none());
    let canonical = tokio::fs::canonicalize(p).await.expect("canonical");
    assert!(f
        .rt()
        .state_store
        .get(&f.engine().state_key(canonical.to_str().expect("path")))
        .last_offset()
        .is_none());
}
#[tokio::test]
async fn marker_root_mismatch_cannot_admit_an_unrelated_codex_session_directory() {
    let f = Fixture::new();
    let p = f
        .write(
            "../unexpected/sessions/2026/06/24/rollout-mismatch-home.jsonl",
            &completed(),
        )
        .await;
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","codex_home":f.root.path().join("expected"),"session_dir":f.root.path().join("unexpected/sessions"),"received_at":chrono::Utc::now().to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    let canonical = tokio::fs::canonicalize(p).await.expect("canonical");
    assert!(f
        .rt()
        .state_store
        .get(&f.engine().state_key(canonical.to_str().expect("path")))
        .last_offset()
        .is_none());
}
#[tokio::test]
async fn newest_valid_marker_is_considered_after_more_than_two_hundred_fifty_six_older_markers() {
    let f = Fixture::new();
    f.write(
        "../newest/sessions/2026/06/24/rollout-newest.jsonl",
        &completed(),
    )
    .await;
    for n in 0..256 {
        f.marker(
            "wakeups",
            &format!("old-{n:03}.json"),
            json!({"session_id":format!("old-{n}"),"received_at":chrono::Utc::now().to_rfc3339()}),
        )
        .await;
    }
    f.marker("wakeups","zzzz-newest.json",json!({"session_id":"session-1","session_dir":f.root.path().join("newest/sessions"),"received_at":chrono::Utc::now().to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    assert!(f
        .records()
        .iter()
        .any(|e| e["gen_ai.session.id"] == "session-1"));
}
#[tokio::test]
async fn expired_dynamic_home_marker_is_removed_without_checkpointing_its_rollout() {
    let f = Fixture::new();
    let p = f
        .write(
            "../stale/sessions/2026/06/24/rollout-stale.jsonl",
            &completed(),
        )
        .await;
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","session_dir":f.root.path().join("stale/sessions"),"received_at":(chrono::Utc::now()-chrono::Duration::hours(49)).to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    assert!(!f
        .root
        .path()
        .join("wakeups")
        .join("session-1.json")
        .exists());
    let canonical = tokio::fs::canonicalize(p).await.expect("canonical");
    assert!(f
        .rt()
        .state_store
        .get(&f.engine().state_key(canonical.to_str().expect("path")))
        .last_offset()
        .is_none());
}
#[tokio::test]
async fn newly_discovered_dynamic_home_ignores_rollouts_inactive_for_sixteen_minutes() {
    let f = Fixture::new();
    let p = f
        .write(
            "../inactive/sessions/2026/06/24/rollout-inactive.jsonl",
            &completed(),
        )
        .await;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&p)
        .expect("fixture file");
    file.set_times(
        std::fs::FileTimes::new()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(16 * 60)),
    )
    .expect("set synthetic age");
    f.marker("wakeups","session-1.json",json!({"session_id":"session-1","session_dir":f.root.path().join("inactive/sessions"),"received_at":chrono::Utc::now().to_rfc3339()})).await;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    let canonical = tokio::fs::canonicalize(p).await.expect("canonical");
    assert!(f
        .rt()
        .state_store
        .get(&f.engine().state_key(canonical.to_str().expect("path")))
        .last_offset()
        .is_none());
}
#[tokio::test]
async fn real_start_baselines_preexisting_default_rollout_without_exporting_history() {
    let f = Fixture::new();
    let text = completed();
    let p = f
        .write("2026/06/24/rollout-default-history.jsonl", &text)
        .await;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    let canonical = tokio::fs::canonicalize(p).await.expect("canonical");
    assert_eq!(
        f.checkpoint(canonical.to_str().expect("path")).scan_offset,
        text.len() as i64
    );
}
struct NativeDetection {
    input: Arc<CodexTranscriptInput>,
    paths: Vec<String>,
    starts: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl crate::types::AgentDetection for NativeDetection {
    fn id(&self) -> &str {
        self.input.id()
    }
    fn type_name(&self) -> &str {
        "codex-transcript"
    }
    fn watch_paths(&self) -> &[String] {
        &self.paths
    }
    fn enabled(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u64 {
        60_000
    }
    async fn is_available(&self) -> bool {
        CodexTranscriptInput::check_availability(
            Some(&self.input.inner.body.wakeup_dir),
            Some(&self.input.inner.body.session_dir),
        )
        .await
    }
    async fn start(&self) -> anyhow::Result<()> {
        self.starts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.input.start().await.map_err(anyhow::Error::msg)
    }
    async fn stop(&self) -> anyhow::Result<()> {
        self.input.stop().await.map_err(anyhow::Error::msg)
    }
}
#[tokio::test]
async fn all_invalid_marker_variants_keep_real_discovery_idle_without_starting_codex() {
    for kind in [
        "expired",
        "malformed",
        "missing-timestamp",
        "unsupported-layout",
        "missing-root",
    ] {
        let f = Fixture::new();
        let home = f.root.path().join("home");
        let isolated = home.join(if kind == "unsupported-layout" {
            "other/fixture/sessions"
        } else {
            "u/fixture/sessions"
        });
        if kind != "missing-root" {
            tokio::fs::create_dir_all(&isolated)
                .await
                .expect("isolated");
        }
        let mut payload = json!({"codex_home":home,"session_dir":isolated,"received_at":chrono::Utc::now().to_rfc3339()});
        if kind == "expired" {
            payload["received_at"] =
                json!((chrono::Utc::now() - chrono::Duration::hours(49)).to_rfc3339());
        }
        if kind == "missing-timestamp" {
            payload
                .as_object_mut()
                .expect("object")
                .remove("received_at");
        }
        f.marker("wakeups", "invalid.json", payload).await;
        if kind == "malformed" {
            tokio::fs::write(f.root.path().join("wakeups/invalid.json"), "{")
                .await
                .expect("invalid");
        }
        let native = Arc::new(NativeDetection {
            input: Arc::new(CodexTranscriptInput {
                inner: f.input.inner.clone(),
            }),
            paths: CodexTranscriptInput::watch_paths(
                Some(&f.input.inner.body.wakeup_dir),
                Some(&f.input.inner.body.session_dir),
            ),
            starts: std::sync::atomic::AtomicUsize::new(0),
        });
        let entry: Arc<dyn crate::types::AgentDetection> = native.clone();
        let service = Arc::new(crate::core::AgentDiscoveryService::new(vec![entry]));
        tokio::time::timeout(std::time::Duration::from_secs(3), service.start())
            .await
            .expect("discovery start");
        assert_eq!(
            service.get_states().get(f.input.id()),
            Some(&crate::types::EntryState::Idle),
            "{kind}"
        );
        assert_eq!(
            native.starts.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "{kind}"
        );
        assert!(!f.input.collector_running());
        assert!(f
            .input
            .inner
            .body
            .watcher_stop
            .lock()
            .expect("watcher")
            .is_none());
        assert!(
            !f.root.path().join("sessions").exists(),
            "native on_start must not create a baseline directory"
        );
        tokio::time::timeout(std::time::Duration::from_secs(3), service.stop())
            .await
            .expect("discovery stop");
    }
}
async fn start_until_first_native_cycle(f: &Fixture) {
    let cycles = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let slot = cycles.clone();
    f.input.inner.on_runtime_delta(move |_| {
        slot.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    f.input.start().await.expect("real startup");
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while cycles.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first actual collection completion");
    f.input.stop().await.expect("real bounded stop");
}

fn simple_turn(turn: &str, input: u64, output: u64, seconds: i64) -> Vec<String> {
    let base = chrono::DateTime::parse_from_rfc3339("2026-06-24T06:00:00Z").expect("time")
        + chrono::Duration::seconds(seconds);
    let at = |s: i64| (base + chrono::Duration::seconds(s)).to_rfc3339();
    vec![
        record(
            &at(0),
            "session_meta",
            json!({"id":"session-1","model_provider":"openai"}),
        ),
        record(
            &at(1),
            "turn_context",
            json!({"turn_id":turn,"model":"gpt-5.5","cwd":"/tmp/project"}),
        ),
        record(
            &at(2),
            "event_msg",
            json!({"type":"task_started","turn_id":turn}),
        ),
        record(
            &at(3),
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("prompt {turn}")}]}),
        ),
        record(
            &at(4),
            "event_msg",
            json!({"type":"agent_message","message":format!("response {turn}"),"phase":"final"}),
        ),
        record(&at(4), "event_msg", usage(input, output)),
        record(
            &at(5),
            "event_msg",
            json!({"type":"task_complete","turn_id":turn,"last_agent_message":format!("response {turn}")}),
        ),
    ]
}
fn control_abort() -> Vec<String> {
    vec![
        record(
            "2026-06-24T06:00:00.000Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"turn-control"}),
        ),
        record(
            "2026-06-24T06:00:01.000Z",
            "turn_context",
            json!({"turn_id":"turn-control","model":"gpt-5.5"}),
        ),
        record(
            "2026-06-24T06:00:02.000Z",
            "session_meta",
            json!({"id":"session-1","model_provider":"openai"}),
        ),
        record(
            "2026-06-24T06:00:03.000Z",
            "response_item",
            json!({"type":"message","role":"developer","content":[{"type":"input_text","text":"<turn_aborted> previous turn interrupted"}]}),
        ),
        record(
            "2026-06-24T06:00:04.000Z",
            "event_msg",
            json!({"type":"turn_aborted","turn_id":"turn-control"}),
        ),
    ]
}
#[tokio::test]
async fn hundred_terminal_budget_resumes_at_durable_offset_without_losing_the_hundred_and_first_turn(
) {
    let f = Fixture::new();
    let mut lines = Vec::new();
    for n in 0..101 {
        let turn = simple_turn(&format!("turn-{n}"), 100 + n, 10, n as i64 * 10);
        lines.extend(if n == 0 {
            turn
        } else {
            turn.into_iter().skip(1).collect()
        });
    }
    let text = lines.join("\n") + "\n";
    let p = f.write("rollout-terminal-budget.jsonl", &text).await;
    f.process(&p).await;
    assert_eq!(events(&f.records(), "llm.response").len(), 100);
    assert!(f.checkpoint(&p).scan_offset < text.len() as i64);
    f.process(&p).await;
    assert_eq!(events(&f.records(), "llm.response").len(), 101);
    assert_eq!(f.checkpoint(&p).scan_offset, text.len() as i64);
}
#[tokio::test]
async fn control_only_abort_consumes_its_range_and_collects_following_normal_turn_in_the_same_cycle(
) {
    let f = Fixture::new();
    let mut lines = control_abort();
    lines.extend(simple_turn("turn-normal", 120, 12, 60).into_iter().skip(1));
    let p = f
        .write("rollout-control-abort.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let all = f.records();
    assert!(all
        .iter()
        .all(|e| e["agent.codex.transcript_turn_id"] != "turn-control"));
    let normal = events(&all, "llm.response");
    assert_eq!(normal.len(), 1);
    assert_eq!(normal[0]["agent.codex.transcript_turn_id"], "turn-normal");
    let cp = f.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
}
#[tokio::test]
async fn truly_unparseable_legacy_pending_range_survives_durable_restart_and_blocks_later_work() {
    let first = Fixture::new();
    let pending = record(
        "2026-06-24T06:00:00.000Z",
        "event_msg",
        json!({"type":"task_started","turn_id":"turn-unparseable"}),
    ) + "\n";
    let p = first
        .write(
            "rollout-unparseable-pending.jsonl",
            &(pending.clone() + &simple_turn("turn-normal", 120, 12, 60).join("\n") + "\n"),
        )
        .await;
    let (ino, _, _) = file_meta_snapshot(&p).await.expect("native snapshot");
    first.rt().state_store.update(&first.engine().state_key(&p),InputStatePatch{last_offset:Some(pending.len() as f64),extra:Some(json!({"codexTranscript":{"inode":ino,"scanOffset":pending.len(),"activeTurn":{"turnId":"turn-unparseable","startOffset":0,"startedAtMs":1_782_280_800_000.0},"pendingTerminal":{"turnId":"turn-unparseable","terminalEndOffset":pending.len()},"latestSessionMetaOffset":null,"emittedTerminalTurnIds":[]}})),..Default::default()});
    let second = first.restart().await;
    start_until_first_native_cycle(&second).await;
    assert!(second.records().is_empty());
    let cp = second.checkpoint(&p);
    assert_eq!(cp.scan_offset, pending.len() as i64);
    let still = cp.pending_terminal.expect("pending retained");
    assert_eq!(still.turn_id, "turn-unparseable");
    assert_eq!(still.retry_count, Some(1));
    assert_eq!(still.source_record_count, Some(1));
}
fn turn_block(turn: &str, base: &str) -> Vec<String> {
    let at = chrono::DateTime::parse_from_rfc3339(base).expect("time");
    let ts = |s: i64| (at + chrono::Duration::seconds(s)).to_rfc3339();
    vec![
        record(
            &ts(0),
            "turn_context",
            json!({"turn_id":turn,"model":"gpt-5.5","cwd":"/tmp/p"}),
        ),
        record(
            &ts(1),
            "event_msg",
            json!({"type":"task_started","turn_id":turn}),
        ),
        record(
            &ts(2),
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}),
        ),
        record(
            &ts(3),
            "event_msg",
            json!({"type":"agent_message","message":format!("done-{turn}"),"phase":"final"}),
        ),
        record(&ts(4), "event_msg", usage(100, 10)),
        record(
            &ts(5),
            "event_msg",
            json!({"type":"task_complete","turn_id":turn,"last_agent_message":format!("done-{turn}")}),
        ),
    ]
}
fn uuid_at(at: &str, tail: u64) -> String {
    let hex = format!(
        "{:012x}",
        chrono::DateTime::parse_from_rfc3339(at)
            .expect("time")
            .timestamp_millis()
    );
    format!("{}-{}-7000-8000-{tail:012x}", &hex[..8], &hex[8..])
}
fn owner_meta(owner: &str, parent: &str, subagent: bool) -> String {
    let mut payload = json!({"id":owner,"forked_from_id":parent,"thread_source":if subagent{"subagent"}else{"user"},"model_provider":"openai"});
    if subagent {
        payload["source"] = json!({"subagent":{"thread_spawn":{"parent_thread_id":parent,"depth":1,"agent_path":"/root/child"}}});
    }
    record("2026-08-05T10:00:00.000Z", "session_meta", payload)
}
fn responses_for(records: &[Value], turn: &str) -> Vec<Value> {
    events(records, "llm.response")
        .into_iter()
        .filter(|e| e["agent.codex.transcript_turn_id"] == turn)
        .collect()
}
async fn prefix_is_dropped(subagent: bool) {
    let f = Fixture::new();
    let owner = "cccccccc-2222-4222-8222-222222222222";
    let parent = "aaaaaaaa-8888-4888-8888-888888888888";
    let mut lines = vec![
        owner_meta(owner, parent, subagent),
        record(
            "2026-06-01T00:00:00.000Z",
            "session_meta",
            json!({"id":parent,"thread_source":"user","model_provider":"openai"}),
        ),
    ];
    lines.extend(turn_block("copied-turn", "2026-06-01T00:00:10Z"));
    lines.push(record(
        "2026-08-05T10:00:05.000Z",
        "event_msg",
        json!({"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.5"}}),
    ));
    lines.extend(turn_block("child-turn", "2026-08-05T10:00:10Z"));
    let p = f
        .write(
            &format!("2026/08/05/rollout-2026-08-05T10-00-00-{owner}.jsonl"),
            &(lines.join("\n") + "\n"),
        )
        .await;
    f.marker("wakeups",&format!("{owner}.json"),json!({"session_id":owner,"turn_id":"child-turn","initial_turn_id":"child-turn","transcript_path":p,"hook_event":if subagent{"subagent-stop"}else{"stop"},"received_at":chrono::Utc::now().to_rfc3339()})).await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(responses_for(&all, "child-turn").len(), 1);
    assert!(all
        .iter()
        .all(|e| e["agent.codex.transcript_turn_id"] != "copied-turn"));
}
#[tokio::test]
async fn fork_rollout_drops_copied_ancestor_prefix_and_emits_only_owned_turn() {
    prefix_is_dropped(false).await;
}
#[tokio::test]
async fn subagent_rollout_drops_copied_parent_prefix_and_emits_only_owned_turn() {
    prefix_is_dropped(true).await;
}
#[tokio::test]
async fn normal_user_rollout_without_copied_prefix_is_never_skipped() {
    let f = Fixture::new();
    let owner = "dddddddd-3333-4333-8333-333333333333";
    let mut lines = vec![record(
        "2026-08-05T10:00:00.000Z",
        "session_meta",
        json!({"id":owner,"thread_source":"user","model_provider":"openai"}),
    )];
    lines.extend(turn_block("normal-turn", "2026-08-05T10:00:10Z"));
    let p = f
        .write(
            &format!("2026/08/05/rollout-2026-08-05T10-00-00-{owner}.jsonl"),
            &(lines.join("\n") + "\n"),
        )
        .await;
    f.process(&p).await;
    assert_eq!(responses_for(&f.records(), "normal-turn").len(), 1);
}
async fn startup_copied_baseline_does_not_poison_parent(subagent: bool) {
    let f = Fixture::new();
    let parent = uuid_at("2026-08-05T09:00:00Z", 41);
    let owner = uuid_at("2026-08-05T10:00:00Z", 42);
    let parent_turn = uuid_at("2026-08-05T09:30:00Z", 43);
    let child_turn = uuid_at("2026-08-05T10:00:00.010Z", 44);
    let parent_meta = record(
        "2026-08-05T09:00:00Z",
        "session_meta",
        json!({"id":parent,"thread_source":"user","model_provider":"openai"}),
    );
    let p = f
        .write(
            &format!("2026/08/05/rollout-2026-08-05T09-00-00-{parent}.jsonl"),
            &(parent_meta.clone()
                + "\n"
                + &turn_block(&parent_turn, "2026-08-05T09:30:00Z").join("\n")
                + "\n"),
        )
        .await;
    let (ino, _, _) = file_meta_snapshot(&p).await.expect("native snapshot");
    let mut cp = empty_checkpoint(ino);
    cp.scan_offset = (parent_meta.len() + 1) as i64;
    cp.owner_session_meta_offset = Some(0);
    f.engine()
        .save_checkpoint(f.rt(), &f.engine().state_key(&p), &cp);
    let mut lines = vec![owner_meta(&owner, &parent, subagent)];
    lines.extend(turn_block(&parent_turn, "2026-08-05T09:30:00Z"));
    lines.extend(turn_block(&child_turn, "2026-08-05T10:00:00.010Z"));
    f.write(
        &format!("2026/08/05/rollout-2026-08-05T10-00-00-{owner}.jsonl"),
        &(lines.join("\n") + "\n"),
    )
    .await;
    run_real_lifecycle(&f).await;
    let all = f.records();
    assert_eq!(responses_for(&all, &parent_turn).len(), 1);
    assert!(responses_for(&all, &child_turn).is_empty());
}
#[tokio::test]
async fn startup_baselined_user_fork_never_suppresses_the_uncollected_parent_turn() {
    startup_copied_baseline_does_not_poison_parent(false).await;
}
#[tokio::test]
async fn startup_baselined_subagent_never_suppresses_the_uncollected_parent_turn() {
    startup_copied_baseline_does_not_poison_parent(true).await;
}
#[tokio::test]
async fn same_millisecond_uuidv7_causality_collects_first_owned_turn_without_any_hook() {
    let f = Fixture::new();
    let parent = uuid_at("2026-08-05T09:00:00Z", 21);
    let owner = uuid_at("2026-08-05T10:00:00Z", 22);
    let old = uuid_at("2026-08-05T09:30:00Z", 23);
    let owned = uuid_at("2026-08-05T10:00:00Z", 24);
    let mut lines = vec![owner_meta(&owner, &parent, false)];
    lines.push(record(
        "2026-08-05T09:00:00Z",
        "session_meta",
        json!({"id":parent,"model_provider":"openai"}),
    ));
    lines.extend(turn_block(&old, "2026-08-05T09:30:00Z"));
    lines.extend(turn_block(&owned, "2026-08-05T10:00:00Z"));
    let second_owned = uuid_at("2026-08-05T10:01:00Z", 25);
    lines.extend(turn_block(&second_owned, "2026-08-05T10:01:00Z"));
    let p = f
        .write(
            &format!("2026/08/05/rollout-2026-08-05T10-00-00-{owner}.jsonl"),
            &(lines.join("\n") + "\n"),
        )
        .await;
    f.process(&p).await;
    let all = f.records();
    assert!(responses_for(&all, &old).is_empty());
    assert_eq!(responses_for(&all, &owned).len(), 1);
    let first_response = responses_for(&all, &owned);
    assert_eq!(first_response[0]["gen_ai.response.model"], "gpt-5.5");
    assert_eq!(first_response[0]["agent.codex.cwd"], "/tmp/p");
    assert_eq!(responses_for(&all, &second_owned).len(), 1);

    assert!(f.checkpoint(&p).fork_bootstrap.is_none());
}
#[tokio::test]
async fn hook_anchor_uses_turn_context_when_task_started_is_absent() {
    let f = Fixture::new();
    let owner = "cccccccc-0005-4005-8005-000000000005";
    let owned = "turn-context-only-owned-turn";
    let mut lines = vec![owner_meta(owner, "parent", false)];
    lines.extend(turn_block(
        "copied-parent-turn-with-start",
        "2026-08-04T10:00:00Z",
    ));
    lines.extend(
        turn_block(owned, "2026-08-05T10:00:00.010Z")
            .into_iter()
            .filter(|l| {
                serde_json::from_str::<Value>(l).expect("record")["payload"]["type"]
                    != "task_started"
            }),
    );
    let p = f
        .write(
            &format!("2026/08/05/rollout-2026-08-05T10-00-00-{owner}.jsonl"),
            &(lines.join("\n") + "\n"),
        )
        .await;
    f.marker(
        "wakeups",
        &format!("{owner}.json"),
        json!({"session_id":owner,"initial_turn_id":owned,"transcript_path":p,"hook_event":"stop"}),
    )
    .await;
    f.process(&p).await;
    let all = f.records();
    assert!(responses_for(&all, "copied-parent-turn-with-start").is_empty());
    let r = responses_for(&all, owned);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.response.model"], "gpt-5.5");
    assert_eq!(r[0]["agent.codex.cwd"], "/tmp/p");
}
fn isolated_diagnostic_records(scenario: &str) -> Vec<Value> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let root = isolated_fixture_root();
    let mut command = Command::new(std::env::current_exe().expect("native test executable"));
    command.args(["--exact","inputs::codex_transcript::input::engine::history_contracts::native_diagnostic_records_preserve_control_retry_resource_and_anchor_reasons","--nocapture"]);
    command
        .env_clear()
        .current_dir(root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
    for key in [
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TEMP",
        "TMP",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "CURSOR_AGENT_HOME",
        "QODER_USER_DATA_DIR",
        "LOONGSUITE_PILOT_DATA_DIR",
        "LOONGSUITE_PILOT_CACHE_DIR",
    ] {
        command.env(key, root.path());
    }
    command
        .env("PATH", root.path().join("no-runtime"))
        .env(
            "AGENT_DATA_COLLECTION_CONFIG",
            root.path().join("absent-config.json"),
        )
        .env("LOG_LEVEL", "debug")
        .env("PILOT_SYNTHETIC_CODEX_DIAGNOSTIC", scenario);
    let mut child = command.spawn().expect("native child");
    let capture = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream
                .take(1_048_577)
                .read_to_end(&mut bytes)
                .expect("bounded child capture");
            assert!(bytes.len() <= 1_048_576, "child exceeded output bound");
            bytes
        })
    };
    let stdout = capture(Box::new(child.stdout.take().expect("stdout")));
    let stderr = capture(Box::new(child.stderr.take().expect("stderr")));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().expect("child state") {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("native diagnostic child timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    let out = stdout.join().expect("stdout capture");
    let err = stderr.join().expect("stderr capture");
    assert!(
        status.success(),
        "native child scenario {scenario}: {}",
        String::from_utf8_lossy(&err)
    );
    out.split(|b| *b == b'\n')
        .chain(err.split(|b| *b == b'\n'))
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|line| line.get("msg").is_some())
        .collect()
}
#[tokio::test]
async fn native_diagnostic_records_preserve_control_retry_resource_and_anchor_reasons() {
    if let Ok(scenario) = std::env::var("PILOT_SYNTHETIC_CODEX_DIAGNOSTIC") {
        let f = Fixture::new();
        match scenario.as_str() {
            "control" => {
                let mut lines = control_abort();
                lines.extend(simple_turn("turn-normal", 120, 12, 60).into_iter().skip(1));
                let p = f
                    .write("rollout-control-logs.jsonl", &(lines.join("\n") + "\n"))
                    .await;
                f.process(&p).await;
                assert!(f
                    .records()
                    .iter()
                    .all(|e| e["agent.codex.transcript_turn_id"] != "turn-control"));
                assert_eq!(responses_for(&f.records(), "turn-normal").len(), 1);
            }
            "live-control" => {
                assert_live_control_does_not_end_collection(&f).await;
            }
            "fork-control" => {
                assert_copied_control_forks_restart_without_control_recovery(&f).await;
            }
            "invalid-offset" => {
                assert_invalid_fork_search_repair(&f).await;
            }
            "pending" => {
                let pending = record(
                    "2026-06-24T06:00:00.000Z",
                    "event_msg",
                    json!({"type":"task_started","turn_id":"turn-unparseable"}),
                ) + "\n";
                let p = f
                    .write(
                        "rollout-pending-logs.jsonl",
                        &(pending.clone()
                            + &simple_turn("turn-normal", 120, 12, 60).join("\n")
                            + "\n"),
                    )
                    .await;
                let (ino, _, _) = file_meta_snapshot(&p).await.expect("native snapshot");
                let mut cp = empty_checkpoint(ino);
                cp.scan_offset = pending.len() as i64;
                cp.active_turn = Some(create_active_turn(
                    "turn-unparseable".into(),
                    0,
                    1_782_280_800_000.0,
                    false,
                ));
                cp.pending_terminal =
                    Some(crate::inputs::codex_transcript::CodexPendingTerminalTurn {
                        turn_id: "turn-unparseable".into(),
                        terminal_end_offset: pending.len() as i64,
                        retry_count: None,
                        first_pending_at_ms: None,
                        last_attempt_at_ms: None,
                        source_record_count: None,
                    });
                f.engine()
                    .save_checkpoint(f.rt(), &f.engine().state_key(&p), &cp);
                f.process(&p).await;
                assert!(f.records().is_empty());
                println!(
                    "{}",
                    json!({"msg":"synthetic fixture expected pending path","expectedPath":p})
                );
                assert_eq!(
                    f.checkpoint(&p)
                        .pending_terminal
                        .expect("retained")
                        .retry_count,
                    Some(1)
                );
            }
            "resource" => {
                f.marker(
                    "wakeups",
                    "session-1.json",
                    json!({"session_id":"session-1"}),
                )
                .await;
                println!(
                    "{}",
                    json!({"msg":"synthetic fixture expected resource marker","expectedMarker":f.root.path().join("wakeups").join("session-1.json")})
                );
                let p = f.write("rollout-resource-logs.jsonl", &completed()).await;
                f.process(&p).await;
                assert_eq!(events(&f.records(), "llm.response").len(), 3);
                assert!(f
                    .records()
                    .iter()
                    .all(|e| e.get("resourceAttributes").is_none()));
            }
            "registry" => {
                assert_cross_transcript_restore().await;
            }
            other if other.starts_with("root-cap-") => {
                let count = other
                    .trim_start_matches("root-cap-")
                    .parse::<usize>()
                    .expect("synthetic count");
                assert!([33, 64, 65].contains(&count));
                assert_global_root_priority(count).await;
            }
            "anchor" => {
                let owner = "cccccccc-0004-4004-8004-000000000004";
                let mut lines = vec![owner_meta(owner, "parent", false)];
                lines.extend(turn_block("copied-parent-turn", "2026-08-04T10:00:00Z"));
                lines.extend(turn_block(
                    "owned-turn-from-soft-path-anchor",
                    "2026-08-05T10:00:00.010Z",
                ));
                let name = format!("rollout-2026-08-05T10-00-00-{owner}.jsonl");
                let p = f
                    .write(&format!("2026/08/05/{name}"), &(lines.join("\n") + "\n"))
                    .await;
                f.marker("wakeups",&format!("{owner}.json"),json!({"session_id":owner,"initial_turn_id":"owned-turn-from-soft-path-anchor","transcript_path":f.root.path().join("different-spelling").join(name),"hook_event":"stop"})).await;
                f.process(&p).await;
                assert!(responses_for(&f.records(), "copied-parent-turn").is_empty());
                assert_eq!(
                    responses_for(&f.records(), "owned-turn-from-soft-path-anchor").len(),
                    1
                );
            }
            other => panic!("unknown synthetic scenario {other}"),
        }
        return;
    }
    let registry = isolated_diagnostic_records("registry");
    assert!(!registry
        .iter()
        .any(|e| e["msg"] == "skipped terminal Codex turn already present in global registry"));
    let control = isolated_diagnostic_records("control");
    let skipped = control
        .iter()
        .find(|e| e["msg"] == "processed terminal Codex turn without observable entries")
        .expect("control explanation diagnostic");
    assert_eq!(skipped["turnId"], "turn-control");
    assert_eq!(skipped["terminalStatus"], "interrupted");
    assert!(!control
        .iter()
        .any(|e| e["msg"] == "processed terminal Codex turn produced no explainable new entries"));
    let pending = isolated_diagnostic_records("pending");
    let retry = pending
        .iter()
        .find(|e| e["msg"] == "pending Codex terminal turn still could not be parsed; will retry")
        .expect("pending retry diagnostic");
    assert_eq!(retry["level"], "WARN");
    assert_eq!(retry["turnId"], "turn-unparseable");
    assert_eq!(retry["retryCount"], 1);
    assert_eq!(retry["sourceRecordCount"], 1);
    let expected_pending = pending
        .iter()
        .find(|e| e["msg"] == "synthetic fixture expected pending path")
        .expect("fixture pending path");
    assert_eq!(retry["transcriptPath"], expected_pending["expectedPath"]);
    let resource = isolated_diagnostic_records("resource");
    let attribution = resource
        .iter()
        .find(|e| e["msg"] == "Codex wakeup marker has no resourceAttributes; attribution skipped")
        .expect("missing resource attribution diagnostic");
    assert_eq!(attribution["level"], "DEBUG");
    let expected_resource = resource
        .iter()
        .find(|e| e["msg"] == "synthetic fixture expected resource marker")
        .expect("fixture resource marker");
    assert_eq!(attribution["marker"], expected_resource["expectedMarker"]);
    let anchor = isolated_diagnostic_records("anchor");
    let accepted = anchor
        .iter()
        .find(|e| {
            e["msg"]
                .as_str()
                .is_some_and(|s| s.contains("accepting session anchor"))
        })
        .expect("soft-path acceptance diagnostic");
    assert_eq!(accepted["level"], "WARN");
    assert_eq!(
        accepted["sessionId"],
        "cccccccc-0004-4004-8004-000000000004"
    );
}
fn runtime_deltas(f: &Fixture) -> Arc<Mutex<Vec<crate::inputs::base::InputRuntimeDelta>>> {
    let out = Arc::new(Mutex::new(Vec::new()));
    let slot = out.clone();
    f.input
        .inner
        .on_runtime_delta(move |delta| slot.lock().expect("deltas").push(delta.clone()));
    out
}
#[tokio::test]
async fn preexisting_idle_owner_metadata_reuse_has_no_physical_read_in_first_native_cycle() {
    let f = Fixture::new();
    let deltas = runtime_deltas(&f);
    f.write("2026/06/24/rollout-idle-metadata.jsonl", &completed())
        .await;
    run_real_lifecycle(&f).await;
    let deltas = deltas.lock().expect("deltas");
    assert!(!deltas.is_empty());
    assert_eq!(deltas[0].raw_read_calls, 0);
    assert_eq!(deltas[0].raw_read_bytes, 0);
}
#[tokio::test]
async fn cold_historical_files_are_not_restatted_by_each_default_collection_cycle() {
    let f = Fixture::new();
    let deltas = runtime_deltas(&f);
    let mut old_paths = Vec::new();
    for n in 0..12 {
        let p = f
            .write(
                &format!("2024/01/{:02}/rollout-old-{n}.jsonl", n + 1),
                &(record(
                    "2024-01-01T00:00:00Z",
                    "session_meta",
                    json!({"id":format!("old-{n}"),"model_provider":"openai"}),
                ) + "\n"),
            )
            .await;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&p)
            .expect("old file")
            .set_times(std::fs::FileTimes::new().set_modified(
                std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 3600),
            ))
            .expect("historical age");
        old_paths.push(p);
    }
    let recent = f
        .write("2026/06/24/rollout-recent.jsonl", &completed())
        .await;
    f.input.start().await.expect("start");
    f.input.run_cycle().await;
    let cold_offset = f.checkpoint(&old_paths[0]).scan_offset;
    let recent_offset = f.checkpoint(&recent).scan_offset;
    let before = deltas.lock().expect("deltas").len();
    f.append(
        &old_paths[0],
        &(record(
            "2024-01-01T00:00:01Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"late-turn"}),
        ) + "\n"),
    )
    .await;
    f.input.run_cycle().await;
    assert_eq!(f.checkpoint(&old_paths[0]).scan_offset, cold_offset);
    let after = deltas.lock().expect("deltas").clone();
    assert!(after.len() > before);
    assert_eq!(after.last().expect("cycle").raw_read_calls, 0);
    f.append(
        &recent,
        &(record(
            "2026-06-24T06:20:00Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"turn-2"}),
        ) + "\n"),
    )
    .await;
    f.input.run_cycle().await;
    assert!(f.checkpoint(&recent).scan_offset > recent_offset);
    assert_eq!(f.checkpoint(&old_paths[0]).scan_offset, cold_offset);
    let created = f
        .write(
            "2026/06/25/rollout-new.jsonl",
            &(record(
                "2026-06-25T00:00:00Z",
                "session_meta",
                json!({"id":"new-session","model_provider":"openai"}),
            ) + "\n"),
        )
        .await;
    f.input.run_cycle().await;
    assert!(f
        .engine()
        .read_checkpoint(f.rt(), &f.engine().state_key(&created))
        .is_some());
    assert_eq!(f.checkpoint(&old_paths[0]).scan_offset, cold_offset);
    f.input.stop().await.expect("stop");
}
#[tokio::test]
async fn runtime_callbacks_distinguish_physical_reads_from_unique_jsonl_commits_and_parse_failures()
{
    let f = Fixture::new();
    let deltas = runtime_deltas(&f);
    f.input.start().await.expect("start");
    f.input.run_cycle().await;
    let text = completed();
    let p = f.write("2026/06/24/rollout-runtime.jsonl", &text).await;
    f.input.run_cycle().await;
    let first = deltas
        .lock()
        .expect("deltas")
        .iter()
        .find(|d| d.raw_in_bytes > 0)
        .expect("consumption delta")
        .clone();
    assert!(first.raw_read_calls > 0);
    assert!(first.raw_read_bytes >= first.raw_in_bytes);
    assert_eq!(first.raw_in_bytes, text.len() as u64);
    assert_eq!(first.raw_in_records, text.lines().count() as u64);
    assert_eq!(first.parse_success_records, text.lines().count() as u64);
    assert_eq!(first.parse_failed_records, 0);
    assert!(first.raw_in_max_batch_bytes > 0 && first.raw_in_max_record_bytes > 0);
    assert!(first.read_duration_ms >= 0.0 && first.process_duration_ms >= 0.0);
    let diagnostic = format!("{first:?}");
    for forbidden in ["session_id", "turn_id", "trace_id", "session-1", "turn-1"] {
        assert!(!diagnostic.contains(forbidden), "{forbidden}");
    }
    let invalid = "not-json\n";
    f.append(&p, invalid).await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    let all = deltas.lock().expect("deltas");
    let invalid_read = all
        .iter()
        .find(|d| d.parse_failed_records > 0)
        .expect("parse failure delta");
    assert_eq!(invalid_read.raw_in_bytes, invalid.len() as u64);
    assert_eq!(invalid_read.raw_in_records, 1);
    assert_eq!(invalid_read.parse_success_records, 0);
    assert_eq!(invalid_read.parse_failed_records, 1);
    assert_eq!(
        all.iter().map(|d| d.raw_in_bytes).sum::<u64>(),
        (text.len() + invalid.len()) as u64
    );
}
async fn fork_path(f: &Fixture, owner: &str, lines: &[String]) -> String {
    f.write(
        &format!("2026/08/05/rollout-2026-08-05T10-00-00-{owner}.jsonl"),
        &(lines.join("\n") + "\n"),
    )
    .await
}
async fn initial_hook(f: &Fixture, owner: &str, turn: &str, path: &str, event: &str) {
    f.marker("wakeups",&format!("{owner}.json"),json!({"session_id":owner,"initial_turn_id":turn,"turn_id":turn,"transcript_path":path,"hook_event":event})).await;
}
#[tokio::test]
async fn non_uuid_fork_remains_pending_until_an_initial_turn_hook_exists() {
    let f = Fixture::new();
    let owner = "cccccccc-0001-4001-8001-000000000001";
    let parent = "aaaaaaaa-0001-4001-8001-000000000001";
    let mut lines = vec![
        owner_meta(owner, parent, false),
        record(
            "2026-06-01T00:00:00Z",
            "session_meta",
            json!({"id":parent,"model_provider":"openai"}),
        ),
    ];
    lines.extend(turn_block("parent-turn-awaiting", "2026-06-01T00:00:10Z"));
    lines.extend(turn_block("child-turn-awaiting", "2026-08-05T10:00:10Z"));
    let p = fork_path(&f, owner, &lines).await;
    f.process(&p).await;
    assert!(f.records().is_empty());
    let cp = f.checkpoint(&p);
    assert_eq!(cp.scan_offset, 0);
    assert_eq!(
        cp.fork_bootstrap.expect("pending bootstrap").search_offset,
        (lines.join("\n") + "\n").len() as i64
    );
}
#[tokio::test]
async fn later_stop_turn_is_recovery_evidence_without_skipping_earlier_owned_turn() {
    let f = Fixture::new();
    let parent = uuid_at("2026-08-05T09:00:00Z", 11);
    let owner = uuid_at("2026-08-05T10:00:00Z", 12);
    let old = uuid_at("2026-08-05T09:30:00Z", 13);
    let first = uuid_at("2026-08-05T10:00:00.010Z", 14);
    let last = uuid_at("2026-08-05T10:01:00Z", 15);
    let mut lines = vec![owner_meta(&owner, &parent, false)];
    lines.extend(turn_block(&old, "2026-08-05T09:30:00Z"));
    lines.extend(turn_block(&first, "2026-08-05T10:00:00.010Z"));
    lines.extend(turn_block(&last, "2026-08-05T10:01:00Z"));
    let p = fork_path(&f, &owner, &lines).await;
    f.marker("wakeups",&format!("{owner}.json"),json!({"session_id":owner,"turn_id":last,"recovery_turn_id":last,"transcript_path":p,"hook_event":"stop"})).await;
    f.process(&p).await;
    let all = f.records();
    assert!(responses_for(&all, &old).is_empty());
    assert_eq!(responses_for(&all, &first).len(), 1);
    assert_eq!(responses_for(&all, &last).len(), 1);
}
#[tokio::test]
async fn initial_hook_before_task_started_keeps_exact_turn_search_resumable() {
    let f = Fixture::new();
    let owner = "cccccccc-0002-4002-8002-000000000002";
    let parent = "aaaaaaaa-0002-4002-8002-000000000002";
    let turn = "child-turn-late-write";
    let mut lines = vec![
        owner_meta(owner, parent, false),
        record(
            "2026-06-01T00:00:00Z",
            "session_meta",
            json!({"id":parent,"model_provider":"openai"}),
        ),
    ];
    lines.extend(turn_block(
        "parent-turn-before-hook",
        "2026-06-01T00:00:10Z",
    ));
    let p = fork_path(&f, owner, &lines).await;
    initial_hook(&f, owner, turn, &p, "user-prompt-submit").await;
    f.process(&p).await;
    let pending = f.checkpoint(&p);
    assert_eq!(pending.scan_offset, 0);
    let bootstrap = pending.fork_bootstrap.expect("search");
    assert_eq!(bootstrap.initial_turn_id.as_deref(), Some(turn));
    assert!(bootstrap.search_offset > 0);
    f.append(&p,&([
 record("2026-08-05T10:00:05Z","event_msg",json!({"type":"thread_settings_applied"})),
 record("2026-08-05T10:00:10Z","event_msg",json!({"type":"task_started","turn_id":turn})),
 record("2026-08-05T10:00:11Z","turn_context",json!({"turn_id":turn,"model":"gpt-5.5"})),
 record("2026-08-05T10:00:12Z","response_item",json!({"type":"message","role":"user","content":[{"type":"input_text","text":"new child work"}]})),
 record("2026-08-05T10:00:13Z","event_msg",json!({"type":"agent_message","message":"done","phase":"final"})),
 record("2026-08-05T10:00:14Z","event_msg",usage(10,2)),
 record("2026-08-05T10:00:15Z","event_msg",json!({"type":"task_complete","turn_id":turn}))].join("\n")+"\n")).await;
    f.process(&p).await;
    assert!(responses_for(&f.records(), turn).is_empty());
    f.process(&p).await;
    let all = f.records();
    assert_eq!(responses_for(&all, turn).len(), 1);
    assert!(responses_for(&all, "parent-turn-before-hook").is_empty());
    assert!(f.checkpoint(&p).fork_bootstrap.is_none());
}
#[tokio::test]
async fn recursive_fork_uses_explicit_hook_turn_instead_of_historical_settings_markers() {
    let f = Fixture::new();
    let owner = "cccccccc-0003-4003-8003-000000000003";
    let parent = "bbbbbbbb-0003-4003-8003-000000000003";
    let grand = "aaaaaaaa-0003-4003-8003-000000000003";
    let turn = "current-fork-turn";
    let mut lines = vec![
        owner_meta(owner, parent, false),
        record(
            "2026-08-04T10:00:00Z",
            "session_meta",
            json!({"id":parent,"forked_from_id":grand,"model_provider":"openai"}),
        ),
        record(
            "2026-08-03T10:00:00Z",
            "session_meta",
            json!({"id":grand,"model_provider":"openai"}),
        ),
    ];
    lines.extend(turn_block("grandparent-turn", "2026-08-03T10:00:10Z"));
    lines.push(record(
        "2026-08-03T10:01:00Z",
        "event_msg",
        json!({"type":"thread_settings_applied"}),
    ));
    lines.extend(turn_block("parent-turn-a", "2026-08-04T10:00:10Z"));
    lines.push(record(
        "2026-08-04T10:01:00Z",
        "event_msg",
        json!({"type":"thread_settings_applied"}),
    ));
    lines.extend(turn_block("parent-turn-b", "2026-08-04T10:02:10Z"));
    lines.push(record(
        "2026-08-05T10:00:05Z",
        "event_msg",
        json!({"type":"thread_settings_applied"}),
    ));
    lines.extend(turn_block(turn, "2026-08-05T10:00:10Z"));
    let p = fork_path(&f, owner, &lines).await;
    initial_hook(&f, owner, turn, &p, "stop").await;
    f.process(&p).await;
    let all = f.records();
    assert_eq!(responses_for(&all, turn).len(), 1);
    for copied in ["grandparent-turn", "parent-turn-a", "parent-turn-b"] {
        assert!(responses_for(&all, copied).is_empty());
    }
}
#[tokio::test]
async fn startup_baseline_keeps_probing_while_copied_fork_history_is_materializing() {
    let f = Fixture::new();
    let parent = uuid_at("2026-08-05T09:00:00Z", 61);
    let owner = uuid_at("2026-08-05T10:00:00Z", 62);
    let old = uuid_at("2026-08-05T09:20:00Z", 63);
    let later = uuid_at("2026-08-05T09:30:00Z", 64);
    let owned = uuid_at("2026-08-05T10:00:00.010Z", 65);
    let mut lines = vec![owner_meta(&owner, &parent, false)];
    lines.extend(turn_block(&old, "2026-08-05T09:20:00Z"));
    let p = fork_path(&f, &owner, &lines).await;
    let baseline = tokio::fs::metadata(&p).await.expect("size").len() as i64;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    let cp = f.checkpoint(&p);
    assert_eq!(cp.scan_offset, baseline);
    assert!(cp.fork_bootstrap.is_some());
    let mut tail = turn_block(&later, "2026-08-05T09:30:00Z");
    tail.extend(turn_block(&owned, "2026-08-05T10:00:00.010Z"));
    f.append(&p, &(tail.join("\n") + "\n")).await;
    f.process(&p).await;
    let all = f.records();
    assert!(responses_for(&all, &old).is_empty() && responses_for(&all, &later).is_empty());
    assert_eq!(responses_for(&all, &owned).len(), 1);
    let cp = f.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
}
#[tokio::test]
async fn hook_before_startup_baseline_anchors_later_non_uuid_owned_turn() {
    let f = Fixture::new();
    let parent = "aaaaaaaa-0061-4061-8061-000000000061";
    let owner = "cccccccc-0062-4062-8062-000000000062";
    let copied = "parent-turn-startup-hook";
    let child = "child-turn-startup-hook";
    let mut lines = vec![owner_meta(owner, parent, false)];
    lines.extend(turn_block(copied, "2026-08-05T09:20:00Z"));
    let p = fork_path(&f, owner, &lines).await;
    let baseline = tokio::fs::metadata(&p).await.expect("size").len() as i64;
    f.marker("wakeups",&format!("{owner}.json"),json!({"session_id":owner,"initial_turn_id":child,"transcript_path":p,"hook_event":"user-prompt-submit"})).await;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    let cp = f.checkpoint(&p);
    assert_eq!(cp.scan_offset, baseline);
    assert_eq!(
        cp.fork_bootstrap
            .expect("pending")
            .initial_turn_id
            .as_deref(),
        Some(child)
    );
    f.append(
        &p,
        &(turn_block(child, "2026-08-05T10:00:00.010Z").join("\n") + "\n"),
    )
    .await;
    f.process(&p).await;
    f.process(&p).await;
    let all = f.records();
    assert!(responses_for(&all, copied).is_empty());
    assert_eq!(responses_for(&all, child).len(), 1);
    let cp = f.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
}
#[test]
fn default_codex_allowed_root_is_exactly_the_current_home_dot_codex() {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    }
    .expect("controlled test home");
    let expected = std::path::PathBuf::from(home)
        .join(".codex")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        crate::inputs::codex_transcript::codex_default_allowed_root_paths(),
        vec![expected]
    );
}
#[tokio::test]
async fn appended_owning_session_meta_moves_checkpoint_and_cache_without_idle_reread() {
    let f = Fixture::new();
    let deltas = runtime_deltas(&f);
    let owner = uuid_at("2026-06-24T06:00:00Z", 1);
    let copied = record(
        "2026-06-24T06:00:00Z",
        "session_meta",
        json!({"id":"copied-parent","model_provider":"openai"}),
    ) + "\n";
    let p = f
        .write(
            &format!("2026/06/24/rollout-2026-06-24T06-00-00-{owner}.jsonl"),
            &copied,
        )
        .await;
    f.input.start().await.expect("start");
    f.input.run_cycle().await;
    f.append(
        &p,
        &(record(
            "2026-06-24T06:00:01Z",
            "session_meta",
            json!({"id":owner,"model_provider":"openai"}),
        ) + "\n"),
    )
    .await;
    f.input.run_cycle().await;
    let before = deltas.lock().expect("deltas").len();
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    assert_eq!(
        f.checkpoint(&p).owner_session_meta_offset,
        Some(copied.len() as i64)
    );
    let deltas = deltas.lock().expect("deltas");
    assert!(deltas.len() > before);
    let last = deltas.last().expect("idle delta");
    assert_eq!(last.raw_read_calls, 0);
    assert_eq!(last.raw_read_bytes, 0);
}
#[tokio::test]
async fn legacy_latest_parent_meta_checkpoint_rebuilds_true_owner_before_child_recovery() {
    let first = Fixture::new();
    let owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let child = "child-turn-1";
    let mut owner_record = child_record();
    owner_record["timestamp"] = json!("2026-08-05T10:00:00Z");
    owner_record["payload"]["timestamp"] = json!("2026-08-05T10:00:00Z");
    let first_line = owner_record.to_string();
    let mut lines = vec![
        first_line.clone(),
        record(
            "2026-06-01T00:00:00Z",
            "session_meta",
            json!({"id":parent,"model_provider":"openai"}),
        ),
    ];
    lines.extend(turn_block("parent-turn-1", "2026-06-01T00:00:10Z"));
    lines.push(record(
        "2026-08-05T10:00:05Z",
        "event_msg",
        json!({"type":"thread_settings_applied"}),
    ));
    let copied_end = (lines.join("\n") + "\n").len();
    lines.extend(turn_block(child, "2026-08-05T10:00:10Z"));
    let p = fork_path(&first, owner, &lines).await;
    let (ino, _, _) = file_meta_snapshot(&p).await.expect("native snapshot");
    first.rt().state_store.update(&first.engine().state_key(&p),InputStatePatch{last_offset:Some(copied_end as f64),extra:Some(json!({"codexTranscript":{"inode":ino,"scanOffset":copied_end,"activeTurn":null,"pendingTerminal":null,"latestSessionMetaOffset":first_line.len()+1,"emittedTerminalTurnIds":["parent-turn-1"]}})),..Default::default()});
    initial_hook(&first, owner, child, &p, "subagent-stop").await;
    let second = first.restart().await;
    start_until_first_native_cycle(&second).await;
    assert_eq!(responses_for(&second.records(), child).len(), 1);
    let cp = second.checkpoint(&p);
    assert_eq!(cp.owner_session_meta_offset, Some(0));
    assert!(cp.pending_subagent.is_none() && cp.active_turn.is_none());
}
#[tokio::test]
async fn missing_child_creation_timestamp_still_excludes_copied_parent_turns() {
    let f = Fixture::new();
    let owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let child_meta=json!({"type":"session_meta","payload":{"id":owner,"session_id":parent,"source":{"subagent":{"thread_spawn":{"parent_thread_id":parent,"depth":1,"agent_path":"/root/fixture_child"}}},"thread_source":"subagent","model_provider":"openai","multi_agent_version":"v2"}}).to_string();
    let parent_meta = record(
        "2026-08-07T02:00:00Z",
        "session_meta",
        json!({"id":parent,"session_id":parent,"source":"vscode","thread_source":"user","model_provider":"openai"}),
    );
    let parent_path = f
        .write(
            "2026/08/07/rollout-parent-pending.jsonl",
            &([
                parent_meta.clone(),
                record(
                    "2026-08-07T02:00:01Z",
                    "turn_context",
                    json!({"turn_id":"copied-parent-turn","model":"gpt-test"}),
                ),
                record(
                    "2026-08-07T02:00:02Z",
                    "event_msg",
                    json!({"type":"task_started","turn_id":"copied-parent-turn"}),
                ),
            ]
            .join("\n")
                + "\n"),
        )
        .await;
    f.process(&parent_path).await;
    let lines = vec![
        child_meta,
        parent_meta,
        record(
            "2026-08-07T02:00:03Z",
            "turn_context",
            json!({"turn_id":"copied-parent-turn","model":"gpt-test"}),
        ),
        record(
            "2026-08-07T02:00:04Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"copied-parent-turn"}),
        ),
        record(
            "2026-08-07T02:00:05Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"copied-parent-turn"}),
        ),
        record(
            "2026-08-07T02:00:06Z",
            "turn_context",
            json!({"turn_id":"owned-child-turn","model":"gpt-test"}),
        ),
        record(
            "2026-08-07T02:00:07Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"owned-child-turn"}),
        ),
        record(
            "2026-08-07T02:00:08Z",
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"child task"}]}),
        ),
        record(
            "2026-08-07T02:00:09Z",
            "event_msg",
            json!({"type":"agent_message","message":"child done","phase":"final"}),
        ),
        record(
            "2026-08-07T02:00:10Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"owned-child-turn"}),
        ),
    ];
    let p = fork_path(&f, owner, &lines).await;
    initial_hook(&f, owner, "owned-child-turn", &p, "subagent-stop").await;
    f.process(&p).await;
    let all = f.records();
    assert!(responses_for(&all, "copied-parent-turn").is_empty());
    assert_eq!(responses_for(&all, "owned-child-turn").len(), 1);
    let cp = f.checkpoint(&p);
    assert!(cp.active_turn.is_none() && cp.pending_terminal.is_none());
}
async fn active_owned_prefix(f: &Fixture, padding: usize) -> (String, String, String, i64) {
    let parent = uuid_at("2026-08-05T09:00:00Z", 71);
    let owner = uuid_at("2026-08-05T10:00:00Z", 72);
    let copied = uuid_at("2026-08-05T09:30:00Z", 73);
    let owned = uuid_at("2026-08-05T10:00:00.010Z", 74);
    let mut lines = vec![owner_meta(&owner, &parent, false)];
    lines.extend(turn_block(&copied, "2026-08-05T09:30:00Z"));
    lines.extend([
 record("2026-08-05T10:00:00.010Z","turn_context",json!({"turn_id":owned,"model":"gpt-5.5","cwd":if padding==0{"/tmp/owned"}else{"/tmp/large-owned"}})),
 record("2026-08-05T10:00:01.010Z","event_msg",json!({"type":"task_started","turn_id":owned})),
 record("2026-08-05T10:00:02.010Z","response_item",json!({"type":"message","role":"user","content":[{"type":"input_text","text":if padding==0{"continue owned turn"}else{"continue large owned turn"}}]}))]);
    for _ in 0..padding {
        lines.push(record(
            "2026-08-05T10:00:03.010Z",
            "event_msg",
            json!({"type":"owned_tail_padding","filler":"x".repeat(64*1024)}),
        ));
    }
    let p = fork_path(f, &owner, &lines).await;
    let size = tokio::fs::metadata(&p).await.expect("stat").len() as i64;
    (p, copied, owned, size)
}
async fn close_owned_tail(f: &Fixture, p: &str, owned: &str) {
    f.append(
        p,
        &([
            record(
                "2026-08-05T10:00:04.010Z",
                "event_msg",
                json!({"type":"agent_message","message":"owned result","phase":"final"}),
            ),
            record("2026-08-05T10:00:05.010Z", "event_msg", usage(100, 10)),
            record(
                "2026-08-05T10:00:06.010Z",
                "event_msg",
                json!({"type":"task_complete","turn_id":owned,"last_agent_message":"owned result"}),
            ),
        ]
        .join("\n")
            + "\n"),
    )
    .await;
    f.process(p).await;
}
#[tokio::test]
async fn startup_rebuilds_an_owned_turn_already_active_at_the_fork_baseline() {
    let f = Fixture::new();
    let (p, copied, owned, size) = active_owned_prefix(&f, 0).await;
    run_real_lifecycle(&f).await;
    assert!(f.records().is_empty());
    let cp = f.checkpoint(&p);
    assert_eq!(cp.scan_offset, size);
    let active = cp.active_turn.expect("owned active");
    assert_eq!(active.turn_id, owned);
    assert_eq!(active.start_offset, size);
    assert_eq!(active.model.as_deref(), Some("gpt-5.5"));
    assert_eq!(active.cwd.as_deref(), Some("/tmp/owned"));
    assert!(cp.fork_bootstrap.is_none());
    close_owned_tail(&f, &p, &owned).await;
    assert!(responses_for(&f.records(), &copied).is_empty());
    assert_eq!(responses_for(&f.records(), &owned).len(), 1);
    let cp = f.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
}
#[tokio::test]
async fn bounded_owned_tail_rebuild_resumes_after_durable_restart_without_exporting_history() {
    let first = Fixture::new();
    let (p, copied, owned, size) = active_owned_prefix(&first, 270).await;
    assert!(size > 16 * 1024 * 1024);
    start_until_first_native_cycle(&first).await;
    let cp = first.checkpoint(&p);
    assert_eq!(cp.scan_offset, size);
    assert!(cp.active_turn.is_none());
    let bootstrap = cp.fork_bootstrap.expect("bounded tail");
    assert_eq!(bootstrap.state, ForkBootstrapState::BaselineTail);
    assert_eq!(bootstrap.tail_candidate.expect("candidate").turn_id, owned);
    assert!(bootstrap.search_offset < size);
    assert!(first.records().is_empty());

    let second = first.restart().await;
    start_until_first_native_cycle(&second).await;
    assert!(second.records().is_empty());
    let cp = second.checkpoint(&p);
    assert_eq!(cp.scan_offset, size);
    let active = cp.active_turn.expect("owned active");
    assert_eq!(active.turn_id, owned);
    assert_eq!(active.start_offset, size);
    assert_eq!(active.model.as_deref(), Some("gpt-5.5"));
    assert_eq!(active.cwd.as_deref(), Some("/tmp/large-owned"));
    assert!(cp.fork_bootstrap.is_none());
    close_owned_tail(&second, &p, &owned).await;
    assert!(responses_for(&second.records(), &copied).is_empty());
    assert_eq!(responses_for(&second.records(), &owned).len(), 1);
}
#[tokio::test]
async fn hook_anchor_search_advances_in_bounded_sixteen_mib_windows_across_restart() {
    let first = Fixture::new();
    let owner = "cccccccc-4444-4444-8444-444444444444";
    let parent = "aaaaaaaa-7777-4777-8777-777777777777";
    let mut lines = vec![
        owner_meta(owner, parent, false),
        record(
            "2026-06-01T00:00:00Z",
            "session_meta",
            json!({"id":parent,"model_provider":"openai"}),
        ),
    ];
    lines.extend(turn_block("big-ancestor-turn", "2026-06-01T00:00:10Z"));
    for _ in 0..540 {
        lines.push(record(
            "2026-06-01T00:00:20Z",
            "event_msg",
            json!({"type":"copied_padding","filler":"x".repeat(64*1024)}),
        ));
    }
    lines.push(record(
        "2026-08-05T10:00:05Z",
        "event_msg",
        json!({"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.5"}}),
    ));
    lines.extend(turn_block("big-child-turn", "2026-08-05T10:00:10Z"));
    let p = fork_path(&first, owner, &lines).await;
    assert!(tokio::fs::metadata(&p).await.expect("stat").len() > 32 * 1024 * 1024);
    initial_hook(&first, owner, "big-child-turn", &p, "stop").await;
    first.process(&p).await;
    let first_offset = first
        .checkpoint(&p)
        .fork_bootstrap
        .expect("pending")
        .search_offset;
    assert!(first_offset > 0 && first_offset <= 16 * 1024 * 1024);
    assert!(first.records().is_empty());
    let second = first.restart().await;
    second.process(&p).await;
    let second_offset = second
        .checkpoint(&p)
        .fork_bootstrap
        .expect("second pending")
        .search_offset;
    assert!(second_offset > first_offset && second_offset <= 32 * 1024 * 1024);
    assert!(second.records().is_empty());
    second.process(&p).await;
    let all = second.records();
    assert_eq!(responses_for(&all, "big-child-turn").len(), 1);
    assert!(responses_for(&all, "big-ancestor-turn").is_empty());
    let cp = second.checkpoint(&p);
    assert!(cp.scan_offset > 16 * 1024 * 1024);
    assert!(cp.fork_bootstrap.is_none());
}
async fn assert_global_root_priority(count: usize) {
    let f = Fixture::new();
    tokio::fs::create_dir_all(&f.input.inner.body.session_dir)
        .await
        .expect("default root");
    let mut expected = Vec::new();
    for n in 0..count {
        let home = f.root.path().join(format!("home-{n}"));
        let legacy = home.join("sessions");
        tokio::fs::create_dir_all(&legacy)
            .await
            .expect("legacy root");
        let p = f
            .write(
                &format!("../home-{n}/u/fixture-user/sessions/2026/06/24/rollout-{n}.jsonl"),
                &completed(),
            )
            .await;
        let isolated = tokio::fs::canonicalize(home.join("u/fixture-user/sessions"))
            .await
            .expect("isolated root")
            .to_string_lossy()
            .into_owned();
        expected.push(isolated);
        f.marker("wakeups",&format!("{n:03}.json"),json!({"codex_home":home,"session_dir":legacy,"transcript_path":p,"received_at":chrono::Utc::now().to_rfc3339()})).await;
    }
    let default = tokio::fs::canonicalize(&f.input.inner.body.session_dir)
        .await
        .expect("default canonical")
        .to_string_lossy()
        .into_owned();
    let roots = f.engine().discover_dynamic_session_dirs(&default).await;
    assert_eq!(roots.len(), 64);
    let isolated: Vec<_> = roots
        .into_iter()
        .filter(|p| {
            std::path::Path::new(p)
                .components()
                .any(|c| c.as_os_str() == std::ffi::OsStr::new("u"))
        })
        .collect();
    expected.reverse();
    expected.truncate(64);
    assert_eq!(isolated, expected);
    let files = f.engine().discover_session_files().await;
    assert_eq!(files.len(), count.min(64));
    f.engine().discover_dynamic_session_dirs(&default).await;
}
#[tokio::test]
async fn isolated_roots_keep_global_priority_and_emit_one_throttled_warning_per_overflow() {
    for count in [33, 64, 65] {
        let records = isolated_diagnostic_records(&format!("root-cap-{count}"));
        let warnings: Vec<_> = records
            .iter()
            .filter(|e| {
                e["msg"] == "Codex dynamic session root limit reached within scanned markers"
            })
            .collect();
        assert_eq!(
            warnings.len(),
            1,
            "count={count}, overflow warns once across repeated discoveries"
        );
        assert_eq!(warnings[0]["level"], "WARN");
        assert_eq!(warnings[0]["dropped"], count * 2 - 64);
        assert_eq!(warnings[0]["cap"], 64);
    }
}
#[tokio::test]
async fn stop_during_native_initialization_reaps_actual_watcher_without_starting_collection() {
    use std::future::{poll_fn, Future};
    use std::task::Poll;
    let f = Fixture::new();
    f.rt().force_poll_interval_ms(5);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *f.input
        .inner
        .body
        .initialization_wait
        .lock()
        .expect("init wait") = Some(super::super::CodexInitializationWait {
        entered: entered.clone(),
        release: release.clone(),
    });
    let cycles = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let changed = Arc::new(tokio::sync::Notify::new());
    let out = cycles.clone();
    let signal = changed.clone();
    f.input.inner.on_runtime_delta(move |_| {
        out.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        signal.notify_one();
    });
    let starting = f.input.start();
    tokio::pin!(starting);
    tokio::select! {
     _=entered.notified()=>{},
     completed=starting.as_mut()=>panic!("native initialization escaped the controlled boundary: {completed:?}"),
    }
    let watcher = f
        .input
        .inner
        .body
        .watcher_stop
        .lock()
        .expect("watcher")
        .as_ref()
        .map(|w| w.task.abort_handle());
    if cfg!(target_os = "linux") {
        assert!(watcher.is_some(), "real native watcher was never created");
    }
    let stopping = f.input.stop();
    tokio::pin!(stopping);
    let completed_stop = poll_fn(|cx| {
        Poll::Ready(match stopping.as_mut().poll(cx) {
            Poll::Ready(done) => Some(done),
            Poll::Pending => None,
        })
    })
    .await;
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let (started, stopped) = tokio::join!(starting.as_mut(), async {
            if let Some(done) = completed_stop {
                done
            } else {
                stopping.as_mut().await
            }
        });
        started.expect("start cleanup");
        stopped.expect("stop cleanup");
    })
    .await
    .expect("bounded actual lifecycle completion");
    assert!(!f.input.collector_running());
    assert!(f
        .input
        .inner
        .body
        .watcher_stop
        .lock()
        .expect("watcher")
        .is_none());
    assert_eq!(cycles.load(std::sync::atomic::Ordering::SeqCst), 0);
    if let Some(watcher) = watcher {
        assert!(watcher.is_finished(), "real watcher task was not reaped");
    }
    f.marker(
        "wakeups",
        "post-stop.json",
        json!({"session_id":"post-stop","received_at":chrono::Utc::now().to_rfc3339()}),
    )
    .await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), changed.notified())
            .await
            .is_err(),
        "stopped watcher or scheduler produced a late collection"
    );
    assert_eq!(cycles.load(std::sync::atomic::Ordering::SeqCst), 0);
}
fn large_output_turn(output: &str) -> Vec<String> {
    let mut lines = header();
    lines[3] = record(
        "2026-06-24T06:00:03Z",
        "response_item",
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"inspect it"}]}),
    );
    lines.extend([
 record("2026-06-24T06:00:04Z","response_item",json!({"type":"function_call","id":"fc-1","call_id":"call-1","name":"exec_command","arguments":"{\"cmd\":\"cat large.txt\"}"})),
 record("2026-06-24T06:00:05Z","response_item",json!({"type":"function_call_output","call_id":"call-1","output":json!(output).to_string()})),
 record("2026-06-24T06:00:06Z","event_msg",usage(100,10)),
 record("2026-06-24T06:00:07Z","response_item",json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]})),
 record("2026-06-24T06:00:08Z","event_msg",json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"done"}))]);
    lines
}
fn expected_large_delta(output: &str) -> Value {
    json!([{"role":"assistant","parts":[{"type":"tool_call","id":"call-1","name":"exec_command","arguments":{"command":"cat large.txt"}}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":output}]}])
}
#[tokio::test]
async fn oversized_request_context_falls_back_to_exact_input_delta_without_losing_tool_output() {
    let f = Fixture::new();
    let output = "x".repeat(1024 * 1024 + 1);
    f.input.start().await.expect("start");
    f.write(
        "2026/06/24/rollout-large-context.jsonl",
        &(large_output_turn(&output).join("\n") + "\n"),
    )
    .await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    let q = events(&f.records(), "llm.request");
    assert_eq!(q.len(), 2);
    let delta = expected_large_delta(&output);
    assert!(
        q[1]["gen_ai.input.messages_delta"] == delta,
        "exact large tool-call/result input delta"
    );
    assert!(
        q[1]["gen_ai.input.messages"] == delta,
        "full context must fall back to the exact original delta"
    );
    assert!(q[1]["gen_ai.input.messages_hash"].is_string());
}
#[tokio::test]
async fn oversized_pending_delta_is_rebuilt_from_offsets_after_durable_restart() {
    let first = Fixture::new();
    let output = "x".repeat(1024 * 1024 + 1);
    let lines = large_output_turn(&output);
    let token = lines
        .iter()
        .position(|s| {
            serde_json::from_str::<Value>(s).expect("record")["payload"]["type"] == "token_count"
        })
        .expect("token");
    first.input.start().await.expect("start");
    let p = first
        .write(
            "2026/06/24/rollout-large-restart.jsonl",
            &(lines[..=token].join("\n") + "\n"),
        )
        .await;
    first.input.run_cycle().await;
    assert!(!events(&first.records(), "llm.response").is_empty());
    first.input.stop().await.expect("stop");
    let second = first.restart().await;
    assert!(
        tokio::fs::metadata(first.root.path().join("state.json"))
            .await
            .expect("state bytes")
            .len()
            < 128 * 1024
    );
    second
        .append(&p, &(lines[token + 1..].join("\n") + "\n"))
        .await;
    start_until_first_native_cycle(&second).await;
    let q = events(&second.records(), "llm.request");
    assert!(!q.is_empty());
    let delta = q[0]["gen_ai.input.messages_delta"]
        .as_array()
        .expect("delta");
    assert_eq!(
        delta
            .iter()
            .map(|m| m["role"].as_str().expect("role"))
            .collect::<Vec<_>>(),
        vec!["assistant", "tool"]
    );
    assert!(serde_json::to_string(delta)
        .expect("delta")
        .contains(&output));
    assert!(q[0]["gen_ai.input.messages"] == q[0]["gen_ai.input.messages_delta"]);
}
#[tokio::test]
async fn durable_restart_restores_wave_time_anchors_and_never_reuses_stale_cumulative_usage() {
    let first = Fixture::new();
    let mut lines = header();
    lines.extend([
 record("2026-06-24T06:00:04Z","response_item",json!({"type":"function_call","call_id":"call-spawn","name":"spawn_agent","arguments":"{}"})),
 record("2026-06-24T06:00:05Z","response_item",json!({"type":"function_call_output","call_id":"call-spawn","output":"{}"})),
 record("2026-06-24T06:00:05.100Z","event_msg",cumulative(10,2,1000))]);
    let p = first
        .write("rollout-wave-anchors.jsonl", &(lines.join("\n") + "\n"))
        .await;
    first.process(&p).await;
    let active = first.checkpoint(&p).active_turn.expect("active");
    assert_eq!(active.next_step_started_at_ms, Some(1_782_280_805_100.0));
    assert_eq!(active.last_cumulative_token_total, Some(1000.0));
    let second = first.restart().await;
    second.append(&p,&([
 record("2026-06-24T06:00:08Z","response_item",json!({"type":"function_call","call_id":"call-wait","name":"wait_agent","arguments":"{}"})),
 record("2026-06-24T06:00:09Z","response_item",json!({"type":"function_call_output","call_id":"call-wait","output":"{}"})),
 record("2026-06-24T06:00:09.100Z","event_msg",cumulative(20,2,1100))].join("\n")+"\n")).await;
    second.process(&p).await;
    let third = second.restart().await;
    third.append(&p,&([
 record("2026-06-24T06:00:12Z","event_msg",json!({"type":"agent_message","message":"continuing after wait","phase":"commentary"})),
 record("2026-06-24T06:00:12.100Z","event_msg",cumulative(20,2,1100)),
 record("2026-06-24T06:00:13Z","event_msg",json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"continuing after wait"}))].join("\n")+"\n")).await;
    third.process(&p).await;
    let mut all = first.records();
    all.extend(second.records());
    all.extend(third.records());
    let r = events(&all, "llm.response");
    assert_eq!(
        r.iter()
            .map(|e| e["gen_ai.usage.total_tokens"].clone())
            .collect::<Vec<_>>(),
        vec![json!(12), json!(22), json!(0)]
    );
    assert_eq!(
        r.iter()
            .filter(|e| e["gen_ai.usage.total_tokens"] == 22)
            .count(),
        1
    );
    let q = events(&all, "llm.request");
    for step in [2, 3] {
        let id = format!("session-1:turn-1:s{step}");
        let request = q
            .iter()
            .find(|e| e["gen_ai.step.id"] == id)
            .expect("request");
        let response = r
            .iter()
            .find(|e| e["gen_ai.step.id"] == id)
            .expect("response");
        assert!(timestamp(response) > timestamp(request));
    }
}
fn completed_with_full_context() -> Vec<String> {
    let mut lines: Vec<_> = completed().lines().map(str::to_owned).collect();
    let mut meta: Value = serde_json::from_str(&lines[0]).expect("meta");
    meta["payload"]["dynamic_tools"] =
        json!([{"name":"exec_command","description":"Run a command"}]);
    lines[0] = meta.to_string();
    let mut context: Value = serde_json::from_str(&lines[1]).expect("context");
    context["payload"]["developer_instructions"] = json!("Follow the project conventions.");
    lines[1] = context.to_string();
    lines
}
#[tokio::test]
async fn closed_wave_incomplete_suffix_restores_messages_model_instructions_and_tools_after_restart(
) {
    let first = Fixture::new();
    let lines = completed_with_full_context();
    let call2 = lines
        .iter()
        .position(|s| s.contains("\"call_id\":\"call-2\""))
        .expect("second call");
    first.input.start().await.expect("start");
    let p = first
        .write(
            "2026/06/24/rollout-incomplete-suffix.jsonl",
            &(lines[..=call2].join("\n") + "\n"),
        )
        .await;
    first.input.run_cycle().await;
    assert_eq!(events(&first.records(), "llm.response").len(), 1);
    first.input.stop().await.expect("stop");
    let second = first.restart().await;
    second
        .append(&p, &(lines[call2 + 1..].join("\n") + "\n"))
        .await;
    start_until_first_native_cycle(&second).await;
    let mut all = first.records();
    all.extend(second.records());
    let r = events(&all, "llm.response");
    assert_eq!(
        r.iter()
            .map(|e| e["gen_ai.step.id"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!("session-1:turn-1:s1"),
            json!("session-1:turn-1:s2"),
            json!("session-1:turn-1:s3")
        ]
    );
    assert_eq!(
        r.iter()
            .map(|e| e["gen_ai.usage.total_tokens"].clone())
            .collect::<Vec<_>>(),
        vec![json!(110), json!(132), json!(143)]
    );
    assert_eq!(
        events(&all, "tool.call")
            .iter()
            .map(|e| e["gen_ai.tool.call.id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("call-1"), json!("call-2")]
    );
    let next = second.records();
    let q = events(&next, "llm.request");
    let request = q
        .iter()
        .find(|e| e["gen_ai.step.id"] == "session-1:turn-1:s2")
        .expect("second request");
    let delta = json!([{"role":"assistant","parts":[{"type":"tool_call","id":"call-1","name":"exec_command","arguments":{"command":"pwd"}}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","response":"/tmp/project"}]}]);
    assert_eq!(request["gen_ai.input.messages_delta"], delta);
    let mut full = json!([{"role":"user","parts":[{"type":"text","content":"fix it"}]}]);
    full.as_array_mut()
        .expect("messages")
        .extend(delta.as_array().expect("delta").clone());
    assert_eq!(request["gen_ai.input.messages"], full);
    assert_eq!(request["gen_ai.request.model"], "gpt-5.5");
    assert_eq!(request["agent.codex.cwd"], "/tmp/project");
    assert_eq!(
        request["gen_ai.system_instructions"],
        json!([{"type":"text","content":"Follow the project conventions."}])
    );
    assert_eq!(
        request["gen_ai.tool.definitions"],
        json!([{"name":"exec_command","description":"Run a command"}])
    );
    let response = r
        .iter()
        .find(|e| e["gen_ai.step.id"] == "session-1:turn-1:s2")
        .expect("second response");
    assert_eq!(response["gen_ai.response.model"], "gpt-5.5");
    assert_eq!(response["agent.codex.cwd"], "/tmp/project");
    assert!(
        response.get("gen_ai.system_instructions").is_none()
            && response.get("gen_ai.tool.definitions").is_none()
    );
    let end = next
        .iter()
        .find(|e| e["gen_ai.turn.end"] == true)
        .expect("end");
    assert_eq!(end["agent.codex.cwd"], "/tmp/project");
    assert_eq!(end["agent.codex.turn_status"], "completed");
}
const NATIVE_PARENT_NAME: &str =
    "rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl";
const NATIVE_PARENT:&str=include_str!("../../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
const NATIVE_CHILDREN:[(&str,&str,&str,&str);4]=[
 ("rollout-2026-08-07T10-00-04-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","child-turn-1",include_str!("../../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-04-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl")),
 ("rollout-2026-08-07T10-00-05-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl","cccccccc-cccc-4ccc-8ccc-cccccccccccc","child-turn-2",include_str!("../../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-05-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl")),
 ("rollout-2026-08-07T10-00-06-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl","dddddddd-dddd-4ddd-8ddd-dddddddddddd","child-turn-3",include_str!("../../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-06-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl")),
 ("rollout-2026-08-07T10-00-07-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl","eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","child-turn-4",include_str!("../../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-07-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl")),
];
async fn write_native_fixture(f: &Fixture, name: &str, text: &str) -> String {
    let p = f.write(&format!("2026/08/07/{name}"), text).await;
    let records: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("synthetic native fixture"))
        .collect();
    let owner = records.first().expect("metadata")["payload"]["id"]
        .as_str()
        .expect("owner");
    let turn = records
        .iter()
        .rev()
        .find(|r| r["payload"]["type"] == "task_started")
        .expect("started")["payload"]["turn_id"]
        .as_str()
        .expect("turn");
    initial_hook(
        f,
        owner,
        turn,
        &p,
        if records[0]["payload"]["thread_source"] == "subagent" {
            "subagent-stop"
        } else {
            "stop"
        },
    )
    .await;
    p
}
#[tokio::test]
async fn orphan_original_child_fixture_emits_own_session_without_pending_subagent_hold() {
    let f = Fixture::new();
    let child = NATIVE_CHILDREN[0];
    let p = write_native_fixture(&f, child.0, child.3).await;
    f.process(&p).await;
    let r = responses_for(&f.records(), child.2);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.session.id"], child.1);
    let cp = f.checkpoint(&p);
    assert!(cp.pending_subagent.is_none() && cp.active_turn.is_none());
}
#[tokio::test]
async fn original_children_arriving_first_bind_current_spawn_not_an_older_parent_turn() {
    let f = Fixture::new();
    let mut current = NATIVE_PARENT.lines();
    let meta = current.next().expect("meta");
    let history = [
        record(
            "2026-08-07T01:00:00Z",
            "turn_context",
            json!({"turn_id":"historical-parent-turn","model":"gpt-test","cwd":"/tmp/codex-subagent-fixture"}),
        ),
        record(
            "2026-08-07T01:00:01Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"historical-parent-turn"}),
        ),
        record(
            "2026-08-07T01:00:02Z",
            "response_item",
            json!({"type":"function_call","call_id":"call-historical-subagent","name":"spawn_agent","arguments":json!({"task_name":"stale_child","message":"redacted"}).to_string()}),
        ),
        record(
            "2026-08-07T01:00:03Z",
            "response_item",
            json!({"type":"function_call_output","call_id":"call-historical-subagent","output":json!({"task_name":"/root/stale_child"}).to_string()}),
        ),
        record(
            "2026-08-07T01:00:04Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"historical-parent-turn","last_agent_message":"delegated"}),
        ),
    ];
    let text = meta.to_owned()
        + "\n"
        + &history.join("\n")
        + "\n"
        + &current.collect::<Vec<_>>().join("\n")
        + "\n";
    let parent = write_native_fixture(&f, NATIVE_PARENT_NAME, &text).await;
    for child in NATIVE_CHILDREN {
        let p = write_native_fixture(&f, child.0, child.3).await;
        f.process(&p).await;
    }
    f.process(&parent).await;
    let cp = f.checkpoint(&parent);
    assert!(cp.pending_fusion.is_none() && cp.active_turn.is_none());
    let links = f.input.subagent_link_snapshot().links;
    for (n, child) in NATIVE_CHILDREN.iter().enumerate() {
        let link = links
            .iter()
            .find(|l| l.child_thread_id == child.1)
            .expect("current child link");
        assert_eq!(link.parent_turn_id.as_deref(), Some("parent-turn-1"));
        assert_eq!(
            link.parent_tool_call_id.as_deref(),
            Some(format!("call-subagent-{}", n + 1).as_str())
        );
    }
}
#[tokio::test]
async fn original_followup_task_fixture_does_not_create_a_new_child_hold_lifecycle() {
    let f = Fixture::new();
    let text = NATIVE_PARENT.replace("\"name\":\"spawn_agent\"", "\"name\":\"followup_task\"");
    let parent = write_native_fixture(&f, NATIVE_PARENT_NAME, &text).await;
    let child = write_native_fixture(&f, NATIVE_CHILDREN[0].0, NATIVE_CHILDREN[0].3).await;
    f.process(&parent).await;
    f.process(&child).await;
    let all = f.records();
    assert_eq!(responses_for(&all, "parent-turn-1").len(), 1);
    assert_eq!(responses_for(&all, "child-turn-1").len(), 1);
    assert!(f.checkpoint(&parent).pending_fusion.is_none());
    assert!(f.checkpoint(&child).pending_subagent.is_none());
}
#[tokio::test]
async fn repeated_path_without_explicit_identity_degrades_to_independent_orphan() {
    let f = Fixture::new();
    let parent_text = NATIVE_PARENT
        .lines()
        .filter(|l| !l.contains("call-subagent-3") && !l.contains("call-subagent-4"))
        .map(|l| l.replace("fixture_child_2", "fixture_child"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let parent = write_native_fixture(&f, NATIVE_PARENT_NAME, &parent_text).await;
    let child = write_native_fixture(&f, NATIVE_CHILDREN[0].0, NATIVE_CHILDREN[0].3).await;
    f.process(&parent).await;
    f.process(&child).await;
    assert_eq!(responses_for(&f.records(), "child-turn-1").len(), 1);
    let cp = f.checkpoint(&child);
    assert!(cp.pending_subagent.is_none() && cp.active_turn.is_none());
    let links = f.input.subagent_link_snapshot().links;
    let link = links
        .iter()
        .find(|l| l.child_thread_id == NATIVE_CHILDREN[0].1)
        .expect("ambiguous child");
    assert_eq!(link.confidence.as_str(), "orphan");
    assert_eq!(
        link.orphan_reason.map(|r| r.as_str()),
        Some("ambiguous_agent_path")
    );
}
#[tokio::test]
async fn original_time_order_only_link_stays_diagnostic_and_never_holds_child() {
    let f = Fixture::new();
    let mut lines: Vec<_> = NATIVE_PARENT.lines().collect();
    lines.pop();
    let parent = write_native_fixture(&f, NATIVE_PARENT_NAME, &(lines.join("\n") + "\n")).await;
    f.process(&parent).await;
    let mut child_lines: Vec<_> = NATIVE_CHILDREN[0].3.lines().map(str::to_owned).collect();
    let mut meta: Value = serde_json::from_str(&child_lines[0]).expect("meta");
    meta["payload"]["source"]["subagent"]["thread_spawn"]
        .as_object_mut()
        .expect("spawn")
        .remove("agent_path");
    child_lines[0] = meta.to_string();
    let child =
        write_native_fixture(&f, NATIVE_CHILDREN[0].0, &(child_lines.join("\n") + "\n")).await;
    f.process(&child).await;
    let links = f.input.subagent_link_snapshot().links;
    let link = links
        .iter()
        .find(|l| l.child_thread_id == NATIVE_CHILDREN[0].1)
        .expect("time order");
    assert_eq!(link.confidence.as_str(), "time_order");
    assert_eq!(responses_for(&f.records(), "child-turn-1").len(), 1);
    assert!(f.checkpoint(&child).pending_subagent.is_none());
}
#[tokio::test]
async fn four_original_children_finish_independently_before_parent_with_full_current_lineage() {
    let f = Fixture::new();
    f.input.start().await.expect("start");
    let mut lines: Vec<_> = NATIVE_PARENT.lines().collect();
    let terminal = lines.pop().expect("terminal");
    let parent = write_native_fixture(&f, NATIVE_PARENT_NAME, &(lines.join("\n") + "\n")).await;
    f.input.run_cycle().await;
    assert_eq!(f.input.subagent_link_snapshot().detected_spawns, 4);
    let mut children = Vec::new();
    for child in NATIVE_CHILDREN {
        let p = write_native_fixture(&f, child.0, child.3).await;
        children.push(p);
        f.input.run_cycle().await;
    }
    let before = f.records();
    for child in NATIVE_CHILDREN {
        assert_eq!(responses_for(&before, child.2).len(), 1);
    }
    assert!(f.checkpoint(&parent).active_turn.is_some());
    f.append(&parent, &(terminal.to_owned() + "\n")).await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    let all = f.records();
    assert_eq!(responses_for(&all, "parent-turn-1").len(), 2);
    let span_regex = Regex::new("^[a-f0-9]{16}$").expect("span regex");
    for (n, child) in NATIVE_CHILDREN.iter().enumerate() {
        let entries: Vec<_> = all
            .iter()
            .filter(|e| e["agent.codex.transcript_turn_id"] == child.2)
            .collect();
        assert!(!entries.is_empty());
        let turn = format!("{}:{}", child.1, child.2);
        let call = format!("call-subagent-{}", n + 1);
        for e in &entries {
            assert_eq!(e["gen_ai.session.id"], child.1);
            assert_eq!(e["gen_ai.agent.id"], child.1);
            assert_eq!(e["gen_ai.turn.id"], turn);
            assert_eq!(e["gen_ai.agent.scope"], "subagent");
            assert_eq!(e["gen_ai.agent.depth"].as_f64(), Some(1.0));
            assert_eq!(e["gen_ai.subagent.parent_tool_call.id"], call);
            assert_eq!(e["agent.codex.delegated"], true);
        }
        assert!(entries.iter().any(|e| e["event.name"] == "other"));
        let steps: std::collections::BTreeSet<_> = entries
            .iter()
            .filter_map(|e| e["gen_ai.step.id"].as_str())
            .collect();
        assert_eq!(
            steps,
            [format!("{turn}:s1")].iter().map(String::as_str).collect()
        );
        assert_eq!(
            f.checkpoint(&children[n]).owner_session_meta_offset,
            Some(0)
        );
        let tool = all
            .iter()
            .find(|e| e["event.name"] == "tool.call" && e["gen_ai.tool.call.id"] == call)
            .expect("parent tool");
        let span = tool["span_id"].as_str().expect("tool span");
        assert!(span_regex.is_match(span));
        let invoke = all
            .iter()
            .find(|e| e["event.name"] == "gen_ai.agent.invoke" && e["gen_ai.tool.call.id"] == call)
            .expect("invoke");
        for e in &entries {
            assert_eq!(e["agent.codex.parent_span_id"], tool["span_id"]);
            assert_eq!(
                e["gen_ai.agent.parent.invocation.id"],
                invoke["gen_ai.agent.invocation.id"]
            );
        }
        let request = entries
            .iter()
            .find(|e| e["event.name"] == "llm.request")
            .expect("child request");
        assert!(request["gen_ai.input.messages"].is_array());
    }
    let cp = f.checkpoint(&parent);
    assert!(cp.pending_fusion.is_none() && cp.active_turn.is_none());
    let snapshot = f.input.subagent_link_snapshot();
    assert_eq!(
        (
            snapshot.detected_children,
            snapshot.detected_spawns,
            snapshot.linked_children,
            snapshot.orphan_children
        ),
        (4, 4, 4, 0)
    );
    for (n, child) in NATIVE_CHILDREN.iter().enumerate() {
        let link = snapshot
            .links
            .iter()
            .find(|l| l.child_thread_id == child.1)
            .expect("link");
        assert_eq!(
            link.parent_thread_id,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        );
        assert_eq!(link.parent_turn_id.as_deref(), Some("parent-turn-1"));
        assert_eq!(
            link.parent_tool_call_id.as_deref(),
            Some(format!("call-subagent-{}", n + 1).as_str())
        );
        assert_eq!(link.confidence.as_str(), "agent_path");
    }
}
#[tokio::test]
async fn completed_and_aborted_original_children_close_independently_and_accept_direct_user_followup(
) {
    let f = Fixture::new();
    f.input.start().await.expect("start");
    let mut parent_lines: Vec<_> = NATIVE_PARENT.lines().collect();
    let terminal = parent_lines.pop().expect("terminal");
    let parent =
        write_native_fixture(&f, NATIVE_PARENT_NAME, &(parent_lines.join("\n") + "\n")).await;
    f.input.run_cycle().await;
    assert_eq!(f.input.subagent_link_snapshot().detected_spawns, 4);
    let mut paths = Vec::new();
    for (n, child) in NATIVE_CHILDREN.iter().enumerate() {
        let mut lines: Vec<_> = child.3.lines().map(str::to_owned).collect();
        if n == 0 {
            let mut end: Value =
                serde_json::from_str(lines.last().expect("terminal")).expect("terminal");
            end["payload"]["type"] = json!("turn_aborted");
            end["payload"]
                .as_object_mut()
                .expect("payload")
                .remove("last_agent_message");
            end["payload"]["reason"] = json!("interrupted");
            *lines.last_mut().expect("end") = end.to_string();
        }
        let p = write_native_fixture(&f, child.0, &(lines.join("\n") + "\n")).await;
        paths.push(p);
        f.input.run_cycle().await;
    }
    let all = f.records();
    for (n, child) in NATIVE_CHILDREN.iter().enumerate() {
        assert_eq!(responses_for(&all, child.2).len(), 1);
        let cp = f.checkpoint(&paths[n]);
        assert_eq!(
            cp.scan_offset,
            tokio::fs::metadata(&paths[n]).await.expect("stat").len() as i64
        );
        assert!(cp.pending_subagent.is_none() && cp.active_turn.is_none());
    }
    let followup = simple_turn("child-followup-turn", 10, 2, 0)
        .into_iter()
        .skip(1)
        .map(|s| s.replace("2026-06-24T06:00", "2026-08-07T02:02"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    f.append(&paths[0], &followup).await;
    f.input.run_cycle().await;
    let followup = responses_for(&f.records(), "child-followup-turn");
    assert_eq!(followup.len(), 1);
    assert!(followup[0]
        .get("gen_ai.agent.parent.invocation.id")
        .is_none());
    assert!(f.checkpoint(&paths[0]).pending_subagent.is_none());
    f.append(&parent, &(terminal.to_owned() + "\n")).await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    let all = f.records();
    for child in NATIVE_CHILDREN {
        assert_eq!(responses_for(&all, child.2).len(), 1);
    }
    let aborted: Vec<_> = all
        .iter()
        .filter(|e| e["agent.codex.transcript_turn_id"] == "child-turn-1")
        .collect();
    assert!(aborted
        .iter()
        .any(|e| e["agent.codex.turn_status"] == "interrupted"));
    assert!(aborted
        .iter()
        .all(|e| e["gen_ai.agent.scope"] == "subagent"));
    assert!(f.checkpoint(&parent).pending_fusion.is_none());
}
#[tokio::test]
async fn original_active_child_is_never_forced_to_end_by_its_parent_terminal() {
    use crate::inputs::base::InputBody;
    let f = Fixture::new();
    let mut parent_lines: Vec<_> = NATIVE_PARENT.lines().collect();
    let parent_end = parent_lines.pop().expect("terminal");
    let parent =
        write_native_fixture(&f, NATIVE_PARENT_NAME, &(parent_lines.join("\n") + "\n")).await;
    f.process(&parent).await;
    let mut child_lines: Vec<_> = NATIVE_CHILDREN[0].3.lines().collect();
    child_lines.pop();
    let child =
        write_native_fixture(&f, NATIVE_CHILDREN[0].0, &(child_lines.join("\n") + "\n")).await;
    f.process(&child).await;
    assert!(responses_for(&f.records(), "child-turn-1").is_empty());
    let cp = f.checkpoint(&child);
    assert_eq!(
        cp.scan_offset,
        tokio::fs::metadata(&child).await.expect("stat").len() as i64
    );
    assert!(cp.pending_subagent.is_none());
    let active = cp.active_turn.expect("running");
    assert_eq!(active.turn_id, "child-turn-1");
    assert_eq!(active.emitted_step_count, 0);
    f.append(&parent, &(parent_end.to_owned() + "\n")).await;
    f.process(&parent).await;
    assert!(f.checkpoint(&parent).pending_fusion.is_none());
    assert_eq!(responses_for(&f.records(), "parent-turn-1").len(), 2);
    f.input
        .inner
        .body
        .collect(f.rt())
        .await
        .expect("real cycle");
    assert!(responses_for(&f.records(), "child-turn-1").is_empty());
    let cp = f.checkpoint(&child);
    assert_eq!(
        cp.active_turn.expect("child still running").turn_id,
        "child-turn-1"
    );
    assert!(cp.pending_subagent.is_none());
    f.append(&child,&(record("2026-08-07T02:05:00Z","event_msg",json!({"type":"task_complete","turn_id":"child-turn-1","last_agent_message":"background complete"}))+"\n")).await;
    f.process(&child).await;
    let r = responses_for(&f.records(), "child-turn-1");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.session.id"], NATIVE_CHILDREN[0].1);
    assert_eq!(
        r[0]["gen_ai.turn.id"],
        format!("{}:child-turn-1", NATIVE_CHILDREN[0].1)
    );
    assert_eq!(r[0]["gen_ai.agent.scope"], "subagent");
    assert_eq!(
        r[0]["gen_ai.subagent.parent_tool_call.id"],
        "call-subagent-1"
    );
    let cp = f.checkpoint(&child);
    assert!(cp.active_turn.is_none() && cp.pending_subagent.is_none());
    let cp = f.checkpoint(&parent);
    assert!(cp.active_turn.is_none() && cp.pending_fusion.is_none());
}
#[tokio::test]
async fn original_child_body_arriving_after_parent_end_keeps_own_identity_and_lineage() {
    use crate::inputs::base::InputBody;
    let f = Fixture::new();
    let mut parent_lines: Vec<_> = NATIVE_PARENT.lines().collect();
    let parent_end = parent_lines.pop().expect("terminal");
    let parent =
        write_native_fixture(&f, NATIVE_PARENT_NAME, &(parent_lines.join("\n") + "\n")).await;
    f.process(&parent).await;
    let child_lines: Vec<_> = NATIVE_CHILDREN[0].3.lines().collect();
    let child = f
        .write(
            &format!("2026/08/07/{}", NATIVE_CHILDREN[0].0),
            &(child_lines[0].to_owned() + "\n"),
        )
        .await;
    f.process(&child).await;
    f.append(&parent, &(parent_end.to_owned() + "\n")).await;
    f.process(&parent).await;
    assert!(f.checkpoint(&parent).pending_fusion.is_none());
    f.input
        .inner
        .body
        .collect(f.rt())
        .await
        .expect("real cycle");
    assert_eq!(responses_for(&f.records(), "parent-turn-1").len(), 2);
    let cp = f.checkpoint(&parent);
    assert!(cp.active_turn.is_none() && cp.pending_fusion.is_none());
    f.append(&child, &(child_lines[1..].join("\n") + "\n"))
        .await;
    initial_hook(
        &f,
        NATIVE_CHILDREN[0].1,
        "child-turn-1",
        &child,
        "subagent-stop",
    )
    .await;
    f.process(&child).await;
    let r = responses_for(&f.records(), "child-turn-1");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.session.id"], NATIVE_CHILDREN[0].1);
    assert_eq!(r[0]["gen_ai.agent.scope"], "subagent");
    assert!(r[0]["gen_ai.agent.parent.invocation.id"].is_string());
    let cp = f.checkpoint(&child);
    assert!(cp.active_turn.is_none() && cp.pending_subagent.is_none());
}
#[tokio::test]
async fn later_ambiguous_spawn_never_replays_a_completed_original_child() {
    let f = Fixture::new();
    let parent_text = NATIVE_PARENT
        .lines()
        .filter(|l| {
            !l.contains("call-subagent-2")
                && !l.contains("call-subagent-3")
                && !l.contains("call-subagent-4")
                && !l.contains("\"type\":\"task_complete\"")
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let parent = write_native_fixture(&f, NATIVE_PARENT_NAME, &parent_text).await;
    f.process(&parent).await;
    let child = write_native_fixture(&f, NATIVE_CHILDREN[0].0, NATIVE_CHILDREN[0].3).await;
    f.process(&child).await;
    let cp = f.checkpoint(&child);
    assert!(cp.pending_subagent.is_none() && cp.active_turn.is_none());
    assert_eq!(responses_for(&f.records(), "child-turn-1").len(), 1);
    f.append(&parent,&([
 record("2026-08-07T02:00:07Z","response_item",json!({"type":"function_call","call_id":"call-subagent-late","name":"spawn_agent","arguments":json!({"task_name":"fixture_child","message":"redacted"}).to_string()})),
 record("2026-08-07T02:00:08Z","response_item",json!({"type":"function_call_output","call_id":"call-subagent-late","output":json!({"task_name":"/root/fixture_child"}).to_string()})),
 record("2026-08-07T02:00:09Z","event_msg",usage(120,12))].join("\n")+"\n")).await;
    f.process(&parent).await;
    f.process(&child).await;
    let links = f.input.subagent_link_snapshot().links;
    let link = links
        .iter()
        .find(|l| l.child_thread_id == NATIVE_CHILDREN[0].1)
        .expect("child link");
    assert_eq!(link.confidence.as_str(), "orphan");
    assert_eq!(
        link.orphan_reason.map(|r| r.as_str()),
        Some("ambiguous_agent_path")
    );
    assert_eq!(responses_for(&f.records(), "child-turn-1").len(), 1);
    assert!(f.checkpoint(&child).pending_subagent.is_none());
}
#[tokio::test]
async fn explicit_original_child_ids_disambiguate_reused_paths_without_holding_children() {
    use crate::inputs::base::InputBody;
    let f = Fixture::new();
    let mut lines: Vec<_> = NATIVE_PARENT.lines().collect();
    let terminal = lines.pop().expect("terminal");
    let mut reduced: Vec<_> = lines
        .into_iter()
        .filter(|l| !l.contains("call-subagent-3") && !l.contains("call-subagent-4"))
        .map(|l| l.replace("fixture_child_2", "fixture_child"))
        .collect();
    let at = reduced.len() - 1;
    reduced.splice(at..at,[
 record("2026-08-07T02:00:04.400Z","event_msg",json!({"type":"sub_agent_activity","kind":"started","event_id":"call-subagent-1","agent_thread_id":NATIVE_CHILDREN[0].1,"agent_path":"/root/fixture_child","occurred_at_ms":1_786_068_004_400_u64})),
 record("2026-08-07T02:00:04.450Z","event_msg",json!({"type":"sub_agent_activity","kind":"started","event_id":"call-subagent-2","agent_thread_id":NATIVE_CHILDREN[1].1,"agent_path":"/root/fixture_child","occurred_at_ms":1_786_068_004_450_u64}))]);
    let parent = write_native_fixture(&f, NATIVE_PARENT_NAME, &(reduced.join("\n") + "\n")).await;
    f.process(&parent).await;
    let mut children = Vec::new();
    for (n, child) in NATIVE_CHILDREN[..2].iter().enumerate() {
        let text = if n == 1 {
            child
                .3
                .replace("/root/fixture_child_2", "/root/fixture_child")
        } else {
            child.3.to_owned()
        };
        let p = write_native_fixture(&f, child.0, &text).await;
        f.process(&p).await;
        children.push(p);
    }
    for p in &children {
        let cp = f.checkpoint(p);
        assert!(cp.pending_subagent.is_none() && cp.active_turn.is_none());
    }
    let links = f.input.subagent_link_snapshot().links;
    for (n, child) in NATIVE_CHILDREN[..2].iter().enumerate() {
        let l = links
            .iter()
            .find(|l| l.child_thread_id == child.1)
            .expect("explicit link");
        assert_eq!(l.confidence.as_str(), "explicit_id");
        assert_eq!(
            l.parent_tool_call_id.as_deref(),
            Some(format!("call-subagent-{}", n + 1).as_str())
        );
    }
    f.append(&parent, &(terminal.to_owned() + "\n")).await;
    f.process(&parent).await;
    assert!(f.checkpoint(&parent).pending_fusion.is_none());
    f.input
        .inner
        .body
        .collect(f.rt())
        .await
        .expect("real cycle");
    let all = f.records();
    for child in &NATIVE_CHILDREN[..2] {
        assert_eq!(responses_for(&all, child.2).len(), 1);
    }
    let parents: std::collections::BTreeSet<_> = all
        .iter()
        .filter(|e| e["gen_ai.agent.scope"] == "subagent")
        .filter_map(|e| e["gen_ai.subagent.parent_tool_call.id"].as_str())
        .collect();
    assert_eq!(
        parents,
        ["call-subagent-1", "call-subagent-2"].into_iter().collect()
    );
}
#[tokio::test]
async fn persisted_legacy_parent_and_child_holds_migrate_to_independent_native_completion() {
    let first = Fixture::new();
    first.input.start().await.expect("start");
    let mut parent_lines: Vec<_> = NATIVE_PARENT.lines().collect();
    let parent_end = parent_lines.pop().expect("terminal");
    let parent = write_native_fixture(
        &first,
        NATIVE_PARENT_NAME,
        &(parent_lines.join("\n") + "\n"),
    )
    .await;
    first.input.run_cycle().await;
    let mut child_lines: Vec<_> = NATIVE_CHILDREN[0].3.lines().collect();
    let child_end = child_lines.pop().expect("terminal");
    let child = write_native_fixture(
        &first,
        NATIVE_CHILDREN[0].0,
        &(child_lines.join("\n") + "\n"),
    )
    .await;
    first.input.run_cycle().await;
    first.input.stop().await.expect("stop");
    let all = first.records();
    let invoke = all
        .iter()
        .find(|e| {
            e["event.name"] == "gen_ai.agent.invoke"
                && e["gen_ai.tool.call.id"] == "call-subagent-1"
        })
        .expect("invoke");
    let parent_trace = invoke["trace_id"].clone();
    let parent_cp = first.checkpoint(&parent);
    let child_cp = first.checkpoint(&child);
    let mut legacy_active =
        serde_json::to_value(child_cp.active_turn.as_ref().expect("child active")).expect("active");
    legacy_active
        .as_object_mut()
        .expect("object")
        .remove("delegation");
    legacy_active
        .as_object_mut()
        .expect("object")
        .remove("emittedTraceId");
    first.append(&parent, &(parent_end.to_owned() + "\n")).await;
    first.append(&child, &(child_end.to_owned() + "\n")).await;
    let parent_size = tokio::fs::metadata(&parent).await.expect("stat").len();
    let child_size = tokio::fs::metadata(&child).await.expect("stat").len();
    let mut child_value = checkpoint_to_value(&child_cp);
    child_value["scanOffset"] = json!(child_size);
    child_value["activeTurn"] = Value::Null;
    child_value["pendingSubagent"] = json!({"turnId":"child-turn-1","parentThreadId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","parentTurnId":"parent-turn-1","parentTraceId":parent_trace,"parentToolCallId":"call-subagent-1","confidence":"agent_path","terminalEndOffset":child_size,"activeTurn":legacy_active});
    first.rt().state_store.update(
        &first.engine().state_key(&child),
        InputStatePatch {
            last_offset: Some(child_size as f64),
            extra: Some(json!({"codexTranscript":child_value})),
            ..Default::default()
        },
    );
    let mut parent_value = checkpoint_to_value(&parent_cp);
    parent_value["scanOffset"] = json!(parent_size);
    parent_value["pendingFusion"] = json!({"turnId":"parent-turn-1","parentThreadId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","parentTraceId":parent_trace,"terminalEndOffset":parent_size,"children":[{"parentToolCallId":"call-subagent-1","parentTraceId":parent_trace,"spawnedAtMs":1_786_068_004_000_u64,"childThreadId":NATIVE_CHILDREN[0].1}]});
    first.rt().state_store.update(
        &first.engine().state_key(&parent),
        InputStatePatch {
            last_offset: Some(parent_size as f64),
            extra: Some(json!({"codexTranscript":parent_value})),
            ..Default::default()
        },
    );
    let recovered = first.restart().await;
    start_until_first_native_cycle(&recovered).await;
    let r = responses_for(&recovered.records(), "child-turn-1");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.session.id"], NATIVE_CHILDREN[0].1);
    assert_eq!(
        r[0]["gen_ai.turn.id"],
        format!("{}:child-turn-1", NATIVE_CHILDREN[0].1)
    );
    let mut combined = first.records();
    combined.extend(recovered.records());
    assert_eq!(responses_for(&combined, "parent-turn-1").len(), 2);
    let cp = recovered.checkpoint(&parent);
    assert!(cp.pending_fusion.is_none() && cp.active_turn.is_none());
    assert!(recovered.checkpoint(&child).pending_subagent.is_none());
}
#[test]
fn actual_segment_filter_distinguishes_known_replay_from_missing_step_or_tool_identity() {
    for name in ["llm.request", "llm.response", "tool.call", "tool.result"] {
        let valid = build_agent_activity_entry(
            &json!({"event.name":name,"gen_ai.agent.type":"codex","gen_ai.session.id":"filter-session","gen_ai.step.id":"filter-session:turn:s1","gen_ai.tool.call.id":"filter-call"}),
        );
        let mut missing = valid.clone();
        if name.starts_with("llm.") {
            missing.step_id = None;
        } else {
            missing.tool_call_id = None;
        }
        let mut active = create_active_turn("turn".into(), 0, 1_782_280_800_000.0, false);
        let initial = filter_new_segment_entries(
            vec![valid.clone(), valid.clone(), missing.clone()],
            &mut active,
        );
        assert_eq!(initial.input_entry_count, 3);
        assert_eq!(initial.entries.len(), 1);
        assert_eq!(initial.entries[0].event_id, valid.event_id);
        assert_eq!(initial.deduplicated_entry_count, 1);
        assert_eq!(initial.rejected_entry_count, 1);
        assert!(!initial.all_already_emitted());
        let mixed = filter_new_segment_entries(vec![valid.clone(), missing], &mut active);
        assert!(mixed.entries.is_empty());
        assert_eq!(mixed.deduplicated_entry_count, 1);
        assert_eq!(mixed.rejected_entry_count, 1);
        assert!(
            !mixed.all_already_emitted(),
            "missing IDs must not be explained as previous successful emission"
        );
        let replay = filter_new_segment_entries(vec![valid], &mut active);
        assert!(replay.entries.is_empty());
        assert_eq!(replay.deduplicated_entry_count, 1);
        assert_eq!(replay.rejected_entry_count, 0);
        assert!(replay.all_already_emitted());
    }
}
#[test]
fn actual_prompt_replay_can_be_known_before_any_closed_step_but_empty_audit_id_cannot() {
    let prompt = build_agent_activity_entry(
        &json!({"event.name":"other","gen_ai.agent.type":"codex","gen_ai.session.id":"filter-session","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"synthetic prompt"}]}]}),
    );
    let mut active = create_active_turn("turn".into(), 0, 1_782_280_800_000.0, true);
    assert_eq!(active.emitted_step_count, 0);
    let replay = filter_new_segment_entries(vec![prompt], &mut active);
    assert!(replay.all_already_emitted());
    assert_eq!(replay.deduplicated_entry_count, 1);
    assert_eq!(replay.rejected_entry_count, 0);
    let mut audit = build_agent_activity_entry(
        &json!({"event.name":"gen_ai.agent.invoke","gen_ai.agent.type":"codex","gen_ai.session.id":"filter-session"}),
    );
    audit.event_id.clear();
    active.emitted_audit_event_ids.push(String::new());
    let malformed = filter_new_segment_entries(vec![audit], &mut active);
    assert!(malformed.entries.is_empty());
    assert_eq!(malformed.deduplicated_entry_count, 0);
    assert_eq!(malformed.rejected_entry_count, 1);
    assert!(!malformed.all_already_emitted());
}

fn control_abort_at(session: &str, seconds: i64) -> Vec<String> {
    let base = chrono::DateTime::parse_from_rfc3339("2026-06-24T06:00:00Z").expect("time")
        + chrono::Duration::seconds(seconds);
    control_abort()
        .into_iter()
        .enumerate()
        .map(|(n, line)| {
            let mut r: Value = serde_json::from_str(&line).expect("control fixture");
            r["timestamp"] = json!((base + chrono::Duration::seconds(n as i64)).to_rfc3339());
            if r["type"] == "session_meta" {
                r["payload"]["id"] = json!(session);
            }
            r.to_string()
        })
        .collect()
}
async fn assert_live_control_does_not_end_collection(f: &Fixture) {
    f.input.start().await.expect("start before new rollout");
    let mut lines = Vec::new();
    for (n, turn) in ["turn-before-1", "turn-before-2", "turn-before-3"]
        .iter()
        .enumerate()
    {
        let turn = simple_turn(turn, 100 + n as u64 * 10, 10 + n as u64, n as i64 * 60);
        lines.extend(turn.into_iter().skip(usize::from(n != 0)));
    }
    lines.extend(control_abort_at("session-1", 180));
    lines.extend(simple_turn("turn-after", 130, 13, 240).into_iter().skip(1));
    let text = lines.join("\n") + "\n";
    let p = f.write("rollout-live-control.jsonl", &text).await;
    f.input.inner.run_cycle().await;
    f.input.stop().await.expect("bounded stop");
    let entries = f.records();
    for turn in [
        "turn-before-1",
        "turn-before-2",
        "turn-before-3",
        "turn-after",
    ] {
        assert_eq!(responses_for(&entries, turn).len(), 1, "{turn}");
    }
    assert!(entries
        .iter()
        .all(|e| e["agent.codex.transcript_turn_id"] != "turn-control"));
    assert_eq!(
        events(&entries, "llm.response")
            .iter()
            .map(|e| e["gen_ai.usage.total_tokens"].as_f64().expect("tokens") as u64)
            .collect::<Vec<_>>(),
        vec![110, 121, 132, 143]
    );
    let ids: std::collections::BTreeSet<_> = entries
        .iter()
        .map(|e| e["event.id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids.len(), entries.len());
    let cp = f.checkpoint(&p);
    assert_eq!(cp.scan_offset, text.len() as i64);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
}
#[tokio::test]
async fn newly_created_live_rollout_collects_four_normal_turns_around_control_abort_with_exact_diagnostic(
) {
    let records = isolated_diagnostic_records("live-control");
    let diagnostic = records
        .iter()
        .find(|e| {
            e["msg"] == "processed terminal Codex turn without observable entries"
                && e["turnId"] == "turn-control"
        })
        .expect("actual control explanation");
    assert_eq!(diagnostic["terminalStatus"], "interrupted");
}
async fn assert_copied_control_forks_restart_without_control_recovery(f: &Fixture) {
    let history = simple_turn("turn-history", 100, 10, 0);
    let p = f
        .write("rollout-history-parent.jsonl", &(history.join("\n") + "\n"))
        .await;
    f.process(&p).await;
    let mut lines = vec![record(
        "2026-06-24T06:10:00Z",
        "session_meta",
        json!({"id":"session-fork","model_provider":"openai","forked_from_id":"session-1"}),
    )];
    lines.extend(history.into_iter().skip(1));
    lines.extend(control_abort_at("session-fork", 660));
    lines.extend(
        simple_turn("turn-fork-new", 130, 13, 720)
            .into_iter()
            .skip(1),
    );
    let p = write_native_fixture(f, "rollout-fork.jsonl", &(lines.join("\n") + "\n")).await;
    f.process(&p).await;
    let entries = f.records();
    assert_eq!(responses_for(&entries, "turn-history").len(), 1);
    assert_eq!(responses_for(&entries, "turn-fork-new").len(), 1);
    assert!(entries
        .iter()
        .all(|e| e["agent.codex.transcript_turn_id"] != "turn-control"));
    let cp = f.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
    let next = f.restart().await;
    let mut lines = vec![record(
        "2026-06-24T06:20:00Z",
        "session_meta",
        json!({"id":"session-fork-2","model_provider":"openai","forked_from_id":"session-fork"}),
    )];
    lines.extend(control_abort_at("session-fork-2", 1260));
    lines.extend(
        simple_turn("turn-fork-after-restart", 140, 14, 1320)
            .into_iter()
            .skip(1),
    );
    let p = write_native_fixture(
        &next,
        "rollout-fork-after-restart.jsonl",
        &(lines.join("\n") + "\n"),
    )
    .await;
    next.process(&p).await;
    assert_eq!(
        responses_for(&next.records(), "turn-fork-after-restart").len(),
        1
    );
    let cp = next.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
}
#[tokio::test]
async fn fork_copied_history_and_control_prefix_skip_in_one_cycle_and_durable_restart() {
    let records = isolated_diagnostic_records("fork-control");
    assert!(!records.iter().any(|e| e["msg"]
        == "processed terminal Codex turn without observable entries"
        && e["turnId"] == "turn-control"));
}
#[tokio::test]
async fn legacy_empty_pending_terminal_clears_during_actual_startup_and_collects_later_work() {
    let f = Fixture::new();
    let lines = control_abort();
    let control = lines.join("\n") + "\n";
    let text = control.clone()
        + &simple_turn("turn-normal", 120, 12, 60)
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
        + "\n";
    let p = f.write("rollout-session-1.jsonl", &text).await;
    let (ino, _, _) = file_meta_snapshot(&p).await.expect("native snapshot");
    f.rt().state_store.update(&f.engine().state_key(&p),InputStatePatch {
        last_offset:Some(control.len() as f64),
        extra:Some(json!({"codexTranscript":{
            "inode":ino,"scanOffset":control.len(),
            "activeTurn":{"turnId":"turn-control","startOffset":0,"startedAtMs":1_782_280_800_000.0,"model":"gpt-5.5"},
            "pendingTerminal":{"turnId":"turn-control","terminalEndOffset":control.len()},
            "latestSessionMetaOffset":(lines[..2].join("\n")+"\n").len(),
            "emittedTerminalTurnIds":[]
        }})),
        ..Default::default()
    });
    let next = f.restart().await;
    start_until_first_native_cycle(&next).await;
    let entries = next.records();
    assert!(entries
        .iter()
        .all(|e| e["agent.codex.transcript_turn_id"] != "turn-control"));
    assert_eq!(responses_for(&entries, "turn-normal").len(), 1);
    let cp = next.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
}
#[tokio::test]
async fn copied_parent_terminal_rewritten_to_fork_timestamp_never_masks_owned_uuid_turn() {
    let f = Fixture::new();
    f.input.start().await.expect("start before new rollout");
    let child = NATIVE_CHILDREN[0];
    let mut lines = Vec::new();
    for (n, line) in child.3.lines().enumerate() {
        let mut r: Value = serde_json::from_str(line).expect("native fixture");
        if n == 0 {
            r["timestamp"] = json!("2026-08-07T08:42:35.146Z");
            r["payload"]["timestamp"] = r["timestamp"].clone();
            r["payload"]["id"] = json!("019fdb63-710a-7131-978c-6a6ee744fff9");
        }
        if (1..=8).contains(&n) {
            r["timestamp"] = json!("2026-08-07T08:42:35.204Z");
        }
        lines.push(
            r.to_string()
                .replace("parent-turn-1", "019fdb63-2fc6-7491-9895-8c8f86a8bcab")
                .replace("child-turn-1", "019fdb63-714b-7c72-9c8c-c2e40d9c9111"),
        );
    }
    let p = write_native_fixture(&f, child.0, &(lines.join("\n") + "\n")).await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    assert_eq!(
        responses_for(&f.records(), "019fdb63-714b-7c72-9c8c-c2e40d9c9111").len(),
        1
    );
    assert!(responses_for(&f.records(), "019fdb63-2fc6-7491-9895-8c8f86a8bcab").is_empty());
    let cp = f.checkpoint(&p);
    assert!(cp.pending_subagent.is_none() && cp.active_turn.is_none());
}
#[tokio::test]
async fn unmatched_token_sample_before_any_response_wave_does_not_shift_later_step_tokens() {
    let f = Fixture::new();
    f.input.start().await.expect("start before new rollout");
    let text = completed();
    let mut lines = text.lines().map(str::to_string).collect::<Vec<_>>();
    lines.insert(
        3,
        record("2026-06-24T06:00:02.500Z", "event_msg", usage(1, 1)),
    );
    f.write("rollout-unmatched-token.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    assert_eq!(
        events(&f.records(), "llm.response")
            .iter()
            .map(|e| e["gen_ai.usage.total_tokens"].as_f64().expect("tokens") as u64)
            .collect::<Vec<_>>(),
        vec![110, 132, 143]
    );
}
#[tokio::test]
async fn actual_single_collector_interrupt_closes_reasoning_response_and_cancels_pending_tool() {
    let f = Fixture::new();
    f.input.start().await.expect("start before new rollout");
    let text = completed();
    let mut lines = text.lines().map(str::to_string).collect::<Vec<_>>();
    lines.truncate(lines.len() - 3);
    lines.extend([
      record("2026-06-24T06:00:10Z","event_msg",json!({"type":"agent_message","message":"one final operation","phase":"commentary"})),
      record("2026-06-24T06:00:11Z","response_item",json!({"type":"function_call","call_id":"call-pending","name":"exec_command","arguments":"{\"cmd\":\"sleep 10\"}"})),
      record("2026-06-24T06:00:12Z","event_msg",json!({"type":"turn_aborted","turn_id":"turn-1","reason":"interrupted"}))
    ]);
    f.write("rollout-interrupted.jsonl", &(lines.join("\n") + "\n"))
        .await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("stop");
    let entries = f.records();
    let response = entries
        .iter()
        .find(|e| {
            e["gen_ai.response.finish_reasons"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("cancelled")))
        })
        .expect("cancelled real response");
    assert_eq!(response["agent.codex.turn_status"], "interrupted");
    let messages = response["gen_ai.output.messages"]
        .as_array()
        .expect("output");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "assistant");
    assert_eq!(messages[0]["finish_reason"], "cancelled");
    assert!(messages[0]["parts"]
        .as_array()
        .expect("parts")
        .contains(&json!({"type":"reasoning","content":"one final operation"})));
    let tool = entries
        .iter()
        .find(|e| e["event.name"] == "tool.result" && e["gen_ai.tool.call.id"] == "call-pending")
        .expect("pending tool closure");
    assert_eq!(tool["tool.result.status"], "cancelled");
}
#[derive(Default)]
struct SyntheticImageUploads(Mutex<Vec<crate::multimodal::types::UploadItem>>);
#[async_trait::async_trait]
impl crate::multimodal::types::Uploader for SyntheticImageUploads {
    async fn upload(
        &self,
        item: crate::multimodal::types::UploadItem,
        _opts: crate::multimodal::types::UploadOptions,
    ) -> bool {
        self.0.lock().expect("uploads").push(item);
        true
    }
    async fn shutdown(&self) {}
}
#[tokio::test]
async fn independent_child_six_case_privacy_matrix_blocks_before_real_attachment_processing_and_output(
) {
    use crate::inputs::base::WorkspacePolicy;
    use crate::inputs::codex_transcript::CodexMultimodalOptions;
    // run_cycle may join a watcher cycle whose file snapshot predates a write.
    // Observe real state, sharing the existing real-lifecycle fixture's five-
    // second budget across every scan boundary in each original matrix case.
    async fn observe_cycle_boundary(
        f: &Fixture,
        deadline: tokio::time::Instant,
        label: &str,
        ready: impl Fn() -> bool,
    ) {
        tokio::time::timeout_at(deadline, async {
            loop {
                f.input.run_cycle().await;
                if ready() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("native privacy fixture did not observe {label}"));
    }
    let mut privacy_failures = Vec::new();
    for child_terminal in [true, false] {
        for (blocked_parent, blocked_child) in [(true, false), (false, false), (false, true)] {
            let root = isolated_fixture_root();
            let uploads = Arc::new(SyntheticImageUploads::default());
            let processor = crate::multimodal::MultimodalProcessor::new(
                Some("oss://test/synthetic-child"),
                uploads.clone(),
                None,
            )
            .expect("processor");
            let f = Fixture::with_root_options(
                root.clone(),
                Some(CodexMultimodalOptions {
                    enabled: true,
                    upload_mode: Some(crate::types::MultimodalUploadMode::All),
                    processor: Some(processor.clone()),
                }),
            );
            // Native absolute paths make the same fixture meaningful on Windows.
            let private = root
                .path()
                .join("private-project")
                .to_string_lossy()
                .into_owned();
            let public = root
                .path()
                .join("public-project")
                .to_string_lossy()
                .into_owned();
            f.rt().set_workspace_policy(WorkspacePolicy::new(
                vec![private.clone()],
                Some(root.path().join("privacy-state")),
            ));
            let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            if blocked_parent {
                assert!(!f.rt().with_workspace_policy(|p| p.allows(
                    json!({"gen_ai.session.id":parent,"cwd":private})
                        .as_object()
                        .expect("record"),
                    "codex"
                )));
            }
            let output = Arc::new(Mutex::new(Vec::<AgentActivityEntry>::new()));
            let target = output.clone();
            let weak = Arc::downgrade(&f.input.inner);
            f.input.on_entries(move |batch| {
                let host = weak.upgrade().expect("fixture input lifetime");
                let filtered = host.runtime.with_workspace_policy(|p| {
                    p.filter_entries(batch, crate::types::ClientType::CodexCliHook)
                });
                target.lock().expect("output").extend(filtered);
            });
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            f.input.start().await.expect("real startup before fixtures");
            let mut parent_lines = NATIVE_PARENT
                .lines()
                .map(str::to_string)
                .collect::<Vec<_>>();
            let parent_terminal = parent_lines.pop().expect("parent terminal");
            let pp =
                write_native_fixture(&f, NATIVE_PARENT_NAME, &(parent_lines.join("\n") + "\n"))
                    .await;
            observe_cycle_boundary(&f, deadline, "parent spawn registration", || {
                f.input.subagent_link_snapshot().detected_spawns >= 4
            })
            .await;
            assert_eq!(f.input.subagent_link_snapshot().detected_spawns, 4);
            let child = NATIVE_CHILDREN[0];
            let mut child_records = child
                .3
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).expect("child fixture"))
                .collect::<Vec<_>>();
            for item in &mut child_records {
                if item["type"] == "turn_context" && item["payload"]["turn_id"] == child.2 {
                    item["payload"]["cwd"] = json!(if blocked_child { &private } else { &public });
                }
                if item["type"] == "response_item"
                    && item["payload"]["role"] == "user"
                    && item["payload"]["content"].as_array().is_some_and(|parts| {
                        parts.iter().any(|p| p["text"] == "synthetic child task")
                    })
                {
                    item["payload"]["content"].as_array_mut().expect("content").push(json!({"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="}));
                }
            }
            let child_end = child_records.last().expect("child terminal").to_string();
            if !child_terminal {
                child_records.pop();
            }
            let text = child_records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            let cp = write_native_fixture(&f, child.0, &text).await;
            let child_prefix_size = std::fs::metadata(&cp)
                .expect("published child prefix")
                .len() as i64;
            observe_cycle_boundary(&f, deadline, "new child checkpoint", || {
                f.engine()
                    .read_checkpoint(f.rt(), &f.engine().state_key(&cp))
                    .is_some_and(|state| state.scan_offset >= child_prefix_size)
            })
            .await;
            let before = f.checkpoint(&cp);
            if child_terminal {
                assert!(before.active_turn.is_none() && before.scan_offset > 0);
            } else {
                assert!(before
                    .active_turn
                    .as_ref()
                    .is_some_and(|active| before.scan_offset > active.start_offset));
                assert!(responses_for(&f.records(), child.2).is_empty());
            }
            f.append(&pp, &(parent_terminal + "\n")).await;
            let parent_end = std::fs::metadata(&pp)
                .expect("published parent terminal")
                .len() as i64;
            observe_cycle_boundary(&f, deadline, "parent terminal checkpoint", || {
                f.engine()
                    .read_checkpoint(f.rt(), &f.engine().state_key(&pp))
                    .is_some_and(|state| {
                        state.scan_offset >= parent_end && state.active_turn.is_none()
                    })
            })
            .await;
            assert!(f.checkpoint(&pp).active_turn.is_none());
            if !child_terminal {
                assert!(
                    responses_for(&f.records(), child.2).is_empty(),
                    "parent must not force child"
                );
                f.append(&cp, &(child_end + "\n")).await;
                let child_end = std::fs::metadata(&cp)
                    .expect("published child terminal")
                    .len() as i64;
                observe_cycle_boundary(&f, deadline, "child terminal checkpoint", || {
                    f.engine()
                        .read_checkpoint(f.rt(), &f.engine().state_key(&cp))
                        .is_some_and(|state| {
                            state.scan_offset >= child_end && state.active_turn.is_none()
                        })
                })
                .await;
            }
            assert!(f.checkpoint(&cp).active_turn.is_none());
            f.input.stop().await.expect("real bounded stop");
            processor.shutdown(1500).await;
            let output: Vec<Value> = output
                .lock()
                .expect("output")
                .iter()
                .map(|e| serde_json::to_value(e).expect("entry"))
                .collect();
            if blocked_parent || blocked_child {
                if !uploads.0.lock().expect("uploads").is_empty() {
                    privacy_failures.push(format!("private attachment reached uploader parent={blocked_parent} child={blocked_child} terminal={child_terminal}"));
                }
                if output
                    .iter()
                    .any(|e| e["agent.codex.transcript_turn_id"] == child.2)
                {
                    privacy_failures.push(format!("private child reached output parent={blocked_parent} child={blocked_child} terminal={child_terminal}"));
                }
            } else {
                let entries = f
                    .records()
                    .into_iter()
                    .filter(|e| e["agent.codex.transcript_turn_id"] == child.2)
                    .collect::<Vec<_>>();
                assert!(!entries.is_empty());
                assert!(entries
                    .iter()
                    .all(|e| e["gen_ai.session.id"] == child.1
                        && e["gen_ai.agent.scope"] == "subagent"));
                let uploads = uploads.0.lock().expect("uploads");
                assert!(!uploads.is_empty());
                assert!(uploads
                    .iter()
                    .all(|item| item.data.as_deref() == Some(b"hello")
                        && item.content_type == "image/png"));
                assert!(output
                    .iter()
                    .any(|e| e["agent.codex.transcript_turn_id"] == child.2));
            }
        }
    }
    assert!(
        privacy_failures.is_empty(),
        "{}",
        privacy_failures.join("\n")
    );
}

async fn replace_native_inode(path: &str, text: &str) -> u64 {
    let original = file_meta_snapshot(path)
        .await
        .expect("old native snapshot")
        .0;
    let replacement = format!("{path}.replacement");
    tokio::fs::write(&replacement, text)
        .await
        .expect("new file");
    tokio::fs::rename(&replacement, path)
        .await
        .expect("atomic replacement");
    let current = file_meta_snapshot(path).await.expect("native snapshot").0;
    assert_ne!(
        current, original,
        "real replacement must change platform file identity"
    );
    current
}
#[tokio::test]
async fn replaced_inode_baseline_never_suppresses_same_turn_id_in_another_file_after_restart() {
    let f = Fixture::new();
    f.input.start().await.expect("start before new rollout");
    let p = f
        .write(
            "rollout-original-inode.jsonl",
            &(simple_turn("turn-1", 100, 10, 0).join("\n") + "\n"),
        )
        .await;
    f.input.run_cycle().await;
    assert_eq!(responses_for(&f.records(), "turn-1").len(), 1);
    let ino = replace_native_inode(
        &p,
        &(simple_turn("turn-2", 200, 20, 1200).join("\n") + "\n"),
    )
    .await;
    f.input.run_cycle().await;
    assert_eq!(f.checkpoint(&p).inode, ino);
    f.input
        .stop()
        .await
        .expect("stop after replacement observed");
    let next = f.restart().await;
    next.input.start().await.expect("startup restore");
    let mut lines = simple_turn("turn-2", 200, 20, 1800);
    lines.extend(simple_turn("turn-3", 300, 30, 1860).into_iter().skip(1));
    next.write("rollout-newfile-inode.jsonl", &(lines.join("\n") + "\n"))
        .await;
    next.input.run_cycle().await;
    next.input.stop().await.expect("stop");
    assert_eq!(responses_for(&next.records(), "turn-2").len(), 1);
    let r = responses_for(&next.records(), "turn-3");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["gen_ai.usage.total_tokens"].as_f64(), Some(330.0));
}
fn inode_fork_records(tail: u64) -> (String, String, String, String, Vec<String>) {
    let parent = uuid_at("2026-08-05T09:00:00Z", tail + 1);
    let owner = uuid_at("2026-08-05T10:00:00Z", tail + 2);
    let copied = uuid_at("2026-08-05T09:30:00Z", tail + 3);
    let owned = uuid_at("2026-08-05T10:00:00.010Z", tail + 4);
    let mut lines = vec![owner_meta(&owner, &parent, false)];
    lines.extend(turn_block(&copied, "2026-08-05T09:30:00Z"));
    (parent, owner, copied, owned, lines)
}
async fn assert_later_parent_not_deduped(f: &Fixture, parent: &str, copied: &str) {
    let mut lines = vec![record(
        "2026-08-05T09:00:00Z",
        "session_meta",
        json!({"id":parent,"thread_source":"user","model_provider":"openai"}),
    )];
    lines.extend(turn_block(copied, "2026-08-05T09:30:00Z"));
    let p = f
        .write(
            &format!("2026/08/05/rollout-2026-08-05T09-00-00-{parent}.jsonl"),
            &(lines.join("\n") + "\n"),
        )
        .await;
    f.process(&p).await;
    assert_eq!(responses_for(&f.records(), copied).len(), 1);
}
#[tokio::test]
async fn pending_fork_inode_replacement_restarts_search_and_keeps_later_parent_emittable() {
    let f = Fixture::new();
    let (parent, owner, copied, owned, mut lines) = inode_fork_records(20);
    let p = fork_path(&f, &owner, &lines).await;
    f.process(&p).await;
    let cp = f.checkpoint(&p);
    assert_eq!(cp.scan_offset, 0);
    assert!(cp.fork_bootstrap.is_some());
    lines.extend(turn_block(&owned, "2026-08-05T10:00:00.010Z"));
    replace_native_inode(&p, &(lines.join("\n") + "\n")).await;
    f.process(&p).await;
    assert!(responses_for(&f.records(), &copied).is_empty());
    assert_eq!(responses_for(&f.records(), &owned).len(), 1);
    assert_later_parent_not_deduped(&f, &parent, &copied).await;
}
#[tokio::test]
async fn anchored_before_collection_fork_replacement_retains_recovery_anchor_and_collects_once() {
    let f = Fixture::new();
    let (_parent, owner, copied, owned, mut lines) = inode_fork_records(30);
    lines.extend(turn_block(&owned, "2026-08-05T10:00:00.010Z"));
    let text = lines.join("\n") + "\n";
    let p = fork_path(&f, &owner, &lines).await;
    initial_hook(&f, &owner, &owned, &p, "user-prompt-submit").await;
    f.process(&p).await;
    let cp = f.checkpoint(&p);
    assert!(cp.scan_offset > 0);
    assert_eq!(
        cp.fork_bootstrap
            .expect("anchored")
            .initial_turn_id
            .as_deref(),
        Some(owned.as_str())
    );
    assert!(f.records().is_empty());
    replace_native_inode(&p, &text).await;
    f.marker("wakeups",&format!("{owner}.json"),json!({"session_id":owner,"initial_turn_id":owned,"recovery_turn_id":owned,"transcript_path":p,"hook_event":"stop"})).await;
    f.process(&p).await;
    assert!(responses_for(&f.records(), &copied).is_empty());
    assert_eq!(responses_for(&f.records(), &owned).len(), 1);
    assert!(f.checkpoint(&p).fork_bootstrap.is_none());
}
#[tokio::test]
async fn consumed_fork_inode_replacement_baselines_without_parent_deduplication_poisoning() {
    let f = Fixture::new();
    let (parent, owner, copied, owned, mut lines) = inode_fork_records(50);
    lines.extend(turn_block(&owned, "2026-08-05T10:00:00.010Z"));
    let text = lines.join("\n") + "\n";
    let p = fork_path(&f, &owner, &lines).await;
    f.process(&p).await;
    assert!(responses_for(&f.records(), &copied).is_empty());
    assert_eq!(responses_for(&f.records(), &owned).len(), 1);
    let cp = f.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_none()
    );
    replace_native_inode(&p, &text).await;
    f.process(&p).await;
    assert!(responses_for(&f.records(), &copied).is_empty());
    assert_eq!(responses_for(&f.records(), &owned).len(), 1);
    let cp = f.checkpoint(&p);
    assert!(
        cp.active_turn.is_none() && cp.pending_terminal.is_none() && cp.fork_bootstrap.is_some()
    );
    assert_later_parent_not_deduped(&f, &parent, &copied).await;
}
async fn assert_invalid_fork_search_repair(f: &Fixture) {
    let owner = "cccccccc-0006-4006-8006-000000000006";
    let turn = "owned-turn-after-invalid-offset";
    let mut lines = vec![owner_meta(owner, "parent", false)];
    lines.extend(turn_block(
        "copied-before-invalid-offset",
        "2026-08-04T10:00:00Z",
    ));
    lines.extend(turn_block(turn, "2026-08-05T10:00:00.010Z"));
    let text = lines.join("\n") + "\n";
    let p = fork_path(f, owner, &lines).await;
    let (ino, _, _) = file_meta_snapshot(&p).await.expect("native snapshot");
    f.rt().state_store.update(&f.engine().state_key(&p),InputStatePatch{
      last_offset:Some(0.0),
      extra:Some(json!({"codexTranscript":{
       "inode":ino,"scanOffset":0,"activeTurn":null,"pendingTerminal":null,"pendingFusion":null,"pendingSubagent":null,
       "ownerSessionMetaOffset":null,"forkBootstrap":{"initialTurnId":turn,"searchOffset":text.len()+100},
       "emittedTerminalTurnIds":[]
      }})),..Default::default()
    });
    initial_hook(f, owner, turn, &p, "stop").await;
    f.process(&p).await;
    assert_eq!(responses_for(&f.records(), turn).len(), 1);
    assert!(responses_for(&f.records(), "copied-before-invalid-offset").is_empty());
    println!(
        "{}",
        json!({"msg":"synthetic invalid fork search offset","expectedOffset":text.len()+100})
    );
}
#[tokio::test]
async fn persisted_out_of_range_fork_search_offset_is_repaired_and_actual_warning_names_both_offsets(
) {
    let records = isolated_diagnostic_records("invalid-offset");
    let offset = records
        .iter()
        .find(|e| e["msg"] == "synthetic invalid fork search offset")
        .expect("fixture offset")["expectedOffset"]
        .clone();
    let warning = records
        .iter()
        .find(|e| e["msg"] == "repaired invalid Codex fork bootstrap search offset")
        .expect("actual repair diagnostic");
    assert_eq!(warning["searchOffset"], offset);
    assert_eq!(warning["repairedSearchOffset"], 0);
}

#[path = "engine_main_history.rs"]
mod main_history_contracts;

#[tokio::test]
async fn fixture_native_path_matches_real_discovery_and_checkpoint_key_for_nested_rollout() {
    let f = Fixture::new();
    f.input.start().await.expect("start before rollout");
    let path = f
        .write("2026/06/24/rollout-native-spelling.jsonl", &completed())
        .await;
    f.input.run_cycle().await;
    f.input.stop().await.expect("bounded stop");
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .expect("canonical source")
        .to_string_lossy()
        .into_owned();
    assert_eq!(path, canonical);
    assert_eq!(f.checkpoint(&path).scan_offset, completed().len() as i64);
    assert_eq!(responses_for(&f.records(), "turn-1").len(), 3);
    assert_eq!(
        f.engine().state_key(&path),
        format!("codex-transcript:{canonical}")
    );
}

#[tokio::test]
async fn ordinary_home_and_canonical_transcript_marker_collect_real_isolated_root_on_windows() {
    let f = Fixture::new();
    let path = f
        .write(
            "../home/u/synthetic/sessions/2026/06/24/rollout-session-1.jsonl",
            &completed(),
        )
        .await;
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .expect("canonical transcript");
    let home = f.root.path().join("home").to_string_lossy().into_owned();
    // Construct the ordinary hook spelling independently of the comparison code.
    #[cfg(windows)]
    let home = home
        .strip_prefix(r"\\?\")
        .expect("canonical local temp prefix")
        .to_string();
    f.marker(
        "wakeups",
        "session-1.json",
        json!({
            "session_id": "session-1", "turn_id": "turn-1",
            "codex_home": home,
            "session_dir": std::path::Path::new(&home).join("sessions"),
            "transcript_path": canonical,
            "received_at": chrono::Utc::now().to_rfc3339()
        }),
    )
    .await;
    run_real_lifecycle(&f).await;
    assert_eq!(responses_for(&f.records(), "turn-1").len(), 3);
    assert_eq!(
        f.checkpoint(canonical.to_str().expect("canonical string"))
            .scan_offset,
        completed().len() as i64
    );
}

include!("workspace_privacy_history.rs");

#[path = "engine_main346_history.rs"]
mod main346_contracts;

#[path = "discovery_cache_main_tests.rs"]
mod discovery_cache_main_tests;
