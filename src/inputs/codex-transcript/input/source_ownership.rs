//! Codex keeps its established ownership/floor API; durable primitives are shared.
pub(super) use crate::checkpoints::source_ownership::{
    baseline_floor, capture_baseline, remember, remember_baseline, was_live, BaselineFloor,
};
