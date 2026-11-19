use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

use super::records::{non_null, Record};

struct Patterns {
    ansi: Regex,
    authorization: Regex,
    secrets: Regex,
    url: Regex,
    url_auth: Regex,
    assignment: Regex,
    payload: Regex,
    private: Regex,
    content_part: Regex,
    camel_head: Regex,
    camel: Regex,
}

static PATTERNS: LazyLock<Patterns> = LazyLock::new(|| {
    let pattern = |expression| Regex::new(expression).expect("Multica diagnostic pattern");
    Patterns {
        ansi: pattern(r"\x1b\[[0-9;]*m"),
        authorization: pattern(r#"(?i)\b(?:Bearer|Basic)\s+[^\s"',;]+"#),
        secrets: pattern(
            r"\b(?:sk-|mat_|mpt_|ghp_|github_pat_)[A-Za-z0-9_.-]+|\bLTAI[A-Za-z0-9]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        ),
        url: pattern(r#"(?i)https?://[^\s<>"']+"#),
        url_auth: pattern(r"(?i)(https?://)[^/@]+:[^/@]+@"),
        assignment: pattern(
            r#"(?i)(["']?(?:authorization|proxy.authorization|cookie|set.cookie|[\w.-]*(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)|token)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)"#,
        ),
        payload: pattern(
            r#"(?i)(["']?(?:prompt|system_prompt|messages|payload|body|request_body|response_body|custom_env)["']?\s*[=:]\s*)[\s\S]*"#,
        ),
        private: pattern(
            r"(?i)^(?:authorization|proxy.authorization|cookie|set.cookie|.*(?:password|secret|api.?key|access.?token|refresh.?token)|token|credentials?|private_key|custom_env|env|prompt|system_prompt|instructions|messages|payload|body|content|arguments|result|input|output|request|response|request_body|response_body)$",
        ),
        content_part: pattern(
            r"(?:^|[_.-])(?:prompts?|instructions|messages?|payload|body|content|arguments|result|input|output|request|response)(?:$|[_.-])",
        ),
        camel_head: pattern(r"([A-Z]+)([A-Z][a-z])"),
        camel: pattern(r"([a-z0-9])([A-Z])"),
    }
});

pub(crate) fn redact(value: &str) -> String {
    let value: String = PATTERNS
        .ansi
        .replace_all(value, "")
        .chars()
        .filter(|ch| !matches!(*ch, '\0'..='\x08' | '\x0b' | '\x0c' | '\x0e'..='\x1f' | '\x7f'))
        .collect();
    let value = PATTERNS.authorization.replace_all(&value, "[REDACTED]");
    let value = PATTERNS.secrets.replace_all(&value, "[REDACTED]");
    let value = PATTERNS.url.replace_all(&value, |matched: &Captures<'_>| {
        let value = PATTERNS.url_auth.replace(&matched[0], "${1}[REDACTED]@");
        value.find(['?', '#']).map_or_else(
            || value.to_string(),
            |offset| format!("{}?[REDACTED]", &value[..offset]),
        )
    });
    let value = PATTERNS.assignment.replace_all(&value, "${1}[REDACTED]");
    PATTERNS
        .payload
        .replace(&value, "${1}[REDACTED]")
        .into_owned()
}

fn sensitive(key: &str) -> bool {
    if PATTERNS.private.is_match(key) {
        return true;
    }
    let head = PATTERNS.camel_head.replace_all(key, "${1}_${2}");
    let normalized = PATTERNS
        .camel
        .replace_all(&head, "${1}_${2}")
        .to_ascii_lowercase();
    normalized != "message" && PATTERNS.content_part.is_match(&normalized)
}

fn scrub(value: Value, depth: usize) -> Value {
    if depth > 8 {
        return Value::String("[DEPTH LIMIT]".into());
    }
    match value {
        Value::Array(rows) => Value::Array(
            rows.into_iter()
                .take(40)
                .map(|item| scrub(item, depth + 1))
                .collect(),
        ),
        Value::Object(rows) => Value::Object(
            rows.into_iter()
                .take(80)
                .map(|(key, item)| {
                    let item = if sensitive(&key) {
                        Value::String("[REDACTED]".into())
                    } else {
                        scrub(item, depth + 1)
                    };
                    (key, item)
                })
                .collect::<Map<_, _>>(),
        ),
        Value::String(text) => Value::String(redact(&text)),
        value => value,
    }
}

fn bounded(value: &Value, limit: usize) -> Option<String> {
    let text = match value {
        Value::Null => return None,
        Value::String(text) if text.is_empty() => return None,
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(parsed) => scrub(parsed, 0).to_string(),
            Err(_) => redact(text),
        },
        value => scrub(value.clone(), 0).to_string(),
    };
    if text.len() <= limit {
        return Some(text);
    }
    const SUFFIX: &str = "\n[TRUNCATED]";
    let mut end = limit - SUFFIX.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}{SUFFIX}", &text[..end]))
}

pub(crate) fn log(fields: &Value, message: &str) -> Record {
    let error = ["error", "err", "exception"]
        .into_iter()
        .find_map(|key| non_null(&fields[key]))
        .unwrap_or(&Value::Null);
    let raw_message = Value::String(message.to_owned());
    let mut output = Record::new();
    for (key, candidates) in [
        ("log_message", vec![&raw_message]),
        ("error_message", vec![error]),
        (
            "error_code",
            vec![
                &fields["error_code"],
                &error["code"],
                &fields["exception"]["code"],
                &fields["code"],
            ],
        ),
        (
            "error_stack",
            vec![
                &fields["stack"],
                &fields["stacktrace"],
                &fields["stack_trace"],
                &fields["exception.stacktrace"],
                &error["stack"],
                &error["stacktrace"],
            ],
        ),
        ("stderr", vec![&fields["stderr"], &fields["stderr_tail"]]),
        (
            "exit_code",
            vec![
                &fields["exit_code"],
                &error["exit_code"],
                &error["exitCode"],
            ],
        ),
    ] {
        if let Some(value) = candidates
            .into_iter()
            .find(|item| !item.is_null())
            .and_then(|value| bounded(value, if key == "error_stack" { 8192 } else { 4096 }))
        {
            output.insert(key.to_owned(), value);
        }
    }
    if output.values().any(|value| value.ends_with("[TRUNCATED]")) {
        output.insert("log_content_truncated".into(), "true".into());
    }
    output
}
