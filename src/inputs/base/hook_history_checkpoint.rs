//! Port of `src/inputs/base/hook-history-checkpoint.ts`.

use crate::checkpoints::InputState;
use crate::utils::get_today_date_string;
use serde_json::{Map, Value};
use std::io::ErrorKind;
use std::path::Path;

pub struct HookHistoryStartupCheckpoint {
    pub last_file: String,
    pub last_offset: f64,
    pub extra: Value,
    pub skipped_existing_bytes: u64,
}

pub async fn create_hook_history_startup_checkpoint(
    current: &InputState,
    log_dir: &str,
    log_prefix: &str,
) -> anyhow::Result<Option<HookHistoryStartupCheckpoint>> {
    if has_usable_checkpoint(current) {
        return Ok(None);
    }
    let log_file_name = format!("{log_prefix}-{}.jsonl", get_today_date_string());
    let log_file = Path::new(log_dir).join(&log_file_name);
    let existing_bytes = match tokio::fs::metadata(&log_file).await {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == ErrorKind::NotFound => 0,
        Err(err) => return Err(err.into()),
    };
    let mut extra = match current.extra() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    extra.insert("hookHistoryInitialized".to_string(), Value::Bool(true));
    Ok(Some(HookHistoryStartupCheckpoint {
        last_file: log_file_name,
        last_offset: existing_bytes as f64,
        extra: Value::Object(extra),
        skipped_existing_bytes: existing_bytes,
    }))
}

fn has_usable_checkpoint(state: &InputState) -> bool {
    let Some(last_file) = state.last_file() else {
        return false;
    };
    if last_file.is_empty() {
        return false;
    }
    state
        .last_offset()
        .is_some_and(|offset| offset.is_finite() && offset >= 0.0)
}
