use super::*;
use serde_json::json;
#[test]
fn provider_l6_fourteen_original_models_map_to_exact_providers() {
    for (model, provider) in [
        ("qwen3.6-plus", "qwen"),
        ("qwen3-coder-plus", "qwen"),
        ("qwen-max-2025-01-25", "qwen"),
        ("tongyi-qwen-plus", "qwen"),
        ("claude-3-5-sonnet-20241022", "anthropic"),
        ("claude-opus-4-7", "anthropic"),
        ("gpt-4o", "openai"),
        ("gpt-4-turbo", "openai"),
        ("o1-preview", "openai"),
        ("o3-mini", "openai"),
        ("codex-mini", "openai"),
        ("gemini-1.5-pro", "gcp.gemini"),
        ("deepseek-r1", "deepseek"),
        ("grok-2-latest", "x_ai"),
    ] {
        assert_eq!(infer_provider(model, None), provider, "{model}");
    }
}
#[test]
fn provider_l25_model_inference_is_case_insensitive() {
    assert_eq!(infer_provider("QWEN-MAX", None), "qwen");
    assert_eq!(infer_provider("Claude-Sonnet", None), "anthropic");
}
#[test]
fn provider_l32_empty_or_missing_model_uses_openai_auth() {
    for model in [Some(""), None] {
        assert_eq!(
            infer_provider(model.unwrap_or_default(), Some("openai")),
            "openai"
        );
    }
}
#[test]
fn provider_l37_empty_model_uses_anthropic_auth() {
    assert_eq!(infer_provider("", Some("anthropic")), "anthropic");
}
#[test]
fn provider_l41_empty_model_uses_qwen_auth() {
    assert_eq!(infer_provider("", Some("qwen")), "qwen");
}
#[test]
fn provider_l49_qwen_model_takes_precedence_over_openai_auth() {
    assert_eq!(infer_provider("qwen3.6-plus", Some("openai")), "qwen");
}
#[test]
fn provider_l53_claude_model_takes_precedence_over_openai_auth() {
    assert_eq!(
        infer_provider("claude-3-5-sonnet", Some("openai")),
        "anthropic"
    );
}
#[test]
fn provider_l59_missing_or_empty_model_and_auth_default_to_qwen() {
    assert_eq!(infer_provider("", None), "qwen");
    assert_eq!(infer_provider("", Some("")), "qwen");
}
#[test]
fn provider_l64_unknown_model_and_auth_default_to_qwen() {
    assert_eq!(infer_provider("weird-model-xyz", Some("some-auth")), "qwen");
}
#[test]
fn message_l11_text_part_preserves_text() {
    assert_eq!(
        convert_qwen_part(&json!({"text":"hello"}), None),
        Some(json!({"type":"text","content":"hello"}))
    );
}
#[test]
fn message_l15_thought_tagged_text_is_reasoning() {
    assert_eq!(
        convert_qwen_part(&json!({"text":"thinking...","thought":true}), None),
        Some(json!({"type":"reasoning","content":"thinking..."}))
    );
}
#[test]
fn message_l22_false_thought_flag_keeps_text() {
    assert_eq!(
        convert_qwen_part(&json!({"text":"hi","thought":false}), None),
        Some(json!({"type":"text","content":"hi"}))
    );
}
#[test]
fn message_l29_function_call_preserves_id_name_and_typed_arguments() {
    assert_eq!(
        convert_qwen_part(
            &json!({"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"call_123"}}),
            None
        ),
        Some(json!({"type":"tool_call","id":"call_123","name":"Bash","arguments":{"cmd":"ls"}}))
    );
}
#[test]
fn message_l39_function_call_without_id_keeps_explicit_null() {
    assert_eq!(
        convert_qwen_part(&json!({"functionCall":{"name":"Bash","args":{}}}), None),
        Some(json!({"type":"tool_call","id":null,"name":"Bash","arguments":{}}))
    );
}
#[test]
fn message_l49_function_response_preserves_supplied_id_and_typed_body() {
    assert_eq!(
        convert_qwen_part(
            &json!({"functionResponse":{"name":"Bash","response":{"stdout":"ok"}}}),
            Some("call_456")
        ),
        Some(json!({"type":"tool_call_response","id":"call_456","response":{"stdout":"ok"}}))
    );
}
#[test]
fn message_l58_function_response_without_id_keeps_explicit_null() {
    assert_eq!(
        convert_qwen_part(
            &json!({"functionResponse":{"name":"Bash","response":"ok"}}),
            None
        ),
        Some(json!({"type":"tool_call_response","id":null,"response":"ok"}))
    );
}
#[test]
fn message_l67_empty_null_and_unknown_parts_are_not_messages() {
    for part in [json!({}), Value::Null, json!({"unknownField":"x"})] {
        assert!(convert_qwen_part(&part, None).is_none());
    }
}
#[test]
fn message_l75_reasoning_text_and_tool_call_preserve_source_order() {
    let parts = json!([{"text":"I should call ls.","thought":true},{"text":"Sure, here it is."},{"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"c1"}}]);
    assert_eq!(convert_qwen_parts(parts.as_array(),None),json!([{"type":"reasoning","content":"I should call ls."},{"type":"text","content":"Sure, here it is."},{"type":"tool_call","id":"c1","name":"Bash","arguments":{"cmd":"ls"}}]).as_array().unwrap().clone());
}
#[test]
fn message_l89_unknown_parts_are_dropped_without_reordering_text() {
    let parts = json!([{"text":"a"},{"weird":1},{"text":"b"}]);
    assert_eq!(
        convert_qwen_parts(parts.as_array(), None),
        json!([{"type":"text","content":"a"},{"type":"text","content":"b"}])
            .as_array()
            .unwrap()
            .clone()
    );
}
#[test]
fn message_l97_empty_null_and_non_array_parts_produce_empty_list() {
    for parts in [json!([]), Value::Null, json!("not-array")] {
        assert!(convert_qwen_parts(parts.as_array(), None).is_empty());
    }
}
#[test]
fn message_l103_all_three_function_calls_are_kept_in_original_order() {
    let parts = json!([{"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"c1"}},{"functionCall":{"name":"Bash","args":{"cmd":"pwd"},"id":"c2"}},{"functionCall":{"name":"Read","args":{"path":"/tmp"},"id":"c3"}}]);
    let result = convert_qwen_parts(parts.as_array(), None);
    assert_eq!(result.len(), 3);
    assert_eq!(
        result
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Bash", "Bash", "Read"]
    );
}
#[test]
fn message_l116_multi_part_assistant_stays_one_output_message_with_tool_call_finish() {
    let rows = build_output_messages(
        &json!({"type":"assistant","message":{"role":"model","parts":[{"text":"Let me think...","thought":true},{"text":"Here you go."},{"functionCall":{"name":"Bash","args":{"cmd":"ls"},"id":"c1"}}]}}),
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["role"], "assistant");
    assert_eq!(rows[0]["parts"].as_array().unwrap().len(), 3);
    assert_eq!(rows[0]["finish_reason"], "tool_call");
}
#[test]
fn message_l135_plain_text_assistant_finishes_with_stop() {
    assert_eq!(
        build_output_messages(
            &json!({"type":"assistant","message":{"role":"model","parts":[{"text":"final answer"}]}})
        )[0]["finish_reason"],
        "stop"
    );
}
#[test]
fn message_l143_empty_assistant_parts_are_empty_with_stop() {
    let output = build_output_messages(&json!({"type":"assistant","message":{"parts":[]}}));
    assert_eq!(output[0]["parts"], json!([]));
    assert_eq!(output[0]["finish_reason"], "stop");
}
#[test]
fn message_l151_function_call_finishes_with_singular_tool_call() {
    assert_eq!(
        infer_assistant_finish_reason(
            &json!({"message":{"parts":[{"text":"x"},{"functionCall":{"name":"F"}}]}})
        ),
        "tool_call"
    );
}
#[test]
fn message_l156_assistant_without_function_call_finishes_stop() {
    assert_eq!(
        infer_assistant_finish_reason(&json!({"message":{"parts":[{"text":"x"}]}})),
        "stop"
    );
}
#[test]
fn message_l160_missing_parts_or_message_finishes_stop() {
    for row in [json!({}), json!({"message":{}})] {
        assert_eq!(infer_assistant_finish_reason(&row), "stop");
    }
}
#[test]
fn message_l167_user_input_delta_has_user_role_and_exact_text() {
    let rows =
        [json!({"uuid":"u1","type":"user","message":{"role":"user","parts":[{"text":"hello"}]}})];
    assert_eq!(
        build_input_messages_delta(&rows, &HashMap::new()),
        json!([{"role":"user","parts":[{"type":"text","content":"hello"}]}])
            .as_array()
            .unwrap()
            .clone()
    );
}
#[test]
fn message_l179_assistant_input_delta_keeps_typed_tool_call() {
    let rows = [
        json!({"uuid":"a1","type":"assistant","message":{"role":"model","parts":[{"functionCall":{"id":"call_abc","name":"Bash","args":{"cmd":"ls"}}}]}}),
    ];
    assert_eq!(build_input_messages_delta(&rows,&HashMap::new()),json!([{"role":"assistant","parts":[{"type":"tool_call","id":"call_abc","name":"Bash","arguments":{"cmd":"ls"}}]}]).as_array().unwrap().clone());
}
#[test]
fn message_l197_tool_result_input_delta_uses_original_call_id_and_typed_response() {
    let rows = [
        json!({"uuid":"tr1","type":"tool_result","message":{"role":"user","parts":[{"functionResponse":{"name":"Bash","response":{"stdout":"ok"}}}]},"toolCallResult":{"callId":"call_abc"}}),
    ];
    assert_eq!(build_input_messages_delta(&rows,&HashMap::new()),json!([{"role":"tool","parts":[{"type":"tool_call_response","id":"call_abc","response":{"stdout":"ok"}}]}]).as_array().unwrap().clone());
}
#[test]
fn message_l213_explicit_response_uuid_map_overrides_wrong_embedded_tool_id() {
    let rows = [
        json!({"uuid":"tr1","type":"tool_result","message":{"parts":[{"functionResponse":{"name":"B","response":"x"}}]},"toolCallResult":{"callId":"wrong"}}),
    ];
    let map = HashMap::from([("tr1".into(), "correct_call_id".into())]);
    assert_eq!(
        build_input_messages_delta(&rows, &map)[0]["parts"][0]["id"],
        "correct_call_id"
    );
}
#[test]
fn message_l226_mixed_user_tool_and_mid_turn_user_preserve_role_order() {
    let rows = [
        json!({"uuid":"u1","type":"user","message":{"parts":[{"text":"q1"}]}}),
        json!({"uuid":"tr1","type":"tool_result","message":{"parts":[{"functionResponse":{"response":"r1"}}]},"toolCallResult":{"callId":"c1"}}),
        json!({"uuid":"u2","type":"user","subtype":"mid_turn_user_message","message":{"parts":[{"text":"q2"}]}}),
    ];
    let messages = build_input_messages_delta(&rows, &HashMap::new());
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["user", "tool", "user"]
    );
}
#[test]
fn message_l243_records_with_empty_or_missing_parts_are_skipped() {
    let rows = [
        json!({"uuid":"x","type":"user","message":{"parts":[]}}),
        json!({"uuid":"y","type":"user","message":{}}),
    ];
    assert!(build_input_messages_delta(&rows, &HashMap::new()).is_empty());
}
