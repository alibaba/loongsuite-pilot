//! Multimodal upload helpers.

pub mod factory;
pub mod lru_set;
pub mod oss_client;
pub mod oss_uploader;
pub mod retry;
pub mod sls_client;
pub mod sls_uploader;

pub use factory::{create_delegated_oss_uploader, create_uploader, DelegatedOssRuntime};
pub use lru_set::{LruMap, MULTIMODAL_LRU_LIMIT};
pub use oss_client::{build_v4_put_request, oss_put_object, parse_oss_storage_base_path};
pub use oss_uploader::OssUploader;
pub use retry::{retry_delay_ms, sleep_ms, with_retries, RetryPolicy, DEFAULT_MULTIMODAL_RETRY};
pub use sls_client::{
    bind_presigned_put_url, build_anonymous_put_request, build_bearer_json_request,
    build_log_v1_json_request, format_rfc822_gmt, normalize_sls_endpoint,
    sls_generate_presigned_url, sls_project_host, sls_put_object, sls_put_presigned_object,
    sls_put_via_presigned_http, sls_storage_auth_fields, sniff_sls_http_event_storage_base_path,
    try_parse_sls_storage_base_path, PRESIGN_ORIGIN_MISMATCH_ERROR, SLS_HTTP_STORAGE_PROBE_KEY,
};
pub use sls_uploader::SlsUploader;
