//! Port of `workbuddy-event-builder.ts`.
//!
//! A user message opens a turn. Reasoning is held until the next assistant or
//! tool wave. Parallel `function_call` rows that share a response id are one
//! wave. A later user message, or an `incomplete` assistant row, cancels the
//! open turn. Hook events fill a missing tool id, name, or timestamp only when
//! the match is unique.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::types::{WorkBuddyBuildOptions, WorkBuddyHookEvent, WorkBuddyRecord};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::{AgentActivityEntry, AgentEventName, ClientType};

struct StepContext {
    step_id: String,
    request_id: String,
    turn_id: String,
    trace_id: String,
    provider: String,
    request_model: Option<String>,
    response_model: Option<String>,
}

impl Clone for StepContext {
    fn clone(&self) -> Self {
        Self {
            step_id: self.step_id.clone(),
            request_id: self.request_id.clone(),
            turn_id: self.turn_id.clone(),
            trace_id: self.trace_id.clone(),
            provider: self.provider.clone(),
            request_model: self.request_model.clone(),
            response_model: self.response_model.clone(),
        }
    }
}

struct ToolContext {
    step: StepContext,
    call_timestamp: f64,
    tool_name: String,
}

impl Clone for ToolContext {
    fn clone(&self) -> Self {
        Self {
            step: self.step.clone(),
            call_timestamp: self.call_timestamp,
            tool_name: self.tool_name.clone(),
        }
    }
}

struct IndexedRecord {
    record: WorkBuddyRecord,
    index: usize,
}

struct ResolvedToolCall {
    record: WorkBuddyRecord,
    call_id: String,
    tool_name: String,
    call_timestamp: f64,
}

struct TrackedHook {
    event: WorkBuddyHookEvent,
    consumed: bool,
}

struct HookEventResolver {
    events: Vec<TrackedHook>,
}

