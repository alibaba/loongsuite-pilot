//! OSS uploader. Fail-open: a put error returns false and does not raise.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::{MultimodalAkAuth, MultimodalOssTarget};
use crate::utils::create_logger;

use super::super::http::log_meta;
use super::super::types::{UploadItem, UploadOptions, Uploader};
use super::lru_set::{LruMap, MULTIMODAL_LRU_LIMIT};
use super::oss_client::{
    oss_put_object, parse_oss_storage_base_path, OssPutObjectParams, OssPutObjectResult,
};
use super::retry::{
    with_retries, AttemptError, RetryOutcome, DEFAULT_MULTIMODAL_RETRY,
    MULTIMODAL_UPLOAD_TIMEOUT_MS,
};

const UPLOAD_FAILURE_WARN_INTERVAL_MS: i64 = 60_000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("OssUploader")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

type PutFn =
    Arc<dyn Fn(OssPutObjectParams) -> super::super::http::BoxFut<OssPutObjectResult> + Send + Sync>;

pub struct OssUploader {
    endpoint: String,
    auth: MultimodalAkAuth,
    bucket: String,
    prefix: String,
    success_keys: Mutex<LruMap<bool>>,
    failure_warn_at: Mutex<LruMap<i64>>,
    abort: super::super::types::AbortFlag,
    closed: AtomicBool,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    put_override: Mutex<Option<PutFn>>,
}

impl OssUploader {
    pub fn new(target: MultimodalOssTarget, auth: MultimodalAkAuth) -> Result<Self, String> {
        let (bucket, prefix) = parse_oss_storage_base_path(&target.storage_base_path)?;
        Ok(Self {
            endpoint: target.endpoint,
            auth,
            bucket,
            prefix,
            success_keys: Mutex::new(LruMap::new(MULTIMODAL_LRU_LIMIT).expect("lru")),
            failure_warn_at: Mutex::new(LruMap::new(MULTIMODAL_LRU_LIMIT).expect("lru")),
            abort: super::super::types::new_abort_flag(),
            closed: AtomicBool::new(false),
            now_ms: Arc::new(now_ms),
            put_override: Mutex::new(None),
        })
    }

    #[cfg(test)]
    pub fn set_put_override(&self, put: PutFn) {
        *self.put_override.lock().unwrap() = Some(put);
    }
}

