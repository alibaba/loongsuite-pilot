//! Small JSON helpers shared by the Codex transcript port.
//! Port of `codex-transcript-utils.ts` plus the record readers the extractor uses.

use serde_json::{Map, Number, Value};

use super::types::JsonValue;

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub fn string_value(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

pub fn number_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

pub fn i64_value(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(integer) = value.as_i64() {
        return Some(integer);
    }
    let number = number_value(Some(value))?;
    // The upper integer bound rounds to 2^63 in binary64. Keep legacy
    // integral JSON floats, but reject that exclusive boundary before casting.
    if number.fract() == 0.0 && number >= i64::MIN as f64 && number < i64::MAX as f64 {
        Some(number as i64)
    } else {
        None
    }
}

pub fn u64_value(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(integer) = value.as_u64() {
        return Some(integer);
    }
    let number = number_value(Some(value))?;
    // Native Windows file IDs commonly exceed 2^53. Preserve JSON integers
    // above it exactly; the float fallback must reject the rounded 2^64 bound.
    if number.fract() == 0.0 && number >= 0.0 && number < u64::MAX as f64 {
        Some(number as u64)
    } else {
        None
    }
}

/// `Date.parse` for the ISO timestamps Codex writes. Non-finite results use `fallback`.
pub fn timestamp_ms(record: &Map<String, Value>, fallback: f64) -> f64 {
    let Some(text) = string_value(record.get("timestamp")) else {
        return fallback;
    };
    parse_timestamp_ms(text).unwrap_or(fallback)
}

pub fn parse_timestamp_ms(text: &str) -> Option<f64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    let millis = parsed.timestamp_millis();
    if millis == i64::MIN {
        return None;
    }
    Some(millis as f64)
}

pub fn json_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < (i64::MAX as f64) {
        Value::Number((value as i64).into())
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

pub fn json_bytes(value: &JsonValue) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

pub fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}
