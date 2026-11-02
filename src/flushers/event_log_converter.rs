//! 将归一化事件转换为保留外部时间与标识的 GenAI Span。

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::otlp_json_serializer::{
    nano_to_hr_time, ConvertOptions, ConvertResult, EventLogConverter, ReadableSpan,
};
use super::span_id_reservation::SpanIdReservations;
use crate::normalization::entry_to_object;
use crate::types::{AgentActivityEntry, AgentEventName};

#[derive(Default)]
pub struct GenAiEventLogConverter;

struct Pair<'a> {
    start: Option<&'a AgentActivityEntry>,
    end: Option<&'a AgentActivityEntry>,
    updates: Vec<&'a AgentActivityEntry>,
    kind: &'static str,
    key: String,
    step: String,
}

pub(crate) fn valid_id(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
        && value.bytes().any(|ch| ch != b'0')
}

fn stable_id(parts: &[&str], length: usize) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    hex::encode(hash.finalize())[..length].to_owned()
}

fn timestamp(record: &AgentActivityEntry) -> Result<i128, String> {
    record
        .time_unix_nano
        .parse::<u64>()
        .map(i128::from)
        .map_err(|_| format!("事件 {} 的 time_unix_nano 无效", record.event_id))
}

fn step_id(record: &AgentActivityEntry) -> String {
    record
        .step_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "step:1".into())
}

fn correlation(record: &AgentActivityEntry, tool: bool) -> Option<&str> {
    if tool {
        record
            .tool_call_exec_id
            .as_deref()
            .or(record.tool_call_id.as_deref())
    } else {
        record
            .response_id
            .as_deref()
            .or(record.request_id.as_deref())
    }
    .filter(|id| !id.is_empty())
}

impl EventLogConverter for GenAiEventLogConverter {
    fn convert(
        &self,
        records: &[AgentActivityEntry],
        options: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        if records.iter().any(|record| {
            matches!(record.agent_type.as_str(), "codex" | "claude-code")
                && record.get("gen_ai.agent.scope").and_then(Value::as_str) == Some("subagent")
        }) {
            return super::qwen_subagent_converter::convert_tool_subagents(records, options, self);
        }
        let mut result = ConvertResult::default();
        let mut groups: BTreeMap<String, Vec<&AgentActivityEntry>> = BTreeMap::new();
        let mut seen = HashSet::new();
        for record in records {
            if record.event_name == Some(AgentEventName::AgentInput) {
                continue;
            }
            if let Err(error) = timestamp(record) {
                if options.strict {
                    return Err(error);
                }
                result.warnings.push(error);
                continue;
            }
            let encoded = serde_json::to_string(record).map_err(|error| error.to_string())?;
            if !seen.insert(encoded) {
                continue;
            }
            let trace = record
                .trace_id
                .as_deref()
                .filter(|id| valid_id(id, 32))
                .unwrap_or("");
            let key = serde_json::to_string(&(
                &record.agent_type,
                &record.session_id,
                &record.turn_id,
                &record.agent_id,
                trace,
            ))
            .map_err(|error| error.to_string())?;
            groups.entry(key).or_default().push(record);
        }
        for (key, mut group) in groups {
            group.sort_by_key(|record| timestamp(record).unwrap_or(0));
            convert_group(&key, &group, options, &mut result)?;
        }
        let mut ids = HashSet::new();
        for span in &result.spans {
            if !ids.insert((&span.trace_id, &span.span_id)) {
                return Err(format!("同一批次存在重复 span_id：{}", span.span_id));
            }
        }
        result.trace_ids.sort();
        result.trace_ids.dedup();
        result.span_count = result.spans.len();
        Ok(result)
    }
}

