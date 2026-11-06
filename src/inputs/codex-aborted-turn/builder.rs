//! Port of `codex-aborted-turn-builder.ts`.

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::normalization::{build_agent_activity_entry, timestamp_to_unix_nanos};
use crate::types::AgentActivityEntry;

use super::types::{
    AssistantMessage, CodexExtractedAbortedTurn, CodexTokenUsage, CodexTokenUsageSample,
    TimelineEvent, ToolCall, ToolResult,
};
use super::utils::now_ms;

struct ToolWave {
    calls: Vec<ToolCall>,
    results: HashMap<String, ToolResult>,
    has_result: bool,
}

pub fn build_codex_aborted_turn_entries(
    turn: &CodexExtractedAbortedTurn,
) -> Vec<AgentActivityEntry> {
    let trace_id = hash_id(
        &[
            turn.session_id.as_str(),
            turn.transcript_turn_id.as_str(),
            "trace",
        ],
        32,
    );
    let agent_span_id = hash_id(
        &[
            turn.session_id.as_str(),
            turn.transcript_turn_id.as_str(),
            "agent",
        ],
        16,
    );
    let turn_id = format!("{}:aborted:{}", turn.session_id, turn.transcript_turn_id);
    let model = if turn.model.is_empty() {
        "unknown"
    } else {
        turn.model.as_str()
    };
    let mut base = Map::new();
    base.insert("trace_id".into(), Value::String(trace_id));
    base.insert(
        "gen_ai.session.id".into(),
        Value::String(turn.session_id.clone()),
    );
    base.insert("gen_ai.turn.id".into(), Value::String(turn_id));
    base.insert("gen_ai.agent.type".into(), Value::String("codex".into()));
    base.insert(
        "gen_ai.agent.id".into(),
        Value::String(turn.session_id.clone()),
    );
    base.insert(
        "gen_ai.provider.name".into(),
        Value::String(turn.provider.clone()),
    );
    base.insert(
        "agent.codex.transcript_turn_id".into(),
        Value::String(turn.transcript_turn_id.clone()),
    );
    base.insert(
        "agent.codex.turn_status".into(),
        Value::String("interrupted".into()),
    );
    if let Some(cwd) = &turn.cwd {
        base.insert("agent.codex.cwd".into(), Value::String(cwd.clone()));
    }

    let mut timeline = turn.timeline.clone();
    timeline.sort_by(|left, right| {
        left.timestamp_ms()
            .partial_cmp(&right.timestamp_ms())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.sequence().cmp(&right.sequence()))
    });
    let waves = build_tool_waves(&timeline);
    let messages_by_step = group_messages_by_step(&timeline, &waves);
    let usage_by_step =
        group_usage_by_step(&turn.usage_samples, &timeline, &waves, &messages_by_step);
    let mut records = Vec::new();

    if let Some(prompt) = &turn.prompt {
        let mut fields = base.clone();
        fields.insert("timestamp".into(), num(turn.started_at_ms));
        fields.insert(
            "event.id".into(),
            Value::String(hash_id(
                &[
                    turn.session_id.as_str(),
                    turn.transcript_turn_id.as_str(),
                    "other",
                ],
                32,
            )),
        );
        fields.insert("event.name".into(), Value::String("other".into()));
        fields.insert("span_id".into(), Value::String(agent_span_id));
        fields.insert(
            "parent_span_id".into(),
            Value::String("0000000000000001".into()),
        );
        fields.insert(
            "gen_ai.input.messages_delta".into(),
            json!([{ "role": "user", "parts": [{ "type": "text", "content": prompt }] }]),
        );
        records.push(build_entry(fields));
    }

    let prompt_messages = turn.prompt.as_ref().map(
        |prompt| json!([{ "role": "user", "parts": [{ "type": "text", "content": prompt }] }]),
    );
    records.push(build_llm_request(
        turn,
        &base,
        model,
        1,
        turn.started_at_ms,
        prompt_messages,
    ));

    for (index, wave) in waves.iter().enumerate() {
        let step = index + 1;
        if step > 1 {
            let previous = &waves[index - 1];
            records.push(build_llm_request(
                turn,
                &base,
                model,
                step as u64,
                request_timestamp(previous),
                tool_result_input(previous),
            ));
        }
        let messages = messages_by_step.get(&step).cloned().unwrap_or_default();
        records.push(build_tool_call_response(
            turn,
            &base,
            model,
            step as u64,
            wave,
            &messages,
            usage_by_step.get(&step),
        ));
        for tool in &wave.calls {
            records.extend(build_tool_entries(
                turn,
                tool,
                wave.results.get(&tool.call_id),
                &base,
                step as u64,
            ));
        }
    }

    let final_step = waves.len() + 1;
    if let Some(previous) = waves.last() {
        records.push(build_llm_request(
            turn,
            &base,
            model,
            final_step as u64,
            request_timestamp(previous),
            tool_result_input(previous),
        ));
    }
    let final_messages = messages_by_step
        .get(&final_step)
        .cloned()
        .unwrap_or_default();
    records.push(build_cancelled_response(
        turn,
        &base,
        model,
        final_step as u64,
        &final_messages,
        usage_by_step.get(&final_step),
    ));
    records
}

