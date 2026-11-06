//! Hook installation and removal.

mod claude_settings;
mod hook_manager;

pub use claude_settings::{
    legacy_claude_hook_paths, quote_claude_hook_path, with_claude_settings_lock,
    with_claude_settings_lock_checked, ClaudeSettingsLockError,
};
pub use hook_manager::{HookDefinition, HookManager};

#[cfg(all(test, unix))]
pub(crate) use claude_settings::history_test_hooks as claude_settings_history_test_hooks;
