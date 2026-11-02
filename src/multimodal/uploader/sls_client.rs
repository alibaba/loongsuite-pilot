//! SLS object storage client: Auth V1, ApiKey bearer, anonymous, and presigned PUT.
//!
//! Port of `src/multimodal/uploader/sls-client.ts`. HTTP goes through reqwest
//! unless a task-local handler is installed.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

use chrono::{Datelike, Timelike, Utc};
use serde_json::{json, Value};

use crate::types::MultimodalStorageAuth;
use crate::utils::create_logger;

use super::retry::{with_retries, AttemptError, RetryOutcome, DEFAULT_MULTIMODAL_RETRY};
use crate::multimodal::digest::{hmac_sha1_base64, md5_hex_upper};
use crate::multimodal::http::{self, HttpReply};
use crate::multimodal::resolve::normalize_oss_endpoint;
use crate::multimodal::types::AbortFlag;

const SLS_API_VERSION: &str = "0.6.0";
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const SLS_PUBLIC_HOST_SUFFIX: &str = ".log.aliyuncs.com";
const SLS_STARTUP_TIMEOUT_MS: u64 = 5_000;

pub const PRESIGN_ORIGIN_MISMATCH_ERROR: &str = "presign url origin mismatch";
pub const SLS_HTTP_STORAGE_PROBE_KEY: &str = "_pilot/storage-probe";

fn logger() -> crate::utils::BoundLogger {
    create_logger("SlsClient")
}

#[derive(Clone, Debug)]
pub struct SlsEndpoint {
    pub scheme: String,
    pub host: String,
}

