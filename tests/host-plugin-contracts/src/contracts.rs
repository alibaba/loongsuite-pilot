use async_trait::async_trait;
use loongsuite_pilot::core::{
    CorrelationStore, InputManager, InterceptResultLinker, LiveInput, TraceLinker,
};
use loongsuite_pilot::flushers::{
    BaseFlusher, JsonlFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter,
};
use loongsuite_pilot::inputs::rest_support::transform_hook_record;
use loongsuite_pilot::interceptor::{
    ToolInterceptPhase, ToolVerdictAction, ToolVerdictKey, ToolVerdictStore,
};
use loongsuite_pilot::types::{
    AgentActivityEntry, ClientType, JsonlFlusherConfig, OtlpTraceFlusherConfig,
};
use loongsuite_pilot::utils::content_hash;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(crate) struct Capture(pub(crate) Mutex<Vec<ReadableSpan>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
pub(crate) fn flusher(root: &std::path::Path) -> (OtlpTraceFlusher, Arc<Capture>) {
    let capture = Arc::new(Capture::default());
    let sink = capture.clone();
    let cfg: OtlpTraceFlusherConfig = serde_json::from_value(json!({
        "enabled":true,"protocol":"http/protobuf","serviceName":"host-contract",
        "endpoints":[{"name":"captured","endpoint":"http://127.0.0.1:1","headers":{}}],
        "dataDir":root
    }))
    .unwrap();
    (
        OtlpTraceFlusher::with_parts(cfg, None, Some(Arc::new(move |_| sink.clone())), None)
            .unwrap(),
        capture,
    )
}
pub(crate) fn kind(s: &ReadableSpan, expected: &str) -> bool {
    s.attributes.get("gen_ai.span.kind") == Some(&json!(expected))
}

#[tokio::test]
async fn history_intercept_jsonl_l24_real_manager_and_file_keep_both_guardrail_verdicts() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("output");
    let store = Arc::new(ToolVerdictStore::new(
        root.path().join("tool-verdicts.json"),
    ));
    for (phase, action) in [
        (ToolInterceptPhase::PreToolUse, ToolVerdictAction::Allow),
        (ToolInterceptPhase::PostToolUse, ToolVerdictAction::Block),
    ] {
        store.put(
            &ToolVerdictKey {
                session_id: Some("native-session".into()),
                tool_use_id: "call-1".into(),
                phase,
            },
            action,
            chrono::Utc::now().timestamp_millis(),
        );
    }
    let manager = InputManager::new();
    let out = Arc::new(JsonlFlusher::new(
        serde_json::from_value::<JsonlFlusherConfig>(json!({
            "enabled":true,"outputDir":output,"rotateDaily":true,"maxFileSizeMb":10
        }))
        .unwrap(),
    ));
    out.start().await.unwrap();
    manager.set_flusher(out.clone());
    manager.set_intercept_result_linker(Arc::new(InterceptResultLinker::new(store, true)));
    manager.register_input(LiveInput::new(
        "qoder-trace",
        "qoder",
        "hook-jsonl",
        || true,
        || Box::pin(async { Ok(()) }),
        || Box::pin(async {}),
    ));
    let entries = [("tool.call", "call"), ("tool.result", "result")]
        .into_iter()
        .map(|(name, id)| {
            serde_json::from_value::<AgentActivityEntry>(json!({
                "event.name":name,"event.id":id,"gen_ai.agent.type":"qoder",
                "gen_ai.session.id":"native-session","gen_ai.tool.call.id":"call-1",
                "gen_ai.tool.name":"Bash","time_unix_nano":"1700000000000000000"
            }))
            .unwrap()
        })
        .collect();
    manager
        .accept_entries("qoder-trace", entries)
        .await
        .unwrap();
    manager.stop_all().await;
    out.shutdown().await.unwrap();
    let paths: Vec<_> = std::fs::read_dir(&output)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    assert_eq!(paths.len(), 1);
    let rows: Vec<Value> = std::fs::read_to_string(&paths[0])
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    for (row, name, action) in [
        (&rows[0], "tool.call", "allow"),
        (&rows[1], "tool.result", "block"),
    ] {
        assert_eq!(row["event.name"], name);
        assert_eq!(row["gen_ai.guardrail.triggered"], true);
        assert_eq!(row["gen_ai.guardrail.action"], action);
    }
}

