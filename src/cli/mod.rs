//! Pilot CLI helpers for token usage and the macOS menu bar.
//!
//! Wire with `#[path = "cli/mod.rs"] pub mod cli;`.

pub(crate) mod args;
pub(crate) mod dashboard_probe;
pub(crate) mod dashboard_shortcut;
mod menubar;
pub(crate) mod service;
pub(crate) mod span_attr;
mod token_usage;

pub use menubar::{run_menubar_command, run_menubar_with, MenubarContext, MenubarIo};
pub use token_usage::{
    load_view_data, parse_token_usage_args, render_help, render_token_usage,
    resolve_token_usage_data_dir, run_token_usage_command, MetricsRange, ParseResult,
    TokenUsageOptions, TokenUsageViewData,
};
