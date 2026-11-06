//! Host adapters. Each agent keeps its own block JSON.

mod openclaw;
mod qoder;
mod qwenwork;
mod reason;

pub use openclaw::{
    canonicalize_openclaw_hook, openclaw_block_result, parse_openclaw_hook_request,
    render_openclaw_block,
};
pub use qoder::{canonicalize_hook_event, parse_hook_request, render_qoder_block};
pub use qwenwork::{
    parse_qwen_work_hook_request, qwen_work_allow_body, qwen_work_block_body,
    render_qwen_work_block,
};
pub use reason::wrap_host_reason;
