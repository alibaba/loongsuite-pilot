use regex::Regex;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
pub type RawEvent = Map<String, Value>;
pub const MIN_MS: i64 = 1_577_836_800_000;
pub const MAX_MS: i64 = 4_102_444_800_000;
pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub fn encode<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("serializable Doubao metadata")
}
pub fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}
pub fn safe_i64(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}
pub fn epoch(value: &Value) -> Option<i64> {
    safe_i64(value).filter(|n| *n >= MIN_MS && *n < MAX_MS)
}
pub fn nanos(value: &str) -> Option<i128> {
    value.parse().ok()
}
pub fn ms_nanos(value: i64) -> String {
    (i128::from(value) * 1_000_000).to_string()
}
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}
pub fn identifier(value: Option<&Value>) -> Option<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_.:-]{1,256}$").unwrap());
    let s = text(value)?;
    RE.is_match(s).then(|| s.to_owned())
}
pub fn native_id(value: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_-]{1,128}$").unwrap());
    RE.is_match(value)
}
pub fn numeric_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 30 && value.bytes().all(|b| b.is_ascii_digit())
}
pub fn uuid(value: &str) -> bool {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$").unwrap());
    RE.is_match(value)
}
pub fn object(value: Value) -> RawEvent {
    value.as_object().expect("Doubao event object").clone()
}
pub fn set(event: &mut RawEvent, key: &str, value: impl Into<Value>) {
    event.insert(key.into(), value.into());
}
pub fn remove(event: &mut RawEvent, keys: &[&str]) {
    for key in keys {
        event.shift_remove(*key);
    }
}
pub fn normalize_json(value: Value) -> Value {
    match value {
        Value::Number(n) => number(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(values) => Value::Array(values.into_iter().map(normalize_json).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(k, v)| (k, normalize_json(v)))
                .collect(),
        ),
        other => other,
    }
}
/// Decode visible JSON text only. Source bytes and witness hashes are never
/// passed through this adapter. Rust's UTF-8 boundary uses U+FFFD for isolated
/// UTF-16 escape code units; valid pairs and escaped backslashes remain intact.
pub fn parse_json(value: &str) -> serde_json::Result<Value> {
    match serde_json::from_str(value) {
        Ok(value) => Ok(normalize_json(value)),
        Err(original) => {
            let (repaired, changed) = repair_surrogate_escapes(value);
            if changed {
                serde_json::from_str(&repaired).map(normalize_json)
            } else {
                Err(original)
            }
        }
    }
}
fn repair_surrogate_escapes(value: &str) -> (String, bool) {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut quoted = false;
    let mut changed = false;
    let unit = |offset: usize| -> Option<u16> {
        if offset + 6 > bytes.len() || bytes[offset] != b'\\' || bytes[offset + 1] != b'u' {
            return None;
        }
        std::str::from_utf8(&bytes[offset + 2..offset + 6])
            .ok()
            .and_then(|hex| u16::from_str_radix(hex, 16).ok())
    };
    while index < bytes.len() {
        let byte = bytes[index];
        if !quoted {
            quoted = byte == b'"';
            out.push(byte);
            index += 1;
            continue;
        }
        if byte == b'"' {
            quoted = false;
            out.push(byte);
            index += 1;
            continue;
        }
        if byte != b'\\' {
            out.push(byte);
            index += 1;
            continue;
        }
        if index + 1 >= bytes.len() {
            out.push(byte);
            index += 1;
            continue;
        }
        if let Some(code) = unit(index) {
            if (0xd800..=0xdbff).contains(&code) {
                if unit(index + 6).is_some_and(|next| (0xdc00..=0xdfff).contains(&next)) {
                    out.extend_from_slice(&bytes[index..index + 12]);
                    index += 12;
                    continue;
                }
                out.extend_from_slice(br"\ufffd");
                changed = true;
                index += 6;
                continue;
            }
            if (0xdc00..=0xdfff).contains(&code) {
                out.extend_from_slice(br"\ufffd");
                changed = true;
                index += 6;
                continue;
            }
            out.extend_from_slice(&bytes[index..index + 6]);
            index += 6;
            continue;
        }
        // Preserve invalid/truncated escapes for serde_json to reject. Consume
        // escaped backslashes/quotes together, so literal "\\ud800" is untouched.
        out.extend_from_slice(&bytes[index..index + 2]);
        index += 2;
    }
    (
        String::from_utf8(out).expect("UTF-8 plus ASCII escapes"),
        changed,
    )
}

