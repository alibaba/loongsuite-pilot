//! loongsuite-pilot collector library.
//!
//! Modules are filled in as each TypeScript area is ported. Public items keep
//! the on-disk and on-the-wire names of the TypeScript sources.

pub mod checkpoints;
pub mod cli;
pub mod cli_main;
pub mod core;
pub mod dashboard;
pub mod deployment;
pub mod flushers;
pub mod hook_process;
pub mod hooks;
pub mod inputs;
pub mod interceptor;
pub mod internal;
#[path = "local-workers/mod.rs"]
pub mod local_workers;
pub mod mask;
pub mod metrics;
pub mod multimodal;
pub mod normalization;
#[path = "pi-sdk/mod.rs"]
pub mod pi_sdk;
pub mod pipeline;
#[path = "status-bar/mod.rs"]
pub mod status_bar;
pub mod types;
pub mod updater;
pub mod utils;
