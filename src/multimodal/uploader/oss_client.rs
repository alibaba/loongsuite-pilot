//! OSS PutObject (signature version 4).

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

use crate::utils::create_logger;

use crate::multimodal::digest::{hmac_sha256, hmac_sha256_hex, sha256_hex};
use crate::multimodal::http::{self, HttpReply};
use crate::multimodal::resolve::{normalize_oss_endpoint, OssEndpoint};
use crate::multimodal::types::AbortFlag;

const OSS_V4_ALGORITHM: &str = "OSS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

fn logger() -> crate::utils::BoundLogger {
    create_logger("OssClient")
}

#[derive(Clone, Debug)]
pub struct OssPutObjectParams {
    pub endpoint: String,
    pub bucket: String,
    pub object_key: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub security_token: Option<String>,
    pub body: Vec<u8>,
    pub content_type: String,
    pub timeout_ms: u64,
    pub meta: BTreeMap<String, String>,
    pub signal: Option<AbortFlag>,
}

#[derive(Clone, Debug)]
pub struct OssPutObjectResult {
    pub ok: bool,
    pub status_code: Option<u16>,
    pub request_id: Option<String>,
    pub error: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Debug)]
pub struct SignedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

pub async fn oss_put_object(params: OssPutObjectParams) -> OssPutObjectResult {
    let built = (|| {
        let endpoint = normalize_oss_endpoint(&params.endpoint)?;
        let bucket = validate_bucket(&params.bucket)?;
        let object_key = normalize_object_key(&params.object_key)?;
        build_v4_put_request(V4PutArgs {
            endpoint,
            bucket,
            object_key,
            access_key_id: params.access_key_id.trim().to_string(),
            access_key_secret: params.access_key_secret.trim().to_string(),
            security_token: params
                .security_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            content_type: if params.content_type.is_empty() {
                "application/octet-stream".to_string()
            } else {
                params.content_type.clone()
            },
            meta: params.meta.clone(),
            now: chrono::Utc::now(),
        })
    })();
    let request = match built {
        Ok(request) => request,
        Err(error) => {
            return OssPutObjectResult {
                ok: false,
                status_code: None,
                request_id: None,
                error: Some(error),
                retryable: Some(false),
            };
        }
    };
    if params
        .signal
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        return OssPutObjectResult {
            ok: false,
            status_code: None,
            request_id: None,
            error: Some("aborted".into()),
            retryable: Some(false),
        };
    }
    match http::http_exchange(
        "PUT",
        &request.url,
        &request.headers,
        Some(&params.body),
        params.timeout_ms,
        params.signal.as_ref(),
    )
    .await
    {
        Ok(reply) => reply_to_result(reply, false),
        Err(error) => {
            if params
                .signal
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
                || error == "aborted"
                    && params
                        .signal
                        .as_ref()
                        .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                return OssPutObjectResult {
                    ok: false,
                    status_code: None,
                    request_id: None,
                    error: Some("aborted".into()),
                    retryable: Some(false),
                };
            }
            let external = params
                .signal
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst));
            OssPutObjectResult {
                ok: false,
                status_code: None,
                request_id: None,
                error: Some(if external { "aborted".into() } else { error }),
                retryable: Some(!external),
            }
        }
    }
}

fn reply_to_result(reply: HttpReply, _oss: bool) -> OssPutObjectResult {
    let request_id = http::header(&reply.headers, "x-oss-request-id").map(str::to_string);
    if (200..300).contains(&reply.status) {
        return OssPutObjectResult {
            ok: true,
            status_code: Some(reply.status),
            request_id,
            error: None,
            retryable: None,
        };
    }
    let retryable = reply.status == 408 || reply.status == 429 || reply.status >= 500;
    logger().debug(
        "oss putObject non-200",
        Some(&http::log_meta(&[
            ("statusCode", serde_json::json!(reply.status)),
            (
                "requestId",
                serde_json::json!(request_id.clone().unwrap_or_default()),
            ),
        ])),
    );
    OssPutObjectResult {
        ok: false,
        status_code: Some(reply.status),
        request_id,
        error: Some(format!("oss putObject status {}", reply.status)),
        retryable: Some(retryable),
    }
}

