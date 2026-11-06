//! Hook JSONL + segment trace input for Qoder Work.
//!
//! Main-turn loop/iteration pairing, source-prioritized hook timing, and token-only SDK fallback.

mod enrichment;
mod qoder_work_trace_input;

pub use qoder_work_trace_input::{QoderWorkTraceInput, QoderWorkTraceOptions};