#[derive(Clone, Debug)]
pub struct SlsRequest {
    pub endpoint: String,
    pub project: String,
    pub logstore: String,
    pub mode: Option<String>,
    pub access_key_id: Option<String>,
    pub access_key_secret: Option<String>,
    pub security_token: Option<String>,
    pub api_key: Option<String>,
    pub timeout_ms: Option<u64>,
    pub signal: Option<AbortFlag>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlsResult {
    pub ok: bool,
    pub status_code: Option<u16>,
    pub request_id: Option<String>,
    pub error: Option<String>,
    pub retryable: Option<bool>,
    pub url: Option<String>,
}

impl SlsResult {
    fn fail(error: impl Into<String>, retryable: bool) -> Self {
        Self {
            ok: false,
            status_code: None,
            request_id: None,
            error: Some(error.into()),
            retryable: Some(retryable),
            url: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SignedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
enum ObjectAuth {
    Ak {
        access_key_id: String,
        access_key_secret: String,
        security_token: Option<String>,
    },
    ApiKey {
        api_key: String,
    },
    Anonymous,
}

pub fn try_parse_sls_storage_base_path(storage_base_path: &str) -> Option<(String, String)> {
    let mut path = storage_base_path.trim().to_string();
    if let Some(rest) = path.strip_prefix("sls://") {
        path = rest.to_string();
    }
    let path = path.trim_start_matches('/');
    let mut parts = path.split('/');
    let project = parts.next().unwrap_or("");
    let logstore = parts.next().unwrap_or("");
    if project.is_empty() || logstore.is_empty() {
        None
    } else {
        Some((project.to_string(), logstore.to_string()))
    }
}

pub fn try_parse_oss_event_storage_base_path(
    storage_base_path: &str,
) -> Option<(String, String, String)> {
    let raw = storage_base_path.trim();
    let rest = raw.strip_prefix("oss://")?;
    let parts: Vec<&str> = rest.trim_start_matches('/').split('/').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some((
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2].to_string(),
    ))
}

pub fn build_sls_http_event_storage_base_path(
    oss_bucket: &str,
    project: &str,
    logstore: &str,
) -> Result<String, String> {
    let oss_bucket = oss_bucket.trim();
    let project = project.trim();
    let logstore = logstore.trim();
    if oss_bucket.is_empty() || project.is_empty() || logstore.is_empty() {
        return Err("oss bucket, project, and logstore are required".to_string());
    }
    Ok(format!("oss://{oss_bucket}/{project}/{logstore}"))
}

pub fn format_rfc822_gmt(date: chrono::DateTime<Utc>) -> String {
    let weekday = WEEKDAYS[date.weekday().num_days_from_sunday() as usize];
    let month = MONTHS[date.month0() as usize];
    format!(
        "{weekday}, {:02} {month} {} {:02}:{:02}:{:02} GMT",
        date.day(),
        date.year(),
        date.hour(),
        date.minute(),
        date.second()
    )
}

pub fn normalize_sls_endpoint(endpoint: &str) -> Result<SlsEndpoint, String> {
    let mut raw = endpoint.trim().to_string();
    if raw.is_empty() {
        return Err("SLS endpoint is required".to_string());
    }
    if !raw.to_ascii_lowercase().starts_with("http://")
        && !raw.to_ascii_lowercase().starts_with("https://")
    {
        raw = format!("https://{raw}");
    }
    let parsed = reqwest::Url::parse(&raw)
        .map_err(|_| "SLS endpoint must not include path, query, or credentials".to_string())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || (parsed.path() != "/" && !parsed.path().is_empty())
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("SLS endpoint must not include path, query, or credentials".to_string());
    }
    let host = parsed
        .host_str()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let port = parsed
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(SlsEndpoint {
        scheme: parsed.scheme().to_string(),
        host: format!("{host}{port}"),
    })
}

pub fn sls_project_host(project: &str, endpoint_host: &str) -> String {
    let host = endpoint_host.trim_end_matches('.');
    let host_lower = host.to_ascii_lowercase();
    let project_lower = project.to_ascii_lowercase();
    if let Some(rest) = host_lower.strip_suffix(SLS_PUBLIC_HOST_SUFFIX) {
        let parts: Vec<&str> = rest.split('.').filter(|part| !part.is_empty()).collect();
        if parts.len() >= 2 {
            if parts[0] == project_lower {
                return host.to_string();
            }
            let regional = format!("{}{SLS_PUBLIC_HOST_SUFFIX}", parts[1..].join("."));
            logger().warn(
                "SLS endpoint host carries a different project; using configured project",
                Some(&http::log_meta(&[
                    ("endpointHost", json!(host)),
                    ("hostProject", json!(parts[0])),
                    ("project", json!(project)),
                ])),
            );
            return format!("{project}.{regional}");
        }
    }
    format!("{project}.{host}")
}

fn resolve_auth(params: &SlsRequest) -> Result<ObjectAuth, String> {
    let api_key = params.api_key.as_deref().unwrap_or("").trim().to_string();
    let access_key_id = params
        .access_key_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let access_key_secret = params
        .access_key_secret
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let security_token = params
        .security_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    match params.mode.as_deref() {
        Some("anonymous") => {
            if !api_key.is_empty()
                || !access_key_id.is_empty()
                || !access_key_secret.is_empty()
                || security_token.is_some()
            {
                return Err("SLS anonymous auth cannot include credentials".to_string());
            }
            Ok(ObjectAuth::Anonymous)
        }
        Some("apiKey") => {
            if api_key.is_empty() {
                return Err("SLS apiKey is required".to_string());
            }
            Ok(ObjectAuth::ApiKey { api_key })
        }
        Some("ak") => {
            if access_key_id.is_empty() || access_key_secret.is_empty() {
                return Err("SLS access key ID and secret are required".to_string());
            }
            Ok(ObjectAuth::Ak {
                access_key_id,
                access_key_secret,
                security_token,
            })
        }
        _ => Err("SLS auth mode is required".to_string()),
    }
}

fn normalize_object_key(object_key: &str) -> Result<String, String> {
    let key = object_key.trim_start_matches('/');
    if key.is_empty() {
        return Err("SLS object key is required".to_string());
    }
    if key.split('/').any(|part| part == "." || part == "..") {
        return Err("SLS object key must not contain dot segments".to_string());
    }
    Ok(key.to_string())
}

fn object_name_encode(object_key: &str) -> String {
    http::uri_encode(object_key, true)
}

fn metadata_headers(meta: &BTreeMap<String, String>) -> Vec<(String, String)> {
    let mut headers = Vec::new();
    for (name, value) in meta {
        let normalized = name.trim().to_ascii_lowercase().replace('_', "-");
        if normalized.is_empty()
            || !normalized
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        {
            continue;
        }
        let value = value.trim().chars().take(256).collect::<String>();
        headers.push((format!("x-log-meta-{normalized}"), value));
    }
    headers
}

fn canonicalized_log_headers(headers: &[(String, String)]) -> String {
    let mut items: Vec<(String, String)> = Vec::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("x-acs-")
            || (lower.starts_with("x-log-") && !lower.starts_with("x-log-meta-"))
        {
            items.push((lower, value.clone()));
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items
        .into_iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect()
}

pub struct JsonRequestArgs<'a> {
    pub endpoint: &'a SlsEndpoint,
    pub project: &'a str,
    pub method: &'a str,
    pub resource: &'a str,
    pub api_key: Option<&'a str>,
    pub access_key_id: Option<&'a str>,
    pub access_key_secret: Option<&'a str>,
    pub security_token: Option<&'a str>,
    pub content_type: Option<String>,
    pub body: Option<&'a [u8]>,
    pub body_length: Option<usize>,
    pub content_md5: Option<String>,
    pub extra_headers: Vec<(String, String)>,
    pub now: chrono::DateTime<Utc>,
    pub anonymous: bool,
}

pub fn build_bearer_json_request(args: &JsonRequestArgs<'_>) -> Result<SignedRequest, String> {
    let api_key = args.api_key.unwrap_or("");
    if api_key.is_empty() {
        return Err("SLS apiKey is required".to_string());
    }
    let host = sls_project_host(args.project, &args.endpoint.host);
    let url = format!("{}://{host}{}", args.endpoint.scheme, args.resource);
    let date = format_rfc822_gmt(args.now);
    let body_length = args
        .body
        .map(|body| body.len())
        .or(args.body_length)
        .unwrap_or(0);
    let mut headers = vec![
        ("Host".into(), host),
        ("Date".into(), date.clone()),
        ("x-log-date".into(), date),
        ("Authorization".into(), format!("Bearer {api_key}")),
        (
            "User-Agent".into(),
            "loongsuite-pilot-multimodal-sls/1.0".into(),
        ),
        ("x-log-apiversion".into(), SLS_API_VERSION.into()),
        ("x-log-bodyrawsize".into(), body_length.to_string()),
    ];
    headers.extend(args.extra_headers.clone());
    if args.method != "GET" && args.method != "DELETE" {
        let content_type = args.content_type.clone().unwrap_or_else(|| {
            if args.body.is_some() {
                "application/json"
            } else {
                "application/octet-stream"
            }
            .to_string()
        });
        headers.push(("Content-Type".into(), content_type));
        headers.push(("Content-Length".into(), body_length.to_string()));
    }
    Ok(SignedRequest { url, headers })
}

pub fn build_anonymous_put_request(args: &JsonRequestArgs<'_>) -> SignedRequest {
    let host = sls_project_host(args.project, &args.endpoint.host);
    let url = format!("{}://{host}{}", args.endpoint.scheme, args.resource);
    let date = format_rfc822_gmt(args.now);
    let body_length = args.body_length.unwrap_or(0);
    let mut headers = vec![
        ("Host".into(), host),
        ("Date".into(), date.clone()),
        ("x-log-date".into(), date),
        (
            "User-Agent".into(),
            "loongsuite-pilot-multimodal-sls/1.0".into(),
        ),
        ("x-log-apiversion".into(), SLS_API_VERSION.into()),
        ("x-log-bodyrawsize".into(), body_length.to_string()),
        (
            "Content-Type".into(),
            args.content_type.clone().unwrap_or_default(),
        ),
        ("Content-Length".into(), body_length.to_string()),
    ];
    headers.extend(args.extra_headers.clone());
    SignedRequest { url, headers }
}

pub fn build_log_v1_json_request(args: &JsonRequestArgs<'_>) -> Result<SignedRequest, String> {
    let access_key_id = args.access_key_id.unwrap_or("");
    let access_key_secret = args.access_key_secret.unwrap_or("");
    if access_key_id.is_empty() || access_key_secret.is_empty() {
        return Err("SLS access key ID and secret are required".to_string());
    }
    let host = sls_project_host(args.project, &args.endpoint.host);
    let url = format!("{}://{host}{}", args.endpoint.scheme, args.resource);
    let date = format_rfc822_gmt(args.now);
    let content_md5 = if let Some(md5) = &args.content_md5 {
        md5.clone()
    } else if let Some(body) = args.body {
        md5_hex_upper(body)
    } else {
        String::new()
    };
    let content_type = args.content_type.clone().unwrap_or_else(|| {
        if args.body.is_some() {
            "application/json".to_string()
        } else {
            String::new()
        }
    });
    let body_length = args
        .body_length
        .or_else(|| args.body.map(|body| body.len()));
    let mut headers = vec![
        ("Host".into(), host),
        ("Date".into(), date.clone()),
        (
            "User-Agent".into(),
            "loongsuite-pilot-multimodal-sls/1.0".into(),
        ),
        ("x-log-apiversion".into(), SLS_API_VERSION.into()),
        (
            "x-log-bodyrawsize".into(),
            body_length.unwrap_or(0).to_string(),
        ),
        ("x-log-signaturemethod".into(), "hmac-sha1".into()),
    ];
    headers.extend(args.extra_headers.clone());
    if !content_type.is_empty() {
        headers.push(("Content-Type".into(), content_type.clone()));
    }
    if let Some(length) = body_length {
        headers.push(("Content-Length".into(), length.to_string()));
    }
    if !content_md5.is_empty() {
        headers.push(("Content-MD5".into(), content_md5.clone()));
    }
    if let Some(token) = args.security_token {
        headers.push(("x-acs-security-token".into(), token.to_string()));
    }
    let string_to_sign = format!(
        "{}\n{}\n{}\n{}\n{}{}",
        args.method,
        content_md5,
        content_type,
        date,
        canonicalized_log_headers(&headers),
        args.resource
    );
    let signature = hmac_sha1_base64(access_key_secret.as_bytes(), string_to_sign.as_bytes());
    headers.push((
        "Authorization".into(),
        format!("LOG {access_key_id}:{signature}"),
    ));
    headers.push((
        "x-log-date".into(),
        headers
            .iter()
            .find(|(name, _)| name == "Date")
            .map(|(_, value)| value.clone())
            .unwrap_or(date),
    ));
    Ok(SignedRequest { url, headers })
}

#[derive(Clone, Debug)]
pub struct PutObjectParams {
    pub request: SlsRequest,
    pub object_key: String,
    pub body: Vec<u8>,
    pub content_type: String,
    pub meta: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub expected_origin: Option<String>,
}

pub async fn sls_put_object(params: PutObjectParams) -> SlsResult {
    match prepare_and_sign(&params, false) {
        Ok(request) => {
            sls_http(
                "PUT",
                &request,
                Some(&params.body),
                params.timeout_ms,
                params.request.signal.as_ref(),
            )
            .await
        }
        Err(error) => SlsResult::fail(error, false),
    }
}

/// Carries the response body alongside [`SlsResult`] for presign parsing.
struct HttpOutcome {
    result: SlsResult,
    body: Vec<u8>,
}

async fn sls_http(
    method: &str,
    request: &SignedRequest,
    body: Option<&[u8]>,
    timeout_ms: u64,
    signal: Option<&AbortFlag>,
) -> SlsResult {
    exchange(method, request, body, timeout_ms, signal)
        .await
        .result
}

async fn exchange(
    method: &str,
    request: &SignedRequest,
    body: Option<&[u8]>,
    timeout_ms: u64,
    signal: Option<&AbortFlag>,
) -> HttpOutcome {
    if timeout_ms == 0 {
        return HttpOutcome {
            result: SlsResult::fail("SLS request timeoutMs must be a positive number", false),
            body: Vec::new(),
        };
    }
    if signal.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return HttpOutcome {
            result: SlsResult::fail("aborted", false),
            body: Vec::new(),
        };
    }
    match http::http_exchange(
        method,
        &request.url,
        &request.headers,
        body,
        timeout_ms,
        signal,
    )
    .await
    {
        Ok(reply) => reply_to_outcome(reply),
        Err(error) => {
            if signal.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return HttpOutcome {
                    result: SlsResult::fail("aborted", false),
                    body: Vec::new(),
                };
            }
            HttpOutcome {
                result: SlsResult {
                    ok: false,
                    status_code: None,
                    request_id: None,
                    error: Some(error),
                    retryable: Some(true),
                    url: None,
                },
                body: Vec::new(),
            }
        }
    }
}

