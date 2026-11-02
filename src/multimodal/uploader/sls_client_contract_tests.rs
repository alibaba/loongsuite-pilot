use super::*;
use crate::multimodal::http::{header, HttpHandler, HttpReply, HTTP_HANDLER};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const ORIGIN: &str = "https://user-bucket.oss-cn-hangzhou.aliyuncs.com";
fn request() -> SlsRequest {
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
fn params() -> PutObjectParams {
    PutObjectParams {
        request: request(),
        object_key: "20260101/a.png".into(),
        body: b"hello".to_vec(),
        content_type: "image/png".into(),
        meta: [("mime_type".into(), "image/png".into())].into(),
        timeout_ms: 1000,
        expected_origin: Some(ORIGIN.into()),
    }
}
fn reply(status: u16, body: Vec<u8>) -> HttpReply {
    HttpReply {
        status,
        body,
        headers: vec![
            ("x-log-requestid".into(), "rid-presign".into()),
            ("x-oss-request-id".into(), "oss-1".into()),
        ],
        error: None,
    }
}
fn args(endpoint: &SlsEndpoint) -> JsonRequestArgs<'_> {
    JsonRequestArgs {
        endpoint,
        project: "example-project",
        method: "PUT",
        resource: "/logstores/logstore-multimodal/objects/arms/a%20b.png",
        api_key: Some("edge-writer-key"),
        access_key_id: Some("ak"),
        access_key_secret: Some("sk"),
        security_token: None,
        content_type: Some("image/png".into()),
        body: None,
        body_length: Some(3),
        content_md5: None,
        extra_headers: vec![("x-log-meta-mime-type".into(), "image/png".into())],
        now: chrono::DateTime::parse_from_rfc3339("2026-08-19T05:53:26Z")
            .unwrap()
            .with_timezone(&Utc),
        anonymous: false,
    }
}
#[test]
fn endpoint_storage_path_and_project_binding_keep_exact_validation_and_headers() {
    let e = normalize_sls_endpoint("https://cn-hangzhou.log.aliyuncs.com").unwrap();
    assert_eq!(e.scheme, "https");
    assert_eq!(e.host, "cn-hangzhou.log.aliyuncs.com");
    assert_eq!(
        normalize_sls_endpoint("cn-shanghai.log.aliyuncs.com")
            .unwrap()
            .host,
        "cn-shanghai.log.aliyuncs.com"
    );
    for path in [
        "sls://proj/logstore-multimodal",
        "sls://proj/logstore-multimodal/pilot-mm/",
    ] {
        assert_eq!(
            try_parse_sls_storage_base_path(path),
            Some(("proj".into(), "logstore-multimodal".into()))
        );
    }
    for path in ["", "sls://only-project", "proj"] {
        assert!(try_parse_sls_storage_base_path(path).is_none());
    }
    assert_eq!(
        try_parse_sls_storage_base_path("sls://proj/logstore"),
        Some(("proj".into(), "logstore".into()))
    );
    assert!(normalize_sls_endpoint("")
        .unwrap_err()
        .contains("SLS endpoint is required"));
    for endpoint in [
        "https://cn-hangzhou.log.aliyuncs.com/extra",
        "https://cn-hangzhou.log.aliyuncs.com?q=1",
        "https://user:pass@cn-hangzhou.log.aliyuncs.com",
    ] {
        assert!(normalize_sls_endpoint(endpoint)
            .unwrap_err()
            .contains("must not include path, query, or credentials"));
    }
    for host in [
        "mm-proj.cn-hangzhou.log.aliyuncs.com",
        "other-proj.cn-hangzhou.log.aliyuncs.com",
    ] {
        let endpoint = normalize_sls_endpoint(&format!("https://{host}")).unwrap();
        assert_eq!(
            sls_project_host("mm-proj", &endpoint.host),
            "mm-proj.cn-hangzhou.log.aliyuncs.com"
        );
        let mut a = args(&endpoint);
        a.project = "mm-proj";
        a.method = "POST";
        a.resource = "/logstores/mm-store/presign";
        let signed = build_bearer_json_request(&a).unwrap();
        assert_eq!(
            signed.url,
            "https://mm-proj.cn-hangzhou.log.aliyuncs.com/logstores/mm-store/presign"
        );
        assert_eq!(
            header(&signed.headers, "Host"),
            Some("mm-proj.cn-hangzhou.log.aliyuncs.com")
        );
    }
}
#[test]
fn signed_request_security_token_metadata_and_json_md5_match_wire_contract() {
    let endpoint = normalize_sls_endpoint("https://cn-hangzhou.log.aliyuncs.com").unwrap();
    let mut a = args(&endpoint);
    a.project = "example-project";
    a.access_key_id = Some("AKIDEXAMPLE");
    a.access_key_secret = Some("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
    a.now = chrono::DateTime::parse_from_rfc3339("2026-07-29T01:02:03Z")
        .unwrap()
        .with_timezone(&Utc);
    a.extra_headers
        .push(("x-log-meta-some-key".into(), "v".into()));
    let signed = build_log_v1_json_request(&a).unwrap();
    assert_eq!(signed.url,"https://example-project.cn-hangzhou.log.aliyuncs.com/logstores/logstore-multimodal/objects/arms/a%20b.png");
    assert_eq!(
        header(&signed.headers, "Authorization"),
        Some("LOG AKIDEXAMPLE:sWmDOSzZSQVzknzC7djUd1duY6U=")
    );
    assert_eq!(header(&signed.headers, "Content-MD5"), None);
    for (name, value) in [
        ("x-log-apiversion", "0.6.0"),
        ("x-log-signaturemethod", "hmac-sha1"),
        ("x-log-meta-mime-type", "image/png"),
        ("x-log-meta-some-key", "v"),
    ] {
        assert_eq!(header(&signed.headers, name), Some(value));
    }
    assert_eq!(
        header(&signed.headers, "x-log-date"),
        header(&signed.headers, "Date")
    );
    a.access_key_id = Some("ak");
    a.access_key_secret = Some("sk");
    a.security_token = Some("sts-token");
    let signed = build_log_v1_json_request(&a).unwrap();
    assert_eq!(
        header(&signed.headers, "x-acs-security-token"),
        Some("sts-token")
    );
    assert!(header(&signed.headers, "Authorization")
        .unwrap()
        .starts_with("LOG ak:"));
    a.security_token = None;
    a.method = "POST";
    a.project = "p";
    a.resource = "/logstores/l/presign";
    a.content_type = None;
    a.body_length = None;
    let body = br#"{"key":"my_object","method":"PUT"}"#;
    a.body = Some(body);
    let signed = build_log_v1_json_request(&a).unwrap();
    assert_eq!(
        signed.url,
        "https://p.cn-hangzhou.log.aliyuncs.com/logstores/l/presign"
    );
    assert_eq!(
        header(&signed.headers, "Content-Type"),
        Some("application/json")
    );
    let md5 = header(&signed.headers, "Content-MD5").unwrap();
    assert_eq!(md5.len(), 32);
    assert!(md5
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b)));
    assert_eq!(md5, md5_hex_upper(body));
    assert!(header(&signed.headers, "Authorization")
        .unwrap()
        .starts_with("LOG ak:"));
    assert_eq!(
        header(&signed.headers, "x-log-date"),
        header(&signed.headers, "Date")
    );
    for (id, secret) in [("", "sk"), ("ak", "")] {
        a.access_key_id = Some(id);
        a.access_key_secret = Some(secret);
        assert!(build_log_v1_json_request(&a)
            .unwrap_err()
            .contains("access key ID and secret are required"));
    }
}
#[test]
fn anonymous_and_bearer_builders_emit_exact_mode_specific_headers_and_gmt() {
    let endpoint = normalize_sls_endpoint("https://cn-hangzhou.log.aliyuncs.com").unwrap();
    let mut a = args(&endpoint);
    assert_eq!(format_rfc822_gmt(a.now), "Wed, 19 Aug 2026 05:53:26 GMT");
    for anonymous in [false, true] {
        if anonymous {
            a.resource = "/logstores/logstore-multimodal/objects/object_key";
        }
        let signed = if anonymous {
            build_anonymous_put_request(&a)
        } else {
            build_bearer_json_request(&a).unwrap()
        };
        assert_eq!(
            signed.url,
            format!(
                "https://example-project.cn-hangzhou.log.aliyuncs.com{}",
                a.resource
            )
        );
        for (name, value) in [
            ("Date", "Wed, 19 Aug 2026 05:53:26 GMT"),
            ("x-log-date", "Wed, 19 Aug 2026 05:53:26 GMT"),
            ("x-log-apiversion", "0.6.0"),
            ("x-log-bodyrawsize", "3"),
            ("Content-Type", "image/png"),
            ("Content-Length", "3"),
            ("x-log-meta-mime-type", "image/png"),
        ] {
            assert_eq!(header(&signed.headers, name), Some(value));
        }
        assert_eq!(
            header(&signed.headers, "Authorization"),
            if anonymous {
                None
            } else {
                Some("Bearer edge-writer-key")
            }
        );
        for name in [
            "x-acs-security-token",
            "x-log-signaturemethod",
            "Content-MD5",
        ] {
            assert_eq!(header(&signed.headers, name), None);
        }
    }
}
#[test]
fn explicit_auth_mode_selects_only_its_credentials_and_rejects_incomplete_or_anonymous_secrets() {
    let mut r = request();
    r.api_key = Some("k".into());
    r.mode = None;
    assert!(resolve_auth(&r)
        .unwrap_err()
        .contains("auth mode is required"));
    r.mode = Some("apiKey".into());
    assert!(matches!(resolve_auth(&r).unwrap(),ObjectAuth::ApiKey{api_key} if api_key=="k"));
    r.mode = Some("ak".into());
    assert!(
        matches!(resolve_auth(&r).unwrap(),ObjectAuth::Ak{access_key_id,access_key_secret,security_token:None} if access_key_id=="ak" && access_key_secret=="sk")
    );
    r.access_key_id = None;
    r.access_key_secret = None;
    r.api_key = None;
    r.mode = Some("anonymous".into());
    assert!(matches!(resolve_auth(&r).unwrap(), ObjectAuth::Anonymous));
    r.api_key = Some("must-not-be-used".into());
    assert!(resolve_auth(&r)
        .unwrap_err()
        .contains("anonymous auth cannot include credentials"));
    r.mode = Some("apiKey".into());
    r.api_key = Some("".into());
    assert!(resolve_auth(&r).unwrap_err().contains("apiKey is required"));
    r.mode = Some("ak".into());
    r.access_key_id = Some("ak".into());
    r.access_key_secret = Some("".into());
    assert!(resolve_auth(&r)
        .unwrap_err()
        .contains("access key ID and secret are required"));
}
#[tokio::test]
async fn invalid_auth_target_key_and_timeout_never_call_http() {
    let handler: HttpHandler = Arc::new(|_| panic!("invalid local request must not reach HTTP"));
    HTTP_HANDLER
        .scope(handler, async {
            let mut cases = Vec::new();
            let mut p = params();
            p.request.project.clear();
            cases.push((p, "project and logstore are required"));
            let mut p = params();
            p.request.logstore.clear();
            cases.push((p, "project and logstore are required"));
            let mut p = params();
            p.object_key = "a/../b.png".into();
            cases.push((p, "must not contain dot segments"));
            let mut p = params();
            p.object_key = "/".into();
            cases.push((p, "object key is required"));
            let mut p = params();
            p.timeout_ms = 0;
            cases.push((p, "timeoutMs must be a positive number"));
            let mut p = params();
            p.request.mode = None;
            p.request.access_key_id = None;
            p.request.access_key_secret = None;
            cases.push((p, "auth mode is required"));
            let mut p = params();
            p.request.mode = Some("apiKey".into());
            p.request.api_key = Some("  ".into());
            cases.push((p, "apiKey is required"));
            for (p, error) in cases {
                let out = sls_put_object(p).await;
                assert!(!out.ok);
                assert_eq!(out.retryable, Some(false));
                assert!(out.error.unwrap().contains(error));
            }
            let mut p = params();
            p.request.mode = Some("anonymous".into());
            p.request.access_key_id = None;
            p.request.access_key_secret = None;
            let out = sls_generate_presigned_url(p).await;
            assert!(!out.ok);
            assert_eq!(out.retryable, Some(false));
            assert_eq!(
                out.error.as_deref(),
                Some("SLS presign does not support anonymous auth")
            );
            let out = sls_put_presigned_object("  ", b"hello", 1000, None).await;
            assert!(!out.ok);
            assert_eq!(out.retryable, Some(false));
            assert!(out.error.unwrap().contains("presigned URL is required"));
        })
        .await;
}
#[tokio::test]
async fn real_put_modes_preserve_metadata_payload_request_id_and_failure_retryability() {
    for mode in ["ak", "apiKey", "anonymous"] {
        let mut p = params();
        p.object_key = "20260101/a b.png".into();
        p.body = b"abc".to_vec();
        p.request.mode = Some(mode.into());
        if mode != "ak" {
            p.request.access_key_id = None;
            p.request.access_key_secret = None;
        }
        if mode == "apiKey" {
            p.request.api_key = Some("edge-key".into());
        }
        let handler: HttpHandler = Arc::new(move |call| {
            assert_eq!(call.method, "PUT");
            assert!(call.url.contains("/logstores/l/objects/20260101/a%20b.png"));
            assert_eq!(call.body, b"abc");
            if mode == "ak" {
                assert!(header(&call.headers, "Authorization")
                    .unwrap()
                    .starts_with("LOG ak:"));
            } else {
                assert_eq!(
                    header(&call.headers, "Authorization"),
                    if mode == "anonymous" {
                        None
                    } else {
                        Some("Bearer edge-key")
                    }
                );
                assert_eq!(header(&call.headers, "x-log-signaturemethod"), None);
                assert_eq!(header(&call.headers, "x-acs-security-token"), None);
            }
            for (name, value) in [
                ("Content-Type", "image/png"),
                ("Content-Length", "3"),
                ("x-log-bodyrawsize", "3"),
                ("x-log-meta-mime-type", "image/png"),
                ("x-log-apiversion", "0.6.0"),
            ] {
                assert_eq!(header(&call.headers, name), Some(value));
            }
            assert!(header(&call.headers, "x-log-date")
                .unwrap()
                .ends_with(" GMT"));
            assert_eq!(header(&call.headers, "Content-MD5"), None);
            Box::pin(async { Ok(reply(200, vec![])) })
        });
        let out = HTTP_HANDLER.scope(handler, sls_put_object(p)).await;
        assert!(out.ok);
        assert_eq!(out.status_code, Some(200));
        assert_eq!(out.request_id.as_deref(), Some("rid-presign"));
    }
    for status in [403, 408, 429, 500] {
        let handler: HttpHandler =
            Arc::new(move |_| Box::pin(async move { Ok(reply(status, b"err".to_vec())) }));
        let out = HTTP_HANDLER.scope(handler, sls_put_object(params())).await;
        assert!(!out.ok);
        assert_eq!(out.status_code, Some(status));
        assert_eq!(out.retryable, Some(status != 403));
    }
}
#[tokio::test(start_paused = true)]
async fn hung_put_aborts_at_exact_timeout_and_marks_transient_failure() {
    let aborted = Arc::new(Mutex::new(None));
    let handler: HttpHandler = Arc::new({
        let aborted = aborted.clone();
        move |call| {
            *aborted.lock().unwrap() = Some(call.aborted);
            Box::pin(std::future::pending())
        }
    });
    let mut p = params();
    p.timeout_ms = 50;
    HTTP_HANDLER
        .scope(handler, async {
            let put = sls_put_object(p);
            tokio::pin!(put);
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(put.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            tokio::time::advance(Duration::from_millis(49)).await;
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(put.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            tokio::time::advance(Duration::from_millis(1)).await;
            let out = put.await;
            assert!(!out.ok);
            assert_eq!(out.retryable, Some(true));
            assert!(out.error.unwrap().to_ascii_lowercase().contains("aborted"));
            assert!(aborted
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .load(Ordering::SeqCst));
        })
        .await;
}
#[tokio::test]
async fn presign_posts_both_auth_modes_and_accepts_url_case_without_leaking_auth_to_object() {
    for api in [false, true] {
        let mut p = params();
        if api {
            p.request.mode = Some("apiKey".into());
            p.request.api_key = Some("edge-key".into());
        }
        let handler: HttpHandler = Arc::new(move |call| {
            assert_eq!(call.method, "POST");
            assert!(call.url.ends_with("/logstores/l/presign"));
            assert_eq!(
                serde_json::from_slice::<Value>(&call.body).unwrap(),
                json!({"key":"20260101/a.png","method":"PUT"})
            );
            if api {
                assert_eq!(
                    header(&call.headers, "Authorization"),
                    Some("Bearer edge-key")
                );
            } else {
                assert!(header(&call.headers, "Authorization")
                    .unwrap()
                    .starts_with("LOG ak:"));
                let md5 = header(&call.headers, "Content-MD5").unwrap();
                assert_eq!(md5.len(), 32);
                assert!(md5
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b)));
            }
            Box::pin(async move {
                Ok(reply(
                    200,
                    serde_json::to_vec(&if api {
                        json!({"url":"https://oss.example/obj?sig=1"})
                    } else {
                        json!({"Url":"https://oss.example/obj?sig=1"})
                    })
                    .unwrap(),
                ))
            })
        });
        let out = HTTP_HANDLER
            .scope(handler, sls_generate_presigned_url(p))
            .await;
        assert!(out.ok);
        assert_eq!(out.url.as_deref(), Some("https://oss.example/obj?sig=1"));
        assert_eq!(out.request_id.as_deref(), Some("rid-presign"));
    }
    let handler: HttpHandler = Arc::new(|call| {
        assert_eq!(call.method, "PUT");
        assert_eq!(call.body, b"hello");
        assert_eq!(header(&call.headers, "Authorization"), None);
        Box::pin(async {
            let mut r = reply(200, vec![]);
            r.headers = vec![("x-oss-request-id".into(), "oss-1".into())];
            Ok(r)
        })
    });
    let out = HTTP_HANDLER
        .scope(
            handler,
            sls_put_presigned_object(
                &format!("{ORIGIN}/p/l/my_object?STS=1"),
                b"hello",
                1000,
                None,
            ),
        )
        .await;
    assert!(out.ok);
    assert_eq!(out.request_id.as_deref(), Some("oss-1"));
}
#[tokio::test]
async fn presign_failure_invalid_url_origin_and_path_never_reach_second_stage() {
    for (status, url, error) in [
        (403, "", "403"),
        (200, "not-a-url", "presign response missing url"),
        (
            200,
            "http://user-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1",
            "presign response missing url",
        ),
        (
            200,
            "https://other-bucket.oss-cn-hangzhou.aliyuncs.com/p/l/20260101/a.png?sig=1",
            "origin mismatch",
        ),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let handler: HttpHandler = Arc::new({
            let calls = calls.clone();
            move |call| {
                calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(call.method, "POST");
                assert!(call.url.ends_with("/presign"));
                Box::pin(async move {
                    Ok(reply(
                        status,
                        serde_json::to_vec(&json!({"url":url})).unwrap(),
                    ))
                })
            }
        });
        let out = HTTP_HANDLER
            .scope(handler, sls_put_via_presigned_http(params()))
            .await;
        assert!(!out.ok);
        assert_eq!(out.retryable, Some(false));
        assert!(out.error.unwrap().contains(error));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    let target = PresignTarget {
        object_key: "20260101/a.png".into(),
        project: "p".into(),
        logstore: "l".into(),
        expected_origin: ORIGIN.into(),
    };
    let valid = format!("{ORIGIN}/p/l/20260101/a.png?sig=1");
    assert!(bind_presigned_put_url(
        &valid,
        &PresignTarget {
            expected_origin: String::new(),
            ..target.clone()
        }
    )
    .unwrap_err()
    .contains("origin is required"));
    for origin in [
        "https://user-bucket.oss-attacker.example",
        "https://user-bucket.oss-cn-beijing.aliyuncs.com",
    ] {
        assert!(
            bind_presigned_put_url(&format!("{origin}/p/l/20260101/a.png?sig=1"), &target)
                .unwrap_err()
                .contains("origin mismatch")
        );
    }
    assert_eq!(bind_presigned_put_url(&valid, &target).unwrap(), valid);
    for path in ["//p/l/20260101/a.png", "/%2Fp/l/20260101/a.png"] {
        assert!(
            bind_presigned_put_url(&format!("{ORIGIN}{path}?sig=1"), &target)
                .unwrap_err()
                .contains("object path mismatch")
        );
    }
}
#[tokio::test]
async fn aborted_presign_result_never_starts_object_put() {
    let flag = Arc::new(AtomicBool::new(false));
    let mut p = params();
    p.request.signal = Some(flag.clone());
    let calls = Arc::new(AtomicUsize::new(0));
    let handler: HttpHandler = Arc::new({
        let calls = calls.clone();
        move |call| {
            assert_eq!(call.method, "POST");
            calls.fetch_add(1, Ordering::SeqCst);
            flag.store(true, Ordering::SeqCst);
            Box::pin(async {
                Ok(reply(
                    200,
                    serde_json::to_vec(
                        &json!({"url":format!("{ORIGIN}/p/l/20260101/a.png?sig=1")}),
                    )
                    .unwrap(),
                ))
            })
        }
    });
    let out = HTTP_HANDLER
        .scope(handler, sls_put_via_presigned_http(p))
        .await;
    assert!(!out.ok);
    assert_eq!(out.retryable, Some(false));
    assert!(out.error.unwrap().contains("aborted"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[tokio::test(start_paused = true)]
async fn discovery_presigns_only_retries_transient_failure_and_accepts_internal_sls() {
    for (endpoint, retry) in [
        ("https://cn-hangzhou.log.aliyuncs.com", false),
        ("https://cn-hangzhou.log.aliyuncs.com", true),
        ("https://cn-hangzhou-internal.log.aliyuncs.com", false),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let handler: HttpHandler = Arc::new({
            let calls = calls.clone();
            move |call| {
                assert_eq!(call.method, "POST");
                assert!(call.url.ends_with("/logstores/l/presign"));
                assert_eq!(
                    serde_json::from_slice::<Value>(&call.body).unwrap(),
                    json!({"key":SLS_HTTP_STORAGE_PROBE_KEY,"method":"PUT"})
                );
                let n = calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if retry && n == 0 {
                        Err("The operation was aborted due to timeout".into())
                    } else {
                        Ok(reply(200,serde_json::to_vec(&json!({"url":format!("{ORIGIN}/p/l/_pilot/storage-probe?sig=secret")})).unwrap()))
                    }
                })
            }
        });
        let mut r = request();
        r.endpoint = endpoint.into();
        r.mode = Some("apiKey".into());
        r.api_key = Some("edge-key".into());
        let result = HTTP_HANDLER
            .scope(handler, sniff_sls_http_event_storage_base_path(r))
            .await
            .unwrap();
        assert_eq!(result, ("oss://user-bucket/p/l".into(), ORIGIN.into()));
        assert_eq!(calls.load(Ordering::SeqCst), if retry { 2 } else { 1 });
    }
    for hung in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let aborted = Arc::new(Mutex::new(Vec::new()));
        let handler: HttpHandler = Arc::new({
            let calls = calls.clone();
            let aborted = aborted.clone();
            move |call| {
                calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(call.method, "POST");
                aborted.lock().unwrap().push(call.aborted);
                if hung {
                    Box::pin(std::future::pending())
                } else {
                    Box::pin(async { Ok(reply(403, b"nope".to_vec())) })
                }
            }
        });
        let mut r = request();
        r.timeout_ms = Some(50);
        let error = HTTP_HANDLER
            .scope(handler, sniff_sls_http_event_storage_base_path(r))
            .await
            .unwrap_err();
        assert!(error
            .to_ascii_lowercase()
            .contains(if hung { "aborted" } else { "403" }));
        assert_eq!(calls.load(Ordering::SeqCst), if hung { 3 } else { 1 });
        if hung {
            assert!(aborted
                .lock()
                .unwrap()
                .iter()
                .all(|flag| flag.load(Ordering::SeqCst)));
        }
    }
}

#[tokio::test]
async fn delegated_chain_preserves_object_response_identity_and_never_forwards_api_key() {
    let mut p = params();
    p.request.mode = Some("apiKey".into());
    p.request.api_key = Some("edge-key".into());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let handler: HttpHandler = Arc::new({
        let seen = seen.clone();
        move |call| {
            seen.lock().unwrap().push((
                call.method.clone(),
                call.url.clone(),
                header(&call.headers, "Authorization").map(str::to_owned),
            ));
            if call.method == "POST" {
                assert!(call.url.ends_with("/logstores/l/presign"));
                assert_eq!(
                    header(&call.headers, "Authorization"),
                    Some("Bearer edge-key")
                );
                Box::pin(async {
                    Ok(reply(
                        200,
                        serde_json::to_vec(
                            &json!({"url":format!("{ORIGIN}/p/l/20260101/a.png?sig=1")}),
                        )
                        .unwrap(),
                    ))
                })
            } else {
                assert_eq!(call.method, "PUT");
                assert_eq!(call.url, format!("{ORIGIN}/p/l/20260101/a.png?sig=1"));
                assert_eq!(call.body, b"hello");
                assert_eq!(header(&call.headers, "Authorization"), None);
                Box::pin(async {
                    Ok(HttpReply {
                        status: 200,
                        headers: vec![("x-oss-request-id".into(), "oss-http".into())],
                        body: vec![],
                        error: None,
                    })
                })
            }
        }
    });
    let out = HTTP_HANDLER
        .scope(handler, sls_put_via_presigned_http(p))
        .await;
    assert!(out.ok);
    assert_eq!(out.request_id.as_deref(), Some("oss-http"));
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, "POST");
    assert_eq!(seen[0].2.as_deref(), Some("Bearer edge-key"));
    assert_eq!(seen[1].0, "PUT");
    assert!(seen[1].2.is_none());
}