fn delegated_turn(agent: &str, id: &str, offset: u64, child: bool) -> Vec<Value> {
    let mut base = json!({"trace_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "gen_ai.agent.type":agent,"gen_ai.session.id":id,"gen_ai.turn.id":id,
        "gen_ai.step.id":format!("{id}:step"),"user.id":"initiator",
        "gen_ai.provider.name":"openai","gen_ai.request.model":"test-model"});
    if child {
        for (key, value) in json!({"parent_span_id":"bbbbbbbbbbbbbbbb",
        "gen_ai.agent.scope":"subagent","gen_ai.agent.parent.id":"parent",
        "gen_ai.subagent.parent_tool_call.id":"spawn"})
        .as_object()
        .unwrap()
        {
            base[key] = value.clone();
        }
    }
    let event = |name: &str, tick: u64, fields: Value| {
        let mut r = base.clone();
        r["event.name"] = json!(name);
        r["event.id"] = json!(format!("{id}-{tick}"));
        r["time_unix_nano"] =
            json!((1_700_000_000_000_000_000u64 + (offset + tick) * 1_000_000).to_string());
        for (key, value) in fields.as_object().unwrap() {
            r[key] = value.clone();
        }
        r
    };
    let messages = json!([{"role":"user","parts":[{"type":"text","content":"task"}]}]);
    let mut rows = vec![
        event(
            "other",
            0,
            json!({"gen_ai.input.messages_delta":messages,"gen_ai.input.messages":messages}),
        ),
        event(
            "llm.request",
            1,
            json!({"gen_ai.response.id":format!("{id}-llm"),"gen_ai.input.messages_delta":messages}),
        ),
        event(
            "llm.response",
            2,
            json!({"gen_ai.response.id":format!("{id}-llm"),
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"done"}]}],
            "gen_ai.usage.input_tokens":11,"gen_ai.usage.output_tokens":7,
            "gen_ai.response.finish_reasons":[if child {"stop"} else {"tool_calls"}]}),
        ),
    ];
    if !child {
        let name = if agent == "hermes" {
            "delegate_task"
        } else {
            "sessions_spawn"
        };
        rows.push(event(
            "tool.call",
            3,
            json!({"span_id":"bbbbbbbbbbbbbbbb","gen_ai.tool.call.id":"spawn",
            "gen_ai.tool.name":name,"gen_ai.tool.call.arguments":{"task":"child"}}),
        ));
        rows.push(event(
            "tool.result",
            4,
            json!({"span_id":"bbbbbbbbbbbbbbbb","gen_ai.tool.call.id":"spawn",
            "gen_ai.tool.name":name,"gen_ai.tool.call.result":{"accepted":true}}),
        ));
    }
    rows.push(event(
        "other",
        5,
        json!({"gen_ai.turn.end":true,"agent.openclaw.hook":"llm_output"}),
    ));
    rows
}
#[tokio::test]
async fn history_delegated_l52_both_agents_four_correlation_variants_keep_late_children_and_reserved_tool(
) {
    for agent in ["hermes", "openclaw"] {
        for with_correlation in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let upstream = format!("00-{}-{}-01", "c".repeat(32), "d".repeat(16));
            if with_correlation {
                for id in ["child-a", "child-b"] {
                    std::fs::write(
                        root.path().join(format!("{id}.jsonl")),
                        json!({"type":"turn",
                "contentHash":content_hash("task"),"traceparent":upstream})
                        .to_string()
                            + "\n",
                    )
                    .unwrap();
                }
            }
            let linker = TraceLinker::with_retry(CorrelationStore::new(root.path()), 0, 0);
            let (out, capture) = flusher(root.path());
            for (id, offset, child, without_other) in [
                ("parent", 0, false, false),
                ("child-a", 100, true, false),
                ("child-b", 200, true, true),
            ] {
                let mut entries = Vec::new();
                for raw in delegated_turn(agent, id, offset, child) {
                    if without_other && raw["event.name"] == "other" {
                        continue;
                    }
                    let client = if agent == "hermes" {
                        ClientType::Hermes
                    } else {
                        ClientType::OpenClaw
                    };
                    let entry = transform_hook_record(raw.as_object().unwrap(), client, agent)
                        .await
                        .unwrap()
                        .unwrap();
                    let mut batch = vec![entry];
                    linker.stamp(&mut batch).await;
                    entries.extend(batch);
                }
                out.send_batch(entries, None).await.unwrap();
                out.flush().await.unwrap();
                assert!(!capture.0.lock().unwrap().is_empty());
            }
            let spans = capture.0.lock().unwrap().clone();
            assert_eq!(
                spans
                    .iter()
                    .map(|s| &s.span_id)
                    .collect::<HashSet<_>>()
                    .len(),
                spans.len()
            );
            assert!(spans.iter().all(|s| s.trace_id == "a".repeat(32)));
            assert_eq!(spans.iter().filter(|s| kind(s, "ENTRY")).count(), 1);
            let children: Vec<_> = spans
                .iter()
                .filter(|s| {
                    kind(s, "AGENT")
                        && s.attributes.get("gen_ai.agent.scope") == Some(&json!("subagent"))
                })
                .collect();
            assert_eq!(children.len(), 2);
            assert!(children
                .iter()
                .all(|s| s.parent_span_id.as_deref() == Some("bbbbbbbbbbbbbbbb")));
            assert_eq!(
                children
                    .iter()
                    .map(|s| s.attributes["gen_ai.session.id"].as_str().unwrap())
                    .collect::<HashSet<_>>(),
                HashSet::from(["child-a", "child-b"])
            );
            assert!(spans
                .iter()
                .all(|s| s.attributes.get("gen_ai.user.id") == Some(&json!("initiator"))));
            let llms: Vec<_> = spans.iter().filter(|s| kind(s, "LLM")).collect();
            assert_eq!(llms.len(), 3);
            assert_eq!(
                llms.iter()
                    .map(|s| s.attributes["gen_ai.usage.input_tokens"].as_u64().unwrap())
                    .sum::<u64>(),
                33
            );
            let tool = spans
                .iter()
                .find(|s| s.span_id == "bbbbbbbbbbbbbbbb")
                .unwrap();
            assert_eq!(tool.end_time[1] - tool.start_time[1], 1_000_000);
            if with_correlation {
                assert_eq!(
                    CorrelationStore::new(root.path()).resolve_turn_with_identity(
                        "child-a",
                        "task",
                        Some("independent"),
                        None
                    ),
                    Some(upstream)
                );
            }
            out.shutdown().await.unwrap();
        }
    }
}