#[async_trait::async_trait]
impl Uploader for OssUploader {
    async fn upload(&self, item: UploadItem, opts: UploadOptions) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            logger().warn("oss upload skipped: uploader closed", None);
            return false;
        }
        let Some(data) = item.data.clone() else {
            logger().warn(
                "oss upload skipped: invalid payload size",
                Some(&log_meta(&[
                    ("expectedSize", serde_json::json!(item.expected_size)),
                    ("actualSize", serde_json::Value::Null),
                ])),
            );
            return false;
        };
        if data.len() != item.expected_size {
            logger().warn(
                "oss upload skipped: invalid payload size",
                Some(&log_meta(&[
                    ("expectedSize", serde_json::json!(item.expected_size)),
                    ("actualSize", serde_json::json!(data.len())),
                ])),
            );
            return false;
        }
        let object_key = if self.prefix.is_empty() {
            item.target_path.clone()
        } else {
            format!("{}/{}", self.prefix, item.target_path)
        };
        let skip = opts.skip_if_exists.unwrap_or(true);
        if skip && self.success_keys.lock().unwrap().has(&object_key) {
            logger().debug("oss upload skipped (idempotent)", None);
            return true;
        }
        let outcome = with_retries(
            DEFAULT_MULTIMODAL_RETRY,
            |_| {
                let closed =
                    self.closed.load(Ordering::SeqCst) || self.abort.load(Ordering::SeqCst);
                let params = OssPutObjectParams {
                    endpoint: self.endpoint.clone(),
                    bucket: self.bucket.clone(),
                    object_key: object_key.clone(),
                    access_key_id: self.auth.access_key_id.clone(),
                    access_key_secret: self.auth.access_key_secret.clone(),
                    security_token: self.auth.security_token.clone(),
                    body: data.clone(),
                    content_type: item.content_type.clone(),
                    timeout_ms: MULTIMODAL_UPLOAD_TIMEOUT_MS,
                    meta: item
                        .meta
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                    signal: Some(Arc::clone(&self.abort)),
                };
                let override_put = self.put_override.lock().unwrap().clone();
                async move {
                    if closed {
                        return Err(AttemptError {
                            retryable: false,
                            error: Some("uploader closed".into()),
                            status_code: None,
                            request_id: None,
                        });
                    }
                    let put = if let Some(put) = override_put {
                        put(params).await
                    } else {
                        oss_put_object(params).await
                    };
                    if put.ok {
                        Ok(())
                    } else {
                        Err(AttemptError {
                            retryable: put.retryable.unwrap_or(true),
                            error: put.error,
                            status_code: put.status_code,
                            request_id: put.request_id,
                        })
                    }
                }
            },
            Some(Arc::clone(&self.abort)),
        )
        .await;
        match outcome {
            RetryOutcome::Err {
                error,
                status_code,
                request_id,
            } => {
                self.warn_upload_failure(
                    status_code,
                    error.as_deref().unwrap_or(""),
                    item.expected_size,
                    request_id.as_deref(),
                );
                false
            }
            RetryOutcome::Ok(()) => {
                if self.closed.load(Ordering::SeqCst) {
                    logger().debug("oss upload completed after close", None);
                    return true;
                }
                self.success_keys.lock().unwrap().set(object_key, true);
                true
            }
        }
    }

    async fn shutdown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            logger().debug("oss uploader shutdown skipped (already closed)", None);
            return;
        }
        self.abort.store(true, Ordering::SeqCst);
        self.success_keys.lock().unwrap().clear();
    }
}

impl OssUploader {
    fn warn_upload_failure(
        &self,
        status_code: Option<u16>,
        reason: &str,
        size: usize,
        request_id: Option<&str>,
    ) {
        let key = format!(
            "{}\0{reason}",
            status_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "none".into())
        );
        let now = (self.now_ms)();
        let mut map = self.failure_warn_at.lock().unwrap();
        let previous = map.get_copied(&key).unwrap_or(0);
        if now - previous < UPLOAD_FAILURE_WARN_INTERVAL_MS {
            return;
        }
        map.set(key, now);
        drop(map);
        logger().warn(
            "oss upload failed",
            Some(&log_meta(&[
                ("statusCode", serde_json::json!(status_code)),
                ("error", serde_json::json!(reason)),
                ("requestId", serde_json::json!(request_id)),
                ("size", serde_json::json!(size)),
            ])),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::multimodal::http::{HttpHandler, HttpReply, HTTP_HANDLER};
    use std::sync::atomic::{AtomicI64, AtomicUsize};
    use std::time::Duration;

    fn uploader() -> OssUploader {
        OssUploader::new(
            MultimodalOssTarget {
                endpoint: "https://oss-cn-shanghai.aliyuncs.com".into(),
                storage_base_path: "oss://bucket/mm".into(),
            },
            MultimodalAkAuth {
                access_key_id: "ak".into(),
                access_key_secret: "sk".into(),
                security_token: None,
            },
        )
        .unwrap()
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

    fn replies(status: u16, calls: Arc<AtomicUsize>) -> HttpHandler {
        Arc::new(move |call| {
            assert_eq!(call.method, "PUT");
            assert!(call
                .url
                .starts_with("https://bucket.oss-cn-shanghai.aliyuncs.com/mm/"));
            assert_eq!(call.body, b"ab");
            assert_eq!(
                crate::multimodal::http::header(&call.headers, "x-oss-meta-mime-type"),
                Some("image/png")
            );
            let request = calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(HttpReply {
                    status,
                    headers: vec![(
                        "x-oss-request-id".into(),
                        format!("oss-req-{status}-{request}"),
                    )],
                    body: Vec::new(),
                    error: None,
                })
            })
        })
    }