fn reply_to_outcome(reply: HttpReply) -> HttpOutcome {
    let request_id = http::header(&reply.headers, "x-log-requestid")
        .or_else(|| http::header(&reply.headers, "x-log-request-id"))
        .or_else(|| http::header(&reply.headers, "x-oss-request-id"))
        .map(str::to_string);
    if reply.status == 200 || reply.status == 204 {
        return HttpOutcome {
            result: SlsResult {
                ok: true,
                status_code: Some(reply.status),
                request_id,
                error: None,
                retryable: None,
                url: None,
            },
            body: reply.body,
        };
    }
    let text = String::from_utf8_lossy(&reply.body);
    let error = if text.is_empty() {
        format!("{} {}b", reply.status, reply.body.len())
    } else {
        format!("{} {text}", reply.status)
    };
    let retryable = reply.status == 408 || reply.status == 429 || reply.status >= 500;
    HttpOutcome {
        result: SlsResult {
            ok: false,
            status_code: Some(reply.status),
            request_id,
            error: Some(error),
            retryable: Some(retryable),
            url: None,
        },
        body: reply.body,
    }
}

struct Prepared {
    endpoint: SlsEndpoint,
    project: String,
    logstore: String,
    object_key: String,
    auth: ObjectAuth,
}

fn prepare_target(params: &PutObjectParams) -> Result<Prepared, String> {
    let project = params.request.project.trim().to_string();
    let logstore = params.request.logstore.trim().to_string();
    if project.is_empty() || logstore.is_empty() {
        return Err("SLS project and logstore are required".to_string());
    }
    Ok(Prepared {
        endpoint: normalize_sls_endpoint(&params.request.endpoint)?,
        project,
        logstore,
        object_key: normalize_object_key(&params.object_key)?,
        auth: resolve_auth(&params.request)?,
    })
}

