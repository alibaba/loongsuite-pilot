//! Checkpoint-only recovery of JSON numbers outside f64's finite range.
//! Ordinary JSON/config parsing retains its existing strict behavior.
use super::json_file::JVal;
use std::path::Path;

pub(super) async fn read_json(path: &Path) -> Option<JVal> {
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text)
        .ok()
        .or_else(|| recover_overflowing_numbers(text))
}

fn recover_overflowing_numbers(text: &str) -> Option<JVal> {
    // RawValue validates the entire original JSON, including number grammar.
    // Its validation skips numeric conversion, so 1e309 is legal while NaN,
    // leading zeros, comments, malformed exponents, and trailing input fail.
    let _: &serde_json::value::RawValue = serde_json::from_str(text).ok()?;
    let bytes = text.as_bytes();
    let mut at = 0;
    let mut copied = 0;
    let mut normalized: Option<String> = None;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => {
                at += 1;
                while at < bytes.len() {
                    match bytes[at] {
                        b'\\' => at += 2,
                        b'"' => {
                            at += 1;
                            break;
                        }
                        _ => at += 1,
                    }
                }
            }
            b'-' | b'0'..=b'9' => {
                let start = at;
                while at < bytes.len()
                    && matches!(bytes[at], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                {
                    at += 1;
                }
                if text[start..at]
                    .parse::<f64>()
                    .ok()
                    .is_some_and(|number| !number.is_finite())
                {
                    let output = normalized.get_or_insert_with(String::new);
                    output.push_str(&text[copied..start]);
                    // Value cannot represent Infinity. Null remains invalid to
                    // input-owned numeric validators, matching their rejection
                    // of JSON.parse's overflowing numeric value.
                    output.push_str("null");
                    copied = at;
                }
            }
            _ => at += 1,
        }
    }
    let mut normalized = normalized?;
    normalized.push_str(&text[copied..]);
    // Reuse the ordered parser and its existing depth limit. Finite integer
    // identities and every byte inside strings remain unchanged.
    serde_json::from_str(&normalized).ok()
}
