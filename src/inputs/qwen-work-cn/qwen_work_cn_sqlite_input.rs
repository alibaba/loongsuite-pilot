//! Port of `src/inputs/qwen-work-cn/qwen-work-cn-sqlite-input.ts`.

use crate::inputs::base::{query_readonly, InputBody, InputRuntime};
use crate::normalization::build_agent_activity_entry;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{resolve_home, DEFAULT_POLL_INTERVAL_MS};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;

const SOURCE: &str = "qwen-work-cn-sqlite";
const SQL_BATCH_LIMIT: usize = 1000;
const TOOL_RESULT_DEDUPE_LIMIT: usize = 50_000;

pub struct QwenWorkCnSqliteInput {
    pub inner: Arc<crate::inputs::base::HostedInput<QwenWorkCnSqliteBody>>,
}

pub struct QwenWorkCnSqliteBody {
    db_path: String,
}

pub struct QwenWorkCnSqliteOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub db_path: Option<String>,
    pub data_root: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

impl QwenWorkCnSqliteInput {
    pub(crate) fn collector_runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        self.inner.runtime.runtime_info()
    }

    /// Apply validated collector exclusions before any collection or upload.
    pub(crate) fn set_collector_workspace_policy(
        &self,
        policy: crate::inputs::base::WorkspacePolicy,
    ) {
        self.inner.runtime.set_workspace_policy(policy);
    }

    /// Collector subscription. Forwards to the hosted runtime without exposing its body type.
    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[crate::types::AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }

    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }

    pub fn new(opts: QwenWorkCnSqliteOptions) -> Self {
        let root = opts.data_root.unwrap_or_else(resolve_qwen_work_cn_root);
        let db_path = opts.db_path.unwrap_or_else(|| {
            PathBuf::from(root)
                .join("data")
                .join("agents.db")
                .to_string_lossy()
                .into_owned()
        });
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QwenWorkCnSqliteBody { db_path },
                "QwenWorkCNSqliteInput",
                opts.state_store,
                opts.poll_interval_ms.or(Some(DEFAULT_POLL_INTERVAL_MS)),
            ),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }

    pub fn get_watch_paths() -> Vec<String> {
        vec![PathBuf::from(resolve_qwen_work_cn_root())
            .join("data")
            .to_string_lossy()
            .into_owned()]
    }

    pub async fn check_availability() -> bool {
        tokio::fs::metadata(
            PathBuf::from(resolve_qwen_work_cn_root())
                .join("data")
                .join("agents.db"),
        )
        .await
        .is_ok()
    }
}

pub fn resolve_qwen_work_cn_root() -> String {
    if cfg!(target_os = "macos") {
        PathBuf::from(resolve_home("~"))
            .join("Library")
            .join("Application Support")
            .join("QwenWorkCN")
            .to_string_lossy()
            .into_owned()
    } else {
        let config_home = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| resolve_home("~/.config"));
        PathBuf::from(config_home)
            .join("QwenWorkCN")
            .to_string_lossy()
            .into_owned()
    }
}

