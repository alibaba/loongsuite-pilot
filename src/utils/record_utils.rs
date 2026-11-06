//! Port of `src/utils/record-utils.ts`.

use indexmap::IndexMap;
use serde_json::{Map, Value};

/// Flatten one object's own values into strings.
///
/// `null` is skipped. Objects and arrays are `JSON.stringify`'d. Nested object
/// key order follows `serde_json`'s sorted map; JavaScript preserves insertion
/// order because this crate's `serde_json` has no `preserve_order` feature.
pub fn flatten_to_strings(obj: &Map<String, Value>) -> IndexMap<String, String> {
    let mut result = IndexMap::new();
    for (key, value) in obj {
        if value.is_null() {
            continue;
        }
        let rendered = match value {
            Value::String(text) => text.clone(),
            Value::Bool(flag) => {
                if *flag {
                    "true".to_string()
                } else {
                    "false".to_string()
                }
            }
            Value::Number(number) => js_number(number),
            Value::Array(_) | Value::Object(_) => {
                serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
            }
            Value::Null => continue,
        };
        result.insert(key.clone(), rendered);
    }
    result
}

fn js_number(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    if let Some(value) = number.as_f64() {
        if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
            return format!("{}", value as i64);
        }
        let text = format!("{value}");
        if text.contains('.') || text.contains('e') || text.contains('E') {
            return text;
        }
    }
    number.to_string()
}

#[cfg(test)]
mod tests {
    use super::flatten_to_strings;
    use serde_json::json;

    #[test]
    fn skips_null_and_stringifies_objects() {
        let obj = json!({
            "name": "pilot",
            "n": 1,
            "ok": true,
            "skip": null,
            "nested": {"b": 1, "a": 2},
            "list": [1, 2]
        });
        let flat = flatten_to_strings(obj.as_object().unwrap());
        assert_eq!(flat.get("name").map(String::as_str), Some("pilot"));
        assert_eq!(flat.get("n").map(String::as_str), Some("1"));
        assert_eq!(flat.get("ok").map(String::as_str), Some("true"));
        assert!(!flat.contains_key("skip"));
        assert_eq!(
            flat.get("nested").map(String::as_str),
            Some("{\"b\":1,\"a\":2}")
        );
        assert_eq!(flat.get("list").map(String::as_str), Some("[1,2]"));
    }
}