impl HookEventResolver {
    fn new(events: &[WorkBuddyHookEvent]) -> Self {
        let mut events: Vec<WorkBuddyHookEvent> = events
            .iter()
            .filter(|event| event.observed_at_ms.is_finite())
            .cloned()
            .collect();
        events.sort_by(|left, right| {
            left.observed_at_ms
                .partial_cmp(&right.observed_at_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Self {
            events: events
                .into_iter()
                .map(|event| TrackedHook {
                    event,
                    consumed: false,
                })
                .collect(),
        }
    }

    fn take_boundary(&mut self, event_name: &str) -> Option<WorkBuddyHookEvent> {
        let index = self
            .events
            .iter()
            .position(|event| !event.consumed && event.event.event_name == event_name)?;
        self.events[index].consumed = true;
        Some(self.events[index].event.clone())
    }

    /// `call_id` / `tool_name` of `None` or `""` do not filter, matching JS truthiness.
    /// More than one candidate is ambiguous and is left unconsumed.
    fn take_tool(
        &mut self,
        event_name: &str,
        call_id: Option<&str>,
        tool_name: Option<&str>,
    ) -> Option<WorkBuddyHookEvent> {
        let call_id = call_id.filter(|value| !value.is_empty());
        let tool_name = tool_name.filter(|value| !value.is_empty());
        let matches: Vec<usize> = self
            .events
            .iter()
            .enumerate()
            .filter(|(_, event)| {
                if event.consumed || event.event.event_name != event_name {
                    return false;
                }
                if let Some(call_id) = call_id {
                    if event.event.tool_call_id.as_deref() != Some(call_id) {
                        return false;
                    }
                }
                if let Some(tool_name) = tool_name {
                    if event.event.tool_name.as_deref() != Some(tool_name) {
                        return false;
                    }
                }
                true
            })
            .map(|(index, _)| index)
            .collect();
        if matches.len() != 1 {
            return None;
        }
        let index = matches[0];
        self.events[index].consumed = true;
        Some(self.events[index].event.clone())
    }
}

struct Builder {
    session_id: String,
    built: Vec<AgentActivityEntry>,
    tools: IndexMap<String, ToolContext>,
    hooks: HookEventResolver,
    result_names: HashMap<String, String>,
    turn_id: String,
    turn_ordinal: u64,
    step_ordinal: u64,
    first_step: bool,
    pending_delta: Vec<Value>,
    reasoning_parts: Vec<Value>,
    reasoning_start_ms: Option<f64>,
    request_start_ms: Option<f64>,
    cwd: Option<String>,
    last_response: Option<usize>,
}

pub async fn build_work_buddy_events(
    records: &[Value],
    opts: &WorkBuddyBuildOptions,
) -> Result<Vec<AgentActivityEntry>, String> {
    let records: Vec<WorkBuddyRecord> = records
        .iter()
        .map(|value| value.as_object().cloned().unwrap_or_default())
        .collect();
    let mut builder = Builder {
        session_id: opts.session_id.clone(),
        built: Vec::new(),
        tools: IndexMap::new(),
        hooks: HookEventResolver::new(&opts.hook_events),
        result_names: HashMap::new(),
        turn_id: stable_id(&opts.session_id, "turn:unknown"),
        turn_ordinal: 0,
        step_ordinal: 0,
        first_step: true,
        pending_delta: Vec::new(),
        reasoning_parts: Vec::new(),
        reasoning_start_ms: None,
        request_start_ms: None,
        cwd: None,
        last_response: None,
    };
    for record in &records {
        if record.get("type").and_then(Value::as_str) != Some("function_call_result") {
            continue;
        }
        if let (Some(call_id), Some(tool_name)) = (
            string_value(record.get("callId")),
            string_value(record.get("name")),
        ) {
            builder
                .result_names
                .insert(call_id.to_string(), tool_name.to_string());
        }
    }
    builder.run(&records).await?;
    Ok(builder.built)
}

impl Builder {
    async fn run(&mut self, records: &[WorkBuddyRecord]) -> Result<(), String> {
        let mut index = 0usize;
        while index < records.len() {
            let record = records[index].clone();
            if is_internal_record(&record) {
                index += 1;
                continue;
            }
            if let Some(cwd) = string_value(record.get("cwd")) {
                self.cwd = Some(cwd.to_string());
            }
            let kind = string_value(record.get("type")).map(str::to_string);
            let role = string_value(record.get("role")).map(str::to_string);

            if kind.as_deref() == Some("message") && role.as_deref() == Some("user") {
                self.close_interrupted_turn(&record).await?;
                self.tools.clear();
                self.turn_ordinal += 1;
                self.step_ordinal = 0;
                self.first_step = true;
                self.turn_id = string_value(record.get("id"))
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        let seed = match finite_f64(record.get("timestamp")) {
                            Some(timestamp) => format!(
                                "turn:{}:{}",
                                self.turn_ordinal,
                                js_number_string(timestamp)
                            ),
                            None => format!("turn:{}:{index}", self.turn_ordinal),
                        };
                        stable_id(&self.session_id, &seed)
                    });
                self.last_response = None;
                let message = to_message(&record, "user");
                let parts_empty = message
                    .get("parts")
                    .and_then(Value::as_array)
                    .is_none_or(|parts| parts.is_empty());
                self.pending_delta = if parts_empty {
                    Vec::new()
                } else {
                    vec![message]
                };
                self.reasoning_parts.clear();
                self.reasoning_start_ms = None;
                self.request_start_ms = match timestamp_ms(&record) {
                    Some(timestamp) => Some(timestamp),
                    None => self
                        .hooks
                        .take_boundary("UserPromptSubmit")
                        .map(|event| event.observed_at_ms),
                };
                index += 1;
                continue;
            }

            if kind.as_deref() == Some("reasoning") {
                self.reasoning_parts.extend(to_reasoning_parts(&record));
                self.reasoning_start_ms =
                    earliest(&[self.reasoning_start_ms, timestamp_ms(&record)]);
                index += 1;
                continue;
            }

            if kind.as_deref() == Some("function_call") {
                let (calls, complete) = collect_function_call_wave(records, index, &record);
                if !complete {
                    break;
                }
                self.emit_tool_wave(&record, &calls, Vec::new()).await?;
                index = calls.last().map(|call| call.index).unwrap_or(index) + 1;
                continue;
            }

            if kind.as_deref() == Some("function_call_result") {
                self.emit_tool_result(&record).await?;
                index += 1;
                continue;
            }

            if kind.as_deref() == Some("message") && role.as_deref() == Some("assistant") {
                let incomplete = record.get("status").and_then(Value::as_str) == Some("incomplete");
                if incomplete {
                    self.close_interrupted_turn(&record).await?;
                    index += 1;
                    continue;
                }
                let (calls, complete) = collect_function_call_wave(records, index + 1, &record);
                if !calls.is_empty() {
                    if !complete {
                        break;
                    }
                    let assistant_parts = message_parts(&to_message(&record, "assistant"));
                    let last = calls.last().map(|call| call.index).unwrap_or(index);
                    self.emit_tool_wave(&record, &calls, assistant_parts)
                        .await?;
                    index = last + 1;
                    continue;
                }
                self.emit_assistant(&record).await?;
                index += 1;
                continue;
            }

            index += 1;
        }
        Ok(())
    }

    async fn close_interrupted_turn(&mut self, boundary: &WorkBuddyRecord) -> Result<bool, String> {
        let Some(boundary_timestamp) = timestamp_ms(boundary) else {
            return Ok(false);
        };
        if self.first_step || self.last_response.is_none() {
            return Ok(false);
        }
        let index = self.last_response.expect("checked");
        {
            let response = &mut self.built[index];
            response.finish_reasons = Some(vec!["cancelled".to_string()]);
            response.turn_end = Some(true);
            if let Some(Value::Array(messages)) = response.output_messages.as_mut() {
                for message in messages {
                    if let Value::Object(object) = message {
                        object.insert("finish_reason".into(), Value::String("cancelled".into()));
                    }
                }
            }
        }
        let turn_id = self.turn_id.clone();
        let pending: Vec<(String, ToolContext)> = self
            .tools
            .iter()
            .filter(|(_, tool)| tool.step.turn_id == turn_id)
            .map(|(call_id, tool)| (call_id.clone(), tool.clone()))
            .collect();
        for (call_id, tool) in pending {
            let mut result = base_entry(
                AgentEventName::ToolResult,
                boundary,
                &self.session_id,
                &tool.step,
                &format!("tool-result:{call_id}"),
                boundary_timestamp,
            );
            result.tool_name = Some(tool.tool_name.clone());
            result.tool_call_id = Some(call_id.clone());
            result.tool_result_status = Some("cancelled".to_string());
            let duration = boundary_timestamp - tool.call_timestamp;
            if duration > 0.0 {
                result.tool_call_duration = Some(duration);
            }
            self.push(result, boundary).await?;
            self.tools.shift_remove(&call_id);
        }
        Ok(true)
    }

    async fn emit_tool_wave(
        &mut self,
        response_source: &WorkBuddyRecord,
        calls: &[IndexedRecord],
        assistant_parts: Vec<Value>,
    ) -> Result<(), String> {
        self.step_ordinal += 1;
        let step = step_context(
            response_source,
            &self.session_id,
            &self.turn_id,
            self.step_ordinal,
        );
        let mut normalized = Vec::new();
        for indexed in calls {
            let native_call_id = string_value(indexed.record.get("callId"));
            let native_tool_name = string_value(indexed.record.get("name"));
            let hook = if let Some(call_id) = native_call_id {
                self.hooks.take_tool("PreToolUse", Some(call_id), None)
            } else {
                self.hooks.take_tool("PreToolUse", None, native_tool_name)
            };
            let call_id = native_call_id
                .map(str::to_string)
                .or_else(|| hook.as_ref().and_then(|event| event.tool_call_id.clone()));
            let tool_name = native_tool_name
                .map(str::to_string)
                .or_else(|| {
                    call_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .and_then(|id| self.result_names.get(id).cloned())
                })
                .or_else(|| hook.as_ref().and_then(|event| event.tool_name.clone()));
            let (Some(call_id), Some(tool_name)) = (call_id, tool_name) else {
                continue;
            };
            if call_id.is_empty() || tool_name.is_empty() {
                continue;
            }
            let call_timestamp = timestamp_ms(&indexed.record)
                .or_else(|| hook.as_ref().map(|event| event.observed_at_ms));
            let Some(call_timestamp) = call_timestamp else {
                continue;
            };
            normalized.push(ResolvedToolCall {
                record: indexed.record.clone(),
                call_id,
                tool_name,
                call_timestamp,
            });
        }
        let response_timestamp = earliest(
            &std::iter::once(self.reasoning_start_ms)
                .chain(std::iter::once(timestamp_ms(response_source)))
                .chain(normalized.iter().map(|call| Some(call.call_timestamp)))
                .collect::<Vec<_>>(),
        );
        let Some(response_timestamp) = response_timestamp else {
            return Ok(());
        };
        let request_timestamp = self.request_start_ms.unwrap_or(response_timestamp);
        let assistant_tool_parts: Vec<Value> = normalized
            .iter()
            .map(|call| to_tool_call_part(&call.record, &call.call_id, &call.tool_name))
            .collect();
        let mut output_parts = self.reasoning_parts.clone();
        output_parts.extend(assistant_parts);
        output_parts.extend(assistant_tool_parts.iter().cloned());

        let mut request = base_entry(
            AgentEventName::LlmRequest,
            response_source,
            &self.session_id,
            &step,
            &format!("request:{}", step.step_id),
            request_timestamp,
        );
        request.request_id = Some(step.request_id.clone());
        if let Some(model) = &step.request_model {
            request.request_model = Some(model.clone());
        }
        if self.first_step {
            request.turn_start = Some(true);
        }
        if !self.pending_delta.is_empty() {
            request.input_messages_delta = Some(Value::Array(self.pending_delta.clone()));
        }

        let response_source_key = response_source_id(response_source);
        let mut response = base_entry(
            AgentEventName::LlmResponse,
            response_source,
            &self.session_id,
            &step,
            &format!("response:{response_source_key}:tool-wave"),
            response_timestamp,
        );
        response.response_id = Some(response_source_key);
        if let Some(model) = &step.response_model {
            response.response_model = Some(model.clone());
        }
        response.finish_reasons = Some(vec!["tool_call".to_string()]);
        response.output_messages = Some(json!([{
            "role": "assistant",
            "parts": output_parts,
            "finish_reason": "tool_call",
        }]));
        if let Some(last) = calls.last() {
            apply_usage(&mut response, &last.record);
        }

        self.push(request, response_source).await?;
        self.push(response, response_source).await?;
        self.last_response = Some(self.built.len() - 1);
        for call in &normalized {
            self.tools.insert(
                call.call_id.clone(),
                ToolContext {
                    step: step.clone(),
                    call_timestamp: call.call_timestamp,
                    tool_name: call.tool_name.clone(),
                },
            );
            let mut tool_call = base_entry(
                AgentEventName::ToolCall,
                &call.record,
                &self.session_id,
                &step,
                &format!("tool-call:{}", call.call_id),
                call.call_timestamp,
            );
            tool_call.tool_name = Some(call.tool_name.clone());
            tool_call.tool_call_id = Some(call.call_id.clone());
            if let Some(args) = parse_json_value(call.record.get("arguments")) {
                tool_call.tool_call_arguments = Some(args);
            }
            self.push(tool_call, &call.record).await?;
        }
        self.pending_delta = if assistant_tool_parts.is_empty() {
            Vec::new()
        } else {
            vec![json!({
                "role": "assistant",
                "parts": assistant_tool_parts,
            })]
        };
        self.reasoning_parts.clear();
        self.reasoning_start_ms = None;
        self.request_start_ms = Some(response_timestamp);
        self.first_step = false;
        Ok(())
    }

    async fn emit_tool_result(&mut self, record: &WorkBuddyRecord) -> Result<(), String> {
        let native_call_id = string_value(record.get("callId"));
        let native_tool_name = string_value(record.get("name"));
        let hook = if let Some(call_id) = native_call_id {
            self.hooks.take_tool("PostToolUse", Some(call_id), None)
        } else {
            self.hooks.take_tool("PostToolUse", None, native_tool_name)
        };
        let call_id = native_call_id
            .map(str::to_string)
            .or_else(|| hook.as_ref().and_then(|event| event.tool_call_id.clone()));
        let result_timestamp =
            timestamp_ms(record).or_else(|| hook.as_ref().map(|event| event.observed_at_ms));
        self.request_start_ms = latest(&[self.request_start_ms, result_timestamp]);
        let Some(call_id) = call_id.filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        let Some(tool) = self.tools.get(&call_id).cloned() else {
            return Ok(());
        };
        let Some(result_timestamp) = result_timestamp else {
            return Ok(());
        };
        let mut result = base_entry(
            AgentEventName::ToolResult,
            record,
            &self.session_id,
            &tool.step,
            &format!("tool-result:{call_id}"),
            result_timestamp,
        );
        result.tool_name = Some(tool.tool_name.clone());
        result.tool_call_id = Some(call_id.clone());
        let output = parse_json_value(record.get("output"));
        if let Some(output) = output.clone() {
            result.tool_call_result = Some(output);
        }
        if let Some(status) = normalize_tool_status(record.get("status")) {
            result.tool_result_status = Some(status.to_string());
            if status == "failure" {
                result.error_type = Some("tool_execution_failed".to_string());
            }
        }
        let duration = result_timestamp - tool.call_timestamp;
        if duration > 0.0 {
            result.tool_call_duration = Some(duration);
        }
        self.push(result, record).await?;
        self.tools.shift_remove(&call_id);
        let result_part = json!({
            "type": "tool_call_response",
            "id": call_id,
            "response": output.unwrap_or(Value::Null),
        });
        self.pending_delta.push(json!({
            "role": "tool",
            "parts": [result_part],
        }));
        Ok(())
    }

    async fn emit_assistant(&mut self, record: &WorkBuddyRecord) -> Result<(), String> {
        self.step_ordinal += 1;
        let step = step_context(record, &self.session_id, &self.turn_id, self.step_ordinal);
        let message = to_message(record, "assistant");
        let transcript_timestamp = earliest(&[self.reasoning_start_ms, timestamp_ms(record)]);
        let response_timestamp = match transcript_timestamp {
            Some(timestamp) => Some(timestamp),
            None => self
                .hooks
                .take_boundary("Stop")
                .map(|event| event.observed_at_ms),
        };
        let Some(response_timestamp) = response_timestamp else {
            return Ok(());
        };
        let request_timestamp = self.request_start_ms.unwrap_or(response_timestamp);
        let mut request = base_entry(
            AgentEventName::LlmRequest,
            record,
            &self.session_id,
            &step,
            &format!("request:{}", step.step_id),
            request_timestamp,
        );
        request.request_id = Some(step.request_id.clone());
        if let Some(model) = &step.request_model {
            request.request_model = Some(model.clone());
        }
        if self.first_step {
            request.turn_start = Some(true);
        }
        if !self.pending_delta.is_empty() {
            request.input_messages_delta = Some(Value::Array(self.pending_delta.clone()));
        }

        let mut response = base_entry(
            AgentEventName::LlmResponse,
            record,
            &self.session_id,
            &step,
            &format!("response:{}", source_id(record)),
            response_timestamp,
        );
        if let Some(response_id) = provider_string(record, "messageId")
            .map(str::to_string)
            .or_else(|| string_value(record.get("id")).map(str::to_string))
        {
            response.response_id = Some(response_id);
        }
        if let Some(model) = &step.response_model {
            response.response_model = Some(model.clone());
        }
        // A stable Stop hook seals this assistant record. WorkBuddy's assistant
        // `status=completed` is not a model finish signal and is ignored.
        response.finish_reasons = Some(vec!["stop".to_string()]);
        response.turn_end = Some(true);
        let mut parts = self.reasoning_parts.clone();
        parts.extend(message_parts(&message));
        if !parts.is_empty() {
            response.output_messages = Some(json!([{
                "role": "assistant",
                "parts": parts,
                "finish_reason": "stop",
            }]));
        }
        apply_usage(&mut response, record);
        self.push(request, record).await?;
        self.push(response, record).await?;
        self.last_response = None;
        self.tools.clear();
        self.pending_delta.clear();
        self.reasoning_parts.clear();
        self.reasoning_start_ms = None;
        self.request_start_ms = Some(response_timestamp);
        self.first_step = false;
        Ok(())
    }

    async fn push(
        &mut self,
        mut entry: AgentActivityEntry,
        source: &WorkBuddyRecord,
    ) -> Result<(), String> {
        if let Some(cwd) = &self.cwd {
            entry.workspace_path = Some(cwd.clone());
            let mut record = Map::new();
            record.insert(
                "agent.workbuddy.cwd".to_string(),
                Value::String(cwd.clone()),
            );
            enrich_canonical_entry_with_git(&mut entry, &record, "workbuddy").await?;
        }
        if let Some(kind) = string_value(source.get("type")) {
            entry.extra.insert(
                "agent.workbuddy.source_type".to_string(),
                Value::String(kind.to_string()),
            );
        }
        self.built.push(entry);
        Ok(())
    }
}

fn base_entry(
    event_name: AgentEventName,
    source: &WorkBuddyRecord,
    session_id: &str,
    step: &StepContext,
    event_seed: &str,
    timestamp: f64,
) -> AgentActivityEntry {
    let mut extra = Map::new();
    if let Some(id) = provider_string(source, "conversationRequestId") {
        extra.insert(
            "agent.workbuddy.conversation_request.id".to_string(),
            Value::String(id.to_string()),
        );
    }
    if let Some(runtime) = provider_string(source, "agent") {
        extra.insert(
            "agent.workbuddy.runtime".to_string(),
            Value::String(runtime.to_string()),
        );
    }
    AgentActivityEntry {
        time_unix_nano: milliseconds_to_nanoseconds(timestamp),
        observed_time_unix_nano: Some(now_nanoseconds()),
        event_id: stable_id(session_id, event_seed),
        event_name: Some(event_name),
        user_id: String::new(),
        trace_id: Some(step.trace_id.clone()),
        span_id: Some(stable_hex(&format!("{session_id}:{event_seed}:span"), 16)),
        session_id: session_id.to_string(),
        turn_id: Some(step.turn_id.clone()),
        step_id: Some(step.step_id.clone()),
        agent_type: ClientType::WorkBuddy.as_str().to_string(),
        provider_name: step.provider.clone(),
        extra,
        ..AgentActivityEntry::default()
    }
}

fn milliseconds_to_nanoseconds(timestamp: f64) -> String {
    if !timestamp.is_finite() {
        return "0".to_string();
    }
    let whole = timestamp.trunc();
    let fractional = js_round((timestamp - whole) * 1_000_000.0);
    let whole_i = float_to_i128(whole);
    let fractional_i = float_to_i128(fractional);
    (whole_i * 1_000_000 + fractional_i).to_string()
}

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn float_to_i128(value: f64) -> i128 {
    if !value.is_finite() {
        return 0;
    }
    value as i128
}

fn now_nanoseconds() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    (millis * 1_000_000).to_string()
}

