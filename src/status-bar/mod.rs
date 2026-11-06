//! Menu bar runtime, metrics summary, and JSONL tail scanning.
//!
//! Wire this directory from the crate root with
//! `#[path = "status-bar/mod.rs"] pub mod status_bar;`
//! so the hyphenated folder name stays the TypeScript path.

mod jsonl_tail_reader;
mod metrics_summary_writer;
mod runtime_writer;
mod status_bar_app_manager;

pub use jsonl_tail_reader::{scan_jsonl_tail, JsonlTailScanResult, DEFAULT_CHUNK_SIZE_BYTES};
pub use metrics_summary_writer::{
    AgentShareEntry, DailyPoint, MetricsSummary, MetricsSummaryRangeData, MetricsSummaryWriter,
    ModelShareEntry, ProviderShareEntry, RepoShareEntry,
};
pub use runtime_writer::{RuntimeRecord, RuntimeWriter};
pub use status_bar_app_manager::{
    command_matches_executable, ProcessOps, StatusBarAppManager, StatusBarAppRuntime,
    StatusBarAppStartResult, StatusBarAppStopResult, BINARY_NAME, DEFAULT_XCODE_DEVELOPER_DIR,
};
