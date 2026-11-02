//! Port of `src/inputs/qoder-work-sqlite/qoder-work-sqlite-input.ts`.
//!
//! `updated_at` is unix seconds. User rows become `llm.request`. Assistant
//! `tool-*` parts other than `tool-Thinking` become `tool.result`.

use crate::inputs::base::{query_readonly, InputBody, InputRuntime};
use crate::normalization::build_agent_activity_entry;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::DEFAULT_POLL_INTERVAL_MS;
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;

const SOURCE: &str = "qoder-work-sqlite";
const UNKNOWN_MODEL: &str = "unknown";
const SQL_BATCH_LIMIT: usize = 1000;
const TOOL_RESULT_DEDUPE_LIMIT: usize = 50_000;

pub struct QoderWorkSqliteOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub db_path: Option<String>,
    pub data_root: Option<String>,
    pub agent_type: Option<ClientType>,
    pub poll_interval_ms: Option<u64>,
}

pub struct QoderWorkSqliteInput {
    inner: Arc<crate::inputs::base::HostedInput<QoderWorkSqliteBody>>,
}

struct QoderWorkSqliteBody {
    id: String,
    agent_type: ClientType,
    db_path: String,
}

impl QoderWorkSqliteInput {
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

    pub fn new(opts: QoderWorkSqliteOptions) -> Self {
        let agent_type = opts.agent_type.unwrap_or(ClientType::QoderWork);
        let data_root = opts.data_root.unwrap_or_else(|| {
            crate::inputs::qoder_work_log::resolve_qoder_work_root(
                if agent_type == ClientType::QoderWorkCN {
                    "cn"
                } else {
                    "standard"
                },
            )
        });
        let db_path = opts.db_path.unwrap_or_else(|| {
            PathBuf::from(&data_root)
                .join("data")
                .join("agents.db")
                .to_string_lossy()
                .into_owned()
        });
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QoderWorkSqliteBody {
                    id: format!("{agent_type}-sqlite"),
                    agent_type,
                    db_path,
                },
                "QoderWorkSqliteInput",
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
    pub fn id(&self) -> &str {
        self.inner.id()
    }

    pub fn get_watch_paths() -> Vec<String> {
        let root = crate::inputs::qoder_work_log::resolve_qoder_work_root("standard");
        vec![PathBuf::from(root)
            .join("data")
            .to_string_lossy()
            .into_owned()]
    }

    pub async fn check_availability() -> bool {
        let path = PathBuf::from(crate::inputs::qoder_work_log::resolve_qoder_work_root(
            "standard",
        ))
        .join("data")
        .join("agents.db");
        tokio::fs::metadata(path).await.is_ok()
    }
}

#[async_trait]
impl InputBody for QoderWorkSqliteBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        &self.id
    }
    fn agent_type(&self) -> ClientType {
        self.agent_type
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SqlitePolling
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let state = rt.state();
        let extra = state.extra();
        let Some(cursor) = extra
            .as_ref()
            .and_then(|extra| extra.get("lastUpdatedAt"))
            .and_then(Value::as_f64)
        else {
            // Only a successful native query establishes initial ownership.
            let baseline = read_latest_cursor(&self.db_path)
                .await
                .map_err(anyhow::Error::msg)?;
            let mut object = match extra {
                Some(Value::Object(map)) => map,
                _ => Map::new(),
            };
            object.insert("lastUpdatedAt".into(), json!(baseline.0));
            object.insert("lastUpdatedRowId".into(), json!(baseline.1));
            rt.set_state_fields(None, None, Some(Value::Object(object)));
            return Ok(Vec::new());
        };
        let cursor_row_id = if let Some(row_id) = extra
            .as_ref()
            .and_then(|extra| extra.get("lastUpdatedRowId"))
            .and_then(Value::as_f64)
        {
            row_id
        } else {
            // Legacy scalar checkpoints excluded all rows at their timestamp.
            // Adopt that precise current exclusion boundary once; later inserts
            // at the same timestamp receive larger rowids and remain visible.
            let row_id = read_max_row_id_at(&self.db_path, cursor)
                .await
                .map_err(anyhow::Error::msg)?;
            let mut object = match extra.clone() {
                Some(Value::Object(map)) => map,
                _ => Map::new(),
            };
            object.insert("lastUpdatedRowId".into(), json!(row_id));
            rt.set_state_fields(None, None, Some(Value::Object(object)));
            row_id
        };
        let rows = match read_new_message_rows(&self.db_path, cursor, cursor_row_id).await {
            Ok(rows) => rows,
            Err(err) => {
                rt.error(
                    "failed to read qoder-work sqlite rows",
                    json!({ "error": err }).as_object(),
                );
                return Ok(Vec::new());
            }
        };
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let mut emitted = string_list(state.extra().as_ref(), "emittedToolResultIds");
        let mut entries = Vec::new();
        let mut max_update = cursor;
        let mut max_row_id = cursor_row_id;
        for row in &rows {
            if row.updated_at > max_update
                || (row.updated_at == max_update && row.row_id > max_row_id)
            {
                max_update = row.updated_at;
                max_row_id = row.row_id;
            }
            match transform_row(row, self.agent_type, &mut emitted) {
                Ok(row_entries) => entries.extend(row_entries),
                Err(err) => rt.warn(
                    "row transform failed",
                    json!({ "messageId": row.id, "error": err }).as_object(),
                ),
            }
        }
        let mut extra = match state.extra() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        extra.insert("lastUpdatedAt".into(), json!(max_update));
        extra.insert("lastUpdatedRowId".into(), json!(max_row_id));
        if emitted.len() > TOOL_RESULT_DEDUPE_LIMIT {
            emitted = emitted.split_off(emitted.len() - TOOL_RESULT_DEDUPE_LIMIT);
        }
        extra.insert("emittedToolResultIds".into(), json!(emitted));
        rt.set_state_fields(None, None, Some(Value::Object(extra)));
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

fn transform_row(
    row: &MessageRow,
    agent_type: ClientType,
    emitted: &mut Vec<String>,
) -> Result<Vec<AgentActivityEntry>, String> {
    let session_id = row.session_id.clone().unwrap_or_default();
    let ts_ms = if row.updated_at > 0.0 {
        row.updated_at * 1000.0
    } else {
        now_ms() as f64
    };
    let model = row
        .model_level
        .clone()
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| UNKNOWN_MODEL.into());
    let parts: Value = serde_json::from_str(&row.parts).map_err(|err| err.to_string())?;
    let Some(parts) = parts.as_array() else {
        return Ok(Vec::new());
    };
    if row.role == "user" {
        let content = extract_user_text(parts);
        if content.is_empty() {
            return Ok(Vec::new());
        }
        return Ok(vec![build_agent_activity_entry(&json!({
            "timestamp": ts_ms,
            "event.id": hash_id(&[session_id.clone(), row.id.clone(), "user".into()]),
            "event.name": "llm.request",
            "gen_ai.session.id": session_id,
            "gen_ai.agent.type": agent_type.as_str(),
            "gen_ai.request.model": model,
            "gen_ai.input.messages_delta": [{ "role": "user", "content": content }],
            "attributes": {
                "source": SOURCE,
                "event_kind": "user_prompt",
                "message_id": row.id,
                "sub_chat_id": row.sub_chat_id,
                "sequence": row.sequence,
            }
        }))]);
    }
    if row.role != "assistant" {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for part in parts {
        let Some(part) = part.as_object() else {
            continue;
        };
        let part_type = string_or(part.get("type"), "");
        if !part_type.starts_with("tool-") || part_type == "tool-Thinking" {
            continue;
        }
        let call_id = {
            let primary = string_or(part.get("toolCallId"), "");
            if primary.is_empty() {
                string_or(part.get("tool_call_id"), "")
            } else {
                primary
            }
        };
        let mut tool_name = string_or(part.get("toolName"), "");
        if tool_name.is_empty() {
            tool_name = string_or(part.get("tool_name"), "");
        }
        if tool_name.is_empty() {
            tool_name = string_or(part.get("name"), "");
        }
        if tool_name.is_empty() {
            tool_name = part_type.trim_start_matches("tool-").to_owned();
        }
        let Some(raw_result) = part.get("output").or_else(|| part.get("result")) else {
            continue;
        };
        if call_id.is_empty() {
            continue;
        }
        let result_payload = if raw_result.is_string() {
            raw_result.clone()
        } else {
            json_clone(raw_result)
        };
        let event_id = hash_id(&[
            session_id.clone(),
            row.id.clone(),
            "tool_result".into(),
            call_id.clone(),
            tool_name.clone(),
            hash_json(&result_payload),
        ]);
        if emitted.iter().any(|existing| existing == &event_id) {
            continue;
        }
        emitted.push(event_id.clone());
        out.push(build_agent_activity_entry(&json!({
            "timestamp": ts_ms,
            "event.id": event_id,
            "event.name": "tool.result",
            "gen_ai.session.id": session_id,
            "gen_ai.agent.type": agent_type.as_str(),
            "gen_ai.request.model": model,
            "gen_ai.tool.name": tool_name,
            "gen_ai.tool.call.id": call_id,
            "gen_ai.tool.call.exec.id": call_id,
            "gen_ai.tool.call.result": result_payload,
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
    Ok(out)
}

fn extract_user_text(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|part| {
            let part = part.as_object()?;
            if string_or(part.get("type"), "") != "text" {
                return None;
            }
            let text = string_or(part.get("text"), "");
            let text = if text.is_empty() {
                string_or(part.get("content"), "")
            } else {
                text
            };
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn read_new_message_rows(
    db_path: &str,
    cursor: f64,
    row_id: f64,
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
        &[json!(cursor), json!(cursor), json!(row_id)],
    )
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let Value::Object(map) = row else { return None };
            Some(MessageRow {
                row_id: map.get("rowId").and_then(Value::as_f64).unwrap_or(0.0),
                id: string_or(map.get("id"), ""),
                session_id: map
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                sub_chat_id: string_or(map.get("subChatId"), ""),
                sequence: map.get("sequence").and_then(Value::as_f64).unwrap_or(0.0),
                role: string_or(map.get("role"), ""),
                parts: string_or(map.get("parts"), ""),
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
    let rows=query_readonly(db_path,
        "SELECT updated_at AS updatedAt,rowid AS rowId FROM messages ORDER BY updated_at DESC,rowid DESC LIMIT 1",&[]).await?;
    Ok(rows
        .first()
        .map(|row| {
            (
                row.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0),
                row.get("rowId").and_then(Value::as_f64).unwrap_or(0.0),
            )
        })
        .unwrap_or((0.0, 0.0)))
}
async fn read_max_row_id_at(db_path: &str, cursor: f64) -> Result<f64, String> {
    let rows = query_readonly(
        db_path,
        "SELECT COALESCE(MAX(rowid),0) AS maxRowId FROM messages WHERE updated_at = ?",
        &[json!(cursor)],
    )
    .await?;
    Ok(rows
        .first()
        .and_then(|row| row.get("maxRowId"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0))
}

fn string_or(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn string_list(extra: Option<&Value>, key: &str) -> Vec<String> {
    extra
        .and_then(|extra| extra.get(key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn json_clone(value: &Value) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.clone(),
        Value::Array(items) => Value::Array(items.iter().map(json_clone).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), json_clone(v)))
                .collect(),
        ),
    }
}

fn hash_json(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(stable_stringify(value).as_bytes());
    hex::encode(hasher.finalize())
}

fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()),
                        stable_stringify(&map[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => other.to_string(),
    }
}

fn hash_id(parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(parts.join("\u{0}").as_bytes());
    hex::encode(hasher.finalize())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "sqlite_migration_contract_tests.rs"]
mod work_sqlite_migration_contract_tests;