fn build_tool_waves(timeline: &[TimelineEvent]) -> Vec<ToolWave> {
    let mut waves: Vec<ToolWave> = Vec::new();
    let mut call_waves: HashMap<String, usize> = HashMap::new();
    let mut current: Option<usize> = None;
    for event in timeline {
        if let TimelineEvent::ToolCall(call) = event {
            let start_new = match current {
                None => true,
                Some(index) => waves[index].has_result,
            };
            if start_new {
                waves.push(ToolWave {
                    calls: Vec::new(),
                    results: HashMap::new(),
                    has_result: false,
                });
                current = Some(waves.len() - 1);
            }
            let index = current.expect("wave");
            waves[index].calls.push(call.clone());
            call_waves.insert(call.call_id.clone(), index);
            continue;
        }
        let TimelineEvent::ToolResult(result) = event else {
            continue;
        };
        let Some(index) = call_waves.get(&result.call_id).copied() else {
            continue;
        };
        waves[index]
            .results
            .insert(result.call_id.clone(), result.clone());
        waves[index].has_result = true;
    }
    waves
}

fn group_messages_by_step(
    timeline: &[TimelineEvent],
    waves: &[ToolWave],
) -> HashMap<usize, Vec<AssistantMessage>> {
    let last_result_sequence: Vec<u64> = waves
        .iter()
        .filter_map(|wave| wave.results.values().map(|result| result.sequence).max())
        .collect();
    let mut messages_by_step: HashMap<usize, Vec<AssistantMessage>> = HashMap::new();
    for event in timeline {
        let TimelineEvent::Assistant(message) = event else {
            continue;
        };
        let step = 1 + last_result_sequence
            .iter()
            .filter(|sequence| **sequence < message.sequence)
            .count();
        messages_by_step
            .entry(step)
            .or_default()
            .push(message.clone());
    }
    messages_by_step
}

fn group_usage_by_step(
    samples: &[CodexTokenUsageSample],
    timeline: &[TimelineEvent],
    waves: &[ToolWave],
    messages_by_step: &HashMap<usize, Vec<AssistantMessage>>,
) -> HashMap<usize, CodexTokenUsage> {
    let mut tool_steps = HashMap::new();
    for (index, wave) in waves.iter().enumerate() {
        for call in &wave.calls {
            tool_steps.insert(call.call_id.clone(), index + 1);
        }
    }
    let mut message_steps = HashMap::new();
    for (step, messages) in messages_by_step {
        for message in messages {
            message_steps.insert(message.sequence, *step);
        }
    }
    let mut boundaries = Vec::new();
    for event in timeline {
        match event {
            TimelineEvent::ToolCall(call) => boundaries.push((
                call.timestamp_ms,
                call.sequence,
                tool_steps.get(&call.call_id).copied().unwrap_or(1),
            )),
            TimelineEvent::Assistant(message) => {
                if let Some(step) = message_steps.get(&message.sequence).copied() {
                    boundaries.push((message.timestamp_ms, message.sequence, step));
                }
            }
            TimelineEvent::ToolResult(_) => {}
        }
    }
    boundaries.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.1.cmp(&right.1))
    });
    let mut usage_by_step = HashMap::new();
    for sample in samples {
        let mut latest = None;
        for boundary in &boundaries {
            let is_before = boundary.0 < sample.timestamp_ms
                || (boundary.0 == sample.timestamp_ms && boundary.1 < sample.sequence);
            if is_before {
                latest = Some(*boundary);
            } else {
                break;
            }
        }
        if let Some((_, _, step)) = latest {
            usage_by_step.insert(step, sample.usage.clone());
        }
    }
    usage_by_step
}

