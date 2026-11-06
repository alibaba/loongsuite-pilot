//! Workspace exclusion shared by the collector and hook runtimes.
//!
//! The JavaScript implementation still lives in
//! `assets/hooks/shared/workspace-policy.mjs`. This re-exports the pipeline
//! port, which matches `enabled`, `allows`, and `filter`.

pub use crate::pipeline::workspace_policy::{validate_excluded_workspaces, WorkspacePolicy};
