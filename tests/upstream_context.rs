//! Upstream main #508: production correlation, batch ordering and delegation.
use loongsuite_pilot::core::{CorrelationStore, TraceLinker};
use loongsuite_pilot::types::AgentActivityEntry;
use loongsuite_pilot::utils::content_hash;
use serde_json::json;
use std::fs;

const TRACE: &str = "11111111111111111111111111111111";
const PARENT: &str = "2222222222222222";
const TP: &str = "00-11111111111111111111111111111111-2222222222222222-01";

fn event(turn: &str, name: &str, text: Option<&str>) -> AgentActivityEntry {
    let mut value = json!({
        "gen_ai.agent.type":"openclaw", "gen_ai.agent.id":"agent",
        "gen_ai.session.id":"session", "gen_ai.turn.id":turn,
        "event.name":name, "time_unix_nano":"1700000000000000000",
        "trace_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    if let Some(text) = text {
        value["gen_ai.input.messages_delta"] = json!([{
            "role":"user", "parts":[{"type":"text","content":text}]
        }]);
    }
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn input_resolution_precedes_metadata_without_changing_batch_order_or_losing_late_input() {
    for split in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("session.jsonl"), format!("{}\n{}\n",
            json!({"type":"session","traceparent":"00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-cccccccccccccccc-01"}),
            json!({"type":"turn","contentHash":content_hash("hello"),"traceparent":TP}),
        )).unwrap();
        let linker = TraceLinker::with_retry(CorrelationStore::new(dir.path()), 0, 0);
        let mut leading = vec![
            event("turn", "other", None),
            event("turn", "llm.request", None),
        ];
        if split {
            linker.stamp(&mut leading).await;
            assert!(
                leading
                    .iter()
                    .all(|entry| entry.trace_id.as_deref()
                        == Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
            );
            let mut later = vec![event("turn", "other", Some("hello"))];
            linker.stamp(&mut later).await;
            assert_eq!(later[0].trace_id.as_deref(), Some(TRACE));
            linker.stamp(&mut leading).await;
        } else {
            leading.push(event("turn", "other", Some("hello")));
            linker.stamp(&mut leading).await;
        }
        assert!(leading
            .iter()
            .all(|entry| entry.trace_id.as_deref() == Some(TRACE)));
        assert_eq!(leading[0].parent_span_id.as_deref(), Some(PARENT));
        assert!(leading[1].parent_span_id.is_none());
        assert_eq!(leading[1].event_name.unwrap().to_string(), "llm.request");
    }
}

#[tokio::test]
async fn native_delegation_keeps_its_parent_and_leaves_the_file_context_unclaimed() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("session.jsonl"),
        format!(
            "{}\n",
            json!({"type":"turn","contentHash":content_hash("hello"),"traceparent":TP}),
        ),
    )
    .unwrap();
    let linker = TraceLinker::with_retry(CorrelationStore::new(dir.path()), 0, 0);
    let mut child = event("child", "other", Some("hello"));
    child
        .extra
        .insert("gen_ai.agent.scope".into(), json!("subagent"));
    child.parent_span_id = Some("dddddddddddddddd".into());
    linker.stamp(std::slice::from_mut(&mut child)).await;
    assert_eq!(
        child.trace_id.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(child.parent_span_id.as_deref(), Some("dddddddddddddddd"));
    assert_eq!(
        CorrelationStore::new(dir.path())
            .resolve_turn("session", "hello")
            .as_deref(),
        Some(TP)
    );
}

