//! Qoder Work SDK log tail and the session-file trace input that lives beside it.
//!
//! `qoder-work-log/qoder-work-trace-input.ts` is a different type from
//! `qoder-work-trace/qoder-work-trace-input.ts`.

mod qoder_work_log_input;
mod qoder_work_trace_input;

pub(crate) use qoder_work_log_input::open_log_file;

pub use qoder_work_log_input::{
    parse_sdk_log_line, resolve_qoder_work_root, QoderWorkLogInput, QoderWorkLogOptions, SdkEvent,
};
pub use qoder_work_trace_input::{QoderWorkLogTraceInput, QoderWorkLogTraceOptions};

mod sdk_trace_model;
mod sdk_trace_output;

pub(crate) mod bounded_line_tail;
