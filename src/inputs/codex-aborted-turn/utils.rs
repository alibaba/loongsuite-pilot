//! Port of `codex-aborted-turn-utils.ts`.

use serde_json::{Map, Value};

pub fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub fn string_value(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

pub fn timestamp_ms(record: &Map<String, Value>) -> Option<f64> {
    let text = string_value(record.get("timestamp"))?;
    let parsed = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    Some(parsed.timestamp_millis() as f64)
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn number_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}
