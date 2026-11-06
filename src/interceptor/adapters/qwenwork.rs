//! QwenWork HTTP and command-hook control JSON.

use super::qoder::parse_hook_request;
use super::reason::wrap_host_reason;
use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
use serde_json::{json, Map, Value};

/// Official QwenWork HTTP / local command hook request uses the same snake_case fields as Qoder.
pub fn parse_qwen_work_hook_request(
    payload: &Map<String, Value>,
    event_hint: Option<&str>,
) -> Option<HookRequest> {
    let hint = event_hint.or_else(|| {
        if payload
            .get("hook_event_name")
            .and_then(Value::as_str)
            .is_some()
        {
            None
        } else {
            payload.get("event").and_then(Value::as_str)
        }
    });
    parse_hook_request(payload, InterceptorAgent::QwenWorkCn, hint)
}

pub fn qwen_work_allow_body() -> Value {
    json!({})
}

pub fn qwen_work_block_body(request: &HookRequest, interceptor_reason: Option<&str>) -> Value {
    let text = wrap_host_reason(request.event, interceptor_reason);
    match request.event {
        HookEventName::UserPromptSubmit => json!({ "decision": "block", "reason": text }),
        HookEventName::PostToolUse => json!({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "updatedToolOutput": text
            }
        }),
        HookEventName::PreToolUse => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": text
            }
        }),
    }
}

pub fn render_qwen_work_block(request: &HookRequest, interceptor_reason: Option<&str>) -> String {
    format!(
        "{}\n",
        serde_json::to_string(&qwen_work_block_body(request, interceptor_reason))
            .unwrap_or_else(|_| "{}".to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::adapters::reason::wrap_host_reason;
    use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
    use serde_json::{json, Map, Value};

    fn base(event: HookEventName) -> HookRequest {
        HookRequest {
            agent: InterceptorAgent::QwenWorkCn,
            event,
            session_id: None,
            transcript_path: None,
            cwd: None,
            tool_name: None,
            tool_input: None,
            tool_response: None,
            tool_use_id: None,
            prompt: Some("secret".to_string()),
            raw: Map::new(),
        }
    }

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn parses_official_snake_case_payloads() {
        let prompt = parse_qwen_work_hook_request(
            &map(json!({"hook_event_name": "UserPromptSubmit", "prompt": "请汇总本季度客户反馈。", "session_id": "session-xxxx"})),
            None,
        )
        .unwrap();
        assert_eq!(prompt.agent, InterceptorAgent::QwenWorkCn);
        assert_eq!(prompt.event, HookEventName::UserPromptSubmit);
        assert_eq!(prompt.session_id.as_deref(), Some("session-xxxx"));
        assert_eq!(prompt.prompt.as_deref(), Some("请汇总本季度客户反馈。"));

        let pre = parse_qwen_work_hook_request(
            &map(json!({"event": "PreToolUse", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "id"}, "tool_use_id": "tool-demo-001"})),
            None,
        )
        .unwrap();
        assert_eq!(pre.event, HookEventName::PreToolUse);
        assert_eq!(pre.tool_name.as_deref(), Some("Bash"));
        assert_eq!(pre.tool_use_id.as_deref(), Some("tool-demo-001"));
        assert_eq!(pre.tool_input, Some(json!({"command":"id"})));

        let hinted = parse_qwen_work_hook_request(
            &map(json!({"event": "PreToolUse", "tool_name": "Bash"})),
            None,
        )
        .unwrap();
        assert_eq!(hinted.agent, InterceptorAgent::QwenWorkCn);
        assert_eq!(hinted.event, HookEventName::PreToolUse);
        assert_eq!(hinted.tool_name.as_deref(), Some("Bash"));
    }

    #[test]
    fn skips_stop_and_other_non_intercept_events() {
        assert!(
            parse_qwen_work_hook_request(&map(json!({"hook_event_name": "Stop"})), None).is_none()
        );
        assert!(parse_qwen_work_hook_request(
            &map(json!({"hook_event_name": "SessionStart"})),
            None
        )
        .is_none());
    }

    #[test]
    fn renders_user_prompt_as_decision_block() {
        assert_eq!(
            qwen_work_block_body(
                &base(HookEventName::UserPromptSubmit),
                Some("[APIKEY_MASKED]")
            ),
            json!({
                "decision": "block",
                "reason": wrap_host_reason(HookEventName::UserPromptSubmit, Some("[APIKEY_MASKED]"))
            })
        );
    }

    #[test]
    fn renders_pre_tool_use_as_permission_deny() {
        assert_eq!(
            qwen_work_block_body(&base(HookEventName::PreToolUse), Some("[APIKEY_MASKED]")),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": wrap_host_reason(HookEventName::PreToolUse, Some("[APIKEY_MASKED]"))
                }
            })
        );
    }

    #[test]
    fn renders_post_tool_use_as_updated_tool_output() {
        let mut request = base(HookEventName::PostToolUse);
        request.tool_response = Some(json!({"stdout": "mysql://x"}));
        let rendered: Value = serde_json::from_str(
            render_qwen_work_block(&request, Some("[DATABASEURL_MASKED]")).trim(),
        )
        .unwrap();
        assert_eq!(
            rendered,
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "updatedToolOutput": wrap_host_reason(HookEventName::PostToolUse, Some("[DATABASEURL_MASKED]"))
                }
            })
        );
        assert!(rendered.get("decision").is_none());
    }

    #[test]
    fn uses_an_empty_object_for_allow_bodies() {
        assert_eq!(qwen_work_allow_body(), json!({}));
    }
}
