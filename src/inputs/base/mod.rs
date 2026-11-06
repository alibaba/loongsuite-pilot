//! Base input collectors ported from `src/inputs/base/*.ts`.
//!
//! TypeScript files stay in place. Rust sources in this directory are the port.

mod bootstrap_turn_filter;
mod canonical_hook_record;
mod cli_forwarder;
mod entry_map;
mod hook;
mod hook_history_checkpoint;
mod hook_record_transform;
mod ide;
mod input_runtime;
mod jsonl;
mod paths;
mod runtime_metrics;
mod session;
mod sqlite_input;
mod sqlite_query;
mod workspace_policy;

pub use bootstrap_turn_filter::filter_bootstrap_history_turns;
pub use canonical_hook_record::{build_canonical_hook_entry, CanonicalHookRecordOptions};
pub use cli_forwarder::{hosted_cli_forwarder, CliForwarderBody, ForwarderPaths};
pub use entry_map::{
    entry_from, entry_get, entry_map, is_event, legacy_file_path, string_field, update_entry,
};
pub use hook::{hosted_hook, HookAdapter, HookBody, HookPaths, OFFSET_MAP_EXTRA_KEY};
pub use hook_history_checkpoint::{
    create_hook_history_startup_checkpoint, HookHistoryStartupCheckpoint,
};
pub use hook_record_transform::transform_hook_record;
pub use ide::{hosted_ide, IdeAdapter, IdeBody};
pub use input_runtime::{HostedInput, InputBody, InputRuntime, InputRuntimeInfo};
pub use jsonl::{decode_complete, parse_object_line, read_file_slice};
pub use paths::{app_support_root, env_poll_or, home_dir, qoder_root};
pub use runtime_metrics::{
    CommittedInputBatch, InputRuntimeAccumulator, InputRuntimeDelta, PRIMARY_INPUT_SOURCE_KIND,
};
pub use session::{hosted_session, SessionAdapter, SessionBody, SessionPaths};
pub use sqlite_input::{hosted_sqlite, SqliteAdapter, SqliteBody};
pub use sqlite_query::{
    query_readonly, query_readonly_paged, query_readonly_sync, SqlitePageCursor, SQLITE_SYNC_PAGE,
};
pub use workspace_policy::{validate_excluded_workspaces, WorkspacePolicy};

#[cfg(test)]
mod tests;
