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
    let Value::Array(items) = &raw else {
        return Some(raw);
    };
    if items.is_empty() {
        return Some(raw);
    }
    let Some(first) = items.first() else {
        return Some(raw);
    };
    let Some(first_obj) = first.as_object() else {
        return Some(raw);
    };

    if first_obj.get("parts").is_some_and(Value::is_array) {
        return Some(Value::Array(
            items.iter().map(normalize_output_message_keys).collect(),
        ));
    }

    if first_obj.get("type").and_then(Value::as_str).is_some() {
        let parts: Vec<Value> = items
            .iter()
            .filter(|part| part.as_object().is_some())
            .cloned()
            .collect();
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String("assistant".to_string()));
        message.insert("parts".to_string(), Value::Array(parts));
        return Some(Value::Array(vec![Value::Object(message)]));
    }

    Some(raw)
}

fn normalize_output_message_keys(msg: &Value) -> Value {
    let Some(obj) = msg.as_object() else {
        return msg.clone();
    };
    if obj.contains_key("finishReason") && !obj.contains_key("finish_reason") {
        let mut rest = obj.clone();
        if let Some(finish_reason) = rest.remove("finishReason") {
            rest.insert("finish_reason".to_string(), finish_reason);
        }
        return Value::Object(rest);
    }
    msg.clone()
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
    let Value::Array(items) = &raw else {
        return Some(raw);
    };
    if items.is_empty() {
        return Some(raw);
    }

    Some(Value::Array(
        items
            .iter()
            .map(|msg| {
                let Some(obj) = msg.as_object() else {
                    return msg.clone();
                };
                if obj.get("parts").is_some_and(Value::is_array) {
                    return msg.clone();
                }
                if let (Some(_role), Some(content)) = (
                    obj.get("role").and_then(Value::as_str),
                    obj.get("content").and_then(Value::as_str),
                ) {
                    let mut rest = obj.clone();
                    rest.remove("content");
                    rest.insert(
                        "parts".to_string(),
                        serde_json::json!([{ "type": "text", "content": content }]),
                    );
                    return Value::Object(rest);
                }
                msg.clone()
            })
            .collect(),
    ))
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