fn step_context(
    record: &WorkBuddyRecord,
    session_id: &str,
    turn_id: &str,
    ordinal: u64,
) -> StepContext {
    let conversation_id = provider_string(record, "conversationRequestId");
    let step_id = match conversation_id {
        Some(id) => format!("{id}:s{ordinal}"),
        None => format!("{turn_id}:s{ordinal}"),
    };
    let response_model = provider_string(record, "model").map(str::to_string);
    let request_model = provider_string(record, "requestModelId")
        .or_else(|| provider_string(record, "requestModelName"))
        .map(str::to_string)
        .or_else(|| response_model.clone());
    let raw_trace = provider_string(record, "traceId");
    let trace_id = if raw_trace.is_some_and(is_valid_trace_id) {
        raw_trace.unwrap_or("").to_lowercase()
    } else {
        stable_hex(&format!("{session_id}:{turn_id}"), 32)
    };
    StepContext {
        request_id: step_id.clone(),
        step_id,
        turn_id: turn_id.to_string(),
        trace_id,
        provider: "workbuddy".to_string(),
        request_model,
        response_model,
    }
}

fn to_message(record: &WorkBuddyRecord, role: &str) -> Value {
    let mut parts = Vec::new();
    if let Some(blocks) = record.get("content").and_then(Value::as_array) {
        for block in blocks {
            let Some(block) = block.as_object() else {
                continue;
            };
            let kind = string_value(block.get("type"));
            let text = string_value(block.get("text"));
            if matches!(kind, Some("input_text" | "output_text")) {
                if let Some(text) = text {
                    parts.push(json!({ "type": "text", "content": text }));
                }
            }
        }
    }
    json!({ "role": role, "parts": parts })
}