    #[tokio::test]
    async fn invalid_payload_size_or_missing_bytes_never_reaches_http() {
        let uploader = uploader();
        let no_http: HttpHandler = Arc::new(|_| panic!("invalid payload must not reach HTTP"));
        HTTP_HANDLER
            .scope(no_http, async {
                let mut mismatched = item("20260101/a.png");
                mismatched.expected_size = 1;
                assert!(!uploader.upload(mismatched, UploadOptions::default()).await);
                let mut absent = item("20260101/absent.png");
                absent.data = None;
                assert!(!uploader.upload(absent, UploadOptions::default()).await);
                assert!(uploader.success_keys.lock().unwrap().is_empty());
            })
            .await;
    }

    #[tokio::test]
    async fn successful_keys_deduplicate_and_shutdown_clears_cache_idempotently() {
        let uploader = uploader();
        let calls = Arc::new(AtomicUsize::new(0));
        HTTP_HANDLER
            .scope(replies(200, calls.clone()), async {
                assert!(
                    uploader
                        .upload(item("20260101/a.png"), UploadOptions::default())
                        .await
                );
                assert!(
                    uploader
                        .upload(item("20260101/a.png"), UploadOptions::default())
                        .await
                );
                assert_eq!(calls.load(Ordering::SeqCst), 1);
                assert_eq!(uploader.success_keys.lock().unwrap().len(), 1);
                uploader.shutdown().await;
                uploader.shutdown().await;
                assert!(uploader.success_keys.lock().unwrap().is_empty());
                assert!(
                    !uploader
                        .upload(item("20260101/a.png"), UploadOptions::default())
                        .await
                );
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            })
            .await;
    }

    #[tokio::test]
    async fn forbidden_response_fails_once_without_retry_or_success_cache() {
        let uploader = uploader();
        let calls = Arc::new(AtomicUsize::new(0));
        let success = HTTP_HANDLER
            .scope(
                replies(403, calls.clone()),
                uploader.upload(item("20260101/a.png"), UploadOptions::default()),
            )
            .await;
        assert!(!success);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(uploader.success_keys.lock().unwrap().is_empty());
    }

    #[test]
    fn constructor_rejects_invalid_storage_base_path() {
        let result = OssUploader::new(
            MultimodalOssTarget {
                endpoint: "https://oss-cn-shanghai.aliyuncs.com".into(),
                storage_base_path: "s3://bucket/mm".into(),
            },
            MultimodalAkAuth {
                access_key_id: "ak".into(),
                access_key_secret: "sk".into(),
                security_token: None,
            },
        );
        match result {
            Ok(_) => panic!("invalid storage base must fail construction"),
            Err(error) => assert!(error.contains("invalid oss storageBasePath")),
        }
    }

    fn failure_records(dir: &std::path::Path) -> Vec<serde_json::Value> {
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
            .filter(|record| record["msg"] == "oss upload failed")
            .collect()
    }

