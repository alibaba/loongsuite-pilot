//! Turn records → activity entries. Port of `codex-transcript-builder.ts`.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::normalization::{build_agent_activity_entry, timestamp_to_unix_nanos};
use crate::types::AgentActivityEntry;

use super::types::{
    CodexExtractedTranscriptTurn, CodexTranscriptInputContext, CodexTranscriptStep,
    CodexTranscriptTool, CodexTranscriptUsage, JsonValue,
};
use super::utils::json_bytes;

const MAX_INPUT_MESSAGES_BYTES: usize = 1024 * 1024;

fn initial_input_hash() -> String {
    hash_id(&[""], 32)
}

#[derive(Clone, Debug)]
pub struct CodexTranscriptBuildOptions {
    pub include_prompt: bool,
    pub start_step_number: u64,
    pub input_context: Option<CodexTranscriptInputContext>,
    pub context_step_count: Option<usize>,
}

impl Default for CodexTranscriptBuildOptions {
    fn default() -> Self {
        Self {
            include_prompt: true,
            start_step_number: 1,
            input_context: None,
            context_step_count: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct CodexTranscriptBuildResult {
    pub entries: Vec<AgentActivityEntry>,
    pub next_input_context: CodexTranscriptInputContext,
}

pub fn build_codex_transcript_entries(
    turn: &CodexExtractedTranscriptTurn,
    opts: &CodexTranscriptBuildOptions,
) -> Vec<AgentActivityEntry> {
    build_codex_transcript_segment(turn, opts).entries
}

pub fn build_codex_transcript_segment(
    turn: &CodexExtractedTranscriptTurn,
    opts: &CodexTranscriptBuildOptions,
) -> CodexTranscriptBuildResult {
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
    let turn_id = format!("{}:{}", turn.session_id, turn.transcript_turn_id);
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
    base.insert("gen_ai.turn.id".into(), Value::String(turn_id.clone()));
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
    if turn.status == super::types::CodexTerminalStatus::Interrupted {
        base.insert(
            "agent.codex.turn_status".into(),
            Value::String("interrupted".into()),
        );
    }
    if let Some(cwd) = &turn.cwd {
        base.insert("agent.codex.cwd".into(), Value::String(cwd.clone()));
    }

    let mut records = Vec::new();
    let mut input_context = opts
        .input_context
        .clone()
        .unwrap_or_else(|| initial_input_context(turn));
    let context_step_count = opts.context_step_count.unwrap_or(turn.steps.len());
    let mut next_input_context = input_context.clone();

    if opts.include_prompt && turn.prompt_ready {
        if let Some(prompt) = &turn.prompt {
            if !prompt.is_empty() {
                let mut fields = base.clone();
                fields.insert("timestamp".into(), json_ms(turn.started_at_ms));
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
        }
    }

    for (index, step) in turn.steps.iter().enumerate() {
        let step_number = opts.start_step_number + index as u64;
        let step_number_text = step_number.to_string();
        let step_id = format!("{turn_id}:s{step_number}");
        let step_span_id = hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "step",
                step_number_text.as_str(),
            ],
            16,
        );
        let llm_span_id = hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "llm",
                step_number_text.as_str(),
            ],
            16,
        );
        let response_id = step
            .response_id
            .clone()
            .unwrap_or_else(|| format!("{turn_id}:r{step_number}"));
        let input_messages = input_context.delta.clone().unwrap_or_default();
        let output_input_messages = input_context
            .full_messages
            .clone()
            .unwrap_or_else(|| input_messages.clone());

        let mut request = base.clone();
        request.insert("timestamp".into(), json_ms(step.started_at_ms));
        request.insert(
            "event.id".into(),
            Value::String(hash_id(
                &[
                    turn.session_id.as_str(),
                    turn.transcript_turn_id.as_str(),
                    "request",
                    step_number_text.as_str(),
                ],
                32,
            )),
        );
        request.insert("event.name".into(), Value::String("llm.request".into()));
        request.insert("span_id".into(), Value::String(llm_span_id.clone()));
        request.insert("parent_span_id".into(), Value::String(step_span_id.clone()));
        request.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        request.insert(
            "gen_ai.request.model".into(),
            Value::String(model.to_owned()),
        );
        request.insert(
            "gen_ai.response.id".into(),
            Value::String(response_id.clone()),
        );
        request.insert(
            "gen_ai.input.messages_hash".into(),
            Value::String(input_context.hash.clone()),
        );
        if !input_messages.is_empty() {
            request.insert(
                "gen_ai.input.messages_delta".into(),
                Value::Array(input_messages),
            );
        }
        if !output_input_messages.is_empty() {
            request.insert(
                "gen_ai.input.messages".into(),
                Value::Array(output_input_messages),
            );
        }
        extend_shared_llm(&mut request, turn);
        records.push(build_entry(request));

        let terminal_step = index + 1 == turn.steps.len();
        let messages = response_messages(turn, step, terminal_step);
        let mut response = base.clone();
        response.insert("timestamp".into(), json_ms(step.response_at_ms));
        response.insert(
            "event.id".into(),
            Value::String(hash_id(
                &[
                    turn.session_id.as_str(),
                    turn.transcript_turn_id.as_str(),
                    "response",
                    step_number_text.as_str(),
                ],
                32,
            )),
        );
        response.insert("event.name".into(), Value::String("llm.response".into()));
        response.insert("span_id".into(), Value::String(llm_span_id));
        response.insert("parent_span_id".into(), Value::String(step_span_id.clone()));
        response.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
        response.insert(
            "gen_ai.request.model".into(),
            Value::String(model.to_owned()),
        );
        response.insert(
            "gen_ai.response.model".into(),
            Value::String(model.to_owned()),
        );
        response.insert("gen_ai.response.id".into(), Value::String(response_id));
        response.insert(
            "gen_ai.response.finish_reasons".into(),
            finish_reasons(turn, step, terminal_step),
        );
        if !messages.is_empty() {
            response.insert("gen_ai.output.messages".into(), Value::Array(messages));
        }
        extend_usage(&mut response, step.token_usage.as_ref());
        records.push(build_entry(response));

        for (tool_index, tool) in step.tools.iter().enumerate() {
            records.extend(build_tool_entries(
                turn,
                tool,
                tool_index,
                &base,
                &step_id,
                &step_span_id,
            ));
        }

        input_context = advance_input_context(&input_context, step);
        if index + 1 == context_step_count {
            next_input_context = input_context.clone();
        }
    }

