//! SLS-backed uploader. `sls` uses PutObject. `delegatedOss` presigns, then PUTs
//! the bytes with no extra auth headers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::types::{MultimodalCredentialAuth, MultimodalSlsTarget, MultimodalStorageAuth};
use crate::utils::create_logger;

use super::super::http::{log_meta, BoxFut};
use super::super::types::{StorageBaseResult, UploadItem, UploadOptions, Uploader};
use super::lru_set::{LruMap, MULTIMODAL_LRU_LIMIT};
use super::retry::{
    with_retries, AttemptError, RetryOutcome, DEFAULT_MULTIMODAL_RETRY,
    MULTIMODAL_UPLOAD_TIMEOUT_MS,
};
use super::sls_client::{
    self, sls_put_object, sls_put_via_presigned_http, sls_storage_auth_fields,
    sniff_sls_http_event_storage_base_path, PutObjectParams, SlsRequest, SlsResult,
    PRESIGN_ORIGIN_MISMATCH_ERROR,
};

const UPLOAD_FAILURE_WARN_INTERVAL_MS: i64 = 60_000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("SlsUploader")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
enum BackingAuth {
    Sls(MultimodalStorageAuth),
    Delegated(MultimodalCredentialAuth),
}

type WriteFn = Arc<dyn Fn(PutObjectParams, bool) -> BoxFut<SlsResult> + Send + Sync>;

pub struct SlsUploader {
    endpoint: String,
    project: String,
    logstore: String,
    auth: BackingAuth,
    expected_origin: Mutex<Option<String>>,
    success_keys: Mutex<LruMap<bool>>,
    failure_warn_at: Mutex<LruMap<i64>>,
    abort: super::super::types::AbortFlag,
    closed: AtomicBool,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    write_override: Mutex<Option<WriteFn>>,
}