pub fn parse_oss_storage_base_path(storage_base_path: &str) -> Result<(String, String), String> {
    let Some(rest) = storage_base_path.strip_prefix("oss://") else {
        return Err(format!("invalid oss storageBasePath: {storage_base_path}"));
    };
    let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
    if bucket.is_empty() {
        return Err(format!("invalid oss storageBasePath: {storage_base_path}"));
    }
    let prefix = prefix.trim_matches('/').to_string();
    Ok((bucket.to_string(), prefix))
}

pub struct V4PutArgs {
    pub endpoint: OssEndpoint,
    pub bucket: String,
    pub object_key: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub security_token: Option<String>,
    pub content_type: String,
    pub meta: BTreeMap<String, String>,
    pub now: chrono::DateTime<chrono::Utc>,
}

pub fn build_v4_put_request(args: V4PutArgs) -> Result<SignedRequest, String> {
    if args.access_key_id.is_empty() || args.access_key_secret.is_empty() {
        return Err("OSS access key ID and secret are required".to_string());
    }
    let date_time = to_oss_date_time(args.now);
    let date = &date_time[..8];
    let mut headers: Vec<(String, String)> = vec![
        ("Content-Type".into(), args.content_type),
        (
            "User-Agent".into(),
            "loongsuite-pilot-multimodal-oss/1.0".into(),
        ),
        ("x-oss-content-sha256".into(), UNSIGNED_PAYLOAD.into()),
        ("x-oss-date".into(), date_time.clone()),
    ];
    if let Some(token) = &args.security_token {
        headers.push(("x-oss-security-token".into(), token.clone()));
    }
    headers.extend(metadata_headers(&args.meta));
    let canonical_uri = http::uri_encode(&format!("/{}/{}", args.bucket, args.object_key), true);
    let canonical_headers = canonical_headers(&headers);
    let canonical_request =
        format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n\n{UNSIGNED_PAYLOAD}");
    let credential_scope = format!("{date}/{}/oss/aliyun_v4_request", args.endpoint.region);
    let string_to_sign = format!(
        "{OSS_V4_ALGORITHM}\n{date_time}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = hmac_sha256_hex(
        &signing_key(&args.access_key_secret, date, &args.endpoint.region),
        string_to_sign.as_bytes(),
    );
    headers.push((
        "Authorization".into(),
        format!(
            "{OSS_V4_ALGORITHM} Credential={}/{credential_scope}, Signature={signature}",
            args.access_key_id
        ),
    ));
    let encoded_key = http::uri_encode(&args.object_key, true);
    let url = format!(
        "{}://{}.{}/{encoded_key}",
        args.endpoint.scheme, args.bucket, args.endpoint.host
    );
    Ok(SignedRequest { url, headers })
}

fn validate_bucket(bucket: &str) -> Result<String, String> {
    let normalized = bucket.trim();
    // `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`
    let bytes = normalized.as_bytes();
    let valid = bytes.len() >= 3
        && bytes.len() <= 63
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && (bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
    if !valid {
        return Err(format!("Invalid OSS bucket name: {normalized}"));
    }
    Ok(normalized.to_string())
}

fn normalize_object_key(object_key: &str) -> Result<String, String> {
    let key = object_key.trim_start_matches('/');
    if key.is_empty() {
        return Err("OSS object key is required".to_string());
    }
    if key.split('/').any(|part| part == "." || part == "..") {
        return Err("OSS object key must not contain dot segments".to_string());
    }
    Ok(key.to_string())
}

fn canonical_headers(headers: &[(String, String)]) -> String {
    let mut items: Vec<(String, String)> = Vec::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("x-oss-") || lower == "content-md5" || lower == "content-type" {
            items.push((lower, value.trim().to_string()));
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items
        .into_iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect()
}

fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let date_key = hmac_sha256(format!("aliyun_v4{secret}").as_bytes(), date.as_bytes());
    let region_key = hmac_sha256(&date_key, region.as_bytes());
    let product_key = hmac_sha256(&region_key, b"oss");
    hmac_sha256(&product_key, b"aliyun_v4_request")
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
        headers.push((format!("x-oss-meta-{normalized}"), value));
    }
    headers
}

