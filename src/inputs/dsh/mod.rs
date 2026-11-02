//! Raw dsh session events → canonical activity entries.
//!
//! Port of `dsh-event-transform.ts`. Cross-line state lives in
//! [`DshEventAggregatorState`].

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::normalization::{build_agent_activity_entry, to_json_value};
use crate::types::{AgentActivityEntry, ClientType};

const MAX_TURN_CORRELATIONS: usize = 1_024;
const MAX_INPUT_MESSAGES: usize = 2_048;
const MAX_RESOURCE_FIELD_VALUE_LENGTH: usize = 512;
const AGENTTEAMS_RESOURCE_KEYS: &[&str] = &["agentteams.worker.name", "agentteams.instance.id"];

#[derive(Clone, Debug, Default)]
pub struct DshRequestHeader {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub system: Option<String>,
    pub tools: Option<Vec<Value>>,
}

#[derive(Clone, Debug)]
pub struct DshEventAggregatorState {
    pub pending_finish: HashMap<String, String>,
    pub current_turn: Option<f64>,
    pub current_step: Option<f64>,
    pub current_turn_header: Option<DshRequestHeader>,
    pub last_known_header: Option<DshRequestHeader>,
    pub emitted_request: HashSet<String>,
    pub request_start_times: HashMap<String, f64>,
    pub first_output_times: HashMap<String, f64>,
    pub tool_names: HashMap<String, String>,
    pub input_messages: Vec<Value>,
    pub last_request_input_message_count: usize,
    pub input_messages_overflowed: bool,
}

impl Default for DshEventAggregatorState {
    fn default() -> Self {
        new_state()
    }
}

pub fn new_state() -> DshEventAggregatorState {
    DshEventAggregatorState {
        pending_finish: HashMap::new(),
        current_turn: None,
        current_step: None,
        current_turn_header: None,
        last_known_header: None,
        emitted_request: HashSet::new(),
        request_start_times: HashMap::new(),
        first_output_times: HashMap::new(),
        tool_names: HashMap::new(),
        input_messages: Vec::new(),
        last_request_input_message_count: 0,
        input_messages_overflowed: false,
    }
}

fn reset_turn_state(state: &mut DshEventAggregatorState) {
    state.pending_finish.clear();
    state.current_turn = None;
    state.current_step = None;
    state.current_turn_header = None;
    state.emitted_request.clear();
    state.request_start_times.clear();
    state.first_output_times.clear();
    state.tool_names.clear();
    state.input_messages.clear();
    state.last_request_input_message_count = 0;
    state.input_messages_overflowed = false;
}

fn set_bounded_str(map: &mut HashMap<String, String>, key: String, value: String) {
    if !map.contains_key(&key) && map.len() >= MAX_TURN_CORRELATIONS {
        return;
    }
    map.insert(key, value);
}

fn set_bounded_f64(map: &mut HashMap<String, f64>, key: String, value: f64) {
    if !map.contains_key(&key) && map.len() >= MAX_TURN_CORRELATIONS {
        return;
    }
    map.insert(key, value);
}

fn add_input_message(state: &mut DshEventAggregatorState, message: Value) {
    if state.input_messages_overflowed {
        return;
    }
    if state.input_messages.len() >= MAX_INPUT_MESSAGES {
        state.input_messages.clear();
        state.input_messages_overflowed = true;
        return;
    }
    state.input_messages.push(message);
}

fn remember_tool_names(content: &Value, state: &mut DshEventAggregatorState) {
    let Some(parts) = content.as_array() else {
        return;
    };
    for part in parts {
        let Some(value) = part.as_object() else {
            continue;
        };
        if as_str(value.get("type")) != Some("tool-call") {
            continue;
        }
        if let (Some(call_id), Some(name)) = (as_str(value.get("id")), as_str(value.get("name"))) {
            set_bounded_str(&mut state.tool_names, call_id.to_string(), name.to_string());
        }
    }
}

fn is_streamed_output_delta(chunk_type: Option<&str>) -> bool {
    matches!(
        chunk_type,
        Some("reasoning-delta" | "text-delta" | "tool-call-delta")
    )
}

fn step_key(sid: &str, turn: f64, step: f64) -> String {
    format!("{sid}:{}:{}", fmt_num(turn), fmt_num(step))
}

fn trace_id_for(sid: &str, turn: f64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{sid}#turn{}", fmt_num(turn)).as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn ms_to_nano(ms: f64) -> String {
    format!("{}", (ms as i128) * 1_000_000)
}

