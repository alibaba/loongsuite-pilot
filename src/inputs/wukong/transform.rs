//! AGUI message → `AgentActivityEntry` conversion.
//!
//! Port of the pure transform half of `wukong-input.ts`. Checkpointing and the
//! CLI process stay in `mod.rs`.

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::normalization::build_agent_activity_entry;
use crate::types::{AgentActivityEntry, AgentEventName, ClientType};
use serde_json::{Map, Value};

#[derive(Clone, Debug)]
pub(crate) struct ValidTask {
    pub id: String,
    pub session_id: String,
    pub metadata: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct WukongMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: Option<String>,
    pub events: Option<Vec<Value>>,
    pub created_at: f64,
    pub turn_index: Option<f64>,
}

struct ActivityResult<'a> {
    result: Option<Value>,
    duration: Option<f64>,
    status: &'a str,
    error_message: Option<String>,
}

impl WukongMessage {
    fn content_truthy(&self) -> bool {
        self.content.as_ref().is_some_and(|text| !text.is_empty())
    }
}

pub(crate) fn parse_task(value: &Value) -> Option<ValidTask> {
    let session_id = match value.get("session_id") {
        Some(Value::String(session_id)) => session_id.clone(),
        _ => return None,
    };
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let metadata = value.get("metadata").cloned().unwrap_or(Value::Null);
    Some(ValidTask {
        id,
        session_id,
        metadata,
    })
}

