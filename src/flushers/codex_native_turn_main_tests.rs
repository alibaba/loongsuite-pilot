//! f84 Codex converter final-output contracts through actual journal/manager/flusher.
use super::super::{codex_turn_journal_group_key, CodexTurnJournal};
use super::*;
use crate::core::InputManager;
use crate::normalization::build_agent_activity_entry;
use crate::pipeline::workspace_policy::WorkspacePolicy;
use crate::types::{AgentEventName, AgentsConfig, MaskConfig, MaskMode};
use std::collections::HashSet;
use std::path::Path;

struct Capture {
    spans: Mutex<Vec<ReadableSpan>>,
    fail: bool,
}
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        if self.fail {
            Err("synthetic export failure".into())
        } else {
            self.spans.lock().unwrap().extend(spans);
            Ok(())
        }
    }
    async fn shutdown(&self) {}
}
struct Harness {
    f: OtlpTraceFlusher,
    capture: Arc<Capture>,
}
impl Harness {
    fn new(
        root: &Path,
        journal: Option<Arc<CodexTurnJournal>>,
        fail: bool,
        manager: Option<Arc<InputManager>>,
    ) -> Self {
        let config: OtlpTraceFlusherConfig = serde_json::from_value(serde_json::json!({
            "enabled":true,"protocol":"http/protobuf","serviceName":"codex-test","dataDir":root,
            "endpoints":[{"name":"test","endpoint":"http://unused:4318","headers":{}}]
        }))
        .unwrap();
        let capture = Arc::new(Capture {
            spans: Mutex::new(Vec::new()),
            fail,
        });
        let output = capture.clone();
        let factory: ExporterFactory = Arc::new(move |_| output.clone());
        let mut f = OtlpTraceFlusher::with_parts(config, None, Some(factory), None).unwrap();
        if let Some(journal) = journal {
            f = f.with_codex_journal(journal, move |rows| {
                Ok(match &manager {
                    Some(manager) => manager.prepare_restored_entries(rows),
                    None => rows,
                })
            });
        }
        Self { f, capture }
    }
    fn spans(&self) -> Vec<ReadableSpan> {
        self.capture.spans.lock().unwrap().clone()
    }
}
fn records(
    session: &str,
    turn: &str,
    trace: &str,
    offset: i64,
    incoming: Option<&str>,
) -> Vec<AgentActivityEntry> {
    let mut base = serde_json::json!({
        "user.id":"owner","gen_ai.agent.type":"codex","gen_ai.agent.id":session,
        "gen_ai.session.id":session,"gen_ai.turn.id":format!("{session}:{turn}"),
        "agent.codex.transcript_turn_id":turn,"gen_ai.provider.name":"openai","trace_id":trace
    })
    .as_object()
    .unwrap()
    .clone();
    if let Some(incoming) = incoming {
        base.extend(serde_json::json!({
            "gen_ai.agent.scope":"subagent","gen_ai.agent.parent.id":"parent",
            "gen_ai.agent.parent.invocation.id":incoming,"agent.codex.delegated":true,
            "gen_ai.subagent.parent_tool_call.id":"spawn","agent.codex.parent_span_id":"b".repeat(16)
        }).as_object().unwrap().clone());
    }
    let event = |name: &str, tick: i64, extra: Value| {
        let mut row = base.clone();
        row.extend(
            serde_json::json!({"event.id":format!("{session}-{turn}-{tick}-{name}"),
            "event.name":name,"timestamp":1_700_000_000_000_i64+offset+tick})
            .as_object()
            .unwrap()
            .clone(),
        );
        row.extend(extra.as_object().unwrap().clone());
        build_agent_activity_entry(&Value::Object(row))
    };
    let pair = serde_json::json!({
        "gen_ai.step.id":format!("{session}:{turn}:s1"),"gen_ai.response.id":format!("{session}:{turn}:r1"),
        "span_id":if session=="parent"{"c".repeat(16)}else{"d".repeat(16)},
        "parent_span_id":if session=="parent"{"e".repeat(16)}else{"f".repeat(16)}
    });
    let mut request = pair.as_object().unwrap().clone();
    request.insert(
        "gen_ai.request.model".into(),
        serde_json::json!("test-model"),
    );
    let mut response = pair.as_object().unwrap().clone();
    response.extend(serde_json::json!({
        "gen_ai.response.finish_reasons":["stop"],
        "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"done"}]}],
        "gen_ai.usage.input_tokens":11,"gen_ai.usage.output_tokens":7
    }).as_object().unwrap().clone());
    let mut rows = vec![
        event(
            "other",
            0,
            serde_json::json!({"gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"task"}]}]}),
        ),
        event("gen_ai.model.request", 1, Value::Object(request)),
        event("gen_ai.model.response", 2, Value::Object(response)),
    ];
    if incoming.is_none() {
        rows.push(event("gen_ai.agent.invoke",3,serde_json::json!({"gen_ai.agent.invocation.id":"I","gen_ai.agent.peer.id":"child","gen_ai.tool.call.id":"spawn"})));
        for (name, tick) in [("gen_ai.tool.call", 3), ("gen_ai.tool.result", 4)] {
            let mut tool = pair.as_object().unwrap().clone();
            tool.extend(serde_json::json!({"span_id":"b".repeat(16),"gen_ai.tool.name":"spawn_agent","gen_ai.tool.call.id":"spawn","gen_ai.agent.invocation.id":"I"}).as_object().unwrap().clone());
            rows.push(event(name, tick, Value::Object(tool)));
        }
    }
    rows.push(event(
        "other",
        5,
        serde_json::json!({"gen_ai.turn.end":true,"agent.codex.turn_status":"completed"}),
    ));
    rows
}
async fn read(journal: &Arc<CodexTurnJournal>) -> Vec<Vec<AgentActivityEntry>> {
    let mut replay = journal.load(None).await.unwrap();
    let mut all = Vec::new();
    while let Some(group) = replay.next_group().await.unwrap() {
        all.push(group)
    }
    all
}
fn kind<'a>(spans: &'a [ReadableSpan], kind: &str) -> Vec<&'a ReadableSpan> {
    spans
        .iter()
        .filter(|span| {
            span.attributes
                .get("gen_ai.span.kind")
                .and_then(Value::as_str)
                == Some(kind)
        })
        .collect()
}
fn unique(spans: &[ReadableSpan]) {
    assert_eq!(
        spans
            .iter()
            .map(|span| &span.span_id)
            .collect::<HashSet<_>>()
            .len(),
        spans.len()
    );
}
fn journal(root: &Path) -> Arc<CodexTurnJournal> {
    Arc::new(CodexTurnJournal::new(root.join("pending")))
}