fn prepare_and_sign(params: &PutObjectParams, _presign: bool) -> Result<SignedRequest, String> {
    let prepared = prepare_target(params)?;
    let content_type = if params.content_type.is_empty() {
        "application/octet-stream".to_string()
    } else {
        params.content_type.clone()
    };
    let resource = format!(
        "/logstores/{}/objects/{}",
        prepared.logstore,
        object_name_encode(&prepared.object_key)
    );
    let now = Utc::now();
    let extra = metadata_headers(&params.meta);
    match prepared.auth {
        ObjectAuth::Anonymous => Ok(build_anonymous_put_request(&JsonRequestArgs {
            endpoint: &prepared.endpoint,
            project: &prepared.project,
            method: "PUT",
            resource: &resource,
            api_key: None,
            access_key_id: None,
            access_key_secret: None,
            security_token: None,
            content_type: Some(content_type),
            body: None,
            body_length: Some(params.body.len()),
            content_md5: None,
            extra_headers: extra,
            now,
            anonymous: true,
        })),
        ObjectAuth::ApiKey { api_key } => build_bearer_json_request(&JsonRequestArgs {
            endpoint: &prepared.endpoint,
            project: &prepared.project,
            method: "PUT",
            resource: &resource,
            api_key: Some(&api_key),
            access_key_id: None,
            access_key_secret: None,
            security_token: None,
            content_type: Some(content_type),
            body: None,
            body_length: Some(params.body.len()),
            content_md5: None,
            extra_headers: extra,
            now,
            anonymous: false,
        }),
        ObjectAuth::Ak {
            access_key_id,
            access_key_secret,
            security_token,
        } => build_log_v1_json_request(&JsonRequestArgs {
            endpoint: &prepared.endpoint,
            project: &prepared.project,
            method: "PUT",
            resource: &resource,
            api_key: None,
            access_key_id: Some(&access_key_id),
            access_key_secret: Some(&access_key_secret),
            security_token: security_token.as_deref(),
            content_type: Some(content_type),
            body: None,
            body_length: Some(params.body.len()),
            content_md5: None,
            extra_headers: extra,
            now,
            anonymous: false,
        }),
    }
}

