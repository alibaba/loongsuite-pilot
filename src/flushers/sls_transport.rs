//! Port of `src/flushers/sls-transport.ts`.
//!
//! WebTracking posts JSON. API-key PutLogs posts the protobuf log group with a
//! bearer token. Both retry the same status codes. MD5 and SHA-1 live here
//! because `Cargo.toml` does not depend on those crates directly; API-key
//! requests need MD5 and the AK signer needs HMAC-SHA1.

use std::time::Duration;

use super::sls_loggroup_codec::{encode_sls_log_group, SlsLogGroupPayload};
use crate::utils::create_logger;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

pub const WEBTRACKING_TIMEOUT_MS: u64 = 10_000;
pub const WEBTRACKING_MAX_BODY_BYTES: usize = 2_800_000;
pub const WEBTRACKING_MAX_LOGS: usize = 4096;
pub const RETRY_MAX_ATTEMPTS: u32 = 3;
pub const RETRY_BASE_DELAY_MS: u64 = 1000;

pub const RETRYABLE_STATUS_CODES: &[u16] = &[408, 429, 500, 502, 503, 504];

#[derive(Clone, Debug)]
pub struct HttpError {
    pub status: u16,
    pub body: String,
}

impl HttpError {
    pub fn new(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} {}", self.status, self.body)
    }
}

impl std::error::Error for HttpError {}

