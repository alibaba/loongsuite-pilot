//! Shared collector dynamic-library boundary. See include/pilot_sdk.h.
pub mod abi;
mod api;
mod monitoring;
mod policy;
mod runtime;

mod outbox;

pub mod hook_protocol;
mod hooks;

#[cfg(test)]
mod source_tests;