#[derive(Clone, Debug)]
pub struct PresignTarget {
    pub object_key: String,
    pub project: String,
    pub logstore: String,
    pub expected_origin: String,
}

pub fn bind_presigned_put_url(url: &str, target: &PresignTarget) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "presign url is invalid".to_string())?;
    if !is_allowed_presign_url(&parsed) {
        return Err("presign url must be https".to_string());
    }
    if target.expected_origin.trim().is_empty() {
        return Err("presign url origin is required".to_string());
    }
    if parsed.origin().ascii_serialization() != target.expected_origin {
        return Err(PRESIGN_ORIGIN_MISMATCH_ERROR.to_string());
    }
    let object_path = presign_object_path(parsed.path())
        .ok_or_else(|| "presign url object path mismatch".to_string())?;
    let expected = format!(
        "{}/{}/{}",
        target.project, target.logstore, target.object_key
    );
    if object_path != expected {
        return Err("presign url object path mismatch".to_string());
    }
    Ok(url.to_string())
}

pub async fn sls_put_presigned_object(
    url: &str,
    body: &[u8],
    timeout_ms: u64,
    signal: Option<&AbortFlag>,
) -> SlsResult {
    if url.trim().is_empty() {
        return SlsResult::fail("presigned URL is required", false);
    }
    let request = SignedRequest {
        url: url.to_string(),
        headers: Vec::new(),
    };
    sls_http("PUT", &request, Some(body), timeout_ms, signal).await
}

pub async fn sls_put_via_presigned_http(params: PutObjectParams) -> SlsResult {
    if params
        .request
        .signal
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        return SlsResult::fail("aborted", false);
    }
    let presign = sls_generate_presigned_url_full(&params).await;
    if !presign.result.ok || presign.result.url.is_none() {
        return presign.result;
    }
    if params
        .request
        .signal
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        return SlsResult::fail("aborted", false);
    }
    let url = presign.result.url.clone().unwrap_or_default();
    let expected = params.expected_origin.clone().unwrap_or_default();
    if let Err(error) = bind_presigned_put_url(
        &url,
        &PresignTarget {
            object_key: params.object_key.clone(),
            project: params.request.project.clone(),
            logstore: params.request.logstore.clone(),
            expected_origin: expected,
        },
    ) {
        return SlsResult::fail(error, false);
    }
    sls_put_presigned_object(
        &url,
        &params.body,
        params.timeout_ms,
        params.request.signal.as_ref(),
    )
    .await
}

async fn sls_generate_presigned_url_full(params: &PutObjectParams) -> HttpOutcome {
    let prepared = match prepare_target(params) {
        Ok(prepared) => prepared,
        Err(error) => {
            return HttpOutcome {
                result: SlsResult::fail(error, false),
                body: Vec::new(),
            }
        }
    };
    if matches!(prepared.auth, ObjectAuth::Anonymous) {
        return HttpOutcome {
            result: SlsResult::fail("SLS presign does not support anonymous auth", false),
            body: Vec::new(),
        };
    }
    let body = serde_json::to_vec(&json!({"key": prepared.object_key, "method": "PUT"}))
        .unwrap_or_default();
    let resource = format!("/logstores/{}/presign", prepared.logstore);
    let now = Utc::now();
    let request = match &prepared.auth {
        ObjectAuth::ApiKey { api_key } => build_bearer_json_request(&JsonRequestArgs {
            endpoint: &prepared.endpoint,
            project: &prepared.project,
            method: "POST",
            resource: &resource,
            api_key: Some(api_key),
            access_key_id: None,
            access_key_secret: None,
            security_token: None,
            content_type: None,
            body: Some(&body),
            body_length: None,
            content_md5: None,
            extra_headers: Vec::new(),
            now,
            anonymous: false,
        }),
        ObjectAuth::Ak {
            access_key_id,
            access_key_secret,
            security_token,
        } => build_log_v1_json_request(&JsonRequestArgs {
            endpoint: &prepared.endpoint,
            project: &prepared.project,
            method: "POST",
            resource: &resource,
            api_key: None,
            access_key_id: Some(access_key_id),
            access_key_secret: Some(access_key_secret),
            security_token: security_token.as_deref(),
            content_type: None,
            body: Some(&body),
            body_length: None,
            content_md5: None,
            extra_headers: Vec::new(),
            now,
            anonymous: false,
        }),
        ObjectAuth::Anonymous => unreachable!(),
    };
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            return HttpOutcome {
                result: SlsResult::fail(error, false),
                body: Vec::new(),
            }
        }
    };
    let outcome = exchange(
        "POST",
        &request,
        Some(&body),
        params.timeout_ms,
        params.request.signal.as_ref(),
    )
    .await;
    if !outcome.result.ok {
        return outcome;
    }
    let text = String::from_utf8_lossy(&outcome.body).to_string();
    match parse_presigned_url(&text) {
        Some(url) => HttpOutcome {
            result: SlsResult {
                url: Some(url),
                ..outcome.result
            },
            body: outcome.body,
        },
        None => HttpOutcome {
            result: SlsResult {
                ok: false,
                error: Some("presign response missing url".into()),
                retryable: Some(false),
                url: None,
                ..outcome.result
            },
            body: outcome.body,
        },
    }
}

