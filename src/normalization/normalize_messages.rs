use serde_json::{Map, Value};

/// Normalize `gen_ai.output.messages` to `[{role, parts, finish_reason?}]`.
///
/// Bare parts `[{type, content}]` become one assistant message. `finishReason`
/// is renamed to `finish_reason` when the snake_case key is absent.
pub fn normalize_output_messages(raw: Option<Value>) -> Option<Value> {
    let raw = raw?;
    if raw.is_null() {
        return None;
    }
    let Value::Array(mut items) = raw else {
        return Some(raw);
    };
    let Some(first_obj) = items.first().and_then(Value::as_object) else {
        return Some(Value::Array(items));
    };

    if first_obj.get("parts").is_some_and(Value::is_array) {
        for msg in &mut items {
            normalize_output_message_keys(msg);
        }
        return Some(Value::Array(items));
    }

    if first_obj.get("type").and_then(Value::as_str).is_some() {
        items.retain(Value::is_object);
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String("assistant".to_string()));
        message.insert("parts".to_string(), Value::Array(items));
        return Some(Value::Array(vec![Value::Object(message)]));
    }

    Some(Value::Array(items))
}

fn normalize_output_message_keys(msg: &mut Value) {
    let Some(obj) = msg.as_object_mut() else {
        return;
    };
    if obj.contains_key("finishReason") && !obj.contains_key("finish_reason") {
        if let Some(finish_reason) = obj.remove("finishReason") {
            obj.insert("finish_reason".to_string(), finish_reason);
        }
    }
}

/// Normalize `gen_ai.input.messages_delta` to `[{role, parts}]`.
pub fn normalize_input_messages_delta(raw: Option<Value>) -> Option<Value> {
    normalize_input_messages_array(raw)
}

/// Normalize `gen_ai.input.messages` with the same rules as `messages_delta`.
pub fn normalize_input_messages(raw: Option<Value>) -> Option<Value> {
    normalize_input_messages_array(raw)
}

