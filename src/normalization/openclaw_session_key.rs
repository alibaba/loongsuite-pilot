use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// Native routing identity, distinct from the conversation UUID. Never truncate
/// an identity: invalid or oversized values are omitted rather than made ambiguous.
pub const OPENCLAW_SESSION_KEY: &str = "agent.openclaw.session_key";
pub const OPENCLAW_SESSION_KEY_AMBIGUOUS: &str = "agent.openclaw.session_key.ambiguous";

static CONTROL_CHARS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\u{0000}-\u{001F}\u{007F}]").expect("openclaw session key control regex")
});

pub fn is_openclaw_session_key(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let len = text.encode_utf16().count();
    len > 0 && len <= 1024 && !text.trim().is_empty() && !CONTROL_CHARS.is_match(text)
}