pub fn json_number_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let text = format!("{value:e}");
    let (mut mantissa, exponent) = text.split_once(['e', 'E']).unwrap();
    let exponent: i32 = exponent.parse().unwrap();
    let negative = mantissa.starts_with('-');
    if negative {
        mantissa = &mantissa[1..];
    }
    let dot = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let digits = mantissa.replace('.', "");
    let point = dot + exponent;
    if value.abs() >= 1e-6 && value.abs() < 1e21 {
        let out = if point <= 0 {
            format!("0.{}{}", "0".repeat((-point) as usize), digits)
        } else if point >= digits.len() as i32 {
            format!(
                "{}{}",
                digits,
                "0".repeat((point - digits.len() as i32) as usize)
            )
        } else {
            format!(
                "{}.{}",
                &digits[..point as usize],
                &digits[point as usize..]
            )
        };
        return if negative { format!("-{out}") } else { out };
    }
    format!(
        "{}{}e{}{}",
        if negative { "-" } else { "" },
        mantissa,
        if exponent >= 0 { "+" } else { "" },
        exponent
    )
}
pub fn js_encode(value: &Value) -> String {
    match value {
        Value::Number(n) => json_number_string(n.as_f64().unwrap()),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(js_encode).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut numeric: Vec<_> = values
                .iter()
                .filter_map(|(k, v)| {
                    k.parse::<u32>()
                        .ok()
                        .filter(|n| *n < u32::MAX && n.to_string() == *k)
                        .map(|n| (n, k, v))
                })
                .collect();
            numeric.sort_by_key(|(n, _, _)| *n);
            let mut parts: Vec<String> = numeric
                .iter()
                .map(|(_, k, v)| format!("{}:{}", encode(k), js_encode(v)))
                .collect();
            parts.extend(
                values
                    .iter()
                    .filter(|(k, _)| !numeric.iter().any(|(_, n, _)| *n == *k))
                    .map(|(k, v)| format!("{}:{}", encode(k), js_encode(v))),
            );
            format!("{{{}}}", parts.join(","))
        }
        other => encode(other),
    }
}
pub fn parse_time_ms(value: &str) -> Option<i64> {
    use chrono::TimeZone;
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis());
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc2822(value) {
        return Some(date.timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(date) = chrono::NaiveDateTime::parse_from_str(value, format) {
            return chrono::Local
                .from_local_datetime(&date)
                .earliest()
                .map(|date| date.timestamp_millis());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_surrogates_repair_only_visible_json_strings_without_changing_source_bytes() {
        let raw =
            r#"{"text":"visible result\ud800中文","pair":"\ud83d\ude80","literal":"\\ud800"}"#;
        let before = raw.as_bytes().to_vec();
        let hash = digest(&hex::encode(&before));
        let value = parse_json(raw).unwrap();
        assert_eq!(value["text"], "visible result\u{fffd}中文");
        assert_eq!(value["pair"], "🚀");
        assert_eq!(value["literal"], r"\ud800");
        assert_eq!(raw.as_bytes(), before);
        assert_eq!(digest(&hex::encode(raw.as_bytes())), hash);
        assert_eq!(parse_json(r#""\udc00""#).unwrap(), "\u{fffd}");
        for invalid in [
            r"\ud800",
            r#""\ud800"#,
            r#"{"x":"\ud800",}"#,
            r#""\u12X4""#,
            r#"{"x":"\ud800"} garbage"#,
        ] {
            assert!(
                parse_json(invalid).is_err(),
                "invalid JSON was broadened: {invalid}"
            );
        }
    }
    #[test]
    fn json_identity_encoding_matches_ecmascript_number_ranges_and_integer_key_order() {
        assert_eq!(
            js_encode(&serde_json::json!({"2":1.0,"1":-0.0,"text":"中文"})),
            r#"{"1":0,"2":1,"text":"中文"}"#
        );
        for (n, expected) in [
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
        ] {
            assert_eq!(json_number_string(n), expected);
        }
    }
}