#[derive(Clone, Debug)]
pub struct SlsTransportConfig {
    pub endpoint: String,
    pub project: String,
    pub logstore: String,
    pub timeout_ms: Option<u64>,
    pub max_retries: Option<u32>,
    pub retry_base_delay_ms: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct PostWebtrackingOptions {
    pub topic: Option<String>,
    pub source: Option<String>,
    pub tags: Option<Map<String, Value>>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct PostApiKeyOptions {
    pub topic: Option<String>,
    pub source: Option<String>,
    pub tags: Option<Vec<IndexMap<String, String>>>,
    pub user_agent: Option<String>,
}

/// Sendable cause chain. Cycles are not representable; the classifier covers
/// those with [`ErrorNode`] directly.
#[derive(Clone, Debug)]
pub struct OwnedError {
    pub name: String,
    pub message: String,
    pub status: Option<i64>,
    pub status_code: Option<i64>,
    pub error_code: Option<String>,
    pub code: Option<String>,
    pub body: Option<String>,
    pub cause: Option<Box<OwnedError>>,
}

impl OwnedError {
    pub fn leaf(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
            status: None,
            status_code: None,
            error_code: None,
            code: None,
            body: None,
            cause: None,
        }
    }
}

#[derive(Clone, Debug)]
pub enum SendError {
    Http(HttpError),
    Chain(Box<OwnedError>),
    Message(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(error) => write!(formatter, "{error}"),
            Self::Chain(node) => {
                if node.name.is_empty() {
                    write!(formatter, "{}", node.message)
                } else {
                    write!(formatter, "{}: {}", node.name, node.message)
                }
            }
            Self::Message(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for SendError {}

pub fn is_retryable(error: &SendError) -> bool {
    match error {
        SendError::Http(http) => RETRYABLE_STATUS_CODES.contains(&http.status),
        other => {
            let message = other.to_string();
            message.contains("ECONNRESET")
                || message.contains("ETIMEDOUT")
                || message.contains("ECONNREFUSED")
                || message.contains("socket hang up")
                || message.contains("network")
                || message.contains("TimeoutError")
                || message.contains("InternalServerError")
                || message.contains("ServerBusy")
        }
    }
}

pub fn split_for_webtracking(
    logs: &[IndexMap<String, String>],
    max_logs: usize,
    max_bytes: usize,
) -> Vec<Vec<IndexMap<String, String>>> {
    let mut chunks: Vec<Vec<IndexMap<String, String>>> = Vec::new();
    let mut current: Vec<IndexMap<String, String>> = Vec::new();
    let mut current_size = 0_usize;
    for log in logs {
        let log_size = json_utf8_len(log);
        if !current.is_empty() && (current.len() >= max_logs || current_size + log_size > max_bytes)
        {
            chunks.push(std::mem::take(&mut current));
            current_size = 0;
        }
        current_size += log_size;
        current.push(log.clone());
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn json_utf8_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_string(value)
        .map(|text| text.len())
        .unwrap_or(0)
}

pub async fn post_webtracking(
    config: &SlsTransportConfig,
    logs: &[IndexMap<String, String>],
    opts: &PostWebtrackingOptions,
    http: &dyn SlsHttp,
) -> Result<(), SendError> {
    let chunks = split_for_webtracking(logs, WEBTRACKING_MAX_LOGS, WEBTRACKING_MAX_BODY_BYTES);
    for chunk in chunks {
        post_webtracking_chunk(config, &chunk, opts, http).await?;
    }
    Ok(())
}

pub async fn post_api_key_log_store_logs(
    config: &SlsTransportConfig,
    api_key: &str,
    log_group: &SlsLogGroupPayload,
    opts: &PostApiKeyOptions,
    http: &dyn SlsHttp,
) -> Result<(), SendError> {
    let mut group = log_group.clone();
    if group.topic.is_none() {
        group.topic.clone_from(&opts.topic);
    }
    if group.source.is_none() {
        group.source.clone_from(&opts.source);
    }
    if group.tags.is_none() {
        group.tags.clone_from(&opts.tags);
    }
    let body = encode_sls_log_group(&group);
    let path = format!("/logstores/{}/shards/lb", config.logstore);
    let target = build_project_request_target(&config.endpoint, &config.project, &path);
    let mut headers = vec![
        ("authorization".to_string(), format!("Bearer {api_key}")),
        (
            "content-type".to_string(),
            "application/x-protobuf".to_string(),
        ),
        ("content-md5".to_string(), content_md5_hex(&body)),
        ("content-length".to_string(), body.len().to_string()),
        ("date".to_string(), http_date_now()),
        ("x-log-apiversion".to_string(), "0.6.0".to_string()),
        ("x-log-bodyrawsize".to_string(), body.len().to_string()),
    ];
    if let Some(user_agent) = &opts.user_agent {
        headers.push(("user-agent".to_string(), user_agent.clone()));
    }
    if let Some(host) = &target.host_header {
        headers.push(("host".to_string(), host.clone()));
    }

    let max_retries = config.max_retries.unwrap_or(RETRY_MAX_ATTEMPTS).max(1);
    let retry_base_delay = config.retry_base_delay_ms.unwrap_or(RETRY_BASE_DELAY_MS);
    let timeout_ms = config.timeout_ms.unwrap_or(WEBTRACKING_TIMEOUT_MS);
    let logger = create_logger("SlsTransport");
    let mut last_err = SendError::Message("unknown apiKey error".to_string());

    for attempt in 0..max_retries {
        match http
            .post(SlsHttpRequest {
                url: target.url.clone(),
                body: body.clone(),
                headers: headers.clone(),
                timeout: Duration::from_millis(timeout_ms),
            })
            .await
        {
            Ok(response) if (200..300).contains(&response.status) => {
                logger.debug(
                    "batch sent via apiKey",
                    Some(&meta(&[
                        ("project", Value::String(config.project.clone())),
                        ("logstore", Value::String(config.logstore.clone())),
                        ("count", Value::from(group.logs.len())),
                    ])),
                );
                return Ok(());
            }
            Ok(response) => {
                let err = SendError::Http(HttpError::new(response.status, response.body));
                let retryable = matches!(&err, SendError::Http(http) if RETRYABLE_STATUS_CODES.contains(&http.status));
                last_err = err;
                if !retryable || attempt + 1 == max_retries {
                    break;
                }
            }
            Err(error) => {
                let retryable = !matches!(&error, SendError::Http(http) if !RETRYABLE_STATUS_CODES.contains(&http.status));
                last_err = error;
                if !retryable || attempt + 1 == max_retries {
                    break;
                }
            }
        }
        let delay = retry_base_delay.saturating_mul(1_u64 << attempt.min(20));
        logger.warn(
            "SLS apiKey send retrying",
            Some(&meta(&[
                ("attempt", Value::from(attempt + 1)),
                ("delayMs", Value::from(delay)),
                ("error", Value::String(last_err.to_string())),
            ])),
        );
        sleep_ms(delay).await;
    }
    Err(last_err)
}

pub fn content_md5_hex(body: &[u8]) -> String {
    hex::encode(md5(body)).to_uppercase()
}

#[derive(Clone, Debug)]
pub struct ProjectRequestTarget {
    pub url: String,
    pub host_header: Option<String>,
}

pub fn build_project_request_target(
    endpoint: &str,
    project: &str,
    request_path: &str,
) -> ProjectRequestTarget {
    let normalized = endpoint.trim_end_matches('/').to_string();
    let Some(parsed) = parse_http_url(&normalized) else {
        return ProjectRequestTarget {
            url: format!("{normalized}{request_path}"),
            host_header: None,
        };
    };
    if is_loopback_host(&parsed.hostname) {
        return ProjectRequestTarget {
            url: format!("{}{request_path}", parsed.origin),
            host_header: Some(if project.is_empty() {
                parsed.host.clone()
            } else {
                format!("{project}.{}", parsed.host)
            }),
        };
    }
    let base = if project.is_empty() {
        normalized
    } else if let Some(rest) = normalized.strip_prefix("https://") {
        format!("https://{project}.{rest}")
    } else if let Some(rest) = normalized.strip_prefix("http://") {
        format!("http://{project}.{rest}")
    } else {
        normalized
    };
    ProjectRequestTarget {
        url: format!("{base}{request_path}"),
        host_header: None,
    }
}

pub fn is_loopback_host(hostname: &str) -> bool {
    matches!(hostname, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

#[derive(Clone, Debug)]
pub struct ParsedHttpUrl {
    pub origin: String,
    pub host: String,
    pub hostname: String,
}

pub fn parse_http_url(input: &str) -> Option<ParsedHttpUrl> {
    let (scheme, rest) = input.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if authority.is_empty() {
        return None;
    }
    let hostname = if let Some(inside) = authority.strip_prefix('[') {
        let end = inside.find(']')?;
        format!("[{}]", &inside[..end])
    } else {
        authority.split(':').next().unwrap_or(authority).to_string()
    };
    Some(ParsedHttpUrl {
        origin: format!("{scheme}://{authority}"),
        host: authority.to_string(),
        hostname,
    })
}

#[derive(Clone, Debug)]
pub struct SlsHttpRequest {
    pub url: String,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
    pub timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct SlsHttpResponse {
    pub status: u16,
    pub body: String,
}

#[async_trait::async_trait]
pub trait SlsHttp: Send + Sync {
    async fn post(&self, request: SlsHttpRequest) -> Result<SlsHttpResponse, SendError>;
}

pub struct ReqwestSlsHttp {
    client: reqwest::Client,
}

impl ReqwestSlsHttp {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }
}

impl Default for ReqwestSlsHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl SlsHttp for ReqwestSlsHttp {
    async fn post(&self, request: SlsHttpRequest) -> Result<SlsHttpResponse, SendError> {
        let mut builder = self
            .client
            .post(&request.url)
            .timeout(request.timeout)
            .body(request.body);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let response = builder.send().await.map_err(map_reqwest_error)?;
        let status = response.status().as_u16();
        // Successful PutLogs/WebTracking responses carry no consumed payload.
        // Drop the body immediately so an unfinished success stream cannot hold
        // the source checkpoint until the request timeout.
        let body = if (200..300).contains(&status) {
            String::new()
        } else {
            response.text().await.map_err(map_reqwest_error)?
        };
        Ok(SlsHttpResponse { status, body })
    }
}

pub fn map_reqwest_error(error: reqwest::Error) -> SendError {
    let raw = error.to_string();
    if error.is_timeout()
        || raw.to_ascii_lowercase().contains("timed out")
        || raw.contains("timeout")
    {
        return SendError::Message(format!("TimeoutError {raw}"));
    }
    if error.is_connect() {
        let lower = raw.to_ascii_lowercase();
        if lower.contains("reset") {
            return SendError::Message(format!("ECONNRESET {raw}"));
        }
        if lower.contains("refused") {
            return SendError::Message(format!("ECONNREFUSED {raw}"));
        }
        return SendError::Message(format!("ECONNREFUSED {raw}"));
    }
    SendError::Message(raw)
}

pub fn send_error_node(error: &SendError) -> std::rc::Rc<super::sls_error_classifier::ErrorNode> {
    use super::sls_error_classifier::{ErrorNode, ErrorNodeInit};
    match error {
        SendError::Http(http) => ErrorNode::create(ErrorNodeInit {
            name: "HttpError".to_string(),
            message: http.to_string(),
            status: Some(i64::from(http.status)),
            body: Some(http.body.clone()),
            ..ErrorNodeInit::default()
        }),
        SendError::Message(message) => ErrorNode::leaf("Error", message.clone()),
        SendError::Chain(owned) => owned_to_node(owned),
    }
}

fn owned_to_node(error: &OwnedError) -> std::rc::Rc<super::sls_error_classifier::ErrorNode> {
    use super::sls_error_classifier::{ErrorNode, ErrorNodeInit};
    let node = ErrorNode::create(ErrorNodeInit {
        name: error.name.clone(),
        message: error.message.clone(),
        status: error.status,
        status_code: error.status_code,
        error_code: error.error_code.clone(),
        code: error.code.clone(),
        body: error.body.clone(),
    });
    if let Some(cause) = &error.cause {
        node.with_cause(owned_to_node(cause));
    }
    node
}

async fn post_webtracking_chunk(
    config: &SlsTransportConfig,
    logs: &[IndexMap<String, String>],
    opts: &PostWebtrackingOptions,
    http: &dyn SlsHttp,
) -> Result<(), SendError> {
    let mut body = Map::new();
    body.insert(
        "__topic__".to_string(),
        Value::String(opts.topic.clone().unwrap_or_default()),
    );
    body.insert(
        "__source__".to_string(),
        Value::String(opts.source.clone().unwrap_or_default()),
    );
    body.insert(
        "__logs__".to_string(),
        Value::Array(logs.iter().map(json_string_map).collect()),
    );
    body.insert(
        "__tags__".to_string(),
        Value::Object(opts.tags.clone().unwrap_or_default()),
    );
    let raw = serde_json::to_string(&Value::Object(body)).unwrap_or_else(|_| "{}".to_string());
    let base = if let Some(rest) = config.endpoint.strip_prefix("https://") {
        format!("https://{}.{}", config.project, rest)
    } else if let Some(rest) = config.endpoint.strip_prefix("http://") {
        format!("http://{}.{}", config.project, rest)
    } else {
        config.endpoint.clone()
    };
    let url = format!("{base}/logstores/{}/track", config.logstore);
    let mut headers = vec![
        ("x-log-apiversion".to_string(), "0.6.0".to_string()),
        ("x-log-bodyrawsize".to_string(), raw.len().to_string()),
        ("content-type".to_string(), "application/json".to_string()),
    ];
    if let Some(user_agent) = &opts.user_agent {
        headers.push(("user-agent".to_string(), user_agent.clone()));
    }
    let max_retries = config.max_retries.unwrap_or(RETRY_MAX_ATTEMPTS).max(1);
    let retry_base_delay = config.retry_base_delay_ms.unwrap_or(RETRY_BASE_DELAY_MS);
    let timeout_ms = config.timeout_ms.unwrap_or(WEBTRACKING_TIMEOUT_MS);
    let logger = create_logger("SlsTransport");
    let mut last_err = SendError::Message("unknown webtracking error".to_string());

    for attempt in 0..max_retries {
        match http
            .post(SlsHttpRequest {
                url: url.clone(),
                body: raw.as_bytes().to_vec(),
                headers: headers.clone(),
                timeout: Duration::from_millis(timeout_ms),
            })
            .await
        {
            Ok(response) if (200..300).contains(&response.status) => {
                logger.debug(
                    "batch sent via webtracking",
                    Some(&meta(&[
                        ("project", Value::String(config.project.clone())),
                        ("logstore", Value::String(config.logstore.clone())),
                        ("count", Value::from(logs.len())),
                    ])),
                );
                return Ok(());
            }
            Ok(response) => {
                let err = SendError::Http(HttpError::new(response.status, response.body));
                let retryable = matches!(&err, SendError::Http(http) if RETRYABLE_STATUS_CODES.contains(&http.status));
                last_err = err;
                if !retryable || attempt + 1 == max_retries {
                    break;
                }
            }
            Err(error) => {
                let stop = matches!(&error, SendError::Http(http) if !RETRYABLE_STATUS_CODES.contains(&http.status));
                last_err = error;
                if stop || attempt + 1 == max_retries {
                    break;
                }
            }
        }
        let delay = retry_base_delay.saturating_mul(1_u64 << attempt.min(20));
        logger.warn(
            "SLS webtracking retrying",
            Some(&meta(&[
                ("attempt", Value::from(attempt + 1)),
                ("delayMs", Value::from(delay)),
                ("error", Value::String(last_err.to_string())),
            ])),
        );
        sleep_ms(delay).await;
    }
    Err(last_err)
}

fn json_string_map(log: &IndexMap<String, String>) -> Value {
    let mut map = Map::new();
    for (key, value) in log {
        map.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(map)
}

pub(crate) fn meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

pub async fn sleep_ms(ms: u64) {
    if ms == 0 {
        tokio::task::yield_now().await;
        return;
    }
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

pub fn http_date_now() -> String {
    chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

/// LOG authorization headers for PutLogs. Canonical string-to-sign follows the
/// Aliyun Log v1 HMAC-SHA1 scheme used by `@alicloud/log`.
pub fn signed_ak_headers(
    method: &str,
    resource: &str,
    body: &[u8],
    access_key_id: &str,
    access_key_secret: &str,
    user_agent: Option<&str>,
    host_header: Option<&str>,
) -> Vec<(String, String)> {
    let mut headers = vec![
        (
            "content-type".to_string(),
            "application/x-protobuf".to_string(),
        ),
        ("content-md5".to_string(), content_md5_hex(body)),
        ("date".to_string(), http_date_now()),
        ("x-log-apiversion".to_string(), "0.6.0".to_string()),
        ("x-log-bodyrawsize".to_string(), body.len().to_string()),
        ("x-log-signaturemethod".to_string(), "hmac-sha1".to_string()),
    ];
    let mut canonical: Vec<(String, String)> = headers
        .iter()
        .filter(|(key, _)| {
            let lower = key.to_ascii_lowercase();
            lower.starts_with("x-log-") || lower.starts_with("x-acs-")
        })
        .map(|(key, value)| (key.to_ascii_lowercase(), value.clone()))
        .collect();
    canonical.sort_by(|left, right| left.0.cmp(&right.0));
    let canonical_headers = canonical
        .iter()
        .map(|(key, value)| format!("{key}:{value}\n"))
        .collect::<String>();
    let content_md5 = header_value(&headers, "content-md5");
    let content_type = header_value(&headers, "content-type");
    let date = header_value(&headers, "date");
    let string_to_sign =
        format!("{method}\n{content_md5}\n{content_type}\n{date}\n{canonical_headers}{resource}");
    let signature = STANDARD.encode(hmac_sha1(
        access_key_secret.as_bytes(),
        string_to_sign.as_bytes(),
    ));
    headers.push((
        "authorization".to_string(),
        format!("LOG {access_key_id}:{signature}"),
    ));
    headers.push(("content-length".to_string(), body.len().to_string()));
    if let Some(user_agent) = user_agent {
        headers.push(("user-agent".to_string(), user_agent.to_string()));
    }
    if let Some(host) = host_header {
        headers.push(("host".to_string(), host.to_string()));
    }
    headers
}

fn header_value(headers: &[(String, String)], name: &str) -> String {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

pub fn md5(message: &[u8]) -> [u8; 16] {
    fn f(x: u32, y: u32, z: u32) -> u32 {
        (x & y) | (!x & z)
    }
    fn g(x: u32, y: u32, z: u32) -> u32 {
        (x & z) | (y & !z)
    }
    fn h(x: u32, y: u32, z: u32) -> u32 {
        x ^ y ^ z
    }
    fn i(x: u32, y: u32, z: u32) -> u32 {
        y ^ (x | !z)
    }
    const SHIFTS: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const TABLE: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];
    let mut msg = message.to_vec();
    let bit_len = (message.len() as u64).saturating_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());
    let mut a0 = 0x67452301_u32;
    let mut b0 = 0xefcdab89_u32;
    let mut c0 = 0x98badcfe_u32;
    let mut d0 = 0x10325476_u32;
    for chunk in msg.chunks(64) {
        let mut words = [0_u32; 16];
        for (index, word) in chunk.chunks(4).enumerate() {
            words[index] = u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
        }
        let mut a = a0;
        let mut b = b0;
        let mut c = c0;
        let mut d = d0;
        for round in 0..64 {
            let (mixed, index) = if round < 16 {
                (f(b, c, d), round)
            } else if round < 32 {
                (g(b, c, d), (5 * round + 1) % 16)
            } else if round < 48 {
                (h(b, c, d), (3 * round + 5) % 16)
            } else {
                (i(b, c, d), (7 * round) % 16)
            };
            let mixed = mixed
                .wrapping_add(a)
                .wrapping_add(TABLE[round])
                .wrapping_add(words[index]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(mixed.rotate_left(SHIFTS[round]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = [0_u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}

pub fn sha1(message: &[u8]) -> [u8; 20] {
    let mut msg = message.to_vec();
    let bit_len = (message.len() as u64).saturating_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    let mut h0 = 0x67452301_u32;
    let mut h1 = 0xEFCDAB89_u32;
    let mut h2 = 0x98BADCFE_u32;
    let mut h3 = 0x10325476_u32;
    let mut h4 = 0xC3D2E1F0_u32;
    for chunk in msg.chunks(64) {
        let mut words = [0_u32; 80];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;
        for (index, word) in words.iter().enumerate() {
            let (mixed, constant) = if index < 20 {
                ((b & c) | ((!b) & d), 0x5A827999)
            } else if index < 40 {
                (b ^ c ^ d, 0x6ED9EBA1)
            } else if index < 60 {
                ((b & c) | (b & d) | (c & d), 0x8F1BBCDC)
            } else {
                (b ^ c ^ d, 0xCA62C1D6)
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(mixed)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }
    let mut out = [0_u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

pub fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    let mut key_block = [0_u8; 64];
    if key.len() > 64 {
        let hashed = sha1(key);
        key_block[..20].copy_from_slice(&hashed);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0_u8; 64];
    let mut opad = [0_u8; 64];
    for index in 0..64 {
        ipad[index] = key_block[index] ^ 0x36;
        opad[index] = key_block[index] ^ 0x5c;
    }
    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(message);
    let inner_hash = sha1(&inner);
    let mut outer = Vec::with_capacity(84);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha1(&outer)
}

#[cfg(test)]
mod tests {
    use super::super::sls_loggroup_codec::{SlsLogEntryPayload, SlsLogGroupPayload};
    use super::*;
    use indexmap::IndexMap;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn map_of(pairs: &[(&str, &str)]) -> IndexMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn md5_and_sha1_match_known_digests() {
        assert_eq!(content_md5_hex(b"abc"), "900150983CD24FB0D6963F7D28E17F72");
        assert_eq!(
            hex::encode(sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
    }

    #[test]
    fn split_returns_one_chunk_under_the_limits() {
        let logs = vec![
            map_of(&[("content", "line1")]),
            map_of(&[("content", "line2")]),
        ];
        let chunks = split_for_webtracking(&logs, WEBTRACKING_MAX_LOGS, WEBTRACKING_MAX_BODY_BYTES);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], logs);
        assert_eq!(WEBTRACKING_MAX_LOGS, 4096);
        assert_eq!(WEBTRACKING_MAX_BODY_BYTES, 2_800_000);
    }

    #[test]
    fn split_respects_max_log_count_and_max_bytes() {
        let logs: Vec<_> = (0..5)
            .map(|index| map_of(&[("content", &format!("line{index}"))]))
            .collect();
        let chunks = split_for_webtracking(&logs, 2, WEBTRACKING_MAX_BODY_BYTES);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), 2);
        assert_eq!(chunks[1].len(), 2);
        assert_eq!(chunks[2].len(), 1);

        let big = "x".repeat(1000);
        let fat: Vec<_> = (0..5).map(|_| map_of(&[("content", &big)])).collect();
        let chunks = split_for_webtracking(&fat, 100, 2500);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 5));
        assert!(split_for_webtracking(&[], 10, 10).is_empty());
    }

    #[test]
    fn retryable_status_codes_and_network_text() {
        for status in [429_u16, 500, 502, 503, 504, 408] {
            assert!(is_retryable(&SendError::Http(HttpError::new(status, "x"))));
        }
        for status in [400_u16, 401, 403, 404] {
            assert!(!is_retryable(&SendError::Http(HttpError::new(status, "x"))));
        }
        for message in [
            "ECONNRESET",
            "ETIMEDOUT",
            "ECONNREFUSED",
            "socket hang up",
            "TimeoutError",
        ] {
            assert!(is_retryable(&SendError::Message(message.to_string())));
        }
        assert!(!is_retryable(&SendError::Message(
            "some random error".to_string()
        )));
        assert!(!is_retryable(&SendError::Message(
            "string error".to_string()
        )));
    }

    #[test]
    fn loopback_target_keeps_the_project_in_the_host_header() {
        let target = build_project_request_target(
            "http://127.0.0.1:9",
            "api-key-project",
            "/logstores/shimu-test/shards/lb",
        );
        assert_eq!(
            target.url,
            "http://127.0.0.1:9/logstores/shimu-test/shards/lb"
        );
        assert_eq!(
            target.host_header.as_deref(),
            Some("api-key-project.127.0.0.1:9")
        );
    }

    struct ScriptedHttp {
        statuses: Vec<u16>,
        cursor: AtomicUsize,
        requests: Mutex<Vec<SlsHttpRequest>>,
    }

    #[async_trait::async_trait]
    impl SlsHttp for ScriptedHttp {
        async fn post(&self, request: SlsHttpRequest) -> Result<SlsHttpResponse, SendError> {
            self.requests.lock().unwrap().push(request);
            let index = self.cursor.fetch_add(1, Ordering::SeqCst);
            let status = self.statuses.get(index).copied().unwrap_or(200);
            let body = if status >= 400 {
                "{\"errorCode\":\"retry\"}".to_string()
            } else {
                String::new()
            };
            Ok(SlsHttpResponse { status, body })
        }
    }

    #[tokio::test]
    async fn api_key_posts_protobuf_and_retries_retryable_responses() {
        let http = ScriptedHttp {
            statuses: vec![500, 200],
            cursor: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
        };
        let mut content = IndexMap::new();
        content.insert(
            "message".to_string(),
            "local mock api key transport test".to_string(),
        );
        content.insert("test_case".to_string(), "api-key-transport".to_string());
        let group = SlsLogGroupPayload {
            logs: vec![SlsLogEntryPayload {
                timestamp: 1_782_820_111,
                content,
                timestamp_ns_part: None,
            }],
            topic: Some("api-key-test".to_string()),
            source: Some("unit-test".to_string()),
            tags: Some(vec![{
                let mut tag = IndexMap::new();
                tag.insert("__hostname__".to_string(), "unit-host".to_string());
                tag
            }]),
        };
        post_api_key_log_store_logs(
            &SlsTransportConfig {
                endpoint: "http://127.0.0.1:9".to_string(),
                project: "api-key-project".to_string(),
                logstore: "shimu-test".to_string(),
                timeout_ms: Some(5000),
                max_retries: Some(2),
                retry_base_delay_ms: Some(1),
            },
            "secret-api-key",
            &group,
            &PostApiKeyOptions {
                user_agent: Some("unit-test-agent".to_string()),
                ..PostApiKeyOptions::default()
            },
            &http,
        )
        .await
        .unwrap();
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let last = &requests[1];
        assert_eq!(
            last.url,
            "http://127.0.0.1:9/logstores/shimu-test/shards/lb"
        );
        let headers = header_map(&last.headers);
        assert_eq!(
            headers.get("host").map(String::as_str),
            Some("api-key-project.127.0.0.1:9")
        );
        assert_eq!(
            headers.get("authorization").map(String::as_str),
            Some("Bearer secret-api-key")
        );
        assert_eq!(
            headers.get("content-type").map(String::as_str),
            Some("application/x-protobuf")
        );
        assert_eq!(
            headers.get("content-md5").map(String::as_str),
            Some(content_md5_hex(&last.body).as_str())
        );
        assert!(chrono::NaiveDateTime::parse_from_str(
            headers.get("date").unwrap(),
            "%a, %d %b %Y %H:%M:%S GMT"
        )
        .is_ok());
        assert_eq!(
            headers.get("x-log-bodyrawsize").map(String::as_str),
            Some(last.body.len().to_string()).as_deref()
        );
        assert!(!headers.contains_key("x-log-signaturemethod"));
        assert!(String::from_utf8_lossy(&last.body).contains("api-key-transport"));
    }

    fn header_map(headers: &[(String, String)]) -> HashMap<String, String> {
        headers
            .iter()
            .map(|(key, value)| (key.to_ascii_lowercase(), value.clone()))
            .collect()
    }

    #[tokio::test]
    async fn reqwest_api_key_reaches_a_local_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0_u8; 8192];
            let mut received = Vec::new();
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                received.extend_from_slice(&buf[..n]);
                if let Some(header_end) = find_crlf(&received) {
                    let header = String::from_utf8_lossy(&received[..header_end]).to_string();
                    let length = content_length(&header);
                    let body_start = header_end + 4;
                    if received.len() >= body_start + length {
                        let body = received[body_start..body_start + length].to_vec();
                        let response =
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        socket.write_all(response).await.unwrap();
                        return (header, body);
                    }
                }
            }
            (String::new(), Vec::new())
        });
        let mut content = IndexMap::new();
        content.insert("test_case".to_string(), "api-key-transport".to_string());
        let group = SlsLogGroupPayload {
            logs: vec![SlsLogEntryPayload {
                timestamp: 1,
                content,
                timestamp_ns_part: None,
            }],
            topic: Some("api-key-test".to_string()),
            source: Some("unit-test".to_string()),
            tags: None,
        };
        post_api_key_log_store_logs(
            &SlsTransportConfig {
                endpoint: format!("http://127.0.0.1:{}", address.port()),
                project: "api-key-project".to_string(),
                logstore: "shimu-test".to_string(),
                timeout_ms: Some(5000),
                max_retries: Some(1),
                retry_base_delay_ms: Some(1),
            },
            "secret-api-key",
            &group,
            &PostApiKeyOptions::default(),
            &ReqwestSlsHttp::new(),
        )
        .await
        .unwrap();
        let (header, body) = server.await.unwrap();
        let header_lower = header.to_ascii_lowercase();
        assert!(header_lower.contains("post /logstores/shimu-test/shards/lb"));
        assert!(header_lower.contains("authorization: bearer secret-api-key"));
        assert!(header_lower.contains(&format!(
            "host: api-key-project.127.0.0.1:{}",
            address.port()
        )));
        assert!(String::from_utf8_lossy(&body).contains("api-key-transport"));
    }

    fn find_crlf(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn content_length(header: &str) -> usize {
        header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod migration_api_key_wire_contracts {
    use super::*;
    use indexmap::IndexMap;
    use std::collections::HashMap;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct Capture {
        request_line: String,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    #[tokio::test]
    async fn actual_api_key_http_retry_preserves_frozen_protobuf_and_independent_md5() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/sls-api-key-golden.json"))
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(10),async move {
                let mut captures=Vec::new();
                for status in [500,200] {
                    let (mut socket,_)=listener.accept().await.unwrap();
                    let mut received=Vec::new();
                    let mut buffer=[0u8;4096];
                    let (head_end,headers,request_line,length)=loop {
                        let count=socket.read(&mut buffer).await.unwrap();
                        assert_ne!(count,0);
                        received.extend_from_slice(&buffer[..count]);
                        assert!(received.len()<=65536);
                        if let Some(end)=received.windows(4).position(|window|window==b"\r\n\r\n") {
                            let text=std::str::from_utf8(&received[..end]).unwrap();
                            let headers:HashMap<String,String>=text.lines().skip(1).map(|line|{
                                let (name,value)=line.split_once(':').unwrap();
                                (name.to_ascii_lowercase(),value.trim().to_owned())
                            }).collect();
                            let length=headers["content-length"].parse::<usize>().unwrap();
                            break (end+4,headers,text.lines().next().unwrap().to_owned(),length);
                        }
                    };
                    while received.len()<head_end+length {
                        let count=socket.read(&mut buffer).await.unwrap();
                        assert_ne!(count,0);
                        received.extend_from_slice(&buffer[..count]);
                        assert!(received.len()<=65536);
                    }
                    captures.push(Capture{
                        request_line,headers,body:received[head_end..head_end+length].to_vec()
                    });
                    let body=if status==500 { b"{\"errorCode\":\"retry\"}".as_slice() } else {b"".as_slice()};
                    let response=format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                    socket.write_all(response.as_bytes()).await.unwrap();
                    socket.write_all(body).await.unwrap();
                }
                captures
            }).await.expect("local API-key retry exchange did not settle")
        });
        let group = SlsLogGroupPayload {
            logs: vec![super::super::sls_loggroup_codec::SlsLogEntryPayload {
                timestamp: 1_782_820_111,
                content: IndexMap::from([
                    (
                        "message".to_owned(),
                        "local mock api key transport test".to_owned(),
                    ),
                    ("test_case".to_owned(), "api-key-transport".to_owned()),
                ]),
                timestamp_ns_part: None,
            }],
            topic: Some("api-key-test".into()),
            source: Some("unit-test".into()),
            tags: Some(vec![IndexMap::from([(
                "__hostname__".into(),
                "unit-host".into(),
            )])]),
        };
        post_api_key_log_store_logs(
            &SlsTransportConfig {
                endpoint: format!("http://{address}"),
                project: "api-key-project".into(),
                logstore: "shimu-test".into(),
                max_retries: Some(2),
                retry_base_delay_ms: Some(1),
                timeout_ms: Some(5_000),
            },
            "secret-api-key",
            &group,
            &PostApiKeyOptions {
                user_agent: Some("unit-test-agent".into()),
                ..Default::default()
            },
            &ReqwestSlsHttp::new(),
        )
        .await
        .unwrap();
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests {
            assert_eq!(
                request.request_line,
                "POST /logstores/shimu-test/shards/lb HTTP/1.1"
            );
            assert_eq!(
                request.headers["host"],
                format!("api-key-project.127.0.0.1:{}", address.port())
            );
            assert_eq!(request.headers["authorization"], "Bearer secret-api-key");
            assert_eq!(request.headers["content-type"], "application/x-protobuf");
            assert_eq!(
                request.headers["content-md5"],
                golden["md5"].as_str().unwrap()
            );
            assert_eq!(hex::encode(&request.body), golden["hex"].as_str().unwrap());
            assert!(chrono::DateTime::parse_from_rfc2822(&request.headers["date"]).is_ok());
            assert_eq!(
                request.headers["x-log-bodyrawsize"],
                request.body.len().to_string()
            );
            assert!(!request.headers.contains_key("x-log-signaturemethod"));
            assert!(String::from_utf8_lossy(&request.body).contains("api-key-transport"));
        }
    }
}
