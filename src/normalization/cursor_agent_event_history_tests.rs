//! Real Cursor record builders/finalizer, not a parallel test-only normalizer.
use super::*;
fn event(payload: Value) -> Value {
    Value::Object(super::super::to_internal_event(
        payload.as_object().unwrap(),
    ))
}
fn base(session: &str, turn: &str) -> Obj {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("config.json"),
        json!({"userId":"u-default",
        "agents":{"cursor":{"captureMessageContent":false}}})
        .to_string(),
    )
    .unwrap();
    let env = Env::from([(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        root.path().to_string_lossy().into_owned(),
    )]);
    let runtime = super::super::super::common::load_runtime_config(&env);
    base_fields(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        session,
        turn,
        "cursor",
        &runtime.user_id,
        None,
        false,
    )
}
#[test]
fn history_l10_both_legacy_false_forms_keep_the_full_record_in_native_finalization() {
    for capture in [json!(false), json!("false")] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("config.json"),
            json!({"userId":"u-default",
            "agents":{"cursor":{"captureMessageContent":capture}}})
            .to_string(),
        )
        .unwrap();
        let env = Env::from([(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        )]);
        let runtime = super::super::super::common::load_runtime_config(&env);
        assert_eq!(runtime.user_id, "u-default");
        let original = json!({"gen_ai.agent.type":"cursor","gen_ai.tool.call.arguments":{"command":"upgrade-content-sentinel"}});
        let out = finish_record(&Obj::new(), original.as_object().unwrap().clone());
        assert_eq!(Value::Object(out.clone()), original);
        assert!(serde_json::to_string(&out)
            .unwrap()
            .contains("upgrade-content-sentinel"));
    }
}
#[test]
fn history_l21_current_producer_tool_fields_preserve_content_with_explicit_legacy_provider_gap() {
    let input = event(
        json!({"hook_event_name":"preToolUse","session_id":"sess-1","generation_id":"turn-1",
        "model":"gpt-5.5","tool_name":"Shell","tool_use_id":"tool-1","tool_input":"{\"command\":\"pwd\"}"}),
    );
    let out = build_tool_call(&input, &base("sess-1", "turn-1"), "step");
    let expected = json!({"event.name":"tool.call","user.id":"u-default","gen_ai.agent.type":"cursor",
        "gen_ai.session.id":"sess-1","gen_ai.turn.id":"turn-1",
        "gen_ai.tool.name":"Shell","gen_ai.tool.call.id":"tool-1","gen_ai.tool.call.arguments":{"command":"pwd"}});
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(out.get(key), Some(value), "{key}");
    }
    // The original unused helper expects openai here. Current Node and Native
    // real producers both omit it; canonical coverage remains partial.
    assert!(!out.contains_key("gen_ai.provider.name"));
    assert!(!out["event.id"].as_str().unwrap().is_empty());
    assert!(out["time_unix_nano"]
        .as_str()
        .unwrap()
        .bytes()
        .all(|byte| byte.is_ascii_digit()));
    for key in [
        "hook_event_name",
        "session_id",
        "generation_id",
        "tool_name",
        "tool_use_id",
        "tool_input",
        "agent.raw",
    ] {
        assert!(!out.contains_key(key), "{key}");
    }
    assert_eq!(out["agent.cursor.hook_event_name"], "preToolUse");
}
#[test]
fn history_l58_tool_result_retains_typed_secret_content_before_history_write() {
    let input = event(
        json!({"hook_event_name":"postToolUse","session_id":"sess-2","tool_name":"Shell",
        "tool_use_id":"tool-2","tool_output":"{\"secret\":\"value\"}"}),
    );
    let out = build_tool_result(&input, &base("sess-2", "turn-2"), "step");
    assert_eq!(out["gen_ai.tool.call.result"], json!({"secret":"value"}));
    for key in ["agent.raw", "tool_output", "tool_input", "text", "prompt"] {
        assert!(!out.contains_key(key));
    }
    assert_eq!(out["gen_ai.session.id"], "sess-2");
}
#[test]
fn history_l174_current_producer_omits_legacy_stop_projection_without_duplicate_usage() {
    let journal = |hook: &str, second: u32, extra: Value| {
        let mut payload = extra.as_object().unwrap().clone();
        payload.insert("hook_event_name".into(), json!(hook));
        payload.insert("session_id".into(), json!("sess-1"));
        payload.insert("generation_id".into(), json!("turn-1"));
        payload.insert("model".into(), json!("gpt-5.5"));
        let mut row = event(Value::Object(payload));
        row["_journal_ts"] = json!(format!("2026-05-14T00:00:{second:02}.000Z"));
        row
    };
    let events = [
        journal("beforeSubmitPrompt", 0, json!({"prompt":"prompt"})),
        journal(
            "preToolUse",
            1,
            json!({"tool_name":"Shell","tool_use_id":"tool-1","tool_input":r#"{"command":"pwd"}"#}),
        ),
        journal(
            "postToolUse",
            2,
            json!({"tool_name":"Shell","tool_use_id":"tool-1","tool_output":r#"{"secret":"value"}"#}),
        ),
        journal(
            "afterAgentResponse",
            3,
            json!({"text":"hello","input_tokens":15809,"output_tokens":141,
            "cache_read_tokens":7424,"total_tokens":15950}),
        ),
        journal(
            "stop",
            4,
            json!({"input_tokens":15809,"output_tokens":141,"cache_read_tokens":7424,
            "cache_write_tokens":0,"total_tokens":15950,"cost_input":0.01,"cost_output":0.005,
            "cost_cache_read":0.002,"cost_cache_write":0,"cost_total":0.017,"status":"completed","loop_count":0}),
        ),
    ];
    let (rows, _) = assemble_parent_turn(
        &events,
        TurnOptions {
            user_id: "u-default",
            variant: "cursor",
            stop_conversation_id: "sess-1",
            transcript_path: None,
            windows: false,
        },
    );
    assert!(!rows
        .iter()
        .any(|row| row.get("agent.cursor.hook_event_name") == Some(&json!("stop"))));
    let responses: Vec<_> = rows
        .iter()
        .filter(|row| row.get("event.name") == Some(&json!("llm.response")))
        .collect();
    assert_eq!(responses.len(), 2);
    for (key, total) in [
        ("gen_ai.usage.input_tokens", 15809.0),
        ("gen_ai.usage.output_tokens", 141.0),
        ("gen_ai.usage.cache_read.input_tokens", 7424.0),
        ("gen_ai.usage.total_tokens", 15950.0),
    ] {
        assert_eq!(
            responses
                .iter()
                .map(|row| row.get(key).and_then(Value::as_f64).unwrap_or(0.0))
                .sum::<f64>(),
            total,
            "{key}"
        );
    }
    for row in rows
        .iter()
        .filter(|row| row.get("event.name") != Some(&json!("llm.response")))
    {
        assert!(!row.keys().any(|key| key.starts_with("gen_ai.usage.")));
    }
    // This is the actual existing producer contract. The original helper's
    // standalone Other/status/loop_count projection is NOT counted complete.
}

#[test]
fn history_l216_after_agent_response_preserves_original_usage_exactly() {
    let input = event(
        json!({"hook_event_name":"afterAgentResponse","session_id":"sess-resp","generation_id":"turn-resp",
        "model":"gpt-5.5","input_tokens":15809,"output_tokens":141,"cache_read_tokens":7424,"total_tokens":15950,"text":"hello"}),
    );
    let out = build_llm_response(
        &input,
        &base("sess-resp", "turn-resp"),
        "gpt-5.5",
        "step",
        "text",
        true,
    );
    assert_eq!(out["gen_ai.usage.input_tokens"], 15809);
    assert_eq!(out["gen_ai.usage.output_tokens"], 141);
    assert_eq!(out["gen_ai.usage.cache_read.input_tokens"], 7424);
    assert_eq!(out["gen_ai.usage.total_tokens"], 15950);
    assert_eq!(out["event.name"], "llm.response");
    assert_eq!(out["agent.cursor.hook_event_name"], "afterAgentResponse");
}
#[test]
fn history_l240_provider_fallback_matches_collector_for_the_original_three_models() {
    for (model, provider) in [
        ("claude-sonnet", "anthropic"),
        ("gpt-5.5", "openai"),
        ("qwen-max", "qwen"),
    ] {
        let fields = json!({"gen_ai.request.model":model})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(crate::normalization::infer_provider_name(&fields), provider);
    }
}

#[tokio::test]
async fn history_l21_real_cursor_input_final_provider_still_documents_unresolved_projection() {
    use crate::checkpoints::StateStore;
    use crate::inputs::cursor_hook::CursorHookInput;
    use crate::inputs::rest_support::HookInputOptions;
    use std::sync::Arc;
    let root = tempfile::tempdir().unwrap();
    let input = CursorHookInput::new(HookInputOptions {
        state_store: Arc::new(StateStore::new(root.path().join("state.json"))),
        log_dir: Some(root.path().to_string_lossy().into_owned()),
        log_prefix: Some("cursor".into()),
        poll_interval_ms: Some(60_000),
    });
    assert!(input.collect_entries().await.unwrap().is_empty());
    let payload = event(json!({"hook_event_name":"preToolUse","session_id":"sess-1",
        "generation_id":"turn-1","model":"gpt-5.5","tool_name":"Shell",
        "tool_use_id":"tool-1","tool_input":r#"{"command":"pwd"}"#}));
    let raw = build_tool_call(&payload, &base("sess-1", "turn-1"), "step");
    let name = format!("cursor-{}.jsonl", crate::utils::get_today_date_string());
    std::fs::write(
        root.path().join(name),
        Value::Object(raw).to_string() + "\n",
    )
    .unwrap();
    let rows = input.collect_entries().await.unwrap();
    assert_eq!(rows.len(), 1);
    let final_row = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(final_row["event.name"], "tool.call");
    assert_eq!(final_row["gen_ai.agent.type"], "cursor");
    assert_eq!(final_row["gen_ai.session.id"], "sess-1");
    assert_eq!(final_row["gen_ai.turn.id"], "turn-1");
    assert_eq!(final_row["gen_ai.tool.name"], "Shell");
    assert_eq!(final_row["gen_ai.tool.call.id"], "tool-1");
    assert_eq!(
        final_row["gen_ai.tool.call.arguments"],
        json!({"command":"pwd"})
    );
    assert_eq!(final_row["gen_ai.request.model"], "unknown");
    assert_eq!(final_row["gen_ai.provider.name"], "unknown");
    // Exact historical factory expectation is openai; this is explicitly a
    // counterexample through the real public Input, not complete coverage.
}
