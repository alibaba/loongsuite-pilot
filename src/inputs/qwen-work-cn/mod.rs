//! QwenWorkCN hook, SQLite, and trace inputs.

mod collaboration_input;
mod collaboration_parser;
mod flash_usage;
pub mod multimodal;

pub(crate) use collaboration_input::{
    resolve_root as resolve_collaboration_root, QwenWorkCnCollaborationInput,
};
mod qwen_work_cn_input;
mod qwen_work_cn_sqlite_input;
mod qwen_work_cn_trace_input;

pub use qwen_work_cn_input::{QwenWorkCnInput, QwenWorkCnOptions};
pub use qwen_work_cn_sqlite_input::{
    resolve_qwen_work_cn_root, QwenWorkCnSqliteInput, QwenWorkCnSqliteOptions,
};
pub use qwen_work_cn_trace_input::{
    qwen_work_cn_default_allowed_root_paths, resolve_qwen_work_cn_allowed_root_paths,
    QwenWorkCnMultimodalOptions, QwenWorkCnTraceInput, QwenWorkCnTraceOptions,
};