fn extend_usage(fields: &mut Map<String, Value>, usage: Option<&CodexTokenUsage>) {
    let Some(usage) = usage else {
        return;
    };
    fields.insert("gen_ai.usage.input_tokens".into(), num(usage.input_tokens));
    fields.insert(
        "gen_ai.usage.output_tokens".into(),
        num(usage.output_tokens),
    );
    fields.insert(
        "gen_ai.usage.cache_read.input_tokens".into(),
        num(usage.cached_input_tokens),
    );
    fields.insert(
        "gen_ai.usage.cache_creation.input_tokens".into(),
        num(usage.cache_creation_tokens),
    );
    fields.insert("gen_ai.usage.total_tokens".into(), num(usage.total_tokens));
    if let Some(reasoning) = usage.reasoning_output_tokens {
        fields.insert(
            "gen_ai.usage.reasoning_output_tokens".into(),
            num(reasoning),
        );
    }
}

fn build_llm_request(
    turn: &CodexExtractedAbortedTurn,
    base: &Map<String, Value>,
    model: &str,
    step: u64,
    timestamp: f64,
    input_messages: Option<Value>,
) -> AgentActivityEntry {
    let step_text = step.to_string();
    let turn_id = base
        .get("gen_ai.turn.id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut fields = base.clone();
    fields.insert("timestamp".into(), num(timestamp));
    fields.insert(
        "event.id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "request",
                step_text.as_str(),
            ],
            32,
        )),
    );
    fields.insert("event.name".into(), Value::String("llm.request".into()));
    fields.insert(
        "span_id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "llm",
                step_text.as_str(),
            ],
            16,
        )),
    );
    fields.insert(
        "parent_span_id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "step",
                step_text.as_str(),
            ],
            16,
        )),
    );
    fields.insert(
        "gen_ai.step.id".into(),
        Value::String(format!("{turn_id}:s{step}")),
    );
    fields.insert(
        "gen_ai.request.model".into(),
        Value::String(model.to_owned()),
    );
    if let Some(messages) = input_messages {
        fields.insert("gen_ai.input.messages_delta".into(), messages);
    }
    extend_shared(&mut fields, turn);
    build_entry(fields)
}

fn build_tool_call_response(
    turn: &CodexExtractedAbortedTurn,
    base: &Map<String, Value>,
    model: &str,
    step: u64,
    wave: &ToolWave,
    messages: &[AssistantMessage],
    usage: Option<&CodexTokenUsage>,
) -> AgentActivityEntry {
    let step_text = step.to_string();
    let turn_id = base
        .get("gen_ai.turn.id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let timestamp = wave
        .calls
        .first()
        .map(|call| call.timestamp_ms)
        .unwrap_or(0.0);
    let mut fields = base.clone();
    fields.insert("timestamp".into(), num(timestamp));
    fields.insert(
        "event.id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "response",
                step_text.as_str(),
            ],
            32,
        )),
    );
    fields.insert("event.name".into(), Value::String("llm.response".into()));
    fields.insert(
        "span_id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "llm",
                step_text.as_str(),
            ],
            16,
        )),
    );
    fields.insert(
        "parent_span_id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "step",
                step_text.as_str(),
            ],
            16,
        )),
    );
    fields.insert(
        "gen_ai.step.id".into(),
        Value::String(format!("{turn_id}:s{step}")),
    );
    fields.insert(
        "gen_ai.request.model".into(),
        Value::String(model.to_owned()),
    );
    fields.insert(
        "gen_ai.response.model".into(),
        Value::String(model.to_owned()),
    );
    fields.insert(
        "gen_ai.response.finish_reasons".into(),
        json!(["tool_call"]),
    );
    fields.insert(
        "gen_ai.output.messages".into(),
        tool_response_messages(messages, &wave.calls),
    );
    extend_usage(&mut fields, usage);
    extend_shared(&mut fields, turn);
    build_entry(fields)
}

