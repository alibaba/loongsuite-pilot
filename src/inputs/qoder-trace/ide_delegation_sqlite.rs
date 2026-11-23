use super::sqlite_token_reader::{parse_model_key, parse_record_model_key, parse_token_info};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::time::Duration;

const MAX_METADATA: usize = 4 * 1024 * 1024;
const MAX_TOOL_METADATA: i64 = 16 * 1024 * 1024;

pub(super) struct NativeRequest {
    pub session: String,
    pub request: String,
    pub messages: Option<Vec<Message>>,
}

pub(super) struct Message {
    pub id: String,
    pub role: String,
    pub at: i64,
    pub tool: Option<String>,
    pub model: Option<String>,
    pub usage: Option<(i64, i64, i64)>,
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 512
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(super) async fn read_request(
    databases: Vec<String>,
    session: String,
    call: String,
    first: usize,
) -> Option<NativeRequest> {
    let scope = crate::utils::source_access::current();
    tokio::task::spawn_blocking(move || {
        let mut result = None;
        for database in databases
            .iter()
            .cycle()
            .skip(first)
            .take(databases.len().min(4))
        {
            let path = Path::new(database);
            if scope
                .as_ref()
                .is_some_and(|scope| scope.check(path).is_err())
            {
                continue;
            }
            match read(path, &session, &call) {
                Ok(Relationship::Absent) | Err(_) => {}
                Ok(Relationship::Confirmed(found)) if result.is_none() => result = Some(found),
                Ok(Relationship::Confirmed(_) | Relationship::Ambiguous) => return None,
            }
        }
        result
    })
    .await
    .ok()
    .flatten()
}

enum Relationship {
    Absent,
    Confirmed(NativeRequest),
    Ambiguous,
}

fn read(path: &Path, session: &str, call: &str) -> anyhow::Result<Relationship> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    conn.busy_timeout(Duration::ZERO)?;
    conn.execute_batch("PRAGMA query_only=ON; BEGIN")?;
    let mut candidates = conn.prepare(
        "SELECT CASE WHEN length(CAST(session_id AS BLOB)) <= 512 THEN session_id END,
                CASE WHEN length(CAST(request_id AS BLOB)) <= 512 THEN request_id END,
                CASE WHEN length(CAST(extra AS BLOB)) <= 16384 THEN extra END
         FROM chat_record WHERE parent_session_id=?1 AND parent_tool_call_id=?2 LIMIT 2",
    )?;
    let mut rows = candidates.query(params![session, call])?;
    let Some(row) = rows.next()? else {
        return Ok(Relationship::Absent);
    };
    let child: Option<String> = row.get(0)?;
    let request: Option<String> = row.get(1)?;
    let extra: Option<String> = row.get(2)?;
    let (Some(child), Some(request)) = (child, request) else {
        return Ok(Relationship::Ambiguous);
    };
    if rows.next()?.is_some() || !valid_id(&child) || !valid_id(&request) || child == session {
        return Ok(Relationship::Ambiguous);
    }
    let model = parse_record_model_key(extra.as_deref());
    let messages = read_messages(&conn, &child, &request, model.as_deref()).ok();
    Ok(Relationship::Confirmed(NativeRequest {
        session: child,
        request,
        messages,
    }))
}

fn read_messages(
    conn: &Connection,
    session: &str,
    request: &str,
    record_model: Option<&str>,
) -> anyhow::Result<Vec<Message>> {
    let mut page = conn.prepare(
        "SELECT rowid, CASE WHEN length(CAST(id AS BLOB)) <= 512 THEN id END,
                CASE WHEN length(CAST(role AS BLOB)) <= 64 THEN role END, CAST(gmt_create AS INTEGER),
                CASE WHEN length(CAST(token_info AS BLOB)) <= 16384 THEN token_info END,
                CASE WHEN length(CAST(model_info AS BLOB)) <= 16384 THEN model_info END,
                CASE WHEN role='tool' THEN COALESCE(length(CAST(tool_result AS BLOB)),0) ELSE 0 END
         FROM chat_message WHERE session_id=?1 AND request_id=?2 AND rowid>?3 ORDER BY rowid LIMIT 32"
    )?;
    let mut tool = conn.prepare(
        "SELECT CASE WHEN json_valid(tool_result)
            THEN CASE WHEN length(CAST(json_extract(tool_result,'$.toolCallId') AS BLOB)) <= 512
                THEN json_extract(tool_result,'$.toolCallId') END END
         FROM chat_message WHERE rowid=?1 AND session_id=?2 AND request_id=?3",
    )?;
    let mut after = 0;
    let mut metadata = 0;
    let mut tool_bytes = 0;
    let mut result = Vec::new();
    loop {
        let mut rows = page.query(params![session, request, after])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            count += 1;
            let id: String = row.get(1)?;
            let role: String = row.get(2)?;
            let at: i64 = row.get(3)?;
            anyhow::ensure!(
                valid_id(&id) && result.len() < 4096 && at > 0,
                "invalid IDE message inventory"
            );
            after = row.get(0)?;
            let token: Option<String> = row.get(4)?;
            let model: Option<String> = row.get(5)?;
            let size: i64 = row.get(6)?;
            tool_bytes += size;
            anyhow::ensure!(
                tool_bytes <= MAX_TOOL_METADATA,
                "IDE tool metadata limit reached"
            );
            metadata += id.len()
                + role.len()
                + token.as_ref().map_or(0, String::len)
                + model.as_ref().map_or(0, String::len);
            anyhow::ensure!(
                metadata <= MAX_METADATA,
                "IDE message metadata limit reached"
            );
            let call = if role == "tool" {
                tool.query_row(params![after, session, request], |row| {
                    row.get::<_, Option<String>>(0)
                })
                .optional()?
                .flatten()
            } else {
                None
            };
            let usage = token.as_deref().and_then(parse_token_info);
            let model = parse_model_key(model.as_deref())
                .or_else(|| record_model.map(str::to_owned))
                .filter(|model| model.len() <= 512);
            result.push(Message {
                id,
                role,
                at,
                tool: call,
                usage,
                model,
            });
        }
        if count < 32 {
            return Ok(result);
        }
    }
}
