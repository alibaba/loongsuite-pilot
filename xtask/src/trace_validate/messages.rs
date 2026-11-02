//! 保持输入消息固定 Schema 与输出消息兼容规则；只报告字段位置，不输出消息正文。
use super::{Check, Span};
use serde_json::Value;

pub(super) const FINISH_REASONS: &[&str] = &[
    "stop",
    "length",
    "content_filter",
    "tool_call",
    "tool_calls",
    "error",
    "end_turn",
    "max_tokens",
    "cancelled",
];

pub(super) fn parsed(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => serde_json::from_str(text).ok(),
        Value::Null => None,
        other => Some(other.clone()),
    }
}

pub(super) fn validate(span: &Span, key: &str, id: &str) -> Vec<Check> {
    let raw = &span.attributes[key];
    if raw.is_null() {
        return Vec::new();
    }
    let mut checks = Vec::new();
    let mut issue = |status, detail| checks.push(Check::new(id, status, detail, Some(span)));
    let Some(messages) = parsed(raw) else {
        issue("error", format!("{key} 不是有效 JSON"));
        return checks;
    };
    let Some(messages) = messages.as_array() else {
        issue("error", format!("{key} 必须是数组"));
        return checks;
    };
    let input = key == "gen_ai.input.messages";
    for (i, message) in messages.iter().enumerate() {
        let location = format!("{key}[{i}]");
        if !message.is_object() {
            issue("error", format!("{location} 必须是 object"));
            continue;
        }
        if !message["role"].is_string() {
            issue(
                "error",
                format!("{location} missing required string \"role\""),
            );
        }
        if input
            && message
                .get("name")
                .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            issue("error", format!("{location}.name 必须是 string 或 null"));
        }
        if !input {
            match message.get("finish_reason") {
                None => issue("warn", format!("{location} 缺少 finish_reason")),
                Some(value) if !value.as_str().is_some_and(|s| FINISH_REASONS.contains(&s)) => {
                    issue("error", format!("{location}.finish_reason 不在允许集合中"))
                }
                _ => {}
            }
        }
        let Some(parts) = message["parts"].as_array() else {
            if input {
                issue(
                    "error",
                    format!("{location} missing required array \"parts\""),
                );
            }
            continue;
        };
        for (j, part) in parts.iter().enumerate() {
            let location = format!("{location}.parts[{j}]");
            if !part.is_object() {
                issue("error", format!("{location} 必须是 object"));
                continue;
            }
            let Some(kind) = part["type"].as_str() else {
                issue(
                    "error",
                    format!("{location} missing required string \"type\""),
                );
                continue;
            };
            if input {
                for (status, detail) in input_part(part, kind) {
                    issue(status, format!("{location} {detail}"));
                }
            } else {
                match kind {
                    "text" if part.get("content").is_none() => {
                        issue("error", format!("{location} TextPart 缺少 content"))
                    }
                    "tool_call" | "tool_call_response" if !super::present(&part["id"]) => {
                        issue("warn", format!("{location} 缺少 id"))
                    }
                    "text" | "tool_call" | "tool_call_response" | "reasoning" => {}
                    _ => issue("warn", format!("{location} 未知输出 part type")),
                }
            }
        }
    }
    checks
}

