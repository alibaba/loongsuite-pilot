//! Port of `src/flushers/jsonl-flusher.ts`.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value};

use super::base_flusher::{BaseFlusher, FlushError};
use crate::normalization::{project_log_entry, SerialiseLogEntryOptions};
use crate::types::{AgentActivityEntry, JsonlFlusherConfig};
use crate::utils::{
    append_segmented_jsonl, ensure_dir, get_today_date_string, DEFAULT_JSONL_SEGMENT_BYTES,
};

pub struct JsonlFlusher {
    config: JsonlFlusherConfig,
    today: Arc<dyn Fn() -> String + Send + Sync>,
}

impl JsonlFlusher {
    pub fn new(config: JsonlFlusherConfig) -> Self {
        Self::with_today(config, Arc::new(get_today_date_string))
    }

    pub fn with_today(
        config: JsonlFlusherConfig,
        today: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self { config, today }
    }

    fn resolve_file_path(&self, agent_type: &str) -> String {
        let date = if self.config.rotate_daily {
            (self.today)()
        } else {
            "all".to_string()
        };
        Path::new(&self.config.output_dir)
            .join(format!("{agent_type}-{date}.jsonl"))
            .to_string_lossy()
            .to_string()
    }

    fn max_file_bytes(&self) -> u64 {
        self.config
            .max_file_size_mb
            .as_f64()
            .filter(|mb| mb.is_finite() && *mb > 0.0)
            .map(|mb| ((mb * 1024.0 * 1024.0).floor() as u64).max(1))
            .unwrap_or(DEFAULT_JSONL_SEGMENT_BYTES)
    }

    fn agent_type_of(entry: &AgentActivityEntry) -> String {
        if !entry.agent_type.is_empty() {
            return entry.agent_type.clone();
        }
        entry
            .get("agent.type")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string()
    }
}

#[async_trait]
impl BaseFlusher for JsonlFlusher {
    fn name(&self) -> &str {
        "jsonl"
    }

    async fn start(&self) -> Result<(), FlushError> {
        ensure_dir(&self.config.output_dir).await;
        Ok(())
    }