impl SlsUploader {
    pub fn new(
        target: MultimodalSlsTarget,
        auth: BackingAuthInput,
        storage_base_path: &str,
        expected_presign_origin: Option<String>,
    ) -> Result<Self, String> {
        let parsed = sls_client::try_parse_sls_storage_base_path(storage_base_path);
        let project = if target.project.is_empty() {
            parsed.as_ref().map(|p| p.0.clone()).unwrap_or_default()
        } else {
            target.project
        };
        let logstore = if target.logstore.is_empty() {
            parsed.as_ref().map(|p| p.1.clone()).unwrap_or_default()
        } else {
            target.logstore
        };
        if project.is_empty() || logstore.is_empty() {
            return Err("multimodal.storage.target requires project and logstore".to_string());
        }
        let mut expected = None;
        if matches!(auth, BackingAuthInput::Delegated(_)) {
            if let Some(origin) = expected_presign_origin
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                expected = Some(origin);
            }
        }
        Ok(Self {
            endpoint: target.endpoint,
            project,
            logstore,
            auth: match auth {
                BackingAuthInput::Sls(auth) => BackingAuth::Sls(auth),
                BackingAuthInput::Delegated(auth) => BackingAuth::Delegated(auth),
            },
            expected_origin: Mutex::new(expected),
            success_keys: Mutex::new(LruMap::new(MULTIMODAL_LRU_LIMIT).expect("lru")),
            failure_warn_at: Mutex::new(LruMap::new(MULTIMODAL_LRU_LIMIT).expect("lru")),
            abort: super::super::types::new_abort_flag(),
            closed: AtomicBool::new(false),
            now_ms: Arc::new(now_ms),
            write_override: Mutex::new(None),
        })
    }

    pub fn set_expected_presign_origin(&self, origin: &str) -> Result<(), String> {
        let trimmed = origin.trim();
        if trimmed.is_empty() {
            return Err("delegatedOss requires expectedPresignOrigin".to_string());
        }
        let mut slot = self.expected_origin.lock().unwrap();
        if slot.as_deref().is_some_and(|current| current != trimmed) {
            self.success_keys.lock().unwrap().clear();
        }
        *slot = Some(trimmed.to_string());
        Ok(())
    }

    pub async fn discover_delegated_oss_bucket(&self) -> StorageBaseResult {
        if !matches!(self.auth, BackingAuth::Delegated(_)) {
            return StorageBaseResult::Err {
                error: "delegatedOss bucket discovery requires delegatedOss storage".into(),
            };
        }
        if self.closed.load(Ordering::SeqCst) || self.abort.load(Ordering::SeqCst) {
            return StorageBaseResult::Err {
                error: "uploader closed".into(),
            };
        }
        let mut request = self.auth_request();
        request.signal = Some(Arc::clone(&self.abort));
        match sniff_sls_http_event_storage_base_path(request).await {
            Ok((storage_base_path, origin)) => {
                let storage_base_path = storage_base_path.trim().trim_end_matches('/').to_string();
                if storage_base_path.is_empty() {
                    return StorageBaseResult::Err {
                        error: "multimodal storageBasePath is required".into(),
                    };
                }
                if let Err(error) = self.set_expected_presign_origin(&origin) {
                    return StorageBaseResult::Err { error };
                }
                StorageBaseResult::Ok { storage_base_path }
            }
            Err(error) => StorageBaseResult::Err { error },
        }
    }

    #[cfg(test)]
    pub fn set_write_override(&self, write: WriteFn) {
        *self.write_override.lock().unwrap() = Some(write);
    }

    fn auth_request(&self) -> SlsRequest {
        let mut request = match &self.auth {
            BackingAuth::Sls(auth) => sls_storage_auth_fields(auth),
            BackingAuth::Delegated(MultimodalCredentialAuth::Ak(auth)) => {
                sls_storage_auth_fields(&MultimodalStorageAuth::Ak(auth.clone()))
            }
            BackingAuth::Delegated(MultimodalCredentialAuth::ApiKey(auth)) => {
                sls_storage_auth_fields(&MultimodalStorageAuth::ApiKey(auth.clone()))
            }
        };
        request.endpoint = self.endpoint.clone();
        request.project = self.project.clone();
        request.logstore = self.logstore.clone();
        request
    }
}

#[derive(Clone, Debug)]
pub enum BackingAuthInput {
    Sls(MultimodalStorageAuth),
    Delegated(MultimodalCredentialAuth),
}

#[async_trait::async_trait]
impl Uploader for SlsUploader {
    async fn upload(&self, item: UploadItem, opts: UploadOptions) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            logger().warn("sls upload skipped: uploader closed", None);
            return false;
        }
        let Some(data) = item.data.clone() else {
            return false;
        };
        if data.len() != item.expected_size {
            logger().warn("sls upload skipped: invalid payload size", None);
            return false;
        }
        let object_key = item.target_path.clone();
        if opts.skip_if_exists.unwrap_or(true) && self.success_keys.lock().unwrap().has(&object_key)
        {
            return true;
        }
        let outcome = with_retries(
            DEFAULT_MULTIMODAL_RETRY,
            |_| {
                let closed =
                    self.closed.load(Ordering::SeqCst) || self.abort.load(Ordering::SeqCst);
                let delegated = matches!(self.auth, BackingAuth::Delegated(_));
                let origin = self.expected_origin.lock().unwrap().clone();
                let mut request = self.auth_request();
                request.signal = Some(Arc::clone(&self.abort));
                let params = PutObjectParams {
                    request,
                    object_key: object_key.clone(),
                    body: data.clone(),
                    content_type: item.content_type.clone(),
                    meta: item
                        .meta
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                    timeout_ms: MULTIMODAL_UPLOAD_TIMEOUT_MS,
                    expected_origin: origin.clone(),
                };
                let override_write = self.write_override.lock().unwrap().clone();
                async move {
                    if closed {
                        return Err(AttemptError {
                            retryable: false,
                            error: Some("uploader closed".into()),
                            status_code: None,
                            request_id: None,
                        });
                    }
                    let put = if delegated && origin.is_none() {
                        SlsResult {
                            ok: false,
                            status_code: None,
                            request_id: None,
                            error: Some("delegatedOss bucket is unknown".into()),
                            retryable: Some(false),
                            url: None,
                        }
                    } else if let Some(write) = override_write {
                        write(params, delegated).await
                    } else if delegated {
                        sls_put_via_presigned_http(params).await
                    } else {
                        sls_put_object(params).await
                    };
                    if put.ok {
                        Ok(put.request_id.unwrap_or_default())
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
                if error.as_deref() == Some(PRESIGN_ORIGIN_MISMATCH_ERROR) {
                    if let Some(callback) = &opts.on_storage_base_invalidated {
                        callback();
                    }
                }
                self.warn_failure(
                    status_code,
                    error.as_deref().unwrap_or(""),
                    &item,
                    request_id.as_deref(),
                );
                false
            }
            RetryOutcome::Ok(_) => {
                if self.closed.load(Ordering::SeqCst) {
                    return true;
                }
                self.success_keys.lock().unwrap().set(object_key, true);
                true
            }
        }
    }

    async fn shutdown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            logger().debug("sls uploader shutdown skipped (already closed)", None);
            return;
        }
        self.abort.store(true, Ordering::SeqCst);
        self.success_keys.lock().unwrap().clear();
    }
}