    CodexTranscriptBuildResult {
        entries: records,
        next_input_context,
    }
}

fn initial_input_context(turn: &CodexExtractedTranscriptTurn) -> CodexTranscriptInputContext {
    let delta = if turn
        .steps
        .first()
        .and_then(|step| step.input_messages.as_ref())
        .is_some_and(|messages| !messages.is_empty())
    {
        turn.steps[0].input_messages.clone().unwrap_or_default()
    } else if !turn.input_messages.is_empty() {
        turn.input_messages.clone()
    } else if let Some(prompt) = &turn.prompt {
        vec![json!({ "role": "user", "parts": [{ "type": "text", "content": prompt }] })]
    } else {
        Vec::new()
    };
    context_from_messages(&initial_input_hash(), Some(&Vec::new()), &delta)
}

fn advance_input_context(
    context: &CodexTranscriptInputContext,
    step: &CodexTranscriptStep,
) -> CodexTranscriptInputContext {
    let delta = next_input_messages_for_step(step);
    context_from_messages(&context.hash, context.full_messages.as_ref(), &delta)
}

fn context_from_messages(
    previous_hash: &str,
    previous_full: Option<&Vec<JsonValue>>,
    delta: &[JsonValue],
) -> CodexTranscriptInputContext {
    let full_messages = previous_full.map(|previous| {
        let mut next = previous.clone();
        next.extend(delta.iter().cloned());
        next
    });
    let retain = full_messages.as_ref().is_some_and(|messages| {
        json_bytes(&Value::Array(messages.clone())) <= MAX_INPUT_MESSAGES_BYTES
    });
    CodexTranscriptInputContext {
        hash: hash_input_messages(previous_hash, delta),
        delta: Some(delta.to_vec()),
        full_messages: if retain { full_messages } else { None },
        delta_range: None,
    }
}

pub fn next_input_messages_for_step(step: &CodexTranscriptStep) -> Vec<JsonValue> {
    let completed: Vec<&CodexTranscriptTool> = step
        .tools
        .iter()
        .filter(|tool| tool.completed_at_ms.is_some())
        .collect();
    let mut messages = Vec::new();
    if let Some(message) = assistant_tool_call_message(&completed) {
        messages.push(message);
    }
    if let Some(message) = tool_response_message(&completed) {
        messages.push(message);
    }
    messages
}