#[tokio::test]
async fn main_l54_both_startup_and_rehydrate_apply_current_workspace_exclusion_without_ack() {
    for rehydrate in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let journal = journal(root.path());
        let manager = Arc::new(InputManager::new());
        let h = Harness::new(
            root.path(),
            Some(journal.clone()),
            false,
            Some(manager.clone()),
        );
        let excluded = root.path().join("codex-private");
        let mut source = records("child", "private", &"a".repeat(32), 0, Some("I"));
        for record in &mut source {
            record
                .extra
                .insert("workspace.path".into(), serde_json::json!(excluded));
        }
        if rehydrate {
            h.f.start().await.unwrap();
        }
        journal.append(&source).await.unwrap();
        manager.set_workspace_policy(
            WorkspacePolicy::new(&[excluded.to_string_lossy().into_owned()], None).unwrap(),
        );
        if rehydrate {
            let key = codex_turn_journal_group_key(&source[0]);
            h.f.inner
                .replay_journal(journal.load(Some(&key)).await.unwrap())
                .await
                .unwrap();
        } else {
            h.f.start().await.unwrap();
        }
        assert!(h.spans().is_empty());
        assert!(!journal.is_acknowledged(&source[0]).await.unwrap());
        assert!(read(&journal).await.is_empty());
        h.f.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn main_l74_legacy_opt_out_and_mask_replay_preserve_original_content_identity_and_topology() {
    for masked in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let manager = Arc::new(InputManager::new());
        if masked {
            manager.set_mask_config(MaskConfig {
                mode: MaskMode::All,
                types: Vec::new(),
                replacement_mode: None,
            });
        } else {
            manager.set_agents_config(
                &serde_json::from_value::<AgentsConfig>(
                    serde_json::json!({"codex":{"captureMessageContent":false}}),
                )
                .unwrap(),
            );
        }
        let mut source = records("child", "private", &"a".repeat(32), 0, Some("I"));
        source[2].output_messages = Some(
            serde_json::json!([{"role":"assistant","parts":[{"type":"text","content":"sk-1234567890abcdefghijklmnop"}]}]),
        );
        let journal = journal(root.path());
        journal.append(&source[..2]).await.unwrap();
        let h = Harness::new(
            root.path(),
            Some(journal.clone()),
            false,
            Some(manager.clone()),
        );
        h.f.start().await.unwrap();
        assert!(h.spans().is_empty());
        h.f.send_batch(manager.prepare_restored_entries(source[2..].to_vec()), None)
            .await
            .unwrap();
        let spans = h.spans();
        assert_eq!(spans.len(), 3);
        let attrs = serde_json::to_string(&spans.iter().map(|s| &s.attributes).collect::<Vec<_>>())
            .unwrap();
        if masked {
            assert!(!attrs.contains("sk-1234567890abcdefghijklmnop"));
            assert!(attrs.contains("[APIKEY_MASKED]"));
        } else {
            assert!(attrs.contains("task"));
            assert!(attrs.contains("sk-1234567890abcdefghijklmnop"));
        }
        assert_eq!(kind(&spans, "LLM")[0].span_id, "d".repeat(16));
        assert_eq!(
            kind(&spans, "AGENT")[0].attributes["gen_ai.agent.parent.invocation.id"],
            "I"
        );
        assert!(journal.is_acknowledged(&source[0]).await.unwrap());
        h.f.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn main_l103_graceful_and_unclean_instance_restart_never_export_a_partial_agent() {
    for graceful in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("pending");
        let one = Harness::new(
            root.path(),
            Some(Arc::new(CodexTurnJournal::new(&dir))),
            false,
            None,
        );
        let source = records("child", "c", &"a".repeat(32), 100, Some("I"));
        one.f.send_batch(source[..2].to_vec(), None).await.unwrap();
        one.f.flush().await.unwrap();
        assert!(one.spans().is_empty());
        if graceful {
            one.f.shutdown().await.unwrap();
        }
        let restored = Arc::new(CodexTurnJournal::new(&dir));
        let two = Harness::new(root.path(), Some(restored.clone()), false, None);
        two.f.start().await.unwrap();
        assert!(two.spans().is_empty());
        two.f.send_batch(source[2..].to_vec(), None).await.unwrap();
        let spans = two.spans();
        assert_eq!(spans.len(), 3);
        assert_eq!(kind(&spans, "AGENT").len(), 1);
        assert_eq!(kind(&spans, "LLM")[0].span_id, "d".repeat(16));
        unique(&spans);
        assert!(read(&restored).await.is_empty());
        one.f.shutdown().await.unwrap();
        two.f.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn main_l126_failed_complete_turn_is_durable_until_successful_replay_ack() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let failed = Harness::new(
        root.path(),
        Some(Arc::new(CodexTurnJournal::new(&dir))),
        true,
        None,
    );
    let recovered_journal = Arc::new(CodexTurnJournal::new(&dir));
    let recovered = Harness::new(root.path(), Some(recovered_journal.clone()), false, None);
    failed
        .f
        .send_batch(records("child", "c", &"a".repeat(32), 100, Some("I")), None)
        .await
        .unwrap();
    assert_eq!(read(&recovered_journal).await.len(), 1);
    recovered.f.start().await.unwrap();
    assert_eq!(recovered.spans().len(), 3);
    assert!(read(&recovered_journal).await.is_empty());
    failed.f.shutdown().await.unwrap();
    recovered.f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l140_acknowledged_source_cursor_replay_after_restart_does_not_export_again() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pending");
    let source = records("child", "c", &"a".repeat(32), 100, Some("I"));
    let one = Harness::new(
        root.path(),
        Some(Arc::new(CodexTurnJournal::new(&dir))),
        false,
        None,
    );
    let restored = Arc::new(CodexTurnJournal::new(&dir));
    let two = Harness::new(root.path(), Some(restored.clone()), false, None);
    one.f.send_batch(source.clone(), None).await.unwrap();
    assert_eq!(one.spans().len(), 3);
    one.f.shutdown().await.unwrap();
    two.f.start().await.unwrap();
    two.f.send_batch(source, None).await.unwrap();
    assert!(two.spans().is_empty());
    assert!(read(&restored).await.is_empty());
    one.f.shutdown().await.unwrap();
    two.f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l157_original_sixty_seven_pending_prefixes_evict_memory_then_rehydrate_only_the_completed_turn(
) {
    let root = tempfile::tempdir().unwrap();
    let journal = journal(root.path());
    let h = Harness::new(root.path(), Some(journal), false, None);
    for i in 0..67 {
        h.f.send_batch(
            records(
                "child",
                &format!("c{i}"),
                &"a".repeat(32),
                i * 10,
                Some("I"),
            )[..2]
                .to_vec(),
            None,
        )
        .await
        .unwrap();
    }
    assert!(h.spans().is_empty());
    assert_eq!(h.f.trace_runtime_snapshot()[0].pending_buffers, 64);
    h.f.send_batch(
        records("child", "c0", &"a".repeat(32), 0, Some("I"))[2..].to_vec(),
        None,
    )
    .await
    .unwrap();
    let spans = h.spans();
    assert_eq!(spans.len(), 3);
    assert_eq!(
        kind(&spans, "AGENT")[0].attributes["gen_ai.turn.id"],
        "child:c0"
    );
    h.f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l169_parent_finishes_before_late_child_with_exact_operation_ids_token_ownership_and_span_topology(
) {
    let root = tempfile::tempdir().unwrap();
    let h = Harness::new(root.path(), None, false, None);
    let parent = records("parent", "t", &"a".repeat(32), 0, None);
    let child = records("child", "c", &"a".repeat(32), 100, Some("I"));
    h.f.send_batch(child[..2].to_vec(), None).await.unwrap();
    h.f.send_batch(parent, None).await.unwrap();
    assert_eq!(kind(&h.spans(), "AGENT").len(), 1);
    assert_eq!(h.f.trace_runtime_snapshot()[0].pending_buffers, 1);
    h.f.send_batch(child[2..].to_vec(), None).await.unwrap();
    let spans = h.spans();
    let agents = kind(&spans, "AGENT");
    assert_eq!(agents.len(), 2);
    let child = agents
        .iter()
        .find(|s| s.attributes["gen_ai.session.id"] == "child")
        .unwrap();
    assert_eq!(child.parent_span_id.as_deref(), Some("bbbbbbbbbbbbbbbb"));
    assert_eq!(child.attributes["gen_ai.agent.parent.invocation.id"], "I");
    assert_eq!(child.attributes["gen_ai.turn.id"], "child:c");
    assert!(!agents
        .iter()
        .find(|s| s.attributes["gen_ai.session.id"] == "parent")
        .unwrap()
        .attributes
        .contains_key("gen_ai.agent.invocation.id"));
    let llms = kind(&spans, "LLM");
    assert_eq!(llms.len(), 2);
    assert_eq!(
        llms.iter()
            .map(|s| s.attributes["gen_ai.usage.input_tokens"].as_i64().unwrap())
            .sum::<i64>(),
        22
    );
    assert_eq!(
        llms.iter()
            .find(|s| s.span_id == "d".repeat(16))
            .unwrap()
            .parent_span_id
            .as_deref(),
        Some("ffffffffffffffff")
    );
    assert_eq!(kind(&spans, "ENTRY").len(), 1);
    assert_eq!(kind(&spans, "STEP").len(), 2);
    unique(&spans);
    let tool = spans.iter().find(|s| s.span_id == "b".repeat(16)).unwrap();
    assert_eq!(tool.duration, [0, 1_000_000]);
    assert_eq!(tool.attributes["gen_ai.agent.invocation.id"], "I");
    h.f.shutdown().await.unwrap();
}
#[tokio::test]
async fn main_l199_standard_short_aliases_have_exact_five_spans_and_restart_stable_ids_without_audit_mutation(
) {
    let root = tempfile::tempdir().unwrap();
    let source = records("parent", "t", &"a".repeat(32), 0, None);
    let mut aliases = Vec::new();
    for record in &source {
        aliases.push(record.clone());
        let short = match record.event_name {
            Some(AgentEventName::ModelRequest) => Some(AgentEventName::LlmRequest),
            Some(AgentEventName::ModelResponse) => Some(AgentEventName::LlmResponse),
            Some(AgentEventName::GenAiToolCall) => Some(AgentEventName::ToolCall),
            Some(AgentEventName::GenAiToolResult) => Some(AgentEventName::ToolResult),
            _ => None,
        };
        if let Some(short) = short {
            let mut alias = record.clone();
            alias.event_id += "-alias";
            alias.event_name = Some(short);
            aliases.push(alias);
        }
    }
    let mut outputs = Vec::new();
    for _ in 0..2 {
        let h = Harness::new(root.path(), None, false, None);
        h.f.send_batch(aliases.clone(), None).await.unwrap();
        let spans = h.spans();
        assert_eq!(spans.len(), 5);
        assert_eq!(
            kind(&spans, "LLM")[0].attributes["gen_ai.usage.input_tokens"],
            11
        );
        let mut ids: Vec<_> = spans.into_iter().map(|s| s.span_id).collect();
        ids.sort();
        outputs.push(ids);
        h.f.shutdown().await.unwrap();
    }
    assert_eq!(outputs[0], outputs[1]);
    assert_eq!(source[1].event_name, Some(AgentEventName::ModelRequest));
}
#[tokio::test]
async fn main_l230_unknown_upstream_keeps_independent_entry_and_audit_only_delivery_never_exports()
{
    let root = tempfile::tempdir().unwrap();
    let h = Harness::new(root.path(), None, false, None);
    let mut child = records("child", "c", &"a".repeat(32), 100, Some("I"));
    for record in &mut child {
        record.extra.remove("agent.codex.parent_span_id");
    }
    h.f.send_batch(child, None).await.unwrap();
    let spans = h.spans();
    assert_eq!(kind(&spans, "ENTRY").len(), 1);
    assert_eq!(
        kind(&spans, "AGENT")[0].attributes["gen_ai.agent.parent.invocation.id"],
        "I"
    );
    let count = spans.len();
    h.f.send_batch(vec![build_agent_activity_entry(&serde_json::json!({"event.name":"gen_ai.agent.result","gen_ai.session.id":"parent","gen_ai.turn.id":"delivery-only","gen_ai.agent.type":"codex","gen_ai.agent.invocation.id":"I"}))],None).await.unwrap();
    h.f.flush().await.unwrap();
    assert_eq!(h.spans().len(), count);
    h.f.shutdown().await.unwrap();
}
