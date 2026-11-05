//! Port of `src/flushers/otlp-json-serializer.ts`.
//!
//! Each span becomes one JSON object. `parentSpanId` and `resource` are omitted
//! when the TypeScript value would have been `undefined`. Times are decimal
//! nanosecond strings, matching `BigInt(seconds) * 1_000_000_000 + BigInt(nanos)`.

use serde_json::{Map, Value};

use crate::types::AgentActivityEntry;

#[derive(Clone, Debug)]
pub struct SpanEvent {
    pub name: String,
    pub time: [i64; 2],
    pub attributes: Map<String, Value>,
    pub dropped_attributes_count: u64,
}

#[derive(Clone, Debug)]
pub struct ReadableSpan {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub kind: i64,
    pub start_time: [i64; 2],
    pub end_time: [i64; 2],
    pub attributes: Map<String, Value>,
    pub status: Map<String, Value>,
    pub resource_attributes: Option<Map<String, Value>>,
    pub events: Vec<SpanEvent>,
    pub links: Vec<Value>,
    pub duration: [i64; 2],
    pub ended: bool,
    pub dropped_attributes_count: u64,
    pub dropped_events_count: u64,
    pub dropped_links_count: u64,
}

impl ReadableSpan {
    pub fn minimal(name: &str, trace_id: &str, span_id: &str) -> Self {
        let mut status = Map::new();
        status.insert("code".to_string(), Value::from(0));
        Self {
            trace_id: trace_id.to_string(),
            span_id: span_id.to_string(),
            parent_span_id: None,
            name: name.to_string(),
            kind: 0,
            start_time: [0, 0],
            end_time: [0, 0],
            attributes: Map::new(),
            status,
            resource_attributes: None,
            events: Vec::new(),
            links: Vec::new(),
            duration: [0, 0],
            ended: true,
            dropped_attributes_count: 0,
            dropped_events_count: 0,
            dropped_links_count: 0,
        }
    }
}

pub fn hr_time_to_nano(hr_time: [i64; 2]) -> String {
    let nanos = (hr_time[0] as i128) * 1_000_000_000 + hr_time[1] as i128;
    nanos.to_string()
}

pub fn nano_to_hr_time(value: i128) -> [i64; 2] {
    let seconds = value.div_euclid(1_000_000_000);
    let nanos = value.rem_euclid(1_000_000_000);
    [seconds as i64, nanos as i64]
}

pub fn create_readable_span_to_otlp_span_json_array(spans: &[ReadableSpan]) -> Vec<String> {
    spans.iter().map(span_to_json).collect()
}

pub fn span_to_json(span: &ReadableSpan) -> String {
    let mut obj = Map::new();
    obj.insert("traceId".to_string(), Value::String(span.trace_id.clone()));
    obj.insert("spanId".to_string(), Value::String(span.span_id.clone()));
    if let Some(parent) = &span.parent_span_id {
        obj.insert("parentSpanId".to_string(), Value::String(parent.clone()));
    }
    obj.insert("name".to_string(), Value::String(span.name.clone()));
    obj.insert("kind".to_string(), Value::from(span.kind));
    obj.insert(
        "startTimeUnixNano".to_string(),
        Value::String(hr_time_to_nano(span.start_time)),
    );
    obj.insert(
        "endTimeUnixNano".to_string(),
        Value::String(hr_time_to_nano(span.end_time)),
    );
    obj.insert(
        "attributes".to_string(),
        Value::Object(span.attributes.clone()),
    );
    obj.insert("status".to_string(), Value::Object(span.status.clone()));
    if !span.events.is_empty() {
        obj.insert("events".into(), Value::Array(span.events.iter().map(|event| serde_json::json!({
            "name": event.name, "timeUnixNano": hr_time_to_nano(event.time),
            "attributes": event.attributes, "droppedAttributesCount": event.dropped_attributes_count,
        })).collect()));
    }
    if !span.links.is_empty() {
        obj.insert(
            "links".into(),
            Value::Array(
                span.links
                    .iter()
                    .map(|link| {
                        let context = link.get("context").unwrap_or(link);
                        let mut value = Map::new();
                        for key in ["traceId", "spanId", "traceState"] {
                            if let Some(v) = context.get(key) {
                                value.insert(key.into(), v.clone());
                            }
                        }
                        for key in ["attributes", "droppedAttributesCount"] {
                            if let Some(v) = link.get(key) {
                                value.insert(key.into(), v.clone());
                            }
                        }
                        Value::Object(value)
                    })
                    .collect(),
            ),
        );
    }
    if let Some(resource) = &span.resource_attributes {
        obj.insert("resource".to_string(), Value::Object(resource.clone()));
    }
    serde_json::to_string(&Value::Object(obj)).unwrap_or_else(|_| "{}".to_string())
}

