//! Historical normalization contracts against the real Qoder canonical builder.
use super::*;
use serde_json::json;
fn record(row: Value) -> Obj {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("config.json"),
        json!({"userId":"u-qoder",
        "agents":{"qoder-cli":{"captureMessageContent":false}}})
        .to_string(),
    )
    .unwrap();
    let env = Env::from([(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        root.path().to_string_lossy().into_owned(),
    )]);
    let runtime = super::super::common::load_runtime_config(&env);
    build_qoder_hook_record(&row, "qoder", &runtime.user_id, "turn").unwrap()
}
#[test]
fn history_l82_legacy_disabled_content_policy_keeps_typed_result_and_drops_raw_aliases() {
    let row = json!({"type":"user","uuid":"row-policy","timestamp":"2026-05-14T00:00:00.000Z",
        "sessionId":"sess-policy","entrypoint":"cli","message":{"role":"user","content":[{
            "type":"tool_result","tool_use_id":"tool-secret","content":"secret result","is_error":false}]},
        "toolUseResult":{"stdout":"secret stdout"}});
    let out = record(row);
    assert_eq!(
        out["gen_ai.tool.call.result"],
        json!({"stdout":"secret stdout"})
    );
    for key in ["agent.raw", "toolUseResult", "message"] {
        assert!(!out.contains_key(key));
    }
    assert_eq!(out["gen_ai.session.id"], "sess-policy");
}
#[test]
fn history_l113_assistant_qoder_rows_preserve_exact_canonical_fields_without_source_aliases() {
    let out = record(
        json!({"type":"assistant","uuid":"row-1","timestamp":"2026-05-14T00:00:00.000Z",
        "sessionId":"sess-q","entrypoint":"cli","message":{"id":"resp-1","model":"qwen-max",
        "content":[{"type":"text","text":"hello"}]}}),
    );
    let expected = json!({"event.id":"row-1","event.name":"llm.response","user.id":"u-qoder",
        "gen_ai.agent.type":"qoder-cli","gen_ai.provider.name":"qwen","gen_ai.session.id":"sess-q",
        "gen_ai.response.id":"resp-1","agent.qoder.variant":"qoder-cli","agent.qoder.raw_type":"assistant",
        "agent.qoder.content_type":"text","gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"hello"}]}]});
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(out.get(key), Some(value), "{key}");
    }
    for key in [
        "type",
        "uuid",
        "sessionId",
        "message",
        "entrypoint",
        "agent.raw",
        "agent.qoder.sessionId",
        "agent.qoder.entrypoint",
        "agent.qoder_variant",
        "agent.raw_type",
        "agent.content_type",
    ] {
        assert!(!out.contains_key(key), "{key}");
    }
}
#[test]
fn history_l155_both_metadata_row_kinds_do_not_create_a_model_record() {
    for row in [
        json!({"type":"session_meta","uuid":"meta-1","sessionId":"sess-meta","cwd":"/tmp/project"}),
        json!({"type":"progress","uuid":"progress-1","sessionId":"sess-meta"}),
    ] {
        assert!(build_qoder_hook_record(&row, "qoder", "u-qoder", "turn").is_none());
    }
}
#[test]
fn history_l246_user_rows_have_no_model_fields_but_keep_qwen_provider_and_session() {
    let out = record(
        json!({"type":"user","uuid":"user-row-1","timestamp":"2026-06-01T00:00:00.000Z",
        "sessionId":"sess-user","entrypoint":"cli","message":{"role":"user","content":"hello world"}}),
    );
    assert_eq!(out["event.name"], "other");
    assert!(!out.contains_key("gen_ai.request.model"));
    assert!(!out.contains_key("gen_ai.response.model"));
    assert_eq!(out["gen_ai.provider.name"], "qwen");
    assert_eq!(out["gen_ai.session.id"], "sess-user");
}
#[test]
fn history_l268_thinking_and_text_fragments_keep_one_original_message_response_id() {
    for (id, timestamp, content) in [
        (
            "row-think",
            "2026-06-01T00:00:01.000Z",
            json!([{"type":"thinking","thinking":"Let me think..."}]),
        ),
        (
            "row-text",
            "2026-06-01T00:00:02.000Z",
            json!([{"type":"text","text":"The answer is 42."}]),
        ),
    ] {
        let out = record(
            json!({"type":"assistant","uuid":id,"timestamp":timestamp,"sessionId":"sess-multi",
            "entrypoint":"cli","message":{"id":"msg-shared-id","model":"auto","stop_reason":"end_turn","content":content}}),
        );
        assert_eq!(out["gen_ai.response.id"], "msg-shared-id");
        assert_eq!(out["event.name"], "llm.response");
    }
}
