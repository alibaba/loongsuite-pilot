//! Port of `src/inputs/qoder-trace/sqlite-token-reader.ts`.
//!
//! Queries run through rusqlite in read-only mode. `query_readonly_paged`
//! keeps the cursor predicate from the TypeScript reader.

use crate::inputs::base::{app_support_root, query_readonly, query_readonly_paged};
use crate::utils::node_sqlite::SqlitePageCursor;
use crate::utils::{create_logger, resolve_home};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteTokenData {
    pub session_id: String,
    pub request_id: String,
    pub message_id: String,
    pub gmt_create: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteTokenResult {
    pub rows: Vec<SqliteTokenData>,
    pub matched_db_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AttachedImageLookup {
    pub paths: Vec<String>,
    pub start_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TokenRow {
    #[serde(default)]
    message_id: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    gmt_create: i64,
    #[serde(default)]
    token_info: String,
    #[serde(default)]
    model_info: Option<String>,
    #[serde(default)]
    record_extra: Option<String>,
}

const TOKEN_SQL: &str = "
    SELECT
      cm.id AS message_id,
      cm.session_id AS session_id,
      cm.request_id AS request_id,
      cm.gmt_create AS gmt_create,
      cm.token_info AS token_info,
      cm.model_info AS model_info,
      cr.extra AS record_extra
    FROM chat_message cm
    LEFT JOIN chat_record cr ON cr.request_id = cm.request_id
    WHERE cm.session_id = ?
      AND cm.role = 'assistant'
      AND cm.token_info IS NOT NULL
      AND cm.token_info != ''
      AND json_valid(cm.token_info)
      AND (? = 0 OR cm.gmt_create > ? OR (cm.gmt_create = ? AND cm.id > ?))
    ORDER BY cm.gmt_create ASC, cm.id ASC
";

pub async fn read_sqlite_tokens_for_session(session_id: &str) -> SqliteTokenResult {
    read_sqlite_tokens(session_id, &resolve_all_qoder_db_paths()).await
}

pub async fn read_sqlite_tokens(session_id: &str, db_paths: &[String]) -> SqliteTokenResult {
    let logger = create_logger("SqliteTokenReader");
    if db_paths.is_empty() {
        return SqliteTokenResult {
            rows: Vec::new(),
            matched_db_path: None,
        };
    }
    for db_path in db_paths {
        let rows = match query_readonly_paged(
            db_path,
            TOKEN_SQL,
            |cursor: &SqlitePageCursor| {
                vec![
                    json!(session_id),
                    json!(cursor.continued),
                    json!(cursor.sort),
                    json!(cursor.sort),
                    json!(cursor.id),
                ]
            },
            |row: &TokenRow| (row.gmt_create, row.message_id.clone()),
        )
        .await
        {
            Ok(rows) => rows,
            Err(err) => {
                logger.debug(
                    "sqlite query failed",
                    serde_json::json!({ "sessionId": session_id, "dbPath": db_path, "error": err })
                        .as_object(),
                );
                continue;
            }
        };
        if rows.is_empty() {
            continue;
        }
        let mut results = Vec::new();
        for row in rows {
            let Some(info) = parse_token_info(&row.token_info) else {
                continue;
            };
            results.push(SqliteTokenData {
                session_id: row.session_id,
                request_id: row.request_id,
                message_id: row.message_id,
                gmt_create: row.gmt_create,
                input_tokens: info.0,
                output_tokens: info.1,
                cache_read_tokens: info.2,
                model: parse_model_key(row.model_info.as_deref())
                    .or_else(|| parse_record_model_key(row.record_extra.as_deref())),
            });
        }
        if !results.is_empty() {
            return SqliteTokenResult {
                rows: results,
                matched_db_path: Some(db_path.clone()),
            };
        }
    }
    SqliteTokenResult {
        rows: Vec::new(),
        matched_db_path: None,
    }
}

pub async fn read_attached_image_paths_for_request_ids(
    request_ids: &[String],
) -> HashMap<String, AttachedImageLookup> {
    read_attached_image_paths(request_ids, &resolve_all_qoder_db_paths()).await
}

/// Read the same attachment projection from explicitly selected read-only databases.
pub async fn read_attached_image_paths(
    request_ids: &[String],
    db_paths: &[String],
) -> HashMap<String, AttachedImageLookup> {
    let logger = create_logger("SqliteTokenReader");
    let mut result = HashMap::new();
    let unique: Vec<String> = {
        let mut seen = HashSet::new();
        request_ids
            .iter()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .collect()
    };
    if unique.is_empty() {
        return result;
    }
    if db_paths.is_empty() {
        return result;
    }
    let placeholders = unique.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT cr.request_id AS request_id, cr.extra AS extra, (SELECT MIN(cm.gmt_create) FROM chat_message cm WHERE cm.request_id = cr.request_id AND cm.role = 'user') AS user_gmt_create FROM chat_record cr WHERE cr.request_id IN ({placeholders})"
    );
    let params: Vec<Value> = unique.iter().cloned().map(Value::String).collect();
    for db_path in db_paths {
        let rows = match query_readonly(db_path, &sql, &params).await {
            Ok(rows) => rows,
            Err(err) => {
                logger.debug(
                    "sqlite attachedImagePaths query failed",
                    serde_json::json!({ "dbPath": db_path, "error": err }).as_object(),
                );
                continue;
            }
        };
        for row in rows {
            let Value::Object(map) = row else { continue };
            let Some(request_id) = map
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if result.contains_key(request_id) {
                continue;
            }
            let mut lookup = AttachedImageLookup {
                paths: parse_attached_image_paths(map.get("extra").and_then(Value::as_str)),
                start_ms: None,
            };
            if let Some(start) = map
                .get("user_gmt_create")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n > 0.0)
            {
                lookup.start_ms = Some(start as i64);
            }
            result.insert(request_id.to_owned(), lookup);
        }
        if result.len() >= unique.len() {
            break;
        }
    }
    result
}

pub fn is_idea_db_path(db_path: Option<&str>) -> bool {
    db_path
        .unwrap_or("")
        .replace('\\', "/")
        .contains(".qoder/shared_client")
}

pub fn resolve_qoder_app_root() -> String {
    if cfg!(target_os = "macos") {
        resolve_home("~/Library/Application Support/Qoder")
    } else if cfg!(windows) {
        app_support_root()
            .join("Qoder")
            .to_string_lossy()
            .into_owned()
    } else {
        resolve_home("~/.config/Qoder")
    }
}

pub fn resolve_all_qoder_db_paths() -> Vec<String> {
    let root = resolve_qoder_app_root();
    let tail = Path::new("SharedClientCache")
        .join("cache")
        .join("db")
        .join("local.db");
    let mut candidates = vec![Path::new(&root).join(&tail).to_string_lossy().into_owned()];
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "SharedClientCache" {
                continue;
            }
            candidates.push(
                Path::new(&root)
                    .join(name)
                    .join(&tail)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    candidates.push(resolve_home("~/.qoder/shared_client/cache/db/local.db"));
    let mut available = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        if Path::new(&candidate).exists() {
            available.push(candidate);
        }
    }
    available
}

pub fn resolve_qoder_cn_db_paths() -> Vec<String> {
    let app_support = if cfg!(target_os = "macos") {
        resolve_home("~/Library/Application Support")
    } else if cfg!(windows) {
        app_support_root().to_string_lossy().into_owned()
    } else {
        resolve_home("~/.config")
    };
    let tail = ["SharedClientCache", "cache", "db", "local.db"];
    let mut candidates = vec![Path::new(&resolve_home("~"))
        .join(".qoder-cn")
        .join("shared_client")
        .join("cache")
        .join("db")
        .join("local.db")
        .to_string_lossy()
        .into_owned()];
    for name in ["QoderCN", "Qoder CN"] {
        let mut path = Path::new(&app_support).join(name);
        for segment in tail {
            path = path.join(segment);
        }
        candidates.push(path.to_string_lossy().into_owned());
    }
    candidates
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .collect()
}

fn parse_token_info(raw: &str) -> Option<(i64, i64, i64)> {
    let obj: Value = serde_json::from_str(raw).ok()?;
    let prompt = obj
        .get("prompt_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion = obj
        .get("completion_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached = obj
        .get("cached_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if prompt == 0 && completion == 0 {
        None
    } else {
        Some((prompt, completion, cached))
    }
}

fn parse_model_key(raw: Option<&str>) -> Option<String> {
    let obj: Value = serde_json::from_str(raw?).ok()?;
    obj.get("model_key")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

fn parse_record_model_key(raw: Option<&str>) -> Option<String> {
    let obj: Value = serde_json::from_str(raw?).ok()?;
    obj.pointer("/modelConfig/key")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

fn parse_attached_image_paths(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else { return Vec::new() };
    let Ok(extra) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    if let Some(items) = extra.get("attachedImagePaths").and_then(Value::as_array) {
        let paths: Vec<String> = items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect();
        if !paths.is_empty() {
            let mut unique = Vec::new();
            for path in paths {
                if !unique.contains(&path) {
                    unique.push(path);
                }
            }
            return unique;
        }
    }
    let mut from_context = Vec::new();
    if let Some(context) = extra.get("context").and_then(Value::as_array) {
        for item in context {
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            let file_type = item.get("fileType").and_then(Value::as_str).unwrap_or("");
            if name != "image" && file_type != "image" {
                continue;
            }
            let candidate = item
                .get("imgUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    item.get("filePath")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                });
            if let Some(candidate) = candidate {
                let owned = candidate.to_owned();
                if !from_context.contains(&owned) {
                    from_context.push(owned);
                }
            }
        }
    }
    from_context
}

#[cfg(test)]
#[path = "qoder_cn_reader_contract_tests.rs"]
mod qoder_cn_migration_contract_tests;
