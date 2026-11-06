//! Port of `src/inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.ts`.

use crate::inputs::base::{env_poll_or, hosted_sqlite, query_readonly, InputRuntime, SqliteBody};
use crate::normalization::build_agent_activity_entry;
use crate::types::{AgentActivityEntry, ClientType};
use crate::utils::node_sqlite::SQLITE_SYNC_PAGE;
use crate::utils::DEFAULT_POLL_INTERVAL_MS;
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Arc;

#[cfg(test)]
type BeforeQuery = std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>;
#[cfg(test)]
tokio::task_local! { static BEFORE_QUERY: BeforeQuery; }
#[cfg(test)]
fn run_before_query_hook() {
    let _ = BEFORE_QUERY.try_with(|hook| {
        let action = hook.lock().unwrap().take();
        if let Some(action) = action {
            action();
        }
    });
}

const SOURCE: &str = "qoder-cn-sqlite-chat-message";
const UNKNOWN_MODEL: &str = "unknown";

pub struct QoderCnSqliteInput {
    pub inner: Arc<
        crate::inputs::base::HostedInput<crate::inputs::base::SqliteAdapter<QoderCnSqliteBody>>,
    >,
}

pub struct QoderCnSqliteBody {
    db_path: String,
    recovery: super::source_ownership::SourceRecovery,
}

pub struct QoderCnSqliteOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub db_path: Option<String>,
    pub data_root: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

impl QoderCnSqliteInput {
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

    pub fn new(opts: QoderCnSqliteOptions) -> Self {
        let data_root = opts
            .data_root
            .unwrap_or_else(crate::inputs::qoder_cn::resolve_qoder_cn_root);
        let db_path = opts
            .db_path
            .unwrap_or_else(|| resolve_qoder_cn_db_path(&data_root));
        let poll = env_poll_or(opts.poll_interval_ms, "QODER_CN_ANALYTICS_POLL_INTERVAL")
            .or(Some(DEFAULT_POLL_INTERVAL_MS));
        let recovery = super::source_ownership::SourceRecovery::new(opts.state_store.file_path());
        Self {
            inner: hosted_sqlite(
                QoderCnSqliteBody { db_path, recovery },
                "QoderCnSqliteInput",
                opts.state_store,
                poll,
            ),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }

    pub fn db_path(&self) -> &str {
        &self.inner.body.inner().db_path
    }

    pub fn get_watch_paths() -> Vec<String> {
        vec![Path::new(&resolve_qoder_cn_db_path(
            &crate::inputs::qoder_cn::resolve_qoder_cn_root(),
        ))
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()]
    }

    pub async fn check_availability() -> bool {
        tokio::fs::metadata(resolve_qoder_cn_db_path(
            &crate::inputs::qoder_cn::resolve_qoder_cn_root(),
        ))
        .await
        .is_ok()
    }
}

pub fn resolve_qoder_cn_db_path(data_root: &str) -> String {
    Path::new(data_root)
        .join("SharedClientCache")
        .join("cache")
        .join("db")
        .join("local.db")
        .to_string_lossy()
        .into_owned()
}

#[async_trait]
impl SqliteBody for QoderCnSqliteBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "qoder-cn-sqlite"
    }

    fn agent_type(&self) -> ClientType {
        ClientType::QoderCn
    }

    fn db_path(&self) -> &str {
        &self.db_path
    }

    async fn read_new_rows(
        &self,
        rt: &InputRuntime,
        last_row_id: f64,
    ) -> anyhow::Result<Vec<Map<String, Value>>> {
        let prepared = self
            .recovery
            .prepare(rt, &self.db_path, last_row_id)
            .await?;
        if prepared.reset {
            return Ok(Vec::new());
        }
        let sql = format!(
            "
      SELECT
        rowid,
        id,
        session_id AS sessionId,
        request_id AS requestId,
        role,
        token_info AS tokenInfo,
        gmt_create AS gmtCreate
      FROM chat_message
      WHERE rowid > ?
        AND token_info IS NOT NULL
        AND token_info != ''
        AND json_valid(token_info)
      ORDER BY rowid ASC
      LIMIT {SQLITE_SYNC_PAGE}
    "
        );
        #[cfg(test)]
        run_before_query_hook();
        let rows = query_readonly(&self.db_path, &sql, &[json!(prepared.cursor)])
            .await
            .map_err(anyhow::Error::msg)?;
        prepared
            .verify_source(&self.db_path, &self.recovery)
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| match row {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .collect())
    }

    async fn transform_row(
        &self,
        _rt: &InputRuntime,
        row: &Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        let Some(token_info_raw) = row.get("tokenInfo").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some(token_info) = parse_token_info(token_info_raw) else {
            return Ok(None);
        };
        let input_tokens = finite_number(token_info.get("prompt_tokens"));
        let output_tokens = finite_number(token_info.get("completion_tokens"));
        let cache_read = finite_number(token_info.get("cached_tokens"));
        let max_input = finite_number(token_info.get("max_input_tokens"));
        let mut attributes = Map::new();
        attributes.insert("source".into(), json!(SOURCE));
        attributes.insert(
            "rowid".into(),
            row.get("rowid").cloned().unwrap_or(Value::Null),
        );
        attributes.insert(
            "message_id".into(),
            row.get("id")
                .cloned()
                .unwrap_or(Value::String(String::new())),
        );
        if let Some(request_id) = row.get("requestId").and_then(Value::as_str) {
            if !request_id.is_empty() {
                attributes.insert("request_id".into(), Value::String(request_id.to_owned()));
            }
        }
        if let Some(max_input) = max_input {
            attributes.insert("max_input_tokens".into(), json!(max_input));
        }
        let mut opts = Map::new();
        opts.insert(
            "timestamp".into(),
            row.get("gmtCreate").cloned().unwrap_or(Value::from(0)),
        );
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            if !id.is_empty() {
                opts.insert("event.id".into(), Value::String(id.to_owned()));
            }
        }
        opts.insert("event.name".into(), json!("llm.response"));
        opts.insert(
            "gen_ai.session.id".into(),
            Value::String(
                row.get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ),
        );
        opts.insert(
            "gen_ai.agent.type".into(),
            json!(ClientType::QoderCn.as_str()),
        );
        opts.insert("gen_ai.request.model".into(), json!(UNKNOWN_MODEL));
        opts.insert("gen_ai.response.model".into(), json!(UNKNOWN_MODEL));
        if let Some(value) = input_tokens {
            opts.insert("gen_ai.usage.input_tokens".into(), json!(value));
        }
        if let Some(value) = output_tokens {
            opts.insert("gen_ai.usage.output_tokens".into(), json!(value));
        }
        if let Some(value) = cache_read {
            opts.insert("gen_ai.usage.cache_read.input_tokens".into(), json!(value));
        }
        if let (Some(left), Some(right)) = (input_tokens, output_tokens) {
            opts.insert("gen_ai.usage.total_tokens".into(), json!(left + right));
        }
        opts.insert("attributes".into(), Value::Object(attributes));
        Ok(Some(build_agent_activity_entry(&Value::Object(opts))))
    }
}

pub(super) async fn read_max_eligible_row_id(db_path: &str) -> Result<f64, String> {
    let rows = query_readonly(
        db_path,
        "SELECT COALESCE(MAX(rowid), 0) AS maxRowId FROM chat_message",
        &[],
    )
    .await?;
    Ok(rows
        .first()
        .and_then(|row| row.get("maxRowId"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0))
}

fn parse_token_info(raw: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(raw).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

#[cfg(test)]
#[path = "source_recovery_race_tests.rs"]
mod source_recovery_race_tests;
