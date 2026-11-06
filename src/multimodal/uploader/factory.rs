//! Build the uploader for the configured storage.

use std::sync::Arc;

use crate::types::{
    MultimodalCredentialAuth, MultimodalRuntimeConfig, MultimodalSlsTarget, MultimodalStorage,
};

use super::super::types::{StorageBaseResult, Uploader};
use super::oss_uploader::OssUploader;
use super::sls_uploader::{BackingAuthInput, SlsUploader};

pub fn create_uploader(
    config: &MultimodalRuntimeConfig,
    expected_presign_origin: Option<String>,
) -> Result<Arc<dyn Uploader>, String> {
    match &config.storage {
        MultimodalStorage::Oss { target, auth } => {
            let uploader = OssUploader::new(target.clone(), auth.clone())?;
            Ok(Arc::new(uploader))
        }
        MultimodalStorage::Sls { target, auth } => {
            let uploader = SlsUploader::new(
                target.clone(),
                BackingAuthInput::Sls(auth.clone()),
                &config.storage_base_path,
                None,
            )?;
            Ok(Arc::new(uploader))
        }
        MultimodalStorage::DelegatedOss { target, auth } => {
            let uploader = SlsUploader::new(
                target.clone(),
                BackingAuthInput::Delegated(auth.clone()),
                &config.storage_base_path,
                expected_presign_origin,
            )?;
            Ok(Arc::new(uploader))
        }
    }
}

pub struct DelegatedOssRuntime {
    pub uploader: Arc<SlsUploader>,
}

impl DelegatedOssRuntime {
    pub async fn resolve_storage_base(&self) -> StorageBaseResult {
        self.uploader.discover_delegated_oss_bucket().await
    }
}

