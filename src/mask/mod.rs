//! Sensitive-data masking. Behavior follows `src/mask/*.ts`.
//!
//! JSON field names on masked activity records stay the serde names of
//! `AgentActivityEntry` (the same dotted keys the TypeScript objects use).

mod detect;
mod entry_masker;
mod field_whitelist;
mod masked_preview;
mod pii_detectors;
mod rule_loader;
mod string_masker;
mod types;

pub use detect::{
    collect_sensitive_ranges, find_first_sensitive_match, resolve_string_mask_options,
};
pub use entry_masker::mask_agent_activity_entry;
pub use field_whitelist::{should_mask_field, FIELDS_TO_MASK};
pub use masked_preview::{build_mask_replacement, MAX_MASKED_PREVIEW_LENGTH};
pub use rule_loader::{
    compile_sensitive_rules, filter_rules_by_config, load_enabled_rules, load_mask_plan,
    load_sensitive_rules, load_sensitive_rules_from_manifest, resolve_enabled_mask_types,
};
pub use string_masker::{apply_mask_ranges, is_large_string, mask_string};
pub use types::*;