fn build_cancelled_response(
    turn: &CodexExtractedAbortedTurn,
    base: &Map<String, Value>,
    model: &str,
    step: u64,
    messages: &[AssistantMessage],
    usage: Option<&CodexTokenUsage>,
) -> AgentActivityEntry {
    let step_text = step.to_string();
    let turn_id = base
        .get("gen_ai.turn.id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut fields = base.clone();
    fields.insert("timestamp".into(), num(turn.aborted_at_ms));
    fields.insert(
        "event.id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "response",
                step_text.as_str(),
            ],
            32,
        )),
    );
    fields.insert("event.name".into(), Value::String("llm.response".into()));
    fields.insert(
        "span_id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "llm",
                step_text.as_str(),
            ],
            16,
        )),
    );
    fields.insert(
        "parent_span_id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "step",
                step_text.as_str(),
            ],
            16,
        )),
    );
    fields.insert(
        "gen_ai.step.id".into(),
        Value::String(format!("{turn_id}:s{step}")),
    );
    fields.insert(
        "gen_ai.request.model".into(),
        Value::String(model.to_owned()),
    );
    fields.insert(
        "gen_ai.response.model".into(),
        Value::String(model.to_owned()),
    );
    fields.insert(
        "gen_ai.response.finish_reasons".into(),
        json!(["cancelled"]),
    );
    fields.insert("gen_ai.turn.end".into(), Value::Bool(true));
    if !messages.is_empty() {
        fields.insert(
            "gen_ai.output.messages".into(),
            json!([{
                "role": "assistant",
                "parts": messages.iter().map(|message| json!({ "type": "reasoning", "content": message.content })).collect::<Vec<_>>(),
                "finish_reason": "cancelled",
            }]),
        );
    }
    extend_usage(&mut fields, usage);
    extend_shared(&mut fields, turn);
    build_entry(fields)
}

fn build_tool_entries(
    turn: &CodexExtractedAbortedTurn,
    tool: &ToolCall,
    result: Option<&ToolResult>,
    base: &Map<String, Value>,
    step: u64,
) -> Vec<AgentActivityEntry> {
    let step_text = step.to_string();
    let turn_id = base
        .get("gen_ai.turn.id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let step_span = hash_id(
        &[
            turn.session_id.as_str(),
            turn.transcript_turn_id.as_str(),
            "step",
            step_text.as_str(),
        ],
        16,
    );
    let span_id = hash_id(
        &[
            turn.session_id.as_str(),
            turn.transcript_turn_id.as_str(),
            "tool",
            tool.call_id.as_str(),
        ],
        16,
    );
    let mut call = base.clone();
    call.insert("timestamp".into(), num(tool.timestamp_ms));
    call.insert(
        "event.id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "tool-call",
                tool.call_id.as_str(),
            ],
            32,
        )),
    );
    call.insert("event.name".into(), Value::String("tool.call".into()));
    call.insert("span_id".into(), Value::String(span_id.clone()));
    call.insert("parent_span_id".into(), Value::String(step_span.clone()));
    call.insert(
        "gen_ai.step.id".into(),
        Value::String(format!("{turn_id}:s{step}")),
    );
    call.insert("gen_ai.tool.name".into(), Value::String(tool.name.clone()));
    call.insert(
        "gen_ai.tool.call.id".into(),
        Value::String(tool.call_id.clone()),
    );
    if let Some(input) = &tool.input {
        call.insert("gen_ai.tool.call.arguments".into(), input.clone());
    }
    let mut records = vec![build_entry(call)];
    let mut result_fields = base.clone();
    result_fields.insert(
        "timestamp".into(),
        num(result
            .map(|item| item.timestamp_ms)
            .unwrap_or(turn.aborted_at_ms)),
    );
    result_fields.insert(
        "event.id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "tool-result",
                tool.call_id.as_str(),
            ],
            32,
        )),
    );
    result_fields.insert("event.name".into(), Value::String("tool.result".into()));
    result_fields.insert("span_id".into(), Value::String(span_id));
    result_fields.insert("parent_span_id".into(), Value::String(step_span));
    result_fields.insert(
        "gen_ai.step.id".into(),
        Value::String(format!("{turn_id}:s{step}")),
    );
    result_fields.insert("gen_ai.tool.name".into(), Value::String(tool.name.clone()));
    result_fields.insert(
        "gen_ai.tool.call.id".into(),
        Value::String(tool.call_id.clone()),
    );
    result_fields.insert(
        "tool.result.status".into(),
        Value::String(
            if result.is_some() {
                "success"
            } else {
                "cancelled"
            }
            .into(),
        ),
    );
    if let Some(result) = result {
        if let Some(output) = &result.output {
            result_fields.insert("gen_ai.tool.call.result".into(), output.clone());
        }
        let duration = result.timestamp_ms - tool.timestamp_ms;
        if duration >= 0.0 {
            result_fields.insert("gen_ai.tool.call.duration".into(), num(duration));
        }
    }
    records.push(build_entry(result_fields));
    records
}

