//! Shared collector dynamic-library boundary. See include/pilot_sdk.h.
pub mod abi;
mod api;
pub(crate) mod host_loader;
mod monitoring;
mod policy;
mod runtime;
pub(crate) use runtime::configure_qwen_wakeups;

pub(crate) mod outbox;

pub(crate) mod agent_hooks;
pub mod hook_protocol;
mod hooks;

#[cfg(test)]
mod source_tests;

/// State directory for the shared SDK instance hosted by full Pilot.
pub const STANDALONE_QODER_DATA: &str = "state/standalone-qoder-sdk";
pub(crate) const STANDALONE_QODER_CN_DATA: &str = "state/standalone-qoder-cn-sdk";