    async fn send(
        &self,
        entry: AgentActivityEntry,
        _logical_bytes: Option<f64>,
    ) -> Result<(), FlushError> {
        let path = self.resolve_file_path(&Self::agent_type_of(&entry));
        let projected = project_log_entry(
            &entry,
            &SerialiseLogEntryOptions {
                drop_agent_scoped_fields: true,
            },
        );
        let line =
            serde_json::to_string(&Value::Object(projected)).unwrap_or_else(|_| "{}".to_string());
        let limit = self.max_file_bytes();
        append_segmented_jsonl(Path::new(&path), &line, limit, false)
            .await
            .map_err(|error| FlushError::new(error.to_string()))
    }

    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _logical_bytes: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        for entry in entries {
            self.send(entry, None).await?;
        }
        Ok(())
    }

    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }

    async fn send_raw(&self, topic: &str, payload: &Map<String, Value>) -> Result<(), FlushError> {
        let path = Path::new(&self.config.output_dir)
            .join(format!("{topic}-{}.jsonl", (self.today)()))
            .to_string_lossy()
            .to_string();
        let mut body = Map::new();
        body.insert(
            "logTime".to_string(),
            Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        body.insert("topic".to_string(), Value::String(topic.to_string()));
        for (key, value) in payload {
            body.insert(key.clone(), value.clone());
        }
        let line = serde_json::to_string(&Value::Object(body)).unwrap_or_else(|_| "{}".to_string());
        let limit = self.max_file_bytes();
        append_segmented_jsonl(Path::new(&path), &line, limit, false)
            .await
            .map_err(|error| FlushError::new(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::JsonlFlusherConfig;
    use serde_json::{json, Map, Value};
    use std::sync::Arc;

    fn config(dir: &str, rotate_daily: bool) -> JsonlFlusherConfig {
        JsonlFlusherConfig {
            enabled: true,
            output_dir: dir.to_string(),
            rotate_daily,
            max_file_size_mb: 100.into(),
        }
    }

    fn flusher(dir: &str, rotate_daily: bool) -> JsonlFlusher {
        JsonlFlusher::with_today(
            config(dir, rotate_daily),
            Arc::new(|| "2026-04-27".to_string()),
        )
    }

    #[tokio::test]
    async fn writes_canonical_json_without_flattening_types() {
        let dir = tempfile::tempdir().unwrap();
        let flusher = flusher(dir.path().to_str().unwrap(), true);
        let entry = crate::normalization::build_test_entry(&json!({
            "uuid": "e1",
            "agentType": "qoder",
            "timestamp": 1700000000000_i64,
            "gen_ai.turn.start": true,
            "gen_ai.usage.total_tokens": 12,
            "gen_ai.output.messages": [{
                "role": "assistant",
                "parts": [{ "type": "text", "content": "synthetic output" }]
            }]
        }));
        flusher.send(entry, None).await.unwrap();
        let path = dir.path().join("qoder-2026-04-27.jsonl");
        let text = std::fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(parsed["event.id"], "e1");
        assert_eq!(parsed["gen_ai.agent.type"], "qoder");
        assert!(parsed.get("logTime").is_none());
        assert!(parsed.get("data").is_none());
        assert!(parsed.get("gen_ai.session.id").is_some());
        assert_eq!(parsed["gen_ai.turn.start"], true);
        assert_eq!(parsed["gen_ai.usage.total_tokens"], 12);
        assert_eq!(
            parsed["gen_ai.output.messages"],
            json!([{ "role": "assistant", "parts": [{ "type": "text", "content": "synthetic output" }] }])
        );
    }

    #[tokio::test]
    async fn omits_agent_scoped_extension_fields() {
        let dir = tempfile::tempdir().unwrap();
        let flusher = flusher(dir.path().to_str().unwrap(), true);
        let entry = crate::normalization::build_test_entry(&json!({
            "agentType": "qoder",
            "agent.qoder.cwd": "/workspace/project",
            "agent.cursor.hook_event_name": "preToolUse"
        }));
        flusher.send(entry, None).await.unwrap();
        let text = std::fs::read_to_string(dir.path().join("qoder-2026-04-27.jsonl")).unwrap();
        let parsed: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert!(parsed.get("agent.qoder.cwd").is_none());
        assert!(parsed.get("agent.cursor.hook_event_name").is_none());
        assert_eq!(parsed["agent.file_path"], "/tmp/test/file.ts");
        assert_eq!(parsed["gen_ai.agent.type"], "qoder");
    }

    #[tokio::test]
    async fn rotate_daily_uses_date_or_all() {
        let dir = tempfile::tempdir().unwrap();
        let daily = flusher(dir.path().to_str().unwrap(), true);
        daily
            .send(
                crate::normalization::build_test_entry(&json!({"agentType": "qoder"})),
                None,
            )
            .await
            .unwrap();
        assert!(dir.path().join("qoder-2026-04-27.jsonl").is_file());

        let flat = flusher(dir.path().to_str().unwrap(), false);
        flat.send(
            crate::normalization::build_test_entry(&json!({"agentType": "cursor"})),
            None,
        )
        .await
        .unwrap();
        assert!(dir.path().join("cursor-all.jsonl").is_file());
    }

    #[tokio::test]
    async fn send_raw_writes_topic_date_file() {
        let dir = tempfile::tempdir().unwrap();
        let flusher = flusher(dir.path().to_str().unwrap(), true);
        let mut payload = Map::new();
        payload.insert("key".to_string(), Value::String("value".to_string()));
        flusher.send_raw("mcp", &payload).await.unwrap();
        let text = std::fs::read_to_string(dir.path().join("mcp-2026-04-27.jsonl")).unwrap();
        let parsed: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(parsed["topic"], "mcp");
        assert_eq!(parsed["key"], "value");
        assert!(parsed.get("logTime").is_some());
    }

    #[tokio::test]
    async fn send_batch_writes_each_entry_and_lifecycle_is_inert() {
        let dir = tempfile::tempdir().unwrap();
        let flusher = flusher(dir.path().to_str().unwrap(), true);
        flusher.start().await.unwrap();
        assert!(dir.path().is_dir());
        let entries = vec![
            crate::normalization::build_test_entry(&json!({"uuid": "a"})),
            crate::normalization::build_test_entry(&json!({"uuid": "b"})),
            crate::normalization::build_test_entry(&json!({"uuid": "c"})),
        ];
        flusher.send_batch(entries, None).await.unwrap();
        let text = std::fs::read_to_string(dir.path().join("qoder-2026-04-27.jsonl")).unwrap();
        assert_eq!(text.lines().filter(|line| !line.is_empty()).count(), 3);
        flusher.flush().await.unwrap();
        flusher.shutdown().await.unwrap();
    }
}

#[cfg(test)]
mod migration_lifecycle_contracts {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn lifecycle_only_start_creates_missing_output_directory() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("not-created/then-output");
        let flusher = JsonlFlusher::with_today(
            JsonlFlusherConfig {
                enabled: true,
                output_dir: missing.to_string_lossy().into_owned(),
                rotate_daily: true,
                max_file_size_mb: 100.into(),
            },
            Arc::new(|| "2026-04-27".to_owned()),
        );
        flusher.flush().await.unwrap();
        flusher.shutdown().await.unwrap();
        assert!(
            !missing.exists(),
            "no-op lifecycle methods must not create storage"
        );
        flusher.start().await.unwrap();
        assert!(missing.is_dir());
        assert_eq!(std::fs::read_dir(&missing).unwrap().count(), 0);
        flusher
            .send(
                crate::normalization::build_test_entry(
                    &json!({"uuid":"after-start","agentType":"qoder"}),
                ),
                None,
            )
            .await
            .unwrap();
        let path = missing.join("qoder-2026-04-27.jsonl");
        let original = std::fs::read(&path).unwrap();
        flusher.flush().await.unwrap();
        flusher.shutdown().await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert_eq!(std::fs::read_dir(missing).unwrap().count(), 1);
    }
}

#[cfg(test)]
#[path = "jsonl_rotation_main_tests.rs"]
mod rotation_main_tests;
