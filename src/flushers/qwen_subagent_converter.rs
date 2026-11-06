//! 将 Qwen/Codex 子 Agent 连接到唯一父 TOOL，按层处理嵌套关系。

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::otlp_json_serializer::{ConvertOptions, ConvertResult, EventLogConverter};
use crate::normalization::{entry_from_map, entry_to_object};
use crate::types::AgentActivityEntry;

pub fn convert_qwen_subagents(
    records: &[AgentActivityEntry],
    options: &ConvertOptions,
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    convert_tool_subagents(records, options, converter)
}

pub(crate) fn convert_tool_subagents(
    records: &[AgentActivityEntry],
    options: &ConvertOptions,
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    let mut roots = Vec::new();
    let mut groups: HashMap<String, Vec<AgentActivityEntry>> = HashMap::new();
    let mut order = Vec::new();
    for record in records {
        if entry_str(record, "gen_ai.agent.scope").as_deref() != Some("subagent") {
            roots.push(record.clone());
            continue;
        }
        let id = entry_str(record, "gen_ai.agent.id").unwrap_or_default();
        if !groups.contains_key(&id) {
            order.push(id.clone());
        }
        groups.entry(id).or_default().push(record.clone());
    }
    if groups.is_empty() {
        return converter.convert(records, options);
    }
    let mut used = HashSet::<String>::new();
    let local: Vec<_> = roots.iter().map(strip_scope).collect();
    let mut result = if local.is_empty() {
        ConvertResult::default()
    } else {
        converter.convert(&local, options)?
    };
    for _depth in 0..100 {
        // 每轮只连接上一层已有的 TOOL，深度上限与输入顺序无关。
        let parent_count = result.spans.len();
        let mut progress = false;
        for id in &order {
            if used.contains(id) {
                continue;
            }
            let group = &groups[id];
            let first = &group[0];
            let parent = entry_str(first, "gen_ai.agent.parent.id");
            let tool = entry_str(first, "gen_ai.subagent.parent_tool_call.id");
            if parent.is_none() || tool.is_none() {
                continue;
            }
            if !group.iter().all(|record| {
                entry_str(record, "gen_ai.agent.parent.id") == parent
                    && entry_str(record, "gen_ai.subagent.parent_tool_call.id") == tool
            }) {
                continue;
            }
            let siblings = groups
                .values()
                .filter(|candidate| {
                    entry_str(&candidate[0], "gen_ai.agent.parent.id") == parent
                        && entry_str(&candidate[0], "gen_ai.subagent.parent_tool_call.id") == tool
                })
                .count();
            let parents: Vec<_> = result.spans[..parent_count]
                .iter()
                .filter(|span| {
                    span.attributes
                        .get("gen_ai.span.kind")
                        .and_then(Value::as_str)
                        == Some("TOOL")
                        && span
                            .attributes
                            .get("gen_ai.agent.id")
                            .and_then(Value::as_str)
                            == parent.as_deref()
                        && span
                            .attributes
                            .get("gen_ai.tool.call.id")
                            .and_then(Value::as_str)
                            == tool.as_deref()
                })
                .map(|span| (span.trace_id.clone(), span.span_id.clone()))
                .collect();
            if siblings != 1 || parents.len() != 1 {
                continue;
            }
            let (trace_id, parent_span_id) = &parents[0];
            let local: Vec<_> = group
                .iter()
                .map(|record| {
                    let mut record = strip_scope(record);
                    record.trace_id = Some(trace_id.clone());
                    record.parent_span_id = Some(parent_span_id.clone());
                    record
                })
                .collect();
            let mut child = converter.convert(&local, options)?;
            super::delegated_turn_converter::suppress_entry_spans(
                &mut child,
                trace_id,
                parent_span_id,
            );
            if entry_str(first, "agent.qwen-code-cli.subagent.status").as_deref() == Some("failed")
            {
                for span in &mut child.spans {
                    if span
                        .attributes
                        .get("gen_ai.span.kind")
                        .and_then(Value::as_str)
                        == Some("AGENT")
                    {
                        span.status.insert("code".into(), Value::from(2));
                        span.attributes
                            .insert("error.type".into(), Value::String("SubagentFailed".into()));
                    }
                }
            }
            result.span_count += child.span_count;
            result.warnings.extend(child.warnings);
            result.trace_ids.extend(child.trace_ids);
            result.spans.extend(child.spans);
            used.insert(id.clone());
            progress = true;
        }
        if !progress {
            break;
        }
    }
    if used.len() != groups.len() {
        result.warnings.push("Qwen child records without a matching parent tool were not converted (ambiguous or cyclic relation)".to_string());
    }
    result.trace_ids.sort();
    result.trace_ids.dedup();
    Ok(result)
}

fn strip_scope(record: &AgentActivityEntry) -> AgentActivityEntry {
    let mut map = entry_to_object(record);
    map.remove("gen_ai.agent.scope");
    entry_from_map(map)
}

fn entry_str(record: &AgentActivityEntry, key: &str) -> Option<String> {
    match key {
        "gen_ai.agent.id" => record.agent_id.clone().filter(|value| !value.is_empty()),
        _ => record
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

#[allow(dead_code)]
fn _keep_value(value: &Value) -> bool {
    !value.is_null()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Recording {
        calls: Mutex<usize>,
    }

    impl EventLogConverter for Recording {
        fn convert(
            &self,
            records: &[AgentActivityEntry],
            _options: &ConvertOptions,
        ) -> Result<ConvertResult, String> {
            *self.calls.lock().unwrap() += 1;
            Ok(ConvertResult {
                span_count: records.len(),
                ..ConvertResult::default()
            })
        }
    }

    #[test]
    fn converts_roots_and_warns_about_unparented_children() {
        let root = AgentActivityEntry {
            agent_id: Some("root".to_string()),
            event_name: Some(crate::types::AgentEventName::Other),
            ..AgentActivityEntry::default()
        };
        let mut child = AgentActivityEntry {
            agent_id: Some("child".to_string()),
            ..AgentActivityEntry::default()
        };
        child.extra.insert(
            "gen_ai.agent.scope".to_string(),
            serde_json::Value::String("subagent".to_string()),
        );
        let converter = Recording {
            calls: Mutex::new(0),
        };
        let result =
            convert_qwen_subagents(&[root, child], &ConvertOptions::default(), &converter).unwrap();
        assert_eq!(*converter.calls.lock().unwrap(), 1);
        assert_eq!(result.span_count, 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("matching parent tool")));
    }

    #[test]
    fn without_children_delegates_the_original_records() {
        let converter = Recording {
            calls: Mutex::new(0),
        };
        let record = AgentActivityEntry::default();
        convert_qwen_subagents(
            std::slice::from_ref(&record),
            &ConvertOptions::default(),
            &converter,
        )
        .unwrap();
        assert_eq!(*converter.calls.lock().unwrap(), 1);
    }
}
