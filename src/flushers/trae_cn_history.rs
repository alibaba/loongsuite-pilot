use super::otlp_json_serializer::{
    hr_time_to_nano, nano_to_hr_time, ConvertOptions, ConvertResult, EventLogConverter,
    ReadableSpan,
};
use crate::hook_process::trae_cn::id_digest;
use crate::types::{AgentActivityEntry, AgentEventName};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const HISTORY: &str = "loongsuite.trae_cn.model_responses";
const OBSERVATION: &str = "loongsuite.trae_cn.observation";
const STREAM: &str = "loongsuite.trae_cn.stream_request_id";

pub(super) fn convert(
    records: &[AgentActivityEntry],
    options: &ConvertOptions,
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    let mut result = converter.convert(records, options)?;
    let response = records
        .iter()
        .find(|row| row.event_name == Some(AgentEventName::LlmResponse));
    if let Some(response) = response {
        stamp_tool_times(records, &mut result.spans);
        if let Some(rounds) = response
            .get(HISTORY)
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty())
        {
            expand(rounds, response, &mut result.spans);
        }
    }
    omit_empty_models(&mut result.spans);
    result.span_count = result.spans.len();
    Ok(result)
}

fn kind(span: &ReadableSpan, name: &str) -> bool {
    span.attributes
        .get("gen_ai.span.kind")
        .and_then(Value::as_str)
        == Some(name)
}

fn stamp_tool_times(records: &[AgentActivityEntry], spans: &mut [ReadableSpan]) {
    let mut ranges: HashMap<&str, (Option<i128>, Option<i128>)> = HashMap::new();
    for record in records.iter().filter(|record| {
        record
            .get("agent.trae-cn.tool_timing_source")
            .and_then(Value::as_str)
            == Some("native_start_to_batch_commit")
    }) {
        let (Some(id), Ok(at)) = (
            record.tool_call_id.as_deref(),
            record.time_unix_nano.parse::<i128>(),
        ) else {
            continue;
        };
        let range = ranges.entry(id).or_default();
        match record.event_name {
            Some(AgentEventName::ToolCall) => range.0 = Some(at),
            Some(AgentEventName::ToolResult) => range.1 = Some(at),
            _ => {}
        }
    }
    for span in spans.iter_mut().filter(|span| kind(span, "TOOL")) {
        let range = span
            .attributes
            .get("gen_ai.tool.call.id")
            .and_then(Value::as_str)
            .and_then(|id| ranges.get(id));
        if let Some((Some(start), Some(end))) = range.filter(|(start, end)| start <= end) {
            time_bounds(span, nano_to_hr_time(*start), nano_to_hr_time(*end));
            span.attributes
                .insert(OBSERVATION.into(), json!("native_tool_acknowledged"));
        }
    }
}