fn input_part(part: &Value, kind: &str) -> Vec<(&'static str, String)> {
    let (title, required, optional, nested): (&str, &[&str], &[&str], Option<&str>) = match kind {
        "text" => ("TextPart", &["content"], &[], None),
        "tool_call" => ("ToolCallRequestPart", &["name"], &["id"], None),
        "tool_call_response" => ("ToolCallResponsePart", &[], &["id"], None),
        "server_tool_call" => (
            "ServerToolCallPart",
            &["name"],
            &["id"],
            Some("server_tool_call"),
        ),
        "server_tool_call_response" => (
            "ServerToolCallResponsePart",
            &[],
            &["id"],
            Some("server_tool_call_response"),
        ),
        "blob" => ("BlobPart", &["modality", "content"], &["mime_type"], None),
        "file" => ("FilePart", &["modality", "file_id"], &["mime_type"], None),
        "uri" => ("UriPart", &["modality", "uri"], &["mime_type"], None),
        "reasoning" => ("ReasoningPart", &["content"], &[], None),
        "image" | "compaction" => {
            return vec![("warn", format!("GenericPart extension type=\"{kind}\""))]
        }
        _ => return vec![("warn", "GenericPart extension type (unrecognized)".into())],
    };
    let mut errors = Vec::new();
    for field in required {
        if !part[*field].is_string() {
            errors.push((
                "error",
                format!("{title} missing required \"{field}\" (string)"),
            ));
        }
    }
    for field in optional {
        if part
            .get(*field)
            .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            errors.push(("error", format!("{title}.{field} 必须是 string 或 null")));
        }
    }
    if kind == "tool_call_response" && part.get("response").is_none() {
        errors.push((
            "error",
            "ToolCallResponsePart missing required \"response\"".into(),
        ));
    }
    if let Some(field) = nested {
        if !part[field].is_object() || !part[field]["type"].is_string() {
            errors.push((
                "error",
                format!("{title} missing required \"{field}\" with string \"type\""),
            ));
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn span(input: Value) -> Span {
        serde_json::from_value(json!({"traceId":"t","spanId":"s","name":"llm","startTimeUnixNano":"1","endTimeUnixNano":"2","attributes":{"gen_ai.input.messages":input}})).unwrap()
    }
    #[test]
    fn collector_and_validator_finish_reason_allowlists_match() {
        let mut collector = loongsuite_pilot::normalization::VALID_FINISH_REASONS.to_vec();
        let mut validator = FINISH_REASONS.to_vec();
        collector.sort_unstable();
        validator.sort_unstable();
        assert_eq!(collector, validator);
        for reason in collector
            .iter()
            .copied()
            .chain(["pause_turn", "some_future_reason", ""])
        {
            let mut output = span(json!([]));
            output.attributes["gen_ai.output.messages"] = json!([
                {"role":"assistant", "finish_reason":reason, "parts":[]}
            ]);
            let checks = validate(&output, "gen_ai.output.messages", "schema.output_messages");
            if collector.contains(&reason) {
                assert!(checks.is_empty(), "{reason}");
            } else {
                assert!(
                    checks.iter().any(|check| check.status == "error"),
                    "{reason}"
                );
            }
        }
    }

    #[test]
    fn pinned_input_schema_accepts_standard_parts_and_nullable_fields() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/schemas/gen-ai-input-messages.json");
        assert_eq!(
            loongsuite_pilot::utils::runtime_paths::sha256_file(&path).unwrap(),
            "c1fddd81ea2b3cd547f74407f1267658f400f5c608772ab2fc4d9a5b3d16297f"
        );
        let value = json!([{"role":"user","name":null,"parts":[
            {"type":"text","content":""}, {"type":"tool_call","name":"Read","id":null},
            {"type":"tool_call_response","response":null},
            {"type":"server_tool_call","name":"web_search","server_tool_call":{"type":"web_search"}},
            {"type":"server_tool_call_response","server_tool_call_response":{"type":"result"}},
            {"type":"blob","modality":"image","content":"","mime_type":null},
            {"type":"file","modality":"document","file_id":"file"},
            {"type":"uri","modality":"image","uri":"https://example.test/image"},
            {"type":"reasoning","content":""}
        ]}]);
        assert!(validate(
            &span(value),
            "gen_ai.input.messages",
            "schema.input_messages"
        )
        .is_empty());
    }
    #[test]
    fn input_message_required_fields_and_generic_extensions_are_distinct() {
        for part in [
            json!({}),
            json!({"type":"text"}),
            json!({"type":"tool_call"}),
            json!({"type":"tool_call_response","result":{"ok":true}}),
            json!({"type":"server_tool_call","name":"web_search"}),
            json!({"type":"server_tool_call_response"}),
            json!({"type":"blob","content":""}),
            json!({"type":"blob","modality":"image"}),
            json!({"type":"file","modality":"document"}),
            json!({"type":"uri","modality":"image"}),
            json!({"type":"reasoning"}),
        ] {
            let checks = validate(
                &span(json!([{"role":"user","parts":[part]}])),
                "gen_ai.input.messages",
                "schema.input_messages",
            );
            assert!(checks.iter().any(|c| c.status == "error"));
        }
        for messages in [
            json!([{"role":123,"parts":[]}]),
            json!([{"role":"user"}]),
            json!([null]),
            json!([{"role":"user","parts":[null]}]),
        ] {
            assert!(validate(
                &span(messages),
                "gen_ai.input.messages",
                "schema.input_messages"
            )
            .iter()
            .any(|c| c.status == "error"));
        }
        for kind in ["image", "compaction"] {
            let checks = validate(
                &span(json!([{"role":"user","parts":[{"type":kind}]}])),
                "gen_ai.input.messages",
                "schema.input_messages",
            );
            assert_eq!(checks.len(), 1);
            assert_eq!(checks[0].status, "warn");
        }
    }

    #[test]
    fn history_input_schema_preserves_each_required_field_and_known_extension_diagnostic() {
        let cases = [
            (
                json!([{"role":123,"parts":[]}]),
                r#"missing required string "role""#,
            ),
            (
                json!([{"role":"user"}]),
                r#"missing required array "parts""#,
            ),
            (
                json!([{"role":"user","parts":[{}]}]),
                r#"missing required string "type""#,
            ),
            (
                json!([{"role":"user","parts":[{"type":"text"}]}]),
                r#"TextPart missing required "content""#,
            ),
            (
                json!([{"role":"assistant","parts":[{"type":"tool_call"}]}]),
                r#"ToolCallRequestPart missing required "name""#,
            ),
            (
                json!([{"role":"assistant","parts":[{"type":"server_tool_call","name":"web_search"}]}]),
                r#"ServerToolCallPart missing required "server_tool_call""#,
            ),
            (
                json!([{"role":"assistant","parts":[{"type":"server_tool_call_response"}]}]),
                r#"ServerToolCallResponsePart missing required "server_tool_call_response""#,
            ),
            (
                json!([{"role":"user","parts":[{"type":"blob","content":""}]}]),
                r#"BlobPart missing required "modality""#,
            ),
            (
                json!([{"role":"user","parts":[{"type":"blob","modality":"image"}]}]),
                r#"BlobPart missing required "content""#,
            ),
            (
                json!([{"role":"user","parts":[{"type":"file","modality":"document"}]}]),
                r#"FilePart missing required "file_id""#,
            ),
            (
                json!([{"role":"user","parts":[{"type":"uri","modality":"image"}]}]),
                r#"UriPart missing required "uri""#,
            ),
            (
                json!([{"role":"assistant","parts":[{"type":"reasoning"}]}]),
                r#"ReasoningPart missing required "content""#,
            ),
            (
                json!([{"role":"tool","parts":[{"type":"tool_call_response","id":"call-1","result":{"ok":true}}]}]),
                r#"ToolCallResponsePart missing required "response""#,
            ),
        ];
        for (input, expected) in cases {
            let checks = validate(
                &span(input),
                "gen_ai.input.messages",
                "schema.input_messages",
            );
            assert!(
                checks
                    .iter()
                    .any(|c| c.status == "error" && c.detail.contains(expected)),
                "missing {expected}: {}",
                serde_json::to_string(&checks).unwrap()
            );
        }
        for kind in ["image", "compaction"] {
            let checks = validate(
                &span(json!([{"role":"user","parts":[{"type":kind}]}])),
                "gen_ai.input.messages",
                "schema.input_messages",
            );
            assert_eq!(checks.len(), 1);
            assert_eq!(checks[0].status, "warn");
            assert!(checks[0]
                .detail
                .contains(&format!("GenericPart extension type=\"{kind}\"")));
        }
        let sensitive = "synthetic-secret-as-untrusted-part-type";
        let checks = validate(
            &span(json!([{"role":"user","parts":[{"type":sensitive}]}])),
            "gen_ai.input.messages",
            "schema.input_messages",
        );
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].status, "warn");
        assert!(!checks[0].detail.contains(sensitive));
    }
}
