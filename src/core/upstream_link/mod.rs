//! Upstream trace linking. Port of `src/core/upstream-link`.

mod correlation_store;
mod retention;
mod trace_linker;

pub use correlation_store::CorrelationStore;
pub use retention::AcpCorrelateRetentionService;
pub use trace_linker::TraceLinker;