fn expand(rounds: &[Value], summary: &AgentActivityEntry, spans: &mut Vec<ReadableSpan>) {
    let mut ids = HashSet::new();
    if rounds.iter().any(|round| {
        !round["id"].as_str().is_some_and(|id| {
            id.len() == 24
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && ids.insert(id)
        }) || nanos(&round["at"]).is_none()
    }) {
        return;
    }
    let Some(llm_index) = spans.iter().position(|span| {
        kind(span, "LLM")
            && span
                .attributes
                .get("gen_ai.response.id")
                .and_then(Value::as_str)
                == summary.response_id.as_deref()
    }) else {
        return;
    };
    let llm = spans[llm_index].clone();
    let Some(step_index) = spans
        .iter()
        .position(|span| kind(span, "STEP") && Some(&span.span_id) == llm.parent_span_id.as_ref())
    else {
        return;
    };
    let step = spans[step_index].clone();
    let Some(agent_index) = spans.iter().position(|span| {
        kind(span, "AGENT") && Some(&span.span_id) == step.parent_span_id.as_ref()
    }) else {
        return;
    };
    let agent_id = spans[agent_index].span_id.clone();
    let agent_start = spans[agent_index].start_time;
    let results: HashMap<String, Value> = spans
        .iter()
        .filter(|span| kind(span, "TOOL"))
        .filter_map(|span| {
            Some((
                span.attributes
                    .get("gen_ai.tool.call.id")?
                    .as_str()?
                    .to_owned(),
                span.attributes.get("gen_ai.tool.call.result")?.clone(),
            ))
        })
        .collect();
    let by_request: HashMap<_, _> = rounds
        .iter()
        .filter_map(|round| Some((round["request"].as_str()?, round["toolIds"].as_array()?)))
        .collect();
    let output = decode_messages(llm.attributes.get("gen_ai.output.messages"));
    let assistant: Vec<_> = output
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["role"] == "assistant")
        .flat_map(|message| message["parts"].as_array().into_iter().flatten())
        .collect();
    let mut shared = HashMap::<String, usize>::new();
    let mut parents = HashMap::<String, usize>::new();
    let mut observed: Vec<ReadableSpan> = Vec::new();
    for (index, round) in rounds.iter().enumerate() {
        let id = round["id"].as_str().expect("validated history ID");
        let at = nanos(&round["at"]).expect("validated history time");
        let end = nano_to_hr_time(at);
        let request = round["request"].as_str();
        let shared_request = request.filter(|_| round["shared"] == true);
        let header = nanos(&round["headersAt"])
            .map(nano_to_hr_time)
            .filter(|header| shared_request.is_none() && *header >= agent_start && *header < end);
        let start = header.unwrap_or(end);
        let mut step_attrs = context(&step, id, request);
        step_attrs.insert("gen_ai.react.round".into(), json!(index + 1));
        let mut llm_attrs = context(&llm, id, request);
        llm_attrs.insert("gen_ai.response.id".into(), json!(id));
        if header.is_some() {
            let source = json!("response_headers_to_history_recorded");
            step_attrs.insert("loongsuite.trae_cn.timing_source".into(), source.clone());
            llm_attrs.insert("loongsuite.trae_cn.timing_source".into(), source);
        }
        let mut step_start = start;
        let mut evidence = Map::new();
        if round["initial"] == true {
            if let Some(prompt) = llm.attributes.get("gen_ai.input.messages") {
                evidence.insert("gen_ai.input.messages".into(), prompt.clone());
            }
            if let Some((started, first)) = round["requestStartMs"]
                .as_u64()
                .zip(round["firstTokenMs"].as_u64())
                .filter(|(start, first)| {
                    *start > 0 && first >= start && i128::from(*first) * 1_000_000 <= at
                })
            {
                step_start = step_start.min(nano_to_hr_time(i128::from(started) * 1_000_000));
                evidence.insert(
                    "loongsuite.trae_cn.request_to_first_token_ns".into(),
                    json!(first.saturating_sub(started).saturating_mul(1_000_000)),
                );
                if let Ok(agent_ns) = hr_time_to_nano(agent_start).parse::<i128>() {
                    if let Ok(elapsed) = u64::try_from(i128::from(first) * 1_000_000 - agent_ns) {
                        spans[agent_index]
                            .attributes
                            .insert("gen_ai.response.time_to_first_token".into(), json!(elapsed));
                    }
                }
            }
        }
        if let Some(calls) = round["continuation"]
            .as_str()
            .and_then(|r| by_request.get(r))
        {
            let parts: Vec<_> = calls
                .iter()
                .filter_map(|id| {
                    let id = id.as_str()?;
                    Some(json!({"type":"tool_call_response","id":id,"response":results.get(id)?}))
                })
                .collect();
            if !parts.is_empty() {
                evidence.insert(
                    "gen_ai.input.messages".into(),
                    json!(json!([{"role":"tool","parts":parts}]).to_string()),
                );
            }
        }
        let calls = round["toolIds"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let parts: Vec<_> = assistant
            .iter()
            .copied()
            .filter(|part| {
                (part["type"] == "text" && round["terminal"] == true)
                    || (part["type"] == "tool_call" && calls.contains(&part["id"]))
                    || (part["type"] == "reasoning" && calls.contains(&part["tool_call_id"]))
            })
            .collect();
        if !parts.is_empty() {
            evidence.insert(
                "gen_ai.output.messages".into(),
                json!(json!([{"role":"assistant","parts":parts}]).to_string()),
            );
        }
        if let Some((input, output)) = round["input"].as_u64().zip(round["output"].as_u64()) {
            if let Some(total) = input.checked_add(output) {
                for (key, value) in [
                    ("input_tokens", Some(input)),
                    ("output_tokens", Some(output)),
                    ("total_tokens", Some(total)),
                    (
                        "cache_read.input_tokens",
                        round["cached"].as_u64().filter(|n| *n <= input),
                    ),
                    (
                        "cache_creation.input_tokens",
                        round["cacheCreated"].as_u64().filter(|n| *n <= input),
                    ),
                    (
                        "reasoning_tokens",
                        round["reasoning"].as_u64().filter(|n| *n <= output),
                    ),
                ] {
                    if let Some(value) = value {
                        evidence.insert(format!("gen_ai.usage.{key}"), json!(value));
                    }
                }
            }
        }
        let owner = if let Some(shared_request) = shared_request {
            for (source, target) in [
                ("streamReceived", "usage_received"),
                ("streamExpected", "usage_expected"),
                ("streamTokens", "total_tokens_observed"),
            ] {
                if let Some(value) = round[source].as_u64() {
                    evidence.insert(format!("agent.trae-cn.hub.{target}"), json!(value));
                }
            }
            if let Some(&owner) = shared.get(shared_request) {
                let stream = &mut observed[owner];
                time_bounds(
                    stream,
                    stream.start_time.min(step_start),
                    stream.end_time.max(end),
                );
                stream.attributes.extend(evidence);
                owner
            } else {
                let span_id = id_digest(&llm.trace_id, "stream", shared_request, 16);
                let mut attrs = context(&step, shared_request, Some(shared_request));
                attrs.insert(OBSERVATION.into(), json!("stream_summary"));
                attrs.extend(evidence);
                let mut stream = leaf(&step, span_id, &agent_id, (step_start, end), attrs);
                stream.name = "response stream (multiple model responses)".into();
                let owner = observed.len();
                shared.insert(shared_request.into(), owner);
                observed.push(stream);
                owner
            }
        } else {
            llm_attrs.extend(evidence);
            observed.len()
        };
        for call in calls.iter().filter_map(Value::as_str) {
            parents
                .entry(call.into())
                .and_modify(|prior| {
                    if *prior != owner {
                        *prior = usize::MAX;
                    }
                })
                .or_insert(owner);
        }
        let step_id = id_digest(&llm.trace_id, "round", id, 16);
        observed.push(leaf(
            &step,
            step_id.clone(),
            &agent_id,
            (step_start, end),
            step_attrs,
        ));
        observed.push(leaf(
            &llm,
            id_digest(&llm.trace_id, "llm", id, 16),
            &step_id,
            (start, end),
            llm_attrs,
        ));
    }
    let mut unassigned = false;
    for span in spans
        .iter_mut()
        .filter(|span| span.parent_span_id.as_ref() == Some(&step.span_id) && kind(span, "TOOL"))
    {
        let owner = span
            .attributes
            .get("gen_ai.tool.call.id")
            .and_then(Value::as_str)
            .and_then(|id| parents.get(id))
            .and_then(|&i| observed.get_mut(i));
        if let Some(owner) = owner {
            span.parent_span_id = Some(owner.span_id.clone());
            for key in ["gen_ai.step.id", STREAM] {
                if let Some(value) = owner.attributes.get(key) {
                    span.attributes.insert(key.into(), value.clone());
                }
            }
            if owner.name != "response stream (multiple model responses)" {
                if let Some(id) = owner.attributes.get("gen_ai.step.id") {
                    span.attributes
                        .insert("loongsuite.trae_cn.history_id".into(), id.clone());
                }
            }
            time_bounds(
                owner,
                owner.start_time.min(span.start_time),
                owner.end_time.max(span.end_time),
            );
        } else {
            unassigned = true;
        }
    }
    if unassigned {
        spans[step_index].name = "tool execution (round unknown)".into();
        spans[step_index]
            .attributes
            .shift_remove("gen_ai.react.round");
        spans[step_index]
            .attributes
            .insert(OBSERVATION.into(), json!("unattributed_tools"));
    }
    let agent = &mut spans[agent_index];
    for (key, value) in llm.attributes.iter() {
        if key.starts_with("gen_ai.usage.")
            || key.starts_with("agent.trae-cn.hub.")
            || matches!(
                key.as_str(),
                "gen_ai.input.messages" | "gen_ai.output.messages"
            )
        {
            agent.attributes.insert(key.clone(), value.clone());
        }
    }
    if rounds
        .iter()
        .any(|round| round["shared"] == true && round["terminal"] == true)
    {
        agent
            .attributes
            .insert(OBSERVATION.into(), json!("turn_summary"));
    }
    let range = observed
        .iter()
        .fold((agent.start_time, agent.end_time), |(start, end), span| {
            (start.min(span.start_time), end.max(span.end_time))
        });
    time_bounds(agent, range.0, range.1);
    if let Some(root) = agent
        .parent_span_id
        .clone()
        .and_then(|id| spans.iter_mut().find(|span| span.span_id == id))
    {
        time_bounds(
            root,
            root.start_time.min(range.0),
            root.end_time.max(range.1),
        );
    }
    spans
        .retain(|span| span.span_id != llm.span_id && (unassigned || span.span_id != step.span_id));
    spans.extend(observed);
}