fn convert_group(
    key: &str,
    records: &[&AgentActivityEntry],
    options: &ConvertOptions,
    result: &mut ConvertResult,
) -> Result<(), String> {
    let first = records[0];
    let is_dsh = first.agent_type == "dsh";
    let pairs = pair_events(records, &mut result.warnings);
    if pairs.is_empty()
        && !records
            .iter()
            .any(|record| record.input_messages.is_some() || record.input_messages_delta.is_some())
    {
        return Ok(());
    }
    let trace = first
        .trace_id
        .as_deref()
        .filter(|id| valid_id(id, 32))
        .map(str::to_owned)
        .unwrap_or_else(|| stable_id(&["trace", key], 32));
    let entry_id = stable_id(&[&trace, key, "ENTRY"], 16);
    let agent_id = stable_id(&[&trace, key, "AGENT"], 16);
    let begin = timestamp(first)?;
    let end = timestamp(records[records.len() - 1])?;
    let name = first.agent_name.as_deref().unwrap_or(&first.agent_type);
    let mut root = make_span(
        &trace,
        &entry_id,
        "ENTRY",
        "enter_ai_application_system",
        begin,
        end,
    );
    root.parent_span_id =
        if super::qoder_turn_converter::is_qoder_transcript_agent(&first.agent_type) {
            super::qoder_turn_converter::entry_upstream_parent(records)
        } else {
            first.parent_span_id.clone().filter(|id| valid_id(id, 16))
        };
    root.attributes.extend(context_attributes(records, options));
    root.attributes.insert(
        "gen_ai.operation.name".into(),
        Value::String("enter".into()),
    );
    let first_request = records
        .iter()
        .position(|record| record.event_name == Some(AgentEventName::LlmRequest))
        .map(|index| index + 1)
        .unwrap_or(records.len());
    // DSH keeps injected plugin context on LLM requests. Its explicit
    // top-level user events alone define the ENTRY/AGENT human input.
    let pi_turn_input: Vec<_> = if first.agent_type == "pi-coding-agent"
        || first.get("gen_ai.framework").and_then(Value::as_str) == Some("pi-coding-agent")
    {
        records
            .iter()
            .copied()
            .filter(|record| {
                record.event_name == Some(AgentEventName::Other)
                    && record.step_id.is_none()
                    && (record.input_messages.is_some() || record.input_messages_delta.is_some())
            })
            .collect()
    } else {
        Vec::new()
    };
    let top_input = if !pi_turn_input.is_empty() {
        // Pi emits one explicit turn-level user input independently of the
        // rolling full LLM context. Registered PI SDK identities use the same
        // protocol. Only this declaration defines ENTRY/AGENT input; LLM leaves
        // below still materialize their complete original context.
        materialize_input(&pi_turn_input)
    } else if is_dsh {
        let human_records: Vec<_> = records
            .iter()
            .copied()
            .filter(|record| record.event_name == Some(AgentEventName::Other))
            .collect();
        materialize_input(&human_records)
    } else {
        materialize_input(&records[..first_request])
    };
    if let Some(input) = top_input {
        root.attributes.insert(
            "gen_ai.input.messages".into(),
            Value::String(input.to_string()),
        );
    }
    if let Some(output) = records
        .iter()
        .rev()
        .find_map(|record| record.output_messages.as_ref())
    {
        root.attributes
            .insert("gen_ai.output.messages".into(), attribute(output.clone()));
    }
    let mut agent = make_span(
        &trace,
        &agent_id,
        "AGENT",
        &format!("invoke_agent {name}"),
        begin,
        end,
    );
    agent.parent_span_id = Some(entry_id.clone());
    agent.attributes.extend(root.attributes.clone());
    agent.attributes.insert(
        "gen_ai.operation.name".into(),
        Value::String("invoke_agent".into()),
    );
    agent
        .attributes
        .insert("gen_ai.span.kind".into(), Value::String("AGENT".into()));
    let copied: Vec<_> = records.iter().map(|record| (*record).clone()).collect();
    let mut tool_ids = SpanIdReservations::tool();
    let mut llm_ids = SpanIdReservations::llm();
    tool_ids.prepare(&copied);
    llm_ids.prepare(&copied);
    let mut steps: BTreeMap<String, ReadableSpan> = BTreeMap::new();
    let mut leaves = Vec::new();
    for (index, pair) in pairs.iter().enumerate() {
        let start = pair.start.or(pair.end).ok_or("事件对为空")?;
        let finish = pair.end.or(pair.start).ok_or("事件对为空")?;
        let start_time = timestamp(start)?;
        let end_time = timestamp(finish)?.max(start_time);
        let step_span_id = stable_id(&[&trace, key, "STEP", &pair.step], 16);
        let reserved = if pair.kind == "TOOL" {
            tool_ids.take(
                finish
                    .tool_call_id
                    .as_deref()
                    .or(start.tool_call_id.as_deref()),
            )
        } else {
            llm_ids.take(
                finish
                    .response_id
                    .as_deref()
                    .or(start.response_id.as_deref()),
            )
        };
        let id = reserved.unwrap_or_else(|| {
            stable_id(&[&trace, key, pair.kind, &pair.key, &index.to_string()], 16)
        });
        let leaf_name = if pair.kind == "TOOL" {
            format!(
                "execute_tool {}",
                finish
                    .tool_name
                    .as_deref()
                    .or(start.tool_name.as_deref())
                    .unwrap_or("unknown")
            )
        } else {
            format!(
                "chat {}",
                finish
                    .response_model
                    .as_deref()
                    .or(start.request_model.as_deref())
                    .unwrap_or("unknown")
            )
        };
        let mut leaf = make_span(&trace, &id, pair.kind, &leaf_name, start_time, end_time);
        leaf.kind = if pair.kind == "LLM" { 2 } else { 0 };
        leaf.parent_span_id = Some(step_span_id.clone());
        merge_attributes(&mut leaf.attributes, start, options);
        merge_attributes(&mut leaf.attributes, finish, options);
        for update in &pair.updates {
            let mut attributes = Map::new();
            merge_attributes(&mut attributes, update, options);
            for (key, value) in attributes {
                // OpenClaw 最终 llm_output 包含整轮用量，不能覆盖最后一次调用的用量。
                if key.starts_with("gen_ai.usage.")
                    && update.agent_type == "openclaw"
                    && update.get("agent.openclaw.hook").and_then(Value::as_str)
                        == Some("llm_output")
                {
                    continue;
                }
                leaf.attributes.insert(key, value);
            }
        }
        // The DSH adapter reports disjoint usage already folded into input
        // and output. Derive only the missing total from those evidenced
        // counts; cache and reasoning must not be added again.
        if is_dsh
            && pair.kind == "LLM"
            && !leaf.attributes.contains_key("gen_ai.usage.total_tokens")
        {
            let total = leaf
                .attributes
                .get("gen_ai.usage.input_tokens")
                .and_then(Value::as_i64)
                .zip(
                    leaf.attributes
                        .get("gen_ai.usage.output_tokens")
                        .and_then(Value::as_i64),
                )
                .and_then(|(input, output)| input.checked_add(output));
            if let Some(total) = total {
                leaf.attributes
                    .insert("gen_ai.usage.total_tokens".into(), Value::from(total));
            }
        }
        leaf.attributes
            .insert("gen_ai.span.kind".into(), Value::String(pair.kind.into()));
        leaf.attributes.insert(
            "gen_ai.operation.name".into(),
            Value::String(
                if pair.kind == "LLM" {
                    "chat"
                } else {
                    "execute_tool"
                }
                .into(),
            ),
        );
        if pair.start.is_none() || pair.end.is_none() {
            leaf.attributes.insert(
                "agent.pilot.collection.incomplete".into(),
                Value::Bool(true),
            );
        }
        if finish.error_type.is_some()
            || finish.error_message.is_some()
            || finish.tool_result_status.as_deref() == Some("failure")
            || finish
                .finish_reasons
                .as_ref()
                .is_some_and(|reasons| reasons.iter().any(|reason| reason == "error"))
        {
            leaf.status.insert("code".into(), Value::from(2));
            if let Some(message) = &finish.error_message {
                leaf.status
                    .insert("message".into(), Value::String(message.clone()));
            }
        }
        let round = steps.len() + 1;
        let step = steps.entry(pair.step.clone()).or_insert_with(|| {
            let mut span = make_span(
                &trace,
                &step_span_id,
                "STEP",
                &format!("react step {round}"),
                start_time,
                end_time,
            );
            span.parent_span_id = Some(agent_id.clone());
            span.attributes
                .extend(context_attributes(&[start], options));
            span.attributes.insert(
                "gen_ai.operation.name".into(),
                Value::String("react".into()),
            );
            span.attributes
                .insert("gen_ai.step.id".into(), Value::String(pair.step.clone()));
            span.attributes
                .insert("gen_ai.react.round".into(), Value::from(round));
            span
        });
        extend_time(step, start_time, end_time);
        if pair.kind == "LLM" {
            if let Some(reason) = finish
                .finish_reasons
                .as_ref()
                .and_then(|reasons| reasons.first())
            {
                step.attributes.insert(
                    "gen_ai.react.finish_reason".into(),
                    Value::String(reason.clone()),
                );
            }
            let input_records: Vec<_> = records
                .iter()
                .copied()
                .take_while(|record| timestamp(record).unwrap_or(0) <= start_time)
                .collect();
            if let Some(input) = materialize_input(&input_records) {
                leaf.attributes.insert(
                    "gen_ai.input.messages".into(),
                    Value::String(input.to_string()),
                );
            }
        }
        leaves.push(leaf);
    }
    aggregate_usage(&mut agent, &leaves);
    aggregate_usage(&mut root, &leaves);
    result.trace_ids.push(trace);
    result.spans.extend([root, agent]);
    result.spans.extend(steps.into_values());
    result.spans.extend(leaves);
    Ok(())
}

