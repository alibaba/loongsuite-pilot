//! Port of `src/flushers/sls-error-classifier.ts`.
//!
//! Classification only describes the failure. Retry decisions stay with the
//! transport that produced the error.

use regex::Regex;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::LazyLock;

const MAX_CAUSE_DEPTH: usize = 5;
const MAX_CODE_LENGTH: usize = 128;
const MAX_STRUCTURED_BODY_LENGTH: usize = 16 * 1024;
const MAX_DETAIL_BYTES: usize = 512;

static SAFE_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$").expect("safe code"));
static CONTROL_CHARS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\u{0000}-\u{001F}\u{007F}]+").expect("control"));
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("whitespace"));

static REDACT_AUTH_SCHEME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\bauthorization\s*["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s,"'}]+"#)
        .expect("auth scheme")
});
static REDACT_AUTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\bauthorization\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+"#).expect("auth")
});
static REDACT_BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+").expect("bearer"));
static REDACT_LTAI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bLTAI[A-Za-z0-9]{12,}\b").expect("ltai"));
static REDACT_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)((?:access[_-]?key(?:[_-]?(?:id|secret))?|api[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+"#,
    )
    .expect("key")
});
static REDACT_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(https?://)[^\s/@:]+:[^\s/@]+@").expect("url userinfo"));

const DNS_CODES: &[&str] = &["ENOTFOUND", "EAI_AGAIN"];
const CONNECTION_RESET_CODES: &[&str] = &["ECONNRESET"];
const CONNECTION_REFUSED_CODES: &[&str] = &["ECONNREFUSED"];
const TIMEOUT_CODES: &[&str] = &[
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "TimeoutError",
    "AbortError",
];
const ROUTE_CODES: &[&str] = &["ENETUNREACH", "EHOSTUNREACH"];
const TLS_CODES: &[&str] = &[
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_TLS_HANDSHAKE_TIMEOUT",
];
const PROXY_CODES: &[&str] = &[
    "UND_ERR_PROXY",
    "ERR_HTTP_PROXY_CONNECT",
    "ERR_PROXY_CONNECTION_FAILED",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlsSendErrorCategory {
    Quota,
    Dns,
    ConnectionReset,
    ConnectionRefused,
    Timeout,
    Route,
    Tls,
    Proxy,
    Http,
    Unknown,
}

impl SlsSendErrorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quota => "quota",
            Self::Dns => "dns",
            Self::ConnectionReset => "connection_reset",
            Self::ConnectionRefused => "connection_refused",
            Self::Timeout => "timeout",
            Self::Route => "route",
            Self::Tls => "tls",
            Self::Proxy => "proxy",
            Self::Http => "http",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlsSendErrorClassification {
    pub category: SlsSendErrorCategory,
    pub code: String,
    pub http_status: i64,
    pub detail: String,
}

/// One link in an error cause chain. `cause` may point at an ancestor; the
/// walker stops when it sees the same allocation twice.
#[derive(Debug)]
pub struct ErrorNode {
    pub name: String,
    pub message: String,
    pub status: Option<i64>,
    pub status_code: Option<i64>,
    pub error_code: Option<String>,
    pub code: Option<String>,
    pub body: Option<String>,
    pub cause: RefCell<Option<Rc<ErrorNode>>>,
}

#[derive(Default)]
pub struct ErrorNodeInit {
    pub name: String,
    pub message: String,
    pub status: Option<i64>,
    pub status_code: Option<i64>,
    pub error_code: Option<String>,
    pub code: Option<String>,
    pub body: Option<String>,
}

impl ErrorNode {
    pub fn create(init: ErrorNodeInit) -> Rc<Self> {
        Rc::new(Self {
            name: init.name,
            message: init.message,
            status: init.status,
            status_code: init.status_code,
            error_code: init.error_code,
            code: init.code,
            body: init.body,
            cause: RefCell::new(None),
        })
    }

    pub fn leaf(name: impl Into<String>, message: impl Into<String>) -> Rc<Self> {
        Self::create(ErrorNodeInit {
            name: name.into(),
            message: message.into(),
            ..ErrorNodeInit::default()
        })
    }

    pub fn with_cause(self: &Rc<Self>, cause: Rc<ErrorNode>) {
        *self.cause.borrow_mut() = Some(cause);
    }
}

pub fn classify_sls_send_error(error: &Rc<ErrorNode>) -> SlsSendErrorClassification {
    let evidence = extract_evidence(error);
    let code = if !evidence.code.is_empty() {
        evidence.code.clone()
    } else if evidence.http_status == 0 {
        let from_message = code_from_legacy_message(&evidence.message);
        if !from_message.is_empty() {
            from_message
        } else {
            code_from_error_name(&evidence.name)
        }
    } else {
        String::new()
    };
    SlsSendErrorClassification {
        category: category_for_code(&code, evidence.http_status, &evidence.name),
        code: if !code.is_empty() {
            code
        } else if evidence.http_status != 0 {
            format!("HTTP_{}", evidence.http_status)
        } else {
            "UNKNOWN".to_string()
        },
        http_status: evidence.http_status,
        detail: evidence.detail,
    }
}

pub fn format_sls_send_failure_message(
    transport: &str,
    classification: &SlsSendErrorClassification,
    attempts: i64,
) -> String {
    let safe_transport = if matches!(transport, "ak" | "apiKey" | "webtracking") {
        transport
    } else {
        "unknown"
    };
    let safe_attempts = if attempts > 0 { attempts } else { 1 };
    let status = if classification.http_status > 0 {
        format!(" status={}", classification.http_status)
    } else {
        String::new()
    };
    let detail = if classification.detail.is_empty() {
        String::new()
    } else {
        format!(
            " error={}",
            serde_json::to_string(&classification.detail).unwrap_or_else(|_| "\"\"".to_string())
        )
    };
    format!(
        "SLS {safe_transport} send failed [category={} code={}{status} attempts={safe_attempts}]{detail}",
        classification.category.as_str(),
        classification.code
    )
}

struct ExtractedEvidence {
    code: String,
    http_status: i64,
    name: String,
    message: String,
    detail: String,
}

fn extract_evidence(error: &Rc<ErrorNode>) -> ExtractedEvidence {
    let mut code = String::new();
    let mut http_status = 0_i64;
    let mut name = String::new();
    let mut message = String::new();
    let mut detail_parts: Vec<String> = Vec::new();
    let mut visited: HashSet<*const ErrorNode> = HashSet::new();
    let mut current = Some(Rc::clone(error));

    for _ in 0..MAX_CAUSE_DEPTH {
        let Some(node) = current.take() else {
            break;
        };
        if !visited.insert(Rc::as_ptr(&node)) {
            break;
        }
        if name.is_empty() && !node.name.is_empty() {
            name.clone_from(&node.name);
        }
        if message.is_empty() && !node.message.is_empty() {
            message.clone_from(&node.message);
        }
        if !node.message.is_empty() {
            let part = if node.name.is_empty() {
                node.message.clone()
            } else {
                format!("{}: {}", node.name, node.message)
            };
            if detail_parts.last() != Some(&part) {
                detail_parts.push(part);
            }
        }
        if http_status == 0 {
            http_status = node
                .status
                .and_then(normalize_http_status)
                .or_else(|| node.status_code.and_then(normalize_http_status))
                .unwrap_or(0);
        }
        if code.is_empty() {
            code = node
                .error_code
                .as_deref()
                .map(normalize_code)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    node.code
                        .as_deref()
                        .map(normalize_code)
                        .filter(|value| !value.is_empty())
                })
                .unwrap_or_default();
        }
        if code.is_empty() {
            if let Some(body) = node.body.as_deref() {
                code = structured_code_from_body(body);
            }
        }
        current = node.cause.borrow().clone();
    }

    let detail = if http_status == 0 {
        normalize_error_detail(&detail_parts.join(" <- "))
    } else {
        String::new()
    };
    ExtractedEvidence {
        code,
        http_status,
        name,
        message,
        detail,
    }
}