#[test]
fn durable_claims_replay_only_their_owner_and_preserve_node_marker_compatibility() {
    let dir = tempfile::tempdir().unwrap();
    // Digest captured from Node crypto(SHA-256(JSON.stringify(normalizedRecord)))
    // using the upstream record field order, with unknown fields discarded.
    let digest = "cddc8b1d98ed5b801adaad4fe0ba3b25b6201a5d8c606f640beb49e4d5164521";
    fs::write(
        dir.path().join("session.jsonl"),
        format!(
            "{}\n",
            json!({
                "type":"turn","contentHash":"0123456789abcdef","contentPrefix":"界/line\n",
                "traceparent":TP,"sessionId":"ignored","privateExtra":"not-in-marker",
            })
        ),
    )
    .unwrap();
    let store = CorrelationStore::new(dir.path());
    assert_eq!(
        store
            .resolve_turn_with_identity(
                "session",
                "display truncated",
                Some("native-turn"),
                Some("0123456789abcdef")
            )
            .as_deref(),
        Some(TP)
    );
    let marker = dir
        .path()
        .join(format!("session.turn-context-0-{digest}.done"));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&marker).unwrap()).unwrap(),
        json!({"turnId":"native-turn"})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(fs::read_dir(dir.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".turn-claim-")));
    for _ in 0..2 {
        let restarted = CorrelationStore::new(dir.path());
        assert!(restarted
            .resolve_turn_with_identity("session", "界/line\nrewrite", Some("other-turn"), None)
            .is_none());
        assert_eq!(
            restarted
                .resolve_turn_with_identity(
                    "session",
                    "display truncated",
                    Some("native-turn"),
                    Some("0123456789abcdef")
                )
                .as_deref(),
            Some(TP)
        );
        restarted.prune_idle(u128::MAX);
        assert_eq!(
            restarted
                .resolve_turn_with_identity(
                    "session",
                    "",
                    Some("native-turn"),
                    Some("0123456789abcdef")
                )
                .as_deref(),
            Some(TP)
        );
    }
    fs::write(&marker, b"interrupted/invalid owner").unwrap();
    assert!(CorrelationStore::new(dir.path())
        .resolve_turn_with_identity("session", "", Some("native-turn"), Some("0123456789abcdef"))
        .is_none());
}

#[test]
fn repeated_prompts_consume_distinct_contexts_and_append_reloads_without_a_clock_tick() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let record = |tp: &str| {
        json!({"type":"turn","contentHash":content_hash("repeat"),"traceparent":tp}).to_string()
    };
    fs::write(&path, format!("{}\n", record(TP))).unwrap();
    let fixed = fs::metadata(&path).unwrap().modified().unwrap();
    let store = CorrelationStore::new(dir.path());
    assert_eq!(
        store
            .resolve_turn_with_identity("session", "repeat", Some("one"), None)
            .as_deref(),
        Some(TP)
    );
    let second = "00-33333333333333333333333333333333-4444444444444444-01";
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "{}", record(second)).unwrap();
    file.set_modified(fixed).unwrap();
    drop(file);
    assert_eq!(
        store
            .resolve_turn_with_identity("session", "repeat", Some("two"), None)
            .as_deref(),
        Some(second)
    );
    assert_eq!(
        store
            .resolve_turn_with_identity("session", "repeat", Some("one"), None)
            .as_deref(),
        Some(TP)
    );
    let restarted = CorrelationStore::new(dir.path());
    assert!(restarted
        .resolve_turn_with_identity("session", "repeat", Some("three"), None)
        .is_none());
    assert_eq!(
        restarted
            .resolve_turn_with_identity("session", "repeat", Some("two"), None)
            .as_deref(),
        Some(second)
    );
}