pub async fn sls_generate_presigned_url(params: PutObjectParams) -> SlsResult {
    sls_generate_presigned_url_full(&params).await.result
}

fn presign_object_path(pathname: &str) -> Option<String> {
    if !pathname.starts_with('/') || pathname.starts_with("//") {
        return None;
    }
    let decoded = percent_decode(&pathname[1..])?;
    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.split('/').any(|part| part.is_empty())
    {
        return None;
    }
    Some(decoded)
}

fn percent_decode(value: &str) -> Option<String> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_allowed_presign_url(parsed: &reqwest::Url) -> bool {
    if parsed.scheme() == "https" {
        return true;
    }
    if parsed.scheme() != "http" {
        return false;
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "::1"
}

fn parse_presigned_url(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    let url = ["url", "Url", "URL"].iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })?;
    let parsed_url = reqwest::Url::parse(&url).ok()?;
    is_allowed_presign_url(&parsed_url).then_some(url)
}

pub fn sls_storage_auth_fields(auth: &MultimodalStorageAuth) -> SlsRequest {
    match auth {
        MultimodalStorageAuth::Anonymous => SlsRequest {
            endpoint: String::new(),
            project: String::new(),
            logstore: String::new(),
            mode: Some("anonymous".into()),
            access_key_id: None,
            access_key_secret: None,
            security_token: None,
            api_key: None,
            timeout_ms: None,
            signal: None,
        },
        MultimodalStorageAuth::ApiKey(auth) => SlsRequest {
            endpoint: String::new(),
            project: String::new(),
            logstore: String::new(),
            mode: Some("apiKey".into()),
            access_key_id: None,
            access_key_secret: None,
            security_token: None,
            api_key: Some(auth.api_key.clone()),
            timeout_ms: None,
            signal: None,
        },
        MultimodalStorageAuth::Ak(auth) => SlsRequest {
            endpoint: String::new(),
            project: String::new(),
            logstore: String::new(),
            mode: Some("ak".into()),
            access_key_id: Some(auth.access_key_id.clone()),
            access_key_secret: Some(auth.access_key_secret.clone()),
            security_token: auth.security_token.clone(),
            api_key: None,
            timeout_ms: None,
            signal: None,
        },
    }
}

pub async fn sniff_sls_http_event_storage_base_path(
    params: SlsRequest,
) -> Result<(String, String), String> {
    let timeout = params.timeout_ms.unwrap_or(SLS_STARTUP_TIMEOUT_MS);
    let signal = params.signal.clone();
    let probe = with_retries(
        DEFAULT_MULTIMODAL_RETRY,
        |_| {
            let params = params.clone();
            let signal = signal.clone();
            async move {
                let mut request = params.clone();
                request.signal = signal;
                let last = sls_generate_presigned_url_full(&PutObjectParams {
                    request,
                    object_key: SLS_HTTP_STORAGE_PROBE_KEY.into(),
                    body: Vec::new(),
                    content_type: String::new(),
                    meta: BTreeMap::new(),
                    timeout_ms: timeout,
                    expected_origin: None,
                })
                .await;
                if last.result.ok && last.result.url.is_some() {
                    Ok(last.result)
                } else {
                    Err(AttemptError {
                        retryable: last.result.retryable == Some(true),
                        error: last.result.error,
                        status_code: last.result.status_code,
                        request_id: last.result.request_id,
                    })
                }
            }
        },
        params.signal.clone(),
    )
    .await;
    let presign = match probe {
        RetryOutcome::Ok(result) => result,
        RetryOutcome::Err { error, .. } => {
            return Err(error.unwrap_or_else(|| "sls multimodal probe failed".into()));
        }
    };
    let url = presign
        .url
        .ok_or_else(|| presign.error.unwrap_or_else(|| "presign failed".into()))?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| "presign url is invalid".to_string())?;
    if !is_allowed_presign_url(&parsed) {
        return Err("presign url must be https".to_string());
    }
    let oss = parse_aliyun_oss_virtual_host(&url)
        .ok_or_else(|| "presign url missing oss bucket".to_string())?;
    let storage =
        build_sls_http_event_storage_base_path(&oss.0, &params.project, &params.logstore)?;
    Ok((storage, oss.2))
}