#[async_trait]
impl InputBody for QwenWorkCnSqliteBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "qwen-work-cn-sqlite"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QwenWorkCN
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SqlitePolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        let state = rt.state();
        let extra = state.extra();
        if extra
            .as_ref()
            .and_then(|value| value.get("lastUpdatedAt"))
            .and_then(Value::as_f64)
            .is_some()
        {
            if extra
                .as_ref()
                .and_then(|value| value.get("lastUpdatedRowId"))
                .and_then(Value::as_f64)
                .is_none()
            {
                let mut object = plain_object(extra.as_ref());
                object.insert("lastUpdatedRowId".into(), json!(0));
                rt.set_state_fields(None, None, Some(Value::Object(object)));
            }
            return Ok(());
        }
        match read_latest_cursor(&self.db_path).await {
            Ok(cursor) => {
                let mut object = plain_object(extra.as_ref());
                object.insert("lastUpdatedAt".into(), json!(cursor.0));
                object.insert("lastUpdatedRowId".into(), json!(cursor.1));
                rt.set_state_fields(None, None, Some(Value::Object(object)));
            }
            Err(err) => rt.warn(
                "failed to baseline qwen-work-cn sqlite cursor",
                json!({ "error": err }).as_object(),
            ),
        }
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let state = rt.state();
        let extra = state.extra();
        if extra
            .as_ref()
            .and_then(|extra| extra.get("lastUpdatedAt"))
            .and_then(Value::as_f64)
            .is_none()
        {
            // Failed initialization remains unowned. Retry its compound floor
            // before any historical row can enter the delivery path.
            let baseline = read_latest_cursor(&self.db_path)
                .await
                .map_err(anyhow::Error::msg)?;
            let mut object = plain_object(extra.as_ref());
            object.insert("lastUpdatedAt".into(), json!(baseline.0));
            object.insert("lastUpdatedRowId".into(), json!(baseline.1));
            rt.set_state_fields(None, None, Some(Value::Object(object)));
            return Ok(Vec::new());
        }
        let cursor_updated_at = extra
            .as_ref()
            .and_then(|value| value.get("lastUpdatedAt"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let cursor_row_id = extra
            .as_ref()
            .and_then(|value| value.get("lastUpdatedRowId"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let rows = match read_rows(&self.db_path, cursor_updated_at, cursor_row_id).await {
            Ok(rows) => rows,
            Err(err) => {
                rt.error(
                    "failed to read qwen-work-cn sqlite rows",
                    json!({ "error": err }).as_object(),
                );
                return Ok(Vec::new());
            }
        };
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let mut emitted = string_array(extra.as_ref(), "emittedToolResultIds");
        let mut entries = Vec::new();
        for row in &rows {
            entries.extend(map_row(row, &mut emitted));
        }
        let last = rows.last().unwrap();
        let mut object = plain_object(extra.as_ref());
        object.insert("lastUpdatedAt".into(), json!(last.updated_at));
        object.insert("lastUpdatedRowId".into(), json!(last.row_id));
        if emitted.len() > TOOL_RESULT_DEDUPE_LIMIT {
            emitted = emitted.split_off(emitted.len() - TOOL_RESULT_DEDUPE_LIMIT);
        }
        object.insert("emittedToolResultIds".into(), json!(emitted));
        rt.set_state_fields(None, None, Some(Value::Object(object)));
        Ok(entries)
    }
}

struct MessageRow {
    row_id: f64,
    id: String,
    session_id: Option<String>,
    sub_chat_id: String,
    sequence: f64,
    role: String,
    parts: String,
    updated_at: f64,
    model_level: Option<String>,
}

fn map_row(row: &MessageRow, emitted: &mut Vec<String>) -> Vec<AgentActivityEntry> {
    let Ok(parts) = serde_json::from_str::<Value>(&row.parts) else {
        return Vec::new();
    };
    let Some(parts) = parts.as_array() else {
        return Vec::new();
    };
    let session_id = row.session_id.clone().unwrap_or_default();
    let timestamp = if row.updated_at > 0.0 {
        row.updated_at * 1000.0
    } else {
        now_ms() as f64
    };
    let model = row
        .model_level
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".into());
    if row.role == "user" {
        let text = parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .map(|part| {
                string_value(part.get("text"))
                    .or_else(|| string_value(part.get("content")))
                    .unwrap_or_default()
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if text.is_empty() {
            return Vec::new();
        }
        return vec![build_agent_activity_entry(&json!({
            "timestamp": timestamp,
            "event.id": hash_parts(&[session_id.clone(), row.id.clone(), "user".into()]),
            "event.name": "llm.request",
            "gen_ai.session.id": session_id,
            "gen_ai.agent.type": ClientType::QwenWorkCN.as_str(),
            "gen_ai.request.model": model,
            "gen_ai.input.messages_delta": [{ "role": "user", "content": text }],
            "attributes": {
                "source": SOURCE,
                "event_kind": "user_prompt",
                "message_id": row.id,
                "sub_chat_id": row.sub_chat_id,
                "sequence": row.sequence,
            }
        }))];
    }
    if row.role != "assistant" {
        return Vec::new();
    }
    let mut entries = Vec::new();
    for part in parts {
        let Some(part_type) = part.get("type").and_then(Value::as_str) else {
            continue;
        };
        if !part_type.starts_with("tool-") || part_type == "tool-Thinking" {
            continue;
        }
        let call_id = string_value(part.get("toolCallId"))
            .filter(|value| !value.is_empty())
            .or_else(|| string_value(part.get("tool_call_id")).filter(|value| !value.is_empty()))
            .unwrap_or_default();
        let tool_name = string_value(part.get("toolName"))
            .filter(|value| !value.is_empty())
            .or_else(|| string_value(part.get("tool_name")).filter(|value| !value.is_empty()))
            .or_else(|| string_value(part.get("name")).filter(|value| !value.is_empty()))
            .unwrap_or_else(|| part_type.trim_start_matches("tool-").to_owned());
        let Some(raw_result) = part.get("output").or_else(|| part.get("result")) else {
            continue;
        };
        if call_id.is_empty() {
            continue;
        }
        let result = json_value(raw_result);
        let event_id = hash_parts(&[
            session_id.clone(),
            row.id.clone(),
            "tool_result".into(),
            call_id.clone(),
            tool_name.clone(),
            result.to_string(),
        ]);
        if emitted.iter().any(|existing| existing == &event_id) {
            continue;
        }
        emitted.push(event_id.clone());
        entries.push(build_agent_activity_entry(&json!({
            "timestamp": timestamp,
            "event.id": event_id,
            "event.name": "tool.result",
            "gen_ai.session.id": session_id,
            "gen_ai.agent.type": ClientType::QwenWorkCN.as_str(),
            "gen_ai.request.model": model,
            "gen_ai.tool.name": tool_name,
            "gen_ai.tool.call.id": call_id,
            "gen_ai.tool.call.exec.id": call_id,
            "gen_ai.tool.call.result": result,
            "tool.result.status": "success",
            "attributes": {
                "source": SOURCE,
                "event_kind": "tool_result",
                "message_id": row.id,
                "sub_chat_id": row.sub_chat_id,
                "part_type": part_type,
            }
        })));
    }
    entries
}

async fn read_rows(
    db_path: &str,
    cursor_updated_at: f64,
    cursor_row_id: f64,
) -> Result<Vec<MessageRow>, String> {
    let sql = format!(
        "
    SELECT m.rowid AS rowId, m.id AS id, sc.session_id AS sessionId, m.sub_chat_id AS subChatId,
      m.sequence AS sequence, m.role AS role, m.parts AS parts,
      m.updated_at AS updatedAt, sc.model_level AS modelLevel
    FROM messages m
    LEFT JOIN sub_chats sc ON sc.id = m.sub_chat_id
    WHERE (m.updated_at > ? OR (m.updated_at = ? AND m.rowid > ?))
      AND m.parts IS NOT NULL AND m.parts != '' AND m.parts != '[]'
    ORDER BY m.updated_at ASC, m.rowid ASC
    LIMIT {SQL_BATCH_LIMIT}
  "
    );
    let rows = query_readonly(
        db_path,
        &sql,
        &[
            json!(cursor_updated_at),
            json!(cursor_updated_at),
            json!(cursor_row_id),
        ],
    )
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let Value::Object(map) = row else { return None };
            Some(MessageRow {
                row_id: map.get("rowId").and_then(Value::as_f64).unwrap_or(0.0),
                id: map
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                session_id: map
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                sub_chat_id: map
                    .get("subChatId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                sequence: map.get("sequence").and_then(Value::as_f64).unwrap_or(0.0),
                role: map
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                parts: map
                    .get("parts")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                updated_at: map.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0),
                model_level: map
                    .get("modelLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect())
}

async fn read_latest_cursor(db_path: &str) -> Result<(f64, f64), String> {
    let rows = query_readonly(
        db_path,
        "SELECT updated_at AS updatedAt, rowid AS rowId FROM messages ORDER BY updated_at DESC, rowid DESC LIMIT 1",
        &[],
    )
    .await?;
    let Some(Value::Object(row)) = rows.into_iter().next() else {
        return Ok((0.0, 0.0));
    };
    Ok((
        row.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0),
        row.get("rowId").and_then(Value::as_f64).unwrap_or(0.0),
    ))
}

fn hash_parts(parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(parts.join("\u{0}").as_bytes());
    hex::encode(hasher.finalize())
}

fn string_value(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn json_value(value: &Value) -> Value {
    match value {
        Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(items) => Value::Array(items.iter().map(json_value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), json_value(item)))
                .collect(),
        ),
    }
}

fn plain_object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn string_array(value: Option<&Value>, key: &str) -> Vec<String> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "sqlite_migration_contract_tests.rs"]
mod work_sqlite_migration_contract_tests;