#[tokio::test]
async fn user_alias_preserves_explicit_identity_empty_values_and_independent_child_context() {
    use loongsuite_pilot::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
    for (canonical, explicit, expected) in [
        ("", None, None),
        ("canonical", None, Some("canonical")),
        ("canonical", Some("explicit"), Some("explicit")),
    ] {
        let mut rows: Vec<AgentActivityEntry> = delegated_turn("hermes", "alias", 0, false)
            .into_iter()
            .map(|mut v| {
                v["user.id"] = json!(canonical);
                serde_json::from_value(v).unwrap()
            })
            .collect();
        // Explicit identity only at the first event must survive later canonical
        // events, including the finishing member of each LLM/tool pair.
        if let Some(explicit) = explicit {
            for row in &mut rows {
                if row.event_id.ends_with("-0")
                    || row.event_id.ends_with("-1")
                    || row.event_id.ends_with("-3")
                {
                    row.extra.insert("gen_ai.user.id".into(), json!(explicit));
                }
            }
        }
        let result = GenAiEventLogConverter
            .convert(
                &rows,
                &ConvertOptions {
                    strict: false,
                    passthrough_keys: vec![],
                },
            )
            .unwrap();
        for span in result.spans {
            assert_eq!(
                span.attributes
                    .get("gen_ai.user.id")
                    .and_then(Value::as_str),
                expected,
                "{}",
                span.name
            );
        }
    }
    let root = tempfile::tempdir().unwrap();
    let (out, capture) = flusher(root.path());
    for (id, child, user) in [
        ("parent", false, "parent-user"),
        ("child-a", true, "child-user"),
    ] {
        let mut rows = vec![];
        for mut raw in delegated_turn("hermes", id, 0, child) {
            raw["user.id"] = json!(user);
            rows.push(
                transform_hook_record(raw.as_object().unwrap(), ClientType::Hermes, "hermes")
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        out.send_batch(rows, None).await.unwrap();
        out.flush().await.unwrap();
    }
    let spans = capture.0.lock().unwrap().clone();
    let child: Vec<_> = spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.session.id") == Some(&json!("child-a")))
        .collect();
    assert!(!child.is_empty());
    assert!(child
        .iter()
        .all(|s| s.attributes.get("gen_ai.user.id") == Some(&json!("child-user"))));
    assert!(spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.session.id") == Some(&json!("parent")))
        .all(|s| s.attributes.get("gen_ai.user.id") == Some(&json!("parent-user"))));
    out.shutdown().await.unwrap();
}

#[tokio::test]
async fn agent_name_fallback_is_group_scoped_and_does_not_overwrite_explicit_leaf_identity() {
    use loongsuite_pilot::flushers::{ConvertOptions, EventLogConverter, GenAiEventLogConverter};
    for (explicit, expected) in [(false, "qwen-code-cli"), (true, "explicit-worker")] {
        let mut rows: Vec<AgentActivityEntry> = delegated_turn("qwen-code-cli", "name", 0, false)
            .into_iter()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect();
        assert!(rows.iter().all(|r| r.agent_name.is_none()));
        if explicit {
            rows[0].agent_name = Some("explicit-worker".into());
        }
        let spans = GenAiEventLogConverter
            .convert(&rows, &ConvertOptions::default())
            .unwrap()
            .spans;
        assert!(!spans.is_empty());
        assert!(spans
            .iter()
            .all(|s| s.attributes.get("gen_ai.agent.name") == Some(&json!(expected))));
    }
    let mut records = vec![];
    for (id, child, user, name) in [
        ("parent", false, "parent-user", "parent-name"),
        ("child-a", true, "child-user", "child-name"),
    ] {
        let mut rows: Vec<AgentActivityEntry> = delegated_turn("hermes", id, 0, child)
            .into_iter()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect();
        for row in &mut rows {
            row.user_id = user.into();
            row.agent_name = Some(name.into());
        }
        records.extend(rows);
    }
    let result = GenAiEventLogConverter
        .convert(&records, &ConvertOptions::default())
        .unwrap();
    for session in ["parent", "child-a"] {
        let own: Vec<_> = result
            .spans
            .iter()
            .filter(|s| s.attributes.get("gen_ai.session.id") == Some(&json!(session)))
            .collect();
        assert!(!own.is_empty());
        let expected = if session == "parent" {
            "parent-name"
        } else {
            "child-name"
        };
        assert!(own
            .iter()
            .all(|s| s.attributes.get("gen_ai.agent.name") == Some(&json!(expected))));
    }
    let mut rows: Vec<AgentActivityEntry> = delegated_turn("qwen-code-cli", "leaf", 0, false)
        .into_iter()
        .map(|v| serde_json::from_value(v).unwrap())
        .collect();
    rows[0].agent_name = Some("container-name".into());
    for r in &mut rows {
        if matches!(
            r.event_name,
            Some(
                loongsuite_pilot::types::AgentEventName::ToolCall
                    | loongsuite_pilot::types::AgentEventName::ToolResult
            )
        ) {
            r.agent_name = Some("explicit-tool-worker".into());
        }
    }
    let result = GenAiEventLogConverter
        .convert(&rows, &ConvertOptions::default())
        .unwrap();
    assert!(result
        .spans
        .iter()
        .filter(|s| kind(s, "TOOL"))
        .all(|s| s.attributes.get("gen_ai.agent.name") == Some(&json!("explicit-tool-worker"))));
}
