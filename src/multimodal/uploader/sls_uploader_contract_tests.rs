use super::*;
use crate::multimodal::http::{header, HttpHandler, HttpReply, HTTP_HANDLER};
use crate::types::{MultimodalAkAuth, MultimodalApiKeyAuth};
use std::sync::atomic::{AtomicI64, AtomicUsize};
use std::time::Duration;

const ORIGIN: &str = "https://user-bucket.oss-cn-hangzhou.aliyuncs.com";
fn ak() -> MultimodalAkAuth {
    MultimodalAkAuth {
        access_key_id: "synthetic-ak".into(),
        access_key_secret: "synthetic-sk".into(),
        security_token: None,
    }
}
fn target() -> MultimodalSlsTarget {
    MultimodalSlsTarget {
        endpoint: "https://cn-hangzhou.log.aliyuncs.com".into(),
        project: "proj".into(),
        logstore: "logstore".into(),
    }
}
fn uploader(auth: BackingAuthInput) -> SlsUploader {
    SlsUploader::new(target(), auth, "sls://proj/logstore", Some(ORIGIN.into())).unwrap()
}
fn ordinary() -> SlsUploader {
    uploader(BackingAuthInput::Sls(MultimodalStorageAuth::Ak(ak())))
}
fn item(path: &str) -> UploadItem {
    UploadItem {
        target_path: path.into(),
        content_type: "image/png".into(),
        meta: [("mime_type".into(), "image/png".into())].into(),
        data: Some(b"ab".to_vec()),
        source_uri: None,
        expected_size: 2,
    }
}
fn result(ok: bool, status: Option<u16>, error: &str, request_id: &str) -> SlsResult {
    SlsResult {
        ok,
        status_code: status,
        request_id: Some(request_id.into()),
        error: (!ok).then(|| error.into()),
        retryable: Some(false),
        url: None,
    }
}
fn reply(status: u16, body: Vec<u8>) -> HttpReply {
    HttpReply {
        status,
        body,
        headers: vec![],
        error: None,
    }
}
fn records(dir: &std::path::Path) -> Vec<serde_json::Value> {
    crate::utils::flush_logs_sync();
    std::fs::read_dir(dir)
        .unwrap()
        .flat_map(|entry| {
            std::fs::read_to_string(entry.unwrap().path())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
                .collect::<Vec<_>>()
        })
        .filter(|entry| entry["msg"] == "sls upload failed")
        .collect()
}
#[tokio::test]
async fn invalid_payload_and_unknown_delegated_origin_never_start_a_write() {
    let plain = ordinary();
    let calls = Arc::new(AtomicUsize::new(0));
    let writer: WriteFn = Arc::new({
        let calls = calls.clone();
        move |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { result(true, Some(200), "", "ok") })
        }
    });
    plain.set_write_override(writer.clone());
    let mut absent = item("missing");
    absent.data = None;
    let mut mismatch = item("mismatch");
    mismatch.expected_size = 9;
    assert!(!plain.upload(absent, UploadOptions::default()).await);
    assert!(!plain.upload(mismatch, UploadOptions::default()).await);
    let delegated = SlsUploader::new(
        target(),
        BackingAuthInput::Delegated(MultimodalCredentialAuth::Ak(ak())),
        "sls://proj/logstore",
        None,
    )
    .unwrap();
    delegated.set_write_override(writer);
    assert!(
        !delegated
            .upload(item("unknown"), UploadOptions::default())
            .await
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    delegated.set_expected_presign_origin(ORIGIN).unwrap();
    assert!(
        delegated
            .upload(item("known"), UploadOptions::default())
            .await
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[test]
fn unresolved_project_and_logstore_are_rejected_before_construction() {
    let mut target = target();
    target.project.clear();
    target.logstore.clear();
    let error = SlsUploader::new(
        target,
        BackingAuthInput::Sls(MultimodalStorageAuth::Ak(ak())),
        "sls://only-project",
        None,
    )
    .err()
    .expect("incomplete target must fail");
    assert!(error.contains("requires project and logstore"));
}
#[tokio::test]
async fn success_deduplicates_but_explicit_overwrite_and_after_close_never_reuse_progress() {
    let uploader = ordinary();
    let calls = Arc::new(AtomicUsize::new(0));
    uploader.set_write_override(Arc::new({
        let calls = calls.clone();
        move |p, delegated| {
            assert!(!delegated);
            assert_eq!(p.object_key, "20260101/a.png");
            assert_eq!(p.body, b"ab");
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { result(true, Some(200), "", "ok") })
        }
    }));
    for _ in 0..2 {
        assert!(
            uploader
                .upload(item("20260101/a.png"), UploadOptions::default())
                .await
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(uploader.success_keys.lock().unwrap().len(), 1);
    assert!(
        uploader
            .upload(
                item("20260101/a.png"),
                UploadOptions {
                    skip_if_exists: Some(false),
                    ..Default::default()
                }
            )
            .await
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    uploader.shutdown().await;
    uploader.shutdown().await;
    assert!(uploader.success_keys.lock().unwrap().is_empty());
    assert!(
        !uploader
            .upload(item("20260101/a.png"), UploadOptions::default())
            .await
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn a_forbidden_object_does_not_poison_the_next_object() {
    let uploader = ordinary();
    let calls = Arc::new(AtomicUsize::new(0));
    uploader.set_write_override(Arc::new({
        let calls = calls.clone();
        move |_, _| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                result(
                    call != 0,
                    Some(if call == 0 { 403 } else { 200 }),
                    "forbidden",
                    "r",
                )
            })
        }
    }));
    assert!(!uploader.upload(item("a"), UploadOptions::default()).await);
    assert!(uploader.success_keys.lock().unwrap().is_empty());
    assert!(uploader.upload(item("b"), UploadOptions::default()).await);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn anonymous_and_api_key_puts_use_real_client_without_cross_mode_credentials() {
    for anonymous in [false, true] {
        let auth = if anonymous {
            MultimodalStorageAuth::Anonymous
        } else {
            MultimodalStorageAuth::ApiKey(MultimodalApiKeyAuth {
                api_key: "synthetic-edge-key".into(),
            })
        };
        let uploader = uploader(BackingAuthInput::Sls(auth));
        let calls = Arc::new(AtomicUsize::new(0));
        let handler: HttpHandler = Arc::new({
            let calls = calls.clone();
            move |call| {
                assert_eq!(call.method, "PUT");
                assert!(call.url.ends_with("/objects/20260101/a.png"));
                assert_eq!(call.body, b"ab");
                assert_eq!(
                    header(&call.headers, "Authorization"),
                    if anonymous {
                        None
                    } else {
                        Some("Bearer synthetic-edge-key")
                    }
                );
                for name in [
                    "x-log-signaturemethod",
                    "x-log-security-token",
                    "Content-MD5",
                ] {
                    assert_eq!(header(&call.headers, name), None);
                }
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(reply(200, Vec::new())) })
            }
        });
        assert!(
            HTTP_HANDLER
                .scope(
                    handler,
                    uploader.upload(item("20260101/a.png"), UploadOptions::default())
                )
                .await
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn delegated_api_key_and_ak_presign_then_put_without_forwarding_authorization() {
    for api_key in [false, true] {
        let auth = if api_key {
            MultimodalCredentialAuth::ApiKey(MultimodalApiKeyAuth {
                api_key: "synthetic-edge-key".into(),
            })
        } else {
            MultimodalCredentialAuth::Ak(ak())
        };
        let uploader = uploader(BackingAuthInput::Delegated(auth));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let handler: HttpHandler = Arc::new({
            let calls = calls.clone();
            move |call| {
                calls.lock().unwrap().push(call.method.clone());
                if call.method == "POST" {
                    assert!(call.url.ends_with("/presign"));
                    let auth = header(&call.headers, "Authorization").unwrap();
                    if api_key {
                        assert_eq!(auth, "Bearer synthetic-edge-key");
                    } else {
                        assert!(auth.starts_with("LOG synthetic-ak:"));
                    }
                    let body: Value = serde_json::from_slice(&call.body).unwrap();
                    assert_eq!(body["method"], "PUT");
                    Box::pin(async {
                        Ok(reply(200,serde_json::to_vec(&serde_json::json!({"url":format!("{ORIGIN}/proj/logstore/20260101/a.png?sig=1")})).unwrap()))
                    })
                } else {
                    assert_eq!(call.method, "PUT");
                    assert!(call.url.starts_with(ORIGIN));
                    assert_eq!(call.body, b"ab");
                    assert_eq!(header(&call.headers, "Authorization"), None);
                    assert_eq!(header(&call.headers, "x-log-security-token"), None);
                    Box::pin(async { Ok(reply(200, Vec::new())) })
                }
            }
        });
        assert!(
            HTTP_HANDLER
                .scope(
                    handler,
                    uploader.upload(item("20260101/a.png"), UploadOptions::default())
                )
                .await
        );
        assert_eq!(*calls.lock().unwrap(), vec!["POST", "PUT"]);
    }
}
#[tokio::test]
async fn accepted_write_finishes_after_shutdown_without_repopulating_success_cache() {
    let uploader = ordinary();
    let entered = Arc::new(tokio::sync::Notify::new());
    let (release, gate) = tokio::sync::oneshot::channel();
    let gate = Arc::new(Mutex::new(Some(gate)));
    let calls = Arc::new(AtomicUsize::new(0));
    uploader.set_write_override(Arc::new({
        let entered = entered.clone();
        let calls = calls.clone();
        move |_, _| {
            let gate = gate.lock().unwrap().take().unwrap();
            let entered = entered.clone();
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                entered.notify_one();
                gate.await.unwrap();
                result(true, Some(200), "", "late")
            })
        }
    }));
    let (ok, ()) = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(
            uploader.upload(item("race"), UploadOptions::default()),
            async {
                entered.notified().await;
                uploader.shutdown().await;
                release.send(()).unwrap();
            }
        )
    })
    .await
    .unwrap();
    assert!(ok);
    assert!(uploader.success_keys.lock().unwrap().is_empty());
    assert!(
        !uploader
            .upload(item("race"), UploadOptions::default())
            .await
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn shutdown_during_real_presign_cancels_request_and_never_starts_second_stage_put() {
    let uploader = uploader(BackingAuthInput::Delegated(MultimodalCredentialAuth::Ak(
        ak(),
    )));
    let entered = Arc::new(tokio::sync::Notify::new());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let aborted = Arc::new(Mutex::new(None));
    let handler: HttpHandler = Arc::new({
        let entered = entered.clone();
        let calls = calls.clone();
        let aborted = aborted.clone();
        move |call| {
            calls.lock().unwrap().push(call.method);
            assert!(call.url.ends_with("/presign"));
            *aborted.lock().unwrap() = Some(call.aborted);
            entered.notify_one();
            Box::pin(std::future::pending())
        }
    });
    let (ok, ()) = tokio::time::timeout(
        Duration::from_secs(1),
        HTTP_HANDLER.scope(handler, async {
            tokio::join!(
                uploader.upload(item("20260101/a.png"), UploadOptions::default()),
                async {
                    entered.notified().await;
                    uploader.shutdown().await;
                }
            )
        }),
    )
    .await
    .unwrap();
    assert!(!ok);
    assert_eq!(*calls.lock().unwrap(), vec!["POST"]);
    assert!(aborted
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .load(Ordering::SeqCst));
    assert!(uploader.success_keys.lock().unwrap().is_empty());
}
#[tokio::test]
async fn failure_logs_keep_request_identity_rate_limit_and_distinguish_json_xml_and_local_reasons()
{
    if !crate::utils::isolated_env_test() {
        return;
    }
    std::env::set_var("LOG_LEVEL", "warn");
    std::env::set_var("LOONGSUITE_PILOT_STDOUT", "0");
    let logs = tempfile::tempdir().unwrap();
    crate::utils::init_file_logging(&logs.path().join("sls.log").to_string_lossy())
        .await
        .unwrap();
    let clock = Arc::new(AtomicI64::new(1_767_225_600_000));
    let mut uploader = ordinary();
    uploader.now_ms = Arc::new({
        let clock = clock.clone();
        move || clock.load(Ordering::SeqCst)
    });
    let calls = Arc::new(AtomicUsize::new(0));
    uploader.set_write_override(Arc::new({
        let calls = calls.clone();
        move |_, _| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(
                async move { result(false, Some(403), "forbidden", &format!("req-403-{call}")) },
            )
        }
    }));
    for n in 0..5 {
        assert!(
            !uploader
                .upload(item(&format!("a{n}")), UploadOptions::default())
                .await
        );
    }
    let rows = records(logs.path());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["requestId"], "req-403-0");
    assert_eq!(rows[0]["size"], 2);
    clock.fetch_add(59_999, Ordering::SeqCst);
    assert!(
        !uploader
            .upload(item("before-minute"), UploadOptions::default())
            .await
    );
    assert_eq!(records(logs.path()).len(), 1);
    clock.fetch_add(1, Ordering::SeqCst);
    assert!(
        !uploader
            .upload(item("at-minute"), UploadOptions::default())
            .await
    );
    assert_eq!(records(logs.path()).len(), 2);
    assert_eq!(records(logs.path())[1]["requestId"], "req-403-6");

    let errors=vec![
        (Some(403),r#"403 {"errorCode":"Unauthorized","errorMessage":"anonymous writes disabled","requestId":"r1"}"#.to_string()),
        (Some(403),r#"403 {"errorCode":"Unauthorized","errorMessage":"anonymous writes disabled","requestId":"r2"}"#.to_string()),
        (Some(403),r#"403 {"errorCode":"SignatureDoesNotMatch","errorMessage":"signature mismatch","requestId":"r3"}"#.to_string()),
        (None,"fetch failed".into()),
        (None,PRESIGN_ORIGIN_MISMATCH_ERROR.into()),
    ];
    let errors = Arc::new(Mutex::new(errors.into_iter()));
    uploader.set_write_override(Arc::new(move |_, _| {
        let (status, error) = errors.lock().unwrap().next().unwrap();
        Box::pin(async move { result(false, status, &error, "different") })
    }));
    let invalidated = Arc::new(AtomicUsize::new(0));
    for n in 0..5 {
        assert!(
            !uploader
                .upload(
                    item(&format!("reason{n}")),
                    UploadOptions {
                        on_storage_base_invalidated: Some(Arc::new({
                            let invalidated = invalidated.clone();
                            move || {
                                invalidated.fetch_add(1, Ordering::SeqCst);
                            }
                        })),
                        ..Default::default()
                    }
                )
                .await
        );
    }
    let rows = records(logs.path());
    assert_eq!(rows.len(), 6);
    assert!(rows[3]["error"]
        .as_str()
        .unwrap()
        .contains("signature mismatch"));
    assert_eq!(rows[4]["error"], "fetch failed");
    assert_eq!(rows[5]["error"], PRESIGN_ORIGIN_MISMATCH_ERROR);
    assert_eq!(invalidated.load(Ordering::SeqCst), 1);
    let xml_calls = Arc::new(AtomicUsize::new(0));
    uploader.set_write_override(Arc::new({let xml_calls=xml_calls.clone();move |_,_|{
        let n=xml_calls.fetch_add(1,Ordering::SeqCst);
        Box::pin(async move {result(false,Some(403),&format!("403 <Error><Code>AccessDenied</Code><Message>not your bucket</Message><RequestId>req-{n}</RequestId></Error>"),"xml")})
    }}));
    for n in 0..50 {
        assert!(
            !uploader
                .upload(item(&format!("xml{n}")), UploadOptions::default())
                .await
        );
    }
    assert_eq!(records(logs.path()).len(), 7);
    uploader.set_write_override(Arc::new(|_,_|Box::pin(async {result(false,Some(403),"403 <Error><Code>InvalidObjectState</Code><Message>frozen</Message><RequestId>other</RequestId></Error>","other")})));
    assert!(
        !uploader
            .upload(item("frozen"), UploadOptions::default())
            .await
    );
    let rows = records(logs.path());
    assert_eq!(rows.len(), 8);
    assert!(rows[7]["error"].as_str().unwrap().contains("frozen"));
    assert_eq!(xml_calls.load(Ordering::SeqCst), 50);
}
