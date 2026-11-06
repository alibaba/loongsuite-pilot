//! OpenClaw hook names and block JSON.

use super::qoder::{canonicalize_hook_event, parse_hook_request, present};
use super::reason::wrap_host_reason;
use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
use serde_json::{json, Map, Value};

pub fn canonicalize_openclaw_hook(raw: Option<&str>) -> Option<HookEventName> {
    match raw? {
        "before_agent_run" | "before_prompt_build" | "llm_input" => {
            Some(HookEventName::UserPromptSubmit)
        }
        "before_tool_call" => Some(HookEventName::PreToolUse),
        "after_tool_call" | "tool_result_middleware" | "tool_result_persist" => {
            Some(HookEventName::PostToolUse)
        }
        other => canonicalize_hook_event(Some(other)),
    }
}

fn pick_string(values: &[Option<&str>]) -> Option<String> {
    values
        .iter()
        .copied()
        .flatten()
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

fn as_str(value: &Value) -> Option<&str> {
    value.as_str()
}

pub fn parse_openclaw_hook_request(
    payload: &Map<String, Value>,
    event_hint: Option<&str>,
) -> Option<HookRequest> {
    let event = canonicalize_hook_event(event_hint)
        .or_else(|| {
            canonicalize_openclaw_hook(payload.get("openclaw_hook").and_then(Value::as_str))
        })
        .or_else(|| canonicalize_openclaw_hook(payload.get("hook").and_then(Value::as_str)))
        .or_else(|| {
            canonicalize_hook_event(payload.get("hook_event_name").and_then(Value::as_str))
        })?;
    let mut merged = payload.clone();
    merged.insert(
        "hook_event_name".to_string(),
        Value::String(event.as_str().to_string()),
    );
    if let Some(session) = pick_string(&[
        payload.get("session_id").and_then(as_str),
        payload.get("sessionId").and_then(as_str),
    ]) {
        merged.insert("session_id".to_string(), Value::String(session));
    } else {
        merged.remove("session_id");
    }
    if let Some(path) = pick_string(&[
        payload.get("transcript_path").and_then(as_str),
        payload.get("transcriptPath").and_then(as_str),
    ]) {
        merged.insert("transcript_path".to_string(), Value::String(path));
    }
    if let Some(prompt) = pick_string(&[payload.get("prompt").and_then(as_str)]) {
        merged.insert("prompt".to_string(), Value::String(prompt));
    }
    if let Some(cwd) = pick_string(&[payload.get("cwd").and_then(as_str)]) {
        merged.insert("cwd".to_string(), Value::String(cwd));
    }
    if let Some(name) = pick_string(&[
        payload.get("tool_name").and_then(as_str),
        payload.get("toolName").and_then(as_str),
    ]) {
        merged.insert("tool_name".to_string(), Value::String(name));
    }
    let tool_input = present(payload.get("tool_input"))
        .or_else(|| present(payload.get("params")))
        .or_else(|| present(payload.get("toolInput")));
    match tool_input {
        Some(value) => {
            merged.insert("tool_input".to_string(), value);
        }
        None => {
            merged.remove("tool_input");
        }
    }
    let tool_response = present(payload.get("tool_response"))
        .or_else(|| present(payload.get("tool_output")))
        .or_else(|| present(payload.get("message")))
        .or_else(|| present(payload.get("result")))
        .or_else(|| present(payload.get("toolResponse")));
    match tool_response {
        Some(value) => {
            merged.insert("tool_response".to_string(), value);
        }
        None => {
            merged.remove("tool_response");
        }
    }
    if let Some(id) = pick_string(&[
        payload.get("tool_use_id").and_then(as_str),
        payload.get("toolCallId").and_then(as_str),
        payload.get("call_id").and_then(as_str),
    ]) {
        merged.insert("tool_use_id".to_string(), Value::String(id));
    } else {
        merged.remove("tool_use_id");
    }
    parse_hook_request(&merged, InterceptorAgent::OpenClaw, Some(event.as_str()))
}

fn rewrite_post_tool_content(original: Option<&Value>, wrapped: &str) -> Value {
    let mut out = match original {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    out.insert(
        "content".to_string(),
        json!([{ "type": "text", "text": wrapped }]),
    );
    Value::Object(out)
}

pub fn openclaw_block_result(request: &HookRequest, interceptor_reason: Option<&str>) -> Value {
    let wrapped = wrap_host_reason(request.event, interceptor_reason);
    let detail = interceptor_reason
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("Blocked by security policy");
    match request.event {
        HookEventName::UserPromptSubmit => json!({
            "outcome": "block",
            "reason": detail,
            "message": wrapped
        }),
        HookEventName::PostToolUse => {
            let rewritten = rewrite_post_tool_content(request.tool_response.as_ref(), &wrapped);
            if request.raw.get("openclaw_hook").and_then(Value::as_str)
                == Some("tool_result_middleware")
            {
                json!({ "result": rewritten })
            } else {
                json!({ "message": rewritten })
            }
        }
        HookEventName::PreToolUse => json!({
            "block": true,
            "blockReason": wrapped
        }),
    }
}

pub fn render_openclaw_block(request: &HookRequest, interceptor_reason: Option<&str>) -> String {
    format!(
        "{}\n",
        serde_json::to_string(&openclaw_block_result(request, interceptor_reason))
            .unwrap_or_else(|_| "{}".to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::adapters::reason::wrap_host_reason;
    use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
    use serde_json::{json, Map};

    fn base() -> HookRequest {
        HookRequest {
            agent: InterceptorAgent::OpenClaw,
            event: HookEventName::UserPromptSubmit,
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
    fn maps_native_openclaw_hook_names() {
        assert_eq!(
            canonicalize_openclaw_hook(Some("before_agent_run")),
            Some(HookEventName::UserPromptSubmit)
        );
        assert_eq!(
            canonicalize_openclaw_hook(Some("before_tool_call")),
            Some(HookEventName::PreToolUse)
        );
        assert_eq!(
            canonicalize_openclaw_hook(Some("tool_result_middleware")),
            Some(HookEventName::PostToolUse)
        );
        assert_eq!(
            canonicalize_openclaw_hook(Some("tool_result_persist")),
            Some(HookEventName::PostToolUse)
        );
        assert_eq!(canonicalize_openclaw_hook(Some("Stop")), None);
    }

    #[test]
    fn parses_native_prompt_and_tool_payloads() {
        let prompt = parse_openclaw_hook_request(
            &map(json!({"openclaw_hook": "before_agent_run", "prompt": "export KEY=sk-test", "sessionId": "s1", "cwd": "/tmp/proj"})),
            None,
        )
        .unwrap();
        assert_eq!(prompt.agent, InterceptorAgent::OpenClaw);
        assert_eq!(prompt.event, HookEventName::UserPromptSubmit);
        assert_eq!(prompt.prompt.as_deref(), Some("export KEY=sk-test"));
        assert_eq!(prompt.session_id.as_deref(), Some("s1"));
        assert_eq!(prompt.cwd.as_deref(), Some("/tmp/proj"));

        let tool = parse_openclaw_hook_request(
            &map(json!({"hook": "before_tool_call", "toolName": "exec", "params": {"command": "id"}, "toolCallId": "call_1"})),
            None,
        )
        .unwrap();
        assert_eq!(tool.event, HookEventName::PreToolUse);
        assert_eq!(tool.tool_name.as_deref(), Some("exec"));
        assert_eq!(tool.tool_input, Some(json!({"command": "id"})));
        assert_eq!(tool.tool_use_id.as_deref(), Some("call_1"));
    }

    #[test]
    fn keeps_the_persisted_tool_message_as_post_tool_response() {
        let message = json!({"toolCallId": "t1", "content": [{"type": "text", "text": "secret"}]});
        let parsed = parse_openclaw_hook_request(
            &map(json!({"openclaw_hook": "tool_result_persist", "toolName": "read", "message": message})),
            None,
        )
        .unwrap();
        assert_eq!(parsed.tool_response, Some(message));
    }

    #[test]
    fn renders_before_agent_run_block() {
        let rendered: Value =
            serde_json::from_str(render_openclaw_block(&base(), Some("[APIKEY_MASKED]")).trim())
                .unwrap();
        assert_eq!(
            rendered,
            json!({
                "outcome": "block",
                "reason": "[APIKEY_MASKED]",
                "message": wrap_host_reason(HookEventName::UserPromptSubmit, Some("[APIKEY_MASKED]"))
            })
        );
    }

    #[test]
    fn renders_before_tool_call_as_block() {
        let mut request = base();
        request.event = HookEventName::PreToolUse;
        assert_eq!(
            openclaw_block_result(&request, Some("[APIKEY_MASKED]")),
            json!({
                "block": true,
                "blockReason": wrap_host_reason(HookEventName::PreToolUse, Some("[APIKEY_MASKED]"))
            })
        );
    }

    #[test]
    fn renders_tool_result_persist_by_replacing_message_content() {
        let mut request = base();
        request.event = HookEventName::PostToolUse;
        request.tool_response = Some(
            json!({"toolCallId": "t1", "content": [{"type": "text", "text": "mysql://user:pass@127.0.0.1/db"}]}),
        );
        assert_eq!(
            openclaw_block_result(&request, Some("[DATABASEURL_MASKED]")),
            json!({
                "message": {
                    "toolCallId": "t1",
                    "content": [{"type": "text", "text": wrap_host_reason(HookEventName::PostToolUse, Some("[DATABASEURL_MASKED]"))}]
                }
            })
        );
    }

    #[test]
    fn renders_tool_result_middleware_as_result() {
        let original = json!({
            "content": [{"type": "text", "text": "mysql://user:pass@127.0.0.1/db"}],
            "details": {"status": "completed"}
        });
        let mut request = base();
        request.event = HookEventName::PostToolUse;
        request.tool_response = Some(original.clone());
        request
            .raw
            .insert("openclaw_hook".to_string(), json!("tool_result_middleware"));
        let mut expected_result = original;
        expected_result["content"] = json!([{
            "type": "text",
            "text": wrap_host_reason(HookEventName::PostToolUse, Some("[DATABASEURL_MASKED]"))
        }]);
        assert_eq!(
            openclaw_block_result(&request, Some("[DATABASEURL_MASKED]")),
            json!({ "result": expected_result })
        );
    }
}