fn pair_events<'a>(
    records: &[&'a AgentActivityEntry],
    warnings: &mut Vec<String>,
) -> Vec<Pair<'a>> {
    let mut pairs: Vec<Pair<'a>> = Vec::new();
    for record in records {
        let (kind, ending) = match record.event_name {
            Some(AgentEventName::LlmRequest) => ("LLM", false),
            Some(AgentEventName::LlmResponse) => ("LLM", true),
            Some(AgentEventName::ToolCall) => ("TOOL", false),
            Some(AgentEventName::ToolResult) => ("TOOL", true),
            _ => continue,
        };
        let tool = kind == "TOOL";
        let step = step_id(record);
        let correlation = correlation(record, tool);
        let matched = if ending {
            pairs
                .iter()
                .rposition(|pair| {
                    pair.kind == kind
                        && pair.end.is_none()
                        && pair.step == step
                        && (correlation.is_none()
                            || pair.key.is_empty()
                            || correlation == Some(pair.key.as_str()))
                })
                .or_else(|| {
                    if tool || correlation.is_none() {
                        return None;
                    }
                    // request 与 response 可能分别只有 request.id 和 response.id；仅在同 STEP 唯一候选时配对。
                    let candidates: Vec<_> = pairs
                        .iter()
                        .enumerate()
                        .filter(|(_, pair)| {
                            pair.kind == kind && pair.end.is_none() && pair.step == step
                        })
                        .collect();
                    (candidates.len() == 1).then(|| candidates[0].0)
                })
        } else {
            None
        };
        if let Some(index) = matched {
            pairs[index].end = Some(record);
        } else if let Some(pair) = pairs.iter_mut().rev().find(|pair| {
            ending
                && correlation.is_some()
                && pair.kind == kind
                && pair.step == step
                && pair
                    .end
                    .is_some_and(|end| self::correlation(end, tool) == correlation)
        }) {
            pair.updates.push(record);
        } else {
            pairs.push(Pair {
                start: if ending { None } else { Some(record) },
                end: if ending { Some(record) } else { None },
                updates: Vec::new(),
                kind,
                step,
                key: correlation.unwrap_or("").to_owned(),
            });
        }
    }
    for pair in &pairs {
        if pair.start.is_none() || pair.end.is_none() {
            warnings.push(format!("{} 事件对不完整：{}", pair.kind, pair.key));
        }
    }
    // 结束事件仍保留观测结果；无响应的开始事件不能伪造零时长叶 Span。
    pairs.retain(|pair| pair.end.is_some());
    pairs
}

