//! Complete Copilot interactions correlated with optional native OTel evidence.
//! Transcript event time orders messages; native time supplies operation timing.
use crate::normalization::entry_from_map;
use crate::types::AgentActivityEntry;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub struct InteractionBatch {
    pub key: String,
    pub records: Vec<AgentActivityEntry>,
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}
fn identity(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_else(|| {
        if value.is_null() {
            String::new()
        } else {
            value.to_string()
        }
    })
}
fn event_time(event: &Value) -> Option<i128> {
    chrono::DateTime::parse_from_rfc3339(text(event, "timestamp"))
        .ok()
        .map(|time| {
            i128::from(time.timestamp()) * 1_000_000_000 + i128::from(time.timestamp_subsec_nanos())
        })
        .filter(|time| *time >= 0)
}
fn native_time(span: &Value, key: &str) -> Option<i128> {
    let parts = span.get(key)?.as_array()?;
    if parts.len() != 2 {
        return None;
    }
    let seconds = parts[0].as_i64()?;
    let nanos = parts[1].as_u64()?;
    (seconds >= 0 && nanos < 1_000_000_000)
        .then_some(i128::from(seconds) * 1_000_000_000 + i128::from(nanos))
}
fn hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))[..32].to_owned()
}
fn infer_provider(model: &str) -> &'static str {
    // Match the current main Copilot adapter's explicit model fallbacks.
    let model = model.to_lowercase();
    if model.is_empty() {
        "unknown"
    } else if model.starts_with("gpt") || model.contains("openai") {
        "openai"
    } else if model.starts_with("claude") || model.contains("anthropic") {
        "anthropic"
    } else if model.contains("gemini") {
        "google"
    } else if model.contains("qwen") {
        "alibaba"
    } else {
        "openai"
    }
}
fn parts(data: &Value) -> Vec<Value> {
    let mut parts = Vec::new();
    for (field, kind) in [("reasoningText", "reasoning"), ("content", "text")] {
        if let Some(text) = data
            .get(field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            parts.push(json!({"type":kind,"content":text}));
        }
    }
    if let Some(tools) = data.get("toolRequests").and_then(Value::as_array) {
        for tool in tools {
            let id = text(tool, "toolCallId");
            let name = text(tool, "name");
            if id.is_empty() && name.is_empty() {
                continue;
            }
            parts.push(json!({"type":"tool_call","id":tool.get("toolCallId"),"name":tool.get("name"),"arguments":tool.get("arguments")}));
        }
    }
    parts
}
fn base(
    session: &str,
    turn: &str,
    trace: &str,
    id: &str,
    name: &str,
    time: i128,
) -> Map<String, Value> {
    json!({"event.name":name,"event.id":id,"user.id":"","gen_ai.agent.type":"copilot",
        "gen_ai.provider.name":"unknown","gen_ai.session.id":session,"gen_ai.turn.id":turn,
        "trace_id":trace,"time_unix_nano":time.to_string()})
    .as_object()
    .expect("object")
    .clone()
}
struct ModelCall<'a> {
    id: String,
    messages: Vec<&'a Value>,
    span: Option<&'a Value>,
    step: String,
    model: String,
    start: i128,
    end: i128,
    input_cutoff: i128,
}
pub fn parse_interactions(
    events: &[Value],
    spans: &[Value],
    require_otel: bool,
) -> Vec<InteractionBatch> {
    let Some(session) = events.iter().find(|event| event["type"] == "session.start") else {
        return Vec::new();
    };
    let session_id = text(&session["data"], "sessionId");
    if session_id.is_empty() {
        return Vec::new();
    }
    let spans: Vec<_> = spans
        .iter()
        .filter(|span| {
            span["type"] == "span" && span["attributes"]["gen_ai.conversation.id"] == session_id
        })
        .collect();
    let mut groups: IndexMap<String, Vec<&Value>> = IndexMap::new();
    let mut active = String::new();
    for event in events {
        if event["type"] == "session.shutdown" {
            continue;
        }
        let explicit = text(&event["data"], "interactionId");
        if !explicit.is_empty() {
            active = explicit.into();
        } else if event["type"] == "user.message" {
            active = text(event, "id").into();
        }
        if !active.is_empty() {
            groups.entry(active.clone()).or_default().push(event);
        }
    }
    let mut batches = Vec::new();
    for (interaction, history) in groups {
        let messages: Vec<_> = history
            .iter()
            .copied()
            .filter(|event| event["type"] == "assistant.message")
            .collect();
        let chats: Vec<_> = spans
            .iter()
            .copied()
            .filter(|span| {
                span["attributes"]["gen_ai.operation.name"] == "chat"
                    && span["attributes"]["github.copilot.interaction_id"] == interaction
            })
            .collect();
        let root = spans.iter().copied().find(|span| {
            span["attributes"]["gen_ai.operation.name"] == "invoke_agent"
                && chats.iter().any(|chat| chat["traceId"] == span["traceId"])
                && span
                    .get("parentSpanId")
                    .is_none_or(|parent| parent.is_null() || parent == "")
        });
        let abort = history.iter().any(|event| event["type"] == "abort");
        let final_message = messages.last();
        let last_end = history
            .iter()
            .rev()
            .find(|event| event["type"] == "assistant.turn_end");
        let closed = abort
            || final_message.zip(last_end).is_some_and(|(message, end)| {
                message["data"]
                    .get("toolRequests")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
                    && event_time(end)
                        .zip(event_time(message))
                        .is_some_and(|(end, start)| end >= start)
            });
        let root_failed = root.is_some_and(|root| root["status"]["code"] == 2);
        if (require_otel && root.is_none()) || (!closed && !root_failed) {
            continue;
        }
        if require_otel
            && (chats.iter().any(|chat| {
                chat["status"]["code"] != 2
                    && !messages.iter().any(|message| {
                        message["data"]["apiCallId"] == chat["attributes"]["gen_ai.response.id"]
                    })
            }) || messages.iter().any(|message| {
                !chats.iter().any(|chat| {
                    chat["attributes"]["gen_ai.response.id"] == message["data"]["apiCallId"]
                })
            }))
        {
            continue;
        }
        let turn = format!("copilot:{session_id}:{interaction}");
        let trace = hash(&turn);
        let mut entries: Vec<Map<String, Value>> = history
            .iter()
            .filter(|event| event["type"] == "user.message")
            .filter_map(|event| {
                let content = event["data"].get("content")?.as_str()?;
                let mut fields = base(
                    session_id,
                    &turn,
                    &trace,
                    &hash(&format!("{turn}:input:{}", text(event, "id"))),
                    "other",
                    event_time(event)?,
                );
                fields.insert(
                    "gen_ai.input.messages".into(),
                    json!([{"role":"user","parts":[{"type":"text","content":content}]}]),
                );
                Some(fields)
            })
            .collect();
        let mut grouped: IndexMap<String, Vec<&Value>> = IndexMap::new();
        for message in messages.iter().copied() {
            let id = ["apiCallId", "messageId"]
                .iter()
                .map(|key| text(&message["data"], key))
                .find(|id| !id.is_empty())
                .unwrap_or_else(|| text(message, "id"));
            if !id.is_empty() {
                grouped.entry(id.into()).or_default().push(message);
            }
        }
        for chat in &chats {
            if chat["status"]["code"] == 2 {
                let id = text(&chat["attributes"], "gen_ai.response.id");
                let id = if id.is_empty() {
                    text(chat, "spanId")
                } else {
                    id
                };
                if !id.is_empty() {
                    grouped.entry(id.into()).or_default();
                }
            }
        }
        let mut calls = Vec::new();
        for (id, messages) in grouped {
            let span = chats.iter().copied().find(|span| {
                span["attributes"]["gen_ai.response.id"] == id || span["spanId"] == id
            });
            let attrs = span.map(|span| &span["attributes"]);
            let step = attrs
                .and_then(|attrs| attrs.get("github.copilot.turn_id"))
                .or_else(|| {
                    messages
                        .first()
                        .and_then(|message| message["data"].get("turnId"))
                })
                .map(identity)
                .filter(|step| !step.is_empty())
                .unwrap_or_else(|| id.clone());
            let start_event = history.iter().copied().find(|event| {
                event["type"] == "assistant.turn_start"
                    && identity(&event["data"]["turnId"]) == step
            });
            let first = messages.first().copied();
            let model = attrs
                .map(|attrs| text(attrs, "gen_ai.response.model"))
                .filter(|model| !model.is_empty())
                .or_else(|| {
                    first
                        .map(|event| text(&event["data"], "model"))
                        .filter(|model| !model.is_empty())
                })
                .or_else(|| attrs.map(|attrs| text(attrs, "gen_ai.request.model")))
                .unwrap_or_default()
                .to_owned();
            let transcript_start = start_event.or(first).and_then(event_time);
            let start = span
                .and_then(|span| native_time(span, "startTime"))
                .or(transcript_start);
            let end = span
                .and_then(|span| native_time(span, "endTime"))
                .or_else(|| messages.last().and_then(|event| event_time(event)));
            if let (Some(start), Some(end)) = (start, end) {
                if end < start {
                    continue;
                }
                calls.push(ModelCall {
                    id,
                    messages,
                    span,
                    step,
                    model,
                    start,
                    end,
                    input_cutoff: transcript_start.map_or(start, |stamp| stamp.max(start)),
                });
            }
        }
        calls.sort_by_key(|call| call.input_cutoff);
        let mut consumed = std::collections::HashSet::new();
        for call in calls {
            let attrs = call.span.map(|span| &span["attributes"]);
            let mut input = Vec::new();
            for (index, event) in history.iter().enumerate() {
                if consumed.contains(&index)
                    || event_time(event).is_none_or(|time| time >= call.input_cutoff)
                {
                    continue;
                }
                match event["type"].as_str() {
                    Some("system.message"|"user.message") => {
                        if let Some(content) = event["data"].get("content").and_then(Value::as_str) {
                            input.push(json!({"role":if event["type"]=="system.message" {"system"}else{"user"},
                                "parts":[{"type":"text","content":content}]}));
                        }
                    },
                    Some("assistant.message") => input.push(json!({"role":"assistant","parts":parts(&event["data"])})),
                    Some("tool.execution_complete") if event["data"].get("toolCallId").is_some() =>
                        input.push(json!({"role":"tool","parts":[{"type":"tool_call_response",
                            "id":event["data"]["toolCallId"],"response":event["data"].get("result")}]})),
                    _ => {},
                }
                consumed.insert(index);
            }
            let provider = attrs
                .map(|attrs| text(attrs, "gen_ai.provider.name"))
                .filter(|provider| !provider.is_empty())
                .unwrap_or_else(|| infer_provider(&call.model));
            let mut request = base(
                session_id,
                &turn,
                &trace,
                &hash(&format!("{turn}:request:{}", call.id)),
                "llm.request",
                call.start,
            );
            request.insert("gen_ai.step.id".into(), json!(call.step));
            request.insert("gen_ai.request.id".into(), json!(call.id));
            request.insert("gen_ai.response.id".into(), json!(call.id));
            request.insert("gen_ai.provider.name".into(), json!(provider));
            request.insert(
                "gen_ai.request.model".into(),
                json!(attrs
                    .map(|attrs| text(attrs, "gen_ai.request.model"))
                    .filter(|model| !model.is_empty())
                    .unwrap_or(&call.model)),
            );
            if !input.is_empty() {
                request.insert("gen_ai.input.messages_delta".into(), json!(input));
            }
            let mut response = request.clone();
            response.remove("gen_ai.input.messages_delta");
            response.insert("event.name".into(), json!("llm.response"));
            response.insert(
                "event.id".into(),
                json!(hash(&format!("{turn}:llm:{}", call.id))),
            );
            response.insert("time_unix_nano".into(), json!(call.end.to_string()));
            response.insert("gen_ai.response.model".into(), json!(call.model));
            let output: Vec<_> = call
                .messages
                .iter()
                .flat_map(|message| parts(&message["data"]))
                .collect();
            let reasoning = call
                .messages
                .iter()
                .filter_map(|message| message["data"].get("reasoningText").and_then(Value::as_str))
                .filter(|chunk| !chunk.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            if !reasoning.is_empty() {
                response.insert("gen_ai.llm.reasoning.text".into(), json!(reasoning));
            }
            if !output.is_empty() {
                response.insert(
                    "gen_ai.output.messages".into(),
                    json!([{"role":"assistant","parts":output}]),
                );
            }
            let reasons = if call.messages.iter().any(|message| {
                message["data"]
                    .get("toolRequests")
                    .and_then(Value::as_array)
                    .is_some_and(|tools| !tools.is_empty())
            }) {
                json!(["tool_calls"])
            } else {
                json!(["stop"])
            };
            response.insert("gen_ai.response.finish_reasons".into(), reasons);
            if let Some(attrs) = attrs {
                for suffix in [
                    "input_tokens",
                    "output_tokens",
                    "cache_read.input_tokens",
                    "cache_creation.input_tokens",
                    "reasoning.output_tokens",
                ] {
                    let key = format!("gen_ai.usage.{suffix}");
                    if let Some(value) = attrs.get(&key).filter(|value| {
                        value
                            .as_f64()
                            .is_some_and(|value| value.is_finite() && value >= 0.0)
                    }) {
                        response.insert(key, value.clone());
                    }
                }
                if let Some(total) = response
                    .get("gen_ai.usage.input_tokens")
                    .and_then(Value::as_u64)
                    .zip(
                        response
                            .get("gen_ai.usage.output_tokens")
                            .and_then(Value::as_u64),
                    )
                    .and_then(|(input, output)| input.checked_add(output))
                {
                    response.insert("gen_ai.usage.total_tokens".into(), json!(total));
                }
                if let Some(reasons) = attrs
                    .get("gen_ai.response.finish_reasons")
                    .filter(|value| value.is_array())
                {
                    response.insert("gen_ai.response.finish_reasons".into(), reasons.clone());
                }
                if call.span.is_some_and(|span| span["status"]["code"] == 2) {
                    response.insert(
                        "error.type".into(),
                        attrs
                            .get("error.type")
                            .cloned()
                            .unwrap_or(json!("provider_error")),
                    );
                }
            }
            entries.push(request);
            entries.push(response);
        }
        for start in history
            .iter()
            .copied()
            .filter(|event| event["type"] == "tool.execution_start")
        {
            let call_id = text(&start["data"], "toolCallId");
            if call_id.is_empty() {
                continue;
            }
            let complete = history.iter().copied().find(|event| {
                event["type"] == "tool.execution_complete"
                    && text(&event["data"], "toolCallId") == call_id
            });
            let tool = spans.iter().copied().find(|span| {
                span["attributes"]["gen_ai.operation.name"] == "execute_tool"
                    && text(&span["attributes"], "gen_ai.tool.call.id") == call_id
                    && chats.iter().any(|chat| chat["traceId"] == span["traceId"])
            });
            if complete.is_none() && tool.is_none() {
                continue;
            }
            let begin = tool
                .and_then(|span| native_time(span, "startTime"))
                .or_else(|| event_time(start));
            let end = tool
                .and_then(|span| native_time(span, "endTime"))
                .or_else(|| complete.and_then(event_time));
            let (Some(begin), Some(end)) = (begin, end) else {
                continue;
            };
            let resolved_model = messages
                .iter()
                .find(|message| message["data"].get("turnId") == start["data"].get("turnId"))
                .map(|message| text(&message["data"], "model"))
                .unwrap_or_default();
            let call_model = text(&start["data"], "model");
            let call_model = if call_model.is_empty() {
                resolved_model
            } else {
                call_model
            };
            let result_model = [
                text(&start["data"], "model"),
                complete
                    .map(|event| text(&event["data"], "model"))
                    .unwrap_or_default(),
            ]
            .into_iter()
            .find(|model| !model.is_empty())
            .unwrap_or(resolved_model);
            let mut call = base(
                session_id,
                &turn,
                &trace,
                text(start, "id"),
                "tool.call",
                begin,
            );
            call.insert(
                "gen_ai.provider.name".into(),
                json!(infer_provider(call_model)),
            );
            call.insert("gen_ai.step.id".into(), start["data"]["turnId"].clone());
            call.insert("gen_ai.tool.name".into(), start["data"]["toolName"].clone());
            call.insert("gen_ai.tool.call.id".into(), json!(call_id));
            call.insert("gen_ai.tool.call.exec.id".into(), json!(call_id));
            if let Some(args) = start["data"].get("arguments") {
                call.insert("gen_ai.tool.call.arguments".into(), args.clone());
            }
            let mut result = call.clone();
            result.insert(
                "gen_ai.provider.name".into(),
                json!(infer_provider(result_model)),
            );
            result.insert("event.name".into(), json!("tool.result"));
            result.insert(
                "event.id".into(),
                json!(complete
                    .map(|event| text(event, "id"))
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| hash(&format!("{turn}:tool:{call_id}:result")))),
            );
            result.insert("time_unix_nano".into(), json!(end.to_string()));
            result.remove("gen_ai.tool.call.arguments");
            if let Some(complete) = complete {
                if let Some(value) = complete["data"].get("result") {
                    result.insert("gen_ai.tool.call.result".into(), value.clone());
                }
                if let Some(success) = complete["data"]
                    .get("success")
                    .filter(|value| value.is_boolean())
                {
                    result.insert("gen_ai.tool.success".into(), success.clone());
                    result.insert(
                        "tool.result.status".into(),
                        json!(if success == true {
                            "success"
                        } else {
                            "failure"
                        }),
                    );
                }
                for (source, target) in [("code", "error.code"), ("message", "error.message")] {
                    if let Some(value) = complete["data"]["error"].get(source) {
                        result.insert(target.into(), value.clone());
                    }
                }
            }
            let native_tool_failed = tool.is_some_and(|span| span["status"]["code"] == 2);
            if native_tool_failed {
                result.insert("gen_ai.tool.success".into(), json!(false));
                result.insert("tool.result.status".into(), json!("failure"));
            }
            if result.get("gen_ai.tool.success") == Some(&json!(false)) {
                let error_type = if native_tool_failed {
                    tool.and_then(|span| span["attributes"].get("error.type"))
                } else {
                    result.get("error.code")
                }
                .filter(|value| value.as_str().is_some_and(|value| !value.is_empty()))
                .cloned()
                .unwrap_or(json!("tool_error"));
                result.insert("error.type".into(), error_type);
            }
            if let Some(permission) = history.iter().find(|event| {
                event["type"] == "permission.completed"
                    && text(&event["data"], "toolCallId") == call_id
            }) {
                if let Some(kind) = permission["data"]["result"].get("kind") {
                    result.insert("permission.result.kind".into(), kind.clone());
                }
                if let Some(source) = permission["data"].get("decisionSource") {
                    result.insert("permission.decision_source".into(), source.clone());
                }
            }
            entries.push(call);
            entries.push(result);
        }
        // Retain the legacy per-step endpoint as a separate observed fact.
        // It closes no interaction itself; the final scoped record owns turn.end.
        let step_ids: std::collections::BTreeSet<_> = entries
            .iter()
            .filter_map(|entry| entry.get("gen_ai.step.id").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        for step in step_ids {
            let children: Vec<_> = entries
                .iter()
                .filter(|entry| {
                    entry.get("gen_ai.step.id").and_then(Value::as_str) == Some(step.as_str())
                })
                .collect();
            let Some(first) = children.iter().min_by_key(|entry| {
                entry
                    .get("time_unix_nano")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<i128>().ok())
            }) else {
                continue;
            };
            let end = children
                .iter()
                .filter_map(|entry| {
                    entry
                        .get("_merged_end_time_unix_nano")
                        .or_else(|| entry.get("time_unix_nano"))
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<i128>().ok())
                })
                .max()
                .unwrap_or_default();
            let mut endpoint = base(
                session_id,
                &turn,
                &trace,
                &hash(&format!("{turn}:step:{step}")),
                "react.step",
                end,
            );
            endpoint.insert("gen_ai.step.id".into(), json!(step));
            for key in ["gen_ai.provider.name", "gen_ai.request.model"] {
                if let Some(value) = first.get(key) {
                    endpoint.insert(key.into(), value.clone());
                }
            }
            entries.push(endpoint);
        }
        if entries.is_empty() {
            continue;
        }
        for fields in &mut entries {
            fields.insert("gen_ai.copilot.interaction.id".into(), json!(interaction));
            fields.insert("gen_ai.copilot.source".into(), json!("hybrid-v2"));
        }
        entries.sort_by_key(|fields| {
            fields
                .get("time_unix_nano")
                .and_then(Value::as_str)
                .and_then(|text| text.parse::<i128>().ok())
                .unwrap_or_default()
        });
        if let Some(last) = entries.last_mut() {
            last.insert("gen_ai.turn.end".into(), json!(true));
            if root_failed || abort {
                last.insert(
                    "gen_ai.copilot.interaction.error".into(),
                    root.and_then(|root| root["attributes"].get("error.type"))
                        .cloned()
                        .unwrap_or(json!("cancelled")),
                );
            }
        }
        batches.push(InteractionBatch {
            key: turn,
            records: entries.into_iter().map(entry_from_map).collect(),
        });
    }
    for shutdown in events
        .iter()
        .filter(|event| event["type"] == "session.shutdown")
    {
        let Some(time) = event_time(shutdown) else {
            continue;
        };
        let key = format!("copilot:{session_id}:summary:{}", text(shutdown, "id"));
        let mut fields = base(session_id, "", "", &hash(&key), "other", time);
        fields.remove("gen_ai.turn.id");
        fields.remove("trace_id");
        fields.insert("gen_ai.copilot.session_summary".into(), json!(true));
        fields.insert(
            "gen_ai.session.model_metrics".into(),
            shutdown["data"]
                .get("modelMetrics")
                .cloned()
                .unwrap_or(json!({})),
        );
        if let Some(duration) = shutdown["data"].get("totalApiDurationMs") {
            fields.insert(
                "gen_ai.session.total_api_duration_ms".into(),
                duration.clone(),
            );
        }
        batches.push(InteractionBatch {
            key,
            records: vec![entry_from_map(fields)],
        });
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AgentEventName;
    fn fixture(tool: bool) -> Value {
        serde_json::from_str(if tool {
            include_str!("../../../tests/fixtures/copilot/tool-conversation.json")
        } else {
            include_str!("../../../tests/fixtures/copilot/conversation.json")
        })
        .unwrap()
    }
    #[test]
    fn native_provider_usage_requires_correlated_root_and_message_and_preserves_real_usage() {
        let fixture = fixture(false);
        let events = fixture["events"].as_array().unwrap();
        let spans = fixture["spans"].as_array().unwrap();
        assert!(parse_interactions(events, &spans[..1], true).is_empty());
        assert!(parse_interactions(events, &spans[1..], true).is_empty());
        let missing: Vec<_> = events
            .iter()
            .filter(|event| event["type"] != "assistant.message")
            .cloned()
            .collect();
        assert!(parse_interactions(&missing, spans, true).is_empty());
        let batches = parse_interactions(events, spans, true);
        assert_eq!(batches.len(), 1);
        let response = batches[0]
            .records
            .iter()
            .find(|entry| entry.event_name == Some(AgentEventName::LlmResponse))
            .unwrap();
        assert_eq!(response.input_tokens, Some(100));
        assert_eq!(response.output_tokens, Some(10));
        assert_eq!(response.total_tokens, Some(110));
        assert_eq!(
            batches[0]
                .records
                .iter()
                .filter(|entry| entry.turn_end == Some(true))
                .count(),
            1
        );
        let degraded = parse_interactions(events, &[], false);
        assert!(degraded[0]
            .records
            .iter()
            .all(|entry| entry.input_tokens.is_none() && entry.output_tokens.is_none()));
    }
    #[test]
    fn repeated_turn_zero_keeps_interactions_separate_and_tool_fragments_are_incremental() {
        let fixture = fixture(true);
        let events = fixture["events"].as_array().unwrap();
        let spans = fixture["spans"].as_array().unwrap();
        let batches = parse_interactions(events, spans, true);
        assert_eq!(batches.len(), 1);
        let requests: Vec<_> = batches[0]
            .records
            .iter()
            .filter(|entry| entry.event_name == Some(AgentEventName::LlmRequest))
            .collect();
        assert_eq!(requests.len(), 2);
        let roles = |entry: &AgentActivityEntry| {
            entry
                .input_messages_delta
                .as_ref()
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["role"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(roles(requests[0]), ["user"]);
        assert_eq!(roles(requests[1]), ["assistant", "tool"]);
        assert!(batches[0]
            .records
            .iter()
            .filter(|entry| entry.event_name == Some(AgentEventName::LlmResponse))
            .all(|entry| entry.input_messages_delta.is_none()));
        let mut second_events = events.clone();
        let mut second_spans = spans.clone();
        for event in &mut second_events {
            if let Some(id) = event["data"].get_mut("interactionId") {
                *id = json!("interaction-b");
            }
            if let Some(id) = event.get_mut("id") {
                *id = json!(format!("b-{}", id.as_str().unwrap_or_default()));
            }
        }
        for span in &mut second_spans {
            if let Some(id) = span["attributes"].get_mut("github.copilot.interaction_id") {
                *id = json!("interaction-b");
            }
            span["traceId"] = json!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        }
        let combined_events: Vec<_> = events
            .iter()
            .chain(second_events.iter().skip(1))
            .cloned()
            .collect();
        let combined_spans: Vec<_> = spans.iter().chain(&second_spans).cloned().collect();
        let combined = parse_interactions(&combined_events, &combined_spans, true);
        assert_eq!(combined.len(), 2);
        assert_ne!(
            combined[0].records[0].trace_id,
            combined[1].records[0].trace_id
        );
    }
}

#[cfg(test)]
#[path = "copilot_interaction_main_contract_tests.rs"]
mod current_main_contract_tests;

#[cfg(test)]
#[path = "copilot_captured_transcript_main_contract_tests.rs"]
mod captured_transcript_main_contract_tests;