fn request_timestamp(wave: &ToolWave) -> f64 {
    wave.results
        .values()
        .map(|result| result.timestamp_ms)
        .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or_else(|| {
            wave.calls
                .iter()
                .map(|tool| tool.timestamp_ms)
                .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or(0.0)
        })
}

fn tool_result_input(wave: &ToolWave) -> Option<Value> {
    let completed: Vec<Value> = wave
        .calls
        .iter()
        .filter_map(|tool| {
            let result = wave.results.get(&tool.call_id)?;
            Some(json!({
                "type": "tool_call_response",
                "id": tool.call_id,
                "response": result.output.clone().unwrap_or(Value::Null),
            }))
        })
        .collect();
    if completed.is_empty() {
        None
    } else {
        Some(json!([{ "role": "tool", "parts": completed }]))
    }
}

fn tool_response_messages(messages: &[AssistantMessage], tools: &[ToolCall]) -> Value {
    let mut parts = Vec::new();
    for message in messages {
        parts.push(json!({ "type": "reasoning", "content": message.content }));
    }
    for tool in tools {
        parts.push(json!({
            "type": "tool_call",
            "id": tool.call_id,
            "name": tool.name,
            "arguments": tool.input.clone().unwrap_or(Value::Null),
        }));
    }
    json!([{ "role": "assistant", "parts": parts, "finish_reason": "tool_call" }])
}

fn extend_shared(fields: &mut Map<String, Value>, turn: &CodexExtractedAbortedTurn) {
    let mut instructions = Vec::new();
    if let Some(text) = &turn.base_instructions {
        instructions.push(json!({ "type": "text", "content": text }));
    }
    if let Some(text) = &turn.developer_instructions {
        instructions.push(json!({ "type": "text", "content": text }));
    }
    if !instructions.is_empty() {
        fields.insert(
            "gen_ai.system_instructions".into(),
            Value::Array(instructions),
        );
    }
    if let Some(definitions) = &turn.tool_definitions {
        fields.insert("gen_ai.tool.definitions".into(), definitions.clone());
    }
}

fn build_entry(mut fields: Map<String, Value>) -> AgentActivityEntry {
    let timestamp = fields
        .get("timestamp")
        .cloned()
        .unwrap_or_else(|| num(now_ms()));
    fields.insert(
        "time_unix_nano".into(),
        Value::String(timestamp_to_unix_nanos(Some(&timestamp))),
    );
    fields.insert("timestamp".into(), timestamp);
    build_agent_activity_entry(&Value::Object(fields))
}

fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < i64::MAX as f64 {
        Value::Number((value as i64).into())
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

fn hash_id(parts: &[&str], length: usize) -> String {
    let mut hasher = Sha256::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hasher.update([0]);
        }
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
        .chars()
        .take(length)
        .collect()
}