fn message_parts(message: &Value) -> Vec<Value> {
    message
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn to_reasoning_parts(record: &WorkBuddyRecord) -> Vec<Value> {
    let source = match record.get("rawContent") {
        Some(Value::Null) | None => record.get("content"),
        other => other,
    };
    let Some(blocks) = source.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    for block in blocks {
        let Some(block) = block.as_object() else {
            continue;
        };
        if let Some(text) = string_value(block.get("text")) {
            parts.push(json!({ "type": "reasoning", "content": text }));
        }
    }
    parts
}

fn to_tool_call_part(record: &WorkBuddyRecord, call_id: &str, tool_name: &str) -> Value {
    let mut part = Map::new();
    part.insert("type".into(), Value::String("tool_call".into()));
    part.insert("id".into(), Value::String(call_id.to_string()));
    part.insert("name".into(), Value::String(tool_name.to_string()));
    if let Some(args) = parse_json_value(record.get("arguments")) {
        part.insert("arguments".into(), args);
    }
    Value::Object(part)
}

fn apply_usage(entry: &mut AgentActivityEntry, record: &WorkBuddyRecord) {
    let (usage, raw) = usage_maps(record);
    let input = number_field(&usage, "input_tokens")
        .or_else(|| number_field(&usage, "inputTokens"))
        .or_else(|| number_field(&usage, "prompt_tokens"))
        .or_else(|| number_field(&raw, "prompt_tokens"));
    let output = number_field(&usage, "output_tokens")
        .or_else(|| number_field(&usage, "outputTokens"))
        .or_else(|| number_field(&usage, "completion_tokens"))
        .or_else(|| number_field(&raw, "completion_tokens"));
    let total = number_field(&usage, "total_tokens")
        .or_else(|| number_field(&usage, "totalTokens"))
        .or_else(|| number_field(&raw, "total_tokens"))
        .or(match (input, output) {
            (Some(input), Some(output)) => Some(input + output),
            _ => None,
        });
    let details = raw.get("prompt_tokens_details").and_then(Value::as_object);
    let cache_read = number_field(&usage, "cache_read_input_tokens")
        .or_else(|| number_field(&raw, "cache_read_input_tokens"))
        .or_else(|| number_field(&raw, "prompt_cache_hit_tokens"))
        .or_else(|| details.and_then(|object| number_field(object, "cached_tokens")));
    let cache_creation = number_field(&usage, "cache_creation_input_tokens")
        .or_else(|| number_field(&raw, "cache_creation_input_tokens"))
        .or_else(|| number_field(&raw, "prompt_cache_write_tokens"));
    if let Some(input) = integer_token(input) {
        entry.input_tokens = Some(input);
    }
    if let Some(output) = integer_token(output) {
        entry.output_tokens = Some(output);
    }
    if let Some(total) = integer_token(total) {
        entry.total_tokens = Some(total);
    }
    if let Some(cache_read) = integer_token(cache_read) {
        entry.cache_read_input_tokens = Some(cache_read);
    }
    if let Some(cache_creation) = integer_token(cache_creation) {
        entry.cache_creation_input_tokens = Some(cache_creation);
    }
    if let Some(credit) = number_field(&raw, "credit") {
        entry.workbuddy_usage_credit = Some(credit);
    }
}

fn usage_maps(record: &WorkBuddyRecord) -> (Map<String, Value>, Map<String, Value>) {
    let provider = record.get("providerData").and_then(Value::as_object);
    let raw = provider
        .and_then(|object| object.get("rawUsage"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let message_usage = record
        .get("message")
        .and_then(|message| message.get("usage"));
    let usage = if message_usage.is_some_and(|value| !value.is_null()) {
        message_usage
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    } else if let Some(provider_usage) = provider
        .and_then(|object| object.get("usage"))
        .filter(|value| !value.is_null())
    {
        provider_usage.as_object().cloned().unwrap_or_default()
    } else if provider
        .and_then(|object| object.get("rawUsage"))
        .is_some_and(|value| !value.is_null())
    {
        raw.clone()
    } else {
        Map::new()
    };
    (usage, raw)
}

fn is_internal_record(record: &WorkBuddyRecord) -> bool {
    let Some(provider) = record.get("providerData").and_then(Value::as_object) else {
        return false;
    };
    provider.get("isCompactInternal") == Some(&Value::Bool(true))
        || provider.get("skipRun") == Some(&Value::Bool(true))
        || provider.get("agent").and_then(Value::as_str) == Some("compact")
}

fn normalize_tool_status(status: Option<&Value>) -> Option<&'static str> {
    match status.and_then(Value::as_str) {
        Some("completed" | "success") => Some("success"),
        Some("failed" | "failure" | "error") => Some("failure"),
        Some("cancelled" | "canceled") => Some("cancelled"),
        _ => None,
    }
}

fn timestamp_ms(record: &WorkBuddyRecord) -> Option<f64> {
    finite_f64(record.get("timestamp")).map(|value| value.trunc())
}

fn earliest(values: &[Option<f64>]) -> Option<f64> {
    values.iter().copied().flatten().reduce(f64::min)
}

fn latest(values: &[Option<f64>]) -> Option<f64> {
    values.iter().copied().flatten().reduce(f64::max)
}

fn source_id(record: &WorkBuddyRecord) -> String {
    if let Some(id) = string_value(record.get("id")) {
        return id.to_string();
    }
    if let Some(id) = string_value(record.get("callId")) {
        return id.to_string();
    }
    let kind = string_value(record.get("type")).unwrap_or("record");
    let timestamp = finite_f64(record.get("timestamp")).unwrap_or(0.0);
    format!("{kind}:{}", js_number_string(timestamp))
}

fn response_source_id(record: &WorkBuddyRecord) -> String {
    provider_string(record, "messageId")
        .map(str::to_string)
        .unwrap_or_else(|| source_id(record))
}

fn collect_function_call_wave(
    records: &[WorkBuddyRecord],
    start_index: usize,
    response_source: &WorkBuddyRecord,
) -> (Vec<IndexedRecord>, bool) {
    let mut calls = Vec::new();
    let mut cursor = start_index;
    while cursor < records.len() {
        let candidate = &records[cursor];
        if candidate.get("type").and_then(Value::as_str) != Some("function_call")
            || !is_same_response_wave(response_source, candidate)
        {
            break;
        }
        calls.push(IndexedRecord {
            record: candidate.clone(),
            index: cursor,
        });
        cursor += 1;
    }
    let complete = cursor < records.len();
    (calls, complete)
}

fn is_same_response_wave(left: &WorkBuddyRecord, right: &WorkBuddyRecord) -> bool {
    let left_conversation = provider_string(left, "conversationRequestId");
    let right_conversation = provider_string(right, "conversationRequestId");
    if left_conversation.is_some()
        && right_conversation.is_some()
        && left_conversation != right_conversation
    {
        return false;
    }
    let left_response = response_source_id(left);
    let right_response = response_source_id(right);
    if !left_response.is_empty() && !right_response.is_empty() && left_response != right_response {
        return false;
    }
    (left_conversation.is_some() && left_conversation == right_conversation)
        || (!left_response.is_empty() && left_response == right_response)
}

fn provider_string<'a>(record: &'a WorkBuddyRecord, key: &str) -> Option<&'a str> {
    record
        .get("providerData")
        .and_then(Value::as_object)
        .and_then(|provider| string_value(provider.get(key)))
}

