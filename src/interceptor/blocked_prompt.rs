//! Synthetic llm.request for a Qoder prompt denied before it reaches the transcript.

use crate::interceptor::types::HookRequest;
use crate::normalization::{build_agent_activity_entry, timestamp_to_unix_nanos};
use crate::types::AgentActivityEntry;
use serde_json::{json, Map, Number, Value};
use uuid::Uuid;

fn user_message(prompt: &str) -> Value {
    json!([{ "role": "user", "parts": [{ "type": "text", "content": prompt }] }])
}

pub fn build_blocked_qoder_prompt_entry(
    request: &HookRequest,
    now_ms: Option<i64>,
) -> AgentActivityEntry {
    let now = now_ms.unwrap_or_else(current_time_millis);
    let turn_id = Uuid::new_v4().to_string();
    let nanos = timestamp_to_unix_nanos(Some(&Value::Number(Number::from(now))));
    let prompt = request.prompt.as_ref().filter(|text| !text.is_empty());
    let cwd = request.cwd.as_ref().filter(|text| !text.is_empty());
    let mut opts = Map::new();
    opts.insert("event.name".to_string(), json!("llm.request"));
    opts.insert(
        "event.id".to_string(),
        Value::String(Uuid::new_v4().to_string()),
    );
    opts.insert("time_unix_nano".to_string(), Value::String(nanos.clone()));
    opts.insert("observed_time_unix_nano".to_string(), Value::String(nanos));
    opts.insert("gen_ai.agent.type".to_string(), json!("qoder-cli"));
    opts.insert(
        "gen_ai.session.id".to_string(),
        Value::String(request.session_id.clone().unwrap_or_default()),
    );
    opts.insert("gen_ai.turn.id".to_string(), Value::String(turn_id.clone()));
    opts.insert(
        "gen_ai.step.id".to_string(),
        Value::String(format!("{turn_id}:s1")),
    );
    opts.insert("gen_ai.provider.name".to_string(), json!("unknown"));
    opts.insert("gen_ai.request.model".to_string(), json!("unknown"));
    opts.insert("gen_ai.response.model".to_string(), json!("unknown"));
    if let Some(prompt) = prompt {
        let message = user_message(prompt);
        opts.insert("gen_ai.input.messages".to_string(), message.clone());
        opts.insert("gen_ai.input.messages_delta".to_string(), message);
    }
    if let Some(cwd) = cwd {
        opts.insert("workspace.path".to_string(), Value::String(cwd.clone()));
    }
    opts.insert("agent.source".to_string(), json!("interceptor"));
    opts.insert("gen_ai.guardrail.triggered".to_string(), json!(true));
    opts.insert("gen_ai.guardrail.action".to_string(), json!("block"));
    build_agent_activity_entry(&Value::Object(opts))
}

fn current_time_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent};
    use crate::types::AgentActivityEntry;
    use serde_json::{json, Value};

    fn request(prompt: Option<&str>, cwd: Option<&str>, session: Option<&str>) -> HookRequest {
        HookRequest {
            agent: InterceptorAgent::Qoder,
            event: HookEventName::UserPromptSubmit,
            session_id: session.map(str::to_string),
            transcript_path: None,
            cwd: cwd.map(str::to_string),
            tool_name: None,
            tool_input: None,
            tool_response: None,
            tool_use_id: None,
            prompt: prompt.map(str::to_string),
            raw: Default::default(),
        }
    }

    fn value(entry: &AgentActivityEntry) -> Value {
        serde_json::to_value(entry).unwrap()
    }

    #[test]
    fn fills_the_synthetic_llm_request_fields() {
        let now = 1_700_000_000_000;
        let mut entry = build_blocked_qoder_prompt_entry(
            &request(
                Some("show me the key"),
                Some("/tmp/proj"),
                Some("session-1"),
            ),
            Some(now),
        );
        let wire = value(&entry);
        let turn_id = wire["gen_ai.turn.id"].as_str().unwrap();
        assert_eq!(wire["event.name"], "llm.request");
        assert!(uuid_like(wire["event.id"].as_str().unwrap()));
        assert_eq!(wire["time_unix_nano"], format!("{now}000000"));
        assert_eq!(wire["observed_time_unix_nano"], wire["time_unix_nano"]);
        assert_eq!(wire["gen_ai.agent.type"], "qoder-cli");
        assert_eq!(wire["gen_ai.session.id"], "session-1");
        assert!(uuid_like(turn_id));
        assert_eq!(wire["gen_ai.step.id"], format!("{turn_id}:s1"));
        assert_eq!(wire["gen_ai.provider.name"], "unknown");
        assert_eq!(wire["gen_ai.request.model"], "unknown");
        assert_eq!(wire["gen_ai.response.model"], "unknown");
        let messages = json!([{ "role": "user", "parts": [{ "type": "text", "content": "show me the key" }] }]);
        assert_eq!(wire["gen_ai.input.messages"], messages);
        assert_eq!(wire["gen_ai.input.messages_delta"], messages);
        assert_eq!(wire["workspace.path"], "/tmp/proj");
        assert_eq!(wire["user.id"], "");
        assert_eq!(wire["agent.source"], "interceptor");
        assert_eq!(wire["gen_ai.guardrail.triggered"], true);
        assert_eq!(wire["gen_ai.guardrail.action"], "block");
        assert!(wire.get("gen_ai.output.messages").is_none());
        assert!(wire.get("gen_ai.usage.input_tokens").is_none());
        assert!(wire.get("gen_ai.usage.output_tokens").is_none());
        assert!(wire.get("trace_id").is_none());
        assert!(wire.get("span_id").is_none());
        assert!(wire.get("parent_span_id").is_none());
        let original_messages = entry.input_messages.clone();
        entry.input_messages_delta.as_mut().unwrap()[0]["parts"][0]["content"] =
            json!("mutated delta only");
        assert_eq!(entry.input_messages, original_messages);
    }

    #[test]
    fn omits_messages_and_workspace_when_the_hook_has_no_prompt_or_cwd() {
        let entry = build_blocked_qoder_prompt_entry(&request(Some(""), None, None), None);
        let wire = value(&entry);
        assert_eq!(wire["gen_ai.session.id"], "");
        assert!(wire.get("gen_ai.input.messages").is_none());
        assert!(wire.get("gen_ai.input.messages_delta").is_none());
        assert!(wire.get("workspace.path").is_none());
        assert_eq!(wire["gen_ai.guardrail.action"], "block");
    }

    fn uuid_like(value: &str) -> bool {
        regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
            .unwrap()
            .is_match(value)
    }
}