fn structured_code_from_body(body: &str) -> String {
    if body.is_empty() || body.len() > MAX_STRUCTURED_BODY_LENGTH {
        return String::new();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    let Value::Object(map) = parsed else {
        return String::new();
    };
    map.get("errorCode")
        .and_then(value_as_code)
        .or_else(|| map.get("code").and_then(value_as_code))
        .unwrap_or_default()
}

fn value_as_code(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let code = normalize_code(text);
    if code.is_empty() {
        None
    } else {
        Some(code)
    }
}

fn normalize_code(value: &str) -> String {
    if value.is_empty() || value.len() > MAX_CODE_LENGTH || !SAFE_CODE.is_match(value) {
        String::new()
    } else {
        value.to_string()
    }
}

fn normalize_http_status(value: i64) -> Option<i64> {
    if (100..=599).contains(&value) {
        Some(value)
    } else {
        None
    }
}

pub fn redact_sensitive_error_text(value: &str) -> String {
    let step = REDACT_AUTH_SCHEME.replace_all(value, "$1[REDACTED]");
    let step = REDACT_AUTH.replace_all(&step, "$1[REDACTED]");
    let step = REDACT_BEARER.replace_all(&step, "Bearer [REDACTED]");
    let step = REDACT_LTAI.replace_all(&step, "[REDACTED_ACCESS_KEY]");
    let step = REDACT_KEY.replace_all(&step, "$1[REDACTED]");
    REDACT_URL.replace_all(&step, "$1[REDACTED]@").into_owned()
}

fn normalize_error_detail(value: &str) -> String {
    let redacted = redact_sensitive_error_text(value);
    let one_line = CONTROL_CHARS.replace_all(&redacted, " ");
    let collapsed = WHITESPACE.replace_all(&one_line, " ");
    truncate_utf8(collapsed.trim(), MAX_DETAIL_BYTES)
}

pub(crate) fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let bytes = value.as_bytes();
    if bytes.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(bytes.len());
    while end > 0 && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
    }
    if end < bytes.len() && end + utf8_char_width(bytes[end]) > max_bytes {
        return String::from_utf8_lossy(&bytes[..end]).into_owned();
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn utf8_char_width(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead < 0xE0 {
        2
    } else if lead < 0xF0 {
        3
    } else {
        4
    }
}

fn category_for_code(code: &str, http_status: i64, name: &str) -> SlsSendErrorCategory {
    if http_status == 429 {
        return SlsSendErrorCategory::Quota;
    }
    if DNS_CODES.contains(&code) {
        return SlsSendErrorCategory::Dns;
    }
    if CONNECTION_RESET_CODES.contains(&code) {
        return SlsSendErrorCategory::ConnectionReset;
    }
    if CONNECTION_REFUSED_CODES.contains(&code) {
        return SlsSendErrorCategory::ConnectionRefused;
    }
    if TIMEOUT_CODES.contains(&code) || name == "TimeoutError" || name == "AbortError" {
        return SlsSendErrorCategory::Timeout;
    }
    if ROUTE_CODES.contains(&code) {
        return SlsSendErrorCategory::Route;
    }
    if TLS_CODES.contains(&code) {
        return SlsSendErrorCategory::Tls;
    }
    if PROXY_CODES.contains(&code) || http_status == 407 {
        return SlsSendErrorCategory::Proxy;
    }
    if http_status > 0 || code == "InternalServerError" || code == "ServerBusy" {
        return SlsSendErrorCategory::Http;
    }
    SlsSendErrorCategory::Unknown
}

fn code_from_legacy_message(message: &str) -> String {
    for candidate in [
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "TimeoutError",
        "InternalServerError",
        "ServerBusy",
    ] {
        if message.contains(candidate) {
            return candidate.to_string();
        }
    }
    if message.contains("socket hang up") {
        return "ECONNRESET".to_string();
    }
    if message.contains("network") {
        return "NETWORK_ERROR".to_string();
    }
    String::new()
}

fn code_from_error_name(name: &str) -> String {
    if name == "TimeoutError" || name == "AbortError" {
        name.to_string()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(
        name: &str,
        message: &str,
        code: Option<&str>,
        status: Option<i64>,
        body: Option<&str>,
    ) -> Rc<ErrorNode> {
        ErrorNode::create(ErrorNodeInit {
            name: name.to_string(),
            message: message.to_string(),
            status,
            code: code.map(str::to_string),
            body: body.map(str::to_string),
            ..ErrorNodeInit::default()
        })
    }

    #[test]
    fn redacts_known_credential_patterns() {
        let cases = [
            (
                "Authorization: Bearer test-token",
                "Authorization: [REDACTED]",
            ),
            ("Authorization=Basic test-token", "Authorization=[REDACTED]"),
            ("Bearer test-token", "Bearer [REDACTED]"),
            ("accessKeyId=test-key", "accessKeyId=[REDACTED]"),
            (
                "access-key-secret=test-secret",
                "access-key-secret=[REDACTED]",
            ),
            ("api_key=test-api-key", "api_key=[REDACTED]"),
            (
                "https://user:password@example.com",
                "https://[REDACTED]@example.com",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(redact_sensitive_error_text(input), expected, "{input}");
        }
        let access_key = format!("LTAI{}", "1".repeat(16));
        assert_eq!(
            redact_sensitive_error_text(&access_key),
            "[REDACTED_ACCESS_KEY]"
        );
    }

    #[test]
    fn reads_nested_codes_into_categories() {
        let cases = [
            ("ENOTFOUND", SlsSendErrorCategory::Dns),
            ("ECONNRESET", SlsSendErrorCategory::ConnectionReset),
            ("ECONNREFUSED", SlsSendErrorCategory::ConnectionRefused),
            ("UND_ERR_CONNECT_TIMEOUT", SlsSendErrorCategory::Timeout),
            ("ENETUNREACH", SlsSendErrorCategory::Route),
            ("CERT_HAS_EXPIRED", SlsSendErrorCategory::Tls),
            ("UND_ERR_PROXY", SlsSendErrorCategory::Proxy),
        ];
        for (code, category) in cases {
            let cause = node("Error", "original cause text", Some(code), None, None);
            let error = node("TypeError", "fetch failed", None, None, None);
            error.with_cause(cause);
            let classification = classify_sls_send_error(&error);
            assert_eq!(classification.code, code);
            assert_eq!(classification.category, category);
        }
    }

    #[test]
    fn extracts_structured_http_code_without_the_response_body() {
        let body = r#"{"errorCode":"Forbidden","message":"original response text"}"#;
        let error = node(
            "HttpError",
            &format!("403 {body}"),
            None,
            Some(403),
            Some(body),
        );
        let classification = classify_sls_send_error(&error);
        assert_eq!(classification.category, SlsSendErrorCategory::Http);
        assert_eq!(classification.code, "Forbidden");
        assert_eq!(classification.http_status, 403);
        assert_eq!(classification.detail, "");
        let message = format_sls_send_failure_message("webtracking", &classification, 1);
        assert!(!message.contains("original response text"));
    }

    #[test]
    fn redacts_credentials_from_network_error_detail() {
        let cause_text = "Authorization: Bearer test-token accessKeySecret=test-secret apiKey=test-api-key https://user:password@example.com";
        let cause = node("Error", cause_text, Some("ECONNRESET"), None, None);
        let error = node("TypeError", "fetch failed", None, None, None);
        error.with_cause(cause);
        let classification = classify_sls_send_error(&error);
        let message = format_sls_send_failure_message("webtracking", &classification, 3);
        assert!(message.contains("category=connection_reset code=ECONNRESET attempts=3"));
        assert!(message.contains("Authorization: [REDACTED]"));
        assert!(message.contains("accessKeySecret=[REDACTED]"));
        assert!(message.contains("apiKey=[REDACTED]"));
        assert!(message.contains("https://[REDACTED]@example.com"));
        assert!(!message.contains("test-token"));
        assert!(!message.contains("test-secret"));
        assert!(!message.contains("test-api-key"));
        assert!(!message.contains("user:password"));
    }

    #[test]
    fn flattens_and_truncates_network_detail_to_512_utf8_bytes() {
        let cause = node(
            "Error",
            &format!("line one\n{}", "测".repeat(400)),
            Some("ECONNRESET"),
            None,
            None,
        );
        let error = node("TypeError", "fetch failed", None, None, None);
        error.with_cause(cause);
        let classification = classify_sls_send_error(&error);
        assert!(classification.detail.len() <= 512);
        assert!(!classification.detail.contains('\n'));
        assert!(!classification.detail.contains('\u{FFFD}'));
    }

    #[test]
    fn bounds_http_response_parsing_and_error_codes() {
        let overlong = format!(
            "{{\"errorCode\":\"Forbidden\",\"padding\":\"{}\"}}",
            "x".repeat(17_000)
        );
        let error = node(
            "HttpError",
            &format!("403 {overlong}"),
            None,
            Some(403),
            Some(&overlong),
        );
        let classification = classify_sls_send_error(&error);
        assert_eq!(classification.category, SlsSendErrorCategory::Http);
        assert_eq!(classification.code, "HTTP_403");
        assert_eq!(classification.http_status, 403);
        assert_eq!(classification.detail, "");

        let long_code = node("", "", Some(&format!("E{}", "X".repeat(128))), None, None);
        assert_eq!(classify_sls_send_error(&long_code).code, "UNKNOWN");
    }

    #[test]
    fn terminates_on_a_cyclic_cause_chain() {
        let error = node("Error", "cyclic", None, None, None);
        error.with_cause(Rc::clone(&error));
        let classification = classify_sls_send_error(&error);
        assert_eq!(classification.category, SlsSendErrorCategory::Unknown);
        assert_eq!(classification.code, "UNKNOWN");
        assert_eq!(classification.http_status, 0);
        assert_eq!(classification.detail, "Error: cyclic");
    }
}
