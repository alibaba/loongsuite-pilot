//! Port of `src/status-bar/runtime-writer.ts`.

use crate::types::StatusBarConfig;
use crate::utils::{ensure_dir, write_json_file};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRecord {
    pub status: String,
    pub package_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_commit: Option<String>,
    pub pid: u32,
    pub updated_at: String,
}

pub struct RuntimeWriter {
    file_path: String,
    config: StatusBarConfig,
    package_version: String,
    git_commit: String,
}

impl RuntimeWriter {
    pub fn new(
        data_dir: &str,
        config: StatusBarConfig,
        package_version: impl Into<String>,
        git_commit: impl Into<String>,
    ) -> Self {
        Self {
            file_path: Path::new(data_dir)
                .join("logs")
                .join("runtime.json")
                .to_string_lossy()
                .into_owned(),
            config,
            package_version: package_version.into(),
            git_commit: git_commit.into(),
        }
    }

    pub fn file_path(&self) -> &str {
        &self.file_path
    }

    pub fn refresh_interval_ms(&self) -> u64 {
        self.config.runtime_refresh_interval_ms
    }

    pub async fn write_once(&self) -> Result<(), String> {
        let record = RuntimeRecord {
            status: "active".into(),
            package_version: self.package_version.clone(),
            git_commit: if self.git_commit.is_empty() {
                None
            } else {
                Some(self.git_commit.clone())
            },
            pid: std::process::id(),
            updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        if let Some(parent) = Path::new(&self.file_path).parent() {
            ensure_dir(&parent.to_string_lossy()).await;
        }
        write_json_file(&self.file_path, &record)
            .await
            .map_err(|err| err.to_string())
    }

    pub fn remove(&self) {
        let _ = std::fs::remove_file(&self.file_path);
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeWriter;
    use crate::types::StatusBarConfig;
    use serde_json::Value;

    fn config(enabled: bool) -> StatusBarConfig {
        StatusBarConfig {
            enabled,
            metrics_summary_interval_ms: 60_000,
            runtime_refresh_interval_ms: 30_000,
        }
    }

    #[tokio::test]
    async fn writes_runtime_json_and_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let writer = RuntimeWriter::new(
            dir.path().to_str().unwrap(),
            config(true),
            "1.2.3",
            "abc123",
        );
        writer.write_once().await.unwrap();
        let content: Value =
            serde_json::from_str(&std::fs::read_to_string(writer.file_path()).unwrap()).unwrap();
        assert_eq!(content["status"], "active");
        assert_eq!(content["packageVersion"], "1.2.3");
        assert_eq!(content["gitCommit"], "abc123");
        assert_eq!(content["pid"], std::process::id());
        assert!(content["updatedAt"].as_str().unwrap().contains('T'));
        writer.remove();
        assert!(!std::path::Path::new(writer.file_path()).exists());
    }

    #[tokio::test]
    async fn writes_health_when_the_status_bar_ui_is_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let writer = RuntimeWriter::new(dir.path().to_str().unwrap(), config(false), "1.0.0", "");
        writer.write_once().await.unwrap();
        let content: Value =
            serde_json::from_str(&std::fs::read_to_string(writer.file_path()).unwrap()).unwrap();
        assert_eq!(content["status"], "active");
        assert_eq!(content["packageVersion"], "1.0.0");
        assert_eq!(content["pid"], std::process::id());
        assert!(content.get("gitCommit").is_none());
        writer.remove();
    }
}
