//! Preflight for the completed-turn stream. Unsupported source order and inline
//! children retain batch conversion before any span is emitted.
use crate::types::{AgentActivityEntry, AgentEventName};
use indexmap::IndexMap;
use serde_json::Value;

pub(super) fn can_stream(records: &[AgentActivityEntry]) -> bool {
    let Some(first) = records.first() else {
        return false;
    };
    let mut groups: IndexMap<&str, Vec<&AgentActivityEntry>> = IndexMap::new();
    for record in records {
        if record.turn_id != first.turn_id
            || record.trace_id != first.trace_id
            || record.agent_type != first.agent_type
            || record.session_id != first.session_id
            || record.agent_id != first.agent_id
            || record.get("gen_ai.agent.scope").and_then(Value::as_str) == Some("subagent")
            || record.time_unix_nano.parse::<u64>().is_err()
        {
            return false;
        }
        match record.event_name {
            Some(AgentEventName::Other) => continue,
            Some(
                AgentEventName::LlmRequest
                | AgentEventName::LlmResponse
                | AgentEventName::ToolCall
                | AgentEventName::ToolResult,
            ) => {}
            _ => return false,
        }
        let Some(step) = record.step_id.as_deref().filter(|step| !step.is_empty()) else {
            return false;
        };
        groups.entry(step).or_default().push(record);
    }
    if groups.is_empty() {
        return false;
    }
    let metadata = |parents: &[&AgentActivityEntry]| {
        let user_inputs = records.iter().filter(|record| {
            record.event_name == Some(AgentEventName::Other)
                && (record.input_messages.is_some() || record.input_messages_delta.is_some())
        });
        let all: Vec<_> = parents.iter().copied().chain(user_inputs).collect();
        let values = (
            all.iter().find_map(|record| {
                record
                    .agent_name
                    .as_deref()
                    .filter(|name| !name.is_empty())
                    .or_else(|| {
                        (!record.agent_type.is_empty()).then_some(record.agent_type.as_str())
                    })
            }),
            all.iter()
                .find_map(|record| (!record.user_id.is_empty()).then_some(record.user_id.as_str())),
            all.iter().find_map(|record| {
                (!record.session_id.is_empty()).then_some(record.session_id.as_str())
            }),
            parents.iter().find_map(|record| {
                record
                    .request_model
                    .as_deref()
                    .filter(|model| !model.is_empty())
            }),
        );
        (
            values.0.map(str::to_owned),
            values.1.map(str::to_owned),
            values.2.map(str::to_owned),
            values.3.map(str::to_owned),
        )
    };
    let parents: Vec<_> = records
        .iter()
        .filter(|record| record.event_name != Some(AgentEventName::Other))
        .collect();
    if metadata(&parents) != metadata(&groups[0]) {
        return false;
    }
    let mut previous = 0;
    for group in groups.values() {
        let requests: Vec<_> = group
            .iter()
            .filter(|record| record.event_name == Some(AgentEventName::LlmRequest))
            .collect();
        if requests.len() != 1
            || !group
                .iter()
                .any(|record| record.event_name == Some(AgentEventName::LlmResponse))
        {
            return false;
        }
        let request_time = requests[0].time_unix_nano.parse::<u64>().unwrap_or(0);
        if request_time < previous {
            return false;
        }
        previous = request_time;
    }
    let mut request_index = 0;
    let mut response_index = 0;
    for record in records {
        let Some(index) = record
            .step_id
            .as_deref()
            .and_then(|step| groups.get_index_of(step))
        else {
            continue;
        };
        if record.event_name == Some(AgentEventName::LlmRequest) {
            if index != request_index {
                return false;
            }
            request_index += 1;
        } else if record.event_name == Some(AgentEventName::LlmResponse) {
            if index < response_index {
                return false;
            }
            response_index = index;
        }
    }
    true
}