fn context(template: &ReadableSpan, id: &str, stream: Option<&str>) -> Map<String, Value> {
    let mut attrs = Map::new();
    for key in [
        "gen_ai.span.kind",
        "gen_ai.operation.name",
        "gen_ai.agent.name",
        "gen_ai.agent.id",
        "gen_ai.session.id",
        "gen_ai.conversation.id",
        "gen_ai.provider.name",
        "gen_ai.turn.id",
        "gen_ai.user.id",
        "gen_ai.request.model",
        "workspace.path",
        "workspace.current_root",
        "git.repo",
        "git.branch",
        "git.domain",
    ] {
        if let Some(value) = template.attributes.get(key) {
            attrs.insert(key.into(), value.clone());
        }
    }
    attrs.insert("gen_ai.step.id".into(), json!(id));
    attrs.insert(OBSERVATION.into(), json!("response_recorded"));
    if let Some(stream) = stream {
        attrs.insert(STREAM.into(), json!(stream));
    }
    attrs
}

fn leaf(
    template: &ReadableSpan,
    id: String,
    parent: &str,
    (start, end): ([i64; 2], [i64; 2]),
    attributes: Map<String, Value>,
) -> ReadableSpan {
    let mut span = ReadableSpan::minimal(&template.name, &template.trace_id, &id);
    span.parent_span_id = Some(parent.into());
    span.kind = template.kind;
    span.resource_attributes
        .clone_from(&template.resource_attributes);
    span.attributes = attributes;
    time_bounds(&mut span, start, end);
    span
}

