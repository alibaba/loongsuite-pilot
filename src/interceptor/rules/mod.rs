//! Local interceptor rules.

mod engine;
mod hook_text;
mod registry;
mod sensitive_type;

use crate::interceptor::types::{HookRequest, RuleResult};

pub trait LocalRule: Send + Sync {
    fn id(&self) -> &str;
    fn supports(&self, request: &HookRequest) -> bool;
    fn evaluate(&self, request: &HookRequest) -> Result<RuleResult, String>;
}

pub use engine::RuleEngine;
pub use hook_text::collect_hook_text;
pub use registry::builtin_rules;
pub use sensitive_type::{create_sensitive_type_rule, SENSITIVE_INTERCEPT_TYPES};
