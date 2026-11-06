//! 委派轮次共享有效外部 trace/parent，抑制虚拟 ENTRY 并恢复子 Agent 标记。

use serde_json::{Map, Value};

use super::otlp_json_serializer::{ConvertOptions, ConvertResult, EventLogConverter};
use crate::normalization::{entry_from_map, entry_to_object};
use crate::types::AgentActivityEntry;

pub fn convert_delegated_turn(
    records: &[AgentActivityEntry],
    options: &ConvertOptions,
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    let marker = records.iter().find(|record| {
        entry_str(record, "gen_ai.agent.scope").as_deref() == Some("subagent")
            && entry_str(record, "parent_span_id").is_some()
    });
    let Some(marker) = marker else {
        return converter.convert(records, options);
    };
    let trace_id = entry_str(marker, "trace_id").unwrap_or_default();
    let parent_span_id = entry_str(marker, "parent_span_id").unwrap_or_default();
    let valid = is_hex(&trace_id, 32)
        && is_hex(&parent_span_id, 16)
        && !all_zero(&trace_id)
        && !all_zero(&parent_span_id)
        && records.iter().all(|record| {
            entry_str(record, "trace_id").as_deref() == Some(trace_id.as_str())
                && entry_str(record, "parent_span_id").as_deref() == Some(parent_span_id.as_str())
        });
    if !valid {
        return converter.convert(records, options);
    }
    let local: Vec<AgentActivityEntry> = records.iter().map(strip_scope).collect();
    let mut result = converter.convert(&local, options)?;
    suppress_entry_spans(&mut result, &trace_id, &parent_span_id);
    Ok(result)
}

pub(crate) fn suppress_entry_spans(
    result: &mut ConvertResult,
    trace_id: &str,
    parent_span_id: &str,
) {
    let entries: std::collections::HashSet<_> = result
        .spans
        .iter()
        .filter(|span| {
            span.attributes
                .get("gen_ai.span.kind")
                .and_then(Value::as_str)
                == Some("ENTRY")
        })
        .map(|span| span.span_id.clone())
        .collect();
    result.spans.retain(|span| !entries.contains(&span.span_id));
    result.span_count = result.span_count.saturating_sub(entries.len());
    for span in &mut result.spans {
        span.trace_id = trace_id.into();
        if span
            .parent_span_id
            .as_ref()
            .is_none_or(|id| entries.contains(id))
        {
            span.parent_span_id = Some(parent_span_id.into());
        }
        span.attributes.insert(
            "gen_ai.agent.scope".into(),
            Value::String("subagent".into()),
        );
    }
    result.trace_ids = vec![trace_id.into()];
}

fn strip_scope(record: &AgentActivityEntry) -> AgentActivityEntry {
    let mut map = entry_to_object(record);
    map.remove("gen_ai.agent.scope");
    entry_from_map(map)
}

fn entry_str(record: &AgentActivityEntry, key: &str) -> Option<String> {
    match key {
        "trace_id" => record.trace_id.clone().filter(|value| !value.is_empty()),
        "parent_span_id" => record
            .parent_span_id
            .clone()
            .filter(|value| !value.is_empty()),
        "gen_ai.agent.scope" => record
            .get("gen_ai.agent.scope")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn is_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
}

fn all_zero(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|ch| ch == '0')
}

#[allow(dead_code)]
fn _object_placeholder(map: Map<String, Value>) -> usize {
    map.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::Mutex;

    struct Recording {
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl EventLogConverter for Recording {
        fn convert(
            &self,
            records: &[AgentActivityEntry],
            _options: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            self.calls.lock().unwrap().push(
                records
                    .iter()
                    .map(|record| {
                        record
                            .get("gen_ai.agent.scope")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string()
                    })
                    .collect(),
            );
            Ok(ConvertResult::default())
        }
    }

    fn record(scope: Option<&str>, trace: &str, parent: &str) -> AgentActivityEntry {
        let mut entry = AgentActivityEntry {
            trace_id: Some(trace.to_string()),
            parent_span_id: Some(parent.to_string()),
            ..AgentActivityEntry::default()
        };
        if let Some(scope) = scope {
            entry.extra.insert(
                "gen_ai.agent.scope".to_string(),
                Value::String(scope.to_string()),
            );
        }
        entry
    }

    #[test]
    fn strips_scope_only_when_the_parent_marker_is_uniform() {
        let converter = Recording {
            calls: Mutex::new(Vec::new()),
        };
        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        let parent = "d0d0d0d0d0d0d0d0";
        let records = vec![
            record(Some("subagent"), trace, parent),
            record(Some("subagent"), trace, parent),
        ];
        convert_delegated_turn(&records, &ConvertOptions::default(), &converter).unwrap();
        let calls = converter.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].iter().all(|scope| scope.is_empty()));
    }

    #[test]
    fn leaves_records_alone_when_ids_disagree() {
        let converter = Recording {
            calls: Mutex::new(Vec::new()),
        };
        let records = vec![
            record(
                Some("subagent"),
                "4bf92f3577b34da6a3ce929d0e0e4736",
                "d0d0d0d0d0d0d0d0",
            ),
            record(
                Some("subagent"),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "d0d0d0d0d0d0d0d0",
            ),
        ];
        convert_delegated_turn(&records, &ConvertOptions::default(), &converter).unwrap();
        assert_eq!(converter.calls.lock().unwrap()[0][0], "subagent");
    }
}