fn make_span(
    trace: &str,
    id: &str,
    kind: &str,
    name: &str,
    start: i128,
    end: i128,
) -> ReadableSpan {
    let mut span = ReadableSpan::minimal(name, trace, id);
    span.start_time = nano_to_hr_time(start);
    span.end_time = nano_to_hr_time(end);
    span.duration = nano_to_hr_time(end - start);
    span.attributes
        .insert("gen_ai.span.kind".into(), Value::String(kind.into()));
    span
}

fn extend_time(span: &mut ReadableSpan, start: i128, end: i128) {
    let previous_start = span.start_time[0] as i128 * 1_000_000_000 + span.start_time[1] as i128;
    let previous_end = span.end_time[0] as i128 * 1_000_000_000 + span.end_time[1] as i128;
    span.start_time = nano_to_hr_time(previous_start.min(start));
    span.end_time = nano_to_hr_time(previous_end.max(end));
    span.duration = nano_to_hr_time(previous_end.max(end) - previous_start.min(start));
}

fn attribute(value: Value) -> Value {
    match &value {
        Value::Object(_) | Value::Null => Value::String(value.to_string()),
        Value::Array(items) if items.iter().any(|item| !item.is_string()) => {
            Value::String(value.to_string())
        }
        _ => value,
    }
}