pub(crate) fn parse_message(value: &Value) -> WukongMessage {
    let obj = value.as_object();
    WukongMessage {
        id: obj
            .and_then(|map| map.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        conversation_id: obj
            .and_then(|map| map.get("conversationId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        role: obj
            .and_then(|map| map.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        content: obj
            .and_then(|map| map.get("content"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        events: obj
            .and_then(|map| map.get("events"))
            .and_then(Value::as_array)
            .cloned(),
        created_at: obj
            .and_then(|map| num_or(map.get("createdAt")))
            .unwrap_or(0.0),
        turn_index: obj.and_then(|map| num_or(map.get("turnIndex"))),
    }
}

pub(crate) fn parse_messages(value: &[Value]) -> Vec<WukongMessage> {
    value.iter().map(parse_message).collect()
}

pub(crate) fn is_message_complete(msg: &WukongMessage) -> bool {
    if msg.role != "assistant" {
        return true;
    }
    match &msg.events {
        None => true,
        Some(events) if events.is_empty() => true,
        Some(events) => events.iter().any(|evt| {
            matches!(
                evt.get("type").and_then(Value::as_str),
                Some("RUN_FINISHED" | "RUN_ERROR")
            )
        }),
    }
}

/// Index of the last message that can be emitted, or -1 when the slice is still
/// incomplete or ends on an unpaired user message.
pub(crate) fn find_last_complete_index(messages: &[WukongMessage]) -> isize {
    let mut last = messages.len() as isize - 1;
    for (index, msg) in messages.iter().enumerate() {
        if !is_message_complete(msg) {
            last = index as isize - 1;
            break;
        }
    }
    while last >= 0 && messages[last as usize].role == "user" {
        last -= 1;
    }
    last
}

pub(crate) fn transform_messages(
    task: &ValidTask,
    messages: &[WukongMessage],
) -> Vec<AgentActivityEntry> {
    let mut entries = Vec::new();
    let mut pending: Vec<WukongMessage> = Vec::new();
    for msg in messages {
        if msg.role == "user" {
            if msg.content_truthy() {
                pending.push(msg.clone());
            }
            continue;
        }
        if msg.role != "assistant" {
            continue;
        }
        let Some(events) = msg.events.as_ref().filter(|events| !events.is_empty()) else {
            pending.clear();
            continue;
        };
        let user_content = pending
            .iter()
            .filter_map(|message| {
                message
                    .content
                    .as_ref()
                    .filter(|text| !text.is_empty())
                    .map(String::as_str)
            })
            .collect::<Vec<_>>()
            .join("\n");
        let turn_entries = transform_assistant(task, msg, events, &user_content);
        if turn_entries.is_empty() {
            continue;
        }
        pending.clear();
        entries.extend(turn_entries);
    }
    entries
}

#[derive(Clone)]
struct StepContext {
    step_index: i64,
    step_id: String,
    has_tool_calls: bool,
    start_timestamp: f64,
    step_span_id: String,
}

struct ToolPart {
    part_type: String,
    id: String,
    name: String,
}

struct RunError {
    code: String,
    message: String,
}

struct AssistantTurn<'a> {
    task: &'a ValidTask,
    msg: &'a WukongMessage,
    model: String,
    turn_id: String,
    common: Map<String, Value>,
    user_content: String,
    entries: Vec<AgentActivityEntry>,
    step_index: i64,
    current_step: Option<StepContext>,
    has_step_events: bool,
    run_id: Option<String>,
    text_content: String,
    usage_event: Option<Value>,
    first_token: Option<Value>,
    run_started_ts: Option<f64>,
    run_finished_ts: Option<f64>,
    run_error: Option<RunError>,
    tool_idx: i64,
    tool_start_count: i64,
    tool_start_timestamps: HashMap<String, f64>,
    all_tool_start_times: Vec<f64>,
    all_tool_end_times: Vec<f64>,
    tool_args: HashMap<String, String>,
    tool_names: HashMap<String, String>,
    tool_call_parts: Vec<ToolPart>,
    flushed: HashSet<String>,
    trace_id: String,
    agent_span_id: String,
}

fn transform_assistant(
    task: &ValidTask,
    msg: &WukongMessage,
    events: &[Value],
    user_content: &str,
) -> Vec<AgentActivityEntry> {
    let meta = match &task.metadata {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let model = match meta.get("modelName") {
        Some(Value::String(name)) if !name.is_empty() => name.clone(),
        _ => "unknown".to_string(),
    };
    let provider = match meta.get("modelProvider") {
        Some(Value::String(name)) if !name.is_empty() => Some(name.clone()),
        _ => None,
    };
    let turn_id = resolve_turn_id(&task.session_id, msg);
    let mut common = Map::new();
    common.insert("host.name".into(), Value::String(host_name()));
    common.insert("service.name".into(), Value::String("wukong".into()));
    common.insert(
        "gen_ai.session.id".into(),
        Value::String(task.session_id.clone()),
    );
    common.insert(
        "gen_ai.agent.type".into(),
        Value::String(ClientType::Wukong.as_str().to_string()),
    );
    common.insert("gen_ai.agent.id".into(), Value::String(task.id.clone()));
    common.insert(
        "gen_ai.agent.name".into(),
        Value::String(ClientType::Wukong.as_str().to_string()),
    );
    if let Some(provider) = provider {
        common.insert("gen_ai.provider.name".into(), Value::String(provider));
    }

    let has_step_events = events.iter().any(|evt| event_type(evt) == "STEP_STARTED");
    let first_step = events
        .iter()
        .position(|evt| event_type(evt) == "STEP_STARTED");
    let before = match first_step {
        Some(index) => &events[..index],
        None => events,
    };
    let has_content_before = before.iter().any(|evt| {
        matches!(
            event_type(evt),
            "TOOL_CALL_START" | "ACTIVITY_SNAPSHOT" | "TEXT_MESSAGE_CONTENT"
        )
    });

    let mut turn = AssistantTurn {
        task,
        msg,
        model,
        turn_id,
        common,
        user_content: user_content.to_string(),
        entries: Vec::new(),
        step_index: 0,
        current_step: None,
        has_step_events,
        run_id: None,
        text_content: String::new(),
        usage_event: None,
        first_token: None,
        run_started_ts: None,
        run_finished_ts: None,
        run_error: None,
        tool_idx: 0,
        tool_start_count: 0,
        tool_start_timestamps: HashMap::new(),
        all_tool_start_times: Vec::new(),
        all_tool_end_times: Vec::new(),
        tool_args: HashMap::new(),
        tool_names: HashMap::new(),
        tool_call_parts: Vec::new(),
        flushed: HashSet::new(),
        trace_id: random_hex(16),
        agent_span_id: random_hex(8),
    };
    if !has_step_events || has_content_before {
        turn.step_index = 1;
        turn.current_step = Some(StepContext {
            step_index: 1,
            step_id: format!("{}:s1", turn.turn_id),
            has_tool_calls: false,
            start_timestamp: msg.created_at,
            step_span_id: random_hex(8),
        });
    }
    for raw in events {
        let evt = sanitize_event(raw, msg.created_at);
        let kind = event_type_map(&evt);
        match kind.as_str() {
            "STEP_STARTED" => turn.start_step(&evt),
            "STEP_FINISHED" => {
                turn.emit_step_llm(false);
            }
            "RUN_STARTED" => {
                turn.run_id = string_prop(&evt, "runId");
                turn.run_started_ts = Some(evt_ts(&evt, msg.created_at));
            }
            "RUN_FINISHED" => {
                turn.run_finished_ts = Some(evt_ts(&evt, msg.created_at));
            }
            "RUN_ERROR" => {
                turn.run_error = Some(RunError {
                    code: coerce_nullish(&evt, "code", "UNKNOWN"),
                    message: coerce_nullish(&evt, "message", ""),
                });
            }
            "TEXT_MESSAGE_CONTENT" => {
                if let Some(delta) = string_prop(&evt, "delta") {
                    turn.text_content.push_str(&delta);
                }
            }
            "USAGE" => turn.usage_event = Some(Value::Object(evt)),
            "FIRST_TOKEN" => turn.first_token = Some(Value::Object(evt)),
            "TOOL_CALL_START" => turn.on_tool_start(&evt),
            "TOOL_CALL_ARGS" => turn.on_tool_args(&evt),
            "TOOL_CALL_END" => turn.on_tool_end(&evt),
            "TOOL_CALL_RESULT" => turn.on_tool_result_event(&evt),
            "ACTIVITY_SNAPSHOT" => turn.on_activity(&evt),
            _ => {}
        }
    }
    if !turn.has_step_events
        && turn
            .current_step
            .as_ref()
            .is_some_and(|step| step.has_tool_calls)
        && !turn.all_tool_start_times.is_empty()
    {
        turn.emit_split_mid();
    }
    let already = turn
        .current_step
        .as_ref()
        .is_some_and(|step| turn.flushed.contains(&step.step_id));
    let should_final = !already
        && turn.current_step.as_ref().is_some_and(|step| {
            !turn.text_content.is_empty()
                || turn.usage_event.is_some()
                || !turn.tool_call_parts.is_empty()
                || turn.run_error.is_some()
                || (step.step_index > 1 && !step.has_tool_calls)
        });
    if should_final {
        turn.emit_step_llm(true);
    }
    turn.synthesize_orphan_steps();
    turn.backfill();
    turn.enrich_tool_responses();
    turn.entries
}

impl<'a> AssistantTurn<'a> {
    fn start_step(&mut self, evt: &Map<String, Value>) {
        self.step_index += 1;
        self.current_step = Some(StepContext {
            step_index: self.step_index,
            step_id: format!("{}:s{}", self.turn_id, self.step_index),
            has_tool_calls: false,
            start_timestamp: evt_ts(evt, self.msg.created_at),
            step_span_id: random_hex(8),
        });
        self.text_content.clear();
        self.usage_event = None;
        self.first_token = None;
        self.tool_call_parts.clear();
        self.all_tool_start_times.clear();
        self.all_tool_end_times.clear();
    }

    fn emit_step_llm(&mut self, force: bool) -> bool {
        let Some(step) = self.current_step.clone() else {
            return false;
        };
        let has_content = !self.text_content.is_empty()
            || self.usage_event.is_some()
            || !self.tool_call_parts.is_empty()
            || self.run_error.is_some();
        if !has_content && !force {
            return false;
        }
        let finish = finish_reasons(step.has_tool_calls, self.run_error.is_some());
        let usage = self.token_usage();
        let request_ts = request_timestamp(
            step.start_timestamp,
            self.run_started_ts,
            self.msg.created_at,
        );
        let response_ts = response_timestamp(
            request_ts,
            step.has_tool_calls,
            &self.all_tool_start_times,
            self.run_finished_ts,
            self.msg.created_at,
        );
        let include_user = !self.user_content.is_empty() && step.step_index == 1;
        let output_parts = self.output_parts();
        let llm_span = random_hex(8);
        let attributes = self.llm_attributes(true);

        let mut request = self.llm_base(&step, "request");
        request.insert("timestamp".into(), number_value(request_ts));
        request.insert("event.name".into(), Value::String("llm.request".into()));
        request.insert(
            "gen_ai.request.model".into(),
            Value::String(self.model.clone()),
        );
        if include_user {
            request.insert(
                "gen_ai.input.messages_delta".into(),
                Value::Array(vec![self.user_message()]),
            );
        }
        request.insert(
            "attributes".into(),
            Value::Object(short_attributes(&attributes, false)),
        );
        self.push_entry(request);

        let mut response = self.llm_base(&step, "response");
        response.insert("timestamp".into(), number_value(response_ts));
        response.insert("event.name".into(), Value::String("llm.response".into()));
        response.insert(
            "gen_ai.request.model".into(),
            Value::String(self.model.clone()),
        );
        response.insert(
            "gen_ai.response.model".into(),
            Value::String(self.model.clone()),
        );
        response.insert(
            "gen_ai.response.finish_reasons".into(),
            Value::Array(finish.into_iter().map(Value::String).collect()),
        );
        response.insert("span_id".into(), Value::String(llm_span));
        response.insert(
            "parent_span_id".into(),
            Value::String(step.step_span_id.clone()),
        );
        if include_user {
            response.insert(
                "gen_ai.input.messages".into(),
                Value::Array(vec![self.user_message()]),
            );
        }
        if !output_parts.is_empty() {
            response.insert(
                "gen_ai.output.messages".into(),
                Value::Array(vec![json_obj([
                    ("role", Value::String("assistant".into())),
                    ("parts", Value::Array(output_parts)),
                ])]),
            );
        }
        insert_usage(&mut response, &usage);
        if let Some(err) = &self.run_error {
            response.insert("error.type".into(), Value::String(err.code.clone()));
            response.insert("error.message".into(), Value::String(err.message.clone()));
        }
        response.insert("attributes".into(), Value::Object(attributes));
        self.push_entry(response);

        self.flushed.insert(step.step_id);
        self.text_content.clear();
        self.usage_event = None;
        self.first_token = None;
        self.tool_call_parts.clear();
        self.run_error = None;
        true
    }

    fn emit_split_mid(&mut self) {
        let Some(step) = self.current_step.clone() else {
            return;
        };
        let mid_req = self.run_started_ts.unwrap_or(step.start_timestamp);
        let first_tool = min_of(&self.all_tool_start_times);
        let last_tool = max_of(&[&self.all_tool_start_times, &self.all_tool_end_times]);
        let mid_resp = (mid_req + 1.0).max(first_tool - 1.0);
        let include_user = !self.user_content.is_empty() && step.step_index == 1;
        let output_parts: Vec<Value> = self.tool_call_parts.iter().map(tool_part_json).collect();
        let llm_span = random_hex(8);
        let attributes = short_attributes(&self.llm_attributes(false), false);

        let mut request = self.llm_base(&step, "request");
        request.insert("timestamp".into(), number_value(mid_req));
        request.insert("event.name".into(), Value::String("llm.request".into()));
        request.insert(
            "gen_ai.request.model".into(),
            Value::String(self.model.clone()),
        );
        if include_user {
            request.insert(
                "gen_ai.input.messages_delta".into(),
                Value::Array(vec![self.user_message()]),
            );
        }
        request.insert("attributes".into(), Value::Object(attributes.clone()));
        self.push_entry(request);

        let mut response = self.llm_base(&step, "response");
        response.insert("timestamp".into(), number_value(mid_resp));
        response.insert("event.name".into(), Value::String("llm.response".into()));
        response.insert(
            "gen_ai.request.model".into(),
            Value::String(self.model.clone()),
        );
        response.insert(
            "gen_ai.response.model".into(),
            Value::String(self.model.clone()),
        );
        response.insert(
            "gen_ai.response.finish_reasons".into(),
            Value::Array(vec![Value::String("tool_calls".into())]),
        );
        response.insert("span_id".into(), Value::String(llm_span));
        response.insert(
            "parent_span_id".into(),
            Value::String(step.step_span_id.clone()),
        );
        if include_user {
            response.insert(
                "gen_ai.input.messages".into(),
                Value::Array(vec![self.user_message()]),
            );
        }
        if !output_parts.is_empty() {
            response.insert(
                "gen_ai.output.messages".into(),
                Value::Array(vec![json_obj([
                    ("role", Value::String("assistant".into())),
                    ("parts", Value::Array(output_parts)),
                ])]),
            );
        }
        insert_usage(
            &mut response,
            &TokenUsage {
                input: 0.0,
                output: 0.0,
                cached: 0.0,
                total: 0.0,
            },
        );
        response.insert("attributes".into(), Value::Object(attributes));
        self.push_entry(response);

        self.step_index += 1;
        let final_start = last_tool + 1.0;
        self.current_step = Some(StepContext {
            step_index: self.step_index,
            step_id: format!("{}:s{}", self.turn_id, self.step_index),
            has_tool_calls: false,
            start_timestamp: final_start,
            step_span_id: random_hex(8),
        });
        self.tool_call_parts.clear();
        let finished = self.run_finished_ts;
        let replace = match finished {
            None => true,
            Some(ts) if !ts.is_finite() || ts == 0.0 || ts <= final_start => true,
            Some(_) => false,
        };
        if replace {
            self.run_finished_ts = Some(final_start + 1.0);
        }
    }

    fn on_tool_start(&mut self, evt: &Map<String, Value>) {
        if let Some(step) = &mut self.current_step {
            step.has_tool_calls = true;
        }
        let tc_id = string_prop(evt, "toolCallId")
            .unwrap_or_else(|| format!("idx-{}", self.tool_start_count));
        let timestamp = evt_ts(evt, self.msg.created_at);
        self.tool_start_timestamps.insert(tc_id.clone(), timestamp);
        self.all_tool_start_times.push(timestamp);
        let tool_name = tool_name_of(evt);
        self.tool_names.insert(tc_id.clone(), tool_name.clone());
        self.tool_call_parts.push(ToolPart {
            part_type: "tool_call".into(),
            id: tc_id,
            name: tool_name,
        });
        self.tool_start_count += 1;
    }

    fn on_tool_args(&mut self, evt: &Map<String, Value>) {
        let tc_id = string_prop(evt, "toolCallId")
            .unwrap_or_else(|| format!("idx-{}", self.tool_start_count - 1));
        let prev = self.tool_args.get(&tc_id).cloned().unwrap_or_default();
        let delta = string_prop(evt, "delta").unwrap_or_default();
        self.tool_args.insert(tc_id, format!("{prev}{delta}"));
    }

    fn on_tool_end(&mut self, evt: &Map<String, Value>) {
        let tc_id = string_prop(evt, "toolCallId")
            .unwrap_or_else(|| format!("idx-{}", self.tool_start_count - 1));
        let evt_timestamp = evt_ts(evt, self.msg.created_at);
        let start = self.tool_start_timestamps.get(&tc_id).copied();
        let start_evt = start.unwrap_or(evt_timestamp);
        let adjusted_end = evt_timestamp.max(start_evt + 1.0);
        let duration = match start {
            Some(start) if start != 0.0 && start.is_finite() => Some(adjusted_end - start),
            _ => None,
        };
        let tool_name = self
            .tool_names
            .get(&tc_id)
            .cloned()
            .unwrap_or_else(|| tool_name_of(evt));
        let args = self.tool_args.get(&tc_id).cloned();
        self.push_tool_call(&tc_id, &tool_name, start_evt, args.as_deref());
        self.tool_idx += 1;
        self.push_tool_result(&tc_id, &tool_name, adjusted_end, evt, duration);
        self.tool_idx += 1;
        self.all_tool_end_times.push(adjusted_end);
    }

    fn on_tool_result_event(&mut self, evt: &Map<String, Value>) {
        let Some(tc_id) = string_prop(evt, "toolCallId").filter(|id| !id.is_empty()) else {
            return;
        };
        let Some(entry) = self.entries.iter_mut().rev().find(|entry| {
            entry.event_name == Some(AgentEventName::ToolResult)
                && entry.tool_call_id.as_deref() == Some(tc_id.as_str())
        }) else {
            return;
        };
        if evt.contains_key("content") {
            entry.tool_call_result = Some(evt.get("content").cloned().unwrap_or(Value::Null));
        }
        if evt.get("is_error") == Some(&Value::Bool(true)) && entry.error_type.is_none() {
            entry.error_type = Some("_OTHER".into());
        }
    }

    fn on_activity(&mut self, evt: &Map<String, Value>) {
        let activity_type = string_prop(evt, "activityType").unwrap_or_default();
        if activity_type.is_empty() || activity_type == "TASK_LINE_PLAN" {
            return;
        }
        let tool_name = activity_tool_name(&activity_type);
        let tool_idx = self.tool_idx;
        let tool_call_id = format!("activity-{}-{tool_idx}", self.msg.id);
        self.tool_call_parts.push(ToolPart {
            part_type: "tool_call".into(),
            id: tool_call_id.clone(),
            name: tool_name.clone(),
        });
        let content = evt.get("content").and_then(Value::as_object);
        let timestamp = evt_ts(evt, self.msg.created_at);
        let act_start = content
            .and_then(|map| num_or(map.get("start_time")))
            .unwrap_or(timestamp);
        let act_end = content
            .and_then(|map| num_or(map.get("finish_time")))
            .unwrap_or(timestamp);
        self.all_tool_start_times.push(act_start);
        self.all_tool_end_times.push(act_end);
        let (args, result) = activity_payload(&activity_type, content);
        let start = content
            .and_then(|map| num_or(map.get("start_time")))
            .unwrap_or(timestamp);
        let raw_finish = content
            .and_then(|map| num_or(map.get("finish_time")))
            .unwrap_or(timestamp);
        let finish = if raw_finish > start {
            raw_finish
        } else {
            start + 1.0
        };
        let duration = if finish > start {
            Some(finish - start)
        } else {
            None
        };
        let status = activity_status(content);
        let error_message = activity_error_message(content);
        self.push_activity_call(&tool_call_id, &tool_name, start, args);
        self.push_activity_result(
            &tool_call_id,
            &tool_name,
            finish,
            tool_idx + 1,
            ActivityResult {
                result,
                duration,
                status,
                error_message,
            },
        );
        self.tool_idx += 2;
        if let Some(step) = &mut self.current_step {
            step.has_tool_calls = true;
        }
    }

    fn synthesize_orphan_steps(&mut self) {
        let mut with_llm = HashSet::new();
        let mut with_tools: Vec<(String, Vec<AgentActivityEntry>)> = Vec::new();
        for entry in &self.entries {
            let Some(step_id) = entry.step_id.clone().filter(|id| !id.is_empty()) else {
                continue;
            };
            match entry.event_name {
                Some(AgentEventName::LlmRequest | AgentEventName::LlmResponse) => {
                    with_llm.insert(step_id);
                }
                Some(AgentEventName::ToolCall | AgentEventName::ToolResult) => {
                    if let Some(index) = with_tools.iter().position(|(id, _)| id == &step_id) {
                        with_tools[index].1.push(entry.clone());
                    } else {
                        with_tools.push((step_id, vec![entry.clone()]));
                    }
                }
                _ => {}
            }
        }
        let mut synthesized = Vec::new();
        for (step_id, tool_entries) in with_tools {
            if with_llm.contains(&step_id) {
                continue;
            }
            synthesized.extend(self.synth_pair(&step_id, &tool_entries));
        }
        self.entries.extend(synthesized);
    }

    fn synth_pair(
        &self,
        step_id: &str,
        tool_entries: &[AgentActivityEntry],
    ) -> Vec<AgentActivityEntry> {
        let mut output_parts = Vec::new();
        for entry in tool_entries {
            if entry.event_name != Some(AgentEventName::ToolCall) {
                continue;
            }
            output_parts.push(json_obj([
                ("type", Value::String("tool_call".into())),
                (
                    "id",
                    Value::String(entry.tool_call_id.clone().unwrap_or_default()),
                ),
                (
                    "name",
                    Value::String(entry.tool_name.clone().unwrap_or_default()),
                ),
            ]));
        }
        let tool_times: Vec<f64> = tool_entries
            .iter()
            .map(|entry| nanos_to_millis(&entry.time_unix_nano))
            .collect();
        let request_ts = min_of(&tool_times) - 1.0;
        let response_ts = max_of(&[&tool_times]) + 1.0;
        let parent = tool_entries
            .first()
            .and_then(|entry| entry.parent_span_id.clone())
            .unwrap_or_else(|| self.agent_span_id.clone());
        let continued = if self.user_content.is_empty() {
            "(continued)".to_string()
        } else {
            self.user_content.clone()
        };
        let user = json_obj([
            ("role", Value::String("user".into())),
            (
                "parts",
                Value::Array(vec![json_obj([
                    ("type", Value::String("text".into())),
                    ("content", Value::String(continued)),
                ])]),
            ),
        ]);
        let attributes = Value::Object(short_attributes(&self.llm_attributes(false), false));
        let mut request = Map::new();
        request.insert("timestamp".into(), number_value(request_ts));
        request.insert(
            "event.id".into(),
            Value::String(hash_id(&[
                self.task.session_id.clone(),
                self.msg.id.clone(),
                "synth-request".into(),
                step_id.to_string(),
            ])),
        );
        request.insert("event.name".into(), Value::String("llm.request".into()));
        request.insert("gen_ai.turn.id".into(), Value::String(self.turn_id.clone()));
        request.insert("gen_ai.step.id".into(), Value::String(step_id.to_string()));
        request.insert(
            "gen_ai.request.model".into(),
            Value::String(self.model.clone()),
        );
        if let Some(run_id) = &self.run_id {
            request.insert("gen_ai.response.id".into(), Value::String(run_id.clone()));
        }
        request.insert("trace_id".into(), Value::String(self.trace_id.clone()));
        request.insert(
            "gen_ai.input.messages_delta".into(),
            Value::Array(vec![user.clone()]),
        );
        request.insert("attributes".into(), attributes.clone());

        let mut response = Map::new();
        response.insert("timestamp".into(), number_value(response_ts));
        response.insert(
            "event.id".into(),
            Value::String(hash_id(&[
                self.task.session_id.clone(),
                self.msg.id.clone(),
                "synth-response".into(),
                step_id.to_string(),
            ])),
        );
        response.insert("event.name".into(), Value::String("llm.response".into()));
        response.insert("gen_ai.turn.id".into(), Value::String(self.turn_id.clone()));
        response.insert("gen_ai.step.id".into(), Value::String(step_id.to_string()));
        response.insert(
            "gen_ai.request.model".into(),
            Value::String(self.model.clone()),
        );
        response.insert(
            "gen_ai.response.model".into(),
            Value::String(self.model.clone()),
        );
        if let Some(run_id) = &self.run_id {
            response.insert("gen_ai.response.id".into(), Value::String(run_id.clone()));
        }
        response.insert(
            "gen_ai.response.finish_reasons".into(),
            Value::Array(vec![Value::String("tool_calls".into())]),
        );
        response.insert("trace_id".into(), Value::String(self.trace_id.clone()));
        response.insert("span_id".into(), Value::String(random_hex(8)));
        response.insert("parent_span_id".into(), Value::String(parent));
        response.insert("gen_ai.input.messages".into(), Value::Array(vec![user]));
        if !output_parts.is_empty() {
            response.insert(
                "gen_ai.output.messages".into(),
                Value::Array(vec![json_obj([
                    ("role", Value::String("assistant".into())),
                    ("parts", Value::Array(output_parts)),
                ])]),
            );
        }
        insert_usage(
            &mut response,
            &TokenUsage {
                input: 0.0,
                output: 0.0,
                cached: 0.0,
                total: 0.0,
            },
        );
        response.insert("attributes".into(), attributes);
        vec![self.built(request), self.built(response)]
    }

    fn backfill(&mut self) {
        let first = self
            .entries
            .iter()
            .find_map(|entry| entry.step_id.clone().filter(|id| !id.is_empty()));
        for entry in &mut self.entries {
            if entry.step_id.as_deref().map(str::is_empty).unwrap_or(true) {
                if let Some(first) = &first {
                    entry.step_id = Some(first.clone());
                }
            }
            if entry.trace_id.as_deref().map(str::is_empty).unwrap_or(true) {
                entry.trace_id = Some(self.trace_id.clone());
            }
        }
    }

    fn enrich_tool_responses(&mut self) {
        let mut by_step: Vec<(String, Vec<Value>)> = Vec::new();
        for entry in &self.entries {
            if entry.event_name != Some(AgentEventName::ToolResult) {
                continue;
            }
            let Some(step_id) = entry.step_id.clone().filter(|id| !id.is_empty()) else {
                continue;
            };
            let message = json_obj([
                ("role", Value::String("tool".into())),
                (
                    "parts",
                    Value::Array(vec![json_obj([
                        ("type", Value::String("tool_call_response".into())),
                        (
                            "id",
                            Value::String(entry.tool_call_id.clone().unwrap_or_default()),
                        ),
                        (
                            "response",
                            Value::String(tool_response_text(entry.tool_call_result.as_ref())),
                        ),
                    ])]),
                ),
            ]);
            if let Some(index) = by_step.iter().position(|(id, _)| id == &step_id) {
                by_step[index].1.push(message);
            } else {
                by_step.push((step_id, vec![message]));
            }
        }
        let mut step_ids = Vec::new();
        for entry in &self.entries {
            if let Some(step_id) = entry.step_id.clone().filter(|id| !id.is_empty()) {
                if !step_ids.contains(&step_id) {
                    step_ids.push(step_id);
                }
            }
        }
        step_ids.sort_by_key(|id| step_number(id));
        for index in 1..step_ids.len() {
            let prev = step_ids[index - 1].clone();
            let current = step_ids[index].clone();
            let Some(prior) = by_step
                .iter()
                .find(|(id, _)| id == &prev)
                .map(|(_, messages)| messages.clone())
            else {
                continue;
            };
            if prior.is_empty() {
                continue;
            }
            if let Some(entry) = self.entries.iter_mut().find(|entry| {
                entry.event_name == Some(AgentEventName::LlmRequest)
                    && entry.step_id.as_deref() == Some(current.as_str())
            }) {
                let mut merged = prior;
                if let Some(Value::Array(existing)) = entry.input_messages_delta.clone() {
                    merged.extend(existing);
                }
                entry.input_messages_delta = Some(Value::Array(merged));
            }
        }
    }

    fn push_tool_call(&mut self, tc_id: &str, tool_name: &str, timestamp: f64, args: Option<&str>) {
        let mut fields = self.tool_base("tool_call", tc_id, tool_name, timestamp);
        if let Some(args) = args.filter(|text| !text.is_empty()) {
            fields.insert("gen_ai.tool.call.arguments".into(), parse_tool_args(args));
        }
        fields.insert(
            "attributes".into(),
            Value::Object(tool_attributes(&self.msg.id)),
        );
        self.push_entry(fields);
    }

    fn push_tool_result(
        &mut self,
        tc_id: &str,
        tool_name: &str,
        timestamp: f64,
        evt: &Map<String, Value>,
        duration: Option<f64>,
    ) {
        let mut fields = self.tool_base("tool_result", tc_id, tool_name, timestamp);
        if let Some(result) = nullish_value(evt, "result").or_else(|| nullish_value(evt, "output"))
        {
            fields.insert("gen_ai.tool.call.result".into(), result);
        }
        if let Some(duration) = duration {
            fields.insert("gen_ai.tool.call.duration".into(), number_value(duration));
        }
        let failed = js_truthy(evt.get("error")) || js_truthy(evt.get("isError"));
        fields.insert(
            "tool.result.status".into(),
            Value::String(if failed { "failure" } else { "success" }.into()),
        );
        if failed {
            if let Some(error) = evt.get("error").filter(|value| js_truthy(Some(value))) {
                fields.insert("error.type".into(), Value::String(js_coerce(error)));
            }
        }
        fields.insert(
            "attributes".into(),
            Value::Object(tool_attributes(&self.msg.id)),
        );
        self.push_entry(fields);
    }

    fn push_activity_call(
        &mut self,
        tc_id: &str,
        tool_name: &str,
        timestamp: f64,
        args: Option<Value>,
    ) {
        let mut fields = Map::new();
        fields.insert(
            "timestamp".into(),
            number_value(truthy_ts(timestamp, self.msg.created_at)),
        );
        fields.insert(
            "event.id".into(),
            Value::String(hash_id(&[
                self.task.session_id.clone(),
                self.msg.id.clone(),
                "activity_call".into(),
                tc_id.to_string(),
                self.tool_idx.to_string(),
            ])),
        );
        fields.insert("event.name".into(), Value::String("tool.call".into()));
        self.insert_tool_identity(&mut fields, tc_id, tool_name);
        if let Some(args) = args {
            fields.insert("gen_ai.tool.call.arguments".into(), args);
        }
        fields.insert("trace_id".into(), Value::String(self.trace_id.clone()));
        fields.insert("span_id".into(), Value::String(random_hex(8)));
        fields.insert("parent_span_id".into(), Value::String(self.parent_span()));
        fields.insert(
            "attributes".into(),
            Value::Object(tool_attributes(&self.msg.id)),
        );
        self.push_entry(fields);
    }

    fn push_activity_result(
        &mut self,
        tc_id: &str,
        tool_name: &str,
        timestamp: f64,
        tool_idx: i64,
        outcome: ActivityResult<'_>,
    ) {
        let ActivityResult {
            result,
            duration,
            status,
            error_message,
        } = outcome;
        let mut fields = Map::new();
        fields.insert(
            "timestamp".into(),
            number_value(truthy_ts(timestamp, self.msg.created_at)),
        );
        fields.insert(
            "event.id".into(),
            Value::String(hash_id(&[
                self.task.session_id.clone(),
                self.msg.id.clone(),
                "activity_result".into(),
                tc_id.to_string(),
                tool_idx.to_string(),
            ])),
        );
        fields.insert("event.name".into(), Value::String("tool.result".into()));
        self.insert_tool_identity(&mut fields, tc_id, tool_name);
        if let Some(result) = result {
            fields.insert("gen_ai.tool.call.result".into(), result);
        }
        if let Some(duration) = duration {
            fields.insert("gen_ai.tool.call.duration".into(), number_value(duration));
        }
        fields.insert(
            "tool.result.status".into(),
            Value::String(status.to_string()),
        );
        if let Some(message) = error_message {
            fields.insert("error.message".into(), Value::String(message));
        }
        fields.insert("trace_id".into(), Value::String(self.trace_id.clone()));
        fields.insert("span_id".into(), Value::String(random_hex(8)));
        fields.insert("parent_span_id".into(), Value::String(self.parent_span()));
        fields.insert(
            "attributes".into(),
            Value::Object(tool_attributes(&self.msg.id)),
        );
        self.push_entry(fields);
    }

    fn tool_base(
        &self,
        kind: &str,
        tc_id: &str,
        tool_name: &str,
        timestamp: f64,
    ) -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert(
            "timestamp".into(),
            number_value(truthy_ts(timestamp, self.msg.created_at)),
        );
        fields.insert(
            "event.id".into(),
            Value::String(hash_id(&[
                self.task.session_id.clone(),
                self.msg.id.clone(),
                kind.to_string(),
                tc_id.to_string(),
                self.tool_idx.to_string(),
            ])),
        );
        fields.insert(
            "event.name".into(),
            Value::String(
                if kind == "tool_call" {
                    "tool.call"
                } else {
                    "tool.result"
                }
                .into(),
            ),
        );
        self.insert_tool_identity(&mut fields, tc_id, tool_name);
        fields.insert("trace_id".into(), Value::String(self.trace_id.clone()));
        fields.insert("span_id".into(), Value::String(random_hex(8)));
        fields.insert("parent_span_id".into(), Value::String(self.parent_span()));
        fields
    }

    fn insert_tool_identity(&self, fields: &mut Map<String, Value>, tc_id: &str, tool_name: &str) {
        fields.insert("gen_ai.turn.id".into(), Value::String(self.turn_id.clone()));
        if let Some(step_id) = self.current_step.as_ref().map(|step| step.step_id.clone()) {
            fields.insert("gen_ai.step.id".into(), Value::String(step_id));
        }
        fields.insert(
            "gen_ai.request.model".into(),
            Value::String(self.model.clone()),
        );
        fields.insert(
            "gen_ai.tool.name".into(),
            Value::String(tool_name.to_string()),
        );
        fields.insert(
            "gen_ai.tool.call.id".into(),
            Value::String(tc_id.to_string()),
        );
    }

    fn llm_base(&self, step: &StepContext, kind: &str) -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert(
            "event.id".into(),
            Value::String(hash_id(&[
                self.task.session_id.clone(),
                self.msg.id.clone(),
                kind.to_string(),
                step.step_index.to_string(),
            ])),
        );
        fields.insert("gen_ai.turn.id".into(), Value::String(self.turn_id.clone()));
        fields.insert("gen_ai.step.id".into(), Value::String(step.step_id.clone()));
        if let Some(run_id) = &self.run_id {
            fields.insert("gen_ai.response.id".into(), Value::String(run_id.clone()));
        }
        fields.insert("trace_id".into(), Value::String(self.trace_id.clone()));
        fields
    }

    fn output_parts(&self) -> Vec<Value> {
        let mut parts = Vec::new();
        if !self.text_content.is_empty() {
            parts.push(json_obj([
                ("type", Value::String("text".into())),
                ("content", Value::String(self.text_content.clone())),
            ]));
        }
        for part in &self.tool_call_parts {
            parts.push(tool_part_json(part));
        }
        if parts.is_empty() {
            if let Some(err) = &self.run_error {
                parts.push(json_obj([
                    ("type", Value::String("text".into())),
                    (
                        "content",
                        Value::String(format!("[error] {}: {}", err.code, err.message)),
                    ),
                ]));
            }
        }
        parts
    }

    fn user_message(&self) -> Value {
        json_obj([
            ("role", Value::String("user".into())),
            (
                "parts",
                Value::Array(vec![json_obj([
                    ("type", Value::String("text".into())),
                    ("content", Value::String(self.user_content.clone())),
                ])]),
            ),
        ])
    }

    fn token_usage(&self) -> TokenUsage {
        let input = num_or(
            self.usage_event
                .as_ref()
                .and_then(|evt| evt.get("prompt_tokens")),
        )
        .unwrap_or(0.0);
        let output = num_or(
            self.usage_event
                .as_ref()
                .and_then(|evt| evt.get("completion_tokens")),
        )
        .unwrap_or(0.0);
        let cached = num_or(
            self.usage_event
                .as_ref()
                .and_then(|evt| evt.get("cached_tokens")),
        )
        .unwrap_or(0.0);
        let total = num_or(
            self.usage_event
                .as_ref()
                .and_then(|evt| evt.get("total_tokens")),
        )
        .unwrap_or(input + output);
        TokenUsage {
            input,
            output,
            cached,
            total,
        }
    }

    fn llm_attributes(&self, detailed: bool) -> Map<String, Value> {
        let mut attributes = Map::new();
        attributes.insert("source".into(), Value::String("wukong".into()));
        attributes.insert("message_id".into(), Value::String(self.msg.id.clone()));
        attributes.insert(
            "conversation_id".into(),
            Value::String(self.msg.conversation_id.clone()),
        );
        if detailed {
            if let Some(first) = &self.first_token {
                if let Some(value) = first.get("ttft_ms") {
                    attributes.insert("ttft_ms".into(), value.clone());
                }
                if let Some(value) = first.get("e2e_ttft_ms") {
                    attributes.insert("e2e_ttft_ms".into(), value.clone());
                }
            }
            if let (Some(start), Some(end)) = (self.run_started_ts, self.run_finished_ts) {
                if js_num_truthy(start) && js_num_truthy(end) {
                    attributes.insert("run_duration_ms".into(), number_value(end - start));
                }
            }
        }
        attributes
    }

    fn parent_span(&self) -> String {
        self.current_step
            .as_ref()
            .map(|step| step.step_span_id.clone())
            .unwrap_or_else(|| self.agent_span_id.clone())
    }

    fn push_entry(&mut self, fields: Map<String, Value>) {
        self.entries.push(self.built(fields));
    }

    fn built(&self, fields: Map<String, Value>) -> AgentActivityEntry {
        let mut map = self.common.clone();
        for (key, value) in fields {
            map.insert(key, value);
        }
        build_agent_activity_entry(&Value::Object(map))
    }
}

struct TokenUsage {
    input: f64,
    output: f64,
    cached: f64,
    total: f64,
}

fn insert_usage(fields: &mut Map<String, Value>, usage: &TokenUsage) {
    fields.insert(
        "gen_ai.usage.input_tokens".into(),
        number_value(usage.input),
    );
    fields.insert(
        "gen_ai.usage.output_tokens".into(),
        number_value(usage.output),
    );
    fields.insert(
        "gen_ai.usage.cache_read.input_tokens".into(),
        number_value(usage.cached),
    );
    fields.insert(
        "gen_ai.usage.total_tokens".into(),
        number_value(usage.total),
    );
}

fn finish_reasons(has_tool_calls: bool, run_error: bool) -> Vec<String> {
    if run_error {
        vec!["stop".into()]
    } else if has_tool_calls {
        vec!["tool_calls".into()]
    } else {
        vec!["end_turn".into()]
    }
}

fn request_timestamp(step_start: f64, run_started: Option<f64>, created_at: f64) -> f64 {
    let maxed = step_start.max(run_started.unwrap_or(0.0));
    if maxed == 0.0 || !maxed.is_finite() {
        created_at
    } else {
        maxed
    }
}

fn response_timestamp(
    request_ts: f64,
    has_tools: bool,
    tool_starts: &[f64],
    run_finished: Option<f64>,
    created_at: f64,
) -> f64 {
    if has_tools && !tool_starts.is_empty() {
        (request_ts + 1.0).max(min_of(tool_starts) - 1.0)
    } else if has_tools {
        request_ts + 1.0
    } else {
        (request_ts + 1.0).max(run_finished.unwrap_or(created_at))
    }
}

fn activity_payload(
    activity_type: &str,
    content: Option<&Map<String, Value>>,
) -> (Option<Value>, Option<Value>) {
    let Some(content) = content else {
        return (None, None);
    };
    match activity_type {
        "TERMINAL" => {
            let args =
                truthy_clone(content, "command").map(|command| json_obj([("command", command)]));
            let result = copy_defined(content, &["output", "exit_code"]);
            (args, Some(result))
        }
        "FILE_WRITE" => {
            let path =
                nullish_clone(content, "path").or_else(|| nullish_clone(content, "file_path"));
            let args = compact([("path", path)]);
            let status = match content.get("status") {
                None | Some(Value::Null) => Value::String("done".into()),
                Some(value) => value.clone(),
            };
            (args, Some(json_obj([("status", status)])))
        }
        "FILE_READ" => (
            compact([
                ("path", nullish_clone(content, "path")),
                ("start_line", nullish_clone(content, "start_line")),
            ]),
            compact([
                ("content", nullish_clone(content, "content")),
                ("snippet", nullish_clone(content, "snippet")),
                ("total_lines", nullish_clone(content, "total_lines")),
                ("status", nullish_clone(content, "status")),
                ("error_message", nullish_clone(content, "error_message")),
            ]),
        ),
        "GREP_SEARCH" => {
            let args = truthy_clone(content, "query").map(|query| json_obj([("query", query)]));
            let result =
                nullish_clone(content, "matches").or_else(|| nullish_clone(content, "output"));
            (args, result)
        }
        "SEARCH" => (
            compact([
                ("queries", nullish_clone(content, "queries")),
                ("search_type", nullish_clone(content, "search_type")),
            ]),
            compact([
                ("results", nullish_clone(content, "results")),
                ("status", nullish_clone(content, "status")),
            ]),
        ),
        "DIRECTORY_LIST" => {
            let args = truthy_clone(content, "path").map(|path| json_obj([("path", path)]));
            let result = nullish_clone(content, "entries")
                .or_else(|| nullish_clone(content, "output"))
                .or_else(|| {
                    compact([
                        ("files", nullish_clone(content, "files")),
                        ("total_count", nullish_clone(content, "total_count")),
                        ("status", nullish_clone(content, "status")),
                    ])
                });
            (args, result)
        }
        "SKILL" => (
            compact([
                ("skill_name", nullish_clone(content, "skill_name")),
                ("purpose", nullish_clone(content, "purpose")),
                ("meta", nullish_clone(content, "meta")),
            ]),
            compact([
                ("output", nullish_clone(content, "output")),
                ("status", nullish_clone(content, "status")),
                ("error_message", nullish_clone(content, "error_message")),
            ]),
        ),
        "ARTIFACT" => (
            None,
            compact([
                (
                    "artifactsMetadata",
                    nullish_clone(content, "artifactsMetadata"),
                ),
                ("generatedAt", nullish_clone(content, "generatedAt")),
            ]),
        ),
        _ => (
            nullish_clone(content, "input"),
            nullish_clone(content, "output").or_else(|| nullish_clone(content, "result")),
        ),
    }
}

fn activity_status(content: Option<&Map<String, Value>>) -> &'static str {
    let Some(content) = content else {
        return "success";
    };
    if let Some(exit_code) = content.get("exit_code") {
        let zero = matches!(exit_code, Value::Number(number) if number.as_f64() == Some(0.0));
        if !zero {
            return "failure";
        }
    }
    if let Some(Value::String(message)) = content.get("error_message") {
        if !message.is_empty() {
            return "failure";
        }
    }
    let Some(Value::String(status)) = content.get("status") else {
        return "success";
    };
    match status.to_lowercase().as_str() {
        "error" | "failed" | "failure" => "failure",
        "cancelled" | "canceled" => "cancelled",
        _ => "success",
    }
}

fn activity_error_message(content: Option<&Map<String, Value>>) -> Option<String> {
    match content.and_then(|map| map.get("error_message")) {
        Some(Value::String(message)) if !message.is_empty() => Some(message.clone()),
        _ => None,
    }
}

fn activity_tool_name(activity_type: &str) -> String {
    match activity_type {
        "TERMINAL" => "terminal".into(),
        "FILE_WRITE" => "file_write".into(),
        "FILE_READ" => "file_read".into(),
        "GREP_SEARCH" => "grep_search".into(),
        "SEARCH" => "search".into(),
        "DIRECTORY_LIST" => "directory_list".into(),
        "SKILL" => "skill".into(),
        "ARTIFACT" => "artifact".into(),
        other => other.to_lowercase(),
    }
}

fn resolve_turn_id(session_id: &str, msg: &WukongMessage) -> String {
    match msg.turn_index {
        Some(index) if index >= 0.0 && index.is_finite() => {
            format!("{session_id}:t{}", format_js_number(index))
        }
        _ => format!("{session_id}:{}", msg.id),
    }
}

fn format_js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map(|number| number.to_string())
            .unwrap_or_else(|| value.to_string())
    }
}

fn tool_name_of(evt: &Map<String, Value>) -> String {
    string_prop(evt, "toolName")
        .or_else(|| string_prop(evt, "name"))
        .unwrap_or_default()
}

fn parse_tool_args(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn tool_part_json(part: &ToolPart) -> Value {
    json_obj([
        ("type", Value::String(part.part_type.clone())),
        ("id", Value::String(part.id.clone())),
        ("name", Value::String(part.name.clone())),
    ])
}

fn tool_attributes(message_id: &str) -> Map<String, Value> {
    let mut attributes = Map::new();
    attributes.insert("source".into(), Value::String("wukong".into()));
    attributes.insert("message_id".into(), Value::String(message_id.to_string()));
    attributes
}

fn short_attributes(attributes: &Map<String, Value>, detailed: bool) -> Map<String, Value> {
    if detailed {
        return attributes.clone();
    }
    let mut short = Map::new();
    for key in ["source", "message_id", "conversation_id"] {
        if let Some(value) = attributes.get(key) {
            short.insert(key.to_string(), value.clone());
        }
    }
    short
}

fn tool_response_text(result: Option<&Value>) -> String {
    match result {
        Some(Value::String(text)) => text.clone(),
        other => {
            let value = match other {
                None | Some(Value::Null) => Value::String(String::new()),
                Some(value) => value.clone(),
            };
            serde_json::to_string(&value).unwrap_or_else(|_| "null".into())
        }
    }
}

fn step_number(step_id: &str) -> i64 {
    let Some(index) = step_id.rfind(":s") else {
        return 0;
    };
    let rest = &step_id[index + 2..];
    if rest.is_empty() || !rest.bytes().all(|byte| byte.is_ascii_digit()) {
        return 0;
    }
    rest.parse().unwrap_or(0)
}

fn nanos_to_millis(nanos: &str) -> f64 {
    nanos.trim().parse::<f64>().unwrap_or(0.0) / 1_000_000.0
}

fn hash_id(parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hasher.update([0u8]);
        }
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn random_hex(bytes: usize) -> String {
    let mut buf = Vec::with_capacity(bytes);
    while buf.len() < bytes {
        buf.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    buf.truncate(bytes);
    hex::encode(buf)
}

fn host_name() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_default()
}

fn event_type(evt: &Value) -> &str {
    evt.get("type").and_then(Value::as_str).unwrap_or("")
}

fn event_type_map(evt: &Map<String, Value>) -> String {
    string_prop(evt, "type").unwrap_or_default()
}

fn sanitize_event(raw: &Value, created_at: f64) -> Map<String, Value> {
    let mut obj = raw.as_object().cloned().unwrap_or_default();
    let sanitized = num_or(obj.get("timestamp")).unwrap_or(created_at);
    let same = num_or(obj.get("timestamp")).is_some_and(|value| value == sanitized);
    if !same {
        obj.insert("timestamp".into(), number_value(sanitized));
    }
    obj
}

fn evt_ts(evt: &Map<String, Value>, created_at: f64) -> f64 {
    num_or(evt.get("timestamp")).unwrap_or(created_at)
}

fn truthy_ts(timestamp: f64, created_at: f64) -> f64 {
    if timestamp == 0.0 || !timestamp.is_finite() {
        created_at
    } else {
        timestamp
    }
}

fn num_or(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        _ => None,
    }
}

fn number_value(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&value)
    {
        Value::from(value as i64)
    } else if let Some(number) = serde_json::Number::from_f64(value) {
        Value::Number(number)
    } else {
        Value::Null
    }
}

