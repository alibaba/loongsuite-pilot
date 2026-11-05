//! Multimodal upload pipeline.
//!
//! Port of `src/multimodal`. JSON field names and error strings follow the
//! TypeScript sources. Wire this module from `src/lib.rs` with `pub mod multimodal`.

pub mod agent_gate;
pub mod digest;
pub mod http;
pub mod processor;
pub mod resolve;
pub mod rewrite;
pub mod types;
pub mod uploader;

pub use agent_gate::{
    any_agent_multimodal_enabled, is_agent_multimodal_enabled, is_multimodal_supported_agent,
};
pub use processor::{with_deadline, MultimodalProcessor};
pub use resolve::{
    as_record, match_all, resolve_image_path, take_unique_extracted_paths, time_unix_nano_to_millis,
};
pub use rewrite::attach_multimodal_metadata_for_entry;
pub use types::{
    PathToUriOptions, StorageBaseResult, UriPart, MAX_MULTIMODAL_PARTS, MAX_MULTIMODAL_PATH_CHARS,
};
pub use uploader::{create_delegated_oss_uploader, create_uploader};