fn merge_attributes(
    attributes: &mut Map<String, Value>,
    record: &AgentActivityEntry,
    options: &ConvertOptions,
) {
    for (key, value) in entry_to_object(record) {
        if key.starts_with("gen_ai.")
            || key.starts_with("error.")
            || key == "tool.result.status"
            || options.passthrough_keys.contains(&key)
        {
            attributes.insert(key, attribute(value));
        }
    }
}

fn context_attributes(
    records: &[&AgentActivityEntry],
    options: &ConvertOptions,
) -> Map<String, Value> {
    let mut result = Map::new();
    for record in records {
        for (key, value) in entry_to_object(record) {
            if key.starts_with("gen_ai.agent.")
                || key.starts_with("gen_ai.subagent.")
                || key == "gen_ai.session.id"
                || key == "gen_ai.turn.id"
                || key == "gen_ai.provider.name"
                || options.passthrough_keys.contains(&key)
            {
                result.insert(key, attribute(value));
            }
        }
    }
    result
}

fn materialize_input(records: &[&AgentActivityEntry]) -> Option<Value> {
    let mut messages = Vec::new();
    let mut present = false;
    let mut last_hash = None;
    for record in records {
        if let Some(full) = record.input_messages.as_ref().and_then(message_array) {
            messages = full;
            present = true;
            last_hash = record.input_messages_hash.as_deref();
        } else if let Some(delta) = record.input_messages_delta.as_ref().and_then(message_array) {
            present = true;
            if record.input_messages_hash.is_some()
                && record.input_messages_hash.as_deref() == last_hash
            {
                continue;
            }
            // 相邻 Hook 可能重复同一段上下文，只去掉已在末尾出现的前缀。
            let overlap = (0..=messages.len().min(delta.len()))
                .rev()
                .find(|&length| messages[messages.len() - length..] == delta[..length])
                .unwrap_or(0);
            messages.extend_from_slice(&delta[overlap..]);
            last_hash = record.input_messages_hash.as_deref();
        }
    }
    present.then_some(Value::Array(messages))
}

fn message_array(value: &Value) -> Option<Vec<Value>> {
    match value {
        Value::Array(items) => Some(items.clone()),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()?
            .as_array()
            .cloned(),
        _ => None,
    }
}

