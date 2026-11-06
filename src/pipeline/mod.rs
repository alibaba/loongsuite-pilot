//! File and Qoder API collection pipelines.
//!
//! Port of `src/pipeline`. Directory `qoder-api` keeps the TypeScript name;
//! the Rust module is `qoder_api`. Wire this from `src/lib.rs` with
//! `pub mod pipeline` — that file was left unchanged on purpose.
//!
//! Webtracking and failed-log writes live in [`sls_transport`] because
//! `src/flushers` is not part of this port.

pub mod digest;
pub mod flusher;
pub mod input;
pub mod pipeline_manager;
pub mod sleep_detector;
pub mod sls_transport;
pub mod types;
pub mod workspace_policy;

pub use input::file::{
    parse_checkpoint_key_or_legacy, FilePipelineHandle, FileTailer, FileWatcher,
};
pub use input::qoder_api::{QoderApiClient, QoderApiInput, QoderApiPipeline};
pub use pipeline_manager::PipelineManager;
pub use sleep_detector::{SleepDetector, WakeEvent};
pub use types::{Pipeline, PipelineConfig, PipelineManagerOptions, PipelineToggle};
pub use workspace_policy::WorkspacePolicy;