fn to_oss_date_time(date: chrono::DateTime<chrono::Utc>) -> String {
    date.format("%Y%m%dT%H%M%SZ").to_string()
}

pub fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_storage_base_and_signs_without_content_md5() {
        assert_eq!(
            parse_oss_storage_base_path("oss://bucket/pilot-mm/").unwrap(),
            ("bucket".into(), "pilot-mm".into())
        );
        let endpoint = normalize_oss_endpoint("https://oss-cn-shanghai.aliyuncs.com").unwrap();
        let mut meta = BTreeMap::new();
        meta.insert("mime_type".into(), "image/png".into());
        meta.insert("some_key".into(), "v".into());
        let signed = build_v4_put_request(V4PutArgs {
            endpoint,
            bucket: "example-bucket".into(),
            object_key: "arms/a b.png".into(),
            access_key_id: "AKIDEXAMPLE".into(),
            access_key_secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            security_token: None,
            content_type: "image/png".into(),
            meta,
            now: chrono::DateTime::parse_from_rfc3339("2026-07-29T01:02:03Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        })
        .unwrap();
        assert_eq!(
            signed.url,
            "https://example-bucket.oss-cn-shanghai.aliyuncs.com/arms/a%20b.png"
        );
        assert_eq!(
            header_value(&signed.headers, "x-oss-content-sha256"),
            Some("UNSIGNED-PAYLOAD")
        );
        assert_eq!(
            header_value(&signed.headers, "x-oss-date"),
            Some("20260729T010203Z")
        );
        assert!(header_value(&signed.headers, "Content-MD5").is_none());
        assert_eq!(
            header_value(&signed.headers, "x-oss-meta-mime-type"),
            Some("image/png")
        );
        assert_eq!(
            header_value(&signed.headers, "x-oss-meta-some-key"),
            Some("v")
        );
        let auth = header_value(&signed.headers, "Authorization").unwrap();
        assert!(auth.starts_with("OSS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260729/cn-shanghai/oss/aliyun_v4_request, Signature="));
        assert_eq!(auth.len(), "OSS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260729/cn-shanghai/oss/aliyun_v4_request, Signature=".len() + 64);
        let (_, signature) = auth.rsplit_once("Signature=").unwrap();
        assert!(signature
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn includes_security_token_and_rejects_bad_inputs() {
        let endpoint = normalize_oss_endpoint("https://oss-cn-hangzhou.aliyuncs.com").unwrap();
        let signed = build_v4_put_request(V4PutArgs {
            endpoint: endpoint.clone(),
            bucket: "bkt".into(),
            object_key: "k.png".into(),
            access_key_id: "ak".into(),
            access_key_secret: "sk".into(),
            security_token: Some("sts-token".into()),
            content_type: "image/png".into(),
            meta: BTreeMap::new(),
            now: chrono::DateTime::parse_from_rfc3339("2026-08-05T00:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        })
        .unwrap();
        assert_eq!(
            header_value(&signed.headers, "x-oss-security-token"),
            Some("sts-token")
        );
        assert!(header_value(&signed.headers, "Authorization")
            .unwrap()
            .contains("OSS4-HMAC-SHA256"));
        assert!(parse_oss_storage_base_path("s3://bucket/mm")
            .unwrap_err()
            .contains("invalid oss storageBasePath"));
        assert!(parse_oss_storage_base_path("bucket/mm")
            .unwrap_err()
            .contains("invalid oss storageBasePath"));
        assert!(parse_oss_storage_base_path("")
            .unwrap_err()
            .contains("invalid oss storageBasePath"));
        for (id, secret) in [("", "sk"), ("ak", "")] {
            let err = build_v4_put_request(V4PutArgs {
                endpoint: endpoint.clone(),
                bucket: "bucket".into(),
                object_key: "k.png".into(),
                access_key_id: id.into(),
                access_key_secret: secret.into(),
                security_token: None,
                content_type: "image/png".into(),
                meta: BTreeMap::new(),
                now: chrono::Utc::now(),
            })
            .unwrap_err();
            assert!(err.contains("access key ID and secret are required"));
        }
    }

    fn put_params() -> OssPutObjectParams {
        OssPutObjectParams {
            endpoint: "https://oss-cn-shanghai.aliyuncs.com".into(),
            bucket: "valid-bucket".into(),
            object_key: "20260101/abc.png".into(),
            access_key_id: "ak".into(),
            access_key_secret: "sk".into(),
            security_token: None,
            body: b"x".to_vec(),
            content_type: "image/png".into(),
            timeout_ms: 1000,
            meta: BTreeMap::new(),
            signal: None,
        }
    }

    #[tokio::test]
    async fn invalid_bucket_and_key_do_not_use_the_network() {
        let no_network: http::HttpHandler = std::sync::Arc::new(|_| {
            panic!("invalid OSS input must fail before HTTP");
        });
        http::HTTP_HANDLER
            .scope(no_network, async {
                for (bucket, key, message) in [
                    ("Bad_Bucket", "20260101/abc.png", "Invalid OSS bucket name"),
                    (
                        "valid-bucket",
                        "a/../b.png",
                        "must not contain dot segments",
                    ),
                    ("valid-bucket", "/", "object key is required"),
                ] {
                    let mut params = put_params();
                    params.bucket = bucket.into();
                    params.object_key = key.into();
                    let result = oss_put_object(params).await;
                    assert!(!result.ok);
                    assert_eq!(result.retryable, Some(false));
                    assert_eq!(result.status_code, None);
                    assert_eq!(result.request_id, None);
                    assert!(result.error.unwrap().contains(message));
                }
            })
            .await;
    }

    async fn assert_stalled_put_is_cancelled(by_caller: bool) {
        use std::sync::atomic::{AtomicBool, AtomicUsize};
        use std::sync::{Arc, Mutex};
        use std::time::Duration;

        let signal = Arc::new(AtomicBool::new(false));
        let started = Arc::new(tokio::sync::Notify::new());
        let seen = Arc::new(Mutex::new(None));
        let calls = Arc::new(AtomicUsize::new(0));
        let handler: http::HttpHandler = Arc::new({
            let started = started.clone();
            let seen = seen.clone();
            let calls = calls.clone();
            move |call| {
                assert_eq!(call.method, "PUT");
                assert_eq!(call.body, b"x");
                *seen.lock().unwrap() = Some(call.aborted);
                calls.fetch_add(1, Ordering::SeqCst);
                started.notify_one();
                Box::pin(std::future::pending())
            }
        });
        let mut params = put_params();
        params.timeout_ms = if by_caller { 5000 } else { 25 };
        params.signal = Some(signal.clone());
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            http::HTTP_HANDLER.scope(handler.clone(), async {
                let trigger = async {
                    if by_caller {
                        started.notified().await;
                        signal.store(true, Ordering::SeqCst);
                    }
                };
                tokio::join!(oss_put_object(params), trigger).0
            }),
        )
        .await
        .expect("the deadline or caller abort must cancel a stalled PUT");
        assert!(!result.ok);
        assert_eq!(result.retryable, Some(!by_caller));
        assert_eq!(result.error.as_deref(), Some("aborted"));
        assert_eq!(result.status_code, None);
        assert_eq!(result.request_id, None);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(seen
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .load(Ordering::SeqCst));
        assert_eq!(
            Arc::strong_count(&signal),
            1,
            "finished PUT must release caller abort state"
        );

        signal.store(true, Ordering::SeqCst);
        let mut params = put_params();
        params.signal = Some(signal);
        let result = http::HTTP_HANDLER
            .scope(handler, oss_put_object(params))
            .await;
        assert!(!result.ok);
        assert_eq!(result.retryable, Some(false));
        assert_eq!(result.error.as_deref(), Some("aborted"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "pre-aborted input must not invoke HTTP"
        );
    }

    #[tokio::test]
    async fn deadline_aborts_hung_put_and_returns_a_retryable_failure() {
        assert_stalled_put_is_cancelled(false).await;
    }

    #[tokio::test]
    async fn caller_abort_cancels_hung_put_without_retry_or_retaining_signal() {
        assert_stalled_put_is_cancelled(true).await;
    }
}
