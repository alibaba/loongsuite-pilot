//! Local worker instance store, private directories, CLI, and activation.
//!
//! Wire this directory from the crate root with
//! `#[path = "local-workers/mod.rs"] pub mod local_workers;`.
//!
//! `fs.watch` and the poll timer are not armed here. Callers invoke
//! [`LocalWorkerActivationService::refresh`]. Bundle install still belongs to
//! the unported deployment `PluginProbeStrategy`; this module supplies
//! [`WorkerSupervisor`] for that boundary.

mod instance_store;
mod local_worker_activation_service;
mod private_directory;
mod worker_cli;

pub use instance_store::*;
pub use local_worker_activation_service::{
    build_definition, build_manifest_instance, LocalWorkerActivationService, WorkerSupervisor,
    DEFAULT_SCAN_INTERVAL_MS,
};
pub use private_directory::{
    prepare_private_local_worker_directory, prepare_private_local_worker_directory_on,
    windows_acl_argv, WorkerPlatform, WINDOWS_ACL_COMMAND_TIMEOUT_MS, WINDOWS_ACL_PROTECT,
};
pub use worker_cli::{handle_worker_cli, handle_worker_cli_with, WorkerCliIo};

#[cfg(test)]
#[path = "deployment_test_isolation_history_contract_tests.rs"]
mod deployment_isolation_history_contract_tests;