fn js_num_truthy(value: f64) -> bool {
    value != 0.0 && value.is_finite()
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|value| value != 0.0 && value.is_finite()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn js_coerce(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items.iter().map(js_coerce).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn string_prop(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn coerce_nullish(map: &Map<String, Value>, key: &str, default: &str) -> String {
    match map.get(key) {
        None | Some(Value::Null) => default.to_string(),
        Some(value) => js_coerce(value),
    }
}

fn nullish_value(map: &Map<String, Value>, key: &str) -> Option<Value> {
    match map.get(key) {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.clone()),
    }
}

fn nullish_clone(map: &Map<String, Value>, key: &str) -> Option<Value> {
    nullish_value(map, key)
}

fn truthy_clone(map: &Map<String, Value>, key: &str) -> Option<Value> {
    let value = map.get(key)?;
    js_truthy(Some(value)).then(|| value.clone())
}

fn compact<const N: usize>(pairs: [(&str, Option<Value>); N]) -> Option<Value> {
    let mut map = Map::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            if !value.is_null() {
                map.insert(key.to_string(), value);
            }
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map))
    }
}

fn copy_defined(map: &Map<String, Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = map.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(out)
}

fn json_obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

fn min_of(values: &[f64]) -> f64 {
    let mut min = f64::INFINITY;
    for value in values {
        if *value < min {
            min = *value;
        }
    }
    min
}

fn max_of(groups: &[&[f64]]) -> f64 {
    let mut max = f64::NEG_INFINITY;
    for group in groups {
        for value in *group {
            if *value > max {
                max = *value;
            }
        }
    }
    max
}