    #[tokio::test]
    async fn repeated_failure_warnings_keep_first_request_id_and_resume_after_one_minute() {
        if !crate::utils::isolated_env_test() {
            return;
        }
        std::env::set_var("LOG_LEVEL", "warn");
        std::env::set_var("LOONGSUITE_PILOT_STDOUT", "0");
        let logs = tempfile::tempdir().unwrap();
        crate::utils::init_file_logging(&logs.path().join("oss.log").to_string_lossy())
            .await
            .unwrap();
        let clock = Arc::new(AtomicI64::new(1_767_225_600_000));
        let mut uploader = uploader();
        uploader.now_ms = Arc::new({
            let clock = clock.clone();
            move || clock.load(Ordering::SeqCst)
        });
        let calls = Arc::new(AtomicUsize::new(0));
        HTTP_HANDLER
            .scope(replies(403, calls.clone()), async {
                for index in 0..5 {
                    assert!(
                        !uploader
                            .upload(
                                item(&format!("20260101/a{index}.png")),
                                UploadOptions::default()
                            )
                            .await
                    );
                }
                let records = failure_records(logs.path());
                assert_eq!(
                    records.len(),
                    1,
                    "changing request IDs must not defeat the warning rate limit"
                );
                assert_eq!(records[0]["requestId"], "oss-req-403-0");
                assert_eq!(records[0]["statusCode"], 403);
                assert_eq!(records[0]["error"], "oss putObject status 403");
                assert_eq!(records[0]["size"], 2);
                clock.fetch_add(61_000, Ordering::SeqCst);
                assert!(
                    !uploader
                        .upload(item("20260101/b.png"), UploadOptions::default())
                        .await
                );
                let records = failure_records(logs.path());
                assert_eq!(records.len(), 2);
                assert_eq!(records[1]["requestId"], "oss-req-403-5");
                assert_eq!(calls.load(Ordering::SeqCst), 6);
            })
            .await;
    }

    #[tokio::test]
    async fn completed_put_after_close_succeeds_without_repopulating_success_keys() {
        let uploader = uploader();
        let started = Arc::new(tokio::sync::Notify::new());
        let (release, pending) = tokio::sync::oneshot::channel();
        let pending = Arc::new(Mutex::new(Some(pending)));
        let calls = Arc::new(AtomicUsize::new(0));
        uploader.set_put_override(Arc::new({
            let started = started.clone();
            let calls = calls.clone();
            move |params| {
                assert_eq!(params.object_key, "mm/20260101/race.png");
                assert!(!params.signal.unwrap().load(Ordering::SeqCst));
                calls.fetch_add(1, Ordering::SeqCst);
                let pending = pending.lock().unwrap().take().expect("only one PUT");
                let started = started.clone();
                Box::pin(async move {
                    started.notify_one();
                    pending.await.unwrap();
                    OssPutObjectResult {
                        ok: true,
                        status_code: Some(200),
                        request_id: None,
                        error: None,
                        retryable: None,
                    }
                })
            }
        }));
        let (success, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(
                uploader.upload(item("20260101/race.png"), UploadOptions::default()),
                async {
                    started.notified().await;
                    uploader.shutdown().await;
                    release.send(()).unwrap();
                }
            )
        })
        .await
        .expect("controlled in-flight completion must finish");
        assert!(success);
        assert!(uploader.success_keys.lock().unwrap().is_empty());
        assert!(
            !uploader
                .upload(item("20260101/race.png"), UploadOptions::default())
                .await
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shutdown_cancels_real_client_put_and_rejects_later_uploads() {
        let uploader = uploader();
        let started = Arc::new(tokio::sync::Notify::new());
        let aborted = Arc::new(Mutex::new(None));
        let calls = Arc::new(AtomicUsize::new(0));
        let handler: HttpHandler = Arc::new({
            let started = started.clone();
            let aborted = aborted.clone();
            let calls = calls.clone();
            move |call| {
                *aborted.lock().unwrap() = Some(call.aborted);
                calls.fetch_add(1, Ordering::SeqCst);
                started.notify_one();
                Box::pin(std::future::pending())
            }
        });
        let (success, ()) = tokio::time::timeout(
            Duration::from_secs(1),
            HTTP_HANDLER.scope(handler, async {
                tokio::join!(
                    uploader.upload(item("20260101/hang.png"), UploadOptions::default()),
                    async {
                        started.notified().await;
                        uploader.shutdown().await;
                        assert!(uploader.abort.load(Ordering::SeqCst));
                    }
                )
            }),
        )
        .await
        .expect("shutdown must cancel a stalled real client request");
        assert!(!success);
        assert!(aborted
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .load(Ordering::SeqCst));
        assert!(uploader.success_keys.lock().unwrap().is_empty());
        assert!(
            !uploader
                .upload(item("20260101/later.png"), UploadOptions::default())
                .await
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