fn fmt_num(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < (i64::MAX as f64) {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn as_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn as_num(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn as_obj(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn agent_teams_fields(record: &Map<String, Value>) -> Map<String, Value> {
    let Some(raw) = as_obj(record.get("resourceAttributes")) else {
        return Map::new();
    };
    let mut resource_attributes = Map::new();
    for key in AGENTTEAMS_RESOURCE_KEYS {
        let Some(value) = as_str(raw.get(*key))
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if value.len() > MAX_RESOURCE_FIELD_VALUE_LENGTH {
            continue;
        }
        resource_attributes.insert((*key).to_string(), Value::String(value.to_string()));
    }
    if resource_attributes.is_empty() {
        return Map::new();
    }
    let mut out = Map::new();
    if let Some(worker) = resource_attributes.get("agentteams.worker.name").cloned() {
        out.insert("gen_ai.agent.name".to_string(), worker);
    }
    out.insert(
        "resourceAttributes".to_string(),
        Value::Object(resource_attributes),
    );
    out
}

pub fn parse_dsh_request_header(record: &Map<String, Value>) -> Option<DshRequestHeader> {
    if record.get("type").and_then(Value::as_str) != Some("request/header") {
        return None;
    }
    let data = as_obj(record.get("data"))?;
    let header = as_obj(data.get("header"))?;
    let config = as_obj(header.get("config"));
    let parsed = DshRequestHeader {
        model: config.and_then(|config| as_str(config.get("model")).map(str::to_string)),
        provider: config.and_then(|config| as_str(config.get("provider")).map(str::to_string)),
        system: as_str(header.get("system")).map(str::to_string),
        tools: header.get("tools").and_then(Value::as_array).cloned(),
    };
    if parsed.model.is_none()
        && parsed.provider.is_none()
        && parsed.system.is_none()
        && parsed.tools.is_none()
    {
        None
    } else {
        Some(parsed)
    }
}

fn normalize_system_instructions(system: Option<&str>) -> Option<Value> {
    system.map(|system| {
        json_array(vec![json_obj(&[
            ("type", json_str("text")),
            ("content", json_str(system)),
        ])])
    })
}

fn normalize_assistant_parts(content: &Value) -> Vec<Value> {
    let Some(parts) = content.as_array() else {
        return Vec::new();
    };
    parts
        .iter()
        .map(|part| {
            let object = part.as_object();
            let kind = object.and_then(|value| as_str(value.get("type")));
            match kind {
                Some("reasoning") => json_obj(&[
                    ("type", json_str("reasoning")),
                    (
                        "content",
                        json_str(
                            object
                                .and_then(|value| as_str(value.get("text")))
                                .unwrap_or(""),
                        ),
                    ),
                ]),
                Some("text") => json_obj(&[
                    ("type", json_str("text")),
                    (
                        "content",
                        json_str(
                            object
                                .and_then(|value| as_str(value.get("text")))
                                .unwrap_or(""),
                        ),
                    ),
                ]),
                Some("tool-call") => {
                    let mut args = object
                        .and_then(|value| value.get("arguments"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    if let Value::String(text) = &args {
                        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                            args = parsed;
                        }
                    }
                    json_obj(&[
                        ("type", json_str("tool_call")),
                        (
                            "id",
                            json_str(
                                object
                                    .and_then(|value| as_str(value.get("id")))
                                    .unwrap_or(""),
                            ),
                        ),
                        (
                            "name",
                            json_str(
                                object
                                    .and_then(|value| as_str(value.get("name")))
                                    .unwrap_or(""),
                            ),
                        ),
                        ("arguments", args),
                    ])
                }
                _ => json_obj(&[
                    ("type", json_str("text")),
                    ("content", json_str(&part.to_string())),
                ]),
            }
        })
        .collect()
}

fn normalize_text_parts(content: &Value) -> Vec<Value> {
    let Some(parts) = content.as_array() else {
        return Vec::new();
    };
    parts
        .iter()
        .map(|part| {
            let object = part.as_object();
            if object.and_then(|value| as_str(value.get("type"))) == Some("text") {
                json_obj(&[
                    ("type", json_str("text")),
                    (
                        "content",
                        json_str(
                            object
                                .and_then(|value| as_str(value.get("text")))
                                .unwrap_or(""),
                        ),
                    ),
                ])
            } else {
                json_obj(&[
                    ("type", json_str("text")),
                    ("content", json_str(&part.to_string())),
                ])
            }
        })
        .collect()
}

struct EmbeddedStreamFacts {
    first_chunk_time: Option<f64>,
    first_output_time: Option<f64>,
    finish_kind: Option<String>,
}

fn read_embedded_stream(value: Option<&Value>) -> Option<EmbeddedStreamFacts> {
    let stream = value?.as_array()?;
    let mut facts = EmbeddedStreamFacts {
        first_chunk_time: None,
        first_output_time: None,
        finish_kind: None,
    };
    for candidate in stream {
        let Some(record) = candidate.as_object() else {
            continue;
        };
        match as_str(record.get("type")) {
            Some("chunk") => {
                let chunk = as_obj(record.get("chunk"));
                let time = as_num(record.get("time"));
                if let (Some(time), Some(chunk)) = (time, chunk) {
                    if is_safe_integer(time) {
                        if facts.first_chunk_time.is_none() {
                            facts.first_chunk_time = Some(time);
                        }
                        if is_streamed_output_delta(as_str(chunk.get("type")))
                            && facts.first_output_time.is_none()
                        {
                            facts.first_output_time = Some(time);
                        }
                    }
                }
                if chunk
                    .and_then(|chunk| chunk.get("type"))
                    .and_then(Value::as_str)
                    == Some("finish")
                {
                    facts.finish_kind = as_obj(chunk.and_then(|chunk| chunk.get("reason")))
                        .and_then(|reason| as_str(reason.get("kind")))
                        .map(str::to_string);
                }
            }
            Some("text-chunks" | "reasoning-chunks" | "tool-call-chunks") => {
                let kind = as_str(record.get("type")).unwrap_or("");
                let time = as_num(record.get("time0"));
                let members = record
                    .get(if kind == "tool-call-chunks" {
                        "args"
                    } else {
                        "texts"
                    })
                    .and_then(Value::as_array);
                if let Some(time) = time {
                    if is_safe_integer(time) && members.is_some_and(|items| !items.is_empty()) {
                        if facts.first_chunk_time.is_none() {
                            facts.first_chunk_time = Some(time);
                        }
                        if facts.first_output_time.is_none() {
                            facts.first_output_time = Some(time);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Some(facts)
}

fn is_safe_integer(value: f64) -> bool {
    value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

struct RecordContext {
    type_name: String,
    sid: String,
    time: f64,
    data: Map<String, Value>,
    turn: Option<f64>,
    step: Option<f64>,
    key: Option<String>,
    common: Map<String, Value>,
}

fn record_context(
    record: &Map<String, Value>,
    agent_type: ClientType,
    state: &DshEventAggregatorState,
) -> Option<RecordContext> {
    let type_name = as_str(record.get("type"))?.to_string();
    let sid = as_str(record.get("sid")).unwrap_or("").to_string();
    let time = as_num(record.get("time"))?;
    let data = as_obj(record.get("data")).cloned().unwrap_or_default();
    let turn = as_num(data.get("turn")).or(state.current_turn);
    let step = as_num(data.get("step")).or(state.current_step);
    let turn_id = if !sid.is_empty() {
        turn.map(|turn| format!("{sid}:{}", fmt_num(turn)))
    } else {
        None
    };
    let step_id = match (&turn_id, step) {
        (Some(turn_id), Some(step)) => Some(format!("{turn_id}:{}", fmt_num(step))),
        _ => None,
    };
    let trace_id = if !sid.is_empty() {
        turn.map(|turn| trace_id_for(&sid, turn))
    } else {
        None
    };
    let mut common = Map::new();
    common.insert(
        "time_unix_nano".to_string(),
        Value::String(ms_to_nano(time)),
    );
    common.insert("gen_ai.session.id".to_string(), Value::String(sid.clone()));
    if let Some(turn_id) = turn_id {
        common.insert("gen_ai.turn.id".to_string(), Value::String(turn_id));
    }
    if let Some(step_id) = step_id {
        common.insert("gen_ai.step.id".to_string(), Value::String(step_id));
    }
    if let Some(trace_id) = trace_id {
        common.insert("trace_id".to_string(), Value::String(trace_id));
    }
    common.insert("user.id".to_string(), Value::String(String::new()));
    common.insert(
        "gen_ai.agent.type".to_string(),
        Value::String(agent_type.as_str().to_string()),
    );
    for (key, value) in agent_teams_fields(record) {
        common.insert(key, value);
    }
    let key = match (!sid.is_empty(), turn, step) {
        (true, Some(turn), Some(step)) => Some(step_key(&sid, turn, step)),
        _ => None,
    };
    Some(RecordContext {
        type_name,
        sid,
        time,
        data,
        turn,
        step,
        key,
        common,
    })
}

fn finish_reason(kind: &str) -> Option<&'static str> {
    match kind {
        "stop" => Some("stop"),
        "tool-calls" => Some("tool_calls"),
        "length" | "max-tokens" => Some("length"),
        "content-filter" => Some("content_filter"),
        "error" => Some("error"),
        "cancelled" | "aborted" => Some("cancelled"),
        _ => None,
    }
}

fn emit_request(
    common: &Map<String, Value>,
    key: &str,
    fallback_time: f64,
    state: &mut DshEventAggregatorState,
) -> Option<AgentActivityEntry> {
    if state.emitted_request.contains(key) || state.emitted_request.len() >= MAX_TURN_CORRELATIONS {
        return None;
    }
    state.emitted_request.insert(key.to_string());
    let input_snapshot = state.input_messages.clone();
    let input_delta = input_snapshot[state
        .last_request_input_message_count
        .min(input_snapshot.len())..]
        .to_vec();
    let header = state
        .current_turn_header
        .clone()
        .or_else(|| state.last_known_header.clone());
    let request_time = state
        .request_start_times
        .get(key)
        .copied()
        .unwrap_or(fallback_time);
    let mut opts = common.clone();
    opts.insert(
        "time_unix_nano".to_string(),
        Value::String(ms_to_nano(request_time)),
    );
    opts.insert("event.name".to_string(), json_str("llm.request"));
    if let Some(provider) = header.as_ref().and_then(|header| header.provider.clone()) {
        opts.insert("gen_ai.provider.name".to_string(), Value::String(provider));
    }
    if let Some(model) = header.as_ref().and_then(|header| header.model.clone()) {
        opts.insert("gen_ai.request.model".to_string(), Value::String(model));
    }
    if let Some(system) =
        normalize_system_instructions(header.as_ref().and_then(|header| header.system.as_deref()))
    {
        opts.insert("gen_ai.system_instructions".to_string(), system);
    }
    if let Some(tools) = header.as_ref().and_then(|header| header.tools.clone()) {
        if !tools.is_empty() {
            if let Some(value) = to_json_value(Some(&Value::Array(tools))) {
                opts.insert("gen_ai.tool.definitions".to_string(), value);
            }
        }
    }
    if !state.input_messages_overflowed && !input_snapshot.is_empty() {
        if let Some(value) = to_json_value(Some(&Value::Array(input_snapshot.clone()))) {
            opts.insert("gen_ai.input.messages".to_string(), value);
        }
        if let Some(value) = to_json_value(Some(&Value::Array(input_delta))) {
            opts.insert("gen_ai.input.messages_delta".to_string(), value);
        }
    }
    state.last_request_input_message_count = input_snapshot.len();
    Some(build_agent_activity_entry(&Value::Object(opts)))
}

pub fn transform_dsh_record_entries(
    record: &Value,
    agent_type: ClientType,
    state: &mut DshEventAggregatorState,
) -> Vec<AgentActivityEntry> {
    let mut entries = Vec::new();
    if record.get("type").and_then(Value::as_str) == Some("assistant/message") {
        if let Some(object) = record.as_object() {
            if let Some(context) = record_context(object, agent_type, state) {
                if let Some(key) = context.key.clone() {
                    let stream = read_embedded_stream(context.data.get("stream"));
                    let request_time = state
                        .request_start_times
                        .get(&key)
                        .copied()
                        .or(stream.as_ref().and_then(|facts| facts.first_chunk_time));
                    if let (Some(stream), Some(request_time)) = (stream, request_time) {
                        let _ = stream;
                        if request_time <= context.time {
                            if let Some(request) =
                                emit_request(&context.common, &key, request_time, state)
                            {
                                entries.push(request);
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(entry) = transform_dsh_record(record, agent_type, state) {
        entries.push(entry);
    }
    entries
}

pub fn transform_dsh_record(
    record: &Value,
    agent_type: ClientType,
    state: &mut DshEventAggregatorState,
) -> Option<AgentActivityEntry> {
    let record = record.as_object()?;
    let context = record_context(record, agent_type, state)?;
    match context.type_name.as_str() {
        "session/created"
        | "permission/preset"
        | "sandbox/mode"
        | "approval/policy"
        | "agent/inbox/spliced"
        | "session/title"
        | "session/title-llm-request"
        | "step/end" => None,
        "turn/start" => {
            let turn = context.turn;
            reset_turn_state(state);
            state.current_turn = turn;
            None
        }
        "turn/end" => {
            reset_turn_state(state);
            None
        }
        "step/start" => {
            state.current_step = context.step;
            if let (Some(turn), Some(step)) = (context.turn, context.step) {
                if !context.sid.is_empty() {
                    set_bounded_f64(
                        &mut state.request_start_times,
                        step_key(&context.sid, turn, step),
                        context.time,
                    );
                }
            }
            None
        }
        "request/header" => {
            let header = parse_dsh_request_header(record)?;
            state.current_turn_header = Some(header.clone());
            state.last_known_header = Some(header);
            if let (Some(turn), Some(step)) = (context.turn, context.step) {
                if !context.sid.is_empty() {
                    set_bounded_f64(
                        &mut state.request_start_times,
                        step_key(&context.sid, turn, step),
                        context.time,
                    );
                }
            }
            None
        }
        "request/context" => {
            if let (Some(turn), Some(step)) = (context.turn, context.step) {
                if !context.sid.is_empty() {
                    set_bounded_f64(
                        &mut state.request_start_times,
                        step_key(&context.sid, turn, step),
                        context.time,
                    );
                }
            }
            None
        }
        "assistant/chunk" => {
            let chunk = as_obj(context.data.get("chunk"))
                .cloned()
                .unwrap_or_default();
            let chunk_type = as_str(chunk.get("type")).map(str::to_string);
            let key = context.key.clone();
            if let Some(key) = key.clone() {
                if is_streamed_output_delta(chunk_type.as_deref())
                    && !state.first_output_times.contains_key(&key)
                {
                    set_bounded_f64(&mut state.first_output_times, key.clone(), context.time);
                }
                if chunk_type.as_deref() == Some("finish") {
                    if let Some(kind) =
                        as_obj(chunk.get("reason")).and_then(|reason| as_str(reason.get("kind")))
                    {
                        set_bounded_str(&mut state.pending_finish, key.clone(), kind.to_string());
                    }
                }
            }
            key.and_then(|key| emit_request(&context.common, &key, context.time, state))
        }
        "user/message" => {
            let content = context.data.get("content").cloned().unwrap_or(Value::Null);
            let msg_id = as_str(context.data.get("id")).map(str::to_string);
            let user_parts = normalize_text_parts(&content);
            let source_kind =
                as_obj(context.data.get("source")).and_then(|source| as_str(source.get("kind")));
            add_input_message(
                state,
                json_obj(&[
                    ("role", json_str("user")),
                    ("parts", Value::Array(user_parts.clone())),
                ]),
            );
            if context.data.get("source").is_some() && source_kind != Some("user") {
                return None;
            }
            let mut opts = context.common;
            opts.insert("event.name".to_string(), json_str("other"));
            if let Some(msg_id) = msg_id {
                opts.insert("event.id".to_string(), Value::String(msg_id));
            }
            if let Some(value) = to_json_value(Some(&Value::Array(vec![json_obj(&[
                ("role", json_str("user")),
                ("parts", Value::Array(user_parts)),
            ])]))) {
                opts.insert("gen_ai.input.messages_delta".to_string(), value);
            }
            Some(build_agent_activity_entry(&Value::Object(opts)))
        }
        "assistant/message" => {
            let message = as_obj(context.data.get("message"))
                .cloned()
                .unwrap_or_default();
            let source = as_obj(message.get("source")).cloned().unwrap_or_default();
            let model = as_str(source.get("model")).map(str::to_string);
            let provider = as_str(source.get("provider")).map(str::to_string);
            let response_id = as_str(message.get("id")).map(str::to_string);
            let content = message.get("content").cloned().unwrap_or(Value::Null);
            let usage = as_obj(context.data.get("usage"))
                .cloned()
                .unwrap_or_default();
            let uncached = as_num(usage.get("inputTokens"));
            let output_tokens = as_num(usage.get("outputTokens"));
            let cache_read = as_num(usage.get("cacheReadTokens"));
            let cache_write = as_num(usage.get("cacheWriteTokens"));
            let input_tokens = uncached
                .map(|value| value + cache_read.unwrap_or(0.0) + cache_write.unwrap_or(0.0));
            let stream = read_embedded_stream(context.data.get("stream"));
            let mut finish_kind = stream.as_ref().and_then(|facts| facts.finish_kind.clone());
            let mut time_to_first_token = None;
            if let (Some(turn), Some(step)) = (context.turn, context.step) {
                if !context.sid.is_empty() {
                    let key = step_key(&context.sid, turn, step);
                    if stream.is_none() {
                        finish_kind = state.pending_finish.get(&key).cloned();
                    }
                    state.pending_finish.remove(&key);
                    let request_start = state.request_start_times.remove(&key);
                    let first_output = if stream.is_some() {
                        stream.as_ref().and_then(|facts| facts.first_output_time)
                    } else {
                        state.first_output_times.get(&key).copied()
                    };
                    state.first_output_times.remove(&key);
                    if let (Some(request_start), Some(first_output)) = (request_start, first_output)
                    {
                        if first_output >= request_start && first_output <= context.time {
                            time_to_first_token =
                                Some(((first_output - request_start) * 1_000_000.0).round());
                        }
                    }
                }
            }
            let finish = if context.data.get("interrupted") == Some(&Value::Bool(true)) {
                Some("cancelled")
            } else {
                finish_kind.as_deref().and_then(finish_reason)
            };
            let assistant_parts = normalize_assistant_parts(&content);
            remember_tool_names(&content, state);
            add_input_message(
                state,
                json_obj(&[
                    ("role", json_str("assistant")),
                    ("parts", Value::Array(assistant_parts.clone())),
                ]),
            );
            let mut opts = context.common;
            opts.insert("event.name".to_string(), json_str("llm.response"));
            if let Some(response_id) = response_id.clone() {
                opts.insert("event.id".to_string(), Value::String(response_id.clone()));
                opts.insert("gen_ai.response.id".to_string(), Value::String(response_id));
            }
            if let Some(provider) = provider {
                opts.insert("gen_ai.provider.name".to_string(), Value::String(provider));
            }
            if let Some(model) = model {
                opts.insert("gen_ai.response.model".to_string(), Value::String(model));
            }
            if let Some(finish) = finish {
                opts.insert(
                    "gen_ai.response.finish_reasons".to_string(),
                    Value::Array(vec![Value::String(finish.to_string())]),
                );
            }
            if let Some(ttft) = time_to_first_token {
                insert_num(&mut opts, "gen_ai.response.time_to_first_token", Some(ttft));
            }
            insert_num(&mut opts, "gen_ai.usage.input_tokens", input_tokens);
            insert_num(&mut opts, "gen_ai.usage.output_tokens", output_tokens);
            insert_num(
                &mut opts,
                "gen_ai.usage.cache_read.input_tokens",
                cache_read,
            );
            insert_num(
                &mut opts,
                "gen_ai.usage.cache_creation.input_tokens",
                cache_write,
            );
            if let Some(value) = to_json_value(Some(&Value::Array(vec![json_obj(&[
                ("role", json_str("assistant")),
                ("parts", Value::Array(assistant_parts)),
            ])]))) {
                opts.insert("gen_ai.output.messages".to_string(), value);
            }
            Some(build_agent_activity_entry(&Value::Object(opts)))
        }
        "tool/call" => {
            let call_id = as_str(context.data.get("callId"))?;
            let name = as_str(context.data.get("name"))?;
            set_bounded_str(&mut state.tool_names, call_id.to_string(), name.to_string());
            let mut args = context
                .data
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Null);
            if let Value::String(text) = &args {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    args = parsed;
                }
            }
            let mut opts = context.common;
            opts.insert("event.name".to_string(), json_str("tool.call"));
            opts.insert(
                "gen_ai.tool.name".to_string(),
                Value::String(name.to_string()),
            );
            opts.insert(
                "gen_ai.tool.call.id".to_string(),
                Value::String(call_id.to_string()),
            );
            if let Some(value) = to_json_value(Some(&args)) {
                opts.insert("gen_ai.tool.call.arguments".to_string(), value);
            }
            Some(build_agent_activity_entry(&Value::Object(opts)))
        }
        "tool/result" => {
            let message = as_obj(context.data.get("message"))
                .cloned()
                .unwrap_or_default();
            let source = as_obj(message.get("source")).cloned().unwrap_or_default();
            let call_id = as_str(source.get("callId"))?.to_string();
            let name = state.tool_names.remove(&call_id);
            let content = message.get("content").cloned().unwrap_or(Value::Null);
            let tool_parts = normalize_text_parts(&content);
            add_input_message(
                state,
                json_obj(&[
                    ("role", json_str("tool")),
                    ("parts", Value::Array(tool_parts.clone())),
                ]),
            );
            let name = name?;
            let mut opts = context.common;
            opts.insert("event.name".to_string(), json_str("tool.result"));
            opts.insert("gen_ai.tool.name".to_string(), Value::String(name));
            opts.insert("gen_ai.tool.call.id".to_string(), Value::String(call_id));
            if let Some(value) = to_json_value(Some(&Value::Array(vec![json_obj(&[
                ("role", json_str("tool")),
                ("parts", Value::Array(tool_parts)),
            ])]))) {
                opts.insert("gen_ai.tool.call.result".to_string(), value);
            }
            Some(build_agent_activity_entry(&Value::Object(opts)))
        }
        _ => None,
    }
}

fn insert_num(opts: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    let Some(value) = value else {
        return;
    };
    if let Some(number) = if value.fract() == 0.0 && value.abs() < (i64::MAX as f64) {
        Some(Number::from(value as i64))
    } else {
        Number::from_f64(value)
    } {
        opts.insert(key.to_string(), Value::Number(number));
    }
}

fn json_str(value: &str) -> Value {
    Value::String(value.to_string())
}

fn json_obj(pairs: &[(&str, Value)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect(),
    )
}

fn json_array(items: Vec<Value>) -> Value {
    Value::Array(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inputs::rest_support::entry_json;
    use serde_json::json;

    fn field(entry: &AgentActivityEntry, key: &str) -> Option<Value> {
        entry_json(entry).get(key).cloned()
    }

    #[test]
    fn maps_disjoint_usage_without_double_counting_reasoning() {
        let entry = transform_dsh_record(
            &json!({
                "type": "assistant/message",
                "sid": "s",
                "time": 1000,
                "data": {
                    "turn": 1,
                    "step": 1,
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "done" }],
                        "source": { "provider": "test", "model": "test-model" }
                    },
                    "usage": {
                        "inputTokens": 10,
                        "outputTokens": 5,
                        "cacheReadTokens": 20,
                        "cacheWriteTokens": 30,
                        "reasoningTokens": 4
                    }
                }
            }),
            ClientType::Dsh,
            &mut new_state(),
        )
        .expect("entry");
        assert_eq!(field(&entry, "gen_ai.usage.input_tokens"), Some(json!(60)));
        assert_eq!(field(&entry, "gen_ai.usage.output_tokens"), Some(json!(5)));
        assert_eq!(
            field(&entry, "gen_ai.usage.cache_read.input_tokens"),
            Some(json!(20))
        );
        assert_eq!(
            field(&entry, "gen_ai.usage.cache_creation.input_tokens"),
            Some(json!(30))
        );
    }

    #[test]
    fn does_not_fabricate_missing_usage_or_model() {
        let entry = transform_dsh_record(
            &json!({
                "type": "assistant/message",
                "sid": "s",
                "time": 1000,
                "data": { "turn": 1, "step": 1, "message": { "role": "assistant", "content": [], "source": {} } }
            }),
            ClientType::Dsh,
            &mut new_state(),
        )
        .expect("entry");
        let value = entry_json(&entry);
        assert!(value.get("gen_ai.usage.input_tokens").is_none());
        assert!(value.get("gen_ai.usage.output_tokens").is_none());
        assert!(value.get("gen_ai.response.model").is_none());
    }

    #[test]
    fn skips_telemetry_and_incomplete_records() {
        assert!(transform_dsh_record(
            &json!({"type": "session/created", "sid": "s", "time": 1}),
            ClientType::Dsh,
            &mut new_state()
        )
        .is_none());
        assert!(transform_dsh_record(
            &json!({"type": "permission/preset", "sid": "s", "time": 1, "data": {}}),
            ClientType::Dsh,
            &mut new_state()
        )
        .is_none());
        assert!(transform_dsh_record(
            &json!({"type": "turn/start", "sid": "s", "time": 1, "data": {"turn": 1}}),
            ClientType::Dsh,
            &mut new_state()
        )
        .is_none());
        assert!(transform_dsh_record(
            &json!({"sid": "s", "time": 1}),
            ClientType::Dsh,
            &mut new_state()
        )
        .is_none());
        assert!(transform_dsh_record(
            &json!({"type": "user/message"}),
            ClientType::Dsh,
            &mut new_state()
        )
        .is_none());
    }

    #[test]
    fn omits_input_messages_when_accumulator_is_empty() {
        let mut state = new_state();
        state.current_turn_header = Some(DshRequestHeader {
            model: Some("m".to_string()),
            provider: Some("p".to_string()),
            system: Some("s".to_string()),
            tools: None,
        });
        state.current_turn = Some(1.0);
        state.current_step = Some(1.0);
        let entry = transform_dsh_record(
            &json!({
                "type": "assistant/chunk",
                "sid": "s",
                "time": 1000,
                "data": { "turn": 1, "step": 1, "chunk": { "type": "block-start" } }
            }),
            ClientType::Dsh,
            &mut state,
        )
        .expect("request");
        let value = entry_json(&entry);
        assert_eq!(value["event.name"], "llm.request");
        assert!(value.get("gen_ai.input.messages").is_none());
        assert!(value.get("gen_ai.input.messages_delta").is_none());
        assert_eq!(
            value["gen_ai.system_instructions"],
            json!([{ "type": "text", "content": "s" }])
        );
        assert!(value.get("gen_ai.tool.definitions").is_none());
    }

    #[test]
    fn records_ttft_from_request_context_to_first_delta() {
        let mut state = new_state();
        for record in [
            json!({"type": "turn/start", "sid": "s", "time": 1000, "data": {"turn": 1}}),
            json!({"type": "step/start", "sid": "s", "time": 1010, "data": {"turn": 1, "step": 1}}),
            json!({"type": "request/header", "sid": "s", "time": 1020, "data": {"header": {"config": {"provider": "p", "model": "m"}}}}),
            json!({"type": "request/context", "sid": "s", "time": 1030, "data": {"turn": 1, "step": 1}}),
        ] {
            transform_dsh_record(&record, ClientType::Dsh, &mut state);
        }
        let request = transform_dsh_record(
            &json!({"type": "assistant/chunk", "sid": "s", "time": 1090, "data": {"turn": 1, "step": 1, "chunk": {"type": "text-delta", "text": "hello"}}}),
            ClientType::Dsh,
            &mut state,
        )
        .expect("request");
        assert_eq!(field(&request, "event.name"), Some(json!("llm.request")));
        let response = transform_dsh_record(
            &json!({
                "type": "assistant/message",
                "sid": "s",
                "time": 1200,
                "data": { "turn": 1, "step": 1, "message": { "id": "r", "content": [{ "type": "text", "text": "hello" }] } }
            }),
            ClientType::Dsh,
            &mut state,
        )
        .expect("response");
        assert_eq!(
            field(&response, "gen_ai.response.time_to_first_token").and_then(|v| v.as_f64()),
            Some(60_000_000.0)
        );
    }

    #[test]
    fn reuses_last_session_header() {
        let mut state = new_state();
        for record in [
            json!({"type": "turn/start", "sid": "session-a", "time": 1, "data": {"turn": 1}}),
            json!({"type": "step/start", "sid": "session-a", "time": 2, "data": {"turn": 1, "step": 1}}),
            json!({"type": "request/header", "sid": "session-a", "time": 3, "data": {"header": {"config": {"provider": "deepseek-official", "model": "deepseek-model"}, "system": "follow the session instructions"}}}),
            json!({"type": "turn/end", "sid": "session-a", "time": 4, "data": {"turn": 1}}),
            json!({"type": "turn/start", "sid": "session-a", "time": 5, "data": {"turn": 2}}),
            json!({"type": "step/start", "sid": "session-a", "time": 6, "data": {"turn": 2, "step": 1}}),
            json!({"type": "user/message", "sid": "session-a", "time": 7, "data": {"turn": 2, "content": [{ "type": "text", "text": "continue" }]}}),
        ] {
            transform_dsh_record(&record, ClientType::Dsh, &mut state);
        }
        let request = transform_dsh_record(
            &json!({"type": "assistant/chunk", "sid": "session-a", "time": 8, "data": {"turn": 2, "step": 1, "chunk": {"type": "block-start"}}}),
            ClientType::Dsh,
            &mut state,
        )
        .expect("request");
        let value = entry_json(&request);
        assert_eq!(value["event.name"], "llm.request");
        assert_eq!(value["gen_ai.provider.name"], "deepseek-official");
        assert_eq!(value["gen_ai.request.model"], "deepseek-model");
        assert_eq!(
            value["gen_ai.system_instructions"],
            json!([{ "type": "text", "content": "follow the session instructions" }])
        );
        assert!(value["gen_ai.input.messages"]
            .to_string()
            .contains("continue"));
    }
}

#[cfg(test)]
#[path = "history_contracts.rs"]
mod history_contracts;
