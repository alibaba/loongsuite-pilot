//! Read-only SQLite used by the Qoder and QwenWork inputs.
//!
//! `crate::utils::node_sqlite` reports the bundled engine but does not execute
//! SQL (`EngineNotLinked`). These helpers run the same statements with
//! rusqlite, opened read-only, including `json_valid` and the paged cursor
//! shape from `queryReadonlyPaged`.

pub const SQLITE_SYNC_PAGE: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlitePageCursor {
    pub continued: i64,
    pub sort: i64,
    pub id: String,
}
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{Map, Number, Value};

pub fn query_readonly_sync(
    db_path: &str,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|err| err.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let bound = params.iter().map(to_sql).collect::<Result<Vec<_>, _>>()?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(
            bound.iter().map(|value| value as &dyn rusqlite::ToSql),
        ))
        .map_err(|err| err.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index).map_err(|err| err.to_string())? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => Value::Number(value.into()),
                ValueRef::Real(value) => Number::from_f64(value)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
                ValueRef::Blob(bytes) => {
                    Value::Array(bytes.iter().copied().map(Value::from).collect())
                }
            };
            object.insert(name.clone(), value);
        }
        out.push(Value::Object(object));
    }
    Ok(out)
}

pub async fn query_readonly(
    db_path: &str,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let db_path = db_path.to_owned();
    let sql = sql.to_owned();
    let params = params.to_vec();
    tokio::task::spawn_blocking(move || query_readonly_sync(&db_path, &sql, &params))
        .await
        .map_err(|err| err.to_string())?
}

fn paged_sql(sql: &str) -> String {
    format!("{sql}\nLIMIT {SQLITE_SYNC_PAGE}")
}

pub async fn query_readonly_paged<T, P, C>(
    db_path: &str,
    sql: &str,
    mut params_for: P,
    mut cursor_from: C,
) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
    P: FnMut(&SqlitePageCursor) -> Vec<Value>,
    C: FnMut(&T) -> (i64, String),
{
    let paged = paged_sql(sql);
    let mut rows = Vec::new();
    let mut cursor = SqlitePageCursor {
        continued: 0,
        sort: 0,
        id: String::new(),
    };
    loop {
        let params = params_for(&cursor);
        let page_values = query_readonly(db_path, &paged, &params).await?;
        if page_values.is_empty() {
            return Ok(rows);
        }
        let mut page = Vec::with_capacity(page_values.len());
        for value in page_values {
            let row = serde_json::from_value(value).map_err(|err| err.to_string())?;
            page.push(row);
        }
        let full = page.len() >= SQLITE_SYNC_PAGE;
        if full {
            if let Some(last) = page.last() {
                let (sort, id) = cursor_from(last);
                cursor = SqlitePageCursor {
                    continued: 1,
                    sort,
                    id,
                };
            }
        }
        rows.extend(page);
        if !full {
            return Ok(rows);
        }
        tokio::task::yield_now().await;
    }
}

enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
}

impl rusqlite::ToSql for SqlValue {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        match self {
            Self::Null => Ok(rusqlite::types::ToSqlOutput::Owned(
                rusqlite::types::Value::Null,
            )),
            Self::Integer(value) => Ok(rusqlite::types::ToSqlOutput::Owned(
                rusqlite::types::Value::Integer(*value),
            )),
            Self::Real(value) => Ok(rusqlite::types::ToSqlOutput::Owned(
                rusqlite::types::Value::Real(*value),
            )),
            Self::Text(value) => Ok(rusqlite::types::ToSqlOutput::Owned(
                rusqlite::types::Value::Text(value.clone()),
            )),
        }
    }
}

fn to_sql(value: &Value) -> Result<SqlValue, String> {
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::Bool(true) => Ok(SqlValue::Integer(1)),
        Value::Bool(false) => Ok(SqlValue::Integer(0)),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                Ok(SqlValue::Integer(value))
            } else if let Some(value) = number.as_u64() {
                i64::try_from(value)
                    .map(SqlValue::Integer)
                    .map_err(|err| err.to_string())
            } else if let Some(value) = number.as_f64() {
                Ok(SqlValue::Real(value))
            } else {
                Err("unsupported SQL number".into())
            }
        }
        Value::String(value) => Ok(SqlValue::Text(value.clone())),
        Value::Array(_) | Value::Object(_) => Ok(SqlValue::Text(value.to_string())),
    }
}