#[tokio::test]
async fn competing_collector_processes_publish_one_complete_owner_and_allow_only_its_replay() {
    const OWNER: &str = "PILOT_CORRELATION_CLAIM_OWNER";
    const ROOT: &str = "PILOT_CORRELATION_CLAIM_ROOT";
    if let Ok(owner) = std::env::var(OWNER) {
        let dir = std::env::var(ROOT).unwrap();
        let value = CorrelationStore::new(&dir).resolve_turn_with_identity(
            "session",
            "same prompt",
            Some(&owner),
            None,
        );
        fs::write(
            std::path::Path::new(&dir).join(format!("{owner}.json")),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("session.jsonl"),
        format!(
            "{}\n",
            json!({
                "type":"turn","contentHash":content_hash("same prompt"),"traceparent":TP,
            })
        ),
    )
    .unwrap();
    let mut children = tokio::task::JoinSet::new();
    for index in 0..8 {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact","competing_collector_processes_publish_one_complete_owner_and_allow_only_its_replay"])
            .env_clear().env(OWNER, format!("owner-{index}")).env(ROOT, dir.path())
            .env("HOME",dir.path()).env("USERPROFILE",dir.path())
            .env("PATH",dir.path().join("no-runtimes"));
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        children.spawn(async move {
            let output = loongsuite_pilot::utils::candidate_process::output(
                &mut command,
                std::time::Duration::from_secs(15),
                1024 * 1024,
            )
            .await
            .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        });
    }
    while let Some(result) = children.join_next().await {
        result.unwrap();
    }
    let winners: Vec<_> = (0..8)
        .filter_map(|index| {
            let owner = format!("owner-{index}");
            let value: Option<String> = serde_json::from_slice(
                &fs::read(dir.path().join(format!("{owner}.json"))).unwrap(),
            )
            .unwrap();
            value.map(|value| {
                assert_eq!(value, TP);
                owner
            })
        })
        .collect();
    assert_eq!(winners.len(), 1);
    let restarted = CorrelationStore::new(dir.path());
    assert!(restarted
        .resolve_turn_with_identity("session", "same prompt", Some("new-owner"), None)
        .is_none());
    assert_eq!(
        restarted
            .resolve_turn_with_identity("session", "same prompt", Some(&winners[0]), None)
            .as_deref(),
        Some(TP)
    );
}

#[tokio::test]
async fn producer_hash_links_truncated_unicode_and_first_turn_fallback_keeps_source_order() {
    let text = "界".repeat(33000);
    for display in [Some("truncated"), None] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("session.jsonl"), format!("{}\n", json!({
            "type":"turn","contentHash":content_hash(&text),"traceparent":TP.to_ascii_uppercase(),
        }))).unwrap();
        let linker = TraceLinker::with_retry(CorrelationStore::new(dir.path()), 0, 0);
        let mut record = event("one", "other", display);
        record.extra.insert(
            "agent.pilot.correlation.content_hash".into(),
            json!(content_hash(&text)),
        );
        linker.stamp(std::slice::from_mut(&mut record)).await;
        assert_eq!(record.trace_id.as_deref(), Some(TRACE));
        assert_eq!(record.parent_span_id.as_deref(), Some(PARENT));
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("session.jsonl"),
        format!("{}\n", json!({"type":"session","traceparent":TP})),
    )
    .unwrap();
    let linker = TraceLinker::with_retry(CorrelationStore::new(dir.path()), 0, 0);
    let mut batch = vec![
        event("first", "other", None),
        event("second", "other", Some("input")),
    ];
    linker.stamp(&mut batch).await;
    assert!(batch
        .iter()
        .all(|entry| entry.trace_id.as_deref() == Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")));
    let mut late = event("first", "other", Some("late input"));
    linker.stamp(std::slice::from_mut(&mut late)).await;
    assert_eq!(late.trace_id.as_deref(), Some(TRACE));
    assert_eq!(late.turn_id.as_deref(), Some("first"));
    assert!(CorrelationStore::new(dir.path())
        .resolve_session_first("session")
        .is_none());
}

#[tokio::test]
async fn retention_keeps_old_claims_until_their_source_is_stale_or_missing() {
    use loongsuite_pilot::core::AcpCorrelateRetentionService;
    use loongsuite_pilot::types::UpstreamLinkConfig;
    use std::time::{Duration, SystemTime};
    let dir = tempfile::tempdir().unwrap();
    let correlate = dir.path().join("acp-correlate");
    fs::create_dir(&correlate).unwrap();
    let old = SystemTime::now() - Duration::from_secs(3600);
    let claim_names = [
        format!("session.turn-context-0-{}.done", "a".repeat(64)),
        "session.session-context.done".into(),
        format!("missing.turn-context-1-{}.done", "b".repeat(64)),
    ];
    for name in &claim_names {
        let path = correlate.join(name);
        fs::write(&path, b"{}").unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }
    let source = correlate.join("session.jsonl");
    fs::write(&source, b"{}\n").unwrap();
    let service = AcpCorrelateRetentionService::new(
        dir.path(),
        &UpstreamLinkConfig {
            enabled: true,
            propagate_to_tools: false,
            propagate_to_llm: false,
            generate_trace_when_missing: false,
            ttl_ms: 60_000,
        },
        None,
    );
    assert_eq!(service.run_cleanup().await, (1, 0));
    for name in &claim_names[..2] {
        assert!(correlate.join(name).exists());
    }
    fs::File::options()
        .write(true)
        .open(source)
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert_eq!(service.run_cleanup().await, (3, 0));
    assert_eq!(fs::read_dir(correlate).unwrap().count(), 0);
}

#[derive(Default)]
struct CapturedOutput(std::sync::Mutex<Vec<AgentActivityEntry>>);

#[async_trait::async_trait]
impl loongsuite_pilot::flushers::BaseFlusher for CapturedOutput {
    fn name(&self) -> &str {
        "captured-output"
    }
    async fn send(
        &self,
        entry: AgentActivityEntry,
        _: Option<f64>,
    ) -> Result<(), loongsuite_pilot::flushers::FlushError> {
        self.0.lock().unwrap().push(entry);
        Ok(())
    }
    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), loongsuite_pilot::flushers::FlushError> {
        self.0.lock().unwrap().extend(entries);
        Ok(())
    }
    async fn flush(&self) -> Result<(), loongsuite_pilot::flushers::FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), loongsuite_pilot::flushers::FlushError> {
        Ok(())
    }
}

