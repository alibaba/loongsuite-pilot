//! Multimodal types. Storage and auth structs live in [`crate::types`] and keep
//! the JSON names from `src/types`.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub use crate::types::{
    AgentConfig, AgentsConfig, MultimodalAkAuth, MultimodalApiKeyAuth, MultimodalCredentialAuth,
    MultimodalRuntimeConfig, MultimodalSlsAuthMode, MultimodalSlsTarget, MultimodalStorage,
    MultimodalStorageAuth, MultimodalStorageType, MultimodalUploadMode,
};

pub const MAX_MULTIMODAL_PARTS: usize = 10;
pub const MAX_MULTIMODAL_PATH_CHARS: usize = 1024;
pub const MAX_MULTIMODAL_DATA_SIZE: usize = 30 * 1024 * 1024;
pub const MAX_MULTIMODAL_PENDING_UPLOADS: usize = 1024;
pub const MAX_MULTIMODAL_PENDING_BYTES: usize = 1024 * 1024 * 1024;
pub const MAX_MULTIMODAL_PATH_INFLIGHT: usize = 1024;
pub const MAX_MULTIMODAL_BASE64_CHARS: usize = (MAX_MULTIMODAL_DATA_SIZE * 4).div_ceil(3) + 16;
pub const MULTIMODAL_SHUTDOWN_TIMEOUT_MS: u64 = 1_500;
pub const PATH_TO_URI_DEADLINE_MS: u64 = 3_000;
pub const INPUT_MULTIMODAL_METADATA_FIELD: &str = "gen_ai.input.multimodal_metadata";
pub const INPUT_MULTIMODAL_METADATA_DELTA_FIELD: &str = "gen_ai.input.multimodal_metadata_delta";
pub const OUTPUT_MULTIMODAL_METADATA_FIELD: &str = "gen_ai.output.multimodal_metadata";

#[derive(Clone, Debug)]
pub struct UploadItem {
    pub target_path: String,
    pub content_type: String,
    pub meta: HashMap<String, String>,
    pub data: Option<Vec<u8>>,
    pub source_uri: Option<String>,
    pub expected_size: usize,
}

#[derive(Clone, Default)]
pub struct UploadOptions {
    pub skip_if_exists: Option<bool>,
    pub on_storage_base_invalidated: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageBaseResult {
    Ok { storage_base_path: String },
    Err { error: String },
}

#[async_trait::async_trait]
pub trait Uploader: Send + Sync {
    async fn upload(&self, item: UploadItem, opts: UploadOptions) -> bool;
    async fn shutdown(&self);
}

#[derive(Clone, Debug, Default)]
pub struct UriConvertMeta {
    pub mime_type: Option<String>,
    pub modality: Option<String>,
    pub time_unix_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UriResult {
    pub uri: String,
    pub mime_type: String,
    pub modality: Option<String>,
    pub size: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UriPart {
    pub uri: String,
    pub mime_type: Option<String>,
    pub modality: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MultimodalMetadataItem {
    pub uri: String,
    pub mime_type: String,
    pub modality: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BlobToUriParams {
    pub content: String,
    pub mime_type: Option<String>,
    pub modality: Option<String>,
    pub time_unix_ms: Option<f64>,
    pub reuse_key: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BlobPart {
    pub mime_type: Option<String>,
    pub modality: Option<String>,
    pub content: String,
}

#[derive(Clone, Debug, Default)]
pub struct PathToUriOptions {
    pub allowed_root_paths: Option<Vec<String>>,
    pub deadline_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct PathBytes {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub size: usize,
}

/// Shared abort flag. `store(true)` matches `AbortController.abort()`.
pub type AbortFlag = Arc<AtomicBool>;

pub fn new_abort_flag() -> AbortFlag {
    Arc::new(AtomicBool::new(false))
}