fn time_bounds(span: &mut ReadableSpan, start: [i64; 2], end: [i64; 2]) {
    span.start_time = start;
    span.end_time = end;
    let nanos = |time: [i64; 2]| i128::from(time[0]) * 1_000_000_000 + i128::from(time[1]);
    span.duration = nano_to_hr_time(nanos(end) - nanos(start));
}

fn nanos(value: &Value) -> Option<i128> {
    value
        .as_str()
        .filter(|value| {
            !value.is_empty() && value.len() <= 19 && value.bytes().all(|b| b.is_ascii_digit())
        })?
        .parse()
        .ok()
}

fn decode_messages(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(serialized)) => serde_json::from_str(serialized).unwrap_or(Value::Null),
        Some(value) if value.is_array() => value.clone(),
        _ => Value::Null,
    }
}

fn has_message(value: Option<&Value>) -> bool {
    decode_messages(value)
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["parts"].as_array().into_iter().flatten())
        .any(|part| match part["type"].as_str() {
            Some("tool_call") => part["name"].as_str().is_some_and(|s| !s.trim().is_empty()),
            Some("tool_call_response") => part.get("response").is_some_and(|value| {
                !value.is_null() && !value.as_str().is_some_and(|s| s.trim().is_empty())
            }),
            _ => part["content"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty()),
        })
}

fn omit_empty_models(spans: &mut Vec<ReadableSpan>) {
    let removed: HashMap<_, _> = spans
        .iter()
        .filter(|span| {
            kind(span, "LLM")
                && (!has_message(span.attributes.get("gen_ai.input.messages"))
                    || !has_message(span.attributes.get("gen_ai.output.messages")))
        })
        .map(|span| (span.span_id.clone(), span.parent_span_id.clone()))
        .collect();
    spans.retain(|span| !removed.contains_key(&span.span_id));
    for span in spans.iter_mut() {
        if let Some(parent) = span.parent_span_id.as_ref().and_then(|id| removed.get(id)) {
            span.parent_span_id.clone_from(parent);
        }
    }
    let owned: HashSet<_> = spans
        .iter()
        .filter_map(|span| span.parent_span_id.clone())
        .collect();
    spans.retain(|span| !kind(span, "STEP") || owned.contains(&span.span_id));
}

#[cfg(test)]
#[path = "trae_cn_history_tests.rs"]
mod tests;
