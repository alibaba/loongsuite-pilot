//! Qoder desktop and qodercli hook payloads.

use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
use serde_json::{json, Map, Value};

pub fn canonicalize_hook_event(raw: Option<&str>) -> Option<HookEventName> {
    match raw? {
        "UserPromptSubmit" | "user_prompt_submit" | "user-prompt-submit" | "userPromptSubmit" => {
            Some(HookEventName::UserPromptSubmit)
        }
        "PreToolUse" | "pre_tool_use" | "pre-tool-use" | "preToolUse" => {
            Some(HookEventName::PreToolUse)
        }
        "PostToolUse" | "post_tool_use" | "post-tool-use" | "postToolUse" => {
            Some(HookEventName::PostToolUse)
        }
        _ => None,
    }
}

pub fn parse_hook_request(
    payload: &Map<String, Value>,
    agent: InterceptorAgent,
    event_hint: Option<&str>,
) -> Option<HookRequest> {
    let event = canonicalize_hook_event(event_hint).or_else(|| {
        canonicalize_hook_event(payload.get("hook_event_name").and_then(Value::as_str))
    })?;
    Some(HookRequest {
        agent,
        event,
        session_id: string_field(payload, "session_id"),
        transcript_path: string_field(payload, "transcript_path"),
        cwd: string_field(payload, "cwd"),
        prompt: string_field(payload, "prompt"),
        tool_name: string_field(payload, "tool_name"),
        tool_input: present(payload.get("tool_input")),
        tool_response: present(payload.get("tool_response"))
            .or_else(|| present(payload.get("tool_output"))),
        tool_use_id: string_field(payload, "tool_use_id")
            .or_else(|| string_field(payload, "call_id")),
        raw: payload.clone(),
    })
}

pub fn render_qoder_block(request: &HookRequest, reason: &str) -> String {
    let text = if reason.is_empty() {
        "Blocked by security policy"
    } else {
        reason
    };
    let body = match request.event {
        HookEventName::UserPromptSubmit => {
            let decision = if request.agent == InterceptorAgent::Qoder {
                "block"
            } else {
                "deny"
            };
            json!({ "decision": decision, "reason": text })
        }
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
    };
    format!(
        "{}\n",
        serde_json::to_string(&body).unwrap_or_else(|_| "{}".to_string())
    )
}

pub(crate) fn string_field(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(crate) fn present(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Null) | None => None,
        Some(other) => Some(other.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
    use serde_json::{json, Map, Value};

    fn base(agent: InterceptorAgent, event: HookEventName) -> HookRequest {
        HookRequest {
            agent,
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
    fn parses_official_and_aliased_event_names() {
        assert_eq!(
            parse_hook_request(
                &map(json!({"hook_event_name": "user_prompt_submit", "prompt": "hi"})),
                InterceptorAgent::Qoder,
                None
            )
            .unwrap()
            .event,
            HookEventName::UserPromptSubmit
        );
        assert_eq!(
            parse_hook_request(
                &map(json!({"hook_event_name": "pre-tool-use", "tool_name": "Bash"})),
                InterceptorAgent::QoderCli,
                None
            )
            .unwrap()
            .event,
            HookEventName::PreToolUse
        );
        assert_eq!(
            parse_hook_request(
                &map(json!({"hook_event_name": "post_tool_use", "tool_response": {"ok": true}})),
                InterceptorAgent::Qoder,
                None
            )
            .unwrap()
            .event,
            HookEventName::PostToolUse
        );
        assert!(parse_hook_request(
            &map(json!({"hook_event_name": "Stop"})),
            InterceptorAgent::Qoder,
            None
        )
        .is_none());
    }

    #[test]
    fn renders_desktop_user_prompt_as_decision_block() {
        let expected = format!(
            "{}\n",
            serde_json::to_string(&json!({"decision": "block", "reason": "nope"})).unwrap()
        );
        assert_eq!(
            render_qoder_block(
                &base(InterceptorAgent::Qoder, HookEventName::UserPromptSubmit),
                "nope"
            ),
            expected
        );
    }

    #[test]
    fn renders_cli_user_prompt_as_decision_deny() {
        let expected = format!(
            "{}\n",
            serde_json::to_string(&json!({"decision": "deny", "reason": "nope"})).unwrap()
        );
        assert_eq!(
            render_qoder_block(
                &base(InterceptorAgent::QoderCli, HookEventName::UserPromptSubmit),
                "nope"
            ),
            expected
        );
    }

    #[test]
    fn renders_pre_tool_use_the_same_way_for_both_surfaces() {
        let expected = format!(
            "{}\n",
            serde_json::to_string(&json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "denied"
                }
            }))
            .unwrap()
        );
        assert_eq!(
            render_qoder_block(
                &base(InterceptorAgent::Qoder, HookEventName::PreToolUse),
                "denied"
            ),
            expected
        );
        assert_eq!(
            render_qoder_block(
                &base(InterceptorAgent::QoderCli, HookEventName::PreToolUse),
                "denied"
            ),
            expected
        );
    }

    #[test]
    fn renders_post_tool_use_by_replacing_the_tool_output() {
        let expected = format!(
            "{}\n",
            serde_json::to_string(&json!({
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "updatedToolOutput": "denied"
                }
            }))
            .unwrap()
        );
        assert_eq!(
            render_qoder_block(
                &base(InterceptorAgent::Qoder, HookEventName::PostToolUse),
                "denied"
            ),
            expected
        );
        assert_eq!(
            render_qoder_block(
                &base(InterceptorAgent::QoderCli, HookEventName::PostToolUse),
                "denied"
            ),
            expected
        );
    }

    #[test]
    fn keeps_tool_response_on_parsed_post_tool_use_requests() {
        let parsed = parse_hook_request(
            &map(json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_response": {"stdout": "secret"}})),
            InterceptorAgent::QoderCli,
            None,
        )
        .unwrap();
        assert_eq!(parsed.tool_response, Some(json!({"stdout": "secret"})));
    }
}