fn aggregate_usage(container: &mut ReadableSpan, leaves: &[ReadableSpan]) {
    for leaf in leaves.iter().filter(|span| {
        span.attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            == Some("LLM")
    }) {
        for (key, value) in &leaf.attributes {
            if key.starts_with("gen_ai.usage.") {
                if let Some(number) = value.as_i64() {
                    let previous = container
                        .attributes
                        .get(key)
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    container
                        .attributes
                        .insert(key.clone(), Value::from(previous.saturating_add(number)));
                } else if let Some(number) = value.as_f64() {
                    let previous = container
                        .attributes
                        .get(key)
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    container
                        .attributes
                        .insert(key.clone(), Value::from(previous + number));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(name: &str, time: &str) -> AgentActivityEntry {
        serde_json::from_value(json!({"event.name": name, "time_unix_nano": time,
            "gen_ai.session.id": "s", "gen_ai.turn.id": "t", "gen_ai.step.id": "s1",
            "gen_ai.agent.type": "codex", "trace_id": "0123456789abcdef0123456789abcdef",
            "gen_ai.response.id": "response", "span_id": "1234567890abcdef"}))
        .unwrap()
    }

    #[test]
    fn preserves_nanos_reserved_ids_and_hierarchy() {
        let start = event("llm.request", "1700000000000000001");
        let mut end = event("llm.response", "1700000000000000023");
        end.output_tokens = Some(42);
        let result = GenAiEventLogConverter
            .convert(&[start, end], &ConvertOptions::default())
            .unwrap();
        assert_eq!(result.spans.len(), 4);
        let llm = result.spans.last().unwrap();
        assert_eq!(llm.span_id, "1234567890abcdef");
        assert_eq!(llm.duration, [0, 22]);
        assert_eq!(llm.attributes["gen_ai.usage.output_tokens"], 42);
        let parents: HashSet<_> = result
            .spans
            .iter()
            .map(|span| span.span_id.clone())
            .collect();
        assert!(result
            .spans
            .iter()
            .skip(1)
            .all(|span| parents.contains(span.parent_span_id.as_ref().unwrap())));
        assert_eq!(result.spans[1].attributes["gen_ai.usage.output_tokens"], 42);
    }

    #[test]
    fn canonical_container_operations_and_names_cannot_inherit_leaf_operation() {
        let mut start = event("llm.request", "100");
        start
            .extra
            .insert("gen_ai.operation.name".into(), json!("chat"));
        let result = GenAiEventLogConverter
            .convert(
                &[start, event("llm.response", "200")],
                &ConvertOptions {
                    passthrough_keys: vec!["gen_ai.operation.name".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        for (kind, operation, name) in [
            ("ENTRY", "enter", "enter_ai_application_system"),
            ("AGENT", "invoke_agent", "invoke_agent codex"),
            ("STEP", "react", "react step 1"),
            ("LLM", "chat", "chat unknown"),
        ] {
            let span = result
                .spans
                .iter()
                .find(|s| s.attributes["gen_ai.span.kind"] == kind)
                .unwrap();
            assert_eq!(span.attributes["gen_ai.operation.name"], operation);
            assert_eq!(span.name, name);
        }
    }

    #[test]
    fn parallel_tool_calls_keep_distinct_execution_ids() {
        let mut records = Vec::new();
        for (index, name) in ["tool.call", "tool.call", "tool.result", "tool.result"]
            .iter()
            .enumerate()
        {
            let mut record = event(name, &(100 + index).to_string());
            record.span_id = None;
            record.tool_call_id = Some(format!("tool-{}", index % 2));
            records.push(record);
        }
        let result = GenAiEventLogConverter
            .convert(&records, &ConvertOptions::default())
            .unwrap();
        let tools: Vec<_> = result
            .spans
            .iter()
            .filter(|span| span.attributes["gen_ai.span.kind"] == "TOOL")
            .collect();
        assert_eq!(tools.len(), 2);
        assert_ne!(tools[0].span_id, tools[1].span_id);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn rejects_invalid_timestamps_in_strict_mode() {
        let record = event("llm.response", "not-a-timestamp");
        assert!(GenAiEventLogConverter
            .convert(
                &[record],
                &ConvertOptions {
                    strict: true,
                    ..Default::default()
                }
            )
            .is_err());
    }

    #[test]
    fn orphan_requests_do_not_fabricate_leaf_spans_but_keep_input() {
        let mut input = event("other", "99");
        input.input_messages_delta = Some(json!([{"role":"user", "content":"保留输入"}]));
        let result = GenAiEventLogConverter
            .convert(
                &[
                    input,
                    event("llm.request", "100"),
                    event("tool.call", "101"),
                ],
                &ConvertOptions::default(),
            )
            .unwrap();
        assert_eq!(result.spans.len(), 2);
        assert_eq!(result.spans[0].attributes["gen_ai.span.kind"], "ENTRY");
        assert_eq!(result.spans[1].attributes["gen_ai.span.kind"], "AGENT");
        assert!(result.spans[1].attributes["gen_ai.input.messages"]
            .as_str()
            .unwrap()
            .contains("保留输入"));
        assert_eq!(result.warnings.len(), 2);
    }

    #[test]
    fn cancelled_response_preserves_step_finish_reason() {
        let start = event("llm.request", "100");
        let mut end = event("llm.response", "200");
        end.finish_reasons = Some(vec!["cancelled".into()]);
        let result = GenAiEventLogConverter
            .convert(&[start, end], &ConvertOptions::default())
            .unwrap();
        assert!(result.warnings.is_empty());
        let step = result
            .spans
            .iter()
            .find(|span| span.attributes["gen_ai.span.kind"] == "STEP")
            .unwrap();
        assert_eq!(step.attributes["gen_ai.react.finish_reason"], "cancelled");
        assert_eq!(
            result.spans.last().unwrap().attributes["gen_ai.response.finish_reasons"],
            json!(["cancelled"])
        );
    }
}