fn parse_aliyun_oss_virtual_host(url: &str) -> Option<(String, String, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return None;
    }
    let host = parsed
        .host_str()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let (bucket, rest) = host.split_once('.')?;
    if bucket.is_empty() {
        return None;
    }
    let endpoint = normalize_oss_endpoint(&format!("{}://{rest}", parsed.scheme())).ok()?;
    Some((
        bucket.to_string(),
        endpoint.region,
        parsed.origin().ascii_serialization(),
    ))
}

pub fn header_of<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn ak_request() -> SlsRequest {
        SlsRequest {
            endpoint: "https://cn-hangzhou.log.aliyuncs.com".into(),
            project: "p".into(),
            logstore: "l".into(),
            mode: Some("ak".into()),
            access_key_id: Some("ak".into()),
            access_key_secret: Some("sk".into()),
            security_token: None,
            api_key: None,
            timeout_ms: Some(1000),
            signal: None,
        }
    }

    #[test]
    fn normalizes_endpoint_and_parses_base_path() {
        let endpoint = normalize_sls_endpoint("https://cn-hangzhou.log.aliyuncs.com").unwrap();
        assert_eq!(endpoint.scheme, "https");
        assert_eq!(endpoint.host, "cn-hangzhou.log.aliyuncs.com");
        assert_eq!(
            normalize_sls_endpoint("cn-shanghai.log.aliyuncs.com")
                .unwrap()
                .host,
            "cn-shanghai.log.aliyuncs.com"
        );
        assert_eq!(
            try_parse_sls_storage_base_path("sls://proj/logstore-multimodal"),
            Some(("proj".into(), "logstore-multimodal".into()))
        );
        assert_eq!(
            try_parse_sls_storage_base_path("sls://proj/logstore-multimodal/pilot-mm/"),
            Some(("proj".into(), "logstore-multimodal".into()))
        );
        assert!(try_parse_sls_storage_base_path("").is_none());
        assert!(try_parse_sls_storage_base_path("sls://only-project").is_none());
        assert!(normalize_sls_endpoint("")
            .unwrap_err()
            .contains("SLS endpoint is required"));
        assert!(
            normalize_sls_endpoint("https://cn-hangzhou.log.aliyuncs.com/extra")
                .unwrap_err()
                .contains("must not include path, query, or credentials")
        );
        assert!(
            normalize_sls_endpoint("https://user:pass@cn-hangzhou.log.aliyuncs.com")
                .unwrap_err()
                .contains("must not include path, query, or credentials")
        );
    }

    #[test]
    fn golden_log_authorization_and_bearer_headers() {
        let endpoint = normalize_sls_endpoint("https://cn-hangzhou.log.aliyuncs.com").unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-29T01:02:03Z")
            .unwrap()
            .with_timezone(&Utc);
        let signed = build_log_v1_json_request(&JsonRequestArgs {
            endpoint: &endpoint,
            project: "example-project",
            method: "PUT",
            resource: "/logstores/logstore-multimodal/objects/arms/a%20b.png",
            api_key: None,
            access_key_id: Some("AKIDEXAMPLE"),
            access_key_secret: Some("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"),
            security_token: None,
            content_type: Some("image/png".into()),
            body: None,
            body_length: Some(3),
            content_md5: None,
            extra_headers: vec![
                ("x-log-meta-mime-type".into(), "image/png".into()),
                ("x-log-meta-some-key".into(), "v".into()),
            ],
            now,
            anonymous: false,
        })
        .unwrap();
        assert_eq!(
            signed.url,
            "https://example-project.cn-hangzhou.log.aliyuncs.com/logstores/logstore-multimodal/objects/arms/a%20b.png"
        );
        assert!(header_of(&signed.headers, "Content-MD5").is_none());
        assert_eq!(
            header_of(&signed.headers, "x-log-apiversion"),
            Some("0.6.0")
        );
        assert_eq!(
            header_of(&signed.headers, "x-log-signaturemethod"),
            Some("hmac-sha1")
        );
        assert_eq!(
            header_of(&signed.headers, "Authorization"),
            Some("LOG AKIDEXAMPLE:sWmDOSzZSQVzknzC7djUd1duY6U=")
        );
        assert_eq!(
            header_of(&signed.headers, "x-log-date"),
            header_of(&signed.headers, "Date")
        );

        assert_eq!(
            format_rfc822_gmt(
                chrono::DateTime::parse_from_rfc3339("2026-08-19T05:53:26Z")
                    .unwrap()
                    .with_timezone(&Utc)
            ),
            "Wed, 19 Aug 2026 05:53:26 GMT"
        );
        let endpoint =
            normalize_sls_endpoint("https://mm-proj.cn-hangzhou.log.aliyuncs.com").unwrap();
        assert_eq!(
            sls_project_host("mm-proj", &endpoint.host),
            "mm-proj.cn-hangzhou.log.aliyuncs.com"
        );
        let other =
            normalize_sls_endpoint("https://other-proj.cn-hangzhou.log.aliyuncs.com").unwrap();
        assert_eq!(
            sls_project_host("mm-proj", &other.host),
            "mm-proj.cn-hangzhou.log.aliyuncs.com"
        );
    }

    #[test]
    fn bind_presign_url_pins_origin_and_path() {
        let target = PresignTarget {
            object_key: "20260101/a.png".into(),
            project: "p".into(),
            logstore: "l".into(),
            expected_origin: "https://user-bucket.oss-cn-hangzhou.aliyuncs.com".into(),
        };
        assert!(bind_presigned_put_url(
            "https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1",
            &PresignTarget {
                expected_origin: String::new(),
                ..target.clone()
            },
        )
        .unwrap_err()
        .contains("origin is required"));
        assert!(bind_presigned_put_url(
            "https://user-bucket.oss-attacker.example/p/l/20260101/a.png?sig=1",
            &target
        )
        .unwrap_err()
        .contains("origin mismatch"));
        assert_eq!(
            bind_presigned_put_url(
                "https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1",
                &target
            )
            .unwrap(),
            "https://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1"
        );
        assert!(bind_presigned_put_url(
            "https://user-bucket.oss-cn-hangzhou.aliyuncs.com//p/l/20260101/a.png?sig=1",
            &target
        )
        .unwrap_err()
        .contains("object path mismatch"));
        assert!(bind_presigned_put_url(
            "https://user-bucket.oss-cn-hangzhou.aliyuncs.com/%2Fp/l/20260101/a.png?sig=1",
            &target
        )
        .unwrap_err()
        .contains("object path mismatch"));
    }

    #[tokio::test]
    async fn put_object_records_log_auth_and_status_codes() {
        let seen = std::sync::Arc::new(Mutex::new(
            Vec::<(String, String, Vec<(String, String)>)>::new(),
        ));
        let seen_handler = seen.clone();
        let handler: http::HttpHandler = std::sync::Arc::new(move |call| {
            seen_handler.lock().unwrap().push((
                call.method.clone(),
                call.url.clone(),
                call.headers.clone(),
            ));
            Box::pin(async {
                Ok(http::HttpReply {
                    status: 200,
                    headers: vec![("x-log-requestid".into(), "rid-ak".into())],
                    body: Vec::new(),
                    error: None,
                })
            })
        });
        let result = http::HTTP_HANDLER
            .scope(handler, async {
                sls_put_object(PutObjectParams {
                    request: ak_request(),
                    object_key: "20260101/a b.png".into(),
                    body: b"x".to_vec(),
                    content_type: "image/png".into(),
                    meta: BTreeMap::new(),
                    timeout_ms: 1000,
                    expected_origin: None,
                })
                .await
            })
            .await;
        assert!(result.ok);
        assert_eq!(result.status_code, Some(200));
        assert_eq!(result.request_id.as_deref(), Some("rid-ak"));
        let seen = seen.lock().unwrap();
        assert!(seen[0]
            .1
            .contains("/logstores/l/objects/20260101/a%20b.png"));
        assert!(header_of(&seen[0].2, "Authorization")
            .unwrap()
            .starts_with("LOG ak:"));
        assert!(header_of(&seen[0].2, "Content-MD5").is_none());
    }

    #[tokio::test]
    async fn missing_project_and_bad_key_fail_closed() {
        let mut request = ak_request();
        request.project.clear();
        let missing = sls_put_object(PutObjectParams {
            request,
            object_key: "20260101/abc.png".into(),
            body: b"x".to_vec(),
            content_type: "image/png".into(),
            meta: BTreeMap::new(),
            timeout_ms: 1000,
            expected_origin: None,
        })
        .await;
        assert!(!missing.ok && missing.retryable == Some(false));
        assert!(missing
            .error
            .unwrap()
            .contains("project and logstore are required"));
        let zero = sls_put_object(PutObjectParams {
            request: ak_request(),
            object_key: "k.png".into(),
            body: b"x".to_vec(),
            content_type: "image/png".into(),
            meta: BTreeMap::new(),
            timeout_ms: 0,
            expected_origin: None,
        })
        .await;
        assert!(!zero.ok);
        assert!(zero
            .error
            .unwrap()
            .contains("timeoutMs must be a positive number"));
    }
}

#[cfg(test)]
#[path = "sls_client_contract_tests.rs"]
mod migration_contract_tests;