fn assistant_tool_call_message(tools: &[&CodexTranscriptTool]) -> Option<JsonValue> {
    if tools.is_empty() {
        return None;
    }
    Some(json!({
        "role": "assistant",
        "parts": tools.iter().map(|tool| json!({
            "type": "tool_call",
            "id": tool.call_id,
            "name": tool.name,
            "arguments": tool.input.clone().unwrap_or(Value::Null),
        })).collect::<Vec<_>>(),
    }))
}

fn tool_response_message(tools: &[&CodexTranscriptTool]) -> Option<JsonValue> {
    if tools.is_empty() {
        return None;
    }
    Some(json!({
        "role": "tool",
        "parts": tools.iter().map(|tool| json!({
            "type": "tool_call_response",
            "id": tool.call_id,
            "response": tool.output.clone().unwrap_or(Value::Null),
        })).collect::<Vec<_>>(),
    }))
}

fn finish_reasons(
    turn: &CodexExtractedTranscriptTurn,
    step: &CodexTranscriptStep,
    terminal_step: bool,
) -> Value {
    if terminal_step && turn.status == super::types::CodexTerminalStatus::Interrupted {
        return json!(["cancelled"]);
    }
    if !step.tools.is_empty() {
        return json!(["tool_call"]);
    }
    if step.token_usage.is_some()
        || (terminal_step && turn.status == super::types::CodexTerminalStatus::Completed)
    {
        return json!(["stop"]);
    }
    json!([])
}

fn response_messages(
    turn: &CodexExtractedTranscriptTurn,
    step: &CodexTranscriptStep,
    terminal_step: bool,
) -> Vec<JsonValue> {
    let mut parts = Vec::new();
    for content in &step.reasoning {
        parts.push(json!({ "type": "reasoning", "content": content }));
    }
    for tool in &step.tools {
        parts.push(json!({
            "type": "tool_call",
            "id": tool.call_id,
            "name": tool.name,
            "arguments": tool.input.clone().unwrap_or(Value::Null),
        }));
    }
    if let Some(text) = &step.final_text {
        parts.push(json!({ "type": "text", "content": text }));
    }
    if parts.is_empty() {
        return Vec::new();
    }
    let finish_reason =
        if terminal_step && turn.status == super::types::CodexTerminalStatus::Interrupted {
            "cancelled"
        } else if !step.tools.is_empty() {
            "tool_call"
        } else {
            "stop"
        };
    vec![json!({ "role": "assistant", "parts": parts, "finish_reason": finish_reason })]
}

fn build_tool_entries(
    turn: &CodexExtractedTranscriptTurn,
    tool: &CodexTranscriptTool,
    index: usize,
    base: &Map<String, Value>,
    step_id: &str,
    step_span_id: &str,
) -> Vec<AgentActivityEntry> {
    let span_id = codex_tool_span_id(&turn.session_id, &turn.transcript_turn_id, &tool.call_id);
    let index_text = index.to_string();
    let mut call = base.clone();
    call.insert("timestamp".into(), json_ms(tool.started_at_ms));
    call.insert(
        "event.id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "tool-call",
                tool.call_id.as_str(),
                index_text.as_str(),
            ],
            32,
        )),
    );
    call.insert("event.name".into(), Value::String("tool.call".into()));
    call.insert("span_id".into(), Value::String(span_id.clone()));
    call.insert(
        "parent_span_id".into(),
        Value::String(step_span_id.to_owned()),
    );
    call.insert("gen_ai.step.id".into(), Value::String(step_id.to_owned()));
    call.insert("gen_ai.tool.name".into(), Value::String(tool.name.clone()));
    call.insert(
        "gen_ai.tool.call.id".into(),
        Value::String(tool.call_id.clone()),
    );
    if let Some(input) = &tool.input {
        call.insert("gen_ai.tool.call.arguments".into(), input.clone());
    }
    let mut records = vec![build_entry(call)];

    let completed = tool.completed_at_ms.is_some();
    let mut result = base.clone();
    result.insert(
        "timestamp".into(),
        json_ms(if completed {
            tool.completed_at_ms.unwrap_or(turn.terminal_at_ms)
        } else {
            turn.terminal_at_ms
        }),
    );
    result.insert(
        "event.id".into(),
        Value::String(hash_id(
            &[
                turn.session_id.as_str(),
                turn.transcript_turn_id.as_str(),
                "tool-result",
                tool.call_id.as_str(),
                index_text.as_str(),
            ],
            32,
        )),
    );
    result.insert("event.name".into(), Value::String("tool.result".into()));
    result.insert("span_id".into(), Value::String(span_id));
    result.insert(
        "parent_span_id".into(),
        Value::String(step_span_id.to_owned()),
    );
    result.insert("gen_ai.step.id".into(), Value::String(step_id.to_owned()));
    result.insert("gen_ai.tool.name".into(), Value::String(tool.name.clone()));
    result.insert(
        "gen_ai.tool.call.id".into(),
        Value::String(tool.call_id.clone()),
    );
    result.insert(
        "tool.result.status".into(),
        Value::String(if completed { "success" } else { "cancelled" }.into()),
    );
    if completed {
        if let Some(output) = &tool.output {
            result.insert("gen_ai.tool.call.result".into(), output.clone());
        }
    }
    if let Some(completed_at) = tool.completed_at_ms {
        let duration = completed_at - tool.started_at_ms;
        if duration >= 0.0 {
            result.insert("gen_ai.tool.call.duration".into(), json_ms(duration));
        }
    }
    records.push(build_entry(result));
    records
}