#[tokio::test]
async fn actual_hermes_host_replays_keep_each_turn_parent_input_usage_and_trace_tree() {
    use loongsuite_pilot::{
        checkpoints::StateStore,
        core::{InputManager, LiveInput},
        flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter},
        inputs::{hermes_log::HermesLogInput, rest_support::SessionInputOptions},
        types::AgentEventName,
    };
    use sha2::{Digest, Sha256};
    use std::{io::Write, sync::Arc};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/hermes-agent/upstream-replay.json")).unwrap();
    assert_eq!(fixture["schema"], 1);
    assert_eq!(
        fixture["producerSha256"],
        format!(
            "{:x}",
            Sha256::digest(include_bytes!(
                "../assets/plugins/hermes-agent/loongsuite-pilot/__init__.py"
            ))
        )
    );
    assert_eq!(
        fixture["sourceSha256"],
        format!(
            "{:x}",
            Sha256::digest(include_bytes!(
                "fixtures/hermes-agent/real-tool-turn-hooks.jsonl"
            ))
        )
    );
    let prompt = fixture["prompt"].as_str().unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        for split in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let sessions = dir.path().join("sessions");
            let correlate = dir.path().join("acp-correlate");
            fs::create_dir(&sessions).unwrap();
            fs::create_dir(&correlate).unwrap();
            fs::write(correlate.join("hermes-native-session.jsonl"), [1,2].map(|index| {
                json!({"type":"turn","contentHash":content_hash(prompt),"contentPrefix":prompt,
                    "traceparent":format!("00-{}-{}-01",index.to_string().repeat(32),index.to_string().repeat(16)),
                }).to_string()
            }).join("\n")+"\n").unwrap();
            let input = HermesLogInput::new(SessionInputOptions {
                state_store: Arc::new(StateStore::new(dir.path().join("state.json"))),
                session_dir: Some(sessions.to_string_lossy().into_owned()),
                file_pattern: None,
                poll_interval_ms: Some(60000),
            });
            let output = Arc::new(CapturedOutput::default());
            let manager = InputManager::new();
            manager.register_input(LiveInput::new(
                "hermes-agent-log",
                "hermes",
                "session-file-polling",
                || true,
                || Box::pin(async { Ok(()) }),
                || Box::pin(async {}),
            ));
            manager.set_flusher(output.clone());
            manager.set_configured_user_id("fixture-user");
            manager.set_trace_linker(Arc::new(TraceLinker::with_retry(
                CorrelationStore::new(correlate),
                0,
                0,
            )));
            let records = case["records"].as_array().unwrap();
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(sessions.join("hermes-agent-replay.jsonl"))
                .unwrap();
            for batch in records.chunks(if split { 1 } else { records.len() }) {
                for record in batch {
                    writeln!(file, "{record}").unwrap();
                }
                manager
                    .accept_entries("hermes-agent-log", input.collect_entries().await.unwrap())
                    .await
                    .unwrap();
            }
            let collected = output.0.lock().unwrap().clone();
            for index in [1, 2] {
                let turn = format!("turn-{index}");
                let entries: Vec<_> = collected
                    .iter()
                    .filter(|entry| entry.turn_id.as_deref() == Some(turn.as_str()))
                    .cloned()
                    .collect();
                assert!(!entries.is_empty(), "{case:?}, split={split}, turn={turn}");
                let trace = index.to_string().repeat(32);
                let parent = index.to_string().repeat(16);
                assert!(
                    entries
                        .iter()
                        .all(|entry| entry.trace_id.as_deref() == Some(trace.as_str())),
                    "{}, split={split}, turn={turn}",
                    case["name"]
                );
                let inputs: Vec<_> = entries
                    .iter()
                    .filter(|entry| {
                        entry.event_name == Some(AgentEventName::Other)
                            && entry.extra.get("agent.hermes.hook") == Some(&json!("turn_start"))
                    })
                    .collect();
                assert_eq!(inputs.len(), 1);
                assert_eq!(inputs[0].parent_span_id.as_deref(), Some(parent.as_str()));
                assert_eq!(
                    inputs[0].extra["agent.pilot.correlation.content_hash"],
                    content_hash(prompt)
                );
                assert_eq!(
                    inputs[0].input_messages_delta.as_ref().unwrap()[0]["parts"][0]["content"],
                    prompt
                );
                assert!(inputs[0].input_tokens.is_none() && inputs[0].output_tokens.is_none());
                assert_eq!(
                    entries
                        .iter()
                        .filter(|entry| entry.event_name == Some(AgentEventName::AgentInput))
                        .count(),
                    1
                );
                assert_eq!(
                    entries
                        .iter()
                        .filter(|entry| entry.turn_start == Some(true))
                        .count(),
                    1
                );
                assert_eq!(
                    entries
                        .iter()
                        .filter(|entry| entry.turn_end == Some(true))
                        .count(),
                    1
                );
                let filtered: Vec<_> = entries
                    .into_iter()
                    .filter(|entry| entry.event_name != Some(AgentEventName::AgentInput))
                    .collect();
                let converted = GenAiEventLogConverter
                    .convert(&filtered, &ConvertOptions::default())
                    .unwrap();
                assert!(converted.warnings.is_empty(), "{:?}", converted.warnings);
                assert_eq!(converted.spans.len(), 7);
                assert!(converted.spans.iter().all(|span| span.trace_id == trace));
                let spans = |kind: &str| {
                    converted
                        .spans
                        .iter()
                        .filter(|span| {
                            span.attributes.get("gen_ai.span.kind") == Some(&json!(kind))
                        })
                        .collect::<Vec<_>>()
                };
                assert_eq!(
                    spans("ENTRY")[0].parent_span_id.as_deref(),
                    Some(parent.as_str())
                );
                let llm = spans("LLM");
                assert_eq!(
                    llm.iter()
                        .map(|span| (
                            span.attributes["gen_ai.usage.input_tokens"]
                                .as_i64()
                                .unwrap(),
                            span.attributes["gen_ai.usage.output_tokens"]
                                .as_i64()
                                .unwrap()
                        ))
                        .collect::<Vec<_>>(),
                    [(1711, 31), (1794, 36)]
                );
                assert_eq!(
                    spans("AGENT")[0].attributes["gen_ai.usage.input_tokens"],
                    3505
                );
                assert_eq!(
                    spans("AGENT")[0].attributes["gen_ai.usage.output_tokens"],
                    67
                );
            }
        }
    }
}
