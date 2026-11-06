//! 历史 SQLite API 的兼容入口，查询和分页统一委托 bundled rusqlite 只读实现。
//! Node probe 常量仅暂供尚未原生化的更新器引用；采集查询不探测 Node。

use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::OnceLock;

/// Probe passed to `node -e` before an upgrade is activated.
pub const NODE_SQLITE_PROBE: &str = "require('node:sqlite')";

/// Historical Node-missing error. The collector does not return this while the
/// bundled engine is reported present.
pub const NODE_SQLITE_UNAVAILABLE: &str =
    "node:sqlite is unavailable; SQLite reads require unflagged node:sqlite (Node.js >= 22.13 or >= 23.4)";

/// Max rows one synchronous page may materialize.
pub use crate::inputs::base::{SqlitePageCursor, SQLITE_SYNC_PAGE};

/// Marker that the bundled engine is the intended SQLite implementation.
#[derive(Debug, Clone, Copy)]
pub struct DatabaseSync;

static ENGINE: OnceLock<Option<DatabaseSync>> = OnceLock::new();

/// Bundled engine handle, or `None` if it were unavailable. Never panics.
///
/// The Rust collector reports the engine present. It does not look for a Node
/// binary and it does not parse Node version strings.
pub fn load_database_sync() -> Option<DatabaseSync> {
    *ENGINE.get_or_init(|| Some(DatabaseSync))
}

pub fn sqlite_engine_available() -> bool {
    load_database_sync().is_some()
}

#[derive(Debug, thiserror::Error)]
pub enum SqliteQueryError {
    #[error("{NODE_SQLITE_UNAVAILABLE}")]
    Unavailable,
    #[error("{0}")]
    Query(String),
    #[error("{0}")]
    Decode(String),
}

/// Read-only query. Rejects when the engine cannot execute the statement.
pub async fn query_readonly(
    db_path: &str,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, SqliteQueryError> {
    crate::inputs::base::query_readonly(db_path, sql, params)
        .await
        .map_err(SqliteQueryError::Query)
}

pub fn paged_sql(sql: &str) -> String {
    format!("{sql}\nLIMIT {SQLITE_SYNC_PAGE}")
}

/// Run `sql` in pages of [`SQLITE_SYNC_PAGE`].
///
/// `sql` must include the cursor predicate and must not already have a LIMIT:
/// `AND (? = 0 OR <sort> > ? OR (<sort> = ? AND <id> > ?)) ORDER BY <sort> ASC, <id> ASC`.
/// A full page yields before the next one.
pub async fn query_readonly_paged<T, P, C>(
    db_path: &str,
    sql: &str,
    params_for: P,
    cursor_from: C,
) -> Result<Vec<T>, SqliteQueryError>
where
    T: DeserializeOwned,
    P: FnMut(&SqlitePageCursor) -> Vec<Value>,
    C: FnMut(&T) -> (i64, String),
{
    crate::inputs::base::query_readonly_paged(db_path, sql, params_for, cursor_from)
        .await
        .map_err(SqliteQueryError::Query)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_sqlite_engine_is_present_without_a_node_binary() {
        assert!(sqlite_engine_available());
        assert!(load_database_sync().is_some());
        assert_eq!(NODE_SQLITE_PROBE, "require('node:sqlite')");
        assert_eq!(SQLITE_SYNC_PAGE, 1000);
        assert!(NODE_SQLITE_UNAVAILABLE.contains("Node.js >= 22.13"));
    }

    #[tokio::test]
    async fn query_does_not_require_a_node_binary() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("中文 😀.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute_batch("CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('保留');")
            .unwrap();
        drop(connection);
        let path = db.to_str().unwrap();
        let rows = query_readonly(
            path,
            "SELECT value, ? AS parameter FROM data",
            &[Value::from("参数")],
        )
        .await
        .unwrap();
        assert_eq!(rows[0]["value"], "保留");
        assert_eq!(rows[0]["parameter"], "参数");
        assert!(
            query_readonly(path, "DELETE FROM data RETURNING value", &[])
                .await
                .is_err()
        );
        assert_eq!(
            query_readonly(path, "SELECT value FROM data", &[])
                .await
                .unwrap()
                .len(),
            1
        );
        let missing = dir.path().join("missing.db");
        let error = query_readonly(missing.to_str().unwrap(), "select 1", &[])
            .await
            .unwrap_err();
        assert!(matches!(error, SqliteQueryError::Query(_)));
        assert!(!missing.exists());
    }

    #[test]
    fn paged_sql_appends_the_sync_page_limit() {
        assert_eq!(
            paged_sql("select 1"),
            format!("select 1\nLIMIT {SQLITE_SYNC_PAGE}")
        );
    }
}
