//! Built-in local rules. They run when interceptor mode/types enable the mask type.

use super::sensitive_type::{create_sensitive_type_rule, SENSITIVE_INTERCEPT_TYPES};
use super::LocalRule;
use std::sync::Arc;

pub fn builtin_rules() -> Vec<Arc<dyn LocalRule>> {
    SENSITIVE_INTERCEPT_TYPES
        .iter()
        .map(|kind| Arc::new(create_sensitive_type_rule(kind)) as Arc<dyn LocalRule>)
        .collect()
}
