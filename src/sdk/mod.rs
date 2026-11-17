//! Shared collector dynamic-library boundary. See include/pilot_sdk.h.
pub mod abi;
mod api;
pub(crate) mod host_loader;
mod monitoring;
mod policy;
mod runtime;

mod outbox;

mod agent_hooks;
pub mod hook_protocol;
mod hooks;

#[cfg(test)]
mod source_tests;

/// State directory for the shared SDK instance hosted by full Pilot.
pub const STANDALONE_QODER_DATA: &str = "state/standalone-qoder-sdk";