fn extend_usage(fields: &mut Map<String, Value>, usage: Option<&CodexTranscriptUsage>) {
    let resolved = usage.cloned().unwrap_or(CodexTranscriptUsage {
        input_tokens: 0.0,
        output_tokens: 0.0,
        cached_input_tokens: 0.0,
        cache_creation_tokens: 0.0,
        reasoning_output_tokens: None,
        total_tokens: 0.0,
    });
    fields.insert(
        "gen_ai.usage.input_tokens".into(),
        json_ms(resolved.input_tokens),
    );
    fields.insert(
        "gen_ai.usage.output_tokens".into(),
        json_ms(resolved.output_tokens),
    );
    fields.insert(
        "gen_ai.usage.cache_read.input_tokens".into(),
        json_ms(resolved.cached_input_tokens),
    );
    fields.insert(
        "gen_ai.usage.cache_creation.input_tokens".into(),
        json_ms(resolved.cache_creation_tokens),
    );
    fields.insert(
        "gen_ai.usage.total_tokens".into(),
        json_ms(resolved.total_tokens),
    );
    if let Some(reasoning) = resolved.reasoning_output_tokens {
        fields.insert(
            "gen_ai.usage.reasoning_output_tokens".into(),
            json_ms(reasoning),
        );
    }
}

fn extend_shared_llm(fields: &mut Map<String, Value>, turn: &CodexExtractedTranscriptTurn) {
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

fn build_entry(fields: Map<String, Value>) -> AgentActivityEntry {
    let timestamp = fields
        .get("timestamp")
        .cloned()
        .unwrap_or_else(|| json_ms(super::utils::now_ms()));
    let mut rest = fields;
    rest.insert(
        "time_unix_nano".into(),
        Value::String(timestamp_to_unix_nanos(Some(&timestamp))),
    );
    rest.insert("timestamp".into(), timestamp);
    build_agent_activity_entry(&Value::Object(rest))
}

fn json_ms(value: f64) -> Value {
    super::utils::json_number(value)
}

pub fn hash_id(parts: &[&str], length: usize) -> String {
    let mut hasher = Sha256::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hasher.update([0]);
        }
        hasher.update(part.as_bytes());
    }
    let digest = hex::encode(hasher.finalize());
    digest.chars().take(length).collect()
}

pub fn codex_tool_span_id(session_id: &str, turn_id: &str, tool_call_id: &str) -> String {
    hash_id(&[session_id, turn_id, "tool", tool_call_id], 16)
}

fn hash_input_messages(previous_hash: &str, messages: &[JsonValue]) -> String {
    let mut hash = previous_hash.to_owned();
    for message in messages {
        let mut hasher = Sha256::new();
        hasher.update(hash.as_bytes());
        hasher.update(stable_serialize(message).as_bytes());
        hash = hex::encode(hasher.finalize());
        hash.truncate(32);
    }
    hash
}

fn stable_serialize(value: &JsonValue) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => {
            if *flag {
                "true".to_owned()
            } else {
                "false".to_owned()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned()),
        Value::Array(items) => {
            let parts = items.iter().map(stable_serialize).collect::<Vec<_>>();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let parts = keys
                .into_iter()
                .map(|key| {
                    let rendered =
                        serde_json::to_string(&key).unwrap_or_else(|_| "\"\"".to_owned());
                    format!(
                        "{rendered}:{}",
                        stable_serialize(map.get(&key).unwrap_or(&Value::Null))
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", parts.join(","))
        }
    }
}