fn string_value(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.as_str()),
        _ => None,
    }
}

fn finite_f64(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn number_field(map: &Map<String, Value>, key: &str) -> Option<f64> {
    finite_f64(map.get(key))
}

fn integer_token(value: Option<f64>) -> Option<i64> {
    let value = value?;
    if value.is_finite()
        && value.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&value)
    {
        Some(value as i64)
    } else {
        None
    }
}

fn parse_json_value(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    match value {
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(parsed) => Some(parsed),
            Err(_) => {
                let trimmed = text.trim_start();
                if trimmed.starts_with('[') || trimmed.starts_with('{') {
                    None
                } else {
                    Some(Value::String(text.clone()))
                }
            }
        },
        other => Some(other.clone()),
    }
}

fn stable_id(namespace: &str, seed: &str) -> String {
    let hex = stable_hex(&format!("{namespace}:{seed}"), 32);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn stable_hex(seed: &str, length: usize) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let encoded = hex::encode(digest);
    encoded[..length.min(encoded.len())].to_string()
}

fn is_valid_trace_id(value: &str) -> bool {
    value.len() == 32
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().any(|byte| byte != b'0')
}

fn js_number_string(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < (2.0f64.powi(53)) {
        format!("{}", value as i64)
    } else if let Some(number) = serde_json::Number::from_f64(value) {
        number.to_string()
    } else if value.is_nan() {
        "NaN".to_string()
    } else if value.is_sign_positive() {
        "Infinity".to_string()
    } else {
        "-Infinity".to_string()
    }
}