pub fn create_delegated_oss_uploader(
    target: MultimodalSlsTarget,
    auth: MultimodalCredentialAuth,
    storage_base_path: &str,
) -> Result<DelegatedOssRuntime, String> {
    let uploader = SlsUploader::new(
        target,
        BackingAuthInput::Delegated(auth),
        storage_base_path,
        None,
    )?;
    Ok(DelegatedOssRuntime {
        uploader: Arc::new(uploader),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::multimodal::{
        http::{header, HttpCall, HttpHandler, HttpReply, HTTP_HANDLER},
        types::{UploadItem, UploadOptions},
    };
    use serde_json::{json, Value};
    use std::{collections::HashMap, sync::Mutex};

    const ORIGIN: &str = "https://user-bucket.oss-cn-hangzhou.aliyuncs.com";

    fn config(kind: &str, api_key: bool) -> MultimodalRuntimeConfig {
        let target = if kind == "oss" {
            json!({"endpoint":"https://oss-cn-shanghai.aliyuncs.com","storageBasePath":"oss://bucket/mm"})
        } else {
            json!({"endpoint":"https://cn-hangzhou.log.aliyuncs.com","project":"proj","logstore":"logstore"})
        };
        serde_json::from_value(json!({
            "storage":{"type":kind,"target":target,"auth":if api_key {
                json!({"mode":"apiKey","apiKey":"edge-key"})
            } else { json!({"mode":"ak","accessKeyId":"ak","accessKeySecret":"sk"}) }},
            "storageBasePath":if kind=="oss" {"oss://bucket/mm"} else {"sls://proj/logstore"}
        }))
        .unwrap()
    }

    fn item() -> UploadItem {
        UploadItem {
            target_path: "file.png".into(),
            content_type: "image/png".into(),
            meta: HashMap::new(),
            data: Some(b"image".to_vec()),
            source_uri: None,
            expected_size: 5,
        }
    }

    fn wire(calls: Arc<Mutex<Vec<HttpCall>>>) -> HttpHandler {
        Arc::new(move |call| {
            calls.lock().unwrap().push(call.clone());
            Box::pin(async move {
                let body = if call.url.ends_with("/presign") {
                    let input: Value = serde_json::from_slice(&call.body).unwrap();
                    assert_eq!(call.method, "POST");
                    assert_eq!(input["method"], "PUT");
                    json!({"url":format!("{ORIGIN}/proj/logstore/{}?signature=fixture",input["key"].as_str().unwrap())})
                } else {
                    json!({})
                };
                Ok(HttpReply {
                    status: 200,
                    headers: vec![],
                    body: serde_json::to_vec(&body).unwrap(),
                    error: None,
                })
            })
        })
    }

    #[tokio::test]
    async fn factory_selects_real_upload_routes_auth_and_cold_delegated_lifecycle() {
        for (kind, api_key, origin) in [
            ("oss", false, None),
            ("sls", false, None),
            ("sls", true, None),
            ("delegatedOss", false, Some(ORIGIN)),
            ("delegatedOss", false, None),
        ] {
            let calls = Arc::new(Mutex::new(Vec::new()));
            HTTP_HANDLER
                .scope(wire(calls.clone()), async {
                    let uploader =
                        create_uploader(&config(kind, api_key), origin.map(str::to_string))
                            .unwrap();
                    let uploaded = uploader.upload(item(), UploadOptions::default()).await;
                    let cold = kind == "delegatedOss" && origin.is_none();
                    assert_eq!(
                        uploaded, !cold,
                        "{kind} api_key={api_key} origin={origin:?}"
                    );
                    let requests = calls.lock().unwrap().clone();
                    if cold {
                        assert!(
                            requests.is_empty(),
                            "unknown delegated origin must not send object data"
                        );
                    } else if kind == "oss" {
                        assert_eq!(requests.len(), 1);
                        assert_eq!(requests[0].method, "PUT");
                        assert_eq!(
                            requests[0].url,
                            "https://bucket.oss-cn-shanghai.aliyuncs.com/mm/file.png"
                        );
                        assert!(header(&requests[0].headers, "Authorization")
                            .unwrap()
                            .starts_with("OSS4-HMAC-SHA256 "));
                        assert_eq!(requests[0].body, b"image");
                    } else {
                        let first = &requests[0];
                        assert!(first.url.starts_with(
                            "https://proj.cn-hangzhou.log.aliyuncs.com/logstores/logstore/"
                        ));
                        let auth = header(&first.headers, "Authorization").unwrap();
                        if api_key {
                            assert_eq!(auth, "Bearer edge-key");
                        } else {
                            assert!(auth.starts_with("LOG ak:"));
                        }
                        if kind == "delegatedOss" {
                            assert_eq!(requests.len(), 2);
                            assert!(first.url.ends_with("/presign"));
                            assert_eq!(requests[1].method, "PUT");
                            assert_eq!(
                                requests[1].url,
                                format!("{ORIGIN}/proj/logstore/file.png?signature=fixture")
                            );
                            assert!(
                                requests[1].headers.is_empty(),
                                "presigned PUT must not forward SLS credentials"
                            );
                            assert_eq!(requests[1].body, b"image");
                        } else {
                            assert_eq!(requests.len(), 1);
                            assert_eq!(first.method, "PUT");
                            assert!(first.url.ends_with("/objects/file.png"));
                            assert_eq!(first.body, b"image");
                        }
                    }
                    uploader.shutdown().await;
                    let before = calls.lock().unwrap().len();
                    assert!(!uploader.upload(item(), UploadOptions::default()).await);
                    assert_eq!(calls.lock().unwrap().len(), before);
                })
                .await;
        }
    }

    #[tokio::test]
    async fn delegated_factory_discovers_storage_and_uses_that_origin_for_upload() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        HTTP_HANDLER
            .scope(wire(calls.clone()), async {
                let config = config("delegatedOss", false);
                let MultimodalStorage::DelegatedOss { target, auth } = config.storage else {
                    unreachable!()
                };
                let runtime =
                    create_delegated_oss_uploader(target, auth, &config.storage_base_path).unwrap();
                assert_eq!(
                    runtime.resolve_storage_base().await,
                    StorageBaseResult::Ok {
                        storage_base_path: "oss://user-bucket/proj/logstore".into()
                    }
                );
                assert!(
                    runtime
                        .uploader
                        .upload(item(), UploadOptions::default())
                        .await
                );
                assert_eq!(calls.lock().unwrap().len(), 3);
                runtime.uploader.shutdown().await;
                assert!(matches!(
                    runtime.resolve_storage_base().await,
                    StorageBaseResult::Err { .. }
                ));
                assert_eq!(calls.lock().unwrap().len(), 3);
            })
            .await;
    }

    #[test]
    fn factory_rejects_invalid_oss_base_and_unresolved_sls_destination() {
        let mut oss = config("oss", false);
        let MultimodalStorage::Oss { target, .. } = &mut oss.storage else {
            unreachable!()
        };
        target.storage_base_path = "not-oss://bucket".into();
        oss.storage_base_path = "not-oss://bucket".into();
        assert!(create_uploader(&oss, None)
            .err()
            .unwrap()
            .contains("invalid oss storageBasePath"));
        let mut sls = config("sls", false);
        let MultimodalStorage::Sls { target, .. } = &mut sls.storage else {
            unreachable!()
        };
        target.project.clear();
        target.logstore.clear();
        sls.storage_base_path = "sls://only-project".into();
        assert!(create_uploader(&sls, None)
            .err()
            .unwrap()
            .contains("requires project and logstore"));
    }
}
