//! Port of `src/updater/runtime-state.ts`.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdaterRuntimeStatus {
    Running,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterRuntimeState {
    pub status: UpdaterRuntimeStatus,
    pub pid: u32,
    pub version: String,
    pub version_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_commit: Option<String>,
    pub updated_at: String,
    pub consecutive_failures: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_check_at: Option<String>,
}

pub fn updater_runtime_path(data_dir: &str) -> String {
    Path::new(data_dir)
        .join("logs")
        .join("updater-runtime.json")
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::updater_runtime_path;
    use std::path::Path;

    #[test]
    fn runtime_file_lives_under_logs() {
        assert_eq!(
            Path::new(&updater_runtime_path("/data")),
            Path::new("/data/logs/updater-runtime.json")
        );
    }
}