impl SlsUploader {
    fn warn_failure(
        &self,
        status_code: Option<u16>,
        error: &str,
        item: &UploadItem,
        request_id: Option<&str>,
    ) {
        let reason = if status_code.is_none() {
            error.chars().take(200).collect::<String>()
        } else {
            stable_failure_reason(error)
        };
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
            "sls upload failed",
            Some(&log_meta(&[
                ("statusCode", serde_json::json!(status_code)),
                ("error", serde_json::json!(error)),
                ("requestId", serde_json::json!(request_id)),
                ("size", serde_json::json!(item.expected_size)),
                ("targetPath", serde_json::json!(item.target_path)),
            ])),
        );
    }
}

fn stable_failure_reason(error: &str) -> String {
    if error.is_empty() {
        return String::new();
    }
    if let Some(index) = error.find('{') {
        if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&error[index..]) {
            let code = parsed
                .get("errorCode")
                .and_then(Value::as_str)
                .unwrap_or("");
            let message = parsed
                .get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !code.is_empty() || !message.is_empty() {
                return format!("{code}\0{message}");
            }
        }
    }
    let code = xml_tag(error, "Code");
    let message = xml_tag(error, "Message");
    if !code.is_empty() || !message.is_empty() {
        return format!("{code}\0{message}");
    }
    String::new()
}

fn xml_tag(xml: &str, tag: &str) -> String {
    let pattern = format!("<{tag}>");
    let Some(start) = xml.to_ascii_lowercase().find(&pattern.to_ascii_lowercase()) else {
        return String::new();
    };
    let rest = &xml[start + pattern.len()..];
    let end_tag = format!("</{tag}>");
    let Some(end) = rest
        .to_ascii_lowercase()
        .find(&end_tag.to_ascii_lowercase())
    else {
        return String::new();
    };
    rest[..end].trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_reason_ignores_request_id_noise() {
        let left = stable_failure_reason(
            "<Error><Code>AccessDenied</Code><Message>no</Message><RequestId>a</RequestId></Error>",
        );
        let right = stable_failure_reason(
            "<Error><Code>AccessDenied</Code><Message>no</Message><RequestId>b</RequestId></Error>",
        );
        assert_eq!(left, right);
        assert_eq!(left, "AccessDenied\0no");
    }
}

#[cfg(test)]
#[path = "sls_uploader_contract_tests.rs"]
mod migration_contract_tests;
