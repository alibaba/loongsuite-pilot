//! Parse Cursor Hook stdin, retaining recovery for legacy Windows transport.
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

static WINDOWS_JSON_COMMA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""?\?,"#).expect("windows comma"));
static WINDOWS_JSON_OBJECT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""?\?}"#).expect("windows object"));
static WINDOWS_JSON_ARRAY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""?\?]"#).expect("windows array"));

pub(super) fn parse(
    raw: &str,
    windows: impl FnOnce() -> bool,
) -> serde_json::Result<Map<String, Value>> {
    serde_json::from_str(raw.trim()).or_else(|error| {
        if !windows() {
            return Err(error);
        }
        let repaired = repair_windows_json(raw);
        if repaired == raw {
            return Err(error);
        }
        serde_json::from_str(repaired.trim())
    })
}

fn repair_windows_json(raw: &str) -> String {
    let step = WINDOWS_JSON_COMMA_RE.replace_all(raw, "\",");
    let step = WINDOWS_JSON_OBJECT_RE.replace_all(&step, "\"}");
    WINDOWS_JSON_ARRAY_RE.replace_all(&step, "\"]").into_owned()
}
