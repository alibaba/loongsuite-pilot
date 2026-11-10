//! Public main #568: attach multimodal summaries to the owning converted spans.

use super::ReadableSpan;
use crate::multimodal::rewrite::multimodal_metadata_items_from_messages;
use crate::types::AgentActivityEntry;
use serde_json::{Map, Value};
use std::collections::HashMap;

fn event_time_ms(value: &str) -> Option<i128> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u128>().ok().map(|n| (n / 1_000_000) as i128)
}

fn turn_start_key(turn: Option<&str>, start_ms: Option<i128>) -> Option<(String, i128)> {
    Some((turn.filter(|v| !v.is_empty())?.to_string(), start_ms?))
}

fn message_metadata(value: &Value) -> Option<Value> {
    match value {
        Value::Array(messages) => Some(multimodal_metadata_items_from_messages(messages)),
        Value::String(encoded) => {
            let value: Value = serde_json::from_str(encoded).ok()?;
            Some(multimodal_metadata_items_from_messages(value.as_array()?))
        }
        _ => None,
    }
}

pub(super) fn enrich(records: &[AgentActivityEntry], spans: &mut [ReadableSpan]) {
    let mut response_by_step: HashMap<&str, Option<&str>> = HashMap::new();
    for record in records {
        if record.event_name.map(|v| v.as_str()) != Some("llm.response") {
            continue;
        }
        let Some(step) = record.step_id.as_deref().filter(|v| !v.is_empty()) else {
            continue;
        };
        let Some(response) = record.response_id.as_deref().filter(|v| !v.is_empty()) else {
            continue;
        };
        response_by_step
            .entry(step)
            .and_modify(|prior| {
                if *prior != Some(response) {
                    *prior = None;
                }
            })
            .or_insert(Some(response));
    }

    let mut by_call: HashMap<&str, Map<String, Value>> = HashMap::new();
    let mut by_response: HashMap<&str, Map<String, Value>> = HashMap::new();
    let mut delta_by_turn_start = HashMap::new();
    for record in records {
        let name = record.event_name.map(|v| v.as_str());
        let (target, id) = match name {
            Some("tool.call" | "tool.result") => (&mut by_call, record.tool_call_id.as_deref()),
            Some("llm.request" | "llm.response") => {
                let response = record
                    .response_id
                    .as_deref()
                    .filter(|v| !v.is_empty())
                    .or_else(|| {
                        if name == Some("llm.request") {
                            record
                                .step_id
                                .as_deref()
                                .and_then(|step| response_by_step.get(step).copied().flatten())
                        } else {
                            None
                        }
                    });
                if response.is_none() && name == Some("llm.request") {
                    if let (Some(key), Some(delta)) = (
                        turn_start_key(
                            record.turn_id.as_deref(),
                            event_time_ms(&record.time_unix_nano),
                        ),
                        record
                            .input_multimodal_metadata_delta
                            .as_ref()
                            .filter(|v| v.is_array() || v.is_object()),
                    ) {
                        delta_by_turn_start.insert(key, Value::String(delta.to_string()));
                    }
                }
                (&mut by_response, response)
            }
            _ => continue,
        };
        let Some(id) = id.filter(|v| !v.is_empty()) else {
            continue;
        };
        for (key, value) in [
            (
                "gen_ai.input.multimodal_metadata",
                record.input_multimodal_metadata.as_ref(),
            ),
            (
                "gen_ai.input.multimodal_metadata_delta",
                record.input_multimodal_metadata_delta.as_ref(),
            ),
            (
                "gen_ai.output.multimodal_metadata",
                record.output_multimodal_metadata.as_ref(),
            ),
        ] {
            if let Some(value) = value.filter(|v| v.is_array() || v.is_object()) {
                target
                    .entry(id)
                    .or_default()
                    .insert(key.to_string(), Value::String(value.to_string()));
            }
        }
    }

    for span in spans {
        let is_tool = span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            == Some("TOOL");
        let is_llm = span
            .attributes
            .get("gen_ai.span.kind")
            .and_then(Value::as_str)
            == Some("LLM");
        let id = if is_tool {
            span.attributes.get("gen_ai.tool.call.id")
        } else if is_llm {
            span.attributes.get("gen_ai.response.id")
        } else {
            None
        }
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
        if let Some(id) = id {
            if let Some(attributes) = (if is_tool { &by_call } else { &by_response }).get(id) {
                for (key, value) in attributes {
                    span.attributes.insert(key.clone(), value.clone());
                }
            }
        } else if is_llm {
            let start_ms = i128::from(span.start_time[0]) * 1000
                + i128::from(span.start_time[1]).div_euclid(1_000_000);
            if let Some(delta) = turn_start_key(
                span.attributes
                    .get("gen_ai.turn.id")
                    .and_then(Value::as_str),
                Some(start_ms),
            )
            .and_then(|key| delta_by_turn_start.get(&key))
            {
                span.attributes.insert(
                    "gen_ai.input.multimodal_metadata_delta".to_string(),
                    delta.clone(),
                );
            }
        }
        if !is_llm {
            continue;
        }
        // Converted input messages describe the accumulated turn or an explicit
        // full snapshot; entry metadata alone cannot reconstruct this summary.
        for (messages, metadata) in [
            ("gen_ai.input.messages", "gen_ai.input.multimodal_metadata"),
            (
                "gen_ai.output.messages",
                "gen_ai.output.multimodal_metadata",
            ),
        ] {
            if let Some(items) = span.attributes.get(messages).and_then(message_metadata) {
                if items.as_array().is_some_and(Vec::is_empty) {
                    span.attributes.remove(metadata);
                } else {
                    span.attributes
                        .insert(metadata.to_string(), Value::String(items.to_string()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalization::entry_from_map;
    use serde_json::json;

    fn entry(value: Value) -> AgentActivityEntry {
        entry_from_map(value.as_object().unwrap().clone())
    }
    fn uri(name: &str) -> Value {
        json!({"uri":format!("oss://bucket/{name}.png"),"mime_type":"image/png","modality":"image"})
    }
    fn messages(item: Value) -> Value {
        let mut part = item.as_object().unwrap().clone();
        part.insert("type".into(), json!("uri"));
        json!([{"role":"user","parts":[part]}])
    }
    fn span(kind: &str, key: Option<(&str, &str)>) -> ReadableSpan {
        let mut span = ReadableSpan::minimal("test", &"a".repeat(32), &"b".repeat(16));
        span.attributes
            .insert("gen_ai.span.kind".into(), json!(kind));
        if let Some((key, value)) = key {
            span.attributes.insert(key.into(), json!(value));
        }
        span
    }
    fn metadata(span: &ReadableSpan, key: &str) -> Option<Value> {
        span.attributes
            .get(key)
            .and_then(Value::as_str)
            .map(|s| serde_json::from_str(s).unwrap())
    }

    #[test]
    fn exact_tool_and_response_ids_do_not_cross_span_kinds() {
        let image = json!([uri("a")]);
        let records = vec![
            entry(
                json!({"event.name":"tool.call","gen_ai.tool.call.id":"c1","gen_ai.output.multimodal_metadata":image}),
            ),
            entry(
                json!({"event.name":"tool.result","gen_ai.tool.call.id":"c1","gen_ai.input.multimodal_metadata":image,"gen_ai.input.multimodal_metadata_delta":image}),
            ),
            entry(
                json!({"event.name":"llm.response","gen_ai.response.id":"r1","gen_ai.output.multimodal_metadata":image}),
            ),
        ];
        let mut spans = vec![
            span("TOOL", Some(("gen_ai.tool.call.id", "c1"))),
            span("TOOL", Some(("gen_ai.tool.call.id", "c2"))),
            span("LLM", Some(("gen_ai.response.id", "r1"))),
            span("AGENT", Some(("gen_ai.response.id", "r1"))),
        ];
        spans[2]
            .attributes
            .insert("gen_ai.tool.call.id".into(), json!("c1"));
        enrich(&records, &mut spans);
        assert_eq!(
            metadata(&spans[0], "gen_ai.input.multimodal_metadata"),
            Some(image.clone())
        );
        assert_eq!(
            metadata(&spans[0], "gen_ai.input.multimodal_metadata_delta"),
            Some(image.clone())
        );
        assert_eq!(
            metadata(&spans[0], "gen_ai.output.multimodal_metadata"),
            Some(image.clone())
        );
        assert_eq!(
            metadata(&spans[2], "gen_ai.output.multimodal_metadata"),
            Some(image)
        );
        assert!(metadata(&spans[1], "gen_ai.output.multimodal_metadata").is_none());
        assert!(metadata(&spans[2], "gen_ai.input.multimodal_metadata").is_none());
        assert!(metadata(&spans[3], "gen_ai.output.multimodal_metadata").is_none());
    }

    #[test]
    fn request_step_join_rejects_ambiguous_responses_and_accepts_repeated_same_id() {
        let image = json!([uri("a")]);
        let mut records = vec![
            entry(
                json!({"event.name":"llm.request","gen_ai.step.id":"s1","gen_ai.input.multimodal_metadata":image}),
            ),
            entry(
                json!({"event.name":"llm.request","gen_ai.step.id":"s2","gen_ai.input.multimodal_metadata":image}),
            ),
        ];
        for (step, id) in [
            ("s1", "r1"),
            ("s1", "r1"),
            ("s2", "r2"),
            ("s2", "r3"),
            ("s2", "r2"),
        ] {
            records.push(entry(
                json!({"event.name":"llm.response","gen_ai.step.id":step,"gen_ai.response.id":id}),
            ));
        }
        let mut spans = vec![
            span("LLM", Some(("gen_ai.response.id", "r1"))),
            span("LLM", Some(("gen_ai.response.id", "r2"))),
            span("LLM", Some(("gen_ai.response.id", "other"))),
        ];
        enrich(&records, &mut spans);
        assert_eq!(
            metadata(&spans[0], "gen_ai.input.multimodal_metadata"),
            Some(image)
        );
        assert!(metadata(&spans[1], "gen_ai.input.multimodal_metadata").is_none());
        assert!(metadata(&spans[2], "gen_ai.input.multimodal_metadata").is_none());
    }

    #[test]
    fn missing_response_ids_match_both_turn_and_millisecond_start_without_crossing_adjacent_spans()
    {
        let records = vec![
            entry(
                json!({"event.name":"llm.request","gen_ai.turn.id":"t1","time_unix_nano":"1700000000010123456","gen_ai.input.multimodal_metadata_delta":[uri("a")]}),
            ),
            entry(
                json!({"event.name":"llm.request","gen_ai.turn.id":"t2","time_unix_nano":"1700000000010123456","gen_ai.input.multimodal_metadata_delta":[uri("b")]}),
            ),
        ];
        let mut spans = vec![
            span("LLM", Some(("gen_ai.turn.id", "t1"))),
            span("LLM", Some(("gen_ai.turn.id", "t2"))),
            span("LLM", Some(("gen_ai.turn.id", "t1"))),
            span("LLM", None),
        ];
        for s in &mut spans {
            s.start_time = [1_700_000_000, 10_999_999];
        }
        spans[2].start_time[1] = 11_000_000;
        enrich(&records, &mut spans);
        assert_eq!(
            metadata(&spans[0], "gen_ai.input.multimodal_metadata_delta"),
            Some(json!([uri("a")]))
        );
        assert_eq!(
            metadata(&spans[1], "gen_ai.input.multimodal_metadata_delta"),
            Some(json!([uri("b")]))
        );
        assert!(metadata(&spans[2], "gen_ai.input.multimodal_metadata_delta").is_none());
        assert!(metadata(&spans[3], "gen_ai.input.multimodal_metadata_delta").is_none());
        for bad in ["-1", "1.5", " 1000000", "NaN", ""] {
            assert_eq!(event_time_ms(bad), None);
        }
    }

    #[test]
    fn span_messages_rebuild_cumulative_or_full_snapshot_summaries_and_preserve_delta() {
        let prior = uri("a");
        let current = uri("b");
        let records = vec![
            entry(
                json!({"event.name":"llm.request","gen_ai.response.id":"r1","gen_ai.input.multimodal_metadata":[prior,current],"gen_ai.input.multimodal_metadata_delta":[current]}),
            ),
            entry(
                json!({"event.name":"llm.request","gen_ai.response.id":"r2","gen_ai.input.multimodal_metadata":[prior,current],"gen_ai.input.multimodal_metadata_delta":[current]}),
            ),
        ];
        let mut spans = vec![
            span("LLM", Some(("gen_ai.response.id", "r1"))),
            span("LLM", Some(("gen_ai.response.id", "r2"))),
        ];
        let cumulative = json!([
            messages(prior.clone())[0].clone(),
            messages(current.clone())[0].clone()
        ]);
        spans[0].attributes.insert(
            "gen_ai.input.messages".into(),
            json!(cumulative.to_string()),
        );
        spans[1]
            .attributes
            .insert("gen_ai.input.messages".into(), messages(current.clone()));
        spans[1].attributes.insert(
            "gen_ai.output.messages".into(),
            json!([{ "role":"assistant","parts":[{"type":"uri","uri":"oss://bucket/output.png"}]}]),
        );
        enrich(&records, &mut spans);
        assert_eq!(
            metadata(&spans[0], "gen_ai.input.multimodal_metadata"),
            Some(json!([prior, current]))
        );
        assert_eq!(
            metadata(&spans[1], "gen_ai.input.multimodal_metadata"),
            Some(json!([current]))
        );
        for span in &spans {
            assert_eq!(
                metadata(span, "gen_ai.input.multimodal_metadata_delta"),
                Some(json!([current]))
            );
        }
        assert_eq!(
            metadata(&spans[1], "gen_ai.output.multimodal_metadata"),
            Some(json!([{"uri":"oss://bucket/output.png","mime_type":"application/octet-stream"}]))
        );
    }

    #[test]
    fn malformed_messages_do_not_erase_copied_metadata_but_valid_empty_lists_do() {
        let image = json!([uri("a")]);
        let records = vec![
            entry(
                json!({"event.name":"llm.response","gen_ai.response.id":"r1","gen_ai.output.multimodal_metadata":image}),
            ),
            entry(
                json!({"event.name":"llm.response","gen_ai.response.id":"r2","gen_ai.output.multimodal_metadata":image}),
            ),
            entry(
                json!({"event.name":"llm.response","gen_ai.response.id":"r3","gen_ai.output.multimodal_metadata":null}),
            ),
        ];
        let mut spans = vec![
            span("LLM", Some(("gen_ai.response.id", "r1"))),
            span("LLM", Some(("gen_ai.response.id", "r2"))),
            span("LLM", Some(("gen_ai.response.id", "r3"))),
        ];
        spans[0]
            .attributes
            .insert("gen_ai.output.messages".into(), json!("{"));
        spans[1]
            .attributes
            .insert("gen_ai.output.messages".into(), json!([]));
        enrich(&records, &mut spans);
        assert_eq!(
            metadata(&spans[0], "gen_ai.output.multimodal_metadata"),
            Some(image)
        );
        assert!(metadata(&spans[1], "gen_ai.output.multimodal_metadata").is_none());
        assert!(metadata(&spans[2], "gen_ai.output.multimodal_metadata").is_none());
    }
}
