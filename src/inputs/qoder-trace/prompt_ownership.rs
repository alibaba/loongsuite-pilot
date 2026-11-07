//! #533 metadata-only prompt ownership, bounded to four candidates and 256 rows.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QoderOwnershipCursor {
    pub at: f64,
    pub request_id: String,
    pub inventory_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QoderOwnershipSearch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_index: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QoderOwnershipRow {
    pub request_id: String,
    pub at: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QoderPromptOwnership {
    pub inventory_id: String,
    pub rows: Vec<QoderOwnershipRow>,
    pub complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset: Option<bool>,
}
#[async_trait]
pub trait QoderPromptOwnershipResolver: Send + Sync {
    async fn resolve(
        &self,
        agent_id: &str,
        session_id: &str,
        request_id: &str,
        cursor: Option<&QoderOwnershipCursor>,
        search: &mut QoderOwnershipSearch,
    ) -> Option<QoderPromptOwnership>;
}
type Discovery = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;
pub struct NativeQoderPromptOwnershipResolver {
    discovery: Discovery,
    #[cfg(test)]
    queries: std::sync::Mutex<Vec<(String, String, Vec<Value>)>>,
}
impl Default for NativeQoderPromptOwnershipResolver {
    fn default() -> Self {
        Self::with_discovery(Arc::new(|agent| match agent {
            "qoder" => super::resolve_all_qoder_db_paths(),
            "qoder-cn" => super::resolve_qoder_cn_db_paths(),
            _ => Vec::new(),
        }))
    }
}
impl NativeQoderPromptOwnershipResolver {
    pub fn with_paths(paths: Vec<String>) -> Self {
        Self::with_discovery(Arc::new(move |_| paths.clone()))
    }
    pub fn with_discovery(discovery: Discovery) -> Self {
        Self {
            discovery,
            #[cfg(test)]
            queries: Default::default(),
        }
    }
    async fn query(&self, path: &str, sql: &str, params: Vec<Value>) -> Result<Vec<Value>, String> {
        #[cfg(test)]
        self.queries
            .lock()
            .unwrap()
            .push((path.into(), sql.into(), params.clone()));
        // A locked candidate cannot establish ownership. Do not inherit
        // rusqlite's default multi-second busy wait for this request-scoped proof.
        let path = path.to_owned();
        let sql = sql.to_owned();
        tokio::task::spawn_blocking(move || {
            crate::utils::source_access::check(&path).map_err(|error| error.to_string())?;
            let conn = rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(|e| e.to_string())?;
            conn.busy_timeout(std::time::Duration::ZERO)
                .map_err(|e| e.to_string())?;
            conn.pragma_update(None, "query_only", "ON")
                .map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let names = stmt
                .column_names()
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let params = params
                .into_iter()
                .map(|v| match v {
                    Value::String(s) => Ok(rusqlite::types::Value::Text(s)),
                    Value::Number(n) => n
                        .as_i64()
                        .map(rusqlite::types::Value::Integer)
                        .or_else(|| n.as_f64().map(rusqlite::types::Value::Real))
                        .ok_or("invalid numeric parameter"),
                    _ => Err("invalid ownership parameter"),
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(str::to_owned)?;
            let mut rows = stmt
                .query(rusqlite::params_from_iter(params.iter()))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut object = serde_json::Map::new();
                for (index, name) in names.iter().enumerate() {
                    use rusqlite::types::ValueRef;
                    let value = match row.get_ref(index).map_err(|e| e.to_string())? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Real(v) => json!(v),
                        ValueRef::Text(v) => Value::String(String::from_utf8_lossy(v).into_owned()),
                        ValueRef::Blob(_) => return Err("invalid ownership metadata".into()),
                    };
                    object.insert(name.clone(), value);
                }
                out.push(Value::Object(object));
                // All production statements have a literal LIMIT 2 or 257.
                if out.len() > 257 {
                    return Err("ownership page exceeded row budget".into());
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            if s.trim().is_empty() {
                Some(0.0)
            } else {
                s.trim().parse().ok()
            }
        }
        Value::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}
async fn inventory_id(path: &str) -> Option<String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = crate::utils::source_access::open(Path::new(&path)).ok()?;
        let identity = crate::utils::file_identity::identity_from_open(&file).ok()?;
        let encoded = serde_json::to_vec(&json!([path, identity.dev, identity.ino])).ok()?;
        Some(format!("{:x}", Sha256::digest(encoded)))
    })
    .await
    .ok()
    .flatten()
}
#[async_trait]
impl QoderPromptOwnershipResolver for NativeQoderPromptOwnershipResolver {
    async fn resolve(
        &self,
        agent_id: &str,
        session_id: &str,
        request_id: &str,
        cursor: Option<&QoderOwnershipCursor>,
        search: &mut QoderOwnershipSearch,
    ) -> Option<QoderPromptOwnership> {
        if !matches!(agent_id, "qoder" | "qoder-cn") {
            return None;
        }
        let mut paths = (self.discovery)(agent_id);
        paths.sort();
        if paths.is_empty() {
            return None;
        }
        let preferred = search
            .preferred_path
            .as_ref()
            .and_then(|p| paths.iter().position(|v| v == p));
        if preferred.is_none() {
            search.preferred_path = None;
        }
        let start = search
            .next_index
            .filter(|v| *v <= 9_007_199_254_740_991)
            .unwrap_or(0)
            % (paths.len() as u64);
        let mut candidates = Vec::with_capacity(4);
        if let Some(index) = preferred {
            candidates.push(index);
        }
        for i in 0..paths.len() {
            if candidates.len() == 4 {
                break;
            }
            let index = (start as usize + i) % paths.len();
            if Some(index) != preferred {
                candidates.push(index);
            }
        }
        for index in candidates {
            let path = &paths[index];
            search.next_index = Some(((index + 1) % paths.len()) as u64);
            let target=self.query(path,
                "SELECT request_id,gmt_create FROM chat_message WHERE session_id=? AND request_id=? AND role='user' LIMIT 2",
                vec![json!(session_id),json!(request_id)]).await;
            let Ok(target) = target else { continue };
            if target.is_empty() {
                if search.preferred_path.as_ref() == Some(path) {
                    search.preferred_path = None;
                }
                continue;
            }
            if target.len() != 1 {
                return None;
            }
            let Some(inventory_id) = inventory_id(path).await else {
                continue;
            };
            if path.encode_utf16().count() <= 4096 {
                search.preferred_path = Some(path.clone());
            }
            if let Some(cursor) = cursor {
                let anchor=self.query(path,
                    "SELECT gmt_create FROM chat_message WHERE session_id=? AND request_id=? AND role='user' LIMIT 2",
                    vec![json!(session_id),json!(cursor.request_id)]).await;
                let Ok(anchor) = anchor else { continue };
                if cursor.inventory_id != inventory_id
                    || anchor.len() != 1
                    || number(&anchor[0]["gmt_create"]) != Some(cursor.at)
                {
                    return Some(QoderPromptOwnership {
                        inventory_id,
                        rows: vec![],
                        complete: false,
                        reset: Some(true),
                    });
                }
            }
            let page=self.query(path,
                "SELECT request_id,gmt_create FROM chat_message WHERE session_id=? AND role='user' AND (?=0 OR gmt_create>? OR (gmt_create=? AND request_id>?)) ORDER BY gmt_create,request_id LIMIT 257",
                vec![json!(session_id),json!(if cursor.is_some(){1}else{0}),json!(cursor.map(|c|c.at).unwrap_or(0.0)),json!(cursor.map(|c|c.at).unwrap_or(0.0)),json!(cursor.map(|c|c.request_id.as_str()).unwrap_or(""))]).await;
            let Ok(page) = page else { continue };
            let mut rows = Vec::with_capacity(page.len().min(256));
            let mut previous = cursor.map(|c| c.at).unwrap_or(0.0);
            for row in page.iter().take(256) {
                let request_id = row["request_id"].as_str()?;
                let at = number(&row["gmt_create"])?;
                if request_id.is_empty()
                    || request_id.encode_utf16().count() > 512
                    || !at.is_finite()
                    || at <= previous
                {
                    return None;
                }
                rows.push(QoderOwnershipRow {
                    request_id: request_id.into(),
                    at,
                });
                previous = at;
            }
            return Some(QoderPromptOwnership {
                inventory_id,
                rows,
                complete: page.len() <= 256,
                reset: None,
            });
        }
        None
    }
}
pub async fn read_qoder_prompt_ownership(
    agent_id: &str,
    session_id: &str,
    request_id: &str,
    cursor: Option<&QoderOwnershipCursor>,
    search: &mut QoderOwnershipSearch,
) -> Option<QoderPromptOwnership> {
    NativeQoderPromptOwnershipResolver::default()
        .resolve(agent_id, session_id, request_id, cursor, search)
        .await
}

#[cfg(test)]
#[path = "prompt_ownership_533_tests.rs"]
mod history_contract_tests;