fn normalize_input_messages_array(raw: Option<Value>) -> Option<Value> {
    let raw = raw?;
    if raw.is_null() {
        return None;
    }
    let Value::Array(mut items) = raw else {
        return Some(raw);
    };
    for msg in &mut items {
        let Some(obj) = msg.as_object_mut() else {
            continue;
        };
        if obj.get("parts").is_some_and(Value::is_array) {
            continue;
        }
        if obj.get("role").and_then(Value::as_str).is_some()
            && obj.get("content").and_then(Value::as_str).is_some()
        {
            if let Some(content) = obj.remove("content") {
                let mut part = Map::new();
                part.insert("type".to_string(), Value::String("text".to_string()));
                part.insert("content".to_string(), content);
                obj.insert("parts".to_string(), Value::Array(vec![Value::Object(part)]));
            }
        }
    }
    Some(Value::Array(items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn output_returns_none_for_missing_and_null() {
        assert_eq!(normalize_output_messages(None), None);
        assert_eq!(normalize_output_messages(Some(Value::Null)), None);
    }

    #[test]
    fn wraps_bare_parts_array_into_role_parts() {
        let input = json!([{ "type": "text", "content": "hello" }]);
        assert_eq!(
            normalize_output_messages(Some(input)),
            Some(json!([{
                "role": "assistant",
                "parts": [{ "type": "text", "content": "hello" }]
            }]))
        );
    }

    #[test]
    fn wraps_bare_reasoning_part() {
        let input = json!([{ "type": "reasoning", "content": "thinking..." }]);
        assert_eq!(
            normalize_output_messages(Some(input)),
            Some(json!([{
                "role": "assistant",
                "parts": [{ "type": "reasoning", "content": "thinking..." }]
            }]))
        );
    }

    #[test]
    fn wraps_multiple_bare_parts_into_a_single_message() {
        let input = json!([
            { "type": "reasoning", "content": "think" },
            { "type": "text", "content": "answer" }
        ]);
        assert_eq!(
            normalize_output_messages(Some(input)),
            Some(json!([{
                "role": "assistant",
                "parts": [
                    { "type": "reasoning", "content": "think" },
                    { "type": "text", "content": "answer" }
                ]
            }]))
        );
    }

    #[test]
    fn renames_camel_case_finish_reason() {
        let input = json!([{
            "role": "assistant",
            "parts": [{ "type": "text", "content": "hi" }],
            "finishReason": "stop"
        }]);
        assert_eq!(
            normalize_output_messages(Some(input)),
            Some(json!([{
                "role": "assistant",
                "parts": [{ "type": "text", "content": "hi" }],
                "finish_reason": "stop"
            }]))
        );
    }

    #[test]
    fn passes_through_canonical_output_with_and_without_finish_reason() {
        let with_reason = json!([{
            "role": "assistant",
            "parts": [{ "type": "text", "content": "hello" }],
            "finish_reason": "stop"
        }]);
        assert_eq!(
            normalize_output_messages(Some(with_reason.clone())),
            Some(with_reason)
        );

        let without_reason = json!([{
            "role": "assistant",
            "parts": [{ "type": "text", "content": "hello" }]
        }]);
        assert_eq!(
            normalize_output_messages(Some(without_reason.clone())),
            Some(without_reason)
        );
    }

    #[test]
    fn output_returns_empty_array_as_is() {
        assert_eq!(normalize_output_messages(Some(json!([]))), Some(json!([])));
    }

    #[test]
    fn input_delta_returns_none_for_missing_and_null() {
        assert_eq!(normalize_input_messages_delta(None), None);
        assert_eq!(normalize_input_messages_delta(Some(Value::Null)), None);
    }

    #[test]
    fn input_delta_converts_flat_content_to_parts() {
        let input = json!([{ "role": "user", "content": "hello" }]);
        assert_eq!(
            normalize_input_messages_delta(Some(input)),
            Some(json!([{
                "role": "user",
                "parts": [{ "type": "text", "content": "hello" }]
            }]))
        );
    }

    #[test]
    fn input_delta_passes_through_canonical_format() {
        let input = json!([{
            "role": "user",
            "parts": [{ "type": "text", "content": "hello" }]
        }]);
        assert_eq!(
            normalize_input_messages_delta(Some(input.clone())),
            Some(input)
        );
    }

    #[test]
    fn input_delta_returns_empty_array_as_is() {
        assert_eq!(
            normalize_input_messages_delta(Some(json!([]))),
            Some(json!([]))
        );
    }

    #[test]
    fn input_messages_returns_none_for_missing() {
        assert_eq!(normalize_input_messages(None), None);
    }

    #[test]
    fn input_messages_converts_flat_content_to_parts() {
        let input = json!([{ "role": "user", "content": "hello" }]);
        assert_eq!(
            normalize_input_messages(Some(input)),
            Some(json!([{
                "role": "user",
                "parts": [{ "type": "text", "content": "hello" }]
            }]))
        );
    }

    #[test]
    fn input_messages_passes_through_canonical_format() {
        let input = json!([{
            "role": "user",
            "parts": [{ "type": "text", "content": "hello" }]
        }]);
        assert_eq!(normalize_input_messages(Some(input.clone())), Some(input));
    }
}

#[cfg(test)]
mod owned_message_normalizer_tests {
    use super::*;
    use serde_json::{json, Value};

    fn assert_bytes(actual: Option<Value>, expected: &str) {
        assert_eq!(serde_json::to_string(&actual.unwrap()).unwrap(), expected);
    }

    #[test]
    fn flat_input_preserves_swap_remove_order_and_unknown_fields() {
        let raw = r#"[{"before":0,"role":"user","content":"中文🚀","opaque":{"z":2,"a":1},"parts":null,"last":18446744073709551615}]"#;
        let expected = r#"[{"before":0,"role":"user","last":18446744073709551615,"opaque":{"z":2,"a":1},"parts":[{"type":"text","content":"中文🚀"}]}]"#;
        assert_bytes(
            normalize_input_messages(Some(serde_json::from_str(raw).unwrap())),
            expected,
        );
        assert_bytes(
            normalize_input_messages_delta(Some(serde_json::from_str(raw).unwrap())),
            expected,
        );
    }

    #[test]
    fn canonical_input_keeps_content_and_all_original_bytes() {
        let raw = r#"[{"role":"user","content":"kept","parts":[],"unknown":{"b":false,"a":null}},null,0,false,"text",[]]"#;
        assert_bytes(
            normalize_input_messages(Some(serde_json::from_str(raw).unwrap())),
            raw,
        );
    }

    #[test]
    fn output_rename_preserves_swap_remove_and_only_snake_absence_triggers() {
        let raw = r#"[{"role":"assistant","finishReason":null,"unknown":{"z":2,"a":1},"parts":[],"last":false},null,{"finishReason":"keep","parts":[],"finish_reason":null}]"#;
        let expected = r#"[{"role":"assistant","last":false,"unknown":{"z":2,"a":1},"parts":[],"finish_reason":null},null,{"finishReason":"keep","parts":[],"finish_reason":null}]"#;
        assert_bytes(
            normalize_output_messages(Some(serde_json::from_str(raw).unwrap())),
            expected,
        );
    }

    #[test]
    fn bare_parts_keep_unknown_objects_drop_scalars_and_keep_order() {
        let raw = r#"[{"type":"reasoning","content":"think","z":1},null,0,false,[],"text",{"opaque":{"b":2,"a":1}},{"type":"text","content":"answer"}]"#;
        let expected = r#"[{"role":"assistant","parts":[{"type":"reasoning","content":"think","z":1},{"opaque":{"b":2,"a":1}},{"type":"text","content":"answer"}]}]"#;
        assert_bytes(
            normalize_output_messages(Some(serde_json::from_str(raw).unwrap())),
            expected,
        );
    }

    #[test]
    fn output_first_item_controls_path_and_parts_array_has_priority() {
        let untouched = r#"[null,{"parts":[],"finishReason":"keep"}]"#;
        assert_bytes(
            normalize_output_messages(Some(serde_json::from_str(untouched).unwrap())),
            untouched,
        );
        let raw =
            r#"[{"type":"text","parts":[],"finishReason":"rename"},0,{"finishReason":false}]"#;
        let expected =
            r#"[{"type":"text","parts":[],"finish_reason":"rename"},0,{"finish_reason":false}]"#;
        assert_bytes(
            normalize_output_messages(Some(serde_json::from_str(raw).unwrap())),
            expected,
        );
    }

    #[test]
    fn null_scalar_and_non_string_content_contracts_are_unchanged() {
        let normalizers: [fn(Option<Value>) -> Option<Value>; 3] = [
            normalize_input_messages,
            normalize_input_messages_delta,
            normalize_output_messages,
        ];
        for normalize in normalizers {
            assert_eq!(normalize(None), None);
            assert_eq!(normalize(Some(Value::Null)), None);
            for value in [
                json!(false),
                json!(0),
                json!(""),
                json!({"z":1,"a":2}),
                json!([]),
            ] {
                let expected = serde_json::to_vec(&value).unwrap();
                assert_eq!(
                    serde_json::to_vec(&normalize(Some(value)).unwrap()).unwrap(),
                    expected
                );
            }
        }
        for value in [
            json!(false),
            json!(0),
            Value::Null,
            json!([]),
            json!({"unknown":true}),
        ] {
            let raw = json!([{"role":"user","content":value,"unknown":{"z":1,"a":2}}]);
            let expected = serde_json::to_vec(&raw).unwrap();
            assert_eq!(
                serde_json::to_vec(&normalize_input_messages(Some(raw)).unwrap()).unwrap(),
                expected
            );
        }
    }
}