pub fn estimate_span_size(span: &ReadableSpan) -> usize {
    let mut size = 512_usize;
    for value in span.attributes.values() {
        size += attribute_size(value);
    }
    for event in &span.events {
        size += 64;
        for value in event.attributes.values() {
            size += attribute_size(value);
        }
    }
    size
}

fn attribute_size(value: &Value) -> usize {
    match value {
        Value::String(text) => text.encode_utf16().count(),
        _ => 32,
    }
}

#[derive(Clone, Debug, Default)]
pub struct ConvertOptions {
    pub strict: bool,
    pub passthrough_keys: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ConvertResult {
    pub trace_ids: Vec<String>,
    pub span_count: usize,
    pub warnings: Vec<String>,
    pub spans: Vec<ReadableSpan>,
}

pub trait EventLogConverter: Send + Sync {
    /// Custom converters keep the batch contract unless they explicitly opt in.
    fn supports_streaming(&self) -> bool {
        false
    }

    fn convert(
        &self,
        records: &[AgentActivityEntry],
        options: &ConvertOptions,
    ) -> Result<ConvertResult, String>;

    /// A blocking bounded sink is the native drain barrier. Custom implementations
    /// may opt in while retaining their own conversion/error accounting.
    fn convert_stream(
        &self,
        records: &[AgentActivityEntry],
        options: &ConvertOptions,
        emit: &mut dyn FnMut(Vec<ReadableSpan>, bool) -> Result<(), String>,
    ) -> Result<(), String> {
        let result = self.convert(records, options)?;
        emit(result.spans, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_one_json_object_per_span_with_nanosecond_strings() {
        let mut span = ReadableSpan::minimal(
            "execute_tool",
            "ab".repeat(16).as_str(),
            "cd".repeat(8).as_str(),
        );
        span.parent_span_id = Some("ef".repeat(8));
        span.kind = 1;
        span.start_time = [1, 2];
        span.end_time = [3, 4];
        span.attributes.insert(
            "gen_ai.span.kind".to_string(),
            Value::String("TOOL".to_string()),
        );
        let mut resource = Map::new();
        resource.insert(
            "service.name".to_string(),
            Value::String("pilot".to_string()),
        );
        span.resource_attributes = Some(resource);
        let lines = create_readable_span_to_otlp_span_json_array(&[span]);
        assert_eq!(lines.len(), 1);
        let parsed: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(parsed["traceId"], "ab".repeat(16));
        assert_eq!(parsed["spanId"], "cd".repeat(8));
        assert_eq!(parsed["parentSpanId"], "ef".repeat(8));
        assert_eq!(parsed["name"], "execute_tool");
        assert_eq!(parsed["kind"], 1);
        assert_eq!(parsed["startTimeUnixNano"], "1000000002");
        assert_eq!(parsed["endTimeUnixNano"], "3000000004");
        assert_eq!(parsed["attributes"]["gen_ai.span.kind"], "TOOL");
        assert_eq!(parsed["status"]["code"], 0);
        assert_eq!(parsed["resource"]["service.name"], "pilot");
        assert_eq!(hr_time_to_nano([0, 0]), "0");
        assert_eq!(nano_to_hr_time(1_000_000_002), [1, 2]);
    }

    #[test]
    fn omits_undefined_parent_and_resource() {
        let span = ReadableSpan::minimal("n", "a", "b");
        let parsed: Value = serde_json::from_str(&span_to_json(&span)).unwrap();
        assert!(parsed.get("parentSpanId").is_none());
        assert!(parsed.get("resource").is_none());
        let _ = json!(null);
    }

    #[test]
    fn estimates_string_attributes_by_utf16_length() {
        let mut span = ReadableSpan::minimal("n", "a", "b");
        span.attributes.insert(
            "gen_ai.agent.type".to_string(),
            Value::String("claude-code".to_string()),
        );
        span.attributes.insert(
            "gen_ai.input.messages".to_string(),
            Value::String("x".repeat(4096)),
        );
        assert_eq!(estimate_span_size(&span), 512 + 11 + 4096);
    }
}
