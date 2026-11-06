//! Flatten a hook request into the text the sensitive-data rules scan.

use crate::interceptor::types::HookRequest;
use serde_json::Value;

const MAX_LEAF_DEPTH: usize = 32;

pub fn collect_hook_text(request: &HookRequest) -> String {
    let mut parts = Vec::new();
    if let Some(prompt) = request.prompt.as_deref() {
        if !prompt.is_empty() {
            parts.push(prompt.to_string());
        }
    }
    if let Some(tool_name) = request.tool_name.as_deref() {
        if !tool_name.is_empty() {
            parts.push(tool_name.to_string());
        }
    }
    if let Some(input) = &request.tool_input {
        parts.extend(collect_text_leaves(input, 0));
    }
    if let Some(response) = &request.tool_response {
        parts.extend(collect_text_leaves(response, 0));
    }
    parts.join("\n")
}

// Value owns its children and cannot form reference cycles. Container addresses
// are not object identities: a Vec's first element can share its address with
// an Object payload, causing an address set to silently omit sensitive text.
fn collect_text_leaves(value: &Value, depth: usize) -> Vec<String> {
    if value.is_null() || depth > MAX_LEAF_DEPTH {
        return Vec::new();
    }
    match value {
        Value::String(text) => {
            if text.is_empty() {
                Vec::new()
            } else {
                vec![text.clone()]
            }
        }
        Value::Number(number) => vec![number.to_string()],
        Value::Bool(flag) => vec![flag.to_string()],
        Value::Array(items) => items
            .iter()
            .flat_map(|item| collect_text_leaves(item, depth + 1))
            .collect(),
        Value::Object(map) => map
            .values()
            .flat_map(|item| collect_text_leaves(item, depth + 1))
            .collect(),
        Value::Null => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
    use serde_json::{json, Map, Value};

    fn request(
        prompt: Option<&str>,
        tool_name: Option<&str>,
        input: Option<Value>,
        response: Option<Value>,
    ) -> HookRequest {
        HookRequest {
            agent: InterceptorAgent::Qoder,
            event: HookEventName::UserPromptSubmit,
            session_id: None,
            transcript_path: None,
            cwd: None,
            tool_name: tool_name.map(str::to_string),
            tool_input: input,
            tool_response: response,
            tool_use_id: None,
            prompt: prompt.map(str::to_string),
            raw: Map::new(),
        }
    }

    #[test]
    fn joins_prompt_tool_name_and_nested_string_leaves() {
        assert_eq!(
            collect_hook_text(&request(
                Some("hello"),
                Some("Bash"),
                Some(json!({"command": "ls"})),
                Some(json!({"stdout": "ok"}))
            )),
            "hello\nBash\nls\nok"
        );
    }

    #[test]
    fn keeps_real_newlines_inside_nested_file_content() {
        assert_eq!(
            collect_hook_text(&request(
                None,
                Some("Read"),
                None,
                Some(
                    json!({"type": "text", "file": {"content": "intro\nmysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot"}})
                )
            )),
            "Read\ntext\nintro\nmysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot"
        );
    }
    #[test]
    fn reads_every_nested_content_object_including_first_array_element() {
        let text = collect_hook_text(&request(
            None,
            Some("Read"),
            None,
            Some(json!({
                "toolCallId":"nested-array","content":[
                    {"type":"text","text":"LTAI1234567890ABCD"},
                    {"type":"text","text":"second leaf"}
                ]
            })),
        ));
        assert!(text.contains("LTAI1234567890ABCD"), "{text:?}");
        assert!(text.contains("second leaf"), "{text:?}");
    }
    #[test]
    fn owned_arrays_keep_equal_but_independent_objects_and_nested_primitives() {
        assert_eq!(
            collect_text_leaves(
                &json!([
                    {"text":"same"},{"text":"same"},[[{"text":"nested"}]],null,true,17
                ]),
                0
            ),
            vec!["same", "same", "nested", "true", "17"]
        );
    }
    #[test]
    fn owned_tree_traversal_keeps_the_existing_depth_limit() {
        fn nested(depth: usize) -> Value {
            (0..depth).fold(json!("leaf"), |v, _| json!([v]))
        }
        assert_eq!(
            collect_text_leaves(&nested(MAX_LEAF_DEPTH), 0),
            vec!["leaf"]
        );
        assert!(collect_text_leaves(&nested(MAX_LEAF_DEPTH + 1), 0).is_empty());
    }
    #[test]
    fn native_openclaw_post_tool_content_reaches_the_builtin_block_rule() {
        use crate::interceptor::adapters::parse_openclaw_hook_request;
        use crate::interceptor::rules::{builtin_rules, RuleEngine};
        use crate::interceptor::VerdictAction;
        let body = json!({"hook_event_name":"PostToolUse","openclaw_hook":"tool_result_persist","tool_name":"read",
            "tool_response":{"toolCallId":"nested-array","content":[{"type":"text","text":"LTAI1234567890ABCD"}]}});
        let request = parse_openclaw_hook_request(body.as_object().unwrap(), None).unwrap();
        let result = RuleEngine::new(
            builtin_rules(),
            std::collections::HashSet::from(["cloudAccessKey".into()]),
        )
        .evaluate(&request);
        assert_eq!(result.action, VerdictAction::Block);
        assert_eq!(result.reason.as_deref(), Some("[ACCESSKEY_BLOCKED]"));
        assert_eq!(result.rule_id.as_deref(), Some("cloudAccessKey"));
    }
}
