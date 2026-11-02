use super::*;

#[test]
fn collector_keeps_original_tool_value_kinds_and_legacy_hook_keeps_strings() {
    for input in [
        json!({"path":"synthetic","options":{"enabled":true,"counts":[2,3]}}),
        json!({}),
        json!([]),
        json!([true, 2, null, {}]),
        json!(true),
        json!(42),
        Value::Null,
        json!("{\"a\":1}"),
    ] {
        let rows = vec![
            json!({"type":"user","timestamp":"2026-11-02T00:00:00.000Z","message":{"role":"user","content":"synthetic"}}),
            json!({"type":"assistant","timestamp":"2026-11-02T00:00:00.100Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-0","name":"Read","input":input}],"stop_reason":"tool_use"}}),
        ];
        let attrs = Obj::new();
        let collected = build_collected_transcript_turn(
            &rows,
            CollectedTranscriptTurnContext {
                agent_id: "qoder",
                session_id: "synthetic-session",
                turn_id: "synthetic-turn",
                runtime_user: "synthetic-user",
                cwd: None,
                user_name: None,
                user_email: None,
                agent_name: None,
                span_attributes: &attrs,
                resource_attributes: &attrs,
            },
        );
        let call = collected
            .iter()
            .find(|r| r["event.name"] == "tool.call")
            .unwrap();
        assert_eq!(call["gen_ai.tool.call.arguments"], input);
        let (_, content) = split_progress_content(&rows);
        let boundaries = build_llm_boundaries(&content);
        let legacy = build_events_from_boundaries(
            &boundaries,
            &content,
            &rows,
            "synthetic-turn",
            BoundaryContext {
                agent_id: "qoder",
                session_id: "synthetic-session",
                runtime_user: "synthetic-user",
                identity: None,
                cwd: None,
                stamp: &Stamp {
                    span: Obj::new(),
                    resources: Obj::new(),
                    agent_name: None,
                },
            },
        );
        let legacy_call = legacy
            .iter()
            .find(|r| r.get("event.name") == Some(&json!("tool.call")))
            .unwrap();
        let expected = arguments_string(&Some(input)).unwrap();
        assert_eq!(
            legacy_call["gen_ai.tool.call.arguments"],
            Value::String(expected)
        );
    }
}
